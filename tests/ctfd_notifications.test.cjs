const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync('app/static/js/ctfd_manager.js', 'utf8');

function manager() {
  const elements = new Map();
  const timers = new Map();
  const stores = {};
  let nextTimer = 0;
  let currentPid = 'one';
  const storage = () => {
    const values = new Map();
    return { getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
  };
  const context = {
    console: { log() {}, warn() {}, error() {} },
    document: {
      addEventListener() {}, getElementById: id => elements.get(id) || null,
      querySelectorAll: () => [], querySelector: () => null,
    },
    shell: { getCurrentProjectId: () => currentPid, isRemote: () => false, logWarn() {}, logSuccess() {}, logInfo() {} },
    sessionStorage: storage(), localStorage: storage(),
    location: { href: 'http://localhost/static/ctfd_manager.html', protocol: 'http:' },
    URL, addEventListener() {},
    SETTINGS_AUDIO_FIELDS_META: {
      ctfdFirstUser: { defaultSpeak: true, defaultSpeakTemplate: '{{audio}} {{event_user}}' },
      ctfdPeriodic: { defaultSpeak: true, defaultSpeakTemplate: '{{audio}} Periodic' },
    },
    getProjectAudio: pid => stores[pid] || {},
    loadProjectAudio: async pid => stores[pid] || {},
    setTimeout: (fn, delay) => { const id = ++nextTimer; timers.set(id, { fn, delay }); return id; },
    clearTimeout: id => timers.delete(id),
    setInterval() {}, clearInterval() {},
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(source, context);
  return { context, elements, timers, stores, select: pid => { currentPid = pid; } };
}

test('periodic announcements keep their deadline across table refreshes', () => {
  const { context: c, stores, timers, select } = manager();
  stores.one = { 'event:ctfdPeriodic': { enabled: true, intervalSeconds: 120 } };
  c.ctfdReschedulePeriodicForProject('one');
  const firstTimer = [...timers.keys()][0];
  c.ctfdReschedulePeriodicForProject('one');
  assert.equal([...timers.keys()][0], firstTimer);
  const announced = [];
  c.ctfdAnnouncePeriodic = pid => announced.push(pid);
  const tick = timers.get(firstTimer).fn;
  timers.delete(firstTimer);
  tick();
  assert.deepEqual(announced, ['one']);
  assert.equal(timers.size, 1);
  stores.one['event:ctfdPeriodic'].enabled = false;
  c.ctfdReschedulePeriodicForProject('one');
  assert.equal(timers.size, 0);
  stores.one['event:ctfdPeriodic'].enabled = true;
  c.ctfdReschedulePeriodicForProject('one');
  select('two');
  const staleTick = [...timers.values()][0].fn;
  timers.clear();
  staleTick();
  assert.deepEqual(announced, ['one'], 'A timer for the previous project must not announce');
});

test('simultaneous notifications finish in order and Stop discards waiting events', async () => {
  const { context: c } = manager();
  const started = [];
  const release = [];
  c.ctfdSpeakFromTemplate = async (_template, payload) => {
    started.push(payload.context.event_user);
    await new Promise(resolve => release.push(resolve));
    return { spoke: true, wantsAudio: true };
  };
  const first = c.ctfdSpeakForEvent('ctfdFirstUser', { context: { event_user: 'alice' } }, 0, { projectId: 'one' });
  const second = c.ctfdSpeakForEvent('ctfdFirstUser', { context: { event_user: 'bob' } }, 0, { projectId: 'one' });
  await new Promise(setImmediate);
  assert.deepEqual(started, ['alice']);
  release.shift()();
  await first;
  await new Promise(setImmediate);
  assert.deepEqual(started, ['alice', 'bob']);
  const waiting = c.ctfdSpeakForEvent('ctfdFirstUser', { context: { event_user: 'carol' } }, 0, { projectId: 'one' });
  c.ctfdStopActivePlayback();
  release.shift()();
  await Promise.all([second, waiting]);
  assert.deepEqual(started, ['alice', 'bob']);
});

test('each project loads its notification settings before an event can play', async () => {
  const { context: c, stores } = manager();
  const loaded = [];
  let played = 0;
  c.loadProjectAudio = async pid => {
    loaded.push(pid);
    stores[pid] = { 'event:ctfdFirstUser': { enabled: false } };
  };
  c.ctfdSpeakFromTemplate = async () => { played++; };
  await c.ctfdSpeakForEvent('ctfdFirstUser', { context: {} }, 0, { projectId: 'two' });
  assert.deepEqual(loaded, ['two']);
  assert.equal(played, 0, 'A saved disabled event must not fall back to the enabled default');
  c.loadProjectAudio = async () => { throw new Error('offline'); };
  await c.ctfdSpeakForEvent('ctfdFirstUser', { context: {} }, 0, { projectId: 'three' });
  assert.equal(played, 0, 'Failed settings reads must not play default notifications');
});

test('unknown ranks and scores do not repeat first-place and first-score alerts', () => {
  const { context: c } = manager();
  const leaders = [];
  let scores = 0;
  c.ctfdAnnounceFirstPlace = (_pid, kind, name) => leaders.push([kind, name]);
  c.ctfdAnnounceFirstScore = () => scores++;
  c.ctfdDetectFirstPlaceChange('one', { alice: { user_rank: 1 } });
  c.ctfdDetectFirstPlaceChange('one', { alice: { user_rank: null } });
  c.ctfdDetectFirstPlaceChange('one', { alice: { user_rank: 1 } });
  assert.deepEqual(leaders, []);
  c.ctfdDetectFirstPlaceChange('two', { alice: { user_rank: 2 } });
  c.ctfdDetectFirstPlaceChange('two', { alice: { user_rank: 1 } });
  assert.deepEqual(leaders, [['user', 'alice']], 'A known user moving from #2 to #1 must announce');
  c.ctfdDetectFirstScore('one', { alice: { user_points: 0 } });
  c.ctfdDetectFirstScore('one', { alice: { user_points: 100 } });
  c.ctfdDetectFirstScore('one', { alice: { user_points: null, team_points: null } });
  c.ctfdDetectFirstScore('one', { alice: { user_points: 100 } });
  assert.equal(scores, 1);
});

test('notification save reports a failed write instead of Saved', async () => {
  const { context: c, elements } = manager();
  elements.set('ctfd-notify-status', { textContent: '' });
  elements.set('ctfd-notify-rows', { querySelectorAll: () => [] });
  c.patchProjectAudio = async () => { throw new Error('offline'); };
  await c.ctfdSaveNotifyConfig();
  assert.match(elements.get('ctfd-notify-status').textContent, /failed/i);
});

test('Stop ends built-in tones and resolves their pending playback', async () => {
  const { context: c } = manager();
  const stopped = [];
  c.ctfdEnsureAudioContext = () => ({
    currentTime: 0, destination: {},
    createOscillator: () => ({ type: '', frequency: { setValueAtTime() {} },
      connect() { return { connect() {} }; }, start() {}, stop() { stopped.push(true); } }),
    createGain: () => ({ gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} } }),
  });
  const playback = c.ctfdPlayFallbackPattern([{ freq: 440, dur: 2 }], 0);
  assert.equal(stopped.length, 1, 'The note should have a scheduled end');
  c.ctfdStopActivePlayback();
  assert.equal(stopped.length, 2, 'Stop should end the note immediately');
  assert.equal((await playback).played, false);
});

test('Stop ends HTML audio and speech even if the browser sends no end event', async () => {
  const { context: c } = manager();
  let paused = 0;
  let cancelled = 0;
  c.Audio = class {
    addEventListener() {} removeEventListener() {}
    play() { return Promise.resolve(); }
    pause() { paused++; }
  };
  c.ctfdEnsureAudioContext = () => null;
  c.ctfdGetAudioEntry = () => ({ enabled: true, sounds: [{ dataUrl: 'data:audio/wav;base64,AAAA' }] });
  const audio = c.ctfdTryPlayCustomAudio('ctfdFirstUser', 0, 'one');
  c.ctfdStopActivePlayback();
  assert.equal(paused, 1);
  assert.equal((await audio).played, false);
  c.SpeechSynthesisUtterance = class {};
  c.speechSynthesis = { speak() {}, cancel() { cancelled++; } };
  const speech = c.ctfdSpeakTextSegment('Hello');
  c.ctfdStopActivePlayback();
  assert.equal(cancelled > 0, true);
  assert.equal((await speech).spoke, false);
});

test('stopping an uploaded clip does not start its fallback tone', async () => {
  const { context: c } = manager();
  let release;
  let tones = 0;
  c.ctfdTryPlayCustomAudio = () => new Promise(resolve => { release = resolve; });
  c.ctfdPlayFallbackPattern = async () => { tones++; return { played: true }; };
  const playing = c.ctfdPlayNamedSound('ctfdFirstUser', [{ freq: 440, dur: 1 }], 0, 'one');
  c.ctfdStopActivePlayback();
  release({ played: false, duration: 0 });
  await playing;
  assert.equal(tones, 0);
});

test('an event plays its selected uploaded clip from the event project', async () => {
  const { context: c, stores } = manager();
  stores.two = {
    'event:ctfdFirstUser': { enabled: true, speak: false, speakTemplates: [{ text: '{{audio}}', soundKey: 'media:bell' }] },
    'media:bell': { enabled: true, dataUrl: 'data:audio/wav;base64,AAAA' },
  };
  const played = [];
  c.Audio = class {
    constructor(src) { this.src = src; this.listeners = new Map(); }
    addEventListener(name, fn) { this.listeners.set(name, fn); }
    removeEventListener(name) { this.listeners.delete(name); }
    play() { played.push(this.src); setImmediate(() => this.listeners.get('ended')?.()); return Promise.resolve(); }
  };
  let fallback = 0;
  await c.ctfdSpeakForEvent('ctfdFirstUser', { context: {} }, 0, {
    projectId: 'two', onAudioRequest: async () => { fallback++; return { played: true }; },
  });
  assert.deepEqual(played, ['data:audio/wav;base64,AAAA']);
  assert.equal(fallback, 0);
});

test('a failed initial category lookup does not turn old solves into new alerts', () => {
  const { context: c } = manager();
  let announced = 0;
  c.ctfdAnnounceFirstCategorySolve = () => announced++;
  c.ctfdHandleCategoryFirsts('one', { user: [], team: [], errors: ['upstream unavailable'] });
  c.ctfdHandleCategoryFirsts('one', { user: [{ category: 'Web', user: 'alice', timestamp_epoch: 100 }], team: [] });
  assert.equal(announced, 0);
});

test('an enabled periodic event needs a valid interval before saving', async () => {
  const { context: c, elements } = manager();
  let writes = 0;
  const row = {
    getAttribute: () => 'ctfdPeriodic', querySelectorAll: () => [],
    querySelector: selector => selector.includes('notify-enabled') ? { checked: true }
      : selector.includes('notify-period-sec') ? { value: '' } : null,
  };
  elements.set('ctfd-notify-status', { textContent: '' });
  elements.set('ctfd-notify-rows', { querySelectorAll: () => [row] });
  c.patchProjectAudio = async () => { writes++; };
  await c.ctfdSaveNotifyConfig();
  assert.equal(writes, 0);
  assert.match(elements.get('ctfd-notify-status').textContent, /interval/i);
});

test('switching projects during a settings load keeps the new project in the editor', async () => {
  const { context: c, stores, elements, timers, select } = manager();
  const rows = { innerHTML: '', querySelectorAll: () => [] };
  elements.set('ctfd-notify-rows', rows);
  elements.set('ctfd-notify-status', { textContent: '' });
  stores.one = { 'event:ctfdFirstUser': { speakTemplates: ['one-only'] } };
  stores.two = {
    'event:ctfdFirstUser': { speakTemplates: ['two-only'] },
    'event:ctfdPeriodic': { enabled: true, intervalSeconds: 120 },
  };
  let finishFirstLoad;
  c.loadProjectAudio = pid => pid === 'one' ? new Promise(resolve => { finishFirstLoad = resolve; }) : Promise.resolve();
  const oldRender = c.ctfdRenderNotifyConfig();
  select('two');
  await c.ctfdRenderNotifyConfig();
  finishFirstLoad();
  await oldRender;
  assert.match(rows.innerHTML, /two-only/);
  assert.doesNotMatch(rows.innerHTML, /one-only/);
  assert.equal([...timers.values()][0].delay, 120000, 'Loaded periodic settings should start their timer');
});
