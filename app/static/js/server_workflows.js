function buildServerWizardSteps(payload, runOptions, auth) {
  const steps = [{ method: 'POST', url: '/api/projects', body: payload, wizardKey: 'project-create' }];
  const add = (key, method, path, body) => steps.push({
    method, url: `/api/projects/$project/${path}`, body, projectFromStep: 0, wizardKey: key,
  });
  if (auth.vmUser || auth.vmPass || auth.ctfdToken) {
    add('save-secrets', 'PUT', 'secrets', {
      proxmox: (auth.vmUser || auth.vmPass) ? { username: auth.vmUser, password: auth.vmPass } : undefined,
      ctfd: auth.ctfdToken ? { token: auth.ctfdToken } : undefined,
    });
  }
  if (runOptions.createVms) {
    const targets = [];
    for (let index = 1; index <= Number(payload.instances || 0); index++) {
      for (const vm of payload.vms || []) targets.push({ index, name: vm.name });
    }
    const opts = wizardNormalizeVmCreateOptions(runOptions.createOptions);
    const body = { username: auth.vmUser || undefined, password: auth.vmPass || undefined,
      baseUrl: auth.vmUrl || payload.proxmox_url || undefined, verifySSL: payload.proxmox_verify_ssl !== false, targets };
    add('vm-create', 'POST', 'instances/actions/create', { ...body, applyScenario: false, syncUserAccess: false,
      setNetworkInterfaces: opts.setNetworkInterfaces, takeSnapshot: opts.takeSnapshot });
    if (opts.enableUserAccessibility) {
      const plan = wizardBuildUserAccessibilityPlan(payload, targets);
      for (const name of plan.bases) {
        add('vm-accessibility', 'PATCH', `vms/${encodeURIComponent(name)}`, { viewable_to_user: plan.accessibilityByBase.get(name) === true });
      }
      if (!opts.createUsersAndPerms && plan.indices.length) {
        for (const enable of [true, false]) {
          const templates = plan.bases.filter(name => (plan.accessibilityByBase.get(name) === true) === enable);
          if (templates.length) add('vm-accessibility', 'POST', 'instances/actions/users_access_sync', { ...body, templates, indices: plan.indices, enable });
        }
      }
    }
    if (opts.createUsersAndPerms) add('vm-users', 'POST', 'instances/actions/users_create', body);
    if (opts.applyScenario) add('vm-scenario', 'POST', 'instances/actions/apply_scenario', body);
    if (opts.startVm) add('vm-start', 'POST', 'instances/actions/start', body);
  }
  if (runOptions.createCtfdUsers) {
    add('ctfd-users', 'POST', 'ctfd/users_create', { baseUrl: payload.challenge_url || undefined,
      token: auth.ctfdToken || undefined, verifySSL: payload.challenge_verify_ssl !== false });
  }
  return steps;
}

async function submitServerWizard(payload, runOptions, auth) {
  const steps = buildServerWizardSteps(payload, runOptions, auth);
  const job = await ServerQueue.submit(`Create scenario: ${payload.name}`, steps);
  wizardSetRunState('Scenario queued.', 'The server will complete the selected operations. You can navigate to any page.');
  const state = await ServerQueue.wait(job, state => {
    if (state.projectId) wizardRunState.projectId = state.projectId;
    for (const item of wizardRunState.items || []) {
      const indices = steps.map((step, index) => step.wizardKey === item.key ? index + 1 : 0).filter(Boolean);
      if (!indices.length) continue;
      const done = state.status === 'completed' || Math.max(...indices) < state.step;
      const active = indices.includes(state.step);
      wizardUpdateRunItem(item.key, { status: done ? 'success' : active ? (state.status === 'error' ? 'error' : 'running') : 'pending',
        progress: done ? 100 : 0, detail: done ? 'Completed.' : active ? (state.errorMessage || 'Running on the server…') : 'Queued on the server.' });
    }
  });
  const response = await ServerQueue.nativeFetch(`/api/queue/${job.id}/result`, { credentials: 'same-origin' });
  const output = await response.json();
  const created = output.results?.[0] || output;
  wizardRunState.projectId = created.id || created.pid || state.projectId || '';
  await loadProjects();
  await shell.refreshSidebar('config');
  const ok = state.status === 'completed';
  wizardFinishQueue(ok, ok ? 'Wizard run complete.' : 'Wizard run stopped.', state.errorMessage || (ok ? 'All selected operations completed.' : 'The run was cancelled.'));
  if (ok && wizSelectedTemplates?.length) scheduleWizardAutoRedirect(1400);
  return state;
}

async function submitServerCtfdBulk(kind, pids) {
  if (!['users_create', 'users_delete'].includes(kind)) throw new Error('Unsupported bulk action');
  const projects = [];
  const steps = [];
  for (const pid of pids) {
    const project = CTFD_ALL_PROJECTS.find(item => String(item.id) === String(pid));
    if (!project) throw new Error(`Project ${pid} is unavailable`);
    const creds = await hydrateCtfdCredsFromPersisted(String(pid));
    const body = { baseUrl: project.challenge_url, port: Number(project.challenge_port || 443),
      ...ctfdAuthPayload(creds), verifySSL: ctfdProjectVerifySSL(project) };
    const indices = Array.from(CTFD_SELECTED_KEYS || []).map(key => String(key).split(':'))
      .filter(([id]) => id === String(pid)).map(([, index]) => Number(index));
    const names = indices.map(index => project.credentials?.[index - 1]?.username).filter(Boolean);
    if (names.length) body.only = names;
    steps.push({ method: 'POST', url: `/api/projects/${encodeURIComponent(pid)}/ctfd/${kind}`, body });
    projects.push(project);
  }
  const title = kind === 'users_create' ? 'CTFd Users Create (Multi)' : 'CTFd Users Delete (Multi)';
  const job = await ServerQueue.submit(title, steps);
  const state = await ServerQueue.wait(job);
  const response = await ServerQueue.nativeFetch(`/api/queue/${job.id}/result`, { credentials: 'same-origin' });
  const output = await response.json();
  const results = output.results || [output];
  const summary = results.map((result, index) => `<h6>${escHtml(projects[index]?.name || projects[index]?.id || '')}</h6>`
    + buildCtfdResultsSummary(kind === 'users_delete' ? 'delete' : 'create', result)).join('');
  showActionSummary(title, summary + (state.errorMessage ? `<p class="text-danger">${escHtml(state.errorMessage)}</p>` : ''));
  CTFD_ALLOW_LOAD = true;
  await ctfdRefreshMulti();
  return state;
}
