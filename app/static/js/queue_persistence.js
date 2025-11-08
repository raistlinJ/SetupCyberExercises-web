// Helpers to persist queue-backed actions across reloads
(function(){
  if (!window.registerRemoteActionHandler || !window.queueRemoteAction || !window.runQueued) return;

  function canonicalPayload(payload){
    return JSON.parse(JSON.stringify(payload || {}));
  }

  window.shell = window.shell || {};
  window.shell.queuePersist = {
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
      registerRemoteActionHandler(opts.key, (data, saved) => {
        return builder({ data, saved });
      });
      return queueRemoteAction(label, () => builder({}), {
        projectId: opts.projectId,
        persist: { key: opts.key, data: canonicalPayload(opts.data) },
      });
    }
  };
})();
