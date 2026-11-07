const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../app/static/js/accessforge_manager.js'), 'utf8');
const tagSource = fs.readFileSync(path.join(__dirname, '../app/static/js/row_tags.js'), 'utf8');
const settle = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return {promise, resolve}; };
const response = (data, ok = true) => ({ok, status: ok ? 200 : 502, json: async () => data});

async function harness({connected = true, storage = new Map(), user = 'admin', tagServer = new Map(), credentials = {}} = {}) {
  class Element {
    constructor(id = '') {
      this.id = id; this.value = id === 'af-auto-interval' ? '0' : ''; this.type = 'password';
      this.checked = false; this.disabled = false; this.textContent = ''; this.dataset = {}; this.listeners = {};
      this.children = new Map(); this.classes = new Set();
      this.classList = {add: name => this.classes.add(name), remove: name => this.classes.delete(name),
        toggle: (name, on) => { on ? this.classes.add(name) : this.classes.delete(name); }};
    }
    addEventListener(name, fn) { this.listeners[name] = fn; }
    setAttribute(name, value) { this[name] = value; }
    async fire(name = 'click') { return this.listeners[name]?.({target: this, preventDefault() {}}); }
    set innerHTML(html) {
      this.html = html;
      this.boxes = [...html.matchAll(/<input[^>]*data-(user|filter-tag|assign-tag)="([^"]+)"[^>]*>/g)].map(match => {
        const box = new Element();
        box.dataset[{'user':'user','filter-tag':'filterTag','assign-tag':'assignTag'}[match[1]]] = match[2];
        box.checked = /\schecked(?:\s|>)/.test(match[0]); return box;
      });
    }
    get innerHTML() { return this.html || ''; }
    querySelector(selector) {
      if (!this.children.has(selector)) this.children.set(selector, new Element());
      return this.children.get(selector);
    }
    querySelectorAll(selector = '.af-account') {
      const key = {'.af-account':'user','[data-filter-tag]':'filterTag','[data-assign-tag]':'assignTag'}[selector];
      return (this.boxes || []).filter(box => key in box.dataset);
    }
  }
  const elements = new Map(), listeners = {}, windowListeners = {}, timers = new Map(), calls = [];
  const el = id => { if (!elements.has(id)) elements.set(id, new Element(id)); return elements.get(id); };
  const columnNames = ['username', 'status', 'name', 'email', 'checked_out_at', 'checkout_ip', 'relinquished_at'];
  const columns = columnNames.map(name => { const box = new Element(); box.value = name; box.checked = true; return box; });
  const headers = Array.from({length: 8}, () => new Element());
  let project = 'a', override = null, sequence = 0, persisted = connected, confirmation = true;
  const document = {hidden: false, getElementById: el, addEventListener: (name, fn) => { listeners[name] = fn; },
    querySelectorAll: selector => selector === '.af-column' ? columns : selector === '#af-table thead th' ? headers : []};
  const shell = {getCurrentProjectId: () => project, initShell: async () => {}};
  const broadcasts=[],subscribers=[];
  const window = {CheckoutState:{publish:(pid,checkout)=>broadcasts.push({pid,checkout}),subscribe:fn=>subscribers.push(fn)},shell, addEventListener: (name, fn) => { windowListeners[name] = fn; }};
  const snapshot = pid => ({checked_at:12345,accounts:Object.fromEntries((credentials[pid]||[`student-${pid}`]).map(username=>[username,{email:`${pid}@example.edu`,eligible:true}]))});
  const context = {window, document, shell, AUTH: {me: async () => ({user: {username: user}})},
    sessionStorage: {getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key)},
    setInterval: fn => { const id = ++sequence; timers.set(id, fn); return id; }, clearInterval: id => timers.delete(id),
    confirm: () => confirmation, fetch: async (url, options = {}) => {
      calls.push({url, options});
      if (override) { const result = override(url, options); if (result) return result; }
      const tagMatch = url.match(/projects\/([^/]+)\/row-tags\/(.+)$/);
      if (tagMatch) {
        const key = `${decodeURIComponent(tagMatch[1])}:${tagMatch[2]}`;
        const rows = structuredClone(tagServer.get(key) || {});
        if (options.method === 'PATCH') {
          const body = JSON.parse(options.body);
          for (const row of body.rows) {
            const ids = new Set(rows[row] || []);
            if (body.tag_id === null) ids.clear();
            else if (body.enabled) ids.add(body.tag_id);
            else ids.delete(body.tag_id);
            if (ids.size) rows[row] = [...ids].sort(); else delete rows[row];
          }
          tagServer.set(key, rows);
        }
        return response({row_tags: rows});
      }
      if (url === '/api/projects') return response({projects: [{id: 'a', name: 'Project A'}, {id: 'b', name: 'Project B'}]});
      const pid = decodeURIComponent(url.split('/')[3]), operation = url.split('/').at(-1);
      if (operation === 'connection') {
        if (options.method === 'POST') persisted = JSON.parse(options.body).persist;
        if (options.method === 'DELETE') persisted = false;
        return response({connected: persisted || !!options.headers['X-AccessForge-Connection'], persist: persisted,
          url: 'https://accessforge.example', username: 'root@pam', verify_ssl: true, administrator: 'root@pam'});
      }
      if (operation === 'accounts') return response({accounts: (credentials[pid] || [`student-${pid}`]).map(username => ({username})), checkout: snapshot(pid)});
      const selected=options.body?JSON.parse(options.body).usernames:null;
      return response({checkout: snapshot(pid),results:(selected||[]).map(username=>({username,success:true}))});
    }};
  window.fetch = context.fetch;
  vm.createContext(context);
  vm.runInContext(tagSource, context);
  vm.runInContext(source, context);
  await listeners.DOMContentLoaded(); await settle();
  return {el, calls, broadcasts, pushCheckout:(pid,checkout)=>subscribers.forEach(fn=>fn(pid,checkout)), tagServer, timers, document, snapshot, columns, headers, storage, window,
    confirm: value => { confirmation = value; },
    override: fn => { override = fn; }, select: async pid => { project = pid; await listeners['project-selected'](); },
    tick: async () => { for (const fn of [...timers.values()]) fn(); await settle(); },
    auto: async seconds => { el('af-auto-interval').value = String(seconds); await el('af-auto-interval').fire('change'); },
    emit: name => el('af-connection').fire(name), hide: () => windowListeners.pagehide()};
}

test('status requests require Refresh or an explicitly enabled Auto interval', async () => {
  const h = await harness();
  assert.equal(h.timers.size, 0);
  assert.equal(h.calls.filter(call => call.url.endsWith('/status')).length, 0);
  await h.el('af-refresh').fire();
  assert.equal(h.calls.filter(call => call.url.endsWith('/status')).length, 1);
  await h.auto(15); await h.tick();
  assert.equal(h.calls.filter(call => call.url.endsWith('/status')).length, 2);
  await h.auto(0); assert.equal(h.timers.size, 0);
});

test('Auto waits for authentication and pauses while the connection modal or tab is hidden', async () => {
  const unauthenticated = await harness({connected: false});
  assert.equal(unauthenticated.el('af-refresh').disabled, true);
  await unauthenticated.auto(15); await unauthenticated.tick();
  assert.equal(unauthenticated.el('af-auto-badge').textContent, 'Auth');
  assert.equal(unauthenticated.calls.filter(call => call.url.endsWith('/status')).length, 0);
  const h = await harness(); await h.auto(15);
  await h.emit('show.bs.modal'); await h.tick();
  assert.equal(h.el('af-auto-badge').textContent, 'Pause');
  assert.equal(h.calls.filter(call => call.url.endsWith('/status')).length, 0);
  await h.emit('hidden.bs.modal'); h.document.hidden = true; await h.tick();
  assert.equal(h.calls.filter(call => call.url.endsWith('/status')).length, 0);
  h.document.hidden = false; await h.tick();
  assert.equal(h.calls.filter(call => call.url.endsWith('/status')).length, 1);
  h.hide(); assert.equal(h.timers.size, 0);
});

test('Auto cannot overlap an account operation and preserves checkbox selection during refresh', async () => {
  const h = await harness();
  h.el('af-select-all').checked=true; await h.el('af-select-all').fire('change'); await h.el('af-refresh').fire();
  assert.equal(h.el('af-accounts').querySelectorAll()[0].checked, true);
  const pending = deferred(); h.override(url => url.endsWith('/reenable-logins') ? pending.promise : null);
  const enabling = h.el('af-reenable-logins').fire(); await h.auto(15); await h.tick();
  assert.equal(h.el('af-auto-badge').textContent, 'Busy');
  assert.equal(h.calls.filter(call => call.url.endsWith('/status')).length, 1);
  pending.resolve(response({checkout: h.snapshot('a')})); await enabling;
  await h.tick(); assert.equal(h.calls.filter(call => call.url.endsWith('/status')).length, 3);
});

test('late refresh responses cannot overwrite a project after switching away and back', async () => {
  const h = await harness(), pending = deferred();
  h.override(url => url.endsWith('/status') ? pending.promise : null);
  const refreshing = h.el('af-refresh').fire();
  h.el('af-password').value = 'must-be-cleared'; await h.select('b'); await h.select('a');
  assert.equal(h.el('af-password').value, '');
  pending.resolve(response({checkout: {accounts: {'student-a': {email: 'stale@example.edu'}}}})); await refreshing;
  assert.match(h.el('af-accounts').innerHTML, /a@example.edu/);
  assert.doesNotMatch(h.el('af-accounts').innerHTML, /stale@example.edu/);
});

test('refresh failures retain the cached status and report the error', async () => {
  const h = await harness(); h.override(url => url.endsWith('/status') ? response({error: 'AccessForge is unavailable'}, false) : null);
  await h.el('af-refresh').fire();
  assert.match(h.el('af-accounts').innerHTML, /a@example.edu/);
  assert.equal(h.el('af-status').textContent, 'AccessForge is unavailable');
  assert.equal(h.el('af-refresh').disabled, false);
});

test('existing persistent connections restore Save credentials and submit the choice', async () => {
  const h = await harness(); assert.equal(h.el('af-save-creds').checked, true);
  await h.el('af-connection-form').fire('submit');
  const saved = h.calls.find(call => call.options.method === 'POST');
  assert.equal(JSON.parse(saved.options.body).persist, true);
  assert.equal([...h.storage.keys()].filter(key => key.startsWith('toolhub.accessforge.session.')).length, 0);
});

test('session-only credentials survive a reload, stay scoped to user/project, and can become persistent', async () => {
  const storage = new Map(), h = await harness({connected: false, storage});
  h.el('af-password').value = 'session-secret'; await h.el('af-connection-form').fire('submit');
  assert.equal(JSON.parse(h.calls.find(call => call.options.method === 'POST').options.body).persist, false);
  const reloaded = await harness({connected: false, storage});
  assert.equal(reloaded.el('af-refresh').disabled, false);
  assert.equal(reloaded.el('af-save-creds').checked, false);
  await reloaded.el('af-refresh').fire();
  const status = reloaded.calls.find(call => call.url.endsWith('/status'));
  assert.equal(JSON.parse(decodeURIComponent(status.options.headers['X-AccessForge-Connection'])).password, 'session-secret');
  await reloaded.select('b');
  assert.equal(reloaded.el('af-refresh').disabled, true);
  const anotherUser = await harness({connected: false, storage, user: 'other-admin'});
  assert.equal(anotherUser.el('af-refresh').disabled, true);
  await reloaded.select('a'); reloaded.el('af-save-creds').checked = true;
  await reloaded.el('af-connection-form').fire('submit');
  const saved = reloaded.calls.find(call => call.options.method === 'POST');
  assert.equal(JSON.parse(saved.options.body).password, 'session-secret');
  assert.equal(JSON.parse(saved.options.body).persist, true);
  assert.equal([...storage.keys()].filter(key => key.startsWith('toolhub.accessforge.session.')).length, 0);
});

test('unchecking a saved connection requires a password and failed validation restores prior session credentials', async () => {
  const h = await harness(); h.el('af-save-creds').checked = false;
  await h.el('af-connection-form').fire('submit');
  assert.match(h.el('af-connection-feedback').textContent, /Enter the administrator password/);
  assert.equal(h.calls.filter(call => call.options.method === 'POST').length, 0);
  h.el('af-password').value = 'valid-session-secret'; await h.el('af-connection-form').fire('submit');
  h.override(url => url.endsWith('/connection') ? response({error: 'Invalid credentials'}, false) : null);
  h.el('af-password').value = 'invalid-secret'; await h.el('af-connection-form').fire('submit');
  const saved = JSON.parse([...h.storage.entries()].find(([key]) => key.startsWith('toolhub.accessforge.session.'))[1]);
  assert.equal(saved.password, 'valid-session-secret');
  assert.equal(h.el('af-connection-feedback').textContent, 'Invalid credentials');
});

test('bare administrator usernames default to pam and explicit realms remain unchanged', async () => {
  for (const [entered, expected] of [['jcacosta','jcacosta@pam'],[' jcacosta ','jcacosta@pam'],['jcacosta@pve','jcacosta@pve'],['jcacosta@ldap','jcacosta@ldap']]) {
    const h = await harness(); h.el('af-username').value = entered; h.el('af-password').value = 'admin-secret';
    await h.el('af-connection-form').fire('submit');
    const saved = h.calls.find(call => call.options.method === 'POST');
    assert.equal(JSON.parse(saved.options.body).username, expected);
    assert.equal(h.el('af-username').value, expected);
  }
});

test('checkout names are escaped, searchable, and controlled by the Name column preference', async () => {
  const h = await harness();
  h.override(url => url.endsWith('/status') ? response({checkout:{accounts:{'student-a':{name:'Zoë <img src=x>',email:'a@example.edu',eligible:true}}}}) : null);
  await h.el('af-refresh').fire();
  assert.match(h.el('af-accounts').innerHTML,/Zoë &lt;img src=x&gt;/);
  assert.doesNotMatch(h.el('af-accounts').innerHTML,/<img src=x>/);
  h.el('af-filter').value='Zoë'; await h.el('af-filter').fire('input');
  assert.match(h.el('af-accounts').innerHTML,/student-a/);
  const nameColumn=h.columns.find(column=>column.value==='name');nameColumn.checked=false;await nameColumn.fire('change');
  assert.equal(h.headers[3].hidden,true);
  assert.match(h.el('af-accounts').innerHTML,/<td hidden[^>]*>Zoë/);
});

test('checkout settings load fresh policy, pause Auto, and send the secret without queueing or browser persistence', async () => {
  const restrictions={allowed_email_patterns:['*@utep.edu'],allowed_subnets:['192.0.2.0/24'],subnet_checkout_limit:2,ipv4_prefix:28,ipv6_prefix:56,global_delay_seconds:10,subnet_delay_seconds:60};
  const h = await harness(), policy = {...h.snapshot('a'), id: 'pool', enabled: true, verify_email: false, secret_set: true, smtp_configured: true,policy:restrictions};
  h.override(url => url.endsWith('/status') ? response({checkout: policy}) : null);
  await h.el('af-checkout-settings').fire();
  assert.equal(h.el('af-checkout-enabled').checked, true);assert.equal(h.el('af-checkout-verify').checked, false);
  assert.match(h.el('af-checkout-secret-state').textContent, /Leave this field blank/);
  assert.equal(h.el('af-policy-allowed_email_patterns').value,'*@utep.edu');
  assert.equal(h.el('af-policy-ipv4_prefix').value,28);
  await h.auto(15);await h.el('af-checkout-modal').fire('show.bs.modal');
  const before=h.calls.length;await h.tick();assert.equal(h.calls.length,before);assert.equal(h.el('af-auto-badge').textContent,'Pause');
  const direct=[];h.window.ServerQueue={nativeFetch:async(url,options)=>{direct.push({url,options});return response({checkout:policy});}};
  h.el('af-checkout-secret').value='new-class-secret';
  h.el('af-policy-allowed_subnets').value='192.0.2.0/24\n2001:db8::/48';
  h.el('af-policy-global_delay_seconds').value='20';
  await h.el('af-checkout-form').fire('submit');
  assert.equal(direct.length,2);assert.equal(direct[0].options.method,'PATCH');assert.ok(direct[1].url.endsWith('/status'));
  assert.equal(JSON.parse(direct[0].options.body).secret,'new-class-secret');
  assert.deepEqual(JSON.parse(direct[0].options.body).policy,{...restrictions,allowed_subnets:['192.0.2.0/24','2001:db8::/48'],global_delay_seconds:20});
  assert.equal(h.el('af-checkout-secret').value,'');
  assert.ok(![...h.storage.values()].join('').includes('new-class-secret'));
  assert.ok(!h.calls.some(call=>call.url.endsWith('/settings')));
});

test('all checkout actions use direct requests and immediately render the live AccessForge response',async()=>{
  const h=await harness(),direct=[],before=h.calls.length;
  let live={...h.snapshot('a'),id:'pool',enabled:true,verify_email:false,secret_set:true,smtp_configured:true,
    accounts:{'student-a':{eligible:true,login_disabled:true,email:null,sync_status:'synced'}}};
  h.window.ServerQueue={nativeFetch:async(url,options)=>{
    direct.push({url,options});
    if(url.endsWith('/connection'))return response({connected:true,administrator:'root@pam',checkout:live});
    if(url.endsWith('/reenable-logins'))live={...live,accounts:{'student-a':{eligible:true,login_disabled:false,email:null,sync_status:'synced'}}};
    if(url.endsWith('/disable-logins')||url.endsWith('/relinquish-accounts'))live={...live,accounts:{'student-a':{eligible:true,login_disabled:true,email:null,sync_status:'synced'}}};
    return response({checkout:live,results:[{username:'student-a',success:true}]});
  }};
  for(const [button,label] of [['af-reenable-logins','Available'],['af-disable-logins','Disabled'],['af-relinquish','Disabled']]){
    h.el('af-select-all').checked=true;await h.el('af-select-all').fire('change');await h.el(button).fire();
    assert.match(h.el('af-accounts').innerHTML,new RegExp(label));
    assert.match(h.el('af-selection-count').innerHTML,/1 selected/);
    assert.equal(h.el('af-accounts').querySelectorAll()[0].checked,true);
  }
  h.el('af-password').value='test-admin-password';await h.el('af-connection-form').fire('submit');
  assert.deepEqual(direct.slice(-2).map(call=>call.url.split('/').at(-1)),['connection','status']);
  assert.match(h.el('af-status').textContent,/Connected as root@pam\. Status updated/);
  await h.el('af-refresh').fire();await h.el('af-checkout-settings').fire();
  await h.el('af-checkout-form').fire('submit');
  assert.deepEqual(direct.slice(-2).map(call=>call.url.split('/').at(-1)),['settings','status']);
  assert.equal(direct.at(-2).options.method,'PATCH');
  for(const call of direct)assert.equal(call.options.cache,'no-store');
  assert.equal(h.calls.length,before,'live actions must not go through the queued fetch wrapper');
});

test('a failed live status read after connection does not report a refreshed table or restore stale target status',async()=>{
  const h=await harness();
  h.window.ServerQueue={nativeFetch:async(url)=>url.endsWith('/connection')?
    response({administrator:'root@pam',checkout:{accounts:{'student-a':{eligible:true,sync_status:'unknown'}}}}):
    response({error:'AccessForge status unavailable.'},false)};
  h.el('af-password').value='test-admin-password';await h.el('af-connection-form').fire('submit');
  assert.equal(h.el('af-connection-feedback').textContent,'AccessForge status unavailable.');
  assert.equal(h.el('af-status').textContent,'AccessForge status unavailable.');
  assert.match(h.el('af-accounts').innerHTML,/Unknown/);
});

test('admin relinquishment honors Cancel and displays per-account errors', async () => {
  const h = await harness();h.el('af-select-all').checked=true; await h.el('af-select-all').fire('change');h.confirm(false);
  await h.el('af-relinquish').fire();assert.ok(!h.calls.some(call=>call.url.endsWith('/relinquish-accounts')));
  h.confirm(true);h.override(url=>url.endsWith('/relinquish-accounts')?response({checkout:h.snapshot('a'),results:[{username:'student-a',success:false,error:'Login disable failed.'}]}):null);
  await h.el('af-relinquish').fire();
  const request=h.calls.find(call=>call.url.endsWith('/relinquish-accounts'));
  assert.deepEqual(JSON.parse(request.options.body),{usernames:['student-a'],confirmed:true});
  assert.match(h.el('af-status').textContent,/student-a: Login disable failed/);
});


test('selected count includes filtered-out accounts and resets when the project changes', async () => {
  const h = await harness({credentials: {a: ['alice', 'bob']}});
  assert.match(h.el('af-selection-count').innerHTML, /Project A: <strong>0 selected/);
  const box = h.el('af-accounts').querySelectorAll()[0]; box.checked=true; await box.fire('change');
  assert.match(h.el('af-selection-count').innerHTML, /1 selected/);
  h.el('af-filter').value='bob'; await h.el('af-filter').fire('input');
  assert.match(h.el('af-selection-count').innerHTML, /1 selected/);
  h.el('af-select-all').checked=true; await h.el('af-select-all').fire('change');
  assert.match(h.el('af-selection-count').innerHTML, /2 selected/);
  h.el('af-select-all').checked=false; await h.el('af-select-all').fire('change');
  assert.match(h.el('af-selection-count').innerHTML, /1 selected/);
  await h.el('af-clear-filter').fire();
  assert.equal(h.el('af-select-all').indeterminate,true);
  await h.select('b');
  assert.match(h.el('af-selection-count').innerHTML, /Project B: <strong>0 selected/);
  const html=fs.readFileSync(path.join(__dirname,'../app/static/accessforge_manager.html'),'utf8');
  assert.doesNotMatch(html,/id="af-(select-visible|clear-selection)"/);
});

test('tag assignment, filters and badges persist per account and project without changing selection', async () => {
  const tagServer = new Map(), credentials = {a: ['alice', 'bob'], b: ['alice']};
  const h = await harness({tagServer, credentials});
  const assignment = h.el('af-tag-assignment');
  assert.equal(assignment.querySelector('button').disabled,true);
  const box = h.el('af-accounts').querySelectorAll()[0]; box.checked=true; await box.fire('change');
  assert.equal(assignment.querySelector('button').disabled,false);
  const inputs = assignment.querySelectorAll('[data-assign-tag]');
  inputs[0].checked=true; await inputs[0].fire('change');
  inputs[3].checked=true; await inputs[3].fire('change');
  assert.deepEqual(tagServer.get('a:accessforge'),{alice:[1,4]});
  assert.match(h.el('af-accounts').innerHTML,/alice<span class="row-tag-badges">/);
  assert.match(h.el('af-accounts').innerHTML,/row-tag-blue/);
  assert.match(h.el('af-accounts').innerHTML,/row-tag-purple/);
  const filter = h.el('af-tag-filters').querySelectorAll('[data-filter-tag]')[0];
  filter.checked=true; await filter.fire('change');
  assert.match(h.el('af-accounts').innerHTML,/alice/);assert.doesNotMatch(h.el('af-accounts').innerHTML,/bob/);
  assert.match(h.el('af-selection-count').innerHTML,/1 selected/);
  h.el('af-filter').value='bob'; await h.el('af-filter').fire('input');
  assert.match(h.el('af-accounts').innerHTML,/No matching/);
  await h.el('af-clear-filter').fire();assert.match(h.el('af-accounts').innerHTML,/bob/);
  const usernameColumn=h.columns[0]; usernameColumn.checked=false; await usernameColumn.fire('change');
  assert.match(h.el('af-accounts').innerHTML,/<td><input[^>]+><span class="row-tag-badges"><span class="row-tag row-tag-blue/);
  await h.select('b');await settle();assert.doesNotMatch(h.el('af-accounts').innerHTML,/row-tag-blue/);
  const reloaded=await harness({tagServer,credentials});
  assert.match(reloaded.el('af-accounts').innerHTML,/row-tag-purple/);
  assert.match(reloaded.el('af-selection-count').innerHTML,/0 selected/);
  const selectedBox=reloaded.el('af-accounts').querySelectorAll()[0];selectedBox.checked=true;await selectedBox.fire('change');
  await reloaded.el('af-tag-assignment').querySelector('[data-remove-tags]').fire();
  assert.deepEqual(tagServer.get('a:accessforge'),{});
});

test('Accounts offers only Enable, Relinquish and Disable and enabling never submits a password reset', async () => {
  const html=fs.readFileSync(path.join(__dirname,'../app/static/accessforge_manager.html'),'utf8');
  const menu=html.slice(html.indexOf('id="af-accounts-button"'),html.indexOf('id="af-checkout-settings"'));
  assert.deepEqual([...menu.matchAll(/class="dropdown-item[^"\n]*"[^>]*>([^<]+)<\/button>/g)].map(match=>match[1]),['Enable','Relinquish','Disable']);
  assert.doesNotMatch(html,/af-publish|af-reset-passwords/);
  assert.doesNotMatch(source,/af-publish|af-reset-passwords/);
  const h=await harness();
  h.el('af-select-all').checked=true;await h.el('af-select-all').fire('change');
  h.confirm(false);await h.el('af-reenable-logins').fire();
  assert.ok(!h.calls.some(call=>call.url.endsWith('/reenable-logins')));
  h.confirm(true);await h.el('af-reenable-logins').fire();
  const request=h.calls.find(call=>call.url.endsWith('/reenable-logins'));
  assert.deepEqual(JSON.parse(request.options.body),{usernames:['student-a']});
  assert.ok(!h.calls.some(call=>call.url.endsWith('/reset-passwords')||call.url.endsWith('/publish')));
  assert.equal(h.el('af-status').textContent,'Selected accounts enabled.');
  assert.match(h.el('af-selection-count').innerHTML,/1 selected/);
  assert.equal(h.el('af-accounts').querySelectorAll()[0].checked,true);
});


test('AccessForge refresh and account changes broadcast snapshots and receive updates from other managers', async () => {
  const h=await harness();assert.equal(h.broadcasts.length,0);
  await h.el('af-refresh').fire();
  assert.equal(h.broadcasts.length,1);assert.equal(h.broadcasts[0].pid,'a');
  h.pushCheckout('a',{accounts:{'student-a':{email:'updated@example.edu',eligible:true}}});
  assert.match(h.el('af-accounts').innerHTML,/updated@example.edu/);
  h.pushCheckout('b',{accounts:{'student-b':{email:'other@example.edu'}}});
  assert.doesNotMatch(h.el('af-accounts').innerHTML,/other@example.edu/);
  assert.equal(h.broadcasts.length,1,'receiving updates must not rebroadcast them');
  const pending=deferred();h.override(url=>url.endsWith('/status')?pending.promise:null);
  const refresh=h.el('af-refresh').fire();await h.select('b');
  pending.resolve(response({checkout:{accounts:{}}}));await refresh;
  assert.equal(h.broadcasts.length,1,'a late refresh must not broadcast a stale snapshot');
});

test('local On-Demand accounts are visible offline as Unknown and stay visible as Not enabled after refresh',async()=>{
  const h=await harness({connected:false});
  h.pushCheckout('a',{accounts:{'student-a':{eligible:true,sync_status:'unknown',remote_eligible:false}}});
  assert.match(h.el('af-accounts').innerHTML,/student-a/);assert.match(h.el('af-accounts').innerHTML,/Unknown/);
  assert.equal(h.el('af-reenable-logins').disabled,true);
  h.pushCheckout('a',{checked_at:12345,accounts:{'student-a':{eligible:true,sync_status:'not_enabled',remote_eligible:false}}});
  assert.match(h.el('af-accounts').innerHTML,/student-a/);assert.match(h.el('af-accounts').innerHTML,/Not enabled/);
  assert.doesNotMatch(h.el('af-accounts').innerHTML,/Available/);
});

test('refresh summary reports an unenabled local account without dropping its type or claiming login is enabled',async()=>{
  const h=await harness();summaryModal(h);
  h.pushCheckout('a',{accounts:{'student-a':{eligible:true,sync_status:'unknown',remote_eligible:false}}});
  h.override(url=>url.endsWith('/status')?response({checkout:{checked_at:1,accounts:{'student-a':{eligible:true,sync_status:'not_enabled',remote_eligible:false}}}}):null);
  await h.el('af-refresh').fire();
  assert.match(h.el('af-accounts').innerHTML,/Not enabled/);
  assert.match(h.el('af-refresh-results').innerHTML,/Not enabled/);
  assert.match(h.el('af-refresh-results').innerHTML,/Checkout status: Unknown → Not enabled/);
  assert.doesNotMatch(h.el('af-refresh-results').innerHTML,/>Enabled<|>Removed</);
});

function summaryModal(h){
  const shown=[];
  const modal={show(){shown.push(h.el('af-refresh-results').innerHTML);h.el('af-refresh-summary').fire('show.bs.modal');},hide(){h.el('af-refresh-summary').fire('hidden.bs.modal');}};
  h.window.bootstrap={Dropdown:{getInstance:()=>null},Modal:{getInstance:()=>modal,getOrCreateInstance:()=>modal}};
  return {shown,close:()=>modal.hide()};
}

function operationModal(h){
  const shown=[];
  const modal={show(){shown.push(h.el('af-operation-results').innerHTML);h.el('af-operation-summary').fire('show.bs.modal');},hide(){h.el('af-operation-summary').fire('hidden.bs.modal');}};
  h.window.bootstrap={Dropdown:{getInstance:()=>null},Modal:{getInstance:el=>el.id==='af-operation-summary'?modal:null,getOrCreateInstance:()=>modal}};
  return {shown,close:()=>modal.hide()};
}

test('Enable shows per-account success/error results after refreshing the actual status',async()=>{
  const h=await harness({credentials:{a:['alice','bob']}}),modal=operationModal(h),order=[];
  h.override(url=>{
    if(url.endsWith('/reenable-logins')){order.push('enable');return response({checkout:h.snapshot('a'),results:[{username:'alice@pve',success:true},{username:'bob@pve',success:false,error:'Denied <script>'}]});}
    if(url.endsWith('/status')){order.push('refresh');return response({checkout:{accounts:{alice:{eligible:true,sync_status:'synced',login_disabled:false},bob:{eligible:true,sync_status:'not_enabled'}}}});}
    return null;
  });
  h.el('af-select-all').checked=true;await h.el('af-select-all').fire('change');await h.el('af-reenable-logins').fire();
  assert.deepEqual(order,['enable','refresh']);assert.equal(modal.shown.length,1);
  assert.equal(h.el('af-operation-totals').textContent,'2 account(s) · 1 succeeded · 1 errors · 0 unconfirmed');
  assert.match(h.el('af-operation-results').innerHTML,/Success/);assert.match(h.el('af-operation-results').innerHTML,/Denied &lt;script&gt;/);
  assert.doesNotMatch(h.el('af-operation-results').innerHTML,/<script>/);
  assert.match(h.el('af-operation-results').innerHTML,/Not enabled/);assert.match(h.el('af-accounts').innerHTML,/Available/);
  assert.match(h.el('af-operation-refresh').textContent,/Status refreshed/);
  assert.match(h.el('af-selection-count').innerHTML,/2 selected/);
  assert.ok(h.el('af-accounts').querySelectorAll().every(box=>box.checked));
});

test('an operation request error still refreshes and shows its error in the summary',async()=>{
  const h=await harness(),modal=operationModal(h),order=[];
  h.override(url=>{
    if(url.endsWith('/reenable-logins')){order.push('enable');return response({error:'Update and rebuild AccessForge.'},false);}
    if(url.endsWith('/status')){order.push('refresh');return response({checkout:{accounts:{'student-a':{eligible:true,sync_status:'not_synced'}}}});}
    return null;
  });
  h.el('af-select-all').checked=true;await h.el('af-select-all').fire('change');await h.el('af-reenable-logins').fire();
  assert.deepEqual(order,['enable','refresh']);assert.equal(modal.shown.length,1);
  assert.match(h.el('af-operation-totals').textContent,/0 succeeded · 1 errors/);
  assert.match(h.el('af-operation-results').innerHTML,/Update and rebuild/);assert.match(h.el('af-operation-results').innerHTML,/Not synced/);
});

test('a refresh failure preserves the action result and clearly marks the status snapshot as stale',async()=>{
  const h=await harness(),modal=operationModal(h);
  h.override(url=>url.endsWith('/status')?response({error:'Remote unavailable.'},false):null);
  h.el('af-select-all').checked=true;await h.el('af-select-all').fire('change');await h.el('af-disable-logins').fire();
  assert.equal(modal.shown.length,1);assert.match(h.el('af-operation-totals').textContent,/1 succeeded/);
  assert.match(h.el('af-operation-refresh').textContent,/Status refresh failed: Remote unavailable/);
  assert.match(h.el('af-operation-refresh').className,/alert-warning/);
  assert.match(h.el('af-status').textContent,/Status refresh failed/);
});

test('missing per-account results are unconfirmed instead of reported as success',async()=>{
  const h=await harness();operationModal(h);
  h.override(url=>url.endsWith('/reenable-logins')?response({checkout:h.snapshot('a'),results:[]}):null);
  h.el('af-select-all').checked=true;await h.el('af-select-all').fire('change');await h.el('af-reenable-logins').fire();
  assert.match(h.el('af-operation-totals').textContent,/0 succeeded · 0 errors · 1 unconfirmed/);
  assert.match(h.el('af-operation-results').innerHTML,/did not return a result/);
});

test('operation summaries pause Auto and a project switch discards late results and skips their refresh',async()=>{
  const h=await harness(),modal=operationModal(h);await h.auto(15);
  h.el('af-select-all').checked=true;await h.el('af-select-all').fire('change');await h.el('af-reenable-logins').fire();
  assert.equal(h.el('af-auto-badge').textContent,'Pause');let before=h.calls.length;await h.tick();assert.equal(h.calls.length,before);
  modal.close();await h.tick();assert.ok(h.calls.length>before);
  const pending=deferred();h.override(url=>url.endsWith('/reenable-logins')?pending.promise:null);
  h.el('af-select-all').checked=true;await h.el('af-select-all').fire('change');const operation=h.el('af-reenable-logins').fire();
  await h.select('b');before=h.calls.length;pending.resolve(response({checkout:{accounts:{private:{eligible:true,email:'private@example.edu'}}},results:[]}));await operation;
  assert.equal(h.calls.length,before);assert.equal(modal.shown.length,1);assert.equal(h.el('af-operation-results').innerHTML,'');
});
test('manual refresh summary lists changed marks, assignments, login state and history safely; unmarked accounts leave its scope',async()=>{
  const h=await harness(),modal=summaryModal(h);
  const checkout={checked_at:1,accounts:{'student-a':{eligible:false,email:'changed@example.edu',name:'Ava <script>',login_disabled:true,checked_out_at:123,checkout_ip:'203.0.113.1',relinquished_at:456,relinquished_ip:'203.0.113.2'}}};
  h.override(url=>url.endsWith('/status')?response({checkout}):null);
  await h.el('af-refresh').fire();
  assert.equal(modal.shown.length,1);assert.equal(h.broadcasts.length,1);
  assert.equal(h.el('af-refresh-project').textContent,'Project A');
  assert.equal(h.el('af-refresh-totals').textContent,'1 account(s) checked · 1 changed · 0 unchanged');
  const html=h.el('af-refresh-results').innerHTML;
  assert.match(html,/Synced/);assert.match(html,/Checkout mark: Marked → Unmarked/);
  assert.match(html,/Assigned email: a@example.edu → changed@example.edu/);
  assert.match(html,/AccessForge login: Enabled → Disabled/);assert.match(html,/Checkout IP: — → 203.0.113.1/);
  assert.match(html,/Relinquished:/);assert.doesNotMatch(html,/Relinquish IP|203\.0\.113\.2/);
  assert.match(html,/Ava &lt;script&gt;/);assert.doesNotMatch(html,/<script>/);
  modal.close();await h.el('af-refresh').fire();
  assert.equal(h.el('af-refresh-totals').textContent,'0 account(s) checked · 0 changed · 0 unchanged');
  assert.match(h.el('af-refresh-results').innerHTML,/No accounts marked for checkout/);
});
test('Auto refresh stays silent and pauses while a manual sync summary is open',async()=>{
  const h=await harness(),modal=summaryModal(h);await h.auto(15);await h.tick();
  assert.equal(modal.shown.length,0);assert.equal(h.broadcasts.length,1);
  await h.el('af-refresh').fire();assert.equal(modal.shown.length,1);
  const before=h.calls.length;await h.tick();assert.equal(h.calls.length,before);
  assert.equal(h.el('af-auto-badge').textContent,'Pause');
  modal.close();await h.tick();assert.equal(modal.shown.length,1);assert.equal(h.broadcasts.length,3);
});
test('failed and superseded refreshes do not show success summaries or leak a previous project summary',async()=>{
  const h=await harness(),modal=summaryModal(h);
  h.override(url=>url.endsWith('/status')?response({error:'Unavailable'},false):null);
  await h.el('af-refresh').fire();assert.equal(modal.shown.length,0);
  assert.equal(h.el('af-status').textContent,'Unavailable');
  const pending=deferred();h.override(url=>url.endsWith('/status')?pending.promise:null);
  const refreshing=h.el('af-refresh').fire();await h.select('b');
  pending.resolve(response({checkout:{accounts:{private:{email:'stale@example.edu'}}}}));await refreshing;
  assert.equal(modal.shown.length,0);assert.equal(h.el('af-refresh-results').innerHTML,'');
});
test('refresh summary accounts for removed and newly published accounts and empty pools',async()=>{
  const h=await harness();summaryModal(h);
  h.override(url=>url.endsWith('/status')?response({checkout:{accounts:{'new-account':{eligible:true}}}}):null);
  await h.el('af-refresh').fire();
  assert.equal(h.el('af-refresh-totals').textContent,'2 account(s) checked · 2 changed · 0 unchanged');
  assert.match(h.el('af-refresh-results').innerHTML,/Added to checkout snapshot/);
  assert.match(h.el('af-refresh-results').innerHTML,/Removed from checkout snapshot/);
  h.override(url=>url.endsWith('/status')?response({checkout:{accounts:{}}}):null);
  await h.el('af-refresh').fire();await h.el('af-refresh').fire();
  assert.equal(h.el('af-refresh-totals').textContent,'0 account(s) checked · 0 changed · 0 unchanged');
  assert.match(h.el('af-refresh-results').innerHTML,/No accounts marked for checkout/);
});

test('Checkout lists only marked accounts and removes stale selection when authoritative marks change',async()=>{
  const h=await harness({credentials:{a:['on-demand','permanent','disabled','assigned']}});
  const checkout={accounts:{'on-demand':{eligible:true},permanent:{eligible:false},disabled:{eligible:true,login_disabled:true},assigned:{eligible:true,email:'student@example.edu'}}};
  h.pushCheckout('a',checkout);
  assert.equal(h.el('af-accounts').querySelectorAll().length,3);
  assert.doesNotMatch(h.el('af-accounts').innerHTML,/data-user="permanent"/);
  assert.match(h.el('af-accounts').innerHTML,/data-user="disabled"/);
  const box=h.el('af-accounts').querySelectorAll()[0];box.checked=true;await box.fire('change');
  const next={accounts:{'on-demand':{eligible:false},permanent:{eligible:true},disabled:{eligible:true,login_disabled:true},assigned:{eligible:false,email:'student@example.edu'}}};
  h.override(url=>url.endsWith('/status')?response({checkout:next}):null);await h.el('af-refresh').fire();
  assert.equal(h.el('af-accounts').querySelectorAll().length,2);
  assert.match(h.el('af-accounts').innerHTML,/data-user="permanent"/);
  assert.doesNotMatch(h.el('af-accounts').innerHTML,/data-user="on-demand"|data-user="assigned"/);
  assert.match(h.el('af-selection-count').innerHTML,/0 selected/);
  assert.equal(h.broadcasts.at(-1).checkout.accounts['on-demand'].eligible,false,'the full ground truth is shared, including accounts no longer marked');
  await h.el('af-relinquish').fire();assert.ok(!h.calls.some(call=>call.url.endsWith('/relinquish-accounts')));
});


test('unchanged marked accounts remain explicit in the authoritative refresh summary',async()=>{
  const h=await harness();summaryModal(h);await h.el('af-refresh').fire();
  assert.equal(h.el('af-refresh-totals').textContent,'1 account(s) checked · 0 changed · 1 unchanged');
  assert.match(h.el('af-refresh-results').innerHTML,/No changes/);
});

test('awaiting checkout stays available while AccessForge login is gated',async()=>{
  const h=await harness();
  h.pushCheckout('a',{accounts:{'student-a':{eligible:true,sync_status:'synced',login_disabled:true,awaiting_checkout:true}}});
  assert.match(h.el('af-accounts').innerHTML,/Available \(awaiting checkout\)/);
  h.override(url=>url.endsWith('/status')?response({checkout:{accounts:{'student-a':{eligible:true,sync_status:'synced',login_disabled:true,awaiting_checkout:false}}}}):null);
  await h.el('af-refresh').fire();
  assert.match(h.el('af-accounts').innerHTML,/>Disabled<\/td>/);
  assert.match(h.el('af-refresh-results').innerHTML,/Awaiting checkout: Yes → No/);
});
