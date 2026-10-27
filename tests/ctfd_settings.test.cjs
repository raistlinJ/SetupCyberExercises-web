const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');

function manager() {
  let pid = 'one';
  const elements = new Map();
  for (const id of ['ctfd-toggle-chals', 'ctfd-toggle-scoreboard', 'ctfd-toggle-paused', 'ctfd-toggle-clear-submissions', 'ctfd-settings-status']) {
    const wrapper = { setAttribute() {} };
    elements.set(id, { checked: false, disabled: true, dataset: {}, closest: () => wrapper, removeAttribute() {} });
  }
  const storage = { getItem: () => null, setItem() {} };
  const c = {
    document: { addEventListener() {}, getElementById: id => elements.get(id) || null, querySelectorAll: () => [] },
    location: { href: 'http://localhost/static/ctfd_manager.html' }, URL,
    sessionStorage: storage, localStorage: storage, addEventListener() {},
    shell: { getCurrentProjectId: () => pid, logWarn() {}, logError() {} },
    setTimeout() {}, clearTimeout() {}, setInterval() {}, clearInterval() {},
    bootstrap: null,
  };
  c.window = c;
  vm.createContext(c);
  vm.runInContext(fs.readFileSync('app/static/js/ctfd_manager.js', 'utf8'), c);
  vm.runInContext("PROJ = { id: 'one', name: 'One', challenge_url: 'https://one.test', challenge_port: 8443 }", c);
  c.readCtfdCreds = () => ({ username: 'admin', password: 'pw', validated: true });
  c.hydrateCtfdCredsFromPersisted = async () => c.readCtfdCreds();
  c.runQueued = async (_label, fn) => fn();
  c.ctfdHandleChallengesStateChange = () => {};
  return { c, elements, toggle: elements.get('ctfd-toggle-clear-submissions'), select: value => { pid = value; } };
}

const settings = (enabled, supported = true) => ({ ok: true,
  settings: { users_can_clear_submissions: enabled }, capabilities: { solve_retraction: supported },
});

test('the toggle stays disabled until the server advertises support', async () => {
  const m = manager();
  m.c.updateCtfdControlsEnabled();
  assert.equal(m.toggle.disabled, true);
  m.c.http = async () => settings(false, false);
  await m.c.ctfdLoadSettings();
  assert.equal(m.toggle.disabled, true);
  m.c.http = async () => settings(true);
  await m.c.ctfdLoadSettings();
  assert.equal(m.toggle.checked, true);
  assert.equal(m.toggle.disabled, false);
});

test('enabling or disabling sends the focused project setting and uses the server readback', async () => {
  const m = manager();
  m.c.ctfdEnsureLiveStateBeforeAction = () => { throw new Error('This setting does not require leaderboard preflight'); };
  for (const enabled of [true, false]) {
    m.c.http = async (method, url, body) => {
      assert.equal(method, 'POST');
      assert.equal(url, '/api/projects/one/ctfd/settings/update');
      assert.equal(body.users_can_clear_submissions, enabled);
      assert.equal(body.port, 8443);
      return settings(enabled);
    };
    await m.c.ctfdUpdateSettings({ users_can_clear_submissions: enabled });
    assert.equal(m.toggle.checked, enabled);
    assert.equal(m.toggle.disabled, false);
    assert.equal(m.elements.get('ctfd-settings-status').textContent, 'Applied');
  }
});

test('a delayed settings read cannot undo the toggle after an update', async () => {
  const m = manager();
  let release;
  m.c.http = async (_method, url) => url.endsWith('/update')
    ? settings(true) : new Promise(resolve => { release = resolve; });
  const oldRead = m.c.ctfdLoadSettings();
  await new Promise(setImmediate);
  await m.c.ctfdUpdateSettings({ users_can_clear_submissions: true });
  release(settings(false));
  await oldRead;
  assert.equal(m.toggle.checked, true);
});

test('switching projects while updating cannot change the new project controls', async () => {
  const m = manager();
  let release;
  m.c.http = () => new Promise(resolve => { release = resolve; });
  const updating = m.c.ctfdUpdateSettings({ users_can_clear_submissions: true });
  await new Promise(setImmediate);
  m.select('two');
  vm.runInContext("PROJ = { id: 'two' }", m.c);
  release(settings(true));
  await updating;
  assert.equal(m.toggle.checked, false);
  assert.equal(m.toggle.disabled, true);
});

test('failed settings writes reload the effective value and show the error', async () => {
  const m = manager();
  m.c.http = async (_method, url) => {
    if (url.endsWith('/update')) throw new Error('CTFd did not apply the setting');
    return settings(false);
  };
  m.toggle.checked = true;
  await m.c.ctfdUpdateSettings({ users_can_clear_submissions: true });
  assert.equal(m.toggle.checked, false);
  assert.match(m.elements.get('ctfd-settings-status').textContent, /Error: CTFd did not apply/);
});
