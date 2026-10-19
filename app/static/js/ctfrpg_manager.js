(() => {
  'use strict';

  const $ = id => document.getElementById(id);
  const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const projectPath = pid => `/api/projects/${encodeURIComponent(pid)}`;
  const keyFor = (pid, username) => JSON.stringify([pid, username]);
  const columnIds = ['project', 'user', 'team', 'user_points', 'team_points', 'character', 'completed', 'state'];
  const defaultColumns = (multi = false) => ({project: multi, user: true, team: true, user_points: true,
    team_points: true, character: true, completed: true, state: true});
  const state = { projects: [], selectedProjects: new Set(), selectedUsers: new Set(), rows: [], teams: [], errors: {}, characters: [], refreshSeq: 0, busy: false, refreshPending: false, timer: null,
    sort: {key: 'user', dir: 'asc'}, userSortMode: 'name', teamSortMode: 'name', columns: defaultColumns() };

  async function api(path, options = {}) {
    const response = await fetch(path, { credentials: 'same-origin', ...options });
    let body = {};
    try { body = await response.json(); } catch { /* Non-JSON errors are handled below. */ }
    if (!response.ok || body.ok === false) throw new Error(body.error || body.message || `HTTP ${response.status}`);
    return body;
  }

  const jsonOptions = (method, body) => ({ method, headers: {'Content-Type':'application/json'}, body: JSON.stringify(body) });
  function currentProject() { return state.projects.find(p => p.id === shell.getCurrentProjectId()); }
  function showStatus(message, kind = 'muted') {
    const host = $('status');
    host.textContent = message;
    host.className = `small mb-3 text-${kind}`;
  }
  function setBusy(value) {
    state.busy = value;
    for (const id of ['refresh-button', 'create-users', 'delete-users', 'save-connection', 'test-connection']) $(id).disabled = value;
  }

  function updateAutoRefresh() {
    if (state.timer) clearInterval(state.timer);
    state.timer = null;
    const seconds = Number($('auto-interval').value);
    if (seconds > 0) state.timer = setInterval(refresh, seconds * 1000);
    const badge = $('auto-badge');
    badge.textContent = seconds > 0 ? (seconds < 60 ? `${seconds}s` : `${seconds / 60}m`) : 'Off';
    badge.className = `badge ${seconds > 0 ? 'bg-primary' : 'bg-secondary'} align-self-center ms-1`;
  }

  function tablePrefsKey() { return `toolhub.ctfrpg.table.v1.${[...state.selectedProjects].sort().join(',')}`; }
  function restoreTablePrefs() {
    let saved = {};
    try { saved = JSON.parse(sessionStorage.getItem(tablePrefsKey()) || '{}') || {}; } catch { /* Keep defaults. */ }
    state.sort = columnIds.includes(saved.sort?.key) && ['asc', 'desc'].includes(saved.sort?.dir) ? saved.sort : {key: 'user', dir: 'asc'};
    state.userSortMode = saved.userSortMode === 'rank' ? 'rank' : 'name';
    state.teamSortMode = saved.teamSortMode === 'rank' ? 'rank' : 'name';
    const defaults = defaultColumns(state.selectedProjects.size > 1);
    state.columns = Object.fromEntries(columnIds.map(id => [id, saved.columns?.[id] === undefined ? defaults[id] : !!saved.columns[id]]));
    $('filter').value = typeof saved.filter === 'string' ? saved.filter : '';
    $('filter-regex').checked = !!saved.regex;
  }
  function saveTablePrefs() {
    try { sessionStorage.setItem(tablePrefsKey(), JSON.stringify({sort: state.sort, userSortMode: state.userSortMode, teamSortMode: state.teamSortMode,
      columns: state.columns, filter: $('filter').value, regex: $('filter-regex').checked})); } catch { /* Storage is optional. */ }
  }

  async function loadProjects() {
    const body = await api('/api/projects');
    state.projects = (body.projects || []).filter(p => p && p.id).map(p => ({...p, id: String(p.id)}));
    const valid = new Set(state.projects.map(p => p.id));
    state.selectedProjects = new Set([...state.selectedProjects].filter(id => valid.has(id)));
    const current = shell.getCurrentProjectId();
    if (current && valid.has(current) && !state.selectedProjects.size) state.selectedProjects.add(current);
    if (!current && state.projects.length) shell.setCurrentProjectId(state.projects[0].id);
    restoreTablePrefs();
    renderProjects();
    updateGameLink();
  }

  function renderProjects() {
    $('projects-count').textContent = String(state.selectedProjects.size);
    $('projects-list').innerHTML = state.projects.length ? state.projects.map(p => `<label class="d-flex align-items-center gap-2 border-bottom py-2"><input class="form-check-input project-check" type="checkbox" value="${escapeHtml(p.id)}" ${state.selectedProjects.has(p.id) ? 'checked' : ''}><span>${escapeHtml(p.name)}</span><span class="small text-muted ms-auto">${(p.credentials || []).length} users</span></label>`).join('') : '<div class="text-muted">No projects yet.</div>';
    $('projects-list').querySelectorAll('.project-check').forEach(input => input.addEventListener('change', () => {
      if (input.checked) state.selectedProjects.add(input.value);
      else state.selectedProjects.delete(input.value);
      $('projects-count').textContent = String(state.selectedProjects.size);
      state.selectedUsers.clear();
      state.rows = [];
      state.teams = [];
      restoreTablePrefs();
      render();
      refresh();
      CTFRPG_Audio.load(state.projects.filter(project => state.selectedProjects.has(project.id)));
    }));
  }

  function updateGameLink() {
    const url = currentProject()?.ctfrpg_url;
    const link = $('game-link');
    if (url) {
      link.href = url;
      try { link.textContent = `Server: ${new URL(url).host}`; } catch { link.textContent = `Server: ${url}`; }
      link.title = url;
      link.classList.remove('d-none');
    } else {
      link.removeAttribute('href');
      link.textContent = 'Server: —';
      link.classList.add('d-none');
    }
  }

  function credentialsRows() {
    const rows = CTFRPG_Table.buildRows(state.projects, state.selectedProjects, state.rows, state.teams, state.errors);
    const filtered = CTFRPG_Table.filterRows(rows, $('filter').value, $('filter-regex').checked);
    $('filter-error').classList.toggle('d-none', !filtered.error);
    return CTFRPG_Table.sortRows(filtered.rows, state.sort, state.userSortMode, state.teamSortMode);
  }

  function render() {
    const visible = credentialsRows();
    const tbody = $('users-body');
    document.querySelectorAll('thead [data-col]').forEach(header => {
      const key = header.dataset.col;
      header.classList.toggle('d-none', !state.columns[key]);
      header.setAttribute('aria-sort', state.sort.key === key ? (state.sort.dir === 'asc' ? 'ascending' : 'descending') : 'none');
      const icon = header.querySelector('.sort-icon');
      if (icon) icon.textContent = state.sort.key === key ? (state.sort.dir === 'asc' ? ' ▲' : ' ▼') : '';
    });
    document.querySelectorAll('.column-check').forEach(input => { input.checked = !!state.columns[input.value]; });
    document.querySelectorAll('.sort-mode').forEach(button => {
      const mode = button.dataset.mode === 'user' ? state.userSortMode : state.teamSortMode;
      button.title = `Toggle ${button.dataset.mode} sort (currently ${mode})`;
    });
    tbody.innerHTML = visible.length ? visible.map(({project, username, user, teamName, teamRank, teamPoints, userRank, userPoints, completed, state: userState}) => {
      const key = keyFor(project.id, username);
      const badge = user ? (user.exists ? (user.role === 'admin' ? 'warning' : 'success') : 'secondary') : 'light';
      const cell = (column, value) => `<td data-col="${column}" ${state.columns[column] ? '' : 'class="d-none"'}>${value}</td>`;
      const rankLabel = rank => rank !== null ? ` <span class="text-muted">(#${escapeHtml(rank)})</span>` : '';
      return `<tr>${cell('project', escapeHtml(project.name) + (project.tag ? `<div class="small text-muted">${escapeHtml(project.tag)}</div>` : ''))}`
        + cell('user', `<input class="form-check-input user-check me-2" type="checkbox" data-key="${escapeHtml(key)}" aria-label="Select ${escapeHtml(username)}" ${state.selectedUsers.has(key) ? 'checked' : ''}><code>${escapeHtml(username)}</code>${rankLabel(userRank)}`)
        + cell('team', teamName ? `${escapeHtml(teamName)}${rankLabel(teamRank)}` : 'n/a')
        + cell('user_points', userPoints ?? 'n/a')
        + cell('team_points', teamPoints ?? 'n/a')
        + cell('character', escapeHtml(user?.hero || 'n/a'))
        + cell('completed', completed ?? 'n/a')
        + cell('state', `<span class="badge text-bg-${badge}">${escapeHtml(userState)}</span>`)
        + '</tr>';
    }).join('') : `<tr><td colspan="${columnIds.filter(id => state.columns[id]).length || 1}" class="text-muted">${state.selectedProjects.size ? 'No credentials match the filter.' : 'Select a project from the sidebar or Projects menu.'}</td></tr>`;
    tbody.querySelectorAll('.user-check').forEach(input => input.addEventListener('change', () => {
      if (input.checked) state.selectedUsers.add(input.dataset.key);
      else state.selectedUsers.delete(input.dataset.key);
      updateSelection();
    }));
    updateSelection();
  }

  function updateSelection() {
    const visible = credentialsRows().map(({project, username}) => keyFor(project.id, username));
    let total = 0;
    $('project-selection-count').innerHTML = state.projects.filter(project => state.selectedProjects.has(project.id)).map(project => {
      const count = (project.credentials || []).filter(credential => {
        const username = String(credential.username || '').trim();
        return username && state.selectedUsers.has(keyFor(project.id, username));
      }).length;
      total += count;
      return `<span class="border rounded px-2 py-1">${escapeHtml(project.name || project.id)}: <strong>${count} selected</strong></span>`;
    }).join('');
    $('selected-count').textContent = `${total} selected`;
    $('select-all').checked = !!visible.length && visible.every(key => state.selectedUsers.has(key));
    $('select-all').indeterminate = visible.some(key => state.selectedUsers.has(key)) && !$('select-all').checked;
  }

  function renderCharacters() {
    const select = $('hero');
    const previous = select.value;
    select.innerHTML = '<option value="">Game default</option>' + state.characters.map(c => `<option value="${escapeHtml(c.id)}">${escapeHtml(c.name || c.id)}</option>`).join('');
    if ([...select.options].some(o => o.value === previous)) select.value = previous;
  }

  function actionSummary(title, sections) {
    const modal = $('actionSummaryModal');
    $('action-summary-title').textContent = title;
    $('action-summary-body').innerHTML = sections || '<div class="text-muted">No details.</div>';
    bootstrap.Modal.getOrCreateInstance(modal).show();
  }

  function userResultsHtml(result) {
    const counts = `Created: <strong>${Number(result.created || 0)}</strong> · Updated: <strong>${Number(result.updated || 0)}</strong> · Deleted: <strong>${Number(result.deleted || 0)}</strong>`;
    const rows = (result.results || []).map(row => {
      const action = row.error ? 'error' : (row.action || 'unknown');
      const color = row.error ? 'danger' : action === 'missing' ? 'secondary' : action === 'updated' ? 'primary' : 'success';
      return `<tr><td>${escapeHtml(row.username || '—')}</td><td><span class="badge bg-${color}">${escapeHtml(action)}</span></td><td class="small text-danger">${escapeHtml(row.error || '')}</td></tr>`;
    }).join('');
    return `<div class="mb-2">${counts}</div>${rows ? `<div class="table-responsive"><table class="table table-sm"><thead><tr><th>User</th><th>Status</th><th>Info</th></tr></thead><tbody>${rows}</tbody></table></div>` : '<div class="text-muted">No per-user details.</div>'}`;
  }

  async function loadCharacters() {
    const project = currentProject();
    if (!project?.ctfrpg_url) { state.characters = []; renderCharacters(); return; }
    try {
      const me = await api(projectPath(project.id) + '/ctfrpg/login', jsonOptions('POST', {}));
      if (currentProject()?.id !== project.id) return;
      state.characters = me.characters || [];
      renderCharacters();
    } catch { state.characters = []; renderCharacters(); }
  }

  async function refresh() {
    if (state.busy) { state.refreshPending = true; return; }
    const seq = ++state.refreshSeq;
    const projects = state.projects.filter(p => state.selectedProjects.has(p.id));
    if (!projects.length) { state.rows = []; state.teams = []; render(); showStatus('Select a project to get started.'); return; }
    setBusy(true);
    showStatus(`Refreshing ${projects.length} project${projects.length === 1 ? '' : 's'}…`);
    try {
      const results = await Promise.allSettled(projects.map(async project => {
        if (!project.ctfrpg_url) throw new Error('Set the CTF-RPG URL in Connection.');
        const result = await api(projectPath(project.id) + '/ctfrpg/users_check', jsonOptions('POST', {}));
        return { id: project.id, project: project.name, ...result };
      }));
      if (seq !== state.refreshSeq) return;
      state.rows = [];
      state.teams = [];
      state.errors = {};
      results.forEach((result, index) => {
        const project = projects[index];
        if (result.status === 'fulfilled') {
          state.rows.push(result.value);
          if (state.selectedProjects.has(project.id)) CTFRPG_Audio.process(project, result.value);
          state.teams.push({id: project.id, project: project.name, teams: result.value.teams || []});
        } else state.errors[project.id] = result.reason?.message || 'Connection failed';
      });
      render();
      const errors = Object.entries(state.errors);
      showStatus(errors.length ? errors.map(([id, message]) => `${state.projects.find(p => p.id === id)?.name || id}: ${message}`).join(' · ') : `Updated ${new Date().toLocaleTimeString()}.`, errors.length ? 'danger' : 'success');
    } finally {
      setBusy(false);
      if (state.refreshPending) { state.refreshPending = false; refresh(); }
    }
  }

  async function openConnection() {
    const project = currentProject();
    if (!project) { showStatus('Select a project first.', 'warning'); return; }
    $('connection-project').textContent = `Project: ${project.name}`;
    $('game-url').value = project.ctfrpg_url || '';
    $('verify-ssl').checked = project.ctfrpg_verify_ssl !== false;
    $('game-username').value = '';
    $('game-password').value = '';
    $('connection-status').textContent = 'Loading saved credentials…';
    try {
      const secrets = await api(projectPath(project.id) + '/secrets');
      $('game-username').value = secrets.ctfrpg?.username || '';
      $('game-password').value = secrets.ctfrpg?.password || '';
      $('connection-status').textContent = secrets.ctfrpg?.saved ? 'Saved credentials loaded.' : 'Enter an admin username and password to connect.';
    } catch (error) { $('connection-status').textContent = error.message; }
    bootstrap.Modal.getOrCreateInstance($('connection-modal')).show();
  }

  function connectionInput() {
    return { baseUrl: $('game-url').value.trim(), username: $('game-username').value.trim(), password: $('game-password').value, verifySSL: $('verify-ssl').checked };
  }

  async function testConnection() {
    const project = currentProject();
    if (!project) return;
    if (!connectionInput().username || !connectionInput().password) { $('connection-status').textContent = 'Enter an admin username and password.'; throw new Error('Admin username and password are required'); }
    setBusy(true);
    $('connection-status').textContent = 'Connecting…';
    try {
      const me = await api(projectPath(project.id) + '/ctfrpg/login', jsonOptions('POST', connectionInput()));
      state.characters = me.characters || [];
      renderCharacters();
      $('connection-status').textContent = `Connected as ${me.user?.username || me.username || connectionInput().username}.`;
      return me;
    } catch (error) { $('connection-status').textContent = error.message; throw error; }
    finally { setBusy(false); }
  }

  async function saveConnection() {
    const project = currentProject();
    if (!project) return;
    const input = connectionInput();
    let saved = false;
    try {
      await testConnection();
      setBusy(true);
      const updated = await api(projectPath(project.id), jsonOptions('PATCH', {ctfrpg_url: input.baseUrl, ctfrpg_verify_ssl: input.verifySSL}));
      await api(projectPath(project.id) + '/secrets', jsonOptions('PATCH', {ctfrpg: {username: input.username, password: input.password}}));
      Object.assign(project, updated);
      updateGameLink();
      $('connection-status').textContent = 'Connection saved.';
      showStatus(`${project.name}: connection saved.`, 'success');
      bootstrap.Modal.getOrCreateInstance($('connection-modal')).hide();
      saved = true;
    } catch (error) { $('connection-status').textContent = error.message; }
    finally { setBusy(false); }
    if (saved) refresh();
  }

  async function runUsers(action) {
    if (state.busy) return;
    const projects = state.projects.filter(project => state.selectedProjects.has(project.id));
    if (!projects.length) { showStatus('Select a project first.', 'warning'); return; }
    const selected = projects.map(project => ({project, only: (project.credentials || []).filter(c => state.selectedUsers.has(keyFor(project.id, c.username))).map(c => c.username)}));
    const hasSelection = selected.some(item => item.only.length);
    if (state.selectedUsers.size && !hasSelection) { showStatus('The selected users are outside the chosen projects. Select users here or clear the selection.', 'warning'); return; }
    const targets = hasSelection ? selected.filter(item => item.only.length) : projects.map(project => ({project, only: (project.credentials || []).map(c => c.username).filter(Boolean)})).filter(item => item.only.length);
    if (!targets.length) { showStatus('Add project credentials before managing users.', 'warning'); return; }
    const count = targets.reduce((sum, item) => sum + item.only.length, 0);
    if (action === 'delete' && !confirm(`Delete ${hasSelection ? count + ' selected' : 'all ' + count + ' configured'} CTF-RPG account${count === 1 ? '' : 's'} and their progress across ${targets.length} project${targets.length === 1 ? '' : 's'}?`)) return;
    if (action === 'create' && !hasSelection && !confirm(`No users selected. Create or update all ${count} configured CTF-RPG accounts across ${targets.length} project${targets.length === 1 ? '' : 's'}?`)) return;
    setBusy(true);
    const failures = [];
    const sections = [];
    let created = 0, updated = 0, unchanged = 0, deleted = 0;
    try {
      const title = action === 'create' ? 'CTF-RPG Users Create' : 'CTF-RPG Users Delete';
      shell.beginActionContext(title);
      showActionProgress(title, `Processing ${count} user${count === 1 ? '' : 's'} across ${targets.length} project${targets.length === 1 ? '' : 's'}…`);
      for (const [index, {project, only}] of targets.entries()) {
        updateActionProgress(Math.round(10 + index / targets.length * 80), `Projects ${index}/${targets.length}`, `Processing ${project.name}…`);
        showStatus(`${action === 'create' ? 'Creating / updating' : 'Deleting'} users for ${project.name}…`);
        try {
          const body = {only};
          if (action === 'create' && $('hero').value) body.hero = $('hero').value;
          const result = await api(projectPath(project.id) + `/ctfrpg/users_${action}`, jsonOptions('POST', body));
          created += result.created || 0; updated += result.updated || 0; unchanged += result.unchanged || 0; deleted += result.deleted || 0;
          for (const row of result.results || []) if (row.error) failures.push(`${project.name}/${row.username}: ${row.error}`);
          sections.push(`<div class="mb-3"><h3 class="h6">${escapeHtml(project.name)}</h3>${userResultsHtml(result)}</div>`);
        } catch (error) {
          failures.push(`${project.name}: ${error.message}`);
          sections.push(`<div class="mb-3 text-danger"><strong>${escapeHtml(project.name)}</strong>: ${escapeHtml(error.message)}</div>`);
        }
      }
      updateActionProgress(100, `Projects ${targets.length}/${targets.length}`, 'User action finished.');
      shell.endActionContext(failures.length === 0);
    } finally { setBusy(false); hideActionProgress(); }
    await refresh();
    showStatus(`${created} created, ${updated} updated, ${unchanged} unchanged, ${deleted} deleted.${failures.length ? ' Errors: ' + failures.join(' · ') : ''}`, failures.length ? 'danger' : 'success');
    actionSummary(action === 'create' ? 'CTF-RPG Users Create' : 'CTF-RPG Users Delete', sections.join(''));
  }

  function exportCsv() {
    const quote = value => `"${String(value ?? '').replaceAll('"', '""')}"`;
    const lines = [['Project','User','User Rank','Team','Team Rank','User Points','Team Points','Character','Completed','State'].map(quote).join(',')];
    for (const row of credentialsRows()) lines.push([row.project.name, row.username, row.userRank ?? '', row.teamName,
      row.teamRank ?? '', row.userPoints ?? '', row.teamPoints ?? '', row.user?.hero ?? '', row.completed ?? '', row.state].map(quote).join(','));
    const blob = new Blob([lines.join('\r\n') + '\r\n'], {type:'text/csv;charset=utf-8'});
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = 'ctfrpg-users.csv';
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  }

  document.addEventListener('DOMContentLoaded', async () => {
    $('connection-button').addEventListener('click', openConnection);
    $('test-connection').addEventListener('click', () => { testConnection().catch(() => {}); });
    $('save-connection').addEventListener('click', saveConnection);
    $('refresh-button').addEventListener('click', refresh);
    $('create-users').addEventListener('click', () => runUsers('create'));
    $('delete-users').addEventListener('click', () => runUsers('delete'));
    CTFRPG_Audio.init();
    $('notifications-tab').addEventListener('shown.bs.tab', () => CTFRPG_Audio.load(state.projects.filter(project => state.selectedProjects.has(project.id))));
    $('export-button').addEventListener('click', exportCsv);
    $('filter').addEventListener('input', () => { saveTablePrefs(); render(); });
    $('filter-regex').addEventListener('change', () => { saveTablePrefs(); render(); });
    $('clear-filter').addEventListener('click', () => { $('filter').value = ''; saveTablePrefs(); render(); });
    document.querySelectorAll('.table-sort').forEach(button => button.addEventListener('click', () => {
      const key = button.dataset.sort;
      state.sort = state.sort.key === key ? {key, dir: state.sort.dir === 'asc' ? 'desc' : 'asc'} : {key, dir: 'asc'};
      saveTablePrefs(); render();
    }));
    document.querySelectorAll('.sort-mode').forEach(button => button.addEventListener('click', () => {
      if (button.dataset.mode === 'user') state.userSortMode = state.userSortMode === 'name' ? 'rank' : 'name';
      else state.teamSortMode = state.teamSortMode === 'name' ? 'rank' : 'name';
      saveTablePrefs(); render();
    }));
    document.querySelectorAll('.column-check').forEach(input => input.addEventListener('change', () => {
      state.columns[input.value] = input.checked;
      if (!columnIds.some(id => state.columns[id])) { state.columns[input.value] = true; input.checked = true; return; }
      saveTablePrefs(); render();
    }));
    $('select-visible').addEventListener('click', () => { credentialsRows().forEach(({project, username}) => state.selectedUsers.add(keyFor(project.id, username))); render(); });
    $('clear-selection').addEventListener('click', () => { state.selectedUsers.clear(); render(); });
    $('select-all').addEventListener('change', event => { credentialsRows().forEach(({project, username}) => { const key = keyFor(project.id, username); if (event.target.checked) state.selectedUsers.add(key); else state.selectedUsers.delete(key); }); render(); });
    $('auto-interval').addEventListener('change', updateAutoRefresh);
    updateAutoRefresh();
    $('create-project').addEventListener('click', async () => { const input = $('proj-name'); const name = input.value.trim(); if (!name) return; try { const p = await api('/api/projects', jsonOptions('POST', {name})); input.value = ''; shell.setCurrentProjectId(p.id); await shell.refreshSidebar('ctfrpg'); await loadProjects(); render(); } catch (error) { showStatus(error.message, 'danger'); } });
    try { await shell.initShell('ctfrpg'); await loadProjects(); render(); await Promise.all([refresh(), loadCharacters(), CTFRPG_Audio.load(state.projects.filter(project => state.selectedProjects.has(project.id)))]); }
    catch (error) { showStatus(error.message, 'danger'); }
    document.addEventListener('project-selected', async () => { const pid = shell.getCurrentProjectId(); if (pid) state.selectedProjects.add(pid); await loadProjects(); render(); refresh(); loadCharacters(); CTFRPG_Audio.load(state.projects.filter(project => state.selectedProjects.has(project.id))); });
    try { const me = await AUTH.me(); $('banner-username').textContent = me?.user?.username || 'anonymous'; } catch { /* Login UI handles auth. */ }
    $('banner-logout').addEventListener('click', async () => { await AUTH.logout(); location.href = '/'; });
  });
})();
