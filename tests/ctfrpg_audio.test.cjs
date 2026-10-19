const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync('app/static/js/ctfrpg_audio.js', 'utf8');
const window = {};
vm.runInNewContext(source, {window, document: {}});
const {snapshot, changes} = window.CTFRPG_Audio;

function manager() {
  const elements = new Map();
  const stores = new Map();
  const clips = [];
  const spoken = [];
  const speech = [];
  const requestLog = [];
  let toneCount = 0;
  function element() {
    return { innerHTML: '', textContent: '', className: '', disabled: false, dataset: {},
      handlers: {}, addEventListener(name, callback) { this.handlers[name] = callback; },
      setAttribute() {}, removeAttribute() {} };
  }
  for (const id of ['notify-rows', 'notify-status', 'notify-save', 'notify-reload', 'notify-stop']) elements.set(id, element());
  const context = {
    console, URL, setTimeout, clearTimeout,
    document: { getElementById: id => elements.get(id) || null, querySelectorAll: () => [], addEventListener() {} },
    addEventListener() {}, shell: { isRemote: () => false },
    Audio: class {
      constructor(src) { this.src = src; this.handlers = new Map(); clips.push(this); }
      addEventListener(name, fn) { this.handlers.set(name, fn); }
      removeEventListener(name) { this.handlers.delete(name); }
      play() { this.started = true; return Promise.resolve(); }
      pause() { this.paused = true; }
      end() { this.handlers.get('ended')?.(); }
    },
    SpeechSynthesisUtterance: class { constructor(text) { this.text = text; } },
    speechSynthesis: { speak(utterance) { spoken.push(utterance.text); speech.push(utterance); }, cancel() {} },
    AudioContext: class {
      constructor() { this.state = 'running'; this.currentTime = 0; this.destination = {}; }
      resume() { return Promise.resolve(); }
      close() { return Promise.resolve(); }
      createGain() { return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {}, disconnect() {} }; }
      createOscillator() {
        return { frequency: {}, connect() {}, disconnect() {}, start() { toneCount++; },
          stop() { queueMicrotask(() => this.onended?.()); } };
      }
    },
    async fetch(url, options = {}) {
      requestLog.push({url, options});
      const pid = url.match(/\/projects\/([^/]+)/)?.[1];
      const store = stores.get(pid) || {};
      if (context.respond) return context.respond(url, options);
      if (url.includes('/audio_entry')) return {ok: true, json: async () => ({entry: store.clip})};
      return {ok: true, json: async () => ({audio: url.includes('prefix=media:') ? {} : store.events || {}})};
    },
  };
  context.window = context;
  vm.runInNewContext(source, context);
  return {context, audio: context.CTFRPG_Audio, elements, stores, clips, spoken, speech, requestLog, tones: () => toneCount};
}

const flush = () => new Promise(setImmediate);
const project = {id: 'one', name: 'Quest'};
const result = (score, rank = 1, completed = 0) => ({users: [{username: 'alice', exists: true, score, rank, completed}], teams: []});
const eventSettings = (key, entry = {}) => Object.fromEntries(
  ['ctfrpgFirstUser', 'ctfrpgFirstTeam', 'ctfrpgFirstScore', 'ctfrpgScoreIncrease', 'ctfrpgQuestComplete']
    .map(name => [name, {enabled: name === key, speak: false, ...(name === key ? entry : {})}])
);

test('audio changes use the first successful refresh as a baseline', () => {
  const project = {id: 'one', name: 'Quest'};
  const first = snapshot({users: [{username: 'alice', exists: true, score: 0, completed: 0, rank: 1}], teams: []});
  assert.equal(changes(null, first, project).length, 0);
  const next = snapshot({users: [{username: 'alice', exists: true, score: 25, completed: 1, rank: 1}], teams: []});
  assert.deepEqual(Array.from(changes(first, next, project), event => event.key), [
    'ctfrpgFirstScore', 'ctfrpgScoreIncrease', 'ctfrpgQuestComplete',
  ]);
  assert.equal(changes(next, next, project).length, 0);
});

test('leader change reports user and team once', () => {
  const project = {id: 'one', name: 'Quest'};
  const previous = snapshot({users: [
    {username: 'alice', exists: true, score: 50, rank: 1},
    {username: 'bob', exists: true, score: 20, rank: 2},
  ], teams: [{username: 'Blue', score: 50, rank: 1}, {username: 'Red', score: 20, rank: 2}]});
  const next = snapshot({users: [
    {username: 'alice', exists: true, score: 50, rank: 2},
    {username: 'bob', exists: true, score: 75, rank: 1},
  ], teams: [{username: 'Blue', score: 50, rank: 2}, {username: 'Red', score: 75, rank: 1}]});
  assert.deepEqual(Array.from(changes(previous, next, project), event => event.key), [
    'ctfrpgFirstUser', 'ctfrpgFirstTeam', 'ctfrpgScoreIncrease',
  ]);
});

test('only rank #1 is announced, and unknown metrics do not cause repeat alerts', () => {
  const first = snapshot(result(100, 1, 2));
  const missing = snapshot(result(null, null, null), first);
  const restored = snapshot(result(100, 1, 2), missing);
  assert.equal(changes(missing, restored, project).length, 0);
  const second = snapshot(result(100, 2, 2));
  const otherSecond = snapshot({users: [{username: 'bob', exists: true, score: 200, rank: 2}], teams: []}, second);
  assert.equal(changes(second, otherSecond, project).some(event => event.key === 'ctfrpgFirstUser'), false);
});

test('notifications wait for each clip and speech segment to finish', async () => {
  const m = manager();
  m.stores.set('one', {events: eventSettings('ctfrpgScoreIncrease', {soundKey: 'media:bell', speak: true}),
    clip: {enabled: true, dataUrl: 'data:audio/wav;base64,AAAA'}});
  await m.audio.load([project]);
  m.audio.process(project, result(0));
  const first = m.audio.process(project, result(10));
  const second = m.audio.process(project, result(20));
  await flush();
  assert.equal(m.clips.length, 1);
  assert.equal(m.spoken.length, 0, 'Speech should follow the finished clip');
  m.clips[0].end();
  await flush();
  assert.equal(m.clips.length, 1, 'The next clip should wait for speech');
  assert.equal(m.spoken.length, 1);
  m.speech[0].onend();
  await first;
  await flush();
  assert.equal(m.clips.length, 2);
  m.clips[1].end();
  await flush();
  m.speech[1].onend();
  await second;
});

test('Stop cancels the active clip and discards queued notifications', async () => {
  const m = manager();
  m.stores.set('one', {events: eventSettings('ctfrpgScoreIncrease', {soundKey: 'media:bell'}),
    clip: {enabled: true, dataUrl: 'data:audio/wav;base64,AAAA'}});
  await m.audio.load([project]);
  m.audio.process(project, result(0));
  const first = m.audio.process(project, result(10));
  const second = m.audio.process(project, result(20));
  await flush();
  assert.equal(typeof m.audio.stop, 'function');
  m.audio.stop();
  await Promise.all([first, second]);
  assert.equal(m.clips[0].paused, true);
  assert.equal(m.clips.length, 1);
  assert.equal(m.tones(), 0, 'A cancelled clip must not start a fallback tone');
});

test('failed settings reads do not enable default alerts', async () => {
  const m = manager();
  m.context.respond = async () => { throw new Error('offline'); };
  await m.audio.load([project]);
  m.audio.process(project, result(0));
  await m.audio.process(project, result(10));
  await flush();
  assert.equal(m.tones(), 0);
  assert.equal(m.spoken.length, 0);
});

test('remote mode and disabled uploaded clips are respected', async () => {
  const m = manager();
  m.stores.set('one', {events: eventSettings('ctfrpgScoreIncrease', {soundKey: 'media:bell'}),
    clip: {enabled: false, dataUrl: 'data:audio/wav;base64,AAAA'}});
  await m.audio.load([project]);
  m.audio.process(project, result(0));
  await m.audio.process(project, result(10));
  await flush();
  assert.equal(m.clips.length, 0);
  assert.equal(m.tones(), 1, 'An unavailable uploaded clip uses the built-in tone');
  m.context.shell.isRemote = () => true;
  await m.audio.process(project, result(20));
  await flush();
  assert.equal(m.tones(), 1);
});

test('a failed save remains an error in the notification editor', async () => {
  const m = manager();
  await m.audio.load([project]);
  m.audio.init();
  m.context.respond = async (_url, options) => ({ok: options.method !== 'PATCH', json: async () => ({error: 'offline'})});
  await m.elements.get('notify-save').handlers.click();
  assert.equal(m.elements.get('notify-status').className.includes('danger'), true);
  assert.doesNotMatch(m.elements.get('notify-status').textContent, /saved/i);
});

test('switching projects cancels speech without waiting for a browser end event', async () => {
  const m = manager();
  m.stores.set('one', {events: eventSettings('ctfrpgScoreIncrease', {speak: true})});
  await m.audio.load([project]);
  m.audio.process(project, result(0));
  const playing = m.audio.process(project, result(10));
  await flush();
  assert.equal(m.spoken.length, 1);
  await m.audio.load([{id: 'two', name: 'Other'}]);
  await playing;
  assert.equal(m.spoken.length, 1);
});

test('a save finishing after a project switch does not replace the new project settings', async () => {
  const m = manager();
  m.stores.set('one', {events: eventSettings('ctfrpgFirstScore')});
  m.stores.set('two', {events: eventSettings('none')});
  await m.audio.load([project]);
  m.audio.init();
  const row = {
    dataset: {pid: 'one', event: 'ctfrpgFirstScore'},
    querySelector: selector => ({
      '.notify-enabled': {checked: true}, '.notify-sound': {value: ''},
      '.notify-speak': {checked: false}, '.notify-template': {value: ''},
    })[selector],
  };
  m.context.document.querySelectorAll = () => [row];
  let finishSave;
  m.context.respond = (url, options) => {
    if (options.method === 'PATCH') return new Promise(resolve => { finishSave = () => resolve({ok: true, json: async () => ({})}); });
    return Promise.resolve({ok: true, json: async () => ({audio: url.includes('prefix=ctfrpg') ? eventSettings('none') : {}})});
  };
  const saving = m.elements.get('notify-save').handlers.click();
  const other = {id: 'two', name: 'Other'};
  await m.audio.load([other]);
  finishSave();
  await saving;
  m.audio.process(other, result(0));
  await m.audio.process(other, result(10));
  assert.equal(m.tones(), 0, 'The new project should keep its disabled first-score setting');
  assert.doesNotMatch(m.elements.get('notify-status').textContent, /saved/i);
});

test('Preview toggles to Stop and a second click cancels its clip', async () => {
  const m = manager();
  m.stores.set('one', {clip: {enabled: true, dataUrl: 'data:audio/wav;base64,AAAA'}});
  await m.audio.load([project]);
  m.audio.init();
  const row = { dataset: {pid: 'one', event: 'ctfrpgFirstScore'}, querySelector: selector => ({
    '.notify-sound': {value: 'media:bell'}, '.notify-speak': {checked: false}, '.notify-template': {value: ''},
  })[selector] };
  const button = { dataset: {}, textContent: 'Preview', closest: () => row };
  const event = {target: {closest: () => button}};
  const playing = m.elements.get('notify-rows').handlers.click(event);
  await flush();
  assert.equal(button.textContent, 'Stop');
  m.elements.get('notify-rows').handlers.click(event);
  await playing;
  assert.equal(button.textContent, 'Preview');
  assert.equal(m.clips[0].paused, true);
});
