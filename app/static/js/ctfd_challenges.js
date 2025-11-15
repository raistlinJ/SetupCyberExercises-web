/* CTFd Challenges Stats Page */
(function(){
  const el = sel => document.querySelector(sel);
  const tableWrap = el('#table-wrap');
  const btnRefresh = el('#btn-refresh');
  const btnDownload = el('#btn-download');
  const prog = el('#progress');
  const progBar = el('#progress-bar');
  const selInterval = el('#auto-interval');
  const inputFilter = el('#filter-text');
  const chkFilterRegex = el('#toggle-filter-regex');
  const btnFilterClear = el('#filter-clear');
  const btnSetVisible = el('#btn-set-visible');
  const btnSetHidden = el('#btn-set-hidden');
  const toastWrap = el('#toast-wrap');
  const chkHideHidden = el('#toggle-hide-hidden');
  const chkDetailed = el('#toggle-detailed-solves');
  // Multi-project UI
  const btnProjects = el('#btn-projects');
  const projectsCount = el('#projects-count');
  const projectsList = () => document.getElementById('projects-list');
  const projectsFilter = () => document.getElementById('projects-filter');
  const projectsFilterClear = () => document.getElementById('projects-filter-clear');
  const projectsSelectCurrent = () => document.getElementById('projects-select-current');
  const projectsSelectAll = () => document.getElementById('projects-select-all');
  const projectsClear = () => document.getElementById('projects-clear');
  const projectsApply = () => document.getElementById('projects-apply');

  let autoTimer = null;
  let lastData = [];
  let projectInfo = null; // cached project for fixed pid (single)
  let PROJECTS = []; // all known projects (for modal)
  let SELECTED_PIDS = null; // array of project ids in merged mode; null => single-project mode using getFixedPid()
  let sortKey = 'name'; // name | category | solves | points | teams | users
  let sortDir = 'asc';
  let filterText = '';
  let filterIsRegex = false;
  let selected = new Set();
  // When true, we hide hidden challenges. UI checkbox now means 'Include Hidden'.
  // includeHidden: when true, show hidden challenges; when false, filter them out
  let includeHidden = true;
  let detailedSolves = false; // when false, only counts are fetched (no names)
  // Track current progress percentage to ensure monotonic (non-decreasing) updates per refresh
  let progPct = 0;
  // Track last intended action for auto-retry after login
  let lastAction = { type: 'refresh', payload: null };
  // Persist expanded <details> state for teams/users per challenge id (only applies in detailedSolves mode)
  let expandedTeams = new Set();
  let expandedUsers = new Set();
  function expKey(){ const keyPid = Array.isArray(SELECTED_PIDS) && SELECTED_PIDS.length ? SELECTED_PIDS.slice().sort().join(',') : getFixedPid(); return `toolhub.ctfd.chals.exp.${keyPid||'none'}`; }
  function readExpanded(){ try { const raw = sessionStorage.getItem(expKey()); if(!raw) return; const obj = JSON.parse(raw); if (obj && Array.isArray(obj.t)) expandedTeams = new Set(obj.t); if (obj && Array.isArray(obj.u)) expandedUsers = new Set(obj.u); } catch {} }
  function writeExpanded(){ try { sessionStorage.setItem(expKey(), JSON.stringify({ t: Array.from(expandedTeams), u: Array.from(expandedUsers) })); } catch {} }

  // Column visibility (per project)
  const COL_DEFAULTS = { project:false, name:true, category:true, solves:true, points:true, visible:true, teams:true, users:true };
  let COLS = { ...COL_DEFAULTS };
  function colsKey(){ const keyPid = SELECTED_PIDS && SELECTED_PIDS.length ? SELECTED_PIDS.slice().sort().join(',') : getFixedPid(); return `toolhub.ctfd.chals.cols.${keyPid||'none'}`; }
  function readCols(){ try { const raw = sessionStorage.getItem(colsKey()); return raw ? { ...COL_DEFAULTS, ...JSON.parse(raw) } : { ...COL_DEFAULTS }; } catch { return { ...COL_DEFAULTS }; } }
  function writeCols(){ try { sessionStorage.setItem(colsKey(), JSON.stringify(COLS||{})); } catch {} }
  function wireCols(){
    const ids = ['project','name','category','solves','points','visible','teams','users'];
    ids.forEach(id=>{
      const el = document.getElementById(`chals-col-${id}`);
      if (el && !el._toolhubBound) {
        el.addEventListener('change', ()=>{ COLS[id] = !!el.checked; writeCols(); renderTable(lastData); });
        el._toolhubBound = true;
      }
    });
  }

  // --- Multi-project helpers (moved in-scope) ---
  const STORE_KEY = 'toolhub.ctfd.chals.selectedPids.v1';
  const MGR_STORE_SELECTED = 'toolhub.ctfd.mgr.selectedPids.v1';
  function currentPid(){ try { return getFixedPid(); } catch { return ''; } }
  async function fetchAllProjects(){ try { const r = await fetch('/api/projects'); const j = await r.json(); return j?.projects||[]; } catch { return []; } }
  async function ensureAllProjects(){
    if (Array.isArray(PROJECTS) && PROJECTS.length) return;
    PROJECTS = await fetchAllProjects();
  }
  function readSelected(){ try { const raw = sessionStorage.getItem(STORE_KEY); const arr = raw? JSON.parse(raw): null; return Array.isArray(arr)? arr: null; } catch { return null; } }
  function writeSelected(arr){ try { sessionStorage.setItem(STORE_KEY, JSON.stringify(arr||[])); } catch {} }
  function updateBadge(){ try { const c = document.getElementById('projects-count'); if (!c) return; const arr = SELECTED_PIDS; const n = Array.isArray(arr)? arr.length : 1; c.textContent = String(n); c.className = 'badge '+(n>1?'bg-primary':'bg-secondary'); } catch {} }
  function renderList(filter){
    const host = document.getElementById('projects-list'); if (!host) return;
    const arr = PROJECTS || [];
    const f = (filter||'').toLowerCase();
    const items = arr.filter(p => !f || (String(p.name||'').toLowerCase().includes(f) || String(p.tag||'').toLowerCase().includes(f)));
    const cur = String(currentPid()||'');
    const sel = new Set(SELECTED_PIDS || [cur].filter(Boolean));
    if (cur) sel.add(cur);
    host.innerHTML = items.map(p => {
      const pid = String(p.id);
      const isCur = cur && pid===cur;
      const on = sel.has(pid) ? 'checked' : '';
      const dis = isCur ? 'disabled' : '';
      const tip = isCur ? 'title="Current project (always selected)"' : '';
      return `<label class="list-group-item d-flex align-items-center gap-2">`
            + `<input type="checkbox" class="form-check-input" data-pid="${p.id}" ${on} ${dis} ${tip} />`
            + `<div class="flex-grow-1">`
            + `<div><strong>${escapeHtml(p.name)}</strong></div>`
            + `<div class="small text-muted">${escapeHtml(p.tag||'')}</div>`
            + `</div>`
            + `<span class="badge bg-secondary" title="Instances">${Number(p.instances||0)}</span>`
            + `</label>`;
    }).join('');
  }
  async function setupProjectsUi(){
    await ensureAllProjects();
    // Initialize selection
    SELECTED_PIDS = readSelected();
    // If Manager has multiple projects selected, adopt them as default for Challenges when our own isn't already multi
    try {
      const raw = sessionStorage.getItem(MGR_STORE_SELECTED);
      const mgrSel = raw ? JSON.parse(raw) : null;
      const isMgrMulti = Array.isArray(mgrSel) && mgrSel.length > 1;
      const isChalsMulti = Array.isArray(SELECTED_PIDS) && SELECTED_PIDS.length > 1;
      if (isMgrMulti && !isChalsMulti) {
        const set = new Set();
        const known = new Set((PROJECTS||[]).map(p=> String(p.id)));
        for (const pid of mgrSel) { const s = String(pid); if (known.has(s)) set.add(s); }
        // Always include current
        const cur = String(currentPid()||''); if (cur) set.add(cur);
        SELECTED_PIDS = Array.from(set);
        writeSelected(SELECTED_PIDS);
        // Ensure Project column visible in multi
        try {
          COLS = readCols();
          const multi = Array.isArray(SELECTED_PIDS) && SELECTED_PIDS.length>1;
          if (multi) {
            const chk = document.getElementById('chals-col-project'); if (chk) chk.checked = true;
            COLS.project = true;
            writeCols();
          }
        } catch {}
      }
    } catch {}
    // Always include current project in any existing selection
    try { const cur = String(currentPid()||''); if (cur) { if (Array.isArray(SELECTED_PIDS)) { if (!SELECTED_PIDS.includes(cur)) SELECTED_PIDS.push(cur); } } } catch {}
    // Reflect initial badge
    updateBadge();
    // Wire modal controls
    const filter = document.getElementById('projects-filter');
    const clearBtn = document.getElementById('projects-filter-clear');
    const selCur = document.getElementById('projects-select-current');
    const selAll = document.getElementById('projects-select-all');
    const clr = document.getElementById('projects-clear');
    const apply = document.getElementById('projects-apply');
    renderList('');
    if (filter) filter.addEventListener('input', ()=> renderList(filter.value||''));
    if (clearBtn) clearBtn.addEventListener('click', ()=>{ if (filter) filter.value=''; renderList(''); });
    if (selCur) selCur.addEventListener('click', ()=>{
      const pid = currentPid();
      SELECTED_PIDS = pid? [pid]: [];
      renderList(filter?filter.value:'');
    });
    if (selAll) selAll.addEventListener('click', ()=>{
      const cur = currentPid();
      const list = (PROJECTS||[]).map(p=> String(p.id));
      if (cur && !list.includes(cur)) list.push(cur);
      SELECTED_PIDS = list;
      renderList(filter?filter.value:'');
    });
    if (clr) clr.addEventListener('click', ()=>{
      const cur = currentPid();
      SELECTED_PIDS = cur? [cur] : [];
      renderList(filter?filter.value:'');
    });
    if (apply) apply.addEventListener('click', ()=>{
      try {
        const host = document.getElementById('projects-list');
        const boxes = host ? Array.from(host.querySelectorAll('input[type="checkbox"][data-pid]')) : [];
        const cur = currentPid();
        let ids = boxes.filter(b=>b.checked).map(b=> String(b.getAttribute('data-pid')));
        if (cur && !ids.includes(cur)) ids.push(cur);
        // If only current is selected, revert to single-project mode
        SELECTED_PIDS = (ids.length === 1 && cur && ids[0] === cur) ? null : ids;
        writeSelected(SELECTED_PIDS);
        updateBadge();
        // Force columns to show Project when multiple
        try {
          COLS = readCols();
          const multi = Array.isArray(SELECTED_PIDS) && SELECTED_PIDS.length>1;
          const chk = document.getElementById('chals-col-project'); if (chk) chk.checked = !!(multi || COLS.project);
          COLS.project = !!(multi || COLS.project);
          writeCols();
        } catch {}
        // Close modal and refresh
        try { const el = document.getElementById('projectsModal'); if (el && window.bootstrap) { const m = bootstrap.Modal.getInstance(el) || bootstrap.Modal.getOrCreateInstance(el); m.hide(); } } catch {}
        setTimeout(()=> refresh(), 50);
      } catch { }
    });
    // Persist checkbox clicks live (mirror current selection)
    const host = document.getElementById('projects-list');
    if (host) host.addEventListener('change', (e)=>{
      const cb = e.target && e.target.matches && e.target.matches('input[type="checkbox"][data-pid]') ? e.target : null;
      if (!cb) return;
      const pid = String(cb.getAttribute('data-pid'));
      if (cb.disabled) return; // current project cannot be unselected
      const set = new Set(SELECTED_PIDS || []);
      if (cb.checked) set.add(pid); else set.delete(pid);
      const cur = currentPid(); if (cur) set.add(String(cur));
      SELECTED_PIDS = Array.from(set);
    });
  }

  function readCtfdCreds(pid){
    try {
      // Prefer same-origin cookie (works reliably in popup)
      const key = `toolhub.session.ctfd.${pid}`;
      try {
        const m = document.cookie.match(new RegExp('(?:^|; )'+key.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'=([^;]*)'));
        if (m) {
          const fromCookie = JSON.parse(decodeURIComponent(m[1]||''));
          if (fromCookie && (fromCookie.token || fromCookie.username)) return fromCookie;
        }
      } catch {}
      // Next, local sessionStorage
      let obj = {};
      try { obj = JSON.parse(sessionStorage.getItem(key)||'{}'); } catch { obj = {}; }
      if (obj && (obj.token || obj.username)) return obj;
      // Fallback to opener's sessionStorage when opened as popup
      if (window.opener && window.opener.sessionStorage) {
        try {
          const raw = window.opener.sessionStorage.getItem(key) || '{}';
          const fromOpener = JSON.parse(raw);
          if (fromOpener && (fromOpener.token || fromOpener.username)) return fromOpener;
        } catch {}
      }
      return obj || {};
    } catch { return {}; }
  }

  async function loadProject(pid){
    if (projectInfo && String(projectInfo.id) === String(pid)) return projectInfo;
    try {
      const res = await fetch('/api/projects');
      if (!res.ok) throw new Error('Failed to load projects');
      const j = await res.json();
      const list = j?.projects || [];
      projectInfo = list.find(p => String(p.id) === String(pid)) || null;
    } catch (e) { console.error(e); projectInfo = null; }
    return projectInfo;
  }

  async function getCreds(pidOverride){
    const pid = pidOverride || getFixedPid();
    const proj = await loadProject(pid);
    const sess = readCtfdCreds(pid) || {};
    const url = (proj && proj.challenge_url) ? String(proj.challenge_url).trim() : '';
    const port = (proj && proj.challenge_port) ? Number(proj.challenge_port) : 443;
    const token = sess.token || '';
    const verify = true; // keep SSL verify on
    return { url, port, token, verify };
  }

  function setProgText(msg, pct){
    try{
      if (progBar) {
        progBar.textContent = msg || 'Loading…';
        if (typeof pct === 'number' && isFinite(pct)) {
          const next = Math.max(0, Math.min(100, Math.max(progPct, pct)));
          progPct = next;
          progBar.style.width = next + '%';
          progBar.setAttribute('aria-valuenow', String(Math.round(next)));
        }
      }
    } catch {}
  }

  function setBusy(b){
    if(b){ prog?.classList.remove('d-none'); } else { prog?.classList.add('d-none'); }
    if(btnRefresh) btnRefresh.disabled = b;
    if(btnDownload) btnDownload.disabled = b || (lastData.length===0);
    if(btnSetVisible) btnSetVisible.disabled = b || (selected.size===0);
    if(btnSetHidden) btnSetHidden.disabled = b || (selected.size===0);
  }

  function renderSkippedIndicator(skippedPids, reason){
    try {
      const box = document.getElementById('proj-errors');
      if (!box) return;
      if (!skippedPids || skippedPids.length === 0) { box.classList.add('d-none'); box.textContent = ''; return; }
      const byId = {}; (PROJECTS||[]).forEach(p=> byId[String(p.id)] = p);
      const names = skippedPids.map(id=> byId[String(id)]?.name || String(id));
      const data = skippedPids.map(id=> String(id)).join(',');
      box.innerHTML = `<div class="d-flex flex-wrap align-items-center gap-2"><div><strong>Some projects were skipped</strong>:</div><div>${names.map(n=>`<span class=\"badge bg-light text-dark me-1\">${escapeHtml(n)}</span>`).join(' ')}</div><button id="proj-errors-fix" type="button" class="btn btn-sm btn-outline-primary" data-pids="${escapeHtml(data)}" title="Enter/Update tokens">Fix tokens</button></div><div class="mt-1">Reason: ${escapeHtml(reason||'credential or connection issue')}. Update tokens in CTFd Manager or via the login prompt.</div>`;
      box.classList.remove('d-none');
      // Wire button
      const btn = document.getElementById('proj-errors-fix');
      if (btn && !btn._bound){
        btn._bound = true;
        btn.addEventListener('click', ()=>{
          try {
            const attr = btn.getAttribute('data-pids') || '';
            const pids = attr.split(',').map(s=>s.trim()).filter(Boolean);
            openCtfdLoginForPids(pids);
          } catch {}
        });
      }
    } catch {}
  }

  // Open CTFd login modal for specific projects and render inputs
  function openCtfdLoginForPids(pids){
    try {
      const el = document.getElementById('ctfdLoginModal');
      const list = document.getElementById('ctfdLoginList');
      const saveBtn = document.getElementById('ctfdLoginSave');
      if (!el || !list || !saveBtn || !window.bootstrap) return;
      const byId = {}; (PROJECTS||[]).forEach(p=> byId[String(p.id)] = p);
      const entries = (pids||[]).map(pid => ({ pid: String(pid), name: byId[String(pid)]?.name || String(pid) }));
      if (!entries.length) return;
      list.innerHTML = entries.map(m => `
        <div class="card">
          <div class="card-body">
            <div class="d-flex justify-content-between align-items-center mb-2">
              <div>
                <div><strong>${escapeHtml(m.name)}</strong></div>
                <div class="small text-muted">Project ID: ${escapeHtml(m.pid)}</div>
              </div>
            </div>
            <div class="input-group input-group-sm">
              <span class="input-group-text">API Token</span>
              <div class="input-group">
                <input type="password" class="form-control ctfd-token-input" data-pid="${m.pid}" placeholder="ctfd_…" value="${(()=>{ try { const raw = localStorage.getItem('toolhub.ctfd.persist.${m.pid}'); if (raw) { const obj = JSON.parse(raw); if (obj && obj.token) return escapeHtml(obj.token); } } catch {} return ''; })()}">
                <button class="btn btn-outline-secondary" type="button" data-act="toggle-visible" title="Show">&#x1F576;&#xFE0E;</button>
              </div>
            </div>
          </div>
        </div>
      `).join('');
      const m = bootstrap.Modal.getInstance(el) || bootstrap.Modal.getOrCreateInstance(el);
      m.show();
      // If any tokens persisted, check the save creds checkbox for clarity
      try {
        let anyPersist = false; (pids||[]).forEach(pid => { try { if (localStorage.getItem(`toolhub.ctfd.persist.${pid}`)) anyPersist = true; } catch {} });
        const c = document.getElementById('chals-save-creds'); if (c && anyPersist) c.checked = true;
      } catch {}
    } catch {}
  }

  function renderTable(items){
    lastData = Array.isArray(items) ? items : [];
    // ensure COLS is loaded and reflect UI checkboxes if present
    try { COLS = readCols(); const ids=['project','name','category','solves','points','visible','teams','users']; ids.forEach(id=>{ const el=document.getElementById(`chals-col-${id}`); if(el) el.checked = !!COLS[id]; }); } catch {}
    // Filtering
    const rawFilter = (filterText||'').trim();
    const t = filterIsRegex ? rawFilter : rawFilter.toLowerCase();
    let filtered = lastData.slice();
    // When includeHidden is false we filter out hidden items
    if (!includeHidden) {
      filtered = filtered.filter(it => it.visible !== false);
    }
    // Text filter across all columns: name, category, solves, points, visibility label, team names, user names, counts
    if (rawFilter) {
      if (filterIsRegex) {
        let re = null;
        try { re = new RegExp(rawFilter, 'i'); } catch (e) {
          // Invalid regex: gracefully fallback to simple includes (case-insensitive)
          const ft = rawFilter.toLowerCase();
          filtered = filtered.filter(it => {
            const visLabel = (it.visible === true) ? 'visible' : (it.visible === false) ? 'hidden' : 'unknown';
            const fields = [
              it.name||'', it.category||'', String(it.solves||0), String((it.value!=null?it.value:it.points)||0), visLabel,
              String((it.teams||[]).length||0), String((it.users||[]).length||0),
              ...(it.teams||[]).map(x=>x.name||''), ...(it.users||[]).map(x=>x.name||''),
            ];
            return fields.join(' ').toLowerCase().includes(ft);
          });
          re = null;
        }
        if (re) {
          filtered = filtered.filter(it => {
            const visLabel = (it.visible === true) ? 'visible' : (it.visible === false) ? 'hidden' : 'unknown';
            const fields = [
              it.name||'', it.category||'', String(it.solves||0), String((it.value!=null?it.value:it.points)||0), visLabel,
              String((it.teams||[]).length||0), String((it.users||[]).length||0),
              ...(it.teams||[]).map(x=>x.name||''), ...(it.users||[]).map(x=>x.name||''),
            ];
            return re.test(fields.join(' '));
          });
        }
      } else {
        filtered = filtered.filter(it => {
          const visLabel = (it.visible === true) ? 'visible' : (it.visible === false) ? 'hidden' : 'unknown';
          const fields = [
            it.name||'', it.category||'', String(it.solves||0), String((it.value!=null?it.value:it.points)||0), visLabel,
            String((it.teams||[]).length||0), String((it.users||[]).length||0),
            ...(it.teams||[]).map(x=>x.name||''), ...(it.users||[]).map(x=>x.name||''),
          ];
          return fields.join(' ').toLowerCase().includes(t);
        });
      }
    }
    // Sorting
    const safeNum = v => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
    const cmp = (a,b) => {
      const dir = (sortDir === 'desc') ? -1 : 1;
      let va, vb;
      if (sortKey === 'name') { va = (a.name||'').toLowerCase(); vb = (b.name||'').toLowerCase(); }
      else if (sortKey === 'category') { va = (a.category||'').toLowerCase(); vb = (b.category||'').toLowerCase(); }
      else if (sortKey === 'solves') { va = safeNum(a.solves); vb = safeNum(b.solves); }
      else if (sortKey === 'points') { va = safeNum((a.value!=null?a.value:a.points)); vb = safeNum((b.value!=null?b.value:b.points)); }
      else if (sortKey === 'project') {
        const an = (a._proj?.name||'').toLowerCase();
        const bn = (b._proj?.name||'').toLowerCase();
        if (an !== bn) return (an < bn ? -1 : 1) * dir;
        const at = (a._proj?.tag||'').toLowerCase();
        const bt = (b._proj?.tag||'').toLowerCase();
        if (at !== bt) return (at < bt ? -1 : 1) * dir;
        va = (a.name||'').toLowerCase(); vb = (b.name||'').toLowerCase();
        if (va < vb) return -1*dir; if (va > vb) return 1*dir; return 0;
      }
      else if (sortKey === 'teams') { va = (a.teams||[]).length; vb = (b.teams||[]).length; }
      else if (sortKey === 'users') { va = (a.users||[]).length; vb = (b.users||[]).length; }
      else { va = (a.name||'').toLowerCase(); vb = (b.name||'').toLowerCase(); }
      if (va < vb) return -1*dir; if (va > vb) return 1*dir; return 0;
    };
    try { filtered.sort(cmp); } catch {}

    const baseUrlSingle = ((projectInfo && projectInfo.challenge_url) ? String(projectInfo.challenge_url) : '').replace(/\/$/,'');
    const ensureAdminBase = url => {
      const trimmed = (url || '').replace(/\/+$/,'');
      if (!trimmed) return '';
      if (/(^|\/)admin(?:\/|$)/.test(trimmed)) return trimmed;
      return `${trimmed}/admin`;
    };
    const icon = key => {
      const active = (sortKey === key);
      const cls = active ? (sortDir==='asc' ? 'bi-caret-up-fill' : 'bi-caret-down-fill') : 'bi-dot';
      const aria = active ? (sortDir==='asc' ? 'ascending' : 'descending') : 'none';
      return { cls, aria };
    };
    const hdr = (label, key) => {
      const ic = icon(key);
      return `<th role="columnheader" aria-sort="${ic.aria}" style="cursor:pointer; white-space:nowrap" data-sort="${key}">${label} <i class="bi ${ic.cls}"></i></th>`;
    };

    const rows = filtered.map(it=>{
      const selKey = compositeId(it);
      const baseUrl = (it._proj && it._proj.challenge_url ? String(it._proj.challenge_url) : baseUrlSingle).replace(/\/$/,'');
      const teamCount = Number((it.teams_count!=null?it.teams_count:(it.teams||[]).length) || 0);
      const userCount = Number((it.users_count!=null?it.users_count:(it.users||[]).length) || 0);
      const teamBadges = detailedSolves ? (it.teams||[]).map(t=>{
        const ord = (t.ord!=null ? String(t.ord)+'. ' : '');
        const name = escapeHtml(t.name);
        const link = (t.url || (baseUrl && t.id!=null ? `${baseUrl}/teams/${encodeURIComponent(String(t.id))}` : ''));
        const title = t.ts ? ` title="Solved at: ${escapeHtml(String(t.ts))}"` : '';
        return link ? `<a class="badge bg-secondary text-decoration-none" href="${link}" target="_blank" rel="noopener"${title}>${ord}${name}</a>`
                    : `<span class="badge bg-secondary"${title}>${ord}${name}</span>`;
      }).join(' ') : '<span class="text-muted">n/a</span>';
      const userBadges = detailedSolves ? (it.users||[]).map(u=>{
        const ord = (u.ord!=null ? String(u.ord)+'. ' : '');
        const name = escapeHtml(u.name);
        const link = (u.url || (baseUrl && u.id!=null ? `${baseUrl}/users/${encodeURIComponent(String(u.id))}` : ''));
        const title = u.ts ? ` title="Solved at: ${escapeHtml(String(u.ts))}"` : '';
        return link ? `<a class="badge bg-info text-dark text-decoration-none" href="${link}" target="_blank" rel="noopener"${title}>${ord}${name}</a>`
                    : `<span class="badge bg-info text-dark"${title}>${ord}${name}</span>`;
      }).join(' ') : '<span class="text-muted">n/a</span>';
      const chalBase = ensureAdminBase(baseUrl);
      const chalLink = (chalBase && it.id!=null) ? `${chalBase}/challenges/${encodeURIComponent(String(it.id))}` : '';
      const chalName = chalLink ? `<a href="${chalLink}" target="_blank" rel="noopener">${escapeHtml(it.name||'')}</a>`
                                : `${escapeHtml(it.name||'')}`;
      const visBadge = (it.visible === true) ? '<span class="badge bg-success me-2">Visible</span>' : (it.visible === false) ? '<span class="badge bg-secondary me-2">Hidden</span>' : '<span class="badge bg-light text-muted me-2">Unknown</span>';
      const visActions = `<div class="btn-group btn-group-sm" role="group"><button class="btn btn-outline-success btn-row-visible" data-id="${selKey}" title="Set visible">Show</button><button class="btn btn-outline-warning btn-row-hidden" data-id="${selKey}" title="Set hidden">Hide</button></div>`;
      const visCell = `<div class="d-flex align-items-center">${visBadge}${visActions}</div>`;
      const checked = selected.has(selKey) ? 'checked' : '';
      let row = `
        <tr>
          <td style="width:1%; white-space:nowrap"><input type="checkbox" class="form-check-input row-select" data-id="${selKey}" ${checked}></td>`;
      if (COLS.project) row += `<td>${escapeHtml(it._proj?.name||'')}<div class="small text-muted">${escapeHtml(it._proj?.tag||'')}</div></td>`;
      if (COLS.name) row += `<td>${chalName}</td>`;
      if (COLS.category) row += `<td>${escapeHtml(it.category||'')}</td>`;
      if (COLS.solves) row += `<td>${Number(it.solves||0)}</td>`;
  if (COLS.points) row += `<td>${Number((it.value!=null?it.value:it.points)||0)}</td>`;
      if (COLS.visible) row += `<td>${visCell}</td>`;
  const teamSummary = detailedSolves ? `${teamCount} teams` : 'n/a';
  const userSummary = detailedSolves ? `${userCount} users` : 'n/a';
  if (COLS.teams) {
        const openAttr = (detailedSolves && expandedTeams.has(selKey)) ? ' open' : '';
        row += `<td><details data-chid="${selKey}" data-col="teams"${openAttr}><summary>${teamSummary}</summary><div class="solve-badges mt-1">${teamBadges||'<span class=\"text-muted\">n/a</span>'}</div></details></td>`;
      }
      if (COLS.users) {
        const openAttr = (detailedSolves && expandedUsers.has(selKey)) ? ' open' : '';
        row += `<td><details data-chid="${selKey}" data-col="users"${openAttr}><summary>${userSummary}</summary><div class="solve-badges mt-1">${userBadges||'<span class=\"text-muted\">n/a</span>'}</div></details></td>`;
      }
      row += `</tr>`;
      return row;
    }).join('');

    let header = `
      <thead>
        <tr>
          <th style="width:1%; white-space:nowrap"><input type="checkbox" class="form-check-input" id="select-all"></th>`;
    if (COLS.project) header += `${hdr('Project','project')}`;
    if (COLS.name) header += `${hdr('Challenge Name','name')}`;
    if (COLS.category) header += `${hdr('Category','category')}`;
    if (COLS.solves) header += `${hdr('Solves','solves')}`;
    if (COLS.points) header += `${hdr('Points','points')}`;
    if (COLS.visible) header += `<th>Visible</th>`;
    if (COLS.teams) {
      const ic = icon('teams');
      header += `<th role="columnheader" aria-sort="${ic.aria}" style="cursor:pointer; white-space:nowrap" data-sort="teams">Teams <i class="bi ${ic.cls}"></i><span id="teams-exp-toggle" class="exp-toggle" title="Toggle expand/collapse all team solves">(expand)</span></th>`;
    }
    if (COLS.users) {
      const ic = icon('users');
      header += `<th role="columnheader" aria-sort="${ic.aria}" style="cursor:pointer; white-space:nowrap" data-sort="users">Users <i class="bi ${ic.cls}"></i><span id="users-exp-toggle" class="exp-toggle" title="Toggle expand/collapse all user solves">(expand)</span></th>`;
    }
    header += `
        </tr>
      </thead>`;

    const html = `
      <table class="table table-sm table-hover align-middle" id="chals-table">
        ${header}
        <tbody>${rows}</tbody>
      </table>`;
    tableWrap.innerHTML = html;

    // Wire header click for sorting
    try {
      tableWrap.querySelectorAll('#chals-table thead th[data-sort]').forEach(th => {
        th.addEventListener('click', () => {
          const key = th.getAttribute('data-sort');
          if (!key) return;
          if (sortKey === key) sortDir = (sortDir === 'asc' ? 'desc' : 'asc'); else { sortKey = key; sortDir = 'asc'; }
          persistUiState();
          renderTable(lastData);
        });
      });
      // Wire select all
      const selAll = tableWrap.querySelector('#select-all');
      if (selAll) {
        selAll.addEventListener('change', () => {
          const check = selAll.checked;
          filtered.forEach(it => { const key = compositeId(it); if (check) selected.add(key); else selected.delete(key); });
          updateActionState();
          // update row checkboxes
          tableWrap.querySelectorAll('.row-select').forEach(cb => { cb.checked = check; });
        });
      }
      // Wire per-row selection
      tableWrap.querySelectorAll('.row-select').forEach(cb => {
        cb.addEventListener('change', () => {
          const id = cb.getAttribute('data-id');
          if (cb.checked) selected.add(id); else selected.delete(id);
          updateActionState();
        });
      });
  // Wire per-row visibility actions
      tableWrap.querySelectorAll('.btn-row-visible').forEach(btn => {
        btn.addEventListener('click', async () => {
          const id = btn.getAttribute('data-id');
          selected = new Set([id]);
          updateActionState();
          await bulkSetVisibility(true);
        });
      });
      tableWrap.querySelectorAll('.btn-row-hidden').forEach(btn => {
        btn.addEventListener('click', async () => {
          const id = btn.getAttribute('data-id');
          selected = new Set([id]);
          updateActionState();
          await bulkSetVisibility(false);
        });
      });
      // Wire details toggle events (only meaningful in detailed mode)
      if (detailedSolves) {
        tableWrap.querySelectorAll('details[data-chid][data-col]').forEach(d => {
          if (d._bound) return; d._bound = true;
            d.addEventListener('toggle', () => {
              const id = d.getAttribute('data-chid');
              const col = d.getAttribute('data-col');
              if (col === 'teams') { if (d.open) expandedTeams.add(id); else expandedTeams.delete(id); }
              else if (col === 'users') { if (d.open) expandedUsers.add(id); else expandedUsers.delete(id); }
              writeExpanded();
            });
        });
        // Header expand/collapse toggles
        const teamsToggle = document.getElementById('teams-exp-toggle');
        const usersToggle = document.getElementById('users-exp-toggle');
        const applyToggleState = () => {
          if (teamsToggle) {
            const allExpanded = filtered.length>0 && filtered.every(it=> expandedTeams.has(compositeId(it)));
            teamsToggle.textContent = allExpanded ? '(collapse)' : '(expand)';
          }
          if (usersToggle) {
            const allExpanded = filtered.length>0 && filtered.every(it=> expandedUsers.has(compositeId(it)));
            usersToggle.textContent = allExpanded ? '(collapse)' : '(expand)';
          }
        };
        applyToggleState();
        if (teamsToggle && !teamsToggle._bound){
          teamsToggle._bound = true;
          teamsToggle.addEventListener('click', ()=>{
            const allExpanded = filtered.length>0 && filtered.every(it=> expandedTeams.has(compositeId(it)));
            if (allExpanded) { expandedTeams.clear(); } else { filtered.forEach(it=> expandedTeams.add(compositeId(it))); }
            writeExpanded();
            renderTable(lastData);
          });
        }
        if (usersToggle && !usersToggle._bound){
          usersToggle._bound = true;
            usersToggle.addEventListener('click', ()=>{
              const allExpanded = filtered.length>0 && filtered.every(it=> expandedUsers.has(compositeId(it)));
              if (allExpanded) { expandedUsers.clear(); } else { filtered.forEach(it=> expandedUsers.add(compositeId(it))); }
              writeExpanded();
              renderTable(lastData);
            });
        }
      }
    } catch {}
  }

  function escapeHtml(s){
    try{ return String(s).replace(/[&<>"']/g, c=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c])); }catch{return String(s)}
  }

  function getFixedPid(){
    try { const u = new URL(window.location.href); return u.searchParams.get('id') || ''; } catch { return ''; }
  }

  // Composite id for selection/expansion when multi-project is active
  function compositeId(it){
    try { const pid = String(it._proj?.id || getFixedPid()); const cid = String(it.id); return pid + ':' + cid; } catch { return String(it.id); }
  }

  // Get concurrency from sessionStorage (1-8), default 4
  function getConcurrency(){
    try { const v = parseInt(sessionStorage.getItem('ctfd_chals_concurrency')||'4',10); return Math.min(8, Math.max(1, isNaN(v)?4:v)); } catch { return 4; }
  }

  // Verify that required CTFd credentials exist for all selected projects before running actions
  async function preflightCreds(pids, actionLabel){
    try {
      await ensureAllProjects();
      const byId = {}; (PROJECTS||[]).forEach(p=> byId[String(p.id)] = p);
      const missing = []; // missing token
      const invalid = []; // missing challenge_url/port
      for (const pid of pids){
        const creds = await getCreds(pid);
        const proj = byId[String(pid)] || (await loadProject(pid)) || { id: pid };
        const name = proj?.name || String(pid);
        if (!creds.url) invalid.push(name);
        if (!creds.token) missing.push({ pid: String(pid), name });
      }
      if (missing.length || invalid.length){
        if (invalid.length) {
          const msg = `Cannot ${actionLabel||'proceed'} — projects without CTFd URL: ${invalid.join(', ')}. Fix in CTFd Manager/settings, then retry.`;
          showToast(msg, 'danger');
        }
        if (missing.length) {
          try { openCtfdLoginForPids(missing.map(x=>x.pid)); } catch {}
        }
        return false;
      }
      return true;
    } catch { return true; }
  }

  async function refresh(){
    setBusy(true);
    // Reset progress tracking for this refresh cycle
    progPct = 0; try { if (progBar) { progBar.style.width = '0%'; progBar.setAttribute('aria-valuenow','0'); } } catch {}
    let autoAnim = null;
    try{
      const pids = Array.isArray(SELECTED_PIDS) && SELECTED_PIDS.length ? SELECTED_PIDS.slice() : (getFixedPid()? [getFixedPid()] : []);
      if(!pids.length){ tableWrap.innerHTML = '<div class="text-danger">Missing project id. Open this page from the CTFd Manager, or select projects.</div>'; return; }
      // If multiple projects, ensure creds exist for all before proceeding
      if (pids.length > 1) {
        const ok = await preflightCreds(pids, 'load challenges');
        if (!ok) { setBusy(false); return; }
      }
      // For multi-project, query each pid and merge
      const merged = [];
      let totalAcross = 0;
      // Preload project list (names) and selected project objects
  await ensureAllProjects();
  const byId = {}; PROJECTS.forEach(p=>{ byId[String(p.id)] = p; });
      // Optional: animate progress overall
      let started = false;
      const invalidAuth = []; // pids with 401/403
      const otherErrs = [];   // pids with other failures
      for (const pid of pids){
        const creds = await getCreds(pid);
        // If not detailed, use counts-only path per project
        if (!detailedSolves) {
          try {
            const items = await refreshBulkFast(creds, pid, /*returnOnly=*/true);
            items.forEach(it=> merged.push({ ...it, _proj: byId[String(pid)] }));
            totalAcross += items.length;
            if (!started) { started = true; setProgText('Merging…', Math.min(95, progPct+5)); }
          } catch (e) {
            const msg = String(e?.message||'');
            if (/\b(401|403)\b/.test(msg) || /forbidden/i.test(msg)) invalidAuth.push(pid); else otherErrs.push(pid);
          }
          continue;
        }
        // Detailed path: bulk first, fallback per-challenge for this pid
        try {
          const items = await refreshBulkFast(creds, pid, /*returnOnly=*/true);
          items.forEach(it=> merged.push({ ...it, _proj: byId[String(pid)] }));
          totalAcross += items.length;
          if (!started) { started = true; setProgText('Merging…', Math.min(95, progPct+5)); }
        } catch (bulkErr) {
          console.warn('[ctfd_challenges] Bulk detailed fetch failed (pid='+pid+'), falling back:', bulkErr);
          try {
            const items = await refreshPerChallengeDetailed(creds, autoAnim, pid, /*returnOnly=*/true);
            items.forEach(it=> merged.push({ ...it, _proj: byId[String(pid)] }));
            totalAcross += items.length;
          } catch (e2) {
            const msg = String(e2?.message||'');
            if (/\b(401|403)\b/.test(msg) || /forbidden/i.test(msg)) invalidAuth.push(pid); else otherErrs.push(pid);
          }
        }
      }
      // Render merged
  const prev = new Set(selected);
      renderTable(merged);
      try { const ids = new Set(merged.map(it => compositeId(it))); selected = new Set(Array.from(prev).filter(id => ids.has(id))); updateActionState(); } catch {}
      btnDownload && (btnDownload.disabled = (lastData.length===0));
      setProgText('Done', 100);
      // Notify about any invalid tokens or other failures; show persistent indicator
      try {
        const skipped = [...new Set([...invalidAuth, ...otherErrs])];
        renderSkippedIndicator(skipped, invalidAuth.length ? 'invalid or missing token' : 'connection or configuration error');
        if (invalidAuth.length) {
          const names = invalidAuth.map(id=> (byId[String(id)]?.name || String(id))).join(', ');
          showToast(`CTFd token invalid for: ${names}. Ignoring these projects until updated.`, 'warning');
        }
        if (otherErrs.length) {
          const names = otherErrs.map(id=> (byId[String(id)]?.name || String(id))).join(', ');
          showToast(`Failed to load challenges for: ${names}. See console for details.`, 'danger');
        }
      } catch {}
      return;
    }catch(e){
      console.error('[ctfd_challenges] refresh failed:', e);
      const msg = String(e?.message||e||'Error');
      showToast(`Failed to refresh challenges: ${msg}`, 'danger');
    } finally { if (autoAnim) { try { clearInterval(autoAnim); } catch {} } setBusy(false); }
  }

  // Legacy detailed path retained as a fallback when bulk detailed stats cannot be used.
  async function refreshPerChallengeDetailed(creds, autoAnimRef, pid, returnOnly){
    pid = pid || getFixedPid();
    setProgText('Fetching challenges…', 10);
    let total = 0; let list = [];
    try {
      const body1 = { baseUrl: creds.url, token: creds.token, port: creds.port, verifySSL: creds.verify };
      let res1;
      await runQueued(`CTFd challenges list for project ${pid}`, async () => {
        res1 = await fetch(`/api/projects/${encodeURIComponent(pid)}/ctfd/challenges/list`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body1) });
      });
      if (res1.ok) { const j1 = await res1.json(); list = Array.isArray(j1?.challenges) ? j1.challenges : []; total = list.length; }
    } catch {}
  if (!Array.isArray(list) || list.length === 0) { return await refreshBulkFast(creds, pid, returnOnly); }
    if (total > 0) setProgText(`Fetching 0 of ${total}…`, 20);
    try { let pct = 20; if(!autoAnimRef){ autoAnimRef = setInterval(()=>{ pct = Math.min(pct + 2, 85); setProgText(progBar?.textContent || 'Working…', pct); }, 500); } } catch {}
    const items = new Array(total);
    let done = 0; let index = 0;
    const conc = getConcurrency();
    async function worker(){
      while (true) {
        if (index >= total) return;
        const i = index; index++;
        const ch = list[i];
        try {
          const body = { baseUrl: creds.url, port: creds.port, token: creds.token, verifySSL: creds.verify };
          let res;
          await runQueued(`CTFd challenge ${ch.id} stats`, async () => {
            res = await fetch(`/api/projects/${encodeURIComponent(pid)}/ctfd/stats/challenges/${encodeURIComponent(ch.id)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
          });
          if (res.ok) {
            const j = await res.json();
            if (j?.item) items[i] = j.item;
            try { if (j && Array.isArray(j.logs) && j.logs.length && done < 3) console.debug('[ctfd_challenges] logs(one):', ch.id, j.logs); } catch {}
          }
        } catch {}
        done++;
        setProgText(`Fetching ${done} of ${total}…`, Math.min(20 + Math.floor((done/total)*70), 90));
      }
    }
    const workers = Array.from({length: conc}, ()=> worker());
    await Promise.all(workers);
    setProgText('Finalizing…', 95);
    const out = items.filter(Boolean);
    if (returnOnly) return out;
    const prev = new Set(selected);
    renderTable(out);
    try { const ids = new Set(out.map(it => compositeId({ ...it, _proj: projectInfo }))); selected = new Set(Array.from(prev).filter(id => ids.has(id))); updateActionState(); } catch {}
    btnDownload && (btnDownload.disabled = (lastData.length===0));
    setProgText('Done', 100);
  }

  // Fast bulk path (counts-only) and fallback when per-challenge list fails
  async function refreshBulkFast(creds, pidOverride, returnOnly){
    try {
      const pid = pidOverride || getFixedPid();
      // Prefetch challenge list to get total count for progress messaging
      let total = 0;
      try {
        const body1 = { baseUrl: creds.url, token: creds.token, port: creds.port, verifySSL: creds.verify };
        let res1;
        await runQueued(`CTFd challenges list for project ${pid}`, async () => {
          res1 = await fetch(`/api/projects/${encodeURIComponent(pid)}/ctfd/challenges/list`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body1) });
        });
        if (res1.ok) { const j1 = await res1.json(); const list = Array.isArray(j1?.challenges) ? j1.challenges : []; total = list.length; }
      } catch {}

      if (total > 0) setProgText(`Fetching 0 of ${total}…`, 20); else setProgText('Fetching…', 20);
      let pct = 20; let estX = 0; let lastShownX = -1;
      const timer = setInterval(()=>{
        pct = Math.min(pct+5, 90);
        if (total > 0) {
          const frac = Math.max(0, Math.min(1, (pct - 20) / 70));
          estX = Math.min(total - 1, Math.floor(total * frac));
          // Always update width, but only update text if x changed to avoid flicker
          if (estX !== lastShownX) {
            setProgText(`Fetching ${estX} of ${total}…`, pct);
            lastShownX = estX;
          } else {
            // Update width without changing text (monotonic)
            try{
              const next = Math.max(progPct, pct);
              progPct = next;
              if (progBar) { progBar.style.width = next + '%'; progBar.setAttribute('aria-valuenow', String(Math.round(next))); }
            } catch {}
          }
        } else {
          setProgText('Fetching…', pct);
        }
      }, 700);

      const body = { baseUrl: creds.url, port: creds.port, token: creds.token, verifySSL: creds.verify, detail: !!detailedSolves };
      let res;
      await runQueued(`CTFd challenges stats for project ${pid}`, async () => {
        res = await fetch(`/api/projects/${encodeURIComponent(pid)}/ctfd/stats/challenges`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      });
      clearInterval(timer);
      if (!res.ok) {
        const raw = await res.text().catch(()=> '');
        let msg = '';
        try { const jerr = raw ? JSON.parse(raw) : null; msg = (jerr && (jerr.error || jerr.message)) || raw || res.statusText || 'Error'; }
        catch{ msg = raw || res.statusText || 'Error'; }
        throw new Error(`CTFd stats error ${res.status}: ${msg}`);
      }
      const j = await res.json();
      try { if (j && Array.isArray(j.logs) && j.logs.length) console.debug('[ctfd_challenges] logs:', j.logs); } catch {}
      if (total > 0) setProgText(`Fetching ${total} of ${total}…`, 95); else setProgText('Finalizing…', 95);
      const items = j.items||[];
      if (returnOnly) return items;
      const prev = new Set(selected);
      renderTable(items.map(it=> ({ ...it, _proj: projectInfo })));
      try { const ids = new Set(items.map(it => compositeId({ ...it, _proj: projectInfo }))); selected = new Set(Array.from(prev).filter(id => ids.has(id))); updateActionState(); } catch {}
      btnDownload && (btnDownload.disabled = (lastData.length===0));
      setProgText('Done', 100);
    } catch (e) {
      throw e;
    }
  }

  function downloadCsv(){
    const multi = Array.isArray(SELECTED_PIDS) && SELECTED_PIDS.length > 1;
    const lines = [ multi ? ['Project','Tag','Challenge Name','Category','Solves','Points','Visible','Teams','Users'] : ['Challenge Name','Category','Solves','Points','Visible','Teams','Users'] ];
    for(const it of lastData){
      const teams = (it.teams||[]).map(t=> (t.ord!=null ? `${t.ord}. ${t.name}` : `${t.name}`)).join('; ');
      const users = (it.users||[]).map(u=> (u.ord!=null ? `${u.ord}. ${u.name}` : `${u.name}`)).join('; ');
      let vis = '';
      if (it.visible === true) vis = 'Visible'; else if (it.visible === false) vis = 'Hidden'; else vis = 'Unknown';
      if (multi) lines.push([ it._proj?.name||'', it._proj?.tag||'', it.name||'', it.category||'', String(it.solves||0), String(((it.value!=null?it.value:it.points)||0)), vis, teams, users ]);
      else lines.push([ it.name||'', it.category||'', String(it.solves||0), String(((it.value!=null?it.value:it.points)||0)), vis, teams, users ]);
    }
    const csv = lines.map(r=>r.map(cell=>`"${String(cell).replace(/"/g,'""')}"`).join(',')).join('\n');
    const blob = new Blob([csv], {type:'text/csv'});
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'ctfd_challenges.csv';
    a.click();
    setTimeout(()=>URL.revokeObjectURL(a.href), 1000);
  }

  function setup(){
    // Initialize tooltip for Detailed Solves toggle
    try {
      if (chkDetailed) {
        new bootstrap.Tooltip(chkDetailed.parentElement);
      }
    } catch {}
  if(btnRefresh) btnRefresh.addEventListener('click', ()=>{ lastAction = { type: 'refresh', payload: null }; refresh(); });
    function updateHeaderToggleDisabled(){
      const tt = document.getElementById('teams-exp-toggle');
      const ut = document.getElementById('users-exp-toggle');
      [tt, ut].forEach(tg=>{ if (tg) tg.classList.toggle('disabled', !detailedSolves); });
    }
    if(btnDownload) btnDownload.addEventListener('click', downloadCsv);
    if (inputFilter) {
      inputFilter.addEventListener('input', () => {
        filterText = inputFilter.value || '';
        persistUiState();
        renderTable(lastData);
      });
    }
    if (chkFilterRegex) {
      // Tooltip already enabled nearby for Detailed Solves; keep minimal here
      chkFilterRegex.addEventListener('change', () => {
        filterIsRegex = !!chkFilterRegex.checked;
        persistUiState();
        renderTable(lastData);
      });
    }
    if (btnFilterClear) {
      btnFilterClear.addEventListener('click', () => {
        filterText = '';
        if (inputFilter) inputFilter.value = '';
        persistUiState();
        renderTable(lastData);
      });
    }
    if (chkHideHidden) {
      chkHideHidden.addEventListener('change', () => {
        // Checked means Include Hidden
        includeHidden = !!chkHideHidden.checked;
        persistUiState();
        renderTable(lastData);
      });
    }
    if (chkDetailed) {
      chkDetailed.addEventListener('change', () => {
        detailedSolves = !!chkDetailed.checked;
        persistUiState();
        updateHeaderToggleDisabled();
        refresh();
      });
    }
  if (btnSetVisible) btnSetVisible.addEventListener('click', () => { lastAction = { type: 'set-vis', payload: { visible: true } }; bulkSetVisibility(true); });
  if (btnSetHidden) btnSetHidden.addEventListener('click', () => { lastAction = { type: 'set-vis', payload: { visible: false } }; bulkSetVisibility(false); });
    // Wire column chooser
    wireCols();
    try { COLS = readCols(); const ids=['name','category','solves','points','visible','teams','users']; ids.forEach(id=>{ const el=document.getElementById(`chals-col-${id}`); if(el) el.checked = !!COLS[id]; }); } catch {}
    if(selInterval){
      const saved = sessionStorage.getItem('ctfd_chals_auto')||'0';
      selInterval.value = saved;
      selInterval.addEventListener('change', ()=>{
        const v = selInterval.value; sessionStorage.setItem('ctfd_chals_auto', v);
        applyAuto();
      });
    }
  // Projects multi-select wiring
  setupProjectsUi();
  // Wire global CTFd Login Save handler once
  try {
    const el = document.getElementById('ctfdLoginModal');
    const saveBtn = document.getElementById('ctfdLoginSave');
    if (el && saveBtn && !saveBtn._toolhubBound) {
      saveBtn._toolhubBound = true;
      saveBtn.addEventListener('click', () => {
        try {
          const inputs = Array.from(document.querySelectorAll('#ctfdLoginList .ctfd-token-input[data-pid]'));
          const persist = !!document.getElementById('chals-save-creds')?.checked;
          inputs.forEach(inp => {
            const pid = String(inp.getAttribute('data-pid'));
            const token = String(inp.value || '').trim();
            if (!pid) return;
            if (!token) return;
            const key = `toolhub.session.ctfd.${pid}`;
            try { sessionStorage.setItem(key, JSON.stringify({ token })); } catch {}
            try { document.cookie = `${key}=${encodeURIComponent(JSON.stringify({ token }))}; path=/; SameSite=Lax`; } catch {}
            try { if (persist) localStorage.setItem(`toolhub.ctfd.persist.${pid}`, JSON.stringify({ token })); else localStorage.removeItem(`toolhub.ctfd.persist.${pid}`); } catch {}
          });
          const modal = (window.bootstrap && (bootstrap.Modal.getInstance(el) || bootstrap.Modal.getOrCreateInstance(el))) || null;
          if (modal) modal.hide();
          setTimeout(() => {
            try {
              if (lastAction && lastAction.type === 'set-vis') {
                bulkSetVisibility(!!(lastAction.payload && lastAction.payload.visible));
              } else {
                refresh();
              }
            } catch {}
          }, 75);
        } catch {}
      });
    }
  } catch {}
    // enable buttons when creds present and pid provided (single or multi)
    const hasPid = !!getFixedPid();
    (async ()=>{
      const pid = getFixedPid();
      await loadProject(pid);
  restoreUiState();
  readExpanded();
      if (inputFilter) inputFilter.value = filterText;
  if (chkFilterRegex) chkFilterRegex.checked = !!filterIsRegex;
  // Checkbox reflects Include Hidden directly
  if (chkHideHidden) chkHideHidden.checked = !!includeHidden;
    if (chkDetailed) chkDetailed.checked = !!detailedSolves;
  updateHeaderToggleDisabled();
  const creds = await getCreds();
  const multiActive = Array.isArray(SELECTED_PIDS) && SELECTED_PIDS.length > 0;
  const enableRefresh = multiActive || (creds.url && hasPid);
  if(btnRefresh) btnRefresh.disabled = !enableRefresh;
      if(btnDownload) btnDownload.disabled = true;
      // Optional: reflect project in title
      try {
        if (Array.isArray(SELECTED_PIDS) && SELECTED_PIDS.length > 1) document.title = `AN3S — CTFd Challenges (Multiple)`;
        else { const name = (projectInfo && projectInfo.name) ? String(projectInfo.name) : pid; if (hasPid) document.title = `AN3S — CTFd Challenges (${name})`; }
      } catch {}
      refresh();
      applyAuto();
    })();
  }

  function applyAuto(){
    if(autoTimer){ clearInterval(autoTimer); autoTimer = null; }
    const v = parseInt(selInterval?.value||'0',10) || 0;
    if(v>0){ autoTimer = setInterval(refresh, v*1000); }
  }

  document.addEventListener('DOMContentLoaded', setup);

  // --- Persist UI state per project ---
  function uiKey(){ const keyPid = Array.isArray(SELECTED_PIDS) && SELECTED_PIDS.length ? SELECTED_PIDS.slice().sort().join(',') : getFixedPid(); return `toolhub.ctfd.chals.ui.${keyPid||'none'}`; }
  function persistUiState(){ try { sessionStorage.setItem(uiKey(), JSON.stringify({ sortKey, sortDir, filterText, filterIsRegex, includeHidden, detailedSolves })); } catch {} }
  function restoreUiState(){
    try {
      const raw = sessionStorage.getItem(uiKey());
      if (!raw) return;
      const s = JSON.parse(raw);
      if (s && typeof s === 'object') {
        if (s.sortKey) sortKey = String(s.sortKey);
        if (s.sortDir && (s.sortDir==='asc' || s.sortDir==='desc')) sortDir = s.sortDir;
  if (typeof s.filterText === 'string') filterText = s.filterText;
  if (typeof s.filterIsRegex === 'boolean') filterIsRegex = !!s.filterIsRegex; else filterIsRegex = false;
        if (typeof s.includeHidden === 'boolean') includeHidden = !!s.includeHidden; else includeHidden = true;
        if (typeof s.detailedSolves === 'boolean') detailedSolves = !!s.detailedSolves; else detailedSolves = false;
      }
    } catch {}
  }

  function updateActionState(){
    if(btnSetVisible) btnSetVisible.disabled = (selected.size===0);
    if(btnSetHidden) btnSetHidden.disabled = (selected.size===0);
  }

  async function bulkSetVisibility(visible){
    if (selected.size === 0) return;
    setBusy(true);
    try {
      // Group ids by pid
      const groups = {}; // pid -> [cid]
      Array.from(selected).forEach(key => {
        const m = String(key).split(':');
        const pid = (m.length>1) ? m[0] : getFixedPid();
        const cid = (m.length>1) ? m[1] : m[0];
        groups[pid] = groups[pid] || []; groups[pid].push(Number(cid));
      });
      // Preflight for all involved projects
      const pids = Object.keys(groups);
      const ok = await preflightCreds(pids, visible ? 'set visibility to Visible' : 'set visibility to Hidden');
      if (!ok) { return; }
      let total = 0;
      for (const pid of pids){
        const creds = await getCreds(pid);
        const body = { baseUrl: creds.url, port: creds.port, token: creds.token, verifySSL: creds.verify, ids: groups[pid], visible: !!visible };
        let res;
        await runQueued(`CTFd set challenge visibility for project ${pid}`, async () => {
          res = await fetch(`/api/projects/${encodeURIComponent(pid)}/ctfd/challenges/visibility`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        });
        if (!res.ok) {
          const raw = await res.text().catch(()=> '');
          let msg = '';
          try { const jerr = raw ? JSON.parse(raw) : null; msg = (jerr && (jerr.error || jerr.message)) || raw || res.statusText || 'Error'; }
          catch{ msg = raw || res.statusText || 'Error'; }
          throw new Error(`Visibility update error (${pid}) ${res.status}: ${msg}`);
        }
        total += groups[pid].length;
      }
      await refresh();
      showToast(`Updated ${total} challenge(s)`, 'success');
    } catch (e){
      showToast(String(e?.message||e||'Failed to update visibility'), 'danger');
    } finally {
      setBusy(false);
    }
  }

  function showToast(message, type){
    if (!toastWrap) { console[type==='danger'?'error':'log'](message); return; }
    const id = 't_'+Date.now()+Math.random().toString(16).slice(2);
    const bg = type === 'success' ? 'bg-success text-white' : type === 'warning' ? 'bg-warning' : type === 'danger' ? 'bg-danger text-white' : 'bg-secondary text-white';
    const div = document.createElement('div');
    div.className = 'toast align-items-center border-0 show';
    div.setAttribute('role', 'alert');
    div.setAttribute('aria-live', 'assertive');
    div.setAttribute('aria-atomic', 'true');
    div.id = id;
    div.innerHTML = `<div class="toast-header ${bg}"><strong class="me-auto">CTFd</strong><button type="button" class="btn-close btn-close-white ms-2 mb-1" data-bs-dismiss="toast" aria-label="Close"></button></div><div class="toast-body">${escapeHtml(message)}</div>`;
    toastWrap.appendChild(div);
    try { const t = new bootstrap.Toast(div, { delay: 2500 }); t.show(); } catch {}
    setTimeout(()=>{ try{ div.remove(); }catch{} }, 3000);
  }
})();


  // --- Multi-project helpers (in-scope) ---
