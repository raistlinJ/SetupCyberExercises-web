(() => {
  'use strict';
  const interval = 60000;
  const lookups = new Map();

  function timestamp(value) {
    if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
    const raw = String(value).trim();
    if (!raw) return null;
    const numeric = Number(raw);
    const ms = Number.isFinite(numeric) ? numeric * (numeric < 1e12 ? 1000 : 1)
      : Date.parse(/[zZ]$|[+-]\d{2}:?\d{2}$/.test(raw) ? raw : `${raw.replace(' ', 'T')}Z`);
    return Number.isFinite(ms) && ms > 0 && ms <= 8.64e15 ? ms : null;
  }

  function isoTime(value) {
    const ms = timestamp(value);
    return ms === null ? '' : new Date(ms).toISOString();
  }

  function exactTime(iso) {
    return `${iso.slice(0, 16).replace('T', ' ')} UTC`;
  }

  function durationAgo(value, now) {
    const ms = timestamp(value);
    if (ms === null) return '';
    const minutes = Math.max(0, Math.floor((now - ms) / 60000));
    return `${String(Math.floor(minutes / 60)).padStart(2, '0')}h ${String(minutes % 60).padStart(2, '0')}m`;
  }

  function format(value, now) {
    const age = durationAgo(value, now);
    return age ? `${age} ago` : 'Unavailable';
  }

  function endTitle(end, estimated) {
    return end ? `. ${estimated ? 'Last browser check-in' : 'Signed out'} ${end}` : '';
  }

  function cell(value, endValue, estimated) {
    const iso = isoTime(value);
    if (!iso) return '<span class="text-muted" title="Waiting for an AccessForge sign-in lookup">Unavailable</span>';
    const end = isoTime(endValue);
    const startTime = `<time datetime="${iso}">${exactTime(iso)}</time>`;
    const endTime = end ? ` - <time datetime="${end}">${exactTime(end)}</time>` : '';
    return `<span class="text-muted" title="Saved AccessForge sign-in ${iso}${endTitle(end, estimated)}">${startTime}${endTime}</span>`;
  }

  function sessionState(lookup, account, saved, savedEnd) {
    const latest = isoTime(lookup?.latest?.[account]);
    return {
      latest,
      start: latest || saved,
      end: latest ? lookup.ends?.[account] : savedEnd,
      active: Boolean(!lookup?.error && lookup?.active?.has(account)),
    };
  }

  function sortValue({active, start, end}) {
    if (active) return Infinity;
    return start ? timestamp(end?.timestamp) ?? 0 : 0;
  }

  function sessionSortValue(pid, account, saved, end) {
    return sortValue(sessionState(lookups.get(pid), account, saved, end));
  }

  function cellSession(element, lookup) {
    const data = element.dataset;
    return sessionState(lookup, data.accessforgeAccount, data.accessforgeSaved, {
      timestamp: data.accessforgeSavedEnd,
      estimated: data.accessforgeSavedEstimate === 'true',
    });
  }

  function paint(element, lookup, session = cellSession(element, lookup)) {
    const {latest, start: iso, end: sessionEnd, active} = session;
    const end = isoTime(sessionEnd?.timestamp);
    const estimated = sessionEnd?.estimated;
    const verified = Boolean(latest && !lookup.error);
    element.classList.toggle('text-muted', !active && !verified);
    element.classList.toggle('text-success', Boolean(active));
    element.classList.toggle('fw-semibold', Boolean(active));
    if (active) {
      element.textContent = 'Active';
      element.title = latest ? `Active AccessForge session. Signed in at ${latest}` : 'Active AccessForge session';
      return;
    }
    if (!iso) {
      const errorLabels = {404: 'Check SCE-web', 409: 'Check connection', 501: 'Update AccessForge'};
      const connectionLabels = {accessforge_url_required: 'Set AccessForge URL', proxmox_login_required: 'Sign in to Proxmox'};
      element.textContent = lookup.latest && !lookup.error ? 'No sign-in recorded'
        : connectionLabels[lookup.errorCode] || errorLabels[lookup.errorStatus] || 'Unavailable';
      element.title = lookup.error || 'No AccessForge sign-in timestamp is available for this account';
      return;
    }
    const now = verified && lookup.observedAt !== null
      ? lookup.observedAt + Math.max(0, performance.now() - lookup.receivedAt) : null;
    if (end) {
      element.textContent = now === null ? `${exactTime(iso)} - ${exactTime(end)}`
        : `${durationAgo(iso, now)} - ${format(end, now)}`;
    } else {
      element.textContent = now === null ? exactTime(iso) : format(iso, now);
    }
    element.title = `${verified ? 'AccessForge sign-in' : 'Saved AccessForge sign-in'} ${iso}${endTitle(end, estimated)}${lookup.error ? `. ${lookup.error}` : ''}`;
  }

  async function lookupProject(pid, lookup) {
    lookup.request?.abort();
    const controller = new AbortController();
    lookup.request = controller;
    lookup.requestedAt = performance.now();
    const previous = {latest: lookup.latest, ends: lookup.ends, active: lookup.active, error: lookup.error};
    let errorStatus = null;
    let errorCode = null;
    try {
      const credentials = typeof hydrateProxCredsFromPersisted === 'function'
        ? await hydrateProxCredsFromPersisted(pid) : {};
      const useProxmox = credentials.username && credentials.password;
      if (controller.signal.aborted) return;
      const transport = window.ServerQueue?.nativeFetch || fetch;
      const response = await transport(`/api/projects/${encodeURIComponent(pid)}/accessforge/sign-ins/latest`, {
        cache: 'no-store', credentials: 'same-origin', signal: controller.signal,
        ...(useProxmox ? {method: 'POST', headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({username: credentials.username, password: credentials.password})} : {}),
      });
      const result = await response.json().catch(() => null);
      if (controller.signal.aborted) return;
      if (!response.ok) {
        errorStatus = response.status;
        errorCode = result?.code;
        throw new Error(result?.error || (errorStatus === 404
          ? 'The running SCE-web server does not expose this lookup. Check that the AccessForge plugin is enabled and SCE-web is up to date.'
          : 'AccessForge sign-in lookup unavailable'));
      }
      if (!result?.latest || typeof result.latest !== 'object' || Array.isArray(result.latest)) {
        throw new Error('Invalid AccessForge sign-in response');
      }
      lookup.latest = result.latest;
      lookup.ends = result.ends;
      lookup.active = new Set(Array.isArray(result.active) ? result.active : []);
      lookup.observedAt = timestamp(result.observed_at);
      lookup.receivedAt = performance.now();
      lookup.error = '';
    } catch (error) {
      if (!controller.signal.aborted) lookup.error = error.message || 'AccessForge sign-in lookup unavailable';
    } finally {
      if (lookup.request === controller) {
        lookup.errorStatus = errorStatus;
        lookup.errorCode = errorCode;
        lookup.request = null;
        let sortChanged = false;
        for (const cell of document.querySelectorAll('[data-accessforge-project]')) {
          if (cell.dataset.accessforgeProject !== pid) continue;
          const session = cellSession(cell, lookup);
          if (sortValue(session) !== sortValue(cellSession(cell, previous))) sortChanged = true;
          paint(cell, lookup, session);
        }
        if (sortChanged) document.dispatchEvent(new Event('vm-sign-in-sort-changed'));
      }
    }
  }

  function refreshVisible(force = false, restart = false) {
    if (document.hidden) return;
    const visited = new Set();
    for (const element of document.querySelectorAll('[data-accessforge-project]')) {
      const pid = element.dataset.accessforgeProject;
      if (!lookups.has(pid)) lookups.set(pid, {requestedAt: -Infinity});
      const lookup = lookups.get(pid);
      if (lookup.latest || lookup.error) paint(element, lookup);
      if (visited.has(pid)) continue;
      visited.add(pid);
      if (restart || (!lookup.request && (force || performance.now() - lookup.requestedAt >= interval))) {
        void lookupProject(pid, lookup);
      }
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    refreshVisible();
    setInterval(refreshVisible, interval);
  });
  document.addEventListener('vm-table-rendered', () => refreshVisible());
  document.addEventListener('visibilitychange', () => refreshVisible(true));
  window.addEventListener('focus', () => refreshVisible(true));
  window.LoginTime = {timestamp, isoTime, format, cell, sessionSortValue, refresh: () => refreshVisible(true, true)};
})();
