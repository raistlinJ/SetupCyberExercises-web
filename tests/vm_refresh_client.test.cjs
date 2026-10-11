const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const source = fs.readFileSync('app/static/js/vm_manager.js', 'utf8');
const refreshSource = source.slice(source.indexOf('async function refreshVmView(opts)'), source.indexOf('\nfunction renderMergedVmTable(rows)'));

test('failed multi-project refresh keeps saved containers visible and warns until recovery', async () => {
  const saved = { index: 1, vm_details: [{ name: 'container-1', type: 'lxc', state: 'running', vmid: 201 }] };
  const projects = ['one', 'two'].map(id => ({ id, name: id, instances: 1, tag: '-', vms: [{ name: 'container' }], instance_statuses: [saved] }));
  const note = { innerHTML: '' };
  let fail = true;
  let rows;
  const markedLive = [];
  const noop = () => {};
  const sandbox = {
    window: {}, document: { getElementById: () => note }, console: { log: noop, warn: noop, debug: noop }, performance,
    ALL_PROJECTS: projects, VM_MULTI_REFRESH_PROMISES: new Map(),
    ensureAllProjects: async () => {}, getActivePids: () => ['one', 'two'],
    canonicalPid: id => id, canonicalPidList: ids => ids, normalizeProjects: p => p,
    hydrateProxCredsFromPersisted: async () => ({ username: 'test', password: 'test' }),
    http: async (method, url) => {
      if (method === 'GET') return { projects };
      if (url.includes('/one/') && fail) throw new Error('LXC scan timed out <node>');
      return { instance_statuses: [{ index: 1, vm_details: [] }] };
    },
    queueRemoteAction: (label, work) => { queueMicrotask(work); return {}; },
    vmMarkLiveRefreshed: id => markedLive.push(id), vmApplyServerResources: noop,
    renderMergedVmTable: result => { rows = result; },
    _coerceEnabled: (value, fallback) => value == null ? fallback : !!value,
    escHtml: text => text.replace(/</g, '&lt;').replace(/>/g, '&gt;'),
    showVmInlineProgress: noop, updateVmInlineProgress: noop, hideVmInlineProgress: noop,
  };
  vm.createContext(sandbox);
  vm.runInContext(refreshSource, sandbox);
  await sandbox.refreshVmView({ showProgressDialog: false });
  assert.equal(rows.length, 2);
  assert.equal(rows.find(row => row.pid === 'one').detail.state, 'running');
  assert.equal(rows.find(row => row.pid === 'one').status, 'created');
  assert.equal(rows.find(row => row.pid === 'two').status, 'missing');
  assert.deepEqual(markedLive, ['two']);
  assert.match(note.innerHTML, /last saved inventory/);
  assert.match(note.innerHTML, /LXC scan timed out &lt;node&gt;/);
  fail = false;
  await sandbox.refreshVmView({ showProgressDialog: false });
  assert.equal(rows.find(row => row.pid === 'one').status, 'missing');
  assert.equal(note.innerHTML, '');
  assert(markedLive.includes('one'));
});

test('paused execution state overrides running power state in badges, sorting, and actions', () => {
  const sandbox = { escHtml: String };
  vm.createContext(sandbox);
  vm.runInContext(source.slice(source.indexOf('function mapProxmoxPowerState('), source.indexOf('function vmBuildFilterParts(')), sandbox);
  vm.runInContext(source.slice(source.indexOf('function _vmDetailIsRunning('), source.indexOf('function filterRunningTargetsForProject(')), sandbox);
  for (const state of ['paused', 'suspended']) {
    const detail = { power_state: 'running', qmp_state: state };
    assert.ok(sandbox.renderVmStateBadges(detail).includes(`>${state}<`));
    assert.equal(sandbox.vmStateSortWeight(detail), 2);
    assert.equal(sandbox._vmDetailIsRunning(detail), false);
  }
  const suspended = {power_state: 'stopped', qmp_state: 'stopped', suspended_to_disk: true, lock: 'suspended'};
  assert.match(sandbox.renderVmStateBadges(suspended), />suspended</);
  assert.equal(sandbox.vmStateSortWeight(suspended), 2);
  assert.equal(sandbox._vmDetailIsRunning(suspended), false);
  assert.equal(sandbox._vmDetailIsRunning({power_state: 'running', qmp_state: 'running'}), true);
});

const singleRefreshSource = source.slice(source.indexOf('async function vmRefresh(opts)'), source.indexOf('\nfunction _vmExpectedBridgeName'));

for (const switchDuringRefresh of [false, true]) {
  test(`post-unlock refresh stays scoped to original project (switch during request: ${switchDuringRefresh})`, async () => {
    const original = { id: 'one', name: 'One', proxmox_url: 'https://one', instance_statuses: ['locked'] };
    const other = { id: 'two', name: 'Two', instance_statuses: ['other inventory'] };
    const cached = { ...original };
    const rendered = [];
    const requests = [];
    const noop = () => {};
    const sandbox = {
      PROJ: switchDuringRefresh ? original : other,
      SELECTED_PIDS: ['two', 'three'], ALL_PROJECTS: [cached, other],
      window: { PROJ_CACHE: { one: { ...original } } },
      shell: {}, console: { log: noop, error: noop }, canonicalPid: String,
      runQueued: async (label, work, opts) => { assert.equal(opts.projectId, 'one'); await work(); },
      hydrateProxCredsFromPersisted: async pid => { assert.equal(pid, 'one'); return { username: 'operator', password: 'secret' }; },
      http: async (method, path, body) => {
        requests.push({ path, body });
        sandbox.PROJ = other;
        return { instance_statuses: ['unlocked'] };
      },
      vmApplyServerResources: noop, vmMarkLiveRefreshed: noop,
      showVmInlineProgress: noop, updateVmInlineProgress: noop, hideVmInlineProgress: noop,
      renderVmTable: p => rendered.push(p.id),
      alert: message => assert.fail(message),
    };
    vm.createContext(sandbox);
    vm.runInContext(singleRefreshSource, sandbox);
    await sandbox.vmRefresh({ project: original, forceRefresh: true, showProgressDialog: false });
    assert.equal(requests.length, 1);
    assert.equal(requests[0].path, '/api/projects/one/instances/refresh/vm');
    assert.equal(requests[0].body.forceRefresh, true);
    assert.equal(requests[0].body.baseUrl, 'https://one');
    assert.deepEqual(original.instance_statuses, ['unlocked']);
    assert.deepEqual(cached.instance_statuses, ['unlocked']);
    assert.deepEqual(sandbox.window.PROJ_CACHE.one.instance_statuses, ['unlocked']);
    assert.deepEqual(other.instance_statuses, ['other inventory']);
    assert.deepEqual(rendered, []);
  });
}

test('unlock completion schedules a forced refresh even after switching projects', async () => {
  const calls = [];
  const original = { id: 'one' };
  const start = source.indexOf('    // Always refresh after any action');
  const end = source.indexOf('\n  }\n}', start);
  const sandbox = { action: 'unlock', PROJ: original, Promise, window: {},
    isCurrentVmProject: () => false, vmRefresh: opts => calls.push(opts) };
  vm.createContext(sandbox);
  vm.runInContext(source.slice(start, end), sandbox);
  await Promise.resolve();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].project, original);
  assert.equal(calls[0].forceRefresh, true);
});

test('server inventory updates hidden project caches and merged rows without touching another project', () => {
  const one = { id: 'one', instance_statuses: ['locked'] };
  const two = { id: 'two', instance_statuses: ['untouched'] };
  const row = { pid: 'one', index: 1, vmName: 'alpha', detail: { lock: 'backup' } };
  const rendered = [];
  const sandbox = {
    PROJ: two, ALL_PROJECTS: [one, two], SELECTED_PIDS: [], canonicalPid: String,
    window: { PROJ_CACHE: { one: { ...one } }, __MERGED_ROWS__: [row] },
    vmApplyServerResources() {}, vmMarkLiveRefreshed() {},
    renderVmTable: () => assert.fail('other project must not render'),
    renderMergedVmTable: rows => rendered.push(rows),
  };
  vm.createContext(sandbox);
  vm.runInContext(source.slice(source.indexOf('function vmApplyQueuedInventory('), source.indexOf('async function vmRefresh(opts)')), sandbox);
  const result = { instance_statuses: [{ index: 1, vm_details: [{ name: 'alpha', lock: '' }] }] };
  sandbox.vmApplyQueuedInventory('one', result);
  assert.equal(one.instance_statuses, result.instance_statuses);
  assert.equal(sandbox.window.PROJ_CACHE.one.instance_statuses, result.instance_statuses);
  assert.deepEqual(two.instance_statuses, ['untouched']);
  sandbox.SELECTED_PIDS = ['one', 'two'];
  sandbox.vmApplyQueuedInventory('one', result);
  assert.equal(row.detail.lock, '');
  assert.equal(row.status, 'created');
  assert.equal(rendered.length, 1);
});

test('refresh modal disables empty selection and submits only active selected rows', async () => {
  const elements = Object.fromEntries(['vm-refresh-selected', 'vm-refresh-all', 'vm-refresh-screenshots', 'vmRefreshModal'].map(id => [id, {}]));
  let entries = [];
  let submitted;
  let shown = 0;
  let hidden = 0;
  const sandbox = {
    document: { getElementById: id => elements[id] },
    bootstrap: { Modal: { getOrCreateInstance: () => ({show: () => shown++}), getInstance: () => ({hide: () => hidden++}) } },
    listSelectedEntries: () => entries, getActivePids: () => ['one'], canonicalPid: String,
    window: {}, PROJ: {id: 'one'}, vmRefresh: async opts => { assert.equal(sandbox.window.__VM_REFRESH_VIEW_PENDING__, true); submitted = opts; },
  };
  vm.createContext(sandbox);
  vm.runInContext(source.slice(source.indexOf('function vmShowRefreshOptions()')), sandbox);
  sandbox.vmShowRefreshOptions();
  assert.equal(elements['vm-refresh-selected'].disabled, true);
  assert.equal(elements['vm-refresh-all'].checked, true);
  entries = [{pidCanonical:'one', index:1, name:'web-1'}, {pidCanonical:'other', index:1, name:'outside-1'}];
  sandbox.vmShowRefreshOptions();
  assert.equal(elements['vm-refresh-selected'].disabled, false);
  assert.equal(elements['vm-refresh-selected'].checked, true);
  elements['vm-refresh-screenshots'].checked = true;
  await sandbox.vmConfirmRefresh();
  assert.equal(submitted.targets.length, 1);
  assert.equal(submitted.targets[0].name, 'web-1');
  assert.equal(submitted.targetsByPid.other, undefined);
  assert.equal(submitted.updateScreenshots, true);
  assert.equal(shown, 2);
  assert.equal(hidden, 1);
  assert.equal(sandbox.window.__VM_REFRESH_VIEW_PENDING__, false);
});

test('selected-only filter disables text filtering and Clear restores the full view', () => {
  const elements = Object.fromEntries(['vm-filter', 'vm-filter-regex', 'vm-filter-selected', 'vm-selected-filter-notice', 'vm-filter-error'].map(id => [id, {classList:{toggle(){}, add(){}}}]));
  let rendered = 0;
  const sandbox = {document:{getElementById:id => elements[id]}, FILTER_TEXT:'old text', FILTER_SELECTED_ONLY:false,
    SELECTED_ROWS:new Set(['one|1|web']), vmIsMulti:()=>false, PROJ:{}, renderVmTable:()=>rendered++};
  vm.createContext(sandbox);
  vm.runInContext(source.slice(source.indexOf('function vmUpdateFilterControls()'), source.indexOf('async function refreshVmView(opts)')), sandbox);
  sandbox.vmSetSelectedFilter(true);
  assert.equal(elements['vm-filter'].disabled, true);
  assert.equal(elements['vm-filter-regex'].disabled, true);
  assert.equal(elements['vm-filter-selected'].checked, true);
  const rows = [{key:'one|1|web'}, {pid:'two', index:1, vmName:'web'}];
  assert.equal(sandbox.vmFilterSelectedRows(rows).length, 1);
  sandbox.SELECTED_ROWS.clear();
  assert.equal(sandbox.vmFilterSelectedRows(rows).length, 0);
  sandbox.vmClearFilter();
  assert.equal(sandbox.FILTER_SELECTED_ONLY, false);
  assert.equal(sandbox.FILTER_TEXT, '');
  assert.equal(elements['vm-filter'].disabled, false);
  assert.equal(elements['vm-filter-selected'].checked, false);
  assert.equal(rendered, 2);
});

test('saved screenshots are gray until captured by the latest refresh', () => {
  const sandbox = {escHtml: String};
  vm.createContext(sandbox);
  vm.runInContext(source.slice(source.indexOf('function vmHasScreenshot('), source.indexOf('function vmClearFilter()')), sandbox);
  vm.runInContext(source.slice(source.indexOf('function vmScreenshotCell('), source.indexOf('function vmShowRefreshOptions()')), sandbox);
  const detail = {screenshot:'data:image/jpeg;base64,YQ==', screenshot_stale:true};
  assert.match(sandbox.vmScreenshotCell(detail), /grayscale\(1\)/);
  assert.match(sandbox.vmScreenshotCell(detail), /not updated in the latest refresh/);
  assert.doesNotMatch(sandbox.vmScreenshotCell({...detail, screenshot_stale:false}), /grayscale/);
});


test('screenshot filter includes current and saved captures, excluding uncaptured VMs', () => {
  const sandbox = {document:{getElementById:()=>null}};
  vm.createContext(sandbox);
  vm.runInContext(source.slice(source.indexOf('function vmHasScreenshot('), source.indexOf('function vmClearFilter()')), sandbox);
  const rows = [
    {vmName:'current', detail:{screenshot:'data:image/jpeg;base64,YQ==', screenshot_stale:false}},
    {vmName:'saved', detail:{screenshot:'data:image/jpeg;base64,YQ==', screenshot_stale:true}},
    {vmName:'screenshot-named-guest', detail:{}},
    {vmName:'failed', detail:{screenshot_error:'Display capture unavailable'}},
    {vmName:'missing', detail:null},
  ];
  assert.deepEqual(Array.from(sandbox.vmFilterScreenshotRows(rows), row=>row.vmName), ['current','saved']);
});
