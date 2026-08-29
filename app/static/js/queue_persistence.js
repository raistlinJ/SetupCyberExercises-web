// Cross-page helpers for durable queue-backed actions.
(function(){
  if (!window.registerRemoteActionHandler || !window.queueRemoteAction || !window.runQueued) return;

  const PAYLOAD_DB_NAME = 'deployforge-action-queue';
  const PAYLOAD_DB_VERSION = 1;
  const PAYLOAD_STORE_NAME = 'payloads';
  const VM_ACTION_HANDLER = 'vm-manager-action-v1';
  const GUEST_TRANSFER_HANDLER = 'vm-manager-guest-transfer-v1';

  function canonicalPayload(payload){
    return JSON.parse(JSON.stringify(payload || {}));
  }

  function openPayloadDb(){
    return new Promise((resolve, reject) => {
      if (!window.indexedDB) return reject(new Error('IndexedDB is unavailable'));
      const request = window.indexedDB.open(PAYLOAD_DB_NAME, PAYLOAD_DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(PAYLOAD_STORE_NAME)) {
          db.createObjectStore(PAYLOAD_STORE_NAME, { keyPath: 'id' });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('Could not open the queue payload database'));
    });
  }

  async function payloadTransaction(mode, callback){
    const db = await openPayloadDb();
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(PAYLOAD_STORE_NAME, mode);
        const store = tx.objectStore(PAYLOAD_STORE_NAME);
        let request;
        try { request = callback(store); } catch (error) { reject(error); return; }
        tx.oncomplete = () => {
          try { resolve(request ? request.result : undefined); }
          catch { resolve(undefined); }
        };
        tx.onerror = () => reject(tx.error || new Error('Queue payload transaction failed'));
        tx.onabort = () => reject(tx.error || new Error('Queue payload transaction was aborted'));
      });
    } finally {
      try { db.close(); } catch {}
    }
  }

  const payloadStore = {
    async put(id, value){
      const key = String(id || '').trim();
      if (!key) throw new Error('Missing queue payload id');
      await payloadTransaction('readwrite', store => store.put({ id: key, value, updatedAt: Date.now() }));
      return key;
    },
    async get(id){
      const key = String(id || '').trim();
      if (!key) return null;
      const record = await payloadTransaction('readonly', store => store.get(key));
      return record && Object.prototype.hasOwnProperty.call(record, 'value') ? record.value : null;
    },
    async remove(id){
      const key = String(id || '').trim();
      if (!key) return;
      await payloadTransaction('readwrite', store => store.delete(key));
    },
  };

  function projectIdsFromVmAction(data){
    const ids = [];
    const seen = new Set();
    const add = value => {
      const pid = String(value ?? '').trim();
      if (!pid || seen.has(pid)) return;
      seen.add(pid);
      ids.push(pid);
    };
    (Array.isArray(data?.projectIds) ? data.projectIds : []).forEach(add);
    add(data?.projectId);
    Object.keys(data?.options?.targetsByPid || {}).forEach(add);
    (Array.isArray(data?.groups) ? data.groups : []).forEach(group => add(group?.pid));
    return ids;
  }

  async function readVmActionStatus(pid){
    const response = await fetch(`/api/projects/${encodeURIComponent(pid)}/instances/actions/status`, {
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
    });
    if (response.status === 404) return null;
    if (!response.ok) {
      let message = '';
      try { message = await response.text(); } catch {}
      throw new Error(message || response.statusText || `HTTP ${response.status}`);
    }
    return await response.json();
  }

  async function trackActiveVmAction(data, saved){
    const projectIds = projectIdsFromVmAction(data);
    if (!projectIds.length) return;
    const label = String(saved?.label || data?.label || 'VM action');
    try { window.showActionProgress?.(label, 'Reconnecting to the running operation…'); } catch {}

    let sawRunning = false;
    let emptyPasses = 0;
    const started = Date.now();
    while ((Date.now() - started) < 24 * 60 * 60 * 1000) {
      const statuses = [];
      for (const pid of projectIds) {
        try {
          const status = await readVmActionStatus(pid);
          if (status) statuses.push({ pid, status });
        } catch (error) {
          try { window.shell?.logWarn?.(`[QUEUE] Could not read ${pid} action status: ${error?.message || error}`); } catch {}
        }
      }

      const running = statuses.filter(item => {
        const state = String(item?.status?.status || '').toLowerCase();
        return !state || !['completed', 'cancelled', 'error'].includes(state);
      });
      if (running.length) {
        sawRunning = true;
        emptyPasses = 0;
        const primary = running[0].status || {};
        const percentValues = running.map(item => Number(item?.status?.progress)).filter(Number.isFinite);
        const percent = percentValues.length
          ? Math.round(percentValues.reduce((sum, value) => sum + value, 0) / percentValues.length)
          : null;
        const detail = String(primary.message || primary.current || `Running on ${running.length} project(s)…`);
        try { window.updateActionProgress?.(percent, `${running.length} active`, detail); } catch {}
      } else {
        emptyPasses += 1;
        if (sawRunning || emptyPasses >= 3) {
          try {
            window.shell?.logInfo?.(
              sawRunning
                ? `[QUEUE] Reconnected operation finished: ${label}`
                : `[QUEUE] ${label} is no longer reported active; it was not replayed.`
            );
          } catch {}
          try { window.hideActionProgress?.(); } catch {}
          if (data?.payloadId) {
            try { await payloadStore.remove(data.payloadId); } catch {}
          }
          return;
        }
      }
      await new Promise(resolve => window.setTimeout(resolve, 1200));
    }
    throw new Error(`Timed out while tracking ${label}`);
  }

  // Every page can safely reconnect to an action that was already active.
  // Waiting VM actions stay in the backlog until vm_manager.js registers the
  // executor that knows how to build their complete request.
  window.registerRemoteActionHandler(VM_ACTION_HANDLER, (data, saved) => {
    if (String(saved?.status || '') !== 'active') return null;
    return () => trackActiveVmAction(data || {}, saved || {});
  });
  window.registerRemoteActionHandler(GUEST_TRANSFER_HANDLER, (data, saved) => {
    if (String(saved?.status || '') !== 'active') return null;
    return () => trackActiveVmAction(data || {}, saved || {});
  });

  window.PersistentQueuePayloads = payloadStore;
  window.PERSISTENT_VM_ACTION_HANDLER = VM_ACTION_HANDLER;
  window.cleanupPersistentQueueTask = entry => {
    const payloadId = entry?.persist?.data?.payloadId;
    if (payloadId) payloadStore.remove(payloadId).catch(() => {});
  };

  window.shell = window.shell || {};
  window.shell.queuePersist = {
    payloads: payloadStore,

    submitHttp(method, url, body, opts){
      const persist = window.makeHttpPersist ? window.makeHttpPersist(method, url, body, opts) : null;
      return runQueued(opts?.label || `${method} ${url}`, async () => {
        const headers = (opts && opts.headers) ? { ...opts.headers } : {};
        const fetchOpts = {
          method: method,
          headers,
          credentials: opts?.credentials || 'same-origin',
        };
        if (body !== undefined && !(body instanceof FormData)) {
          if (!Object.keys(headers).some(h => h.toLowerCase() === 'content-type')) {
            fetchOpts.headers['Content-Type'] = 'application/json';
          }
          fetchOpts.body = JSON.stringify(body);
        } else if (body instanceof FormData) {
          fetchOpts.body = body;
        }
        const res = await fetch(url, fetchOpts);
        if (!res.ok) throw new Error(await res.text());
        return res;
      }, { persist, projectId: opts?.projectId });
    },

    restoreSubmit(label, builder, opts){
      if (!opts || !opts.key) throw new Error('Missing persist key');
      registerRemoteActionHandler(opts.key, (data, saved) => builder({ data, saved }));
      return queueRemoteAction(label, () => builder({}), {
        projectId: opts.projectId,
        persist: { key: opts.key, data: canonicalPayload(opts.data) },
      });
    }
  };
})();
