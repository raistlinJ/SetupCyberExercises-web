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
