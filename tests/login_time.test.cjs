const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function helper() {
  const listeners = new Map();
  const document = {hidden: false, querySelectorAll: () => [], addEventListener: (type, fn) => listeners.set(type, fn),
    dispatchEvent: event => listeners.get(event.type)?.(event)};
  const window = {addEventListener: (type, fn) => listeners.set(type, fn)};
  let elapsed = 0;
  let update;
  const context = {window, document, AbortController, Event, CustomEvent: Event, performance: {now: () => elapsed},
    setInterval(fn, interval) { assert.equal(interval, 60000); update = fn; }};
  vm.runInNewContext(fs.readFileSync('app/static/js/login_time.js', 'utf8'), context);
  return {api: context.window.LoginTime, context, listeners, tick(ms) { elapsed += ms; update(); }};
}

test('last login formats hours and minutes without wrapping after a day', () => {
  const {api} = helper();
  const now = Date.parse('2026-10-29T18:00:00Z');
  assert.equal(api.format('2026-10-29T15:45:00Z', now), '02h 15m ago');
  assert.equal(api.format('2026-10-28T15:45:00Z', now), '26h 15m ago');
  assert.equal(api.format('2026-10-29T17:59:01Z', now), '00h 00m ago');
  assert.equal(api.format('2026-10-29T19:00:00Z', now), '00h 00m ago');
  assert.equal(api.timestamp('2026-10-29 15:45:00'), Date.parse('2026-10-29T15:45:00Z'));
  assert.equal(api.timestamp('2026-10-29T09:45:00-06:00'), Date.parse('2026-10-29T15:45:00Z'));
});

test('missing and invalid timestamps remain unavailable, including zero and booleans', () => {
  const {api} = helper();
  for (const value of [null, undefined, '', ' ', false, true, 0, '0', 'never', -1]) {
    assert.equal(api.format(value), 'Unavailable');
    assert.doesNotMatch(api.cell(value), /datetime=/);
  }
  assert.match(api.cell('2026-10-29T09:00:00-06:00'), /datetime="2026-10-29T15:00:00.000Z"/);
  assert.equal(api.timestamp(1793286000), api.timestamp(1793286000000));
});

test('sign-in age uses AccessForge time and reloads when the window regains focus', async () => {
  const {context, listeners, tick} = helper();
  const cell = {dataset: {accessforgeProject: 'lab', accessforgeAccount: 'alice@pve',
    accessforgeSaved: '2026-10-08T04:00:00.000Z'}, classList: {toggle() {}}, textContent: ''};
  context.document.querySelectorAll = () => [cell];
  let result = {latest: {'alice@pve': 1793286000}, observed_at: 1793286059};
  let available = true;
  let requests = 0;
  context.fetch = async url => {
    requests++;
    assert.equal(url, '/api/projects/lab/accessforge/sign-ins/latest');
    return {ok: available, json: async () => result};
  };
  const settle = () => new Promise(setImmediate);
  listeners.get('DOMContentLoaded')();
  await settle();
  assert.equal(cell.textContent, '00h 00m ago');
  tick(2000);
  assert.equal(cell.textContent, '00h 01m ago');
  assert.equal(requests, 1);
  result = {latest: {'alice@pve': 1793286090}, observed_at: 1793286095};
  listeners.get('focus')();
  await settle();
  assert.equal(cell.textContent, '00h 00m ago');
  assert.equal(requests, 2);
  result.active = ['alice@pve'];
  listeners.get('focus')();
  await settle();
  assert.equal(cell.textContent, 'Active');
  result.active = ['alice@pam'];
  result.observed_at = 1793289810;
  result.ends = {'alice@pve': {timestamp: 1793289750, estimated: true}};
  listeners.get('focus')();
  await settle();
  assert.equal(cell.textContent, '01h 02m - 00h 01m ago');
  assert.match(cell.title, /Last browser check-in/);
  result.ends['alice@pve'].estimated = false;
  listeners.get('focus')();
  await settle();
  assert.equal(cell.textContent, '01h 02m - 00h 01m ago');
  assert.match(cell.title, /Signed out/);
  result.active = ['alice@pve'];
  listeners.get('focus')();
  await settle();
  assert.equal(cell.textContent, 'Active');
  available = false;
  listeners.get('focus')();
  await settle();
  assert.match(cell.textContent, /UTC$/);
  assert.match(cell.title, /^Saved AccessForge sign-in/);
});

test('VM login cells use the exact credential account and ignore stale username assignments', () => {
  const {api} = helper();
  const source = fs.readFileSync('app/static/js/vm_manager.js', 'utf8');
  const context = {LoginTime: api, escHtml: value => value};
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('function vmSignInData('), source.indexOf('function renderMergedVmTable(')), context);
  const status = {accessforge_login_user:'alice@pve',accessforge_last_login:1793286000,
    accessforge_last_login_end:{timestamp:1793286090, estimated:true}};
  assert.match(context.vmLastLoginCell({uname:'alice',instStatus:status}, 'lab'), /data-accessforge-account="alice@pve".*datetime=/);
  assert.match(context.vmLastLoginCell({uname:'alice@pve',instStatus:status}), /Last browser check-in.*datetime=.* - <time datetime=/);
  assert.doesNotMatch(context.vmLastLoginCell({uname:'alice2',instStatus:status}), /datetime=/);
  assert.doesNotMatch(context.vmLastLoginCell({uname:'alice@pam',instStatus:status}), /datetime=/);
  const oldStatus = {proxmox_login_user:'alice@pve',proxmox_last_login:1793286000};
  assert.doesNotMatch(context.vmLastLoginCell({uname:'alice',instStatus:oldStatus}), /datetime=/);
});

for (const multi of [false, true]) {
  test(`Signed-in sorts the ${multi ? 'merged' : 'single-project'} table and updates when live status arrives`, async () => {
    const {api, context} = helper();
    const source = fs.readFileSync('app/static/js/vm_manager.js', 'utf8');
    const table = {innerHTML: '', querySelectorAll: () => [], querySelector: () => null};
    const names = ['missing', 'older', 'active', 'recent', 'legacy'];
    const starts = {older: 1793286020, recent: 1793286000, legacy: 1793286120};
    const ends = {older: 1793286090, recent: 1793286300};
    const status = names.map((name, i) => ({index: i + 1, accessforge_login_user: `${name}@pve`,
      accessforge_last_login: starts[name], accessforge_last_login_end: {timestamp: ends[name]}}));
    const project = {id: 'lab', instances: names.length, tag: '-', vms: [{name: 'vm'}, {name: 'db'}],
      credentials: names.map(username => ({username})), instance_statuses: status};
    const cells = names.map((name, i) => ({
      dataset: {accessforgeProject: 'lab', accessforgeAccount: `${name}@pve`,
        accessforgeSaved: api.isoTime(starts[name]), accessforgeSavedEnd: api.isoTime(ends[name])},
      classList: {toggle() {}},
    }));
    context.document.getElementById = id => id === 'vm-table' ? table : null;
    context.document.querySelectorAll = () => cells;
    context.window.__MERGED_ROWS__ = names.flatMap((uname, i) => project.vms.map(({name}) => ({
      pid: 'lab', index: i + 1, vmName: `${name}-${i + 1}`, uname, instStatus: status[i],
    })));
    const noop = () => {};
    Object.assign(context, {
      LoginTime: api, PROJ: project, VM_COLS: {last_login: true, cred: true}, SORT_STATE: {key: 'index', dir: 'asc'},
      FILTER_TEXT: '', FILTER_SELECTED_ONLY: false, SELECTED_ROWS: new Set(), SHOW_PASSWORDS: false, escHtml: String,
      vmIsMulti: () => multi, updateVmSelectionCount: noop, vmEnsureScrollPersistence: noop,
      vmRowTags: () => ({matches: () => true, badges: () => ''}), _coerceEnabled: (_, fallback) => fallback,
      renderVmStateBadges: noop, resolveValidationConfiguredFlag: () => false, vmAgentStatusControl: noop, vmCheckoutIcon: noop,
    });
    for (const [start, end] of [
      ['function vmRenderCurrentTable(', 'function vmInitRowTags('],
      ['function ariaSort(', '// Map raw Proxmox'],
      ['function vmSignInData(', '// Sidebar: create a new project'],
      ['function renderVmTable(', 'function badgeForStatus('],
    ]) {
      vm.runInContext(source.slice(source.indexOf(start), source.indexOf(end)), context);
    }
    let finishLookup;
    context.fetch = () => new Promise(resolve => { finishLookup = resolve; });
    const renderedIndices = () => [...table.innerHTML.matchAll(/data-key="lab\|(\d+)\|/g)].map(match => Number(match[1]));
    context.vmSortBy('last_login');
    assert.match(table.innerHTML, /aria-sort="descending".*<button id="vm-sign-in-sort"/);
    assert.deepEqual(renderedIndices(), [4, 4, 2, 2, 1, 1, 3, 3, 5, 5]);
    finishLookup({ok: true, json: async () => ({
      latest: {'older@pve': starts.older, 'recent@pve': starts.recent, 'legacy@pve': starts.legacy},
      ends: {'older@pve': {timestamp: ends.older}, 'recent@pve': {timestamp: ends.recent + 60}},
      active: ['active@pve'], observed_at: 1793287000,
    })});
    await new Promise(setImmediate);
    assert.deepEqual(renderedIndices(), [3, 3, 4, 4, 2, 2, 1, 1, 5, 5]);
    assert.equal((table.innerHTML.match(/rowspan="2"/g) || []).length, 5);
    context.vmSortBy('last_login');
    assert.match(table.innerHTML, /aria-sort="ascending"/);
    assert.deepEqual(renderedIndices(), [3, 3, 2, 2, 4, 4, 1, 1, 5, 5]);
  });
}

test('a server missing the sign-in API shows an upgrade cue', async () => {
  const {context, listeners} = helper();
  const cell = {dataset: {accessforgeProject: 'lab', accessforgeAccount: 'alice@pve'}, classList: {toggle() {}}};
  context.document.querySelectorAll = () => [cell];
  context.fetch = async () => ({ok: false, status: 501, json: async () => ({error: 'Update AccessForge and restart.'})});
  listeners.get('DOMContentLoaded')();
  await new Promise(setImmediate);
  assert.equal(cell.textContent, 'Update AccessForge');
  assert.match(cell.title, /restart/);
});

test('manual refresh retries immediately with the Proxmox login and ignores an older lookup', async () => {
  const {api, context, listeners} = helper();
  const cell = {dataset: {accessforgeProject: 'lab', accessforgeAccount: 'alice@pve'}, classList: {toggle() {}}};
  context.document.querySelectorAll = () => [cell, cell];
  context.hydrateProxCredsFromPersisted = async () => ({username: 'teacher', password: 'example-password'});
  const requests = [];
  context.fetch = (url, options) => new Promise(resolve => requests.push({options, resolve}));
  listeners.get('DOMContentLoaded')();
  await new Promise(setImmediate);
  api.refresh();
  await new Promise(setImmediate);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].options.signal.aborted, true);
  assert.equal(requests[1].options.method, 'POST');
  assert.deepEqual(JSON.parse(requests[1].options.body), {username: 'teacher', password: 'example-password'});
  requests[1].resolve({ok: true, json: async () => ({latest: {}, active: ['alice@pve']})});
  requests[0].resolve({ok: false, status: 409, json: async () => ({error: 'Old error'})});
  await new Promise(setImmediate);
  assert.equal(cell.textContent, 'Active');
});

test('VM refresh can send the existing browser-session AccessForge connection', async () => {
  const connection = {url: 'https://accessforge.example', username: 'root@pam', password: 'test-password'};
  const context = {
    AUTH: {me: async () => ({user: {username: 'instructor'}})},
    canonicalPid: pid => pid,
    sessionStorage: {getItem(key) {
      return key === 'toolhub.accessforge.session.instructor.lab' ? JSON.stringify(connection) : null;
    }},
  };
  vm.runInNewContext(fs.readFileSync('app/static/js/vm_clipboard.js', 'utf8'), context);
  const headers = await context.vmAccessForgeConnectionHeaders('lab');
  assert.deepEqual(JSON.parse(decodeURIComponent(headers['X-AccessForge-Connection'])), connection);
  assert.equal(Object.keys(await context.vmAccessForgeConnectionHeaders('other')).length, 0);
});
