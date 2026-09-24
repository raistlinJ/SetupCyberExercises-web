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
