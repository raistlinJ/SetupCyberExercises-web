const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function manager(storage = new Map(), user = 'admin') {
  const elements = new Map();
  const el = id => {
    if (!elements.has(id)) elements.set(id, {value: '', checked: false, disabled: false, textContent: '',
      classList: {add() {}, remove() {}, toggle() {}}, setAttribute() {}});
    return elements.get(id);
  };
  let pid = 'one', saved = {username: 'saved-admin', password: 'saved-password', saved: true};
  let loginFails = false, shown = 0, secretsReply;
  const calls = [];
  const projects = [{id: 'one', name: 'Quest', ctfrpg_url: 'https://quest.test'},
    {id: 'two', name: 'Other', ctfrpg_url: 'https://other.test'}];
  const context = {
    document: {getElementById: el, addEventListener() {}},
    RowTags: {create: () => ({})}, AUTH: {getUser: () => ({username: user})},
    shell: {getCurrentProjectId: () => pid},
    sessionStorage: {getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key)},
    bootstrap: {Modal: {getOrCreateInstance: () => ({show() {shown++;}, hide() {}})}},
    fetch: async (path, options) => {
      const body = options.body ? JSON.parse(options.body) : {};
      calls.push({path, method: options.method, body});
      if (path.endsWith('/secrets') && !options.method) {
        if (secretsReply) await secretsReply;
        return {ok: true, json: async () => ({ctfrpg: saved})};
      }
      if (path.endsWith('/login') && loginFails) return {ok: false, json: async () => ({error: 'Invalid credentials'})};
      if (path.endsWith('/secrets')) saved = {...body.ctfrpg, saved: !!body.ctfrpg.password};
      const result = path.endsWith('/login') ? {user: {username: body.username}, characters: []}
        : path.endsWith('/secrets') ? {ok: true} : {...projects.find(p => path.endsWith(p.id)), ...body};
      return {ok: true, json: async () => result};
    }, console,
  };
  context.window = context;
  const source = fs.readFileSync('app/static/js/ctfrpg_manager.js', 'utf8').replace(/\}\)\(\);\s*$/, `
    renderCharacters = () => {};
    refresh = async () => {};
    window.manager = {state, api, openConnection, saveConnection, testConnection, readSessionCredentials};
  })();`);
  vm.runInNewContext(source, context);
  Object.assign(context.manager.state, {projects});
  return {m: context.manager, el, calls, projects, storage, shown: () => shown,
    select: id => {pid = id;}, failLogin: () => {loginFails = true;},
    deferSecrets: () => {let release; secretsReply = new Promise(resolve => {release = resolve;}); return release;},
    saved: () => saved, setSaved: value => {saved = value;}};
}

test('saved credentials restore the persistence toggle and survive a new page instance', async () => {
  const h = manager();
  await h.m.openConnection();
  assert.equal(h.shown(), 1);
  assert.equal(h.el('save-credentials').checked, true);
  assert.equal(h.el('game-username').value, 'saved-admin');
  h.el('game-password').value = 'new-password';
  await h.m.saveConnection();
  assert.equal(h.saved().password, 'new-password');
  assert.equal(h.storage.size, 0);
  const reloaded = manager();
  reloaded.setSaved(h.saved());
  await reloaded.m.openConnection();
  assert.equal(reloaded.el('save-credentials').checked, true);
  assert.equal(reloaded.el('game-password').value, 'new-password');
});

test('turning persistence off clears server secrets and session credentials authenticate all operations after reload', async () => {
  const h = manager();
  await h.m.openConnection();
  h.el('save-credentials').checked = false;
  await h.m.saveConnection();
  assert.equal(h.saved().password, '');
  const reloaded = manager(h.storage);
  reloaded.setSaved(h.saved());
  await reloaded.m.openConnection();
  assert.equal(reloaded.el('save-credentials').checked, false);
  assert.equal(reloaded.el('game-password').value, 'saved-password');
  for (const action of ['login', 'users_check', 'users_create', 'users_delete']) {
    await reloaded.m.api(`/api/projects/one/ctfrpg/${action}`, {method: 'POST', body: JSON.stringify({only: ['alice']})});
    const request = reloaded.calls.at(-1);
    assert.equal(request.body.password, 'saved-password');
    assert.deepEqual(request.body.only, ['alice']);
  }
  await reloaded.m.api('/api/projects/two/ctfrpg/login', {method: 'POST', body: '{}'});
  assert.equal(reloaded.calls.at(-1).body.password, undefined);
  const otherUser = manager(h.storage, 'someone-else');
  await otherUser.m.api('/api/projects/one/ctfrpg/login', {method: 'POST', body: '{}'});
  assert.equal(otherUser.calls.at(-1).body.password, undefined);
  reloaded.projects[0].ctfrpg_url = 'https://changed.test';
  assert.equal(reloaded.m.readSessionCredentials(reloaded.projects[0]), null);
});

test('failed login does not persist credentials or change the project', async () => {
  const h = manager();
  await h.m.openConnection();
  h.failLogin();
  await h.m.saveConnection();
  assert.equal(h.calls.filter(call => call.method === 'PATCH').length, 0);
  assert.equal(h.storage.size, 0);
  assert.match(h.el('connection-status').textContent, /Invalid credentials/);
});

test('a late secrets response cannot populate another project or overwrite typed credentials', async () => {
  const h = manager();
  const release = h.deferSecrets();
  const opening = h.m.openConnection();
  assert.equal(h.shown(), 1);
  assert.equal(h.el('save-connection').disabled, true);
  h.el('game-username').value = 'typed';
  release();
  await opening;
  assert.equal(h.el('game-username').value, 'typed');
  const releaseAgain = h.deferSecrets();
  const openingAgain = h.m.openConnection();
  h.select('two');
  releaseAgain();
  await openingAgain;
  assert.equal(h.el('game-password').value, '');
  await h.m.saveConnection();
  assert.equal(h.calls.filter(call => call.method === 'PATCH').length, 0);
});
