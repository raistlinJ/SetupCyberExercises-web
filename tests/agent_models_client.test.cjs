const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('app/static/js/agent_plugin.js', 'utf8');

function element(value = '') {
  const classes = new Set();
  return {value, checked: true, disabled: false, hidden: false, children: [], listeners: {},
    classList: {add: name => classes.add(name), remove: name => classes.delete(name),
      toggle: (name, enabled) => enabled ? classes.add(name) : classes.delete(name)},
    addEventListener(type, callback) { (this.listeners[type] ||= []).push(callback); },
    async fire(type) { for (const callback of this.listeners[type] || []) await callback({target: this}); },
    replaceChildren(...children) { this.children = children; },
    removeAttribute(name) { delete this[name]; }, setCustomValidity() {}, reportValidity: () => true,
    checkValidity: () => true,
  };
}

function dialog(data, saved = {model: 'gpt-6.1-sol', context: '156000'}) {
  const elements = new Map();
  const node = id => {
    if (!elements.has(id)) elements.set(id, element());
    return elements.get(id);
  };
  node('url').value = 'https://api.openai.com/v1';
  node('context').value = '16384'; node('tokens').value = '2048';
  node('model-picker').hidden = true; node('model-picker').disabled = true;
  const storage = new Map([['deployforge.agent.config.v1', JSON.stringify(saved)]]);
  const calls = [];
  const sandbox = {URL,
    document: {getElementById: id => node(id.replace(/^agent-/, '')), createElement: () => element()},
    localStorage: {getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value)},
    sessionStorage: {getItem: () => 'test-key', setItem() {}},
    ServerQueue: {nativeFetch: async (...args) => {
      calls.push(args); return {ok: true, json: async () => typeof data === 'function' ? await data() : data};
    }},
  };
  vm.createContext(sandbox);
  vm.runInContext(source.slice(source.indexOf('const el ='), source.indexOf('const filesReady =')) +
    source.slice(source.indexOf('function saveSettings()'), source.indexOf('async function saveFiles()')) +
    source.slice(source.indexOf('function validEndpoint('), source.indexOf("command.addEventListener('click'")) +
    source.slice(source.indexOf("el('fetch').addEventListener"), source.indexOf("el('form').addEventListener")), sandbox);
  return {node, storage, calls, sandbox};
}

const catalog = {models: ['gpt-6-astra', 'gpt-6.1-sol', 'local-test'], model_limits: {
  'gpt-6-astra': {context_window: 1050000, max_output_tokens: 128000, source: 'OpenAI model documentation'},
  'gpt-6.1-sol': {context_window: 1050000, max_output_tokens: 128000, source: 'OpenAI model documentation'},
  'local-test': {context_window: 32768, source: 'Loaded runtime'},
}};

test('Fetch shows a visible model picker, preserves the current model, and enables provider max', async () => {
  const d = dialog(catalog);
  assert.equal(d.node('context-max').disabled, true);
  await d.node('fetch').fire('click');
  const picker = d.node('model-picker');
  assert.equal(picker.hidden, false);
  assert.equal(picker.disabled, false);
  assert.deepEqual(picker.children.slice(1).map(option => option.textContent), catalog.models);
  assert.equal(picker.value, 'gpt-6.1-sol');
  assert.equal(d.node('model').value, 'gpt-6.1-sol');
  assert.equal(d.node('context').value, '156000', 'Fetching does not replace a custom context');
  assert.equal(d.node('context-max').disabled, false);
  await d.node('context-max').fire('click');
  assert.equal(d.node('context').value, '1050000');
  assert.equal(d.node('tokens').max, '128000');
  assert.equal(JSON.parse(d.storage.get('deployforge.agent.config.v1'))['context-auto'], true);
  assert.equal(d.calls.length, 1);
  assert.equal(d.calls[0][0], '/api/plugins/agent/models');
});

test('choosing a fetched model updates the input and uses that model’s own context limit', async () => {
  const d = dialog(catalog);
  await d.node('fetch').fire('click');
  d.node('model-picker').value = 'local-test';
  await d.node('model-picker').fire('change');
  assert.equal(d.node('model').value, 'local-test');
  await d.node('context-max').fire('click');
  assert.equal(d.node('context').value, '32768');
  assert.equal(JSON.parse(d.storage.get('deployforge.agent.config.v1')).model, 'local-test');
});

test('unknown limits allow manual entry and explain why provider max is unavailable', async () => {
  const d = dialog({models: ['unknown'], model_limits: {unknown: {}}}, {model: 'unknown'});
  await d.node('fetch').fire('click');
  assert.equal(d.node('context-max').disabled, true);
  assert.match(d.node('context-max').title, /enter the context manually/);
  assert.match(d.node('context-limit').textContent, /No context limit is available/);
  d.node('context').value = '65536';
  await d.node('context').fire('input');
  assert.equal(d.node('context').value, '65536');
});

test('changing endpoint or API key clears stale model choices and limits', async () => {
  for (const field of ['url', 'api-key']) {
    const d = dialog(catalog);
    await d.node('fetch').fire('click');
    d.node(field).value += '-changed';
    await d.node(field).fire('input');
    assert.equal(d.node('model-picker').hidden, true);
    assert.equal(d.node('model-picker').disabled, true);
    assert.equal(d.node('model-picker').children.length, 0);
    assert.equal(d.node('context-max').disabled, true);
  }
});

test('empty catalogs show an empty selector without enabling maximum-context controls', async () => {
  const d = dialog({models: [], model_limits: {}});
  await d.node('fetch').fire('click');
  assert.equal(d.node('model-picker').hidden, false);
  assert.equal(d.node('model-picker').disabled, true);
  assert.equal(d.node('model-picker').children[0].textContent, 'No models returned');
  assert.equal(d.node('context-max').disabled, true);
  assert.equal(d.node('fetch').disabled, false);
});

test('a late Fetch result cannot repopulate choices after the connection changes', async () => {
  let resolve;
  const d = dialog(() => new Promise(done => { resolve = done; }));
  const pending = d.node('fetch').fire('click');
  await Promise.resolve();
  d.node('url').value = 'http://localhost:1234/v1';
  await d.node('url').fire('input');
  resolve(catalog);
  await pending;
  assert.equal(d.node('model-picker').hidden, true);
  assert.equal(d.node('model-picker').children.length, 0);
  assert.equal(d.node('context-max').disabled, true);
});
