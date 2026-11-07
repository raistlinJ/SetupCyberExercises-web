const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const read = name => fs.readFileSync(`app/static/js/${name}.js`, 'utf8');

function harness(saved = new Map(), server = new Map()) {
  const elements = new Map();
  const session = new Map();
  const element = () => ({innerHTML: '', value: '', checked: false, dataset: {}, style: {},
    classList: {add() {}, remove() {}, toggle() {}}, querySelector: () => null, querySelectorAll: () => [],
    addEventListener() {}, setAttribute() {}, getAttribute: () => '', scrollTop: 0});
  const context = {
    document: {addEventListener() {}, dispatchEvent() {}, querySelectorAll: () => [], querySelector: () => null,
      getElementById(id) { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); }},
    fetch: async (url, options = {}) => {
      const match = url.match(/projects\/([^/]+)\/row-tags\/(.+)$/);
      const key = `${decodeURIComponent(match[1])}:${match[2]}`;
      const rows = structuredClone(server.get(key) || {});
      if (options.method === 'PATCH') {
        const body = JSON.parse(options.body);
        if (body.merge) {
          for (const [row, ids] of Object.entries(body.merge)) rows[row] = [...new Set([...(rows[row] || []), ...ids])].sort();
        } else for (const row of body.rows) {
          const ids = new Set(rows[row] || []);
          if (body.tag_id === null) ids.clear();
          else if (body.enabled) ids.add(body.tag_id);
          else ids.delete(body.tag_id);
          if (ids.size) rows[row] = [...ids].sort(); else delete rows[row];
        }
        server.set(key, rows);
      }
      return {ok: true, json: async () => ({row_tags: rows})};
    },
    localStorage: {getItem: key => saved.get(key) || null, setItem: (key, value) => saved.set(key, value)},
    sessionStorage: {getItem: key => session.get(key) || null, setItem: (key, value) => session.set(key, value)},
    location: {href: 'http://localhost/', protocol: 'http:'},
    addEventListener() {}, setTimeout() {}, setInterval() {}, clearTimeout() {}, clearInterval() {},
    CustomEvent: function() {}, console, URL, performance,
    shell: {getCurrentProjectId: () => 'one', logDebug() {}},
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(read('row_tags'), context);
  return {context, elements, saved, server, run: code => vm.runInContext(code, context)};
}

test('bulk tags persist on the server across clean browsers and support overlapping groups', async () => {
  const {context, server} = harness();
  const tags = context.RowTags.create('vm');
  await tags.assign(['one|1|web', 'one|2|web'], 1);
  await tags.assign(['one|2|web', 'two|1|web'], 5);
  await tags.assign(['one|2|web'], 5);
  tags.setFilter([5]);
  assert.equal(tags.matches('one|1|web'), false);
  assert.equal(tags.matches('one|2|web'), true);
  assert.equal(tags.matches('two|1|web'), true);
  tags.setFilter([1, 5]);
  assert.equal(tags.matches('one|1|web'), true);
  assert.equal(tags.matches('one|3|web'), false);
  assert.match(tags.badges('one|2|web'), /row-tag-blue/);
  assert.match(tags.badges('one|2|web'), /row-tag-rose/);
  const restored = harness(new Map(), server).context.RowTags.create('vm');
  await restored.loadProjects(['one', 'two']);
  assert.deepEqual(Array.from(restored.get('one|2|web')), [1, 5]);
  assert.equal(context.RowTags.create('ctfd').get('one|2|web').length, 0);
  await tags.assign(['one|2|web'], 1, false);
  assert.deepEqual(Array.from(tags.get('one|2|web')), [5]);
  await tags.assign(['one|2|web'], null);
  assert.equal(tags.get('one|2|web').length, 0);
  assert.deepEqual(Array.from(tags.get('two|1|web')), [5]);
  tags.clearFilter();
  assert.equal(tags.matches('one|3|web'), true);
});

test('browser assignments migrate once and merge with existing server tags', async () => {
  const saved = new Map([['toolhub.rowTags.v1.vm', JSON.stringify({'one|1|web': [1, 6, '2'], 'two|1|db': [3], invalid: [4]})]]);
  const server = new Map([['one:vm', {'1|web': [5]}]]);
  const {context} = harness(saved, server);
  const tags = context.RowTags.create('vm');
  assert.equal(await tags.loadProjects(['one']), true);
  assert.deepEqual(Array.from(tags.get('one|1|web')), [1, 5]);
  assert.deepEqual(JSON.parse(saved.get('toolhub.rowTags.v1.vm')), {'two|1|db': [3]});
  await tags.assign(['one|1|web'], null);
  const reopened = harness(saved, server).context.RowTags.create('vm');
  await reopened.loadProjects(['one']);
  assert.equal(reopened.get('one|1|web').length, 0); // Cleared tags cannot be reimported.
});

test('unavailable browser storage does not prevent durable assignments', async () => {
  const {context, server} = harness();
  context.localStorage.getItem = context.localStorage.setItem = () => { throw new Error('Storage blocked'); };
  const tags = context.RowTags.create('ctfrpg');
  await tags.assign(['["one","alice"]'], 3);
  assert.deepEqual(server.get('one:ctfrpg'), {alice: [3]});
});

test('failed saves retain the confirmed assignments and can be retried', async () => {
  const {context} = harness();
  const tags = context.RowTags.create('ctfd');
  await tags.assign(['one:1'], 2);
  const send = context.fetch;
  context.fetch = async () => ({ok: false, json: async () => ({error: 'Disk write failed'})});
  assert.equal(await tags.assign(['one:1'], 4), false);
  assert.deepEqual(Array.from(tags.get('one:1')), [2]);
  context.fetch = send;
  assert.equal(await tags.assign(['one:1'], 4), true);
  assert.deepEqual(Array.from(tags.get('one:1')), [2, 4]);
});

for (const multi of [false, true]) {
  test(`VM ${multi ? 'merged' : 'single'} renderer filters tagged rows without changing selection`, async () => {
    const {run, elements} = harness();
    run(read('vm_manager'));
    await run(`(async () => {
      PROJ = {id:'one', name:'First', instances:2, tag:'-', vms:[{name:'web'}], credentials:[]};
      ALL_PROJECTS = [PROJ]; SELECTED_PIDS = ${multi ? "['one','two']" : "['one']"};
      SELECTED_ROWS = new Set(['one|1|web-1','one|2|web-2']);
      await vmRowTags().assign(['one|2|web-2'], 2); vmRowTags().setFilter([2]);
      ${multi ? `renderMergedVmTable(window.__MERGED_ROWS__ = [
        {pid:'one', index:1, vmName:'web-1', project:'First'},
        {pid:'one', index:2, vmName:'web-2', project:'First'},
        {pid:'two', index:2, vmName:'web-2', project:'Second'},
      ]);` : 'renderVmTable(PROJ);'}
    })()`);
    const html = elements.get('vm-table').innerHTML;
    assert.match(html, /web-2/);
    assert.doesNotMatch(html, /web-1|Second/);
    assert.match(html, /row-tag-green/);
    assert.equal(run('SELECTED_ROWS.size'), 2);
    run('vmClearFilter()');
    assert.match(elements.get('vm-table').innerHTML, /web-1/);
  });

  test(`CTFd ${multi ? 'merged' : 'single'} renderer keeps tags scoped and intersects selected-only filter`, async () => {
    const {run, elements} = harness();
    run(read('ctfd_manager'));
    await run(`(async () => {
      PROJ = {id:'one',name:'First',instances:2,credentials:[{username:'alice'},{username:'bob'}]};
      CTFD_ALL_PROJECTS = [PROJ,{id:'two',name:'Second',instances:1,credentials:[{username:'alice'}]}];
      CTFD_SELECTED_PIDS = ${multi ? "['one','two']" : 'null'};
      CTFD_SELECTED_KEYS = new Set(['one:1']); CTFD_SELECTED_INDICES = new Set([1]);
      sessionStorage.setItem('toolhub.ctfd.mgr.selectedKeys.v1', '["one:1"]');
      await ctfdRowTags().assign(['one:1'], 4); ctfdRowTags().setFilter([4]);
      renderCtfdTable(PROJ);
    })()`);
    const html = elements.get('ctfd-table').innerHTML;
    assert.match(html, /alice/);
    assert.match(html, /row-tag-purple/);
    assert.doesNotMatch(html, /bob|Second/);
    run('CTFD_FILTER_SELECTED_ONLY=true; CTFD_FILTER_TEXT="bob"; renderCtfdTable(PROJ);');
    assert.match(elements.get('ctfd-table').innerHTML, /alice/);
    run("CTFD_SELECTED_KEYS.clear(); CTFD_SELECTED_INDICES.clear(); sessionStorage.setItem('toolhub.ctfd.mgr.selectedKeys.v1','[]'); renderCtfdTable(PROJ);");
    assert.doesNotMatch(elements.get('ctfd-table').innerHTML, /alice/);
    run('ctfdClearFilter()');
    assert.match(elements.get('ctfd-table').innerHTML, /bob/);
  });
}

test('CTF-RPG filtering composes tags, text and selection and preserves project identity', async () => {
  const {context, run, elements} = harness();
  run(read('ctfrpg_table'));
  // Exercise the manager's credential pipeline with the same closure inputs as the page.
  const manager = read('ctfrpg_manager');
  run(`
    const $ = id => document.getElementById(id);
    const keyFor = (pid, username) => JSON.stringify([pid,username]);
    const rowTags = RowTags.create('ctfrpg');
    const state = {projects:[
      {id:'one', name:'First', credentials:[{username:'alice'},{username:'bob'}]},
      {id:'two', name:'Second', credentials:[{username:'alice'}]}
    ], selectedProjects:new Set(['one','two']), selectedUsers:new Set([keyFor('one','alice')]),
    rows:[],teams:[],errors:{},sort:{key:'user',dir:'asc'}};
    ${manager.slice(manager.indexOf('  function credentialsRows()'), manager.indexOf('  function render()'))}
  `);
  await run("rowTags.assign([keyFor('one','alice')],1)");
  run(`rowTags.setFilter([1]);
  `);
  assert.equal(run('credentialsRows().length'), 1);
  assert.equal(run('credentialsRows()[0].project.id'), 'one');
  elements.get('filter').value = 'bob';
  assert.equal(run('credentialsRows().length'), 0);
  run('state.selectedOnly=true');
  assert.equal(run('credentialsRows().length'), 1);
  run('state.selectedUsers.clear()');
  assert.equal(run('credentialsRows().length'), 0);
  run('state.selectedOnly=false; rowTags.clearFilter();');
  assert.equal(run('credentialsRows().length'), 1); // Remaining text filter is still active.
  elements.get('filter').value = '';
  assert.equal(run('credentialsRows().length'), 3);
});

test('project tag saves bypass the lifecycle queue', async () => {
  const {context, server} = harness();
  context.ServerQueue = {nativeFetch: context.fetch};
  context.fetch = () => { throw new Error('This request should not be queued'); };
  assert.equal(await context.RowTags.create('ctfd').assign(['one:1'], 5), true);
  assert.deepEqual(server.get('one:ctfd'), {'1': [5]});
});

test('mounted controls await server saves and retain other tag memberships', async () => {
  const {context} = harness();
  const makeElement = (dataset = {}) => ({dataset, disabled: false, checked: false, handlers: {},
    classList: {toggle() {}}, addEventListener(type, handler) { this.handlers[type] = handler; }});
  const inputs = [1, 2, 3, 4, 5].map(id => makeElement({assignTag: String(id)}));
  const filters = [1, 2, 3, 4, 5].map(id => makeElement({filterTag: String(id)}));
  const button = makeElement(), remove = makeElement(), status = makeElement(), retry = makeElement();
  const assignmentHost = {...makeElement(), querySelector: selector => ({
    button, '[data-remove-tags]': remove, '[data-tag-storage]': status, '[data-retry-tags]': retry,
  })[selector], querySelectorAll: () => inputs};
  const filterHost = {querySelectorAll: () => filters};
  const tags = context.RowTags.create('ctfd');
  tags.mount({assignmentHost, filterHost, notice: makeElement(), getProjectIds: () => ['one'],
    getSelectedKeys: () => ['one:1'], onChange() {}});
  await tags.loadProjects(['one']);
  assert.equal(button.disabled, false);
  assert.equal(inputs[0].disabled, false);
  assert.match(status.textContent, /survive restarts/);
  const send = context.fetch;
  let finish;
  context.fetch = (url, options) => new Promise(resolve => { finish = () => resolve(send(url, options)); });
  inputs[0].checked = true;
  const saving = inputs[0].handlers.change();
  await Promise.resolve();
  assert.equal(inputs[0].disabled, true);
  assert.match(status.textContent, /Saving/);
  finish();
  await saving;
  assert.equal(inputs[0].checked, true);
  assert.equal(inputs[0].disabled, false);
  context.fetch = send;
  inputs[3].checked = true;
  await inputs[3].handlers.change();
  assert.equal(inputs[0].checked, true);
  assert.equal(inputs[3].checked, true);
  assert.deepEqual(Array.from(tags.get('one:1')), [1, 4]);
});

test('an older server without the tag route explains that a backend restart is required', async () => {
  const {context} = harness();
  context.fetch = async () => ({ok: false, status: 404, json: async () => { throw new SyntaxError('HTML 404 response'); }});
  const tags = context.RowTags.create('vm');
  const controls = {};
  const elements = new Map();
  const element = () => ({dataset: {}, classList: {toggle() {}}, addEventListener() {}});
  const assignmentHost = {innerHTML: '', addEventListener() {}, querySelector(selector) {
    if (!elements.has(selector)) elements.set(selector, element());
    return elements.get(selector);
  }, querySelectorAll: () => []};
  tags.mount({assignmentHost, filterHost: {querySelectorAll: () => []}, notice: element(),
    getSelectedKeys: () => ['one|1|web'], getProjectIds: () => ['one'], onChange() {}});
  assert.equal(await tags.loadProjects(['one']), false);
  assert.match(elements.get('[data-tag-storage]').textContent, /Restart DeployForge, then reload this page/);
});

for (const multi of [false,true]) {
  test(`VM ${multi?'merged':'single'} checkout icons sync without changing selection or VM inventory`,async()=>{
    const {context,run,elements}=harness();
    context.document.documentElement={dataset:{accessforgePlugin:'on'}};
    run(read('checkout_state'));run(read('vm_manager'));
    run(`PROJ={id:'one',name:'First',instances:2,tag:'-',vms:[{name:'web'}],credentials:[{username:'alice'},{username:'bob'}],checkout:{accounts:{alice:{eligible:true},bob:{eligible:false}}}};
      ALL_PROJECTS=[PROJ];SELECTED_PIDS=${multi?"['one','two']":"['one']"};
      SELECTED_ROWS=new Set(['one|1|web-1']);
      window.__MERGED_ROWS__=[{pid:'one',index:1,vmName:'web-1',uname:'alice',project:'First'},{pid:'one',index:2,vmName:'web-2',uname:'bob',project:'First'}];
      ${multi?'renderMergedVmTable(window.__MERGED_ROWS__)':'renderVmTable(PROJ)'};`);
    let html=elements.get('vm-table').innerHTML;
    assert.match(html,/data-checkout-marked="true"/);assert.doesNotMatch(html,/data-checkout-marked="false"/);
    assert.doesNotMatch(html,/<th[^>]*>Checked out to/);
    run(`vmApplyCheckoutSnapshot('one',{accounts:{alice:{eligible:false,login_disabled:true}}});`);
    html=elements.get('vm-table').innerHTML;
    assert.doesNotMatch(html,/credential-checkout-state/);
    assert.equal(run('SELECTED_ROWS.size'),1);assert.match(html,/web-1/);assert.match(html,/web-2/);
    run("vmApplyCheckoutSnapshot('one',{accounts:{alice:{eligible:true,login_disabled:true}}});VM_COLS.cred=false;VM_COLS.name=false;vmRenderTaggedView()");
    assert.match(elements.get('vm-table').innerHTML,/Marked for checkout · AccessForge login disabled/);
  });
}

for(const multi of [false,true]){
  test(`CTFd ${multi?'merged':'single'} checkout sync updates only matching project icons and preserves scores and selections`,()=>{
    const {context,run,elements}=harness();context.document.documentElement={dataset:{accessforgePlugin:'on'}};
    run(read('checkout_state'));run(read('ctfd_manager'));
    run(`PROJ={id:'one',name:'First',instances:1,credentials:[{username:'alice'}],checkout:{accounts:{alice:{eligible:true}}}};
      CTFD_ALL_PROJECTS=[PROJ,{id:'two',name:'Second',instances:1,credentials:[{username:'alice'}],checkout:{accounts:{alice:{eligible:false}}}}];
      CTFD_SELECTED_PIDS=${multi?"['one','two']":"null"};CTFD_SELECTED_INDICES=new Set([1]);CTFD_SELECTED_KEYS=new Set(['one:1']);
      sessionStorage.setItem('toolhub.ctfd.mgr.selectedKeys.v1','["one:1"]');
      CTFD_USER_META[ctfdMetaKey('one','alice')]={exists:true,user_points:77};renderCtfdTable(PROJ);`);
    assert.equal((elements.get('ctfd-table').innerHTML.match(/credential-checkout-state/g)||[]).length,1);
    run("ctfdApplyCheckoutSnapshot('one',{accounts:{alice:{eligible:false}}});");
    assert.doesNotMatch(elements.get('ctfd-table').innerHTML,/credential-checkout-state/);
    assert.equal(run("CTFD_USER_META[ctfdMetaKey('one','alice')].user_points"),77);
    assert.equal(run(multi?'CTFD_SELECTED_KEYS.size':'CTFD_SELECTED_INDICES.size'),1);
    run("ctfdApplyCheckoutSnapshot('one',{accounts:{alice:{eligible:true,login_disabled:true}}});");
    assert.match(elements.get('ctfd-table').innerHTML,/Marked for checkout · AccessForge login disabled/);
  });
}
test('CTF-RPG checkout sync preserves selected users and scores and only marks the matching project account',()=>{
  const {context,run,elements}=harness();context.document.documentElement={dataset:{accessforgePlugin:'on'}};
  run(read('checkout_state'));run(read('ctfrpg_table'));
  run(read('ctfrpg_manager').replace("  document.addEventListener('DOMContentLoaded', async () => {", "  window.checkoutTest={state,render,applyCheckoutSnapshot};\n  document.addEventListener('DOMContentLoaded', async () => {"));
  run(`checkoutTest.state.projects=[{id:'one',name:'First',credentials:[{username:'alice'}],checkout:{accounts:{alice:{eligible:true}}}},{id:'two',name:'Second',credentials:[{username:'alice'}],checkout:{accounts:{alice:{eligible:false}}}}];
    checkoutTest.state.selectedProjects=new Set(['one','two']);checkoutTest.state.selectedUsers=new Set(['["one","alice"]']);
    checkoutTest.state.rows=[{id:'one',users:[{username:'alice',exists:true,score:77}]}];checkoutTest.render();`);
  assert.equal((elements.get('users-body').innerHTML.match(/credential-checkout-state/g)||[]).length,1);
  run("checkoutTest.applyCheckoutSnapshot('one',{accounts:{alice:{eligible:false}}});");
  assert.doesNotMatch(elements.get('users-body').innerHTML,/credential-checkout-state/);
  assert.equal(run('checkoutTest.state.selectedUsers.size'),1);assert.equal(run('checkoutTest.state.rows[0].users[0].score'),77);
  run("checkoutTest.applyCheckoutSnapshot('two',{accounts:{alice:{eligible:true,email:'student@example.edu'}}});");
  assert.match(elements.get('users-body').innerHTML,/student@example.edu/);
});
