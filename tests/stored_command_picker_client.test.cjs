const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('app/static/js/vm_manager.js', 'utf8');
const appSource = fs.readFileSync('app/static/js/app.js', 'utf8');

class Element {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase(); this.children = []; this.dataset = {}; this.listeners = {};
    this.className = ''; this.value = ''; this.checked = false;
    this.classList = {
      contains: value => this.className.split(' ').includes(value),
      add: value => { if (!this.classList.contains(value)) this.className += ' ' + value; },
      remove: value => { this.className = this.className.split(' ').filter(x => x !== value).join(' '); },
      toggle: (value, enabled) => { this.classList[enabled ? 'add' : 'remove'](value); },
    };
  }
  set innerHTML(value) { this.children = []; this.html = value; }
  get innerHTML() { return this.html || ''; }
  appendChild(child) { child.parent = this; this.children.push(child); return child; }
  setAttribute(name, value) {
    if (name.startsWith('data-')) this.dataset[name.slice(5).replace(/-([a-z])/g, (_, x) => x.toUpperCase())] = value;
    else this[name] = value;
  }
  matches(selector) {
    const tag = selector.match(/^[a-z]+/i)?.[0];
    if (tag && this.tagName.toLowerCase() !== tag) return false;
    return [...selector.matchAll(/\[([^=\]]+)(?:="([^"]*)")?\]/g)].every(([, key, expected]) => {
      const actual = key.startsWith('data-') ? this.dataset[key.slice(5).replace(/-([a-z])/g, (_, x) => x.toUpperCase())] : this[key];
      return expected === undefined ? actual !== undefined : actual === expected;
    });
  }
  querySelectorAll(selector) { return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  closest(selector) { return this.matches(selector) ? this : this.parent?.closest(selector); }
  addEventListener(type, listener) { (this.listeners[type] ||= new Set()).add(listener); }
  removeEventListener(type, listener) { this.listeners[type]?.delete(listener); }
  fire(type, target = this) {
    const event = {type, target, stopPropagation() {}, preventDefault() {}};
    for (const listener of this.listeners[type] || []) listener(event);
  }
  focus() {}
}

function picker({mixed = false} = {}) {
  const elements = Object.fromEntries(['storedCmdPickerModal', 'stored-cmd-picker-summary', 'stored-cmd-picker-missing',
    'stored-cmd-picker-list', 'stored-cmd-picker-empty', 'stored-cmd-picker-error', 'stored-cmd-picker-run']
    .map(id => [id, new Element()]));
  const project = {id: 'p', name: 'Lab', tag: '-set-', vms: [{name: 'core', template_name: 'same', template_id: 9000,
    stored_commands: [{commands: [
      {command: 'echo {{instance_index}}', render_template_variables: true},
      {command: 'echo {{literal}}', render_template_variables: false},
    ]}],
  }]};
  if (mixed) project.vms.push({...project.vms[0], name: 'other', stored_commands: [{commands: [
    {command: 'echo {{instance_index}}', render_template_variables: false},
  ]}]});
  const document = new Element();
  document.createElement = tag => new Element(tag);
  document.getElementById = id => elements[id];
  const modal = {show() {}, hide() { elements.storedCmdPickerModal.fire('hidden.bs.modal'); }};
  const Modal = function () {};
  Modal.getOrCreateInstance = () => modal;
  const context = {
    window: {bootstrap: {Modal}}, document, console, setTimeout,
    canonicalPid: value => String(value || ''), vmIsMulti: () => false, PROJ: project, STORED_CMD_SAMPLE_LIMIT: 4,
    VM_DEFAULT_COMMAND_TIMEOUT_SECONDS: 300, DEFAULT_COMMAND_TIMEOUT_SECONDS: 300,
    listSelectedEntries: () => project.vms.map(v => ({pid: 'p', pidCanonical: 'p', name: v.name + '-set-1', index: 1})),
    deriveBaseVmName: (_, name) => name.replace('-set-1', ''),
    findVmConfigByBaseName: (_, name) => project.vms.find(v => v.name === name),
    getProjectSnapshot: () => project,
    normalizeCommandTimeout: value => Number(value) || 300,
    alert: message => assert.fail(message),
  };
  context.bootstrap = context.window.bootstrap;
  vm.createContext(context);
  vm.runInContext(appSource.slice(appSource.indexOf('function sanitizeStartCommandSteps('), appSource.indexOf('function encodeStartCommandsValue(')), context);
  vm.runInContext(source.slice(source.indexOf('const STORED_CMD_CORE ='), source.indexOf('function openStoredCommandsManagerForContext(')), context);
  vm.runInContext(source.slice(source.indexOf('async function promptStoredCommandSelection('), source.indexOf('const VM_ACTION_QUEUE_PERSIST_KEY')), context);
  const result = context.promptStoredCommandSelection();
  const list = elements['stored-cmd-picker-list'];
  return {context, project, document, elements, list, modal, result,
    commands: () => list.querySelectorAll('[data-stored-cmd]'),
    renders: () => list.querySelectorAll('[data-stored-render]'),
    run: () => elements['stored-cmd-picker-run'].fire('click'),
  };
}

test('picker reflects saved render settings and leaves them unchanged without an override', async () => {
  const p = picker();
  assert.deepEqual(p.renders().map(input => input.checked), [true, false]);
  assert(p.list.querySelectorAll('[data-stored-command-row]').every(row => row.tagName === 'DIV'));
  p.commands().forEach(input => { input.checked = true; });
  p.run();
  assert.deepEqual(Array.from(await p.result), ['echo {{instance_index}}', 'echo {{literal}}']);
});

test('picker includes render-only overrides, keeps selection separate, and preserves choices after inline edits', async () => {
  const p = picker();
  const render = p.renders()[0];
  render.checked = false; render.fire('change');
  assert.equal(p.commands()[0].checked, false);
  p.commands()[0].checked = true;
  p.project.vms[0].stored_commands[0].commands[0].command = 'echo updated {{instance_index}}';
  p.document.fire('stored-commands-updated');
  assert.equal(p.renders()[0].checked, false);
  p.commands()[0].checked = true;
  p.run();
  const result = JSON.parse(JSON.stringify(await p.result));
  assert.deepEqual(result, {commands: ['echo updated {{instance_index}}'], overrides: [
    {templateKey: 'p|same|9000', stepIndex: 1, commandIndex: 1, renderTemplateVariables: false},
  ]});
  const interpreted = p.context.interpretStoredCommandSelection(result);
  assert.equal(interpreted.overrides[0].renderTemplateVariables, false);
  assert.equal(p.project.vms[0].stored_commands[0].commands[0].render_template_variables, true);
});

test('mixed saved render settings remain untouched unless the user chooses a mode', async () => {
  const p = picker({mixed: true});
  assert.equal(p.renders()[0].indeterminate, true);
  p.commands()[0].checked = true;
  p.run();
  assert.deepEqual(Array.from(await p.result), ['echo {{instance_index}}']);
  const changed = picker({mixed: true});
  changed.commands()[0].checked = true;
  const input = changed.renders()[0];
  input.checked = true; input.fire('change');
  assert.equal(input.indeterminate, false);
  changed.run();
  assert.equal((await changed.result).overrides[0].renderTemplateVariables, true);
});

test('cancelling discards render changes and reopening uses saved settings', async () => {
  const p = picker();
  p.renders()[0].checked = false; p.renders()[0].fire('change');
  p.modal.hide();
  assert.equal(await p.result, null);
  const reopened = p.context.promptStoredCommandSelection();
  assert.equal(p.renders()[0].checked, true);
  p.modal.hide();
  assert.equal(await reopened, null);
});
