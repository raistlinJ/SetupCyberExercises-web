// --- Run Mode (Local vs Remote) ---
const TOOLHUB_SETTINGS_KEY = 'toolhub.settings.v1';
const REMOTE_UI_TOOLTIP_DEFAULT = 'Disabled when app is running in remote mode.';
let _runModeRevision = 0;
let _remoteUiGuardsInstalled = false;
let _remoteUiLastBlockedAt = 0;
function _installRemoteModeGuards(){
  if (_remoteUiGuardsInstalled) return;
  _remoteUiGuardsInstalled = true;

  function _findRemoteDisabledTarget(t){
    try {
      if (!t) return null;
      if (t.closest) return t.closest('[data-remote-disable]');
    } catch {}
    return null;
  }

  function _notifyBlocked(el){
    const now = Date.now();
    if (now - _remoteUiLastBlockedAt < 800) return;
    _remoteUiLastBlockedAt = now;
    const msg = (el && el.getAttribute && el.getAttribute('data-remote-tooltip')) || REMOTE_UI_TOOLTIP_DEFAULT;
    // Best-effort: show tooltip if present on wrapper.
    try {
      const w = (el && el.parentElement && el.parentElement.dataset && el.parentElement.dataset.remoteTooltipWrapper === '1') ? el.parentElement : null;
      const tipHost = w || el;
      if (tipHost && window.bootstrap && bootstrap.Tooltip) {
        bootstrap.Tooltip.getOrCreateInstance(tipHost).show();
      }
    } catch {}
    // Best-effort: toast if available.
    try { if (typeof window.showToast === 'function') window.showToast(msg, 'warning'); } catch {}
  }

  function _blockIfRemote(ev){
    try {
      if (!isRemote()) return;
      const el = _findRemoteDisabledTarget(ev.target);
      if (!el) return;
      ev.preventDefault();
      ev.stopPropagation();
      try { ev.stopImmediatePropagation(); } catch {}
      _notifyBlocked(el);
      return false;
    } catch {}
  }

  document.addEventListener('click', _blockIfRemote, true);
  document.addEventListener('submit', _blockIfRemote, true);
  document.addEventListener('keydown', (ev) => {
    try {
      if (!isRemote()) return;
      // Prevent keyboard activation of disabled controls.
      if (ev.key !== 'Enter' && ev.key !== ' ') return;
      const el = _findRemoteDisabledTarget(ev.target);
      if (!el) return;
      ev.preventDefault();
      ev.stopPropagation();
      try { ev.stopImmediatePropagation(); } catch {}
      _notifyBlocked(el);
    } catch {}
  }, true);
}
function readToolhubSettings(){
  try { return JSON.parse(localStorage.getItem(TOOLHUB_SETTINGS_KEY) || '{}') || {}; } catch { return {}; }
}
function writeToolhubSettings(s){
  try { localStorage.setItem(TOOLHUB_SETTINGS_KEY, JSON.stringify(s || {})); } catch {}
}
function applyTheme() {
  try {
    const raw = localStorage.getItem('toolhub.uiSettings.v2');
    let s = {};
    if (raw) {
      s = JSON.parse(raw);
    } else {
      s = JSON.parse(localStorage.getItem('toolhub.settings.v1') || '{}') || {};
    }
    if (s.hackerTheme !== false) {
      document.documentElement.setAttribute('data-bs-theme', 'dark');
    } else {
      document.documentElement.setAttribute('data-bs-theme', 'light');
    }
  } catch {}
}
applyTheme();
document.addEventListener('settings-changed', applyTheme);
function getRunMode(){
  try {
    const s = readToolhubSettings();
    return (s && s.runMode === 'remote') ? 'remote' : 'local';
  } catch {
    return 'local';
  }
}
function isRemote(){ return getRunMode() === 'remote'; }

function _setRunModeLocal(normalized, emitEvent){
  const mode = (String(normalized || '').toLowerCase() === 'remote') ? 'remote' : 'local';
  _runModeRevision++;
  const s = readToolhubSettings();
  if (mode === 'local') delete s.runMode;
  else s.runMode = 'remote';
  writeToolhubSettings(s);
  if (emitEvent) {
    try { document.dispatchEvent(new CustomEvent('run-mode-changed', { detail: { mode } })); } catch {}
  }
  try { applyRemoteModeUI(); } catch {}
  return mode;
}

let _serverRunModeLoaded = false;
let _serverRunModePromise = null;
async function loadRunModeFromServer(){
  if (_serverRunModeLoaded) return getRunMode();
  if (_serverRunModePromise) return _serverRunModePromise;
  _serverRunModePromise = (async()=>{
    const startRev = _runModeRevision;
    try {
      const res = await fetch('/api/runtime', { method: 'GET', credentials: 'same-origin' });
      if (!res.ok) throw new Error('runtime fetch failed');
      const data = await res.json();
      const mode = (data && data.runMode === 'remote') ? 'remote' : 'local';
      // Avoid clobbering a user toggle that happened while this request was in-flight.
      if (_runModeRevision === startRev) {
        _setRunModeLocal(mode, false);
      }
    } catch {
      // Best-effort; fall back to local storage default.
    } finally {
      _serverRunModeLoaded = true;
    }
    return getRunMode();
  })();
  return _serverRunModePromise;
}

async function persistRunModeToServer(mode){
  const normalized = (String(mode || '').toLowerCase() === 'remote') ? 'remote' : 'local';
  try {
    const res = await fetch('/api/runtime', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      keepalive: true,
      body: JSON.stringify({ runMode: normalized })
    });
    if (!res.ok) {
      let detail = '';
      try { detail = (await res.text()) || ''; } catch {}
      return { ok: false, status: res.status || 0, detail };
    }
    const data = await res.json().catch(()=>null);
    const ok = !!(data && data.ok && (data.runMode === 'remote' || data.runMode === 'local'));
    return { ok, status: res.status || 200, mode: normalized, data };
  } catch (e) {
    return { ok: false, status: 0, detail: (e && e.message) ? e.message : String(e || '') };
  }
}

function setRunMode(mode){
  const normalized = _setRunModeLocal(mode, true);
  // Best-effort: persist on server so it survives reboots.
  try { persistRunModeToServer(normalized).then(()=>{}); } catch {}
  _serverRunModeLoaded = true; // don't immediately overwrite with stale server value
  return normalized;
}

async function setRunModeAsync(mode){
  const normalized = _setRunModeLocal(mode, true);
  const result = await persistRunModeToServer(normalized);
  _serverRunModeLoaded = true;
  return { ok: !!result?.ok, mode: normalized, status: result?.status || 0, detail: result?.detail || '' };
}

function _remoteUiEnsureWrapper(el){
  try {
    const p = el.parentElement;
    if (p && p.dataset && p.dataset.remoteTooltipWrapper === '1') return p;
    const w = document.createElement('span');
    w.dataset.remoteTooltipWrapper = '1';
    // Keep inline layout stable for buttons/links.
    w.className = 'd-inline-block';
    el.parentNode.insertBefore(w, el);
    w.appendChild(el);
    return w;
  } catch {
    return null;
  }
}

function _remoteUiSetDisabled(el, disabled, tooltipText){
  const tip = tooltipText || el.getAttribute('data-remote-tooltip') || REMOTE_UI_TOOLTIP_DEFAULT;
  try {
    if (disabled) {
      if (!el.dataset.remoteOrigClass) el.dataset.remoteOrigClass = el.className || '';
      if (el.tagName === 'A') {
        if (!el.dataset.remoteOrigHref) el.dataset.remoteOrigHref = el.getAttribute('href') || '';
        el.setAttribute('href', '#');
        el.setAttribute('aria-disabled', 'true');
        el.setAttribute('tabindex', '-1');
        el.classList.add('disabled');
      }
      // Generic visual mute + interaction block.
      el.style.pointerEvents = 'none';
      el.style.opacity = '0.65';
      // Form controls.
      if ('disabled' in el) el.disabled = true;
      // Labels (file inputs): disable nested input too.
      try { el.querySelectorAll('input,button,select,textarea').forEach(x => { try { x.disabled = true; } catch {} }); } catch {}

      const w = _remoteUiEnsureWrapper(el);
      if (w) {
        w.setAttribute('data-bs-toggle', 'tooltip');
        w.setAttribute('data-bs-placement', 'top');
        w.setAttribute('title', tip);
        w.style.cursor = 'not-allowed';
        try {
          if (window.bootstrap && bootstrap.Tooltip) {
            bootstrap.Tooltip.getOrCreateInstance(w);
          }
        } catch {}
      }
    } else {
      // Restore.
      try { el.style.pointerEvents = ''; el.style.opacity = ''; } catch {}
      if ('disabled' in el) el.disabled = false;
      if (el.tagName === 'A') {
        const orig = el.dataset.remoteOrigHref || '';
        if (orig) el.setAttribute('href', orig);
        else el.removeAttribute('href');
        el.removeAttribute('aria-disabled');
        el.removeAttribute('tabindex');
        el.classList.remove('disabled');
      }
      try {
        const cls = el.dataset.remoteOrigClass;
        if (cls !== undefined) el.className = cls;
      } catch {}
      // Allow nested form controls again.
      try { el.querySelectorAll('input,button,select,textarea').forEach(x => { try { x.disabled = false; } catch {} }); } catch {}
      // Remove tooltip from wrapper if present.
      try {
        const p = el.parentElement;
        if (p && p.dataset && p.dataset.remoteTooltipWrapper === '1') {
          try {
            if (window.bootstrap && bootstrap.Tooltip) {
              const inst = bootstrap.Tooltip.getInstance(p);
              if (inst) inst.dispose();
            }
          } catch {}
          p.removeAttribute('data-bs-toggle');
          p.removeAttribute('data-bs-placement');
          p.removeAttribute('title');
          p.style.cursor = '';
        }
      } catch {}
    }
  } catch {}
}

function applyRemoteModeUI(root){
  const host = root || document;
  const remote = isRemote();
  try {
    host.querySelectorAll('[data-remote-disable]')
      .forEach(el => _remoteUiSetDisabled(el, remote, el.getAttribute('data-remote-tooltip') || REMOTE_UI_TOOLTIP_DEFAULT));
  } catch {}
  // If audio is disabled, ensure Settings is not stuck on Notifications tab.
  if (remote) {
    try {
      const notifTab = document.getElementById('settings-tab-notifications');
      if (notifTab && notifTab.classList.contains('active')) {
        const generalTab = document.getElementById('settings-tab-general');
        if (generalTab) generalTab.click();
      }
    } catch {}
  }
}
// Shared shell for sidebar project list and cross-page sync
const CURRENT_PROJECT_KEY = 'toolhub.currentProjectId.v1';
const SIDEBAR_COLLAPSE_KEY = 'toolhub.sidebarCollapsed.v1';

function readSidebarCollapsedFromStorage() {
  try {
    const raw = localStorage.getItem(SIDEBAR_COLLAPSE_KEY);
    if (raw === '1' || raw === 'true') return true;
    if (raw === '0' || raw === 'false') return false;
  } catch {}
  return false;
}

let _sidebarCollapsed = readSidebarCollapsedFromStorage();
let _sidebarBoundsCache = null;
let _toggleWidthCache = null;
let _toggleHeightCache = null;
let _toggleAnchorYCache = null;

function isSidebarCollapsed() {
  return !!_sidebarCollapsed;
}

function updateSidebarToggleLabel() {
  const btn = document.querySelector('[data-shell-sidebar-toggle]');
  if (!btn) return;
  const collapsed = !!_sidebarCollapsed;
  const expanded = collapsed ? 'false' : 'true';
  btn.setAttribute('aria-expanded', expanded);
  btn.setAttribute('aria-label', collapsed ? 'Show projects sidebar' : 'Hide projects sidebar');
  btn.setAttribute('title', collapsed ? 'Show projects sidebar' : 'Hide projects sidebar');
  btn.innerHTML = '';
  const icon = document.createElement('span');
  icon.className = 'icon';
  icon.innerHTML = collapsed ? '&rsaquo;' : '&lsaquo;';
  btn.appendChild(icon);
}

function positionSidebarToggle() {
  const btn = document.querySelector('[data-shell-sidebar-toggle]');
  const sidebar = document.querySelector('.shell-container .shell-sidebar');
  if (!btn) return;
  const wrapper = sidebar ? sidebar.parentElement : document.querySelector('.shell-container .row');
  if (wrapper && window.getComputedStyle(wrapper).position === 'static') {
    wrapper.style.position = 'relative';
  }
  const wrapperRect = wrapper ? wrapper.getBoundingClientRect() : null;
  const btnWidth = btn.offsetWidth || _toggleWidthCache || 16;
  if (btnWidth > 0) _toggleWidthCache = btnWidth;
  const btnHeight = btn.offsetHeight || _toggleHeightCache || 26;
  if (btnHeight > 0) _toggleHeightCache = btnHeight;
  const importSection = sidebar ? (() => {
    const blocks = sidebar.querySelectorAll('.border-bottom');
    return blocks.length > 1 ? blocks[1] : null;
  })() : null;
  const importRect = importSection ? importSection.getBoundingClientRect() : null;

  let seamOffset = 16;
  if (wrapperRect) {
    if (!_sidebarCollapsed && sidebar) {
      const rect = sidebar.getBoundingClientRect();
      if (rect && rect.width > 0) {
        seamOffset = rect.right - wrapperRect.left;
        _sidebarBoundsCache = { seamLeft: seamOffset };
      }
    } else if (_sidebarCollapsed) {
      const content = document.querySelector('.shell-container .shell-content');
      if (content) {
        const rect = content.getBoundingClientRect();
        seamOffset = rect.left - wrapperRect.left;
      }
    } else if (_sidebarBoundsCache && typeof _sidebarBoundsCache.seamLeft === 'number') {
      seamOffset = _sidebarBoundsCache.seamLeft;
    }
  }

  let anchorOffset = null;
  if (wrapperRect) {
    if (!_sidebarCollapsed) {
      const navTabs = document.querySelector('.shell-content .nav');
      const navRect = navTabs ? navTabs.getBoundingClientRect() : null;
      const topSection = sidebar ? sidebar.querySelector('.border-bottom') : null;
      const topRect = topSection ? topSection.getBoundingClientRect() : null;
      let anchorAbs = null;
      if (importRect && importRect.height > 0) {
        anchorAbs = importRect.top + importRect.height / 2;
      }
      if (anchorAbs == null && topRect && navRect) {
        anchorAbs = topRect.bottom + (navRect.top - topRect.bottom) / 2;
      }
      if (anchorAbs == null && navRect) {
        anchorAbs = navRect.top + navRect.height / 2;
      }
      if (anchorAbs == null && topRect) {
        anchorAbs = topRect.bottom;
      }
      if (anchorAbs != null) {
        anchorOffset = anchorAbs - wrapperRect.top;
      }
    }
  }
  if (anchorOffset != null) {
    _toggleAnchorYCache = anchorOffset;
  } else if (_toggleAnchorYCache != null) {
    anchorOffset = _toggleAnchorYCache;
  } else if (wrapperRect) {
    const navTabs = document.querySelector('.shell-content .nav');
    const navRect = navTabs ? navTabs.getBoundingClientRect() : null;
    if (navRect) {
      anchorOffset = navRect.top + navRect.height / 2 - wrapperRect.top;
    }
  }

  let leftPx = seamOffset;
  leftPx = Math.max(leftPx, 0);
  const topPx = Math.max((anchorOffset != null ? anchorOffset - Math.floor(btnHeight / 2) : 16), 0);

  btn.style.left = `${leftPx}px`;
  btn.style.top = `${topPx}px`;
  btn.style.opacity = '1';
}

function applySidebarCollapseState(collapsed) {
  const prev = _sidebarCollapsed;
  _sidebarCollapsed = !!collapsed;
  try {
    const container = document.querySelector('.shell-container');
    if (container) container.classList.toggle('sidebar-collapsed', _sidebarCollapsed);
  } catch {}
  try {
    const body = document.body;
    if (body) body.classList.toggle('sidebar-collapsed', _sidebarCollapsed);
  } catch {}
  const sidebar = document.querySelector('.shell-container .shell-sidebar');
  const wrapper = sidebar ? sidebar.parentElement : document.querySelector('.shell-container .row');
  const wrapperRect = wrapper ? wrapper.getBoundingClientRect() : null;
  if (!_sidebarCollapsed) {
    if (sidebar && wrapperRect) {
      const rect = sidebar.getBoundingClientRect();
      if (rect) {
        _sidebarBoundsCache = { seamLeft: rect.right - wrapperRect.left };
      }
    }
    if (wrapperRect) {
      const blocks = sidebar ? sidebar.querySelectorAll('.border-bottom') : null;
      const importSection = blocks && blocks.length > 1 ? blocks[1] : null;
      const importRect = importSection ? importSection.getBoundingClientRect() : null;
      const topSection = blocks && blocks.length ? blocks[0] : null;
      const topRect = topSection ? topSection.getBoundingClientRect() : null;
      const navTabs = document.querySelector('.shell-content .nav');
      const navRect = navTabs ? navTabs.getBoundingClientRect() : null;
      let anchorAbs = null;
      if (importRect && importRect.height > 0) {
        anchorAbs = importRect.top + importRect.height / 2;
      }
      if (anchorAbs == null && topRect && navRect) {
        anchorAbs = topRect.bottom + (navRect.top - topRect.bottom) / 2;
      }
      if (anchorAbs == null && navRect) {
        anchorAbs = navRect.top + navRect.height / 2;
      }
      if (anchorAbs == null && topRect) {
        anchorAbs = topRect.bottom;
      }
      if (anchorAbs != null) {
        _toggleAnchorYCache = anchorAbs - wrapperRect.top;
      }
    }
  } else {
    if (wrapperRect) {
      const content = document.querySelector('.shell-container .shell-content');
      if (content) {
        const contentRect = content.getBoundingClientRect();
        if (contentRect) {
          _sidebarBoundsCache = { seamLeft: contentRect.left - wrapperRect.left };
        }
      }
      // keep existing anchor cache when collapsed to avoid vertical drift
    }
  }
  updateSidebarToggleLabel();
  positionSidebarToggle();
}

function setSidebarCollapsed(collapsed) {
  const flag = !!collapsed;
  try { localStorage.setItem(SIDEBAR_COLLAPSE_KEY, flag ? '1' : '0'); } catch {}
  applySidebarCollapseState(flag);
}

function toggleSidebar() {
  setSidebarCollapsed(!_sidebarCollapsed);
}

function setSidebarImportBusy(flag) {
  const input = document.getElementById('import-file');
  if (!input) return;
  const label = input.closest('label');
  if (flag) {
    if (!input.dataset.shellImportPrevDisabled) {
      input.dataset.shellImportPrevDisabled = input.disabled ? '1' : '0';
    }
    input.disabled = true;
  } else {
    const prev = input.dataset.shellImportPrevDisabled;
    input.disabled = prev === '1';
    delete input.dataset.shellImportPrevDisabled;
  }
  if (label) {
    label.classList.toggle('disabled', !!flag);
    if (flag) label.setAttribute('aria-disabled', 'true'); else label.removeAttribute('aria-disabled');
    label.style.pointerEvents = flag ? 'none' : '';
    label.style.opacity = flag ? '0.65' : '';
  }
}

function ensureSidebarToggleControl() {
  const sidebar = document.querySelector('.shell-container .shell-sidebar');
  if (!sidebar || !sidebar.parentElement) return;
  const wrapper = sidebar.parentElement;
  if (wrapper && window.getComputedStyle(wrapper).position === 'static') {
    wrapper.style.position = 'relative';
  }
  let btn = document.querySelector('[data-shell-sidebar-toggle]');
  if (!btn) {
    btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn-sm sidebar-toggle-btn';
    btn.setAttribute('data-shell-sidebar-toggle', 'true');
    btn.addEventListener('click', (ev) => {
      ev.preventDefault();
      toggleSidebar();
    });
  }
  if (!btn.parentElement) {
    wrapper.insertBefore(btn, sidebar.nextSibling);
  }
  updateSidebarToggleLabel();
  positionSidebarToggle();
}

function getCurrentProjectId() {
  try { return localStorage.getItem(CURRENT_PROJECT_KEY) || ''; } catch { return ''; }
}
function setCurrentProjectId(id) {
  const pid = String(id || '').trim();
  try {
    if (pid) localStorage.setItem(CURRENT_PROJECT_KEY, pid);
  } catch {}
  document.dispatchEvent(new CustomEvent('project-selected', { detail: pid }));
}

async function fetchProjects() {
  const res = await fetch('/api/projects');
  if (!res.ok) throw new Error('Failed to load projects');
  const data = await res.json();
  const list = Array.isArray(data.projects) ? data.projects : [];
  return list.map(p => {
    if (!p || typeof p !== 'object') return p;
    return { ...p, id: String(p.id ?? '').trim() };
  });
}

function updateTopLinks(pid) {
  try {
    const links = document.querySelectorAll('[data-shell-link]');
    links.forEach(a => {
      const base = a.getAttribute('href').split('?')[0];
      const url = new URL(base, window.location.origin);
      if (pid) url.searchParams.set('id', pid);
      a.setAttribute('href', url.pathname + url.search);
    });
  } catch {}
}

async function renderSidebarProjects(activeTab) {
  const host = document.getElementById('sidebar-projects');
  if (!host) return;
  host.innerHTML = '<div class="text-muted small p-2">Loading projects...</div>';
  let list = [];
  try { list = await fetchProjects(); } catch (e) {
    host.innerHTML = `<div class="text-danger small p-2">${e.message}</div>`; return;
  }
  const current = getCurrentProjectId();
  let html = '';
  html += '<div class="d-flex align-items-center justify-content-between px-2 py-2 border-bottom">'
       +  '<strong>Projects</strong>'
       +  '</div>';
  html += '<div class="list-group list-group-flush" style="max-height: calc(100vh - 160px); overflow:auto">';
  if (!list.length) {
    html += '<div class="p-2 text-muted small">No projects yet.</div>';
  } else {
    for (const p of list) {
      const active = p.id === current ? 'active' : '';
      const inst = Number(p.instances || 0);
      const tag = String(p.tag || '');
      html += `<button class="list-group-item list-group-item-action ${active}" data-pid="${p.id}">`
           +  `<div class="d-flex justify-content-between align-items-center">`
           +  `<span class="text-truncate" title="${p.name}">${escapeHtml(p.name)}</span>`
           +  `<span class="badge bg-secondary ms-2" title="Instances">${inst}</span>`
           +  `</div>`
           +  `<div class="small text-muted text-truncate" title="Tag">${escapeHtml(tag)}</div>`
           +  `</button>`;
    }
  }
  html += '</div>';
  host.innerHTML = html;
  host.querySelectorAll('button.list-group-item').forEach(btn => {
    btn.addEventListener('click', () => {
      const pid = btn.getAttribute('data-pid');
      setCurrentProjectId(pid);
      updateTopLinks(pid);
      // Visual active state toggle
      host.querySelectorAll('button.list-group-item').forEach(b => b.classList.toggle('active', b===btn));
    });
  });
  updateTopLinks(current);
  positionSidebarToggle();
}

function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;','\'':'&#39;'}[c])); }

async function initShell(activeTab) {
  try { _installRemoteModeGuards(); } catch {}
  ensureSidebarToggleControl();
  applySidebarCollapseState(_sidebarCollapsed);
  await renderSidebarProjects(activeTab);
  updateSidebarToggleLabel();
  positionSidebarToggle();
  try { await loadRunModeFromServer(); } catch {}
  try { applyRemoteModeUI(); } catch {}
  // If a query ?id= is present, prefer that and set current
  const u = new URL(window.location.href);
  const qid = u.searchParams.get('id');
  if (qid) setCurrentProjectId(qid);
  else if (getCurrentProjectId()) document.dispatchEvent(new CustomEvent('project-selected', { detail: getCurrentProjectId() }));
}

async function refreshSidebar(activeTab) {
  try { _installRemoteModeGuards(); } catch {}
  await renderSidebarProjects(activeTab);
  ensureSidebarToggleControl();
  applySidebarCollapseState(_sidebarCollapsed);
  updateSidebarToggleLabel();
  positionSidebarToggle();
  try { await loadRunModeFromServer(); } catch {}
  try { applyRemoteModeUI(); } catch {}
}

// --- Shared Remote Action Queue (global across pages) ---
const REMOTE_ACTION_QUEUE = [];
const REMOTE_QUEUE_LABELS = new Set();
const REMOTE_PROJECT_LOCKS = new Set();
const REMOTE_COMPLETED_ITEMS = [];
const REMOTE_COMPLETED_LIMIT = 50;
const REMOTE_ACTIVE_ENTRIES = [];
let REMOTE_ACTIVE_EXCLUSIVE_COUNT = 0;
let REMOTE_ACTION_SEQ = 0;
const REMOTE_QUEUE_STORE_KEY = 'toolhub.remoteQueue.state.v2';
const REMOTE_QUEUE_ABORT_KEY = 'toolhub.remoteQueue.abort.v2';
const REMOTE_QUEUE_HANDLERS = new Map();
const REMOTE_QUEUE_BACKLOG = new Map();
let REMOTE_QUEUE_RESTORING = false;

function _remoteQueue_storage(){
  try { return window.sessionStorage; } catch { return null; }
}

function _remoteQueue_clone(data){
  if (data === undefined) return undefined;
  try { return JSON.parse(JSON.stringify(data)); } catch { return null; }
}

function _remoteQueue_serializeTask(entry, status){
  if (!entry) return null;
  const persist = entry.persist && entry.persist.key ? { key: entry.persist.key, data: entry.persist.data, token: entry.persist.token || entry.persistToken } : null;
  return {
    token: entry.persistToken || (persist && persist.token) || `task-${entry.id}`,
    label: entry.label,
    projectId: entry.projectId || '',
    dedupeKey: entry.key || null,
    persist,
    createdAt: entry.createdAt || Date.now(),
    status: status || 'queued',
    exclusive: entry.exclusive !== false,
    lockProject: entry.lockProject !== false,
    dedupeWhileActive: !!entry.dedupeWhileActive,
  };
}

function _remoteQueue_saveState(){
  if (REMOTE_QUEUE_RESTORING) return;
  const store = _remoteQueue_storage();
  if (!store) return;
  try {
    const active = REMOTE_ACTIVE_ENTRIES.map(it => _remoteQueue_serializeTask(it, 'active')).filter(Boolean);
    const items = REMOTE_ACTION_QUEUE.map(it => _remoteQueue_serializeTask(it, 'queued')).filter(Boolean);
    const completed = REMOTE_COMPLETED_ITEMS.map(item => ({ ...item }));
    if (!active.length && !items.length && !completed.length) {
      store.removeItem(REMOTE_QUEUE_STORE_KEY);
      return;
    }
    const payload = { seq: REMOTE_ACTION_SEQ, active, items, completed, ts: Date.now() };
    store.setItem(REMOTE_QUEUE_STORE_KEY, JSON.stringify(payload));
  } catch {}
}

function _remoteQueue_scheduleRestoredEntry(saved){
  if (!saved || !saved.persist || !saved.persist.key) return;
  const key = saved.persist.key;
  const builder = REMOTE_QUEUE_HANDLERS.get(key);
  if (!builder) {
    const back = REMOTE_QUEUE_BACKLOG.get(key) || [];
    back.push(saved);
    REMOTE_QUEUE_BACKLOG.set(key, back);
    return;
  }
  try {
    const fn = builder(saved.persist.data, saved) || null;
    if (typeof fn !== 'function') {
      try { logWarn ? logWarn(`[QUEUE] Persist handler for ${key} returned no function, skipping restore.`) : console.warn('Queue restore skipped for', key); } catch {}
      return;
    }
    REMOTE_QUEUE_RESTORING = true;
    const restoreOptions = {
      projectId: saved.projectId,
      allowDuplicate: true,
      dedupeKey: saved.dedupeKey,
      persist: saved.persist,
      persistToken: saved.token,
    };
  if (saved.exclusive !== undefined) restoreOptions.exclusive = !!saved.exclusive;
  if (saved.lockProject !== undefined) restoreOptions.lockProject = !!saved.lockProject;
  if (saved.dedupeWhileActive !== undefined) restoreOptions.dedupeWhileActive = !!saved.dedupeWhileActive;
    queueRemoteAction(saved.label || 'Action', fn, restoreOptions);
  } catch (err) {
    try { logError ? logError(`[QUEUE] Failed to restore ${saved.label || saved.persist.key}: ${err?.message || err}`) : console.error('Queue restore failed', err); } catch {}
  } finally {
    REMOTE_QUEUE_RESTORING = false;
    _remoteQueue_saveState();
  }
}

function _remoteQueue_restoreFromStorage(){
  const store = _remoteQueue_storage();
  if (!store) return;
  let raw;
  try { raw = store.getItem(REMOTE_QUEUE_STORE_KEY); } catch { raw = null; }
  if (!raw) return;
  let data;
  try { data = JSON.parse(raw); } catch { return; }
  const pending = [];
  if (Array.isArray(data.active)) pending.push(...data.active);
  else if (data.active) pending.push(data.active);
  if (Array.isArray(data.items)) pending.push(...data.items);
  pending.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  pending.forEach(item => _remoteQueue_scheduleRestoredEntry(item));
  try {
    REMOTE_COMPLETED_ITEMS.length = 0;
    if (Array.isArray(data.completed)) {
      data.completed.forEach(entry => {
        if (!entry) return;
        const finished = Number(entry.finishedAt);
        const started = Number(entry.startedAt);
        const duration = Number(entry.durationMs);
        REMOTE_COMPLETED_ITEMS.push({
          id: Number(entry.id) || 0,
          label: entry.label != null ? String(entry.label) : '',
          projectId: entry.projectId != null ? String(entry.projectId) : '',
          status: entry.status ? String(entry.status) : 'success',
          finishedAt: Number.isFinite(finished) ? finished : Date.now(),
          startedAt: Number.isFinite(started) ? started : null,
          durationMs: Number.isFinite(duration) ? duration : null,
          errorMessage: entry.errorMessage ? String(entry.errorMessage) : '',
          cancelRequested: !!entry.cancelRequested,
        });
      });
    }
    if (REMOTE_COMPLETED_ITEMS.length > REMOTE_COMPLETED_LIMIT) {
      REMOTE_COMPLETED_ITEMS.splice(REMOTE_COMPLETED_LIMIT);
    }
  } catch {}
  _remoteQueue_emit();
}

function _remoteQueue_collectVolatile(){
  const list = [];
  REMOTE_ACTIVE_ENTRIES.forEach(entry => {
    if (entry && (!entry.persist || !entry.persist.key)) {
      list.push(_remoteQueue_serializeTask(entry, 'active'));
    }
  });
  REMOTE_ACTION_QUEUE.forEach(entry => {
    if (entry && (!entry.persist || !entry.persist.key)) {
      list.push(_remoteQueue_serializeTask(entry, 'queued'));
    }
  });
  return list.filter(Boolean);
}

function _remoteQueue_recordCompleted(task, status, error){
  if (!task) return;
  const finishedAt = Date.now();
  const startedAt = Number(task.startedAt);
  const durationMs = Number.isFinite(startedAt) ? Math.max(0, finishedAt - startedAt) : null;
  const normalized = {
    id: Number(task.id) || 0,
    label: task.label != null ? String(task.label) : '',
    projectId: task.projectId != null ? String(task.projectId) : '',
  status: status || 'completed',
    finishedAt,
    startedAt: Number.isFinite(startedAt) ? startedAt : null,
    durationMs,
    errorMessage: error ? String(error?.message || error) : '',
    cancelRequested: !!task.cancelRequested,
  };
  REMOTE_COMPLETED_ITEMS.unshift(normalized);
  if (REMOTE_COMPLETED_ITEMS.length > REMOTE_COMPLETED_LIMIT) {
    REMOTE_COMPLETED_ITEMS.splice(REMOTE_COMPLETED_LIMIT);
  }
  _remoteQueue_saveState();
  _remoteQueue_emit();
}

function _remoteQueue_checkForAbortNotice(){
  const store = _remoteQueue_storage();
  if (!store) return;
  let raw;
  try { raw = store.getItem(REMOTE_QUEUE_ABORT_KEY); } catch { raw = null; }
  if (!raw) return;
  try {
    const data = JSON.parse(raw);
    const count = Array.isArray(data?.volatile) ? data.volatile.length : 0;
    if (count > 0) {
      const msg = `[QUEUE] ${count} queued action${count===1?' was':'s were'} cancelled during navigation.`;
      try { logWarn ? logWarn(msg) : console.warn(msg); } catch {}
    }
  } catch {}
  try { store.removeItem(REMOTE_QUEUE_ABORT_KEY); } catch {}
}

function _remoteQueue_hasVolatileTasks(){
  for (const entry of REMOTE_ACTIVE_ENTRIES) {
    if (entry && (!entry.persist || !entry.persist.key)) return true;
  }
  for (const entry of REMOTE_ACTION_QUEUE) {
    if (entry && (!entry.persist || !entry.persist.key)) return true;
  }
  return false;
}

function registerRemoteActionHandler(key, builder){
  if (!key || typeof builder !== 'function') return;
  REMOTE_QUEUE_HANDLERS.set(key, builder);
  const pending = REMOTE_QUEUE_BACKLOG.get(key);
  if (Array.isArray(pending) && pending.length) {
    REMOTE_QUEUE_BACKLOG.delete(key);
    pending.forEach(item => _remoteQueue_scheduleRestoredEntry(item));
  }
}

function makeHttpPersist(method, url, body, opts){
  const kind = 'http';
  if (!method || !url) return null;
  if (typeof FormData !== 'undefined' && body instanceof FormData) return null;
  const data = {
    method: String(method || 'GET').toUpperCase(),
    url: String(url || ''),
    expect: opts && opts.expect ? String(opts.expect) : 'json',
    credentials: opts && opts.credentials ? String(opts.credentials) : 'same-origin',
  };
  if (opts && opts.headers) data.headers = { ...opts.headers };
  if (body !== undefined) data.body = _remoteQueue_clone(body);
  return { key: kind, data };
}

registerRemoteActionHandler('http', (data) => {
  if (!data || !data.url) return null;
  const method = String(data.method || 'GET').toUpperCase();
  const url = String(data.url);
  const expect = String(data.expect || 'json').toLowerCase();
  const headers = (data.headers && typeof data.headers === 'object') ? { ...data.headers } : {};
  const credentials = data.credentials || 'same-origin';
  const body = data.body;
  return async () => {
    const opts = { method, headers: { ...headers }, credentials };
    const headerKeys = Object.keys(opts.headers).map(k => k.toLowerCase());
    if (body !== undefined && method !== 'GET' && method !== 'HEAD') {
      if (body !== null && typeof body === 'object') {
        if (!headerKeys.includes('content-type')) opts.headers['Content-Type'] = 'application/json';
        opts.body = JSON.stringify(body);
      } else {
        opts.body = body;
      }
    }
    const res = await fetch(url, opts);
    if (!res.ok) {
      let errText = '';
      try { errText = await res.text(); } catch {}
      throw new Error(errText || res.statusText || `HTTP ${res.status}`);
    }
    if (expect === 'json') {
      try { await res.json(); } catch {}
    } else if (expect === 'text') {
      try { await res.text(); } catch {}
    }
  };
});

function canonicalPid(value) { return String(value ?? '').trim(); }

function queueRemoteAction(label, fn, options) {
  const opts = options || {};
  const entryLabel = String(label || 'Action');
  const dedupeKeyBase = opts.dedupeKey ? String(opts.dedupeKey) : entryLabel;
  const dedupeKey = opts.allowDuplicate ? null : (dedupeKeyBase.trim().toLowerCase() || dedupeKeyBase);
  if (dedupeKey && REMOTE_QUEUE_LABELS.has(dedupeKey)) {
    try { logInfo ? logInfo(`[QUEUE] Already queued: ${entryLabel}`) : console.info('[QUEUE] Already queued:', entryLabel); } catch {}
    return null;
  }
  const persistOpt = opts.persist || (opts.persistKey ? { key: opts.persistKey, data: opts.persistData } : null);
  const persistToken = opts.persistToken || (persistOpt ? `persist-${Date.now()}-${Math.random().toString(16).slice(2)}` : null);
  const projectId = canonicalPid(opts.projectId);
  const exclusive = opts.exclusive !== false;
  const lockProject = opts.lockProject !== undefined ? !!opts.lockProject : exclusive;
  const dedupeWhileActive = !!opts.dedupeWhileActive;
  const task = {
    id: ++REMOTE_ACTION_SEQ,
    label: entryLabel,
    fn: typeof fn === 'function' ? fn : async ()=>{},
    key: dedupeKey,
    projectId,
    onCancel: typeof opts.onCancel === 'function' ? opts.onCancel : null,
    cancelRequested: false,
    persist: persistOpt && persistOpt.key ? { key: persistOpt.key, data: persistOpt.data, token: persistToken } : null,
    persistToken,
    createdAt: Date.now(),
    exclusive,
    lockProject,
    dedupeWhileActive,
  };
  REMOTE_ACTION_QUEUE.push(task);
  if (dedupeKey) REMOTE_QUEUE_LABELS.add(dedupeKey);
  _remoteQueue_log();
  _remoteQueue_process();
  _remoteQueue_saveState();
  return task;
}

function runQueued(label, fn, options){
  const opts = options || {};
  return new Promise((resolve) => {
    const entry = queueRemoteAction(label, async () => {
      try { await Promise.resolve(fn && fn()); }
      catch (e) { throw e; }
      finally { try { resolve({ status: 'completed' }); } catch {} }
    }, {
      projectId: opts.projectId,
      dedupeKey: opts.dedupeKey,
      allowDuplicate: opts.allowDuplicate,
      persist: opts.persist,
      persistKey: opts.persistKey,
      persistData: opts.persistData,
      persistToken: opts.persistToken,
      exclusive: opts.exclusive,
      lockProject: opts.lockProject,
      dedupeWhileActive: opts.dedupeWhileActive,
      onCancel: () => { try { resolve({ status: 'canceled' }); } catch {} },
    });
    if (!entry) { try { resolve({ status: 'skipped' }); } catch {} }
  });
}

function cancelRemoteAction(id) {
  const targetId = Number(id);
  if (!Number.isFinite(targetId)) return false;
  // Pending entries
  for (let i = 0; i < REMOTE_ACTION_QUEUE.length; i += 1) {
    const entry = REMOTE_ACTION_QUEUE[i];
    if (entry && entry.id === targetId) {
      REMOTE_ACTION_QUEUE.splice(i, 1);
      if (entry.key) REMOTE_QUEUE_LABELS.delete(entry.key);
      try { entry.onCancel && entry.onCancel(); } catch {}
      _remoteQueue_log();
      _remoteQueue_emit();
      _remoteQueue_saveState();
      try { logWarn ? logWarn(`[QUEUE] Cancelled queued action: ${entry.label}`) : console.warn('Queue cancelled:', entry.label); } catch {}
      return true;
    }
  }
  // Active entry (best-effort flag)
  for (const entry of REMOTE_ACTIVE_ENTRIES) {
    if (entry && entry.id === targetId) {
      entry.cancelRequested = true;
      try { entry.onCancel && entry.onCancel(); } catch {}
      _remoteQueue_emit();
      _remoteQueue_saveState();
      return true;
    }
  }
  return false;
}

function _remoteQueue_canStart(entry){
  if (!entry) return false;
  if (entry.lockProject !== false) {
    const pid = entry.projectId;
    if (pid && REMOTE_PROJECT_LOCKS.has(pid)) return false;
  }
  if (entry.exclusive !== false && REMOTE_ACTIVE_EXCLUSIVE_COUNT > 0) return false;
  return true;
}

function _remoteQueue_start(task){
  if (!task) return;
  const releaseKeyOnStart = !task.dedupeWhileActive;
  if (task.key && releaseKeyOnStart) REMOTE_QUEUE_LABELS.delete(task.key);
  const requiresLock = task.lockProject !== false;
  if (requiresLock && task.projectId) REMOTE_PROJECT_LOCKS.add(task.projectId);
  if (task.exclusive !== false) REMOTE_ACTIVE_EXCLUSIVE_COUNT += 1;
  REMOTE_ACTIVE_ENTRIES.push(task);
  const label = task.label;
  try { window.CURRENT_ACTION_LABEL = String(label||''); } catch {}
  try { logInfo ? logInfo(`[QUEUE] Starting: ${label}`) : console.log('[QUEUE] Starting:', label); } catch {}
  _remoteQueue_emit();
  _remoteQueue_saveState();
  task.startedAt = Date.now();
  const fn = typeof task.fn === 'function' ? task.fn : async () => {};
  Promise.resolve()
    .then(() => fn())
    .then(() => {
      try { logSuccess ? logSuccess(`[QUEUE] Finished: ${label}`) : console.log('[QUEUE] Finished:', label); } catch {}
      const resolvedStatus = task.cancelRequested ? 'cancelled' : 'completed';
      _remoteQueue_recordCompleted(task, resolvedStatus);
    })
    .catch((e) => {
      try { logError ? logError(`[QUEUE] Failed: ${label} (${e && e.message ? e.message : e})`) : console.error('[QUEUE] Failed:', label, e); } catch {}
      _remoteQueue_recordCompleted(task, 'error', e);
    })
    .finally(() => {
      if (requiresLock && task.projectId) REMOTE_PROJECT_LOCKS.delete(task.projectId);
      if (task.exclusive !== false) {
        REMOTE_ACTIVE_EXCLUSIVE_COUNT = Math.max(0, REMOTE_ACTIVE_EXCLUSIVE_COUNT - 1);
      }
      if (task.key) REMOTE_QUEUE_LABELS.delete(task.key);
      const idx = REMOTE_ACTIVE_ENTRIES.indexOf(task);
      if (idx !== -1) REMOTE_ACTIVE_ENTRIES.splice(idx, 1);
      try {
        const next = REMOTE_ACTIVE_ENTRIES.length ? REMOTE_ACTIVE_ENTRIES[REMOTE_ACTIVE_ENTRIES.length - 1] : null;
        window.CURRENT_ACTION_LABEL = next ? String(next.label || '') : '';
      } catch {}
      _remoteQueue_log();
      _remoteQueue_emit();
      _remoteQueue_saveState();
      setTimeout(_remoteQueue_process, 0);
    });
}

function _remoteQueue_process(){
  if (!REMOTE_ACTION_QUEUE.length) {
    if (!REMOTE_ACTIVE_ENTRIES.length) _remoteQueue_emit();
    return;
  }
  // Remove any canceled placeholders (should be none, but defensive)
  for (let i = REMOTE_ACTION_QUEUE.length - 1; i >= 0; i -= 1) {
    const entry = REMOTE_ACTION_QUEUE[i];
    if (!entry) REMOTE_ACTION_QUEUE.splice(i, 1);
  }
  let startedAny = false;
  for (let i = 0; i < REMOTE_ACTION_QUEUE.length; i += 1) {
    const entry = REMOTE_ACTION_QUEUE[i];
    if (!entry) { REMOTE_ACTION_QUEUE.splice(i, 1); i -= 1; continue; }
    if (!_remoteQueue_canStart(entry)) continue;
    REMOTE_ACTION_QUEUE.splice(i, 1);
    _remoteQueue_start(entry);
    startedAny = true;
    i -= 1;
  }
  if (!startedAny) {
    _remoteQueue_emit();
  }
}

function _remoteQueue_log(){
  try {
    const waiting = REMOTE_ACTION_QUEUE.length;
    const activeLabels = REMOTE_ACTIVE_ENTRIES.map(a => a && a.label ? String(a.label) : '').filter(Boolean);
    const activeLines = REMOTE_ACTIVE_ENTRIES.map((a, i) => {
      if (!a) return '';
      const projSuffix = a.projectId ? ` [${a.projectId}]` : '';
      const mode = a.exclusive === false ? ' (shared)' : '';
      return `A${i+1}. ${a.label}${projSuffix}${mode}`;
    }).filter(Boolean).join('\n');
    const waitingLines = REMOTE_ACTION_QUEUE.map((a, i) => {
      if (!a) return '';
      const projSuffix = a.projectId ? ` [${a.projectId}]` : '';
      const mode = a.exclusive === false ? ' (shared)' : '';
      const locked = a.lockProject !== false && a.projectId && REMOTE_PROJECT_LOCKS.has(a.projectId) ? ' (blocked)' : '';
      return `${i+1}. ${a.label}${projSuffix}${mode}${locked}`;
    }).filter(Boolean).join('\n');
    const status = activeLabels.length
      ? `[QUEUE] Active (${activeLabels.length}) • ${waiting} waiting`
      : `[QUEUE] Idle • ${waiting} waiting`;
    let msg = status;
    if (activeLines) msg += `\n${activeLines}`;
    if (waitingLines) msg += `\n${waitingLines}`;
    if (logInfo) logInfo(msg); else console.log(msg);
  } catch {}
}

function _remoteQueue_emit(){
  try { document.dispatchEvent(new CustomEvent('remote-queue-changed')); } catch {}
}

function getRemoteQueueState(){
  try {
    const activeItems = REMOTE_ACTIVE_ENTRIES.map(it => it ? ({
      id: it.id,
      label: it.label,
      projectId: it.projectId,
      cancelRequested: !!it.cancelRequested,
      createdAt: it.createdAt,
      startedAt: it.startedAt || null,
      exclusive: it.exclusive !== false,
      lockProject: it.lockProject !== false,
    }) : null).filter(Boolean);
    return {
      active: activeItems.length > 0,
      current: activeItems.length ? activeItems[0] : null,
      activeItems,
      items: REMOTE_ACTION_QUEUE.map(it => it ? ({
        id: it.id,
        label: it.label,
        projectId: it.projectId,
        blocked: !!(it.lockProject !== false && it.projectId && REMOTE_PROJECT_LOCKS.has(it.projectId)),
        createdAt: it.createdAt,
        exclusive: it.exclusive !== false,
        lockProject: it.lockProject !== false,
      }) : null).filter(Boolean),
      completed: REMOTE_COMPLETED_ITEMS.map(item => ({
        id: item.id,
        label: item.label,
        projectId: item.projectId,
        status: item.status,
        finishedAt: item.finishedAt,
        startedAt: item.startedAt,
        durationMs: item.durationMs,
        errorMessage: item.errorMessage,
        cancelRequested: item.cancelRequested,
      })),
    };
  } catch { return { active:false, current:null, activeItems:[], items:[], completed:[] }; }
}

function clearCompletedRemoteActions(){
  if (!REMOTE_COMPLETED_ITEMS.length) return;
  REMOTE_COMPLETED_ITEMS.length = 0;
  _remoteQueue_saveState();
  _remoteQueue_emit();
}

const ACTION_PROGRESS_DEFAULT_STATE = Object.freeze({
  active: false,
  visible: false,
  title: '',
  text: '',
  percent: 0,
  barText: '',
  updatedAt: 0
});
let ACTION_PROGRESS_STATE = { ...ACTION_PROGRESS_DEFAULT_STATE };
function actionProgressEmit(){ try { document.dispatchEvent(new CustomEvent('queue-progress-updated')); } catch {} }
function hasActiveActionProgress(){ return !!ACTION_PROGRESS_STATE.active; }
function getActionProgressState(){ return { ...ACTION_PROGRESS_STATE }; }
function showActionProgress(title, text){
  const nextTitle = title || 'Working…';
  const nextText = text || '';
  const modal = document.getElementById('actionProgressModal');
  const titleEl = document.getElementById('action-progress-title');
  const textEl = document.getElementById('action-progress-text');
  const barEl = document.getElementById('action-progress-bar');
  if (titleEl) titleEl.textContent = nextTitle;
  if (textEl) textEl.textContent = nextText;
  if (barEl) {
    barEl.style.width = '20%';
    barEl.setAttribute('aria-valuenow', '20');
    barEl.textContent = nextText || 'Starting…';
    barEl.classList.add('progress-bar-striped', 'progress-bar-animated');
  }
  ACTION_PROGRESS_STATE = {
    active: true,
    visible: false,
    title: nextTitle,
    text: nextText,
    percent: 20,
    barText: nextText || 'Starting…',
    updatedAt: Date.now()
  };
  actionProgressEmit();
  try { showQueuePanel(); } catch {}
  if (modal && modal.parentElement !== document.body) {
    try { document.body.appendChild(modal); } catch {}
  }
}
function updateActionProgress(percent, label, detail){
  const textEl = document.getElementById('action-progress-text');
  const barEl = document.getElementById('action-progress-bar');
  const p = Math.max(0, Math.min(100, Number(percent) || 0));
  if (barEl) {
    barEl.style.width = `${p}%`;
    barEl.setAttribute('aria-valuenow', String(p));
    if (label !== undefined && label !== null && label !== '') {
      barEl.textContent = String(label);
    }
  }
  const message = (detail !== undefined && detail !== null && detail !== '')
    ? String(detail)
    : (label !== undefined && label !== null ? String(label) : '');
  if (textEl && message) textEl.textContent = message;
  if (ACTION_PROGRESS_STATE.active) {
    ACTION_PROGRESS_STATE.percent = p;
    if (label !== undefined) ACTION_PROGRESS_STATE.barText = (label !== null ? String(label) : '');
    if (message) ACTION_PROGRESS_STATE.text = message;
    ACTION_PROGRESS_STATE.updatedAt = Date.now();
    actionProgressEmit();
  }
}
function hideActionProgress(){
  const modal = document.getElementById('actionProgressModal');
  const barEl = document.getElementById('action-progress-bar');
  if (barEl) {
    barEl.style.width = '100%';
    barEl.textContent = 'Done';
    barEl.classList.remove('progress-bar-animated');
  }
  if (modal && window.bootstrap && window.bootstrap.Modal) {
    try {
      const bs = window.bootstrap;
      const inst = bs.Modal.getInstance(modal) || bs.Modal.getOrCreateInstance(modal);
      inst.hide();
    } catch {}
  }
  try { document.querySelectorAll('.modal-backdrop').forEach(b => b.remove()); } catch {}
  try {
    document.body.classList.remove('modal-open');
    document.body.style.removeProperty('padding-right');
    document.body.style.removeProperty('overflow');
  } catch {}
  ACTION_PROGRESS_STATE = { ...ACTION_PROGRESS_DEFAULT_STATE, updatedAt: Date.now() };
  actionProgressEmit();
}
function openActionProgressModal(){
  if (!ACTION_PROGRESS_STATE.active) return;
  const modal = document.getElementById('actionProgressModal');
  if (!modal || !window.bootstrap || !window.bootstrap.Modal) return;
  const titleEl = document.getElementById('action-progress-title');
  const textEl = document.getElementById('action-progress-text');
  const barEl = document.getElementById('action-progress-bar');
  if (titleEl) titleEl.textContent = ACTION_PROGRESS_STATE.title || 'Working…';
  if (textEl) textEl.textContent = ACTION_PROGRESS_STATE.text || '';
  if (barEl) {
    barEl.style.width = `${ACTION_PROGRESS_STATE.percent || 0}%`;
    barEl.setAttribute('aria-valuenow', String(ACTION_PROGRESS_STATE.percent || 0));
    if (ACTION_PROGRESS_STATE.barText) barEl.textContent = ACTION_PROGRESS_STATE.barText;
    barEl.classList.add('progress-bar-striped', 'progress-bar-animated');
  }
  let inst;
  try {
    const bs = window.bootstrap;
    inst = bs.Modal.getOrCreateInstance(modal);
  } catch {
    return;
  }
  ACTION_PROGRESS_STATE.visible = true;
  ACTION_PROGRESS_STATE.updatedAt = Date.now();
  actionProgressEmit();
  setTimeout(() => {
    try { inst && inst.show(); } catch {}
  }, 10);
}
document.addEventListener('hidden.bs.modal', (ev)=>{
  if (!ev || !ev.target || ev.target.id !== 'actionProgressModal') return;
  ACTION_PROGRESS_STATE.visible = false;
  ACTION_PROGRESS_STATE.updatedAt = Date.now();
  actionProgressEmit();
});
window.showActionProgress = showActionProgress;
window.updateActionProgress = updateActionProgress;
window.hideActionProgress = hideActionProgress;
window.openActionProgressModal = openActionProgressModal;
window.hasActiveActionProgress = hasActiveActionProgress;
window.getActionProgressState = getActionProgressState;

// Expose globally
try {
  window.queueRemoteAction = queueRemoteAction;
  window.runQueued = runQueued;
  window.getRemoteQueueState = getRemoteQueueState;
  window.cancelRemoteAction = cancelRemoteAction;
  window.registerRemoteActionHandler = registerRemoteActionHandler;
  window.clearCompletedRemoteActions = clearCompletedRemoteActions;
  window.makeHttpPersist = makeHttpPersist;
} catch {}

// --- Global Console Dock (persists across pages) ---
const CONS_LOG_KEY = 'toolhub.console.logs.v1';
const CONS_STATE_KEY = 'toolhub.console.state.v1';
const CONS_MAX = 2000;
const LAST_ACTION_KEY = 'toolhub.console.lastAction.v1';

function readConsoleState(){ try { return JSON.parse(localStorage.getItem(CONS_STATE_KEY)||'{}'); } catch { return {}; } }
function writeConsoleState(s){ try { localStorage.setItem(CONS_STATE_KEY, JSON.stringify(s||{})); } catch {} }
function readConsoleLogs(){ try { return JSON.parse(localStorage.getItem(CONS_LOG_KEY)||'[]'); } catch { return []; } }
function writeConsoleLogs(arr){ try { localStorage.setItem(CONS_LOG_KEY, JSON.stringify(arr||[])); } catch {} }
function writeLastAction(obj){ try { localStorage.setItem(LAST_ACTION_KEY, JSON.stringify(obj||{})); } catch {} }
function readLastAction(){ try { return JSON.parse(localStorage.getItem(LAST_ACTION_KEY)||'{}'); } catch { return {}; } }

function formatArgs(args){
  try {
    return Array.from(args).map(a => {
      if (a === null) return 'null';
      if (a === undefined) return 'undefined';
      if (typeof a === 'string') return a;
      if (typeof a === 'number' || typeof a === 'boolean') return String(a);
      if (a instanceof Error) return a.stack || a.message || String(a);
      try { return JSON.stringify(a); } catch { return String(a); }
    }).join(' ');
  } catch { return String(args); }
}

const ConsoleDock = (() => {
  let el, body, toggleBtn, dropBtn, dropMenu, titleEl, autoScroll = true;
  // Include debug level, default off to reduce noise
  let state = { open: false, height: 220, search: '', tsUTC: false, mode: 'console', levels: { debug:false, log:true, info:true, warn:true, error:true, success:true } };
  const orig = { log: console.log, warn: console.warn, error: console.error, info: console.info };
  let seq = 0; // monotonically increasing sequence for each appended line to aid ordering diagnostics

  function ensureElements(){
    if (el) return;
    // Container
    el = document.createElement('div');
    el.className = 'console-dock';
  el.innerHTML = '<div class="dragbar"></div>'+
      '<div class="dock-header">'+
        '<div class="title">Console</div>'+
        '<div class="filters d-flex align-items-center gap-1 me-auto ms-2">'+
      '<button type="button" class="btn btn-sm btn-outline-light" data-level="debug" title="Show debug">Debug</button>'+
          '<button type="button" class="btn btn-sm btn-outline-light" data-level="info" title="Show info">Info</button>'+
          '<button type="button" class="btn btn-sm btn-outline-light" data-level="warn" title="Show warn">Warn</button>'+
          '<button type="button" class="btn btn-sm btn-outline-light" data-level="error" title="Show error">Error</button>'+
          '<button type="button" class="btn btn-sm btn-outline-light" data-level="success" title="Show success">Success</button>'+
          '<input type="search" class="form-control form-control-sm ms-2" placeholder="Search" data-act="search" style="width: 180px;" />'+
        '</div>'+
        '<div class="actions">'+
          '<button type="button" class="btn btn-sm btn-outline-light me-1" data-act="autoscroll">Auto</button>'+
          '<button type="button" class="btn btn-sm btn-outline-light me-1" data-act="utc">UTC</button>'+
          '<button type="button" class="btn btn-sm btn-outline-light me-1" data-act="copy">Copy</button>'+
          '<button type="button" class="btn btn-sm btn-outline-info me-1" data-act="download">Download</button>'+
          '<button type="button" class="btn btn-sm btn-outline-warning me-1" data-act="clear">Clear</button>'+
        '</div>'+
      '</div>'+
      '<div class="dock-body" id="console-body"></div>';
    document.body.appendChild(el);
    body = el.querySelector('#console-body');
    titleEl = el.querySelector('.dock-header .title');
    // Toggle button
    toggleBtn = document.createElement('button');
    toggleBtn.type = 'button';
    toggleBtn.className = 'console-toggle';
    toggleBtn.innerHTML = '<span class="label">Dock</span>';
    toggleBtn.title = 'Toggle dock (Console/Queue)';
    toggleBtn.addEventListener('click', toggle);
    document.body.appendChild(toggleBtn);
    // Dropdown button to choose view
    dropBtn = document.createElement('button');
    dropBtn.type = 'button';
    dropBtn.className = 'console-drop';
  dropBtn.innerHTML = '<span class="label">Console</span><span class="caret">▾</span>';
    dropBtn.title = 'Choose Console or Queue';
    dropBtn.setAttribute('aria-haspopup', 'true');
    dropBtn.setAttribute('aria-expanded', 'false');
    dropBtn.addEventListener('click', (e) => {
      e.preventDefault();
      if (!dropMenu) buildDropMenu();
      const isOpen = dropMenu.style.display === 'block';
      if (isOpen) {
        dropMenu.style.display = 'none';
        dropBtn.setAttribute('aria-expanded', 'false');
        return;
      }
      dropMenu.style.display = 'block';
      dropMenu.style.visibility = 'hidden';
      positionDropMenu();
      dropMenu.style.visibility = 'visible';
      dropBtn.setAttribute('aria-expanded', 'true');
    });
    document.body.appendChild(dropBtn);
    function positionDropMenu(){
      if (!dropMenu || dropMenu.style.display !== 'block') return;
      try {
        const rect = dropBtn.getBoundingClientRect();
        const gap = 8;
        const menuRect = dropMenu.getBoundingClientRect();
        // Align horizontally with drop button (right edge)
        const right = Math.max(12, window.innerWidth - rect.right);
        dropMenu.style.right = `${right}px`;
        dropMenu.style.left = 'auto';
        dropMenu.style.bottom = 'auto';
        // Prefer positioning above the button; if insufficient space, drop below
        let top = rect.top - menuRect.height - gap;
        if (top < 12) top = rect.bottom + gap;
        dropMenu.style.top = `${top}px`;
      } catch {}
    }
    dropBtn._positionMenu = positionDropMenu;
    function buildDropMenu(){
      dropMenu = document.createElement('div');
      dropMenu.className = 'console-drop-menu shadow';
      dropMenu.style.position = 'fixed';
      dropMenu.style.zIndex = '2102';
      dropMenu.style.minWidth = '160px';
      dropMenu.style.borderRadius = '.25rem';
      dropMenu.style.display = 'none';
      dropMenu.innerHTML = '<div class="list-group list-group-flush">\
        <button type="button" class="list-group-item list-group-item-action" data-mode="console">Show Console</button>\
        <button type="button" class="list-group-item list-group-item-action" data-mode="queue">Show Queue</button>\
      </div>';
      dropMenu.addEventListener('click', (ev)=>{
        const btn = ev.target.closest('[data-mode]');
        if (!btn) return;
        const mode = btn.getAttribute('data-mode');
        setMode(mode === 'queue' ? 'queue' : 'console');
        setOpen(true);
        dropMenu.style.display = 'none';
        dropBtn.setAttribute('aria-expanded', 'false');
      });
      document.body.appendChild(dropMenu);
      // Reposition on window resize while menu is visible
      window.addEventListener('resize', () => { positionDropMenu(); });
      document.addEventListener('click', (evt)=>{
        if (!dropMenu) return;
        const t = evt.target;
        if (t === dropBtn || dropBtn.contains(t)) return;
        if (dropMenu.style.display === 'block' && !dropMenu.contains(t)) {
          dropMenu.style.display = 'none';
          dropBtn.setAttribute('aria-expanded', 'false');
        }
      });
    }
    // Header actions
    el.querySelector('[data-act="clear"]').addEventListener('click', clear);
  el.querySelector('[data-act="download"]').addEventListener('click', downloadCurrent);
  el.querySelector('[data-act="copy"]').addEventListener('click', copyCurrent);
  // Hide button removed
    const autoBtn = el.querySelector('[data-act="autoscroll"]');
    autoBtn.addEventListener('click', () => { autoScroll = !autoScroll; autoBtn.classList.toggle('active', autoScroll); saveState(); });
  const utcBtn = el.querySelector('[data-act="utc"]');
  utcBtn.addEventListener('click', () => { state.tsUTC = !state.tsUTC; utcBtn.classList.toggle('active', state.tsUTC); saveState(); renderAll(); });
    // Level filters
    el.querySelectorAll('[data-level]').forEach(btn => {
      btn.addEventListener('click', () => {
        const lvl = btn.getAttribute('data-level');
        state.levels[lvl] = !state.levels[lvl];
        btn.classList.toggle('active', !!state.levels[lvl]);
        saveState();
        renderAll();
      });
    });
    // Search filter
    const search = el.querySelector('[data-act="search"]');
    search.addEventListener('input', () => { state.search = search.value || ''; saveState(); renderAll(); });
    // Drag to resize
    const drag = el.querySelector('.dragbar');
    let dragging = false, startY = 0, startH = 0;
    drag.addEventListener('mousedown', (e)=>{ dragging = true; startY = e.clientY; startH = state.height; document.body.classList.add('noselect'); e.preventDefault(); });
    window.addEventListener('mousemove', (e)=>{
      if (!dragging) return;
      const dy = startY - e.clientY;
      const nh = Math.min(Math.max(startH + dy, 120), Math.round(window.innerHeight*0.65));
      setHeight(nh);
    });
    window.addEventListener('mouseup', ()=>{ dragging = false; document.body.classList.remove('noselect'); });
  }

  function renderAll(){
    if (state.mode === 'queue') { renderQueue(); return; }
    if (!body) return;
    const logs = readConsoleLogs();
    const searchLC = (state.search||'').toLowerCase();
    const filtered = logs.filter(l => {
      if (!state.levels[l.level||'info']) return false;
      if (searchLC) return (String(l.msg||'').toLowerCase().includes(searchLC));
      return true;
    });
    const ordered = filtered.slice().reverse();
    body.innerHTML = ordered.map(l => {
      const lvl = l.level || 'info';
      const cls = 'lvl-' + (lvl === 'log' ? 'info' : lvl);
      const d = new Date(l.ts || Date.now());
      const ts = state.tsUTC ? d.toISOString().split('T')[1].replace('Z','') : d.toLocaleTimeString();
      const msg = (l.msg || '').replace(/</g,'&lt;').replace(/>/g,'&gt;');
      return `<span class="log-line ${cls}"><span class="ts">[${ts}]</span>${msg}</span>`;
    }).join('');
    if (autoScroll) body.scrollTop = 0;
  }

  function append(level, args){
    const logs = readConsoleLogs();
    logs.push({ ts: Date.now(), level, msg: formatArgs(args), seq: ++seq });
    if (logs.length > CONS_MAX) logs.splice(0, logs.length - CONS_MAX);
    writeConsoleLogs(logs);
    if (state.mode === 'console') renderAll();
  }

  function clear(){ writeConsoleLogs([]); renderAll(); }

  function setOpen(v){ state.open = !!v; saveState(); applyState(); }
  function toggle(){ setOpen(!state.open); }
  function setHeight(h){ state.height = Math.max(120, h|0); saveState(); applyState(); }
  function saveState(){
    writeConsoleState({
      open: state.open,
      height: state.height,
      auto: autoScroll,
      search: state.search,
      tsUTC: state.tsUTC,
      levels: state.levels,
      mode: state.mode
    });
  }
  function applyState(){
    if (!el) return;
    const root = document.documentElement;
    root.style.setProperty('--console-height', (state.height||220)+'px');
    el.classList.toggle('open', !!state.open);
    document.body.classList.toggle('console-dock-open', !!state.open);
    const autoBtn = el.querySelector('[data-act="autoscroll"]');
    if (autoBtn) autoBtn.classList.toggle('active', !!autoScroll);
    const utcBtn = el.querySelector('[data-act="utc"]');
    if (utcBtn) utcBtn.classList.toggle('active', !!state.tsUTC);
    // Apply filters UI state
    el.querySelectorAll('[data-level]').forEach(btn => {
      const lvl = btn.getAttribute('data-level');
      btn.classList.toggle('active', !!(state.levels && state.levels[lvl]));
    });
    const search = el.querySelector('[data-act="search"]');
    if (search) search.value = state.search || '';
    // Reposition toggle button just above the dock when open
    const offset = (state.open ? (state.height + 8) : 8);
    toggleBtn.style.bottom = offset + 'px';
    if (toggleBtn) toggleBtn.classList.toggle('open', !!state.open);
    if (toggleBtn) {
      const labelNode = toggleBtn.querySelector('.label');
      if (labelNode) labelNode.textContent = state.open ? 'Hide Dock' : 'Show Dock';
    }
    if (dropBtn) {
      dropBtn.style.bottom = offset + 'px';
      dropBtn.classList.toggle('open', !!state.open);
      if (dropMenu && dropMenu.style.display === 'block') {
        dropMenu.style.visibility = 'hidden';
        requestAnimationFrame(()=>{
          if (dropBtn && typeof dropBtn._positionMenu === 'function') dropBtn._positionMenu();
          dropMenu.style.visibility = 'visible';
        });
      }
    }
    applyModeState();
  }

  function setMode(mode){
    state.mode = (mode === 'queue') ? 'queue' : 'console';
    saveState();
    applyModeState();
    renderAll();
  }

  function applyModeState(){
    if (el) el.classList.toggle('mode-queue', state.mode === 'queue');
    if (dropBtn) {
      const dropLabel = dropBtn.querySelector('.label');
      if (dropLabel) dropLabel.textContent = state.mode === 'queue' ? 'Queue' : 'Console';
    }
    if (dropBtn) dropBtn.setAttribute('aria-expanded', dropMenu && dropMenu.style.display === 'block' ? 'true' : 'false');
    try { if (titleEl) titleEl.textContent = (state.mode === 'queue') ? 'Queue' : 'Console'; } catch {}
  }

  function renderQueue(){
    if (!body) return;
    if (!window.getRemoteQueueState) {
      body.innerHTML = '<div class="queue-view"><div class="queue-empty">Queue API not available on this page.</div></div>';
      return;
    }
    const formatStampLabel = (value, prefix) => {
      const ts = Number(value);
      if (!Number.isFinite(ts) || ts <= 0) return '';
      try {
        const stamp = new Date(ts).toLocaleTimeString();
        return prefix ? `${prefix} ${stamp}` : stamp;
      } catch { return ''; }
    };
  const st = window.getRemoteQueueState();
  const waitingItems = Array.isArray(st.items) ? st.items : [];
  const completedItems = Array.isArray(st.completed) ? st.completed : [];
  const activeItems = Array.isArray(st.activeItems) ? st.activeItems : (st.current && typeof st.current === 'object' ? [st.current] : []);
    const progressState = (typeof window.getActionProgressState === 'function') ? window.getActionProgressState() : null;
    const progressAvailable = !!(progressState && progressState.active);
    const progressPercentRaw = progressState ? Number(progressState.percent) : NaN;
    const progressPercentLabel = progressAvailable && Number.isFinite(progressPercentRaw) ? `${Math.round(progressPercentRaw)}%` : '';
    const progressText = progressAvailable && progressState.text ? String(progressState.text) : '';
    const progressSummaryParts = [];
    if (progressPercentLabel) progressSummaryParts.push(progressPercentLabel);
    if (progressText) progressSummaryParts.push(progressText);
    const progressSummary = progressAvailable && progressSummaryParts.length ? progressSummaryParts.join(' • ') : '';
    const waitingCount = waitingItems.length;
    const completedCount = completedItems.length;
    const activeCount = activeItems.length;
    const total = waitingCount + activeCount;
    const totalLabel = `${total} item${total===1?'':'s'}`;
    const completedLabel = completedCount ? ` • ${completedCount} completed` : '';
    const statusClass = activeCount ? 'active' : 'idle';
    const statusLabel = activeCount ? (activeCount === 1 ? 'Running' : `Running (${activeCount})`) : 'Idle';
    let html = '<div class="queue-view">';
    html += `<div class="queue-status is-${statusClass}">`+
      `<div class="queue-status-main">`
        + `<span class="queue-pill ${statusClass}">${statusLabel}</span>`
    + `<span class="queue-count">${totalLabel}${completedLabel}</span>`
      + `</div>`
      + `<div class="queue-status-actions">`
        + `<button type="button" class="btn btn-sm btn-queue-refresh" data-act="q-refresh">Refresh</button>`
      + `</div>`
    + `</div>`;
    if (activeCount) {
      html += `<div class="queue-section">`
            + `<div class="queue-section-title">In Progress</div>`
            + activeItems.map((entry, idx) => {
                if (!entry) return '';
                const proj = entry.projectId ? `<div class="queue-meta">Project: ${escapeHtml(entry.projectId)}</div>` : '';
                const queuedLabel = formatStampLabel(entry.createdAt, 'Queued');
                const startedLabel = formatStampLabel(entry.startedAt, 'Started');
                const queuedMeta = queuedLabel ? `<div class="queue-meta text-muted">${escapeHtml(queuedLabel)}</div>` : '';
                const startedMeta = startedLabel ? `<div class="queue-meta text-muted">${escapeHtml(startedLabel)}</div>` : '';
                const cancelNote = entry.cancelRequested ? '<div class="queue-meta text-warning">Cancel requested…</div>' : '';
                const disableCancel = entry.cancelRequested ? 'disabled' : '';
                const isPrimary = idx === 0;
                const progressMeta = (isPrimary && progressSummary) ? `<div class="queue-meta text-muted">${escapeHtml(progressSummary)}</div>` : '';
                const progressHint = (isPrimary && progressAvailable) ? '<div class="queue-meta text-primary small">Click or tap for progress details.</div>' : '';
                const progressButton = (isPrimary && progressAvailable) ? `<button type="button" class="btn btn-sm btn-outline-primary me-2" data-act="q-show-progress">View Progress</button>` : '';
                const cardAttrs = (isPrimary && progressAvailable)
                  ? 'class="queue-card current queue-card-clickable" data-act="q-open-progress" style="cursor:pointer;"'
                  : 'class="queue-card current"';
                const modeMeta = entry.exclusive === false ? '<div class="queue-meta text-muted">Shared task</div>' : '';
                return `<div ${cardAttrs}>`
                  + `<div class="queue-label">${escapeHtml(entry.label)}</div>`
                  + `${proj}`
                  + `${modeMeta}`
                  + `${queuedMeta}`
                  + `${startedMeta}`
                  + `${progressMeta}`
                  + `${progressHint}`
                  + `${cancelNote}`
                  + `<div class="queue-actions mt-2">`
                  + `${progressButton}`
                  + `<button type="button" class="btn btn-sm btn-outline-danger" data-act="q-cancel-active" data-id="${entry.id}" ${disableCancel}>Cancel</button>`
                  + `</div>`
                  + `</div>`;
              }).join('')
            + `</div>`;
    }
    if (waitingCount) {
      html += `<div class="queue-section">`
            + `<div class="queue-section-title">Waiting</div>`
            + `<ol class="queue-list">`
            + waitingItems.map((item, idx) => {
                const proj = item.projectId ? `<span class="queue-meta">${escapeHtml(item.projectId)}</span>` : '';
                const queuedLabel = formatStampLabel(item.createdAt, 'Queued');
                const queuedMeta = queuedLabel ? `<span class="queue-meta text-muted">${escapeHtml(queuedLabel)}</span>` : '';
                const blocked = item.blocked ? ' queue-item-blocked' : '';
                const blockedNote = item.blocked ? '<span class="queue-blocked text-warning ms-2">Waiting on project</span>' : '';
                return `<li class="queue-item${blocked}">`
                  + `<span class="queue-index">${idx+1}</span>`
                  + `<span class="queue-label">${escapeHtml(item.label)}</span>`
                  + `${proj}`
                  + `${queuedMeta}`
                  + `${blockedNote}`
                  + `<button type="button" class="btn btn-sm btn-outline-danger ms-auto" data-act="q-cancel" data-id="${item.id}">Cancel</button>`
                  + `</li>`;
              }).join('')
            + `</ol>`
          + `</div>`;
    }
    if (completedCount) {
      html += `<div class="queue-section">`
            + `<div class="queue-section-title">Completed</div>`
            + `<div class="queue-actions mb-2">`
            + `<button type="button" class="btn btn-sm btn-outline-secondary" data-act="q-clear-completed">Clear Completed</button>`
            + `</div>`
            + `<ol class="queue-list queue-list-completed">`
            + completedItems.map((item, idx) => {
                const proj = item.projectId ? `<span class="queue-meta">${escapeHtml(item.projectId)}</span>` : '';
                const status = (item.status || 'completed').toLowerCase();
                let statusLabel = 'Completed';
                let statusClass = 'text-success';
                if (status === 'error') { statusLabel = 'Failed'; statusClass = 'text-danger'; }
                else if (status === 'cancelled' || status === 'canceled') { statusLabel = 'Cancelled'; statusClass = 'text-muted'; }
                const durationMs = Number(item.durationMs);
                let durationMeta = '';
                if (Number.isFinite(durationMs) && durationMs > 0) {
                  const seconds = durationMs / 1000;
                  let display;
                  if (seconds >= 10) display = `${Math.round(seconds)}s`;
                  else display = `${(Math.round(seconds * 10) / 10).toFixed(1)}s`;
                  durationMeta = `<span class="queue-meta text-muted">${escapeHtml(display)} elapsed</span>`;
                }
                const finishedAt = Number(item.finishedAt);
                let finishedMeta = '';
                if (Number.isFinite(finishedAt) && finishedAt > 0) {
                  try {
                    const stamp = new Date(finishedAt).toLocaleTimeString();
                    finishedMeta = `<span class="queue-meta text-muted">${escapeHtml(stamp)}</span>`;
                  } catch {}
                }
                const cancelMeta = item.cancelRequested && status !== 'cancelled' && status !== 'canceled'
                  ? '<span class="queue-meta text-muted">cancel requested</span>'
                  : '';
                const errorMeta = (status === 'failed' || status === 'error') && item.errorMessage
                  ? `<div class="queue-meta text-danger small">${escapeHtml(item.errorMessage)}</div>`
                  : '';
                return `<li class="queue-item queue-item-completed">`
                  + `<span class="queue-index">${idx+1}</span>`
                  + `<span class="queue-label">${escapeHtml(item.label || 'Completed action')}</span>`
                  + `${proj}`
                  + `<span class="queue-meta ${statusClass}">${statusLabel}</span>`
                  + `${durationMeta}`
                  + `${finishedMeta}`
                  + `${cancelMeta}`
                  + `${errorMeta}`
                  + `</li>`;
              }).join('')
            + `</ol>`
          + `</div>`;
    }
    if (!st.active && !waitingCount && !completedCount) {
      html += `<div class="queue-empty">No actions in queue.</div>`;
    }
    html += '</div>';
    body.innerHTML = html;
    const btn = body.querySelector('[data-act="q-refresh"]'); if (btn) btn.addEventListener('click', renderQueue);
    body.querySelectorAll('[data-act="q-cancel"]').forEach(cancelBtn => {
      cancelBtn.addEventListener('click', () => {
        const id = Number(cancelBtn.getAttribute('data-id'));
        if (Number.isFinite(id)) {
          try { window.cancelRemoteAction && window.cancelRemoteAction(id); } catch {}
          renderQueue();
        }
      });
    });
    body.querySelectorAll('[data-act="q-cancel-active"]').forEach(cancelBtn => {
      cancelBtn.addEventListener('click', () => {
        const id = Number(cancelBtn.getAttribute('data-id'));
        if (Number.isFinite(id)) {
          try { window.cancelRemoteAction && window.cancelRemoteAction(id); } catch {}
          renderQueue();
        }
      });
    });
    const clearCompletedBtn = body.querySelector('[data-act="q-clear-completed"]');
    if (clearCompletedBtn) {
      clearCompletedBtn.addEventListener('click', () => {
        try { window.clearCompletedRemoteActions && window.clearCompletedRemoteActions(); } catch {}
        renderQueue();
      });
    }
    if (progressAvailable) {
      const progressButtons = body.querySelectorAll('[data-act="q-show-progress"]');
      progressButtons.forEach(btnEl => {
        btnEl.addEventListener('click', (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          try {
            if (typeof window.openProgressDetailsModal === 'function') {
              const st = (typeof window.getActionProgressState === 'function') ? window.getActionProgressState() : null;
              if (window.openProgressDetailsModal(st)) return;
            }
          } catch {}
          if (typeof window.openActionProgressModal === 'function') window.openActionProgressModal();
        });
      });
      const clickableCards = body.querySelectorAll('[data-act="q-open-progress"]');
      clickableCards.forEach(card => {
        card.addEventListener('click', (ev) => {
          if (ev.target && ev.target.closest('[data-act="q-cancel-active"]')) return;
          try {
            if (typeof window.openProgressDetailsModal === 'function') {
              const st = (typeof window.getActionProgressState === 'function') ? window.getActionProgressState() : null;
              if (window.openProgressDetailsModal(st)) return;
            }
          } catch {}
          if (typeof window.openActionProgressModal === 'function') window.openActionProgressModal();
        });
      });
    }
  }

  function setLevel(level, enabled){
    try {
      state.levels = state.levels || {};
      state.levels[level] = !!enabled;
      saveState();
      applyState();
      renderAll();
    } catch {}
  }

  function hookConsole(){
    try {
      const originalDebug = console.debug;
      console.debug = function(){ append('debug', arguments); return (originalDebug ? originalDebug.apply(console, arguments) : orig.log.apply(console, arguments)); };
      console.log = function(){ append('log', arguments); return orig.log.apply(console, arguments); };
      console.info = function(){ append('info', arguments); return orig.info.apply(console, arguments); };
      console.warn = function(){ append('warn', arguments); return orig.warn.apply(console, arguments); };
      console.error = function(){ append('error', arguments); return orig.error.apply(console, arguments); };
    } catch {}
    window.addEventListener('toolhub-log', (e) => {
      try { append((e.detail && e.detail.level) || 'info', [e.detail && e.detail.message]); } catch {}
    });
  }

  function init(){
    ensureElements();
    const s = readConsoleState();
    if (typeof s.open === 'boolean') state.open = s.open;
    if (typeof s.height === 'number') state.height = s.height;
  if (typeof s.auto === 'boolean') autoScroll = s.auto;
  if (typeof s.tsUTC === 'boolean') state.tsUTC = s.tsUTC;
    if (typeof s.search === 'string') state.search = s.search;
    if (s.levels && typeof s.levels === 'object') state.levels = Object.assign(state.levels, s.levels);
    if (typeof s.mode === 'string') state.mode = (s.mode === 'queue') ? 'queue' : 'console';
    applyState();
    renderAll();
    hookConsole();
    try {
      document.addEventListener('remote-queue-changed', () => { if (state.mode === 'queue') renderAll(); });
    } catch {}
    try {
      document.addEventListener('queue-progress-updated', () => { if (state.mode === 'queue') renderAll(); });
    } catch {}
  }

  function downloadCurrent(){
    try {
      const all = readConsoleLogs();
      const searchLC = (state.search||'').toLowerCase();
      const filtered = all.filter(l => {
        if (!state.levels[l.level||'info']) return false;
        if (searchLC) return (String(l.msg||'').toLowerCase().includes(searchLC));
        return true;
      });
      const lines = filtered.map(l => {
        const ts = new Date(l.ts || Date.now()).toISOString();
        return `[${ts}] ${l.level?.toUpperCase() || 'INFO'} ${l.msg || ''}`;
      }).join('\n');
      const blob = new Blob([lines+'\n'], { type: 'text/plain' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const stamp = new Date().toISOString().replace(/[:.]/g,'-');
      a.href = url; a.download = `toolhub-console-${stamp}.txt`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(()=>URL.revokeObjectURL(url), 2000);
    } catch {}
  }

  async function copyCurrent(){
    try {
      const all = readConsoleLogs();
      const searchLC = (state.search||'').toLowerCase();
      const filtered = all.filter(l => {
        if (!state.levels[l.level||'info']) return false;
        if (searchLC) return (String(l.msg||'').toLowerCase().includes(searchLC));
        return true;
      });
      const lines = filtered.map(l => {
        const ts = new Date(l.ts || Date.now()).toISOString();
        return `[${ts}] ${l.level?.toUpperCase() || 'INFO'} ${l.msg || ''}`;
      }).join('\n');
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(lines + '\n');
      } else {
        const ta = document.createElement('textarea');
        ta.value = lines + '\n';
        document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove();
      }
    } catch {}
  }

  return { init, append, clear, setOpen, toggle, setLevel, setMode };
})();

function log(level, message){ ConsoleDock.append(level||'info', [message]); }
// Verbose step logger: automatically numbers steps within an action context
let _currentActionCtx = null; let _actionStep = 0;
function beginActionContext(name){
  _currentActionCtx = String(name||'Action'); _actionStep = 0;
  try { logInfo(`[${_currentActionCtx}] BEGIN`); } catch {}
  try { writeLastAction({ name: _currentActionCtx, started: Date.now(), steps: [] }); } catch {}
}
function endActionContext(success=true){
  if (_currentActionCtx) { 
    try { (success?logSuccess:logError)(`[${_currentActionCtx}] END (${success?'ok':'failed'}) totalSteps=${_actionStep}`); } catch {}
    try {
      const cur = readLastAction() || {};
      cur.ended = Date.now();
      cur.success = !!success;
      cur.totalSteps = _actionStep;
      writeLastAction(cur);
    } catch {}
  }
  _currentActionCtx = null; _actionStep = 0;
}
function step(message){
  if (!_currentActionCtx) return logDebug(message);
  _actionStep += 1;
  logDebug(`[${_currentActionCtx}#${_actionStep}] ${message}`);
  try {
    const cur = readLastAction() || {};
    if (cur && cur.name === _currentActionCtx) {
      cur.steps = Array.isArray(cur.steps) ? cur.steps : [];
      cur.steps.push({ n: _actionStep, msg: message, ts: Date.now() });
      if (cur.steps.length > 500) cur.steps.splice(0, cur.steps.length - 500);
      writeLastAction(cur);
    }
  } catch {}
}
function logInfo(msg){ log('info', msg); }
function logWarn(msg){ log('warn', msg); }
function logError(msg){ log('error', msg); }
function logSuccess(msg){ ConsoleDock.append('success', [msg]); }
function logDebug(msg){ ConsoleDock.append('debug', [msg]); }
function enableConsoleDebug(on){ try { ConsoleDock.setLevel('debug', on===undefined ? true : !!on); } catch {} }
function showQueuePanel(){
  try { ConsoleDock.setMode('queue'); } catch {}
  try { ConsoleDock.setOpen(true); } catch {}
}

window.shell = {
  initShell,
  refreshSidebar,
  getCurrentProjectId,
  setCurrentProjectId,
  getRunMode,
  setRunMode,
  setRunModeAsync,
  isRemote,
  loadRunModeFromServer,
  persistRunModeToServer,
  applyRemoteModeUI,
  toggleSidebar,
  setSidebarImportBusy,
  setSidebarCollapsed,
  isSidebarCollapsed,
  log,
  logInfo,
  logWarn,
  logError,
  logSuccess,
  logDebug,
  enableConsoleDebug,
  showQueuePanel,
  beginActionContext,
  endActionContext,
  step,
  readLastAction
};

window.addEventListener('resize', () => positionSidebarToggle());
window.addEventListener('orientationchange', () => positionSidebarToggle());
window.addEventListener('scroll', () => positionSidebarToggle(), { passive: true });

// Auto-init console dock once DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => { try { ConsoleDock.init(); } catch {} });
} else {
  try { ConsoleDock.init(); } catch {}
}

_remoteQueue_checkForAbortNotice();
_remoteQueue_restoreFromStorage();

window.addEventListener('beforeunload', (ev) => {
  try {
    const store = _remoteQueue_storage();
    if (store) {
      const payload = { volatile: _remoteQueue_collectVolatile(), ts: Date.now() };
      store.setItem(REMOTE_QUEUE_ABORT_KEY, JSON.stringify(payload));
    }
  } catch {}
  if (_remoteQueue_hasVolatileTasks()) {
    try { ev.preventDefault(); ev.returnValue = ''; } catch {}
    return '';
  }
  return undefined;
});

// Dynamic Bootstrap Confirm Modal Utility
window.showConfirmModal = function(title, bodyTextHtml, config = {}) {
  return new Promise((resolve) => {
    const modalId = 'dynamic-confirm-' + Math.floor(Math.random() * 1000000);
    const wrap = document.createElement('div');
    const confirmBtnClass = config.confirmClass || 'btn-primary';
    const confirmBtnText = config.confirmText || 'OK';
    const cancelBtnText = config.cancelText || 'Cancel';
    const noBtnText = config.noText || null;
    const noBtnClass = config.noClass || 'btn-outline-secondary';
    const titleHtml = typeof window.escapeHtml === 'function' ? window.escapeHtml(title) : title;
    
    let result = noBtnText ? 'cancel' : false;
    
    wrap.innerHTML = `
      <div class="modal fade" id="${modalId}" tabindex="-1" aria-hidden="true" data-bs-backdrop="static" data-bs-keyboard="false">
        <div class="modal-dialog">
          <div class="modal-content">
            <div class="modal-header">
              <h5 class="modal-title">${titleHtml}</h5>
              <button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Close"></button>
            </div>
            <div class="modal-body" style="white-space: pre-wrap;">${bodyTextHtml}</div>
            <div class="modal-footer">
              <button type="button" class="btn btn-secondary" data-bs-dismiss="modal" id="${modalId}-cancel">${cancelBtnText}</button>
              ${noBtnText ? `<button type="button" class="btn ${noBtnClass}" id="${modalId}-no">${noBtnText}</button>` : ''}
              <button type="button" class="btn ${confirmBtnClass}" id="${modalId}-confirm">${confirmBtnText}</button>
            </div>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(wrap.firstElementChild);
    const el = document.getElementById(modalId);
    const bsModal = new bootstrap.Modal(el);
    
    document.getElementById(`${modalId}-confirm`).addEventListener('click', () => {
      result = noBtnText ? 'yes' : true;
      bsModal.hide();
    });
    
    if (noBtnText) {
      document.getElementById(`${modalId}-no`).addEventListener('click', () => {
        result = 'no';
        bsModal.hide();
      });
    }
    
    el.addEventListener('hidden.bs.modal', () => {
      el.remove();
      resolve(result);
    });
    
    bsModal.show();
  });
};
