const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('app/static/js/vm_clipboard.js', 'utf8');
const plans = fs.readFileSync('app/static/js/server_vm_actions.js', 'utf8');

function context() {
  const ctx = vm.createContext({AbortController, canonicalPid:String, escHtml: text => String(text).replaceAll('<','&lt;'), window:{}});
  vm.runInContext(source+plans,ctx);
  return ctx;
}

test('clipboard settings and resets keep their selected multi-project targets in the queue', () => {
  const ctx = context();
  const projects = ['one','two'].map(id=>({project:{id},targets:[{index:2,name:'web-lab-2'}],auth:{username:'root@pam'}}));
  ctx.deriveBaseVmName=()=> 'web';
  const change=ctx.buildServerVmSteps('clipboard_update',{clipboardPolicy:{clipboard_to_vm:true,clipboard_to_vm_limit:42}},projects);
  assert.equal(change.length,2);
  assert.equal(change[0].url,'/api/projects/one/instances/actions/clipboard');
  assert.equal(change[1].body.clipboard_to_vm_limit,42);
  assert.equal(change[1].body.clipboard_to_vm,true);
  assert.equal(change[1].body.targets[0].index,2);
  assert.equal(change[1].body.clipboard_from_vm,undefined);
  const files = ctx.buildServerVmSteps('file_transfer_update', {fileTransferPolicy: {file_upload: false, file_download: true}}, projects);
  assert.equal(files[1].url, '/api/projects/two/instances/actions/file_transfer');
  assert.equal(files[1].body.file_upload, false);
  assert.equal(files[1].body.file_download, true);
  const reset=ctx.buildServerVmSteps('clipboard_reset',{},projects);
  assert.equal(reset[0].body.reset_counts,true);
  assert.equal(reset[1].body.reset_counts,true);
});

test('usage column distinguishes exhausted, unlimited, stale-reset and unavailable counts', () => {
  const ctx=context();
  ctx.row={pid:'one',detail:{vmid:101,type:'qemu',clipboard_policy:{
    to_vm:{enabled:true,limit:10,reset:'epoch',scope:'vm'},
    from_vm:{enabled:false,limit:null,reset:'',scope:'vm'},
  }}};
  vm.runInContext("VM_CLIPBOARD_USAGE.set('one',{usage:{'101':{to_vm:{used:10,remaining:0,reset:'epoch',scope:'vm'},from_vm:{used:25,remaining:null,reset:'',scope:'vm'}}}})",ctx);
  let html=ctx.vmClipboardCell(ctx.row,{});
  assert.match(html,/10 \/ 10/);
  assert.match(html,/0 characters remaining/);
  assert.match(html,/25 \/ ∞<\/div>/);
  assert.match(html,/bi-box-arrow-in-right/);
  assert.match(html,/bi-box-arrow-left/);
  ctx.row.detail.clipboard_policy.to_vm.reset='new-reset';
  ctx.row.detail.clipboard_policy.from_vm.reset='new-reset';
  html=ctx.vmClipboardCell(ctx.row,{});
  assert.match(html,/bi-question-circle[^>]*aria-label="Usage unavailable"><\/i> \/ 10/);
  assert.match(html,/<\/i>∞<\/div>/);
  assert.equal(ctx.vmClipboardCell({detail:{type:'lxc'}},{}),'<span class="text-muted">n/a</span>');
});

test('Clipboard Access menu opens the two configuration dialogs and both table modes include usage', () => {
  const html=fs.readFileSync('app/static/vm_manager.html','utf8');
  const manager=fs.readFileSync('app/static/js/vm_manager.js','utf8');
  const menu=html.slice(html.indexOf('id="act-clipboard"'),html.indexOf('<!-- Users & Access group -->'));
  for(const action of ['file_transfer_update', 'clipboard_update', 'clipboard_reset']) assert.ok(menu.includes(action));
  assert.doesNotMatch(menu, /file_(upload|download)_(enable|disable)/);
  assert.equal((manager.match(/<th>Clipboard<\/th>/g)||[]).length,2);
  assert.equal((manager.match(/vmClipboardCell\(r,/g)||[]).length,2);
});

function policyDialog(textCopy, details) {
  const ctx = context();
  const element = (props = {}) => Object.assign(new EventTarget(), props);
  const access = (textCopy ? ['clipboard_to_vm', 'clipboard_from_vm'] : ['file_upload', 'file_download'])
    .map(key => element({dataset: {policyAccess: key}}));
  const limits = textCopy ? access.map(({dataset}) => {
    const toggle = element({focus() {}}), input = {defaultValue: '2000'}, allowance = {}, mixed = {}, clear = element();
    return {dataset: {policyLimit: dataset.policyAccess}, toggle, input, allowance, mixed, clear,
      querySelector: selector => ({'[data-limit-toggle]': toggle, '[data-limit-allowance]': allowance,
        '[data-mixed-limits]': mixed, '[data-clear-limits]': clear, 'input[type="number"]': input})[selector]};
  }) : [];
  const reset = textCopy ? {checked: false} : null;
  const form = element({querySelectorAll: selector => selector === '[data-policy-access]' ? access : limits,
    querySelector: () => reset, reportValidity: () => true});
  const modal = element({querySelector: selector => selector === 'form' ? form : {}});
  ctx.document = {getElementById: id => id === (textCopy ? 'vmClipboardModal' : 'vmFileTransferModal') ? modal : null};
  ctx.guestTransferProject = id => ({id});
  ctx._findVmDetailForTarget = (_project, target) => details[target.index];
  ctx.bootstrap = {Modal: {getOrCreateInstance: () => ({show() {}, hide() {modal.dispatchEvent(new Event('hidden.bs.modal'));}})}};
  const result = ctx.promptVmAccessPolicy({targetsByPid: {one: details.map((_, index) => ({index}))}}, textCopy);
  return {access, limits, reset, async submit() {
    form.dispatchEvent(new Event('submit', {cancelable: true}));
    return JSON.parse(JSON.stringify(await result));
  }};
}

test('text copy recalls an existing allowance, prefills a new one and can reset both counts on save', async () => {
  const dialog = policyDialog(true, [{clipboard_policy: {
    to_vm: {enabled: true, limit: 25}, from_vm: {enabled: false, limit: null},
  }}]);
  const [client, guest] = dialog.limits;
  assert.equal(dialog.access[0].value, 'true');
  assert.equal(dialog.access[1].value, 'false');
  assert.equal(client.allowance.hidden, false);
  assert.equal(client.input.value, '25');
  assert.equal(guest.allowance.hidden, true);
  guest.toggle.checked = true;
  guest.toggle.dispatchEvent(new Event('change'));
  assert.equal(guest.allowance.hidden, false);
  assert.equal(guest.input.value, '2000');
  dialog.access[1].value = 'true';
  dialog.reset.checked = true;
  assert.deepEqual(await dialog.submit(), {clipboard_from_vm: true, clipboard_from_vm_limit: 2000, reset_counts: true});
});

test('mixed file access and clipboard allowances are preserved until edited', async () => {
  const files = policyDialog(false, [{file_transfer_policy: {file_upload: true, file_download: true}},
    {file_transfer_policy: {file_upload: false, file_download: true}}]);
  assert.equal(files.access[0].value, '');
  files.access[1].value = 'false';
  assert.deepEqual(await files.submit(), {file_download: false});

  const details = [25, 50].map(limit => ({clipboard_policy: {to_vm: {enabled: true, limit}}}));
  const text = policyDialog(true, details);
  assert.equal(text.limits[0].toggle.indeterminate, true);
  assert.equal(text.limits[0].allowance.hidden, true);
  assert.equal(await text.submit(), null);

  const remove = policyDialog(true, details);
  remove.limits[0].clear.dispatchEvent(new Event('click'));
  assert.deepEqual(await remove.submit(), {clipboard_to_vm_limit: null});
});
