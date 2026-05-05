import json
import shutil
import subprocess
import textwrap
import unittest
from pathlib import Path


class VmCreateFollowUpRegressionTests(unittest.TestCase):

    def _run_node_regression(self, harness: str):
        node = shutil.which('node')
        if not node:
            self.skipTest('Node.js is required for frontend create follow-up regression checks')

        node_script = textwrap.dedent(
            f"""
            const fs = require('fs');
            const path = require('path');
            const vm = require('vm');

            function makeStorage() {{
              const store = new Map();
              return {{
                getItem(key) {{
                  const value = store.get(String(key));
                  return value === undefined ? null : value;
                }},
                setItem(key, value) {{
                  store.set(String(key), String(value));
                }},
                removeItem(key) {{
                  store.delete(String(key));
                }},
                clear() {{
                  store.clear();
                }},
              }};
            }}

            function makeClassList() {{
              return {{
                add() {{}},
                remove() {{}},
                toggle() {{}},
                replace() {{}},
                contains() {{ return false; }},
              }};
            }}

            function makeElement(name) {{
              return {{
                id: String(name || ''),
                value: '',
                checked: false,
                innerHTML: '',
                textContent: '',
                className: '',
                style: {{}},
                dataset: {{}},
                disabled: false,
                open: false,
                hidden: false,
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
                showModal() {{ this.open = true; }},
                close() {{ this.open = false; }},
                setAttribute(name, value) {{ this[name] = value; }},
                getAttribute(name) {{ return this[name] || ''; }},
                removeAttribute(name) {{ delete this[name]; }},
              }};
            }}

            const elements = new Map();
            const document = {{
              cookie: '',
              body: makeElement('body'),
              addEventListener() {{}},
              removeEventListener() {{}},
              dispatchEvent() {{ return true; }},
              getElementById(id) {{
                const key = String(id || '');
                if (!elements.has(key)) elements.set(key, makeElement(key));
                return elements.get(key);
              }},
              querySelector() {{ return null; }},
              querySelectorAll() {{ return []; }},
              createElement(tagName) {{ return makeElement(tagName); }},
            }};

            const shell = {{
              logDebug() {{}},
              logInfo() {{}},
              logError() {{}},
              logWarn() {{}},
              logSuccess() {{}},
              beginActionContext() {{}},
              endActionContext() {{}},
              step() {{}},
              initShell: async () => {{}},
              getCurrentProjectId() {{ return ''; }},
              setCurrentProjectId() {{}},
              refreshSidebar: async () => {{}},
              setSidebarImportBusy() {{}},
            }};

            const sessionStorage = makeStorage();
            const localStorage = makeStorage();
            const windowObj = {{
              document,
              shell,
              bootstrap: null,
              sessionStorage,
              localStorage,
              history: {{ replaceState() {{}} }},
              location: {{
                href: 'http://localhost:8080/static/vm_manager.html?id=test-project',
                protocol: 'http:',
                pathname: '/static/vm_manager.html',
                search: '',
                hash: '',
              }},
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
              fetch: async () => ({{ ok: true, json: async () => ({{ projects: [] }}) }}),
              http: async () => ({{}}),
              bootstrap: null,
              URL,
              URLSearchParams,
              FormData: function FormData() {{ this.append = () => {{}}; }},
              Blob: function Blob(parts, options) {{ this.parts = parts; this.options = options; }},
              CustomEvent: function CustomEvent(type, init) {{ this.type = type; this.detail = init && init.detail; }},
              Event: function Event(type) {{ this.type = type; }},
              performance: {{ now: () => 0 }},
              setTimeout,
              clearTimeout,
              setInterval,
              clearInterval,
              requestAnimationFrame: (callback) => callback(),
              cancelAnimationFrame() {{}},
              queueMicrotask,
              alert(message) {{ throw new Error('Unexpected alert: ' + message); }},
              confirm() {{ return true; }},
            }};
            context.window.window = windowObj;
            context.window.document = document;
            context.window.performance = context.performance;
            context.global = context;
            context.globalThis = context;

            const source = fs.readFileSync(path.join(process.cwd(), 'app/static/js/vm_manager.js'), 'utf8');
            const harness = {json.dumps(harness)};

            (async () => {{
              const result = vm.runInNewContext(source + '\\n' + harness, context, {{ filename: 'vm_manager.create_followup.bundle.js' }});
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
                'Node regression harness failed for vm_manager.js create follow-ups\n'
                f'STDOUT:\n{result.stdout}\n'
                f'STDERR:\n{result.stderr}'
            )

    @unittest.skipUnless(shutil.which('node'), 'Node.js is required for frontend create follow-up regression checks')
    def test_create_followups_patch_access_then_run_users_scenario_and_start(self):
        harness = textwrap.dedent(
            """
            (async () => {
              const assert = (condition, message) => {
                if (!condition) throw new Error(message);
              };

              maybeRetryVerifiedVmAction = async ({ resp }) => ({ resp, verifiedCount: 0 });

              const calls = [];
              http = async (method, url, body) => {
                calls.push({ method, url, body });
                if (method === 'PATCH' && url === '/api/projects/proj-1/vms/web') {
                  return { ok: true };
                }
                if (method === 'POST' && url === '/api/projects/proj-1/instances/actions/users_create') {
                  return { created_users: [{ userid: 'alice@pve' }] };
                }
                if (method === 'POST' && url === '/api/projects/proj-1/instances/actions/apply_scenario') {
                  return { applied: [{ name: 'web-lab-1' }] };
                }
                if (method === 'POST' && url === '/api/projects/proj-1/instances/actions/start') {
                  return { started: [{ name: 'web-lab-1' }] };
                }
                throw new Error(`Unexpected request: ${method} ${url}`);
              };

              const proj = {
                id: 'proj-1',
                name: 'Project One',
                tag: '-lab-',
                vms: [{ name: 'web', viewable_to_user: false }],
              };

              const resp = await runVmCreateFollowUpActions({
                proj,
                targets: [{ index: 1, name: 'web-lab-1' }],
                baseBody: { baseUrl: 'https://proxmox.local', verifySSL: false },
                createOptions: {
                  createUsersAndPerms: true,
                  enableUserAccessibility: true,
                  applyScenario: true,
                  startVm: true,
                },
                setProgress() {},
                contextLabel: 'Project One',
                summaryResp: {},
              });

              assert(proj.vms[0].viewable_to_user === true, 'Create follow-up should update the local viewable_to_user flag');
              assert(calls.length === 4, `Expected four create follow-up requests, saw ${calls.length}`);
              assert(calls[0].method === 'PATCH' && calls[0].url === '/api/projects/proj-1/vms/web', 'User accessibility should patch the VM template first');
              assert(calls[0].body && calls[0].body.viewable_to_user === true, 'User accessibility patch should enable viewable_to_user');
              assert(calls[1].url === '/api/projects/proj-1/instances/actions/users_create', 'Users follow-up should run after the access flag update');
              assert(calls[2].url === '/api/projects/proj-1/instances/actions/apply_scenario', 'Scenario follow-up should run after users');
              assert(calls[3].url === '/api/projects/proj-1/instances/actions/start', 'Start follow-up should run last');
              assert(!calls.some(call => call.url === '/api/projects/proj-1/instances/actions/users_access_sync'), 'Users create should replace a redundant users_access_sync call when both toggles are enabled');
              assert(Array.isArray(resp.created_users) && resp.created_users.length === 1, 'Create follow-up summary should include created users');
              assert(Array.isArray(resp.applied) && resp.applied.length === 1, 'Create follow-up summary should include applied scenario notes');
              assert(Array.isArray(resp.started) && resp.started.length === 1, 'Create follow-up summary should include started VMs');
            })();
            """
        )

        self._run_node_regression(harness)

    @unittest.skipUnless(shutil.which('node'), 'Node.js is required for frontend delete follow-up regression checks')
    def test_delete_followups_disable_access_before_delete(self):
        harness = textwrap.dedent(
            """
            (async () => {
              const assert = (condition, message) => {
                if (!condition) throw new Error(message);
              };

              const calls = [];
              http = async (method, url, body) => {
                calls.push({ method, url, body });
                if (method === 'PATCH' && url === '/api/projects/proj-1/vms/web') {
                  return { ok: true };
                }
                if (method === 'POST' && url === '/api/projects/proj-1/instances/actions/users_access_sync') {
                  return { applied: [{ name: 'web-lab-1', userid: 'alice@pve' }] };
                }
                if (method === 'POST' && url === '/api/projects/proj-1/instances/actions/delete') {
                  return { deleted: [{ name: 'web-lab-1' }] };
                }
                throw new Error(`Unexpected request: ${method} ${url}`);
              };

              maybeRetryVerifiedVmAction = async ({ resp }) => ({ resp, verifiedCount: 0 });

              const proj = {
                id: 'proj-1',
                name: 'Project One',
                tag: '-lab-',
                vms: [{ name: 'web', viewable_to_user: true }],
                proxmox_url: 'https://proxmox.local',
                proxmox_verify_ssl: false,
                proxmox_api_port: 8006,
                instance_statuses: [{
                  index: 1,
                  vm_details: [{ name: 'web-lab-1' }],
                }],
              };

              PROJ = proj;
              readProxCreds = () => ({ username: 'root@pam', password: 'secret' });
              showActionSummary = () => {};
              emitActionLogs = () => {};
              vmRefresh = async () => {};

              await vmActionExec('delete', {
                targets: [{ index: 1, name: 'web-lab-1' }],
                deleteOptions: {
                  deleteUsersAndPools: true,
                  disableUserAccessibility: true,
                  verifyCleanup: false,
                },
              });

              assert(proj.vms[0].viewable_to_user === false, 'Delete follow-up should update the local viewable_to_user flag');
              assert(calls.length === 3, `Expected three delete requests, saw ${calls.length}`);
              assert(calls[0].method === 'PATCH' && calls[0].url === '/api/projects/proj-1/vms/web', 'Delete flow should patch the VM template first');
              assert(calls[0].body && calls[0].body.viewable_to_user === false, 'Delete accessibility patch should disable viewable_to_user');
              assert(calls[1].url === '/api/projects/proj-1/instances/actions/users_access_sync', 'Delete flow should revoke Proxmox access before deletion');
              assert(calls[1].body && calls[1].body.enable === false, 'Delete accessibility sync should disable access');
              assert(calls[2].url === '/api/projects/proj-1/instances/actions/delete', 'Delete request should run after the accessibility follow-up');
            })();
            """
        )

        self._run_node_regression(harness)


if __name__ == '__main__':
    unittest.main()
