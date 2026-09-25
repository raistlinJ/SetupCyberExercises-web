const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const sandbox = vm.createContext({});
vm.runInContext(fs.readFileSync('app/static/js/orchestration_access.js', 'utf8'), sandbox);
vm.runInContext(fs.readFileSync('app/static/js/server_vm_actions.js', 'utf8'), sandbox);
sandbox.deriveBaseVmName = (p, name) => name;
const projects = () => [
 { project: { id: 'p1', name: 'Lab one', instances: 2, credentials: [{ username: 'alice' }, { username: 'bob@pam' }] },
   targets: [{ index: 1, name: 'app' }, { index: 1, name: 'core' }], auth: {} },
 { project: { id: 'p2', name: 'Lab two', instances: 1, credentials: [{ username: 'charlie' }] },
   targets: [{ index: 1, name: 'participant' }], auth: {} },
];
const plain = value => JSON.parse(JSON.stringify(value));

test('confirmation names users and clearly describes user-wide grant and revocation', () => {
 const plan = sandbox.buildOrchestrationAccessPlan(projects(), true);
 assert.deepEqual(plain(plan.expectedByProject), { p1: { 1: 'alice@pve' }, p2: { 1: 'charlie@pve' } });
 assert.equal(plan.message.match(/alice@pve/g).length, 1);
 assert.match(plan.message, /Dangerous/);
 assert.match(plan.message, /not just the selected VM rows/);
 assert.match(plan.message, /current WebUI is read-only/);
 assert.match(sandbox.buildOrchestrationAccessPlan(projects(), false).message, /including access enrolled from other projects/);
});

test('missing users or invalid instance selections cannot be confirmed', () => {
 assert.throws(() => sandbox.buildOrchestrationAccessPlan([], true));
 const selection = projects();
 selection[0].project.credentials = [];
 assert.throws(() => sandbox.buildOrchestrationAccessPlan(selection, true), /No credential username/);
 selection[0].targets[0].index = 9;
 assert.throws(() => sandbox.buildOrchestrationAccessPlan(selection, true), /Invalid selected instance/);
});

test('both queued operations preserve confirmed identities for every project and do not add VM ACL steps', () => {
 for (const action of ['users_orchestration_enable', 'users_orchestration_disable']) {
  const selection = projects();
  const plan = sandbox.buildOrchestrationAccessPlan(selection, true);
  const steps = sandbox.buildServerVmSteps(action, { orchestrationConfirmed: true, orchestrationUsers: plan.expectedByProject }, selection);
  assert.equal(steps.length, 2);
  assert.equal(steps[0].url, `/api/projects/p1/instances/actions/${action}`);
  assert.equal(steps[1].url, `/api/projects/p2/instances/actions/${action}`);
  assert.deepEqual(plain(steps[0].body.expectedUsers), { 1: 'alice@pve' });
  assert.equal(steps[1].body.confirmed, true);
  assert.throws(() => sandbox.buildServerVmSteps(action, {}, selection), /requires confirmation/);
 }
});

function actionPage(accept, multi = false) {
 const selected = projects();
 const calls = [];
 const page = vm.createContext({
  PROJ: selected[0].project, vmIsMulti: () => multi,
  listSelectedEntriesForPid: () => selected[0].targets,
  listSelectedEntries: () => selected.flatMap(p => p.targets.map(t => ({ ...t, pid: p.project.id }))),
  guestTransferProject: pid => selected.find(p => p.project.id === pid)?.project,
  vmEnsureLiveStateBeforeAction: async () => 'continue', canonicalPid: value => String(value || ''),
  countExplicitActionTargets: () => 2, getActionableSelections: () => [], friendlyActionName: action => action,
  window: { confirm: message => { calls.push({ message }); return accept; } },
  alert: message => { throw Error(message); },
  runQueued: async (label, fn, options) => calls.push({ label, options }),
 });
 vm.runInContext(fs.readFileSync('app/static/js/orchestration_access.js', 'utf8'), page);
 const manager = fs.readFileSync('app/static/js/vm_manager.js', 'utf8');
 vm.runInContext(manager.slice(manager.indexOf("const VM_ACTION_QUEUE_PERSIST_KEY ="), manager.indexOf('// Original implementation moved to vmActionExec')), page);
 return { page, calls };
}

test('canceling the actual menu handler never queues enrollment', async () => {
 const { page, calls } = actionPage(false);
 await page.vmAction('users_orchestration_enable');
 assert.equal(calls.length, 1);
 assert.match(calls[0].message, /alice@pve/);
});

test('the actual menu handler persists reviewed users for single and multi-project operations', async () => {
 for (const multi of [false, true]) {
  const { page, calls } = actionPage(true, multi);
  await page.vmAction('users_orchestration_disable');
  assert.equal(calls.length, 2);
  const options = calls[1].options.persist.data.options;
  assert.equal(options.orchestrationConfirmed, true);
  assert.deepEqual(plain(options.orchestrationUsers.p1), { 1: 'alice@pve' });
  if (multi) assert.deepEqual(plain(options.orchestrationUsers.p2), { 1: 'charlie@pve' });
 }
});
