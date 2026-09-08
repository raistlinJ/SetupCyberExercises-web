// The browser submits complete work, then observes it. The server owns scheduling.
(function () {
  const nativeFetch = window.fetch.bind(window);
  let records = [];
  let context = null;
  let refreshing = null;
  const terminal = item => ['completed', 'error', 'cancelled'].includes(item.status);
  const emit = () => document.dispatchEvent(new CustomEvent('remote-queue-changed'));
  const token = () => window.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;

  async function refresh() {
    if (refreshing) return refreshing;
    refreshing = (async () => {
      const response = await nativeFetch('/api/queue', { credentials: 'same-origin' });
      if (!response.ok) return;
      records = ((await response.json()).items || []).filter(item => item.label);
      emit();
    })().finally(() => { refreshing = null; });
    return refreshing;
  }

  async function submit(label, steps, options = {}, files = []) {
    const plan = { label, steps, projectId: String(options.projectId || ''), token: options.token || token() };
    let body;
    const headers = {};
    const apiKey = options.headers && new Headers(options.headers).get('X-API-Key');
    if (apiKey) headers['X-API-Key'] = apiKey;
    if (files.length) {
      body = new FormData();
      body.append('plan', JSON.stringify(plan));
      files.forEach(([key, file]) => body.append(key, file, file.name || 'upload'));
    } else {
      body = JSON.stringify(plan);
      headers['Content-Type'] = 'application/json';
    }
    // Small submissions survive ordinary page navigation while being accepted.
    const response = await nativeFetch('/api/queue', {
      method: 'POST', credentials: 'same-origin', headers, body,
      keepalive: typeof body === 'string' && new Blob([body]).size < 60000,
    });
    if (!response.ok) throw new Error(await response.text());
    const job = await response.json();
    records = records.filter(item => item.id !== job.id).concat(job);
    emit();
    return job;
  }

  async function wait(job, onUpdate) {
    for (;;) {
      // Network failures affect observation only; never resubmit accepted work.
      try {
        const response = await nativeFetch(`/api/queue/${job.id}`, { credentials: 'same-origin' });
        if (response.status === 401 || response.status === 403 || response.status === 404) {
          throw Object.assign(new Error('Cannot access queued action'), { terminal: true });
        }
        if (response.ok) {
          const state = await response.json();
          try { onUpdate?.(state); } catch (error) { window.shell?.logError?.(error.message || error); }
          records = records.filter(item => item.id !== state.id).concat(state);
          emit();
          if (terminal(state)) return state;
        }
      } catch (error) { if (error.terminal) throw error; }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }

  async function result(job) {
    const state = await wait(job);
    const response = await nativeFetch(`/api/queue/${job.id}/result`, { credentials: 'same-origin' });
    if (state.status === 'cancelled') throw new Error('Action cancelled');
    // Preserve endpoint errors (and their HTTP status) for existing callers.
    if (state.status === 'error' && response.ok) {
      throw new Error(state.errorMessage || 'Action failed');
    }
    return response;
  }

  function requestStep(url, options = {}, files = []) {
    const step = { url, method: String(options.method || 'GET').toUpperCase() };
    const headers = new Headers(options.headers || {});
    step.headers = Object.fromEntries(headers);
    if (options.body instanceof FormData) {
      step.form = [];
      step.files = [];
      for (const [field, value] of options.body.entries()) {
        if (typeof value === 'string') step.form.push([field, value]);
        else {
          const key = `file-${files.length}`;
          files.push([key, value]);
          step.files.push([field, key]);
        }
      }
      delete step.headers['content-type'];
    } else if (options.body !== undefined) {
      if ((headers.get('Content-Type') || '').includes('application/json')) step.body = JSON.parse(options.body);
      else step.raw = options.body;
    }
    return step;
  }

  async function queuedFetch(url, options = {}, onAccepted) {
    const files = [];
    const step = requestStep(url, options, files);
    const opts = { ...(context || {}), headers: options.headers };
    // The server derives a readable action title when no explicit label exists.
    const label = opts.label;
    const job = await submit(label, [step], opts, files);
    opts.onAccepted?.(job);
    onAccepted?.(job);
    return result(job);
  }

  async function run(label, fn, options = {}) {
    try {
      const key = options.persist?.key;
      if (key === 'vm-manager-action-v1') {
        return await window.submitServerVmAction(label, options.persist.data, options);
      }
      if (key === 'vm-manager-guest-transfer-v1') {
        return await window.submitServerGuestTransfer(label, options.persist.data, options);
      }
      // Start request preparation immediately. No operation waits in a page's
      // JavaScript queue; fetch hands its request body to the server scheduler.
      const previous = context;
      let promise;
      try { context = { ...options, label }; promise = fn?.(); }
      finally { context = previous; }
      await promise;
      return { status: 'completed' };
    } catch (error) {
      window.shell?.logError?.(`[QUEUE] ${label}: ${error.message || error}`);
      throw error;
    }
  }

  const state = () => {
    const activeItems = records.filter(item => item.status === 'running');
    return { active: !!activeItems.length, current: activeItems[0] || null, activeItems,
      items: records.filter(item => item.status === 'queued'),
      completed: records.filter(terminal).sort((a, b) => b.id - a.id) };
  };

  window.ServerQueue = { submit, wait, result, run, state, refresh, requestStep, nativeFetch, fetch: queuedFetch,
    clearCompleted() {
      return nativeFetch('/api/queue/completed', { method: 'DELETE', credentials: 'same-origin' })
        .then(response => { if (!response.ok) throw new Error('Could not clear queue history'); return refresh(); })
        .catch(error => window.shell?.logError?.(error.message));
    },
    cancel(id) {
      nativeFetch(`/api/queue/${id}/cancel`, { method: 'POST', credentials: 'same-origin' })
        .then(response => { if (!response.ok) throw new Error('Cancellation failed'); return refresh(); })
        .catch(error => window.shell?.logError?.(error.message));
      return true;
    },
  };
  window.fetch = function (input, options = {}) {
    if (typeof input !== 'string') return nativeFetch(input, options);
    const url = new URL(input, window.location.href);
    const method = String(options.method || 'GET').toUpperCase();
    // These inventory reads use POST to carry connection credentials. They
    // must remain available while actions are running, even inside runQueued.
    const inventoryRead = method === 'POST' && (
      /^\/api\/proxmox\/(?:nodes(?:\/[^/]+\/network)?|templates)$/.test(url.pathname)
      || /^\/api\/projects\/[^/]+\/instances\/refresh\/vm$/.test(url.pathname)
    );
    const eligible = url.origin === window.location.origin && url.pathname.startsWith('/api/')
      && !inventoryRead
      && !url.pathname.startsWith('/api/queue')
      && !/\/(cancel|status|create-preflight)$/.test(url.pathname);
    if (eligible && (context || ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method))) {
      return queuedFetch(url.pathname + url.search, options);
    }
    return nativeFetch(input, options);
  };
  refresh().catch(() => {});
  setInterval(() => refresh().catch(() => {}), 2000);
})();
