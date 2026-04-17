import shutil
import subprocess
import textwrap
import unittest
from pathlib import Path


class CtfdManagerCacheRegressionTests(unittest.TestCase):

    @unittest.skipUnless(shutil.which('node'), 'Node.js is required for frontend cache regression checks')
    def test_sparse_ctfd_meta_does_not_replace_richer_cached_state(self):
        repo_root = Path(__file__).resolve().parents[1]
        node_script = textwrap.dedent(
            """
            const fs = require('fs');
            const path = require('path');
            const vm = require('vm');

            function makeStorage() {
              const store = new Map();
              return {
                getItem(key) {
                  const value = store.get(String(key));
                  return value === undefined ? null : value;
                },
                setItem(key, value) {
                  store.set(String(key), String(value));
                },
                removeItem(key) {
                  store.delete(String(key));
                },
                clear() {
                  store.clear();
                },
              };
            }

            function makeElement() {
              return {
                value: '',
                checked: false,
                innerHTML: '',
                textContent: '',
                className: '',
                style: {},
                dataset: {},
                disabled: false,
                classList: {
                  add() {},
                  remove() {},
                  toggle() {},
                  contains() { return false; },
                },
                addEventListener() {},
                removeEventListener() {},
                appendChild() {},
                removeChild() {},
                querySelector() { return null; },
                querySelectorAll() { return []; },
                closest() { return null; },
                setAttribute() {},
                getAttribute() { return ''; },
                removeAttribute() {},
              };
            }

            const document = {
              cookie: '',
              body: {
                appendChild() {},
                removeChild() {},
              },
              addEventListener() {},
              removeEventListener() {},
              getElementById() { return null; },
              querySelector() { return null; },
              querySelectorAll() { return []; },
              createElement() { return makeElement(); },
            };

            const shell = {
              logDebug() {},
              logInfo() {},
              logError() {},
              logWarn() {},
              logSuccess() {},
              initShell: async () => {},
              getCurrentProjectId() { return ''; },
              setCurrentProjectId() {},
              refreshSidebar: async () => {},
              setSidebarImportBusy() {},
            };

            const windowObj = {
              document,
              shell,
              bootstrap: null,
              location: {
                href: 'http://localhost:8080/static/ctfd_manager.html?id=test-project',
                protocol: 'http:',
              },
              CREDS: {
                readPersistCtfdToken() { return ''; },
                fetchProjectSecrets: async () => {},
              },
              showConfirmModal: async () => 'continue',
              addEventListener() {},
              removeEventListener() {},
            };

            const context = {
              console,
              sessionStorage: makeStorage(),
              localStorage: makeStorage(),
              document,
              window: windowObj,
              shell,
              location: windowObj.location,
              navigator: {},
              fetch: async () => ({ ok: true, json: async () => ({ projects: [] }) }),
              http: async () => ({}),
              AUTH: {},
              CREDS: windowObj.CREDS,
              bootstrap: null,
              URL,
              FormData: function FormData() { this.append = () => {}; },
              Blob: function Blob(parts, options) { this.parts = parts; this.options = options; },
              CustomEvent: function CustomEvent(type, init) { this.type = type; this.detail = init && init.detail; },
              setTimeout,
              clearTimeout,
              setInterval,
              clearInterval,
              requestAnimationFrame: (callback) => callback(),
              queueMicrotask,
            };
            context.global = context;
            context.globalThis = context;

            const source = fs.readFileSync(path.join(process.cwd(), 'app/static/js/ctfd_manager.js'), 'utf8');
            const harness = `
              const assert = (condition, message) => {
                if (!condition) throw new Error(message);
              };

              PROJ = {
                id: 'test-project',
                name: 'Test Project',
                challenge_url: 'https://ctfd.local',
                instances: 1,
                credentials: [{ username: 'alice', password: 'pw' }],
              };

              const richMeta = {
                alice: {
                  username: 'alice',
                  exists: true,
                  user_rank: 1,
                  user_points: 500,
                  team_name: 'Red Team',
                  team_rank: 1,
                },
              };

              ctfdPersistLiveProjectMeta(PROJ.id, richMeta);

              CTFD_USER_META = {
                alice: {
                  username: 'alice',
                  exists: true,
                  user_rank: null,
                  user_points: null,
                  team_name: null,
                  team_rank: null,
                },
              };

              assert(ctfdSnapshotHasProjectMeta(PROJ, CTFD_USER_META) === false, 'Sparse metadata should not count as display state');

              const restored = ctfdRestoreLiveProjectMeta(PROJ);
              assert(restored === true, 'Live metadata should restore when current state is sparse');

              const restoredMeta = ctfdMetaLookup(PROJ.id, 'alice');
              assert(restoredMeta && Number(restoredMeta.user_rank) === 1, 'Restored metadata should include the richer user rank');
              assert(restoredMeta && restoredMeta.team_name === 'Red Team', 'Restored metadata should include the richer team name');

              ctfdPersistLiveProjectMeta(PROJ.id, {
                alice: {
                  username: 'alice',
                  exists: true,
                  user_rank: null,
                  user_points: null,
                  team_name: null,
                  team_rank: null,
                },
              });

              const cachedMeta = ctfdReadLiveProjectMeta(PROJ.id);
              assert(cachedMeta && Number(cachedMeta.alice.user_rank) === 1, 'Sparse metadata should not overwrite richer cached user rank');
              assert(cachedMeta && cachedMeta.alice.team_name === 'Red Team', 'Sparse metadata should not overwrite richer cached team name');
            `;

            vm.runInNewContext(source + '\\n' + harness, context, { filename: 'ctfd_manager.bundle.js' });
            """
        )

        result = subprocess.run(
            [shutil.which('node'), '-e', node_script],
            cwd=repo_root,
            capture_output=True,
            text=True,
            check=False,
        )

        if result.returncode != 0:
            self.fail(
                'Node regression harness failed for ctfd_manager.js\n'
                f'STDOUT:\n{result.stdout}\n'
                f'STDERR:\n{result.stderr}'
            )