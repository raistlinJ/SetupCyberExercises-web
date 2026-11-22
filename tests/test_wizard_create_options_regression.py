import json
import shutil
import subprocess
import textwrap
import unittest
from pathlib import Path


class WizardCreateOptionsRegressionTests(unittest.TestCase):

    def _run_node_regression(self, harness: str):
        node = shutil.which('node')
        if not node:
            self.skipTest('Node.js is required for frontend wizard regression checks')

        node_script = textwrap.dedent(
            f"""
            const fs = require('fs');
            const path = require('path');
            const vm = require('vm');

            function makeClassList() {{
              return {{
                add() {{}},
                remove() {{}},
                toggle() {{}},
                replace() {{}},
                contains() {{ return false; }},
              }};
            }}

            function makeStorage() {{
              const store = new Map();
              return {{
                getItem(key) {{
                  const value = store.get(String(key));
                  return value === undefined ? null : value;
                }},
                setItem(key, value) {{ store.set(String(key), String(value)); }},
                removeItem(key) {{ store.delete(String(key)); }},
                clear() {{ store.clear(); }},
              }};
            }}

            function makeElement(id) {{
              return {{
                id: String(id || ''),
                value: '',
                checked: false,
                innerHTML: '',
                innerText: '',
                textContent: '',
                className: '',
                style: {{}},
                dataset: {{}},
                disabled: false,
                files: [],
                classList: makeClassList(),
                addEventListener() {{}},
                removeEventListener() {{}},
                appendChild(child) {{ return child; }},
                append() {{}},
                removeChild() {{}},
                querySelector() {{ return null; }},
                querySelectorAll() {{ return []; }},
                closest() {{ return null; }},
                focus() {{}},
                click() {{}},
                setAttribute(name, value) {{ this[name] = value; }},
                getAttribute(name) {{ return this[name] || ''; }},
                removeAttribute(name) {{ delete this[name]; }},
              }};
            }}

            const elements = new Map();
            const document = {{
              body: makeElement('body'),
              documentElement: {{ dataset: {{ ctfdPlugin: 'on', ctfrpgPlugin: 'on' }} }},
              addEventListener() {{}},
              removeEventListener() {{}},
              dispatchEvent() {{ return true; }},
              createElement(tagName) {{ return makeElement(tagName); }},
              getElementById(id) {{
                const key = String(id || '');
                if (!elements.has(key)) elements.set(key, makeElement(key));
                return elements.get(key);
              }},
              querySelector(selector) {{
                if (selector === 'input[name="wiz-cap-mode"]:checked') return {{ value: 'num' }};
                return null;
              }},
              querySelectorAll() {{ return []; }},
            }};

            const shell = {{
              logDebug() {{}},
              logInfo() {{}},
              logError() {{}},
              logWarn() {{}},
              logSuccess() {{}},
              refreshSidebar: async () => {{}},
              getCurrentProjectId() {{ return ''; }},
              setCurrentProjectId() {{}},
              applyRemoteModeUI() {{}},
            }};

            const sessionStorage = makeStorage();
            const localStorage = makeStorage();
            const windowObj = {{
              document,
              shell,
              sessionStorage,
              localStorage,
              PROJ_CACHE: {{}},
              MATERIAL_PENDING: {{}},
              bootstrap: null,
              location: {{ href: 'http://localhost:8080/', pathname: '/', search: '', hash: '', origin: 'http://localhost:8080' }},
              history: {{ replaceState() {{}} }},
              addEventListener() {{}},
              removeEventListener() {{}},
              dispatchEvent() {{ return true; }},
            }};

            const context = {{
              console,
              sessionStorage,
              localStorage,
              document,
              window: windowObj,
              shell,
              location: windowObj.location,
              history: windowObj.history,
              navigator: {{}},
              fetch: async () => ({{ ok: true, headers: {{ get: () => 'application/json' }}, json: async () => ({{}}) }}),
              bootstrap: null,
              FormData: function FormData() {{}},
              FileReader: function FileReader() {{}},
              URL,
              URLSearchParams,
              CustomEvent: function CustomEvent(type, init) {{ this.type = type; this.detail = init && init.detail; }},
              Event: function Event(type) {{ this.type = type; }},
              performance: {{ now: () => 0 }},
              setTimeout,
              clearTimeout,
              setInterval,
              clearInterval,
              requestAnimationFrame: (callback) => callback(),
              cancelAnimationFrame() {{}},
              alert(message) {{ throw new Error('Unexpected alert: ' + message); }},
            }};
            context.window.window = windowObj;
            context.global = context;
            context.globalThis = context;

            const source = fs.readFileSync(path.join(process.cwd(), 'app/static/js/app.js'), 'utf8');
            const harness = {json.dumps(harness)};

            (async () => {{
              const result = vm.runInNewContext(source + '\\n' + harness, context, {{ filename: 'app.wizard_create_options.bundle.js' }});
              if (result && typeof result.then === 'function') await result;
            }})().catch((error) => {{
              console.error(error && error.stack ? error.stack : String(error));
              process.exit(1);
            }});
            """
        )

        repo_root = Path(__file__).resolve().parents[1]
        result = subprocess.run(
            [node, '-e', node_script],
            cwd=repo_root,
            capture_output=True,
            text=True,
            check=False,
        )

        if result.returncode != 0:
            self.fail(
                'Node regression harness failed for app.js wizard create options\n'
                f'STDOUT:\n{result.stdout}\n'
                f'STDERR:\n{result.stderr}'
            )

    @unittest.skipUnless(shutil.which('node'), 'Node.js is required for frontend wizard regression checks')
    def test_wizard_ctfrpg_selection_respects_enabled_plugin(self):
        harness = textwrap.dedent(
            """
            (async () => {
              const input = document.getElementById('proj-name');
              const calls = [];
              input.value = 'RPG Lab';
              document.getElementById('wiz-users').value = '1';
              document.getElementById('wiz-feat-vm').checked = false;
              document.getElementById('wiz-feat-ctfd').checked = true;
              document.getElementById('wiz-feat-ctfrpg').checked = true;
              document.getElementById('wiz-act-ctfrpg-users').checked = true;
              document.getElementById('wiz-ctfrpg-url').value = 'https://rpg.local';
              document.getElementById('wiz-ctfrpg-username').value = 'rpg-admin';
              document.getElementById('wiz-ctfrpg-password').value = 'rpg-password';
              document.getElementById('wiz-ctfrpg-verify').checked = false;
              document.documentElement.dataset.ctfdPlugin = 'off';
              document.documentElement.dataset.ctfrpgPlugin = 'on';
              currentWizardStep = 5;
              loadProjects = async () => {};
              startWizardJobStatusPolling = () => () => {};
              showToast = () => {};
              http = async (method, url, body) => {
                calls.push({ method, url, body });
                if (url === '/api/projects') return { id: 'rpg-lab', name: 'RPG Lab' };
                if (url === '/api/projects/rpg-lab/secrets') return { ok: true };
                if (url === '/api/projects/rpg-lab/ctfrpg/users_create') return { ok: true, created: 1, results: [] };
                throw new Error(`Unexpected request: ${method} ${url}`);
              };
              await window.submitProjectCreation('wizard');
              const project = calls.find(call => call.url === '/api/projects');
              if (project.body.ctfrpg_url !== 'https://rpg.local' || project.body.challenge_url) throw new Error('Only enabled integration settings should be saved');
              const secrets = calls.find(call => call.url.endsWith('/secrets'));
              if (secrets.body.ctfrpg.username !== 'rpg-admin' || secrets.body.ctfrpg.password !== 'rpg-password' || secrets.body.ctfd) throw new Error('Only enabled integration credentials should be saved');
              const create = calls.find(call => call.url.endsWith('/ctfrpg/users_create'));
              if (!create || create.body.verifySSL !== false) throw new Error('Selected CTF-RPG users should be created');

              calls.length = 0;
              input.value = 'Disabled RPG Lab';
              document.documentElement.dataset.ctfrpgPlugin = 'off';
              await window.submitProjectCreation('wizard');
              if (calls.length !== 1 || calls[0].url !== '/api/projects') throw new Error('Disabled plugin should not run integration actions');
              if (calls[0].body.ctfrpg_url) throw new Error('Disabled plugin should not save integration settings');
            })();
            """
        )
        self._run_node_regression(harness)

    @unittest.skipUnless(shutil.which('node'), 'Node.js is required for frontend wizard regression checks')
    def test_wizard_create_runs_vm_manager_style_followups(self):
        harness = textwrap.dedent(
            """
            (async () => {
              const assert = (condition, message) => {
                if (!condition) throw new Error(message);
              };

              const setValue = (id, value) => { document.getElementById(id).value = value; };
              const setChecked = (id, value) => { document.getElementById(id).checked = !!value; };

              setValue('proj-name', 'Wizard Lab');
              setValue('wiz-scenario-tag', '-lab-');
              setValue('wiz-users', '1');
              setChecked('wiz-feat-vm', true);
              setChecked('wiz-feat-ctfd', false);
              setValue('wiz-proxmox-url', 'https://proxmox.local');
              setValue('wiz-proxmox-user', 'root@pam');
              setValue('wiz-proxmox-pass', 'secret');
              setChecked('wiz-proxmox-verify', false);
              setChecked('wiz-act-vm-create', true);
              setChecked('wiz-act-vm-users', true);
              setChecked('wiz-act-vm-accessibility', true);
              setChecked('wiz-act-vm-scenario', true);
              setChecked('wiz-act-vm-network', true);
              setChecked('wiz-act-vm-snapshot', true);
              setChecked('wiz-act-vm-start', false);
              setChecked('wiz-act-ctfd-users', true);

              currentWizardStep = 5;
              wizSelectedTemplates = [
                {
                  vmid: 900,
                  name: 'web',
                  finalName: 'web',
                  user_accessible: true,
                  vm_user: 'student',
                  vm_pass: 'password',
                  nets: ['lab'],
                  internet_connected_adaptors: [],
                },
                {
                  vmid: 901,
                  name: 'db',
                  finalName: 'db',
                  user_accessible: false,
                  vm_user: 'operator',
                  vm_pass: 'password',
                  nets: ['lab'],
                  internet_connected_adaptors: [],
                },
                {
                  vmid: 902,
                  name: 'admin',
                  finalName: 'admin',
                  user_accessible: false,
                  vm_user: 'admin',
                  vm_pass: 'password',
                  nets: ['lab'],
                  internet_connected_adaptors: [],
                },
              ];

              loadProjects = async () => {};
              startWizardJobStatusPolling = () => () => {};
              scheduleWizardAutoRedirect = () => {};
              showToast = () => {};

              const calls = [];
              http = async (method, url, body) => {
                calls.push({ method, url, body });
                if (method === 'POST' && url === '/api/test/credentials') return { ok: true };
                if (method === 'POST' && url === '/api/projects') {
                  return {
                    id: 'proj-wizard',
                    name: 'Wizard Lab',
                    tag: '-lab-',
                    vms: [
                      { name: 'web', viewable_to_user: true },
                      { name: 'db', viewable_to_user: false },
                      { name: 'admin', viewable_to_user: false },
                    ],
                  };
                }
                if (method === 'PUT' && url === '/api/projects/proj-wizard/secrets') return { ok: true };
                if (method === 'POST' && url === '/api/projects/proj-wizard/instances/actions/create') return { created: [{ name: 'web-lab-1' }, { name: 'db-lab-1' }, { name: 'admin-lab-1' }] };
                if (method === 'PATCH' && url.startsWith('/api/projects/proj-wizard/vms/')) return { ok: true };
                if (method === 'POST' && url === '/api/projects/proj-wizard/instances/actions/users_create') {
                  return { created_users: [{ userid: 'user01@pve' }], created_pools: [{ pool: 'user01' }], added_members: [{ name: 'web-lab-1' }, { name: 'db-lab-1' }, { name: 'admin-lab-1' }] };
                }
                if (method === 'POST' && url === '/api/projects/proj-wizard/instances/actions/apply_scenario') return { applied: [{ name: 'web-lab-1' }, { name: 'db-lab-1' }, { name: 'admin-lab-1' }] };
                throw new Error(`Unexpected request: ${method} ${url}`);
              };

              await window.submitProjectCreation('wizard');

              const createCall = calls.find(call => call.url === '/api/projects/proj-wizard/instances/actions/create');
              assert(createCall, 'Wizard should call VM create');
              assert(createCall.body.applyScenario === false, 'Wizard create should defer scenario notes to the follow-up option');
              assert(createCall.body.syncUserAccess === false, 'Wizard create should defer user access to follow-up actions');
              assert(createCall.body.setNetworkInterfaces === true, 'Wizard create should pass the network option');
              assert(createCall.body.takeSnapshot === true, 'Wizard create should pass the snapshot option');

              const projectCreateCall = calls.find(call => call.method === 'POST' && call.url === '/api/projects');
              const configuredAccess = Object.fromEntries(projectCreateCall.body.vms.map(vm => [vm.name, vm.viewable_to_user]));
              assert(configuredAccess.web === true, 'Wizard should persist the checked VM as user-accessible');
              assert(configuredAccess.db === false, 'Wizard should persist an unchecked VM as not user-accessible');
              assert(configuredAccess.admin === false, 'Wizard should not make any other VM user-accessible');

              const accessPatches = calls.filter(call => call.method === 'PATCH' && call.url.startsWith('/api/projects/proj-wizard/vms/'));
              assert(accessPatches.length === 3, 'Wizard should reconcile accessibility for each configured VM exactly once');
              const patchedAccess = Object.fromEntries(accessPatches.map(call => [decodeURIComponent(call.url.split('/').pop()), call.body.viewable_to_user]));
              assert(patchedAccess.web === true, 'Accessibility follow-up should keep the checked VM enabled');
              assert(patchedAccess.db === false, 'Accessibility follow-up should keep the unchecked DB VM disabled');
              assert(patchedAccess.admin === false, 'Accessibility follow-up should not enable the admin VM');

              const urls = calls.map(call => call.url);
              assert(urls.includes('/api/projects/proj-wizard/vms/web'), 'Wizard should apply user accessibility');
              assert(urls.includes('/api/projects/proj-wizard/instances/actions/users_create'), 'Wizard should create Proxmox users and pools');
              assert(urls.includes('/api/projects/proj-wizard/instances/actions/apply_scenario'), 'Wizard should apply scenario notes');
              assert(!urls.includes('/api/projects/proj-wizard/instances/actions/users_access_sync'), 'Users create should replace redundant access sync when selected');
              assert(!urls.includes('/api/projects/proj-wizard/instances/actions/start'), 'Start should not run when the VM Manager-style default is off');
              assert(!urls.includes('/api/projects/proj-wizard/ctfd/users_create'), 'Hidden CTFd option should not run when CTFd feature is disabled');
            })();
            """
        )

        self._run_node_regression(harness)

    @unittest.skipUnless(shutil.which('node'), 'Node.js is required for frontend wizard regression checks')
    def test_wizard_accessibility_sync_preserves_the_exact_selected_set(self):
        harness = textwrap.dedent(
            """
            (async () => {
              const assert = (condition, message) => {
                if (!condition) throw new Error(message);
              };
              const calls = [];
              http = async (method, url, body) => {
                calls.push({ method, url, body });
                if (method === 'PATCH') return { ok: true };
                if (method === 'POST' && url.endsWith('/instances/actions/users_access_sync')) {
                  return { applied: [], unchanged: [], errors: [] };
                }
                throw new Error(`Unexpected request: ${method} ${url}`);
              };

              const project = {
                id: 'proj-access',
                tag: '-lab-',
                vms: [
                  { name: 'web', viewable_to_user: true },
                  { name: 'db', viewable_to_user: false },
                  { name: 'admin', viewable_to_user: false },
                ],
              };
              const targets = [
                { index: 1, name: 'web' },
                { index: 1, name: 'db' },
                { index: 1, name: 'admin' },
              ];

              await wizardRunUserAccessibilityFollowUp({
                pid: project.id,
                project,
                targets,
                baseBody: { username: 'root@pam' },
                syncAccess: true,
              });

              const patches = calls.filter(call => call.method === 'PATCH');
              const patchedAccess = Object.fromEntries(patches.map(call => [decodeURIComponent(call.url.split('/').pop()), call.body.viewable_to_user]));
              assert(patches.length === 3, 'Each configured VM should be reconciled once');
              assert(patchedAccess.web === true, 'Only web should remain user-accessible');
              assert(patchedAccess.db === false, 'DB should remain inaccessible');
              assert(patchedAccess.admin === false, 'Admin should remain inaccessible');

              const syncCalls = calls.filter(call => call.method === 'POST');
              assert(syncCalls.length === 2, 'Enabled and disabled templates should be synced separately');
              const enabledSync = syncCalls.find(call => call.body.enable === true);
              const disabledSync = syncCalls.find(call => call.body.enable === false);
              assert(JSON.stringify(enabledSync.body.templates) === JSON.stringify(['web']), 'Only web should receive user access');
              assert(JSON.stringify(disabledSync.body.templates.sort()) === JSON.stringify(['admin', 'db']), 'All other templates should have user access revoked');
            })();
            """
        )

        self._run_node_regression(harness)

    @unittest.skipUnless(shutil.which('node'), 'Node.js is required for frontend wizard regression checks')
    def test_wizard_credentials_parser_accepts_commas_and_whitespace(self):
        harness = textwrap.dedent(
            """
            (() => {
              const assert = (condition, message) => {
                if (!condition) throw new Error(message);
              };

              const parsed = parseWizardCredentialsText([
                'username,password',
                'cealvarez2 80734677',
                'student02,PASSWORD2',
                'student03, PASSWORD3',
                'student04,\\tPASSWORD4',
                'student05,, \\t PASSWORD5',
                'student06     PASSWORD6',
              ].join('\\n'));

              assert(parsed.valid, 'Comma- and whitespace-delimited rows should be valid');
              assert(parsed.credentials.length === 6, 'Optional header should not become a credential');
              assert(parsed.credentials[0].username === 'cealvarez2', 'Whitespace-delimited username should be isolated');
              assert(parsed.credentials[0].password === '80734677', 'Whitespace-delimited password should be isolated');
              assert(parsed.credentials[2].password === 'PASSWORD3', 'Whitespace around a comma should be ignored');
              assert(parsed.credentials[3].password === 'PASSWORD4', 'Comma-tab delimiters should be accepted');
              assert(parsed.credentials[4].password === 'PASSWORD5', 'Mixed repeated delimiters should collapse to one');
              assert(parsed.credentials[5].password === 'PASSWORD6', 'Repeated whitespace should collapse to one');

              const missingPassword = parseWizardCredentialsText('student07,,,');
              assert(!missingPassword.valid, 'Repeated trailing delimiters must not hide a missing password');
            })();
            """
        )

        self._run_node_regression(harness)

    @unittest.skipUnless(shutil.which('node'), 'Node.js is required for frontend wizard regression checks')
    def test_wizard_blocks_invalid_credentials_rows(self):
        harness = textwrap.dedent(
            """
            (async () => {
              const assert = (condition, message) => {
                if (!condition) throw new Error(message);
              };

              document.querySelector = (selector) => {
                if (selector === 'input[name="wiz-cap-mode"]:checked') return { value: 'csv' };
                return null;
              };
              document.getElementById('wiz-csv-file').files = [{
                text: async () => 'alice,password1\\nbob,password2,unexpected',
              }];
              document.getElementById('wiz-scenario-tag').value = '-lab-';
              currentWizardStep = 1;

              let toast = '';
              showToast = (message) => { toast = String(message || ''); };
              await window.wizardNext();

              assert(currentWizardStep === 1, 'Wizard should remain on the capacity step');
              assert(toast.includes('Line 2:'), 'Wizard should identify the invalid row number');
              assert(document.getElementById('wiz-csv-feedback').className.includes('text-danger'), 'Inline validation should show an error');
            })();
            """
        )

        self._run_node_regression(harness)

    @unittest.skipUnless(shutil.which('node'), 'Node.js is required for frontend config regression checks')
    def test_configured_vmid_change_invalidates_only_that_project_session(self):
        harness = textwrap.dedent(
            """
            (async () => {
              const assert = (condition, message) => {
                if (!condition) throw new Error(message);
              };

              window.PROJ_CACHE = {
                'project-a': { id: 'project-a', vms: [{ name: 'web', vmid: 101 }] },
              };
              const credKey = 'toolhub.session.proxmox.project-a';
              const metaKey = 'toolhub.session.proxmox.meta.project-a';
              sessionStorage.setItem(credKey, JSON.stringify({ username: 'root@pam', password: 'secret' }));
              sessionStorage.setItem(metaKey, JSON.stringify({ url: 'https://prox.example', apiPort: 8006, sshPort: 22 }));
              http = async () => ({ ok: true });

              await saveVM('project-a', 'web', { vmid: 101 }, { silent: true, rethrow: true });
              assert(sessionStorage.getItem(credKey), 'Saving the same VM ID should preserve authentication');

              await saveVM('project-a', 'web', { vmid: 102 }, { silent: true, rethrow: true });
              assert(sessionStorage.getItem(credKey) === null, 'Changing the configured VM ID should invalidate authentication');
              assert(sessionStorage.getItem(metaKey) === null, 'Changing the configured VM ID should clear connection metadata');
            })();
            """
        )

        self._run_node_regression(harness)

    @unittest.skipUnless(shutil.which('node'), 'Node.js is required for frontend wizard regression checks')
    def test_wizard_internet_node_creates_internet_connected_adapter(self):
        harness = textwrap.dedent(
            """
            (() => {
              const assert = (condition, message) => {
                if (!condition) throw new Error(message);
              };

              const makeSvgElement = (tagName) => {
                const el = {
                  tagName,
                  attributes: {},
                  children: [],
                  listeners: {},
                  style: {},
                  textContent: '',
                  innerHTML: '',
                  setAttribute(name, value) { this.attributes[name] = String(value); },
                  getAttribute(name) { return this.attributes[name] || ''; },
                  appendChild(child) { this.children.push(child); return child; },
                  addEventListener(type, handler) { this.listeners[type] = handler; },
                  removeEventListener(type) { delete this.listeners[type]; },
                };
                if (tagName === 'g') svgGroups.push(el);
                return el;
              };

              const installContainer = (el) => {
                el.children = [];
                el.listeners = {};
                el.appendChild = function(child) { this.children.push(child); return child; };
                el.addEventListener = function(type, handler) { this.listeners[type] = handler; };
                el.removeEventListener = function(type) { delete this.listeners[type]; };
                el.setAttribute = function(name, value) { this[name] = String(value); };
                el.getAttribute = function(name) { return this[name] || ''; };
              };

              const svgGroups = [];
              document.createElementNS = (ns, tagName) => makeSvgElement(tagName);

              const svg = document.getElementById('wiz-net-canvas');
              const linksG = document.getElementById('wiz-net-links');
              const nodesG = document.getElementById('wiz-net-nodes');
              const dragLine = document.getElementById('wiz-drag-line');
              const legend = document.getElementById('wiz-net-legend');
              [svg, linksG, nodesG, dragLine, legend].forEach(installContainer);
              svg.clientWidth = 720;
              svg.clientHeight = 560;
              svg.getBoundingClientRect = () => ({ left: 0, top: 0, width: 720, height: 560 });
              dragLine.style = {};

              wizSelectedTemplates = [{
                _wizId: 'vm-web',
                vmid: 900,
                name: 'web',
                finalName: 'web',
                user_accessible: true,
                nets: [],
                internet_connected_adaptors: [],
              }];

              window.wizNetGraph.init(wizSelectedTemplates);
              assert(svgGroups.length >= 2, 'Graph should render a VM node and an Internet node');
              const vmGroup = svgGroups[0];
              const internetGroup = svgGroups[1];
              const internetTransform = internetGroup.getAttribute('transform');
              assert(internetTransform.includes('translate('), 'Internet node should have a position');
              const coords = internetTransform.match(/translate\\(([-0-9.]+),([-0-9.]+)\\)/);
              assert(coords, `Unexpected Internet node transform: ${internetTransform}`);

              vmGroup.listeners.mousedown({ preventDefault() {}, button: 0 });
              svg.listeners.mouseup({ clientX: Number(coords[1]), clientY: Number(coords[2]) });
              window.wizNetGraph.saveState();

              assert(JSON.stringify(wizSelectedTemplates[0].nets) === JSON.stringify(['vmbr0']), 'Internet node should add vmbr0 to VM nets');
              assert(JSON.stringify(wizSelectedTemplates[0].internet_connected_adaptors) === JSON.stringify(['vmbr0']), 'Internet node link should persist vmbr0 as internet-connected');
            })();
            """
        )

        self._run_node_regression(harness)

    @unittest.skipUnless(shutil.which('node'), 'Node.js is required for frontend wizard regression checks')
    def test_wizard_can_clear_core_gateway_or_switch_to_another_template(self):
        harness = textwrap.dedent(
            r"""
            (async () => {
              const assert = (condition, message) => { if (!condition) throw new Error(message); };
              const ids = [900, 901, 902];
              const byId = id => document.getElementById(id);
              const selected = id => byId(`wiz-tpl-chk-${id}`);
              const gateway = id => byId(`wiz-tpl-proxy-${id}`);
              const bridge = id => byId(`wiz-tpl-proxy-bridge-${id}`);
              const rows = [];
              const tbody = {
                appendChild(row) { rows.push(row); },
                querySelectorAll() { return ids.map(gateway).filter(input => input.checked); },
              };
              const container = byId('wiz-templates-list');
              container.insertAdjacentHTML = () => {};
              container.querySelector = () => tbody;
              const createElement = document.createElement;
              document.createElement = tag => {
                const row = createElement(tag);
                if (tag !== 'tr') return row;
                const proxyControls = {style: {}};
                row.querySelector = selector => {
                  if (selector === '[data-wiz-proxy-controls]') {
                    const group = row.innerHTML.match(/<div[^>]+data-wiz-proxy-controls[^>]*>/)[0];
                    proxyControls.style.visibility = /visibility:\s*hidden/.test(group) ? 'hidden' : '';
                    row.proxyControls = proxyControls;
                    return proxyControls;
                  }
                  if (!selector.startsWith('#')) return null;
                  const id = selector.slice(1);
                  const input = row.innerHTML.match(new RegExp(`<input[^>]*id="${id}"[^>]*>`))[0];
                  const element = byId(id);
                  element.type = input.match(/type="([^"]+)"/)[1];
                  element.value = input.match(/value="([^"]*)"/)?.[1] || '';
                  element.disabled = /\sdisabled(?=\s|>)/.test(input);
                  element.addEventListener = (event, listener) => { element[event] = listener; };
                  return element;
                };
                return row;
              };
              document.querySelectorAll = () => ids.map(selected).filter(input => input.checked);
              globalThis.wizardFilterTable = () => {};
              globalThis.wizardGotoStep = step => { currentWizardStep = step; };
              const built = [];
              window.wizNetGraph = {init: templates => built.push(templates), saveState() {}};
              http = async (_method, url) => url.endsWith('/templates') ? {templates: ids.map(vmid => ({
                vmid, name: `vm-${vmid}`, node: 'pve', type: vmid === 902 ? 'lxc' : 'qemu',
              }))} : {ok: true};
              showToast = message => { throw new Error(message); };
              byId('wiz-feat-vm').checked = true;
              byId('wiz-proxmox-url').value = 'https://pve.example';
              byId('wiz-proxmox-user').value = 'operator';
              byId('wiz-proxmox-pass').value = 'fixture';
              currentWizardStep = 2;
              await window.wizardNext();

              assert(rows.length === 3 && currentWizardStep === 3, 'Wizard should render fetched templates');
              assert(rows.every(row => row.proxyControls.style.visibility === 'hidden'),
                'Gateway controls are hidden before row selection');
              assert(ids.every(id => gateway(id).disabled && bridge(id).disabled),
                'Gateway controls are disabled before row selection');
              for (const id of ids) { selected(id).checked = true; selected(id).change(); }
              assert(rows.every(row => row.proxyControls.style.visibility === ''),
                'Selecting a row shows both gateway controls');
              assert(gateway(900).type === 'checkbox' && !gateway(900).disabled && bridge(900).disabled,
                'Selecting a QEMU row enables its toggle before its bridge');
              assert(gateway(902).disabled && bridge(902).disabled, 'Selecting LXC keeps both controls disabled');
              gateway(900).checked = true; gateway(900).change();
              assert(!bridge(900).disabled, 'Gateway selection enables its bridge');
              selected(900).checked = false; selected(900).change();
              assert(rows[0].proxyControls.style.visibility === 'hidden' && rows[1].proxyControls.style.visibility === '',
                'Deselecting hides the controls for only that row');
              assert(!gateway(900).checked && gateway(900).disabled && bridge(900).disabled,
                'Deselecting a gateway row clears the role and disables both controls');
              selected(900).checked = true; selected(900).change();
              gateway(900).checked = true; gateway(900).change();
              gateway(901).checked = true; gateway(901).change();
              assert(!gateway(900).checked && bridge(900).disabled && !bridge(901).disabled,
                'Changing gateways leaves one checked template');

              bridge(901).value = 'vmbr2';
              await window.wizardNext();
              assert(built.at(-1)[1].proxy_config.uplink_bridge === 'vmbr2', 'Pass the selected bridge to the topology');
              window.wizardBack();
              gateway(901).checked = false; gateway(901).change();
              assert(bridge(901).disabled && selected(901).checked, 'Clearing the gateway keeps the VM selected');
              await window.wizardNext();
              assert(built.length === 2 && built.at(-1).every(vm => !vm.proxy_config),
                'Rebuild the topology with no reserved gateway uplink');
            })();
            """
        )
        self._run_node_regression(harness)

    @unittest.skipUnless(shutil.which('node'), 'Node.js is required for frontend wizard regression checks')
    def test_core_gateway_reserves_net1_and_requires_internal_connection(self):
        harness = textwrap.dedent(
            """
            (() => {
              const assert = (condition, message) => { if (!condition) throw new Error(message); };
              const groups = [];
              document.createElementNS = (ns, tagName) => {
                const el = {
                  tagName, attributes: {}, children: [], listeners: {}, style: {}, textContent: '', innerHTML: '',
                  setAttribute(name, value) { this.attributes[name] = String(value); },
                  getAttribute(name) { return this.attributes[name] || ''; },
                  appendChild(child) { this.children.push(child); return child; },
                  addEventListener(type, handler) { this.listeners[type] = handler; },
                };
                if (tagName === 'g') groups.push(el);
                return el;
              };
              const install = el => {
                el.children = []; el.listeners = {};
                el.appendChild = function(child) { this.children.push(child); return child; };
                el.addEventListener = function(type, handler) { this.listeners[type] = handler; };
                el.setAttribute = function(name, value) { this[name] = String(value); };
                el.getAttribute = function(name) { return this[name] || ''; };
              };
              const svg = document.getElementById('wiz-net-canvas');
              const links = document.getElementById('wiz-net-links');
              const nodes = document.getElementById('wiz-net-nodes');
              const drag = document.getElementById('wiz-drag-line');
              const legend = document.getElementById('wiz-net-legend');
              [svg, links, nodes, drag, legend].forEach(install);
              svg.clientWidth = 720; svg.clientHeight = 560;
              svg.getBoundingClientRect = () => ({ left: 0, top: 0, width: 720, height: 560 });
              drag.style = {};
              showToast = () => {};
              const proxyPanel = document.getElementById('wiz-proxy-settings');
              const mode = document.getElementById('wiz-proxy-mode');
              const addresses = document.getElementById('wiz-proxy-addresses');
              const translations = document.getElementById('wiz-proxy-translations');
              mode.dataset.proxyField = 'mode';
              addresses.dataset.proxyField = 'external_addresses';
              translations.dataset.proxyField = 'translations';
              proxyPanel.querySelectorAll = () => [mode, addresses, translations];
              wizSelectedTemplates = [
                { _wizId: 'proxy', vmid: 900, name: 'proxy', finalName: 'proxy',
                  user_accessible: false, nets: [], internet_connected_adaptors: [],
                  proxy_config: { ...defaultCoreProxyConfig(), router_node: 'n3', uplink_bridge: 'vmbr2',
                    external_addresses: ['129.108.4.46:443'],
                    translations: ['100.100.100.100:8080:129.108.156.63:11434-11436'] } },
                { _wizId: 'client', vmid: 901, name: 'client', finalName: 'client',
                  user_accessible: true, nets: [], internet_connected_adaptors: [], proxy_config: null },
              ];
              window.wizNetGraph.init(wizSelectedTemplates);
              assert(groups.length >= 3, 'Proxy, client, and Internet nodes should render');
              mode.value = 'full'; mode.onchange();
              assert(addresses.disabled && addresses.value === '', 'Full mode must disable and clear the destination allowlist');
              assert(document.getElementById('wiz-proxy-addresses-label').textContent.includes('none needed'),
                'Wizard label should say that full access needs no allowed destinations');
              assert(document.getElementById('wiz-proxy-translations-label').textContent.includes('optional'),
                'Wizard label should say translations are optional');
              assert(!translations.disabled && translations.value.includes('100.100.100.100'),
                'Full mode must keep translations available');
              assert(window.wizNetGraph.validateProxyTopology() === false, 'Proxy needs an internal NIC');
              const proxy = groups[0], client = groups[1], internet = groups[2];
              const coords = group => group.getAttribute('transform').match(/translate\\(([-0-9.]+),([-0-9.]+)\\)/);
              const proxyCoords = coords(proxy), internetCoords = coords(internet);
              client.listeners.mousedown({ preventDefault() {}, button: 0 });
              svg.listeners.mouseup({ clientX: Number(proxyCoords[1]), clientY: Number(proxyCoords[2]) });
              assert(window.wizNetGraph.validateProxyTopology() === true, 'Internal net0 plus uplink net1 is valid');
              window.wizNetGraph.saveState();
              assert(JSON.stringify(wizSelectedTemplates[0].nets) === JSON.stringify(['netA', 'vmbr2']),
                'CORE gateway must keep internal net0 and use the chosen bridge on net1');
              assert(JSON.stringify(wizSelectedTemplates[0].internet_connected_adaptors) === JSON.stringify(['vmbr2']),
                'The chosen bridge should be the only Internet-connected interface');
              client.listeners.mousedown({ preventDefault() {}, button: 0 });
              svg.listeners.mouseup({ clientX: Number(internetCoords[1]), clientY: Number(internetCoords[2]) });
              window.wizNetGraph.saveState();
              assert(wizSelectedTemplates[1].internet_connected_adaptors.length === 0,
                'Client linked to gateway must not gain a direct Internet NIC');
            })();
            """
        )
        self._run_node_regression(harness)

    @unittest.skipUnless(shutil.which('node'), 'Node.js is required for frontend config regression checks')
    def test_configuration_keeps_the_fixed_uplink_in_its_configured_slot(self):
        harness = textwrap.dedent(
            """
            (() => {
              const assert = (condition, message) => { if (!condition) throw new Error(message); };
              const vm = {
                proxy_config: { uplink_bridge: 'vmbr2' },
                internal_network_adaptors: ['lab', 'vmbr0', 'extra'],
                internet_connected_adaptors: ['vmbr0'],
              };
              const listId = 'vm-proj-0-nets-list';
              const html = renderVmNetworkRows(listId, vm);
              const [, net0, net1, net2] = html.split('<li');
              assert(net1.includes('data-proxy-uplink="true"') && /value="vmbr2"\\s+disabled/.test(net1),
                'The locked second row should show the fixed uplink');
              assert(net1.includes('data-net-internet checked disabled'), 'The uplink should be locked to Internet');
              assert(net0.includes('value="lab"') && net2.includes('value="extra"') && !html.includes('value="vmbr0"'),
                'The fixed uplink should replace only the stale net1 row');
              assert([net0, net1, net2].every(row => row.includes('draggable="true"')),
                'Every gateway interface row should have a drag handle');
              const ordinaryVm = renderVmNetworkRows(listId, { ...vm, proxy_config: {} });
              assert(ordinaryVm.includes('value="vmbr0"') && !ordinaryVm.includes('data-proxy-uplink'),
                'An ordinary VM should keep its configured bridge and editable interfaces');
              const [, uplinkFirst, internalSecond] = renderVmNetworkRows(listId, {
                ...vm,
                internal_network_adaptors: ['vmbr2', 'lab'],
                internet_connected_adaptors: ['vmbr2'],
              }).split('<li');
              assert(uplinkFirst.includes('data-proxy-uplink="true"') && uplinkFirst.includes('draggable="true"') &&
                internalSecond.includes('value="lab"') && !internalSecond.includes('data-proxy-uplink'),
                'The moved uplink should stay locked and draggable in the first slot after reloading');

              const prefix = 'vm-proj-0-proxy';
              const editor = document.getElementById(prefix + '-bridge');
              const uplink = { value: 'vmbr2', disabled: true };
              const internal = { value: 'lab' };
              const extra = { value: 'extra' };
              const networkRow = (input, checked) => ({
                querySelector: selector => selector === 'input.form-control' ? input : { checked },
              });
              const rows = [networkRow(internal, false), networkRow(uplink, true), networkRow(extra, false)];
              document.getElementById(prefix + '-enabled').checked = true;
              document.getElementById(prefix + '-router').value = 'n3';
              document.querySelector = () => uplink;
              document.querySelectorAll = selector => selector.endsWith('input.form-control')
                ? [internal, uplink, extra] : rows;
              const saves = [];
              showToast = () => {};
              saveVmImmediately = (pid, idx) => saves.push({
                policy: collectVmProxyConfig(pid, idx),
                network: collectVmNetworkRows(pid, idx),
              });

              editor.value = ' lab ';
              onVmProxyUplinkChange('proj', 0, editor);
              assert(editor.value === 'vmbr2' && saves.length === 0, 'Reject an existing interface name');
              editor.value = 'not a bridge';
              onVmProxyUplinkChange('proj', 0, editor);
              assert(editor.value === 'vmbr2' && saves.length === 0, 'Reject an invalid bridge name');
              editor.value = ' vmbr10 ';
              assert(collectVmProxyConfig('proj', 0).uplink_bridge === 'vmbr2', 'Ignore an unfinished bridge edit');
              onVmProxyUplinkChange('proj', 0, editor);
              assert(editor.value === 'vmbr10' && uplink.value === 'vmbr10' && uplink.disabled,
                'Mirror and lock the new bridge on net1');
              assert(saves.length === 1 && saves[0].policy.uplink_bridge === 'vmbr10' && saves[0].policy.router_node === 'n3',
                'Save the new bridge with the existing gateway policy');
              assert(saves[0].network.adaptors.join(',') === 'lab,vmbr10,extra' && saves[0].network.internetConnectedAdaptors.join(',') === 'vmbr10',
                'Save net0 as internal and net1 as the sole Internet bridge');

              const [internalRow, uplinkRow, extraRow] = rows;
              let activeGateway = true;
              const list = {
                id: listId,
                contains: row => rows.includes(row),
                querySelector(selector) {
                  if (selector === '[data-proxy-uplink]') return activeGateway ? uplinkRow : null;
                  if (selector === '[data-network-dragging]') return rows.find(row => row.dataset.networkDragging);
                  return rows.find(row => row.dataset.networkDrop);
                },
                insertBefore(row, before) {
                  rows.splice(rows.indexOf(row), 1);
                  rows.splice(before ? rows.indexOf(before) : rows.length, 0, row);
                },
              };
              for (const row of rows) {
                row.dataset = {};
                row.parentElement = list;
                row.closest = () => row;
                row.removeAttribute = name => {
                  if (name === 'data-network-dragging') delete row.dataset.networkDragging;
                  if (name === 'data-network-drop') delete row.dataset.networkDrop;
                };
                row.getBoundingClientRect = () => ({ top: 0, height: 20 });
                Object.defineProperty(row, 'nextElementSibling', { get: () => rows[rows.indexOf(row) + 1] || null });
              }
              const grip = { closest: () => uplinkRow, focus() {} };
              const drag = { currentTarget: grip, target: internalRow, clientY: 2,
                dataTransfer: { setData() {} }, preventDefault() {} };
              onVmProxyNetworkDragStart(drag);
              onVmProxyNetworkDragOver(list, drag);
              assert(internalRow.dataset.networkDrop === 'before', 'Highlight the slot above the internal interface');
              onVmProxyNetworkDrop(list, drag);
              assert(!uplinkRow.dataset.networkDragging && !internalRow.dataset.networkDrop, 'Clear the drag indicators after dropping');
              assert(saves[1].network.adaptors.join(',') === 'vmbr10,lab,extra' &&
                saves[1].network.internetConnectedAdaptors.join(',') === 'vmbr10' && saves[1].policy.uplink_bridge === 'vmbr10',
                'Dropping should save the new order and keep the Internet bridge and policy');
              onVmProxyNetworkOrderKey({ key: 'ArrowDown', currentTarget: grip, preventDefault() {} });
              assert(saves[2].network.adaptors.join(',') === 'lab,vmbr10,extra', 'Moving down with the keyboard should save the restored order');

              const internalDrag = { ...drag, currentTarget: { closest: () => internalRow }, target: extraRow, clientY: 18 };
              onVmProxyNetworkDragStart(internalDrag);
              onVmProxyNetworkDragOver(list, internalDrag);
              onVmProxyNetworkDrop(list, internalDrag);
              assert(saves[3].network.adaptors.join(',') === 'vmbr10,extra,lab',
                'Dragging an internal interface should reorder the internal NICs');
              const dropOnUplink = { ...internalDrag, target: uplinkRow, clientY: 2 };
              onVmProxyNetworkDragStart(dropOnUplink);
              onVmProxyNetworkDragOver(list, dropOnUplink);
              onVmProxyNetworkDrop(list, dropOnUplink);
              assert(saves[4].network.adaptors.join(',') === 'lab,vmbr10,extra' &&
                saves[4].network.internetConnectedAdaptors.join(',') === 'vmbr10',
                'An internal row can drop beside the Internet row without changing its bridge');
              activeGateway = false;
              onVmProxyNetworkDragStart(internalDrag);
              assert(!internalRow.dataset.networkDragging, 'Dragging is available only on gateway VMs');
            })();
            """
        )
        self._run_node_regression(harness)

    @unittest.skipUnless(shutil.which('node'), 'Node.js is required for frontend config regression checks')
    def test_core_gateway_full_mode_disables_only_allowlist(self):
        harness = textwrap.dedent(
            """
            (() => {
              const assert = (condition, message) => { if (!condition) throw new Error(message); };
              const prefix = 'vm-proj-0-proxy';
              document.getElementById(prefix + '-enabled').checked = true;
              document.getElementById(prefix + '-mode').value = 'full';
              const addresses = document.getElementById(prefix + '-addresses');
              const translations = document.getElementById(prefix + '-translations');
              addresses.value = '129.108.4.46:443';
              translations.value = '100.100.100.100:8080:129.108.156.63:11434-11436';
              saveVmImmediately = () => {};
              onVmProxyModeChange('proj', 0);
              assert(addresses.disabled && addresses.value === '', 'Full mode clears and disables allowed destinations');
              assert(document.getElementById(prefix + '-addresses-label').textContent.includes('none needed'),
                'Configuration label should say that no allowed destination is required');
              assert(document.getElementById(prefix + '-translations-label').textContent.includes('optional'),
                'Configuration label should mark translations optional');
              assert(!translations.disabled && translations.value.includes('100.100.100.100'),
                'Full mode keeps translations editable');
              const config = collectVmProxyConfig('proj', 0);
              assert(config.external_addresses.length === 0 && config.translations.length === 1,
                'Saved full policy should retain translations without a destination allowlist');
            })();
            """
        )
        self._run_node_regression(harness)

    @unittest.skipUnless(shutil.which('node'), 'Node.js is required for frontend config regression checks')
    def test_add_interface_internet_toggle_waits_for_input(self):
        harness = textwrap.dedent(
            """
            (() => {
              const assert = (condition, message) => {
                if (!condition) throw new Error(message);
              };

              const input = document.getElementById('vm-proj-0-nets-input');
              const internetToggle = document.getElementById('vm-proj-0-nets-internet');
              const addButton = document.getElementById('btn-add-net-proj-0');

              input.value = '';
              internetToggle.checked = true;
              internetToggle.disabled = false;
              onAdaptorInput('proj', 0, input);
              assert(internetToggle.disabled === true, 'Internet toggle should be disabled with empty input');
              assert(internetToggle.checked === false, 'Internet toggle should clear when input is empty');
              assert(addButton.disabled === true, 'Add button should stay disabled with empty input');

              input.value = 'n';
              onAdaptorInput('proj', 0, input);
              assert(internetToggle.disabled === false, 'Internet toggle should enable after a valid interface-name character');
              assert(addButton.disabled === false, 'Add button should enable for a valid internal adaptor name');

              input.value = 'enp0s3';
              internetToggle.checked = false;
              onAdaptorInput('proj', 0, input);
              assert(internetToggle.disabled === false, 'Internet toggle should stay available for an internet-style name');
              assert(addButton.disabled === true, 'Add button should reject internet-style names until Internet is selected');

              internetToggle.checked = true;
              onAdaptorInput('proj', 0, input);
              assert(addButton.disabled === false, 'Add button should enable after selecting Internet for a valid interface name');
            })();
            """
        )

        self._run_node_regression(harness)

    @unittest.skipUnless(shutil.which('node'), 'Node.js is required for frontend config regression checks')
    def test_internet_toggle_saves_vm_network_state_immediately(self):
        harness = textwrap.dedent(
            """
            (async () => {
              const assert = (condition, message) => {
                if (!condition) throw new Error(message);
              };
              const wait = () => new Promise(resolve => setTimeout(resolve, 20));
              const makeHarnessElement = (id) => ({
                id: String(id || ''),
                value: '',
                checked: false,
                textContent: '',
                classList: { add() {}, remove() {}, toggle() {} },
                querySelector() { return null; },
                querySelectorAll() { return []; },
                closest() { return null; },
                matches() { return false; },
              });

              document.getElementById('vm-name-display-proj-0').textContent = 'web';
              document.getElementById('vm-proj-0-vmid').value = '';
              document.getElementById('vm-proj-0-type').value = 'qemu';
              document.getElementById('vm-proj-0-user').value = '';
              document.getElementById('vm-proj-0-pass').value = '';

              const textInput = makeHarnessElement('network-input');
              textInput.value = 'vmbr0';
              const internetToggle = makeHarnessElement('network-internet-toggle');
              internetToggle.checked = true;
              internetToggle.matches = (selector) => selector === '[data-net-internet]';
              const row = makeHarnessElement('network-row');
              row.querySelector = (selector) => {
                if (selector === 'input.form-control') return textInput;
                if (selector === '[data-net-internet]') return internetToggle;
                return null;
              };
              textInput.closest = () => row;
              internetToggle.closest = () => row;
              document.querySelectorAll = (selector) => {
                if (selector === '#vm-proj-0-nets-list li') return [row];
                return [];
              };

              window.PROJ_CACHE = {
                proj: {
                  vms: [{
                    name: 'web',
                    internal_network_adaptors: ['vmbr0'],
                    internet_connected_adaptors: [],
                  }],
                },
              };

              const calls = [];
              http = async (method, url, body) => {
                calls.push({ method, url, body });
                return { ok: true };
              };

              onListItemEdit('vm-proj-0-nets-list', internetToggle);
              await wait();

              assert(calls.length === 1, `Expected an immediate PATCH, got ${calls.length} calls`);
              assert(calls[0].method === 'PATCH', 'Internet toggle should PATCH the VM');
              assert(calls[0].url === '/api/projects/proj/vms/web', `Unexpected URL: ${calls[0].url}`);
              assert(JSON.stringify(calls[0].body.internal_network_adaptors) === JSON.stringify(['vmbr0']), 'Internal adaptor list should include vmbr0');
              assert(JSON.stringify(calls[0].body.internet_connected_adaptors) === JSON.stringify(['vmbr0']), 'Internet adaptor list should include vmbr0');
              assert(JSON.stringify(window.PROJ_CACHE.proj.vms[0].internet_connected_adaptors) === JSON.stringify(['vmbr0']), 'Project cache should reflect the internet toggle immediately');
            })();
            """
        )

        self._run_node_regression(harness)

    @unittest.skipUnless(shutil.which('node'), 'Node.js is required for frontend config regression checks')
    def test_csv_credentials_replace_old_rows_and_save_immediately(self):
        harness = textwrap.dedent(
            """
            (async () => {
              const assert = (condition, message) => {
                if (!condition) throw new Error(message);
              };

              const pid = 'proj';
              document.getElementById(`cfg-${pid}-instances`).value = '2';
              const fileInput = document.getElementById(`cfg-${pid}-cred-file`);
              fileInput.files = [{ text: async () => 'new-user,new-password' }];

              let rendered = [
                { username: 'old-user-1', password: 'old-password-1' },
                { username: 'old-user-2', password: 'old-password-2' },
              ];
              renderCredentials = (_pid, credentials) => {
                rendered = credentials.map(item => ({ ...item }));
                return '<div>rendered</div>';
              };
              collectCredentials = () => rendered.map(item => ({ ...item }));
              window.showConfirmModal = async () => 'no';
              window.PROJ_CACHE = { proj: { id: pid, credentials: rendered.map(item => ({ ...item })) } };

              const calls = [];
              http = async (method, url, body) => {
                calls.push({ method, url, body });
                return { id: pid, credentials: body.credentials };
              };

              await uploadCredentialsFile(pid);

              assert(calls.length === 1, `Expected one immediate save, got ${calls.length}`);
              assert(calls[0].method === 'PATCH', 'CSV replacement should PATCH the project');
              assert(calls[0].url === '/api/projects/proj', `Unexpected URL: ${calls[0].url}`);
              const saved = calls[0].body.credentials;
              assert(saved.length === 2, 'Credentials should remain aligned with the instance count');
              assert(saved[0].username === 'new-user' && saved[0].password === 'new-password', 'CSV row should replace the first credential');
              assert(saved[1].username !== 'old-user-2', 'Missing CSV rows must not retain an old username');
              assert(saved[1].password !== 'old-password-2', 'Missing CSV rows must not retain an old password');
              assert(window.PROJ_CACHE.proj.credentials[0].username === 'new-user', 'Project cache should update after save');
              assert(window.PROJ_CACHE.proj.credentials[1].username !== 'old-user-2', 'Project cache must not retain old trailing credentials');
            })();
            """
        )

        self._run_node_regression(harness)


if __name__ == '__main__':
    unittest.main()
