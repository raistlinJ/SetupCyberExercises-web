const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const source = fs.readFileSync('app/static/js/server_queue.js', 'utf8');
const plans = fs.readFileSync('app/static/js/server_vm_actions.js', 'utf8');

function browser(fetch) {
  const window = { fetch, location: { href: 'http://localhost/vm-manager', origin: 'http://localhost' }, shell: { logError() {} } };
  window.window = window;
  const sandbox = { window, document: { dispatchEvent() {} }, CustomEvent: class {}, Headers, FormData, Blob, URL,
    setTimeout: fn => setTimeout(fn, 0), setInterval() {}, console };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  return window;
}

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

test('waiting work is submitted immediately and a new page observes the same jobs', async () => {
  const accepted = [];
  let finish = false;
  const fetch = async (url, opts = {}) => {
    if (url === '/api/queue' && opts.method === 'POST') {
      accepted.push(JSON.parse(opts.body));
      return json({ id: accepted.length, label: accepted.at(-1).label, status: 'queued' }, 202);
    }
    if (url === '/api/queue') return json({ items: accepted.map((item, i) => ({ id: i + 1, label: item.label, status: finish ? 'completed' : (i ? 'queued' : 'running') })) });
    if (/\/result$/.test(url)) return json({ ok: true });
    return json({ id: Number(url.split('/').at(-1)), label: 'work', status: finish ? 'completed' : 'running' });
  };
  const firstPage = browser(fetch);
  const one = firstPage.ServerQueue.run('first', () => firstPage.fetch('/api/work/first', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"n":1}' }));
  const two = firstPage.ServerQueue.run('second', () => firstPage.fetch('/api/work/second', { method: 'POST' }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(accepted.length, 2);
  assert.equal(accepted[0].label, 'first');
  assert.equal(accepted[1].label, 'second');
  const nextPage = browser(fetch);
  await nextPage.ServerQueue.refresh();
  assert.equal(nextPage.ServerQueue.state().activeItems.length, 1);
  assert.equal(nextPage.ServerQueue.state().items.length, 1);
  finish = true;
  await Promise.all([one, two]);
  await nextPage.ServerQueue.refresh();
  assert.equal(nextPage.ServerQueue.state().completed.length, 2);
  assert.equal(accepted.length, 2, 'reconnection never resubmits');
});

test('navigation reads and cancellation bypass the queue, endpoint errors stay errors', async () => {
  const calls = [];
  const window = browser(async (url, opts = {}) => {
    calls.push([url, opts.method]);
    if (url === '/api/queue' && opts.method === 'POST') return json({ id: 1, status: 'queued' }, 202);
    if (url === '/api/queue') return json({ items: [] });
    if (url === '/api/queue/1') return json({ id: 1, status: 'error', errorMessage: 'failed' });
    if (url.endsWith('/result')) return json({ error: 'bad input' }, 422);
    return json({ ok: true });
  });
  await window.fetch('/api/projects');
  await window.fetch('/api/projects/p/instances/actions/cancel', { method: 'POST' });
  const response = await window.fetch('/api/work', { method: 'POST' });
  assert.equal(response.status, 422);
  assert(calls.some(([url]) => url === '/api/projects'));
  assert(calls.some(([url]) => url.endsWith('/actions/cancel')));
});

test('automatically captured settings requests let the server name the action', async () => {
  let submitted;
  const window = browser(async (url, options = {}) => {
    if (url === '/api/queue' && options.method === 'POST') {
      submitted = JSON.parse(options.body);
      return json({ id: 1, label: 'Save VM settings · agentic-VM', status: 'queued' }, 202);
    }
    if (url === '/api/queue') return json({ items: [] });
    if (url.endsWith('/result')) return json({ ok: true });
    return json({ id: 1, label: 'Save VM settings · agentic-VM', status: 'completed' });
  });
  await window.fetch('/api/projects/p/vms/agentic-VM', {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: '{"viewable_to_user":true}',
  });
  assert.equal(submitted.label, undefined);
  assert.equal(submitted.steps[0].method, 'PATCH');
  assert.equal(submitted.steps[0].body.viewable_to_user, true);
});

test('multipart submission includes actual files and all repeated form fields', () => {
  const window = browser(async () => json({ items: [] }));
  const files = [];
  const form = new FormData();
  form.append('destination', '/opt/lab');
  form.append('tag', 'a'); form.append('tag', 'b');
  form.append('files', new Blob(['content']), 'hello.txt');
  const step = window.ServerQueue.requestStep('/api/upload', { method: 'POST', body: form }, files);
  assert.equal(step.form.filter(([key]) => key === 'tag').length, 2);
  assert.equal(step.files.length, 1);
  assert.equal(files[0][1].name, 'hello.txt');
});

test('inventory POST lookups and refreshes bypass active jobs, including inside runQueued', async () => {
  const calls = [];
  const window = browser(async (url, options = {}) => {
    calls.push([url, options]);
    if (url === '/api/queue') {
      assert.notEqual(options.method, 'POST', 'inventory reads must not submit jobs');
      return json({ items: [{ id: 1, label: 'Running VM action', status: 'running' }] });
    }
    return json({ nodes: ['node1'] });
  });
  await window.ServerQueue.refresh();
  const options = { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ baseUrl: 'https://proxmox.example', username: 'user', password: 'test' }) };
  for (const url of ['/api/proxmox/nodes', '/api/proxmox/nodes?refresh=1',
    '/api/proxmox/templates', '/api/proxmox/nodes/node1/network',
    '/api/projects/project-1/instances/refresh/vm',
    '/api/projects/project%202/instances/refresh/vm?forceRefresh=true']) {
    const response = await window.fetch(url, options);
    assert.deepEqual(await response.json(), { nodes: ['node1'] });
    await window.ServerQueue.run('Read inventory', () => window.fetch(url, options));
    const requests = calls.filter(([path]) => path === url);
    assert.equal(requests.length, 2);
    assert(requests.every(([, sent]) => sent === options), 'preserve credentials and request options');
  }
  assert.equal(window.ServerQueue.state().activeItems.length, 1);
  assert.equal(window.ServerQueue.state().items.length, 0);
});

test('VM plans capture every project and all create/delete follow-ups before submission', () => {
  const sandbox = {
    normalizeVmCreateOptions: opts => opts,
    normalizeVmDeleteOptions: opts => opts,
    deriveBaseVmName: (proj, name) => name.replace(/-lab1$/, ''),
    buildVmCreateUserAccessibilityPlan: () => ({ bases: ['vm'], indices: [1] }),
  };
  vm.createContext(sandbox); vm.runInContext(plans, sandbox);
  const projects = ['one', 'two'].map(id => ({ project: { id }, targets: [{ index: 1, name: 'vm-lab1' }], auth: { username: id } }));
  const steps = sandbox.buildServerVmSteps('create', { createOptions: {
    setNetworkInterfaces: true, takeSnapshot: true, enableUserAccessibility: true,
    createUsersAndPerms: true, applyScenario: true, startVm: true,
  } }, projects);
  assert.equal(steps.length, 10);
  assert.equal(steps[0].body.targets[0].name, 'vm');
  assert.equal(steps[4].url, '/api/projects/one/instances/actions/start');
  assert.equal(steps[5].body.username, 'two');
  const deletion = sandbox.buildServerVmSteps('delete', { deleteOptions: { disableUserAccessibility: true, deleteUsersAndPools: false, verifyCleanup: true } }, [projects[0]]);
  assert.equal(deletion.length, 3);
  assert.equal(deletion[0].body.viewable_to_user, false);
  assert.equal(deletion[1].body.enable, false);
  assert.equal(deletion[2].body.deleteUsersAndPools, false);
  assert.equal(deletion[2].body.verifyCleanup, true);
});

test('wizard captures dynamically created project references and per-template accessibility', () => {
  const sandbox = {
    wizardNormalizeVmCreateOptions: value => value,
    wizardBuildUserAccessibilityPlan: () => ({ bases: ['public', 'private'], indices: [1], accessibilityByBase: new Map([['public', true], ['private', false]]) }),
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync('app/static/js/server_workflows.js', 'utf8'), sandbox);
  const steps = sandbox.buildServerWizardSteps({ name: 'lab', instances: 1, vms: [{ name: 'public' }, { name: 'private' }] }, {
    createVms: true, createCtfdUsers: true,
    createOptions: { enableUserAccessibility: true, createUsersAndPerms: false, startVm: true },
  }, { vmUser: 'u', vmPass: 'p', ctfdToken: 't' });
  assert.equal(steps[0].url, '/api/projects');
  assert(steps.slice(1).every(step => step.projectFromStep === 0));
  const patches = steps.filter(step => step.method === 'PATCH');
  assert.equal(patches[0].body.viewable_to_user, true);
  assert.equal(patches[1].body.viewable_to_user, false);
  const syncs = steps.filter(step => step.url.endsWith('/users_access_sync'));
  assert.equal(syncs.length, 2);
  assert.equal(syncs[0].body.enable, true);
  assert.equal(syncs[1].body.enable, false);
  assert.equal(steps.at(-1).url, '/api/projects/$project/ctfd/users_create');
});

test('queue progress renders each job independently, escapes status, and handles unknown percentages', () => {
  const shell = fs.readFileSync('app/static/js/shell.js', 'utf8');
  const helper = shell.slice(shell.indexOf('function renderRemoteQueueProgress('), shell.indexOf('function clearCompletedRemoteActions('));
  const sandbox = { escapeHtml: value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;') };
  vm.createContext(sandbox); vm.runInContext(helper, sandbox);
  const measured = sandbox.renderRemoteQueueProgress({ label: 'Create "VM"', progress: 70,
    step: 2, totalSteps: 3, message: 'Cloning <vm1>' });
  assert.match(measured, /aria-valuenow="70"/);
  assert.match(measured, /width:70%/);
  assert.match(measured, /Step 2 of 3/);
  assert.match(measured, /Cloning &lt;vm1&gt;/);
  assert.match(measured, /Create &quot;VM&quot; progress/);
  assert.doesNotMatch(measured, /progress-bar-animated/);
  for (const progress of [null, undefined, '', NaN]) {
    const unknown = sandbox.renderRemoteQueueProgress({ label: 'Upload', progress, cancelRequested: true, phase: 'guest_push', current: 'vm2' });
    assert.match(unknown, /progress-bar-animated/);
    assert.match(unknown, /Cancelling/);
    assert.match(unknown, /guest push · vm2/);
    assert.doesNotMatch(unknown, /aria-valuenow|Cloning|70%/);
  }
  assert.match(sandbox.renderRemoteQueueProgress({ progress: 0 }), /aria-valuenow="0"/);
  assert.match(sandbox.renderRemoteQueueProgress({ progress: 200 }), /width:100%/);
});
