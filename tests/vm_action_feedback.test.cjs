const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const manager = fs.readFileSync('app/static/js/vm_manager.js', 'utf8');
const plans = fs.readFileSync('app/static/js/server_vm_actions.js', 'utf8');
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return {promise, resolve}; };

function page({preflightError = false, submissionError = false} = {}) {
  const preflight = deferred(), opened = deferred(), completion = deferred(), preparing = deferred();
  const status = {className: '', set textContent(value) { this.text = value; if (value.startsWith('Preparing')) preparing.resolve(); }};
  const project = {id: 'one', name: 'Lab', vms: [{name:'web'}], proxmox_url:'https://prox.test'};
  const events = [], logs = [];
  const context = {
    document: {getElementById: id => id === 'vm-action-status' ? status : null, addEventListener() {}},
    PROJ: project, vmIsMulti: () => false, canonicalPid: String,
    listSelectedEntriesForPid: () => [{index:1,name:'web-set-1'}],
    vmEnsureLiveStateBeforeAction: async () => 'continue',
    promptVmCreateOptions: async () => ({setNetworkInterfaces:true,takeSnapshot:true}),
    normalizeVmCreateOptions: options => options,
    friendlyActionName: () => 'Create', countExplicitActionTargets: () => 1, getActionableSelections: () => [],
    guestTransferProject: () => project, hasAuthForProject: () => true,
    readProxCreds: () => ({username:'root@pam',password:'secret'}),
    deriveBaseVmName: () => 'web',
    ServerQueue: {
      nativeFetch: async () => {
        await preflight.promise;
        return {ok: !preflightError, json: async () => ({ambiguous: []}), text: async () => 'Template check failed'};
      },
      submit: async () => {
        if (submissionError) throw new Error('Submission failed');
        events.push('accepted');
        return {id:24,status:'queued'};
      },
    },
    window: {shell: {showQueuePanel() { events.push('queue opened'); opened.resolve(); }, logError: message => logs.push(message)}},
  };
  vm.createContext(context);
  vm.runInContext(plans, context);
  context.finishServerVmAction = () => { events.push('observing'); return completion.promise; };
  context.runQueued = (label, fn, options) => context.submitServerVmAction(label, options.persist.data, options);
  vm.runInContext(manager.slice(manager.indexOf('const VM_ACTION_QUEUE_PERSIST_KEY ='), manager.indexOf('// Original implementation moved to vmActionExec')), context);
  return {context, status, events, logs, preflight, opened, completion, preparing};
}

test('Create shows preparation during preflight, then acknowledges acceptance and opens progress before completion', async () => {
  const p = page();
  const action = p.context.vmAction('create');
  await p.preparing.promise;
  assert.match(p.status.text, /Preparing Create/);
  assert.deepEqual(p.events, []);
  p.preflight.resolve();
  await p.opened.promise;
  assert.match(p.status.text, /Create \(1 item\) queued \(job #24\)/);
  assert.deepEqual(p.events.slice(0,2), ['accepted','queue opened']);
  p.completion.resolve({status:'completed'});
  await action;
  assert.match(p.status.text, /completed/);
});

for (const failure of ['preflightError','submissionError']) {
  test(`${failure} appears on the page instead of becoming an unhandled promise rejection`, async () => {
    const p = page({[failure]:true});
    p.preflight.resolve();
    await p.context.vmAction('create');
    assert.match(p.status.className, /alert-danger/);
    assert.match(p.status.text, /Template check failed|Submission failed/);
    assert.match(p.status.text, /Check the Queue before retrying/);
    assert.equal(p.logs.length, 1);
    assert.equal(p.events.includes('accepted'), false);
  });
}
