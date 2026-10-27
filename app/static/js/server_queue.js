// The browser submits complete work, then observes it. The server owns scheduling.
(function () {
  const nativeFetch = window.fetch.bind(window);
  const records = new Map();
  let observation = 0;
  let lastPublished = '';
  let context = null;
  let refreshing = null;
  const reads = new Map();
  const readControllers = new Set();
  let readGeneration = 0;
  let pageActive = true;
  const terminal = item => ['completed', 'error', 'cancelled'].includes(item.status);
  const visible = () => [...records.values()].filter(entry => !entry.hidden)
    .map(entry => entry.item).sort((a, b) => a.id - b.id);
  const emit = () => {
    // Identical polling responses should not rebuild the queue DOM.
    const signature = JSON.stringify(visible().map(({ revision, ...item }) => item));
    if (signature === lastPublished) return;
    lastPublished = signature;
    document.dispatchEvent(new CustomEvent('remote-queue-changed'));
  };
  const stamp = value => Number.isFinite(Number(value)) && Number(value) > 0;
  const rank = item => terminal(item) ? 2 : item.status === 'running' ? 1 : 0;
  function merge(item, sequence, listed = false) {
    const id = Number(item.id);
    if (!Number.isSafeInteger(id) || id <= 0) return item;
    const previous = records.get(id);
    const versioned = Number.isInteger(item.revision) && Number.isInteger(previous?.item.revision);
    if (previous && ((versioned && item.revision < previous.item.revision)
        || ((!versioned || item.revision === previous.item.revision) && sequence < previous.sequence)
        || rank(item) < rank(previous.item))) return previous.item;
    const next = { ...previous?.item, ...item, id };
    // Submission/start times describe one event, never the latest poll.
    for (const field of ['createdAt', 'startedAt', 'finishedAt']) {
      if (stamp(previous?.item[field])) next[field] = previous.item[field];
    }
    const hidden = !!item.dismissed || (!!previous?.hidden && !listed
      && (!versioned || item.revision <= previous.item.revision));
    records.set(id, { item: next, sequence: Math.max(sequence, previous?.sequence || 0), hidden });
    if (terminal(next) && (!previous || !terminal(previous.item))) ++readGeneration;
    return next;
  }
  const token = () => window.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;

  function isRead(url, method) {
    if (method === 'GET' || method === 'HEAD') return true;
    // These endpoints use POST to carry credentials, but do not submit actions.
    return method === 'POST' && (
      /^\/api\/proxmox\/(?:nodes(?:\/[^/]+\/network)?|templates)$/.test(url.pathname)
      || url.pathname === '/api/ctfd/challenges'
      || /^\/api\/projects\/[^/]+\/(?:instances\/refresh\/vm|proxmox\/verify|ctfrpg\/(?:login|users_check)|ctfd\/(?:login|settings|users_check|challenges\/list|stats\/challenges(?:\/\d+)?))$/.test(url.pathname)
    );
  }

  function readFetch(input, options = {}) {
    if (!pageActive) return Promise.reject(Object.assign(new Error('Page navigation cancelled the read'), { name: 'AbortError' }));
    // Caller-owned cancellation must never cancel another consumer's request.
    if (options.signal || (options.body !== undefined && typeof options.body !== 'string')) {
      return nativeFetch(input, options);
    }
    const headers = Array.from(new Headers(options.headers || {})).sort(([a], [b]) => a.localeCompare(b));
    const key = JSON.stringify([readGeneration, new URL(input, window.location.href).href, { ...options, headers }]);
    let pending = reads.get(key);
    if (!pending) {
      const controller = window.AbortController ? new window.AbortController() : null;
      if (controller) readControllers.add(controller);
      pending = Promise.resolve().then(() => nativeFetch(input, controller ? { ...options, signal: controller.signal } : options))
        .finally(() => {
          reads.delete(key);
          if (controller) readControllers.delete(controller);
        });
      reads.set(key, pending);
    }
    // Each caller consumes its own body, including error responses.
    return pending.then(response => response.clone());
  }

  async function refresh() {
    if (refreshing) return refreshing;
    const sequence = ++observation;
    refreshing = (async () => {
      const response = await nativeFetch('/api/queue', { credentials: 'same-origin', cache: 'no-store' });
      if (!response.ok) return;
      const payload = await response.json();
      if (!Array.isArray(payload.items)) throw new Error('Invalid queue snapshot');
      const items = payload.items.filter(item => item.label);
      const present = new Set(items.map(item => Number(item.id)));
      items.forEach(item => merge(item, sequence, true));
      // An older list must not erase work accepted or updated while it loaded.
      for (const [id, entry] of records) {
        if (!present.has(id) && entry.sequence <= sequence) {
          entry.hidden = true;
          entry.sequence = sequence;
        }
      }
      emit();
    })().finally(() => { refreshing = null; });
    return refreshing;
  }

  async function submit(label, steps, options = {}, files = []) {
    ++readGeneration;
    const sequence = ++observation;
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
    let job;
    if (files.length && window.XMLHttpRequest) {
      job = await new Promise((resolve, reject) => {
        const xhr = new window.XMLHttpRequest();
        xhr.open('POST', '/api/queue');
        xhr.withCredentials = true;
        Object.entries(headers).forEach(([key, value]) => xhr.setRequestHeader(key, value));
        xhr.upload.onprogress = event => options.onUploadProgress?.({
          loaded: event.loaded, total: event.lengthComputable ? event.total : null,
        });
        xhr.upload.onload = () => options.onUploadProgress?.({ uploaded: true });
        xhr.onerror = () => reject(new Error('Upload failed. The file may have changed on disk. Please re-select it and upload again.'));
        xhr.onabort = () => reject(new Error('Upload interrupted. Check the Queue before retrying.'));
        xhr.onload = () => {
          if (xhr.status < 200 || xhr.status >= 300) {
            const message = xhr.status === 413
              ? 'The server or proxy rejected this file as too large (HTTP 413).'
              : `Upload submission failed (HTTP ${xhr.status}).`;
            let detail;
            try { detail = JSON.parse(xhr.responseText).error; } catch { }
            reject(new Error(detail || message));
            return;
          }
          try { resolve(JSON.parse(xhr.responseText)); }
          catch { reject(new Error('Invalid upload response. Check the Queue before retrying.')); }
        };
        xhr.send(body);
      });
    } else {
      // Small submissions survive ordinary page navigation while being accepted.
      const response = await nativeFetch('/api/queue', {
        method: 'POST', credentials: 'same-origin', headers, body,
        keepalive: typeof body === 'string' && new Blob([body]).size < 60000,
      });
      if (!response.ok) throw new Error(await response.text());
      job = await response.json();
    }
    merge(job, sequence);
    emit();
    return job;
  }

  async function wait(job, onUpdate) {
    for (;;) {
      // Network failures affect observation only; never resubmit accepted work.
      try {
        const sequence = ++observation;
        const response = await nativeFetch(`/api/queue/${job.id}`, { credentials: 'same-origin', cache: 'no-store' });
        if (response.status === 401 || response.status === 403 || response.status === 404) {
          throw Object.assign(new Error('Cannot access queued action'), { terminal: true });
        }
        if (response.ok) {
          const state = merge(await response.json(), sequence);
          try { onUpdate?.(state); } catch (error) { window.shell?.logError?.(error.message || error); }
          emit();
          if (terminal(state)) return state;
        }
      } catch (error) { if (error.terminal) throw error; }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }

  async function result(job) {
    const state = await wait(job);
    // A refresh after a mutation must not share a pre-mutation read.
    ++readGeneration;
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
    const ordered = visible();
    const activeItems = ordered.filter(item => item.status === 'running');
    return { active: !!activeItems.length, current: activeItems[0] || null, activeItems,
      items: ordered.filter(item => item.status === 'queued'),
      completed: ordered.filter(terminal).reverse() };
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
    const localApi = url.origin === window.location.origin && url.pathname.startsWith('/api/');
    if (localApi && !url.pathname.startsWith('/api/queue') && isRead(url, method)) {
      return readFetch(input, options);
    }
    const eligible = localApi
      && !url.pathname.startsWith('/api/queue')
      && !/\/(cancel|status|create-preflight)$/.test(url.pathname);
    if (eligible && (context || ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method))) {
      return queuedFetch(url.pathname + url.search, options);
    }
    return nativeFetch(input, options);
  };
  window.addEventListener?.('pagehide', () => {
    pageActive = false;
    ++readGeneration;
    for (const controller of readControllers) controller.abort();
    reads.clear();
  });
  window.addEventListener?.('pageshow', () => { pageActive = true; });
  document.addEventListener?.('auth-changed', () => {
    ++readGeneration;
    for (const controller of readControllers) controller.abort();
    reads.clear();
  });
  refresh().catch(() => {});
  // Hidden tabs do not need a steady stream of queue snapshots.
  setInterval(() => {
    if (pageActive && !document.hidden) refresh().catch(() => {});
  }, 2000);
  document.addEventListener?.('visibilitychange', () => {
    if (pageActive && !document.hidden) refresh().catch(() => {});
  });
})();
