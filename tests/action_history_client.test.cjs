const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const source = fs.readFileSync('app/static/js/action_history.js', 'utf8');

function browser(fetch, options = {}) {
  class Element {
    constructor() { this.listeners = {}; this.dataset = {}; this.files = []; this.value = ''; this.children = []; this.disabled = false; }
    set value(value) { this._value = value; if (value === '') this.files = []; }
    get value() { return this._value; }
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
    dispatchEvent(event) { for (const fn of this.listeners[event.type] || []) fn(event); }
    async fire(type) { await Promise.all((this.listeners[type] || []).map(fn => fn({ type }))); }
    replaceChildren(...options) { this.children = options; this.value = ''; }
    append(option) { this.children.push(option); }
  }
  const ids = ['lxcPushModal', 'lxcPullModal', 'customCommandModal', 'lxc-push-history', 'lxc-pull-history',
    'custom-command-history', 'lxc-push-type-file', 'lxc-push-type-folder', 'lxc-push-files', 'lxc-push-folder',
    'lxc-push-destination', 'lxc-push-owner', 'lxc-push-permissions', 'lxc-push-advanced', 'lxc-push-history-help', 'lxc-pull-paths',
    'custom-command-input', 'custom-command-timeout'];
  const elements = Object.fromEntries(ids.map(id => [id, new Element()]));
  const callbacks = {};
  const window = { fetch: () => assert.fail('History must bypass queued fetch'), ServerQueue: { nativeFetch: fetch } };
  const sandbox = { window, document: { getElementById: id => elements[id], addEventListener: (type, fn) => { callbacks[type] = fn; } },
    Event: class { constructor(type) { this.type = type; } }, Option: class { constructor(text, value) { this.text = text; this.value = value; } } };
  if (options.canRestore !== false) sandbox.DataTransfer = class {
    constructor() { this.files = []; this.items = { add: file => this.files.push(file) }; }
  };
  // The transfer dialog clears its inactive picker on a file/folder mode change.
  for (const [type, other] of [['file', 'folder'], ['folder', 'files']]) {
    elements[`lxc-push-type-${type}`].addEventListener('change', () => {
      elements[`lxc-push-${other}`].value = '';
    });
  }
  vm.createContext(sandbox); vm.runInContext(source, sandbox); callbacks.DOMContentLoaded();
  return elements;
}
const json = items => new Response(JSON.stringify({ items }));
const entry = settings => ({ id: 1, settings });

test('custom history restores exact multiline commands and timeout without executing anything', async () => {
  const command = "printf '<script>literal</script>'\necho done";
  const calls = [];
  const elements = browser(async (url, options) => {
    calls.push([url, options]); return json([entry({ command, timeoutSeconds: 600 })]);
  });
  let edits = 0;
  elements['custom-command-input'].addEventListener('input', () => edits++);
  elements['custom-command-timeout'].addEventListener('input', () => edits++);
  await elements.customCommandModal.fire('show.bs.modal');
  const select = elements['custom-command-history'];
  assert.equal(select.disabled, false);
  assert.equal(select.children[1].title, command);
  select.value = '1'; await select.fire('change');
  assert.equal(elements['custom-command-input'].value, command);
  assert.equal(elements['custom-command-timeout'].value, 600);
  assert.equal(edits, 2);
  assert.equal(select.value, '', 'same entry can be recalled again after editing');
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], '/api/queue/history/custom');
  assert.equal(calls[0][1].cache, 'no-store');
  assert.equal(calls[0][1].method, undefined, 'only a GET, never command execution');
});

test('pull history restores multiple paths and literal wildcard patterns', async () => {
  const paths = '/var/log/*.log\n/home/agentic/exams/exam1';
  const elements = browser(async () => json([entry({ paths })]));
  await elements.lxcPullModal.fire('show.bs.modal');
  elements['lxc-pull-history'].value = '1'; await elements['lxc-pull-history'].fire('change');
  assert.equal(elements['lxc-pull-paths'].value, paths);
});

test('push history restores settings but requires selection when previous files are unavailable', async () => {
  const settings = { destination: '/data', selectionType: 'folder', ownerOnRemote: '1000', filePermissions: '0755', sourceNames: ['folder/a.txt'] };
  const elements = browser(async () => json([entry(settings)]));
  elements['lxc-push-files'].value = 'old-file'; elements['lxc-push-folder'].value = 'old-folder';
  await elements.lxcPushModal.fire('show.bs.modal');
  elements['lxc-push-history'].value = '1'; await elements['lxc-push-history'].fire('change');
  assert.equal(elements['lxc-push-type-folder'].checked, true);
  assert.equal(elements['lxc-push-destination'].value, '/data');
  assert.equal(elements['lxc-push-owner'].value, '1000');
  assert.equal(elements['lxc-push-permissions'].value, '0755');
  assert.equal(elements['lxc-push-advanced'].open, true);
  assert.equal(elements['lxc-push-files'].value, ''); assert.equal(elements['lxc-push-folder'].value, '');
  assert.match(elements['lxc-push-history-help'].textContent, /Choose the original files/);
});

test('push recall retains matching selected files without requiring DataTransfer support', async () => {
  const settings = { destination: '/data', selectionType: 'file', sourceNames: ['b.txt', 'a.txt'] };
  const elements = browser(async () => json([entry(settings)]), { canRestore: false });
  const files = [{ name: 'a.txt' }, { name: 'b.txt' }];
  elements['lxc-push-files'].files = files;
  elements['lxc-push-files'].value = 'C:\\fakepath\\a.txt';
  await elements.lxcPushModal.fire('show.bs.modal');
  elements['lxc-push-history'].value = '1'; await elements['lxc-push-history'].fire('change');
  assert.equal(elements['lxc-push-files'].files, files);
  assert.match(elements['lxc-push-history-help'].textContent, /selection is ready/);
});

test('push recall restores earlier File objects across different selections and mode changes', async () => {
  const first = { destination: '/first', selectionType: 'file', sourceNames: ['first.txt'] };
  const folder = { destination: '/second', selectionType: 'folder', sourceNames: ['bundle/sub/a.txt'] };
  const elements = browser(async () => json([entry(first), { id: 2, settings: folder }]));
  const original = { name: 'first.txt' };
  const nested = { name: 'a.txt', webkitRelativePath: 'bundle/sub/a.txt' };
  elements['lxc-push-files'].files = [original]; await elements['lxc-push-files'].fire('change');
  elements['lxc-push-files'].files = [{ name: 'different.txt' }];
  elements['lxc-push-folder'].files = [nested]; await elements['lxc-push-folder'].fire('change');
  await elements.lxcPushModal.fire('show.bs.modal');
  const select = elements['lxc-push-history'];
  select.value = '1'; await select.fire('change');
  assert.equal(elements['lxc-push-files'].files[0], original);
  assert.equal(elements['lxc-push-folder'].files.length, 0);
  select.value = '2'; await select.fire('change');
  assert.equal(elements['lxc-push-folder'].files[0], nested);
  assert.equal(elements['lxc-push-files'].files.length, 0);
  assert.equal(elements['lxc-push-destination'].value, '/second');
});

test('recall never reuses unrelated selections with the same leaf filename in another folder', async () => {
  const settings = { destination: '/data', selectionType: 'folder', sourceNames: ['right/a.txt'] };
  const elements = browser(async () => json([entry(settings)]));
  elements['lxc-push-folder'].files = [{ name: 'a.txt', webkitRelativePath: 'wrong/a.txt' }];
  await elements.lxcPushModal.fire('show.bs.modal');
  elements['lxc-push-history'].value = '1'; await elements['lxc-push-history'].fire('change');
  assert.equal(elements['lxc-push-folder'].files.length, 0);
  assert.match(elements['lxc-push-history-help'].textContent, /Choose the original files/);
});

test('only the last five selections remain available and a new page cannot recall old File objects', async () => {
  const settings = { destination: '/data', selectionType: 'file', sourceNames: ['0.txt'] };
  const fetch = async () => json([entry(settings)]);
  const elements = browser(fetch);
  for (let i = 0; i < 6; i++) {
    elements['lxc-push-files'].files = [{ name: `${i}.txt` }];
    await elements['lxc-push-files'].fire('change');
  }
  for (const page of [elements, browser(fetch)]) {
    await page.lxcPushModal.fire('show.bs.modal');
    page['lxc-push-history'].value = '1'; await page['lxc-push-history'].fire('change');
    assert.equal(page['lxc-push-files'].files.length, 0);
  }
});

test('history refreshes on every opening and handles empty and unavailable history', async () => {
  let calls = 0;
  const elements = browser(async () => ++calls === 1 ? json([]) : new Response('unavailable', { status: 503 }));
  await elements.lxcPullModal.fire('show.bs.modal');
  assert.equal(elements['lxc-pull-history'].disabled, true);
  assert.equal(elements['lxc-pull-history'].children[0].text, 'No recent runs');
  await elements.lxcPullModal.fire('show.bs.modal');
  assert.equal(elements['lxc-pull-history'].children[0].text, 'History unavailable');
  assert.equal(elements['lxc-pull-paths'].value, '', 'history errors never change the form');
});

test('late responses from an earlier opening cannot replace newer history', async () => {
  let complete, calls = 0;
  const old = new Promise(resolve => { complete = resolve; });
  const elements = browser(async () => ++calls === 1 ? old : json([entry({ paths: '/new' })]));
  const first = elements.lxcPullModal.fire('show.bs.modal');
  await elements.lxcPullModal.fire('show.bs.modal');
  complete(json([entry({ paths: '/old' })])); await first;
  assert.equal(elements['lxc-pull-history'].children[1].title, '/new');
});
