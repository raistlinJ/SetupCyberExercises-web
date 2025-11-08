// Shared credential persistence & visibility utilities
(function(){
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
  function setPersistCtfdToken(pid, token, persist){
    try {
      if (!persist) { localStorage.removeItem(ctfdKey(pid)); return; }
      localStorage.setItem(ctfdKey(pid), JSON.stringify({ token_enc: xorEncode(token || '') }));
    } catch {}
  }
  function readPersistCtfdToken(pid){
    try {
      const raw = localStorage.getItem(ctfdKey(pid));
      if (!raw) return '';
      const obj = JSON.parse(raw);
      return obj && obj.token_enc ? xorDecode(obj.token_enc) : '';
    } catch {
      return '';
    }
  }
  function setPersistProxCreds(pid, username, password, persist){
    try {
      if (!persist) { localStorage.removeItem(proxKey(pid)); return; }
      localStorage.setItem(proxKey(pid), JSON.stringify({ u_enc: xorEncode(username || ''), p_enc: xorEncode(password || '') }));
    } catch {}
  }
  function readPersistProxCreds(pid){
    try {
      const raw = localStorage.getItem(proxKey(pid));
      if (!raw) return {};
      const obj = JSON.parse(raw);
      return (obj && (obj.u_enc || obj.p_enc)) ? { username: xorDecode(obj.u_enc || ''), password: xorDecode(obj.p_enc || '') } : {};
    } catch {
      return {};
    }
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

  function ensureSettingsModal(){
    if (document.getElementById('settingsModal')) return;
    const div = document.createElement('div');
    div.innerHTML = `
<div class="modal fade" id="settingsModal" tabindex="-1" aria-hidden="true">
  <div class="modal-dialog">
    <div class="modal-content">
      <div class="modal-header"><h5 class="modal-title">Settings</h5><button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Close"></button></div>
      <div class="modal-body">
        <ul class="nav nav-tabs" id="settings-tabs" role="tablist">
          <li class="nav-item" role="presentation">
            <button class="nav-link active" id="settings-tab-general" data-bs-toggle="tab" data-bs-target="#settings-pane-general" type="button" role="tab" aria-controls="settings-pane-general" aria-selected="true">General</button>
          </li>
          <li class="nav-item" role="presentation">
            <button class="nav-link" id="settings-tab-notifications" data-bs-toggle="tab" data-bs-target="#settings-pane-notifications" type="button" role="tab" aria-controls="settings-pane-notifications" aria-selected="false">Notifications</button>
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
            <h6 class="text-uppercase text-muted mb-2">Text-to-Speech</h6>
            <p id="settings-tts-support-note" class="small text-muted mb-2">Applies to supported browsers.</p>
            <div class="row g-2 mb-3">
              <div class="col">
                <label class="form-label small mb-1" for="settings-tts-rate">Speech rate</label>
                <input class="form-control form-control-sm" type="number" step="0.1" min="0.5" max="2.0" id="settings-tts-rate" value="1">
              </div>
              <div class="col">
                <label class="form-label small mb-1" for="settings-tts-pitch">Speech pitch</label>
                <input class="form-control form-control-sm" type="number" step="0.1" min="0" max="2.0" id="settings-tts-pitch" value="1">
              </div>
            </div>
            <p class="small text-muted mb-3">Adjust how quickly and how high announcements are spoken by the browser.</p>
            <hr/>
            <h6 class="text-uppercase text-muted mb-2">Security</h6>
            <p class="small text-muted">Manage locally saved API tokens and credentials stored only in this browser (never on the server).</p>
            <button type="button" class="btn btn-outline-danger btn-sm" id="btn-clear-creds">Clear Saved Credentials</button>
            <div id="clear-creds-feedback" class="small mt-2"></div>
            <hr/>
            <h6 class="text-uppercase text-muted mb-2">Plugins</h6>
            <div class="text-muted small">No plugins configured.</div>
          </div>
          <div class="tab-pane fade" id="settings-pane-notifications" role="tabpanel" aria-labelledby="settings-tab-notifications">
            <h6 class="text-uppercase text-muted mb-2">Notifications</h6>
            <p class="small text-muted mb-3">Each event can play an audio clip and speak a template-based message. When enabled, the template wraps the placeholders you enter for the live announcement.</p>
            <div class="mb-3">
              <div class="d-flex justify-content-between align-items-center">
                <label class="form-label mb-0">CTFd User First-Place Sound</label>
                <div class="form-check form-switch m-0">
                  <input class="form-check-input" type="checkbox" id="settings-audio-ctfd-user-toggle">
                  <label class="form-check-label small text-muted" for="settings-audio-ctfd-user-toggle">Enabled</label>
                </div>
              </div>
              <div class="d-flex flex-wrap gap-2 mt-2">
                <label class="btn btn-outline-secondary btn-sm mb-0">
                  Choose File<input type="file" id="settings-audio-ctfd-user" accept="audio/*" hidden>
                </label>
                <button type="button" class="btn btn-outline-secondary btn-sm" id="settings-audio-ctfd-user-preview" disabled>Preview</button>
                <button type="button" class="btn btn-outline-danger btn-sm" id="settings-audio-ctfd-user-clear" disabled>Clear</button>
              </div>
              <div class="small text-muted" id="settings-audio-ctfd-user-label">Using built-in tone.</div>
              <div class="form-check form-switch mt-2">
                <input class="form-check-input" type="checkbox" id="settings-audio-ctfd-user-speak">
                <label class="form-check-label small text-muted" id="settings-audio-ctfd-user-speak-label" for="settings-audio-ctfd-user-speak">Announce winner via text-to-speech</label>
              </div>
              <div class="row g-2 mt-2">
                <div class="col-12">
                  <label class="form-label small mb-1" for="settings-audio-ctfd-user-speak-template">Speech Template</label>
                  <input class="form-control form-control-sm" type="text" id="settings-audio-ctfd-user-speak-template" placeholder="Include {{audio}} to play the sound (e.g., {{audio}} Congratulations {{first_team}}!)">
                </div>
                <div class="col-12">
                  <div class="form-text text-muted mb-1">The template wraps your placeholders when text-to-speech runs.</div>
                  <div class="form-text" id="settings-audio-ctfd-user-speak-help">Placeholders: {{audio}}, {{leader}}, {{first_team}}, {{second_team}}, {{third_team}}, {{project}}, {{project_clause}}</div>
                </div>
              </div>
            </div>
            <div class="mb-3">
              <div class="d-flex justify-content-between align-items-center">
                <label class="form-label mb-0">CTFd Team First-Place Sound</label>
                <div class="form-check form-switch m-0">
                  <input class="form-check-input" type="checkbox" id="settings-audio-ctfd-team-toggle">
                  <label class="form-check-label small text-muted" for="settings-audio-ctfd-team-toggle">Enabled</label>
                </div>
              </div>
              <div class="d-flex flex-wrap gap-2 mt-2">
                <label class="btn btn-outline-secondary btn-sm mb-0">
                  Choose File<input type="file" id="settings-audio-ctfd-team" accept="audio/*" hidden>
                </label>
                <button type="button" class="btn btn-outline-secondary btn-sm" id="settings-audio-ctfd-team-preview" disabled>Preview</button>
                <button type="button" class="btn btn-outline-danger btn-sm" id="settings-audio-ctfd-team-clear" disabled>Clear</button>
              </div>
              <div class="small text-muted" id="settings-audio-ctfd-team-label">Using built-in tone.</div>
              <div class="form-check form-switch mt-2">
                <input class="form-check-input" type="checkbox" id="settings-audio-ctfd-team-speak">
                <label class="form-check-label small text-muted" id="settings-audio-ctfd-team-speak-label" for="settings-audio-ctfd-team-speak">Announce winner via text-to-speech</label>
              </div>
              <div class="row g-2 mt-2">
                <div class="col-12">
                  <label class="form-label small mb-1" for="settings-audio-ctfd-team-speak-template">Speech Template</label>
                  <input class="form-control form-control-sm" type="text" id="settings-audio-ctfd-team-speak-template" placeholder="Include {{audio}} to play the sound (e.g., {{audio}} {{first_team}} is now in first place)">
                </div>
                <div class="col-12">
                  <div class="form-text text-muted mb-1">The template wraps your placeholders when text-to-speech runs.</div>
                  <div class="form-text" id="settings-audio-ctfd-team-speak-help">Placeholders: {{audio}}, {{first_team}}, {{second_team}}, {{third_team}}, {{project}}, {{project_clause}}</div>
                </div>
              </div>
            </div>
            <div class="mb-3">
              <div class="d-flex justify-content-between align-items-center">
                <label class="form-label mb-0">CTFd First Score Sound</label>
                <div class="form-check form-switch m-0">
                  <input class="form-check-input" type="checkbox" id="settings-audio-ctfd-score-toggle">
                  <label class="form-check-label small text-muted" for="settings-audio-ctfd-score-toggle">Enabled</label>
                </div>
              </div>
              <div class="d-flex flex-wrap gap-2 mt-2">
                <label class="btn btn-outline-secondary btn-sm mb-0">
                  Choose File<input type="file" id="settings-audio-ctfd-score" accept="audio/*" hidden>
                </label>
                <button type="button" class="btn btn-outline-secondary btn-sm" id="settings-audio-ctfd-score-preview" disabled>Preview</button>
                <button type="button" class="btn btn-outline-danger btn-sm" id="settings-audio-ctfd-score-clear" disabled>Clear</button>
              </div>
              <div class="small text-muted" id="settings-audio-ctfd-score-label">Using built-in tone.</div>
              <div class="form-check form-switch mt-2">
                <input class="form-check-input" type="checkbox" id="settings-audio-ctfd-score-speak">
                <label class="form-check-label small text-muted" id="settings-audio-ctfd-score-speak-label" for="settings-audio-ctfd-score-speak">Announce scorer via text-to-speech</label>
              </div>
              <div class="row g-2 mt-2">
                <div class="col-12">
                  <label class="form-label small mb-1" for="settings-audio-ctfd-score-speak-template">Speech Template</label>
                  <input class="form-control form-control-sm" type="text" id="settings-audio-ctfd-score-speak-template" placeholder="Include {{audio}} to play the sound (e.g., {{audio}} First score goes to {{leader}})">
                </div>
                <div class="col-12">
                  <div class="form-text text-muted mb-1">The template wraps your placeholders when text-to-speech runs.</div>
                  <div class="form-text" id="settings-audio-ctfd-score-speak-help">Placeholders: {{audio}}, {{leader}}, {{user_first}}, {{team_first}}, {{team_clause}}, {{challenge}}, {{challenge_clause}}, {{points}}, {{points_clause}}, {{project}}, {{project_clause}}, {{first_team}}, {{second_team}}, {{third_team}}</div>
                </div>
              </div>
            </div>
            <div class="mb-3">
              <div class="d-flex justify-content-between align-items-center">
                <label class="form-label mb-0">Countdown Alert Sound</label>
                <div class="form-check form-switch m-0">
                  <input class="form-check-input" type="checkbox" id="settings-audio-ctfd-countdown-toggle">
                  <label class="form-check-label small text-muted" for="settings-audio-ctfd-countdown-toggle">Enabled</label>
                </div>
              </div>
              <div class="d-flex flex-wrap gap-2 mt-2">
                <label class="btn btn-outline-secondary btn-sm mb-0">
                  Choose File<input type="file" id="settings-audio-ctfd-countdown" accept="audio/*" hidden>
                </label>
                <button type="button" class="btn btn-outline-secondary btn-sm" id="settings-audio-ctfd-countdown-preview" disabled>Preview</button>
                <button type="button" class="btn btn-outline-danger btn-sm" id="settings-audio-ctfd-countdown-clear" disabled>Clear</button>
              </div>
              <div class="small text-muted" id="settings-audio-ctfd-countdown-label">Using built-in tone.</div>
              <div class="form-check form-switch mt-2">
                <input class="form-check-input" type="checkbox" id="settings-audio-ctfd-countdown-speak">
                <label class="form-check-label small text-muted" id="settings-audio-ctfd-countdown-speak-label" for="settings-audio-ctfd-countdown-speak">Announce completion via text-to-speech</label>
              </div>
              <div class="row g-2 mt-2">
                <div class="col-12">
                  <label class="form-label small mb-1" for="settings-audio-ctfd-countdown-speak-template">Speech Template</label>
                  <input class="form-control form-control-sm" type="text" id="settings-audio-ctfd-countdown-speak-template" placeholder="Include {{audio}} to play the sound (e.g., {{audio}} Countdown complete {{reason_clause}})">
                </div>
                <div class="col-12">
                  <div class="form-text text-muted mb-1">The template wraps your placeholders when text-to-speech runs.</div>
                  <div class="form-text" id="settings-audio-ctfd-countdown-speak-help">Placeholders: {{audio}}, {{reason}}, {{reason_clause}}, {{countdown_seconds}}, {{first_team}}, {{second_team}}, {{third_team}}</div>
                </div>
              </div>
              <div class="small text-muted mt-1">Files are stored locally in this browser (max 600 KB each).</div>
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
        btn.innerHTML = '\\u{1F441}\\u{FE0E}';
        btn.setAttribute('title', 'Hide');
      } else {
        input.type = 'password';
        btn.innerHTML = '\\u{1F576}\\u{FE0E}';
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
