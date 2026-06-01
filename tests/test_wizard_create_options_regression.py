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

            const windowObj = {{
              document,
              shell,
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
              wizSelectedTemplates = [{
                vmid: 900,
                name: 'web',
                finalName: 'web',
                user_accessible: false,
                vm_user: 'student',
                vm_pass: 'password',
                nets: ['lab'],
                internet_connected_adaptors: [],
              }];

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
                    vms: [{ name: 'web', viewable_to_user: false }],
                  };
                }
                if (method === 'PUT' && url === '/api/projects/proj-wizard/secrets') return { ok: true };
                if (method === 'POST' && url === '/api/projects/proj-wizard/instances/actions/create') return { created: [{ name: 'web-lab-1' }] };
                if (method === 'PATCH' && url === '/api/projects/proj-wizard/vms/web') return { ok: true };
                if (method === 'POST' && url === '/api/projects/proj-wizard/instances/actions/users_create') {
                  return { created_users: [{ userid: 'user01@pve' }], created_pools: [{ pool: 'user01' }], added_members: [{ name: 'web-lab-1' }] };
                }
                if (method === 'POST' && url === '/api/projects/proj-wizard/instances/actions/apply_scenario') return { applied: [{ name: 'web-lab-1' }] };
                throw new Error(`Unexpected request: ${method} ${url}`);
              };

              await window.submitProjectCreation('wizard');

              const createCall = calls.find(call => call.url === '/api/projects/proj-wizard/instances/actions/create');
              assert(createCall, 'Wizard should call VM create');
              assert(createCall.body.applyScenario === false, 'Wizard create should defer scenario notes to the follow-up option');
              assert(createCall.body.syncUserAccess === false, 'Wizard create should defer user access to follow-up actions');
              assert(createCall.body.setNetworkInterfaces === true, 'Wizard create should pass the network option');
              assert(createCall.body.takeSnapshot === true, 'Wizard create should pass the snapshot option');

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


if __name__ == '__main__':
    unittest.main()
