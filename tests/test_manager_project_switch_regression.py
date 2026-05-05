import json
import shutil
import subprocess
import textwrap
import unittest
from pathlib import Path


class ManagerProjectSwitchRegressionTests(unittest.TestCase):

    def _run_node_regression(self, source_path, harness, bundle_name):
        node = shutil.which('node')
        if not node:
            self.skipTest('Node.js is required for frontend project-switch regression checks')

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
                href: 'http://localhost:8080/static/test.html?id=test-project',
                protocol: 'http:',
                pathname: '/static/test.html',
                search: '',
                hash: '',
              }},
              CREDS: {{
                readPersistCtfdToken() {{ return ''; }},
                fetchProjectSecrets: async () => {{}},
              }},
              AUTH: {{}},
              showConfirmModal: async () => 'continue',
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
              AUTH: windowObj.AUTH,
              CREDS: windowObj.CREDS,
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

            const source = fs.readFileSync(path.join(process.cwd(), {json.dumps(source_path)}), 'utf8');
            const harness = {json.dumps(harness)};

            (async () => {{
              const result = vm.runInNewContext(source + '\\n' + harness, context, {{ filename: {json.dumps(bundle_name)} }});
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
                f'Node regression harness failed for {source_path}\n'
                f'STDOUT:\n{result.stdout}\n'
                f'STDERR:\n{result.stderr}'
            )

    @unittest.skipUnless(shutil.which('node'), 'Node.js is required for frontend project-switch regression checks')
    def test_vm_refresh_uses_project_snapshot_when_selection_changes(self):
        harness = textwrap.dedent(
            """
            (async () => {
              const assert = (condition, message) => {
                if (!condition) throw new Error(message);
              };

              const noop = () => {};
              runQueued = async (_label, fn) => await fn();
              showVmInlineProgress = noop;
              updateVmInlineProgress = noop;
              hideVmInlineProgress = noop;
              showActionProgress = noop;
              updateActionProgress = noop;
              hideActionProgress = noop;
              vmMarkLiveRefreshed = noop;
              renderVmTable = noop;
              startVmActionStatusPolling = () => noop;

              const calls = [];
              let releaseHydrate;
              const hydrateGate = new Promise((resolve) => { releaseHydrate = resolve; });

              SELECTED_PIDS = null;
              PROJ = {
                id: 'project-a',
                name: 'Alpha',
                proxmox_url: 'https://alpha.example',
                proxmox_api_port: 8006,
                proxmox_verify_ssl: true,
                instance_statuses: [],
              };

              hydrateProxCredsFromPersisted = async (pid) => {
                assert(pid === 'project-a', 'VM refresh should hydrate creds for the original project');
                await hydrateGate;
                return { username: 'alpha-user', password: 'alpha-pass' };
              };

              http = async (method, url, body) => {
                calls.push({ method, url, body });
                return { instance_statuses: [] };
              };

              const refreshPromise = vmRefresh({ showProgressDialog: false });
              await Promise.resolve();

              PROJ = {
                id: 'project-b',
                name: 'Beta',
                proxmox_url: 'https://beta.example',
                proxmox_api_port: 9443,
                proxmox_verify_ssl: false,
                instance_statuses: [],
              };

              releaseHydrate();
              await refreshPromise;

              assert(calls.length === 1, `Expected one VM refresh request, saw ${calls.length}`);
              assert(calls[0].url === '/api/projects/project-a/instances/refresh/vm', 'VM refresh should post to the original project id');
              assert(calls[0].body.baseUrl === 'https://alpha.example', 'VM refresh should keep the original project baseUrl');
              assert(Number(calls[0].body.apiPort) === 8006, 'VM refresh should keep the original project API port');
              assert(calls[0].body.verifySSL === true, 'VM refresh should keep the original project SSL setting');
              assert(PROJ && PROJ.id === 'project-b', 'VM refresh should not overwrite the newly selected project');
            })();
            """
        )

        self._run_node_regression('app/static/js/vm_manager.js', harness, 'vm_manager.bundle.js')

    @unittest.skipUnless(shutil.which('node'), 'Node.js is required for frontend project-switch regression checks')
    def test_ctfd_load_stops_before_users_check_when_selection_changes(self):
        harness = textwrap.dedent(
            """
            (async () => {
              const assert = (condition, message) => {
                if (!condition) throw new Error(message);
              };

              const noop = () => {};
              let currentPid = 'project-a';

              shell.getCurrentProjectId = () => currentPid;
              runQueued = async (_label, fn) => await fn();
              ctfdSyncProgress = noop;
              ctfdHideSyncedProgress = noop;
              updateCtfdControlsEnabled = noop;
              ctfdStopCountdown = noop;
              ctfdClearPeriodicTimer = noop;
              ctfdClearSkipped = noop;
              ctfdRenderSkippedIndicatorRaw = noop;
              ctfdRenderSkippedIndicator = noop;
              ctfdRestoreSkippedIndicator = noop;
              ctfdUpdateServerNavLinkForCurrent = noop;
              ctfdCacheSnapshot = noop;
              ctfdPersistLiveProjectMeta = noop;
              ctfdApplyUserMeta = noop;
              ctfdHandleCategoryFirsts = noop;
              ctfdMarkLiveRefreshed = noop;
              ctfdReschedulePeriodicForProject = noop;
              renderCtfdTable = noop;
              readCtfdUiState = () => ({});
              readCtfdCols = () => ({});

              const calls = [];
              const settingsCalls = [];
              let releaseHydrate;
              const hydrateGate = new Promise((resolve) => { releaseHydrate = resolve; });

              CTFD_ALLOW_LOAD = true;

              hydrateCtfdCredsFromPersisted = async (pid) => {
                assert(pid === 'project-a', 'CTFd load should hydrate creds for the original project');
                await hydrateGate;
                return { token: 'token-a', validated: true };
              };

              ctfdLoadSettings = async (projectOverride) => {
                settingsCalls.push(projectOverride && projectOverride.id ? projectOverride.id : null);
              };

              http = async (method, url, body) => {
                calls.push({ method, url, body });
                if (method === 'GET' && url === '/api/projects') {
                  return {
                    projects: [
                      {
                        id: 'project-a',
                        name: 'Alpha',
                        challenge_url: 'https://alpha.example',
                        challenge_port: 8443,
                        challenge_verify_ssl: true,
                        credentials: [{ username: 'alpha-user', password: 'pw' }],
                      },
                      {
                        id: 'project-b',
                        name: 'Beta',
                        challenge_url: 'https://beta.example',
                        challenge_port: 9443,
                        challenge_verify_ssl: false,
                        credentials: [{ username: 'beta-user', password: 'pw' }],
                      },
                    ],
                  };
                }
                if (url.includes('/ctfd/users_check')) {
                  return { users: [{ username: 'alpha-user', exists: true }] };
                }
                if (url.includes('/ctfd/settings')) {
                  return { settings: { challenges_visible: true, scoreboard_visible: true, ctfd_paused: false } };
                }
                throw new Error(`Unexpected request: ${method} ${url}`);
              };

              const loadPromise = ctfdLoadProjectById('project-a', { showProgressDialog: false });
              await Promise.resolve();

              currentPid = 'project-b';
              PROJ = {
                id: 'project-b',
                name: 'Beta',
                challenge_url: 'https://beta.example',
                challenge_port: 9443,
                challenge_verify_ssl: false,
                credentials: [{ username: 'beta-user', password: 'pw' }],
              };

              releaseHydrate();
              await loadPromise;

              assert(calls.length === 1, `Expected only the projects fetch before the stale CTFd load aborted, saw ${calls.length}`);
              assert(calls[0].method === 'GET' && calls[0].url === '/api/projects', 'CTFd load should stop before users_check after project switch');
              assert(settingsCalls.length === 0, 'CTFd load should not reach stale settings refresh after project switch');
              assert(PROJ && PROJ.id === 'project-b', 'CTFd load should keep the newly selected project visible');
            })();
            """
        )

        self._run_node_regression('app/static/js/ctfd_manager.js', harness, 'ctfd_manager.load.bundle.js')

    @unittest.skipUnless(shutil.which('node'), 'Node.js is required for frontend project-switch regression checks')
    def test_ctfd_settings_response_is_discarded_after_selection_changes(self):
        harness = textwrap.dedent(
            """
            (async () => {
              const assert = (condition, message) => {
                if (!condition) throw new Error(message);
              };

              let currentPid = 'project-a';
              let releaseSettings;
              const settingsGate = new Promise((resolve) => { releaseSettings = resolve; });

              shell.getCurrentProjectId = () => currentPid;
              runQueued = async (_label, fn) => await fn();
              readCtfdCreds = () => ({ token: 'token-a', validated: true });
              ctfdCurrentVerifySSL = (project) => project.challenge_verify_ssl !== false;
              ctfdHandleChallengesStateChange = () => {};
              CTFD_LAST_CHALLENGES_STATE = null;

              const ch = document.getElementById('ctfd-toggle-chals');
              const sc = document.getElementById('ctfd-toggle-scoreboard');
              const pa = document.getElementById('ctfd-toggle-paused');
              ch.checked = false;
              sc.checked = false;
              pa.checked = false;

              http = async (method, url, body) => {
                if (method !== 'POST' || url !== '/api/projects/project-a/ctfd/settings') {
                  throw new Error(`Unexpected request: ${method} ${url}`);
                }
                await settingsGate;
                return {
                  settings: {
                    challenges_visible: true,
                    scoreboard_visible: true,
                    ctfd_paused: true,
                  },
                };
              };

              const alpha = {
                id: 'project-a',
                name: 'Alpha',
                challenge_url: 'https://alpha.example',
                challenge_port: 8443,
                challenge_verify_ssl: true,
              };

              const settingsPromise = ctfdLoadSettings(alpha);
              await Promise.resolve();

              currentPid = 'project-b';
              releaseSettings();
              await settingsPromise;

              assert(ch.checked === false, 'Stale CTFd settings response should not update the challenges toggle');
              assert(sc.checked === false, 'Stale CTFd settings response should not update the scoreboard toggle');
              assert(pa.checked === false, 'Stale CTFd settings response should not update the paused toggle');
            })();
            """
        )

        self._run_node_regression('app/static/js/ctfd_manager.js', harness, 'ctfd_manager.settings.bundle.js')


if __name__ == '__main__':
    unittest.main()