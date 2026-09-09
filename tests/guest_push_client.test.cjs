const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const manager = fs.readFileSync('app/static/js/vm_manager.js', 'utf8');
const plans = fs.readFileSync('app/static/js/server_vm_actions.js', 'utf8');

function functionSource(name, next) {
  return manager.slice(manager.indexOf(`function ${name}(`), manager.indexOf(next, manager.indexOf(`function ${name}(`)));
}

function pushDialog(owner, permissions, selectionType = 'file', options = {}) {
  const elements = new Map();
  for (const [id, value] of Object.entries({
    'lxc-push-destination': '/opt/scenario', 'lxc-push-owner': owner,
    'lxc-push-permissions': permissions, 'lxc-push-error': '', 'lxc-push-confirm': '',
    'lxc-push-files': '', 'lxc-push-folder': '',
  })) elements.set(id, { value, classList: { remove() {} }, addEventListener(event, fn) { this[event] = fn; } });
  const file = new Blob(['hello']);
  file.name = 'hello.txt';
  file.webkitRelativePath = selectionType === 'folder' ? 'bundle/hello.txt' : '';
  elements.get(`lxc-push-${selectionType === 'folder' ? 'folder' : 'files'}`).files = [file];
  let saved, queued;
  const sandbox = {
    document: { getElementById: id => elements.get(id), querySelector: () => ({ value: selectionType }), querySelectorAll: () => [] },
    window: {
      ServerQueue: options.serverQueue,
      PersistentQueuePayloads: options.noStorage ? undefined : {
        async put(id, data) {
          if (options.storageError) throw options.storageError;
          saved = data;
        },
      },
    },
    serializeGuestTransferGroups: () => [{ pid: 'p', targets: [{ index: 1, name: 'vm' }] }],
    groupSelectedGuestEntriesByProject() {}, hideLxcSetupModal: async () => {},
    GUEST_TRANSFER_QUEUE_PERSIST_KEY: 'vm-manager-guest-transfer-v1',
    runQueued: async (label, fn, opts) => {
      queued = opts;
      return options.runQueued?.(label, fn, opts);
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(functionSource('wireLxcTransferModals', "document.addEventListener('DOMContentLoaded', wireLxcTransferModals)"), sandbox);
  sandbox.wireLxcTransferModals();
  return {
    async submit() { await elements.get('lxc-push-confirm').click(); return { saved, queued, error: elements.get('lxc-push-error').textContent }; },
  };
}

test('push dialog persists advanced options for files and folders', async () => {
  for (const type of ['file', 'folder']) {
    const { saved, queued, error } = await pushDialog(' www-data ', ' 0755 ', type).submit();
    assert.equal(error, undefined);
    assert.equal(saved.ownerOnRemote, 'www-data');
    assert.equal(saved.filePermissions, '0755');
    assert.equal(queued.persist.data.ownerOnRemote, 'www-data');
    assert.equal(queued.persist.data.filePermissions, '0755');
    assert.equal(queued.persist.data.relativePaths[0], type === 'folder' ? 'bundle/hello.txt' : 'hello.txt');
    assert.equal(queued.runtimePayload, saved);
  }
});

test('push dialog rejects invalid options before storing or queueing files', async () => {
  for (const [owner, permissions] of [['-R', '644'], ['root;id', '644'], ['root', '888'], ['root', 'u+rwx']]) {
    const result = await pushDialog(owner, permissions).submit();
    assert.ok(result.error);
    assert.equal(result.saved, undefined);
    assert.equal(result.queued, undefined);
  }
  const blank = await pushDialog('', '').submit();
  assert.ok(blank.queued);
});

test('server uploads bypass failing or unavailable browser storage and send bytes with advanced options', async () => {
  for (const type of ['file', 'folder']) {
    for (const noStorage of [false, true]) {
      let submission;
      const window = {
        location: { href: 'http://localhost/static/vm_manager.html', origin: 'http://localhost' },
        async fetch(url, options) {
          if (url === '/api/queue' && options?.method === 'POST') {
            submission = options.body;
            return new Response(JSON.stringify({ id: 1, status: 'queued' }));
          }
          return new Response(JSON.stringify({ items: [] }));
        },
      };
      const sandbox = {
        window, FormData, Headers, Blob, URL, CustomEvent: class {},
        document: { dispatchEvent() {} }, setInterval() {},
        guestTransferAuthPayload: async () => ({}),
      };
      vm.createContext(sandbox);
      vm.runInContext(fs.readFileSync('app/static/js/server_queue.js', 'utf8'), sandbox);
      sandbox.ServerQueue = window.ServerQueue;
      vm.runInContext(plans, sandbox);
      window.submitServerGuestTransfer = sandbox.submitServerGuestTransfer;
      sandbox.finishServerVmAction = async () => ({ status: 'completed' });
      const result = await pushDialog('www-data', '0755', type, {
        serverQueue: window.ServerQueue,
        runQueued: window.ServerQueue.run,
        storageError: new Error('Failed to write blobs (InvalidBlob)'),
        noStorage,
      }).submit();
      assert.equal(result.error, undefined);
      assert.equal(result.saved, undefined);
      assert.equal(result.queued.persist.data.payloadId, null);
      const plan = JSON.parse(submission.get('plan'));
      assert.equal(plan.steps.length, 1);
      const step = plan.steps[0];
      const body = JSON.parse(step.form.find(([key]) => key === 'payload')[1]);
      assert.equal(body.ownerOnRemote, 'www-data');
      assert.equal(body.filePermissions, '0755');
      assert.equal(body.destination, '/opt/scenario');
      assert.equal(body.relativePaths[0], type === 'folder' ? 'bundle/hello.txt' : 'hello.txt');
      const uploaded = submission.get(step.files[0][1]);
      assert.equal(uploaded.name, 'hello.txt');
      assert.equal(await uploaded.text(), 'hello');
    }
  }
});

test('legacy browser queue still requires durable storage before enqueueing', async () => {
  for (const options of [
    { noStorage: true },
    { storageError: new Error('Failed to write blobs (InvalidBlob)') },
  ]) {
    const result = await pushDialog('www-data', '0755', 'file', options).submit();
    assert.ok(result.error);
    assert.equal(result.queued, undefined);
  }
});

test('server and browser queue paths preserve advanced options when restored', async () => {
  for (const queue of ['server', 'browser']) {
    for (const source of ['payload', 'descriptor', 'old']) {
      const options = source === 'old' ? {} : { ownerOnRemote: '1000', filePermissions: '000' };
      const payload = { destination: '/opt/scenario', files: [{ blob: new Blob(['hello']), name: 'hello.txt' }], ...(source === 'payload' ? options : {}) };
      const descriptor = { kind: 'push', payloadId: 'saved', groups: [{ pid: 'p', targets: [] }], relativePaths: ['hello.txt'], selectionType: 'file', ...(source === 'descriptor' ? options : {}) };
      let sent;
      const storage = { get: async () => payload, remove: async () => {} };
      const sandbox = {
        FormData, encodeURIComponent, PersistentQueuePayloads: storage, window: { PersistentQueuePayloads: storage },
        guestTransferAuthPayload: async () => ({}), ensureGuestTransferProjects: async () => {},
        deserializeGuestTransferGroups: groups => groups, runGuestTransfer: async (label, fn) => fn('p', [], {}),
        fetch: async (url, opts) => { sent = JSON.parse(opts.body.get('payload')); return { ok: true, text: async () => '{}' }; },
        ServerQueue: {
          requestStep: (url, opts) => { sent = JSON.parse(opts.body.get('payload')); return {}; },
          submit: async () => ({}),
        },
      };
      vm.createContext(sandbox);
      if (queue === 'server') {
        vm.runInContext(plans, sandbox);
        sandbox.finishServerVmAction = async () => {};
        await sandbox.submitServerGuestTransfer('Push', descriptor, {});
      } else {
        const start = manager.indexOf('async function executePersistedGuestTransfer(');
        vm.runInContext(manager.slice(start, manager.indexOf("if (typeof window.registerRemoteActionHandler", start)), sandbox);
        await sandbox.executePersistedGuestTransfer(descriptor);
      }
      assert.equal(sent.ownerOnRemote, options.ownerOnRemote || '');
      assert.equal(sent.filePermissions, options.filePermissions || '');
      assert.equal(sent.destination, '/opt/scenario');
    }
  }
});
