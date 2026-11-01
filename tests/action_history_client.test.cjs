const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const source = fs.readFileSync('app/static/js/action_history.js', 'utf8');

function browser(fetch, options = {}) {
  class Element {
    constructor() {
      this.listeners = {}; this.dataset = {}; this.files = []; this.value = ''; this.children = []; this.disabled = false;
      this.classList = { toggle: (name, hidden) => { this.hidden = hidden; } };
    }
    set value(value) { this._value = value; if (value === '') this.files = []; }
    get value() { return this._value; }
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
    dispatchEvent(event) { for (const fn of this.listeners[event.type] || []) fn(event); }
    async fire(type) { await Promise.all((this.listeners[type] || []).map(fn => fn({ type }))); }
    replaceChildren(...options) { this.children = options; this.value = ''; }
    append(option) { this.children.push(option); }
    setAttribute(name, value) { this[name] = value; }
  }
  const ids = ['lxcPushModal', 'lxcPullModal', 'customCommandModal', 'lxc-push-history', 'lxc-pull-history',
    'custom-command-history', 'lxc-push-type-file', 'lxc-push-type-folder', 'lxc-push-files', 'lxc-push-folder',
    'lxc-push-destination', 'lxc-push-owner', 'lxc-push-permissions', 'lxc-push-advanced', 'lxc-push-history-help', 'lxc-push-csv-mode', 'lxc-pull-paths',
    'custom-command-input', 'custom-command-timeout', 'custom-render-template-variables',
    'lxc-push-files-warning', 'lxc-push-folder-warning'];
  const elements = Object.fromEntries(ids.map(id => [id, new Element()]));
  elements['lxc-push-type-file'].checked = true;
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
      elements[`lxc-push-type-${type === 'file' ? 'folder' : 'file'}`].checked = false;
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
    calls.push([url, options]); return json([entry({ command, timeoutSeconds: 600, renderTemplateVariables: false })]);
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
  assert.equal(elements['custom-render-template-variables'].checked, false);
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
  elements['lxc-push-csv-mode'].checked = true;
  await elements.lxcPushModal.fire('show.bs.modal');
  elements['lxc-push-history'].value = '1'; await elements['lxc-push-history'].fire('change');
  assert.equal(elements['lxc-push-type-folder'].checked, true);
  assert.equal(elements['lxc-push-csv-mode'].checked, false);
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

test('recall preserves current files and their mode even when the saved run used a folder', async () => {
  const settings = { destination: '/recalled', selectionType: 'folder', sourceNames: ['old/a.txt'] };
  const elements = browser(async () => json([entry(settings)]), { canRestore: false });
  const files = [{ name: 'current.txt' }];
  elements['lxc-push-files'].files = files;
  await elements.lxcPushModal.fire('show.bs.modal');
  elements['lxc-push-history'].value = '1'; await elements['lxc-push-history'].fire('change');
  assert.equal(elements['lxc-push-files'].files, files);
  assert.equal(elements['lxc-push-type-file'].checked, true);
  assert.equal(elements['lxc-push-destination'].value, '/recalled');
});

test('recall keeps a changed file and gives its warning a hover description', async () => {
  const settings = { destination: '/data', selectionType: 'file', sourceNames: ['a.txt'] };
  const elements = browser(async () => json([{ ...entry(settings), executedAt: 1000 }]));
  const file = { name: 'a.txt', lastModified: 2000, slice(start, end) {
    assert.equal(start, 0); assert.equal(end, 1);
    return { arrayBuffer: async () => new ArrayBuffer(1) };
  } };
  elements['lxc-push-files'].files = [file];
  await elements.lxcPushModal.fire('show.bs.modal');
  elements['lxc-push-history'].value = '1'; await elements['lxc-push-history'].fire('change');
  assert.equal(elements['lxc-push-files'].files[0], file);
  const warning = elements['lxc-push-files-warning'];
  assert.equal(warning.hidden, false);
  assert.match(warning.title, /a.txt: changed since this run/);
  assert.equal(warning['aria-label'], warning.title);
  await elements['lxc-push-files'].fire('change');
  assert.equal(warning.hidden, true, 'choosing files clears the old recall warning');
});

test('recall retains unreadable snapshots with a warning and removes only confirmed missing files', async () => {
  const settings = { destination: '/data', selectionType: 'file', sourceNames: ['a.txt', 'b.txt'] };
  for (const failure of ['NotReadableError', 'NotFoundError']) {
    const elements = browser(async () => json([entry(settings)]));
    const changed = { name: 'a.txt', slice: () => ({ arrayBuffer: async () => {
      throw Object.assign(new Error('file changed'), { name: failure });
    } }) };
    const present = { name: 'b.txt', slice: () => ({ arrayBuffer: async () => new ArrayBuffer(1) }) };
    elements['lxc-push-files'].files = [changed, present];
    await elements.lxcPushModal.fire('show.bs.modal');
    elements['lxc-push-history'].value = '1'; await elements['lxc-push-history'].fire('change');
    const warning = elements['lxc-push-files-warning'];
    if (failure === 'NotReadableError') {
      assert.equal(elements['lxc-push-files'].files[0], changed);
      assert.equal(warning.hidden, false);
      assert.match(warning.title, /changed or is no longer readable.*Select it again/);
    } else {
      assert.deepEqual(Array.from(elements['lxc-push-files'].files), [present]);
      assert.equal(warning.hidden, true);
    }
  }
});

test('recall clears the selection only when all selected files are missing', async () => {
  const settings = { destination: '/data', sourceNames: ['gone.txt'] };
  const elements = browser(async () => json([entry(settings)]));
  elements['lxc-push-files'].files = [{ name: 'gone.txt', slice: () => ({ arrayBuffer: async () => {
    throw Object.assign(new Error('gone'), { name: 'NotFoundError' });
  } }) }];
  await elements.lxcPushModal.fire('show.bs.modal');
  elements['lxc-push-history'].value = '1'; await elements['lxc-push-history'].fire('change');
  assert.equal(elements['lxc-push-files'].files.length, 0);
  assert.match(elements['lxc-push-history-help'].textContent, /no longer exist/);
});

test('an old file read cannot remove a newer selection or show a stale warning', async () => {
  let finish;
  const pending = new Promise(resolve => { finish = resolve; });
  const elements = browser(async () => json([entry({ destination: '/data', sourceNames: ['old.txt'] })]));
  elements['lxc-push-files'].files = [{ name: 'old.txt', slice: () => ({ arrayBuffer: () => pending }) }];
  await elements.lxcPushModal.fire('show.bs.modal');
  elements['lxc-push-history'].value = '1';
  const recall = elements['lxc-push-history'].fire('change');
  const newFile = { name: 'new.txt' };
  elements['lxc-push-files'].files = [newFile]; await elements['lxc-push-files'].fire('change');
  finish(new ArrayBuffer(1)); await recall;
  assert.equal(elements['lxc-push-files'].files[0], newFile);
  assert.equal(elements['lxc-push-files-warning'].hidden, true);
});

test('push recall restores earlier File objects across different selections and mode changes', async () => {
  const first = { destination: '/first', selectionType: 'file', sourceNames: ['first.txt'] };
  const folder = { destination: '/second', selectionType: 'folder', sourceNames: ['bundle/sub/a.txt'] };
  const elements = browser(async () => json([entry(first), { id: 2, settings: folder }]));
  const original = { name: 'first.txt' };
  const nested = { name: 'a.txt', webkitRelativePath: 'bundle/sub/a.txt' };
  elements['lxc-push-files'].files = [original]; await elements['lxc-push-files'].fire('change');
  elements['lxc-push-files'].value = '';
  elements['lxc-push-folder'].files = [nested]; await elements['lxc-push-folder'].fire('change');
  elements['lxc-push-folder'].value = '';
  await elements.lxcPushModal.fire('show.bs.modal');
  const select = elements['lxc-push-history'];
  select.value = '1'; await select.fire('change');
  assert.equal(elements['lxc-push-files'].files[0], original);
  assert.equal(elements['lxc-push-folder'].files.length, 0);
  elements['lxc-push-files'].value = '';
  select.value = '2'; await select.fire('change');
  assert.equal(elements['lxc-push-folder'].files[0], nested);
  assert.equal(elements['lxc-push-files'].files.length, 0);
  assert.equal(elements['lxc-push-destination'].value, '/second');
});

test('recall keeps the current folder even when a history entry names another folder', async () => {
  const settings = { destination: '/data', selectionType: 'folder', sourceNames: ['right/a.txt'] };
  const elements = browser(async () => json([entry(settings)]));
  elements['lxc-push-folder'].files = [{ name: 'a.txt', webkitRelativePath: 'wrong/a.txt' }];
  await elements.lxcPushModal.fire('show.bs.modal');
  elements['lxc-push-history'].value = '1'; await elements['lxc-push-history'].fire('change');
  assert.equal(elements['lxc-push-folder'].files[0].webkitRelativePath, 'wrong/a.txt');
  assert.match(elements['lxc-push-history-help'].textContent, /selection is ready/);
});

test('the last ten selections remain available and a new page cannot recall old File objects', async () => {
  const settings = { destination: '/data', selectionType: 'file', sourceNames: ['0.txt'] };
  const fetch = async () => json([entry(settings)]);
  for (const count of [10, 11]) {
    const page = browser(fetch);
    for (let i = 0; i < count; i++) {
      page['lxc-push-files'].files = [{ name: `${i}.txt` }];
      await page['lxc-push-files'].fire('change');
    }
    page['lxc-push-files'].value = '';
    await page.lxcPushModal.fire('show.bs.modal');
    page['lxc-push-history'].value = '1'; await page['lxc-push-history'].fire('change');
    assert.equal(page['lxc-push-files'].files.length, count === 10 ? 1 : 0);
  }
  const fresh = browser(fetch);
  await fresh.lxcPushModal.fire('show.bs.modal');
  fresh['lxc-push-history'].value = '1'; await fresh['lxc-push-history'].fire('change');
  assert.equal(fresh['lxc-push-files'].files.length, 0);
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

test('each history dropdown offers all ten recent runs', async () => {
  const items = Array.from({ length: 12 }, (_, i) => ({ id: i + 1, settings: { paths: `/data/${i}` } }));
  const elements = browser(async () => json(items));
  for (const [modal, select] of [['lxcPushModal', 'lxc-push-history'], ['lxcPullModal', 'lxc-pull-history'],
    ['customCommandModal', 'custom-command-history']]) {
    await elements[modal].fire('show.bs.modal');
    assert.equal(elements[select].children.length, 11, 'placeholder and ten entries');
    assert.equal(elements[select].children[10].value, '10');
  }
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
