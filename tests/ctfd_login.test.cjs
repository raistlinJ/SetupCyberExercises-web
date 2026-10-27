const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync('app/static/js/ctfd_manager.js', 'utf8');

function manager() {
  const elements = new Map();
  const listeners = new Map();
  let pid = 'one';
  let shown = 0;
  const storage = () => {
    const values = new Map();
    return { getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, value) };
  };
  for (const id of ['btn-ctfd-login', 'ctfdLoginModal', 'btn-ctfd-save', 'ctfd-login-feedback',
    'ctfd-url', 'ctfd-port', 'ctfd-username', 'ctfd-password', 'ctfd-save-creds', 'ctfd-verify-ssl']) {
    elements.set(id, {
      value: '', checked: false, disabled: false, dataset: {}, textContent: '',
      addEventListener(event, fn) { this[event] = fn; },
      setAttribute() {}, removeAttribute() {},
    });
  }
  const c = {
    console,
    document: {
      addEventListener(event, fn) {
        if (!listeners.has(event)) listeners.set(event, []);
        listeners.get(event).push(fn);
      },
      getElementById: id => elements.get(id) || null,
      querySelectorAll: () => [], querySelector: () => null,
    },
    shell: { getCurrentProjectId: () => pid, initShell: () => new Promise(() => {}), logDebug() {} },
    sessionStorage: storage(), localStorage: storage(),
    location: { href: 'http://localhost/static/ctfd_manager.html', protocol: 'http:' },
    URL, addEventListener() {}, setTimeout, clearTimeout, setInterval, clearInterval,
    bootstrap: { Modal: { getOrCreateInstance: () => ({ show() { shown++; } }) } },
    CREDS: { fetchProjectSecrets: async () => {}, readPersistCtfdCreds: () => ({}) },
  };
  c.window = c;
  vm.createContext(c);
  vm.runInContext(source, c);
  return {
    c, elements, listeners, shown: () => shown, select: value => { pid = value; },
    project: value => { c.project = value; vm.runInContext('PROJ = project', c); },
  };
}

test('authentication is clickable while shell initialization is pending', async () => {
  const m = manager();
  m.project({ id: 'one', challenge_url: 'https://one.test' });
  m.listeners.get('DOMContentLoaded').find(fn => fn.toString().includes('shell.initShell'))();
  assert.equal(typeof m.elements.get('btn-ctfd-login').click, 'function');
  await m.elements.get('btn-ctfd-login').click({ preventDefault() {} });
  assert.equal(m.shown(), 1);
});

test('the dialog opens before saved secrets resolve and preserves typed credentials', async () => {
  const m = manager();
  m.project({ id: 'one', challenge_url: 'https://one.test', challenge_port: 8443, challenge_verify_ssl: false });
  let release;
  m.c.CREDS.fetchProjectSecrets = () => new Promise(resolve => { release = resolve; });
  const opening = m.c.openCtfdLoginModal();
  assert.equal(m.shown(), 1);
  assert.equal(m.elements.get('btn-ctfd-save').disabled, false);
  assert.equal(m.elements.get('ctfd-url').value, 'https://one.test');
  assert.equal(m.elements.get('ctfd-port').value, 8443);
  assert.equal(m.elements.get('ctfd-verify-ssl').checked, false);
  m.elements.get('ctfd-username').value = 'typed-admin';
  m.elements.get('ctfd-password').value = 'typed-password';
  m.c.CREDS.readPersistCtfdCreds = () => ({ username: 'saved-admin', password: 'saved-password' });
  release();
  await opening;
  assert.equal(m.elements.get('ctfd-username').value, 'typed-admin');
  assert.equal(m.elements.get('ctfd-password').value, 'typed-password');
});

test('project loading finishes before Save is enabled, without waiting for secrets', async () => {
  const m = manager();
  m.project({ id: 'old', challenge_url: 'https://old.test' });
  let load;
  m.c.ctfdLoadProjectConfig = async () => {
    await new Promise(resolve => { load = resolve; });
    m.project({ id: 'one', challenge_url: 'https://one.test' });
  };
  m.c.CREDS.fetchProjectSecrets = () => new Promise(() => {});
  m.c.openCtfdLoginModal();
  assert.equal(m.shown(), 1);
  assert.equal(m.elements.get('btn-ctfd-save').disabled, true);
  assert.equal(m.elements.get('ctfd-url').value, '');
  load();
  await new Promise(setImmediate);
  assert.equal(m.elements.get('btn-ctfd-save').disabled, false);
  assert.equal(m.elements.get('ctfd-url').value, 'https://one.test');
});

test('an old secrets response cannot fill a different project login', async () => {
  const m = manager();
  m.project({ id: 'one' });
  const pending = {};
  const saved = {};
  m.c.CREDS.fetchProjectSecrets = pid => new Promise(resolve => { pending[pid] = resolve; });
  m.c.CREDS.readPersistCtfdCreds = pid => saved[pid] || {};
  const first = m.c.openCtfdLoginModal();
  m.select('two');
  m.project({ id: 'two' });
  const second = m.c.openCtfdLoginModal();
  saved.one = { username: 'one', password: 'one' };
  pending.one();
  await first;
  assert.equal(m.elements.get('ctfd-username').value, '');
  saved.two = { username: 'two', password: 'two' };
  pending.two();
  await second;
  assert.equal(m.elements.get('ctfd-username').value, 'two');
});

test('missing project selection explains the next step and prevents Save', async () => {
  const m = manager();
  m.select('');
  await m.c.openCtfdLoginModal();
  assert.equal(m.shown(), 1);
  assert.equal(m.elements.get('btn-ctfd-save').disabled, true);
  assert.match(m.elements.get('ctfd-login-feedback').textContent, /Select a project/);
});

test('the login label distinguishes first authentication from re-authentication', () => {
  const m = manager();
  m.project({ id: 'one' });
  m.c.updateCtfdSelectionCount = () => {};
  m.c.updateCtfdControlsEnabled();
  assert.equal(m.elements.get('btn-ctfd-login').textContent, 'Authenticate to CTFd');
  m.c.writeCtfdCreds('one', { username: 'admin', password: 'password', validated: true });
  m.c.updateCtfdControlsEnabled();
  assert.equal(m.elements.get('btn-ctfd-login').textContent, 'Re-authenticate to CTFd');
});
