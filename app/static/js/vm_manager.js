// Backward compatibility shim: open Dock to queue mode
window.showRemoteQueuePanel = function () {
  // Backward compatibility: open dock in queue mode
  try { if (window.ConsoleDock && ConsoleDock.setMode) { ConsoleDock.setMode('queue'); ConsoleDock.setOpen(true); return; } } catch { }
  try { if (window.shell && shell.logInfo) shell.logInfo('Queue view is now inside the Dock. Use the ▾ menu next to Dock button.'); } catch { }
};
window.hideRemoteQueuePanel = function () { /* no-op; legacy */ };

// Project/global data
let PROJ = null;
let ALL_PROJECTS = [];
let SELECTED_PIDS = [];
let FILTER_TEXT = '';
let FILTER_IS_REGEX = false;
let SELECTED_ROWS = new Set();
let SORT_STATE = { key: 'index', dir: 'asc' };
let SHOW_PASSWORDS = false;
let VM_AUTO_REFRESH_ACTIVE = false;
let ACTION_IN_FLIGHT = false;
let CURRENT_ACTION = null;
let ACTION_RUN_ID = 0;
let FIX_CREDS_IN_PROGRESS = false;
const VM_LIVE_REFRESHED_PIDS = new Set();
let VM_LOAD_REQUEST_TOKEN = 0;
const VM_MULTI_REFRESH_PROMISES = new Map();
const VM_SERVER_RESOURCES_BY_PID = new Map();
const VM_SERVER_RESOURCE_REQUESTS = new Map();
let VM_SERVER_RESOURCE_REQUEST_ID = 0;

function _coerceEnabled(value, def = true) {
  if (value === null || value === undefined) return def;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (!normalized) return def;
    if (['false', '0', 'no', 'off', 'disabled'].includes(normalized)) return false;
    if (['true', '1', 'yes', 'on', 'enabled'].includes(normalized)) return true;
  }
  return !!value;
}

const VM_SCROLL_KEY = 'toolhub.vmManager.scrollTop';
const STORED_CMD_SAMPLE_LIMIT = 3;
const VM_DEFAULT_COMMAND_TIMEOUT_SECONDS = (() => {
  try {
    if (typeof window !== 'undefined' && window && window.DEFAULT_COMMAND_TIMEOUT_SECONDS !== undefined) {
      const candidate = Number(window.DEFAULT_COMMAND_TIMEOUT_SECONDS);
      if (Number.isFinite(candidate) && candidate > 0) {
        return candidate;
      }
    }
  } catch { }
  return 300;
})();

function vmScrollContainer() {
  try { return document.getElementById('vm-table'); } catch { return null; }
}

function _vmBuildProxmoxHref(proj) {
  try {
    const baseRaw = (proj && proj.proxmox_url != null) ? String(proj.proxmox_url).trim() : '';
    if (!baseRaw) return '';
    const portRaw = (proj && proj.proxmox_api_port != null) ? String(proj.proxmox_api_port).trim() : '';
    let urlStr = baseRaw;
    if (!/^https?:\/\//i.test(urlStr)) urlStr = `https://${urlStr}`;
    const u = new URL(urlStr);
    if (portRaw && !u.port) u.port = portRaw;
    // Keep stable: remove trailing slash for nicer nav links
    return u.toString().replace(/\/$/, '');
  } catch {
    return '';
  }
}

function vmFormatResourceBytes(value) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes === 0) return '0 B';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
  const unitIndex = Math.max(0, Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024))));
  const scaled = bytes / Math.pow(1024, unitIndex);
  const digits = scaled >= 100 ? 0 : (scaled >= 10 ? 1 : 2);
  const rendered = digits > 0 ? scaled.toFixed(digits).replace(/\.?0+$/, '') : scaled.toFixed(0);
  return `${rendered} ${units[unitIndex]}`;
}

function vmFormatResourceUsage(resources, usedKey, totalKey) {
  const used = Number(resources?.[usedKey]);
  const total = Number(resources?.[totalKey]);
  if (!Number.isFinite(total) || total <= 0) return '— / —';
  const usedText = vmFormatResourceBytes(Math.max(0, used || 0));
  const totalText = vmFormatResourceBytes(total);
  const usedMatch = usedText.match(/^(.+?)\s+([A-Za-z]+)$/);
  const totalMatch = totalText.match(/^(.+?)\s+([A-Za-z]+)$/);
  if (usedMatch && totalMatch && usedMatch[2] === totalMatch[2]) {
    return `${usedMatch[1]} / ${totalMatch[1]} ${totalMatch[2]}`;
  }
  return `${usedText} / ${totalText}`;
}

function vmCurrentServerResources(proj) {
  const pid = canonicalPid(proj?.id);
  return pid ? (VM_SERVER_RESOURCES_BY_PID.get(pid) || null) : null;
}

function vmUpdateProxmoxNavLinkForCurrent() {
  const link = document.getElementById('nav-proxmox-link');
  if (!link) return;
  const serverLabel = document.getElementById('nav-proxmox-server-label');
  const spaceLabel = document.getElementById('nav-proxmox-space-label');
  const memoryLabel = document.getElementById('nav-proxmox-memory-label');
  const setLabels = (server, space, memory) => {
    if (serverLabel && spaceLabel && memoryLabel) {
      serverLabel.textContent = `Server: ${server}`;
      spaceLabel.textContent = space;
      memoryLabel.textContent = memory;
    } else {
      link.textContent = `Server: ${server} • ${space} • ${memory}`;
    }
  };
  let proj = PROJ;
  try {
    const cur = getCurrentPid ? getCurrentPid() : '';
    if (cur && (!proj || canonicalPid(proj.id) !== canonicalPid(cur))) {
      proj = (ALL_PROJECTS || []).find(p => canonicalPid(p.id) === canonicalPid(cur)) || proj;
    }
  } catch { }
  const href = _vmBuildProxmoxHref(proj);
  if (href) {
    try { link.classList.remove('d-none'); } catch { }
    link.href = href;
    try {
      const u = new URL(href);
      const hostPort = u.host || href;
      const resources = vmCurrentServerResources(proj);
      const space = vmFormatResourceUsage(resources, 'space_used_bytes', 'space_total_bytes');
      const memory = vmFormatResourceUsage(resources, 'memory_used_bytes', 'memory_total_bytes');
      setLabels(hostPort, space, memory);
      const scope = resources?.node ? ` (${resources.node})` : '';
      link.title = `${href}\nSpace${scope}: ${space}\nMemory${scope}: ${memory}`;
    } catch {
      const resources = vmCurrentServerResources(proj);
      const space = vmFormatResourceUsage(resources, 'space_used_bytes', 'space_total_bytes');
      const memory = vmFormatResourceUsage(resources, 'memory_used_bytes', 'memory_total_bytes');
      setLabels(href, space, memory);
      link.title = href;
    }
    link.classList.remove('disabled');
    try {
      link.classList.remove('border-secondary', 'text-muted');
      link.classList.add('border-primary', 'text-primary');
    } catch { }
    link.removeAttribute('aria-disabled');
    link.removeAttribute('tabindex');
  } else {
    link.href = '#';
    setLabels('—', '— / —', '— / —');
    try { link.classList.add('d-none'); } catch { }
    link.classList.add('disabled');
    try {
      link.classList.remove('border-primary', 'text-primary');
      link.classList.add('border-secondary', 'text-muted');
    } catch { }
    link.setAttribute('aria-disabled', 'true');
    link.setAttribute('tabindex', '-1');
  }
}

async function vmRefreshServerResources(projectOverride) {
  const project = projectOverride && typeof projectOverride === 'object' ? { ...projectOverride } : (PROJ ? { ...PROJ } : null);
  const pid = canonicalPid(project?.id);
  if (!pid || !project?.proxmox_url) return null;
  const requestId = ++VM_SERVER_RESOURCE_REQUEST_ID;
  VM_SERVER_RESOURCE_REQUESTS.set(pid, requestId);
  try {
    const sess = await hydrateProxCredsFromPersisted(pid);
    const hasSession = !!(sess?.username && sess?.password);
    const token = !hasSession && typeof project.proxmox_api_token === 'string'
      ? project.proxmox_api_token.trim()
      : '';
    if (!hasSession && !token) throw new Error('Proxmox credentials are unavailable');
    const response = await http('POST', '/api/proxmox/nodes', {
      baseUrl: project.proxmox_url,
      apiPort: project.proxmox_api_port || undefined,
      verifySSL: project.proxmox_verify_ssl !== false,
      username: hasSession ? sess.username : undefined,
      password: hasSession ? sess.password : undefined,
      token: token || undefined,
      preferredNode: project.proxmox_node || undefined,
    });
    if (VM_SERVER_RESOURCE_REQUESTS.get(pid) !== requestId) return null;
    const resources = response?.server_resources && typeof response.server_resources === 'object'
      ? { ...response.server_resources }
      : null;
    if (resources) VM_SERVER_RESOURCES_BY_PID.set(pid, resources);
    else VM_SERVER_RESOURCES_BY_PID.delete(pid);
    if (canonicalPid(PROJ?.id) === pid) vmUpdateProxmoxNavLinkForCurrent();
    return resources;
  } catch (error) {
    if (VM_SERVER_RESOURCE_REQUESTS.get(pid) === requestId) {
      VM_SERVER_RESOURCES_BY_PID.delete(pid);
      if (canonicalPid(PROJ?.id) === pid) vmUpdateProxmoxNavLinkForCurrent();
    }
    try { (window.shell && shell.logWarn) ? shell.logWarn(`Server resources unavailable: ${error?.message || error}`) : console.warn('Server resources unavailable', error); } catch { }
    return null;
  }
}

function vmApplyServerResources(pid, resources) {
  const projectId = canonicalPid(pid);
  if (!projectId || !resources || typeof resources !== 'object') return;
  VM_SERVER_RESOURCES_BY_PID.set(projectId, { ...resources });
  if (canonicalPid(PROJ?.id) === projectId) vmUpdateProxmoxNavLinkForCurrent();
}

function vmRestoreScrollPosition() {
  try {
    const el = vmScrollContainer();
    if (!el) return;
    const raw = sessionStorage.getItem(VM_SCROLL_KEY);
    if (raw === null) return;
    const top = parseInt(raw, 10);
    if (!Number.isFinite(top) || top < 0) return;
    requestAnimationFrame(() => {
      const max = Math.max(0, el.scrollHeight - el.clientHeight);
      el.scrollTop = Math.max(0, Math.min(top, max));
    });
  } catch { }
}

function vmInitScrollPersistence() {
  const el = vmScrollContainer();
  if (!el || el._scrollPersistBound) return;
  el._scrollPersistBound = true;
  const save = () => {
    try { sessionStorage.setItem(VM_SCROLL_KEY, String(el.scrollTop || 0)); } catch { }
  };
  el.addEventListener('scroll', save);
  window.addEventListener('beforeunload', save);
  vmRestoreScrollPosition();
}

function vmEnsureScrollPersistence() {
  vmInitScrollPersistence();
  vmRestoreScrollPosition();
}

document.addEventListener('DOMContentLoaded', vmEnsureScrollPersistence);

// Column visibility per project
let VM_COLS = { project: false, name: true, cred: true, status: true, state: true, id: true, node: true, template: true, nets: true };
function vmColsKey(pid) { return `toolhub.vm.mgr.cols.${pid}`; }
function readVmCols(pid) { try { const base = { project: false, name: true, cred: true, status: true, state: true, id: true, node: true, template: true, nets: true }; const raw = JSON.parse(sessionStorage.getItem(vmColsKey(pid)) || '{}') || {}; return { ...base, ...raw }; } catch { return { project: false, name: true, cred: true, status: true, state: true, id: true, node: true, template: true, nets: true }; } }
function writeVmCols(pid, obj) { try { sessionStorage.setItem(vmColsKey(pid), JSON.stringify(obj || {})); } catch { } }

// Lightweight HTTP helper (fallback if global http() not provided on this page)
var http = (typeof window !== 'undefined' && typeof window.http === 'function')
  ? window.http
  : (window.http = async function http(method, url, body) {
    const opts = { method, headers: {}, credentials: 'same-origin' };
    if (body instanceof FormData) {
      opts.body = body;
    } else if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    try {
      (window.shell && shell.logDebug) ? shell.logDebug(`[HTTP] ${method} ${url}`) : null;
    } catch { }
    const res = await fetch(url, opts);
    if (!res.ok) {
      let msg = res.statusText;
      let bodyText = '';
      try { bodyText = (await res.text()) || ''; } catch { }
      if (bodyText) msg = bodyText;
      try {
        if (res.status === 403) {
          let extracted = '';
          try {
            const parsed = JSON.parse(bodyText || '{}');
            extracted = (parsed && (parsed.error || parsed.message)) ? String(parsed.error || parsed.message) : '';
          } catch { }
          const warn = extracted || (bodyText || 'Action is disabled when app is running in remote mode.');
          try { if (typeof window.showToast === 'function') window.showToast(warn, 'warning'); } catch { }
        }
      } catch { }
      throw new Error(msg || `HTTP ${res.status}`);
    }
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('application/json')) return res.json();
    return res.text();
  });

const VM_STATUS_PHASE_LABELS = Object.freeze({
  inventory: 'Scanning',
  access: 'Access',
  summarizing: 'Summarizing',
  refreshing: 'Refreshing',
  refresh_vm: 'Refreshing',
  cloning: 'Cloning',
  networking: 'Networking',
  snapshotting: 'Snapshotting',
  starting: 'Starting',
  suspending: 'Suspending',
  unlocking: 'Unlocking',
  powering_off: 'Powering Off',
  deleting: 'Deleting',
  restoring: 'Restoring',
  applying: 'Applying',
  validation: 'Validating',
});

function showVmInlineProgress(label, percent = 20, detail) {
  try {
    const prog = document.getElementById('vm-progress');
    if (!prog) return;
    prog.classList.remove('d-none');
    prog.removeAttribute('aria-hidden');
    const bar = document.getElementById('vm-progress-bar');
    if (!bar) return;
    const pct = Math.max(0, Math.min(100, Number(percent) || 0));
    const text = String(label || detail || (VM_AUTO_REFRESH_ACTIVE ? 'Auto-refresh in progress…' : 'Working…'));
    bar.textContent = text;
    bar.style.width = `${pct}%`;
    bar.setAttribute('aria-valuenow', String(pct));
    if (detail || text) bar.title = String(detail || text);
  } catch { }
}

function updateVmInlineProgress(percent, label, detail) {
  showVmInlineProgress(label, percent, detail);
}

function hideVmInlineProgress() {
  try {
    const prog = document.getElementById('vm-progress');
    if (prog) {
      prog.classList.add('d-none');
      prog.setAttribute('aria-hidden', 'true');
    }
  } catch { }
}

function deriveStatusCountParts(status) {
  const step = Number(status?.step);
  const total = Number(status?.total_steps);
  if (!Number.isFinite(step) || !Number.isFinite(total) || total <= 0) return null;
  return { current: Math.max(0, Math.min(total, step)), total };
}

function deriveStatusProgressCounts(status, style = 'words') {
  const parts = deriveStatusCountParts(status);
  if (!parts) return '';
  if (style === 'slash') return `${parts.current} / ${parts.total}`;
  if (style === 'compact') return `${parts.current}/${parts.total}`;
  return `${parts.current} of ${parts.total}`;
}

function deriveStatusCountStyle(status) {
  const action = String(status?.action || '').trim().toLowerCase();
  const phase = String(status?.phase || '').trim().toLowerCase();
  if (action === 'start' || phase === 'starting') return 'slash';
  return 'words';
}

function statusMessageHasCounts(message, status) {
  const text = String(message || '').trim();
  if (!text) return false;
  const compact = deriveStatusProgressCounts(status, 'compact');
  const slash = deriveStatusProgressCounts(status, 'slash');
  const words = deriveStatusProgressCounts(status, 'words');
  return !!((compact && text.includes(compact)) || (slash && text.includes(slash)) || (words && text.includes(words)));
}

function deriveStatusPhaseLabel(status) {
  const phase = String(status?.phase || '').trim().toLowerCase();
  if (phase && VM_STATUS_PHASE_LABELS[phase]) return VM_STATUS_PHASE_LABELS[phase];
  const action = String(status?.action || '').trim().toLowerCase();
  return friendlyActionName(action || phase) || '';
}

function deriveStatusProgressLabel(status) {
  if (!status) return '';
  const phaseLabel = deriveStatusPhaseLabel(status);
  const counts = deriveStatusProgressCounts(status, deriveStatusCountStyle(status));
  const progress = Number(status?.progress);
  if (phaseLabel && counts) return `${phaseLabel} ${counts}`;
  if (counts) return counts;
  if (phaseLabel && Number.isFinite(progress) && progress > 0) return `${phaseLabel} ${Math.round(progress)}%`;
  return phaseLabel;
}

function deriveStatusDetailMessage(status) {
  if (!status) return '';
  const base = typeof status.message === 'string' ? status.message.trim() : '';
  const counts = deriveStatusProgressCounts(status, deriveStatusCountStyle(status));
  const phaseLabel = deriveStatusPhaseLabel(status);
  const detail = (status && status.detail) || {};
  const kind = typeof detail.kind === 'string' ? detail.kind.toLowerCase() : '';
  const vmLabel = detail.vm || status.current || '';
  if (kind === 'delay') {
    const delayLabel = detail.delay_label || (detail.delay_seconds != null ? `${detail.delay_seconds}s` : '');
    if (delayLabel && vmLabel) return `Waiting ${delayLabel} before step ${detail.step || ''} on ${vmLabel}`.trim();
    if (delayLabel) return `Waiting ${delayLabel}`;
  }
  if (kind === 'command') {
    const cmd = detail.command || '';
    const seqBits = [];
    const commandNumber = Number(detail.command_number);
    if (Number.isFinite(commandNumber) && commandNumber > 0) {
      const total = Number(detail.command_total);
      let seq = `command ${commandNumber}`;
      if (Number.isFinite(total) && total > 0) seq += `/${total}`;
      seqBits.push(seq);
    }
    const stepNum = Number(detail.step);
    if (Number.isFinite(stepNum) && stepNum > 0) {
      let stepLabel = `step ${stepNum}`;
      const cmdIndex = Number(detail.command_index);
      if (Number.isFinite(cmdIndex) && cmdIndex > 0) {
        const stepTotal = Number(detail.step_command_total);
        if (Number.isFinite(stepTotal) && stepTotal > 0) {
          stepLabel += ` #${cmdIndex}/${stepTotal}`;
        } else {
          stepLabel += ` #${cmdIndex}`;
        }
      }
      seqBits.push(stepLabel);
    }
    const prefix = seqBits.length ? `Running ${seqBits.join(' · ')}` : 'Running';
    if (cmd && vmLabel) return `${prefix} on ${vmLabel}: ${cmd}`;
    if (cmd) return `${prefix} ${cmd}`.trim();
    if (vmLabel) return `${prefix} on ${vmLabel}`;
    return prefix;
  }
  if (kind === 'validation') {
    const cmd = String(detail.command || '').trim();
    const match = String(detail.match || '').trim();
    const timeout = Number(detail.timeout_seconds);
    const seqBits = [];
    const commandNumber = Number(detail.command_number || detail.step);
    const commandTotal = Number(detail.command_total || status?.total_steps);
    if (Number.isFinite(commandNumber) && commandNumber > 0) {
      let seq = `check ${commandNumber}`;
      if (Number.isFinite(commandTotal) && commandTotal > 0) seq += `/${commandTotal}`;
      seqBits.push(seq);
    }
    const result = String(detail.result || '').trim().toLowerCase();
    if (result) seqBits.push(result);
    const timedOut = !!detail.timed_out;
    if (timedOut) seqBits.push('timed out');
    if (Number.isFinite(timeout) && timeout > 0) seqBits.push(`timeout ${timeout}s`);
    if (match) seqBits.push(`match /${match}/`);
    const reason = String(detail.reason || '').trim();
    const preview = String(detail.stdout_preview || detail.stderr_preview || '').trim();
    const prefix = seqBits.length ? `Validating ${seqBits.join(' · ')}` : 'Validating';
    let msg = prefix;
    if (vmLabel) msg += ` on ${vmLabel}`;
    if (cmd) msg += `: ${cmd}`;
    if (reason) msg += ` — ${reason}`;
    if (preview) msg += ` — ${preview}`;
    return msg;
  }
  if (base) return counts && !statusMessageHasCounts(base, status) ? `${base} (${counts})` : base;
  if (phaseLabel && counts) return `${phaseLabel} ${counts}`;
  if (counts && vmLabel) return `${vmLabel} (${counts})`;
  if (counts) return counts;
  return '';
}

const VM_BATCH_STATUS_ACTIONS = new Set([
  'delete',
  'start',
  'unlock',
  'suspend',
  'poweroff',
  'snapshot',
  'restore',
  'run_startup_cmds',
  'run_stored_cmds',
  'validate',
  'apply_scenario',
]);

function vmActionShouldPollStatus(action) {
  return VM_BATCH_STATUS_ACTIONS.has(String(action || '').trim().toLowerCase());
}

function startVmActionStatusPolling(pid, options = {}) {
  const projectId = String(pid ?? '').trim();
  if (!projectId || typeof http !== 'function') return () => { };
  const interval = Math.max(600, Number(options.interval) || 1200);
  const setProgress = typeof options.setProgress === 'function' ? options.setProgress : null;
  const initialDelay = Math.max(0, Number(options.initialDelay) || 0);
  let stopped = false;
  let timer = null;
  let seenActive = false;

  const clearTimer = () => { if (timer) { try { clearTimeout(timer); } catch { } timer = null; } };
  const stop = () => { stopped = true; clearTimer(); };

  const schedule = () => {
    if (stopped) return;
    clearTimer();
    timer = setTimeout(run, interval);
  };

  const applyStatus = (status) => {
    if (!setProgress) return;
    const message = deriveStatusDetailMessage(status);
    const label = deriveStatusProgressLabel(status);
    if (!message && !label) return;
    seenActive = true;
    const prev = (typeof getActionProgressState === 'function') ? getActionProgressState() : null;
    const nextPercent = Number(status?.progress);
    const pct = Number.isFinite(nextPercent)
      ? Math.max(0, Math.min(100, nextPercent))
      : (prev && typeof prev.percent === 'number' ? prev.percent : 60);
    try { setProgress(pct, label || undefined, message || label); } catch { }
  };

  const handleNoActive = () => {
    if (seenActive) {
      stop();
      return true;
    }
    return false;
  };

  const run = async () => {
    if (stopped) return;
    try {
      const status = await http('GET', `/api/projects/${encodeURIComponent(projectId)}/instances/actions/status`);
      if (status && !status.error) {
        applyStatus(status);
        const normalized = String(status.status || '').toLowerCase();
        if (normalized && normalized !== 'running') { stop(); return; }
      } else if (status && status.error) {
        const errText = String(status.error || '').toLowerCase();
        if (errText.includes('no active job') && handleNoActive()) { return; }
      }
    } catch (err) {
      const msg = String(err && err.message ? err.message : '').toLowerCase();
      if (msg.includes('no active job') && handleNoActive()) { return; }
    }
    schedule();
  };

  if (initialDelay > 0) {
    timer = setTimeout(run, initialDelay);
  } else {
    run();
  }
  return stop;
}

function normalizeProject(p) {
  if (!p || typeof p !== 'object') return null;
  const copy = { ...p };
  copy.id = String(copy.id ?? '').trim();
  copy.instances = Number(copy.instances ?? 0) || 0;
  copy.tag = String(copy.tag ?? '');
  copy.vms = Array.isArray(copy.vms) ? copy.vms : [];
  copy.credentials = Array.isArray(copy.credentials) ? copy.credentials : [];
  copy.instance_statuses = Array.isArray(copy.instance_statuses) ? copy.instance_statuses : [];
  copy.associated_projects = canonicalPidList(copy.associated_projects);
  return copy;
}
function normalizeProjects(list) {
  return (Array.isArray(list) ? list : [])
    .map(p => normalizeProject(p))
    .filter(Boolean)
    .filter(p => p.id);
}

function canonicalPid(value) { return String(value ?? '').trim(); }
function canonicalPidList(list) {
  const out = [];
  const seen = new Set();
  (Array.isArray(list) ? list : []).forEach(item => {
    const pid = canonicalPid(item);
    if (!pid || seen.has(pid)) return;
    seen.add(pid);
    out.push(pid);
  });
  return out;
}

function vmMarkLiveRefreshed(pid) {
  const key = canonicalPid(pid);
  if (key) VM_LIVE_REFRESHED_PIDS.add(key);
}

function vmClearLiveRefreshed(pid) {
  const key = canonicalPid(pid);
  if (key) VM_LIVE_REFRESHED_PIDS.delete(key);
}

function vmHasLiveRefresh(pid) {
  return VM_LIVE_REFRESHED_PIDS.has(canonicalPid(pid));
}

function vmActionTargetPids(opts = {}) {
  if (opts.targetsByPid && typeof opts.targetsByPid === 'object') {
    if (opts.targetsByPid instanceof Map) {
      return canonicalPidList(Array.from(opts.targetsByPid.keys()));
    }
    return canonicalPidList(Object.keys(opts.targetsByPid));
  }
  if ((vmIsMulti && vmIsMulti())) {
    return canonicalPidList(listSelectedEntries().map(entry => entry.pid));
  }
  const project = opts.project && typeof opts.project === 'object' ? opts.project : PROJ;
  if (!project || !project.id) return [];
  const selected = Array.isArray(opts.targets) && opts.targets.length
    ? opts.targets.map(entry => ({ index: Number(entry?.index), name: String(entry?.name || '') })).filter(entry => Number.isFinite(entry.index) && entry.name)
    : listSelectedEntriesForPid(project.id);
  return selected.length ? [canonicalPid(project.id)] : [];
}

async function vmEnsureLiveStateBeforeAction(opts = {}) {
  const targetPids = vmActionTargetPids(opts);
  if (!targetPids.length) return 'continue';
  try { await Promise.all(targetPids.map(pid => hydrateProxCredsFromPersisted(pid))); } catch { }
  const stalePids = targetPids.filter(pid => !vmHasLiveRefresh(pid));
  if (!stalePids.length) return 'continue';
  const scope = stalePids.length === 1 ? 'this project' : `${stalePids.length} selected projects`;
  const message = `Saved credentials are available, but the VM state for ${scope} may be stale because no refresh has occurred since this page was opened.\n\nChoose Refresh to load the latest VM state before running the action, or Continue to run the action with the current view.`;
  let selection = 'cancel';
  try {
    if (typeof window.showConfirmModal === 'function') {
      selection = await window.showConfirmModal('Refresh VM State?', message, {
        confirmText: 'Refresh',
        confirmClass: 'btn-primary',
        noText: 'Continue',
        noClass: 'btn-outline-secondary',
        cancelText: 'Cancel'
      });
    } else {
      selection = window.confirm(message) ? 'yes' : 'no';
    }
  } catch {
    selection = window.confirm(message) ? 'yes' : 'no';
  }
  if (selection === 'cancel') return 'cancel';
  if (selection !== 'yes') return 'continue';
  try { await vmRefresh({ forceRefresh: true }); } catch { }
  return 'refresh';
}

// Selected projects persistence (multi-view)
// Legacy global selection (for migration only)
const VM_SELECTED_KEY = 'toolhub.vm.mgr.selectedPids.v1';
function readVmSelected() {
  try {
    const v = JSON.parse(sessionStorage.getItem(VM_SELECTED_KEY) || '[]');
    return canonicalPidList(Array.isArray(v) ? v : []);
  } catch {
    return [];
  }
}
function writeVmSelected(arr) {
  try { sessionStorage.setItem(VM_SELECTED_KEY, JSON.stringify(canonicalPidList(arr))); } catch { }
}
// New: per-project associations map basePid -> [associatedPid,...]
const VM_ASSOC_MAP_KEY = 'toolhub.vm.mgr.assocMap.v1';
function vmReadAssocMap() { try { const raw = sessionStorage.getItem(VM_ASSOC_MAP_KEY); const obj = raw ? JSON.parse(raw) : {}; return (obj && typeof obj === 'object') ? obj : {}; } catch { return {}; } }
function vmWriteAssocMap(obj) { try { sessionStorage.setItem(VM_ASSOC_MAP_KEY, JSON.stringify(obj || {})); } catch { } }
function vmReadAssoc(basePid) {
  try {
    const pid = canonicalPid(basePid);
    if (!pid) return [];
    const map = vmReadAssocMap();
    const arr = Array.isArray(map[pid]) ? map[pid] : [];
    return canonicalPidList(arr);
  } catch {
    return [];
  }
}
function vmWriteAssoc(basePid, list) {
  try {
    const pid = canonicalPid(basePid);
    if (!pid) return;
    const arr = canonicalPidList(list).filter(x => x !== pid);
    const map = vmReadAssocMap();
    map[pid] = arr;
    vmWriteAssocMap(map);
  } catch { }
}
function vmMigrateSelectedToAssoc(basePid) {
  try {
    const pid = canonicalPid(basePid);
    if (!pid) return;
    const legacy = readVmSelected();
    if (!Array.isArray(legacy) || !legacy.length) return;
    const assoc = canonicalPidList(legacy).filter(x => x !== pid);
    const map = vmReadAssocMap();
    if (!Array.isArray(map[pid]) || (map[pid] || []).length === 0) {
      map[pid] = assoc;
      vmWriteAssocMap(map);
    }
    try { sessionStorage.removeItem(VM_SELECTED_KEY); } catch { }
  } catch { }
}

// Proxmox session creds and connection meta. Use the same keys as Configuration
// so one successful login remains available across page navigation for this tab.
function proxCredKey(pid) { return `toolhub.session.proxmox.${pid}`; }
function proxMetaKey(pid) { return `toolhub.session.proxmox.meta.${pid}`; }
function legacyVmProxCredKey(pid) { return `toolhub.vm.mgr.proxCred.${pid}`; }
function legacyVmProxMetaKey(pid) { return `toolhub.vm.mgr.proxMeta.${pid}`; }
function readProxCreds(pid) {
  try {
    const current = sessionStorage.getItem(proxCredKey(pid));
    if (current) return JSON.parse(current) || {};
    const legacy = sessionStorage.getItem(legacyVmProxCredKey(pid));
    if (!legacy) return {};
    const parsed = JSON.parse(legacy) || {};
    sessionStorage.setItem(proxCredKey(pid), JSON.stringify(parsed));
    sessionStorage.removeItem(legacyVmProxCredKey(pid));
    return parsed;
  } catch { return {}; }
}
function writeProxCreds(pid, obj) {
  try {
    sessionStorage.setItem(proxCredKey(pid), JSON.stringify(obj || {}));
    sessionStorage.removeItem(legacyVmProxCredKey(pid));
  } catch { }
}

function readPersistedProxCreds(pid) {
  try {
    if (window.CREDS && typeof CREDS.readPersistProxCreds === 'function') {
      return CREDS.readPersistProxCreds(pid) || {};
    }
  } catch { }
  return {};
}

async function hydrateProxCredsFromPersisted(pid) {
  const targetPid = String(pid || '').trim();
  if (!targetPid) return readProxCreds(targetPid) || {};
  let sess = readProxCreds(targetPid) || {};

  // Helper to ensure meta exists so enforceRefreshDisabledOnConnChange doesn't wipe valid credentials
  const ensureMeta = () => {
    try {
      const existingMeta = readProxMeta(targetPid);
      if (!existingMeta || !existingMeta.url) {
        const p = (window.PROJ_CACHE && window.PROJ_CACHE[targetPid])
          ? window.PROJ_CACHE[targetPid]
          : ((PROJ && canonicalPid(PROJ.id) === canonicalPid(targetPid)) ? PROJ : null);
        if (p) {
          writeProxMeta(targetPid, { url: normalizeUrl(p.proxmox_url || ''), apiPort: Number(p.proxmox_api_port || 8006), sshPort: Number(p.proxmox_ssh_port || 22) });
        }
      }
    } catch {}
  };

  if (sess.username && sess.password) {
    ensureMeta();
    return sess;
  }
  try {
    if (window.CREDS && typeof CREDS.fetchProjectSecrets === 'function') {
      await CREDS.fetchProjectSecrets(targetPid);
    }
  } catch { }
  const persisted = readPersistedProxCreds(targetPid);
  if (persisted && persisted.username && persisted.password) {
    sess = { ...sess, username: persisted.username, password: persisted.password };
    writeProxCreds(targetPid, sess);
    ensureMeta();
  }
  return sess;
}

// Utility helpers for conn/meta
function readProxMeta(pid) {
  try {
    const current = sessionStorage.getItem(proxMetaKey(pid));
    if (current) return JSON.parse(current) || {};
    const legacy = sessionStorage.getItem(legacyVmProxMetaKey(pid));
    if (!legacy) return {};
    const parsed = JSON.parse(legacy) || {};
    sessionStorage.setItem(proxMetaKey(pid), JSON.stringify(parsed));
    sessionStorage.removeItem(legacyVmProxMetaKey(pid));
    return parsed;
  } catch { return {}; }
}
function writeProxMeta(pid, obj) {
  try {
    sessionStorage.setItem(proxMetaKey(pid), JSON.stringify(obj || {}));
    sessionStorage.removeItem(legacyVmProxMetaKey(pid));
  } catch { }
}
function clearProxSession(pid) {
  try {
    sessionStorage.removeItem(proxCredKey(pid));
    sessionStorage.removeItem(proxMetaKey(pid));
    sessionStorage.removeItem(legacyVmProxCredKey(pid));
    sessionStorage.removeItem(legacyVmProxMetaKey(pid));
  } catch { }
  vmClearLiveRefreshed(pid);
}

// Normalize Proxmox URL to guarantee a scheme for consistent comparisons
function normalizeUrl(s) {
  if (!s) return '';
  const raw = /^https?:\/\//i.test(String(s).trim()) ? String(s).trim() : `https://${String(s).trim()}`;
  try {
    const parsed = new URL(raw);
    parsed.hash = '';
    parsed.search = '';
    return parsed.toString().replace(/\/+$/, '');
  } catch {
    return raw.replace(/\/+$/, '');
  }
}
function currentConnSnapshot(proj) {
  return {
    url: normalizeUrl(proj?.proxmox_url || ''),
    apiPort: Number(proj?.proxmox_api_port ?? 8006) || 8006,
    sshPort: Number(proj?.proxmox_ssh_port ?? 22) || 22,
  };
}
function sameConn(a, b) { return normalizeUrl(a.url || '') === normalizeUrl(b.url || '') && Number(a.apiPort || 0) === Number(b.apiPort || 0) && Number(a.sshPort || 0) === Number(b.sshPort || 0); }

function enforceRefreshDisabledOnConnChange() {
  if (!PROJ) return;
  const snap = currentConnSnapshot(PROJ);
  const meta = readProxMeta(PROJ.id);
  // Credentials entered on Configuration predate VM Manager's connection meta.
  // Adopt the current project snapshot instead of treating absent meta as a
  // connection change and deleting a valid application-session login.
  if (!meta || !Object.keys(meta).length) {
    if (hasSessionCreds()) writeProxMeta(PROJ.id, snap);
    return;
  }
  if (!sameConn(snap, meta)) {
    // Invalidate session creds and meta; disable Refresh
    clearProxSession(PROJ.id);
    updateRefreshState();
  }
}

// Wire up column toggles for VM table
function wireVmCols() {
  try {
    const ids = ['project', 'name', 'cred', 'status', 'state', 'id', 'node', 'template', 'nets'];
    ids.forEach(id => {
      const el = document.getElementById(`vm-col-${id}`);
      if (!el) return;
      if (!el._toolhubBound) {
        el.addEventListener('change', () => {
          const pid = PROJ ? PROJ.id : (getCurrentPid() || '');
          VM_COLS[id] = !!el.checked;
          if (pid) writeVmCols(pid, VM_COLS);
          try { if (vmIsMulti && vmIsMulti()) renderMergedVmTable(window.__MERGED_ROWS__ || []); else renderVmTable(PROJ); } catch { renderVmTable(PROJ); }
        });
        el._toolhubBound = true;
      }
      el.checked = !!VM_COLS[id];
    });
  } catch { }
}

// ARIA helpers and sort icons for table headers
function ariaSort(key) {
  if (SORT_STATE.key !== key) return 'none';
  return SORT_STATE.dir === 'asc' ? 'ascending' : 'descending';
}
function sortIcon(key) {
  if (SORT_STATE.key !== key) return '';
  const cls = SORT_STATE.dir === 'asc' ? 'bi-caret-up-fill' : 'bi-caret-down-fill';
  return ' <i class="bi ' + cls + '"></i>';
}

// Map raw Proxmox VM power states to canonical labels, badge classes, and sort weight
function mapProxmoxPowerState(raw) {
  const s = String(raw || '').toLowerCase();
  // Canonical buckets with sort weights (lower comes first when ascending)
  // Order: running (0) -> starting (1) -> paused/suspended (2) -> stopped (3) -> stopping (4) -> error (5) -> unknown (6)
  const mk = (label, cls, weight) => ({ label, cls, weight });
  if (!s) return mk('—', 'bg-secondary', 6);
  if (['running', 'ok'].includes(s)) return mk('running', 'bg-success', 0);
  if (['starting', 'prelaunch', 'booting', 'launching'].includes(s)) return mk('starting', 'bg-info text-dark', 1);
  // 'paused' (Proxmox pause) no longer exposed via UI; keep as suspended-like if encountered
  if (['paused', 'pause'].includes(s)) return mk('suspended', 'bg-warning text-dark', 2);
  if (['suspended', 'suspend'].includes(s)) return mk('suspended', 'bg-warning text-dark', 2);
  if (['stopped', 'down', 'shutoff', 'off', 'halted'].includes(s)) return mk('stopped', 'bg-secondary', 3);
  if (['stopping', 'shutdown', 'shutting down'].includes(s)) return mk('stopping', 'bg-info text-dark', 4);
  if (['resetting', 'rebooting', 'reboot'].includes(s)) return mk('rebooting', 'bg-info text-dark', 1);
  if (['io-error', 'error', 'failed', 'failure', 'crashed', 'internal-error'].includes(s)) return mk(s === 'io-error' ? 'io-error' : 'error', 'bg-danger', 5);
  // Default: show raw string but style as secondary
  return mk(s, 'bg-secondary', 6);
}

function vmStateSortWeight(detail) {
  const d = detail || {};
  const qmpState = String(d.qmp_state || '').toLowerCase();
  if (qmpState === 'io-error') return 5;
  return mapProxmoxPowerState(d.power_state || d.state).weight;
}

function renderVmStateBadges(detail) {
  const d = detail || {};
  const badges = [];
  const primaryRaw = d.power_state || d.state || d.qmp_state || '';
  const primary = mapProxmoxPowerState(primaryRaw);
  if (!primary || primary.label === '—') {
    badges.push('<span class="text-muted">—</span>');
  } else {
    badges.push(`<span class="badge ${primary.cls}" title="${escHtml(String(primaryRaw || primary.label))}">${escHtml(primary.label)}</span>`);
  }
  const qmpState = String(d.qmp_state || '').toLowerCase();
  if (qmpState === 'io-error') {
    badges.push('<span class="badge bg-danger" title="QMP status: io-error">I/O Error</span>');
  }
  const lockState = String(d.lock || '').trim();
  if (lockState) {
    badges.push(`<span class="badge bg-warning text-dark" title="${escHtml(`Lock: ${lockState}`)}">Locked</span>`);
  }
  return badges.join(' ');
}

function vmBuildFilterParts(rowLike) {
  const row = rowLike || {};
  const d = row.detail || {};
  const parts = [row.project, row.vmName, row.uname, String(row.status || ''), String(row.index || '')];
  if (d.state) parts.push(String(d.state));
  if (d.power_state) parts.push(String(d.power_state));
  if (d.qmp_state) parts.push(String(d.qmp_state));
  if (d.lock) parts.push(String(d.lock));
  if (d.node) parts.push(String(d.node));
  if (d.vmid !== undefined && d.vmid !== null) parts.push(String(d.vmid));
  if (d.template_name) parts.push(String(d.template_name));
  if (d.template_id !== undefined && d.template_id !== null) parts.push(String(d.template_id));
  if (Array.isArray(d.nets)) parts.push(d.nets.join(' '));

  const validationState = String(d.qemu_agent_validation_state || '').trim().toLowerCase();
  if (validationState) parts.push(validationState);

  const hasValidationCommands = resolveValidationConfiguredFlag(row, d);
  if (!hasValidationCommands) {
    parts.push('validation commands not configured');
  } else {
    const agentEnabled = !!(d && d.qemu_agent_enabled);
    const agentValidated = validationState ? validationState === 'passed' : !!(d && d.qemu_agent_validated);
    if (!agentEnabled) {
      parts.push('qemu guest agent off', 'guest agent off');
    } else if (agentValidated) {
      parts.push('qemu guest agent on and validated', 'guest agent validated', 'passed');
    } else if (validationState === 'failed') {
      parts.push('qemu guest agent on validation failed', 'guest agent failed', 'failed');
    } else {
      parts.push('qemu guest agent on not validated', 'guest agent not validated');
    }
  }

  const effAccess = (row.user_access !== undefined && row.user_access !== null)
    ? _coerceEnabled(row.user_access, false)
    : _coerceEnabled(row.viewable_to_user, true);
  parts.push(effAccess ? 'user access granted' : 'user access not granted');

  // Pool tooltip semantics
  try {
    const instStatus = row.instStatus || {};
    const mgr = instStatus.managers || {};
    const poolsStatus = String(mgr.pools || '').toLowerCase();
    const total = Number(mgr.pools_member_total || 0);
    const count = Number(mgr.pools_member_count || 0);
    if (poolsStatus === 'missing') {
      parts.push('no proxmox pool', 'pool missing');
    } else if (poolsStatus === 'ready' || poolsStatus === 'ok' || poolsStatus === 'created') {
      parts.push('pool exists');
      const memberState = String(mgr.pools_member_state || '').toLowerCase();
      if (memberState === 'all') {
        parts.push('pool all members', 'pool member');
        if (total || count) parts.push(`${count}/${total} in pool`);
      } else if (memberState === 'partial') {
        parts.push('pool partial members', 'pool not all members');
        if (total || count) parts.push(`${count}/${total} in pool`);
      } else if (memberState === 'error') {
        parts.push('pool membership unknown');
      } else {
        parts.push('pool membership status unknown');
      }
    } else if (poolsStatus === 'error') {
      parts.push('pool status error', 'pool error');
    } else if (poolsStatus) {
      parts.push('pool state unknown');
    }
  } catch { }

  // User credential tooltip semantics
  if (row.vm_user || row.vm_pass) {
    parts.push(`user: ${row.vm_user || '(not set)'}`, `pass: ${row.vm_pass ? '(set)' : '(not set)'}`);
    const desc = (d && d.description) ? String(d.description) : '';
    try {
      const match = desc.match(/\{[^{}]*"Scenario"[^{}]*\}/);
      if (match) {
        const parsed = JSON.parse(match[0]);
        if (parsed && typeof parsed === 'object' && parsed.Scenario) {
          const appliedUser = String(parsed.User || '');
          const appliedPass = String(parsed.Pass || '');
          const targetUser = String(row.vm_user || '');
          const targetPass = String(row.vm_pass || '');
          const appliedScenario = String(parsed.Scenario || '');
          const targetScenario = String(row.project || '');
          if (appliedScenario !== targetScenario || appliedUser !== targetUser || appliedPass !== targetPass) {
            parts.push('credential mismatch', 'cred mismatch');
          } else {
            parts.push('credential applied', 'cred applied', 'granted');
          }
        } else {
          parts.push('credential not applied', 'cred not applied');
        }
      } else {
        parts.push('credential not applied', 'cred not applied');
      }
    } catch { parts.push('credential status unknown'); }
  }

  return parts.filter(part => part !== undefined && part !== null && String(part).trim() !== '');
}

function vmBuildFilterHaystack(rowLike) {
  return vmBuildFilterParts(rowLike).join(' | ');
}

async function vmLoadProject() {
  const inputEl = document.getElementById('vm-proj-id');
  const pid = canonicalPid(inputEl ? inputEl.value : '');
  if (!pid) { alert('Enter a Project ID'); return; }
  try {
    await vmLoadProjectById(pid);
  } catch (e) {
    alert('Error loading projects: ' + e.message);
  }
}

async function vmLoadProjectById(pid) {
  const id = canonicalPid(pid);
  if (!id) throw new Error('Missing project id');
  const requestToken = ++VM_LOAD_REQUEST_TOKEN;
  const selectionChanged = () => canonicalPid(getCurrentPid()) !== id;
  const data = await http('GET', '/api/projects');
  if (requestToken !== VM_LOAD_REQUEST_TOKEN || selectionChanged()) return;
  const list = normalizeProjects(data.projects);
  ALL_PROJECTS = list;
  const proj = list.find(p => p.id === id);
  const info = document.getElementById('vm-info');
  if (!proj) {
    if (requestToken !== VM_LOAD_REQUEST_TOKEN || selectionChanged()) return;
    if (info) info.textContent = 'Project not found.';
    PROJ = null;
    renderVmTable(null);
    return;
  }
  if (requestToken !== VM_LOAD_REQUEST_TOKEN || selectionChanged()) return;
  PROJ = proj;
  if (info) info.textContent = '';
  try { vmUpdateProxmoxNavLinkForCurrent(); } catch { }
  try { await hydrateProxCredsFromPersisted(PROJ.id); } catch { }
  if (requestToken !== VM_LOAD_REQUEST_TOKEN || selectionChanged()) return;
  try { Promise.resolve(vmRefreshServerResources(PROJ)).catch(() => { }); } catch { }
  try { VM_COLS = readVmCols(PROJ.id); const ids = ['name', 'cred', 'status', 'state', 'id', 'node', 'template', 'nets']; ids.forEach(id => { const el = document.getElementById(`vm-col-${id}`); if (el) el.checked = !!VM_COLS[id]; }); } catch { }
  if (requestToken !== VM_LOAD_REQUEST_TOKEN || selectionChanged()) return;
  renderVmTable(proj);
  updateRefreshState();
  enforceRefreshDisabledOnConnChange();
}

// ---------- Multi-project support ----------
function getCurrentPid() { try { return canonicalPid((window.shell && shell.getCurrentProjectId) ? shell.getCurrentProjectId() : ''); } catch { return ''; } }
async function ensureAllProjects() {
  if (ALL_PROJECTS && ALL_PROJECTS.length) return;
  try {
    const d = await http('GET', '/api/projects');
    ALL_PROJECTS = normalizeProjects(d.projects);
  } catch {
    ALL_PROJECTS = [];
  }
}
function updateProjectsBadge() { try { const b = document.getElementById('projects-count'); if (!b) return; const n = (Array.isArray(SELECTED_PIDS) && SELECTED_PIDS.length > 1) ? SELECTED_PIDS.length : 1; b.textContent = String(n); b.className = 'badge ' + (n > 1 ? 'bg-primary' : 'bg-secondary'); } catch { } }
function renderProjectsList(filter) {
  const host = document.getElementById('projects-list'); if (!host) return;
  const f = (filter || '').toLowerCase();
  const cur = String(getCurrentPid() || '');
  const assoc = cur ? vmReadAssoc(cur) : [];
  const sel = new Set([...(assoc || []), ...(cur ? [cur] : [])]);
  const items = (ALL_PROJECTS || []).filter(p => !f || String(p.name || '').toLowerCase().includes(f) || String(p.tag || '').toLowerCase().includes(f));
  host.innerHTML = items.map(p => {
    const pid = canonicalPid(p.id);
    const isCur = cur && pid === cur;
    const on = sel.has(pid) ? 'checked' : '';
    const dis = isCur ? 'disabled' : '';
    const tip = isCur ? 'title="Current project (always selected)"' : '';
    return `<label class="list-group-item d-flex align-items-center gap-2"><input type="checkbox" class="form-check-input" data-pid="${pid}" ${on} ${dis} ${tip} /><div class="flex-grow-1"><div><strong>${escHtml(p.name)}</strong></div><div class="small text-muted">${escHtml(p.tag || '')}</div></div><span class="badge bg-secondary" title="Instances">${Number(p.instances || 0)}</span></label>`;
  }).join('');
}
async function setupProjectsSelector() {
  await ensureAllProjects();
  // Migrate legacy selection to per-project associations for current base
  try { const cur = String(getCurrentPid() || ''); if (cur) vmMigrateSelectedToAssoc(cur); } catch { }
  try {
    const cur = getCurrentPid();
    let assoc = cur ? vmReadAssoc(cur) : [];
    // Prefer backend-provided associations when available
    try {
      const proj = (ALL_PROJECTS || []).find(p => canonicalPid(p.id) === cur);
      const backend = Array.isArray(proj?.associated_projects) ? proj.associated_projects.map(String) : [];
      if (backend && backend.length) { vmWriteAssoc(cur, backend); assoc = backend.slice(); }
    } catch { }
    SELECTED_PIDS = canonicalPidList((cur && assoc.length) ? [cur, ...assoc] : []);
  } catch { }
  updateProjectsBadge();
  const filter = document.getElementById('projects-filter');
  const clearBtn = document.getElementById('projects-filter-clear');
  const selCur = document.getElementById('projects-select-current');
  const selAll = document.getElementById('projects-select-all');
  const clr = document.getElementById('projects-clear');
  const apply = document.getElementById('projects-apply');
  renderProjectsList(filter ? filter.value : '');
  try {
    const errEl = document.getElementById('projects-error');
    if (errEl) { errEl.classList.add('d-none'); errEl.setAttribute('aria-hidden', 'true'); errEl.textContent = ''; }
  } catch { }
  if (filter) filter.addEventListener('input', () => {
    renderProjectsList(filter.value || '');
    try {
      const errEl = document.getElementById('projects-error');
      if (errEl) { errEl.classList.add('d-none'); errEl.setAttribute('aria-hidden', 'true'); errEl.textContent = ''; }
    } catch { }
  });
  if (clearBtn) clearBtn.addEventListener('click', () => {
    if (filter) { filter.value = ''; renderProjectsList(''); }
    try {
      const errEl = document.getElementById('projects-error');
      if (errEl) { errEl.classList.add('d-none'); errEl.setAttribute('aria-hidden', 'true'); errEl.textContent = ''; }
    } catch { }
  });
  if (selCur) selCur.addEventListener('click', () => {
    const pid = getCurrentPid(); SELECTED_PIDS = canonicalPidList(pid ? [pid] : []); renderProjectsList(filter ? filter.value : '');
    try { const errEl = document.getElementById('projects-error'); if (errEl) { errEl.classList.add('d-none'); errEl.setAttribute('aria-hidden', 'true'); errEl.textContent = ''; } } catch { }
  });
  if (selAll) selAll.addEventListener('click', () => {
    const cur = getCurrentPid(); const list = (ALL_PROJECTS || []).map(p => canonicalPid(p.id)); if (cur && !list.includes(cur)) list.push(cur); SELECTED_PIDS = canonicalPidList(list); renderProjectsList(filter ? filter.value : '');
    try { const errEl = document.getElementById('projects-error'); if (errEl) { errEl.classList.add('d-none'); errEl.setAttribute('aria-hidden', 'true'); errEl.textContent = ''; } } catch { }
  });
  if (clr) clr.addEventListener('click', () => {
    const cur = getCurrentPid(); SELECTED_PIDS = canonicalPidList(cur ? [cur] : []); renderProjectsList(filter ? filter.value : '');
    try { const errEl = document.getElementById('projects-error'); if (errEl) { errEl.classList.add('d-none'); errEl.setAttribute('aria-hidden', 'true'); errEl.textContent = ''; } } catch { }
  });
  if (apply) apply.addEventListener('click', () => {
    try {
      const previousSelection = Array.isArray(SELECTED_PIDS) ? SELECTED_PIDS.slice() : [];
      const errEl = document.getElementById('projects-error');
      if (errEl) { errEl.classList.add('d-none'); errEl.setAttribute('aria-hidden', 'true'); errEl.textContent = ''; }
      const host = document.getElementById('projects-list');
      const boxes = host ? Array.from(host.querySelectorAll('input[type="checkbox"][data-pid]')) : [];
      const cur = getCurrentPid();
      let ids = boxes.filter(b => b.checked).map(b => canonicalPid(b.getAttribute('data-pid'))).filter(Boolean);
      if (cur && !ids.includes(cur)) ids.push(cur);
      const tagMap = new Map();
      const projectsById = new Map((ALL_PROJECTS || []).map(p => [canonicalPid(p.id), p]));
      const allIdsForCheck = ids.slice();
      const conflicts = [];
      for (const pidRaw of allIdsForCheck) {
        const pid = canonicalPid(pidRaw);
        if (!pid) continue;
        const proj = projectsById.get(pid);
        if (!proj) continue;
        const tagRaw = (proj && typeof proj.tag === 'string') ? proj.tag.trim() : '';
        const tagKey = tagRaw.toLowerCase();
        if (!tagMap.has(tagKey)) tagMap.set(tagKey, []);
        tagMap.get(tagKey).push(proj);
      }
      for (const [tagKey, list] of tagMap.entries()) {
        if (!tagKey) {
          if (list.length > 1) conflicts.push({ tag: '(blank)', projects: list });
        } else if (list.length > 1) {
          const anyTag = list[0] && typeof list[0].tag === 'string' ? list[0].tag.trim() : tagKey;
          conflicts.push({ tag: anyTag || '(blank)', projects: list });
        }
      }
      if (conflicts.length) {
        const names = conflicts.map(group => {
          const projNames = group.projects.map(p => p ? p.name : '').filter(Boolean).map(escHtml);
          return `${projNames.join(', ')} — tag "${escHtml(group.tag)}"`;
        });
        if (errEl) {
          errEl.innerHTML = `<strong>Cannot enter multi-project mode.</strong> Projects must have unique tags.<br>${names.map(n => `<div>${n}</div>`).join('')}`;
          errEl.classList.remove('d-none');
          errEl.setAttribute('aria-hidden', 'false');
        } else {
          alert('Cannot select projects with duplicate tags.');
        }
        SELECTED_PIDS = canonicalPidList(previousSelection);
        updateProjectsBadge();
        updateRefreshState();
        return;
      }
      // Persist per-base associations (exclude current)
      const assoc = canonicalPidList((ids || []).filter(x => x !== cur));
      if (cur) vmWriteAssoc(cur, assoc);
      // Persist to backend (best-effort)
      try { if (cur) { http('PATCH', `/api/projects/${encodeURIComponent(cur)}`, { associated_projects: assoc }).catch(() => { }); } } catch { }
      // Update runtime selection
      SELECTED_PIDS = canonicalPidList((cur && assoc.length > 0) ? [cur, ...assoc] : [cur].filter(Boolean));
      updateProjectsBadge();
      // Force Project column ON when entering multi-mode
      try {
        const multi = Array.isArray(SELECTED_PIDS) && SELECTED_PIDS.length > 1;
        if (multi) { VM_COLS.project = true; const chk = document.getElementById('vm-col-project'); if (chk) chk.checked = true; if (PROJ) writeVmCols(PROJ.id, VM_COLS); }
      } catch { }
      try { const el = document.getElementById('projectsModal'); if (el && window.bootstrap) { const m = bootstrap.Modal.getInstance(el) || bootstrap.Modal.getOrCreateInstance(el); m.hide(); } } catch { }
      try { refreshVmView(); } catch { }
    } catch { }
  });
  const host = document.getElementById('projects-list');
  if (host) host.addEventListener('change', (e) => {
    const cb = e.target && e.target.matches && e.target.matches('input[type="checkbox"][data-pid]') ? e.target : null;
    if (!cb) return; if (cb.disabled) return;
    try {
      const errEl = document.getElementById('projects-error');
      if (errEl) { errEl.classList.add('d-none'); errEl.setAttribute('aria-hidden', 'true'); errEl.textContent = ''; }
    } catch { }
    const pid = canonicalPid(cb.getAttribute('data-pid'));
    const set = new Set(canonicalPidList(SELECTED_PIDS));
    if (cb.checked) set.add(pid); else set.delete(pid);
    const cur = getCurrentPid(); if (cur) set.add(cur);
    SELECTED_PIDS = canonicalPidList(Array.from(set));
  });
}
function vmIsMulti() { return Array.isArray(SELECTED_PIDS) && SELECTED_PIDS.length > 1; }
function getActivePids() { if (vmIsMulti()) return canonicalPidList(SELECTED_PIDS.slice()); const cur = getCurrentPid(); return cur ? [cur] : []; }

function vmClearFilter() {
  try {
    const el = document.getElementById('vm-filter');
    if (el) el.value = '';
    FILTER_TEXT = '';
  } catch { }
  try { if (vmIsMulti()) renderMergedVmTable(window.__MERGED_ROWS__ || []); else renderVmTable(PROJ); } catch { renderVmTable(PROJ); }
}

async function refreshVmView(opts) {
  const forceRefresh = (() => {
    try {
      if (typeof opts === 'boolean') return !!opts;
      if (opts && Object.prototype.hasOwnProperty.call(opts, 'forceRefresh')) return !!opts.forceRefresh;
      return true;
    } catch {
      return true;
    }
  })();
  const showProgressDialog = (() => {
    try {
      if (typeof opts === 'boolean') return true;
      return !(opts && opts.showProgressDialog === false);
    } catch {
      return true;
    }
  })();
  await ensureAllProjects();
  // Capture the active project IDs at the start to prevent race conditions
  const startPids = getActivePids();
  const pids = startPids.slice();
  if (pids.length <= 1) { const id = pids[0]; if (!id) return; await vmLoadProjectById(id); return; }
  const refreshKey = `multi::${forceRefresh ? 'force' : 'normal'}::${canonicalPidList(pids).join('|')}`;
  const activeRefresh = VM_MULTI_REFRESH_PROMISES.get(refreshKey);
  if (activeRefresh) {
    return activeRefresh;
  }
  const refreshTask = (async () => {
  const byId = {}; (ALL_PROJECTS || []).forEach(p => { const key = canonicalPid(p.id); if (key) byId[key] = p; });
  const ok = []; const skipped = [];
  const eligibility = await Promise.all(pids.map(async (pid) => {
    const key = canonicalPid(pid);
    const proj = byId[key];
    if (!proj) return { pid: key, eligible: false };
    const tokenOk = !!(proj && typeof proj.proxmox_api_token === 'string' && proj.proxmox_api_token.trim());
    const sess = await hydrateProxCredsFromPersisted(pid);
    const sessOk = !!(sess.username && sess.password);
    return { pid: key, eligible: !!(tokenOk || sessOk) };
  }));
  for (const item of eligibility) {
    if (!item?.pid) continue;
    if (item.eligible) ok.push(item.pid);
    else skipped.push(item.pid);
  }
  const note = document.getElementById('vm-skipped-note');
  if (note) {
    if (skipped.length) {
      const items = skipped.map(id => {
        const keyId = canonicalPid(id);
        const p = byId[keyId]; const name = escHtml(p?.name || keyId);
        return `<li class="mb-1">` +
          `<span class="badge bg-light text-dark me-2">${name}</span>` +
          `<button class="btn btn-sm btn-outline-primary" onclick="openProxLoginForPid('${keyId.replace(/['"\\]/g, '\\$&')}')">Fix Creds</button>` +
          `</li>`;
      }).join('');
      // Persist the skipped IDs on the note element so other handlers (Fix All) can access them
      try { note.dataset.skipped = JSON.stringify(skipped); } catch { }
      // Render the alert with per-project Fix Creds and a Fix All action
      note.innerHTML = `<div class="alert alert-warning py-2 px-3 small">` +
        `<div class="mb-1">Some projects were skipped due to missing Proxmox credentials or API token:</div>` +
        `<ul class="mb-2">${items}</ul>` +
        `<div class="d-flex gap-2">` +
        `<button class="btn btn-sm btn-primary" onclick="fixAllCredsFromNote()">Fix All Creds</button>` +
        `<button class="btn btn-sm btn-outline-secondary" onclick="vmRefresh({forceRefresh:true})">Refresh</button>` +
        `</div>` +
        `</div>`;
      // Auto-open the first skipped project's login once per session (with user-friendly prompt)
      try {
        const AUTO_KEY = 'toolhub.vm.mgr.autoOpenFixCreds.v1';
        if (!sessionStorage.getItem(AUTO_KEY) && skipped.length > 0) {
          sessionStorage.setItem(AUTO_KEY, '1');
          // Show a more user-friendly prompt instead of auto-opening
          const firstKey = canonicalPid(skipped[0]);
          const firstProj = byId[firstKey];
          const projName = firstProj?.name || firstKey;

          // Add a dismissible helper banner
          const helperBanner = document.createElement('div');
          helperBanner.className = 'alert alert-info alert-dismissible fade show py-2 px-3 small mt-2';
          helperBanner.innerHTML = `
            <button type="button" class="btn-close" data-bs-dismiss="alert" aria-label="Close"></button>
            <div class="mb-1"><strong>👋 Need help getting started?</strong></div>
            <div class="mb-2">Click "Fix All Creds" above to quickly configure credentials for all projects, or click individual "Fix Creds" buttons for each project.</div>
            <div>
              <button class="btn btn-sm btn-outline-primary" onclick="fixAllCredsFromNote(); this.closest('.alert').remove();">
                Configure All Now
              </button>
            </div>
          `;

          // Insert after the warning note
          if (note.parentNode) {
            note.parentNode.insertBefore(helperBanner, note.nextSibling);
          }
        }
      } catch { }
    } else { note.innerHTML = ''; }
  }
  // Show progress bar and start timing
  const refreshStartTime = performance.now();
  const setRefreshProg = (pct, text, detail) => {
    try { updateVmInlineProgress(pct, text, detail); } catch { }
    if (showProgressDialog) {
      try { updateActionProgress(pct, text, detail); } catch { }
    }
  };
  try { showVmInlineProgress('Projects 0/0', 5, 'Preparing multi-project refresh…'); } catch { }
  if (showProgressDialog) {
    try { showActionProgress('VM Refresh', 'Preparing multi-project refresh…'); } catch { }
  }
  const rows = [];
  try { const d = await http('GET', '/api/projects'); ALL_PROJECTS = normalizeProjects(d.projects) || ALL_PROJECTS; } catch { }
  const mapById = {}; (ALL_PROJECTS || []).forEach(p => { const key = canonicalPid(p.id); if (key) mapById[key] = p; });
  const totalRefreshProjects = Math.max(ok.length, 1);
  let refreshedProjects = 0;
  const projectRowsByPid = new Map();
  const runProjectRefresh = (pid, project) => new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const entry = queueRemoteAction(`Refresh VMs for project ${project.name || pid}`, async () => {
      const projectRows = [];
      try {
        const sess = await hydrateProxCredsFromPersisted(pid);
        const body = {
          username: sess.username || undefined,
          password: sess.password || undefined,
          baseUrl: project.proxmox_url || undefined,
          apiPort: project.proxmox_api_port || undefined,
          verifySSL: project.proxmox_verify_ssl !== false,
          forceRefresh: forceRefresh || undefined,
        };
        const resp = await http('POST', `/api/projects/${encodeURIComponent(pid)}/instances/refresh/vm`, body);
        try { vmApplyServerResources(pid, resp?.server_resources); } catch { }
        vmMarkLiveRefreshed(pid);
        const statuses = resp.instance_statuses || [];
        const statusMap = new Map(statuses.map(s => [Number(s.index || 0), s]));
        const hasAnyStatus = statuses.length > 0;
        const inst = Number(project.instances || 0);
        const tag = String(project.tag || '').trim();
        const vms = project.vms || [];
        const creds = project.credentials || [];
        for (let i = 1; i <= inst; i++) {
          const suffix = `${tag}${i}`;
          const cred = creds[i - 1] || {};
          const uname = (cred.username ?? '').trim();
          const pword = cred.password ?? '';
          const st = statusMap.get(i) || {};
          const details = Array.isArray(st.vm_details) ? st.vm_details : [];
          const detailMap = new Map(details.map(d => [String(d.name || ''), d]));
          for (const v of vms) {
            const baseName = String((v && v.name) || '');
            const vmName = `${baseName}${suffix}`;
            const d2 = detailMap.get(vmName) || null;
            const rowStatus = hasAnyStatus ? (d2 ? 'created' : 'missing') : 'n/a';
            const user_access = (d2 && d2.user_access !== undefined && d2.user_access !== null) ? _coerceEnabled(d2.user_access, false) : null;
            projectRows.push({ pid, project: project.name, index: i, vmName, baseName, viewable_to_user: _coerceEnabled(v && v.viewable_to_user, true), user_access, uname, pword, status: rowStatus, detail: d2, instStatus: st, vm_user: v.vm_user, vm_pass: v.vm_pass });
          }
        }
      } catch (e) {
        try { (window.shell && shell.logWarn) ? shell.logWarn(`Refresh skipped for ${project?.name || pid}: ${e?.message || e}`) : console.warn('Refresh skipped', pid, e); } catch { }
      }
      finish({ pid, rows: projectRows });
    }, {
      projectId: pid,
      exclusive: false,
      lockProject: true,
      allowDuplicate: true,
      onCancel: () => finish({ pid, rows: [] }),
    });
    if (!entry) finish({ pid, rows: [] });
  });
  const refreshQueue = ok.slice();
  const refreshConcurrency = Math.min(4, Math.max(1, refreshQueue.length));
  setRefreshProg(
    Math.max(8, Math.min(90, Math.round((refreshedProjects / totalRefreshProjects) * 85))),
    `Projects 0/${totalRefreshProjects}`,
    `Refreshing up to ${refreshConcurrency} project(s) in parallel…`
  );
  const workers = Array.from({ length: refreshConcurrency }, () => (async () => {
    for (;;) {
      const pid = refreshQueue.shift();
      if (!pid) return;
      const key = canonicalPid(pid);
      const p = mapById[key];
      if (!p) continue;
      const result = await runProjectRefresh(pid, p);
      projectRowsByPid.set(pid, Array.isArray(result?.rows) ? result.rows : []);
      refreshedProjects += 1;
      setRefreshProg(
        Math.max(10, Math.min(92, Math.round((refreshedProjects / totalRefreshProjects) * 90))),
        `Projects ${refreshedProjects}/${totalRefreshProjects}`,
        `Refreshed ${refreshedProjects}/${totalRefreshProjects} selected project(s)…`
      );
    }
  })());
  await Promise.all(workers);
  for (const pid of ok) {
    const projectRows = projectRowsByPid.get(pid);
    if (Array.isArray(projectRows) && projectRows.length) rows.push(...projectRows);
  }
  // Also show config-only rows for skipped projects so the table isn't empty and Project column can be sorted/seen
  try {
    for (const pid of skipped) {
      const key = canonicalPid(pid);
      const p = mapById[key]; if (!p) continue;
      const inst = Number(p.instances || 0); const tag = String(p.tag || '').trim(); const vms = p.vms || []; const creds = p.credentials || [];
      for (let i = 1; i <= inst; i++) {
        const suffix = `${tag}${i}`; const cred = creds[i - 1] || {}; const uname = (cred.username ?? '').trim(); const pword = cred.password ?? '';
        for (const v of vms) { const baseName = String((v && v.name) || ''); const vmName = `${baseName}${suffix}`; rows.push({ pid, project: p.name, index: i, vmName, baseName, viewable_to_user: _coerceEnabled(v && v.viewable_to_user, true), user_access: null, uname, pword, status: 'n/a', detail: null, instStatus: null }); }
      }
    }
  } catch { }
  // Only update the UI if we're still viewing the same set of projects
  const currentPids = getActivePids();
  const sameSelection = startPids.length === currentPids.length && startPids.every(pid => currentPids.includes(pid));

  if (sameSelection) {
    window.__MERGED_ROWS__ = rows;
    setRefreshProg(95, 'Rendering…', `Rendering ${rows.length} VM row(s)…`);
    try {
      const projCount = new Set(rows.map(r => canonicalPid(r.pid))).size;
      const vmCount = rows.length;
      (window.shell && shell.logDebug) ? shell.logDebug(`VM Manager: rendering ${vmCount} row(s) across ${projCount} project(s).`) : console.debug('VM Manager rows:', vmCount, 'projects:', projCount);
    } catch { }
    renderMergedVmTable(rows);
  } else {
    try { (window.shell && shell.logInfo) ? shell.logInfo('VM Refresh: completed but project selection changed, discarding results') : console.log('VM Refresh: project selection changed, discarding'); } catch { }
  }

  // Log refresh time for performance monitoring
  const refreshEndTime = performance.now();
  const refreshDuration = Math.round(refreshEndTime - refreshStartTime);
  try {
    if (window.shell && shell.logInfo) {
      shell.logInfo(`VM Refresh completed in ${refreshDuration}ms`);
    } else {
      console.log(`VM Refresh completed in ${refreshDuration}ms`);
    }
  } catch { }

  if (showProgressDialog) {
    try { updateActionProgress(100, 'Done', `Refreshed ${refreshedProjects}/${totalRefreshProjects} project(s) in ${refreshDuration}ms`); } catch { }
  }
  try { hideVmInlineProgress(); } catch { }
  if (showProgressDialog) {
    try { hideActionProgress(); } catch { }
  }
  })();
  VM_MULTI_REFRESH_PROMISES.set(refreshKey, refreshTask);
  try {
    return await refreshTask;
  } finally {
    if (VM_MULTI_REFRESH_PROMISES.get(refreshKey) === refreshTask) {
      VM_MULTI_REFRESH_PROMISES.delete(refreshKey);
    }
  }
}

function renderMergedVmTable(rows) {
  const host = document.getElementById('vm-table'); if (!host) return;
  const f = (FILTER_TEXT || '').toLowerCase().trim();
  const allRows = Array.isArray(rows) ? rows : [];
  if (!allRows.length) {
    host.innerHTML = '<div class="alert alert-info mb-0">No VM definitions are available for the selected projects. Configure VMs on the Configuration page or adjust the project selection.</div>';
    return;
  }
  let filtered = allRows;
  if (f) {
    if (FILTER_IS_REGEX) {
      let re = null; try { re = new RegExp(FILTER_TEXT, 'i'); } catch { re = null; }
      const errEl = document.getElementById('vm-filter-error'); if (re) { if (errEl) errEl.classList.add('d-none'); filtered = allRows.filter(r => re.test(vmBuildFilterHaystack(r))); } else { if (errEl) errEl.classList.remove('d-none'); filtered = []; }
    } else {
      const errEl = document.getElementById('vm-filter-error'); if (errEl) errEl.classList.add('d-none');
      filtered = allRows.filter(r => vmBuildFilterHaystack(r).toLowerCase().includes(f));
    }
  }
  if (!filtered.length) {
    const hasFilter = !!f;
    const reason = hasFilter ? 'No VMs match the current filter.' : 'No VM entries were returned for the selected projects.';
    host.innerHTML = `<div class="alert alert-warning mb-0">${reason}</div>`;
    return;
  }
  // Row/group comparator based on current sort
  const compare = (a, b) => { const dir = SORT_STATE.dir === 'desc' ? -1 : 1; const key = SORT_STATE.key; let va, vb; if (key === 'index') { va = a.index; vb = b.index; } else if (key === 'project') { va = (a.project || '').toLowerCase(); vb = (b.project || '').toLowerCase(); } else if (key === 'name') { va = (a.vmName || '').toLowerCase(); vb = (b.vmName || '').toLowerCase(); } else if (key === 'cred') { va = (a.uname || '').toLowerCase(); vb = (b.uname || '').toLowerCase(); } else if (key === 'status') { va = (a.status || '').toLowerCase(); vb = (b.status || '').toLowerCase(); } else if (key === 'state') { va = vmStateSortWeight(a.detail); vb = vmStateSortWeight(b.detail); } else if (key === 'id') { va = a.detail && a.detail.vmid != null ? Number(a.detail.vmid) : Number.POSITIVE_INFINITY; vb = b.detail && b.detail.vmid != null ? Number(b.detail.vmid) : Number.POSITIVE_INFINITY; } else if (key === 'node') { va = String(a.detail && a.detail.node || '').toLowerCase(); vb = String(b.detail && b.detail.node || '').toLowerCase(); } else if (key === 'template') { const tnA = a.detail && a.detail.template_name ? String(a.detail.template_name) : ''; const tiA = a.detail && a.detail.template_id != null ? ('#' + a.detail.template_id) : ''; const tA = (tnA || tiA).toLowerCase(); const tnB = b.detail && b.detail.template_name ? String(b.detail.template_name) : ''; const tiB = b.detail && b.detail.template_id != null ? ('#' + b.detail.template_id) : ''; const tB = (tnB || tiB).toLowerCase(); va = tA; vb = tB; } else { va = a.index; vb = b.index; } if (va < vb) return -1 * dir; if (va > vb) return 1 * dir; const nA = (a.vmName || '').toLowerCase(); const nB = (b.vmName || '').toLowerCase(); if (nA < nB) return -1; if (nA > nB) return 1; return 0; };
  // Group rows by (pid,index) so we can rowspan the credentials once per instance
  const groups = new Map();
  for (const r of filtered) {
    const gk = `${r.pid}|${r.index}`;
    if (!groups.has(gk)) groups.set(gk, []);
    groups.get(gk).push(r);
  }
  // Sort within each group
  for (const arr of groups.values()) arr.sort(compare);
  // Determine group order: by index when sorting by index; otherwise by the compare() of each group's first row
  const groupKeys = Array.from(groups.keys()).sort((ka, kb) => {
    const [pa, ia] = [ka.split('|')[0], Number(ka.split('|')[1])];
    const [pb, ib] = [kb.split('|')[0], Number(kb.split('|')[1])];
    if (SORT_STATE.key === 'index') return SORT_STATE.dir === 'desc' ? (ib - ia) : (ia - ib);
    // project sort: stable by project, then index
    if (SORT_STATE.key === 'project') {
      const a0 = (groups.get(ka) || [])[0]; const b0 = (groups.get(kb) || [])[0];
      if (a0 && b0) { const pA = (a0.project || '').toLowerCase(); const pB = (b0.project || '').toLowerCase(); if (pA < pB) return SORT_STATE.dir === 'desc' ? 1 : -1; if (pA > pB) return SORT_STATE.dir === 'desc' ? -1 : 1; return ia - ib; }
      return ia - ib;
    }
    const aTop = (groups.get(ka) || [])[0];
    const bTop = (groups.get(kb) || [])[0];
    if (aTop && bTop) return compare(aTop, bTop);
    if (aTop) return -1;
    if (bTop) return 1;
    return 0;
  });
  // Build header
  const allSelected = (SELECTED_ROWS.size > 0 && filtered.length > 0 && filtered.every(r => SELECTED_ROWS.has(`${r.pid}|${r.index}|${r.vmName}`)));
  let html = '<table class="table table-sm align-middle"><thead><tr>' +
    '<th style="width:2.5rem"><input type="checkbox" id="chk-all" ' + (allSelected ? 'checked' : '') + ' /></th>' +
    (VM_COLS.project ? '<th role="button" aria-sort="' + ariaSort('project') + '" onclick="vmSortBy(\'project\')">Project' + sortIcon('project') + '</th>' : '') +
    (VM_COLS.name ? '<th role="button" aria-sort="' + ariaSort('name') + '" onclick="vmSortBy(\'name\')">Generated VM Names' + sortIcon('name') + '</th>' : '') +
    (VM_COLS.cred ? '<th aria-sort="' + ariaSort('cred') + '">' +
      '<div class="d-flex align-items-center gap-2">' +
      '<span role="button" onclick="vmSortBy(\'cred\')">Credentials' + sortIcon('cred') + '</span>' +
      '<button type="button" id="btn-toggle-passwords" class="btn btn-sm btn-link p-0" title="Show/Hide passwords" aria-label="Show/Hide passwords">' +
      '<span class="bi" id="icon-eye">&#128065;&#xFE0E; </span>' +
      '</button>' +
      '</div>' +
      '</th>' : '') +
    (VM_COLS.status ? '<th role="button" aria-sort="' + ariaSort('status') + '" onclick="vmSortBy(\'status\')">Status' + sortIcon('status') + '</th>' : '') +
    (VM_COLS.state ? '<th role="button" aria-sort="' + ariaSort('state') + '" onclick="vmSortBy(\'state\')">State' + sortIcon('state') + '</th>' : '') +
    (VM_COLS.id ? '<th role="button" aria-sort="' + ariaSort('id') + '" onclick="vmSortBy(\'id\')">ID' + sortIcon('id') + '</th>' : '') +
    (VM_COLS.node ? '<th role="button" aria-sort="' + ariaSort('node') + '" onclick="vmSortBy(\'node\')">Node Name' + sortIcon('node') + '</th>' : '') +
    (VM_COLS.template ? '<th role="button" aria-sort="' + ariaSort('template') + '" onclick="vmSortBy(\'template\')">TemplateName/ID' + sortIcon('template') + '</th>' : '') +
    (VM_COLS.nets ? '<th>Adaptors</th>' : '') +
    '</tr></thead><tbody>';
  // Render groups with a single credentials cell per group
  for (const gk of groupKeys) {
    const arr = groups.get(gk) || [];
    const rowspan = arr.length || 1;
    let first = true;
    for (const r of arr) {
      const d = r.detail || {};
      const masked = r.pword ? '•'.repeat(Math.min(r.pword.length, 12)) : '—';
      const credText = (r.uname || r.pword) ? `${escHtml(r.uname || '—')} / ${SHOW_PASSWORDS ? escHtml(r.pword || '—') : masked}` : 'n/a';
      let credExtras = '';
      try {
        const instStatus = r.instStatus || {};
        const mgr = instStatus.managers || {};
        const poolsStatus = String(mgr.pools || '').toLowerCase();
        const total = Number(mgr.pools_member_total || 0);
        const count = Number(mgr.pools_member_count || 0);
        const tipCount = (total || count) ? ` (${count}/${total} in pool)` : '';
        if (poolsStatus === 'missing') {
          credExtras = ` <i class="bi bi-people-fill text-white" style="-webkit-text-stroke: 0.5px #6c757d; text-shadow: 0 0 1px #6c757d;" title="No Proxmox pool"></i>`;
        } else if (poolsStatus === 'ready' || poolsStatus === 'ok' || poolsStatus === 'created') {
          const memberState = String(mgr.pools_member_state || '').toLowerCase();
          if (memberState === 'all') {
            credExtras = ` <i class="bi bi-people-fill text-success" title="Pool exists; all VMs are members${tipCount}"></i>`;
          } else if (memberState === 'partial') {
            credExtras = ` <i class="bi bi-people-fill text-warning" title="Pool exists; not all VMs are members${tipCount}"></i>`;
          } else if (memberState === 'error') {
            credExtras = ` <i class="bi bi-people-fill text-secondary" title="Pool exists; membership unknown"></i>`;
          } else {
            credExtras = ` <i class="bi bi-people-fill text-secondary" title="Pool exists; membership status unknown"></i>`;
          }
        } else if (poolsStatus === 'error') {
          credExtras = ' <i class="bi bi-people text-danger" title="Pool status error"></i>';
        } else {
          credExtras = ' <i class="bi bi-people text-secondary" title="Pool state unknown"></i>';
        }
      } catch { }
      const stateHtml = renderVmStateBadges(d);
      const idHtml = d && d.vmid != null ? `#${d.vmid}` : '—';
      const nodeHtml = d && d.node ? escHtml(d.node) : '—';
      const templateHtml = (() => {
        const tid = d && d.template_id != null ? `#${d.template_id}` : '';
        const tn = d && d.template_name ? escHtml(d.template_name) : '';
        const both = [tn, tid].filter(Boolean).join(' ');
        const hasValidationCommands = resolveValidationConfiguredFlag(r, d);
        if (!hasValidationCommands) {
          return `${both || '—'}<div class="mt-1"><span class="d-inline-flex align-items-center gap-1 text-muted" title="Validation commands not configured"><i class="bi bi-robot"></i><i class="bi bi-dash-circle-fill small"></i></span></div>`;
        }
        const agentEnabled = !!(d && d.qemu_agent_enabled);
        const validationState = String(d?.qemu_agent_validation_state || '').trim().toLowerCase();
        const agentValidated = validationState ? validationState === 'passed' : !!(d && d.qemu_agent_validated);
        let agentIcon = '';
        if (!agentEnabled) {
          agentIcon = '<span class="d-inline-flex align-items-center gap-1 text-secondary" title="QEMU Guest Agent off"><i class="bi bi-robot"></i><i class="bi bi-slash-circle-fill small"></i></span>';
        } else if (agentValidated) {
          agentIcon = '<span class="d-inline-flex align-items-center gap-1 text-success" title="QEMU Guest Agent on and validated"><i class="bi bi-robot"></i><i class="bi bi-check-circle-fill small"></i></span>';
        } else if (validationState === 'failed') {
          agentIcon = '<span class="d-inline-flex align-items-center gap-1 text-danger" title="QEMU guest agent on, validation failed"><i class="bi bi-robot"></i><i class="bi bi-x-circle-fill small"></i></span>';
        } else {
          agentIcon = '<span class="d-inline-flex align-items-center gap-1 text-warning" title="QEMU Guest Agent on, not validated"><i class="bi bi-robot"></i><i class="bi bi-exclamation-circle-fill small"></i></span>';
        }
        return `${both || '—'}<div class="mt-1">${agentIcon}</div>`;
      })();
      const effAccess = (r.user_access !== undefined && r.user_access !== null) ? _coerceEnabled(r.user_access, false) : _coerceEnabled(r.viewable_to_user, true);
      const accessIcon = effAccess
        ? '<i class="bi bi-sunglasses ms-1 text-success" title="User Access: Granted"></i>'
        : '<i class="bi bi-sunglasses ms-1 text-white" style="-webkit-text-stroke: 0.5px #6c757d; text-shadow: 0 0 1px #6c757d;" title="User Access: Not granted"></i>';
      let adaptorsCell = '<span class="text-muted">—</span>';
      const nets = Array.isArray(d?.nets) ? d.nets : [];
      if (nets.length) {
        const pills = nets.map(n => `<span class="badge bg-light text-dark border">${escHtml(n)}</span>`).join(' ');
        adaptorsCell = `<div class="d-flex flex-wrap gap-1">${pills}</div>`;
      }
      const key = `${r.pid}|${r.index}|${r.vmName}`; const checked = SELECTED_ROWS.has(key) ? 'checked' : '';
      let credApplyIcon = '';
      if (r.vm_user || r.vm_pass) {
        let iconColor = 'text-secondary opacity-50';
        let statusTag = ' (Status Unknown)';
        if (r.status === 'n/a') {
          statusTag = ' (Needs Refresh)';
        } else if (r.status === 'missing') {
          statusTag = ' (VM Missing)';
        } else {
          const desc = (d && d.description) ? String(d.description) : '';
          let isApplied = false;
          let isMismatch = false;
          try {
            const match = desc.match(/\{[^{}]*"Scenario"[^{}]*\}/);
            if (match) {
              const parsed = JSON.parse(match[0]);
              if (parsed && typeof parsed === 'object' && parsed.Scenario) {
                isApplied = true;
                const appliedScenario = String(parsed.Scenario || '');
                const appliedUser = String(parsed.User || '');
                const appliedPass = String(parsed.Pass || '');
                const targetScenario = String(r.project || '');
                const targetUser = String(r.vm_user || '');
                const targetPass = String(r.vm_pass || '');

                if (appliedScenario !== targetScenario) {
                  isMismatch = true;
                  statusTooltip = `Mismatch: Scenario (Project: '${targetScenario}', VM: '${appliedScenario}')`;
                } else if (appliedUser !== targetUser || appliedPass !== targetPass) {
                  isMismatch = true;
                  statusTooltip = `Mismatch: Creds (Proj User: '${targetUser}', VM User: '${appliedUser}')`;
                }
              }
            }
          } catch (e) { }

          if (isMismatch) {
            iconColor = 'text-warning';
            statusTag = ' (Mismatch)';
          } else if (isApplied) {
            iconColor = 'text-success';
            statusTag = ' (Applied)';
          } else {
            iconColor = 'text-warning';
            statusTag = ' (Not Applied)';
          }
        }
        const titleText = `User: ${r.vm_user || '(Not set)'}, Pass: ${r.vm_pass || '(Not set)'}${statusTag}`;
        credApplyIcon = ` <i class="bi bi-person-badge ${iconColor}" title="${escHtml(titleText)}"></i>`;
      }
      html += `<tr>` +
        `<td><input type=\"checkbox\" class=\"row-chk\" data-key=\"${escHtml(key)}\" ${checked} /></td>` +
        (VM_COLS.project ? `<td><span class=\"badge bg-light text-dark\">${escHtml(r.project)}</span></td>` : '') +
        (VM_COLS.name ? `<td>${escHtml(r.vmName)}${credApplyIcon}</td>` : '') +
        (VM_COLS.cred ? (first ? `<td class="font-monospace" rowspan="${rowspan}">` +
          `<div class="d-flex align-items-center">` +
          `<div class="flex-grow-1">${credText}</div>` +
          `<div class="ms-2">${credExtras}</div>` +
          `</div>` +
          `</td>` : '') : '') +
        (VM_COLS.status ? `<td>${badgeForStatus('vm', r.status)}${accessIcon}</td>` : '') +
        (VM_COLS.state ? `<td>${stateHtml}</td>` : '') +
        (VM_COLS.id ? `<td>${idHtml}</td>` : '') +
        (VM_COLS.node ? `<td>${nodeHtml}</td>` : '') +
        (VM_COLS.template ? `<td>${templateHtml}</td>` : '') +
        (VM_COLS.nets ? `<td>${adaptorsCell}</td>` : '') +
        `</tr>`;
      first = false;
    }
  }
  html += '</tbody></table>';
  host.innerHTML = html;
  vmEnsureScrollPersistence();
  // Wire header checkbox and row checkboxes
  try {
    const all = host.querySelector('#chk-all');
    if (all) all.addEventListener('change', (e) => {
      if (e.target.checked) { SELECTED_ROWS = new Set(filtered.map(r => `${r.pid}|${r.index}|${r.vmName}`)); }
      else { SELECTED_ROWS.clear(); }
      renderMergedVmTable(rows);
      updateRefreshState();
    });
    // Eye toggle
    const eye = host.querySelector('#btn-toggle-passwords');
    if (eye) eye.addEventListener('click', () => { SHOW_PASSWORDS = !SHOW_PASSWORDS; renderMergedVmTable(rows); });
    host.querySelectorAll('.row-chk').forEach(cb => {
      cb.addEventListener('change', (e) => {
        const key = String(e.target.getAttribute('data-key'));
        if (e.target.checked) SELECTED_ROWS.add(key); else SELECTED_ROWS.delete(key);
        updateRefreshState();
      });
    });
  } catch { }
}

// Sidebar: create a new project from VM Manager page
async function createProjectSidebar() {
  try {
    const input = document.getElementById('proj-name');
    const name = (input && input.value ? input.value.trim() : '');
    if (!name) { alert('Enter a project name.'); return; }
    try { (window.shell && shell.logInfo) ? shell.logInfo(`VM: creating project "${name}"…`) : console.log('VM: creating project', name); } catch { }
    const res = await http('POST', '/api/projects', { name });
    if (input) input.value = '';
    const pid = (res && (res.id || res.pid)) ? (res.id || res.pid) : '';
    if (pid && window.shell && shell.setCurrentProjectId) shell.setCurrentProjectId(pid);
    // Redirect to configuration page so it loads the new project
    try { if (window.shell && shell.refreshSidebar) await shell.refreshSidebar('config'); } catch { }
    try { if (pid) location.href = '/'; else location.href = '/'; } catch { }
    try { (window.shell && shell.logSuccess) ? shell.logSuccess('VM: project created') : console.log('VM: project created'); } catch { }
  } catch (e) {
    alert('Failed to create project: ' + (e && e.message ? e.message : 'Unknown error'));
    try { (window.shell && shell.logError) ? shell.logError('VM: create project failed: ' + (e && e.message ? e.message : e)) : console.error('VM: create project failed:', e); } catch { }
  }
}

// Sidebar: import a project ZIP from VM Manager page
async function importProjectSidebar() {
  const input = document.getElementById('import-file');
  if (!input || !input.files || !input.files[0]) return;
  const toggleBusy = (flag) => {
    try {
      if (window.shell && typeof shell.setSidebarImportBusy === 'function') {
        shell.setSidebarImportBusy(flag);
        return;
      }
    } catch { }
    try {
      input.disabled = !!flag;
      const label = input.closest('label');
      if (label) {
        label.classList.toggle('disabled', !!flag);
        if (flag) label.setAttribute('aria-disabled', 'true'); else label.removeAttribute('aria-disabled');
        label.style.pointerEvents = flag ? 'none' : '';
        label.style.opacity = flag ? '0.65' : '';
      }
    } catch { }
  };
  toggleBusy(true);
  const fd = new FormData();
  fd.append('file', input.files[0]);
  try {
    await runQueued(`Import project: ${input.files[0].name}`, async () => {
      try { (window.shell && shell.logInfo) ? shell.logInfo(`VM: importing project from ${input.files[0].name}`) : console.log('VM: importing project from', input.files[0].name); } catch { }
      const resp = await http('POST', '/api/projects/import', fd);
      input.value = '';
      const importedId = (resp && resp.id) || (resp && resp.imported && resp.imported[0] && resp.imported[0].id) || '';
      if (importedId && window.shell && shell.setCurrentProjectId) shell.setCurrentProjectId(importedId);
      try { if (window.shell && shell.refreshSidebar) await shell.refreshSidebar('vm'); } catch { }
      try { if (importedId) await vmLoadProjectById(importedId); } catch { }
      try { (window.shell && shell.logSuccess) ? shell.logSuccess('VM: project imported') : console.log('VM: project imported'); } catch { }
    }, { projectId: getCurrentPid() });
  } catch (e) {
    alert('Error importing project: ' + (e && e.message ? e.message : 'Unknown error'));
    try { (window.shell && shell.logError) ? shell.logError('VM: import project failed: ' + (e && e.message ? e.message : e)) : console.error('VM: import project failed:', e); } catch { }
  } finally {
    toggleBusy(false);
  }
}

// VM Manager: open import options modal before importing
function openImportOptionsVM() {
  const input = document.getElementById('import-file');
  if (!input || !input.files || !input.files[0]) return;
  const modalEl = document.getElementById('importOptionsVM');
  if (!modalEl || !window.bootstrap) { return importProjectSidebar(); }
  try {
    const c = document.getElementById('impvm-creds');
    const v = document.getElementById('impvm-vms');
    const warn = document.getElementById('impvm-vms-warning');
    if (c) c.checked = true;
    if (v) v.checked = true;
    if (warn) warn.style.display = v && v.checked ? 'block' : 'none';
  } catch { }
  const m = new bootstrap.Modal(modalEl);
  m.show();
  const btn = document.getElementById('impvm-continue');
  if (btn) {
    btn.onclick = async () => {
      const includeCreds = !!document.getElementById('impvm-creds')?.checked;
      const includeVms = !!document.getElementById('impvm-vms')?.checked;
      if (includeVms) {
        const proceed = confirm('Importing VMs can be very time-consuming. This will run on the remote machine, download disk files, and compress them. Continue?');
        if (!proceed) return;
      }
      try { m.hide(); } catch { }
      // Pass flags via global FormData appending in importProjectSidebar
      await importProjectSidebarWithFlags({ includeCreds, includeVms });
    };
  }
}
// Helper: append flags on import
async function importProjectSidebarWithFlags(opts) {
  const input = document.getElementById('import-file');
  document.addEventListener('project-selected', () => { try { const sel = document.getElementById('vm-auto-interval'); if (sel) sel.value = String(readAuto() || 0); apply(); } catch { } });
  const fd = new FormData();
  fd.append('file', input.files[0]);
  if (opts && typeof opts.includeCreds === 'boolean') fd.append('includeCreds', String(opts.includeCreds));
  if (opts && typeof opts.includeVms === 'boolean') fd.append('includeVms', String(opts.includeVms));
  const toggleBusy = (flag) => {
    try {
      if (window.shell && typeof shell.setSidebarImportBusy === 'function') {
        shell.setSidebarImportBusy(flag);
        return;
      }
    } catch { }
    try {
      input.disabled = !!flag;
      const label = input.closest('label');
      if (label) {
        label.classList.toggle('disabled', !!flag);
        if (flag) label.setAttribute('aria-disabled', 'true'); else label.removeAttribute('aria-disabled');
        label.style.pointerEvents = flag ? 'none' : '';
        label.style.opacity = flag ? '0.65' : '';
      }
    } catch { }
  };
  toggleBusy(true);
  try {
    await runQueued(`Import project: ${input.files[0].name}`, async () => {
      try { (window.shell && shell.logInfo) ? shell.logInfo(`VM: importing project from ${input.files[0].name}`) : console.log('VM: importing project from', input.files[0].name); } catch { }
      const resp = await http('POST', '/api/projects/import', fd);
      input.value = '';
      const importedId = (resp && resp.id) || (resp && resp.imported && resp.imported[0] && resp.imported[0].id) || '';
      if (importedId && window.shell && shell.setCurrentProjectId) shell.setCurrentProjectId(importedId);
      try { if (window.shell && shell.refreshSidebar) await shell.refreshSidebar('vm'); } catch { }
      try { if (importedId) await vmLoadProjectById(importedId); } catch { }
      try { (window.shell && shell.logSuccess) ? shell.logSuccess('VM: project imported') : console.log('VM: project imported'); } catch { }
    }, { projectId: getCurrentPid() });
  } catch (e) {
    alert('Error importing project: ' + (e && e.message ? e.message : 'Unknown error'));
    try { (window.shell && shell.logError) ? shell.logError('VM: import project failed: ' + (e && e.message ? e.message : e)) : console.error('VM: import project failed:', e); } catch { }
  } finally {
    toggleBusy(false);
  }
}

async function vmRefresh(opts) {
  const forceRefresh = (() => {
    try {
      if (typeof opts === 'boolean') return !!opts;
      if (opts && Object.prototype.hasOwnProperty.call(opts, 'forceRefresh')) return !!opts.forceRefresh;
      return true;
    } catch {
      return true;
    }
  })();
  const showProgressDialog = (() => {
    try {
      if (typeof opts === 'boolean') return true;
      return !(opts && opts.showProgressDialog === false);
    } catch {
      return true;
    }
  })();
  if (Array.isArray(SELECTED_PIDS) && SELECTED_PIDS.length > 1) { try { await refreshVmView({ forceRefresh, showProgressDialog }); } catch (e) { alert('Refresh failed: ' + (e && e.message ? e.message : e)); } return; }
  if (!PROJ) { alert('Load a project first.'); return; }
  const refreshProject = {
    id: PROJ.id,
    name: PROJ.name,
    proxmox_url: PROJ.proxmox_url,
    proxmox_api_port: PROJ.proxmox_api_port,
    proxmox_verify_ssl: PROJ.proxmox_verify_ssl,
  };
  const label = `Refresh VMs for project ${refreshProject?.name || refreshProject?.id || ''}`.trim();
  await runQueued(label, async () => {
    // Capture the project ID at the start to prevent race conditions when switching projects
    const refreshPid = refreshProject.id;
    const setProg = (pct, text, detail) => {
      try { updateVmInlineProgress(pct, text, detail); } catch { }
      if (showProgressDialog) {
        try { updateActionProgress(pct, text, detail); } catch { }
      }
    };
    let stopStatusPoll = null;
    try {
      try { shell.beginActionContext('VM Refresh'); } catch { }
      try { (window.shell && shell.logInfo) ? shell.logInfo('VM Refresh: starting…') : console.log('VM Refresh: starting…'); } catch { }
      try { showVmInlineProgress('Preparing…', 5, 'Preparing VM refresh…'); } catch { }
      if (showProgressDialog) {
        try { showActionProgress('VM Refresh', 'Preparing VM refresh…'); } catch { }
      }
      try { shell.step('Progress bar shown'); } catch { }
      setProg(10, 'Preparing…', 'Loading saved Proxmox credentials…');
      const sess = await hydrateProxCredsFromPersisted(refreshPid);
      const body = {
        username: sess.username || undefined,
        password: sess.password || undefined,
        baseUrl: refreshProject.proxmox_url || undefined,
        apiPort: refreshProject.proxmox_api_port || undefined,
        verifySSL: refreshProject.proxmox_verify_ssl !== false,
        forceRefresh: forceRefresh || undefined,
      };
      try { shell.step('Prepared refresh body'); } catch { }
      setProg(15, 'Submitting…', 'Requesting live VM inventory from Proxmox…');
      if (typeof startVmActionStatusPolling === 'function') {
        try { stopStatusPoll = startVmActionStatusPolling(refreshPid, { setProgress: setProg, initialDelay: 200, interval: 900 }); } catch { }
      }
      const resp = await http('POST', `/api/projects/${refreshPid}/instances/refresh/vm`, body);
      try { shell.step('HTTP response received'); } catch { }
      try { vmApplyServerResources(refreshPid, resp?.server_resources); } catch { }
      vmMarkLiveRefreshed(refreshPid);
      // Only update if we're still viewing the same project
      if (PROJ && PROJ.id === refreshPid) {
        PROJ.instance_statuses = resp.instance_statuses || [];
        try {
          const total = Array.isArray(PROJ.instance_statuses) ? PROJ.instance_statuses.length : 0;
          (window.shell && shell.logInfo) ? shell.logInfo(`VM Refresh: received ${total} instance status entr${total === 1 ? 'y' : 'ies'}`) : console.log('VM Refresh entries:', total);
          setProg(95, `Instances ${total}/${total || 1}`, `Loaded ${total} instance status entr${total === 1 ? 'y' : 'ies'}`);
        } catch { }
        try { shell.step('Statuses stored & logged'); } catch { }
        renderVmTable(PROJ);
      } else {
        try { (window.shell && shell.logInfo) ? shell.logInfo('VM Refresh: completed but project changed, discarding results') : console.log('VM Refresh: project changed, discarding'); } catch { }
      }
      try { (window.shell && shell.logSuccess) ? shell.logSuccess('VM Refresh: done') : console.log('VM Refresh: done'); } catch { }
      try { shell.endActionContext(true); } catch { }
    } catch (e) {
      alert('Refresh failed: ' + e.message);
      try { (window.shell && shell.logError) ? shell.logError('VM Refresh failed: ' + e.message) : console.error('VM Refresh failed:', e); } catch { }
      try { shell.endActionContext(false); } catch { }
    } finally {
      if (typeof stopStatusPoll === 'function') {
        try { stopStatusPoll(); } catch { }
      }
      try { hideVmInlineProgress(); } catch { }
      if (showProgressDialog) {
        try { hideActionProgress(); } catch { }
      }
    }
  }, {
    projectId: refreshProject?.id,
    dedupeKey: refreshProject && refreshProject.id ? `vm-refresh::${refreshProject.id}` : label,
    exclusive: false,
    lockProject: false,
    dedupeWhileActive: true,
  });
}

function _vmExpectedBridgeName(adaptorLabel, idx) {
  try {
    const raw = String(adaptorLabel || '').trim();
    const alphaBase = raw.replace(/[^A-Za-z]/g, '');
    const digitMatch = raw.match(/(\d+)$/);
    const suffix = digitMatch ? _vmAdaptorNumericSuffixLetters(digitMatch[1]) : '';
    const allowedBase = suffix ? Math.max(0, 8 - suffix.length) : 8;
    const base = suffix ? `${alphaBase.slice(0, allowedBase)}${suffix}`.slice(0, 8) : alphaBase.slice(0, 8);
    let name = base ? `${base}${idx}` : `br${idx}`;
    if (name.length > 15) name = name.slice(0, 15);
    return name;
  } catch {
    return `br${idx}`;
  }
}

function _vmAdaptorNumericSuffixLetters(value) {
  let num = Number.parseInt(String(value || ''), 10);
  if (!Number.isFinite(num) || num < 0) return '';
  let out = '';
  for (;;) {
    out = String.fromCharCode(65 + (num % 26)) + out;
    num = Math.floor(num / 26) - 1;
    if (num < 0) break;
  }
  return out;
}

function _vmInternetConnectedAdaptorSet(vmCfg) {
  const raw = vmCfg && (vmCfg.internet_connected_adaptors || vmCfg.internet_connected_adapters || vmCfg.internet_connected_interfaces) || [];
  return new Set((Array.isArray(raw) ? raw : []).map(item => String(item || '').trim()).filter(Boolean));
}

function _vmExpectedNetLabelsForGeneratedName(proj, genName, idx) {
  try {
    const tag = String(proj?.tag || '').trim();
    const suffix = `${tag}${idx}`;
    let baseName = String(genName || '');
    if (suffix && baseName.endsWith(suffix)) baseName = baseName.slice(0, baseName.length - suffix.length);
    const vmCfg = (proj?.vms || []).find(v => String(v?.name || '') === baseName) || null;
    const adaptors = Array.isArray(vmCfg?.internal_network_adaptors) ? vmCfg.internal_network_adaptors : [];
    const internetSet = _vmInternetConnectedAdaptorSet(vmCfg);
    if (!adaptors.length) return null;
    const nets = [];
    for (let i = 0; i < adaptors.length; i++) {
      const value = String(adaptors[i] || '').trim();
      const bridge = internetSet.has(value) ? value : _vmExpectedBridgeName(value, idx);
      nets.push(`net${i}(${bridge})`);
    }
    return nets;
  } catch {
    return null;
  }
}

function _vmOptimisticallyUpdateProjectNets(proj, targets, mode) {
  try {
    if (!proj || !Array.isArray(proj.instance_statuses)) return;
    const statusMap = new Map((proj.instance_statuses || []).map(s => [Number(s?.index || 0), s]));
    for (const t of (targets || [])) {
      const idx = Number(t?.index || 0);
      const genName = String(t?.name || '');
      if (!idx || !genName) continue;
      const st = statusMap.get(idx);
      if (!st) continue;
      const details = Array.isArray(st.vm_details) ? st.vm_details : [];
      const d = details.find(x => String(x?.name || '') === genName) || null;
      if (!d) continue;
      if (mode === 'remove') {
        d.nets = [];
      } else {
        const expected = _vmExpectedNetLabelsForGeneratedName(proj, genName, idx);
        if (expected) d.nets = expected;
      }
    }
  } catch { }
}

function _vmOptimisticallyUpdateMergedRows(byId, targetsByPid, mode) {
  try {
    const rows = Array.isArray(window.__MERGED_ROWS__) ? window.__MERGED_ROWS__ : null;
    if (!rows) return;
    for (const [pid, targets] of (targetsByPid || new Map()).entries()) {
      const proj = byId ? byId[canonicalPid(pid)] : null;
      for (const t of (targets || [])) {
        const idx = Number(t?.index || 0);
        const genName = String(t?.name || '');
        if (!idx || !genName) continue;
        for (const r of rows) {
          if (canonicalPid(r?.pid) !== canonicalPid(pid)) continue;
          if (Number(r?.index || 0) !== idx) continue;
          if (String(r?.vmName || '') !== genName) continue;
          if (!r.detail) continue;
          if (mode === 'remove') {
            r.detail.nets = [];
          } else {
            const expected = _vmExpectedNetLabelsForGeneratedName(proj, genName, idx);
            if (expected) r.detail.nets = expected;
          }
        }
      }
    }
  } catch { }
}

function _vmOptimisticallyUpdateUserAccessProject(proj, bases, indices, enable) {
  try {
    if (!proj || !Array.isArray(proj.instance_statuses)) return;
    const baseSet = new Set((bases || []).map(b => String(b || '')));
    const idxSet = new Set((indices || []).map(i => Number(i || 0)));
    const tag = String(proj?.tag || '').trim();
    for (const st of (proj.instance_statuses || [])) {
      const idx = Number(st?.index || 0);
      if (!idxSet.has(idx)) continue;
      const details = Array.isArray(st?.vm_details) ? st.vm_details : [];
      for (const d of details) {
        const genName = String(d?.name || '');
        if (!genName) continue;
        const suffix = `${tag}${idx}`;
        let baseName = genName;
        if (suffix && genName.endsWith(suffix)) baseName = genName.slice(0, genName.length - suffix.length);
        if (!baseSet.has(baseName)) continue;
        d.user_access = !!enable;
      }
    }
  } catch { }
}

function _vmOptimisticallyUpdateMergedUserAccess(byId, accessPlanByPid, enable) {
  try {
    const rows = Array.isArray(window.__MERGED_ROWS__) ? window.__MERGED_ROWS__ : null;
    if (!rows) return;
    for (const [pid, plan] of (accessPlanByPid || new Map()).entries()) {
      const proj = byId ? byId[canonicalPid(pid)] : null;
      const baseSet = new Set((plan?.bases || []).map(b => String(b || '')));
      const idxSet = new Set((plan?.indices || []).map(i => Number(i || 0)));
      for (const r of rows) {
        if (canonicalPid(r?.pid) !== canonicalPid(pid)) continue;
        const idx = Number(r?.index || 0);
        if (!idxSet.has(idx)) continue;
        const baseName = String(r?.baseName || '');
        if (!baseSet.has(baseName)) continue;
        r.user_access = !!enable;
        if (r.detail) r.detail.user_access = !!enable;
      }
      // Keep the per-project snapshot consistent if present.
      try { _vmOptimisticallyUpdateUserAccessProject(proj, Array.from(baseSet), Array.from(idxSet), enable); } catch { }
    }
  } catch { }
}

// Emit detailed action results to bottom console dock
function emitActionLogs(actionName, resp) {
  try {
    const name = String(actionName || 'Action');
    const requestedList = (() => {
      const raw = Array.isArray(resp?.requested_commands) ? resp.requested_commands : [];
      const normalized = normalizeSelectedCommands(raw);
      if (normalized.length) return normalized;
      const single = typeof resp?.requested_command === 'string' ? resp.requested_command.trim() : '';
      return single ? [single] : [];
    })();
    if (requestedList.length === 1) {
      try { shell.logInfo(`${name}: command filter — ${requestedList[0]}`); } catch { }
    } else if (requestedList.length > 1) {
      try { shell.logInfo(`${name}: command filters (${requestedList.length}) — ${requestedList.join(', ')}`); } catch { }
    }
    const outputArchives = Array.isArray(resp?.outputs_zips) && resp.outputs_zips.length
      ? resp.outputs_zips
      : (resp?.outputs_zip ? [resp.outputs_zip] : []);
    outputArchives.forEach(outputsZip => {
      if (!outputsZip?.filename) return;
      const sizeLabel = Number(outputsZip.size || 0) > 0 ? `${outputsZip.filename} (${outputsZip.size} bytes)` : outputsZip.filename;
      try { shell.logInfo(`${name}: output archive ready — ${sizeLabel}`); } catch { }
    });
    const created = Array.isArray(resp?.created) ? resp.created : [];
    const deleted = Array.isArray(resp?.deleted) ? resp.deleted : [];
    const skipped = Array.isArray(resp?.skipped) ? resp.skipped : [];
    const errors = Array.isArray(resp?.errors) ? resp.errors : [];
    const amb = Array.isArray(resp?.ambiguous) ? resp.ambiguous : [];
    const started = Array.isArray(resp?.started) ? resp.started : [];
    const resumed = Array.isArray(resp?.resumed) ? resp.resumed : [];
    const suspended = Array.isArray(resp?.suspended) ? resp.suspended : [];
    const unlocked = Array.isArray(resp?.unlocked) ? resp.unlocked : [];
    const poweredOff = Array.isArray(resp?.powered_off) ? resp.powered_off : [];
    const snapshotted = Array.isArray(resp?.snapshotted) ? resp.snapshotted : [];
    const restored = Array.isArray(resp?.restored) ? resp.restored : [];
    const netsUpdated = Array.isArray(resp?.updated) ? resp.updated : [];
    const netsCleared = Array.isArray(resp?.cleared) ? resp.cleared : [];
    const createdUsers = Array.isArray(resp?.created_users) ? resp.created_users : [];
    const createdPools = Array.isArray(resp?.created_pools) ? resp.created_pools : [];
    const addedMembers = Array.isArray(resp?.added_members) ? resp.added_members : [];
    const deletedUsers = Array.isArray(resp?.deleted_users) ? resp.deleted_users : [];
    const deletedPools = Array.isArray(resp?.deleted_pools) ? resp.deleted_pools : [];
    const updatedUsers = Array.isArray(resp?.updated_users) ? resp.updated_users : [];
    const checkedCreds = Array.isArray(resp?.checked) ? resp.checked : [];
    const notices = Array.isArray(resp?.notices) ? resp.notices : [];
    const infos = Array.isArray(resp?.infos) ? resp.infos : [];
    const applied = Array.isArray(resp?.applied) ? resp.applied : [];
    const unchanged = Array.isArray(resp?.unchanged) ? resp.unchanged : [];
    const pushed = Array.isArray(resp?.pushed) ? resp.pushed : [];
    const pulled = Array.isArray(resp?.pulled) ? resp.pulled : [];
    if (created.length) created.forEach(i => {
      try { shell.logSuccess(`${name}: created ${i?.name || ''} ${i?.vmid ? `(#${i.vmid})` : ''} ${i?.node ? `on ${i.node}` : ''}`); } catch { }
      try {
        const dbg = Array.isArray(i?.debug) ? i.debug : [];
        dbg.forEach(d => { try { shell.logDebug(`${name}: ${d}`); } catch { } });
      } catch { }
    });
    if (deleted.length) deleted.forEach(i => { try { shell.logSuccess(`${name}: deleted ${i?.name || ''} ${i?.vmid ? `(#${i.vmid})` : ''} ${i?.node ? `on ${i.node}` : ''}`); } catch { } });
    if (started.length) started.forEach(i => { try { shell.logSuccess(`${name}: started ${i?.name || ''} ${i?.vmid ? `(#${i.vmid})` : ''}`); } catch { } });
    if (resumed.length) resumed.forEach(i => { try { shell.logSuccess(`${name}: resumed ${i?.name || ''} ${i?.vmid ? `(#${i.vmid})` : ''}`); } catch { } });
    if (suspended.length) suspended.forEach(i => { try { shell.logSuccess(`${name}: suspended ${i?.name || ''} ${i?.vmid ? `(#${i.vmid})` : ''}`); } catch { } });
    if (unlocked.length) unlocked.forEach(i => { try { shell.logSuccess(`${name}: unlocked ${i?.name || ''} ${i?.vmid ? `(#${i.vmid})` : ''}`); } catch { } });
    if (poweredOff.length) poweredOff.forEach(i => { try { shell.logSuccess(`${name}: powered off ${i?.name || ''} ${i?.vmid ? `(#${i.vmid})` : ''}`); } catch { } });
    if (snapshotted.length) snapshotted.forEach(i => { try { shell.logSuccess(`${name}: snapshot ${i?.name || ''} ${i?.snapname ? `(${i.snapname})` : ''} ${i?.vmid ? `#${i.vmid}` : ''}`); } catch { } });
    if (restored.length) restored.forEach(i => { try { shell.logSuccess(`${name}: restored ${i?.name || ''} ${i?.snapname ? `(${i.snapname})` : ''} ${i?.started ? '(started)' : ''}`); } catch { } });
    if (netsUpdated.length) netsUpdated.forEach(i => { try { shell.logSuccess(`${name}: network assigned ${i?.name || ''} ${i?.vmid ? `(#${i.vmid})` : ''} ${i?.node ? `on ${i.node}` : ''}`); } catch { } });
    if (netsCleared.length) netsCleared.forEach(i => { try { shell.logSuccess(`${name}: network removed ${i?.name || ''} ${i?.vmid ? `(#${i.vmid})` : ''} ${i?.node ? `on ${i.node}` : ''}`); } catch { } });
    if (pushed.length) pushed.forEach(i => { try { shell.logSuccess(`${name}: pushed ${i?.item_count ?? i?.file_count ?? 0} item(s) to ${i?.name || ''} ${i?.vmid ? `(#${i.vmid})` : ''}${i?.destination ? ` at ${i.destination}` : ''}`); } catch { } });
    if (pulled.length) pulled.forEach(i => { try { shell.logSuccess(`${name}: pulled ${i?.file_count || 0} file(s) from ${i?.name || ''} ${i?.vmid ? `(#${i.vmid})` : ''}`); } catch { } });
    if (createdUsers.length) createdUsers.forEach(i => { try { shell.logSuccess(`${name}: user created ${i?.userid || ''}`); } catch { } });
    if (createdPools.length) createdPools.forEach(i => { try { shell.logSuccess(`${name}: pool created ${i?.pool || ''}${i?.index ? ` (instance ${i.index})` : ''}`); } catch { } });
    if (addedMembers.length) addedMembers.forEach(i => {
      try { shell.logSuccess(`${name}: pool member added ${i?.pool || ''} — ${i?.name || ''} ${i?.vmid ? `(#${i.vmid})` : ''}${i?.via ? ` [${i.via}]` : ''}`); } catch { }
      try {
        const dbg = Array.isArray(i?.debug) ? i.debug : [];
        dbg.forEach(d => { try { shell.logDebug(`${name}: ${d}`); } catch { } });
      } catch { }
    });
    if (deletedUsers.length) deletedUsers.forEach(i => { try { shell.logSuccess(`${name}: user deleted ${i?.userid || ''}`); } catch { } });
    if (deletedPools.length) deletedPools.forEach(i => { try { shell.logSuccess(`${name}: pool deleted ${i?.pool || ''}${i?.index ? ` (instance ${i.index})` : ''}`); } catch { } });
    if (updatedUsers.length) updatedUsers.forEach(i => { try { shell.logSuccess(`${name}: user updated ${i?.userid || ''}`); } catch { } });
    if (checkedCreds.length) checkedCreds.forEach(i => {
      try {
        const status = String(i?.status || '') === 'ok' ? 'in sync' : (i?.reason || 'drift');
        const access = i?.expected_access ? ` expected=${i.expected_access}` : '';
        shell.logInfo(`${name}: credential check ${i?.userid || ''}${i?.name ? ` for ${i.name}` : ''} — ${status}${access}`);
      } catch { }
    });
    if (infos.length) infos.forEach(n => { try { shell.logInfo(`${name}: info — ${n?.reason || n}`); } catch { } });
    if (applied.length) applied.forEach(a => {
      try {
        const verb = String(a?.action || '').toLowerCase() === 'revoke' ? 'revoked' : 'granted';
        shell.logSuccess(`${name}: ${verb} — ${a?.name || ''} (instance ${a?.index || '?'})`);
      } catch { }
    });
    if (unchanged.length) unchanged.forEach(u => {
      try { shell.logWarn(`${name}: unchanged — ${u?.name || ''} (instance ${u?.index || '?'}) ${u?.reason ? ('(' + u.reason + ')') : ''}`); } catch { }
    });
    if (notices.length) notices.forEach(n => { try { shell.logWarn(`${name}: notice — ${n?.reason || n}`); } catch { } });
    if (skipped.length) skipped.forEach(s => { try { shell.logWarn(`${name}: skipped — ${s?.name || s?.index || ''} ${s?.reason ? ('(' + s.reason + ')') : ''}`); } catch { } });
    if (errors.length) errors.forEach(e => { try { shell.logError(`${name}: error — ${e?.name || e?.node || ''} ${e?.reason || ''}`); } catch { } });
    if (amb.length) amb.forEach(a => { try { shell.logWarn(`${name}: ambiguous — ${a?.name || ''} (${(a?.candidates || []).length} candidates)`); } catch { } });
  } catch { }
}

function renderVmTable(proj) {
  const host = document.getElementById('vm-table');
  if (!proj) { host.innerHTML = ''; return; }
  const projectKey = String(proj?.id ?? '__project__');
  const inst = Number(proj.instances || 0);
  const tag = String(proj.tag || '').trim();
  const vms = proj.vms || [];
  const statuses = proj.instance_statuses || [];
  const creds = proj.credentials || [];
  const statusMap = new Map(statuses.map(s => [Number(s.index || 0), s]));
  const hasAnyStatus = Array.isArray(statuses) && statuses.length > 0;
  // Build rows
  const rows = [];
  for (let i = 1; i <= inst; i++) {
    const suffix = `${tag}${i}`;
    const cred = creds[i - 1] || {};
    const uname = (cred.username ?? '').trim();
    const pword = cred.password ?? '';
    const st = statusMap.get(i) || {};
    const details = Array.isArray(st.vm_details) ? st.vm_details : [];
    const detailMap = new Map(details.map(d => [String(d.name || ''), d]));
    for (const v of vms) {
      const vmName = `${v.name}${suffix}`;
      const d = detailMap.get(vmName) || null;
      const key = `${projectKey}|${i}|${vmName}`;
      // Before first refresh, default to N/A; afterwards, show created/missing
      const rowStatus = hasAnyStatus ? (d ? 'created' : 'missing') : 'n/a';
      rows.push({ key, index: i, vmName, baseName: String((v && v.name) || ''), viewable_to_user: _coerceEnabled(v && v.viewable_to_user, true), user_access: (d && d.user_access !== undefined && d.user_access !== null) ? _coerceEnabled(d.user_access, false) : null, uname, pword, status: rowStatus, detail: d, instStatus: st, vm_user: v.vm_user, vm_pass: v.vm_pass });
    }
  }
  // Apply filter
  const f = (FILTER_TEXT || '').toLowerCase().trim();
  let filtered = rows;
  if (f) {
    if (FILTER_IS_REGEX) {
      let re = null;
      try { re = new RegExp(FILTER_TEXT, 'i'); } catch { re = null; }
      const errEl = document.getElementById('vm-filter-error');
      if (re) {
        if (errEl) errEl.classList.add('d-none');
        filtered = rows.filter(r => re.test(vmBuildFilterHaystack(r)));
      } else {
        // invalid regex; show nothing and display inline error
        if (errEl) errEl.classList.remove('d-none');
        filtered = [];
      }
    } else {
      const errEl = document.getElementById('vm-filter-error');
      if (errEl) errEl.classList.add('d-none');
      filtered = rows.filter(r => vmBuildFilterHaystack(r).toLowerCase().includes(f));
    }
  }
  // Sort rows (we'll sort within instance groups so credentials can be row-spanned once per instance)
  const compareRows = (a, b) => {
    const dir = SORT_STATE.dir === 'desc' ? -1 : 1;
    const key = SORT_STATE.key;
    let va, vb;
    if (key === 'index') { va = a.index; vb = b.index; }
    else if (key === 'name') { va = (a.vmName || '').toLowerCase(); vb = (b.vmName || '').toLowerCase(); }
    else if (key === 'cred') { va = a.uname.toLowerCase(); vb = b.uname.toLowerCase(); }
    else if (key === 'status') { va = (a.status || '').toLowerCase(); vb = (b.status || '').toLowerCase(); }
    else if (key === 'state') {
      va = vmStateSortWeight(a.detail);
      vb = vmStateSortWeight(b.detail);
    }
    else if (key === 'id') {
      const ia = (a.detail && a.detail.vmid !== undefined && a.detail.vmid !== null) ? Number(a.detail.vmid) : Number.POSITIVE_INFINITY;
      const ib = (b.detail && b.detail.vmid !== undefined && b.detail.vmid !== null) ? Number(b.detail.vmid) : Number.POSITIVE_INFINITY;
      va = ia; vb = ib;
    }
    else if (key === 'node') {
      const na = String((a.detail && a.detail.node) || '').toLowerCase();
      const nb = String((b.detail && b.detail.node) || '').toLowerCase();
      va = na; vb = nb;
    }
    else if (key === 'template') {
      const tnA = (a.detail && a.detail.template_name) ? String(a.detail.template_name) : '';
      const tiA = (a.detail && a.detail.template_id !== undefined && a.detail.template_id !== null) ? ('#' + a.detail.template_id) : '';
      const tA = (tnA || tiA).toLowerCase();
      const tnB = (b.detail && b.detail.template_name) ? String(b.detail.template_name) : '';
      const tiB = (b.detail && b.detail.template_id !== undefined && b.detail.template_id !== null) ? ('#' + b.detail.template_id) : '';
      const tB = (tnB || tiB).toLowerCase();
      va = tA; vb = tB;
    }
    else { va = a.index; vb = b.index; }
    if (va < vb) return -1 * dir;
    if (va > vb) return 1 * dir;
    // tie-breaker by vm name then id
    const nA = (a.vmName || '').toLowerCase();
    const nB = (b.vmName || '').toLowerCase();
    if (nA < nB) return -1;
    if (nA > nB) return 1;
    return 0;
  };
  // Group rows by instance index
  const groups = new Map();
  for (const r of filtered) {
    if (!groups.has(r.index)) groups.set(r.index, []);
    groups.get(r.index).push(r);
  }
  // Sort rows within each instance group
  for (const [idx, arr] of groups.entries()) {
    arr.sort(compareRows);
  }
  // Determine instance order: when sorting by a column other than index, order groups by the first row in each group
  const instanceOrder = Array.from(groups.keys()).sort((ia, ib) => {
    if (SORT_STATE.key === 'index') return (SORT_STATE.dir === 'desc' ? ib - ia : ia - ib);
    const aArr = groups.get(ia) || [];
    const bArr = groups.get(ib) || [];
    const aTop = aArr[0];
    const bTop = bArr[0];
    if (aTop && bTop) return compareRows(aTop, bTop);
    if (aTop) return -1;
    if (bTop) return 1;
    return 0;
  });
  // Render table with conditional columns
  let html = '<table class="table table-sm align-middle"><thead><tr>' +
    '<th style="width:2.5rem"><input type="checkbox" id="chk-all" ' + (SELECTED_ROWS.size === filtered.length && filtered.length > 0 ? 'checked' : '') + ' /></th>';
  if (VM_COLS.name) html += '<th role="button" aria-sort="' + ariaSort('name') + '" onclick="vmSortBy(\'name\')">Generated VM Names' + sortIcon('name') + '</th>';
  if (VM_COLS.cred) html += '<th aria-sort="' + ariaSort('cred') + '">' +
    '<div class="d-flex align-items-center gap-2">' +
    '<span role="button" onclick="vmSortBy(\'cred\')">Credentials' + sortIcon('cred') + '</span>' +
    '<button type="button" id="btn-toggle-passwords" class="btn btn-sm btn-link p-0" title="Show/Hide passwords" aria-label="Show/Hide passwords">' +
    '<span class="bi" id="icon-eye">' +
    (SHOW_PASSWORDS ? '&#128065;&#xFE0E; ' : '&#128065;&#xFE0E; ') + '\n' +
    '</span>' +
    '</button>' +
    '</div>' +
    '</th>';
  if (VM_COLS.status) html += '<th role="button" aria-sort="' + ariaSort('status') + '" onclick="vmSortBy(\'status\')">Status' + sortIcon('status') + '</th>';
  if (VM_COLS.state) html += '<th role="button" aria-sort="' + ariaSort('state') + '" onclick="vmSortBy(\'state\')">State' + sortIcon('state') + '</th>';
  if (VM_COLS.id) html += '<th role="button" aria-sort="' + ariaSort('id') + '" onclick="vmSortBy(\'id\')">ID' + sortIcon('id') + '</th>';
  if (VM_COLS.node) html += '<th role="button" aria-sort="' + ariaSort('node') + '" onclick="vmSortBy(\'node\')">Node Name' + sortIcon('node') + '</th>';
  if (VM_COLS.template) html += '<th role="button" aria-sort="' + ariaSort('template') + '" onclick="vmSortBy(\'template\')">TemplateName/ID' + sortIcon('template') + '</th>';
  if (VM_COLS.nets) html += '<th>Adaptors</th>';
  html += '</tr></thead><tbody>';
  for (const idx of instanceOrder) {
    const group = groups.get(idx) || [];
    const rowspan = group.length;
    let first = true;
    for (const r of group) {
      const masked = r.pword ? '•'.repeat(Math.min(r.pword.length, 12)) : '—';
      const credText = (r.uname || r.pword) ? `${escHtml(r.uname || '—')} / ${SHOW_PASSWORDS ? escHtml(r.pword || '—') : masked}` : 'n/a';
      const checked = SELECTED_ROWS.has(r.key) ? 'checked' : '';
      const d = r.detail || {};
      const stateHtml = renderVmStateBadges(d);
      const idHtml = (d && d.vmid !== undefined && d.vmid !== null) ? `#${d.vmid}` : '—';
      const nodeHtml = d && d.node ? escHtml(d.node) : '—';
      const templateHtml = (() => {
        const tid = (d && d.template_id !== undefined && d.template_id !== null) ? `#${d.template_id}` : '';
        const tn = (d && d.template_name) ? escHtml(d.template_name) : '';
        const both = [tn, tid].filter(Boolean).join(' ');
        const hasValidationCommands = resolveValidationConfiguredFlag(r, d);
        if (!hasValidationCommands) {
          return `${both || '—'}<div class="mt-1"><span class="d-inline-flex align-items-center gap-1 text-muted" title="Validation commands not configured"><i class="bi bi-robot"></i><i class="bi bi-dash-circle-fill small"></i></span></div>`;
        }
        const isLxc = d && String(d.type).toLowerCase() === 'lxc';
        const agentEnabled = !!(d && d.qemu_agent_enabled);
        const canExecute = isLxc || agentEnabled;
        const execName = isLxc ? 'LXC SSH Execution' : 'QEMU Guest Agent';
        const validationState = String(d?.qemu_agent_validation_state || '').trim().toLowerCase();
        const agentValidated = validationState ? validationState === 'passed' : !!(d && d.qemu_agent_validated);
        let agentIcon = '';
        if (!canExecute) {
          agentIcon = `<span class="d-inline-flex align-items-center gap-1 text-secondary" title="${execName} off"><i class="bi bi-robot"></i><i class="bi bi-slash-circle-fill small"></i></span>`;
        } else if (agentValidated) {
          agentIcon = `<span class="d-inline-flex align-items-center gap-1 text-success" title="${execName} ready and validated"><i class="bi bi-robot"></i><i class="bi bi-check-circle-fill small"></i></span>`;
        } else if (validationState === 'failed') {
          agentIcon = `<span class="d-inline-flex align-items-center gap-1 text-danger" title="${execName} ready, validation failed"><i class="bi bi-robot"></i><i class="bi bi-x-circle-fill small"></i></span>`;
        } else {
          agentIcon = `<span class="d-inline-flex align-items-center gap-1 text-warning" title="${execName} ready, not validated"><i class="bi bi-robot"></i><i class="bi bi-exclamation-circle-fill small"></i></span>`;
        }
        return `${both || '—'}<div class="mt-1">${agentIcon}</div>`;
      })();
      const effAccess = (r.user_access !== undefined && r.user_access !== null) ? _coerceEnabled(r.user_access, false) : _coerceEnabled(r.viewable_to_user, true);
      const accessIcon = effAccess
        ? '<i class="bi bi-sunglasses ms-1 text-success" title="User Access: Granted"></i>'
        : '<i class="bi bi-sunglasses ms-1 text-white" style="-webkit-text-stroke: 0.5px #6c757d; text-shadow: 0 0 1px #6c757d;" title="User Access: Not granted"></i>';
      // Adaptors list (single VM)
      let adaptorsCell = '<span class="text-muted">—</span>';
      const nets = Array.isArray(d?.nets) ? d.nets : [];
      if (nets.length) {
        const pills = nets.map(n => `<span class="badge bg-light text-dark border">${escHtml(n)}</span>`).join(' ');
        adaptorsCell = `<div class="d-flex flex-wrap gap-1">${pills}</div>`;
      }
      // Credentials cell extras: Proxmox pool icon colored by status
      let credExtras = '';
      try {
        const instStatus = statusMap.get(r.index) || {};
        const mgr = instStatus.managers || {};
        const poolsStatus = String(mgr.pools || '').toLowerCase();
        const total = Number(mgr.pools_member_total || 0);
        const count = Number(mgr.pools_member_count || 0);
        const tipCount = (total || count) ? ` (${count}/${total} in pool)` : '';
        // Color rules:
        // - white: pool missing (no pool)
        // - yellow: pool exists but not all configured VMs are members
        // - green: pool exists and all configured VMs are members
        if (poolsStatus === 'missing') {
          credExtras = ` <i class="bi bi-people-fill text-white" style="-webkit-text-stroke: 0.5px #6c757d; text-shadow: 0 0 1px #6c757d;" title="No Proxmox pool"></i>`;
        } else if (poolsStatus === 'ready' || poolsStatus === 'ok' || poolsStatus === 'created') {
          const memberState = String(mgr.pools_member_state || '').toLowerCase();
          if (memberState === 'all') {
            credExtras = ` <i class="bi bi-people-fill text-success" title="Pool exists; all VMs are members${tipCount}"></i>`;
          } else if (memberState === 'partial') {
            credExtras = ` <i class="bi bi-people-fill text-warning" title="Pool exists; not all VMs are members${tipCount}"></i>`;
          } else if (memberState === 'error') {
            credExtras = ` <i class="bi bi-people-fill text-secondary" title="Pool exists; membership unknown"></i>`;
          } else {
            credExtras = ` <i class="bi bi-people-fill text-secondary" title="Pool exists; membership status unknown"></i>`;
          }
        } else if (poolsStatus === 'error') {
          credExtras = ' <i class="bi bi-people text-danger" title="Pool status error"></i>';
        } else {
          credExtras = ' <i class="bi bi-people text-secondary" title="Pool state unknown"></i>';
        }
      } catch { }
      let credApplyIcon = '';
      if (r.vm_user || r.vm_pass) {
        let iconColor = 'text-secondary opacity-50';
        let statusTag = ' (Status Unknown)';
        if (r.status === 'n/a') {
          statusTag = ' (Needs Refresh)';
        } else if (r.status === 'missing') {
          statusTag = ' (VM Missing)';
        } else {
          const desc = (d && d.description) ? String(d.description) : '';
          let isApplied = false;
          let isMismatch = false;
          try {
            const match = desc.match(/\{[^{}]*"Scenario"[^{}]*\}/);
            if (match) {
              const parsed = JSON.parse(match[0]);
              if (parsed && typeof parsed === 'object' && parsed.Scenario) {
                isApplied = true;
                const appliedScenario = String(parsed.Scenario || '');
                const appliedUser = String(parsed.User || '');
                const appliedPass = String(parsed.Pass || '');
                // Note: PROJ is available in renderVmTable
                const targetScenario = String(PROJ.name || '');
                const targetUser = String(r.vm_user || '');
                const targetPass = String(r.vm_pass || '');

                if (appliedScenario !== targetScenario) {
                  isMismatch = true;
                  statusTooltip = `Mismatch: Scenario (Project: '${targetScenario}', VM: '${appliedScenario}')`;
                } else if (appliedUser !== targetUser || appliedPass !== targetPass) {
                  isMismatch = true;
                  statusTooltip = `Mismatch: Creds (Proj User: '${targetUser}', VM User: '${appliedUser}')`;
                }
              }
            }
          } catch (e) { }

          if (isMismatch) {
            iconColor = 'text-warning';
            statusTag = ' (Mismatch)';
          } else if (isApplied) {
            iconColor = 'text-success';
            statusTag = ' (Applied)';
          } else {
            iconColor = 'text-warning';
            statusTag = ' (Not Applied)';
          }
        }
        const titleText = `User: ${r.vm_user || '(Not set)'}, Pass: ${r.vm_pass || '(Not set)'}${statusTag}`;
        credApplyIcon = ` <i class="bi bi-person-badge ${iconColor}" title="${escHtml(titleText)}"></i>`;
      }
      html += `<tr>` +
        `<td><input type="checkbox" class="row-chk" data-key="${escHtml(r.key)}" ${checked} /></td>` +
        (VM_COLS.name ? `<td>${escHtml(r.vmName)}${credApplyIcon}</td>` : '') +
        (VM_COLS.cred ? (first ? `<td class=\"font-monospace\" rowspan=\"${rowspan}\">` +
          `<div class=\"d-flex align-items-center\">` +
          `<div class=\"flex-grow-1\">${credText}</div>` +
          `<div class=\"ms-2\">${credExtras}</div>` +
          `</div>` +
          `</td>` : '') : '') +
        (VM_COLS.status ? `<td>${badgeForStatus('vm', r.status)}${accessIcon}</td>` : '') +
        (VM_COLS.state ? `<td>${stateHtml}</td>` : '') +
        (VM_COLS.id ? `<td>${idHtml}</td>` : '') +
        (VM_COLS.node ? `<td>${nodeHtml}</td>` : '') +
        (VM_COLS.template ? `<td>${templateHtml}</td>` : '') +
        (VM_COLS.nets ? `<td>${adaptorsCell}</td>` : '') +
        `</tr>`;
      first = false;
    }
  }
  html += '</tbody></table>';
  host.innerHTML = html;
  vmEnsureScrollPersistence();
  // Wire row checkboxes and header checkbox
  const all = host.querySelector('#chk-all');
  if (all) all.addEventListener('change', (e) => {
    if (e.target.checked) { SELECTED_ROWS = new Set(filtered.map(r => r.key)); }
    else { SELECTED_ROWS.clear(); }
    renderVmTable(PROJ);
    updateRefreshState();
  });
  // Wire eye icon toggle
  const eye = host.querySelector('#btn-toggle-passwords');
  if (eye) eye.addEventListener('click', () => { SHOW_PASSWORDS = !SHOW_PASSWORDS; renderVmTable(PROJ); });
  host.querySelectorAll('.row-chk').forEach(cb => {
    cb.addEventListener('change', (e) => {
      const key = String(e.target.getAttribute('data-key'));
      if (e.target.checked) SELECTED_ROWS.add(key); else SELECTED_ROWS.delete(key);
      updateRefreshState();
    });
  });
}

// Sorting handler
function vmSortBy(key) {
  if (SORT_STATE.key === key) {
    SORT_STATE.dir = SORT_STATE.dir === 'asc' ? 'desc' : 'asc';
  } else {
    SORT_STATE.key = key;
    SORT_STATE.dir = 'asc';
  }
  try { if (vmIsMulti && vmIsMulti()) renderMergedVmTable(window.__MERGED_ROWS__ || []); else renderVmTable(PROJ); } catch { renderVmTable(PROJ); }
}

function badgeForStatus(name, value) {
  const label = { vm: 'VM' }[name] || name;
  const v = String(value || '').toLowerCase();
  const cls = v === 'ready' || v === 'ok' || v === 'created' ? 'bg-success' : (v === 'error' ? 'bg-danger' : (v === 'pending' ? 'bg-warning text-dark' : (v === 'missing' ? 'bg-secondary' : 'bg-secondary')));
  const text = v ? v : 'n/a';
  return `<span class="badge ${cls}">${label}: ${escHtml(text)}</span>`;
}

function escHtml(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[c])); }

// Autofill if URL query contains ?id=
window.addEventListener('DOMContentLoaded', () => {
  const u = new URL(window.location.href);
  const id = u.searchParams.get('id');
  if (id) {
    const input = document.getElementById('vm-proj-id');
    if (input) { input.value = id; vmLoadProject(); }
    else { vmLoadProjectById(id).catch(() => { }); }
  }
  // Initialize tooltip for disabled Refresh button
  try {
    if (window.bootstrap) {
      const wrap = document.getElementById('refresh-wrapper');
      if (wrap) new bootstrap.Tooltip(wrap);
    }
  } catch { }
  // Ensure modal is a direct child of body to avoid stacking issues
  try {
    const modalEl = document.getElementById('proxLoginModal');
    if (modalEl && modalEl.parentElement !== document.body) {
      document.body.appendChild(modalEl);
    }
    // Also ensure Projects modal is appended to body to prevent gray-backdrop-without-modal issue
    const projEl = document.getElementById('projectsModal');
    if (projEl && projEl.parentElement !== document.body) {
      document.body.appendChild(projEl);
    }
    const tmplEl = document.getElementById('tmplResolveModal');
    if (tmplEl && tmplEl.parentElement !== document.body) {
      document.body.appendChild(tmplEl);
    }
    const summaryEl = document.getElementById('actionSummaryModal');
    if (summaryEl && summaryEl.parentElement !== document.body) {
      document.body.appendChild(summaryEl);
    }
    const progEl = document.getElementById('actionProgressModal');
    if (progEl && progEl.parentElement !== document.body) {
      document.body.appendChild(progEl);
    }
  } catch { }
  // Initialize tooltips in actions bar
  try {
    if (window.bootstrap) {
      document.querySelectorAll('#vm-actions-bar [data-bs-toggle="tooltip"]').forEach(el => {
        try { new bootstrap.Tooltip(el); } catch { }
      });
    }
  } catch { }
  // Enable Enter-to-save on Proxmox login modal when all fields are filled
  const wireProxEnterSubmit = () => {
    try {
      const modalEl = document.getElementById('proxLoginModal');
      if (!modalEl || modalEl._enterBound) return;
      modalEl.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        // Only trigger from inputs/selects inside the modal
        const tag = (e.target && e.target.tagName) ? e.target.tagName.toUpperCase() : '';
        if (tag !== 'INPUT' && tag !== 'SELECT') return;
        const url = document.getElementById('prox-url')?.value?.trim();
        const api = document.getElementById('prox-api-port')?.value?.trim();
        const ssh = document.getElementById('prox-ssh-port')?.value?.trim();
        const user = document.getElementById('prox-username')?.value?.trim();
        const pass = document.getElementById('prox-password')?.value ?? '';
        const allFilled = !!(url && user && pass && api && ssh);
        const saveBtn = document.getElementById('btn-prox-save');
        if (allFilled && !(saveBtn && saveBtn.disabled)) {
          e.preventDefault();
          e.stopPropagation();
          try { saveProxCredsFromModal(); } catch { }
        }
      });
      modalEl._enterBound = true;
    } catch { }
  };
  // Wire immediately and after a short delay (modal may be moved into body)
  wireProxEnterSubmit();
  setTimeout(wireProxEnterSubmit, 300);
  // Prefill login modal when clicking the login button
  const loginBtn = document.getElementById('btn-prox-login');
  if (loginBtn && !loginBtn._toolhubBound) {
    loginBtn.addEventListener('click', handleProxLoginClick);
    loginBtn._toolhubBound = true;
  }
  updateRefreshState();
  // If modal inputs are modified, immediately invalidate session creds and disable Refresh
  const wireConnInputInvalidation = () => {
    const u = document.getElementById('prox-url');
    const a = document.getElementById('prox-api-port');
    const s = document.getElementById('prox-ssh-port');
    const v = document.getElementById('prox-verify-ssl');
    const handler = () => { if (PROJ) { clearProxSession(PROJ.id); updateRefreshState(); } };
    [u, a, s].forEach(el => { if (el && !el._toolhubBound) { el.addEventListener('input', handler); el._toolhubBound = true; } });
    if (v && !v._toolhubBound) { v.addEventListener('change', handler); v._toolhubBound = true; }
  };
  // Try wiring now and again after a tick (modal might be moved to body)
  wireConnInputInvalidation();
  setTimeout(wireConnInputInvalidation, 300);
  // Toggle show passwords
  // Removed page-level toggle; handled by eye icon in header
  // Select/Deselect all buttons
  // Removed Select All / Deselect All page buttons
  // Filter input
  const filter = document.getElementById('vm-filter');
  if (filter) filter.addEventListener('input', (e) => { FILTER_TEXT = e.target.value || ''; try { if (vmIsMulti && vmIsMulti()) renderMergedVmTable(window.__MERGED_ROWS__ || []); else renderVmTable(PROJ); } catch { renderVmTable(PROJ); } });
  const filterRegex = document.getElementById('vm-filter-regex');
  if (filterRegex) filterRegex.addEventListener('change', (e) => {
    FILTER_IS_REGEX = !!e.target.checked;
    const errEl = document.getElementById('vm-filter-error');
    if (!FILTER_IS_REGEX && errEl) errEl.classList.add('d-none');
    try { if (vmIsMulti && vmIsMulti()) renderMergedVmTable(window.__MERGED_ROWS__ || []); else renderVmTable(PROJ); } catch { renderVmTable(PROJ); }
  });
  // Sidebar: allow pressing Enter in the project name field to create a project
  try {
    const nameInput = document.getElementById('proj-name');
    if (nameInput && !nameInput._toolhubEnterBound) {
      nameInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          try { createProjectSidebar(); } catch { }
        }
      });
      nameInput._toolhubEnterBound = true;
    }
  } catch { }
  // Cross-page: if Configuration page changes URL/ports, disable Refresh here
  window.addEventListener('proxmox-conn-changed', (e) => {
    try {
      const pid = e?.detail?.pid;
      if (!PROJ || !pid || pid !== PROJ.id) return;
      clearProxSession(PROJ.id);
      updateRefreshState();
    } catch { }
  });

  // Auto-refresh wiring (per project)
  // Wire column chooser
  wireVmCols();
  // Reflect saved columns on project select
  document.addEventListener('project-selected', (e) => { try { const pid = e.detail || ''; if (!pid) return; VM_COLS = readVmCols(pid); const ids = ['name', 'cred', 'status', 'state', 'id', 'node', 'template', 'nets']; ids.forEach(id => { const el = document.getElementById(`vm-col-${id}`); if (el) el.checked = !!VM_COLS[id]; }); } catch { } });
  (function () {
    let timer = null;
    function key() { try { return `toolhub.vm.mgr.auto.${PROJ ? PROJ.id : 'none'}`; } catch { return 'toolhub.vm.mgr.auto.none'; } }
    function readAuto() { try { const v = sessionStorage.getItem(key()); return parseInt(v || '0', 10) || 0; } catch { return 0; } }
    function writeAuto(v) { try { sessionStorage.setItem(key(), String(v || 0)); } catch { } }
    function setAutoBadge(state) {
      try {
        const badge = document.getElementById('vm-auto-badge');
        if (!badge) return;
        if (state === 'off') { badge.textContent = 'Off'; badge.className = 'badge bg-secondary align-self-center ms-1'; return; }
        if (state === 'auth') { badge.textContent = 'Auth'; badge.className = 'badge bg-warning text-dark align-self-center ms-1'; return; }
        if (state === 'busy') { badge.textContent = 'Busy'; badge.className = 'badge bg-info text-dark align-self-center ms-1'; return; }
        if (state === 'on') { badge.textContent = 'On'; badge.className = 'badge bg-success align-self-center ms-1'; return; }
      } catch { }
    }
    function busy() {
      try { const prog = document.getElementById('vm-progress'); return prog && !prog.classList.contains('d-none'); } catch { return false; }
    }
    function apply() {
      if (timer) { clearInterval(timer); timer = null; }
      const sel = document.getElementById('vm-auto-interval');
      const interval = parseInt(sel?.value || '0', 10) || 0;
      writeAuto(interval);
      // Immediately reflect badge state
      if (interval <= 0) { setAutoBadge('off'); return; }
      if (!PROJ) { setAutoBadge('off'); return; }
      if (!hasAuth()) { setAutoBadge('auth'); /* keep timer updating badge so it flips after login */ }
      else if (busy()) { setAutoBadge('busy'); }
      else { setAutoBadge('on'); }
      if (interval > 0) {
        timer = setInterval(() => {
          try {
            if (!PROJ) { setAutoBadge('off'); return; }
            if (!hasAuth()) { setAutoBadge('auth'); return; }
            if (busy()) { setAutoBadge('busy'); return; }
            setAutoBadge('on');
            VM_AUTO_REFRESH_ACTIVE = true;
            let task;
            try {
              task = vmRefresh();
            } catch (err) {
              VM_AUTO_REFRESH_ACTIVE = false;
              throw err;
            }
            Promise.resolve(task).catch(() => { }).finally(() => { VM_AUTO_REFRESH_ACTIVE = false; });
          } catch { }
        }, interval * 1000);
      }
    }
    // Update when project changes and on initial load
    document.addEventListener('project-selected', () => { try { const sel = document.getElementById('vm-auto-interval'); if (sel) sel.value = String(readAuto() || 0); apply(); } catch { } });
    try {
      const sel = document.getElementById('vm-auto-interval');
      if (sel) { sel.value = String(readAuto() || 0); sel.addEventListener('change', apply); }
      apply();
    } catch { }
  })();
});

// Initialize Projects selector and merged view behavior
document.addEventListener('DOMContentLoaded', async () => {
  try { await ensureAllProjects(); } catch { }
  try { await setupProjectsSelector(); } catch { }
  try { vmUpdateProxmoxNavLinkForCurrent(); } catch { }
  // Adopt CTFd Manager selection if present and VM Manager not already multi
  try {
    const raw = sessionStorage.getItem('toolhub.ctfd.mgr.selectedPids.v1');
    const mgrSel = raw ? JSON.parse(raw) : null;
    const isMgrMulti = Array.isArray(mgrSel) && mgrSel.length > 1;
    const isVmMulti = Array.isArray(SELECTED_PIDS) && SELECTED_PIDS.length > 1;
    if (isMgrMulti && !isVmMulti) {
      const known = new Set((ALL_PROJECTS || []).map(p => canonicalPid(p.id)));
      const set = new Set();
      for (const pid of mgrSel) {
        const s = canonicalPid(pid);
        if (s && known.has(s)) set.add(s);
      }
      const cur = getCurrentPid();
      if (cur) set.add(cur);
      SELECTED_PIDS = canonicalPidList(Array.from(set));
      writeVmSelected(SELECTED_PIDS);
      // Persist per-base associations derived from CTFd selection (exclude current)
      try {
        const assoc = canonicalPidList(Array.from(set).filter(x => x !== cur));
        if (cur) {
          vmWriteAssoc(cur, assoc);
          http('PATCH', `/api/projects/${encodeURIComponent(cur)}`, { associated_projects: assoc }).catch(() => { });
        }
      } catch { }
      updateProjectsBadge();
      // Force Project column ON when entering multi-mode
      try { VM_COLS.project = true; if (PROJ) writeVmCols(PROJ.id, VM_COLS); const el = document.getElementById('vm-col-project'); if (el) el.checked = true; } catch { }
    }
  } catch { }
  // If multi, keep merged view when sidebar switches current project
  document.addEventListener('project-selected', (e) => {
    try {
      try { vmUpdateProxmoxNavLinkForCurrent(); } catch { }
      const pid = e.detail || '';
      if (pid) {
        // Re-derive selection from per-project associations for new base project
        try { vmMigrateSelectedToAssoc(pid); } catch { }
        try {
          let assoc = vmReadAssoc(pid);
          // Prefer backend value when available
          try { const proj = (ALL_PROJECTS || []).find(p => canonicalPid(p.id) === canonicalPid(pid)); const backend = Array.isArray(proj?.associated_projects) ? proj.associated_projects.map(String) : []; if (backend && backend.length) { vmWriteAssoc(pid, backend); assoc = backend.slice(); } } catch { }
          const baseList = (assoc && assoc.length) ? [pid, ...assoc] : [pid];
          SELECTED_PIDS = canonicalPidList(baseList);
          updateProjectsBadge();
        } catch { }
      }
      if (Array.isArray(SELECTED_PIDS) && SELECTED_PIDS.length > 1) { e.stopImmediatePropagation(); refreshVmView(); }
    } catch { }
  }, true);
  try { await refreshVmView(); } catch { }
  try {
    const u = new URL(window.location.href);
    const refreshFlag = String(u.searchParams.get('refresh') || '').trim().toLowerCase();
    if (refreshFlag === '1' || refreshFlag === 'true') {
      await vmRefresh({ forceRefresh: true });
      u.searchParams.delete('refresh');
      window.history.replaceState({}, '', u.pathname + u.search + u.hash);
    }
  } catch { }
});

async function prefillProxLoginModal() {
  if (!PROJ) return;
  const sess = readProxCreds(PROJ.id) || {};
  const u = document.getElementById('prox-username');
  const p = document.getElementById('prox-password');
  const url = document.getElementById('prox-url');
  const api = document.getElementById('prox-api-port');
  const ssh = document.getElementById('prox-ssh-port');
  const vssl = document.getElementById('prox-verify-ssl');
  if (u) u.value = sess.username || '';
  if (p) p.value = sess.password || '';
  if (url) url.value = PROJ.proxmox_url || '';
  if (api) api.value = PROJ.proxmox_api_port ?? 8006;
  if (ssh) ssh.value = PROJ.proxmox_ssh_port ?? 22;
  if (vssl) vssl.checked = (PROJ.proxmox_verify_ssl !== false);
  // If project-saved creds exist and session creds missing, adopt them.
  try {
    let persisted = {};
    // Prefer server secrets (may update CREDS cache)
    try {
      if (window.CREDS && typeof CREDS.fetchProjectSecrets === 'function') {
        await CREDS.fetchProjectSecrets(PROJ.id);
      }
    } catch { }
    try {
      if (window.CREDS && typeof CREDS.readPersistProxCreds === 'function') {
        persisted = CREDS.readPersistProxCreds(PROJ.id) || {};
      }
    } catch { }

    // No localStorage fallback; legacy migration is handled in CREDS.fetchProjectSecrets.

    const saveBox = document.getElementById('prox-save-creds');
    const hasPersisted = !!(persisted && (persisted.username || persisted.password));
    if (saveBox) saveBox.checked = hasPersisted;
    if (u && !u.value && persisted.username) u.value = persisted.username;
    if (p && !p.value && persisted.password) p.value = persisted.password;
  } catch { }
}

async function handleProxLoginClick(ev) {
  try { ev?.preventDefault?.(); } catch { }
  const targets = canonicalPidList(getActivePids());
  if (targets.length > 1) {
    try { await ensureAllProjects(); } catch { }
    return openProxLoginMultiForPids(targets);
  }
  const pid = targets[0] || canonicalPid(PROJ?.id);
  if (!pid) {
    alert('Select a project first.');
    return;
  }
  return openProxLoginForPid(pid);
}

async function openProxLoginMultiForPids(pids) {
  const targets = canonicalPidList(pids);
  if (!targets.length) {
    return { success: false, skipped: true, reason: 'no_targets' };
  }
  if (targets.length === 1) {
    return openProxLoginForPid(targets[0]);
  }
  const note = document.getElementById('vm-skipped-note');
  if (!note) {
    let successful = 0;
    let cancelled = false;
    for (const pid of targets) {
      const result = await openProxLoginForPid(pid, { showErrors: false });
      if (result?.cancelled) {
        cancelled = true;
        break;
      }
      if (result?.success) successful += 1;
    }
    try { updateRefreshState(); } catch { }
    return { success: successful > 0, completed: successful, requested: targets.length, cancelled };
  }
  try { note.dataset.skipped = JSON.stringify(targets); } catch { }
  try { note.dataset.flow = 'reauth'; } catch { }
  note.innerHTML = `<div class="alert alert-info py-2 px-3 small">Re-authenticating ${targets.length} selected project(s)…</div>`;
  await fixAllCredsFromNote();
  try { updateRefreshState(); } catch { }
  return { success: true, requested: targets.length };
}

// Open Proxmox login modal for a specific project id (used by Fix Creds buttons)
function openProxLoginForPid(pid, options = {}) {
  return new Promise(async (resolve, reject) => {
    try {
      await ensureAllProjects();
      const proj = (ALL_PROJECTS || []).find(p => canonicalPid(p.id) === canonicalPid(pid));
      if (!proj) {
        const msg = `Project ${pid} not found`;
        if (options.showErrors !== false) {
          try { (window.shell && shell.logWarn) ? shell.logWarn(msg) : console.warn(msg); } catch { }
        }
        resolve({ success: false, skipped: true, reason: 'not_found' });
        return;
      }

      const prev = PROJ;
      PROJ = proj;

      // Update modal title to show which project we're configuring
      try {
        const modalTitle = document.getElementById('proxLoginModalLabel');
        if (modalTitle) {
          modalTitle.textContent = `Proxmox Login — ${proj.name}`;
        }
      } catch { }

      await prefillProxLoginModal();

      const modalEl = document.getElementById('proxLoginModal');
      if (!modalEl || !window.bootstrap) {
        PROJ = prev;
        resolve({ success: false, skipped: true, reason: 'modal_not_available' });
        return;
      }

      // Track whether credentials were submitted and successfully saved
      let credsSaved = false;
      let submitAttempted = false;
      let submitFailed = false;
      const originalSaveHandler = window.saveProxCredsFromModal;

      // Temporarily wrap the save handler to track success
      window.saveProxCredsFromModal = async function () {
        submitAttempted = true;
        try {
          const result = await originalSaveHandler();
          // Check if credentials were actually saved (session storage has them)
          const sess = readProxCreds(proj.id) || {};
          if (sess.username && sess.password) {
            credsSaved = true;
            submitFailed = false;
          } else if (!result?.success) {
            submitFailed = true;
          }
          return result;
        } catch (error) {
          submitFailed = true;
          throw error;
        }
      };

      const inst = (bootstrap.Modal.getOrCreateInstance ? bootstrap.Modal.getOrCreateInstance(modalEl) : new bootstrap.Modal(modalEl));

      const cleanup = () => {
        try {
          PROJ = prev;
          window.saveProxCredsFromModal = originalSaveHandler;
          updateRefreshState();
          // Reset modal title
          const modalTitle = document.getElementById('proxLoginModalLabel');
          if (modalTitle) modalTitle.textContent = 'Proxmox Login';
          // Clear any leftover feedback
          const feedback = document.getElementById('prox-login-feedback');
          if (feedback) {
            feedback.textContent = '';
            feedback.className = 'me-auto small text-muted';
          }
        } catch { }
      };

      const onHidden = () => {
        cleanup();
        try { modalEl.removeEventListener('hidden.bs.modal', onHidden); } catch { }
        const cancelled = !submitAttempted && !credsSaved;
        const failed = !!(submitFailed && !credsSaved);
        resolve({
          success: credsSaved,
          skipped: !credsSaved && !cancelled && !failed,
          cancelled,
          failed,
          projectId: pid,
          projectName: proj.name,
        });
      };

      // Ensure any existing modal instances are properly hidden first
      try {
        const existingInstance = bootstrap.Modal.getInstance(modalEl);
        if (existingInstance) {
          existingInstance.hide();
          // Wait a bit for the hide animation
          await new Promise(resolve => setTimeout(resolve, 150));
        }
      } catch { }

      modalEl.addEventListener('hidden.bs.modal', onHidden, { once: true });
      inst.show();
    } catch (e) {
      try { (window.shell && shell.logError) ? shell.logError(`Failed to open login for project ${pid}: ${e.message}`) : console.error('openProxLoginForPid error:', e); } catch { }
      resolve({ success: false, skipped: true, reason: 'error', error: e.message });
    }
  });
}

// Walk through all skipped pids in the note and open login sequentially
async function fixAllCredsFromNote() {
  // Prevent concurrent runs
  if (FIX_CREDS_IN_PROGRESS) {
    try { (window.shell && shell.logWarn) ? shell.logWarn('Credential setup already in progress') : console.warn('Already in progress'); } catch { }
    return;
  }

  try {
    FIX_CREDS_IN_PROGRESS = true;

    const note = document.getElementById('vm-skipped-note');
    if (!note) return;

    let arr = [];
    try { arr = JSON.parse(note.dataset.skipped || '[]'); } catch { arr = []; }
    if (!Array.isArray(arr) || arr.length === 0) return;

    // Show progress feedback with cancel option
    const originalHtml = note.innerHTML;
    const total = arr.length;
    let completed = 0;
    let successful = 0;
    let cancelled = false;
    const flow = (() => {
      try { return String(note.dataset.flow || ''); } catch { return ''; }
    })();

    const updateProgress = (current, status, showCancel = true) => {
      note.innerHTML = `<div class="alert alert-info py-2 px-3 small">
        <div class="d-flex justify-content-between align-items-center mb-2">
          <strong>Setting up credentials...</strong>
          ${showCancel ? '<button class="btn btn-sm btn-outline-secondary" onclick="window.CANCEL_FIX_CREDS=true">Cancel</button>' : ''}
        </div>
        <div class="progress mb-2" style="height: 20px;">
          <div class="progress-bar ${cancelled ? 'bg-warning' : ''}" role="progressbar" style="width: ${(current / total) * 100}%" 
               aria-valuenow="${current}" aria-valuemin="0" aria-valuemax="${total}">
            ${current} of ${total}
          </div>
        </div>
        <div class="text-muted small">${status || ''}</div>
      </div>`;
    };

    updateProgress(0, 'Starting...');
    window.CANCEL_FIX_CREDS = false;

    const results = [];

    for (let i = 0; i < arr.length; i++) {
      // Check for cancellation
      if (window.CANCEL_FIX_CREDS) {
        cancelled = true;
        try { (window.shell && shell.logInfo) ? shell.logInfo('Credential setup cancelled by user') : console.log('Cancelled'); } catch { }
        break;
      }

      const pid = String(arr[i]);
      const proj = (ALL_PROJECTS || []).find(p => canonicalPid(p.id) === pid);
      const projName = proj?.name || pid;

      updateProgress(i, `Configuring: ${projName}`, true);

      try {
        const result = await openProxLoginForPid(pid, { showErrors: false });
        if (result?.cancelled) {
          cancelled = true;
          break;
        }
        results.push(result);

        if (result.success) {
          successful++;
          try { (window.shell && shell.logSuccess) ? shell.logSuccess(`Credentials saved for ${projName}`) : console.log(`Creds saved for ${projName}`); } catch { }
        } else if (result.failed) {
          try { (window.shell && shell.logWarn) ? shell.logWarn(`Credentials not verified for ${projName}`) : console.warn(`Credentials not verified for ${projName}`); } catch { }
        } else if (!result.skipped) {
          try { (window.shell && shell.logWarn) ? shell.logWarn(`Skipped ${projName}`) : console.warn(`Skipped ${projName}`); } catch { }
        }
      } catch (e) {
        results.push({ success: false, skipped: true, error: e.message, projectId: pid });
        try { (window.shell && shell.logError) ? shell.logError(`Error for ${projName}: ${e.message}`) : console.error(`Error for ${projName}:`, e); } catch { }
      }

      completed++;
      updateProgress(completed, completed < total ? `Completed: ${projName}` : 'Finishing...', false);
    }

    window.CANCEL_FIX_CREDS = false;

    // Show final summary
    const failedCount = results.filter(r => r.failed).length;
    const skippedCount = results.filter(r => r.skipped).length;
    let summaryClass, summaryTitle;

    if (cancelled && completed === 0 && successful === 0 && failedCount === 0) {
      if (flow === 'reauth') {
        note.innerHTML = '';
      } else {
        note.innerHTML = originalHtml || '';
      }
      try { delete note.dataset.flow; } catch { }
      return;
    }

    if (cancelled) {
      summaryClass = 'alert-warning';
      summaryTitle = 'Credential Setup Cancelled';
    } else if (successful === total) {
      summaryClass = 'alert-success';
      summaryTitle = 'Credential Setup Complete';
    } else if (successful > 0) {
      summaryClass = 'alert-warning';
      summaryTitle = 'Credential Setup Partially Complete';
    } else {
      summaryClass = 'alert-danger';
      summaryTitle = 'Credential Setup Failed';
    }

    note.innerHTML = `<div class="alert ${summaryClass} py-2 px-3 small">
      <div class="mb-1"><strong>${summaryTitle}</strong></div>
      <div>✓ ${successful} of ${completed} project(s) configured successfully</div>
      ${failedCount > 0 ? `<div class="text-muted mt-1">${failedCount} project(s) still need valid Proxmox credentials</div>` : ''}
      ${cancelled ? `<div class="text-muted mt-1">Cancelled after ${completed} of ${total} projects</div>` : ''}
      ${skippedCount > 0 && !cancelled ? `<div class="text-muted mt-1">${skippedCount} project(s) were skipped</div>` : ''}
      ${cancelled && (total - completed) > 0 ? `<div class="text-muted mt-1">${total - completed} project(s) not processed</div>` : ''}
      <div class="mt-2">
        ${successful > 0 ? '<button class="btn btn-sm btn-primary" onclick="refreshVmView()">Refresh Now</button>' : ''}
        ${cancelled && (total - completed) > 0 ? '<button class="btn btn-sm btn-outline-primary" onclick="fixAllCredsFromNote()">Resume Setup</button>' : ''}
        <button class="btn btn-sm btn-outline-secondary" onclick="document.getElementById('vm-skipped-note').innerHTML=''">Dismiss</button>
      </div>
    </div>`;

    // Auto-refresh if any were successful and not cancelled
    if (successful > 0 && !cancelled) {
      setTimeout(() => {
        try { refreshVmView(); } catch { }
      }, 500);
    }

    try { delete note.dataset.flow; } catch { }

  } catch (e) {
    try { (window.shell && shell.logError) ? shell.logError(`Fix all creds failed: ${e.message}`) : console.error('Fix all creds failed:', e); } catch { }
    try {
      const note = document.getElementById('vm-skipped-note');
      if (note) {
        note.innerHTML = `<div class="alert alert-danger py-2 px-3 small">
          <strong>Error:</strong> ${e.message}
          <button class="btn btn-sm btn-outline-secondary ms-2" onclick="document.getElementById('vm-skipped-note').innerHTML=''">Dismiss</button>
        </div>`;
      }
    } catch { }
  } finally {
    FIX_CREDS_IN_PROGRESS = false;
    window.CANCEL_FIX_CREDS = false;
  }
}

async function saveProxCredsFromModal() {
  if (!PROJ) {
    alert('Select a project first.');
    return Promise.reject(new Error('No project selected'));
  }

  const u = document.getElementById('prox-username')?.value?.trim() || '';
  const p = document.getElementById('prox-password')?.value || '';
  let url = document.getElementById('prox-url')?.value?.trim() || '';
  const api = Number(document.getElementById('prox-api-port')?.value || PROJ.proxmox_api_port || 8006);
  const ssh = Number(document.getElementById('prox-ssh-port')?.value || PROJ.proxmox_ssh_port || 22);
  const verifySSL = !!document.getElementById('prox-verify-ssl')?.checked;

  // Normalize URL to include scheme if user omitted it
  const ensureScheme = (s) => { if (!s) return ''; return (/^https?:\/\//i.test(s) ? s : `https://${s}`); };
  if (url) url = ensureScheme(url);
  let effectiveUrl = url || (PROJ.proxmox_url ? ensureScheme(PROJ.proxmox_url) : '');

  // Basic front-end validation to avoid backend 400s
  const feedback = document.getElementById('prox-login-feedback');
  const saveBtn = document.getElementById('btn-prox-save');

  if (!effectiveUrl) {
    if (feedback) {
      feedback.textContent = 'Please enter a valid Proxmox URL (e.g., https://host or host).';
      feedback.className = 'me-auto small text-danger';
    }
    try { sessionStorage.removeItem(proxCredKey(PROJ.id)); } catch { }
    updateRefreshState();
    return Promise.reject(new Error('Invalid URL'));
  }

  if (!u || !p) {
    if (feedback) {
      feedback.textContent = 'Please provide both username and password.';
      feedback.className = 'me-auto small text-danger';
    }
    try { sessionStorage.removeItem(proxCredKey(PROJ.id)); } catch { }
    updateRefreshState();
    return Promise.reject(new Error('Missing credentials'));
  }
  // Optimistically save credentials
  writeProxCreds(PROJ.id, { username: u, password: p });

  try {
    const saveBox = document.getElementById('prox-save-creds');
    const wantsPersist = !!(saveBox && saveBox.checked);
    if (window.CREDS && typeof CREDS.setPersistProxCreds === 'function') {
      await CREDS.setPersistProxCreds(PROJ.id, u, p, wantsPersist);
    }
  } catch { }

  // Show connecting feedback and attempt a lightweight call
  if (feedback) { feedback.textContent = 'Connecting...'; feedback.className = 'me-auto small text-muted'; }
  try { (window.shell && shell.logInfo) ? shell.logInfo('Proxmox login: connecting…') : console.log('Proxmox login: connecting…'); } catch { }
  if (saveBtn) saveBtn.disabled = true;

  // Return a promise that resolves when verification completes
  return (async () => {
    try {
      // Sync config first so Configuration reflects any changes to URL/ports
      await http('PATCH', `/api/projects/${PROJ.id}`, {
        proxmox_url: effectiveUrl,
        proxmox_api_port: api,
        proxmox_ssh_port: ssh,
        proxmox_verify_ssl: verifySSL,
      });
      // Update local PROJ so subsequent calls use the updated values
      PROJ.proxmox_url = effectiveUrl;
      PROJ.proxmox_api_port = api;
      PROJ.proxmox_ssh_port = ssh;
      PROJ.proxmox_verify_ssl = verifySSL;
      // Verify both API and SSH connectivity before declaring success (queued)
      const verifyBody = { baseUrl: effectiveUrl, apiPort: api, sshPort: ssh, verifySSL, username: u, password: p };
      let verify;
      try {
        await runQueued(`Verify Proxmox login for ${PROJ?.name || PROJ?.id || ''}`, async () => {
          verify = await http('POST', `/api/projects/${PROJ.id}/proxmox/verify`, verifyBody);
        }, { projectId: PROJ?.id });
      } catch (e) {
        verify = { ok: false, proxmox_ok: false, ssh_ok: false, proxmox_error: e?.message || 'verify failed' };
      }
      if (verify && verify.ok) {
        if (feedback) { feedback.textContent = 'Login verified. Refreshing states…'; feedback.className = 'me-auto small text-success'; }
        try { (window.shell && shell.logSuccess) ? shell.logSuccess('Proxmox login verified (API + SSH)') : console.log('Proxmox login verified'); } catch { }
        // Store connection snapshot meta to detect future changes
        writeProxMeta(PROJ.id, { url: effectiveUrl, apiPort: api, sshPort: ssh });
        updateRefreshState();
        try { (window.shell && shell.logInfo) ? shell.logInfo('Auto-refresh after login…') : console.log('Auto-refresh after login…'); } catch { }
        await vmRefresh();
      } else {
        const apiOk = !!(verify && verify.proxmox_ok);
        const sshOk = !!(verify && verify.ssh_ok);
        const apiErr = (verify && verify.proxmox_error) ? String(verify.proxmox_error) : '';
        const sshErr = (verify && verify.ssh_error) ? String(verify.ssh_error) : '';
        const hint = ' Please double-check your URL, username, password, and that no firewall or NAT is blocking access.';
        let msg = 'Login could not be verified.';
        if (!apiOk && !sshOk) msg = 'Neither Proxmox API nor SSH could be reached.';
        else if (!apiOk) msg = 'Proxmox API could not be reached.';
        else if (!sshOk) msg = 'SSH could not be reached.';
        const details = [apiErr, sshErr].filter(Boolean).join(' | ');
        if (feedback) { feedback.textContent = msg + (details ? ' ' + details : '') + hint; feedback.className = 'me-auto small text-danger'; }
        try { (window.shell && shell.logWarn) ? shell.logWarn(`Proxmox verify failed: ${msg} ${details}`) : console.warn('Proxmox verify failed:', msg, details); } catch { }
        // Clear session creds on failure so Refresh stays disabled
        try { sessionStorage.removeItem(proxCredKey(PROJ.id)); } catch { }
        updateRefreshState();
        if (saveBtn) saveBtn.disabled = false;
        return;
      }
      // Hide modal after refresh completes
      try {
        const modalEl = document.getElementById('proxLoginModal');
        if (modalEl && window.bootstrap && window.bootstrap.Modal) window.bootstrap.Modal.getInstance(modalEl)?.hide();
      } catch { }
      if (feedback) { feedback.textContent = ''; }
      if (saveBtn) saveBtn.disabled = false;
      return { success: true, verified: true };
    } catch (e) {
      if (feedback) {
        feedback.textContent = 'Login failed: ' + (e && e.message ? e.message : 'Unknown error') + ' Please double-check that no firewall or NAT is blocking access.';
        feedback.className = 'me-auto small text-danger';
      }
      if (saveBtn) saveBtn.disabled = false;
      // Disable Refresh on failure and clear session creds
      try { sessionStorage.removeItem(proxCredKey(PROJ.id)); } catch { }
      updateRefreshState();
      try { (window.shell && shell.logError) ? shell.logError('Proxmox login failed: ' + (e && e.message ? e.message : 'Unknown error')) : console.error('Proxmox login failed:', e); } catch { }
      return Promise.reject(e);
    }
  })();
}

function hasSessionCreds() {
  if (!PROJ) return false;
  const s = readProxCreds(PROJ.id) || {};
  return !!(s.username && s.password);
}

// True when we can authenticate: either session username/password or a saved API token on the project
function hasAuth() {
  if (!PROJ) return false;
  if (hasSessionCreds()) return true;
  try {
    const persisted = readPersistedProxCreds(PROJ.id);
    if (persisted && persisted.username && persisted.password) return true;
    const pid = PROJ.id;
    const cache = (window.PROJ_CACHE && window.PROJ_CACHE[pid]) ? window.PROJ_CACHE[pid] : PROJ;
    return !!(cache && typeof cache.proxmox_api_token === 'string' && cache.proxmox_api_token.trim().length > 0);
  } catch {
    return false;
  }
}

function hasAuthForProject(project) {
  const pid = canonicalPid(project?.id);
  if (!pid) return false;
  try {
    const sess = readProxCreds(pid) || {};
    if (sess.username && sess.password) return true;
    const persisted = readPersistedProxCreds(pid) || {};
    if (persisted.username && persisted.password) return true;
    const cache = (window.PROJ_CACHE && window.PROJ_CACHE[pid]) ? window.PROJ_CACHE[pid] : project;
    return !!(cache && typeof cache.proxmox_api_token === 'string' && cache.proxmox_api_token.trim());
  } catch {
    return false;
  }
}

function isCurrentVmProject(project) {
  return !!(project && canonicalPid(project.id) && canonicalPid(project.id) === canonicalPid(PROJ?.id));
}

function updateRefreshState() {
  const btn = document.getElementById('btn-refresh');
  const wrap = document.getElementById('refresh-wrapper');
  const colsBtn = document.getElementById('vm-cols-btn');
  const loginBtn = document.getElementById('btn-prox-login');
  const multiMode = vmIsMulti && vmIsMulti();
  // In multi mode, refresh can preflight auth per selected project and surface skipped projects.
  const loggedIn = multiMode ? hasAuthForAllSelected() : hasAuth();
  const activeLen = multiMode ? getActivePids().length : 0;
  const refreshEnabled = multiMode ? (activeLen > 1 || (activeLen === 1 && loggedIn)) : loggedIn;
  if (loginBtn) {
    loginBtn.setAttribute('title', multiMode ? 'Update Proxmox credentials for all selected projects' : 'Update Proxmox URL/ports and credentials');
  }
  if (btn) btn.disabled = !refreshEnabled;
  if (colsBtn) colsBtn.disabled = !loggedIn;
  // Toggle config-only notice
  try {
    const note = document.getElementById('vm-config-only-alert');
    if (note) {
      if (multiMode) { note.classList.add('d-none'); note.setAttribute('aria-hidden', 'true'); }
      else if (loggedIn) { note.classList.add('d-none'); note.setAttribute('aria-hidden', 'true'); }
      else { note.classList.remove('d-none'); note.removeAttribute('aria-hidden'); }
    }
  } catch { }
  // Enable/disable Actions toolbar groups depending on selection and login state
  try {
    const scopedSelections = multiMode ? listSelectedEntries() : (PROJ ? listSelectedEntriesForPid(PROJ.id) : []);
    const anySelected = scopedSelections.length > 0;
    const disable = !(loggedIn && anySelected);
    ['act-power', 'act-lifecycle', 'act-state-net', 'act-control'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.disabled = disable;
    });
    const usersBtn = document.getElementById('act-users');
    if (usersBtn) usersBtn.disabled = disable;
    const guestEntries = getSelectedGuestEntries();
    const guestFilesBtn = document.getElementById('act-guest-files');
    if (guestFilesBtn) {
      const guestAuthorized = guestEntries.length > 0
        && guestEntries.every(entry => hasAuthForPid(entry.pid || PROJ?.id));
      guestFilesBtn.disabled = !guestAuthorized;
      guestFilesBtn.title = guestEntries.length
        ? `Push or pull files for ${guestEntries.length} selected guest${guestEntries.length === 1 ? '' : 's'}`
        : 'Select at least one existing LXC container or QEMU VM (refresh states first)';
    }
  } catch { }
  // Enable Cancel button only while an action is in flight
  try {
    const cancelBtn = document.getElementById('act-cancel');
    if (cancelBtn) cancelBtn.disabled = !ACTION_IN_FLIGHT;
  } catch { }
  // Manage tooltip enable/disable
  try {
    if (wrap && window.bootstrap) {
      const tip = bootstrap.Tooltip.getInstance(wrap) || new bootstrap.Tooltip(wrap);
      if (refreshEnabled) {
        try { tip.hide(); } catch { }
        tip.disable();
        ['title', 'data-bs-original-title', 'aria-label'].forEach(attr => wrap.removeAttribute(attr));
        wrap.removeAttribute('tabindex');
      } else {
        tip.enable();
        wrap.setAttribute('tabindex', '0');
        wrap.setAttribute('title', 'Please authenticate to Proxmox first.');
        wrap.setAttribute('data-bs-original-title', 'Please authenticate to Proxmox first.');
      }
    }
    // Ensure Users group tooltip is initialized
    const ug = document.getElementById('users-group');
    if (ug && window.bootstrap) {
      bootstrap.Tooltip.getInstance(ug) || new bootstrap.Tooltip(ug);
    }
  } catch { }
}

// Helpers: per-project auth checks in multi-mode
function hasAuthForPid(pid) {
  try {
    const sess = readProxCreds(pid) || {}; if (sess.username && sess.password) return true;
    const persisted = readPersistedProxCreds(pid) || {}; if (persisted.username && persisted.password) return true;
    const p = (ALL_PROJECTS || []).find(pp => canonicalPid(pp.id) === canonicalPid(pid));
    return !!(p && typeof p.proxmox_api_token === 'string' && p.proxmox_api_token.trim());
  } catch { return false; }
}
function parseKeyMulti(key) {
  const parts = String(key || '').split('|');
  if (parts.length === 3) return { pid: parts[0], index: Number(parts[1]), name: parts[2] };
  if (parts.length === 2) return { pid: PROJ ? PROJ.id : '', index: Number(parts[0]), name: parts[1] };
  return { pid: '', index: NaN, name: '' };
}
function hasAuthForAllSelected() {
  try {
    if (!SELECTED_ROWS || SELECTED_ROWS.size === 0) return false;
    const pids = new Set();
    SELECTED_ROWS.forEach(k => { const o = parseKeyMulti(k); if (o.pid) pids.add(String(o.pid)); });
    if (pids.size === 0) return false;
    for (const pid of pids) { if (!hasAuthForPid(pid)) return false; }
    return true;
  } catch { return false; }
}

function listSelectedEntries() {
  const entries = [];
  const selection = SELECTED_ROWS;
  if (!selection || typeof selection.forEach !== 'function') return entries;
  selection.forEach(key => {
    const info = parseKeyMulti(key);
    if (!info) return;
    const providedPid = info.pid !== undefined && info.pid !== null ? String(info.pid) : '';
    const fallbackPid = providedPid || (PROJ && PROJ.id !== undefined && PROJ.id !== null ? String(PROJ.id) : '');
    const pidCanonical = canonicalPid(fallbackPid);
    const index = Number(info.index);
    const name = String(info.name || '');
    if (!pidCanonical || !Number.isFinite(index) || !name) return;
    const pidValue = providedPid || fallbackPid;
    entries.push({ key: String(key), pid: pidValue, pidCanonical, index, name });
  });
  return entries;
}

function listSelectedEntriesForPid(pid) {
  const target = canonicalPid(pid);
  if (!target) return [];
  return listSelectedEntries().filter(entry => entry.pidCanonical === target);
}

function getActionableSelections() {
  if (vmIsMulti && vmIsMulti()) {
    return listSelectedEntries();
  }
  if (PROJ && PROJ.id) {
    return listSelectedEntriesForPid(PROJ.id);
  }
  return [];
}

function getSelectedGuestEntries() {
  const selected = getActionableSelections();
  const mergedRows = Array.isArray(window.__MERGED_ROWS__) ? window.__MERGED_ROWS__ : [];
  return selected.reduce((entries, entry) => {
    try {
      const merged = mergedRows.find(row => canonicalPid(row?.pid) === canonicalPid(entry?.pid)
        && Number(row?.index) === Number(entry?.index)
        && String(row?.vmName || '') === String(entry?.name || ''));
      let guestType = String(merged?.detail?.type || '').toLowerCase();
      const proj = canonicalPid(PROJ?.id) === canonicalPid(entry?.pid)
        ? PROJ
        : (ALL_PROJECTS || []).find(item => canonicalPid(item?.id) === canonicalPid(entry?.pid));
      if (!guestType) {
        const detail = _findVmDetailForTarget(proj, entry);
        guestType = String(detail?.type || '').toLowerCase();
      }
      if (guestType === 'lxc' || guestType === 'qemu') entries.push({ ...entry, type: guestType });
    } catch { }
    return entries;
  }, []);
}

function groupSelectedGuestEntriesByProject() {
  const grouped = new Map();
  getSelectedGuestEntries().forEach(entry => {
    const pid = canonicalPid(entry?.pid || PROJ?.id);
    if (!pid) return;
    if (!grouped.has(pid)) grouped.set(pid, []);
    grouped.get(pid).push({ index: Number(entry.index), name: String(entry.name || ''), type: String(entry.type || '') });
  });
  return grouped;
}

function guestTransferProject(pid) {
  const canonical = canonicalPid(pid);
  if (canonicalPid(PROJ?.id) === canonical) return PROJ;
  return (ALL_PROJECTS || []).find(item => canonicalPid(item?.id) === canonical) || null;
}

async function guestTransferAuthPayload(pid, targets) {
  const proj = guestTransferProject(pid);
  if (!proj) throw new Error(`Project ${pid} is unavailable`);
  try { await hydrateProxCredsFromPersisted(pid); } catch { }
  const sess = readProxCreds(pid) || {};
  const needsSsh = (targets || []).some(target => String(target?.type || '').toLowerCase() === 'lxc');
  if (!sess.password && needsSsh) throw new Error(`${proj.name || pid}: an SSH password is required for LXC transfers`);
  return {
    username: sess.username || undefined,
    password: sess.password,
    baseUrl: proj.proxmox_url || undefined,
    apiPort: proj.proxmox_api_port || undefined,
    verifySSL: proj.proxmox_verify_ssl !== false,
  };
}

function mergeGuestTransferResponses(responses) {
  const merged = { pushed: [], pulled: [], skipped: [], errors: [], outputs_zips: [] };
  (responses || []).forEach(({ project, response }) => {
    const projectName = project?.name || project?.id || '';
    ['pushed', 'pulled', 'skipped', 'errors'].forEach(key => {
      const items = Array.isArray(response?.[key]) ? response[key] : [];
      items.forEach(item => merged[key].push({ ...(item || {}), project: projectName }));
    });
    if (response?.outputs_zip?.base64) merged.outputs_zips.push(response.outputs_zip);
  });
  if (merged.outputs_zips.length === 1) merged.outputs_zip = merged.outputs_zips[0];
  return merged;
}

async function runGuestTransfer(label, operation) {
  const grouped = groupSelectedGuestEntriesByProject();
  if (!grouped.size) {
    alert('Select at least one existing LXC container or QEMU VM. Refresh states first if needed.');
    return;
  }
  const responses = [];
  ACTION_IN_FLIGHT = true;
  CURRENT_ACTION = label;
  ACTION_RUN_ID += 1;
  updateRefreshState();
  let summaryResult = null;
  const progressCancelButton = document.getElementById('action-progress-cancel-btn');
  const progressCancelWasDisabled = !!progressCancelButton?.disabled;
  const progressCancelTitle = progressCancelButton?.getAttribute('title');
  if (progressCancelButton) {
    progressCancelButton.disabled = true;
    progressCancelButton.title = 'Guest file transfers cannot be cancelled after they start';
  }
  try {
    try { shell.beginActionContext(label); } catch { }
    try { showActionProgress(`${label} in progress`, `Preparing ${getSelectedGuestEntries().length} guest(s)…`); } catch { }
    try { openActionProgressModal(); } catch { }
    let position = 0;
    for (const [pid, targets] of grouped.entries()) {
      position += 1;
      const project = guestTransferProject(pid);
      const progress = Math.max(10, Math.round((position - 1) * 80 / grouped.size) + 10);
      try { updateActionProgress(progress, `${position}/${grouped.size}`, `${project?.name || pid}: transferring ${targets.length} guest(s)…`); } catch { }
      const auth = await guestTransferAuthPayload(pid, targets);
      const response = await operation(pid, targets, auth);
      responses.push({ project, response });
      const completedProgress = Math.min(95, Math.round(position * 85 / grouped.size) + 10);
      try { updateActionProgress(completedProgress, `${position}/${grouped.size}`, `${project?.name || pid}: transfer complete`); } catch { }
    }
    const merged = mergeGuestTransferResponses(responses);
    try { updateActionProgress(100, 'Done', `${label} completed`); } catch { }
    summaryResult = merged;
    emitActionLogs(label, merged);
    try { shell.endActionContext((merged.errors || []).length === 0); } catch { }
  } catch (error) {
    const message = error?.message || String(error);
    try { shell.logError(`${label}: ${message}`); } catch { }
    try { shell.endActionContext(false); } catch { }
    summaryResult = { errors: [{ reason: message }] };
  } finally {
    ACTION_IN_FLIGHT = false;
    CURRENT_ACTION = null;
    updateRefreshState();
    try { hideActionProgress(); } catch { }
    if (progressCancelButton) {
      progressCancelButton.disabled = progressCancelWasDisabled;
      if (progressCancelTitle === null) progressCancelButton.removeAttribute('title');
      else progressCancelButton.setAttribute('title', progressCancelTitle);
    }
  }
  if (summaryResult) {
    window.setTimeout(() => showActionSummary(label, summaryResult), 200);
  }
}

function hideLxcSetupModal(modal) {
  return new Promise(resolve => {
    if (!modal || !window.bootstrap || !bootstrap.Modal) return resolve();
    let resolved = false;
    const finish = () => {
      if (resolved) return;
      resolved = true;
      resolve();
    };
    if (!modal.classList.contains('show')) return finish();
    modal.addEventListener('hidden.bs.modal', finish, { once: true });
    try { bootstrap.Modal.getOrCreateInstance(modal).hide(); } catch { return finish(); }
    window.setTimeout(finish, 500);
  });
}

function openLxcPushModal() {
  const selected = getSelectedGuestEntries();
  if (!selected.length) return alert('Select at least one existing LXC container or QEMU VM. Refresh states first if needed.');
  const summary = document.getElementById('lxc-push-summary');
  if (summary) summary.textContent = `The selected content will be pushed to ${selected.length} guest${selected.length === 1 ? '' : 's'}. QEMU VMs use the guest agent; LXC containers use the configured Proxmox SSH connection.`;
  const error = document.getElementById('lxc-push-error');
  if (error) { error.textContent = ''; error.classList.add('d-none'); }
  const modal = document.getElementById('lxcPushModal');
  if (modal && window.bootstrap) bootstrap.Modal.getOrCreateInstance(modal).show();
}

function openLxcPullModal() {
  const selected = getSelectedGuestEntries();
  if (!selected.length) return alert('Select at least one existing LXC container or QEMU VM. Refresh states first if needed.');
  const summary = document.getElementById('lxc-pull-summary');
  if (summary) summary.textContent = `The requested paths will be pulled from ${selected.length} guest${selected.length === 1 ? '' : 's'}. QEMU VMs use the guest agent; LXC containers use the configured Proxmox SSH connection.`;
  const error = document.getElementById('lxc-pull-error');
  if (error) { error.textContent = ''; error.classList.add('d-none'); }
  const modal = document.getElementById('lxcPullModal');
  if (modal && window.bootstrap) bootstrap.Modal.getOrCreateInstance(modal).show();
}

function wireLxcTransferModals() {
  const updatePushTypeUi = () => {
    const selectionType = document.querySelector('input[name="lxc-push-type"]:checked')?.value === 'folder' ? 'folder' : 'file';
    const filesGroup = document.getElementById('lxc-push-files-group');
    const folderGroup = document.getElementById('lxc-push-folder-group');
    const filesInput = document.getElementById('lxc-push-files');
    const folderInput = document.getElementById('lxc-push-folder');
    filesGroup?.classList.toggle('d-none', selectionType !== 'file');
    folderGroup?.classList.toggle('d-none', selectionType !== 'folder');
    if (selectionType === 'file' && folderInput) folderInput.value = '';
    if (selectionType === 'folder' && filesInput) filesInput.value = '';
  };
  document.querySelectorAll('input[name="lxc-push-type"]').forEach(input => {
    if (input._lxcPushTypeBound) return;
    input._lxcPushTypeBound = true;
    input.addEventListener('change', updatePushTypeUi);
  });
  updatePushTypeUi();
  const pushButton = document.getElementById('lxc-push-confirm');
  if (pushButton && !pushButton._lxcTransferBound) {
    pushButton._lxcTransferBound = true;
    pushButton.addEventListener('click', async () => {
      const selectionType = document.querySelector('input[name="lxc-push-type"]:checked')?.value === 'folder' ? 'folder' : 'file';
      const files = selectionType === 'folder'
        ? Array.from(document.getElementById('lxc-push-folder')?.files || [])
        : Array.from(document.getElementById('lxc-push-files')?.files || []);
      const destination = String(document.getElementById('lxc-push-destination')?.value || '').trim();
      const error = document.getElementById('lxc-push-error');
      const fail = (message) => { if (error) { error.textContent = message; error.classList.remove('d-none'); } };
      if (!files.length) return fail(selectionType === 'folder' ? 'Select a folder.' : 'Select at least one file.');
      if (!destination.startsWith('/')) return fail('Enter an absolute destination directory.');
      const relativePaths = files.map(file => String(file.webkitRelativePath || file.name || ''));
      const modal = document.getElementById('lxcPushModal');
      await hideLxcSetupModal(modal);
      const transferLabel = selectionType === 'folder' ? 'Push Folder' : 'Push Files';
      await runQueued(`${transferLabel} (${getSelectedGuestEntries().length} guests)`, async () => {
        await runGuestTransfer(transferLabel, async (pid, targets, auth) => {
          const form = new FormData();
          form.append('payload', JSON.stringify({ ...auth, targets, destination, relativePaths, selectionType }));
          files.forEach(file => form.append('files', file, file.name));
          return http('POST', `/api/projects/${encodeURIComponent(pid)}/instances/actions/guest_push`, form);
        });
      }, { projectId: PROJ?.id });
    });
  }
  const pullButton = document.getElementById('lxc-pull-confirm');
  if (pullButton && !pullButton._lxcTransferBound) {
    pullButton._lxcTransferBound = true;
    pullButton.addEventListener('click', async () => {
      const raw = String(document.getElementById('lxc-pull-paths')?.value || '');
      const paths = raw.split(/\r?\n/).map(path => path.trim()).filter(Boolean);
      const error = document.getElementById('lxc-pull-error');
      const fail = (message) => { if (error) { error.textContent = message; error.classList.remove('d-none'); } };
      if (!paths.length) return fail('Enter at least one guest path.');
      if (paths.some(path => !path.startsWith('/'))) return fail('Every guest path must be absolute.');
      const modal = document.getElementById('lxcPullModal');
      await hideLxcSetupModal(modal);
      await runQueued(`Pull Files (${getSelectedGuestEntries().length} guests)`, async () => {
        await runGuestTransfer('Pull Files', async (pid, targets, auth) => {
          return http('POST', `/api/projects/${encodeURIComponent(pid)}/instances/actions/guest_pull`, { ...auth, targets, paths: raw });
        });
      }, { projectId: PROJ?.id });
    });
  }
}

document.addEventListener('DOMContentLoaded', wireLxcTransferModals);

function _findVmDetailForTarget(proj, target) {
  try {
    const index = Number(target?.index);
    const name = String(target?.name || '').trim();
    if (!proj || !Number.isFinite(index) || !name) return null;
    const statuses = Array.isArray(proj.instance_statuses) ? proj.instance_statuses : [];
    const status = statuses.find(item => Number(item?.index) === index) || null;
    if (!status) return null;
    const details = Array.isArray(status.vm_details) ? status.vm_details : [];
    return details.find(item => String(item?.name || '').trim() === name) || null;
  } catch {
    return null;
  }
}

function _vmDetailIsRunning(detail) {
  if (!detail || typeof detail !== 'object') return false;
  const mapped = mapProxmoxPowerState(detail.power_state || detail.state || detail.qmp_state || '');
  if (String(mapped?.label || '').toLowerCase() === 'running') return true;
  return String(detail.qmp_state || '').trim().toLowerCase() === 'running';
}

function filterRunningTargetsForProject(proj, targets) {
  const running = [];
  const skipped = [];
  for (const target of (Array.isArray(targets) ? targets : [])) {
    const index = Number(target?.index);
    const name = String(target?.name || '').trim();
    if (!Number.isFinite(index) || !name) continue;
    const detail = _findVmDetailForTarget(proj, target);
    if (_vmDetailIsRunning(detail)) {
      running.push({ index, name });
      continue;
    }
    const stateHint = String(detail?.power_state || detail?.state || detail?.qmp_state || 'unknown');
    skipped.push({ index, name, reason: `validate requires VM state running (current: ${stateHint})` });
  }
  return { running, skipped };
}

function countExplicitActionTargets(opts = {}) {
  try {
    if (Array.isArray(opts.targets) && opts.targets.length) return opts.targets.length;
    const byPid = opts.targetsByPid;
    if (byPid && typeof byPid === 'object') {
      return Object.values(byPid).reduce((sum, arr) => sum + (Array.isArray(arr) ? arr.length : 0), 0);
    }
  } catch { }
  return 0;
}

function explicitActionProjectCount(opts = {}) {
  try {
    const byPid = opts.targetsByPid;
    if (byPid && typeof byPid === 'object') {
      return Object.keys(byPid).filter(pid => Array.isArray(byPid[pid]) && byPid[pid].length).length;
    }
  } catch { }
  return 0;
}

function buildCredsSetConfirmationMessage(opts = {}) {
  const explicitCount = countExplicitActionTargets(opts);
  const targetCount = explicitCount || getActionableSelections().length;
  const projectCount = explicitActionProjectCount(opts);
  const rowLabel = `${targetCount} row${targetCount === 1 ? '' : 's'}`;
  const projectLabel = projectCount > 1 ? ` across ${projectCount} projects` : '';
  return `This will create or update Proxmox users, reset passwords to the current credential list, ensure pools and memberships, and reconcile VM access for ${rowLabel}${projectLabel}. Continue?`;
}

const VM_CREATE_OPTION_DEFAULTS = Object.freeze({
  createUsersAndPerms: true,
  enableUserAccessibility: true,
  applyScenario: true,
  setNetworkInterfaces: true,
  takeSnapshot: true,
  startVm: false,
});

const VM_DELETE_OPTION_DEFAULTS = Object.freeze({
  deleteUsersAndPools: true,
  disableUserAccessibility: false,
  verifyCleanup: false,
});

function normalizeVmCreateOptions(options = {}) {
  const source = (options && typeof options === 'object') ? options : {};
  return {
    createUsersAndPerms: _coerceEnabled(source.createUsersAndPerms, VM_CREATE_OPTION_DEFAULTS.createUsersAndPerms),
    enableUserAccessibility: _coerceEnabled(source.enableUserAccessibility, VM_CREATE_OPTION_DEFAULTS.enableUserAccessibility),
    applyScenario: _coerceEnabled(source.applyScenario, VM_CREATE_OPTION_DEFAULTS.applyScenario),
    setNetworkInterfaces: _coerceEnabled(source.setNetworkInterfaces, VM_CREATE_OPTION_DEFAULTS.setNetworkInterfaces),
    takeSnapshot: _coerceEnabled(source.takeSnapshot, VM_CREATE_OPTION_DEFAULTS.takeSnapshot),
    startVm: _coerceEnabled(source.startVm, VM_CREATE_OPTION_DEFAULTS.startVm),
  };
}

function normalizeVmDeleteOptions(options = {}) {
  const source = (options && typeof options === 'object') ? options : {};
  return {
    deleteUsersAndPools: _coerceEnabled(source.deleteUsersAndPools, VM_DELETE_OPTION_DEFAULTS.deleteUsersAndPools),
    disableUserAccessibility: _coerceEnabled(source.disableUserAccessibility, VM_DELETE_OPTION_DEFAULTS.disableUserAccessibility),
    verifyCleanup: _coerceEnabled(source.verifyCleanup, VM_DELETE_OPTION_DEFAULTS.verifyCleanup),
  };
}

function buildVmCreateOptionsSummary(opts = {}) {
  const explicitTargetCount = countExplicitActionTargets(opts);
  const targetCount = explicitTargetCount || getActionableSelections().length;
  let projectCount = explicitActionProjectCount(opts);
  if (!projectCount) {
    if ((vmIsMulti && vmIsMulti()) || !!opts.targetsByPid) {
      const entries = getActionableSelections();
      projectCount = new Set(entries.map(entry => canonicalPid(entry?.pid || PROJ?.id || '')).filter(Boolean)).size;
    } else if (PROJ && PROJ.id) {
      projectCount = 1;
    }
  }
  const rowLabel = `${targetCount} row${targetCount === 1 ? '' : 's'}`;
  const projectLabel = projectCount > 1 ? ` across ${projectCount} projects` : '';
  return `Clone ${rowLabel}${projectLabel}. Selected create steps and follow-up actions run during or after cloning finishes.`;
}

function buildVmDeleteOptionsSummary(opts = {}) {
  const explicitTargetCount = countExplicitActionTargets(opts);
  const targetCount = explicitTargetCount || getActionableSelections().length;
  let projectCount = explicitActionProjectCount(opts);
  if (!projectCount) {
    if ((vmIsMulti && vmIsMulti()) || !!opts.targetsByPid) {
      const entries = getActionableSelections();
      projectCount = new Set(entries.map(entry => canonicalPid(entry?.pid || PROJ?.id || '')).filter(Boolean)).size;
    } else if (PROJ && PROJ.id) {
      projectCount = 1;
    }
  }
  const rowLabel = `${targetCount} row${targetCount === 1 ? '' : 's'}`;
  const projectLabel = projectCount > 1 ? ` across ${projectCount} projects` : '';
  return `Delete ${rowLabel}${projectLabel}. Selected pre-delete and post-delete actions run around VM deletion, while user/pool cleanup still only runs for instances with no remaining scenario VMs.`;
}

function mergeVmActionSummaryData(baseResp, extraResp) {
  const merged = { ...(baseResp || {}) };
  const source = extraResp || {};
  Object.keys(source).forEach((key) => {
    const value = source[key];
    if (Array.isArray(value)) {
      const existing = Array.isArray(merged[key]) ? merged[key] : [];
      merged[key] = [...existing, ...value];
      return;
    }
    if (key === 'outputs_zip') {
      if (!merged.outputs_zip && value) merged.outputs_zip = value;
      return;
    }
    if (merged[key] === undefined) {
      merged[key] = value;
    }
  });
  return merged;
}

function buildVmCreateFinalizeDetail(options = {}) {
  const normalizedOptions = normalizeVmCreateOptions(options);
  const steps = [];
  if (normalizedOptions.setNetworkInterfaces) steps.push('applying network interfaces');
  if (normalizedOptions.takeSnapshot) steps.push('taking post-clone snapshots');
  if (!steps.length) return 'Skipping network and snapshot steps';
  if (steps.length === 1) {
    const step = steps[0];
    return step.charAt(0).toUpperCase() + step.slice(1);
  }
  return 'Applying network interfaces and taking post-clone snapshots';
}

function buildVmCreateUserAccessibilityPlan(proj, targets) {
  const baseNameSet = new Set((proj?.vms || []).map(v => String(v?.name || '')));
  const bases = new Set();
  const indices = new Set();
  const skipped = [];
  for (const target of (targets || [])) {
    const index = Number(target?.index);
    const name = String(target?.name || '');
    if (Number.isFinite(index) && index > 0) indices.add(index);
    const baseName = deriveBaseVmName(proj, name, index);
    if (!baseName || !baseNameSet.has(baseName)) {
      skipped.push({ name, reason: 'template not found in project configuration' });
      continue;
    }
    bases.add(baseName);
  }
  return {
    bases: Array.from(bases),
    indices: Array.from(indices),
    skipped,
  };
}

async function runVmCreateUserAccessibilityFollowUp({ proj, targets, baseBody, setProgress, contextLabel, syncAccess = true, enable = true }) {
  const plan = buildVmCreateUserAccessibilityPlan(proj, targets);
  const result = {
    infos: [],
    skipped: [...plan.skipped],
    errors: [],
  };
  if (!proj || !proj.id || !plan.bases.length) return result;

  const queue = plan.bases.slice();
  let completed = 0;
  const maxConcurrent = Math.min(4, Math.max(1, queue.length));
  const worker = async () => {
    for (;;) {
      const baseName = queue.shift();
      if (!baseName) return;
      if (typeof setProgress === 'function') {
        setProgress(
          92,
          'User Accessibility…',
          `${enable ? 'Enabling' : 'Disabling'} user accessibility for ${baseName}${contextLabel ? ` in ${contextLabel}` : ''} (${completed + 1}/${plan.bases.length})…`
        );
      }
      try {
        await http('PATCH', `/api/projects/${encodeURIComponent(proj.id)}/vms/${encodeURIComponent(baseName)}`, { viewable_to_user: !!enable });
        try {
          const vmCfg = (proj?.vms || []).find(v => String(v?.name || '') === baseName);
          if (vmCfg) vmCfg.viewable_to_user = !!enable;
        } catch { }
        result.infos.push({ name: baseName, reason: `set viewable_to_user=${enable ? 'true' : 'false'}` });
      } catch (err) {
        result.errors.push({ name: baseName, reason: `set viewable_to_user failed: ${err?.message || err}` });
      }
      completed += 1;
    }
  };

  await Promise.all(Array.from({ length: maxConcurrent }, () => worker()));
  if (!syncAccess || !plan.indices.length) return result;

  if (typeof setProgress === 'function') {
    setProgress(93, 'User Accessibility…', `${enable ? 'Granting' : 'Revoking'} Proxmox access${contextLabel ? ` in ${contextLabel}` : ''}…`);
  }
  try {
    const syncResp = await http('POST', `/api/projects/${encodeURIComponent(proj.id)}/instances/actions/users_access_sync`, {
      ...(baseBody || {}),
      templates: plan.bases,
      indices: plan.indices,
      enable: !!enable,
    });
    return mergeVmActionSummaryData(result, syncResp);
  } catch (err) {
    return mergeVmActionSummaryData(result, {
      errors: [{ reason: `User accessibility sync failed${contextLabel ? ` in ${contextLabel}` : ''}: ${err?.message || err}` }],
    });
  }
}

async function runVmCreateActionFollowUp({ proj, action, baseBody, requestTargets, setProgress, progress = 95, label, detail, contextLabel, verifyRetry = false }) {
  if (typeof setProgress === 'function') {
    setProgress(progress, label, detail);
  }
  let resp = await http('POST', `/api/projects/${encodeURIComponent(proj.id)}/instances/actions/${action}`, {
    ...(baseBody || {}),
    targets: requestTargets,
  });
  if (verifyRetry) {
    const retryOutcome = await maybeRetryVerifiedVmAction({
      proj,
      action,
      resp,
      requestPath: `/api/projects/${encodeURIComponent(proj.id)}/instances/actions/${action}`,
      requestBody: baseBody,
      setProgress,
      contextLabel,
    });
    resp = retryOutcome.resp;
  }
  return resp;
}

async function runVmCreateFollowUpActions({ proj, targets, baseBody, createOptions, setProgress, contextLabel, summaryResp }) {
  const normalizedOptions = normalizeVmCreateOptions(createOptions);
  const requestTargets = Array.isArray(targets)
    ? targets
      .map(entry => ({ index: Number(entry.index), name: String(entry.name || '') }))
      .filter(entry => Number.isFinite(entry.index) && entry.name)
    : [];
  let mergedResp = summaryResp || {};
  if (!proj || !proj.id || !requestTargets.length) return mergedResp;

  const addFollowUpError = (label, err) => {
    mergedResp = mergeVmActionSummaryData(mergedResp, {
      errors: [{ reason: `${label} failed${contextLabel ? ` in ${contextLabel}` : ''}: ${err?.message || err}` }],
    });
  };

  if (normalizedOptions.enableUserAccessibility) {
    try {
      const accessibilityResp = await runVmCreateUserAccessibilityFollowUp({
        proj,
        targets: requestTargets,
        baseBody,
        setProgress,
        contextLabel,
        syncAccess: !normalizedOptions.createUsersAndPerms,
      });
      mergedResp = mergeVmActionSummaryData(mergedResp, accessibilityResp);
    } catch (err) {
      addFollowUpError('User accessibility follow-up', err);
    }
  }

  if (normalizedOptions.createUsersAndPerms) {
    try {
      const usersResp = await runVmCreateActionFollowUp({
        proj,
        action: 'users_create',
        baseBody,
        requestTargets,
        setProgress,
        progress: 96,
        label: 'Users & Access…',
        detail: `Creating users, pools, and permissions${contextLabel ? ` in ${contextLabel}` : ''}…`,
      });
      mergedResp = mergeVmActionSummaryData(mergedResp, usersResp);
    } catch (err) {
      addFollowUpError('Users & Access follow-up', err);
    }
  }

  if (normalizedOptions.applyScenario) {
    try {
      const scenarioResp = await runVmCreateActionFollowUp({
        proj,
        action: 'apply_scenario',
        baseBody,
        requestTargets,
        setProgress,
        progress: 92,
        label: 'Scenario…',
        detail: `Applying scenario notes${contextLabel ? ` in ${contextLabel}` : ''}…`,
      });
      mergedResp = mergeVmActionSummaryData(mergedResp, scenarioResp);
    } catch (err) {
      addFollowUpError('Scenario follow-up', err);
    }
  }

  if (normalizedOptions.startVm) {
    try {
      const startResp = await runVmCreateActionFollowUp({
        proj,
        action: 'start',
        baseBody,
        requestTargets,
        setProgress,
        progress: 99,
        label: 'Starting…',
        detail: `Starting newly created VMs${contextLabel ? ` in ${contextLabel}` : ''}…`,
        contextLabel,
        verifyRetry: true,
      });
      mergedResp = mergeVmActionSummaryData(mergedResp, startResp);
    } catch (err) {
      addFollowUpError('Start follow-up', err);
    }
  }

  return mergedResp;
}

async function runVmDeleteFollowUpActions({ proj, targets, baseBody, deleteOptions, setProgress, contextLabel, summaryResp }) {
  const normalizedOptions = normalizeVmDeleteOptions(deleteOptions);
  const requestTargets = Array.isArray(targets)
    ? targets
      .map(entry => ({ index: Number(entry.index), name: String(entry.name || '') }))
      .filter(entry => Number.isFinite(entry.index) && entry.name)
    : [];
  let mergedResp = summaryResp || {};
  if (!proj || !proj.id || !requestTargets.length) return mergedResp;

  const addFollowUpError = (label, err) => {
    mergedResp = mergeVmActionSummaryData(mergedResp, {
      errors: [{ reason: `${label} failed${contextLabel ? ` in ${contextLabel}` : ''}: ${err?.message || err}` }],
    });
  };

  if (normalizedOptions.disableUserAccessibility) {
    try {
      const accessibilityResp = await runVmCreateUserAccessibilityFollowUp({
        proj,
        targets: requestTargets,
        baseBody,
        setProgress,
        contextLabel,
        syncAccess: true,
        enable: false,
      });
      mergedResp = mergeVmActionSummaryData(mergedResp, accessibilityResp);
    } catch (err) {
      addFollowUpError('User accessibility follow-up', err);
    }
  }

  return mergedResp;
}

async function promptVmCreateOptions(opts = {}) {
  const modalEl = document.getElementById('vmCreateOptionsModal');
  if (!modalEl || !(window.bootstrap && typeof bootstrap.Modal === 'function')) {
    alert('Create options dialog is unavailable in this view.');
    return null;
  }
  const summaryEl = document.getElementById('vm-create-options-summary');
  const usersToggle = document.getElementById('vm-create-opt-users');
  const accessibilityToggle = document.getElementById('vm-create-opt-accessibility');
  const scenarioToggle = document.getElementById('vm-create-opt-scenario');
  const networkToggle = document.getElementById('vm-create-opt-network');
  const snapshotToggle = document.getElementById('vm-create-opt-snapshot');
  const startToggle = document.getElementById('vm-create-opt-start');
  const confirmBtn = document.getElementById('vm-create-options-confirm');
  if (!summaryEl || !usersToggle || !accessibilityToggle || !scenarioToggle || !networkToggle || !snapshotToggle || !startToggle || !confirmBtn) {
    alert('Create options dialog is incomplete in this view.');
    return null;
  }

  const defaults = normalizeVmCreateOptions(opts.createOptions);
  summaryEl.textContent = buildVmCreateOptionsSummary(opts);
  usersToggle.checked = defaults.createUsersAndPerms;
  accessibilityToggle.checked = defaults.enableUserAccessibility;
  scenarioToggle.checked = defaults.applyScenario;
  networkToggle.checked = defaults.setNetworkInterfaces;
  snapshotToggle.checked = defaults.takeSnapshot;
  startToggle.checked = defaults.startVm;

  return new Promise((resolve) => {
    const modal = bootstrap.Modal.getOrCreateInstance(modalEl);
    let finished = false;
    let result = null;

    const cleanup = () => {
      confirmBtn.removeEventListener('click', onConfirm);
      modalEl.removeEventListener('hidden.bs.modal', onHidden);
      modalEl.removeEventListener('shown.bs.modal', onShown);
    };

    const finish = (value) => {
      if (finished) return;
      finished = true;
      cleanup();
      resolve(value);
    };

    const onConfirm = () => {
      result = normalizeVmCreateOptions({
        createUsersAndPerms: !!usersToggle.checked,
        enableUserAccessibility: !!accessibilityToggle.checked,
        applyScenario: !!scenarioToggle.checked,
        setNetworkInterfaces: !!networkToggle.checked,
        takeSnapshot: !!snapshotToggle.checked,
        startVm: !!startToggle.checked,
      });
      modal.hide();
    };

    const onHidden = () => {
      finish(result);
    };

    const onShown = () => {
      try { confirmBtn.focus(); } catch { }
    };

    confirmBtn.addEventListener('click', onConfirm);
    modalEl.addEventListener('hidden.bs.modal', onHidden);
    modalEl.addEventListener('shown.bs.modal', onShown);
    modal.show();
  });
}

async function promptVmDeleteOptions(opts = {}) {
  const modalEl = document.getElementById('vmDeleteOptionsModal');
  if (!modalEl || !(window.bootstrap && typeof bootstrap.Modal === 'function')) {
    alert('Delete options dialog is unavailable in this view.');
    return null;
  }
  const summaryEl = document.getElementById('vm-delete-options-summary');
  const usersToggle = document.getElementById('vm-delete-opt-users');
  const accessibilityToggle = document.getElementById('vm-delete-opt-accessibility');
  const verifyCleanupToggle = document.getElementById('vm-delete-opt-verify-cleanup');
  const confirmBtn = document.getElementById('vm-delete-options-confirm');
  if (!summaryEl || !usersToggle || !accessibilityToggle || !verifyCleanupToggle || !confirmBtn) {
    alert('Delete options dialog is incomplete in this view.');
    return null;
  }

  const defaults = normalizeVmDeleteOptions(opts.deleteOptions);
  summaryEl.textContent = buildVmDeleteOptionsSummary(opts);
  usersToggle.checked = defaults.deleteUsersAndPools;
  accessibilityToggle.checked = defaults.disableUserAccessibility;
  verifyCleanupToggle.checked = defaults.verifyCleanup;

  return new Promise((resolve) => {
    const modal = bootstrap.Modal.getOrCreateInstance(modalEl);
    let finished = false;
    let result = null;

    const cleanup = () => {
      confirmBtn.removeEventListener('click', onConfirm);
      modalEl.removeEventListener('hidden.bs.modal', onHidden);
      modalEl.removeEventListener('shown.bs.modal', onShown);
    };

    const finish = (value) => {
      if (finished) return;
      finished = true;
      cleanup();
      resolve(value);
    };

    const onConfirm = () => {
      result = normalizeVmDeleteOptions({
        deleteUsersAndPools: !!usersToggle.checked,
        disableUserAccessibility: !!accessibilityToggle.checked,
        verifyCleanup: !!verifyCleanupToggle.checked,
      });
      modal.hide();
    };

    const onHidden = () => {
      finish(result);
    };

    const onShown = () => {
      try { confirmBtn.focus(); } catch { }
    };

    confirmBtn.addEventListener('click', onConfirm);
    modalEl.addEventListener('hidden.bs.modal', onHidden);
    modalEl.addEventListener('shown.bs.modal', onShown);
    modal.show();
  });
}

function deriveCredsRepairTargetsFromChecked(checked) {
  const rows = Array.isArray(checked) ? checked : [];
  const drift = rows.filter(item => String(item?.status || '') !== 'ok');
  if (!drift.length) return null;
  const hasProjectDimension = drift.some(item => item && typeof item === 'object' && item.project);
  if (hasProjectDimension) {
    const out = {};
    drift.forEach(item => {
      const pid = String(item?.project || '').trim();
      if (!pid) return;
      const rawName = String(item?.name || '').trim();
      const cleanName = rawName.replace(/^\[[^\]]+\]\s+/, '');
      const index = Number(item?.index);
      if (!Number.isFinite(index) || !cleanName) return;
      if (!Array.isArray(out[pid])) out[pid] = [];
      if (!out[pid].some(entry => Number(entry?.index) === index && String(entry?.name || '') === cleanName)) {
        out[pid].push({ index, name: cleanName });
      }
    });
    return Object.keys(out).length ? { targetsByPid: out, count: drift.length } : null;
  }
  const targets = [];
  drift.forEach(item => {
    const name = String(item?.name || '').trim();
    const index = Number(item?.index);
    if (!Number.isFinite(index) || !name) return;
    if (!targets.some(entry => Number(entry?.index) === index && String(entry?.name || '') === name)) {
      targets.push({ index, name });
    }
  });
  return targets.length ? { targets, count: drift.length } : null;
}

function friendlyActionName(action) {
  const map = {
    unlock: 'Unlock',
    nets_set: 'Set Network Interfaces',
    nets_remove: 'Remove Network Interfaces',
    // Backward-compatible aliases
    nets_assign: 'Set Network Interfaces',
    nets_clear: 'Remove Network Interfaces',
    run_startup_cmds: 'Run Startup Commands',
    run_stored_cmds: 'Run Stored Commands',
    validate: 'Validate',
    users_create: 'Create Users',
    users_delete: 'Delete Users',
    users_perms: 'Set User Perms',
    users_creds_check: 'Check Credential Sync',
    users_creds_set: 'Set Credentials to Current List',
    users_access_enable: 'Enable User Accessibility',
    users_access_disable: 'Disable User Accessibility',
  };
  if (!action) return '';
  if (map[action]) return map[action];
  return action.split('_').map(part => part ? part.charAt(0).toUpperCase() + part.slice(1) : '').join(' ').trim();
}

const VM_RETRY_VERIFY_ACTIONS = new Set(['create', 'delete', 'start', 'unlock', 'suspend', 'poweroff', 'snapshot', 'apply_scenario']);
const VM_RETRY_MERGE_ARRAY_KEYS = [
  'created', 'deleted', 'started', 'resumed', 'suspended', 'unlocked', 'powered_off',
  'snapshotted', 'restored', 'applied', 'ran', 'skipped', 'notices', 'infos',
  'ambiguous', 'network_applied_nodes', 'network_apply_errors', 'created_users',
  'created_pools', 'added_members', 'deleted_users', 'deleted_pools', 'updated_users', 'checked'
];

function getVmRetryRequestTargetName(proj, action, item) {
  const index = Number(item?.index);
  const rawName = String(item?.name || item?.resolved_name || '').trim();
  if (!Number.isFinite(index) || !rawName) return '';
  if (action === 'create' || action === 'delete') {
    return deriveBaseVmName(proj, rawName, index);
  }
  return rawName;
}

function getVmRetryTargetKey(proj, action, item) {
  const index = Number(item?.index);
  const requestName = getVmRetryRequestTargetName(proj, action, item);
  if (!Number.isFinite(index) || !requestName) return '';
  return `${index}|${requestName}`;
}

function mergeVmRetryResponses(baseResp, retryResp, untouchedErrors) {
  const merged = { ...(baseResp || {}), ...(retryResp || {}) };
  VM_RETRY_MERGE_ARRAY_KEYS.forEach((key) => {
    const before = Array.isArray(baseResp?.[key]) ? baseResp[key] : [];
    const after = Array.isArray(retryResp?.[key]) ? retryResp[key] : [];
    if (before.length || after.length) {
      merged[key] = [...before, ...after];
    }
  });
  merged.errors = [
    ...(Array.isArray(untouchedErrors) ? untouchedErrors : []),
    ...(Array.isArray(retryResp?.errors) ? retryResp.errors : []),
  ];
  if (!merged.outputs_zip && baseResp?.outputs_zip) {
    merged.outputs_zip = baseResp.outputs_zip;
  }
  return merged;
}

async function maybeRetryVerifiedVmAction({ proj, action, resp, requestPath, requestBody, setProgress, contextLabel }) {
  if (!VM_RETRY_VERIFY_ACTIONS.has(action)) {
    return { resp: resp || {}, verifiedCount: 0 };
  }

  const errors = Array.isArray(resp?.errors) ? resp.errors : [];
  const targetMap = new Map();
  for (const err of errors) {
    const index = Number(err?.index);
    const rawName = String(err?.name || '').trim();
    if (!Number.isFinite(index) || !rawName) continue;
    const target = { index, name: getVmRetryRequestTargetName(proj, action, { index, name: rawName }) };
    if (!target.name) continue;
    const key = `${target.index}|${target.name}`;
    if (!targetMap.has(key)) targetMap.set(key, target);
  }
  const failedTargets = Array.from(targetMap.values());
  if (!failedTargets.length) {
    return { resp: resp || {}, verifiedCount: 0 };
  }

  const friendly = friendlyActionName(action) || action;
  const scopeSuffix = contextLabel ? ` in ${contextLabel}` : '';
  const verifyBody = { ...(requestBody || {}), targets: failedTargets };
  if (action === 'snapshot') {
    const snapname = String(resp?.snapname || (Array.isArray(resp?.snapshotted) && resp.snapshotted[0]?.snapname) || '').trim();
    if (!snapname) {
      return {
        resp: {
          ...(resp || {}),
          notices: [...(Array.isArray(resp?.notices) ? resp.notices : []), { reason: 'Retry verification skipped because the snapshot name was unavailable.' }],
        },
        verifiedCount: 0,
      };
    }
    verifyBody.snapname = snapname;
  }

  if (typeof setProgress === 'function') {
    try {
      setProgress(45, 'Checking…', `Verifying failed ${friendly.toLowerCase()} results${scopeSuffix}…`);
    } catch { }
  }

  let verifyResp;
  try {
    verifyResp = await http('POST', `${requestPath}/retry-check`, verifyBody);
  } catch (e) {
    return {
      resp: {
        ...(resp || {}),
        notices: [...(Array.isArray(resp?.notices) ? resp.notices : []), { reason: `Retry verification failed: ${e?.message || e}` }],
      },
      verifiedCount: 0,
    };
  }

  const completed = Array.isArray(verifyResp?.completed) ? verifyResp.completed : [];
  const remaining = Array.isArray(verifyResp?.remaining) ? verifyResp.remaining : [];
  const failedKeys = new Set(failedTargets.map(item => `${item.index}|${item.name}`));
  const remainingKeys = new Set(remaining.map(item => getVmRetryTargetKey(proj, action, item)).filter(Boolean));
  const untouchedErrors = errors.filter((err) => {
    const key = getVmRetryTargetKey(proj, action, err);
    return !(key && failedKeys.has(key));
  });
  const remainingOriginalErrors = errors.filter((err) => {
    const key = getVmRetryTargetKey(proj, action, err);
    return !!(key && remainingKeys.has(key));
  });
  const completedInfos = completed.map(item => ({
    name: item?.resolved_name || item?.name || '',
    reason: item?.reason || `${friendly} already completed after verification`,
  }));
  let nextResp = {
    ...(resp || {}),
    infos: [...(Array.isArray(resp?.infos) ? resp.infos : []), ...completedInfos],
    errors: [...untouchedErrors, ...remainingOriginalErrors],
  };

  if (!remaining.length) {
    return { resp: nextResp, verifiedCount: completed.length };
  }

  const verifiedNote = completed.length ? ` ${completed.length} already completed on verification.` : '';
  const retry = window.confirm(`${friendly} failed on ${remaining.length} VM(s)${scopeSuffix}.${verifiedNote} Retry the remaining VM(s) now?`);
  if (!retry) {
    return { resp: nextResp, verifiedCount: completed.length };
  }

  if (typeof setProgress === 'function') {
    try {
      setProgress(55, 'Retrying…', `Retrying ${friendly.toLowerCase()} on ${remaining.length} VM(s)${scopeSuffix}…`);
    } catch { }
  }

  const retryBody = { ...(requestBody || {}), targets: remaining.map(item => ({ index: Number(item?.index), name: String(item?.name || '') })) };
  if (action === 'snapshot' && verifyBody.snapname) {
    retryBody.snapname = verifyBody.snapname;
  }

  let retryResp;
  try {
    retryResp = await http('POST', requestPath, retryBody);
  } catch (e) {
    return {
      resp: {
        ...nextResp,
        notices: [...(Array.isArray(nextResp?.notices) ? nextResp.notices : []), { reason: `Retry request failed: ${e?.message || e}` }],
      },
      verifiedCount: completed.length,
    };
  }

  const baseForRetry = { ...nextResp, errors: untouchedErrors };
  return {
    resp: mergeVmRetryResponses(baseForRetry, retryResp, untouchedErrors),
    verifiedCount: completed.length,
  };
}

function getProjectSnapshot(pid) {
  const target = canonicalPid(pid);
  if (!target) return null;
  if (PROJ && canonicalPid(PROJ.id) === target) return PROJ;
  const cache = window.PROJ_CACHE || {};
  if (cache[pid]) return cache[pid];
  for (const key of Object.keys(cache)) {
    if (canonicalPid(key) === target) return cache[key];
  }
  const match = (ALL_PROJECTS || []).find(p => canonicalPid(p.id) === target);
  return match || null;
}

function deriveBaseVmName(proj, generatedName, index) {
  const vmList = Array.isArray(proj?.vms) ? proj.vms : [];
  const tag = String(proj?.tag || '').trim();
  const idx = Number(index);
  const suffix = Number.isFinite(idx) ? `${tag}${idx}` : '';
  let baseName = String(generatedName || '');
  if (suffix && baseName.endsWith(suffix)) {
    baseName = baseName.slice(0, baseName.length - suffix.length);
  }
  if (!vmList.some(v => String(v?.name || '') === baseName)) {
    for (const vm of vmList) {
      const name = String(vm?.name || '');
      if (suffix && `${name}${suffix}` === String(generatedName || '')) {
        baseName = name;
        break;
      }
    }
  }
  return baseName || String(generatedName || '');
}

function findVmConfigByBaseName(proj, baseName) {
  const vmList = Array.isArray(proj?.vms) ? proj.vms : [];
  return vmList.find(v => String(v?.name || '') === String(baseName || '')) || null;
}

function vmBuildRestartTargetsForFailedValidation(proj, ranItems) {
  const failed = (ranItems || [])
    .filter(item => item.validation && !item.validation.all_passed)
    .map(item => ({ index: item.index, name: item.name }));
  if (!failed.length) return { failed: [], backends: [] };
  const failedIndices = new Set(failed.map(f => f.index));
  const failedNames = new Set(failed.map(f => f.name));
  const tag = String(proj?.tag || '').trim();
  const backends = [];
  for (const idx of failedIndices) {
    for (const vmTemplate of (proj?.vms || [])) {
      const baseName = String(vmTemplate?.name || '').trim();
      if (!baseName) continue;
      const generatedName = `${baseName}${tag}${idx}`;
      if (!failedNames.has(generatedName)) {
        backends.push({ index: idx, name: generatedName });
      }
    }
  }
  return { failed, backends };
}

async function vmMaybeRestartFailedValidation(plan) {
  if (!Array.isArray(plan) || !plan.length) return;
  const totalFailed = plan.reduce((sum, p) => sum + p.failed.length, 0);
  const totalBackends = plan.reduce((sum, p) => sum + p.backends.length, 0);
  const allVmNames = plan.flatMap(p => [...p.failed, ...p.backends].map(t => t.name));
  const namesPreview = allVmNames.slice(0, 6).join(', ') + (allVmNames.length > 6 ? ` (\u2026 +${allVmNames.length - 6} more)` : '');
  const backendNote = totalBackends ? ` and ${totalBackends} backend(s) in the same group(s)` : '';
  const msg = `${totalFailed} VM(s) failed validation.\n\nRestart failed VM(s)${backendNote}?\n\n${namesPreview}\n\nThis will power off then restart all of them.`;
  if (!window.confirm(msg)) return;
  for (const { proj, failed, backends } of plan) {
    const allTargets = [...failed, ...backends];
    if (!allTargets.length) continue;
    try { await vmActionExec(proj, allTargets, 'poweroff', {}); } catch { }
    try { await vmActionExec(proj, allTargets, 'start', {}); } catch { }
  }
}

function vmHasConfiguredValidationCommands(vmCfg) {
  const raw = Array.isArray(vmCfg?.validation_commands) ? vmCfg.validation_commands : [];
  for (const entry of raw) {
    if (entry === null || entry === undefined) continue;
    if (typeof entry === 'string' || typeof entry === 'number') {
      if (String(entry).trim()) return true;
      continue;
    }
    if (typeof entry !== 'object') continue;
    const command = String(entry.command ?? entry.cmd ?? entry.value ?? entry.text ?? '').trim();
    if (!command) continue;
    let enabled = entry.enabled;
    if (enabled === undefined && entry.disabled !== undefined) enabled = !entry.disabled;
    if (enabled === false) continue;
    if (typeof enabled === 'string') {
      const normalized = enabled.trim().toLowerCase();
      if (['false', '0', 'no', 'off', 'disabled'].includes(normalized)) continue;
    }
    if (typeof enabled === 'number' && enabled === 0) continue;
    return true;
  }
  return false;
}

function resolveValidationConfiguredFlag(rowLike, detail) {
  const d = detail && typeof detail === 'object' ? detail : {};
  if (Object.prototype.hasOwnProperty.call(d, 'validation_commands_configured')) {
    return !!d.validation_commands_configured;
  }
  try {
    const pid = canonicalPid(rowLike?.pid || PROJ?.id || '');
    const proj = getProjectSnapshot(pid);
    if (!proj) return true;
    const generatedName = String(rowLike?.vmName || d?.name || '').trim();
    const index = Number(rowLike?.index);
    const baseName = deriveBaseVmName(proj, generatedName, index);
    const vmCfg = findVmConfigByBaseName(proj, baseName);
    if (!vmCfg) return true;
    return vmHasConfiguredValidationCommands(vmCfg);
  } catch {
    return true;
  }
}

const STORED_CMD_CORE = (typeof window !== 'undefined' && window.StoredCommandCore) ? window.StoredCommandCore : null;

const findVmConfigIndex = (STORED_CMD_CORE && typeof STORED_CMD_CORE.findVmConfigIndex === 'function')
  ? (proj, baseName) => STORED_CMD_CORE.findVmConfigIndex(proj, baseName)
  : function findVmConfigIndex(proj, baseName) {
    const vmList = Array.isArray(proj?.vms) ? proj.vms : [];
    const target = String(baseName || '').trim();
    if (!target) return null;
    for (let i = 0; i < vmList.length; i += 1) {
      const name = String(vmList[i]?.name || '').trim();
      if (name === target) return i;
    }
    return null;
  };

const createHostContext = (STORED_CMD_CORE && typeof STORED_CMD_CORE.createHostContext === 'function')
  ? (proj, vmCfg, generatedName, baseName, index, label) => STORED_CMD_CORE.createHostContext(proj, vmCfg, generatedName, baseName, index, label)
  : function createHostContext(proj, vmCfg, generatedName, baseName, index, label) {
    const vmIndex = findVmConfigIndex(proj, baseName);
    return {
      pid: canonicalPid(proj?.id),
      pidRaw: proj?.id,
      vmIndex: Number.isInteger(vmIndex) && vmIndex >= 0 ? vmIndex : null,
      vmName: vmCfg?.name || baseName || generatedName || '',
      hostLabel: label,
      projectName: proj?.name || proj?.id || '',
    };
  };

const resolveStoredCommandContextIndex = (STORED_CMD_CORE && typeof STORED_CMD_CORE.resolveStoredCommandContextIndex === 'function')
  ? (ctx) => STORED_CMD_CORE.resolveStoredCommandContextIndex(ctx, { getProjectSnapshot })
  : function resolveStoredCommandContextIndex(ctx) {
    if (!ctx) return null;
    if (Number.isInteger(ctx.vmIndex) && ctx.vmIndex >= 0) {
      return ctx.vmIndex;
    }
    const pid = canonicalPid(ctx.pid || ctx.pidRaw || '');
    if (!pid) return null;
    const proj = getProjectSnapshot(pid);
    if (!proj) return null;
    const idx = findVmConfigIndex(proj, ctx.vmName || '');
    return Number.isInteger(idx) && idx >= 0 ? idx : null;
  };

function formatVmSelectionLabel(proj, generatedName, baseName, index, multi) {
  const projectName = proj ? (proj.name || proj.id || '') : '';
  const idx = Number(index);
  const idxLabel = Number.isFinite(idx) ? ` (instance ${idx})` : '';
  const display = String(generatedName || baseName || '').trim() || `VM${Number.isFinite(idx) ? ` ${idx}` : ''}`;
  if (multi && projectName) {
    return `[${projectName}] ${display}${idxLabel}`.trim();
  }
  return `${display}${idxLabel}`.trim();
}

function collectStoredCommandOptions() {
  const multi = (vmIsMulti && vmIsMulti());
  if (!multi && !PROJ) {
    return {
      options: [],
      missing: [],
      totalSelected: 0,
      hostsWithCommands: 0,
      multi,
      error: 'Select a project first.',
    };
  }
  const baseEntries = listSelectedEntries();
  const targetPid = canonicalPid(PROJ?.id);
  const scopedEntries = multi ? baseEntries : baseEntries.filter(entry => entry.pidCanonical === targetPid);
  const result = {
    options: [],
    missing: [],
    totalSelected: scopedEntries.length,
    hostsWithCommands: 0,
    multi,
    error: null,
  };
  if (!scopedEntries.length) {
    result.error = multi ? 'Select at least one VM row.' : 'Select at least one VM row in this project.';
    return result;
  }
  if (typeof normalizeStartCommandSteps !== 'function') {
    result.error = 'Stored commands are unavailable on this page.';
    return result;
  }

  const optionMap = new Map();
  const hostsWithCommands = new Set();
  const hostMap = new Map();
  const hostGroups = [];
  let hostCommandSerial = 0;

  const templateMap = new Map();
  const templateGroups = [];

  const ensureTemplateGroup = (templateKey, templateLabel, proj) => {
    if (!templateKey) return null;
    if (templateMap.has(templateKey)) {
      const existing = templateMap.get(templateKey);
      if (templateLabel && !existing.label) existing.label = templateLabel;
      return existing;
    }
    const entry = {
      key: templateKey,
      label: templateLabel || `Template ${templateGroups.length + 1}`,
      projectPid: canonicalPid(proj?.id),
      projectPidRaw: proj?.id || canonicalPid(proj?.id),
      projectName: proj?.name || proj?.id || '',
      commands: [],
      hosts: [],
      _commandMap: new Map(),
      _hostKeySet: new Set(),
    };
    templateMap.set(templateKey, entry);
    templateGroups.push(entry);
    return entry;
  };

  const ensureHostGroup = (hostKey, hostLabel) => {
    if (!hostKey) return null;
    if (hostMap.has(hostKey)) {
      const existing = hostMap.get(hostKey);
      if (hostLabel && !existing.label) existing.label = hostLabel;
      return existing;
    }
    const entry = {
      key: hostKey,
      label: hostLabel || `VM ${hostGroups.length + 1}`,
      commands: [],
    };
    hostMap.set(hostKey, entry);
    hostGroups.push(entry);
    return entry;
  };

  const registerCommand = (commandText, hostKey, hostLabel, meta = {}) => {
    const command = String(commandText || '').trim();
    if (!command) return;
    const stepIndex = Number.isFinite(meta.stepIndex) ? Number(meta.stepIndex) : null;
    const commandIndex = Number.isFinite(meta.commandIndex) ? Number(meta.commandIndex) : null;
    const delayValue = Number.isFinite(meta.delaySeconds) ? Number(meta.delaySeconds) : null;
    const longRunningFlag = meta.longRunning;
    const projectRef = meta.projectRef || null;
    const timeoutValue = Number.isFinite(meta.timeoutSeconds) && meta.timeoutSeconds > 0 ? Number(meta.timeoutSeconds) : null;
    const templateKey = meta.templateKey;
    const templateLabel = meta.templateLabel;
    const hostContext = meta.hostContext || null;
    const key = `${stepIndex ?? 'x'}|${commandIndex ?? 'x'}|${command}`;
    let entry = optionMap.get(key);
    if (!entry) {
      entry = {
        command,
        stepIndex,
        commandIndex,
        delaySeconds: delayValue && delayValue > 0 ? delayValue : null,
        delaySamples: new Set(),
        timeoutSamples: new Set(),
        longRunningStates: new Set(),
        hostKeys: new Set(),
        sampleLabels: [],
        allLabels: [],
      };
      optionMap.set(key, entry);
    }
    if (delayValue && delayValue > 0) {
      entry.delaySamples.add(delayValue);
      if (!Number.isFinite(entry.delaySeconds) || entry.delaySeconds <= 0) {
        entry.delaySeconds = delayValue;
      } else {
        entry.delaySeconds = Math.min(entry.delaySeconds, delayValue);
      }
    }
    if (timeoutValue) {
      entry.timeoutSamples.add(timeoutValue);
    }
    if (longRunningFlag === true) {
      entry.longRunningStates.add('true');
    } else if (longRunningFlag === false) {
      entry.longRunningStates.add('false');
    }
    if (entry.hostKeys.has(hostKey)) return;
    entry.hostKeys.add(hostKey);
    entry.allLabels.push(hostLabel);
    if (entry.sampleLabels.length < STORED_CMD_SAMPLE_LIMIT) {
      entry.sampleLabels.push(hostLabel);
    }
    const hostEntry = ensureHostGroup(hostKey, hostLabel);
    if (hostEntry) {
      hostEntry.commands.push({
        id: `stored-cmd-${hostCommandSerial += 1}`,
        command,
        stepIndex,
        commandIndex,
        delaySeconds: delayValue && delayValue > 0 ? delayValue : null,
        timeoutSeconds: timeoutValue,
        longRunning: longRunningFlag === true,
      });
    }
    if (templateKey) {
      const templateEntry = ensureTemplateGroup(templateKey, templateLabel, projectRef);
      if (templateEntry) {
        if (!templateEntry._hostKeySet) templateEntry._hostKeySet = new Set();
        if (!templateEntry._hostKeySet.has(hostKey)) {
          templateEntry._hostKeySet.add(hostKey);
          const ctx = hostContext || {};
          let ctxPid = canonicalPid(ctx.pid || ctx.pidRaw || templateEntry.projectPid || '');
          if (!ctxPid && templateEntry.projectPid) ctxPid = templateEntry.projectPid;
          const hostKeyParts = String(hostKey || '').split('|');
          let ctxIdx = Number.isInteger(ctx.vmIndex) ? ctx.vmIndex : null;
          if (ctxIdx === null) {
            const idxCandidate = Number(hostKeyParts[hostKeyParts.length - 1]);
            if (Number.isFinite(idxCandidate)) ctxIdx = idxCandidate;
          }
          let ctxName = ctx.vmName || '';
          if (!ctxName && hostKeyParts.length >= 2) ctxName = hostKeyParts[1] || '';
          templateEntry.hosts.push({
            hostKey,
            label: hostLabel,
            hostLabel,
            pid: ctxPid,
            pidRaw: ctx.pidRaw || ctx.pid || templateEntry.projectPidRaw || ctxPid,
            vmIndex: ctxIdx,
            vmName: ctxName,
            projectName: ctx.projectName || templateEntry.projectName || '',
          });
        }
        const templateCmdKey = [
          command,
          stepIndex || 'x',
          commandIndex || 'x',
          delayValue || 'x',
          timeoutValue || 'x',
          longRunningFlag === true ? '1' : (longRunningFlag === false ? '0' : 'x')
        ].join('|');
        let cmdEntry = templateEntry._commandMap.get(templateCmdKey);
        if (!cmdEntry) {
          cmdEntry = {
            id: `stored-cmd-template-${templateEntry.commands.length + 1}`,
            command,
            stepIndex,
            commandIndex,
            delaySeconds: delayValue && delayValue > 0 ? delayValue : null,
            timeoutSeconds: timeoutValue,
            longRunning: longRunningFlag === true,
            contexts: [],
          };
          templateEntry._commandMap.set(templateCmdKey, cmdEntry);
          templateEntry.commands.push(cmdEntry);
        }
        if (hostContext) {
          if (!cmdEntry._contextHostKeys) cmdEntry._contextHostKeys = new Set();
          const ctxPid = canonicalPid(hostContext.pid || hostContext.pidRaw || '');
          let ctxIdx = Number.isInteger(hostContext.vmIndex) ? hostContext.vmIndex : null;
          let ctxName = hostContext.vmName || '';
          if ((ctxIdx === null || !ctxName) && hostKey) {
            const parts = String(hostKey).split('|');
            if (ctxIdx === null) {
              const idxCandidate = Number(parts[parts.length - 1]);
              if (Number.isFinite(idxCandidate)) ctxIdx = idxCandidate;
            }
            if (!ctxName && parts.length >= 2) ctxName = parts[1] || '';
          }
          const ctxKey = `${ctxPid}|${ctxIdx ?? 'x'}|${ctxName}`;
          if (!cmdEntry._contextHostKeys.has(ctxKey)) {
            cmdEntry._contextHostKeys.add(ctxKey);
            cmdEntry.contexts.push({
              pid: ctxPid || templateEntry.projectPid,
              pidDisplay: hostContext.pidRaw || hostContext.pid || templateEntry.projectPidRaw || ctxPid,
              vmIndex: ctxIdx,
              vmName: ctxName,
              hostLabel: hostContext.hostLabel || hostLabel,
              projectName: hostContext.projectName || templateEntry.projectName || '',
              hostKey,
            });
          }
        }
      }
    }
  };

  const ingestHost = (proj, generatedName, index) => {
    const baseName = deriveBaseVmName(proj, generatedName, index);
    const baseKey = String(baseName || generatedName || '');
    const hostKey = `${canonicalPid(proj?.id)}|${baseKey}|${index}`;
    const vmCfg = findVmConfigByBaseName(proj, baseName);
    const label = formatVmSelectionLabel(proj, generatedName, baseName, index, multi);
    if (!vmCfg) {
      result.missing.push(`${label}: not found in project configuration`);
      return;
    }
    const hostContext = createHostContext(proj, vmCfg, generatedName, baseName, index, label);
    let steps;
    try {
      steps = normalizeStartCommandSteps(vmCfg.stored_commands || []);
    } catch (err) {
      steps = [];
    }
    const tmplName = vmCfg.template_name || vmCfg.template || vmCfg.name || baseName || generatedName;
    const tmplId = vmCfg.template_id || vmCfg.templateId || vmCfg.template_vmid;
    const templateLabelParts = [];
    if (tmplName) templateLabelParts.push(tmplName);
    if (tmplId !== undefined && tmplId !== null && tmplId !== '') templateLabelParts.push(`#${tmplId}`);
    const templateLabel = templateLabelParts.join(' ').trim() || `Template ${templateGroups.length + 1}`;
    const templateKey = `${canonicalPid(proj?.id)}|${tmplName || baseName}|${tmplId ?? ''}`;
    ensureTemplateGroup(templateKey, templateLabel, proj);
    let hostHasCommand = false;
    const stepList = Array.isArray(steps) ? steps : [];
    for (let stepIdx = 0; stepIdx < stepList.length; stepIdx += 1) {
      const step = stepList[stepIdx] || {};
      const commands = Array.isArray(step?.commands) ? step.commands : [];
      for (let cmdIdx = 0; cmdIdx < commands.length; cmdIdx += 1) {
        const entry = commands[cmdIdx];
        const text = typeof entry === 'string' ? String(entry).trim() : String(entry?.command || '').trim();
        const enabled = typeof entry === 'object' ? entry.enabled !== false : true;
        if (!text || !enabled) continue;
        const longRunning = typeof entry === 'object' ? entry.longRunning === true : false;
        let timeoutSeconds = typeof entry === 'object' ? Number(entry.timeoutSeconds) : VM_DEFAULT_COMMAND_TIMEOUT_SECONDS;
        if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
          timeoutSeconds = VM_DEFAULT_COMMAND_TIMEOUT_SECONDS;
        }
        registerCommand(text, hostKey, label, {
          stepIndex: stepIdx + 1,
          commandIndex: cmdIdx + 1,
          delaySeconds: Number(step?.delaySeconds) || 0,
          longRunning,
          timeoutSeconds,
          templateKey,
          templateLabel,
          projectRef: proj,
          hostContext,
        });
        hostHasCommand = true;
      }
    }
    if (hostHasCommand) {
      hostsWithCommands.add(hostKey);
    } else {
      result.missing.push(`${label}: no enabled stored commands`);
    }
  };

  if (multi) {
    for (const entry of scopedEntries) {
      if (!entry.pid || !entry.name || !Number.isFinite(entry.index)) continue;
      const proj = getProjectSnapshot(entry.pid);
      if (!proj) {
        result.missing.push(`${entry.pid}: project data unavailable`);
        continue;
      }
      ingestHost(proj, entry.name, entry.index);
    }
  } else {
    const proj = PROJ;
    for (const entry of scopedEntries) {
      if (!Number.isFinite(entry.index)) continue;
      ingestHost(proj, entry.name, entry.index);
    }
  }

  result.hostsWithCommands = hostsWithCommands.size;
  const options = Array.from(optionMap.values()).map(entry => {
    const longStateSize = entry.longRunningStates.size;
    const longRunningState = longStateSize === 0
      ? null
      : longStateSize === 1
        ? entry.longRunningStates.has('true')
        : null;
    const timeoutSamples = Array.from(entry.timeoutSamples || []);
    return {
      command: entry.command,
      hostCount: entry.hostKeys.size,
      sampleHosts: entry.sampleLabels.slice(),
      allHosts: entry.allLabels.slice(),
      stepIndex: entry.stepIndex,
      commandIndex: entry.commandIndex,
      delaySeconds: entry.delaySeconds,
      delaySamples: Array.from(entry.delaySamples || []),
      timeoutSamples,
      longRunning: longRunningState,
      longRunningStates: Array.from(entry.longRunningStates || []),
    };
  });
  const safeNumber = (value) => (Number.isFinite(value) ? Number(value) : Number.POSITIVE_INFINITY);
  options.sort((a, b) => {
    const stepDiff = safeNumber(a.stepIndex) - safeNumber(b.stepIndex);
    if (stepDiff !== 0) return stepDiff;
    const cmdDiff = safeNumber(a.commandIndex) - safeNumber(b.commandIndex);
    if (cmdDiff !== 0) return cmdDiff;
    if (b.hostCount !== a.hostCount) return b.hostCount - a.hostCount;
    const delayDiff = safeNumber(a.delaySeconds) - safeNumber(b.delaySeconds);
    if (delayDiff !== 0) return delayDiff;
    return a.command.localeCompare(b.command);
  });
  templateGroups.forEach(tGroup => {
    if (!Array.isArray(tGroup.commands)) tGroup.commands = [];
    tGroup.commands.forEach(cmd => {
      if (cmd && cmd._contextHostKeys) delete cmd._contextHostKeys;
    });
    delete tGroup._commandMap;
    delete tGroup._hostKeySet;
  });
  result.options = options;
  result.hostGroups = hostGroups;
  result.templateGroups = templateGroups;
  if (!options.length && !result.error) {
    result.error = 'No enabled stored commands are configured for the current selection.';
  }
  return result;
}

function openStoredCommandsManagerForContext(ctx) {
  try {
    if (!ctx) return;
    const pid = canonicalPid(ctx.pid || ctx.pidRaw || '');
    if (!pid) {
      alert('Project data for the selected stored command is unavailable.');
      return;
    }
    const idx = resolveStoredCommandContextIndex(ctx);
    if (idx === null) {
      alert('VM configuration for this stored command could not be found.');
      return;
    }
    if (typeof openStoredCommandsManager === 'function') {
      openStoredCommandsManager(pid, idx);
    } else {
      alert('Stored command editor is unavailable on this page.');
    }
  } catch (err) {
    console.error('Failed to open stored command editor', err);
    alert('Unable to open the stored command editor.');
  }
}

async function promptStoredCommandSelection() {
  let info = collectStoredCommandOptions();
  if (!info.options.length) {
    if (info.error) {
      alert(info.error);
    } else {
      alert('No stored commands are available for the current selection.');
    }
    return null;
  }
  const modalEl = document.getElementById('storedCmdPickerModal');
  if (!modalEl || !(window.bootstrap && typeof bootstrap.Modal === 'function')) {
    alert('Stored command picker is unavailable in this view.');
    return null;
  }
  const summaryEl = document.getElementById('stored-cmd-picker-summary');
  const missingEl = document.getElementById('stored-cmd-picker-missing');
  const listEl = document.getElementById('stored-cmd-picker-list');
  const emptyEl = document.getElementById('stored-cmd-picker-empty');
  const errorEl = document.getElementById('stored-cmd-picker-error');
  const runBtn = document.getElementById('stored-cmd-picker-run');
  const esc = (s) => String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[c] || c));
  let relevantPidSet = new Set();

  const INLINE_CMD_MAX_ROWS = 12;

  const normalizeInlineCommandText = (value) => {
    if (value === null || value === undefined) return '';
    const normalized = String(value).replace(/\r\n/g, '\n');
    return normalized.trim();
  };

  const calcTextareaRows = (value) => {
    const lines = String(value || '').split('\n').length;
    return Math.max(2, Math.min(INLINE_CMD_MAX_ROWS, lines));
  };

  const resolveInlinePersistTarget = (meta = {}) => {
    const contexts = Array.isArray(meta.contexts) ? meta.contexts : [];
    const fallbackHosts = Array.isArray(meta.fallbackHosts) ? meta.fallbackHosts : [];
    const groupPid = canonicalPid(meta.projectPid || meta.projectPidRaw || '');
    const groupPidRaw = meta.projectPidRaw || meta.projectPid || '';
    const pick = (ctx = {}) => {
      const pid = canonicalPid(ctx.pid || ctx.pidRaw || groupPid || '');
      if (!pid) return null;
      let vmIndex = Number.isInteger(ctx.vmIndex) ? ctx.vmIndex : null;
      if (vmIndex === null) {
        const resolved = resolveStoredCommandContextIndex ? resolveStoredCommandContextIndex(ctx) : null;
        if (Number.isInteger(resolved)) vmIndex = resolved;
      }
      if (vmIndex === null && Number.isInteger(meta.vmIndex)) {
        vmIndex = Number(meta.vmIndex);
      }
      if (!Number.isInteger(vmIndex) || vmIndex < 0) return null;
      const vmName = ctx.vmName || meta.vmName || '';
      return {
        pid,
        pidRaw: ctx.pidRaw || ctx.pid || groupPidRaw || pid,
        vmIndex,
        vmName,
      };
    };
    for (const ctx of contexts) {
      const resolved = pick(ctx);
      if (resolved) return resolved;
    }
    for (const host of fallbackHosts) {
      const resolved = pick(host);
      if (resolved) return resolved;
    }
    if (groupPid && Number.isInteger(meta.vmIndex)) {
      return {
        pid: groupPid,
        pidRaw: groupPidRaw || groupPid,
        vmIndex: Number(meta.vmIndex),
        vmName: meta.vmName || '',
      };
    }
    return null;
  };

  const persistInlineCommandChange = async (meta, newCommandText) => {
    const target = resolveInlinePersistTarget(meta);
    if (!target) {
      throw new Error('Unable to locate the stored command template for this edit. Refresh the page and try again.');
    }
    const { pid, pidRaw, vmIndex, vmName } = target;
    const stepIndex = Number(meta?.stepIndex);
    const commandIndex = Number(meta?.commandIndex);
    if (!Number.isInteger(stepIndex) || stepIndex <= 0 || !Number.isInteger(commandIndex) || commandIndex <= 0) {
      throw new Error('Command metadata is incomplete; reopen the picker and try again.');
    }
    const project = getProjectSnapshot(pid) || getProjectSnapshot(pidRaw);
    if (!project) {
      throw new Error('Project data unavailable; refresh and try again.');
    }
    const vmList = Array.isArray(project?.vms) ? project.vms : [];
    let cfgIdx = Number(vmIndex);
    let cfg = vmList[cfgIdx];
    if (!cfg || (vmName && cfg?.name && cfg.name !== vmName)) {
      cfgIdx = vmList.findIndex(vm => vm && vm.name === vmName);
      cfg = cfgIdx >= 0 ? vmList[cfgIdx] : cfg;
    }
    if (!cfg) {
      throw new Error('VM template for this stored command was not found.');
    }
    const rawStored = cfg.stored_commands || [];
    const steps = normalizeStartCommandSteps(rawStored);
    if (!Array.isArray(steps) || !steps.length) {
      throw new Error('No stored commands are configured for this template.');
    }
    const step = steps[stepIndex - 1];
    if (!step || !Array.isArray(step.commands) || !step.commands.length) {
      throw new Error('The referenced step could not be found in the template.');
    }
    if (!step.commands[commandIndex - 1]) {
      throw new Error('The referenced command could not be found in the template.');
    }
    step.commands[commandIndex - 1] = {
      ...step.commands[commandIndex - 1],
      command: newCommandText,
    };
    const sanitized = sanitizeStartCommandSteps ? sanitizeStartCommandSteps(steps) : steps;
    const payload = stepsToServerPayload ? stepsToServerPayload(sanitized) : sanitized;
    if (typeof saveVM !== 'function') {
      throw new Error('Saving stored commands is unavailable on this page.');
    }
    await saveVM(project.id, cfg.name || vmName, { stored_commands: payload }, { silent: true });
    try { updateStoredCommandsCache && updateStoredCommandsCache(project.id, cfg.name || vmName, sanitized, cfgIdx); } catch { }
    try { updateStoredCommandsDomState && updateStoredCommandsDomState(project.id, cfgIdx, sanitized); } catch { }
    try {
      if (PROJ && canonicalPid(PROJ.id) === canonicalPid(project.id) && Array.isArray(PROJ.vms)) {
        if (cfgIdx >= 0 && PROJ.vms[cfgIdx]) {
          PROJ.vms[cfgIdx] = { ...PROJ.vms[cfgIdx], stored_commands: payload.slice ? payload.slice() : payload };
        }
      }
    } catch { }
    try {
      document.dispatchEvent(new CustomEvent('stored-commands-updated', { detail: { pid: project.id } }));
    } catch { }
  };

  const getCommandRowMeta = (input) => {
    if (!input) return null;
    const item = input.closest('label.list-group-item');
    if (!item) return null;
    const original = item.dataset.originalCommand || input.value || '';
    const normalizedOriginal = normalizeInlineCommandText(original);
    if (!normalizedOriginal) return null;
    const override = item.dataset.override ? normalizeInlineCommandText(item.dataset.override) : '';
    const templateKey = item.dataset.templateKey || '';
    const stepIndex = item.dataset.stepIndex ? Number(item.dataset.stepIndex) : null;
    const commandIndex = item.dataset.commandIndex ? Number(item.dataset.commandIndex) : null;
    return {
      original,
      normalizedOriginal,
      override,
      templateKey,
      stepIndex,
      commandIndex,
      element: item,
    };
  };

  const collectSelections = () => {
    if (!listEl) return [];
    return Array.from(listEl.querySelectorAll('input[type="checkbox"][data-stored-cmd]'))
      .filter(input => input.checked)
      .map(getCommandRowMeta)
      .filter(Boolean);
  };

  const serializeSelectionResult = (entries) => {
    if (!Array.isArray(entries) || !entries.length) return null;
    const seen = new Set();
    const commands = [];
    const overrides = [];
    entries.forEach(entry => {
      if (!entry || !entry.normalizedOriginal) return;
      if (!seen.has(entry.normalizedOriginal)) {
        seen.add(entry.normalizedOriginal);
        commands.push(entry.original);
      }
      if (entry.override && Number.isFinite(entry.stepIndex) && Number.isFinite(entry.commandIndex)) {
        overrides.push({
          templateKey: entry.templateKey || '',
          stepIndex: entry.stepIndex,
          commandIndex: entry.commandIndex,
          text: entry.override,
        });
      }
    });
    if (!commands.length) return null;
    if (!overrides.length) return commands;
    return { commands, overrides };
  };

  const updateRunState = () => {
    if (!runBtn) return;
    runBtn.disabled = collectSelections().length === 0;
  };

  const stopEvent = (ev) => {
    if (!ev) return;
    if (typeof ev.stopPropagation === 'function') ev.stopPropagation();
    if (typeof ev.preventDefault === 'function') ev.preventDefault();
  };

  const buildInlineEditElements = ({ cmd, inputEl, displayEl, itemEl, editedBadge, persistMeta }) => {
    if (!inputEl || !displayEl || !itemEl) return null;
    const inlineWrap = document.createElement('div');
    inlineWrap.className = 'stored-cmd-inline-editor border rounded bg-light p-2 mt-2 d-none';
    inlineWrap.setAttribute('data-role', 'stored-cmd-inline-editor');
    const note = document.createElement('div');
    note.className = 'small text-muted mb-2';
    note.textContent = 'Inline edits immediately update the stored command template.';
    inlineWrap.appendChild(note);

    const getResolvedText = () => itemEl.dataset.override || itemEl.dataset.originalCommand || inputEl.value || cmd?.command || '';
    const textarea = document.createElement('textarea');
    textarea.className = 'form-control form-control-sm font-monospace';
    textarea.value = getResolvedText();
    textarea.rows = calcTextareaRows(textarea.value);
    textarea.setAttribute('aria-label', 'Edit command inline');
    textarea.spellcheck = false;
    inlineWrap.appendChild(textarea);

    const errorEl = document.createElement('div');
    errorEl.className = 'text-danger small mt-2 d-none';
    inlineWrap.appendChild(errorEl);

    const actionRow = document.createElement('div');
    actionRow.className = 'd-flex flex-wrap gap-2 mt-2';
    const applyBtn = document.createElement('button');
    applyBtn.type = 'button';
    applyBtn.className = 'btn btn-primary btn-sm';
    applyBtn.textContent = 'Apply';
    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'btn btn-outline-secondary btn-sm';
    cancelBtn.textContent = 'Cancel';
    actionRow.appendChild(applyBtn);
    actionRow.appendChild(cancelBtn);
    inlineWrap.appendChild(actionRow);

    const toggleBtn = document.createElement('button');
    toggleBtn.type = 'button';
    toggleBtn.className = 'btn btn-outline-secondary btn-sm stored-cmd-inline-btn d-flex align-items-center gap-1';
    toggleBtn.innerHTML = '<i class="bi bi-pencil-square"></i><span>Inline edit</span>';
    toggleBtn.setAttribute('aria-expanded', 'false');

    const persistTargetMeta = persistMeta && typeof persistMeta === 'object' ? persistMeta : null;
    const initialApplyLabel = applyBtn.textContent;

    const clearError = () => {
      errorEl.textContent = '';
      errorEl.classList.add('d-none');
    };

    const showError = (msg) => {
      errorEl.textContent = msg;
      errorEl.classList.remove('d-none');
    };

    const setSaving = (state) => {
      if (state) {
        applyBtn.disabled = true;
        applyBtn.textContent = 'Saving…';
        cancelBtn.disabled = true;
        toggleBtn.disabled = true;
      } else {
        applyBtn.disabled = false;
        applyBtn.textContent = initialApplyLabel;
        cancelBtn.disabled = false;
        toggleBtn.disabled = false;
      }
    };

    const updateRows = () => {
      textarea.rows = calcTextareaRows(textarea.value);
    };

    const updateEditedBadge = () => {
      if (!editedBadge) return;
      const original = normalizeInlineCommandText(itemEl.dataset.originalCommand || '');
      const override = normalizeInlineCommandText(itemEl.dataset.override || '');
      if (override && override !== original) {
        editedBadge.classList.remove('d-none');
      } else {
        editedBadge.classList.add('d-none');
      }
    };

    const buildPersistPayload = () => {
      const numericVmIndex = Number.isFinite(Number(itemEl.dataset.vmIndex)) ? Number(itemEl.dataset.vmIndex) : null;
      return {
        ...(persistTargetMeta || {}),
        projectPid: persistTargetMeta?.projectPid || itemEl.dataset.projectPid,
        projectPidRaw: persistTargetMeta?.projectPidRaw || itemEl.dataset.projectPidRaw,
        vmIndex: (persistTargetMeta && persistTargetMeta.vmIndex != null) ? persistTargetMeta.vmIndex : numericVmIndex,
        vmName: persistTargetMeta?.vmName || itemEl.dataset.vmName || '',
        stepIndex: persistTargetMeta?.stepIndex || Number(itemEl.dataset.stepIndex),
        commandIndex: persistTargetMeta?.commandIndex || Number(itemEl.dataset.commandIndex),
      };
    };

    const showEditor = () => {
      inlineWrap.classList.remove('d-none');
      toggleBtn.setAttribute('aria-expanded', 'true');
      setTimeout(() => {
        try {
          textarea.focus();
          textarea.select();
        } catch { }
      }, 50);
    };

    const hideEditor = () => {
      inlineWrap.classList.add('d-none');
      toggleBtn.setAttribute('aria-expanded', 'false');
    };

    const applyInlineUpdate = async () => {
      clearError();
      const normalized = normalizeInlineCommandText(textarea.value);
      if (!normalized) {
        showError('Command text cannot be empty.');
        return;
      }
      const original = normalizeInlineCommandText(itemEl.dataset.originalCommand || '');
      if (normalized === original) {
        delete itemEl.dataset.override;
        textarea.value = itemEl.dataset.originalCommand || '';
        displayEl.textContent = itemEl.dataset.originalCommand || '';
        updateRows();
        updateEditedBadge();
        hideEditor();
        return;
      }

      const previousDisplay = displayEl.textContent;
      itemEl.dataset.override = normalized;
      displayEl.textContent = normalized;
      updateEditedBadge();
      setSaving(true);

      try {
        await persistInlineCommandChange(buildPersistPayload(), normalized);
        itemEl.dataset.originalCommand = normalized;
        delete itemEl.dataset.override;
        inputEl.value = normalized;
        inputEl.setAttribute('value', normalized);
        displayEl.textContent = normalized;
        textarea.value = normalized;
        updateRows();
        clearError();
        updateEditedBadge();
        hideEditor();
      } catch (err) {
        delete itemEl.dataset.override;
        displayEl.textContent = previousDisplay || (itemEl.dataset.originalCommand || '');
        updateEditedBadge();
        showError(err?.message || 'Failed to save inline edit.');
      } finally {
        setSaving(false);
      }
    };

    toggleBtn.addEventListener('click', (ev) => {
      stopEvent(ev);
      const isHidden = inlineWrap.classList.contains('d-none');
      textarea.value = getResolvedText();
      updateRows();
      clearError();
      if (isHidden) {
        showEditor();
      } else {
        hideEditor();
      }
    });

    applyBtn.addEventListener('click', (ev) => {
      stopEvent(ev);
      applyInlineUpdate();
    });

    cancelBtn.addEventListener('click', (ev) => {
      stopEvent(ev);
      delete itemEl.dataset.override;
      textarea.value = itemEl.dataset.originalCommand || '';
      displayEl.textContent = itemEl.dataset.originalCommand || displayEl.textContent;
      clearError();
      updateRows();
      updateEditedBadge();
      hideEditor();
    });

    textarea.addEventListener('input', () => {
      updateRows();
      clearError();
    });

    textarea.addEventListener('keydown', (ev) => {
      ev.stopPropagation();
      if ((ev.metaKey || ev.ctrlKey) && ev.key === 'Enter') {
        ev.preventDefault();
        applyInlineUpdate();
      } else if (ev.key === 'Escape') {
        ev.preventDefault();
        hideEditor();
      }
    });

    ['click', 'mousedown', 'mouseup'].forEach(evt => {
      inlineWrap.addEventListener(evt, stopEvent);
    });

    displayEl.textContent = getResolvedText();
    updateEditedBadge();

    return {
      button: toggleBtn,
      container: inlineWrap,
      updateEditedBadge,
    };
  };

  const buildHostButton = (host, idx) => {
    const label = host?.label || host?.hostLabel || `Host ${idx + 1}`;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn-light btn-sm border stored-cmd-host-btn d-flex align-items-center gap-1';
    btn.innerHTML = `<span>${esc(label)}</span><i class="bi bi-pencil"></i>`;
    btn.title = `Edit stored commands for ${label}`;
    btn.addEventListener('click', (ev) => {
      stopEvent(ev);
      openStoredCommandsManagerForContext({
        pid: host?.pid || host?.pidRaw,
        pidRaw: host?.pidRaw || host?.pid,
        vmIndex: Number.isInteger(host?.vmIndex) ? host.vmIndex : null,
        vmName: host?.vmName || '',
        hostLabel: label,
        projectName: host?.projectName || '',
      });
    });
    return btn;
  };

  const applyInfoToDom = (data, preserveSelections) => {
    info = data;
    const preserveSet = preserveSelections instanceof Set ? preserveSelections : null;
    relevantPidSet = new Set();
    (data.templateGroups || []).forEach(group => {
      (group.hosts || []).forEach(host => {
        const pid = canonicalPid(host?.pid || host?.pidRaw || '');
        if (pid) relevantPidSet.add(pid);
      });
    });
    if (summaryEl) {
      summaryEl.textContent = `${data.totalSelected} VM${data.totalSelected === 1 ? '' : 's'} selected • ${data.hostsWithCommands} with stored commands`;
    }
    if (missingEl) {
      const missing = Array.isArray(data.missing) ? data.missing.filter(Boolean) : [];
      if (missing.length) {
        missingEl.classList.remove('d-none');
        const list = missing.map(item => `<li>${esc(item)}</li>`).join('');
        missingEl.innerHTML = `<ul class="mb-0 ps-3">${list}</ul>`;
      } else {
        missingEl.classList.add('d-none');
        missingEl.innerHTML = '';
      }
    }
    if (listEl) {
      listEl.innerHTML = '';
      const groups = Array.isArray(data.templateGroups)
        ? data.templateGroups.filter(group => Array.isArray(group.commands) && group.commands.length)
        : [];
      if (!groups.length) {
        const fallback = document.createElement('div');
        fallback.className = 'text-muted small';
        fallback.textContent = 'No stored commands available for the current selection.';
        listEl.appendChild(fallback);
      } else {
        groups.forEach((group, groupIdx) => {
          const section = document.createElement('section');
          section.className = 'stored-cmd-template mb-4';
          const header = document.createElement('div');
          header.className = 'stored-cmd-template-header mb-2';
          const headerName = document.createElement('div');
          headerName.className = 'stored-cmd-template-name';
          headerName.textContent = group.label || `Template ${groupIdx + 1}`;
          header.appendChild(headerName);
          if (Array.isArray(group.hosts) && group.hosts.length) {
            const hostList = document.createElement('div');
            hostList.className = 'stored-cmd-template-hosts text-muted small d-flex flex-wrap gap-2';
            group.hosts.forEach((host, hostIdx) => {
              try {
                hostList.appendChild(buildHostButton(host, hostIdx));
              } catch { }
            });
            header.appendChild(hostList);
          }
          section.appendChild(header);
          const groupList = document.createElement('div');
          groupList.className = 'list-group list-group-flush';
          group.commands.forEach((cmd, idx) => {
            const item = document.createElement('label');
            item.className = 'list-group-item d-flex align-items-start gap-2 flex-column flex-sm-row';
            item.dataset.originalCommand = cmd.command || '';
            if (group.key) item.dataset.templateKey = group.key;
            if (Number.isFinite(cmd.stepIndex)) item.dataset.stepIndex = String(cmd.stepIndex);
            if (Number.isFinite(cmd.commandIndex)) item.dataset.commandIndex = String(cmd.commandIndex);
            const primaryHost = Array.isArray(group.hosts) && group.hosts.length ? (group.hosts.find(host => Number.isInteger(host.vmIndex)) || group.hosts[0]) : null;
            if (primaryHost) {
              const hostPid = canonicalPid(primaryHost.pid || primaryHost.pidRaw || group.projectPid || group.projectPidRaw || '');
              if (hostPid) item.dataset.projectPid = hostPid;
              if (primaryHost.pidRaw || group.projectPidRaw) item.dataset.projectPidRaw = primaryHost.pidRaw || group.projectPidRaw;
              if (Number.isInteger(primaryHost.vmIndex)) item.dataset.vmIndex = String(primaryHost.vmIndex);
              if (primaryHost.vmName) item.dataset.vmName = primaryHost.vmName;
            }
            const input = document.createElement('input');
            input.type = 'checkbox';
            input.name = `stored-cmd-template-${groupIdx}-${idx}`;
            input.className = 'form-check-input mt-1';
            input.value = cmd.command;
            input.checked = preserveSet ? preserveSet.has(cmd.command) : false;
            input.setAttribute('data-stored-cmd', 'true');
            const wrapper = document.createElement('div');
            wrapper.className = 'flex-grow-1 w-100';
            const row = document.createElement('div');
            row.className = 'd-flex flex-column flex-sm-row gap-2 align-items-start w-100';
            const headingWrap = document.createElement('div');
            headingWrap.className = 'flex-grow-1';
            const metaLine = document.createElement('div');
            metaLine.className = 'd-flex flex-wrap align-items-center gap-2 mt-1';
            const structuralChips = [];
            if (Number.isFinite(cmd.stepIndex)) structuralChips.push(`Step ${cmd.stepIndex}`);
            if (Number.isFinite(cmd.commandIndex)) structuralChips.push(`Command ${cmd.commandIndex}`);
            if (Number.isFinite(cmd.delaySeconds) && cmd.delaySeconds > 0) {
              const roundedDelay = Math.round(Number(cmd.delaySeconds) * 1000) / 1000;
              structuralChips.push(`Delay ${roundedDelay}s`);
            }
            const badges = [];
            if (structuralChips.length) {
              badges.push({ className: 'badge bg-light text-dark border', text: structuralChips.join(' • ') });
            }
            if (Number.isFinite(cmd.timeoutSeconds) && cmd.timeoutSeconds > 0) {
              badges.push({ className: 'badge bg-light text-dark border', text: `Timeout ${cmd.timeoutSeconds}s` });
            }
            if (cmd.longRunning) {
              badges.push({ className: 'badge bg-warning text-dark', text: 'Long-running' });
            }
            const title = document.createElement('code');
            title.className = 'text-wrap flex-grow-1';
            title.textContent = cmd.command;
            headingWrap.appendChild(title);
            const editedBadge = document.createElement('span');
            editedBadge.className = 'badge bg-info text-dark ms-2 stored-cmd-inline-edited d-none';
            editedBadge.textContent = 'Edited';
            headingWrap.appendChild(editedBadge);
            if (badges.length) {
              badges.forEach(cfg => {
                const badge = document.createElement('span');
                badge.className = cfg.className;
                badge.textContent = cfg.text;
                metaLine.appendChild(badge);
              });
              headingWrap.appendChild(metaLine);
            }
            row.appendChild(headingWrap);
            const inlineEdit = buildInlineEditElements({
              cmd,
              inputEl: input,
              displayEl: title,
              itemEl: item,
              editedBadge,
              persistMeta: {
                templateKey: group.key || '',
                projectPid: group.projectPid,
                projectPidRaw: group.projectPidRaw,
                contexts: Array.isArray(cmd.contexts) ? cmd.contexts : [],
                fallbackHosts: group.hosts || [],
                vmIndex: primaryHost && Number.isInteger(primaryHost.vmIndex) ? primaryHost.vmIndex : null,
                vmName: primaryHost?.vmName || '',
                stepIndex: cmd.stepIndex,
                commandIndex: cmd.commandIndex,
              },
            });
            if (inlineEdit && inlineEdit.button) {
              row.appendChild(inlineEdit.button);
            }
            wrapper.appendChild(row);
            if (inlineEdit && inlineEdit.container) {
              wrapper.appendChild(inlineEdit.container);
            }
            item.appendChild(input);
            item.appendChild(wrapper);
            groupList.appendChild(item);
          });
          section.appendChild(groupList);
          listEl.appendChild(section);
        });
      }
    }
    if (emptyEl) {
      emptyEl.classList.toggle('d-none', data.options.length > 0);
    }
    if (errorEl) {
      errorEl.classList.add('d-none');
      errorEl.textContent = '';
    }
    updateRunState();
  };

  applyInfoToDom(info);

  const handleStoredCommandsUpdated = (event) => {
    const eventPid = canonicalPid(event?.detail?.pid);
    if (eventPid && relevantPidSet.size && !relevantPidSet.has(eventPid)) return;
    const preserve = new Set(collectSelections().map(entry => entry.original));
    applyInfoToDom(collectStoredCommandOptions(), preserve);
  };
  document.addEventListener('stored-commands-updated', handleStoredCommandsUpdated);

  return new Promise((resolve) => {
    const modal = bootstrap.Modal.getOrCreateInstance(modalEl);
    let resolved = false;
    let selectedValues = null;

    const cleanup = () => {
      if (listEl) listEl.removeEventListener('change', onChange);
      if (runBtn) runBtn.removeEventListener('click', onRun);
      modalEl.removeEventListener('hidden.bs.modal', onHidden);
      modalEl.removeEventListener('shown.bs.modal', onShown);
      document.removeEventListener('stored-commands-updated', handleStoredCommandsUpdated);
    };

    const finish = (value) => {
      if (resolved) return;
      resolved = true;
      cleanup();
      resolve(value);
    };

    const onChange = () => {
      updateRunState();
      if (errorEl) {
        errorEl.classList.add('d-none');
        errorEl.textContent = '';
      }
    };

    const onRun = () => {
      const chosenValues = collectSelections();
      if (!chosenValues.length) {
        if (errorEl) {
          errorEl.textContent = 'Select at least one command to run.';
          errorEl.classList.remove('d-none');
        }
        return;
      }
      const serialized = serializeSelectionResult(chosenValues);
      if (!serialized) {
        if (errorEl) {
          errorEl.textContent = 'Unable to prepare selected commands. Please try again.';
          errorEl.classList.remove('d-none');
        }
        return;
      }
      selectedValues = serialized;
      modal.hide();
    };

    const onHidden = () => {
      finish(selectedValues || null);
    };

    const onShown = () => {
      const first = modalEl.querySelector('input[type="checkbox"][data-stored-cmd]');
      if (first) {
        try { first.focus(); } catch { }
      }
    };

    if (listEl) listEl.addEventListener('change', onChange);
    if (runBtn) runBtn.addEventListener('click', onRun);
    modalEl.addEventListener('hidden.bs.modal', onHidden, { once: true });
    modalEl.addEventListener('shown.bs.modal', onShown, { once: true });
    modal.show();
  });
}

function normalizeSelectedCommands(value) {
  const rawArray = Array.isArray(value) ? value : (value ? [value] : []);
  const seen = new Set();
  const out = [];
  rawArray.forEach(item => {
    const text = typeof item === 'string' ? item : (item == null ? '' : String(item));
    const trimmed = text.trim();
    if (!trimmed || seen.has(trimmed)) return;
    seen.add(trimmed);
    out.push(trimmed);
  });
  return out;
}

function normalizeOverrideText(value) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/\r\n/g, '\n').trim();
}

function coerceStoredCommandOverrides(value) {
  if (!Array.isArray(value)) return null;
  const out = [];
  value.forEach(entry => {
    if (!entry || typeof entry !== 'object') return;
    const templateKey = String(entry.templateKey || '').trim();
    const stepIndex = Number(entry.stepIndex);
    const commandIndex = Number(entry.commandIndex);
    const text = normalizeOverrideText(entry.text ?? entry.command ?? entry.override);
    if (!text || !Number.isFinite(stepIndex) || !Number.isFinite(commandIndex)) return;
    out.push({ templateKey, stepIndex, commandIndex, text });
  });
  return out.length ? out : null;
}

function interpretStoredCommandSelection(value) {
  if (!value) {
    return { commands: [], overrides: null };
  }
  if (Array.isArray(value)) {
    return { commands: normalizeSelectedCommands(value), overrides: null };
  }
  if (typeof value === 'object') {
    if (Array.isArray(value.commands)) {
      return {
        commands: normalizeSelectedCommands(value.commands),
        overrides: coerceStoredCommandOverrides(value.overrides),
      };
    }
    if (Array.isArray(value.values)) {
      return {
        commands: normalizeSelectedCommands(value.values),
        overrides: coerceStoredCommandOverrides(value.overrides),
      };
    }
  }
  return { commands: normalizeSelectedCommands(value), overrides: null };
}

// Dispatch VM actions (queued wrapper)
async function vmAction(action, opts) {
  const options = opts ? { ...opts } : {};
  const multi = (vmIsMulti && vmIsMulti()) || !!options.targetsByPid;
  let actionProject = null;
  if (multi) {
    if (!options.targetsByPid) {
      const targetsByPid = {};
      listSelectedEntries().forEach(entry => {
        const pid = canonicalPid(entry?.pid);
        if (!pid || !Number.isFinite(Number(entry?.index)) || !entry?.name) return;
        if (!targetsByPid[pid]) targetsByPid[pid] = [];
        targetsByPid[pid].push({ index: Number(entry.index), name: String(entry.name) });
      });
      options.targetsByPid = targetsByPid;
    }
  } else {
    const currentProject = PROJ;
    if (currentProject && typeof currentProject === 'object') {
      try {
        actionProject = typeof structuredClone === 'function'
          ? structuredClone(currentProject)
          : JSON.parse(JSON.stringify(currentProject));
      } catch {
        actionProject = {
          ...currentProject,
          vms: Array.isArray(currentProject.vms) ? currentProject.vms.map(vm => ({ ...vm })) : [],
          instance_statuses: Array.isArray(currentProject.instance_statuses) ? currentProject.instance_statuses.map(status => ({ ...status })) : [],
        };
      }
      options.project = actionProject;
      if (!Array.isArray(options.targets) || !options.targets.length) {
        options.targets = listSelectedEntriesForPid(actionProject.id)
          .map(entry => ({ index: Number(entry.index), name: String(entry.name || '') }))
          .filter(entry => Number.isFinite(entry.index) && entry.name);
      }
    }
  }
  const liveStateDecision = await vmEnsureLiveStateBeforeAction(options);
  if (liveStateDecision !== 'continue') return;
  if (action === 'users_creds_set') {
    const confirmed = window.confirm(buildCredsSetConfirmationMessage(options));
    if (!confirmed) return;
  }
  if (action === 'run_stored_cmds') {
    const initial = interpretStoredCommandSelection(options.selectedCommands || options.selectedCommand);
    let selectedCommands = initial.commands;
    let overridePayload = initial.overrides || coerceStoredCommandOverrides(options.storedCommandOverrides);
    if (!selectedCommands.length) {
      const picked = await promptStoredCommandSelection();
      const interpreted = interpretStoredCommandSelection(picked);
      selectedCommands = interpreted.commands;
      overridePayload = interpreted.overrides || null;
      if (!selectedCommands.length) return;
    }
    options.selectedCommands = selectedCommands;
    if (overridePayload && overridePayload.length) {
      options.storedCommandOverrides = overridePayload;
    } else {
      delete options.storedCommandOverrides;
    }
  }
  if (action === 'create') {
    if (options.createOptions) {
      options.createOptions = normalizeVmCreateOptions(options.createOptions);
    } else {
      const createOptions = await promptVmCreateOptions(options);
      if (!createOptions) return;
      options.createOptions = createOptions;
    }
  }
  if (action === 'delete') {
    if (options.deleteOptions) {
      options.deleteOptions = normalizeVmDeleteOptions(options.deleteOptions);
    } else {
      const deleteOptions = await promptVmDeleteOptions(options);
      if (!deleteOptions) return;
      options.deleteOptions = deleteOptions;
    }
  }
  const selCount = countExplicitActionTargets(options) || getActionableSelections().length;
  const labelName = friendlyActionName(action) || action;
  const commandSuffix = (() => {
    const cmds = Array.isArray(options.selectedCommands) ? options.selectedCommands : [];
    if (!cmds.length) return '';
    if (cmds.length === 1) return ` — ${cmds[0]}`;
    return ` — ${cmds.length} cmds`;
  })();
  const label = multi
    ? `Multi ${labelName}${commandSuffix}`
    : `${labelName}${commandSuffix} (${selCount || 0} item${(selCount || 0) === 1 ? '' : 's'})`;
  const queueProjectId = multi ? canonicalPid(PROJ?.id) : canonicalPid(actionProject?.id);
  await runQueued(label, async () => { await vmActionExec(action, options); }, { projectId: queueProjectId });
}

// Original implementation moved to vmActionExec
async function vmActionExec(action, opts = {}) {
  const project = opts && opts.project && typeof opts.project === 'object' ? opts.project : PROJ;
  return vmActionExecForProject(action, opts, project);
}

async function vmActionExecForProject(action, opts = {}, PROJ = null) {
  if ((vmIsMulti && vmIsMulti()) || !!opts.targetsByPid) { return vmActionMultiExec(action, opts); }
  if (!PROJ) { alert('Select a project first.'); return; }
  const selected = Array.isArray(opts.targets) && opts.targets.length
    ? opts.targets.map(entry => ({ index: Number(entry.index), name: String(entry.name || '') })).filter(entry => Number.isFinite(entry.index) && entry.name)
    : listSelectedEntriesForPid(PROJ.id);
  if (!selected.length) { alert('Select at least one VM row in this project.'); return; }

  // Configuration-only actions: toggle whether VM templates are user-accessible.
  if (action === 'users_access_enable' || action === 'users_access_disable') {
    const enable = action === 'users_access_enable';
    const prettyAction = friendlyActionName(action) || action;
    // Progress indicator helpers funnel into shared queue state
    const setAp = (pct, text, detail) => {
      try { updateVmInlineProgress(pct, text, detail); } catch { }
      try { updateActionProgress(pct, text, detail); } catch { }
    };
    let topProg = null;
    try {
      topProg = document.getElementById('vm-progress');
      if (topProg) showVmInlineProgress('Preparing…', 5, 'Resolving templates…');
    } catch { }
    try { showActionProgress(`${prettyAction} in progress`, 'Preparing…'); } catch { }
    setAp(10, 'Preparing…', 'Resolving templates…');
    ACTION_IN_FLIGHT = true;
    CURRENT_ACTION = action;
    ACTION_RUN_ID += 1;
    updateRefreshState();

    const proj = PROJ;
    const tag = String(proj?.tag || '').trim();
    const baseNames = new Set((proj?.vms || []).map(v => String(v?.name || '')));
    const toBaseName = (t) => {
      const idxStr = String(t.index);
      const suffix = `${tag}${idxStr}`;
      const full = String(t.name || '');
      let base = full;
      if (suffix && full.endsWith(suffix)) base = full.slice(0, full.length - suffix.length);
      if (!baseNames.has(base)) {
        for (const v of (proj?.vms || [])) {
          if (String(v?.name || '') + suffix === full) { base = String(v?.name || ''); break; }
        }
      }
      return base;
    };

    try {
      const uniqueBases = new Set();
      const uniqueIndices = new Set();
      const skipped = [];
      for (const t of selected) {
        try { uniqueIndices.add(Number(t.index)); } catch { }
        const base = toBaseName(t);
        if (!base || !baseNames.has(base)) {
          skipped.push({ name: String(t.name || ''), reason: 'template not found in project configuration' });
          continue;
        }
        uniqueBases.add(base);
      }
      const bases = Array.from(uniqueBases);
      const indices = Array.from(uniqueIndices).filter(n => Number.isFinite(n) && n > 0);
      if (!bases.length) {
        try { showActionSummary(prettyAction, { skipped, notices: [{ reason: 'No VM templates were updated.' }] }); } catch { }
        return;
      }

      const infos = [];
      const maxConcurrent = 4;
      let completed = 0;
      const queue = bases.slice();
      const worker = async () => {
        for (; ;) {
          const base = queue.shift();
          if (!base) return;
          const pct = Math.round(10 + (completed / Math.max(1, bases.length)) * 60);
          setAp(pct, 'Working…', `${enable ? 'Enabling' : 'Disabling'} user accessibility for ${base}…`);
          await http('PATCH', `/api/projects/${proj.id}/vms/${encodeURIComponent(base)}`, { viewable_to_user: enable });
          // Update local snapshot so subsequent actions use the new state without a full refresh
          try {
            const vmCfg = (PROJ?.vms || []).find(v => String(v?.name || '') === base);
            if (vmCfg) vmCfg.viewable_to_user = enable;
          } catch { }
          completed += 1;
          infos.push({ name: base, reason: `set viewable_to_user=${enable ? 'true' : 'false'}` });
        }
      };
      await Promise.all(Array.from({ length: Math.min(maxConcurrent, bases.length) }, () => worker()));

      // Sync Proxmox ACLs so users immediately gain/lose access.
      setAp(80, 'Syncing…', `${enable ? 'Granting' : 'Revoking'} Proxmox access…`);
      const sess = readProxCreds(PROJ.id) || {};
      const syncResp = await http('POST', `/api/projects/${PROJ.id}/instances/actions/users_access_sync`, {
        username: sess.username || undefined,
        password: sess.password || undefined,
        baseUrl: PROJ.proxmox_url || undefined,
        apiPort: PROJ.proxmox_api_port || undefined,
        verifySSL: PROJ.proxmox_verify_ssl !== false,
        templates: bases,
        indices,
        enable,
      });

      // Optimistic table update: if no errors, flip the effective User Access indicator immediately.
      try {
        const errCount = Array.isArray(syncResp?.errors) ? syncResp.errors.length : 0;
        if (errCount === 0) {
          _vmOptimisticallyUpdateUserAccessProject(PROJ, bases, indices, enable);
          try { if (isCurrentVmProject(PROJ)) renderVmTable(PROJ); } catch { }
        }
      } catch { }

      setAp(100, 'Done', `Updated ${bases.length} template(s) and synced permissions.`);
      const merged = { ...(syncResp || {}) };
      merged.infos = [...(Array.isArray(syncResp?.infos) ? syncResp.infos : []), ...infos];
      if (skipped.length) merged.skipped = [...(Array.isArray(syncResp?.skipped) ? syncResp.skipped : []), ...skipped];
      try { showActionSummary(prettyAction, merged); } catch { }
    } catch (e) {
      alert('Action failed: ' + (e?.message || e));
      try { showActionSummary(prettyAction, { errors: [{ reason: e?.message || String(e) }] }); } catch { }
    } finally {
      ACTION_IN_FLIGHT = false; CURRENT_ACTION = null; updateRefreshState();
      try { if (topProg) { topProg.classList.add('d-none'); topProg.setAttribute('aria-hidden', 'true'); } } catch { }
      try { hideActionProgress(); } catch { }
      try {
        const forceRefresh = (action === 'nets_set' || action === 'nets_remove' || action === 'nets_assign' || action === 'nets_clear' || action === 'apply_scenario');
        if (isCurrentVmProject(PROJ)) {
          Promise.resolve().then(() => vmRefresh({ forceRefresh, showProgressDialog: false })).catch(() => { });
        }
      } catch { }
    }
    return;
  }

  if (!hasAuthForProject(PROJ)) { alert('Please log in to Proxmox (or configure an API token) to run actions.'); return; }
  // Build targets; for 'create' we must use the base VM name from Configuration (without tag/index suffix)
  let targets = selected.map(entry => ({ index: Number(entry.index), name: entry.name }));
  const sess = readProxCreds(PROJ.id) || {};
  // Show top progress bar for any action
  let topProg = null;
  try { topProg = document.getElementById('vm-progress'); if (topProg) showVmInlineProgress('Preparing…', 5, 'Gathering selection…'); } catch { }
  // Progress indicator helpers funnel into shared queue state
  const setAp = (pct, text, detail) => {
    try { updateVmInlineProgress(pct, text, detail); } catch { }
    try { updateActionProgress(pct, text, detail); } catch { }
  };
  const prettyAction = friendlyActionName(action) || action;
  try { showActionProgress(`${prettyAction} in progress`, 'Gathering selection…'); } catch { }
  setAp(5, 'Preparing…', 'Gathering selection…');
  ACTION_IN_FLIGHT = true;
  CURRENT_ACTION = action;
  ACTION_RUN_ID += 1;
  updateRefreshState();
  try {
    if (action === 'nets_set' || action === 'nets_remove' || action === 'nets_assign' || action === 'nets_clear') {
      // Normalize legacy action keys to the new endpoints.
      const normalizedAction = (action === 'nets_assign') ? 'nets_set' : (action === 'nets_clear' ? 'nets_remove' : action);
      const friendly = friendlyActionName(normalizedAction) || normalizedAction;
      try { shell.beginActionContext(friendly); } catch { }
      const setProg = (pct, text, detail) => setAp(pct, text, detail);
      const sess = readProxCreds(PROJ.id) || {};
      const path = `/api/projects/${PROJ.id}/instances/actions/${normalizedAction}`;
      const startDetail = normalizedAction === 'nets_set' ? 'Setting network interfaces…' : 'Removing network interfaces…';
      const doneWord = normalizedAction === 'nets_set' ? 'Set' : 'Removed';
      setProg(10, 'Preparing…', startDetail);
      try { shell.step('Submitting network action'); } catch { }
      const resp = await http('POST', path, {
        username: sess.username || undefined,
        password: sess.password || undefined,
        baseUrl: PROJ.proxmox_url || undefined,
        apiPort: PROJ.proxmox_api_port || undefined,
        verifySSL: PROJ.proxmox_verify_ssl !== false,
        targets,
      });
      try { shell.step('Network action response'); } catch { }
      // Optimistic table update: if no errors, reflect expected adaptors immediately.
      try {
        const errCount = Array.isArray(resp?.errors) ? resp.errors.length : 0;
        const applyErrCount = Array.isArray(resp?.network_apply_errors) ? resp.network_apply_errors.length : 0;
        if (errCount === 0 && applyErrCount === 0) {
          _vmOptimisticallyUpdateProjectNets(PROJ, targets, normalizedAction === 'nets_remove' ? 'remove' : 'set');
          try { if (isCurrentVmProject(PROJ)) renderVmTable(PROJ); } catch { }
        }
      } catch { }
      const successKey = normalizedAction === 'nets_set' ? 'updated' : 'cleared';
      const successArr = Array.isArray(resp[successKey]) ? resp[successKey] : [];
      const skippedCount = Array.isArray(resp.skipped) ? resp.skipped.length : 0;
      setProg(100, 'Done', `${doneWord} ${successArr.length}/${targets.length}${skippedCount ? ', skipped ' + skippedCount : ''}`);
      try { showActionSummary(friendly, resp || {}); } catch { }
      try { emitActionLogs(friendly, resp || {}); } catch { }
      try { (window.shell && shell.logSuccess) ? shell.logSuccess(`${friendly}: ${successArr.length} VM(s)`) : console.log(friendly, 'done'); } catch { }
      try { shell.endActionContext(true); } catch { }
      return;
    }
    if (action === 'create') {
      const createOptions = normalizeVmCreateOptions(opts.createOptions);
      // Convert generated names back to base config names
      const tag = String(PROJ?.tag || '').trim();
      const baseNames = new Set((PROJ?.vms || []).map(v => v.name));
      targets = targets.map(t => {
        const idxStr = String(t.index);
        const suffix = `${tag}${idxStr}`;
        const full = String(t.name || '');
        let base = full;
        if (suffix && full.endsWith(suffix)) base = full.slice(0, full.length - suffix.length);
        // If suffix stripping didn't yield a known base, try mapping by config expansion
        if (!baseNames.has(base)) {
          for (const v of (PROJ?.vms || [])) {
            if (String(v.name || '') + suffix === full) { base = String(v.name || ''); break; }
          }
        }
        return { index: t.index, name: base };
      });
      // Show progress bar and increment as we go (best effort)
      const setProg = (pct, text, detail) => setAp(pct, text, detail);
      setProg(10, 'Preparing…', 'Preparing targets…');
      // Filter out rows already created based on current table state
      try {
        const statuses = PROJ.instance_statuses || [];
        const byIndex = new Map(statuses.map(s => [Number(s.index || 0), s]));
        const before = targets.length;
        targets = targets.filter(t => {
          const st = byIndex.get(Number(t.index) || 0) || {};
          const fullName = String(t.name || '') + tag + String(t.index);
          const details = Array.isArray(st.vm_details) ? st.vm_details : [];
          return !details.some(d => d && d.name === fullName);
        });
        if (before > targets.length) {
          alert('Some selected VM(s) already exist and will be skipped.');
        }
      } catch { }
      const total = targets.length;
      let createdCount = 0;
      let skippedCount = 0;
      // Batch once to server (server orchestrates each target), handle ambiguous response by prompting
      const retryBaseBody = {
        username: sess.username || undefined,
        password: sess.password || undefined,
        baseUrl: PROJ.proxmox_url || undefined,
        apiPort: PROJ.proxmox_api_port || undefined,
        verifySSL: PROJ.proxmox_verify_ssl !== false,
        applyScenario: false,
        syncUserAccess: false,
        setNetworkInterfaces: createOptions.setNetworkInterfaces,
        takeSnapshot: createOptions.takeSnapshot,
      };
      const makeRequest = async () => {
        try { shell.step('Submitting create batch'); } catch { }
        const requestPromise = http('POST', `/api/projects/${PROJ.id}/instances/actions/create`, { ...retryBaseBody, targets });
        let stopStatusPoll = null;
        if (typeof startVmActionStatusPolling === 'function') {
          try { stopStatusPoll = startVmActionStatusPolling(PROJ.id, { setProgress: setProg, initialDelay: 200 }); } catch { }
        }
        try {
          const r = await requestPromise;
          try { shell.step('Create batch response received'); } catch { }
          return r;
        } finally {
          if (typeof stopStatusPoll === 'function') {
            try { stopStatusPoll(); } catch { }
          }
        }
      };
      // Preflight: resolve ALL ambiguities before cloning begins (loop until none remain)
      try {
        let guard = 0;
        for (; ;) {
          if (guard++ > 5) break; // safety cap
          setProg(20, 'Checking templates…', 'Scanning for ambiguous template names…');
          try { shell.step('Preflight request'); } catch { }
          const pre = await http('POST', `/api/projects/${PROJ.id}/instances/actions/create-preflight`, {
            username: sess.username || undefined,
            password: sess.password || undefined,
            baseUrl: PROJ.proxmox_url || undefined,
            apiPort: PROJ.proxmox_api_port || undefined,
            verifySSL: PROJ.proxmox_verify_ssl !== false,
            targets,
          });
          try { shell.step('Preflight response'); } catch { }
          const amb0 = Array.isArray(pre?.ambiguous) ? pre.ambiguous : [];
          if (!amb0.length) break;
          // Group by base and union candidates
          const group0 = new Map();
          for (const entry of amb0) {
            const baseName = String(entry?.name || '');
            const list = Array.isArray(entry?.candidates) ? entry.candidates : [];
            if (!group0.has(baseName)) group0.set(baseName, new Map());
            const seen = group0.get(baseName);
            for (const c of list) {
              const vmid = (c && (c.vmid ?? c.id));
              if (vmid === undefined || vmid === null || vmid === '') continue;
              const node = (c && (c.node ?? c.nodename ?? c.nodeName)) || '';
              const key = `${vmid}@@${node}`;
              if (!seen.has(key)) seen.set(key, { vmid, node });
            }
          }
          for (const [baseName, map] of group0.entries()) {
            await showTemplateResolveDialog(baseName, Array.from(map.values()), PROJ);
          }
          // Loop and re-check until no ambiguous remain
        }
      } catch (e) {
        // Non-fatal: proceed; server-side early check will still prevent cloning if ambiguities remain
      }
      let lastResp = null;
      try {
        setProg(35, 'Cloning…', `Cloning ${targets.length} template(s)…`);
        const resp = await makeRequest();
        lastResp = resp;
        createdCount = Array.isArray(resp.created) ? resp.created.length : 0;
        skippedCount = Array.isArray(resp.skipped) ? resp.skipped.length : 0;
        // Handle ambiguous entries if present: prompt once per base template (deduplicated) and retry once
        const amb = Array.isArray(resp.ambiguous) ? resp.ambiguous : [];
        if (amb.length > 0) {
          // Group by baseName and union candidates
          const group = new Map();
          for (const entry of amb) {
            const baseName = String(entry?.name || '');
            const list = Array.isArray(entry?.candidates) ? entry.candidates : [];
            if (!group.has(baseName)) group.set(baseName, new Map());
            const seen = group.get(baseName);
            for (const c of list) {
              const vmid = (c && (c.vmid ?? c.id))
                ;
              if (vmid === undefined || vmid === null || vmid === '') continue;
              const node = (c && (c.node ?? c.nodename ?? c.nodeName)) || '';
              // key by vmid+node to avoid duplicates
              const key = `${vmid}@@${node}`;
              if (!seen.has(key)) seen.set(key, { vmid, node });
            }
          }
          // Show one dialog per base
          for (const [baseName, map] of group.entries()) {
            await showTemplateResolveDialog(baseName, Array.from(map.values()), PROJ);
          }
          const resp2 = await makeRequest();
          lastResp = resp2 || resp;
          createdCount = Array.isArray(lastResp.created) ? lastResp.created.length : createdCount;
          skippedCount = Array.isArray(lastResp.skipped) ? lastResp.skipped.length : skippedCount;
        }
        setProg(90, `Finalizing…`, `${buildVmCreateFinalizeDetail(createOptions)}…`);
      } catch (e) {
        // Unexpected error: surface and abort create handler
        throw e;
      }
      const retryOutcome = await maybeRetryVerifiedVmAction({
        proj: PROJ,
        action,
        resp: lastResp || {},
        requestPath: `/api/projects/${PROJ.id}/instances/actions/create`,
        requestBody: retryBaseBody,
        setProgress: setProg,
      });
      lastResp = retryOutcome.resp;
      createdCount = Array.isArray(lastResp?.created) ? lastResp.created.length : 0;
      skippedCount = Array.isArray(lastResp?.skipped) ? lastResp.skipped.length : skippedCount;
      const verifiedCount = Number(retryOutcome?.verifiedCount || 0);
      lastResp = await runVmCreateFollowUpActions({
        proj: PROJ,
        targets: selected,
        baseBody: retryBaseBody,
        createOptions,
        setProgress: setProg,
        contextLabel: PROJ?.name || PROJ?.id || '',
        summaryResp: lastResp || {},
      });
      const verifiedSuffix = verifiedCount ? `, verified ${verifiedCount}` : '';
      setProg(100, 'Done', `Created ${createdCount + verifiedCount}/${total}${verifiedSuffix}${skippedCount ? ', skipped ' + skippedCount : ''}`);
      try { showActionSummary('Create', lastResp || {}); } catch { }
      try { emitActionLogs('Create', lastResp || {}); } catch { }
      try { (window.shell && shell.logSuccess) ? shell.logSuccess(`Create: ${createdCount + verifiedCount} VM(s)`) : console.log('Create done'); } catch { }
      try { shell.endActionContext(true); } catch { }
      return;
    }
    if (action === 'users_create' || action === 'users_delete' || action === 'users_perms' || action === 'users_creds_check' || action === 'users_creds_set') {
      const actionTitle = friendlyActionName(action) || action;
      try { shell.beginActionContext(actionTitle); } catch { }
      const setProg = (pct, text, detail) => setAp(pct, text, detail);
      const actionVerb = action === 'users_create'
        ? 'Creating'
        : (action === 'users_delete'
          ? 'Deleting'
          : (action === 'users_creds_check' ? 'Checking' : (action === 'users_creds_set' ? 'Syncing' : 'Updating')));
      setProg(10, 'Preparing…', `${actionVerb} user/pool state…`);
      const sess = readProxCreds(PROJ.id) || {};
      // Reuse precomputed targets from the current selection
      try { shell.step('Submitting user action'); } catch { }
      const resp = await http('POST', `/api/projects/${PROJ.id}/instances/actions/${action}`, {
        username: sess.username || undefined,
        password: sess.password || undefined,
        baseUrl: PROJ.proxmox_url || undefined,
        apiPort: PROJ.proxmox_api_port || undefined,
        verifySSL: PROJ.proxmox_verify_ssl !== false,
        targets,
      });
      try { shell.step('User action response'); } catch { }
      const checkedCount = Array.isArray(resp?.checked) ? resp.checked.length : 0;
      const driftCount = Array.isArray(resp?.checked) ? resp.checked.filter(item => String(item?.status || '') !== 'ok').length : 0;
      const syncedCount = (Array.isArray(resp?.created_users) ? resp.created_users.length : 0) + (Array.isArray(resp?.updated_users) ? resp.updated_users.length : 0);
      const doneText = action === 'users_create'
        ? 'Created/updated user/pool'
        : (action === 'users_delete'
          ? 'Deleted user/pool'
          : (action === 'users_creds_check'
            ? `Checked ${checkedCount} row(s)${driftCount ? `, ${driftCount} drift` : ''}`
            : (action === 'users_creds_set'
              ? `Synced ${syncedCount} user row(s)`
              : 'Updated user/pool')));
      setProg(100, 'Done', doneText);
      try { showActionSummary(actionTitle, resp || {}); } catch { }
      try { emitActionLogs(actionTitle, resp || {}); } catch { }
      try { shell.endActionContext(true); } catch { }
      return;
    }
    if (action === 'start' || action === 'unlock' || action === 'suspend' || action === 'poweroff' || action === 'snapshot' || action === 'restore' || action === 'run_startup_cmds' || action === 'run_stored_cmds' || action === 'validate' || action === 'apply_scenario') {
      try { shell.beginActionContext(action.charAt(0).toUpperCase() + action.slice(1)); } catch { }
      try { (window.shell && shell.logInfo) ? shell.logInfo(`Action: ${action} on ${targets.length} target(s)`) : console.log('Action', action, 'on', targets); } catch { }
      const setProg = (pct, text, detail) => setAp(pct, text, detail);
      const verbMap = {
        start: ['Starting…', 'Starting', 'Started'],
        unlock: ['Unlocking…', 'Unlocking', 'Unlocked'],
        suspend: ['Suspending…', 'Suspending', 'Suspended'],
        poweroff: ['Powering off…', 'Powering off', 'Powered off'],
        snapshot: ['Snapshotting…', 'Taking snapshot(s)', 'Snapshot(s) taken'],
        restore: ['Restoring…', 'Restoring snapshot(s)', 'Restored'],
        run_startup_cmds: ['Running…', 'Running startup commands', 'Ran startup cmds'],
        run_stored_cmds: ['Running…', 'Running stored commands', 'Ran stored cmds'],
        validate: ['Validating…', 'Running validation checks', 'Validated'],
        apply_scenario: ['Applying…', 'Applying scenario notes', 'Applied scenario notes']
      };
      const [shortStart, longStart, pastTense] = verbMap[action] || ['Working…', 'Working', 'Done'];
      let validateSkipped = [];
      if (action === 'validate') {
        const split = filterRunningTargetsForProject(PROJ, targets);
        targets = split.running;
        validateSkipped = split.skipped;
        if (!targets.length) {
          const prefiltered = { ran: [], skipped: validateSkipped, errors: [] };
          try { showActionSummary('Validate', prefiltered); } catch { }
          try { emitActionLogs('Validate', prefiltered); } catch { }
          try { (window.shell && shell.logWarn) ? shell.logWarn('Validate skipped: no selected VMs are currently running') : console.warn('Validate skipped: no running VMs'); } catch { }
          try { shell.endActionContext(true); } catch { }
          return;
        }
      }
      setProg(10, 'Preparing…', `${longStart} for ${targets.length} VM(s)…`);
      // No snapshot/restore prompt: handled server-side (timestamp name; restore latest)
      const actionPathName = action === 'validate' ? 'run_stored_cmds' : action;
      const path = `/api/projects/${PROJ.id}/instances/actions/${actionPathName}`;
      try { shell.step('Submitting action'); } catch { }
      const payload = {
        username: sess.username || undefined,
        password: sess.password || undefined,
        baseUrl: PROJ.proxmox_url || undefined,
        apiPort: PROJ.proxmox_api_port || undefined,
        verifySSL: PROJ.proxmox_verify_ssl !== false,
        targets,
      };
      if (action === 'validate') {
        payload.validateOnly = true;
      }
      if (Array.isArray(opts.selectedCommands) && opts.selectedCommands.length) {
        payload.commands = opts.selectedCommands.slice();
        if (opts.selectedCommands.length === 1) {
          payload.command = opts.selectedCommands[0];
        }
      } else if (opts.selectedCommand) {
        payload.command = opts.selectedCommand;
      }
      if (Array.isArray(opts.storedCommandOverrides) && opts.storedCommandOverrides.length) {
        payload.storedCommandOverrides = opts.storedCommandOverrides.map(entry => ({
          templateKey: entry.templateKey || '',
          stepIndex: entry.stepIndex,
          commandIndex: entry.commandIndex,
          text: entry.text,
        }));
      }
      const requestPromise = http('POST', path, payload);
      const shouldPollDetail = vmActionShouldPollStatus(action);
      let stopStatusPoll = null;
      if (shouldPollDetail && typeof startVmActionStatusPolling === 'function') {
        try { stopStatusPoll = startVmActionStatusPolling(PROJ.id, { setProgress: setProg, initialDelay: 200 }); } catch { }
      }
      let resp;
      try {
        resp = await requestPromise;
      } finally {
        if (typeof stopStatusPoll === 'function') {
          try { stopStatusPoll(); } catch { }
        }
      }
      try { shell.step('Action response'); } catch { }
      const retryBody = { ...payload };
      delete retryBody.targets;
      const retryOutcome = await maybeRetryVerifiedVmAction({
        proj: PROJ,
        action,
        resp,
        requestPath: path,
        requestBody: retryBody,
        setProgress: setProg,
      });
      resp = retryOutcome.resp;
      if (validateSkipped.length) {
        const existingSkipped = Array.isArray(resp?.skipped) ? resp.skipped : [];
        resp.skipped = [...validateSkipped, ...existingSkipped];
      }
      const verifiedCount = Number(retryOutcome?.verifiedCount || 0);
      // Determine counts based on action response keys
      const keyMap = { start: 'started', unlock: 'unlocked', suspend: 'suspended', poweroff: 'powered_off', snapshot: 'snapshotted', restore: 'restored', run_startup_cmds: 'ran', run_stored_cmds: 'ran', validate: 'ran', apply_scenario: 'applied' };
      const k = keyMap[action];
      let doneArr = Array.isArray(resp[k]) ? resp[k] : [];
      if (action === 'start') {
        const total = targets.length;
        const skippedCount = Array.isArray(resp.skipped) ? resp.skipped.length : 0;
        const startedCount = doneArr.length;
        const resumedCount = Array.isArray(resp.resumed) ? resp.resumed.length : 0;
        const completedCount = startedCount + resumedCount + verifiedCount;
        const breakdown = [];
        if (resumedCount > 0 || verifiedCount > 0) {
          if (startedCount) breakdown.push(`${startedCount} started`);
          if (resumedCount) breakdown.push(`${resumedCount} resumed`);
          if (verifiedCount) breakdown.push(`${verifiedCount} verified`);
        }
        const detailSuffix = breakdown.length ? ` (${breakdown.join(', ')})` : '';
        const verb = resumedCount > 0 ? 'Started or resumed' : 'Started';
        setProg(100, 'Done', `${verb} ${completedCount} / ${total}${skippedCount ? ', skipped ' + skippedCount : ''}${detailSuffix}`);
        try { showActionSummary('Start', resp || {}); } catch { }
        try { emitActionLogs('Start', resp || {}); } catch { }
        try { (window.shell && shell.logSuccess) ? shell.logSuccess(`Start/Resume: ${completedCount} VM(s)`) : console.log('Start done'); } catch { }
        try { shell.endActionContext(true); } catch { }
        return;
      }
      const skippedCount = Array.isArray(resp.skipped) ? resp.skipped.length : 0;
      const total = targets.length;
      const verifiedSuffix = verifiedCount ? `, verified ${verifiedCount}` : '';
      setProg(100, 'Done', `${pastTense} ${doneArr.length + verifiedCount}/${total}${verifiedSuffix}${skippedCount ? ', skipped ' + skippedCount : ''}`);
      try { showActionSummary(action.charAt(0).toUpperCase() + action.slice(1), resp || {}); } catch { }
      try { emitActionLogs(action.charAt(0).toUpperCase() + action.slice(1), resp || {}); } catch { }
      try { (window.shell && shell.logSuccess) ? shell.logSuccess(`${action}: ${doneArr.length + verifiedCount} VM(s)`) : console.log(action, 'done'); } catch { }
      try { shell.endActionContext(true); } catch { }
      if (action === 'validate') {
        const { failed: vFailed, backends: vBackends } = vmBuildRestartTargetsForFailedValidation(PROJ, doneArr);
        if (vFailed.length > 0) {
          await vmMaybeRestartFailedValidation([{ proj: PROJ, failed: vFailed, backends: vBackends }]);
        }
      }
      return;
    }
    if (action === 'delete') {
      const deleteOptions = normalizeVmDeleteOptions(opts.deleteOptions);
      try { shell.beginActionContext('Instances Delete'); } catch { }
      try { (window.shell && shell.logInfo) ? shell.logInfo(`Action: delete on ${targets.length} target(s)`) : console.log('Action delete on', targets); } catch { }
      // Normalize names to base and then compute generated names for pre-check
      const tag = String(PROJ?.tag || '').trim();
      const baseNames = new Set((PROJ?.vms || []).map(v => v.name));
      const toSend = targets.map(t => {
        const idxStr = String(t.index);
        const suffix = `${tag}${idxStr}`;
        const full = String(t.name || '');
        let base = full;
        if (suffix && full.endsWith(suffix)) base = full.slice(0, full.length - suffix.length);
        if (!baseNames.has(base)) {
          for (const v of (PROJ?.vms || [])) {
            if (String(v.name || '') + suffix === full) { base = String(v.name || ''); break; }
          }
        }
        return { index: t.index, name: base };
      });
      // Use the same progress bar area as Create
      const setProg = (pct, text, detail) => setAp(pct, text, detail);
      setProg(10, 'Preparing…', 'Preparing delete…');
      // Client-side filter: only keep those that currently exist
      try {
        const statuses = PROJ.instance_statuses || [];
        const byIndex = new Map(statuses.map(s => [Number(s.index || 0), s]));
        const before = toSend.length;
        const exist = toSend.filter(t => {
          const st = byIndex.get(Number(t.index) || 0) || {};
          const fullName = String(t.name || '') + tag + String(t.index);
          const details = Array.isArray(st.vm_details) ? st.vm_details : [];
          return details.some(d => d && d.name === fullName);
        });
        if (exist.length !== before) {
          alert('Some selected VM(s) do not exist and will be skipped.');
        }
        targets = exist;
      } catch { }
      const total = targets.length;
      let deletedCount = 0;
      let skippedCount = 0;
      if (total === 0) {
        alert('No existing VMs found among the selection.');
        return;
      }
      setProg(25, 'Deleting…', `Deleting ${targets.length} VM(s)…`);
      try { shell.step('Submitting delete'); } catch { }
      const retryBaseBody = {
        username: sess.username || undefined,
        password: sess.password || undefined,
        baseUrl: PROJ.proxmox_url || undefined,
        apiPort: PROJ.proxmox_api_port || undefined,
        verifySSL: PROJ.proxmox_verify_ssl !== false,
      };
      let preDeleteResp = {};
      if (deleteOptions.disableUserAccessibility) {
        preDeleteResp = await runVmDeleteFollowUpActions({
          proj: PROJ,
          targets,
          baseBody: retryBaseBody,
          deleteOptions,
          setProgress: setProg,
          contextLabel: PROJ?.name || '',
          summaryResp: {},
        });
      }
      const requestPromise = http('POST', `/api/projects/${PROJ.id}/instances/actions/delete`, {
        ...retryBaseBody,
        deleteUsersAndPools: deleteOptions.deleteUsersAndPools,
        verifyCleanup: deleteOptions.verifyCleanup,
        targets,
      });
      let stopStatusPoll = null;
      if (vmActionShouldPollStatus(action) && typeof startVmActionStatusPolling === 'function') {
        try { stopStatusPoll = startVmActionStatusPolling(PROJ.id, { setProgress: setProg, initialDelay: 200 }); } catch { }
      }
      let resp;
      try {
        resp = await requestPromise;
      } finally {
        if (typeof stopStatusPoll === 'function') {
          try { stopStatusPoll(); } catch { }
        }
      }
      try { shell.step('Delete response'); } catch { }
      const retryOutcome = await maybeRetryVerifiedVmAction({
        proj: PROJ,
        action,
        resp,
        requestPath: `/api/projects/${PROJ.id}/instances/actions/delete`,
        requestBody: retryBaseBody,
        setProgress: setProg,
      });
      resp = retryOutcome.resp;
      resp = mergeVmActionSummaryData(preDeleteResp, resp);
      deletedCount = Array.isArray(resp.deleted) ? resp.deleted.length : 0;
      skippedCount = Array.isArray(resp.skipped) ? resp.skipped.length : 0;
      const verifiedCount = Number(retryOutcome?.verifiedCount || 0);
      const verifiedSuffix = verifiedCount ? `, verified ${verifiedCount}` : '';
      setProg(100, 'Done', `Deleted ${deletedCount + verifiedCount}/${total}${verifiedSuffix}${skippedCount ? ', skipped ' + skippedCount : ''}`);
      try { showActionSummary('Delete', resp || {}); } catch { }
      try { emitActionLogs('Delete', resp || {}); } catch { }
      try { (window.shell && shell.logSuccess) ? shell.logSuccess(`Delete: ${deletedCount + verifiedCount} VM(s)`) : console.log('Delete done'); } catch { }
      try { shell.endActionContext(true); } catch { }
      return;
    }
    alert('Action not implemented yet: ' + action);
  } catch (e) {
    alert('Action failed: ' + e.message);
    try { (window.shell && shell.logError) ? shell.logError('Action failed: ' + e.message) : console.error('Action failed:', e); } catch { }
    try { shell.endActionContext(false); } catch { }
  } finally {
    // Mark action as completed before any UI callbacks may fire
    ACTION_IN_FLIGHT = false; CURRENT_ACTION = null; updateRefreshState();
    // Proactively hide/suppress any lingering template resolve modal/backdrops
    try {
      const modalEl = document.getElementById('tmplResolveModal');
      if (modalEl && modalEl.classList.contains('show') && window.bootstrap && window.bootstrap.Modal) {
        const inst = bootstrap.Modal.getOrCreateInstance(modalEl);
        inst.hide();
      }
      // Clear stray backdrops if any
      document.querySelectorAll('.modal-backdrop').forEach(el => { try { el.remove(); } catch { } });
    } catch { }
    // Hide top progress bar and progress modal promptly
    try { if (topProg) { topProg.classList.add('d-none'); topProg.setAttribute('aria-hidden', 'true'); } } catch { }
    try { hideActionProgress(); } catch { }
    // Always refresh after any action (even on failure) but do not block UI while pending
    try {
      const forceRefresh = (action === 'nets_set' || action === 'nets_remove' || action === 'nets_assign' || action === 'nets_clear' || action === 'apply_scenario');
      if (isCurrentVmProject(PROJ)) {
        Promise.resolve().then(() => vmRefresh({ forceRefresh, showProgressDialog: false })).catch(() => { });
      }
    } catch { }
  }
}

// Multi-project action orchestrator (queued wrapper)
async function vmActionMulti(action, opts) {
  const options = opts ? { ...opts } : {};
  if (action === 'run_stored_cmds') {
    const initial = interpretStoredCommandSelection(options.selectedCommands || options.selectedCommand);
    let selectedCommands = initial.commands;
    let overridePayload = initial.overrides || coerceStoredCommandOverrides(options.storedCommandOverrides);
    if (!selectedCommands.length) {
      const picked = await promptStoredCommandSelection();
      const interpreted = interpretStoredCommandSelection(picked);
      selectedCommands = interpreted.commands;
      overridePayload = interpreted.overrides || null;
      if (!selectedCommands.length) return;
    }
    options.selectedCommands = selectedCommands;
    if (overridePayload && overridePayload.length) {
      options.storedCommandOverrides = overridePayload;
    } else {
      delete options.storedCommandOverrides;
    }
  }
  const selCount = listSelectedEntries().length;
  const labelName = friendlyActionName(action) || action;
  const commandSuffix = (() => {
    const cmds = Array.isArray(options.selectedCommands) ? options.selectedCommands : [];
    if (!cmds.length) return '';
    if (cmds.length === 1) return ` — ${cmds[0]}`;
    return ` — ${cmds.length} cmds`;
  })();
  const label = `Multi ${labelName}${commandSuffix} (${selCount || 0} item${(selCount || 0) === 1 ? '' : 's'})`;
  await runQueued(label, async () => { await vmActionMultiExec(action, options); }, { projectId: PROJ?.id });
}

// Original implementation moved to vmActionMultiExec
async function vmActionMultiExec(action, opts = {}) {
  const selected = (() => {
    if (opts.targetsByPid && typeof opts.targetsByPid === 'object') {
      const out = [];
      Object.entries(opts.targetsByPid).forEach(([pid, arr]) => {
        (Array.isArray(arr) ? arr : []).forEach(entry => {
          const index = Number(entry?.index);
          const name = String(entry?.name || '');
          if (!pid || !Number.isFinite(index) || !name) return;
          out.push({ pid, pidCanonical: canonicalPid(pid), index, name });
        });
      });
      return out;
    }
    return listSelectedEntries();
  })();
  if (!selected.length) { alert('Select at least one VM row.'); return; }
  // Group selections by project id
  const byPid = new Map();
  for (const entry of selected) {
    if (!entry.pid || !Number.isFinite(entry.index) || !entry.name) continue;
    if (!byPid.has(entry.pid)) byPid.set(entry.pid, []);
    byPid.get(entry.pid).push({ index: Number(entry.index), name: entry.name });
  }
  if (byPid.size === 0) { alert('No valid selections.'); return; }
  // Validate auth for actions.
  for (const pid of byPid.keys()) {
    if (!hasAuthForPid(pid)) {
      alert('Some selected projects are missing Proxmox credentials or token. Fix credentials and try again.');
      return;
    }
  }
  // Progress indicator routed through shared helpers
  const friendly = friendlyActionName(action) || action;
  const setAp = (pct, text, detail) => {
    try { updateVmInlineProgress(pct, text, detail); } catch { }
    try { updateActionProgress(pct, text, detail); } catch { }
  };
  try {
    showActionProgress(`Multi ${friendly}`, 'Preparing selections…');
    setAp(10, 'Preparing…', 'Collecting project selections…');
  } catch { }
  ACTION_IN_FLIGHT = true; CURRENT_ACTION = action; ACTION_RUN_ID += 1; updateRefreshState();
  // Aggregate results across projects
  const agg = {};
  const initialCommands = Array.isArray(opts.selectedCommands)
    ? normalizeSelectedCommands(opts.selectedCommands)
    : normalizeSelectedCommands(opts.selectedCommand);
  if (initialCommands.length) {
    agg.requested_commands = initialCommands.slice();
  } else if (opts.selectedCommand) {
    agg.requested_command = opts.selectedCommand;
  }
  const mergeRequestedCommands = (list) => {
    const normalized = normalizeSelectedCommands(list);
    if (!normalized.length) return;
    const existing = new Set(Array.isArray(agg.requested_commands) ? agg.requested_commands : []);
    normalized.forEach(cmd => existing.add(cmd));
    agg.requested_commands = Array.from(existing);
  };
  const addArr = (key, arr, project) => {
    if (!Array.isArray(arr) || arr.length === 0) return;
    if (!Array.isArray(agg[key])) agg[key] = [];
    for (const it of arr) {
      const clone = (it && typeof it === 'object') ? { ...it } : { name: String(it || '') };
      if (clone && clone.name) clone.name = `[${project}] ${clone.name}`;
      if (clone && !clone.project) clone.project = project;
      agg[key].push(clone);
    }
  };
  const pids = Array.from(byPid.keys());
  const totalProjects = pids.length;
  let doneProjects = 0;
  const topProg = document.getElementById('vm-progress');
  try { if (topProg) showVmInlineProgress('Preparing…', 5, 'Collecting project selections…'); } catch { }
  try { (window.shell && shell.logInfo) ? shell.logInfo(`Multi action ${friendlyActionName(action) || action} across ${totalProjects} project(s)`) : console.log('Multi action', action); } catch { }
  // Fetch latest projects list to ensure data
  try { const d = await http('GET', '/api/projects'); ALL_PROJECTS = d.projects || ALL_PROJECTS; } catch { }
  const byId = {}; (ALL_PROJECTS || []).forEach(p => { const key = canonicalPid(p.id); if (key) byId[key] = p; });

  // Fast-path: user accessibility actions can be safely parallelized across projects (limited concurrency)
  if (action === 'users_access_enable' || action === 'users_access_disable') {
    const enable = action === 'users_access_enable';
    const accessPlanByPid = new Map();
    const maxProjConcurrent = Math.min(3, totalProjects);
    const queue = pids.slice();
    const runProject = async () => {
      for (; ;) {
        const pid = queue.shift();
        if (!pid) return;
        const key = canonicalPid(pid);
        const proj = byId[key];
        if (!proj) {
          doneProjects++;
          continue;
        }
        const projName = String(proj.name || pid);
        const sess = readProxCreds(pid) || {};
        const baseBody = { username: sess.username || undefined, password: sess.password || undefined, baseUrl: proj.proxmox_url || undefined, apiPort: proj.proxmox_api_port || undefined, verifySSL: proj.proxmox_verify_ssl !== false };

        let targets = (byPid.get(pid) || []).map(t => ({ index: Number(t.index), name: String(t.name) }));
        const tagLocal = String(proj.tag || '').trim();
        const baseNameSet = new Set((proj.vms || []).map(v => String(v.name || '')));
        const toBaseLocal = (t) => {
          const idxStr = String(t.index);
          const suffix = `${tagLocal}${idxStr}`;
          const full = String(t.name || '');
          let base = full;
          if (suffix && full.endsWith(suffix)) base = full.slice(0, full.length - suffix.length);
          if (!baseNameSet.has(base)) {
            for (const v of (proj.vms || [])) {
              if (String(v.name || '') + suffix === full) { base = String(v.name || ''); break; }
            }
          }
          return base;
        };

        const unique = new Set();
        const idxSet = new Set();
        const skippedLocal = [];
        for (const t of targets) {
          try { idxSet.add(Number(t.index)); } catch { }
          const base = toBaseLocal(t);
          if (!base || !baseNameSet.has(base)) {
            skippedLocal.push({ name: String(t.name || ''), reason: 'template not found in project configuration' });
            continue;
          }
          unique.add(base);
        }
        const bases = Array.from(unique);
        const indices = Array.from(idxSet).filter(n => Number.isFinite(n) && n > 0);
        try { accessPlanByPid.set(pid, { bases: bases.slice(), indices: indices.slice() }); } catch { }

        const pct0 = Math.round((doneProjects / totalProjects) * 100);
        setAp(Math.max(10, pct0), 'Working…', `${enable ? 'Enabling' : 'Disabling'} in ${projName}…`);

        const infos = [];
        const makeReq = async (path, body) => http('POST', `/api/projects/${encodeURIComponent(pid)}${path}`, body);
        try {
          if (bases.length) {
            const maxConcurrent = 4;
            let completed = 0;
            const bq = bases.slice();
            const worker = async () => {
              for (; ;) {
                const base = bq.shift();
                if (!base) return;
                await http('PATCH', `/api/projects/${encodeURIComponent(pid)}/vms/${encodeURIComponent(base)}`, { viewable_to_user: enable });
                try {
                  const vmCfg = (proj?.vms || []).find(v => String(v?.name || '') === base);
                  if (vmCfg) vmCfg.viewable_to_user = enable;
                } catch { }
                completed += 1;
                infos.push({ name: base, reason: `set viewable_to_user=${enable ? 'true' : 'false'}` });
              }
            };
            await Promise.all(Array.from({ length: Math.min(maxConcurrent, bases.length) }, () => worker()));
          }

          // Sync Proxmox ACLs
          const syncResp = await makeReq('/instances/actions/users_access_sync', { ...baseBody, templates: bases, indices, enable });
          addArr('applied', syncResp?.applied, projName);
          addArr('unchanged', syncResp?.unchanged, projName);
          addArr('errors', syncResp?.errors, projName);
          addArr('skipped', syncResp?.skipped, projName);
          addArr('infos', syncResp?.infos, projName);
          addArr('infos', infos, projName);
          addArr('skipped', skippedLocal, projName);
        } catch (e) {
          addArr('errors', [{ reason: e?.message || String(e) }], projName);
        } finally {
          doneProjects += 1;
          const pct = Math.round((doneProjects / totalProjects) * 100);
          setAp(Math.max(10, pct), 'Working…', `Completed ${doneProjects}/${totalProjects}: ${projName}`);
        }
      }
    };

    await Promise.all(Array.from({ length: maxProjConcurrent }, () => runProject()));

    // Optimistic table update: if no errors, flip User Access indicators immediately.
    try {
      const errCount = Array.isArray(agg?.errors) ? agg.errors.length : 0;
      if (errCount === 0) {
        _vmOptimisticallyUpdateMergedUserAccess(byId, accessPlanByPid, enable);
        try {
          if (Array.isArray(window.__MERGED_ROWS__)) renderMergedVmTable(window.__MERGED_ROWS__ || []);
          else renderVmTable(PROJ);
        } catch { }
      }
    } catch { }

    try { showActionSummary(`Multi ${friendly}`, agg || {}); } catch { }
    try { emitActionLogs(`Multi ${friendly}`, agg || {}); } catch { }
    try { shell.endActionContext(true); } catch { }
    ACTION_IN_FLIGHT = false; CURRENT_ACTION = null; updateRefreshState();
    try { if (topProg) { topProg.classList.add('d-none'); topProg.setAttribute('aria-hidden', 'true'); } } catch { }
    try { hideActionProgress(); } catch { }
    try {
      const forceRefresh = (action === 'nets_set' || action === 'nets_remove' || action === 'nets_assign' || action === 'nets_clear' || action === 'apply_scenario');
      Promise.resolve().then(() => vmRefresh({ forceRefresh, showProgressDialog: false })).catch(() => { });
    } catch { }
    return;
  }

  // Iterate projects sequentially to keep UI manageable
  const validateRestartPlan = [];
  for (const pid of pids) {
    const key = canonicalPid(pid);
    const proj = byId[key]; if (!proj) continue;
    const projName = String(proj.name || pid);
    doneProjects++;
    const pct = Math.round((doneProjects - 1) / totalProjects * 100);
    setAp(Math.max(5, pct), 'Working…', `Project ${doneProjects}/${totalProjects}: ${projName}`);
    try { (window.shell && shell.logInfo) ? shell.logInfo(`${action}: ${projName}`) : console.log(action, projName); } catch { }
    const sess = readProxCreds(pid) || {};
    const baseBody = { username: sess.username || undefined, password: sess.password || undefined, baseUrl: proj.proxmox_url || undefined, apiPort: proj.proxmox_api_port || undefined, verifySSL: proj.proxmox_verify_ssl !== false };
    if (Array.isArray(opts.selectedCommands) && opts.selectedCommands.length) {
      baseBody.commands = opts.selectedCommands.slice();
      if (opts.selectedCommands.length === 1) {
        baseBody.command = opts.selectedCommands[0];
      }
    } else if (opts.selectedCommand) {
      baseBody.command = opts.selectedCommand;
    }
    if (Array.isArray(opts.storedCommandOverrides) && opts.storedCommandOverrides.length) {
      baseBody.storedCommandOverrides = opts.storedCommandOverrides.map(entry => ({
        templateKey: entry.templateKey || '',
        stepIndex: entry.stepIndex,
        commandIndex: entry.commandIndex,
        text: entry.text,
      }));
    }
    let targets = (byPid.get(pid) || []).map(t => ({ index: Number(t.index), name: String(t.name) }));
    // For create/delete: convert to base names per project config
    const tag = String(proj.tag || '').trim();
    const baseNames = new Set((proj.vms || []).map(v => String(v.name)));
    const toBase = (t) => {
      const idxStr = String(t.index);
      const suffix = `${tag}${idxStr}`;
      const full = String(t.name || '');
      let base = full;
      if (suffix && full.endsWith(suffix)) base = full.slice(0, full.length - suffix.length);
      if (!baseNames.has(base)) {
        for (const v of (proj.vms || [])) {
          if (String(v.name || '') + suffix === full) { base = String(v.name || ''); break; }
        }
      }
      return { index: t.index, name: base };
    };
    // Pre-checks for create/delete using merged rows detail when available
    const canonicalPidValue = canonicalPid(pid);
    const selectedRowsForPid = (window.__MERGED_ROWS__ || []).filter(r => canonicalPid(r.pid) === canonicalPidValue);
    const detailMapByIndex = new Map();
    try {
      for (const r of selectedRowsForPid) { const key = `${r.index}|${r.vmName}`; detailMapByIndex.set(key, r.detail || null); }
    } catch { }
    const makeReq = async (path, body) => http('POST', `/api/projects/${encodeURIComponent(pid)}${path}`, body);
    try {
      if (action === 'users_access_enable' || action === 'users_access_disable') {
        const enable = action === 'users_access_enable';
        const tagLocal = String(proj.tag || '').trim();
        const baseNameSet = new Set((proj.vms || []).map(v => String(v.name || '')));
        const toBaseLocal = (t) => {
          const idxStr = String(t.index);
          const suffix = `${tagLocal}${idxStr}`;
          const full = String(t.name || '');
          let base = full;
          if (suffix && full.endsWith(suffix)) base = full.slice(0, full.length - suffix.length);
          if (!baseNameSet.has(base)) {
            for (const v of (proj.vms || [])) {
              if (String(v.name || '') + suffix === full) { base = String(v.name || ''); break; }
            }
          }
          return base;
        };
        const unique = new Set();
        const idxSet = new Set();
        const skippedLocal = [];
        for (const t of targets) {
          try { idxSet.add(Number(t.index)); } catch { }
          const base = toBaseLocal(t);
          if (!base || !baseNameSet.has(base)) {
            skippedLocal.push({ name: String(t.name || ''), reason: 'template not found in project configuration' });
            continue;
          }
          unique.add(base);
        }
        const bases = Array.from(unique);
        const indices = Array.from(idxSet).filter(n => Number.isFinite(n) && n > 0);
        setAp(Math.max(20, pct), 'Working…', `${enable ? 'Enabling' : 'Disabling'} user accessibility in ${projName}…`);
        const infos = [];
        const maxConcurrent = 4;
        let completed = 0;
        const queue = bases.slice();
        const worker = async () => {
          for (; ;) {
            const base = queue.shift();
            if (!base) return;
            setAp(Math.max(20, pct), 'Working…', `${enable ? 'Enabling' : 'Disabling'} ${base} (${completed + 1}/${bases.length || 1}) in ${projName}…`);
            await http('PATCH', `/api/projects/${encodeURIComponent(pid)}/vms/${encodeURIComponent(base)}`, { viewable_to_user: enable });
            // Update in-memory snapshot for this project
            try {
              const vmCfg = (proj?.vms || []).find(v => String(v?.name || v?.name || '') === base);
              if (vmCfg) vmCfg.viewable_to_user = enable;
            } catch { }
            completed += 1;
            infos.push({ name: base, reason: `set viewable_to_user=${enable ? 'true' : 'false'}` });
          }
        };
        await Promise.all(Array.from({ length: Math.min(maxConcurrent, bases.length) }, () => worker()));

        // Sync Proxmox ACLs so user visibility matches the new flag.
        setAp(Math.max(20, pct), 'Syncing…', `${enable ? 'Granting' : 'Revoking'} Proxmox access in ${projName}…`);
        const syncResp = await makeReq('/instances/actions/users_access_sync', { ...baseBody, templates: bases, indices, enable });
        addArr('applied', syncResp?.applied, projName);
        addArr('unchanged', syncResp?.unchanged, projName);
        addArr('errors', syncResp?.errors, projName);
        addArr('skipped', syncResp?.skipped, projName);
        addArr('infos', syncResp?.infos, projName);
        addArr('infos', infos, projName);
        addArr('skipped', skippedLocal, projName);
        continue;
      }
      if (action === 'create') {
        const createOptions = normalizeVmCreateOptions(opts.createOptions);
        // Convert to base and client-side skip those already existing
        let t = targets.map(toBase);
        if (t.length === 0) continue;
        const createBaseBody = {
          ...baseBody,
          applyScenario: false,
          syncUserAccess: false,
          setNetworkInterfaces: createOptions.setNetworkInterfaces,
          takeSnapshot: createOptions.takeSnapshot,
        };
        // Preflight ambiguous templates per project
        try {
          let guard = 0;
          for (; ;) {
            if (guard++ > 5) break;
            setAp(Math.max(10, pct), 'Checking templates…', `Resolving templates in ${projName}…`);
            const pre = await makeReq('/instances/actions/create-preflight', { ...createBaseBody, targets: t });
            const amb0 = Array.isArray(pre?.ambiguous) ? pre.ambiguous : [];
            if (!amb0.length) break;
            const group0 = new Map();
            for (const entry of amb0) {
              const baseName = String(entry?.name || '');
              const list = Array.isArray(entry?.candidates) ? entry.candidates : [];
              if (!group0.has(baseName)) group0.set(baseName, new Map());
              const seen = group0.get(baseName);
              for (const c of list) { const vmid = (c && (c.vmid ?? c.id)); if (vmid === undefined || vmid === null || vmid === '') continue; const node = (c && (c.node ?? c.nodename ?? c.nodeName)) || ''; const key = `${vmid}@@${node}`; if (!seen.has(key)) seen.set(key, { vmid, node }); }
            }
            for (const [baseName, map] of group0.entries()) { await showTemplateResolveDialog(baseName, Array.from(map.values()), proj); }
          }
        } catch { }
        setAp(Math.max(35, pct), 'Cloning…', `Cloning in ${projName}…`);
        const createPath = `/api/projects/${encodeURIComponent(pid)}/instances/actions/create`;
        let resp = await makeReq('/instances/actions/create', { ...createBaseBody, targets: t });
        // Retry once if ambiguous reported
        const amb = Array.isArray(resp.ambiguous) ? resp.ambiguous : [];
        if (amb.length) {
          try { const group = new Map(); for (const entry of amb) { const baseName = String(entry?.name || ''); const list = Array.isArray(entry?.candidates) ? entry.candidates : []; if (!group.has(baseName)) group.set(baseName, new Map()); const seen = group.get(baseName); for (const c of list) { const vmid = (c && (c.vmid ?? c.id)); if (vmid === undefined || vmid === null || vmid === '') continue; const node = (c && (c.node ?? c.nodename ?? c.nodeName)) || ''; const k = `${vmid}@@${node}`; if (!seen.has(k)) seen.set(k, { vmid, node }); } } for (const [baseName, map] of group.entries()) { await showTemplateResolveDialog(baseName, Array.from(map.values()), proj); } } catch { }
          resp = await makeReq('/instances/actions/create', { ...createBaseBody, targets: t });
        }
        setAp(Math.max(90, pct), 'Finalizing…', `${buildVmCreateFinalizeDetail(createOptions)} in ${projName}…`);
        const createRetryOutcome = await maybeRetryVerifiedVmAction({ proj, action, resp, requestPath: createPath, requestBody: createBaseBody, setProgress: setAp, contextLabel: projName });
        resp = createRetryOutcome.resp;
        resp = await runVmCreateFollowUpActions({
          proj,
          targets,
          baseBody,
          createOptions,
          setProgress: setAp,
          contextLabel: projName,
          summaryResp: resp,
        });
        ['created', 'skipped', 'errors', 'ambiguous', 'restored', 'snapshotted', 'notices', 'infos', 'started', 'resumed', 'suspended', 'unlocked', 'powered_off', 'created_users', 'created_pools', 'added_members', 'deleted_users', 'deleted_pools', 'updated_users', 'checked', 'applied', 'network_applied_nodes', 'network_apply_errors', 'ran'].forEach(k => addArr(k, resp[k], projName));
        continue;
      }
      if (action === 'nets_set' || action === 'nets_remove' || action === 'nets_assign' || action === 'nets_clear') {
        const normalizedAction = (action === 'nets_assign') ? 'nets_set' : (action === 'nets_clear' ? 'nets_remove' : action);
        setAp(Math.max(20, pct), 'Working…', `${friendlyActionName(normalizedAction) || normalizedAction} in ${projName}…`);
        const resp = await makeReq(`/instances/actions/${normalizedAction}`, { ...baseBody, targets });
        const successKey = normalizedAction === 'nets_set' ? 'updated' : 'cleared';
        addArr(successKey, resp[successKey], projName);
        ['skipped', 'errors', 'notices', 'network_applied_nodes', 'network_apply_errors'].forEach(k => addArr(k, resp[k], projName));
        continue;
      }
      if (action === 'users_create' || action === 'users_delete' || action === 'users_perms' || action === 'users_creds_check' || action === 'users_creds_set') {
        const actionVerb = action === 'users_create'
          ? 'Creating'
          : (action === 'users_delete'
            ? 'Deleting'
            : (action === 'users_creds_check' ? 'Checking' : (action === 'users_creds_set' ? 'Syncing' : 'Updating')));
        setAp(Math.max(20, pct), 'Working…', `${actionVerb} users in ${projName}…`);
        const resp = await makeReq(`/instances/actions/${action}`, { ...baseBody, targets });
        ['created_users', 'created_pools', 'added_members', 'deleted_users', 'deleted_pools', 'updated_users', 'skipped', 'errors', 'notices'].forEach(k => addArr(k, resp[k], projName));
        addArr('checked', resp?.checked, projName);
        continue;
      }
      if (action === 'apply_scenario') {
        setAp(Math.max(20, pct), 'Working…', `Applying Scenario Name in ${projName}…`);
        const requestPromise = makeReq(`/instances/actions/apply_scenario`, { ...baseBody, targets });
        let stopStatusPoll = null;
        if (vmActionShouldPollStatus(action) && typeof startVmActionStatusPolling === 'function') {
          try { stopStatusPoll = startVmActionStatusPolling(pid, { setProgress: setAp, initialDelay: 200 }); } catch { }
        }
        let resp;
        try {
          resp = await requestPromise;
        } finally {
          if (typeof stopStatusPoll === 'function') {
            try { stopStatusPoll(); } catch { }
          }
        }
        const scenarioPath = `/api/projects/${encodeURIComponent(pid)}/instances/actions/apply_scenario`;
        const scenarioRetryOutcome = await maybeRetryVerifiedVmAction({ proj, action, resp, requestPath: scenarioPath, requestBody: baseBody, setProgress: setAp, contextLabel: projName });
        resp = scenarioRetryOutcome.resp;
        ['applied', 'skipped', 'errors', 'infos'].forEach(k => addArr(k, resp[k], projName));
        continue;
      }
      if (action === 'start' || action === 'unlock' || action === 'suspend' || action === 'poweroff' || action === 'snapshot' || action === 'restore' || action === 'run_startup_cmds' || action === 'run_stored_cmds' || action === 'validate') {
        setAp(Math.max(20, pct), 'Working…', `${action} in ${projName}…`);
        const shouldPollDetail = vmActionShouldPollStatus(action);
        let requestTargets = targets;
        let preSkipped = [];
        if (action === 'validate') {
          const split = filterRunningTargetsForProject(proj, targets);
          requestTargets = split.running;
          preSkipped = split.skipped;
          if (!requestTargets.length) {
            addArr('skipped', preSkipped, projName);
            continue;
          }
        }
        const actionPathName = action === 'validate' ? 'run_stored_cmds' : action;
        const requestBody = { ...baseBody, targets: requestTargets };
        if (action === 'validate') {
          requestBody.validateOnly = true;
        }
        const requestPromise = makeReq(`/instances/actions/${actionPathName}`, requestBody);
        let stopStatusPoll = null;
        if (shouldPollDetail && typeof startVmActionStatusPolling === 'function') {
          try { stopStatusPoll = startVmActionStatusPolling(pid, { setProgress: setAp, initialDelay: 200 }); } catch { }
        }
        let resp;
        try {
          resp = await requestPromise;
        } finally {
          if (typeof stopStatusPoll === 'function') {
            try { stopStatusPoll(); } catch { }
          }
        }
        if (resp && (Array.isArray(resp.requested_commands) || resp?.requested_command)) {
          if (Array.isArray(resp.requested_commands) && resp.requested_commands.length) {
            mergeRequestedCommands(resp.requested_commands);
          } else if (typeof resp?.requested_command === 'string' && resp.requested_command.trim()) {
            mergeRequestedCommands([resp.requested_command.trim()]);
          }
        }
        if (!agg.outputs_zip && resp?.outputs_zip) {
          agg.outputs_zip = resp.outputs_zip;
        }
        if (preSkipped.length) {
          const existingSkipped = Array.isArray(resp?.skipped) ? resp.skipped : [];
          resp.skipped = [...preSkipped, ...existingSkipped];
        }
        const actionPath = `/api/projects/${encodeURIComponent(pid)}/instances/actions/${actionPathName}`;
        const actionRetryOutcome = await maybeRetryVerifiedVmAction({ proj, action, resp, requestPath: actionPath, requestBody: baseBody, setProgress: setAp, contextLabel: projName });
        resp = actionRetryOutcome.resp;
        ['started', 'resumed', 'suspended', 'unlocked', 'powered_off', 'snapshotted', 'restored', 'skipped', 'errors', 'notices', 'infos', 'ran'].forEach(k => addArr(k, resp[k], projName));
        if (action === 'validate') {
          const { failed: vFailed, backends: vBackends } = vmBuildRestartTargetsForFailedValidation(proj, resp.ran || []);
          if (vFailed.length) validateRestartPlan.push({ proj, failed: vFailed, backends: vBackends });
        }
        continue;
      }
      if (action === 'delete') {
        const deleteOptions = normalizeVmDeleteOptions(opts.deleteOptions);
        let t = targets.map(toBase);
        if (t.length === 0) continue;
        let preDeleteResp = {};
        if (deleteOptions.disableUserAccessibility) {
          preDeleteResp = await runVmDeleteFollowUpActions({
            proj,
            targets,
            baseBody,
            deleteOptions,
            setProgress: setAp,
            contextLabel: projName,
            summaryResp: {},
          });
        }
        setAp(Math.max(20, pct), 'Deleting…', `Deleting in ${projName}…`);
        const requestPromise = makeReq('/instances/actions/delete', { ...baseBody, deleteUsersAndPools: deleteOptions.deleteUsersAndPools, verifyCleanup: deleteOptions.verifyCleanup, targets: t });
        let stopStatusPoll = null;
        if (vmActionShouldPollStatus(action) && typeof startVmActionStatusPolling === 'function') {
          try { stopStatusPoll = startVmActionStatusPolling(pid, { setProgress: setAp, initialDelay: 200 }); } catch { }
        }
        let resp;
        try {
          resp = await requestPromise;
        } finally {
          if (typeof stopStatusPoll === 'function') {
            try { stopStatusPoll(); } catch { }
          }
        }
        const deletePath = `/api/projects/${encodeURIComponent(pid)}/instances/actions/delete`;
        const deleteRetryOutcome = await maybeRetryVerifiedVmAction({ proj, action, resp, requestPath: deletePath, requestBody: baseBody, setProgress: setAp, contextLabel: projName });
        resp = deleteRetryOutcome.resp;
        resp = mergeVmActionSummaryData(preDeleteResp, resp);
        ['deleted', 'skipped', 'errors', 'notices', 'infos', 'applied', 'unchanged'].forEach(k => addArr(k, resp[k], projName));
        continue;
      }
      alert('Action not implemented yet: ' + action);
      return;
    } catch (e) {
      try { (window.shell && shell.logError) ? shell.logError(`${action} failed in ${projName}: ${e?.message || e}`) : console.error(action, 'failed in', projName, e); } catch { }
      addArr('errors', [{ name: projName, reason: e?.message || String(e) }], projName);
    }
  }
  if (!agg.requested_command && Array.isArray(agg.requested_commands) && agg.requested_commands.length === 1) {
    agg.requested_command = agg.requested_commands[0];
  }
  // Show summary
  const summaryName = friendlyActionName(action) || action;
  try { showActionSummary(summaryName, agg); } catch { }
  try { emitActionLogs(summaryName, agg); } catch { }
  try { shell.endActionContext(true); } catch { }
  if (action === 'validate' && validateRestartPlan.length > 0) {
    await vmMaybeRestartFailedValidation(validateRestartPlan);
  }
  // Optimistic table update (multi): if no errors, reflect expected adaptors immediately.
  try {
    if (action === 'nets_set' || action === 'nets_remove' || action === 'nets_assign' || action === 'nets_clear') {
      const normalizedAction = (action === 'nets_assign') ? 'nets_set' : (action === 'nets_clear' ? 'nets_remove' : action);
      const errCount = Array.isArray(agg?.errors) ? agg.errors.length : 0;
      const applyErrCount = Array.isArray(agg?.network_apply_errors) ? agg.network_apply_errors.length : 0;
      if (errCount === 0 && applyErrCount === 0) {
        // Reuse the existing selection grouping to update just the selected rows.
        const targetsByPid = new Map();
        for (const entry of (selected || [])) {
          if (!entry?.pid || !Number.isFinite(entry.index) || !entry.name) continue;
          if (!targetsByPid.has(entry.pid)) targetsByPid.set(entry.pid, []);
          targetsByPid.get(entry.pid).push({ index: Number(entry.index), name: String(entry.name) });
        }
        _vmOptimisticallyUpdateMergedRows(byId, targetsByPid, normalizedAction === 'nets_remove' ? 'remove' : 'set');
        try { renderMergedVmTable(window.__MERGED_ROWS__ || []); } catch { }
      }
    }
  } catch { }
  // Cleanup
  ACTION_IN_FLIGHT = false; CURRENT_ACTION = null; updateRefreshState();
  try { const prog = document.getElementById('vm-progress'); if (prog) { prog.classList.add('d-none'); prog.setAttribute('aria-hidden', 'true'); } } catch { }
  try { hideActionProgress(); } catch { }
  try {
    const forceRefresh = (action === 'nets_set' || action === 'nets_remove' || action === 'nets_assign' || action === 'nets_clear' || action === 'apply_scenario');
    Promise.resolve().then(() => vmRefresh({ forceRefresh, showProgressDialog: false })).catch(() => { });
  } catch { }
}

async function vmCancelActions() {
  if (!PROJ) return;
  // Immediately reflect cancellation in UI so repeated clicks are suppressed
  try {
    const cancelBtn = document.getElementById('act-cancel');
    if (cancelBtn) cancelBtn.disabled = true;
    const modalCancelBtn = document.getElementById('action-progress-cancel-btn');
    if (modalCancelBtn) modalCancelBtn.disabled = true;
  } catch { }
  try { updateActionProgress(null, 'Cancelling…', 'Waiting for current step to stop…'); } catch { }
  await runQueued('Cancel remote actions', async () => {
    try {
      try { shell.beginActionContext('Cancel Job'); } catch { }
      await http('POST', `/api/projects/${PROJ.id}/instances/actions/cancel`, {});
      try { shell.step('Cancel request acknowledged'); } catch { }
      try { shell.endActionContext(true); } catch { }
      try { updateActionProgress(null, 'Cancelling…', 'Cancel request sent — waiting for job to stop…'); } catch { }
    } catch (e) {
      // noop
      try { shell.endActionContext(false); } catch { }
    }
  }, { projectId: PROJ?.id });
}

// Show modal to resolve ambiguous template base name to a specific VMID and persist to configuration
async function showTemplateResolveDialog(baseName, candidates, projectOverride) {
  const project = projectOverride && typeof projectOverride === 'object' ? projectOverride : PROJ;
  return new Promise((resolve, reject) => {
    try {
      // Only show during an active Create run; otherwise resolve immediately to avoid stray dialogs
      if (!(ACTION_IN_FLIGHT && CURRENT_ACTION === 'create')) { resolve(); return; }
      const body = document.getElementById('tmpl-resolve-body');
      const saveBtn = document.getElementById('tmpl-resolve-save');
      if (!body || !saveBtn) { resolve(); return; }
      // Normalize candidates to a consistent array of { vmid:number|string, node:string }
      const toArray = (val) => Array.isArray(val) ? val : (val && typeof val === 'object' ? Object.values(val) : []);
      const norm = toArray(candidates).map(c => {
        try {
          const vmid = (c && (c.vmid ?? c.id ?? (c.data && c.data.vmid)))
            ;
          const node = (c && (c.node ?? c.nodename ?? c.nodeName ?? c.host ?? c.hostname)) || '';
          if (vmid === undefined || vmid === null || vmid === '') return null;
          return { vmid: vmid, node: String(node || '') };
        } catch { return null; }
      }).filter(Boolean);
      const list = (norm.length ? norm : []).map(c => {
        const id = String(c.vmid);
        const node = c.node || '';
        return `<div class="form-check">
          <input class="form-check-input" type="radio" name="tmpl-vmid" id="tmpl-${id}" value="${id}">
      <label class="form-check-label" for="tmpl-${id}">#${escHtml(id)} on ${escHtml(node)}</label>
        </div>`;
      }).join('') || '<div class="text-muted">No candidates.</div>';
      body.innerHTML = `<div class="mb-2">Multiple templates named <strong>${escHtml(baseName)}</strong> were found. Select the VM ID to use:</div>${list}`;
      const modalEl = document.getElementById('tmplResolveModal');
      if (modalEl && modalEl.parentElement !== document.body) {
        document.body.appendChild(modalEl);
      }
      const bs = window.bootstrap && window.bootstrap.Modal ? bootstrap.Modal.getOrCreateInstance(modalEl) : null;
      // Hide action progress modal to avoid overlap and only show resolve after it's fully hidden
      let prevModal = null;
      let showResolve = () => {
        // Guard again in case the call was queued and action finished meanwhile
        if (!(ACTION_IN_FLIGHT && CURRENT_ACTION === 'create')) { try { resolve(); } catch { }; return; }
        try {
          // Safety: clear any lingering backdrops before showing resolve
          document.querySelectorAll('.modal-backdrop').forEach(el => { try { el.remove(); } catch { } });
        } catch { }
        try {
          // Ensure modal is top-most above any previous modal
          try { modalEl.style.zIndex = '1065'; } catch { }
          bs && bs.show();
          // After show, boost the latest backdrop just below the modal
          setTimeout(() => {
            try {
              const backs = Array.from(document.querySelectorAll('.modal-backdrop'));
              if (backs.length) backs[backs.length - 1].style.zIndex = '1060';
              // Focus modal for accessibility/visibility
              modalEl.focus && modalEl.focus();
            } catch { }
          }, 0);
        } catch { }
      };
      try {
        const progEl = document.getElementById('actionProgressModal');
        if (progEl && window.bootstrap) {
          prevModal = bootstrap.Modal.getInstance(progEl) || bootstrap.Modal.getOrCreateInstance(progEl);
          if (prevModal) {
            // If visible, wait for hidden event before showing resolve modal; fallback timer too
            const doShow = () => {
              // Guard prior to showing in case action already ended
              if (!(ACTION_IN_FLIGHT && CURRENT_ACTION === 'create')) { try { progEl.removeEventListener('hidden.bs.modal', doShow); } catch { }; try { resolve(); } catch { }; return; }
              showResolve();
              try { progEl.removeEventListener('hidden.bs.modal', doShow); } catch { }
            };
            const isShown = !!progEl.classList.contains('show');
            let fallbackTimer = null;
            try {
              progEl.addEventListener('hidden.bs.modal', doShow, { once: true });
              // Fallback in case the hidden event doesn’t fire (or it’s already hidden)
              fallbackTimer = setTimeout(() => { doShow(); }, isShown ? 500 : 0);
            } catch {
              // As a last resort, show immediately
              showResolve();
            }
            // Only hide if actually shown; otherwise show immediately and clear fallback
            if (isShown) {
              prevModal.hide();
            } else {
              if (fallbackTimer) { try { clearTimeout(fallbackTimer); } catch { } }
              showResolve();
            }
          } else {
            showResolve();
          }
        } else {
          showResolve();
        }
      } catch { showResolve(); }
      const cleanup = () => {
        try { saveBtn.removeEventListener('click', onSave); } catch { }
        try { modalEl.removeEventListener('hidden.bs.modal', onHidden); } catch { }
      };
      const onHidden = () => {
        cleanup();
        resolve();
      };
      const onSave = async () => {
        try {
          // Guard: if action ended, just close and resolve
          if (!(ACTION_IN_FLIGHT && CURRENT_ACTION === 'create')) { bs && bs.hide(); cleanup(); resolve(); return; }
          const chosen = (modalEl.querySelector('input[name="tmpl-vmid"]:checked') || {}).value;
          if (!chosen) { alert('Please select a VM ID.'); return; }
          const vm = (project?.vms || []).find(v => String(v.name).toLowerCase() === String(baseName).toLowerCase());
          if (!vm) { bs && bs.hide(); resolve(); return; }
          await http('PATCH', `/api/projects/${project.id}/vms/${encodeURIComponent(vm.name)}`, { vmid: Number(chosen) });
          vm.vmid = Number(chosen);
          bs && bs.hide();
          cleanup();
          resolve();
        } catch (err) {
          alert('Failed to save VM ID: ' + (err && err.message ? err.message : err));
          cleanup();
          reject(err);
        }
      };
      saveBtn.addEventListener('click', onSave);
      if (modalEl && window.bootstrap) {
        modalEl.addEventListener('hidden.bs.modal', onHidden, { once: true });
      }
      // Showing is handled after hiding the progress modal above
    } catch (e) {
      resolve();
    }
  });
}

function showActionSummary(actionName, resp) {
  try {
    const title = document.getElementById('action-summary-title');
    const body = document.getElementById('action-summary-body');
    if (!body) return;
    if (title) title.textContent = `${actionName} Results`;
    const formatBytes = (value) => {
      const n = Number(value);
      if (!Number.isFinite(n) || n <= 0) return '0 B';
      const units = ['B', 'KB', 'MB', 'GB', 'TB'];
      let idx = 0;
      let num = n;
      while (num >= 1024 && idx < units.length - 1) {
        num /= 1024;
        idx += 1;
      }
      const precision = num >= 10 || idx === 0 ? 0 : 1;
      return `${num.toFixed(precision)} ${units[idx]}`;
    };
    const created = Array.isArray(resp.created) ? resp.created : [];
    const deleted = Array.isArray(resp.deleted) ? resp.deleted : [];
    const skipped = Array.isArray(resp.skipped) ? resp.skipped : [];
    const allErrors = Array.isArray(resp.errors) ? resp.errors : [];
    const notices = Array.isArray(resp.notices) ? resp.notices : [];
    const infos = Array.isArray(resp.infos) ? resp.infos : [];
    const appliedPerms = Array.isArray(resp.applied) ? resp.applied : [];
    const unchangedPerms = Array.isArray(resp.unchanged) ? resp.unchanged : [];
    const checkedCreds = Array.isArray(resp.checked) ? resp.checked : [];
    const credsRepairPlan = /check credential sync/i.test(String(actionName || ''))
      ? deriveCredsRepairTargetsFromChecked(checkedCreds)
      : null;
    const isUserAccess = /user accessibility/i.test(String(actionName || '')) || ((resp && typeof resp.enable === 'boolean') && (appliedPerms.length || unchangedPerms.length));
    const isNetInterfacesAction = /network interfaces/i.test(String(actionName || ''));
    // Historically, ACL-related items were filtered out to keep other action summaries tidy.
    // For User Accessibility actions, permission details are the primary output.
    const isAcl = (s) => String(s || '').toLowerCase().includes('acl');
    const errors = isUserAccess ? allErrors : allErrors.filter(e => !isAcl(e?.reason));
    const visibleNotices = isUserAccess ? notices : notices.filter(n => !isAcl(n?.reason || n));
    const amb = Array.isArray(resp.ambiguous) ? resp.ambiguous : [];
    const appliedNodes = Array.isArray(resp.network_applied_nodes) ? resp.network_applied_nodes : [];
    const applyErrors = Array.isArray(resp.network_apply_errors) ? resp.network_apply_errors : [];
    const ran = Array.isArray(resp.ran) ? resp.ran : [];
    // Users / Pools
    const createdUsers = Array.isArray(resp.created_users) ? resp.created_users : [];
    const createdPools = Array.isArray(resp.created_pools) ? resp.created_pools : [];
    const addedMembers = Array.isArray(resp.added_members) ? resp.added_members : [];
    const deletedUsers = Array.isArray(resp.deleted_users) ? resp.deleted_users : [];
    const deletedPools = Array.isArray(resp.deleted_pools) ? resp.deleted_pools : [];
    const updatedUsers = Array.isArray(resp.updated_users) ? resp.updated_users : [];
    const outputsZipInfo = (resp.outputs_zip && resp.outputs_zip.base64) ? resp.outputs_zip : null;
    const outputsZipInfos = Array.isArray(resp.outputs_zips) && resp.outputs_zips.length
      ? resp.outputs_zips.filter(item => item && item.base64)
      : (outputsZipInfo ? [outputsZipInfo] : []);
    const pushed = Array.isArray(resp.pushed) ? resp.pushed : [];
    const pulled = Array.isArray(resp.pulled) ? resp.pulled : [];

    const esc = (s) => String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[c]));
    const list = (items, fmt) => items && items.length ? `<ul class="small">${items.map(fmt).join('')}</ul>` : '<div class="text-muted small">None</div>';
    const buildLogDownloadLink = (filename, content, label = 'download log') => {
      const href = `data:text/plain;charset=utf-8,${encodeURIComponent(String(content || ''))}`;
      return `<a class="small ms-2" href="${href}" download="${esc(filename)}">${esc(label)}</a>`;
    };
    const buildRunLogText = (hostName, cmdObj) => {
      const lines = [
        `Host: ${String(hostName || '')}`,
        `Command: ${String(cmdObj?.cmd || '')}`,
        `Exit Code: ${cmdObj?.exitcode === null || cmdObj?.exitcode === undefined ? '' : String(cmdObj.exitcode)}`,
        `Timeout (s): ${cmdObj?.timeout_seconds ?? ''}`,
        `Long-running: ${cmdObj?.long_running ? 'yes' : 'no'}`,
        '',
        'STDOUT (preview):',
        String(cmdObj?.stdout_preview || ''),
        '',
        'STDERR (preview):',
        String(cmdObj?.stderr_preview || ''),
      ];
      return lines.join('\n');
    };
    const buildValidationLogText = (hostName, validationObj) => {
      const lines = [
        `Host: ${String(hostName || '')}`,
        `Validation Command: ${String(validationObj?.command || '')}`,
        `Match Regex: ${String(validationObj?.match || '')}`,
        `Passed: ${validationObj?.passed ? 'yes' : 'no'}`,
        `Timed Out: ${validationObj?.timed_out ? 'yes' : 'no'}`,
        `Exit Code: ${validationObj?.exitcode === null || validationObj?.exitcode === undefined ? '' : String(validationObj.exitcode)}`,
        `Timeout (s): ${validationObj?.timeout_seconds ?? ''}`,
        validationObj?.reason ? `Reason: ${String(validationObj.reason)}` : '',
        '',
        'STDOUT (preview):',
        String(validationObj?.stdout_preview || ''),
        '',
        'STDERR (preview):',
        String(validationObj?.stderr_preview || ''),
      ].filter(Boolean);
      return lines.join('\n');
    };

    const sections = [];
    const leadSections = [];
    if (!ran.length && Array.isArray(resp.error_summary) && resp.error_summary.length) {
      leadSections.push(`<div class="alert alert-danger py-1 small">${resp.error_summary.map(line => esc(line)).join('<br>')}</div>`);
    }
    const requestedList = (() => {
      if (Array.isArray(resp.requested_commands) && resp.requested_commands.length) {
        return resp.requested_commands.map(c => String(c || '').trim()).filter(Boolean);
      }
      const single = typeof resp.requested_command === 'string' ? resp.requested_command.trim() : '';
      return single ? [single] : [];
    })();
    if (requestedList.length === 1) {
      leadSections.push(`<div class="alert alert-info py-1 small">Command filter: <code>${esc(requestedList[0])}</code></div>`);
    } else if (requestedList.length > 1) {
      const items = requestedList.map(cmd => `<li><code>${esc(cmd)}</code></li>`).join('');
      leadSections.push(`<div class="alert alert-info py-1 small">Command filters (${requestedList.length}):<ul class="mb-0">${items}</ul></div>`);
    }
    if (created.length) sections.push(`<h6>Created</h6>${list(created, i => `<li>${esc(i.name)} ${i.vmid ? `(#${esc(i.vmid)})` : ''} ${i.node ? `on ${esc(i.node)}` : ''}</li>`)}`);
    if (deleted.length) sections.push(`<h6>Deleted</h6>${list(deleted, i => `<li>${esc(i.name)} ${i.vmid ? `(#${esc(i.vmid)})` : ''} ${i.node ? `on ${esc(i.node)}` : ''}</li>`)}`);
    const started = Array.isArray(resp.started) ? resp.started : [];
    const resumed = Array.isArray(resp.resumed) ? resp.resumed : [];
    const suspended = Array.isArray(resp.suspended) ? resp.suspended : [];
    const unlocked = Array.isArray(resp.unlocked) ? resp.unlocked : [];
    const poweredOff = Array.isArray(resp.powered_off) ? resp.powered_off : [];
    const snapshotted = Array.isArray(resp.snapshotted) ? resp.snapshotted : [];
    const restored = Array.isArray(resp.restored) ? resp.restored : [];
    const netsUpdated = Array.isArray(resp.updated) ? resp.updated : [];
    const netsCleared = Array.isArray(resp.cleared) ? resp.cleared : [];
    if (started.length) sections.push(`<h6>Started</h6>${list(started, i => `<li>${esc(i.name)} ${i.vmid ? `(#${esc(i.vmid)})` : ''} ${i.node ? `on ${esc(i.node)}` : ''}</li>`)}`);
    if (resumed.length) sections.push(`<h6>Resumed</h6>${list(resumed, i => `<li>${esc(i.name)} ${i.vmid ? `(#${esc(i.vmid)})` : ''} ${i.node ? `on ${esc(i.node)}` : ''}</li>`)}`);
    if (suspended.length) sections.push(`<h6>Suspended</h6>${list(suspended, i => `<li>${esc(i.name)} ${i.vmid ? `(#${esc(i.vmid)})` : ''} ${i.node ? `on ${esc(i.node)}` : ''}</li>`)}`);
    if (unlocked.length) sections.push(`<h6>Unlocked</h6>${list(unlocked, i => `<li>${esc(i.name)} ${i.vmid ? `(#${esc(i.vmid)})` : ''} ${i.node ? `on ${esc(i.node)}` : ''}</li>`)}`);
    if (poweredOff.length) sections.push(`<h6>Powered Off</h6>${list(poweredOff, i => `<li>${esc(i.name)} ${i.vmid ? `(#${esc(i.vmid)})` : ''} ${i.node ? `on ${esc(i.node)}` : ''}</li>`)}`);
    if (snapshotted.length) sections.push(`<h6>Snapshots</h6>${list(snapshotted, i => `<li>${esc(i.name)} — ${esc(i.snapname || 'snapshot')} ${i.vmid ? `(#${esc(i.vmid)})` : ''}</li>`)}`);
    if (restored.length) sections.push(`<h6>Restored</h6>${list(restored, i => `<li>${esc(i.name)} — ${esc(i.snapname || 'snapshot')} ${i.started ? '(started)' : ''}</li>`)}`);
    if (!isUserAccess && appliedPerms.length) sections.push(`<h6>Applied Notes</h6>${list(appliedPerms, i => `<li>${esc(i.name)} ${i.vmid ? `(#${esc(i.vmid)})` : ''} ${i.node ? `on ${esc(i.node)}` : ''}</li>`)}`);
    const netActionIcon = (kind) => {
      try {
        if (!isNetInterfacesAction) return '';
        if (kind === 'enabled') return '<i class="bi bi-toggle-on text-success me-1" title="Enabled"></i>';
        if (kind === 'disabled') return '<i class="bi bi-toggle-off text-secondary me-1" title="Disabled"></i>';
      } catch { }
      return '';
    };
    if (netsUpdated.length) sections.push(`<h6>Network Assigned</h6>${list(netsUpdated, i => `<li>${netActionIcon('enabled')}${esc(i.name)} ${i.vmid ? `(#${esc(i.vmid)})` : ''} ${i.node ? `on ${esc(i.node)}` : ''}</li>`)}`);
    if (netsCleared.length) sections.push(`<h6>Network Removed</h6>${list(netsCleared, i => `<li>${netActionIcon('disabled')}${esc(i.name)} ${i.vmid ? `(#${esc(i.vmid)})` : ''} ${i.node ? `on ${esc(i.node)}` : ''}</li>`)}`);
    if (pushed.length) sections.push(`<h6>Pushed</h6>${list(pushed, i => `<li>${esc(i.name)} ${i.vmid ? `(#${esc(i.vmid)})` : ''} — ${esc(i.item_count ?? i.file_count ?? 0)} item(s) to <code>${esc(i.destination || '')}</code></li>`)}`);
    if (pulled.length) sections.push(`<h6>Pulled</h6>${list(pulled, i => `<li>${esc(i.name)} ${i.vmid ? `(#${esc(i.vmid)})` : ''} — ${esc(i.file_count || 0)} file(s)</li>`)}`);
    // Users / Pools sections
    if (createdUsers.length) sections.push(`<h6>Users Created</h6>${list(createdUsers, i => `<li>${esc(i.userid || '')}</li>`)}`);
    if (createdPools.length) sections.push(`<h6>Pools Created</h6>${list(createdPools, i => `<li>${esc(i.pool || '')} ${i.index ? `(instance ${esc(i.index)})` : ''}</li>`)}`);
    if (addedMembers.length) sections.push(`<h6>Pool Members Added</h6>${list(addedMembers, i => `<li>${esc(i.pool || '')} — ${esc(i.name || '')} ${i.vmid ? `(#${esc(i.vmid)})` : ''}</li>`)}`);
    if (deletedUsers.length) sections.push(`<h6>Users Deleted</h6>${list(deletedUsers, i => `<li>${esc(i.userid || '')}</li>`)}`);
    if (deletedPools.length) sections.push(`<h6>Pools Deleted</h6>${list(deletedPools, i => `<li>${esc(i.pool || '')} ${i.index ? `(instance ${esc(i.index)})` : ''}</li>`)}`);
    if (updatedUsers.length) sections.push(`<h6>Users Updated</h6>${list(updatedUsers, i => `<li>${esc(i.userid || '')}</li>`)}`);
    if (checkedCreds.length) sections.push(`<h6>Credential Sync</h6>${list(checkedCreds, i => {
      const details = [];
      if (typeof i.user_exists === 'boolean') details.push(`user ${i.user_exists ? 'ok' : 'missing'}`);
      if (typeof i.password_verified === 'boolean') details.push(`password ${i.password_verified ? 'ok' : 'failed'}`);
      else if (i.password_verified === null) details.push('password n/a');
      if (typeof i.pool_exists === 'boolean') details.push(`pool ${i.pool_exists ? 'ok' : 'missing'}`);
      if (typeof i.pool_member === 'boolean') details.push(`member ${i.pool_member ? 'ok' : 'missing'}`);
      if (i.expected_access) details.push(`expected ${i.expected_access}`);
      if (Array.isArray(i.actual_roles) && i.actual_roles.length) details.push(`actual ${i.actual_roles.join(', ')}`);
      return `<li>${esc(i.name || i.userid || i.index || '')} ${i.vmid ? `(#${esc(i.vmid)})` : ''} — <strong class="${String(i.status || '') === 'ok' ? 'text-success' : 'text-warning'}">${esc(i.status || 'checked')}</strong> — ${esc(i.reason || '')}${details.length ? `<div class="text-muted">${esc(details.join(' · '))}</div>` : ''}</li>`;
    })}`);
    const netSkipIcon = (s) => {
      try {
        if (!isNetInterfacesAction) return '';
        const reason = String(s?.reason || '').toLowerCase();
        if (reason.includes('no network interfaces found')) {
          return '<i class="bi bi-toggle-off text-secondary me-1" title="Disabled"></i>';
        }
        if (reason.includes('already correct') || reason.includes('already exist')) {
          return '<i class="bi bi-toggle-on text-success me-1" title="Enabled"></i>';
        }
      } catch { }
      return '';
    };
    if (skipped.length) {
      sections.push(`<h6>Skipped</h6>${list(skipped, s => `<li>${netSkipIcon(s)}${esc(s.name || s.index || '')} — ${esc(s.reason || '')}</li>`)}`);
    }
    if (amb.length) sections.push(`<h6>Ambiguous</h6>${list(amb, a => `<li>${esc(a.name)} — candidates: ${(a.candidates || []).map(c => `#${esc(c.vmid)} on ${esc(c.node || '')}`).join(', ')}</li>`)}`);
    if (isUserAccess) {
      try {
        const hasProject = [...appliedPerms, ...unchangedPerms, ...skipped, ...errors].some(x => x && typeof x === 'object' && x.project);
        const keyFor = (item, idx) => {
          const project = hasProject ? String(item?.project || '') : '';
          return hasProject ? `${project}@@${idx}` : String(idx);
        };
        const labelFor = (key) => {
          if (!hasProject) return { project: '', index: Number(key) };
          const [p, raw] = String(key).split('@@');
          return { project: p || '', index: Number(raw) };
        };
        const keySet = new Set();
        (Array.isArray(resp.indices) ? resp.indices : []).forEach(i => {
          const n = Number(i);
          if (!Number.isFinite(n) || n <= 0) return;
          // Single-project call: no project dimension
          keySet.add(String(n));
        });
        const collect = (arr) => {
          (Array.isArray(arr) ? arr : []).forEach(item => {
            const idx = Number(item?.index);
            if (!Number.isFinite(idx) || idx <= 0) return;
            keySet.add(keyFor(item, idx));
          });
        };
        collect(appliedPerms);
        collect(unchangedPerms);
        collect(skipped);
        collect(errors);
        const keys = Array.from(keySet).sort((a, b) => {
          const aa = labelFor(a); const bb = labelFor(b);
          if ((aa.project || '') !== (bb.project || '')) return String(aa.project || '').localeCompare(String(bb.project || ''));
          return (aa.index || 0) - (bb.index || 0);
        });
        const byKey = (arr) => {
          const m = new Map();
          (Array.isArray(arr) ? arr : []).forEach(item => {
            const idx = Number(item?.index);
            if (!Number.isFinite(idx) || idx <= 0) return;
            const k = keyFor(item, idx);
            if (!m.has(k)) m.set(k, []);
            m.get(k).push(item);
          });
          return m;
        };
        const appliedBy = byKey(appliedPerms);
        const unchangedBy = byKey(unchangedPerms);
        const skippedBy = byKey(skipped);
        const errorsBy = byKey(errors);
        const rows = keys.map(k => {
          const meta = labelFor(k);
          const a = appliedBy.get(k) || [];
          const u = unchangedBy.get(k) || [];
          const s = skippedBy.get(k) || [];
          const e = errorsBy.get(k) || [];
          const grants = a.filter(x => String(x?.action || '').toLowerCase() === 'grant').length;
          const revokes = a.filter(x => String(x?.action || '').toLowerCase() === 'revoke').length;
          const reconciles = a.filter(x => String(x?.action || '').toLowerCase() === 'reconcile').length;
          const parts = [];
          if (grants) parts.push(`${grants} granted`);
          if (revokes) parts.push(`${revokes} revoked`);
          if (reconciles) parts.push(`${reconciles} updated`);
          if (u.length) parts.push(`${u.length} unchanged`);
          if (s.length) parts.push(`${s.length} skipped`);
          if (e.length) parts.push(`${e.length} error(s)`);
          const label = hasProject ? `[${meta.project}] Instance ${meta.index}` : `Instance ${meta.index}`;
          return { label, text: parts.length ? parts.join(' · ') : 'no matching VMs' };
        });
        if (rows.length) sections.push(`<h6>User Accessibility</h6>${list(rows, r => `<li>${esc(r.label)} — ${esc(r.text)}</li>`)}`);
      } catch { }
    }
    // For User Accessibility actions, keep the summary focused on per-row permission results.
    if (!isUserAccess && infos.length) {
      sections.push(`<h6 class="text-muted">Info</h6>${list(infos, i => `<li>${esc(i.name || i.node || '')} — ${esc(i.reason || i)}</li>`)}`);
    }
    if (visibleNotices.length) sections.push(`<h6 class="text-warning">Warnings</h6>${list(visibleNotices, w => `<li>${esc(w.name || w.node || '')} — ${esc(w.reason || w)}</li>`)}`);
    if (errors.length) sections.push(`<h6 class="text-danger">Errors</h6>${list(errors, e => `<li>${esc(e.name || e.node || '')} — ${esc(e.reason || '')}</li>`)}`);
    if (ran.length) sections.push(`<h6>Commands Run</h6>${list(ran, i => {
      const cmds = Array.isArray(i.cmds) ? i.cmds : [];
      const hostSafe = String(i?.name || 'vm').replace(/[^A-Za-z0-9_.-]+/g, '_') || 'vm';
      const cmdList = cmds.length ? `<ul class="small">${cmds.map(c => {
        const exitLabel = c.exitcode === null ? '?' : String(c.exitcode);
        const preview = c.stdout_preview || c.stderr_preview || '';
        const previewBlock = preview ? `<pre class=\"mt-1 mb-2 small bg-light p-2 overflow-auto\" style=\"max-height:8rem\">${esc(preview)}</pre>` : '';
        const cmdNameSafe = String(c?.cmd || 'command').replace(/[^A-Za-z0-9_.-]+/g, '_').slice(0, 48) || 'command';
        const logLink = buildLogDownloadLink(
          `${hostSafe}_${cmdNameSafe}.log.txt`,
          buildRunLogText(i?.name || '', c),
          'download log'
        );
        return `<li><code>${esc(c.cmd || '')}</code> — exit ${exitLabel}${logLink}${previewBlock}</li>`;
      }).join('')}</ul>` : '<div class="text-muted small">No commands</div>';
      const validationResults = Array.isArray(i?.validation?.results) ? i.validation.results : [];
      const validationList = validationResults.length ? `<ul class="small">${validationResults.map((v, idx) => {
        const statusClass = v?.passed ? 'text-success' : 'text-danger';
        const statusText = v?.passed ? 'passed' : 'failed';
        const preview = v?.stdout_preview || v?.stderr_preview || v?.reason || '';
        const previewBlock = preview ? `<pre class=\"mt-1 mb-2 small bg-light p-2 overflow-auto\" style=\"max-height:8rem\">${esc(preview)}</pre>` : '';
        const cmdNameSafe = String(v?.command || `validation_${idx + 1}`).replace(/[^A-Za-z0-9_.-]+/g, '_').slice(0, 48) || `validation_${idx + 1}`;
        const logLink = buildLogDownloadLink(
          `${hostSafe}_validation_${idx + 1}_${cmdNameSafe}.log.txt`,
          buildValidationLogText(i?.name || '', v),
          'download log'
        );
        return `<li><code>${esc(v?.command || '')}</code> — <span class="${statusClass}">${statusText}</span>${v?.timed_out ? ' (timed out)' : ''}${logLink}${previewBlock}</li>`;
      }).join('')}</ul>` : '<div class="text-muted small">No validation attempts</div>';
      const validationSummary = i?.validation && typeof i.validation === 'object'
        ? `<div class="small mt-2"><strong>Validation:</strong> ${i.validation.all_passed ? 'all passed' : 'one or more failed'} (${validationResults.length} attempted)</div>${validationList}`
        : '';
      return `<li>${esc(i.name)} — ${i.count || 0} cmd(s)${cmds.length ? ':' : ''}${cmdList}${validationSummary}</li>`;
    })}`);
    if (resp.notice && typeof resp.notice === 'string') {
      leadSections.unshift(`<div class="alert alert-warning py-1 small">${esc(resp.notice)}</div>`);
    }
    if (appliedNodes.length || applyErrors.length) {
      if (appliedNodes.length) sections.push(`<h6>Network Apply</h6><div class="small">Applied on node(s): ${appliedNodes.map(esc).join(', ')}</div>`);
      if (applyErrors.length) sections.push(`<h6 class="text-danger">Network Apply Errors</h6>${list(applyErrors, e => `<li>${esc(e.node || '')} — ${esc(e.reason || '')}</li>`)}`);
    }

    const summaryCounts = [
      created.length ? `${created.length} created` : null,
      deleted.length ? `${deleted.length} deleted` : null,
      started.length ? `${started.length} started` : null,
      resumed.length ? `${resumed.length} resumed` : null,
      suspended.length ? `${suspended.length} suspended` : null,
      unlocked.length ? `${unlocked.length} unlocked` : null,
      poweredOff.length ? `${poweredOff.length} powered off` : null,
      snapshotted.length ? `${snapshotted.length} snapshotted` : null,
      restored.length ? `${restored.length} restored` : null,
      skipped.length ? `${skipped.length} skipped` : null,
      (isUserAccess && appliedPerms.length) ? `${appliedPerms.length} permission updates` : null,
      (isUserAccess && unchangedPerms.length) ? `${unchangedPerms.length} unchanged` : null,
      errors.length ? `${errors.length} errors` : null,
      ran.length ? `${ran.length} hosts with cmds` : null,
      createdUsers.length ? `${createdUsers.length} user(s)` : null,
      createdPools.length ? `${createdPools.length} pool(s)` : null,
      addedMembers.length ? `${addedMembers.length} member(s)` : null,
      deletedUsers.length ? `${deletedUsers.length} user(s) deleted` : null,
      deletedPools.length ? `${deletedPools.length} pool(s) deleted` : null,
      updatedUsers.length ? `${updatedUsers.length} user(s) updated` : null,
      checkedCreds.length ? `${checkedCreds.length} checked` : null,
      checkedCreds.filter(i => String(i?.status || '') !== 'ok').length ? `${checkedCreds.filter(i => String(i?.status || '') !== 'ok').length} drift` : null,
      netsUpdated.length ? `${netsUpdated.length} network assigned` : null,
      netsCleared.length ? `${netsCleared.length} network removed` : null,
      appliedNodes.length ? `network applied on ${appliedNodes.length} node(s)` : null,
      applyErrors.length ? `${applyErrors.length} network apply errors` : null,
      pushed.length ? `${pushed.length} guest push passed` : null,
      pulled.length ? `${pulled.length} guest pull passed` : null
    ].filter(Boolean).join(' · ');

    const contentSections = leadSections.concat(sections);
    body.innerHTML = `<div class="mb-2 text-muted">${esc(summaryCounts || 'No changes')}</div>${contentSections.join('\n') || '<div class="text-muted small">No results to display.</div>'}`;
    if (credsRepairPlan && (credsRepairPlan.count || 0) > 0) {
      const actionWrap = document.createElement('div');
      actionWrap.className = 'mt-3 pt-2 border-top d-flex flex-column gap-2';
      const note = document.createElement('div');
      note.className = 'small text-muted';
      note.textContent = `Found drift on ${credsRepairPlan.count} row${credsRepairPlan.count === 1 ? '' : 's'}. You can apply the current credential list to just those rows.`;
      actionWrap.appendChild(note);
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn btn-sm btn-outline-primary align-self-start';
      btn.textContent = 'Repair Drifted Rows';
      btn.addEventListener('click', () => {
        try {
          const modalEl = document.getElementById('actionSummaryModal');
          if (modalEl && window.bootstrap) {
            const bs = bootstrap.Modal.getOrCreateInstance(modalEl);
            bs.hide();
          }
        } catch { }
        const payload = credsRepairPlan.targetsByPid
          ? { targetsByPid: credsRepairPlan.targetsByPid }
          : { targets: credsRepairPlan.targets || [] };
        Promise.resolve().then(() => vmAction('users_creds_set', payload)).catch(err => {
          try { alert(`Credential repair failed: ${err?.message || err}`); } catch { }
        });
      });
      actionWrap.appendChild(btn);
      body.appendChild(actionWrap);
    }
    const modalEl = document.getElementById('actionSummaryModal');
    if (outputsZipInfos.length) {
      outputsZipInfos.forEach((archiveInfo, archiveIndex) => {
        try {
          const base64 = archiveInfo.base64;
          const binary = atob(base64);
          const len = binary.length;
          const bytes = new Uint8Array(len);
          for (let i = 0; i < len; i += 1) {
            bytes[i] = binary.charCodeAt(i);
          }
          const blob = new Blob([bytes], { type: 'application/zip' });
          const url = URL.createObjectURL(blob);
          const container = document.createElement('div');
          container.className = 'mt-3';
          const heading = document.createElement('h6');
          heading.textContent = archiveInfo.label || 'Command Outputs';
          container.appendChild(heading);
          const link = document.createElement('a');
          link.className = 'btn btn-sm btn-outline-primary';
          link.href = url;
          link.download = archiveInfo.filename || `action-output-${archiveIndex + 1}.zip`;
          const sizeLabel = formatBytes(archiveInfo.size || bytes.length);
          link.textContent = outputsZipInfos.length > 1 ? `Download ${archiveIndex + 1} (${sizeLabel})` : `Download (${sizeLabel})`;
          container.appendChild(link);
          body.appendChild(container);
          if (modalEl && window.bootstrap) {
            const cleanup = () => {
              try { URL.revokeObjectURL(url); } catch { }
              try { modalEl.removeEventListener('hidden.bs.modal', cleanup); } catch { }
            };
            modalEl.addEventListener('hidden.bs.modal', cleanup, { once: true });
          }
        } catch (err) {
          try { console.error('Failed to prepare action output download', err); } catch { }
        }
      });
    }
    if (modalEl && window.bootstrap) {
      const bs = bootstrap.Modal.getOrCreateInstance(modalEl);
      bs.show();
    }
  } catch (e) {
    // Fall back silently if the modal can't be shown
    try { console.warn('Failed to show action summary', e); } catch { }
  }
}
