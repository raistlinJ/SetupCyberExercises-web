const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('app/static/js/app.js', 'utf8');
function functionSource(name) {
  let start = source.indexOf(`async function ${name}(`);
  if (start < 0) start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, name);
  return source.slice(start, source.indexOf('\n}', start) + 2);
}
function browser() {
  const elements = new Map();
  const node = id => {
    if (!elements.has(id)) elements.set(id, {style: {}, classList: {toggle(){}, add(){}, remove(){}},
      setAttribute(name, value) {this[name] = value;}, removeAttribute(name) {delete this[name];}});
    return elements.get(id);
  };
  const sandbox = {document: {getElementById: node}, console, Response};
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  for (const name of ['_fmtBytes', '_fmtByteProgress', '_renderArchiveProgress']) {
    vm.runInContext(functionSource(name), sandbox);
  }
  return {node, sandbox};
}

test('import progress shows the upload step, overall percentage, item counts, and measured bytes', () => {
  const {node, sandbox} = browser();
  sandbox._renderArchiveProgress('imp', {progress: 50, operationStep: 3, operationTotalSteps: 5,
    phaseProgress: 50, bytesDone: 1048576, bytesTotal: 2097152, itemCompleted: 1, itemTotal: 3,
    current: 'guide.txt', message: 'Extracting Materials'}, {upload: true});
  assert.equal(node('imp-status').textContent, 'Extracting Materials');
  assert.match(node('imp-detail').textContent, /Step 4 of 6/);
  assert.match(node('imp-detail').textContent, /55% overall.*50% of this step.*1 of 3 items/);
  assert.match(node('imp-detail').textContent, /1\.00 MB \/ 2\.00 MB.*guide.txt/);
  assert.equal(node('imp-prog-bar')['aria-valuenow'], '55');
});

test('unknown totals stay indeterminate and failures preserve the last measured percentage', () => {
  const {node, sandbox} = browser();
  sandbox._renderArchiveProgress('imp', {progress: null, bytes_done: 2048, bytes_total: null,
    message: 'Uploading ZIP'}, {upload: true, uploading: true});
  assert.equal(node('imp-prog-bar')['aria-valuenow'], undefined);
  assert.match(node('imp-detail').textContent, /Step 1 of 6.*2\.00 KB \/ \?/);
  assert.doesNotMatch(node('imp-detail').textContent, /100%/);
  sandbox._renderArchiveProgress('imp', {progress: 42});
  sandbox._renderArchiveProgress('imp', {status: 'error', message: 'Import failed'});
  assert.equal(node('imp-prog-bar').style.width, '42%');
  assert.equal(node('imp-status').textContent, 'Import failed');
});

test('queued imports forward upload bytes and live operation updates before the result is available', async () => {
  const {sandbox} = browser();
  let release;
  const pending = new Promise(resolve => {release = resolve;});
  const uploads = [], operations = [], accepted = [];
  let finished = false;
  sandbox.ServerQueue = {
    requestStep: () => ({url:'/api/projects/import/start', method:'POST'}),
    async submit(_label, _steps, options) {
      options.onUploadProgress({loaded:100, total:200});
      return {id:7};
    },
    async wait(job, update) {
      assert.equal(job.id, 7);
      update({progress:42, operationStep:3, bytesDone:1024, bytesTotal:2048});
      await pending;
      finished = true;
    },
    async result() {assert.equal(finished, true); return Response.json({job:'child'});},
  };
  vm.runInContext(functionSource('_xhrPostFormData'), sandbox);
  const result = sandbox._xhrPostFormData('/api/projects/import/start', {}, {
    onProgress: (...args) => uploads.push(args), onOperation: state => operations.push(state),
    onAccepted: job => accepted.push(job.id),
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(uploads, [[50, 100, 200]]);
  assert.deepEqual(accepted, [7]);
  assert.equal(operations[0].bytesDone, 1024);
  assert.equal(finished, false);
  release();
  assert.equal((await result).job, 'child');
});

test('configuration export opens its progress modal before queue submission and needs no Proxmox credentials', async () => {
  const {node, sandbox} = browser();
  let visible = false;
  const timers = [];
  sandbox.bootstrap = {Modal: class {show(){visible = true;} hide(){}}};
  sandbox.readBestProxCreds = () => ({});
  sandbox.setTimeout = callback => timers.push(callback);
  sandbox.alert = message => {throw new Error(message);};
  sandbox.ServerQueue = {
    async submit(_label, steps) {
      assert.equal(visible, true, 'The modal must open before waiting for queue completion');
      assert.equal(steps[0].body.includeVms, false);
      return {id:1};
    },
    async wait(_job, update) {update({progress:50, operationStep:2, operationTotalSteps:3,
      phaseProgress:50, bytesDone:1024, bytesTotal:2048, message:'Compressing ZIP archive'});},
    async result() {return Response.json({job:'export-child'});},
  };
  sandbox.http = async (_method, url) => url.endsWith('/exports')
    ? {exports:[{id:'export-child', exists:true, local_path:'/exports/ready.zip', size:2048}]}
    : {id:'a-newer-export', status:'running', progress:10};
  vm.runInContext(functionSource('startExportJob'), sandbox);
  await sandbox.startExportJob('project', {includeVms:false});
  assert.match(node('exp-detail').textContent, /Step 2 of 3.*50% overall/);
  assert.match(node('exp-detail').textContent, /1\.00 KB \/ 2\.00 KB/);
  await timers.shift()();
  assert.equal(node('exp-prog-bar')['aria-valuenow'], '100');
  assert.equal(node('exp-download-final').href, '/api/projects/project/exports/export-child/download');
  assert.match(node('exp-detail').textContent, /ZIP size: 2\.00 KB/);
});

test('cancelling a queued import does not try to read a child result that may not exist', async () => {
  const {sandbox} = browser();
  sandbox.ServerQueue = {
    requestStep: () => ({}), submit: async () => ({id:7}),
    wait: async () => ({status:'cancelled'}),
    result: async () => {throw new Error('A cancelled job has no child result');},
  };
  vm.runInContext(functionSource('_xhrPostFormData'), sandbox);
  await assert.rejects(sandbox._xhrPostFormData('/api/projects/import/start', {}),
    error => error.code === 'import_cancelled');
});

test('Queue displays archive steps and source bytes separately from outer request counts', () => {
  const shell = fs.readFileSync('app/static/js/shell.js', 'utf8');
  const helper = shell.slice(shell.indexOf('function renderRemoteQueueProgress('), shell.indexOf('function clearCompletedRemoteActions('));
  const sandbox = {escapeHtml: String};
  vm.createContext(sandbox); vm.runInContext(helper, sandbox);
  const html = sandbox.renderRemoteQueueProgress({progress:50, step:1, totalSteps:1,
    operationStep:3, operationTotalSteps:6, phaseProgress:25, bytesDone:1048576, bytesTotal:4194304,
    fileBytesDone:524288, fileBytesTotal:2097152});
  assert.match(html, /Step 3 of 6/);
  assert.match(html, /Current step: 25%/);
  assert.match(html, /Bytes: 1\.0 MiB \/ 4\.0 MiB/);
  assert.match(html, /Current file: 512\.0 KiB \/ 2\.0 MiB/);
});
