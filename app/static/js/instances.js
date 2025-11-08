async function http(method, url, body) {
  const opts = { method, headers: {}, credentials: 'same-origin' };
  if (body instanceof FormData) opts.body = body;
  else if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  const res = await fetch(url, opts);
  if (!res.ok) {
    let bodyText = '';
    let ct = '';
    try { bodyText = await res.text(); } catch {}
    try { ct = res.headers.get('content-type') || ''; } catch {}
    try { (window.shell && shell.logError) ? shell.logError(`[HTTP] ${method} ${url} -> ${res.status} ${res.statusText} ${ct ? '('+ct+')' : ''} ${bodyText ? ' body=' + bodyText.slice(0,800) : ''}`) : console.error('[HTTP]', method, url, res.status, res.statusText, bodyText); } catch {}
    throw new Error(bodyText || res.statusText);
  }
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('application/json')) return res.json();
  return res.text();
}

let CURRENT_PROJECT = null;

async function loadInstances() {
  const pid = document.getElementById('proj-id')?.value?.trim();
  if (!pid) { alert('Enter a Project ID'); return; }
  try {
    (window.shell && shell.logInfo) ? shell.logInfo('Instances: loading project…') : console.log('Instances: loading project…');
    await loadInstancesById(pid);
    (window.shell && shell.logSuccess) ? shell.logSuccess('Instances: project loaded') : console.log('Instances: project loaded');
  } catch (e) {
    alert('Error loading projects: ' + e.message);
    try { (window.shell && shell.logError) ? shell.logError('Instances: load failed: ' + e.message) : console.error('Instances: load failed', e); } catch {}
  }
}

async function loadInstancesById(pid) {
  const id = (pid || '').trim();
  if (!id) throw new Error('Missing project id');
  const data = await http('GET', '/api/projects');
  const proj = (data.projects || []).find(p => p.id === id);
  const info = document.getElementById('instances-info');
  if (!proj) { if (info) info.textContent = 'Project not found.'; CURRENT_PROJECT = null; renderTable(null); return; }
  CURRENT_PROJECT = proj;
  if (info) info.textContent = `Project: ${proj.name} (Instances: ${proj.instances}, Tag: ${proj.tag})`;
  renderTable(proj);
}

async function refreshInstances() {
  if (!CURRENT_PROJECT) { alert('Load a project first.'); return; }
  const label = `Refresh instances for ${CURRENT_PROJECT?.name || CURRENT_PROJECT?.id || ''}`.trim();
  await runQueued(label, async () => {
    try {
      try { shell.beginActionContext('Instances Refresh'); } catch {}
      (window.shell && shell.logInfo) ? shell.logInfo('Instances: refresh starting…') : console.log('Instances: refresh starting…');
      const resp = await http('POST', `/api/projects/${CURRENT_PROJECT.id}/instances/refresh`, {});
      try { shell.step('HTTP response received'); } catch {}
      CURRENT_PROJECT.instance_statuses = resp.instance_statuses || [];
      try { emitActionLogs('Refresh', resp || {}); } catch {}
      try { shell.step('Action logs emitted'); } catch {}
      try { (window.shell && shell.logInfo) ? shell.logInfo(`Instances: refresh received ${(CURRENT_PROJECT.instance_statuses||[]).length} entries`) : console.log('Instances: entries', (CURRENT_PROJECT.instance_statuses||[]).length); } catch {}
      renderTable(CURRENT_PROJECT);
      (window.shell && shell.logSuccess) ? shell.logSuccess('Instances: refresh done') : console.log('Instances: refresh done');
      try { shell.endActionContext(true); } catch {}
    } catch (e) {
      alert('Refresh failed: ' + e.message);
      try { (window.shell && shell.logError) ? shell.logError('Instances: refresh failed: ' + e.message) : console.error('Instances: refresh failed', e); } catch {}
      try { shell.endActionContext(false); } catch {}
    }
  }, { projectId: CURRENT_PROJECT?.id });
}

function renderTable(proj) {
  const host = document.getElementById('instances-table');
  if (!proj) { host.innerHTML = ''; return; }
  const inst = Number(proj.instances || 0);
  const tag = String(proj.tag || '');
  const vms = proj.vms || [];
  const statuses = proj.instance_statuses || [];
  const statusMap = new Map(statuses.map(s => [Number(s.index||0), s]));
  let html = '<table class="table table-sm align-middle"><thead><tr><th>#</th><th>Preview VM Names</th><th>Preview Adaptors</th><th>Managers</th></tr></thead><tbody>';
  for (let i = 1; i <= inst; i++) {
    const suffix = `${tag}${i}`;
    const names = vms.map(v => `${v.name}${suffix}`);
  const adaptors = (vms.flatMap(v => (v.internal_network_adaptors||[]).map(a => `${String(a||'')}${suffix}`)));
    const st = statusMap.get(i) || {};
    const mgr = st.managers || {};
    const mgrBadges = ['vm','guacamole','pools','keycloak','rocketchat','ctfd'].map(m => badgeForStatus(m, mgr[m])).join(' ');
    html += `<tr><td>${i}</td><td>${names.map(escHtml).join('<br>')}</td><td>${adaptors.map(escHtml).join('<br>')||'<span class=\"text-muted\">—</span>'}</td><td>${mgrBadges}</td></tr>`;
  }
  html += '</tbody></table>';
  host.innerHTML = html;
}

function badgeForStatus(name, value) {
  const label = { vm: 'VM', guacamole: 'Guac', pools: 'Pools', keycloak: 'Keycloak', rocketchat: 'RocketChat', ctfd: 'CTFd' }[name] || name;
  const v = String(value || '').toLowerCase();
  const cls = v === 'ready' || v === 'ok' || v === 'created' ? 'bg-success' : (v === 'error' ? 'bg-danger' : (v === 'pending' ? 'bg-warning text-dark' : 'bg-secondary'));
  const text = v ? v : 'n/a';
  return `<span class="badge ${cls}">${label}: ${escHtml(text)}</span>`;
}

function escHtml(s) { return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;','\'':'&#39;'}[c])); }

// Emit concise action logs to the console dock for Instances card
function emitActionLogs(actionName, resp) {
  try {
    const name = String(actionName || 'Action');
    const statuses = Array.isArray(resp?.instance_statuses) ? resp.instance_statuses : [];
    const total = statuses.length;
    if (total) {
      const poolsAll = statuses.filter(s => (s?.managers?.pools_member_state||'') === 'all').length;
      const poolsPartial = statuses.filter(s => (s?.managers?.pools_member_state||'') === 'partial').length;
      const vmCreated = statuses.filter(s => (s?.managers?.vm||'') === 'created').length;
      if (window.shell && shell.logInfo) shell.logInfo(`${name}: ${total} instance entr${total===1?'y':'ies'} — VM created: ${vmCreated}; Pools all/partial: ${poolsAll}/${poolsPartial}`);
    } else {
      if (window.shell && shell.logInfo) shell.logInfo(`${name}: no instance entries`);
    }
  } catch {}
}

// Autofill if URL query contains ?id=
window.addEventListener('DOMContentLoaded', () => {
  const u = new URL(window.location.href);
  const id = u.searchParams.get('id');
  if (id) {
    const input = document.getElementById('proj-id');
    if (input) { input.value = id; loadInstances(); }
    else { loadInstancesById(id).catch(()=>{}); }
  }
});
