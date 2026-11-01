const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function helper() {
  const listeners = new Map();
  const document = {hidden: false, querySelectorAll: () => [], addEventListener: (type, fn) => listeners.set(type, fn)};
  let update;
  const context = {window: {}, document, setInterval(fn, interval) { assert.equal(interval, 60000); update = fn; }};
  vm.runInNewContext(fs.readFileSync('app/static/js/login_time.js', 'utf8'), context);
  return {api: context.window.LoginTime, context, listeners, tick: () => update()};
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
    assert.doesNotMatch(api.cell(value), /data-last-login=/);
  }
  assert.match(api.cell('2026-10-29T09:00:00-06:00'), /data-last-login="2026-10-29T15:00:00.000Z"/);
  assert.equal(api.timestamp(1793286000), api.timestamp(1793286000000));
});

test('elapsed login text updates each minute and on return to a visible tab', () => {
  const {api, context, listeners, tick} = helper();
  const value = new Date(Date.now() - 135 * 60000).toISOString();
  const cell = {dataset: {lastLogin: value}, textContent: ''};
  context.document.querySelectorAll = () => [cell];
  listeners.get('DOMContentLoaded')();
  tick();
  assert.equal(cell.textContent, api.format(value));
  cell.textContent = 'old';
  listeners.get('visibilitychange')();
  assert.equal(cell.textContent, api.format(value));
});

test('VM login cells use the exact credential account and ignore stale username assignments', () => {
  const {api} = helper();
  const source = fs.readFileSync('app/static/js/vm_manager.js', 'utf8');
  const context = {LoginTime: api};
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('function vmLastLoginCell('), source.indexOf('function renderMergedVmTable(')), context);
  const status = {proxmox_login_user:'alice@pve',proxmox_last_login:1793286000};
  assert.match(context.vmLastLoginCell({uname:'alice',instStatus:status}), /data-last-login/);
  assert.match(context.vmLastLoginCell({uname:'alice@pve',instStatus:status}), /data-last-login/);
  assert.doesNotMatch(context.vmLastLoginCell({uname:'alice2',instStatus:status}), /data-last-login/);
  assert.doesNotMatch(context.vmLastLoginCell({uname:'alice@pam',instStatus:status}), /data-last-login/);
});
