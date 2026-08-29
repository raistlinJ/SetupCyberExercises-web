import shutil
import subprocess
import textwrap
import unittest
from pathlib import Path


class CtfdAudioTemplateRegressionTests(unittest.TestCase):

    @unittest.skipUnless(shutil.which("node"), "Node.js is required for CTFd frontend regression checks")
    def test_audio_cues_and_template_resolution(self):
        repo_root = Path(__file__).resolve().parents[1]
        node_script = textwrap.dedent(
            r"""
            const fs = require('fs');
            const path = require('path');
            const vm = require('vm');

            function makeStorage() {
              const values = new Map();
              return {
                getItem(key) { return values.has(String(key)) ? values.get(String(key)) : null; },
                setItem(key, value) { values.set(String(key), String(value)); },
                removeItem(key) { values.delete(String(key)); },
                clear() { values.clear(); },
              };
            }

            function makeElement() {
              return {
                value: '', checked: false, innerHTML: '', textContent: '', className: '',
                style: {}, dataset: {}, disabled: false, selectionStart: 0,
                classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
                addEventListener() {}, removeEventListener() {}, appendChild() {}, removeChild() {},
                querySelector() { return null; }, querySelectorAll() { return []; }, closest() { return null; },
                setAttribute() {}, getAttribute() { return ''; }, removeAttribute() {},
                setSelectionRange(start) { this.selectionStart = start; }, focus() {},
                getBoundingClientRect() { return { left: 0, bottom: 0, width: 300 }; },
              };
            }

            const document = {
              cookie: '',
              body: { appendChild() {}, removeChild() {} },
              addEventListener() {}, removeEventListener() {}, getElementById() { return null; },
              querySelector() { return null; }, querySelectorAll() { return []; },
              createElement() { return makeElement(); },
            };
            const shell = {
              logDebug() {}, logInfo() {}, logError() {}, logWarn() {}, logSuccess() {},
              initShell: async () => {}, getCurrentProjectId() { return 'project-one'; },
              setCurrentProjectId() {}, refreshSidebar: async () => {}, setSidebarImportBusy() {},
              isRemote() { return false; },
            };
            const windowObj = {
              document, shell, bootstrap: null, scrollX: 0, scrollY: 0,
              location: { href: 'http://localhost/static/ctfd_manager.html?id=project-one', protocol: 'http:' },
              CREDS: { readPersistCtfdToken() { return ''; }, fetchProjectSecrets: async () => {} },
              showConfirmModal: async () => 'continue', addEventListener() {}, removeEventListener() {},
              SETTINGS_AUDIO_DEFAULTS: { ctfdFirstUser: true },
              SETTINGS_AUDIO_FIELDS_META: {
                ctfdFirstUser: { defaultSpeak: true, defaultSpeakTemplate: '{{audio}} default' }
              },
            };
            const context = {
              console, process,
              makeElement,
              sessionStorage: makeStorage(), localStorage: makeStorage(),
              document, window: windowObj, shell, location: windowObj.location, navigator: {},
              fetch: async () => ({ ok: true, json: async () => ({ projects: [] }) }),
              http: async () => ({}), AUTH: {}, CREDS: windowObj.CREDS, bootstrap: null,
              getProjectAudio(projectId) {
                return {
                  'event:ctfdFirstUser': {
                    enabled: true, speak: true,
                    speakTemplates: [{ text: `{{audio}} ${projectId}`, enabled: true }]
                  }
                };
              },
              URL, FormData: function FormData() { this.append = () => {}; },
              Blob: function Blob(parts, options) { this.parts = parts; this.options = options; },
              CustomEvent: function CustomEvent(type, init) { this.type = type; this.detail = init && init.detail; },
              setTimeout, clearTimeout, setInterval, clearInterval,
              requestAnimationFrame: (callback) => callback(), queueMicrotask,
            };
            context.global = context;
            context.globalThis = context;

            const source = fs.readFileSync(path.join(process.cwd(), 'app/static/js/ctfd_manager.js'), 'utf8');
            const harness = String.raw`
              (async () => {
                const assert = (condition, message) => { if (!condition) throw new Error(message); };

                const compiled = ctfdCompileSpeechTemplate(
                  'Welcome {{ Project }}{{pause_2}}{{AuDiO}} {{missing}}',
                  { project: 'Arena' }
                );
                assert(compiled.segments.some(s => s.type === 'text' && s.text.includes('Arena')), 'Mixed-case template variable did not resolve');
                assert(compiled.segments.some(s => s.type === 'pause' && s.seconds === 2), 'Pause template token did not resolve');
                assert(compiled.segments.some(s => s.type === 'audio'), 'Audio template token did not resolve');
                assert(ctfdNormalizeNotifyTemplateText('{{project} */}', 'ctfdPeriodic') === '{{project}}', 'Legacy malformed template was not repaired');
                const projectTwoEntry = ctfdGetAudioEntry('ctfdFirstUser', 'project-two');
                assert(projectTwoEntry.speakTemplates[0].text === '{{audio}} project-two', 'Project-scoped template lookup used the active sidebar project');

                const input = makeElement();
                input.value = 'Hello {{pro';
                input.selectionStart = input.value.length;
                CTFD_AUTOCOMPLETE_ACTIVE_INPUT = input;
                ctfdInsertAutocompleteVariable('project');
                assert(input.value === 'Hello {{project}}', 'Autocomplete did not insert a valid two-brace template');

                const originalGetAudioEntry = ctfdGetAudioEntry;
                const originalTryCustom = ctfdTryPlayCustomAudio;
                const originalFallback = ctfdPlayFallbackPattern;

                ctfdGetAudioEntry = () => ({
                  enabled: false, speak: true,
                  speakTemplates: [{ text: '{{audio}} Disabled event', enabled: true }],
                  defaultSpeakTemplate: '{{audio}} Disabled event', sounds: []
                });
                assert(ctfdShouldSpeak('ctfdFirstUser') === false, 'Disabled events must not speak');
                let disabledAudioCalls = 0;
                await ctfdSpeakForEvent('ctfdFirstUser', { context: {}, fallbackText: 'Disabled' }, 0, {
                  onAudioRequest: async () => { disabledAudioCalls += 1; return { played: true, duration: 0 }; }
                });
                assert(disabledAudioCalls === 0, 'Disabled event played an audio cue');

                ctfdGetAudioEntry = () => ({
                  enabled: true, speak: false,
                  speakTemplates: [{ text: '{{audio}}', enabled: true }],
                  defaultSpeakTemplate: '{{audio}}', sounds: []
                });
                ctfdTryPlayCustomAudio = async () => ({ played: false, duration: 0 });
                let fallbackCalls = 0;
                ctfdPlayFallbackPattern = async (pattern, delay) => {
                  fallbackCalls += 1;
                  return { played: Array.isArray(pattern) && pattern.length > 0, duration: Number(delay) || 0 };
                };
                const fallbackResult = await ctfdPlayNamedSound('ctfdFirstUser', [{ freq: 440, dur: 0.1 }], 0);
                assert(fallbackCalls === 1 && fallbackResult.played, 'Built-in cue did not replace a missing uploaded clip');

                let templateAudioCalls = 0;
                await ctfdSpeakForEvent('ctfdFirstUser', { context: {}, fallbackText: 'First user' }, 0, {
                  onAudioRequest: async () => { templateAudioCalls += 1; return { played: true, duration: 0 }; }
                });
                assert(templateAudioCalls === 1, '{{audio}} did not request the event cue when no clip was uploaded');

                ctfdGetAudioEntry = originalGetAudioEntry;
                ctfdTryPlayCustomAudio = originalTryCustom;
                ctfdPlayFallbackPattern = originalFallback;

                let firstPlaceCalls = 0;
                ctfdAnnounceFirstPlace = () => { firstPlaceCalls += 1; };
                ctfdDetectFirstPlaceChange('project-one', {
                  alice: { exists: true, user_rank: 1, team_name: 'Red', team_rank: 1 }
                });
                assert(firstPlaceCalls === 0, 'Initial leaderboard refresh should seed without announcing');
                ctfdDetectFirstPlaceChange('project-one', {
                  alice: { exists: true, user_rank: 1, team_name: 'Red', team_rank: 1 }
                });
                assert(firstPlaceCalls === 0, 'Unchanged first place should not announce');
                ctfdDetectFirstPlaceChange('project-one', {
                  alice: { exists: true, user_rank: 2, team_name: 'Red', team_rank: 1 },
                  bob: { exists: true, user_rank: 1, team_name: 'Red', team_rank: 1 }
                });
                assert(firstPlaceCalls === 1, 'A later first-place change should announce exactly once');

                let firstScoreCalls = 0;
                ctfdAnnounceFirstScore = () => { firstScoreCalls += 1; };
                ctfdDetectFirstScore('project-score', { alice: { exists: true, user_points: 0 } });
                assert(firstScoreCalls === 0, 'Initial score state should seed without announcing');
                ctfdDetectFirstScore('project-score', { alice: { exists: true, user_points: 100 } });
                assert(firstScoreCalls === 1, 'The first observed score should announce exactly once');
                ctfdDetectFirstScore('project-score', { alice: { exists: true, user_points: 200 } });
                assert(firstScoreCalls === 1, 'Later score changes should not repeat the first-score cue');

                let categoryCalls = 0;
                ctfdAnnounceFirstCategorySolve = () => { categoryCalls += 1; };
                ctfdHandleCategoryFirsts('project-category', { user: [], team: [] });
                ctfdHandleCategoryFirsts('project-category', {
                  user: [{ category: 'Web', user: 'alice', timestamp_epoch: 1 }], team: []
                });
                assert(categoryCalls === 1, 'A category first discovered after seeding should announce once');
                ctfdHandleCategoryFirsts('project-category', {
                  user: [{ category: 'Web', user: 'alice', timestamp_epoch: 1 }], team: []
                });
                assert(categoryCalls === 1, 'An unchanged category first should not repeat');

                let revealCueCalls = 0;
                let hideCueCalls = 0;
                ctfdPlayCountdownCueForChallenges = async () => { revealCueCalls += 1; };
                ctfdPlayCountdownStopForChallenges = async () => { hideCueCalls += 1; };
                CTFD_LAST_CHALLENGES_STATE = null;
                ctfdHandleChallengesStateChange(true);
                assert(revealCueCalls === 0 && hideCueCalls === 0, 'Initial challenge visibility must seed silently');
                ctfdHandleChallengesStateChange(false);
                await Promise.resolve();
                assert(hideCueCalls === 1, 'A later challenge hide should emit the cancellation cue');
                ctfdHandleChallengesStateChange(true);
                await Promise.resolve();
                assert(revealCueCalls === 1, 'A later challenge reveal should emit the completion cue');
              })();
            `;

            (async () => {
              const result = vm.runInNewContext(source + '\n' + harness, context, { filename: 'ctfd_manager.bundle.js' });
              if (result && typeof result.then === 'function') await result;
            })().catch((error) => {
              console.error(error && error.stack ? error.stack : error);
              process.exitCode = 1;
            });
            """
        )

        result = subprocess.run(
            [shutil.which("node"), "-e", node_script],
            cwd=repo_root,
            capture_output=True,
            text=True,
            check=False,
        )

        if result.returncode != 0:
            self.fail(
                "Node regression harness failed for CTFd cues/templates\n"
                f"STDOUT:\n{result.stdout}\n"
                f"STDERR:\n{result.stderr}"
            )


if __name__ == "__main__":
    unittest.main()
