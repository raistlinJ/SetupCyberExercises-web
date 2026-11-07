const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');
const stateSource = fs.readFileSync('app/static/js/checkout_state.js', 'utf8');
const source = fs.readFileSync('app/static/js/config_integrations.js', 'utf8');

function harness({enabled = true, saveCredentials = true} = {}) {
  let override;
  const calls = [], buttons = [{disabled: false}, {disabled: false}], fields = new Map(), storage = new Map();
  const el = id => { if (!fields.has(id)) fields.set(id, {value: '', textContent: ''}); return fields.get(id); };
  const rows = ['alice', 'bob'].map(username => {
    const input = {value: username}, badge = {}, row = {querySelector: selector => selector === '.credential-checkout-state' ? badge : input};
    const box = {checked: true, closest: () => row}; return {row, box, badge};
  });
  fields.set('cred-p-list', {querySelectorAll: selector => selector === '[data-index]' ? rows.map(r => r.row) : rows.filter(r => !selector.includes(':checked') || r.box.checked).map(r => r.box)});
  el('cfg-p-accessforge_url').value = 'https://accessforge.example'; el('cfg-p-accessforge_api_port').value = '8443';
  const project = {checkout: {accounts: {}}}, context = {URL, CSS: {escape: value => value},
    window: {PROJ_CACHE: {p: project},addEventListener() {}}, document: {addEventListener() {},documentElement: {dataset: {accessforgePlugin: enabled ? 'on' : 'off'}}, getElementById: el, querySelectorAll: () => buttons},
    AUTH: {me: async () => ({user: {username: 'instructor'}})},
    sessionStorage: {getItem: key => storage.get(key)}, setTimeout, clearTimeout,
    _saveCredentialsNow: async pid => { calls.push({saveCredentials: pid}); return saveCredentials; },
    fetch: async (url, options = {}) => {
      calls.push({url, options, body: options.body?JSON.parse(options.body):undefined});
      if(override){const result=override(url,options);if(result)return result;}
      return {ok: true, json: async () => ({checkout: {connection_url: 'https://accessforge.example:8443', accounts: {alice: {eligible: true}, bob: {login_disabled: true}}}})};
    }};
  context.window.fetch=context.fetch;
  vm.createContext(context);vm.runInContext(stateSource,context);vm.runInContext(source, context);
  return {api: context.window.ConfigIntegrations, context, calls, el, buttons, project, rows, storage, override:fn=>override=fn, publish:checkout=>context.window.CheckoutState.publish('p',checkout)};
}

test('URL and API port round-trip paths, IPv6, HTTP, and embedded custom ports', () => {
  const {api} = harness();
  for (const value of ['https://example.edu:8443/api', 'http://localhost:8080', 'https://[2001:db8::1]:9443/portal']) {
    const split = api.parts(value); assert.equal(api.join(split.url, split.port), value);
  }
  const url = {value: 'https://example.edu:9443'}, port = {value: '443'};
  assert.equal(api.readFields(url, port), 'https://example.edu:9443');
  assert.equal(url.value, 'https://example.edu'); assert.equal(port.value, '9443');
  for (const invalid of ['0', '65536', '', 'bad', '1.2']) assert.throws(() => api.join('https://example.edu', invalid));
});

test('bulk checkout saves current credentials first and sends exactly the selected usernames', async () => {
  const h = harness(); h.rows[1].box.checked = false;
  await h.api.mark('p', true);
  assert.deepEqual(h.calls[0], {saveCredentials: 'p'});
  assert.equal(h.calls.length,2);
  assert.equal(h.calls[1].url, '/api/projects/p/credential-types');
  assert.deepEqual(h.calls[1].body, {usernames: ['alice'], enabled: true});
  assert.match(h.rows[0].badge.outerHTML, /aria-label="Marked for checkout · Available according to checkout policy"/);
  assert.match(h.rows[1].badge.outerHTML, /aria-label="Not marked for checkout · AccessForge login disabled"/);
  assert.ok(h.buttons.every(button => !button.disabled));
});

test('a failed credential save prevents publication and disabled plugins cannot publish', async () => {
  const failed = harness({saveCredentials: false}); await failed.api.mark('p', true);
  assert.equal(failed.calls.length, 1); assert.match(failed.el('cred-checkout-status-p').textContent, /Save the credential list successfully/);
  const off = harness({enabled: false}); await off.api.mark('p', true); assert.equal(off.calls.length, 0);
});

test('local type changes do not send AccessForge credentials or save its URL', async () => {
  const h = harness(); h.storage.set('toolhub.accessforge.session.instructor.p', JSON.stringify({url: 'https://accessforge.example:8443', username: 'admin@pam', password: 'session-password', verify_ssl: false}));
  await h.api.mark('p', false);
  for (const call of h.calls.filter(call => call.url)) {
    assert.equal(call.options.headers['X-AccessForge-Connection'],undefined);
  }
  assert.equal(h.calls.filter(call=>call.url).length,1);
  assert.deepEqual(h.calls.at(-1).body, {usernames: ['alice', 'bob'], enabled: false});
});

test('VM Manager marking keeps the existing remote sync endpoint and session credentials',async()=>{
  const h=harness();h.storage.set('toolhub.accessforge.session.instructor.p',JSON.stringify({url:'https://accessforge.example:8443',username:'admin@pam',password:'session-password',verify_ssl:false}));
  await h.api.setMarked('p',['alice'],true);
  assert.equal(h.calls.length,1);assert.equal(h.calls[0].url,'/api/projects/p/accessforge/checkout-accounts');
  assert.equal(JSON.parse(decodeURIComponent(h.calls[0].options.headers['X-AccessForge-Connection'])).password,'session-password');
  assert.deepEqual(h.calls[0].body,{usernames:['alice'],enabled:true});
});

test('the real credential save and type change bypass the queue and only write SCE-web configuration',async()=>{
  const h=harness(),direct=[];
  const app=fs.readFileSync('app/static/js/app.js','utf8');
  h.context.FormData=class {};
  h.context._credSaveTimers={};h.context.collectCredentials=()=>[{username:'alice',password:'local-password'}];
  h.context.harmonizeCredentialsToInstances=(_pid,credentials)=>credentials;
  h.context.setTimeout=()=>0;h.context.clearTimeout=()=>{};
  h.context.AUTH.me=async()=>{throw Error('Local type changes must not request connector credentials');};
  h.context.fetch=async()=>{throw Error('The shared queue must not handle a local type change');};
  h.context.window.ServerQueue={nativeFetch:async(url,options)=>{
    direct.push({url,options,body:JSON.parse(options.body)});
    const data=url==='/api/projects/p'?{credentials:[{username:'alice',password:'local-password'}]}:
      {checkout:{accounts:{alice:{eligible:true,sync_status:'unknown'}}}};
    return {ok:true,headers:{get:()=> 'application/json'},json:async()=>data};
  }};
  vm.runInContext(app.slice(app.indexOf('async function http('),app.indexOf('// UI state helpers')),h.context);
  vm.runInContext(app.slice(app.indexOf('async function _saveCredentialsNow(')),h.context);
  h.rows[1].box.checked=false;h.el('cfg-p-accessforge_url').value='invalid unused AccessForge URL';
  await h.api.setMode('p','on-demand');
  assert.deepEqual(direct.map(call=>[call.options.method,call.url]),[['PATCH','/api/projects/p'],['POST','/api/projects/p/credential-types']]);
  assert.equal(direct[1].options.headers['X-AccessForge-Connection'],undefined);
  assert.equal(h.el('cred-checkout-mode-p').value,'on-demand');
  assert.match(h.el('cred-checkout-status-p').textContent,/Saved locally in SCE-web/);
  assert.match(h.rows[0].badge.outerHTML,/Marked for checkout · Unknown/);
});

test('a missing local save endpoint reports an SCE-web update error and never falls back to AccessForge',async()=>{
  const h=harness(),direct=[];
  h.context.window.ServerQueue={nativeFetch:async(url,options)=>{direct.push({url,options});return {ok:false,status:404,json:async()=>{throw Error('HTML response');}};}};
  h.rows[1].box.checked=false;await h.api.setMode('p','on-demand');
  assert.equal(direct.length,1);assert.equal(direct[0].url,'/api/projects/p/credential-types');
  assert.match(h.el('cred-checkout-status-p').textContent,/Update and rebuild SCE-web/);
  assert.equal(h.el('cred-checkout-mode-p').value,'permanent');
  assert.equal(h.calls.filter(call=>call.url).length,0);
});


test('Checkout combobox reflects selected credentials and follows synced eligibility without losing selection',()=>{
  const h=harness();h.rows.forEach(row=>row.box.checked=false);h.api.syncSelection('p');
  const mode=h.el('cred-checkout-mode-p');assert.equal(mode.disabled,true);assert.equal(mode.value,'');
  h.rows[0].box.checked=true;h.api.syncSelection('p');assert.equal(mode.disabled,false);assert.equal(mode.value,'permanent');
  h.publish({accounts:{alice:{eligible:true},bob:{eligible:false}}});assert.equal(mode.value,'on-demand');
  h.rows[1].box.checked=true;h.api.syncSelection('p');assert.equal(mode.value,'');
  h.publish({accounts:{alice:{eligible:true},bob:{eligible:true,login_disabled:true}}});assert.equal(mode.value,'on-demand');
  assert.ok(h.rows.every(row=>row.box.checked));
});

test('Checkout modes apply only to selected credentials and preserve the existing save-first workflow',async()=>{
  for(const [mode,eligible] of [['on-demand',true],['permanent',false]]){
    const h=harness();h.rows[1].box.checked=false;
    h.override((url,options)=>url.endsWith('/credential-types')?{ok:true,json:async()=>({checkout:{accounts:{alice:{eligible}}}})}:null);
    await h.api.setMode('p',mode);
    assert.deepEqual(h.calls[0],{saveCredentials:'p'});
    assert.deepEqual(h.calls.at(-1).body,{usernames:['alice'],enabled:eligible});
    assert.equal(h.el('cred-checkout-mode-p').value,mode);assert.equal(h.el('cred-checkout-mode-p').disabled,false);
    assert.match(h.el('cred-checkout-status-p').textContent,/Checkout mode set to/);
  }
  const invalid=harness();await invalid.api.setMode('p','unexpected');assert.equal(invalid.calls.length,0);
});

test('a pending mode change disables the combobox and a failed save restores the actual mode',async()=>{
  const h=harness();h.rows[1].box.checked=false;h.api.syncSelection('p');
  const mode=h.el('cred-checkout-mode-p');mode.value='on-demand';let finish;
  h.override(url=>url.endsWith('/credential-types')?new Promise(resolve=>finish=resolve):null);
  const changing=h.api.setMode('p','on-demand');
  assert.equal(mode.disabled,true);assert.equal(mode.value,'on-demand');
  while(!finish)await new Promise(resolve=>setImmediate(resolve));
  finish({ok:false,status:502,json:async()=>({error:'AccessForge unavailable'})});await changing;
  assert.equal(mode.value,'permanent');assert.equal(mode.disabled,false);
  assert.match(h.el('cred-checkout-status-p').textContent,/AccessForge unavailable/);
  const failed=harness({saveCredentials:false});failed.rows[1].box.checked=false;
  failed.el('cred-checkout-mode-p').value='on-demand';await failed.api.setMode('p','on-demand');
  assert.equal(failed.el('cred-checkout-mode-p').value,'permanent');assert.equal(failed.calls.length,1);
});
