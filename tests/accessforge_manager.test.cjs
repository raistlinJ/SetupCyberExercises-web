const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../app/static/js/accessforge_manager.js'), 'utf8');
const settle = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return {promise, resolve}; };
const response = (data, ok = true) => ({ok, status: ok ? 200 : 502, json: async () => data});

async function harness({connected = true} = {}) {
  class Element {
    constructor(id = '') {
      this.id = id; this.value = id === 'af-auto-interval' ? '0' : ''; this.type = 'password';
      this.checked = false; this.disabled = false; this.textContent = ''; this.dataset = {}; this.listeners = {};
      this.classes = new Set();
      this.classList = {add: name => this.classes.add(name), remove: name => this.classes.delete(name),
        toggle: (name, on) => { on ? this.classes.add(name) : this.classes.delete(name); }};
    }
    addEventListener(name, fn) { this.listeners[name] = fn; }
    setAttribute(name, value) { this[name] = value; }
    async fire(name = 'click') { return this.listeners[name]?.({target: this, preventDefault() {}}); }
    set innerHTML(html) {
      this.html = html;
      this.boxes = [...html.matchAll(/<input[^>]*data-user="([^"]+)"[^>]*>/g)].map(match => {
        const box = new Element(); box.dataset.user = match[1]; box.checked = /\schecked(?:\s|>)/.test(match[0]); return box;
      });
    }
    get innerHTML() { return this.html || ''; }
    querySelectorAll() { return this.boxes || []; }
  }
  const elements = new Map(), listeners = {}, windowListeners = {}, storage = new Map(), timers = new Map(), calls = [];
  const el = id => { if (!elements.has(id)) elements.set(id, new Element(id)); return elements.get(id); };
  const columnNames = ['username', 'status', 'email', 'checked_out_at', 'checkout_ip', 'relinquished_at', 'relinquished_ip'];
  const columns = columnNames.map(name => { const box = new Element(); box.value = name; box.checked = true; return box; });
  const headers = Array.from({length: 8}, () => new Element());
  let project = 'a', override = null, sequence = 0;
  const document = {hidden: false, getElementById: el, addEventListener: (name, fn) => { listeners[name] = fn; },
    querySelectorAll: selector => selector === '.af-column' ? columns : selector === '#af-table thead th' ? headers : []};
  const shell = {getCurrentProjectId: () => project, initShell: async () => {}};
  const window = {shell, addEventListener: (name, fn) => { windowListeners[name] = fn; }};
  const snapshot = pid => ({checked_at: 12345, accounts: {[`student-${pid}`]: {email: `${pid}@example.edu`, eligible: true}}});
  const context = {window, document, shell, AUTH: {me: async () => ({user: {username: 'admin'}})},
    sessionStorage: {getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value)},
    setInterval: fn => { const id = ++sequence; timers.set(id, fn); return id; }, clearInterval: id => timers.delete(id),
    confirm: () => true, fetch: async (url, options = {}) => {
      calls.push({url, options});
      if (override) { const result = override(url, options); if (result) return result; }
      if (url === '/api/projects') return response({projects: [{id: 'a', name: 'Project A'}, {id: 'b', name: 'Project B'}]});
      const pid = url.split('/')[3], operation = url.split('/').at(-1);
      if (operation === 'connection') return response({connected, url: 'https://accessforge.example', username: 'root@pam', verify_ssl: true, administrator: 'root@pam'});
      if (operation === 'accounts') return response({accounts: [{username: `student-${pid}`}], checkout: snapshot(pid)});
      return response({checkout: snapshot(pid)});
    }};
  vm.runInNewContext(source, context);
  await listeners.DOMContentLoaded();
  return {el, calls, timers, document, snapshot, columns, headers,
    override: fn => { override = fn; }, select: async pid => { project = pid; await listeners['project-selected'](); },
    tick: async () => { for (const fn of [...timers.values()]) fn(); await settle(); },
    auto: async seconds => { el('af-auto-interval').value = String(seconds); await el('af-auto-interval').fire('change'); },
    emit: name => el('af-connection').fire(name), hide: () => windowListeners.pagehide()};
}

test('status requests require Refresh or an explicitly enabled Auto interval', async () => {
  const h = await harness();
  assert.equal(h.timers.size, 0);
  assert.equal(h.calls.filter(call => call.url.endsWith('/status')).length, 0);
  await h.el('af-refresh').fire();
  assert.equal(h.calls.filter(call => call.url.endsWith('/status')).length, 1);
  await h.auto(15); await h.tick();
  assert.equal(h.calls.filter(call => call.url.endsWith('/status')).length, 2);
  await h.auto(0); assert.equal(h.timers.size, 0);
});

test('Auto waits for authentication and pauses while the connection modal or tab is hidden', async () => {
  const unauthenticated = await harness({connected: false});
  assert.equal(unauthenticated.el('af-refresh').disabled, true);
  await unauthenticated.auto(15); await unauthenticated.tick();
  assert.equal(unauthenticated.el('af-auto-badge').textContent, 'Auth');
  assert.equal(unauthenticated.calls.filter(call => call.url.endsWith('/status')).length, 0);
  const h = await harness(); await h.auto(15);
  await h.emit('show.bs.modal'); await h.tick();
  assert.equal(h.el('af-auto-badge').textContent, 'Pause');
  assert.equal(h.calls.filter(call => call.url.endsWith('/status')).length, 0);
  await h.emit('hidden.bs.modal'); h.document.hidden = true; await h.tick();
  assert.equal(h.calls.filter(call => call.url.endsWith('/status')).length, 0);
  h.document.hidden = false; await h.tick();
  assert.equal(h.calls.filter(call => call.url.endsWith('/status')).length, 1);
  h.hide(); assert.equal(h.timers.size, 0);
});

test('Auto cannot overlap a publish operation and preserves checkbox selection during refresh', async () => {
  const h = await harness();
  await h.el('af-select-visible').fire(); await h.el('af-refresh').fire();
  assert.equal(h.el('af-accounts').querySelectorAll()[0].checked, true);
  const pending = deferred(); h.override(url => url.endsWith('/publish') ? pending.promise : null);
  const publishing = h.el('af-publish').fire(); await h.auto(15); await h.tick();
  assert.equal(h.el('af-auto-badge').textContent, 'Busy');
  assert.equal(h.calls.filter(call => call.url.endsWith('/status')).length, 1);
  pending.resolve(response({checkout: h.snapshot('a')})); await publishing;
  await h.tick(); assert.equal(h.calls.filter(call => call.url.endsWith('/status')).length, 2);
});

test('late refresh responses cannot overwrite a project after switching away and back', async () => {
  const h = await harness(), pending = deferred();
  h.override(url => url.endsWith('/status') ? pending.promise : null);
  const refreshing = h.el('af-refresh').fire();
  h.el('af-password').value = 'must-be-cleared'; await h.select('b'); await h.select('a');
  assert.equal(h.el('af-password').value, '');
  pending.resolve(response({checkout: {accounts: {'student-a': {email: 'stale@example.edu'}}}})); await refreshing;
  assert.match(h.el('af-accounts').innerHTML, /a@example.edu/);
  assert.doesNotMatch(h.el('af-accounts').innerHTML, /stale@example.edu/);
});

test('refresh failures retain the cached status and report the error', async () => {
  const h = await harness(); h.override(url => url.endsWith('/status') ? response({error: 'AccessForge is unavailable'}, false) : null);
  await h.el('af-refresh').fire();
  assert.match(h.el('af-accounts').innerHTML, /a@example.edu/);
  assert.equal(h.el('af-status').textContent, 'AccessForge is unavailable');
  assert.equal(h.el('af-refresh').disabled, false);
});
