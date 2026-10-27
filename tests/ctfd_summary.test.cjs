const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');

function manager() {
  const events = [];
  const elements = new Map();
  const handlers = new Map();
  const listen = (target, type, fn, options) => {
    if (!handlers.has(target)) handlers.set(target, new Map());
    const types = handlers.get(target);
    if (!types.has(type)) types.set(type, []);
    types.get(type).push({ fn, once: options?.once });
  };
  const emit = (id, phase) => {
    const target = elements.get(id);
    const type = `${phase}.bs.modal`;
    for (const current of [target, document]) {
      const list = handlers.get(current)?.get(type) || [];
      for (const item of [...list]) {
        if (item.once) list.splice(list.indexOf(item), 1);
        item.fn({ target });
      }
    }
  };
  for (const id of ['actionProgressModal', 'actionSummaryModal', 'action-summary-title', 'action-summary-body']) {
    const classes = new Set();
    const el = { id, classList: { contains: value => classes.has(value), add: value => classes.add(value) } };
    el.addEventListener = (type, fn, options) => listen(el, type, fn, options);
    elements.set(id, el);
  }
  const document = {
    addEventListener(type, fn, options) { listen(document, type, fn, options); },
    getElementById: id => elements.get(id) || null,
    querySelector: () => null, querySelectorAll: () => [],
    body: { classList: { remove() { events.push('cleanup'); } }, style: { removeProperty() {} } },
  };
  const modal = {
    hide() { events.push('hide-progress'); emit('actionProgressModal', 'hide'); },
    show() { events.push('show-summary'); },
  };
  const c = {
    document, console, URL, queueMicrotask, setTimeout, clearTimeout, setInterval, clearInterval,
    location: { href: 'http://localhost/static/ctfd_manager.html', protocol: 'http:' },
    addEventListener() {}, sessionStorage: { getItem: () => null }, localStorage: { getItem: () => null },
    bootstrap: { Modal: { getInstance: () => modal, getOrCreateInstance: () => modal } },
    shell: { getCurrentProjectId: () => 'one' },
  };
  c.window = c;
  vm.createContext(c);
  vm.runInContext(fs.readFileSync('app/static/js/ctfd_manager.js', 'utf8'), c);
  return { c, events, elements, emit };
}

test('results wait for progress to finish closing and its cleanup to run', async () => {
  const m = manager();
  m.emit('actionProgressModal', 'show');
  m.emit('actionProgressModal', 'shown');
  m.c.showActionSummary('Created users', '<p>Created: 2</p>');
  assert.deepEqual(m.events, ['hide-progress']);
  m.emit('actionProgressModal', 'hidden');
  assert.deepEqual(m.events, ['hide-progress', 'cleanup']);
  await Promise.resolve();
  assert.deepEqual(m.events, ['hide-progress', 'cleanup', 'show-summary']);
  assert.equal(m.elements.get('action-summary-body').innerHTML, '<p>Created: 2</p>');
});

test('a fast action waits for the progress opening animation before hiding it', async () => {
  const m = manager();
  m.emit('actionProgressModal', 'show');
  m.c.showActionSummary('Done', 'Results');
  await Promise.resolve();
  assert.deepEqual(m.events, []);
  m.emit('actionProgressModal', 'shown');
  assert.deepEqual(m.events, ['hide-progress']);
  m.emit('actionProgressModal', 'hidden');
  await Promise.resolve();
  assert.equal(m.events.at(-1), 'show-summary');
});

test('results open when the progress modal was never opened', async () => {
  const m = manager();
  m.c.showActionSummary('Done', 'Results');
  await Promise.resolve();
  assert.deepEqual(m.events, ['show-summary']);
});

for (const kind of ['users_create', 'users_delete']) {
  test(`${kind} shows results after the final refresh and progress cleanup`, async () => {
    const m = manager();
    vm.runInContext("PROJ = { id: 'one', name: 'One', credentials: [{ username: 'alice' }] }", m.c);
    m.c.ctfdEnsureLiveStateBeforeAction = async () => 'continue';
    m.c.hydrateCtfdCredsFromPersisted = async () => ({ username: 'admin', password: 'pw', validated: true });
    m.c.confirm = () => true;
    m.c.shell = { ...m.c.shell, beginActionContext() {}, endActionContext() {}, logSuccess() {} };
    m.c.showActionProgress = () => {};
    m.c.updateActionProgress = () => {};
    m.c.hideActionProgress = () => m.events.push('finish-progress');
    m.c.ctfdHideProgress = () => {};
    m.c.runQueued = async (_label, fn) => fn();
    let finishCreation;
    m.c.http = () => new Promise(resolve => {
      finishCreation = () => resolve({ created: 1, deleted: 1, results: [{ username: 'alice', action: 'created' }] });
    });
    let finishRefresh;
    m.c.ctfdCheckExistence = () => new Promise(resolve => { finishRefresh = resolve; });
    m.c.renderCtfdTable = () => m.events.push('refresh-finished');
    const action = m.c.ctfdAction(kind);
    await new Promise(setImmediate);
    assert.ok(finishCreation);
    assert.equal(finishRefresh, undefined, 'The check must wait for the user operation response');
    finishCreation();
    await new Promise(setImmediate);
    assert.ok(finishRefresh);
    assert.deepEqual(m.events, []);
    finishRefresh();
    await action;
    assert.deepEqual(m.events, ['refresh-finished', 'finish-progress', 'show-summary']);
    assert.match(m.elements.get('action-summary-body').innerHTML, /alice/);
  });
}

for (const refreshFails of [false, true]) {
  test(`bulk results survive final refresh${refreshFails ? ' failure' : ''}`, async () => {
    const m = manager();
    vm.runInContext(fs.readFileSync('app/static/js/server_workflows.js', 'utf8'), m.c);
    vm.runInContext("CTFD_ALL_PROJECTS = [{ id: 'one', name: 'One' }, { id: 'two', name: 'Two' }]", m.c);
    m.c.hydrateCtfdCredsFromPersisted = async () => ({ username: 'admin', password: 'pw' });
    m.c.escHtml = value => String(value);
    m.c.ServerQueue = {
      submit: async () => ({ id: 1 }), wait: async () => ({ status: 'completed' }),
      nativeFetch: async () => ({ json: async () => ({ results: [{ created: 1 }, { created: 2 }] }) }),
    };
    let finishRefresh;
    m.c.ctfdRefreshMulti = () => new Promise((resolve, reject) => {
      finishRefresh = () => {
        m.events.push('refresh-finished');
        if (refreshFails) reject(new Error('Refresh unavailable'));
        else resolve();
      };
    });
    m.c.hideActionProgress = () => m.events.push('finish-progress');
    const action = m.c.submitServerCtfdBulk('users_create', ['one', 'two']);
    await new Promise(setImmediate);
    assert.ok(finishRefresh);
    assert.deepEqual(m.events, []);
    finishRefresh();
    await action;
    assert.deepEqual(m.events, ['refresh-finished', 'finish-progress', 'show-summary']);
    const body = m.elements.get('action-summary-body').innerHTML;
    assert.match(body, /One/);
    assert.match(body, /Two/);
    assert.match(body, /Created: <strong>2/);
    if (refreshFails) assert.match(body, /Refresh unavailable/);
  });
}

test('a partial refresh started before creation cannot overwrite the post-create snapshot', async () => {
  const m = manager();
  const project = { id: 'one', name: 'One', credentials: [{ username: 'alice' }, { username: 'bob' }] };
  m.c.project = project;
  vm.runInContext('PROJ = project; CTFD_ALLOW_LOAD = true', m.c);
  m.c.shell.logDebug = () => {};
  m.c.shell.logInfo = () => {};
  m.c.readCtfdCreds = () => ({ username: 'admin', password: 'pw', validated: true });
  m.c.hydrateCtfdCredsFromPersisted = async () => m.c.readCtfdCreds();
  m.c.runQueued = async (_label, fn) => fn();
  m.c.ctfdSyncProgress = () => {};
  m.c.ctfdHideSyncedProgress = () => {};
  m.c.updateCtfdControlsEnabled = () => {};
  m.c.renderCtfdTable = () => {};
  m.c.ctfdLoadSettings = async () => {};
  const applied = [];
  m.c.ctfdPersistLiveProjectMeta = () => {};
  m.c.ctfdApplyUserMeta = (_pid, users) => applied.push(users);
  let oldResponse;
  let checks = 0;
  m.c.http = async (method, url) => {
    if (method === 'GET') return { projects: [project] };
    checks++;
    if (checks === 1) return new Promise(resolve => { oldResponse = resolve; });
    return { users: [{ username: 'alice', exists: true }, { username: 'bob', exists: true }] };
  };
  const oldRefresh = m.c.ctfdLoadProjectById('one');
  await new Promise(setImmediate);
  assert.ok(oldResponse);
  assert.equal(m.c.ctfdBeginUserAction(), true);
  await m.c.ctfdCheckExistence(project);
  oldResponse({ users: [{ username: 'alice', exists: true }, { username: 'bob', exists: false }] });
  await oldRefresh;
  m.c.ctfdEndUserAction();
  assert.equal(applied.length, 1);
  assert.equal(applied[0].bob.exists, true);
  assert.equal(checks, 2);
});

for (const status of [429, 502, undefined]) {
  test(`a failed bulk refresh (${status || 'network'}) does not multiply requests per user`, async () => {
    const m = manager();
    const project = { id: 'one', name: 'One', credentials: [{ username: 'alice' }, { username: 'bob' }] };
    m.c.project = project;
    vm.runInContext('PROJ = project; CTFD_ALLOW_LOAD = true', m.c);
    m.c.shell.logDebug = () => {};
    m.c.shell.logInfo = () => {};
    m.c.readCtfdCreds = () => ({ username: 'admin', password: 'pw', validated: true });
    m.c.hydrateCtfdCredsFromPersisted = async () => m.c.readCtfdCreds();
    m.c.runQueued = async (_label, fn) => fn();
    m.c.ctfdSyncProgress = () => {};
    m.c.ctfdHideSyncedProgress = () => {};
    m.c.updateCtfdControlsEnabled = () => {};
    m.c.renderCtfdTable = () => {};
    let checks = 0;
    m.c.http = async method => {
      if (method === 'GET') return { projects: [project] };
      checks++;
      throw Object.assign(new Error('upstream unavailable'), { status });
    };
    await m.c.ctfdLoadProjectById('one');
    assert.equal(checks, 1);
  });
}

test('user mutations pause auto-refresh and block manual or background refreshes until finished', async () => {
  const m = manager();
  const auto = [];
  m.c.CTFD_AUTO_CTRL = { pause: reason => auto.push(`pause:${reason}`), resume: reason => auto.push(`resume:${reason}`) };
  m.c.updateCtfdControlsEnabled = () => {};
  let requests = 0;
  m.c.http = async () => { requests++; };
  vm.runInContext("CTFD_ALLOW_LOAD = true; CTFD_SELECTED_PIDS = ['one', 'two']", m.c);
  assert.equal(m.c.ctfdBeginUserAction(), true);
  assert.equal(m.c.ctfdBeginUserAction(), false, 'A second mutation cannot start');
  await m.c.ctfdRefresh();
  await m.c.ctfdLoadProjectById('one');
  await m.c.ctfdRefreshMulti();
  assert.equal(requests, 0);
  m.c.ctfdEndUserAction();
  assert.deepEqual(auto, ['pause:users-action', 'resume:users-action']);
});

test('an existence check from an old project cannot update the current project', async () => {
  const m = manager();
  m.c.readCtfdCreds = () => ({ username: 'admin', password: 'pw', validated: true });
  let release;
  m.c.http = () => new Promise(resolve => { release = resolve; });
  let applied = false;
  m.c.ctfdPersistLiveProjectMeta = () => { applied = true; };
  m.c.ctfdApplyUserMeta = () => { applied = true; };
  const check = m.c.ctfdCheckExistence({ id: 'one' });
  m.c.shell.getCurrentProjectId = () => 'two';
  vm.runInContext("PROJ = { id: 'two' }", m.c);
  release({ users: [{ username: 'alice', exists: true }] });
  await check;
  assert.equal(applied, false);
});
