const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const materialsSource = fs.readFileSync('app/static/js/vm_materials.js', 'utf8');
const appSource = fs.readFileSync('app/static/js/app.js', 'utf8');
const links = [{title: 'Reference PDF', url: 'https://example.edu/reference.pdf'}];

function editor(response) {
  const error = {classList: {add() {}, remove() {}}, textContent: ''};
  const summary = {};
  const form = {reportValidity: () => true, querySelectorAll: () => []};
  const list = {children: links.map(link => ({querySelector: selector => ({value: link[selector.includes('title') ? 'title' : 'url']})}))};
  const fields = {'form': form, '#vm-materials-error': error, '#vm-materials-list': list,
    '#vm-materials-category': {value: 'Course materials'}};
  const modal = {querySelector: selector => fields[selector]};
  const project = {id: 'p', vms: [{name: 'web', materials: [], material_category: ''}]};
  const calls = [], notices = [], statuses = [];
  let hidden = false;
  const context = {
    state: {pid: 'p', idx: 0, name: 'web', saving: false}, URL,
    window: {PROJ_CACHE: {p: project}}, console: {error() {}},
    document: {getElementById: id => id === 'vmMaterialsModal' ? modal : summary},
    bootstrap: {Modal: {getInstance: () => ({hide() { hidden = true; }})}},
    showToast: (...args) => notices.push(args), setVmStatus: (...args) => statuses.push(args),
    http: async (method, url, body) => { calls.push({method, url, body}); return response; },
  };
  vm.createContext(context);
  vm.runInContext(appSource.slice(appSource.indexOf('async function saveVM('), appSource.indexOf('function startVmRename(')), context);
  vm.runInContext(materialsSource.slice(materialsSource.indexOf('function updateSummary('), materialsSource.indexOf('window.openVmMaterialsManager =')), context);
  return {context, project, calls, notices, statuses, error, summary, hidden: () => hidden};
}

test('materials save uses the server response and updates the editor only after persistence is confirmed', async () => {
  const saved = {id: 'p', vms: [{name: 'web', materials: links, material_category: 'Course materials'}]};
  const e = editor(saved);
  await e.context.save({preventDefault() {}});
  assert.equal(e.hidden(), true);
  assert.equal(e.calls.length, 1, 'Saving configuration does not apply materials to live guests');
  assert.equal(e.calls[0].method, 'PATCH');
  assert.equal(e.calls[0].url, '/api/projects/p/vms/web');
  assert.deepEqual(JSON.parse(JSON.stringify(e.calls[0].body)), {materials: links, material_category: 'Course materials'});
  assert.deepEqual(e.project.vms[0].materials, links);
  assert.equal(e.summary.textContent, '1 link · Course materials');
  assert.deepEqual(e.notices, [['Materials saved.', 'success']]);
});

test('an older backend that ignores materials cannot report a successful save', async () => {
  for (const response of [
    {vms: [{name: 'web'}]},
    {vms: [{name: 'web', materials: [], material_category: ''}]},
    {vms: [{name: 'web', materials: [{title: 'Old', url: 'https://example.edu/old'}], material_category: 'Course materials'}]},
  ]) {
    const e = editor(response);
    await e.context.save({preventDefault() {}});
    assert.equal(e.hidden(), false);
    assert.equal(e.notices.length, 0);
    assert.match(e.error.textContent, /server did not retain.*Restart DeployForge/);
    assert.deepEqual(e.project.vms[0].materials, []);
    assert.equal(e.statuses.at(-1)[2], 'Save failed');
  }
});
