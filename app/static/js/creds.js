// Shared credential persistence & visibility utilities
(function(){
  const _secretsCache = new Map();

  async function _fetchJson(url, opts){
    const res = await fetch(url, Object.assign({
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
    }, (opts||{})));
    let body = null;
    try { body = await res.json(); } catch { body = null; }
    if (!res.ok) {
      const msg = (body && (body.error || body.message)) ? (body.error || body.message) : `Request failed (${res.status})`;
      throw new Error(msg);
    }
    return body;
  }

  async function fetchProjectSecrets(pid, force){
    const key = String(pid||'');
    if (!key) return null;
    if (!force && _secretsCache.has(key)) return _secretsCache.get(key);
    let body = await _fetchJson(`/api/projects/${encodeURIComponent(key)}/secrets`, { method: 'GET' });

    // One-time migration from legacy browser localStorage keys into server secrets.
    // We only do this if the server has no saved values yet.
    try {
      const serverHasAny = !!(body?.proxmox?.saved || body?.ctfd?.saved);
      if (!serverHasAny) {
        const legacy = readLegacyLocalStorageCreds(key);
        const hasLegacy = !!(legacy?.proxmox?.username || legacy?.proxmox?.password || legacy?.ctfd?.token);
        if (hasLegacy) {
          await patchProjectSecrets(key, legacy);
          clearLegacyLocalStorageCreds(key);
          body = await _fetchJson(`/api/projects/${encodeURIComponent(key)}/secrets`, { method: 'GET' });
        }
      }
    } catch {}

    _secretsCache.set(key, body || null);
    return body;
  }

  async function patchProjectSecrets(pid, payload){
    const key = String(pid||'');
    if (!key) return null;
    const body = await _fetchJson(`/api/projects/${encodeURIComponent(key)}/secrets`, { method: 'PATCH', body: JSON.stringify(payload || {}) });
    try { await fetchProjectSecrets(key, true); } catch {}
    return body;
  }

  function xorEncode(str){
    try {
      const key = 23;
      return btoa(Array.from(String(str)).map(c => String.fromCharCode(c.charCodeAt(0) ^ key)).join(''));
    } catch {
      return str;
    }
  }
  function xorDecode(str){
    try {
      const key = 23;
      const raw = atob(str);
      return Array.from(raw).map(c => String.fromCharCode(c.charCodeAt(0) ^ key)).join('');
    } catch {
      return str;
    }
  }
  function ctfdKey(pid){ return `toolhub.ctfd.persist.${pid}`; }
  function proxKey(pid){ return `toolhub.prox.persist.${pid}`; }

  function readLegacyLocalStorageCreds(pid){
    const out = { proxmox: { username: '', password: '' }, ctfd: { token: '' } };
    // Proxmox legacy (xor-encoded u_enc/p_enc)
    try {
      const raw = localStorage.getItem(proxKey(pid));
      if (raw) {
        const obj = JSON.parse(raw);
        if (obj && (obj.u_enc || obj.p_enc)) {
          out.proxmox.username = xorDecode(obj.u_enc || '');
          out.proxmox.password = xorDecode(obj.p_enc || '');
        } else if (obj && (obj.username || obj.password)) {
          // Older plaintext
          out.proxmox.username = String(obj.username || '');
          out.proxmox.password = String(obj.password || '');
        }
      }
    } catch {}
    // CTFd legacy (xor-encoded token_enc or plaintext token)
    try {
      const raw = localStorage.getItem(ctfdKey(pid));
      if (raw) {
        const obj = JSON.parse(raw);
        if (obj && obj.token_enc) out.ctfd.token = xorDecode(obj.token_enc);
        else if (obj && obj.token) out.ctfd.token = String(obj.token || '');
      }
    } catch {}
    // Trim
    try { out.proxmox.username = String(out.proxmox.username || '').trim(); } catch {}
    try { out.ctfd.token = String(out.ctfd.token || '').trim(); } catch {}
    return out;
  }

  function clearLegacyLocalStorageCreds(pid){
    try { localStorage.removeItem(proxKey(pid)); } catch {}
    try { localStorage.removeItem(ctfdKey(pid)); } catch {}
  }
  async function setPersistCtfdToken(pid, token, persist){
    // Persist to the server (per-user, per-project, encrypted at rest).
    try {
      if (persist) {
        await patchProjectSecrets(pid, { ctfd: { token: token || '' } });
      } else {
        await patchProjectSecrets(pid, { ctfd: { token: '' } });
      }
    } catch {}
  }
  function readPersistCtfdToken(pid){
    try {
      const cached = _secretsCache.get(String(pid||''));
      const t = cached?.ctfd?.token;
      if (typeof t === 'string' && t) return t;
    } catch {}
    return '';
  }
  async function setPersistProxCreds(pid, username, password, persist){
    // Persist to the server (per-user, per-project, encrypted at rest).
    try {
      if (persist) {
        await patchProjectSecrets(pid, { proxmox: { username: username || '', password: password || '' } });
      } else {
        await patchProjectSecrets(pid, { proxmox: { username: '', password: '' } });
      }
    } catch {}
  }
  function readPersistProxCreds(pid){
    try {
      const cached = _secretsCache.get(String(pid||''));
      const u = cached?.proxmox?.username;
      const p = cached?.proxmox?.password;
      if ((typeof u === 'string' && u) || (typeof p === 'string' && p)) return { username: u || '', password: p || '' };
    } catch {}
    return {};
  }
  function clearAllPersistedCreds(){
    let removed = 0;
    try {
      const keys = Object.keys(localStorage);
      keys.forEach(k => {
        if (/^toolhub\.(ctfd|prox)\.persist\./.test(k)) {
          try { localStorage.removeItem(k); removed++; } catch {}
        }
      });
    } catch {}
    try {
      const fb = document.getElementById('clear-creds-feedback');
      if (fb) {
        fb.textContent = `Removed ${removed} saved credential entr${removed === 1 ? 'y' : 'ies'}.`;
        fb.className = 'small text-success';
      }
    } catch {}
    return removed;
  }
  window.CREDS = { setPersistCtfdToken, readPersistCtfdToken, setPersistProxCreds, readPersistProxCreds, clearAllPersistedCreds };
  window.CREDS.fetchProjectSecrets = fetchProjectSecrets;
  window.CREDS.patchProjectSecrets = patchProjectSecrets;

  function ensureSettingsModal(){
    if (document.getElementById('settingsModal')) return;
    const div = document.createElement('div');
    div.innerHTML = `
<div class="modal fade" id="settingsModal" tabindex="-1" aria-hidden="true">
  <div class="modal-dialog modal-xl">
    <div class="modal-content">
      <div class="modal-header"><h5 class="modal-title">Settings</h5><button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Close"></button></div>
      <div class="modal-body">
        <ul class="nav nav-tabs" id="settings-tabs" role="tablist">
          <li class="nav-item" role="presentation">
            <button class="nav-link active" id="settings-tab-general" data-bs-toggle="tab" data-bs-target="#settings-pane-general" type="button" role="tab" aria-controls="settings-pane-general" aria-selected="true">General</button>
          </li>
          <li class="nav-item" role="presentation">
            <button class="nav-link" id="settings-tab-media" data-remote-disable="audio" data-remote-tooltip="Audio is disabled when app is running in remote mode." data-bs-toggle="tab" data-bs-target="#settings-pane-media" type="button" role="tab" aria-controls="settings-pane-media" aria-selected="false">Media Manager</button>
          </li>
        </ul>
        <div class="tab-content pt-3">
          <div class="tab-pane fade show active" id="settings-pane-general" role="tabpanel" aria-labelledby="settings-tab-general">
            <h6 class="text-uppercase text-muted mb-2">View</h6>
            <div class="form-check form-switch mb-2">
              <input class="form-check-input" type="checkbox" id="def-cfg">
              <label class="form-check-label" for="def-cfg">Expand Project Configuration by default</label>
            </div>
            <div class="form-check form-switch mb-2">
              <input class="form-check-input" type="checkbox" id="def-vm">
              <label class="form-check-label" for="def-vm">Expand VM Details by default</label>
            </div>
            <div class="form-check form-switch mb-3">
              <input class="form-check-input" type="checkbox" id="def-mat">
              <label class="form-check-label" for="def-mat">Expand Materials by default</label>
            </div>
            <hr/>
            <h6 class="text-uppercase text-muted mb-2">Runtime</h6>
            <div class="form-check form-switch mb-2">
              <input class="form-check-input" type="checkbox" id="settings-run-remote">
              <label class="form-check-label" for="settings-run-remote">Remote mode</label>
            </div>
            <p class="small text-muted mb-3">Local is the default. When Remote mode is on, Import, Export, and Audio features are disabled in the UI.</p>
            <hr/>
            <h6 class="text-uppercase text-muted mb-2">Text-to-Speech</h6>
            <p id="settings-tts-support-note" class="small text-muted mb-2">Applies to supported browsers.</p>
            <div class="row g-2 mb-3">
              <div class="col">
                <label class="form-label small mb-1" for="settings-tts-rate">Speech rate</label>
                <input class="form-control form-control-sm" type="number" step="0.1" min="0.5" max="2.0" id="settings-tts-rate" value="1" data-remote-disable="audio" data-remote-tooltip="Audio is disabled when app is running in remote mode.">
              </div>
              <div class="col">
                <label class="form-label small mb-1" for="settings-tts-pitch">Speech pitch</label>
                <input class="form-control form-control-sm" type="number" step="0.1" min="0" max="2.0" id="settings-tts-pitch" value="1" data-remote-disable="audio" data-remote-tooltip="Audio is disabled when app is running in remote mode.">
              </div>
            </div>
            <p class="small text-muted mb-3">Adjust how quickly and how high announcements are spoken by the browser.</p>
            <hr/>
            <h6 class="text-uppercase text-muted mb-2">Security</h6>
            <p class="small text-muted">Saved credentials are stored with the project on the server (encrypted at rest). This button only clears any browser-local fallback cache.</p>
            <button type="button" class="btn btn-outline-danger btn-sm" id="btn-clear-creds">Clear Browser Credential Cache</button>
            <div id="clear-creds-feedback" class="small mt-2"></div>
            <hr/>
            <h6 class="text-uppercase text-muted mb-2">Plugins</h6>
            <div class="text-muted small">No plugins configured.</div>
          </div>
          <div class="tab-pane fade" id="settings-pane-media" role="tabpanel" aria-labelledby="settings-tab-media">
            <h6 class="text-uppercase text-muted mb-2">Media Manager</h6>
            <p class="small text-muted mb-3">Upload short audio files here, then select them per-project in the CTFd Manager notification audio section.</p>
            <div class="d-flex flex-wrap gap-2 align-items-center mb-2">
              <label class="btn btn-outline-secondary btn-sm mb-0">
                Upload Audio<input type="file" id="settings-media-upload" accept="audio/*" multiple hidden>
              </label>
              <button type="button" class="btn btn-outline-secondary btn-sm" id="settings-media-refresh">Refresh</button>
              <button type="button" class="btn btn-outline-danger btn-sm" id="settings-media-delete-selected" data-remote-disable="audio" data-remote-tooltip="Audio is disabled when app is running in remote mode." disabled>Delete Selected</button>
              <span class="small text-muted">Max 10 MB per file.</span>
            </div>
            <div id="settings-media-status" class="small text-muted mb-2"></div>
            <div class="card" id="settings-media-card">
              <div class="card-header py-2 d-flex align-items-center justify-content-between">
                <label class="small text-muted mb-0 d-flex align-items-center gap-2">
                  <input class="form-check-input m-0" type="checkbox" id="settings-media-select-all" aria-label="Select all uploaded audio" disabled>
                  <span>Select all</span>
                </label>
                <div class="small text-muted">Uploaded audio</div>
              </div>
              <ul class="list-group list-group-flush list-group-sm" id="settings-media-list"></ul>
            </div>
          </div>
        </div>
      </div>
      <div class="modal-footer">
        <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">Close</button>
        <button type="button" class="btn btn-primary" onclick="saveSettings()">Save</button>
      </div>
    </div>
  </div>
</div>`;
    document.body.appendChild(div.firstElementChild);
    try { if (typeof window.prepareSettingsModal === 'function') window.prepareSettingsModal(); } catch {}
  }
  function wireSettingsLink(){
    document.addEventListener('click', (e) => {
      const a = e.target && e.target.closest && e.target.closest('[data-act="open-settings"]');
      if (!a) return;
      e.preventDefault();
      ensureSettingsModal();
      try { if (typeof window.prepareSettingsModal === 'function') window.prepareSettingsModal(); } catch {}
      try {
        const btn = document.getElementById('btn-clear-creds');
        if (btn && !btn._bound) {
          btn._bound = true;
          btn.addEventListener('click', () => {
            if (confirm('Clear all saved (persisted) credentials for this browser?')) CREDS.clearAllPersistedCreds();
          });
        }
      } catch {}
      const el = document.getElementById('settingsModal');
      if (el && window.bootstrap) {
        const m = bootstrap.Modal.getOrCreateInstance(el);
        m.show();
      }
    });
  }

  function toggleVisibility(btn){
    try {
      const target = btn.getAttribute('data-target');
      const input = target ? document.getElementById(target) : (btn.previousElementSibling && btn.previousElementSibling.tagName === 'INPUT' ? btn.previousElementSibling : null);
      if (!input) return;
      if (input.type === 'password') {
        input.type = 'text';
        btn.innerHTML = '&#x1F441;&#xFE0E;';
        btn.setAttribute('title', 'Hide');
      } else {
        input.type = 'password';
        btn.innerHTML = '&#x1F576;&#xFE0E;';
        btn.setAttribute('title', 'Show');
      }
    } catch {}
  }
  function wireVisibility(){
    document.addEventListener('click', (e) => {
      const b = e.target && e.target.closest && e.target.closest('[data-act="toggle-visible"]');
      if (!b) return;
      e.preventDefault();
      toggleVisibility(b);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { wireSettingsLink(); wireVisibility(); });
  } else {
    wireSettingsLink();
    wireVisibility();
  }
})();
