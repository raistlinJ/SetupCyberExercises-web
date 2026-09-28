const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

test('queued pulls auto-download every archive on success and failure and retain manual links', async () => {
  const manager = fs.readFileSync('app/static/js/vm_manager.js', 'utf8');
  for (const status of ['completed', 'error']) {
    const clicks = [];
    const anchors = [];
    const element = () => ({ appendChild() {}, innerHTML: '' });
    const body = element();
    const sandbox = {
      window: {}, Blob, Uint8Array, atob,
      URL: { createObjectURL: () => 'blob:archive' },
      document: {
        getElementById: id => id === 'action-summary-body' ? body : null,
        createElement: tag => {
          const node = element();
          if (tag === 'a') { node.click = () => clicks.push(node.download); anchors.push(node); }
          return node;
        },
      },
      console: { warn: error => { throw error; }, error: error => { throw error; } },
      ServerQueue: {
        wait: async () => ({ status, errorMessage: status === 'error' ? 'Some pulls failed' : '' }),
        nativeFetch: async () => ({ json: async () => ({ results: ['one', 'two'].map(name => ({
          errors: status === 'error' ? [{ reason: 'file not found' }] : [],
          outputs_zip: { filename: `${name}.zip`, base64: 'UEs=', auto_download: true },
        })) }) }),
      },
      mergeVmActionSummaryData: (merged, item) => ({ ...merged, ...item }),
      emitActionLogs() {}, vmRefresh: async () => {},
    };
    vm.createContext(sandbox);
    vm.runInContext(manager.slice(manager.indexOf('function showActionSummary(')), sandbox);
    vm.runInContext(fs.readFileSync('app/static/js/server_vm_actions.js', 'utf8'), sandbox);
    await sandbox.finishServerVmAction('Pull Files', { id: 1 });
    assert.deepEqual(clicks, ['one.zip', 'two.zip']);
    assert.equal(anchors.length, 2);
    assert.ok(anchors.every(link => link.href === 'blob:archive'));
    sandbox.showActionSummary('Run Commands', { outputs_zip: { filename: 'commands.zip', base64: 'UEs=' } });
    assert.deepEqual(clicks, ['one.zip', 'two.zip'], 'command archives remain manual downloads');
  }
});
