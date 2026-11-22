const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync('app/static/js/vm_manager.js', 'utf8');

function page(selected, {confirm = true, emptyPreview = false, state = {status: 'completed'}, result = {
  ran: [{name: 'proxy-t1', cmds: [{exitcode: 0}]}], skipped: [], errors: [],
}} = {}) {
  const project = {id: 'p1', name: 'Lab', tag: '-t', vms: [
    {name: 'proxy', vm_type: 'qemu', proxy_config: {router_node: 'n3'}},
    {name: 'student', vm_type: 'qemu', proxy_config: {}},
  ]};
  const calls = [], alerts = [], summaries = [], statuses = [];
  const policy = {mode: 'restricted', internal_sources: ['13.0.0.101/32'], external_addresses: [],
    translations: ['198.51.100.12:8080:203.0.113.25:8001']};
  const proxyButton = {disabled: true};
  const context = {
    PROJ: project,
    getActionableSelections: () => selected,
    guestTransferProject: () => project,
    getSelectedGuestEntries: () => [],
    updateVmSelectionCount() {},
    vmIsMulti: () => false,
    hasAuth: () => true,
    document: {getElementById: id => id === 'act-proxy-restart' ? proxyButton : null},
    canonicalPid: String,
    encodeURIComponent,
    ServerQueue: {
      submit: async (label, steps, options) => { calls.push({label, steps, options}); return {id: 14}; },
      wait: async () => state,
      nativeFetch: async (url, options) => ({ok: true, json: async () => {
        if (!url.endsWith('/preview')) return result;
        const {targets} = JSON.parse(options.body);
        return {targets: emptyPreview ? [] : targets.map(target => ({...target, policy: target.policy || policy, defaults: policy, has_previous: true}))};
      }}),
    },
    guestTransferAuthPayload: async () => ({username: 'root@pam', password: 'secret'}),
    showActionSummary: (_label, result) => summaries.push(result),
    emitActionLogs() {},
    vmSetActionStatus: (message, kind, viewResults) => statuses.push({message, kind, viewResults}),
    alert: message => alerts.push(message),
    window: {shell: {logError() {}}},
  };
  vm.createContext(context);
  for (const [start, end] of [
    ['function vmIsProxyGateway(', 'function renderMergedVmTable('],
    ['function updateRefreshState()', '// Helpers: per-project auth checks'],
    ['function deriveBaseVmName(', 'function vmBuildRestartTargetsForFailedValidation('],
    ['function findSelectedProxyVm(', '// Dispatch VM actions (queued wrapper)'],
  ]) {
    vm.runInContext(source.slice(source.indexOf(start), source.indexOf(end)), context);
  }
  const prompt = context.promptProxyRestartSettings;
  context.promptProxyRestartSettings = async groups => {
    assert.deepEqual(groups.get('p1').settings[0].policy, policy);
    if (!confirm) return null;
    return new Map([...groups].map(([pid, {settings}]) => [pid, settings.map(({index, name, policy}) => ({index, name, policy}))]));
  };
  return {context, calls, alerts, summaries, proxyButton, statuses, prompt, policy};
}

test('VM Manager configures and restarts only the selected CORE gateway', async () => {
  const p = page([{pid: 'p1', index: 1, name: 'proxy-t1'}]);
  await p.context.configureAndRestartProxy();
  assert.equal(p.alerts.length, 0);
  assert.equal(p.calls.length, 1);
  const [step] = p.calls[0].steps;
  assert.match(step.url, /\/projects\/p1\/instances\/actions\/configure_restart_proxy$/);
  assert.equal(step.body.targets[0].name, 'proxy-t1');
  assert.equal(step.body.targets[0].policy.translations[0], '198.51.100.12:8080:203.0.113.25:8001');
  assert.equal(step.body.customCommand, undefined);
  assert.equal(p.summaries.length, 0);
  p.statuses.at(-1).viewResults();
  assert.equal(p.summaries[0].ran.length, 1);
});

test('Cancelling the proxy settings dialog queues no restart', async () => {
  const p = page([{pid: 'p1', index: 1, name: 'proxy-t1'}], {confirm: false});
  await p.context.configureAndRestartProxy();
  assert.equal(p.calls.length, 0);
});

test('An empty preview cannot show a blank editor or queue a restart', async () => {
  const p = page([{pid: 'p1', index: 1, name: 'proxy-t1'}], {emptyPreview: true});
  await p.context.configureAndRestartProxy();
  assert.equal(p.calls.length, 0);
  assert.match(p.statuses.at(-1).message, /Could not open proxy settings/);
});

test('Reopening proxy settings can recall a previous policy and waits for Apply', async () => {
  const {context, prompt, policy} = page([{pid: 'p1', index: 1, name: 'proxy-t1'}]);
  const panel = new EventTarget();
  const apply = {};
  const form = {querySelector: () => apply};
  const host = {rows: [], appendChild(row) { this.rows.push(row); }, replaceChildren() { this.rows = []; }};
  const classList = {add() {}, remove() {}, toggle() {}};
  const makeRow = () => {
    const fields = Object.keys(policy).map(name => ({name, value: ''}));
    const select = {value: '', options: [], add(option) { this.options.push(option); }};
    const elements = new Map([['[data-proxy-history]', select]]);
    return {fields, querySelectorAll: () => fields, querySelector(selector) {
      if (!elements.has(selector)) elements.set(selector, {classList});
      return elements.get(selector);
    }};
  };
  const template = {content: {firstElementChild: {cloneNode: makeRow}}};
  const elements = {
    proxyRestartModal: panel, 'proxy-restart-form': form, 'proxy-restart-targets': host,
    'proxy-restart-target-template': template, 'proxy-restart-error': {classList},
  };
  context.document.getElementById = id => elements[id];
  context.Option = class { constructor(text, value) { this.text = text; this.value = value; } };
  const hide = () => {
    panel.dispatchEvent(new Event('hide.bs.modal'));
    panel.dispatchEvent(new Event('hidden.bs.modal'));
  };
  context.bootstrap = {Modal: {getOrCreateInstance: () => ({show() {}, hide})}};
  const row = {name: 'proxy-t1', index: 1, policy, defaults: policy};
  const groups = settings => new Map([['p1', {project: {name: 'Lab'}, settings: [settings]}]]);
  const first = prompt(groups({...row, has_previous: false}));
  await form.onsubmit({preventDefault() {}, submitter: apply});
  assert.equal((await first).get('p1')[0].name, row.name);
  assert.equal(host.rows.length, 0);

  const saved = {...policy, translations: ['198.51.100.12:8080:203.0.113.25:8002']};
  const older = {...policy, translations: ['198.51.100.12:8080:203.0.113.25:8003']};
  const history = [{policy: saved, appliedAt: 1795298400000}, {policy: older, appliedAt: null}];
  const reopened = prompt(groups({...row, policy: saved, has_previous: true, history}));
  assert.equal(host.rows[0].querySelector('[data-proxy-source]').textContent, 'Last successfully applied');
  const translations = host.rows[0].fields.find(field => field.name === 'translations');
  assert.equal(translations.value, saved.translations[0]);
  const previous = host.rows[0].querySelector('[data-proxy-history]');
  assert.match(previous.options[1].text, /203\.0\.113\.25:8003/);
  previous.value = previous.options[1].value;
  previous.onchange();
  assert.equal(translations.value, older.translations[0]);
  assert.equal(host.rows[0].querySelector('[data-proxy-source]').textContent, 'Previous successful run');
  host.rows[0].querySelector('[data-proxy-defaults]').onclick();
  assert.equal(previous.value, '');
  assert.equal(translations.value, policy.translations[0]);
  previous.value = previous.options[1].value;
  previous.onchange();
  await form.onsubmit({preventDefault() {}, submitter: null});
  assert.equal(host.rows.length, 1);
  await form.onsubmit({preventDefault() {}, submitter: apply});
  assert.equal((await reopened).get('p1')[0].policy.translations[0], older.translations[0]);
});

test('VM Manager shows the guest error from a failed queue job and counts only successful restarts', async () => {
  const p = page([{pid: 'p1', index: 1, name: 'proxy-t1'}], {
    state: {status: 'error', errorMessage: 'Operation reported errors or unresolved templates; see results'},
    result: {
      ran: [{name: 'proxy-t1', cmds: [{exitcode: 1}]}],
      errors: [{name: 'proxy-t1', reason: 'CORE restart requires core-cli on the proxy VM'}],
    },
  });
  await p.context.configureAndRestartProxy();
  p.statuses.at(-1).viewResults();
  assert.equal(p.summaries[0].errors.length, 1);
  assert.match(p.summaries[0].errors[0].reason, /requires core-cli/);
  assert.match(p.statuses.at(-1).message, /0\/1 restarted/);
});

test('VM Manager rejects a selection containing an ordinary VM', async () => {
  const p = page([{pid: 'p1', index: 1, name: 'student-t1'}]);
  await p.context.configureAndRestartProxy();
  assert.match(p.alerts[0], /not a configured CORE gateway/);
  assert.equal(p.calls.length, 0);
});

test('VM Manager updates the proxy action as the selection changes', () => {
  const selected = [];
  const {context, proxyButton} = page(selected);
  context.updateRefreshState();
  assert.equal(proxyButton.disabled, true);

  selected.push({pid: 'p1', index: 1, name: 'proxy-t1'});
  context.updateRefreshState();
  assert.equal(proxyButton.disabled, false);

  selected.push({pid: 'p1', index: 1, name: 'student-t1'});
  context.updateRefreshState();
  assert.equal(proxyButton.disabled, true);

  selected.shift();
  context.updateRefreshState();
  assert.equal(proxyButton.disabled, true);
});
