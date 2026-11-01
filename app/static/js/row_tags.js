(() => {
  'use strict';

  const tags = [
    {id: 1, color: 'blue', label: 'Tag 1'},
    {id: 2, color: 'green', label: 'Tag 2'},
    {id: 3, color: 'amber', label: 'Tag 3'},
    {id: 4, color: 'purple', label: 'Tag 4'},
    {id: 5, color: 'rose', label: 'Tag 5'},
  ];
  const tagName = tag => `${tag.label} (${tag.color})`;
  const badge = tag => `<span class="row-tag row-tag-${tag.color}" role="img" aria-label="${tagName(tag)}" title="${tagName(tag)}"><svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path fill="currentColor" d="M1 1h6l8 8-6 6-8-8Z"/><circle cx="4.25" cy="4.25" r="1.25" fill="white"/></svg></span>`;

  function create(scope) {
    // Read the original browser-only assignments once and migrate each project.
    const storageKey = `toolhub.rowTags.v1.${scope}`;
    const assignments = new Map();
    const loaded = new Set();
    const loading = new Map();
    const loadErrors = new Map();
    let legacy = new Map();
    let active = new Set();
    let controls = null;
    let saving = false;
    let saveError = '';
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey) || '{}');
      if (saved && typeof saved === 'object' && !Array.isArray(saved)) {
        legacy = new Map(Object.entries(saved).filter(([, ids]) => Array.isArray(ids))
          .filter(([key]) => { try { const {pid, row} = parts(key); return pid && typeof row === 'string' && row; } catch { return false; } })
          .map(([key, ids]) => [key, tags.filter(tag => ids.includes(tag.id)).map(tag => tag.id)]));
      }
    } catch { /* Server persistence does not require browser storage. */ }

    function parts(key) {
      if (scope === 'ctfrpg') {
        const [pid, row] = JSON.parse(key);
        return {pid: String(pid), row};
      }
      const separator = scope === 'vm' ? '|' : ':';
      const index = key.indexOf(separator);
      if (index < 1) throw new Error('Invalid row key');
      return {pid: key.slice(0, index), row: key.slice(index + 1)};
    }
    function fullKey(pid, row) {
      return scope === 'ctfrpg' ? JSON.stringify([pid, row]) : `${pid}${scope === 'vm' ? '|' : ':'}${row}`;
    }
    const get = key => assignments.get(String(key)) || [];
    function replaceProject(pid, rows) {
      for (const key of assignments.keys()) if (parts(key).pid === pid) assignments.delete(key);
      for (const [row, ids] of Object.entries(rows)) assignments.set(fullKey(pid, row), ids);
    }
    async function request(pid, body) {
      // Saving local project metadata must not wait behind VM lifecycle jobs.
      const send = window.ServerQueue?.nativeFetch || window.fetch.bind(window);
      const response = await send(`/api/projects/${encodeURIComponent(pid)}/row-tags/${scope}`, {
        credentials: 'same-origin', cache: 'no-store',
        ...(body === undefined ? {} : {method: 'PATCH', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)}),
      });
      let result;
      try { result = await response.json(); } catch {
        if (response.status === 404) throw new Error('The running server does not support tags yet. Restart DeployForge, then reload this page.');
        throw new Error(`Tag request failed (HTTP ${response.status})`);
      }
      if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
      if (!result.row_tags || typeof result.row_tags !== 'object' || Array.isArray(result.row_tags)
          || Object.values(result.row_tags).some(ids => !Array.isArray(ids) || ids.some(id => !tags.some(tag => tag.id === id)))) {
        throw new Error('Invalid tag response');
      }
      return result.row_tags;
    }
    async function loadProject(pid) {
      pid = String(pid);
      if (loaded.has(pid)) return;
      if (loading.has(pid)) return loading.get(pid);
      const pending = (async () => {
        let rows = await request(pid);
        const old = [...legacy].filter(([key]) => parts(key).pid === pid);
        if (old.length) {
          const merge = Object.fromEntries(old.map(([key, ids]) => [parts(key).row, ids]));
          rows = await request(pid, {merge});
          old.forEach(([key]) => legacy.delete(key));
          try { localStorage.setItem(storageKey, JSON.stringify(Object.fromEntries(legacy))); } catch { /* Migration already saved on the server. */ }
        }
        replaceProject(pid, rows);
        loaded.add(pid);
        loadErrors.delete(pid);
      })();
      loading.set(pid, pending);
      try { await pending; }
      catch (error) { loadErrors.set(pid, error.message || 'Could not load tags'); throw error; }
      finally { loading.delete(pid); }
    }
    async function loadProjects(pids) {
      const results = await Promise.allSettled([...new Set(pids.map(String))].map(loadProject));
      refreshControls();
      return results.every(result => result.status === 'fulfilled');
    }
    async function assign(keys, tagId, enabled = true) {
      if (saving || (!tags.some(tag => tag.id === tagId) && tagId !== null)) return false;
      const byProject = new Map();
      for (const key of keys) {
        const {pid, row} = parts(String(key));
        if (!byProject.has(pid)) byProject.set(pid, []);
        byProject.get(pid).push(row);
      }
      saving = true;
      saveError = '';
      refreshControls();
      try {
        for (const [pid, rows] of byProject) {
          await loadProject(pid);
          const saved = await request(pid, {rows, tag_id: tagId, enabled});
          replaceProject(pid, saved);
        }
        return true;
      } catch (error) {
        saveError = error.message || 'Could not save tags';
        return false;
      } finally {
        saving = false;
        refreshControls();
      }
    }
    function refreshControls() {
      if (!controls) return;
      const keys = [...controls.getSelectedKeys()];
      const pids = controls.getProjectIds().map(String);
      const missing = pids.filter(pid => !loaded.has(pid));
      const toLoad = missing.filter(pid => !loading.has(pid) && !loadErrors.has(pid));
      if (toLoad.length) loadProjects(toLoad).then(() => controls.onChange());
      controls.assignmentHost.querySelector('button').disabled = !keys.length;
      const disabled = saving || missing.length > 0;
      controls.assignmentHost.querySelector('[data-remove-tags]').disabled = disabled;
      controls.assignmentHost.querySelector('[data-retry-tags]').classList.toggle('d-none', !saveError && !loadErrors.size);
      controls.assignmentHost.querySelectorAll('[data-assign-tag]').forEach(input => {
        const id = Number(input.dataset.assignTag);
        const count = keys.filter(key => get(key).includes(id)).length;
        input.disabled = disabled;
        input.checked = !!keys.length && count === keys.length;
        input.indeterminate = count > 0 && count < keys.length;
      });
      controls.filterHost.querySelectorAll('[data-filter-tag]').forEach(input => {
        input.checked = active.has(Number(input.dataset.filterTag));
      });
      const notice = controls.notice;
      notice.classList.toggle('d-none', !active.size);
      notice.innerHTML = active.size ? `Showing only ${tags.filter(tag => active.has(tag.id)).map(badge).join(' ')} · Clear to show all` : '';
      const status = controls.assignmentHost.querySelector('[data-tag-storage]');
      const error = saveError || missing.map(pid => loadErrors.get(pid)).find(Boolean);
      status.textContent = error ? `Tags could not be saved or loaded: ${error}` : saving ? 'Saving tags…'
        : missing.length ? 'Loading saved tags…' : 'Tags are saved with the project and survive restarts. Rows can have multiple tags.';
      status.classList.toggle('text-danger', !!error);
    }
    function mount(options) {
      controls = options;
      options.filterHost.innerHTML = '<hr class="dropdown-divider"><div class="small text-muted mb-2">Show only tagged groups</div>'
        + tags.map(tag => `<label class="d-flex align-items-center gap-2 mb-2"><input class="form-check-input m-0" type="checkbox" data-filter-tag="${tag.id}" aria-label="Show only ${tagName(tag)}">${badge(tag)}</label>`).join('')
        + '<div class="small text-muted">Choose multiple tags to show any matching group.</div>';
      options.assignmentHost.innerHTML = '<button class="btn btn-sm btn-outline-secondary dropdown-toggle" type="button" data-bs-toggle="dropdown" data-bs-auto-close="outside" aria-expanded="false" disabled>Tag</button>'
        + '<div class="dropdown-menu p-3 row-tag-menu"><div class="small text-muted mb-2">Assign tags to selected rows</div>'
        + tags.map(tag => `<label class="d-flex align-items-center gap-2 mb-2"><input class="form-check-input m-0" type="checkbox" data-assign-tag="${tag.id}" aria-label="Assign ${tagName(tag)}">${badge(tag)}</label>`).join('')
        + '<button class="btn btn-sm btn-link p-0" type="button" data-remove-tags>Remove all tags from selected</button>'
        + '<div class="small text-muted mt-2" data-tag-storage role="status"></div><button type="button" class="btn btn-sm btn-link p-0 d-none" data-retry-tags>Reload saved tags</button></div>';
      options.filterHost.querySelectorAll('[data-filter-tag]').forEach(input => input.addEventListener('change', () => {
        const id = Number(input.dataset.filterTag);
        if (input.checked) active.add(id); else active.delete(id);
        refreshControls();
        options.onChange();
      }));
      options.assignmentHost.querySelectorAll('[data-assign-tag]').forEach(input => input.addEventListener('change', async () => {
        await assign(options.getSelectedKeys(), Number(input.dataset.assignTag), input.checked);
        options.onChange();
      }));
      options.assignmentHost.querySelector('[data-remove-tags]').addEventListener('click', async () => {
        await assign(options.getSelectedKeys(), null);
        options.onChange();
      });
      options.assignmentHost.querySelector('[data-retry-tags]').addEventListener('click', async () => {
        saveError = '';
        loadErrors.clear();
        loaded.clear();
        await loadProjects(options.getProjectIds());
        options.onChange();
      });
      options.assignmentHost.addEventListener('show.bs.dropdown', refreshControls);
      refreshControls();
    }
    return {
      get, assign, mount, refreshControls, loadProjects,
      badges: key => tags.filter(tag => get(key).includes(tag.id)).map(badge).join(' '),
      matches: key => !active.size || get(key).some(id => active.has(id)),
      setFilter: ids => { active = new Set(ids.filter(id => tags.some(tag => tag.id === id))); refreshControls(); },
      clearFilter: () => { active.clear(); refreshControls(); },
    };
  }

  window.RowTags = {create};
})();
