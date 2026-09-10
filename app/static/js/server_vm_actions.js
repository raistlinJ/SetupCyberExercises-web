// Build the entire operation before enqueueing, including every selected project.
function buildServerVmSteps(action, options, projects) {
  const steps = [];
  for (const { project, targets: selected, auth } of projects) {
    const root = `/api/projects/${encodeURIComponent(project.id)}`;
    const targets = selected.map(target => ({ index: Number(target.index), name: String(target.name) }));
    const baseTargets = targets.map(target => ({ ...target, name: deriveBaseVmName(project, target.name, target.index) }));
    const add = (name, extra = {}, requestTargets = targets) => steps.push({
      method: 'POST', url: `${root}/instances/actions/${name}`, body: { ...auth, targets: requestTargets, ...extra },
    });
    const accessibility = (enable, sync = true) => {
      const plan = buildVmCreateUserAccessibilityPlan(project, targets);
      for (const name of plan.bases) {
        steps.push({ method: 'PATCH', url: `${root}/vms/${encodeURIComponent(name)}`, body: { viewable_to_user: enable } });
      }
      if (sync && plan.bases.length && plan.indices.length) {
        add('users_access_sync', { templates: plan.bases, indices: plan.indices, enable });
      }
    };
    if (action === 'create') {
      const opts = normalizeVmCreateOptions(options.createOptions);
      add('create', { applyScenario: false, syncUserAccess: false,
        setNetworkInterfaces: opts.setNetworkInterfaces, takeSnapshot: opts.takeSnapshot }, baseTargets);
      if (opts.enableUserAccessibility) accessibility(true, !opts.createUsersAndPerms);
      if (opts.createUsersAndPerms) add('users_create');
      if (opts.applyScenario) add('apply_scenario');
      if (opts.startVm) add('start');
    } else if (action === 'delete') {
      const opts = normalizeVmDeleteOptions(options.deleteOptions);
      if (opts.disableUserAccessibility) accessibility(false);
      add('delete', { deleteUsersAndPools: opts.deleteUsersAndPools, verifyCleanup: opts.verifyCleanup }, baseTargets);
    } else if (action === 'users_access_enable' || action === 'users_access_disable') {
      accessibility(action === 'users_access_enable');
    } else {
      const aliases = { nets_assign: 'nets_set', nets_clear: 'nets_remove', validate: 'run_stored_cmds' };
      const extra = {};
      if (options.customCommand) extra.customCommand = options.customCommand;
      if (action === 'validate') extra.validateOnly = true;
      if (options.selectedCommands?.length) {
        extra.commands = options.selectedCommands.slice();
        if (extra.commands.length === 1) extra.command = extra.commands[0];
      } else if (options.selectedCommand) extra.command = options.selectedCommand;
      if (options.storedCommandOverrides?.length) extra.storedCommandOverrides = options.storedCommandOverrides;
      add(aliases[action] || action, extra);
    }
  }
  return steps;
}

async function submitServerVmAction(label, descriptor, queueOptions) {
  const options = descriptor.options || {};
  const grouped = options.targetsByPid || { [descriptor.projectId]: options.targets || [] };
  const projects = [];
  for (const [pid, targets] of Object.entries(grouped)) {
    if (!targets.length) continue;
    const project = guestTransferProject(pid);
    if (!project) throw new Error(`Project ${pid} is unavailable`);
    if (!hasAuthForProject(project)) throw new Error(`Log in to Proxmox for ${project.name || pid} first`);
    const creds = readProxCreds(pid) || {};
    projects.push({ project, targets, auth: {
      username: creds.username || undefined, password: creds.password || undefined,
      baseUrl: project.proxmox_url || undefined, apiPort: project.proxmox_api_port || undefined,
      verifySSL: project.proxmox_verify_ssl !== false,
    } });
  }
  const steps = buildServerVmSteps(descriptor.action, options, projects);
  if (!steps.length) throw new Error('Select at least one VM');
  // Resolve interactive template choices before handing the plan to the worker.
  if (descriptor.action === 'create') {
    for (const step of steps.filter(step => step.url.endsWith('/create'))) {
      const pid = decodeURIComponent(step.url.split('/')[3]);
      const project = projects.find(item => canonicalPid(item.project.id) === pid)?.project;
      for (let attempt = 0; attempt < 6; attempt++) {
        const response = await ServerQueue.nativeFetch(step.url + '-preflight', {
          method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(step.body),
        });
        if (!response.ok) throw new Error(await response.text());
        const data = await response.json();
        if (!data.ambiguous?.length) break;
        if (attempt === 5) throw new Error('Resolve ambiguous templates before queueing this action');
        const seen = new Set();
        ACTION_IN_FLIGHT = true; CURRENT_ACTION = 'create';
        try {
          for (const entry of data.ambiguous) {
            if (seen.has(entry.name)) continue;
            seen.add(entry.name);
            await showTemplateResolveDialog(entry.name, entry.candidates || [], project);
          }
        } finally { ACTION_IN_FLIGHT = false; CURRENT_ACTION = null; }
      }
    }
  }
  const job = await ServerQueue.submit(label, steps, queueOptions);
  return finishServerVmAction(label, job);
}

async function finishServerVmAction(label, job) {
  const state = await ServerQueue.wait(job);
  const response = await ServerQueue.nativeFetch(`/api/queue/${job.id}/result`, { credentials: 'same-origin' });
  const result = await response.json();
  const summary = (result.results || [result]).reduce((merged, item) => mergeVmActionSummaryData(merged, item || {}), {});
  const archives = (result.results || [result]).flatMap(item => item?.outputs_zips || (item?.outputs_zip ? [item.outputs_zip] : []));
  if (archives.length) summary.outputs_zips = archives;
  if (state.status === 'error') summary.errors = [...(summary.errors || []), { reason: state.errorMessage }];
  showActionSummary(label, summary);
  emitActionLogs(label, summary);
  Promise.resolve(vmRefresh({ showProgressDialog: false })).catch(() => {});
  return { status: state.status, job };
}

async function submitServerGuestTransfer(label, descriptor, queueOptions) {
  const steps = [];
  const files = [];
  const payload = queueOptions.runtimePayload || (descriptor.payloadId ? await PersistentQueuePayloads.get(descriptor.payloadId) : null);
  if (descriptor.kind === 'push' && !payload?.files?.length) throw new Error('Upload files are unavailable');
  for (const group of descriptor.groups || []) {
    const auth = await guestTransferAuthPayload(group.pid, group.targets);
    const body = { ...auth, targets: group.targets };
    const url = `/api/projects/${encodeURIComponent(group.pid)}/instances/actions/guest_${descriptor.kind}`;
    if (descriptor.kind === 'push') {
      const destination = String(payload.destination || descriptor.destination || '').trim().replace(/\\/g, '/');
      if (!destination.startsWith('/')) throw new Error('The upload destination must be an absolute guest directory');
      const form = new FormData();
      form.append('payload', JSON.stringify({
        ...body, destination, relativePaths: descriptor.relativePaths, selectionType: descriptor.selectionType,
        ownerOnRemote: payload.ownerOnRemote ?? descriptor.ownerOnRemote ?? '',
        filePermissions: payload.filePermissions ?? descriptor.filePermissions ?? '',
      }));
      form.append('destination', destination);
      payload.files.forEach(file => form.append('files', file.blob || file, file.name || 'upload'));
      steps.push(ServerQueue.requestStep(url + `?destination=${encodeURIComponent(destination)}`, { method: 'POST', body: form }, files));
    } else {
      if (descriptor.kind === 'pull') body.paths = descriptor.paths;
      else if (descriptor.kind === 'delete') {
        if (descriptor.confirmed !== true) throw new Error('Guest deletion requires confirmation');
        Object.assign(body, { path: descriptor.path, selectionType: descriptor.selectionType, confirmed: true });
      } else throw new Error('Unsupported guest transfer');
      steps.push({ method: 'POST', url, body });
    }
  }
  const job = await ServerQueue.submit(label, steps, queueOptions, files);
  if (descriptor.payloadId) await PersistentQueuePayloads.remove(descriptor.payloadId).catch(() => {});
  return finishServerVmAction(label, job);
}
