const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../app/static/js/app.js'), 'utf8');
const implementation = source.slice(source.indexOf('function createCommandTemplatePanel('), source.indexOf('function renderStartCommandsModal()'));

async function run() {
  const elements = {};
  let panel;
  let request;
  const timers = new Map();
  let nextTimer = 0;
  const state = { pid: 'course', vmName: 'core', steps: [{ commands: [
    { command: 'configure {{instance_index}}', enabled: true },
    { command: 'echo {{unknown}}', enabled: true, renderTemplateVariables: false },
    { command: 'do-not-run', enabled: false },
  ] }] };
  const context = {
    AbortController,
    setTimeout: callback => { timers.set(++nextTimer, callback); return nextTimer; },
    clearTimeout: timer => timers.delete(timer),
    START_COMMAND_MODAL_STATE: state, STORED_COMMAND_MODAL_STATE: state,
    window: { PROJ_CACHE: { course: {} } },
    document: {
      getElementById: id => elements[id],
      querySelector: () => ({ prepend: value => { panel = value; elements[value.id] = value; } }),
      createElement: tag => {
        if (tag === 'option') return {};
        const help = { hidden: true };
        const picker = { hidden: true };
        const selector = { disabled: true, options: [], value: '',
          replaceChildren() { this.options = []; }, append(option) { this.options.push(option); },
          addEventListener: (_, callback) => { selector.change = callback; } };
        const helpButton = { setAttribute: (key, value) => { helpButton[key] = value; },
          addEventListener: (_, callback) => { helpButton.click = callback; } };
        const preview = { addEventListener: (_, callback) => { preview.click = callback; } };
        const output = { textContent: '' };
        const node = { tagName: tag, addEventListener: (_, callback) => { node.input = callback; }, querySelector: query => {
          if (query === '[data-role="template-help"]') return helpButton;
          if (query === '[data-role="template-preview"]') return preview;
          if (query === '[data-role="template-preview-picker"]') return picker;
          if (query.endsWith('-preview-selection')) return selector;
          if (query === 'pre') return output;
          return help;
        } };
        Object.defineProperty(node, 'innerHTML', { set(value) {
          node.html = value;
          elements[`${node.id.replace('-template-controls', '')}-template-preview`] = output;
        }, get() { return node.html; } });
        return node;
      },
    },
    http: async (method, url, payload) => {
      request = { method, url, payload };
      return { previews: [{ name: 'core-set-7', index: 7, commands: ['configure 7', 'echo {{unknown}}'] }] };
    },
  };
  vm.createContext(context);
  vm.runInContext(implementation, context);
  elements['start-preview-index'] = { value: '7' };
  elements['start-preview-vmid'] = { value: '' };
  context.ensureCommandTemplatePreview('start');
  assert.match(panel.innerHTML, /Template variables and command preview/);
  assert.equal(panel.tagName, 'details');
  assert.match(panel.innerHTML, /<summary[^>]*>Advanced<\/summary>/);
  const help = panel.querySelector('#start-template-help');
  assert.equal(help.hidden, true);
  panel.querySelector('[data-role="template-help"]').click();
  assert.equal(help.hidden, false);
  assert.equal(panel.querySelector('[data-role="template-help"]')['aria-expanded'], 'true');
  assert.match(panel.innerHTML, /{{instance_index}}/);
  assert.doesNotMatch(panel.innerHTML, /uplink_|CORE/);
  await panel.querySelector('[data-role="template-preview"]').click();
  assert.equal(request.url, '/api/projects/course/commands/preview');
  assert.equal(request.payload.targets[0].index, 7);
  assert.equal(request.payload.commands.length, 2);
  assert.equal(request.payload.commands[0].render_template_variables, true);
  assert.equal(request.payload.commands[1].render_template_variables, false);
  const output = panel.querySelector('pre');
  const selector = panel.querySelector('#start-preview-selection');
  const picker = panel.querySelector('[data-role="template-preview-picker"]');
  assert.equal(selector.options.length, 2);
  assert.equal(selector.disabled, false);
  assert.equal(picker.hidden, false);
  assert.match(selector.options[0].textContent, /course \/ core-set-7.*Command 1 \(Rendered\)/);
  assert.equal(output.textContent, '[Rendered]\nconfigure 7');
  selector.value = '1';
  panel.input({ target: selector });
  selector.change();
  assert.equal(output.textContent, '[Literal]\necho {{unknown}}');

  context.invalidateCommandTemplatePreview('start');
  assert.match(output.textContent, /Settings changed/);
  assert.equal(selector.options.length, 0);
  assert.equal(selector.disabled, true);
  assert.equal(picker.hidden, true);

  let calls = 0;
  context.http = async (_, url) => {
    calls++;
    return { previews: url.includes('other')
      ? [{name: 'failed', index: 8, error: 'Unknown variable'}]
      : [{name: '<vm>', index: 7, commands: ['<script>literal text</script>\nsecond line']}] };
  };
  await context.previewCommandTemplates(output, [
    {pid: 'course', targets: [{}]}, {pid: 'other', targets: [{}]},
  ], [{command: 'echo {{instance_index}}', render_template_variables: true}]);
  assert.equal(selector.options.length, 2);
  assert.match(selector.options[0].textContent, /course \/ <vm>/);
  assert.equal(output.textContent, '[Rendered]\n<script>literal text</script>\nsecond line');
  selector.value = '1';
  selector.change();
  assert.equal(output.textContent, 'Unknown variable');
  assert.match(selector.options[1].textContent, /other \/ failed.*Error/);
  assert.equal(calls, 2, 'selection does not fetch again');

  await context.previewCommandTemplates(output, [], []);
  assert.match(output.textContent, /Enter an enabled command/);
  assert.equal(selector.options.length, 0);
  await context.previewCommandTemplates(output, [], [{}]);
  assert.match(output.textContent, /Select at least one VM/);
  context.http = async () => { throw new Error('Preview unavailable'); };
  await context.previewCommandTemplates(output, [{pid: 'course', targets: [{}]}], [{command: '{{instance_index}}'}]);
  assert.equal(output.textContent, 'Preview unavailable');
  assert.equal(selector.disabled, true);

  // Plain shell/JSON braces and literal placeholders preview immediately, even offline.
  const offlineGroups = [{pid: 'course', targets: [{name: 'vm-7', index: 7}, {name: 'vm-8', index: 8}]}];
  context.http = () => { assert.fail('Unchanged commands should not contact the server'); };
  const ordinary = 'echo ${HOME}; awk \'{print $1}\'; echo \'{"key": 1}\'';
  await context.previewCommandTemplates(output, offlineGroups, [{command: ordinary}]);
  assert.equal(output.textContent, `[Rendered]\n${ordinary}`);
  assert.equal(selector.options.length, 2);
  await context.previewCommandTemplates(output, offlineGroups, [{command: 'echo {{unknown}}', render_template_variables: false}]);
  assert.equal(output.textContent, '[Literal]\necho {{unknown}}');

  // A stalled server request reports a timeout and can be retried.
  context.http = (_, __, ___, {signal}) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('Aborted')), {once: true});
  });
  const timeout = panel.querySelector('[data-role="template-preview"]').click();
  assert.equal(timers.size, 1);
  [...timers.values()][0]();
  await timeout;
  assert.match(output.textContent, /Preview timed out after 10 seconds/);
  assert.equal(selector.disabled, true);
  assert.equal(timers.size, 0);
  await context.previewCommandTemplates(output, offlineGroups, [{command: 'echo retry'}]);
  assert.equal(output.textContent, '[Rendered]\necho retry');
  // A late response cannot replace a preview invalidated by editing the command.
  let resolve;
  context.http = () => new Promise(done => { resolve = done; });
  const pending = panel.querySelector('[data-role="template-preview"]').click();
  context.invalidateCommandTemplatePreview('start');
  resolve({previews: [{name: 'old', index: 1, commands: ['stale']}]});
  await pending;
  assert.doesNotMatch(panel.querySelector('pre').textContent, /stale/);
  assert.equal(selector.options.length, 0);
  assert.equal(timers.size, 0);

  // The shared HTTP helper passes the abort signal through to fetch.
  const signal = new AbortController().signal;
  let fetchOptions;
  context.FormData = class FormData {};
  context.fetch = async (_, options) => {
    fetchOptions = options;
    return {ok: true, headers: {get: () => 'application/json'}, json: async () => ({previews: []})};
  };
  vm.runInContext(source.slice(source.indexOf('async function http('), source.indexOf('// UI state helpers')), context);
  await context.http('POST', '/preview', {commands: []}, {signal});
  assert.equal(fetchOptions.signal, signal);

  context.DEFAULT_COMMAND_TIMEOUT_SECONDS = 300;
  context.normalizeCommandTimeout = value => Number(value) || 300;
  vm.runInContext(source.slice(source.indexOf('function sanitizeStartCommandSteps('), source.indexOf('function encodeStartCommandsValue(')), context);
  const saved = context.stepsToServerPayload([{commands: [
    {command: 'echo {{literal}}', render_template_variables: false}, {command: 'echo {{instance_index}}'},
  ]}]);
  assert.equal(saved[0].commands[0].render_template_variables, false);
  assert.equal(saved[0].commands[1].render_template_variables, true);
  const reopened = context.normalizeStartCommandSteps(saved);
  assert.equal(reopened[0].commands[0].renderTemplateVariables, false);

  console.log('Command preview selector, literal/render modes, help, stale responses and persistence checks passed.');
}
run().catch(error => { console.error(error); process.exitCode = 1; });
