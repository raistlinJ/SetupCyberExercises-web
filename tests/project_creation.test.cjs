const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function extract(path, name) {
  const source = fs.readFileSync(path, 'utf8');
  const start = source.search(new RegExp(`(?:async )?function ${name}\\(`));
  assert.ok(start >= 0, name);
  return source.slice(start, source.indexOf('\n}', start) + 2);
}

test('manager project creation carries the name to the chooser without creating a project', () => {
  for (const path of ['app/static/js/vm_manager.js', 'app/static/js/ctfd_manager.js']) {
    let requested = 0;
    const c = {shell: {startProjectCreation: () => requested++}};
    vm.runInNewContext(extract(path, 'createProjectSidebar') + '\ncreateProjectSidebar();', c);
    assert.equal(requested, 1);
  }
  const c = {document: {getElementById: () => ({value: '  Quest & castle #1  '})}, location: {}, encodeURIComponent, alert() {}};
  c.window = c;
  vm.runInNewContext(extract('app/static/js/shell.js', 'startProjectCreation') + '\nstartProjectCreation();', c);
  assert.equal(new URL(c.location.href, 'http://localhost').searchParams.get('newProject'), 'Quest & castle #1');
});

test('the handoff opens the Manual/Wizard chooser once and preserves unrelated URL state', async () => {
  const input = {value: ''};
  const modal = {};
  let shown = 0, resets = 0;
  const c = {URL, document: {getElementById: id => id === 'proj-name' ? input : modal},
    location: {href: 'http://localhost/?newProject=Quest+%26+castle&other=1#settings'},
    history: {state: {}, replaceState(state, title, url) {c.location.href = new URL(url, c.location.href).href;}},
    resetWizard() {resets++;}, bootstrap: {Modal: {getOrCreateInstance: el => {assert.equal(el, modal); return {show() {shown++;}};}}},
  };
  c.window = c;
  vm.createContext(c);
  for (const name of ['createProject', 'openRequestedProjectCreation']) vm.runInContext(extract('app/static/js/app.js', name), c);
  c.openRequestedProjectCreation();
  assert.equal(input.value, 'Quest & castle');
  assert.equal(shown, 1);
  assert.equal(resets, 1);
  assert.equal(c.location.href, 'http://localhost/?other=1#settings');
  c.openRequestedProjectCreation();
  assert.equal(shown, 1);
});
