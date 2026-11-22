const VM_CLIPBOARD_USAGE = new Map();
const VM_CLIPBOARD_REQUESTS = new Map();

function vmClipboardPolicy(detail) {
  return detail?.clipboard_policy || {
    to_vm: {enabled: false, limit: null, reset: '', scope: ''},
    from_vm: {enabled: false, limit: null, reset: '', scope: ''},
  };
}

function vmClipboardCell(row, project) {
  const pid = canonicalPid(row.pid || project?.id);
  const record = VM_CLIPBOARD_USAGE.get(pid);
  const policy = vmClipboardPolicy(row.detail);
  if (!row.detail || row.detail.type === 'lxc') return '<span class="text-muted">n/a</span>';
  return ['to_vm', 'from_vm'].map(direction => {
    const rule = policy[direction];
    const value = record?.usage?.[String(row.detail.vmid)]?.[direction];
    const current = value && value.reset === rule.reset && value.scope === rule.scope;
    const total = rule.limit === null ? '∞' : Number(rule.limit).toLocaleString();
    const used = current ? Number(value.used).toLocaleString()
      : '<i class="bi bi-question-circle text-secondary" role="img" aria-label="Usage unavailable"></i>';
    const usage = rule.limit === null && !current ? total : `${used} / ${total}`;
    const label = `${direction === 'to_vm' ? 'Client → VM' : 'VM → client'} clipboard: ${rule.enabled ? 'enabled' : 'disabled'}`;
    const usageTitle = record?.error || (current ? `${value.remaining === null ? 'Unlimited' : value.remaining} characters remaining. Shared across logins.` : 'Refresh with an AccessForge administrator connection to load persistent usage.');
    const icon = direction === 'to_vm' ? 'box-arrow-in-right' : 'box-arrow-left';
    return `<div class="small text-nowrap" title="${escHtml(label + '. ' + usageTitle)}"><i class="bi bi-${icon} ${rule.enabled ? 'text-success' : 'text-secondary'} me-1" role="img" aria-label="${escHtml(label)}"></i>${usage}${!rule.enabled && rule.limit !== null ? ' (disabled)' : ''}</div>`;
  }).join('');
}

async function vmAccessForgeConnectionHeaders(pid) {
  try {
    const me = await AUTH.me(), owner = me?.user?.username || '__anonymous__';
    const key = `toolhub.accessforge.session.${encodeURIComponent(owner)}.${encodeURIComponent(canonicalPid(pid))}`;
    const temporary = JSON.parse(sessionStorage.getItem(key) || 'null');
    if (temporary) return { 'X-AccessForge-Connection': encodeURIComponent(JSON.stringify(temporary)) };
  } catch { }
  return {};
}

async function vmLoadClipboardUsage(project, statuses) {
  const vmids = [...new Set((statuses || []).flatMap(status => status.vm_details || [])
    .filter(detail => detail.type !== 'lxc').map(detail => Number(detail.vmid)).filter(id => Number.isInteger(id) && id > 0))];
  if (!vmids.length) return;
  const pid = canonicalPid(project.id);
  const revision = (VM_CLIPBOARD_REQUESTS.get(pid) || 0) + 1;
  VM_CLIPBOARD_REQUESTS.set(pid, revision);
  try {
    const headers = {'Content-Type': 'application/json', ...await vmAccessForgeConnectionHeaders(pid)};
    const transport = window.ServerQueue?.nativeFetch || fetch;
    const usage = {};
    for (let offset = 0; offset < vmids.length; offset += 500) {
      const response = await transport(`/api/projects/${encodeURIComponent(pid)}/accessforge/clipboard/usage`, {
        method: 'POST', credentials: 'same-origin', cache: 'no-store', headers,
        body: JSON.stringify({vmids: vmids.slice(offset, offset+500)}),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || 'Configure the AccessForge administrator connection to load usage.');
      Object.assign(usage, result.usage || {});
    }
    if (VM_CLIPBOARD_REQUESTS.get(pid) === revision) VM_CLIPBOARD_USAGE.set(pid, {usage});
  } catch (error) {
    if (VM_CLIPBOARD_REQUESTS.get(pid) === revision) VM_CLIPBOARD_USAGE.set(pid, {error: error.message});
  }
}

function sharedVmPolicyValue(details, read) {
  if (!details.length) return undefined;
  const value = read(details[0]);
  return details.every(detail => read(detail) === value) ? value : undefined;
}

function promptVmAccessPolicy(options, textCopy) {
  const groups = options.targetsByPid || {[options.project?.id]: options.targets || []};
  const details = Object.entries(groups).flatMap(([pid, targets]) => {
    const project = guestTransferProject(pid) || options.project;
    return targets.map(target => _findVmDetailForTarget(project, target));
  }).filter(detail => detail?.type !== 'lxc');
  if (!details.length) {
    alert('Select at least one QEMU VM.');
    return Promise.resolve(null);
  }

  const element = document.getElementById(textCopy ? 'vmClipboardModal' : 'vmFileTransferModal');
  const form = element.querySelector('form');
  const count = details.length;
  element.querySelector('[data-policy-targets]').textContent = `Apply changes to ${count} selected VM${count === 1 ? '' : 's'}.`;

  const accessFields = Array.from(form.querySelectorAll('[data-policy-access]'), select => {
    const key = select.dataset.policyAccess;
    const enabled = sharedVmPolicyValue(details, detail => textCopy
      ? detail?.clipboard_policy?.[key.slice('clipboard_'.length)]?.enabled
      : detail?.file_transfer_policy?.[key]);
    const initial = enabled === undefined ? '' : String(enabled);
    select.value = initial;
    return {key, select, initial};
  });

  const listeners = new AbortController();
  const listenerOptions = {signal: listeners.signal};
  const limitFields = Array.from(form.querySelectorAll('[data-policy-limit]'), group => {
    const key = group.dataset.policyLimit;
    const direction = key.slice('clipboard_'.length);
    const initial = sharedVmPolicyValue(details, detail => detail?.clipboard_policy?.[direction]?.limit);
    const toggle = group.querySelector('[data-limit-toggle]');
    const allowance = group.querySelector('[data-limit-allowance]');
    const mixed = group.querySelector('[data-mixed-limits]');
    const clear = group.querySelector('[data-clear-limits]');
    const input = group.querySelector('input[type="number"]');
    toggle.indeterminate = initial === undefined;
    toggle.checked = typeof initial === 'number';
    input.value = toggle.checked ? String(initial) : input.defaultValue;

    const updateAllowance = () => {
      allowance.hidden = !toggle.checked;
      input.disabled = !toggle.checked;
      mixed.hidden = !toggle.indeterminate;
    };
    updateAllowance();
    toggle.addEventListener('change', updateAllowance, listenerOptions);
    clear.addEventListener('click', () => {
      toggle.indeterminate = false;
      toggle.checked = false;
      updateAllowance();
      toggle.focus();
    }, listenerOptions);
    return {key: key + '_limit', initial, toggle, input};
  });

  const reset = form.querySelector('[data-reset-counts]');
  if (reset) reset.checked = false;
  const modal = bootstrap.Modal.getOrCreateInstance(element);
  return new Promise(resolve => {
    let value = null;
    form.addEventListener('submit', event => {
      event.preventDefault();
      if (!form.reportValidity()) return;
      const changes = {};
      for (const {key, select, initial} of accessFields) {
        if (select.value && select.value !== initial) changes[key] = select.value === 'true';
      }
      for (const {key, initial, toggle, input} of limitFields) {
        if (toggle.indeterminate) continue;
        const limit = toggle.checked ? Number(input.value) : null;
        if (limit !== initial) changes[key] = limit;
      }
      if (reset?.checked) changes.reset_counts = true;
      if (Object.keys(changes).length) value = changes;
      modal.hide();
    }, listenerOptions);
    element.addEventListener('hidden.bs.modal', () => {
      listeners.abort();
      resolve(value);
    }, {once: true});
    modal.show();
  });
}

async function vmClipboardAction(project, action, targets, options) {
  const sess = readProxCreds(project.id) || {};
  return http('POST', `/api/projects/${encodeURIComponent(project.id)}/instances/actions/clipboard`, {
    targets, ...(action === 'clipboard_reset' ? {reset_counts: true} : options.clipboardPolicy),
    username: sess.username || undefined, password: sess.password || undefined,
    baseUrl: project.proxmox_url, apiPort: project.proxmox_api_port,
    verifySSL: project.proxmox_verify_ssl !== false,
  });
}
