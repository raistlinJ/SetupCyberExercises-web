// CTFd Manager page script
let PROJ = null; // reuse naming for consistency
let CTFD_ALL_PROJECTS = []; // all known projects for modal
let CTFD_SELECTED_PIDS = null; // null implies single-project (sidebar selection); array implies multi-merge mode
let CTFD_SORT = { key: 'cred', dir: 'asc' }; // cred|team|user_points|team_points|user_last|team_last|project
let CTFD_FILTER_TEXT = '';
let CTFD_FILTER_IS_REGEX = false;
let CTFD_SHOW_PASSWORDS = false;
// Gate to ensure no data loads occur until the user explicitly acts
let CTFD_ALLOW_LOAD = false;
let CTFD_AUTO_REFRESH_ACTIVE = false;
// Selection is per credential (instance index), not per VM row
let CTFD_SELECTED_INDICES = new Set(); // numbers: instance indices
let CTFD_LAST_VISIBLE_INDICES = []; // visible indices in current filter (for select-all)
// Multi mode: composite selection pid:index
let CTFD_SELECTED_KEYS = new Set(); // strings "pid:index"
let CTFD_LAST_VISIBLE_KEYS = []; // visible keys for select-all in merged view
// Existence cache: username -> boolean (exists on CTFd)
// Map username -> metadata: { exists, user_rank, team_name, team_rank }
let CTFD_USER_META = {}; 
// Sort mode toggles for headers
let CTFD_USER_SORT_MODE = 'name'; // 'name' | 'rank'
let CTFD_TEAM_SORT_MODE = 'name'; // 'name' | 'rank'
const CTFD_FIRST_PLACE_HISTORY = {};
let CTFD_AUDIO_CONTEXT = null;
const CTFD_AUDIO_CACHE = {};
const CTFD_AUDIO_ROTATION = {};
const CTFD_AUDIO_MEDIA_PREFIX = 'media:';
const CTFD_AUDIO_EVENT_PREFIX = 'event:';
const CTFD_SPEECH_DEFAULT_DELAY = 0.35;
const CTFD_AUDIO_SEGMENT_BUFFER = 0.12;
const CTFD_SPEECH_SEGMENT_BUFFER = 0.12;
const CTFD_SPEECH_TEAM_NAME_MAX = 12;

let CTFD_NOTIFY_MIGRATE_IN_PROGRESS = false;

let CTFD_ACTIVE_AUDIO_PLAYBACK = null;
let CTFD_ACTIVE_PLAY_BUTTON = null;
let CTFD_ACTIVE_PLAY_TOKEN = 0;

function ctfdStopActiveAudioPlayback(){
  const active = CTFD_ACTIVE_AUDIO_PLAYBACK;
  if (!active) return;
  CTFD_ACTIVE_AUDIO_PLAYBACK = null;
  try { if (active && typeof active.stop === 'function') active.stop(); } catch {}
}

function ctfdSetPlayStopButtonState(btn, playing){
  if (!btn) return;
  const isPlaying = !!playing;
  if (!btn.dataset.playTitle) btn.dataset.playTitle = btn.getAttribute('title') || 'Play';
  if (!btn.dataset.playAria) btn.dataset.playAria = btn.getAttribute('aria-label') || 'Play';
  const playTitle = btn.dataset.playTitle || 'Play';
  const playAria = btn.dataset.playAria || 'Play';
  const stopTitle = (playTitle === 'Preview audio') ? 'Stop audio'
    : (playTitle === 'Preview TTS') ? 'Stop'
    : 'Stop';
  const stopAria = (playAria === 'Preview audio') ? 'Stop audio'
    : (playAria === 'Preview TTS') ? 'Stop'
    : 'Stop';

  if (isPlaying) btn.dataset.playing = '1';
  else delete btn.dataset.playing;

  const icon = btn.querySelector('i');
  if (icon) {
    try {
      icon.classList.toggle('bi-play-fill', !isPlaying);
      icon.classList.toggle('bi-stop-fill', isPlaying);
    } catch {}
  }

  const nextTitle = isPlaying ? stopTitle : playTitle;
  const nextAria = isPlaying ? stopAria : playAria;
  try { btn.setAttribute('title', nextTitle); } catch {}
  try { btn.setAttribute('aria-label', nextAria); } catch {}
  try { btn.setAttribute('data-bs-original-title', nextTitle); } catch {}
}

function ctfdClearActivePlayButton(){
  if (!CTFD_ACTIVE_PLAY_BUTTON) return;
  try { ctfdSetPlayStopButtonState(CTFD_ACTIVE_PLAY_BUTTON, false); } catch {}
  CTFD_ACTIVE_PLAY_BUTTON = null;
}

function ctfdStopActiveSpeechPlayback(){
  try {
    const synth = window.speechSynthesis;
    if (synth && typeof synth.cancel === 'function') synth.cancel();
  } catch {}
}

function ctfdStopActivePlayback(){
  ctfdStopActiveAudioPlayback();
  ctfdStopActiveSpeechPlayback();
  ctfdClearActivePlayButton();
  try { if (typeof window !== 'undefined' && typeof window.appStopActivePlayback === 'function') window.appStopActivePlayback(); } catch {}
}

try {
  window.ctfdStopActivePlayback = ctfdStopActivePlayback;
  window.ctfdStopActiveAudioPlayback = ctfdStopActiveAudioPlayback;
  window.ctfdStopActiveSpeechPlayback = ctfdStopActiveSpeechPlayback;
} catch {}
const CTFD_AUDIO_FALLBACKS = {
  ctfdFirstUser: [
    { freq: 784, dur: 0.18, gap: 0.08, type: 'square', gain: 0.22 },
    { freq: 988, dur: 0.2, gap: 0.12, type: 'square', gain: 0.22 },
    { freq: 1175, dur: 0.24, gap: 0, type: 'square', gain: 0.2 }
  ],
  ctfdFirstTeam: [
    { freq: 659, dur: 0.18, gap: 0.08, type: 'triangle', gain: 0.21 },
    { freq: 784, dur: 0.22, gap: 0.12, type: 'triangle', gain: 0.22 },
    { freq: 988, dur: 0.26, gap: 0, type: 'triangle', gain: 0.2 }
  ],
  ctfdFirstScore: [
    { freq: 523, dur: 0.16, gap: 0.07, type: 'square', gain: 0.24 },
    { freq: 659, dur: 0.2, gap: 0.1, type: 'square', gain: 0.23 },
    { freq: 784, dur: 0.26, gap: 0, type: 'square', gain: 0.22 }
  ],
  ctfdCountdown: [
    { freq: 523, dur: 0.12, gap: 0.08, type: 'sawtooth', gain: 0.2 },
    { freq: 494, dur: 0.12, gap: 0.08, type: 'sawtooth', gain: 0.2 },
    { freq: 466, dur: 0.16, gap: 0.2, type: 'sawtooth', gain: 0.18 }
  ],
  ctfdCountdownFinal: [
    { freq: 784, dur: 0.18, gap: 0.08, type: 'sawtooth', gain: 0.24 },
    { freq: 988, dur: 0.24, gap: 0.12, type: 'sawtooth', gain: 0.24 },
    { freq: 1175, dur: 0.28, gap: 0, type: 'triangle', gain: 0.22 }
  ],
  ctfdCountdownStop: [
    { freq: 392, dur: 0.16, gap: 0.08, type: 'triangle', gain: 0.22 },
    { freq: 330, dur: 0.18, gap: 0.1, type: 'sine', gain: 0.2 },
    { freq: 262, dur: 0.22, gap: 0, type: 'sine', gain: 0.18 }
  ],
  ctfdPeriodic: [
    { freq: 440, dur: 0.14, gap: 0.08, type: 'sine', gain: 0.22 },
    { freq: 554, dur: 0.16, gap: 0.08, type: 'sine', gain: 0.22 },
    { freq: 659, dur: 0.2, gap: 0, type: 'triangle', gain: 0.2 }
  ],
  ctfdFirstCategoryUser: [
    { freq: 622, dur: 0.16, gap: 0.09, type: 'square', gain: 0.24 },
    { freq: 740, dur: 0.18, gap: 0.09, type: 'square', gain: 0.22 },
    { freq: 880, dur: 0.24, gap: 0, type: 'square', gain: 0.2 }
  ],
  ctfdFirstCategoryTeam: [
    { freq: 392, dur: 0.18, gap: 0.08, type: 'triangle', gain: 0.24 },
    { freq: 659, dur: 0.24, gap: 0, type: 'triangle', gain: 0.2 }
  ]
};

function setButtonBusyState(btn, busy, label){
  if (!btn) return;
  if (busy) {
    if (btn.dataset.busyState === '1') return;
    btn.dataset.busyState = '1';
    btn.disabled = true;
    btn.setAttribute('aria-busy', 'true');
    if (label) {
      if (!btn.dataset.busyOriginal) btn.dataset.busyOriginal = btn.innerHTML;
      btn.innerHTML = label;
    }
  } else {
    btn.disabled = false;
    btn.removeAttribute('aria-busy');
    if (btn.dataset.busyOriginal !== undefined) {
      btn.innerHTML = btn.dataset.busyOriginal;
      delete btn.dataset.busyOriginal;
    }
    delete btn.dataset.busyState;
  }
}
function setCtfdLoginBusy(busy){
  setButtonBusyState(document.getElementById('btn-ctfd-save'), busy, 'Saving…');
}
function setCtfdMultiLoginBusy(busy){
  setButtonBusyState(document.getElementById('btn-ctfd-multi-save'), busy, 'Saving…');
}
function isCtfdLoginBusy(){
  const btn = document.getElementById('btn-ctfd-save');
  return !!(btn && btn.dataset.busyState === '1');
}
const CTFD_COUNTDOWN_DEFAULT_SECONDS = 5;
let CTFD_COUNTDOWN_TIMER = null;
let CTFD_COUNTDOWN_REMAINING = 0;
let CTFD_COUNTDOWN_TOTAL_SECONDS = 0;
let CTFD_COUNTDOWN_USE_TICKS = false;
let CTFD_COUNTDOWN_REASON = '';
let CTFD_PERIODIC_TIMER = null;
let CTFD_PERIODIC_ACTIVE_PID = '';
const CTFD_CATEGORY_FIRSTS = {};
let CTFD_LAST_CHALLENGES_STATE = null;
let CTFD_CHALLENGE_REVEAL_IN_PROGRESS = false;
let CTFD_CHALLENGE_REVEAL_EXPECTED = false;
let CTFD_CHALLENGE_HIDE_EXPECTED = false;

let CTFD_LOAD_REQUEST_COUNTER = 0;
let CTFD_LOAD_ACTIVE_TOKEN = 0;
let CTFD_CONFIG_REQUEST_TOKEN = 0;

const CTFD_SCROLL_KEY = 'toolhub.ctfdManager.scrollTop';

function ctfdScrollContainer(){
  try { return document.getElementById('ctfd-table'); } catch { return null; }
}

function ctfdRestoreScrollPosition(){
  try {
    const el = ctfdScrollContainer();
    if (!el) return;
    const raw = sessionStorage.getItem(CTFD_SCROLL_KEY);
    if (raw === null) return;
    const top = parseInt(raw, 10);
    if (!Number.isFinite(top) || top < 0) return;
    requestAnimationFrame(() => {
      const max = Math.max(0, el.scrollHeight - el.clientHeight);
      el.scrollTop = Math.max(0, Math.min(top, max));
    });
  } catch {}
}

function ctfdInitScrollPersistence(){
  const el = ctfdScrollContainer();
  if (!el || el._scrollPersistBound) return;
  el._scrollPersistBound = true;
  const save = () => {
    try { sessionStorage.setItem(CTFD_SCROLL_KEY, String(el.scrollTop || 0)); } catch {}
  };
  el.addEventListener('scroll', save);
  window.addEventListener('beforeunload', save);
  ctfdRestoreScrollPosition();
}

function ctfdEnsureScrollPersistence(){
  ctfdInitScrollPersistence();
  ctfdRestoreScrollPosition();
}

document.addEventListener('DOMContentLoaded', ctfdEnsureScrollPersistence);

function ctfdResetAudioCache(){
  Object.keys(CTFD_AUDIO_CACHE).forEach(key => { delete CTFD_AUDIO_CACHE[key]; });
  Object.keys(CTFD_AUDIO_ROTATION).forEach(key => { delete CTFD_AUDIO_ROTATION[key]; });
}
document.addEventListener('settings-changed', ()=>{
  ctfdResetAudioCache();
  ctfdReschedulePeriodicForCurrent();
});

document.addEventListener('project-audio-updated', (ev)=>{
  try {
    if (CTFD_NOTIFY_MIGRATE_IN_PROGRESS) return;
    const pid = ev?.detail?.pid ? String(ev.detail.pid) : '';
    const current = ctfdCurrentPid();
    if (!pid || !current || String(pid) !== String(current)) return;
    ctfdResetAudioCache();
    ctfdReschedulePeriodicForCurrent();
    ctfdRenderNotifyConfig();
  } catch {}
});

function ctfdNotifyMigrationSessionKey(pid){
  const id = String(pid || '').trim() || 'none';
  return `toolhub.ctfd.notify.templates.migrated.v1.${id}`;
}

function ctfdMigrateNotifyTemplatesToStringsInStore(audioStore){
  const store = audioStore && typeof audioStore === 'object' ? audioStore : {};
  let changed = false;
  const outStore = { ...store };

  Object.entries(store).forEach(([k, v]) => {
    const key = String(k || '');
    if (!key.startsWith(CTFD_AUDIO_EVENT_PREFIX)) return;
    if (!v || typeof v !== 'object') return;

    const entry = v;
    const speakTemplates = Array.isArray(entry.speakTemplates) ? entry.speakTemplates : null;
    if (!speakTemplates) return;

    let needsRewrite = false;
    for (const t of speakTemplates) {
      if (t && typeof t === 'object') { needsRewrite = true; break; }
      if (t !== null && t !== undefined && typeof t !== 'string') { needsRewrite = true; break; }
    }
    if (!needsRewrite) return;

    const nextTemplates = [];
    speakTemplates.forEach(t => {
      if (t === null || t === undefined) return;
      if (typeof t === 'string') {
        const str = String(t).trim();
        if (str) nextTemplates.push(str);
        return;
      }
      if (t && typeof t === 'object') {
        const raw = (t.text !== undefined ? t.text : (t.tpl !== undefined ? t.tpl : ''));
        const str = String(raw || '').trim();
        if (str) nextTemplates.push(str);
        return;
      }
      const str = String(t).trim();
      if (str) nextTemplates.push(str);
    });

    const nextEntry = { ...entry, speakTemplates: nextTemplates };
    // Prefer speakTemplates if present.
    try { delete nextEntry.speakTemplate; } catch {}
    outStore[key] = nextEntry;
    changed = true;
  });

  return { changed, audioStore: outStore };
}

function ctfdReadSettingsSafe(){
  try {
    if (typeof readSettings === 'function') return readSettings() || {};
  } catch {}
  return {};
}

function ctfdSplitProjectAudioStore(audioStore){
  const store = audioStore && typeof audioStore === 'object' ? audioStore : {};
  const media = {};
  const events = {};
  Object.entries(store).forEach(([rawKey, rawEntry]) => {
    const key = String(rawKey || '');
    if (!key) return;
    if (key.startsWith(CTFD_AUDIO_MEDIA_PREFIX)) {
      media[key] = rawEntry;
      return;
    }
    if (key.startsWith(CTFD_AUDIO_EVENT_PREFIX)) {
      const eventKey = key.slice(CTFD_AUDIO_EVENT_PREFIX.length);
      if (eventKey) events[eventKey] = rawEntry;
    }
  });
  return { media, events };
}

function ctfdNormalizeMediaSound(entry){
  if (!entry || typeof entry !== 'object') return null;
  const sounds = Array.isArray(entry.sounds) ? entry.sounds : [];
  const sound = sounds.find(s => s && typeof s.dataUrl === 'string' && s.dataUrl.startsWith('data:')) || null;
  if (!sound) return null;
  return {
    dataUrl: sound.dataUrl,
    name: sound.name ? String(sound.name) : 'Audio',
    size: Number(sound.size) || 0,
    type: sound.type ? String(sound.type) : '',
    updated: Number(sound.updated) || 0,
  };
}

function ctfdListProjectMediaOptions(audioStore){
  const { media } = ctfdSplitProjectAudioStore(audioStore);
  const items = [];
  Object.entries(media).forEach(([key, entry]) => {
    const sound = ctfdNormalizeMediaSound(entry);
    if (!sound) return;
    items.push({ key: String(key), ...sound });
  });
  items.sort((a, b) => (b.updated || 0) - (a.updated || 0) || String(a.name).localeCompare(String(b.name)));
  return items;
}

function ctfdNotifyAudioTokenTitle(audioStore, soundKey){
  const key = String(soundKey || '').trim();
  if (!key) return 'Built-in tone (no uploaded clip selected).';
  try {
    const entry = (audioStore && typeof audioStore === 'object') ? audioStore[key] : null;
    const sound = ctfdNormalizeMediaSound(entry);
    const name = sound && sound.name ? String(sound.name) : '';
    return name ? `Audio clip: ${name}` : 'Audio clip';
  } catch {
    return 'Audio clip';
  }
}

function ctfdSetBootstrapTooltipTitle(el, title){
  if (!el) return;
  const next = String(title || '').trim() || 'Audio';
  try { el.setAttribute('title', next); } catch {}
  try { el.setAttribute('data-bs-original-title', next); } catch {}
  try { el.setAttribute('data-bs-title', next); } catch {}
  try {
    if (!window.bootstrap) return;
    const inst = bootstrap.Tooltip.getInstance(el);
    if (inst && typeof inst.setContent === 'function') {
      inst.setContent({ '.tooltip-inner': next });
      return;
    }
    if (inst) {
      try { inst.dispose(); } catch {}
    }
    bootstrap.Tooltip.getInstance(el) || new bootstrap.Tooltip(el);
  } catch {}
}

function ctfdGetProjectAudioStore(pid){
  const id = String(pid || '').trim();
  if (!id) return {};
  try {
    if (typeof getProjectAudio === 'function') return getProjectAudio(id) || {};
  } catch {}
  return {};
}

function ctfdGetSettingsAudio(){
  // Notifications are now project-scoped and backed by /api/projects/<pid>/audio.
  const pid = ctfdCurrentPid();
  const audioStore = ctfdGetProjectAudioStore(pid);
  const { media, events } = ctfdSplitProjectAudioStore(audioStore);
  const meta = window.SETTINGS_AUDIO_FIELDS_META || {};
  const out = {};

  Object.keys(meta).forEach(eventKey => {
    const fromEvents = (events && typeof events[eventKey] === 'object') ? events[eventKey] : null;
    const fromLegacy = (audioStore && typeof audioStore[eventKey] === 'object') ? audioStore[eventKey] : null;
    const source = fromEvents || fromLegacy || {};
    let entry;
    try { entry = source ? JSON.parse(JSON.stringify(source)) : {}; }
    catch { entry = source ? { ...source } : {}; }

    const soundKey = typeof entry.soundKey === 'string' ? entry.soundKey.trim() : '';
    if (soundKey && Object.prototype.hasOwnProperty.call(media, soundKey)) {
      const mediaEntry = media[soundKey];
      if (mediaEntry && typeof mediaEntry === 'object') {
        if (Array.isArray(mediaEntry.sounds)) entry.sounds = mediaEntry.sounds;
        else if (mediaEntry.dataUrl) entry.dataUrl = mediaEntry.dataUrl;
      }
    }
    out[eventKey] = entry;
  });

  return out;
}

const CTFD_NOTIFY_LABELS = {
  ctfdFirstUser: 'User 1st Place',
  ctfdFirstTeam: 'Team 1st Place',
  ctfdFirstScore: 'First Solve',
  ctfdFirstCategoryUser: 'Category 1st (User)',
  ctfdFirstCategoryTeam: 'Category 1st (Team)',
  ctfdCountdown: 'Countdown Start',
  ctfdCountdownStop: 'Countdown Stop',
  ctfdPeriodic: 'Periodic'
};

const CTFD_NOTIFY_WHEN = {
  ctfdFirstUser: 'Plays when the detected rank #1 user changes during refresh (a new user becomes user_rank = 1).',
  ctfdFirstTeam: 'Plays when the detected rank #1 team changes during refresh (a new team becomes team_rank = 1).',
  ctfdFirstScore: 'Plays when the project transitions from “no score yet” to “has score” during refresh (first solve/points appear).',
  ctfdFirstCategoryUser: 'Plays when a new “first solve in category” is detected for a user after initial seeding (during refresh).',
  ctfdFirstCategoryTeam: 'Plays when a new “first solve in category” is detected for a team after initial seeding (during refresh).',
  ctfdCountdown: 'Plays as the countdown cue used when enabling Challenges Visible (and on countdown completion announcements).',
  ctfdCountdownStop: 'Plays when cancelling/stopping the pending countdown (typically when disabling Challenges Visible while a countdown is active).',
  ctfdPeriodic: 'Plays on the periodic timer at the configured interval while enabled.'
};

function ctfdNotifyWhenDescriptionFor(key){
  const k = String(key || '').trim();
  return CTFD_NOTIFY_WHEN[k] || 'Plays when this event triggers.';
}

let CTFD_NOTIFY_ACTIVE_EVENT_KEY = '';

function ctfdNotifySetActiveEventKey(key){
  const next = String(key || '').trim();
  if (!next) return;
  CTFD_NOTIFY_ACTIVE_EVENT_KEY = next;
}

function ctfdNotifyGetActiveEventKey(){
  const current = String(CTFD_NOTIFY_ACTIVE_EVENT_KEY || '').trim();
  if (current) return current;
  try {
    const rows = document.getElementById('ctfd-notify-rows');
    const first = rows ? rows.querySelector('tr[data-event-key]') : null;
    const k = first ? String(first.getAttribute('data-event-key') || '').trim() : '';
    return k;
  } catch { return ''; }
}

function ctfdNotifyTemplateVarsForEvent(eventKey){
  const key = String(eventKey || '').trim();
  if (!key) return [];
  const meta = window.SETTINGS_AUDIO_FIELDS_META || {};
  const cfg = meta && typeof meta === 'object' ? (meta[key] || {}) : {};

  const sources = [];
  if (cfg && typeof cfg.placeholderHint === 'string') sources.push(cfg.placeholderHint);
  try {
    const defaultTemplate = ctfdNotifyDefaultSpeakTemplateFor(key);
    if (defaultTemplate) sources.push(defaultTemplate);
  } catch {}

  const seen = new Set();
  const out = [];
  const push = (name)=>{
    const v = String(name || '').trim();
    if (!v) return;
    if (seen.has(v)) return;
    seen.add(v);
    out.push(v);
  };

  // Always include the special audio token.
  push('audio');

  const re = /{{\s*([a-zA-Z0-9_]+)\s*}}/g;
  sources.forEach(text => {
    const raw = String(text || '');
    let m;
    while ((m = re.exec(raw)) !== null) {
      push(m[1]);
    }
  });

  // Hide unknown placeholders that don't correspond to context keys.
  // (We still keep 'audio' always.)
  return out;
}

function ctfdNotifyTemplateVarDescription(name){
  const key = String(name || '').trim();
  const map = {
    audio: 'Insert the selected audio clip here (no-op if no clip is selected).',
    project: 'Project name/label.',
    project_clause: 'Convenience text like “ in <project>”.',
    leader: 'Main competitor name for the event (user or team).',
    user_first: 'User name (when available).',
    team_first: 'Team name (when available).',
    team_clause: 'Convenience text like “ from team <team>”.',
    first_team: 'Leaderboard #1 team name (when available).',
    second_team: 'Leaderboard #2 team name (when available).',
    third_team: 'Leaderboard #3 team name (when available).',
    challenge: 'Challenge name (when available).',
    challenge_clause: 'Convenience text like “ on <challenge>”.',
    category: 'Challenge category (when available).',
    category_clause: 'Convenience text like “ in <category>”.',
    points: 'Points value (when available).',
    points_clause: 'Convenience text like “ worth 100 points”.',
    reason: 'Reason code for countdown events (when available).',
    reason_clause: 'Convenience text like “ for scoreboard reveal”.',
    countdown_seconds: 'Countdown duration (seconds), when available.',
    interval_minutes: 'Periodic interval minutes, when available.',
    interval_minutes_clause: 'Convenience text like “ 30 minutes”, when available.'
  };
  return map[key] || 'Template variable.';
}

function ctfdRenderNotifyTemplateVarsModal(){
  let eventKey = '';
  try {
    const select = document.getElementById('ctfd-template-vars-select');
    eventKey = select ? String(select.value || '').trim() : '';
  } catch { eventKey = ''; }
  if (!eventKey) eventKey = ctfdNotifyGetActiveEventKey();

  const body = document.getElementById('ctfd-template-vars-body');
  if (!body) return;

  if (!eventKey) {
    body.innerHTML = '<tr><td colspan="2" class="small text-muted">Select an event row to see its variables.</td></tr>';
    return;
  }

  const vars = ctfdNotifyTemplateVarsForEvent(eventKey);
  if (!vars.length) {
    body.innerHTML = '<tr><td colspan="2" class="small text-muted">No variables found for this event.</td></tr>';
    return;
  }

  body.innerHTML = vars.map(v => {
    const safe = escHtml(v);
    const desc = escHtml(ctfdNotifyTemplateVarDescription(v));
    return `<tr><td><code>{{${safe}}}</code></td><td>${desc}</td></tr>`;
  }).join('');
}

function ctfdPopulateNotifyTemplateVarsEventSelect(selectedKey){
  const select = document.getElementById('ctfd-template-vars-select');
  if (!select) return;
  const keys = ctfdNotifyEventKeys();
  const desired = String(selectedKey || '').trim();
  const active = desired || ctfdNotifyGetActiveEventKey();
  const options = keys.map(k => {
    const label = ctfdNotifyLabelFor(k);
    return `<option value="${escHtml(k)}">${escHtml(label)}</option>`;
  }).join('');
  select.innerHTML = options;
  if (active && keys.includes(active)) select.value = active;
  else if (keys.length) select.value = keys[0];
}

function ctfdWireNotifyTemplateVarsModal(){
  const modal = document.getElementById('ctfdTemplateVarsModal');
  if (!modal || modal._toolhubBound) return;
  modal.addEventListener('show.bs.modal', () => {
    try {
      ctfdPopulateNotifyTemplateVarsEventSelect(ctfdNotifyGetActiveEventKey());
      ctfdRenderNotifyTemplateVarsModal();
    } catch {}
  });
  try {
    const select = document.getElementById('ctfd-template-vars-select');
    if (select && !select._toolhubBound) {
      select.addEventListener('change', () => {
        try {
          const key = String(select.value || '').trim();
          if (key) ctfdNotifySetActiveEventKey(key);
        } catch {}
        try { ctfdRenderNotifyTemplateVarsModal(); } catch {}
      });
      select._toolhubBound = true;
    }
  } catch {}
  modal._toolhubBound = true;
}

function ctfdNotifyEventKeys(){
  const meta = window.SETTINGS_AUDIO_FIELDS_META || {};
  const keys = Object.keys(meta);
  // Prefer stable ordering when meta is missing.
  if (!keys.length) {
    return Object.keys(CTFD_NOTIFY_LABELS);
  }
  return keys;
}

function ctfdNotifyLabelFor(key){
  return CTFD_NOTIFY_LABELS[key] || key;
}

function ctfdNotifyIsMultiMode(){
  return Array.isArray(CTFD_SELECTED_PIDS) && CTFD_SELECTED_PIDS.length > 1;
}

function ctfdNotifyDefaultSpeakTemplateFor(eventKey){
  const meta = window.SETTINGS_AUDIO_FIELDS_META || {};
  const cfg = meta && typeof meta === 'object' ? meta[eventKey] : {};
  const tpl = cfg && typeof cfg.defaultSpeakTemplate === 'string' ? cfg.defaultSpeakTemplate : '';
  return String(tpl || '');
}

function ctfdNotifyDefaultSpeakEnabledFor(eventKey){
  const meta = window.SETTINGS_AUDIO_FIELDS_META || {};
  const cfg = meta && typeof meta === 'object' ? meta[eventKey] : {};
  if (cfg && cfg.defaultSpeak !== undefined) return !!cfg.defaultSpeak;
  return false;
}

function ctfdNotifySampleNewTemplateFor(eventKey){
  const key = String(eventKey || '').trim();
  if (key === 'ctfdFirstUser') return '{{audio}} New #1 user: {{name}} ({{points}} points).';
  if (key === 'ctfdFirstTeam') return '{{audio}} New #1 team: {{team}} ({{points}} points).';
  if (key === 'ctfdFirstScore') return '{{audio}} First solve recorded: {{name}} ({{points}} points).';
  if (key === 'ctfdFirstCategoryUser') return '{{audio}} First solve in {{category}} by {{name}}.';
  if (key === 'ctfdFirstCategoryTeam') return '{{audio}} First solve in {{category}} by team {{team}}.';
  if (key === 'ctfdCountdown') return '{{audio}} Countdown started.';
  if (key === 'ctfdCountdownStop') return '{{audio}} Countdown cancelled.';
  if (key === 'ctfdPeriodic') return '{{audio}} Periodic update: {{name}} is #{{rank}}.';
  return '{{audio}} Event update.';
}

function ctfdNotifyNormalizeTemplatesForUi(source){
  const out = [];
  const entry = source && typeof source === 'object' ? source : {};
  if (Array.isArray(entry.speakTemplates)) {
    entry.speakTemplates.forEach(t => {
      if (t === null || t === undefined) return;
      if (typeof t === 'string') {
        const str = String(t).trim();
        if (str) out.push(str);
        return;
      }
      if (t && typeof t === 'object') {
        const raw = (t.text !== undefined ? t.text : (t.tpl !== undefined ? t.tpl : ''));
        const str = String(raw || '').trim();
        if (str) out.push(str);
        return;
      }
      const str = String(t).trim();
      if (str) out.push(str);
    });
  }
  if (entry.speakTemplate !== undefined && entry.speakTemplate !== null) {
    const legacyTpl = String(entry.speakTemplate).trim();
    if (legacyTpl) out.push(legacyTpl);
  }
  return out;
}

function ctfdNotifyTemplateItemHtml(tplText, rowSoundKey, audioStore){
  const text = tplText !== undefined ? String(tplText || '') : '';
  const hasAudioToken = /{{\s*audio\s*}}/i.test(text);
  const tokenTitle = hasAudioToken ? ctfdNotifyAudioTokenTitle(audioStore, String(rowSoundKey || '')) : '';
  const tokenHtml = hasAudioToken
    ? `<span class="input-group-text"><code data-role="notify-audio-token" data-sound-source="row" data-bs-toggle="tooltip" data-bs-placement="top" title="${escHtml(tokenTitle)}">{{audio}}</code></span>`
    : '';
  return `<div class="input-group input-group-sm mb-1" data-role="notify-tts-item">
  <input type="text" class="form-control" data-role="notify-tts-text" value="${escHtml(text)}" />
  ${tokenHtml}
  <button class="btn btn-outline-secondary" type="button" data-role="notify-tts-play" data-bs-toggle="tooltip" data-bs-placement="top" title="Preview TTS" aria-label="Preview TTS">
    <i class="bi bi-play-fill" aria-hidden="true"></i>
  </button>
  <button class="btn btn-outline-danger" type="button" data-role="notify-tts-remove">Remove</button>
</div>`;
}

function ctfdNotifyTemplatesListHtml(templates, defaultTemplate, rowSoundKey, audioStore){
  const list = Array.isArray(templates) ? templates : [];
  if (!list.length) {
    const hint = defaultTemplate ? `Uses default: ${defaultTemplate}` : 'No templates.';
    return `<div class="small text-muted" data-role="notify-tts-empty">${escHtml(hint)}</div>`;
  }
  return list.map(t => ctfdNotifyTemplateItemHtml(t, rowSoundKey, audioStore)).join('');
}

async function ctfdRenderNotifyConfig(options){
  const rows = document.getElementById('ctfd-notify-rows');
  const status = document.getElementById('ctfd-notify-status');
  const saveBtn = document.getElementById('ctfd-notify-save');
  const reloadBtn = document.getElementById('ctfd-notify-reload');
  if (!rows) return;

  const opts = options && typeof options === 'object' ? options : {};
  const forceReload = !!opts.force;

  const pid = ctfdCurrentPid();
  if (reloadBtn) reloadBtn.disabled = !pid;
  if (saveBtn) saveBtn.disabled = !pid;

  if (!pid) {
    rows.innerHTML = '<tr><td colspan="3" class="small text-muted">Select a project to configure notification audio.</td></tr>';
    if (status) status.textContent = '';
    return;
  }
  if (ctfdNotifyIsMultiMode()) {
    rows.innerHTML = '<tr><td colspan="3" class="small text-muted">Notification audio is configured per-project (disable multi-project selection to edit).</td></tr>';
    if (status) status.textContent = '';
    if (saveBtn) saveBtn.disabled = true;
    return;
  }

  if (status) status.textContent = 'Loading…';
  try {
    if (typeof loadProjectAudio === 'function') {
      // Avoid re-downloading the full audio store (including base64 blobs)
      // on every refresh. Use cached store unless the user explicitly hits Reload.
      await loadProjectAudio(pid, { force: forceReload, silent: true });
    }
  } catch {}
  let audioStore = ctfdGetProjectAudioStore(pid);
  // One-time migration: convert object-style templates to strings so the saved
  // notification events only show TTS text like before.
  try {
    const migKey = ctfdNotifyMigrationSessionKey(pid);
    const already = sessionStorage.getItem(migKey) === '1';
    if (!already && typeof saveProjectAudio === 'function') {
      const mig = ctfdMigrateNotifyTemplatesToStringsInStore(audioStore);
      try { sessionStorage.setItem(migKey, '1'); } catch {}
      if (mig && mig.changed) {
        CTFD_NOTIFY_MIGRATE_IN_PROGRESS = true;
        try {
          await saveProjectAudio(pid, mig.audioStore);
          audioStore = ctfdGetProjectAudioStore(pid);
        } catch {
          // best effort; avoid repeated attempts this session
        } finally {
          CTFD_NOTIFY_MIGRATE_IN_PROGRESS = false;
        }
      }
    }
  } catch {
    try { CTFD_NOTIFY_MIGRATE_IN_PROGRESS = false; } catch {}
  }
  const { events } = ctfdSplitProjectAudioStore(audioStore);
  const mediaItems = ctfdListProjectMediaOptions(audioStore);
  const eventKeys = ctfdNotifyEventKeys();

  const optionsHtml = ['<option value="">Built-in tone</option>']
    .concat(mediaItems.map(item => `<option value="${escHtml(item.key)}">${escHtml(item.name || 'Audio')}</option>`))
    .join('');

  rows.innerHTML = eventKeys.map(eventKey => {
    const raw = (events && typeof events[eventKey] === 'object') ? events[eventKey] : null;
    const legacy = (audioStore && typeof audioStore[eventKey] === 'object') ? audioStore[eventKey] : null;
    const source = raw || legacy || {};
    const enabled = source && source.enabled !== undefined ? !!source.enabled : ctfdDefaultAudioEnabled(eventKey);
    const selected = source && typeof source.soundKey === 'string' ? String(source.soundKey) : '';
    const speak = source && source.speak !== undefined ? !!source.speak : ctfdNotifyDefaultSpeakEnabledFor(eventKey);
    const defaultTemplate = ctfdNotifyDefaultSpeakTemplateFor(eventKey);
    const templates = ctfdNotifyNormalizeTemplatesForUi(source);
    const sampleTpl = ctfdNotifySampleNewTemplateFor(eventKey);
    const label = ctfdNotifyLabelFor(eventKey);
    const when = ctfdNotifyWhenDescriptionFor(eventKey);
    return `<tr data-event-key="${escHtml(eventKey)}">
  <td>
    <input class="form-check-input" type="checkbox" data-role="notify-enabled" ${enabled ? 'checked' : ''} />
  </td>
  <td class="small">
    <div class="d-flex align-items-center gap-2">
      <span>${escHtml(label)}</span>
      <button type="button" class="btn btn-outline-secondary btn-sm py-0 px-1" data-role="notify-when" data-bs-toggle="tooltip" data-bs-placement="top" title="${escHtml(when)}" aria-label="When this event plays">
        <i class="bi bi-question-circle" aria-hidden="true"></i>
      </button>
    </div>
  </td>
  <td>
    <div class="input-group input-group-sm mb-2">
      <select class="form-select" data-role="notify-sound">${optionsHtml}</select>
      <button type="button" class="btn btn-outline-secondary" data-role="notify-preview" data-bs-toggle="tooltip" data-bs-placement="top" title="Preview audio" aria-label="Preview audio">
        <i class="bi bi-play-fill" aria-hidden="true"></i>
      </button>
    </div>

    <div class="d-flex align-items-center gap-2 mb-1">
      <div class="form-check m-0">
        <input class="form-check-input" type="checkbox" data-role="notify-speak" ${speak ? 'checked' : ''} />
        <label class="form-check-label small">Speak (TTS)</label>
      </div>
    </div>

    <div class="small text-muted mb-1">Use <code>{{audio}}</code> to place the audio clip inside the spoken text.</div>

    <div class="input-group input-group-sm mb-1">
      <input type="text" class="form-control" data-role="notify-tts-new" placeholder="e.g. ${escHtml(sampleTpl)}" />
      <button class="btn btn-outline-secondary" type="button" data-role="notify-tts-add">Add</button>
      <button type="button" class="btn btn-outline-secondary" data-role="notify-vars" data-bs-toggle="tooltip" data-bs-placement="top" title="Template Variable List" aria-label="Template Variable List">
        <i class="bi bi-question-circle" aria-hidden="true"></i>
      </button>
    </div>

    <div data-role="notify-tts-list">${ctfdNotifyTemplatesListHtml(templates, defaultTemplate, selected, audioStore)}</div>
  </td>
  </tr>`;
  }).join('');

  // Tooltips for dynamically-rendered controls.
  try {
    if (window.bootstrap) {
      rows.querySelectorAll('[data-bs-toggle="tooltip"]').forEach(el => {
        try { bootstrap.Tooltip.getInstance(el) || new bootstrap.Tooltip(el); } catch {}
      });
    }
  } catch {}

  // Apply selected values after row HTML exists.
  rows.querySelectorAll('tr[data-event-key]').forEach(tr => {
    const eventKey = tr.getAttribute('data-event-key') || '';
    const raw = (events && typeof events[eventKey] === 'object') ? events[eventKey] : null;
    const legacy = (audioStore && typeof audioStore[eventKey] === 'object') ? audioStore[eventKey] : null;
    const source = raw || legacy || {};
    const selected = source && typeof source.soundKey === 'string' ? String(source.soundKey) : '';
    const select = tr.querySelector('select[data-role="notify-sound"]');
    if (select) select.value = selected;
  });

  if (status) status.textContent = mediaItems.length ? '' : 'No uploaded audio yet. Upload files in Settings → Media Manager.';
}

async function ctfdSaveNotifyConfig(){
  const status = document.getElementById('ctfd-notify-status');
  const pid = ctfdCurrentPid();
  if (!pid) return;
  if (ctfdNotifyIsMultiMode()) return;
  const rows = document.getElementById('ctfd-notify-rows');
  if (!rows) return;
  if (status) status.textContent = 'Saving…';

  let audioStore = {};
  try {
    if (typeof loadProjectAudio === 'function') {
      // Prefer cached store to avoid pulling large base64 payloads during Save.
      // If not cached yet, loadProjectAudio will fetch it once.
      audioStore = await loadProjectAudio(pid, { force: false, silent: true });
    } else {
      audioStore = ctfdGetProjectAudioStore(pid);
    }
  } catch {
    audioStore = ctfdGetProjectAudioStore(pid);
  }

  rows.querySelectorAll('tr[data-event-key]').forEach(tr => {
    const eventKey = tr.getAttribute('data-event-key') || '';
    if (!eventKey) return;
    const enabledEl = tr.querySelector('input[data-role="notify-enabled"]');
    const selectEl = tr.querySelector('select[data-role="notify-sound"]');
    const speakEl = tr.querySelector('input[data-role="notify-speak"]');
    const enabled = !!enabledEl?.checked;
    const soundKey = selectEl ? String(selectEl.value || '') : '';
    const speak = !!speakEl?.checked;

    const templates = [];
    tr.querySelectorAll('[data-role="notify-tts-item"]').forEach(item => {
      const textEl = item.querySelector('input[data-role="notify-tts-text"]');
      const text = textEl ? String(textEl.value || '').trim() : '';
      if (!text) return;
      templates.push(text);
    });

    const storeKey = `${CTFD_AUDIO_EVENT_PREFIX}${eventKey}`;
    const existing = (audioStore && typeof audioStore[storeKey] === 'object') ? audioStore[storeKey] : {};
    const next = existing && typeof existing === 'object' ? { ...existing } : {};
    next.enabled = enabled;
    next.speak = speak;
    if (soundKey) next.soundKey = soundKey;
    else {
      try { delete next.soundKey; } catch {}
    }

    // Store templates as strings (TTS text only).
    next.speakTemplates = templates;
    try { delete next.speakTemplate; } catch {}

    audioStore[storeKey] = next;
  });

  try {
    if (typeof saveProjectAudio === 'function') {
      await saveProjectAudio(pid, audioStore);
      if (status) status.textContent = 'Saved.';
      setTimeout(() => { try { if (status && status.textContent === 'Saved.') status.textContent = ''; } catch {} }, 1500);
    } else {
      if (status) status.textContent = 'Save is unavailable.';
    }
  } catch (err) {
    if (status) status.textContent = `Save failed: ${err?.message || err}`;
  }
}

function ctfdWireNotifyConfig(){
  const reloadBtn = document.getElementById('ctfd-notify-reload');
  const saveBtn = document.getElementById('ctfd-notify-save');
  const rows = document.getElementById('ctfd-notify-rows');
  if (reloadBtn && !reloadBtn._toolhubBound) {
    reloadBtn.addEventListener('click', ()=> ctfdRenderNotifyConfig({ force: true }));
    reloadBtn._toolhubBound = true;
  }
  if (saveBtn && !saveBtn._toolhubBound) {
    saveBtn.addEventListener('click', ()=> ctfdSaveNotifyConfig());
    saveBtn._toolhubBound = true;
  }
  if (rows && !rows._toolhubBound) {
    rows.addEventListener('focusin', (ev) => {
      const tr = ev.target && ev.target.closest ? ev.target.closest('tr[data-event-key]') : null;
      if (!tr) return;
      const eventKey = tr.getAttribute('data-event-key') || '';
      ctfdNotifySetActiveEventKey(eventKey);
    });
    rows.addEventListener('click', (ev) => {
      const trForActive = ev.target && ev.target.closest ? ev.target.closest('tr[data-event-key]') : null;
      if (trForActive) {
        const eventKey = trForActive.getAttribute('data-event-key') || '';
        ctfdNotifySetActiveEventKey(eventKey);
      }

      const varsBtn = ev.target && ev.target.closest ? ev.target.closest('button[data-role="notify-vars"]') : null;
      if (varsBtn) {
        ev.preventDefault();
        try {
          const tr = varsBtn.closest('tr[data-event-key]');
          const eventKey = tr ? (tr.getAttribute('data-event-key') || '') : '';
          if (eventKey) ctfdNotifySetActiveEventKey(eventKey);
        } catch {}
        try {
          const modalEl = document.getElementById('ctfdTemplateVarsModal');
          if (modalEl && window.bootstrap) {
            const modal = bootstrap.Modal.getInstance(modalEl) || new bootstrap.Modal(modalEl);
            modal.show();
          }
        } catch {}
        return;
      }

      const addBtn = ev.target && ev.target.closest ? ev.target.closest('button[data-role="notify-tts-add"]') : null;
      if (addBtn) {
        ev.preventDefault();
        const tr = addBtn.closest('tr[data-event-key]');
        if (!tr) return;
        const input = tr.querySelector('input[data-role="notify-tts-new"]');
        const text = input ? String(input.value || '').trim() : '';
        if (!text) return;
        const rowSelect = tr.querySelector('select[data-role="notify-sound"]');
        const soundKey = rowSelect ? String(rowSelect.value || '') : '';
        const list = tr.querySelector('[data-role="notify-tts-list"]');
        if (!list) return;
        try {
          const empty = list.querySelector('[data-role="notify-tts-empty"]');
          if (empty) empty.remove();
        } catch {}
        let audioStore = {};
        try {
          const pid = ctfdCurrentPid();
          audioStore = ctfdGetProjectAudioStore(pid);
        } catch { audioStore = {}; }
        list.insertAdjacentHTML('beforeend', ctfdNotifyTemplateItemHtml(text, soundKey, audioStore));
        if (input) input.value = '';

        // Tooltips for newly inserted controls.
        try {
          if (window.bootstrap) {
            list.querySelectorAll('[data-bs-toggle="tooltip"]').forEach(el => {
              try { bootstrap.Tooltip.getInstance(el) || new bootstrap.Tooltip(el); } catch {}
            });
          }
        } catch {}
        return;
      }

      const removeBtn = ev.target && ev.target.closest ? ev.target.closest('button[data-role="notify-tts-remove"]') : null;
      if (removeBtn) {
        ev.preventDefault();
        const item = removeBtn.closest('[data-role="notify-tts-item"]');
        const tr = removeBtn.closest('tr[data-event-key]');
        const list = tr ? tr.querySelector('[data-role="notify-tts-list"]') : null;
        if (item) item.remove();
        if (list && !list.querySelector('[data-role="notify-tts-item"]')) {
          const eventKey = tr ? (tr.getAttribute('data-event-key') || '') : '';
          const defaultTemplate = eventKey ? ctfdNotifyDefaultSpeakTemplateFor(eventKey) : '';
          list.innerHTML = ctfdNotifyTemplatesListHtml([], defaultTemplate);
        }
        return;
      }

      const ttsPlayBtn = ev.target && ev.target.closest ? ev.target.closest('button[data-role="notify-tts-play"]') : null;
      if (ttsPlayBtn) {
        ev.preventDefault();
        if (ttsPlayBtn.dataset.playing === '1') {
          ctfdStopActivePlayback();
          return;
        }
        ctfdStopActivePlayback();
        CTFD_ACTIVE_PLAY_BUTTON = ttsPlayBtn;
        const token = String(++CTFD_ACTIVE_PLAY_TOKEN);
        ttsPlayBtn.dataset.playToken = token;
        ctfdSetPlayStopButtonState(ttsPlayBtn, true);
        const revert = () => {
          try {
            if (CTFD_ACTIVE_PLAY_BUTTON === ttsPlayBtn) CTFD_ACTIVE_PLAY_BUTTON = null;
            ctfdSetPlayStopButtonState(ttsPlayBtn, false);
          } catch {}
        };
        try {
          if (window.shell && shell.isRemote && shell.isRemote()) {
            revert();
            return;
          }
        } catch {}
        const item = ttsPlayBtn.closest('[data-role="notify-tts-item"]');
        const tr = ttsPlayBtn.closest('tr[data-event-key]');
        if (!item || !tr) {
          revert();
          return;
        }
        const eventKey = tr.getAttribute('data-event-key') || '';
        const label = ctfdNotifyLabelFor(eventKey);
        const textEl = item.querySelector('input[data-role="notify-tts-text"]');
        const tpl = textEl ? String(textEl.value || '').trim() : '';
        if (!tpl) {
          revert();
          return;
        }

        const rowSelect = tr.querySelector('select[data-role="notify-sound"]');
        const rowSoundKey = rowSelect ? String(rowSelect.value || '') : '';
        const soundKey = rowSoundKey;
        const pid = ctfdCurrentPid();
        const audioStore = ctfdGetProjectAudioStore(pid);
        const mediaEntry = (soundKey && audioStore && typeof audioStore[soundKey] === 'object') ? audioStore[soundKey] : null;
        const sound = ctfdNormalizeMediaSound(mediaEntry);
        const skipAudioSegments = !soundKey || !sound || !sound.dataUrl;

        const payload = {
          context: { name: 'Example', team: 'Example', category: 'Example', points: 0, rank: 1 },
          fallbackText: label
        };

        ctfdSpeakFromTemplate(tpl, payload, 0, {
          interrupt: true,
          forceSpeak: true,
          skipAudioSegments,
          onAudioRequest: async () => {
            try {
              if (!soundKey) return { played: false, duration: 0 };
              return await ctfdPlayProjectMediaSoundKey(soundKey, 0);
            } catch {
              return { played: false, duration: 0 };
            }
          }
        }).catch(()=>{}).finally(() => {
          try {
            if (CTFD_ACTIVE_PLAY_BUTTON !== ttsPlayBtn) return;
            if (ttsPlayBtn.dataset.playToken !== token) return;
            ctfdSetPlayStopButtonState(ttsPlayBtn, false);
            CTFD_ACTIVE_PLAY_BUTTON = null;
          } catch {}
        });
        return;
      }

      const btn = ev.target && ev.target.closest ? ev.target.closest('button[data-role="notify-preview"]') : null;
      if (!btn) return;
      ev.preventDefault();
      if (btn.dataset.playing === '1') {
        ctfdStopActivePlayback();
        return;
      }
      ctfdStopActivePlayback();
      CTFD_ACTIVE_PLAY_BUTTON = btn;
      const token = String(++CTFD_ACTIVE_PLAY_TOKEN);
      btn.dataset.playToken = token;
      ctfdSetPlayStopButtonState(btn, true);
      const revert = () => {
        try {
          if (CTFD_ACTIVE_PLAY_BUTTON === btn) CTFD_ACTIVE_PLAY_BUTTON = null;
          ctfdSetPlayStopButtonState(btn, false);
        } catch {}
      };
      try {
        if (window.shell && shell.isRemote && shell.isRemote()) {
          revert();
          return;
        }
      } catch {}
      const tr = btn.closest('tr[data-event-key]');
      if (!tr) {
        revert();
        return;
      }
      const select = tr.querySelector('select[data-role="notify-sound"]');
      const soundKey = select ? String(select.value || '') : '';
      if (!soundKey) {
        revert();
        return;
      }
      ctfdPlayProjectMediaSoundKey(soundKey, 0).catch(()=>{}).finally(() => {
        try {
          if (CTFD_ACTIVE_PLAY_BUTTON !== btn) return;
          if (btn.dataset.playToken !== token) return;
          ctfdSetPlayStopButtonState(btn, false);
          CTFD_ACTIVE_PLAY_BUTTON = null;
        } catch {}
      });
    });

    rows.addEventListener('change', (ev) => {
      const select = ev.target && ev.target.closest ? ev.target.closest('select[data-role="notify-sound"]') : null;
      if (!select) return;
      const tr = select.closest('tr[data-event-key]');
      if (!tr) return;
      const pid = ctfdCurrentPid();
      const audioStore = ctfdGetProjectAudioStore(pid);
      const soundKey = String(select.value || '').trim();
      const title = ctfdNotifyAudioTokenTitle(audioStore, soundKey);
      tr.querySelectorAll('code[data-role="notify-audio-token"][data-sound-source="row"]').forEach(token => {
        ctfdSetBootstrapTooltipTitle(token, title);
      });
    });

    rows.addEventListener('keydown', (ev) => {
      try {
        const tr = ev.target && ev.target.closest ? ev.target.closest('tr[data-event-key]') : null;
        if (tr) ctfdNotifySetActiveEventKey(tr.getAttribute('data-event-key') || '');
      } catch {}
      const input = ev.target && ev.target.closest ? ev.target.closest('input[data-role="notify-tts-new"]') : null;
      if (!input) return;
      if (ev.key !== 'Enter') return;
      ev.preventDefault();
      const tr = input.closest('tr[data-event-key]');
      const addBtn = tr ? tr.querySelector('button[data-role="notify-tts-add"]') : null;
      if (addBtn) addBtn.click();
    });

    rows._toolhubBound = true;
  }
  document.addEventListener('project-selected', () => ctfdRenderNotifyConfig());
  ctfdRenderNotifyConfig();
}
function ctfdClearPeriodicTimer(){
  if (CTFD_PERIODIC_TIMER) {
    clearTimeout(CTFD_PERIODIC_TIMER);
    CTFD_PERIODIC_TIMER = null;
  }
  CTFD_PERIODIC_ACTIVE_PID = '';
}
function ctfdSchedulePeriodicTimer(pid){
  const targetPid = pid || ctfdCurrentPid() || '';
  if (!targetPid) {
    ctfdClearPeriodicTimer();
    return;
  }
  const entry = ctfdGetAudioEntry('ctfdPeriodic');
  const enabled = entry && entry.enabled !== undefined ? !!entry.enabled : ctfdDefaultAudioEnabled('ctfdPeriodic');
  const intervalMinutes = entry && Number(entry.intervalMinutes);
  if (!enabled || !Number.isFinite(intervalMinutes) || intervalMinutes <= 0) {
    ctfdClearPeriodicTimer();
    return;
  }
  const delayMs = Math.max(60000, Math.round(intervalMinutes * 60000));
  ctfdClearPeriodicTimer();
  CTFD_PERIODIC_ACTIVE_PID = String(targetPid);
  CTFD_PERIODIC_TIMER = setTimeout(()=>{
    const activePid = CTFD_PERIODIC_ACTIVE_PID || ctfdCurrentPid() || '';
    if (!activePid) {
      ctfdClearPeriodicTimer();
      return;
    }
    ctfdAnnouncePeriodic(activePid);
    ctfdSchedulePeriodicTimer(activePid);
  }, delayMs);
}
function ctfdReschedulePeriodicForProject(pid){
  const targetPid = pid || ctfdCurrentPid() || '';
  if (!targetPid) {
    ctfdClearPeriodicTimer();
    return;
  }
  const entry = ctfdGetAudioEntry('ctfdPeriodic');
  const enabled = entry && entry.enabled !== undefined ? !!entry.enabled : ctfdDefaultAudioEnabled('ctfdPeriodic');
  const intervalMinutes = entry && Number(entry.intervalMinutes);
  if (!enabled || !Number.isFinite(intervalMinutes) || intervalMinutes <= 0) {
    ctfdClearPeriodicTimer();
    return;
  }
  ctfdSchedulePeriodicTimer(targetPid);
}
function ctfdReschedulePeriodicForCurrent(){
  ctfdReschedulePeriodicForProject(ctfdCurrentPid());
}
function ctfdCategoryState(pid){
  const key = String(pid || '').trim();
  if (!key) return { user: {}, team: {} };
  if (!CTFD_CATEGORY_FIRSTS[key]) {
    CTFD_CATEGORY_FIRSTS[key] = { user: {}, team: {}, seededUser: false, seededTeam: false };
  }
  const state = CTFD_CATEGORY_FIRSTS[key];
  if (!state.user) state.user = {};
  if (!state.team) state.team = {};
  if (state.seededUser === undefined) state.seededUser = false;
  if (state.seededTeam === undefined) state.seededTeam = false;
  return state;
}
function ctfdNormalizeCategoryName(name){
  const raw = typeof name === 'string' ? name.trim() : '';
  if (!raw) return 'Uncategorized';
  return raw;
}
function ctfdCategoryKey(name){
  return ctfdNormalizeCategoryName(name).toLowerCase();
}
function ctfdNormalizeCategorySolve(kind, item){
  if (!item) return null;
  const category = ctfdNormalizeCategoryName(item.category);
  const key = ctfdCategoryKey(item.category);
  let timestampEpoch = Number(item.timestamp_epoch);
  if (!Number.isFinite(timestampEpoch)) {
    const tsRaw = item.timestamp || item.timestamp_iso || item.generated_at;
    const parsed = tsRaw ? Date.parse(tsRaw) : NaN;
    if (Number.isFinite(parsed)) timestampEpoch = Math.floor(parsed / 1000);
  }
  const challenge = item.challenge ? String(item.challenge).trim() : '';
  const challengeId = item.challenge_id !== undefined ? item.challenge_id : item.challengeId;
  const userName = item.user || item.user_name || item.account_name || item.name;
  const teamName = item.team || item.team_name || item.group;
  const normalized = {
    category,
    key,
    challenge,
    challenge_id: challengeId,
    timestampEpoch: Number.isFinite(timestampEpoch) ? timestampEpoch : null,
    timestamp: item.timestamp || item.timestamp_iso || null,
    user: kind === 'user' ? (userName ? String(userName).trim() : '') : '',
    team: teamName ? String(teamName).trim() : ''
  };
  return normalized;
}
function ctfdDefaultAudioEnabled(key){
  const defaults = window.SETTINGS_AUDIO_DEFAULTS || {};
  if (Object.prototype.hasOwnProperty.call(defaults, key)) return !!defaults[key];
  return true;
}
function ctfdGetAudioEntry(key){
  const audio = ctfdGetSettingsAudio();
  const raw = audio && typeof audio[key] === 'object' ? audio[key] : null;
  const meta = window.SETTINGS_AUDIO_FIELDS_META || {};
  const cfg = meta && typeof meta === 'object' ? meta[key] : {};
  let entry;
  try { entry = raw ? JSON.parse(JSON.stringify(raw)) : {}; }
  catch { entry = raw ? { ...raw } : {}; }
  if (entry.enabled === undefined) entry.enabled = ctfdDefaultAudioEnabled(key);
  if (entry.speak === undefined) entry.speak = cfg && cfg.defaultSpeak !== undefined ? !!cfg.defaultSpeak : false;
  if (typeof settingsAudioNormalizeLegacyTemplate === 'function') {
    try { settingsAudioNormalizeLegacyTemplate(entry, key); } catch {}
  }
  const defaultTemplate = cfg && typeof cfg.defaultSpeakTemplate === 'string' ? cfg.defaultSpeakTemplate : '';
  const sounds = [];
  if (Array.isArray(entry.sounds)) {
    entry.sounds.forEach(sound => {
      if (!sound) return;
      const dataUrl = typeof sound.dataUrl === 'string' ? sound.dataUrl : '';
      if (!dataUrl.startsWith('data:')) return;
      sounds.push({
        dataUrl,
        name: sound.name || '',
        size: Number(sound.size) || 0,
        type: sound.type || '',
        updated: sound.updated || 0
      });
    });
  }
  if (!sounds.length && entry.dataUrl) {
    const legacyUrl = String(entry.dataUrl || '');
    if (legacyUrl.startsWith('data:')) {
      sounds.push({
        dataUrl: legacyUrl,
        name: entry.name || '',
        size: Number(entry.size) || 0,
        type: entry.type || '',
        updated: entry.updated || 0
      });
    }
  }
  entry.sounds = sounds;
  delete entry.dataUrl;
  delete entry.name;
  delete entry.size;
  delete entry.type;
  delete entry.updated;
  // Templates are stored per-project under event:<key>.
  // Support both legacy formats:
  // - speakTemplate: string
  // - speakTemplates: string[]
  // And current format:
  // - speakTemplates: Array<{ text: string, enabled: boolean }>
  const templates = [];
  if (Array.isArray(entry.speakTemplates)) {
    entry.speakTemplates.forEach(t => {
      if (t === null || t === undefined) return;
      if (typeof t === 'string') {
        const str = String(t).trim();
        if (str) templates.push({ text: str, enabled: true });
        return;
      }
      if (t && typeof t === 'object') {
        const textRaw = (t.text !== undefined ? t.text : (t.tpl !== undefined ? t.tpl : ''));
        const str = String(textRaw || '').trim();
        if (!str) return;
        const enabled = t.enabled === undefined ? true : !!t.enabled;
        const soundKey = typeof t.soundKey === 'string' ? String(t.soundKey || '').trim() : '';
        templates.push(soundKey ? { text: str, enabled, soundKey } : { text: str, enabled });
      }
    });
  }
  if (entry.speakTemplate !== undefined && entry.speakTemplate !== null) {
    const legacyTpl = String(entry.speakTemplate).trim();
    if (legacyTpl) templates.push({ text: legacyTpl, enabled: true });
  }
  if (!templates.length && defaultTemplate) templates.push({ text: defaultTemplate, enabled: true });
  entry.speakTemplates = templates;
  entry.defaultSpeakTemplate = defaultTemplate;
  delete entry.speakTemplate;
  if (typeof settingsAudioApplyNumericFields === 'function') {
    try { settingsAudioApplyNumericFields(entry, key); } catch {}
  }
  return entry;
}
function ctfdListValidSounds(entry){
  const list = entry && Array.isArray(entry.sounds) ? entry.sounds : [];
  return list.map((sound, idx) => ({ sound, idx })).filter(item => {
    const dataUrl = item && item.sound && typeof item.sound.dataUrl === 'string' ? item.sound.dataUrl : '';
    return dataUrl.startsWith('data:');
  });
}
function ctfdListValidTemplates(entry){
  const list = entry && Array.isArray(entry.speakTemplates) ? entry.speakTemplates : [];
  return list.map((tpl, idx) => {
    if (tpl === null || tpl === undefined) return { tpl: '', idx, enabled: false };
    if (typeof tpl === 'string') {
      const str = String(tpl).trim();
      return { tpl: str, idx, enabled: true, soundKey: '' };
    }
    if (tpl && typeof tpl === 'object') {
      const raw = (tpl.text !== undefined ? tpl.text : (tpl.tpl !== undefined ? tpl.tpl : ''));
      const str = String(raw || '').trim();
      const enabled = tpl.enabled === undefined ? true : !!tpl.enabled;
      const soundKey = typeof tpl.soundKey === 'string' ? String(tpl.soundKey || '').trim() : '';
      return { tpl: str, idx, enabled, soundKey };
    }
    const str = String(tpl).trim();
    return { tpl: str, idx, enabled: true, soundKey: '' };
  }).filter(item => !!item.tpl && !!item.enabled);
}
function ctfdRotationState(key){
  if (!CTFD_AUDIO_ROTATION[key]) {
    CTFD_AUDIO_ROTATION[key] = { soundsQueue: [], templatesQueue: [] };
  }
  return CTFD_AUDIO_ROTATION[key];
}
function ctfdShuffleIndices(count){
  const arr = [];
  for (let i = 0; i < count; i++) arr.push(i);
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
  }
  return arr;
}
function ctfdSelectNextSoundSlot(key, entry){
  const list = ctfdListValidSounds(entry);
  if (!list.length) return null;
  const state = ctfdRotationState(key);
  const active = new Set(list.map(item => item.idx));
  state.soundsQueue = (state.soundsQueue || []).filter(idx => active.has(idx));
  if (!state.soundsQueue.length) {
    const order = ctfdShuffleIndices(list.length);
    state.soundsQueue = order.map(i => list[i].idx);
  }
  const nextIdx = state.soundsQueue.shift();
  const selected = list.find(item => item.idx === nextIdx) || list[0];
  return selected || null;
}
function ctfdSelectNextTemplateText(key, entry, fallback){
  const list = ctfdListValidTemplates(entry);
  if (!list.length) return fallback || '';
  const state = ctfdRotationState(key);
  const active = new Set(list.map(item => item.idx));
  state.templatesQueue = (state.templatesQueue || []).filter(idx => active.has(idx));
  if (!state.templatesQueue.length) {
    const order = ctfdShuffleIndices(list.length);
    state.templatesQueue = order.map(i => list[i].idx);
  }
  const nextIdx = state.templatesQueue.shift();
  const selected = list.find(item => item.idx === nextIdx) || list[0];
  return selected ? selected.tpl : (fallback || '');
}

function ctfdSelectNextTemplateSelection(key, entry, fallback){
  const list = ctfdListValidTemplates(entry);
  if (!list.length) return { tpl: fallback || '', soundKey: '' };
  const state = ctfdRotationState(key);
  const active = new Set(list.map(item => item.idx));
  state.templatesQueue = (state.templatesQueue || []).filter(idx => active.has(idx));
  if (!state.templatesQueue.length) {
    const order = ctfdShuffleIndices(list.length);
    state.templatesQueue = order.map(i => list[i].idx);
  }
  const nextIdx = state.templatesQueue.shift();
  const selected = list.find(item => item.idx === nextIdx) || list[0];
  return {
    tpl: selected ? selected.tpl : (fallback || ''),
    soundKey: selected && typeof selected.soundKey === 'string' ? selected.soundKey : ''
  };
}
function ctfdHasCustomAudio(key){
  const entry = ctfdGetAudioEntry(key);
  return ctfdListValidSounds(entry).length > 0;
}
function ctfdIsAudioEnabled(key){
  const entry = ctfdGetAudioEntry(key);
  if (entry && entry.enabled !== undefined) return !!entry.enabled;
  return ctfdDefaultAudioEnabled(key);
}
function ctfdShouldSpeak(key){
  const entry = ctfdGetAudioEntry(key);
  if (entry && entry.speak !== undefined) return !!entry.speak;
  const meta = window.SETTINGS_AUDIO_FIELDS_META || {};
  const cfg = meta && typeof meta === 'object' ? meta[key] : {};
  if (cfg && cfg.defaultSpeak !== undefined) return !!cfg.defaultSpeak;
  return false;
}
function ctfdSpeechSupported(){
  try {
    return typeof window !== 'undefined'
      && 'speechSynthesis' in window
      && window.speechSynthesis
      && typeof window.speechSynthesis.speak === 'function'
      && typeof window.SpeechSynthesisUtterance === 'function';
  } catch { return false; }
}
function ctfdSpeechTrimTeamName(name){
  const raw = typeof name === 'string' ? name.trim() : String(name || '').trim();
  if (!raw) return '';
  return raw.length > CTFD_SPEECH_TEAM_NAME_MAX ? raw.slice(0, CTFD_SPEECH_TEAM_NAME_MAX) : raw;
}
function ctfdDataUrlToBuffer(dataUrl){
  try {
    const parts = String(dataUrl || '').split(',');
    if (parts.length < 2) return null;
    const base64 = parts.slice(1).join(',');
    const binary = atob(base64);
    const len = binary.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);
    return bytes.buffer.slice(0);
  } catch { return null; }
}
async function ctfdDecodeAudioBuffer(ctx, arrayBuffer){
  if (!ctx || !arrayBuffer) return null;
  if (ctx.decodeAudioData && ctx.decodeAudioData.length === 1) {
    try { return await ctx.decodeAudioData(arrayBuffer.slice(0)); } catch { return null; }
  }
  if (ctx.decodeAudioData) {
    return await new Promise((resolve, reject)=> ctx.decodeAudioData(arrayBuffer.slice(0), resolve, reject));
  }
  return null;
}
function ctfdSpeechTemplateFor(key){
  const entry = ctfdGetAudioEntry(key);
  const fallback = entry && typeof entry.defaultSpeakTemplate === 'string' ? entry.defaultSpeakTemplate : '';
  return ctfdSelectNextTemplateText(key, entry, fallback);
}

function ctfdSpeechTemplateSelectionFor(key){
  const entry = ctfdGetAudioEntry(key);
  const fallback = entry && typeof entry.defaultSpeakTemplate === 'string' ? entry.defaultSpeakTemplate : '';
  return ctfdSelectNextTemplateSelection(key, entry, fallback);
}
function ctfdCompileSpeechTemplate(template, context){
  const ctx = context && typeof context === 'object' ? context : {};
  const raw = template != null ? String(template) : '';
  const result = {
    segments: [],
    hasSpeech: false,
    hasAudio: false,
    hasSpeechIntent: false,
    templateTrimmed: raw.trim(),
    fallbackTargets: []
  };
  if (!raw) return result;
  const regex = /{{\s*([a-zA-Z0-9_]+)\s*}}/g;
  let cursor = 0;
  const pushText = (value)=>{
    if (!value) return;
    const last = result.segments[result.segments.length - 1];
    if (last && last.type === 'text') last.text += value;
    else result.segments.push({ type: 'text', text: value });
    if (!result.hasSpeech && value.trim()) result.hasSpeech = true;
  };
  const markFallbackTarget = ()=>{
    const idx = result.segments.length;
    if (!result.fallbackTargets.includes(idx)) result.fallbackTargets.push(idx);
  };
  let match;
  while ((match = regex.exec(raw))) {
    const literal = raw.slice(cursor, match.index);
    if (literal) {
      pushText(literal);
      if (literal.trim()) result.hasSpeechIntent = true;
    }
    const key = (match[1] || '').trim();
    if (key) {
      if (key === 'audio') {
        result.segments.push({ type: 'audio' });
        result.hasAudio = true;
      } else {
        result.hasSpeechIntent = true;
        if (Object.prototype.hasOwnProperty.call(ctx, key) && ctx[key] != null) {
          const rawValue = String(ctx[key]);
          const trimmedValue = rawValue.trim();
          if (trimmedValue) {
            pushText(rawValue);
          } else {
            if (rawValue) pushText(rawValue);
            markFallbackTarget();
          }
        } else {
          // If the template variable doesn't map to anything, speak the variable name
          // so it's obvious during preview/testing.
          pushText(String(key).replace(/_/g, ' '));
        }
      }
    }
    cursor = match.index + match[0].length;
  }
  const trailing = raw.slice(cursor);
  if (trailing) {
    pushText(trailing);
    if (trailing.trim()) result.hasSpeechIntent = true;
  }
  if (result.fallbackTargets.length > 1) {
    result.fallbackTargets.sort((a, b) => a - b);
  }
  return result;
}
function ctfdBuildSpeechPlan(key, context, fallbackText){
  const template = ctfdSpeechTemplateFor(key);
  const compiled = ctfdCompileSpeechTemplate(template, context);
  const segments = compiled.segments.slice();
  let hasSpeech = compiled.hasSpeech;
  if (!hasSpeech) {
    const fallback = fallbackText != null ? String(fallbackText).trim() : '';
    if (fallback && (compiled.hasSpeechIntent || !compiled.templateTrimmed)) {
      const insertAt = compiled.fallbackTargets.length ? compiled.fallbackTargets[0] : segments.length;
      const clamped = Math.max(0, Math.min(insertAt, segments.length));
      const prev = clamped > 0 ? segments[clamped - 1] : null;
      const next = clamped < segments.length ? segments[clamped] : null;
      if (prev && prev.type === 'text') {
        prev.text += fallback;
      } else if (next && next.type === 'text') {
        next.text = fallback + next.text;
      } else {
        segments.splice(clamped, 0, { type: 'text', text: fallback });
      }
      hasSpeech = true;
    }
  }
  return { segments, hasSpeech, hasAudio: compiled.hasAudio };
}
async function ctfdTryPlayCustomAudio(key, delaySeconds){
  try { if (window.shell && shell.isRemote && shell.isRemote()) return { played: false, duration: 0 }; } catch {}
  try {
    const entry = ctfdGetAudioEntry(key);
    if (!ctfdIsAudioEnabled(key)) return { played: false, duration: 0 };
    const selection = ctfdSelectNextSoundSlot(key, entry);
    if (!selection || !selection.sound) return { played: false, duration: 0 };
    const clip = selection.sound;
    const dataUrl = typeof clip.dataUrl === 'string' ? clip.dataUrl : '';
    if (!dataUrl) return { played: false, duration: 0 };
    const offset = Math.max(0, Number(delaySeconds) || 0);

    // Prevent overlapping clips.
    ctfdStopActiveAudioPlayback();

    const ctx = ctfdEnsureAudioContext();
    const cacheKey = `${key}:${selection.idx}`;
    if (ctx) {
      const existing = CTFD_AUDIO_CACHE[cacheKey];
      if (!existing || existing.source !== dataUrl) {
        const buf = ctfdDataUrlToBuffer(dataUrl);
        if (!buf) return { played: false, duration: 0 };
        const decoded = await ctfdDecodeAudioBuffer(ctx, buf);
        if (!decoded) return { played: false, duration: 0 };
        CTFD_AUDIO_CACHE[cacheKey] = { source: dataUrl, buffer: decoded };
      }
      const payload = CTFD_AUDIO_CACHE[cacheKey];
      if (!payload || !payload.buffer) return { played: false, duration: 0 };
      const totalSeconds = offset + Math.max(0, Number(payload.buffer.duration) || 0);
      return await new Promise((resolve) => {
        try {
          const source = ctx.createBufferSource();
          source.buffer = payload.buffer;
          source.connect(ctx.destination);
          let settled = false;
          const finish = (played) => {
            if (settled) return;
            settled = true;
            resolve({ played, duration: played ? totalSeconds : 0 });
          };
          source.onended = () => finish(true);

          CTFD_ACTIVE_AUDIO_PLAYBACK = {
            stop: () => {
              if (settled) return;
              try { source.onended = null; } catch {}
              try { source.stop(); } catch {}
              finish(false);
            }
          };

          source.start(ctx.currentTime + 0.01 + offset);
        } catch {
          resolve({ played: false, duration: 0 });
        }
      });
    }
    const audioEl = new Audio(dataUrl);
    return await new Promise((resolve) => {
      let settled = false;
      const cleanup = () => {
        audioEl.removeEventListener('ended', onEnded);
        audioEl.removeEventListener('error', onError);
        audioEl.removeEventListener('abort', onError);
      };
      const finish = (result) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(result);
      };
      const onEnded = () => {
        const duration = offset + (Number.isFinite(audioEl.duration) && audioEl.duration > 0 ? audioEl.duration : 0);
        finish({ played: true, duration });
      };
      const onError = () => {
        finish({ played: false, duration: offset });
      };
      audioEl.addEventListener('ended', onEnded);
      audioEl.addEventListener('error', onError);
      audioEl.addEventListener('abort', onError);
      const startPlayback = () => {
        try {
          const playPromise = audioEl.play();
          if (playPromise && typeof playPromise.then === 'function') {
            playPromise.catch(()=> onError());
          }
        } catch {
          onError();
        }
      };
      if (offset > 0) setTimeout(startPlayback, offset * 1000);
      else startPlayback();
    });
  } catch { return { played: false, duration: 0 }; }
}
function ctfdBuildFallbackPattern(key){
  const base = Array.isArray(CTFD_AUDIO_FALLBACKS[key]) ? CTFD_AUDIO_FALLBACKS[key] : [];
  const clone = base.map(note => ({ ...note }));
  clone.key = key;
  return clone;
}
function ctfdPlayFallbackPattern(pattern, delaySeconds){
  try { if (window.shell && shell.isRemote && shell.isRemote()) return Promise.resolve({ played: false, duration: 0 }); } catch {}
  try {
    if (!Array.isArray(pattern) || !pattern.length) return Promise.resolve({ played: false, duration: 0 });
    const key = pattern.key;
    if (key && !ctfdIsAudioEnabled(key)) return Promise.resolve({ played: false, duration: 0 });
  } catch { return Promise.resolve({ played: false, duration: 0 }); }
  try {
    const ctx = ctfdEnsureAudioContext();
    if (!ctx) return Promise.resolve({ played: false, duration: 0 });
    const offset = Math.max(0, Number(delaySeconds) || 0);
    let timeline = offset;
    let cursor = offset;
    const schedule = [];
    pattern.forEach(note => {
      if (!note) return;
      const freq = Number(note.freq) || 440;
      const dur = Math.max(0.05, Number(note.dur) || 0.12);
      const amplitude = note.gain != null ? Math.max(0.0001, Number(note.gain)) : 0.22;
      schedule.push({ freq, dur, amplitude, type: note.type || 'sine', start: cursor });
      cursor += dur;
      timeline = cursor;
      const gap = note.gap != null ? Math.max(0, Number(note.gap)) : 0.04;
      cursor += gap;
    });
    const totalDuration = Math.max(offset, timeline + 0.05);
    const baseStart = ctx.currentTime + 0.01;
    schedule.forEach(item => {
      try {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        const startTime = baseStart + item.start;
        const endTime = startTime + item.dur;
        osc.type = item.type;
        osc.frequency.setValueAtTime(item.freq, startTime);
        gain.gain.setValueAtTime(0.0001, startTime);
        gain.gain.exponentialRampToValueAtTime(item.amplitude, startTime + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, endTime);
        osc.connect(gain).connect(ctx.destination);
        osc.start(startTime);
        osc.stop(endTime + 0.05);
      } catch {}
    });
    return new Promise(resolve => {
      setTimeout(()=> resolve({ played: true, duration: totalDuration }), totalDuration * 1000);
    });
  } catch { return Promise.resolve({ played: false, duration: 0 }); }
}
async function ctfdPlayNamedSound(key, fallbackPattern, delaySeconds){
  // Mirror Preview behavior: only play a configured (selected) audio clip.
  // No fallback tones/patterns when a clip is not selected or fails to play.
  if (!ctfdIsAudioEnabled(key)) return { played: false, duration: 0 };
  const customResult = await ctfdTryPlayCustomAudio(key, delaySeconds);
  if (customResult && customResult.played) return customResult;
  return { played: false, duration: 0 };
}

function ctfdBuildSpeechPlanFromTemplate(template, context, fallbackText, opts){
  const options = opts && typeof opts === 'object' ? opts : {};
  const compiled = ctfdCompileSpeechTemplate(template, context);
  let segments = compiled.segments.slice();

  const skipAudio = !!options.skipAudioSegments;
  const hadAudioToken = compiled.hasAudio && segments.some(s => s && s.type === 'audio');
  if (skipAudio && hadAudioToken) {
    segments = segments.filter(s => !(s && s.type === 'audio'));
  }

  let hasSpeech = compiled.hasSpeech && segments.some(s => s && s.type === 'text' && String(s.text || '').trim());

  if (!hasSpeech) {
    const fallback = fallbackText != null ? String(fallbackText).trim() : '';
    // When audio is unavailable (skipAudioSegments) and the template was audio-only (or effectively
    // has no text), speak the fallback label instead of doing nothing.
    const wantsFallback = compiled.hasSpeechIntent || !compiled.templateTrimmed || (skipAudio && hadAudioToken);
    if (fallback && wantsFallback) {
      const insertAt = compiled.fallbackTargets.length ? compiled.fallbackTargets[0] : segments.length;
      const clamped = Math.max(0, Math.min(insertAt, segments.length));
      const prev = clamped > 0 ? segments[clamped - 1] : null;
      const next = clamped < segments.length ? segments[clamped] : null;
      if (prev && prev.type === 'text') {
        prev.text += fallback;
      } else if (next && next.type === 'text') {
        next.text = fallback + next.text;
      } else {
        segments.splice(clamped, 0, { type: 'text', text: fallback });
      }
      hasSpeech = true;
    }
  }

  const hasAudio = !skipAudio && !!compiled.hasAudio;
  return { segments, hasSpeech, hasAudio };
}

async function ctfdSpeakFromTemplate(template, payload, delaySeconds, opts){
  const { context, fallbackText } = ctfdNormalizeSpeechPayload(payload);
  const plan = ctfdBuildSpeechPlanFromTemplate(template, context, fallbackText, opts);
  const segments = plan.segments || [];
  const audioHandler = opts && typeof opts.onAudioRequest === 'function' ? opts.onAudioRequest : null;
  const speechAllowed = plan.hasSpeech && ctfdSpeechSupported() && !!(opts && opts.forceSpeak);
  const baseDelay = Math.max(0, Number(delaySeconds) || 0);
  let elapsed = 0;
  let timeline = baseDelay;
  const baseSpeechStart = ctfdComputeSpeechDelay(baseDelay);
  let nextSpeechBaseline = baseSpeechStart;
  let spokeAny = false;
  for (const segment of segments) {
    if (segment.type === 'audio') {
      if (!audioHandler) continue;
      const wait = Math.max(0, timeline - elapsed);
      if (wait > 0) {
        await ctfdWaitSeconds(wait);
        elapsed += wait;
      }
      try {
        const result = await audioHandler(0);
        const duration = Number(result && result.duration);
        if (Number.isFinite(duration) && duration > 0) elapsed += duration;
      } catch {}
      timeline = elapsed + CTFD_AUDIO_SEGMENT_BUFFER;
      nextSpeechBaseline = Math.max(nextSpeechBaseline, timeline);
    } else if (segment.type === 'text') {
      if (!speechAllowed) continue;
      const start = Math.max(timeline, nextSpeechBaseline);
      const wait = Math.max(0, start - elapsed);
      if (wait > 0) {
        await ctfdWaitSeconds(wait);
        elapsed += wait;
      }
      const speechResult = await ctfdSpeakTextSegment(segment.text, opts);
      if (speechResult.spoke) spokeAny = true;
      const spokenDuration = Number(speechResult.elapsed);
      if (Number.isFinite(spokenDuration) && spokenDuration > 0) elapsed += spokenDuration;
      timeline = elapsed + CTFD_SPEECH_SEGMENT_BUFFER;
      nextSpeechBaseline = Math.max(nextSpeechBaseline, timeline);
    }
  }
  return { spoke: spokeAny, wantsAudio: plan.hasAudio };
}
function ctfdNormalizeSpeechPayload(payload){
  if (typeof payload === 'string') {
    return { context: {}, fallbackText: payload };
  }
  if (payload && typeof payload === 'object') {
    if (Object.prototype.hasOwnProperty.call(payload, 'context') || Object.prototype.hasOwnProperty.call(payload, 'fallbackText') || Object.prototype.hasOwnProperty.call(payload, 'fallback')) {
      const context = payload.context && typeof payload.context === 'object' ? payload.context : {};
      const fallbackText = payload.fallbackText != null ? payload.fallbackText : payload.fallback;
      return { context, fallbackText: fallbackText != null ? String(fallbackText) : '' };
    }
    return { context: payload, fallbackText: '' };
  }
  return { context: {}, fallbackText: '' };
}
function ctfdComputeSpeechDelay(base){
  const val = Number(base);
  return (Number.isFinite(val) && val > 0 ? val : 0) + CTFD_SPEECH_DEFAULT_DELAY;
}
function ctfdWaitSeconds(seconds){
  const delay = Math.max(0, Number(seconds) || 0);
  if (delay <= 0) return Promise.resolve();
  return new Promise(resolve => setTimeout(resolve, delay * 1000));
}
function ctfdSpeakTextSegment(text, opts){
  try { if (window.shell && shell.isRemote && shell.isRemote()) return Promise.resolve({ spoke: false, elapsed: 0 }); } catch {}
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  if (!normalized) return Promise.resolve({ spoke: false, elapsed: 0 });
  return new Promise((resolve) => {
    let utterance;
    try { utterance = new SpeechSynthesisUtterance(normalized); } catch { resolve({ spoke: false, elapsed: 0 }); return; }
    if (!utterance) { resolve({ spoke: false, elapsed: 0 }); return; }
    if (opts && typeof opts === 'object') {
      if (opts.pitch !== undefined) utterance.pitch = opts.pitch;
      if (opts.rate !== undefined) utterance.rate = opts.rate;
      if (opts.lang) utterance.lang = opts.lang;
      if (opts.voice) utterance.voice = opts.voice;
    }
    utterance.onend = (ev)=>{
      const elapsed = ev && typeof ev.elapsedTime === 'number' ? Math.max(0, ev.elapsedTime) : 0;
      resolve({ spoke: true, elapsed });
    };
    utterance.onerror = ()=> resolve({ spoke: false, elapsed: 0 });
    try {
      const synth = window.speechSynthesis;
      if (!synth) { resolve({ spoke: false, elapsed: 0 }); return; }
      if (opts && opts.interrupt) {
        try { synth.cancel(); } catch {}
      }
      synth.speak(utterance);
    } catch {
      resolve({ spoke: false, elapsed: 0 });
    }
  });
}

function ctfdResolveProjectMediaSound(soundKey){
  const key = String(soundKey || '').trim();
  if (!key) return null;
  const pid = ctfdCurrentPid();
  const audioStore = ctfdGetProjectAudioStore(pid);
  const mediaEntry = (audioStore && typeof audioStore[key] === 'object') ? audioStore[key] : null;
  return ctfdNormalizeMediaSound(mediaEntry);
}

async function ctfdPlayProjectMediaSoundKey(soundKey, delaySeconds){
  try { if (window.shell && shell.isRemote && shell.isRemote()) return { played: false, duration: 0 }; } catch {}
  const clip = ctfdResolveProjectMediaSound(soundKey);
  if (!clip || !clip.dataUrl) return { played: false, duration: 0 };
  const offset = Math.max(0, Number(delaySeconds) || 0);
  ctfdStopActiveAudioPlayback();
  return await new Promise((resolve) => {
    let settled = false;
    const audio = new Audio(clip.dataUrl);
    const cleanup = () => {
      try { audio.removeEventListener('ended', onEnded); } catch {}
      try { audio.removeEventListener('error', onError); } catch {}
      try { audio.removeEventListener('abort', onError); } catch {}
    };
    const finish = (played) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (CTFD_ACTIVE_AUDIO_PLAYBACK && CTFD_ACTIVE_AUDIO_PLAYBACK._audio === audio) CTFD_ACTIVE_AUDIO_PLAYBACK = null;
      const duration = offset + ((Number.isFinite(audio.duration) && audio.duration > 0) ? audio.duration : 0);
      resolve({ played, duration });
    };
    const onEnded = () => finish(true);
    const onError = () => finish(false);
    audio.addEventListener('ended', onEnded);
    audio.addEventListener('error', onError);
    audio.addEventListener('abort', onError);

    CTFD_ACTIVE_AUDIO_PLAYBACK = {
      _audio: audio,
      stop: () => {
        if (settled) return;
        try { audio.pause(); } catch {}
        try { audio.currentTime = 0; } catch {}
        finish(false);
      }
    };

    const startPlayback = () => {
      try {
        const p = audio.play();
        if (p && typeof p.catch === 'function') p.catch(()=> finish(false));
      } catch { finish(false); }
    };
    if (offset > 0) setTimeout(startPlayback, offset * 1000);
    else startPlayback();
  });
}

async function ctfdSpeakForEvent(key, payload, delaySeconds, opts){
  const { context, fallbackText } = ctfdNormalizeSpeechPayload(payload);
  const selection = ctfdSpeechTemplateSelectionFor(key);
  const template = selection && typeof selection.tpl === 'string' ? selection.tpl : ctfdSpeechTemplateFor(key);
  const templateSoundKey = selection && typeof selection.soundKey === 'string' ? selection.soundKey.trim() : '';

  // Mirror Preview behavior:
  // - When no clip is selected (no soundKey) OR audio is disabled, treat {{audio}} as a no-op.
  // - If the template ends up audio-only, speak the fallback label instead of staying silent.
  let hasSelectedClip = false;
  try {
    const entry = ctfdGetAudioEntry(key);
    const eventSoundKey = (entry && typeof entry.soundKey === 'string') ? entry.soundKey.trim() : '';
    const soundKey = templateSoundKey || eventSoundKey;
    if (templateSoundKey) {
      const mediaSound = ctfdResolveProjectMediaSound(templateSoundKey);
      hasSelectedClip = !!(mediaSound && mediaSound.dataUrl);
    } else {
      const sounds = ctfdListValidSounds(entry);
      hasSelectedClip = !!(soundKey && sounds && sounds.length);
    }
  } catch {}
  let audioEnabled = false;
  try { audioEnabled = ctfdIsAudioEnabled(key); } catch {}
  let skipAudioSegments = !audioEnabled || !hasSelectedClip;
  try { if (window.shell && shell.isRemote && shell.isRemote()) skipAudioSegments = true; } catch {}

  const forceSpeak = !!ctfdShouldSpeak(key);

  // If this template has a per-template audio selection, use it for {{audio}} segments.
  const baseOpts = (opts && typeof opts === 'object') ? opts : {};
  const baseOnAudio = typeof baseOpts.onAudioRequest === 'function' ? baseOpts.onAudioRequest : null;
  const onAudioRequest = templateSoundKey
    ? (startDelay) => ctfdPlayProjectMediaSoundKey(templateSoundKey, startDelay)
    : baseOnAudio;

  return await ctfdSpeakFromTemplate(template, { context, fallbackText }, delaySeconds, {
    ...baseOpts,
    forceSpeak,
    skipAudioSegments,
    ...(onAudioRequest ? { onAudioRequest } : {}),
  });
}
function ctfdCountdownReasonLabel(reason){
  if (!reason) return '';
  if (reason === 'scoreboard') return ' for scoreboard reveal';
  if (reason === 'challenges') return ' for challenge list reveal';
  if (reason === 'challenges_hidden') return ' while challenges are hidden';
  return ` (${reason})`;
}
function ctfdCountdownNotificationActive(){
  try {
    const audioEnabled = ctfdIsAudioEnabled('ctfdCountdown');
    const speechEnabled = ctfdSpeechSupported() && ctfdShouldSpeak('ctfdCountdown');
    return !!(audioEnabled || speechEnabled);
  } catch { return false; }
}
function ctfdCountdownStopNotificationActive(){
  try {
    const audioEnabled = ctfdIsAudioEnabled('ctfdCountdownStop');
    const speechEnabled = ctfdSpeechSupported() && ctfdShouldSpeak('ctfdCountdownStop');
    return !!(audioEnabled || speechEnabled);
  } catch { return false; }
}
async function ctfdPlayCountdownCueForChallenges(){
  if (!ctfdCountdownNotificationActive()) return;
  const reason = 'challenges';
  const context = {
    reason,
    reason_clause: ctfdCountdownReasonLabel(reason),
    countdown_seconds: CTFD_COUNTDOWN_DEFAULT_SECONDS
  };
  const fallback = `Countdown complete${context.reason_clause}.`;
  try {
    await ctfdSpeakForEvent('ctfdCountdown', { context, fallbackText: fallback }, 0, {
      onAudioRequest: (startDelay)=> ctfdPlayNamedSound('ctfdCountdown', CTFD_AUDIO_FALLBACKS.ctfdCountdownFinal || [], startDelay)
    });
  } catch {}
}
async function ctfdPlayCountdownStopForChallenges(){
  if (!ctfdCountdownStopNotificationActive()) return;
  const reason = 'challenges_hidden';
  const baseContext = ctfdSpeechContextProject(ctfdCurrentPid());
  const context = {
    ...baseContext,
    reason,
    reason_clause: ctfdCountdownReasonLabel(reason)
  };
  const reasonClause = context.reason_clause || '';
  const projectClause = context.project_clause || '';
  const extra = `${reasonClause}${projectClause}`;
  const fallback = `Countdown cancelled${extra}.`;
  try {
    await ctfdSpeakForEvent('ctfdCountdownStop', { context, fallbackText: fallback }, 0, {
      onAudioRequest: (startDelay)=> ctfdPlayNamedSound('ctfdCountdownStop', CTFD_AUDIO_FALLBACKS.ctfdCountdownStop || [], startDelay)
    });
  } catch {}
}
function ctfdSpeechContextProject(projectId){
  const project = ctfdProjectLabel(projectId);
  const leaderboard = ctfdLeaderboardSnapshot();
  const trimmed = leaderboard.map(name => ctfdSpeechTrimTeamName(name));
  return {
    project,
    project_clause: project ? ` in ${project}` : '',
    first_team: trimmed[0] || '',
    second_team: trimmed[1] || '',
    third_team: trimmed[2] || ''
  };
}
function ctfdSpeechContextPeriodic(projectId){
  const base = ctfdSpeechContextProject(projectId);
  let intervalMinutes = 0;
  try {
    const entry = ctfdGetAudioEntry('ctfdPeriodic');
    if (entry && Number.isFinite(Number(entry.intervalMinutes))) {
      intervalMinutes = Number(entry.intervalMinutes);
    }
  } catch {}
  if (Number.isFinite(intervalMinutes) && intervalMinutes > 0) {
    const rounded = Math.round(intervalMinutes);
    base.interval_minutes = String(rounded);
    base.interval_minutes_clause = ` ${rounded} minute${rounded === 1 ? '' : 's'}`;
  } else {
    base.interval_minutes = '';
    base.interval_minutes_clause = '';
  }
  return base;
}
function ctfdSpeechContextCategoryFirst(projectId, kind, info){
  const base = ctfdSpeechContextProject(projectId);
  const categoryRaw = info && info.category ? String(info.category).trim() : '';
  const category = ctfdNormalizeCategoryName(categoryRaw);
  base.category = category;
  base.category_clause = category ? ` in ${category}` : '';
  const challengeRaw = info && info.challenge ? String(info.challenge).trim() : '';
  const challenge = challengeRaw;
  base.challenge = challenge;
  base.challenge_clause = challenge ? ` on ${challenge}` : '';
  const teamNameRaw = info && info.team ? String(info.team).trim() : '';
  const teamName = ctfdSpeechTrimTeamName(teamNameRaw);
  if (kind === 'user') {
    const leader = info && info.user ? String(info.user).trim() : '';
    base.leader = leader;
    base.user_first = leader;
    base.team_first = teamName;
    base.team_clause = teamNameRaw ? ` from team ${teamName}` : '';
  } else {
    base.leader = teamName;
    base.team_first = teamName;
    base.team_clause = '';
  }
  return base;
}
function ctfdAnnouncePeriodic(projectId){
  const pid = projectId || ctfdCurrentPid() || '';
  if (!pid) return;
  const entry = ctfdGetAudioEntry('ctfdPeriodic');
  const enabled = entry && entry.enabled !== undefined ? !!entry.enabled : ctfdDefaultAudioEnabled('ctfdPeriodic');
  if (!enabled) return;
  const context = ctfdSpeechContextPeriodic(pid);
  const intervalVal = Number(context.interval_minutes);
  const projectClause = context.project_clause || '';
  const intervalLabel = Number.isFinite(intervalVal) && intervalVal > 0 ? `${intervalVal} minute${intervalVal === 1 ? '' : 's'}` : 'the configured interval';
  const fallback = `Periodic update${projectClause}. Next check in ${intervalLabel}.`;
  void ctfdSpeakForEvent('ctfdPeriodic', { context, fallbackText: fallback }, 0, {
    onAudioRequest: (startDelay)=> ctfdPlayNamedSound('ctfdPeriodic', CTFD_AUDIO_FALLBACKS.ctfdPeriodic || [], startDelay)
  });
  try {
    const label = ctfdProjectLabel(pid);
    const suffix = label ? ` — ${label}` : '';
    shell.logInfo(`[CTFd] Periodic update${suffix}.`);
  } catch {}
}
function ctfdAnnounceFirstCategorySolve(projectId, kind, info){
  if (!info) return;
  const pid = projectId || ctfdCurrentPid() || '';
  if (!pid) return;
  const context = ctfdSpeechContextCategoryFirst(pid, kind, info);
  const category = context.category || '';
  const categoryLabel = category || 'this';
  const challengeSegment = context.challenge ? ` by solving ${context.challenge}` : '';
  const projectClause = context.project_clause || '';
  let fallback;
  if (kind === 'user') {
    const actor = context.leader || 'A competitor';
    const teamClause = context.team_clause || '';
    fallback = `${actor} is first to solve a ${categoryLabel} challenge${projectClause}${challengeSegment}${teamClause}.`;
  } else {
    const team = context.team_first || 'A team';
    fallback = `${team} is first to solve a ${categoryLabel} challenge${projectClause}${challengeSegment}.`;
  }
  const audioKey = kind === 'user' ? 'ctfdFirstCategoryUser' : 'ctfdFirstCategoryTeam';
  void ctfdSpeakForEvent(audioKey, { context, fallbackText: fallback }, 0, {
    onAudioRequest: (startDelay)=> ctfdPlayNamedSound(audioKey, CTFD_AUDIO_FALLBACKS[audioKey] || [], startDelay)
  });
  try {
    const label = ctfdProjectLabel(pid);
    const suffix = label ? ` — ${label}` : '';
    if (kind === 'user') {
      const actor = context.leader || 'A competitor';
      shell.logSuccess(`[CTFd] ${actor} solved the first ${categoryLabel} challenge${suffix}.`);
    } else {
      const team = context.team_first || 'A team';
      shell.logSuccess(`[CTFd] ${team} solved the first ${categoryLabel} challenge${suffix}.`);
    }
  } catch {}
}
function ctfdLeaderboardSnapshot(){
  try {
    const meta = CTFD_USER_META && typeof CTFD_USER_META === 'object' ? CTFD_USER_META : {};
    const bestByTeam = new Map();
    Object.values(meta).forEach(info => {
      if (!info) return;
      const teamRaw = info.team_name !== undefined ? info.team_name : info.team;
      const team = typeof teamRaw === 'string' ? teamRaw.trim() : '';
      if (!team) return;
      const rankVal = info.team_rank !== undefined ? info.team_rank : info.rank;
      const rank = rankNumber(rankVal);
      if (!Number.isFinite(rank) || rank <= 0) return;
      const existing = bestByTeam.get(team);
      if (!existing || rank < existing.rank) {
        bestByTeam.set(team, { team, rank });
      }
    });
    const ordered = Array.from(bestByTeam.values()).sort((a, b)=>{
      if (a.rank !== b.rank) return a.rank - b.rank;
      return a.team.localeCompare(b.team);
    });
    return ordered.slice(0, 3).map(entry => entry.team || '');
  } catch { return ['', '', '']; }
}
function ctfdSpeechContextFirstPlace(projectId, kind, name){
  const base = ctfdSpeechContextProject(projectId);
  const ctx = { ...base };
  const meta = CTFD_USER_META && typeof CTFD_USER_META === 'object' ? CTFD_USER_META : {};
  const nameRaw = typeof name === 'string' ? name.trim() : '';
  if (kind === 'team') {
    const teamName = ctfdSpeechTrimTeamName(nameRaw);
    ctx.team_first = teamName;
    ctx.user_first = '';
    ctx.team_clause = '';
    ctx.leader = teamName;
  } else {
    ctx.user_first = nameRaw;
    ctx.leader = nameRaw;
    const info = nameRaw && meta ? meta[nameRaw] : null;
    const teamRaw = info && info.team_name ? String(info.team_name).trim() : '';
    const teamName = ctfdSpeechTrimTeamName(teamRaw);
    ctx.team_first = teamName;
    ctx.team_clause = teamRaw && teamRaw !== nameRaw ? ` from team ${teamName}` : '';
  }
  if (!ctx.first_team) ctx.first_team = ctx.team_first || ctx.leader || '';
  ctx.first_team = ctfdSpeechTrimTeamName(ctx.first_team);
  return ctx;
}
function ctfdStartCountdown(seconds, opts){
  ctfdStopCountdown(false);
  let audioEnabled = false;
  try { audioEnabled = ctfdIsAudioEnabled('ctfdCountdown'); } catch { audioEnabled = false; }
  const speechEnabled = ctfdSpeechSupported() && ctfdShouldSpeak('ctfdCountdown');
  if (!audioEnabled && !speechEnabled) return;
  let base = CTFD_COUNTDOWN_DEFAULT_SECONDS;
  if (opts && Object.prototype.hasOwnProperty.call(opts, 'seconds')) {
    const alt = Number(opts.seconds);
    if (Number.isFinite(alt) && alt > 0) base = alt;
  } else if (seconds !== undefined) {
    const alt = Number(seconds);
    if (Number.isFinite(alt) && alt > 0) base = alt;
  }
  const total = Math.max(1, Math.floor(base));
  CTFD_COUNTDOWN_REMAINING = total;
  CTFD_COUNTDOWN_TOTAL_SECONDS = total;
  CTFD_COUNTDOWN_USE_TICKS = audioEnabled && !ctfdHasCustomAudio('ctfdCountdown');
  CTFD_COUNTDOWN_REASON = opts && opts.reason ? String(opts.reason) : '';
  if (CTFD_COUNTDOWN_USE_TICKS) {
    try { ctfdPlayFallbackPattern(ctfdBuildFallbackPattern('ctfdCountdown'), 0); } catch {}
    CTFD_COUNTDOWN_REMAINING -= 1;
  }
  if (CTFD_COUNTDOWN_REMAINING <= 0) {
    ctfdStopCountdown(true);
    return;
  }
  try {
    if (CTFD_COUNTDOWN_TIMER) { clearInterval(CTFD_COUNTDOWN_TIMER); CTFD_COUNTDOWN_TIMER = null; }
    CTFD_COUNTDOWN_TIMER = setInterval(ctfdCountdownTick, 1000);
  } catch {}
  try { shell.logInfo(`[CTFd] Countdown started (${total}s)${ctfdCountdownReasonLabel(CTFD_COUNTDOWN_REASON)}.`); } catch {}
}
function ctfdCountdownTick(){
  if (CTFD_COUNTDOWN_REMAINING <= 0) {
    ctfdStopCountdown(true);
    return;
  }
  CTFD_COUNTDOWN_REMAINING -= 1;
  if (CTFD_COUNTDOWN_REMAINING <= 0) {
    ctfdStopCountdown(true);
    return;
  }
  if (CTFD_COUNTDOWN_USE_TICKS) {
    try { ctfdPlayFallbackPattern(ctfdBuildFallbackPattern('ctfdCountdown'), 0); } catch {}
  }
}
function ctfdStopCountdown(playFinal){
  const wasActive = !!CTFD_COUNTDOWN_TIMER || CTFD_COUNTDOWN_REMAINING > 0;
  const reason = CTFD_COUNTDOWN_REASON;
  if (CTFD_COUNTDOWN_TIMER) {
    try { clearInterval(CTFD_COUNTDOWN_TIMER); } catch {}
    CTFD_COUNTDOWN_TIMER = null;
  }
  CTFD_COUNTDOWN_REMAINING = 0;
  CTFD_COUNTDOWN_USE_TICKS = false;
  CTFD_COUNTDOWN_REASON = '';
  if (playFinal) {
    const speechCtx = {
      reason,
      reason_clause: ctfdCountdownReasonLabel(reason),
      countdown_seconds: CTFD_COUNTDOWN_TOTAL_SECONDS
    };
    const fallback = `Countdown complete${ctfdCountdownReasonLabel(reason)}.`;
    void ctfdSpeakForEvent('ctfdCountdown', { context: speechCtx, fallbackText: fallback }, 0, {
      onAudioRequest: (startDelay)=> ctfdPlayNamedSound('ctfdCountdown', CTFD_AUDIO_FALLBACKS.ctfdCountdownFinal || [], startDelay)
    });
    try { shell.logSuccess(`[CTFd] Countdown complete${ctfdCountdownReasonLabel(reason)}.`); } catch {}
  } else if (wasActive && reason) {
    try { shell.logInfo(`[CTFd] Countdown cancelled${ctfdCountdownReasonLabel(reason)}.`); } catch {}
  }
  CTFD_COUNTDOWN_TOTAL_SECONDS = 0;
}
function ctfdHandleChallengesStateChange(newState){
  const prev = CTFD_LAST_CHALLENGES_STATE;
  const next = !!newState;
  CTFD_LAST_CHALLENGES_STATE = next;
  const previous = (prev === null) ? false : !!prev;
  if (next !== previous) {
    try {
      const chToggle = document.getElementById('ctfd-toggle-chals');
      if (chToggle) {
        chToggle.indeterminate = false;
        chToggle.removeAttribute('data-ctfd-pending-reveal');
      }
    } catch {}
  }
  if (next && !previous) {
    if (CTFD_CHALLENGE_REVEAL_EXPECTED) {
      CTFD_CHALLENGE_REVEAL_EXPECTED = false;
    } else {
      void ctfdPlayCountdownCueForChallenges();
    }
    CTFD_CHALLENGE_HIDE_EXPECTED = false;
  }
  if (!next && previous) {
    if (CTFD_CHALLENGE_HIDE_EXPECTED) {
      CTFD_CHALLENGE_HIDE_EXPECTED = false;
    } else {
      void ctfdPlayCountdownStopForChallenges();
    }
    ctfdStopCountdown(false);
  }
  if (!next) {
    CTFD_CHALLENGE_REVEAL_EXPECTED = false;
    CTFD_CHALLENGE_HIDE_EXPECTED = false;
  }
}
// Sort behavior for rows with n/a values across any visible columns
// Sort Missing Fields toggle removed: always place rows missing the active sort field at the end

// --- Persist last rendered view so switching pages doesn't clear data ---
const CTFD_CACHE_KEY = 'toolhub.ctfd.mgr.cache.v1';
function ctfdCacheSnapshot(mode){
  try {
    const payload = {
      ts: Date.now(),
      mode: (mode === 'multi' ? 'multi' : 'single'),
      proj: (mode === 'single' ? (PROJ || null) : null),
      allProjects: Array.isArray(CTFD_ALL_PROJECTS) ? CTFD_ALL_PROJECTS : [],
      // Back-compat: still store selectedPids snapshot for immediate restore
      selectedPids: Array.isArray(CTFD_SELECTED_PIDS) ? CTFD_SELECTED_PIDS : null,
      // New: persist per-project associations and base project for multi mode
      basePid: (function(){ try { return ctfdCurrentPid(); } catch { return ''; } })(),
      assocMap: (function(){ try { return ctfdReadAssocMap(); } catch { return {}; } })(),
      userMeta: CTFD_USER_META || {}
    };
    sessionStorage.setItem(CTFD_CACHE_KEY, JSON.stringify(payload));
  } catch {}
}
function ctfdRestoreSnapshot(){
  try {
    const raw = sessionStorage.getItem(CTFD_CACHE_KEY);
    if (!raw) return false;
    const data = JSON.parse(raw);
    // Optional TTL to avoid very stale data. 15 minutes feels right for a session.
    const maxAgeMs = 15 * 60 * 1000;
    if (!data || !data.ts || (Date.now() - data.ts) > maxAgeMs) return false;
    CTFD_ALL_PROJECTS = Array.isArray(data.allProjects) ? data.allProjects : [];
    // Prefer assocMap+basePid when restoring multi selection; fall back to snapshot list
    const snapBase = String(data.basePid || '') || String(ctfdCurrentPid()||'');
    const snapAssoc = (data.assocMap && typeof data.assocMap === 'object') ? data.assocMap : {};
    const derived = (snapBase && Array.isArray(snapAssoc[snapBase]) && snapAssoc[snapBase].length)
      ? [snapBase, ...snapAssoc[snapBase].map(String)]
      : (Array.isArray(data.selectedPids) ? data.selectedPids : null);
    CTFD_SELECTED_PIDS = derived;
    CTFD_USER_META = data.userMeta || {};
    if (data.mode === 'single' && data.proj && data.proj.id) {
      ctfdSeedFirstPlaceHistory(data.proj.id, CTFD_USER_META);
    }
    if (data.mode === 'multi') {
      PROJ = null;
      try { ctfdProjectsBadgeUpdate(); } catch {}
      ctfdRenderTableMerged();
      return true;
    }
    if (data.mode === 'single' && data.proj) {
      PROJ = data.proj;
      try {
  const info = document.getElementById('ctfd-info');
  if (info && PROJ) info.textContent = '';
      } catch {}
      try { ctfdUpdateServerNavLinkForCurrent(); } catch {}
      renderCtfdTable(PROJ);
      return true;
    }
    return false;
  } catch { return false; }
}

// Column visibility (persisted per project)
// Add 'project' column (default hidden). When a multi-project view is added, this can default to shown.
const CTFD_COL_DEFAULTS = { project:false, cred:true, team:true, user_points:true, team_points:true, user_last:true, team_last:true };
let CTFD_COLS = { ...CTFD_COL_DEFAULTS };
function ctfdColsKey(pid){ return `toolhub.ctfd.cols.${pid||'none'}`; }
function readCtfdCols(pid){ try { const raw = sessionStorage.getItem(ctfdColsKey(pid)); return raw? { ...CTFD_COL_DEFAULTS, ...JSON.parse(raw) } : { ...CTFD_COL_DEFAULTS }; } catch { return { ...CTFD_COL_DEFAULTS }; } }
function writeCtfdCols(pid, obj){ try { sessionStorage.setItem(ctfdColsKey(pid), JSON.stringify(obj||{})); } catch {} }
function wireCtfdCols(){
  try {
    const ids = ['project','cred','team','user_points','team_points','user_last','team_last'];
    ids.forEach(id=>{
      const el = document.getElementById(`ctfd-col-${id}`);
      if (el && !el._toolhubBound) {
        el.addEventListener('change', ()=>{
          try {
            const multi = Array.isArray(CTFD_SELECTED_PIDS) && CTFD_SELECTED_PIDS.length > 1;
            const keyPid = multi ? 'multi' : (PROJ ? PROJ.id : 'multi');
            CTFD_COLS[id] = !!el.checked;
            writeCtfdCols(keyPid, CTFD_COLS);
            renderCtfdTable(PROJ);
          } catch {}
        });
        el._toolhubBound = true;
      }
    });
  } catch {}
}

// --- Projects selector (multi-project associations are per base project) ---
// Legacy global selection key (for migration only)
const CTFD_STORE_SELECTED = 'toolhub.ctfd.mgr.selectedPids.v1';
function ctfdReadSelected(){ try { const raw = sessionStorage.getItem(CTFD_STORE_SELECTED); const arr = raw? JSON.parse(raw): null; return Array.isArray(arr)? arr: null; } catch { return null; } }
function ctfdWriteSelected(arr){ try { sessionStorage.setItem(CTFD_STORE_SELECTED, JSON.stringify(arr||[])); } catch {} }
// New storage: a map of basePid -> [associatedPid, ...]
const CTFD_STORE_ASSOC_MAP = 'toolhub.ctfd.mgr.assocMap.v1';
function ctfdReadAssocMap(){ try { const raw = sessionStorage.getItem(CTFD_STORE_ASSOC_MAP); const obj = raw? JSON.parse(raw): {}; return (obj && typeof obj==='object')? obj: {}; } catch { return {}; } }
function ctfdWriteAssocMap(obj){ try { sessionStorage.setItem(CTFD_STORE_ASSOC_MAP, JSON.stringify(obj||{})); } catch {} }
function ctfdReadAssoc(basePid){ try { const map = ctfdReadAssocMap(); const arr = map && Array.isArray(map[String(basePid)]) ? map[String(basePid)] : []; return arr.map(String); } catch { return []; } }
function ctfdWriteAssoc(basePid, list){ try { const map = ctfdReadAssocMap(); const pid = String(basePid||''); if (!pid) return; const arr = Array.isArray(list)? list.map(String): []; const clean = arr.filter(x => x && x !== pid);
  map[pid] = clean; ctfdWriteAssocMap(map); } catch {} }
function ctfdMigrateSelectedToAssoc(basePid){ try {
  const pid = String(basePid||''); if (!pid) return;
  const legacy = ctfdReadSelected(); if (!Array.isArray(legacy)) return;
  const assoc = legacy.map(String).filter(x => x && x !== pid);
  const curMap = ctfdReadAssocMap();
  if (!Array.isArray(curMap[pid]) || (curMap[pid]||[]).length===0) {
    curMap[pid] = assoc;
    ctfdWriteAssocMap(curMap);
  }
  try { sessionStorage.removeItem(CTFD_STORE_SELECTED); } catch {}
} catch {} }
function ctfdCurrentPid(){ try { return (window.shell && shell.getCurrentProjectId) ? shell.getCurrentProjectId() : (PROJ?.id||''); } catch { return PROJ?.id||''; } }

function _ctfdBuildServerHref(proj){
  try {
    const baseRaw = (proj && proj.challenge_url != null) ? String(proj.challenge_url).trim()
      : ((proj && proj.ctfd_url != null) ? String(proj.ctfd_url).trim() : '');
    if (!baseRaw) return '';
    const portRaw = (proj && proj.challenge_port != null) ? String(proj.challenge_port).trim()
      : ((proj && proj.ctfd_port != null) ? String(proj.ctfd_port).trim() : '');
    const u = new URL(normalizeUrl(baseRaw));
    if (portRaw && !u.port) u.port = portRaw;
    return u.toString().replace(/\/$/, '');
  } catch {
    return '';
  }
}

function ctfdUpdateServerNavLinkForCurrent(){
  const link = document.getElementById('nav-ctfd-link');
  if (!link) return;
  let proj = PROJ;
  try {
    const cur = String(ctfdCurrentPid() || '').trim();
    if (cur && (!proj || String(proj.id) !== cur)) {
      proj = (CTFD_ALL_PROJECTS || []).find(p => String(p.id) === cur) || null;
    }
  } catch {}
  const href = _ctfdBuildServerHref(proj);
  if (href) {
    try { link.classList.remove('d-none'); } catch {}
    link.href = href;
    try {
      const u = new URL(href);
      const hostPort = u.host || href;
      link.textContent = `Server: ${hostPort}`;
      link.title = href;
    } catch {
      link.textContent = `Server: ${href}`;
      link.title = href;
    }
    link.classList.remove('disabled');
    try {
      link.classList.remove('border-secondary', 'text-muted');
      link.classList.add('border-primary', 'text-primary');
    } catch {}
    link.removeAttribute('aria-disabled');
    link.removeAttribute('tabindex');
  } else {
    link.href = '#';
    link.textContent = 'Server: —';
    try { link.classList.add('d-none'); } catch {}
    link.classList.add('disabled');
    try {
      link.classList.remove('border-primary', 'text-primary');
      link.classList.add('border-secondary', 'text-muted');
    } catch {}
    link.setAttribute('aria-disabled', 'true');
    link.setAttribute('tabindex', '-1');
  }
}

function ctfdSelectionMatches(expectedPid){
  const target = String(expectedPid || '').trim();
  if (!target) return true;
  const current = String(ctfdCurrentPid() || '').trim();
  if (!current) return true;
  return current === target;
}

function ctfdSelectionChanged(expectedPid){
  return !ctfdSelectionMatches(expectedPid);
}
function ctfdProjectsBadgeUpdate(){ try { const c = document.getElementById('projects-count'); if (!c) return; const arr = CTFD_SELECTED_PIDS; const n = Array.isArray(arr)? arr.length : 1; c.textContent = String(n); c.className = 'badge '+(n>1?'bg-primary':'bg-secondary'); } catch {} }
async function ctfdEnsureProjects(){ if (CTFD_ALL_PROJECTS && CTFD_ALL_PROJECTS.length) return; try { const resp = await http('GET','/api/projects'); CTFD_ALL_PROJECTS = Array.isArray(resp?.projects)? resp.projects: []; } catch { CTFD_ALL_PROJECTS = []; } }
function ctfdRenderProjectsList(filter){
  const host = document.getElementById('projects-list'); if (!host) return;
  const f = String(filter||'').toLowerCase();
  const items = (CTFD_ALL_PROJECTS||[]).filter(p => !f || (String(p.name||'').toLowerCase().includes(f) || String(p.tag||'').toLowerCase().includes(f)));
  const cur = String(ctfdCurrentPid()||'');
  // Selection = current base project + its stored associated projects
  const assoc = cur ? ctfdReadAssoc(cur) : [];
  const sel = new Set([...(assoc||[]), ...(cur?[cur]:[]) ]);
  host.innerHTML = items.map(p => { 
    const isCur = cur && String(p.id)===cur;
    const on = sel.has(String(p.id)) ? 'checked' : '';
    const dis = isCur ? 'disabled' : '';
    const tip = isCur ? 'title="Current project (always selected)"' : '';
    return `<label class="list-group-item d-flex align-items-center gap-2">`
         + `<input type="checkbox" class="form-check-input" data-pid="${p.id}" ${on} ${dis} ${tip} />`
         + `<div class="flex-grow-1">`
         + `<div><strong>${escHtml(p.name)}</strong></div>`
         + `<div class="small text-muted">${escHtml(p.tag||'')}</div>`
         + `</div>`
         + `<span class="badge bg-secondary" title="Instances">${Number(p.instances||0)}</span>`
         + `</label>`;
  }).join('');
}
async function ctfdSetupProjectsUi(){
  await ctfdEnsureProjects();
  // Read per-project associations; migrate any legacy global selection
  try {
    const cur = String(ctfdCurrentPid()||'');
    if (cur) ctfdMigrateSelectedToAssoc(cur);
    let assoc = cur ? ctfdReadAssoc(cur) : [];
    // Prefer backend-provided associations when available
    try {
      const proj = (CTFD_ALL_PROJECTS||[]).find(p => String(p.id)===cur);
      const backend = Array.isArray(proj?.associated_projects) ? proj.associated_projects.map(String) : [];
      if (backend && backend.length) {
        // Sync to session cache
        ctfdWriteAssoc(cur, backend);
        assoc = backend.slice();
      }
    } catch {}
    CTFD_SELECTED_PIDS = (cur && assoc.length) ? [cur, ...assoc] : null;
  } catch {}
  ctfdProjectsBadgeUpdate();
  const filter = document.getElementById('projects-filter');
  const clearBtn = document.getElementById('projects-filter-clear');
  const selCur = document.getElementById('projects-select-current');
  const selAll = document.getElementById('projects-select-all');
  const clr = document.getElementById('projects-clear');
  const apply = document.getElementById('projects-apply');
  ctfdRenderProjectsList('');
  if (filter) filter.addEventListener('input', ()=> ctfdRenderProjectsList(filter.value||''));
  if (clearBtn) clearBtn.addEventListener('click', ()=>{ if (filter) filter.value=''; ctfdRenderProjectsList(''); });
  if (selCur) selCur.addEventListener('click', ()=>{ const pid = ctfdCurrentPid(); CTFD_SELECTED_PIDS = pid? [pid]: []; ctfdRenderProjectsList(filter?filter.value:''); });
  if (selAll) selAll.addEventListener('click', ()=>{ const cur = ctfdCurrentPid(); const list = (CTFD_ALL_PROJECTS||[]).map(p=> String(p.id)); if (cur && !list.includes(cur)) list.push(cur); CTFD_SELECTED_PIDS = list; ctfdRenderProjectsList(filter?filter.value:''); });
  if (clr) clr.addEventListener('click', ()=>{ const cur = ctfdCurrentPid(); CTFD_SELECTED_PIDS = cur? [cur] : []; ctfdRenderProjectsList(filter?filter.value:''); });
  if (apply) apply.addEventListener('click', ()=>{
    try {
      const host = document.getElementById('projects-list');
      const boxes = host ? Array.from(host.querySelectorAll('input[type="checkbox"][data-pid]')) : [];
      const cur = ctfdCurrentPid();
      let ids = boxes.filter(b=>b.checked).map(b=> String(b.getAttribute('data-pid')));
      if (cur && !ids.includes(cur)) ids.push(cur);
      // Persist per-base associations (exclude current from stored list)
      const assoc = (ids||[]).filter(x => x !== cur);
      if (cur) ctfdWriteAssoc(cur, assoc);
      // Persist to backend (best-effort)
      try { if (cur) { http('PATCH', `/api/projects/${encodeURIComponent(cur)}`, { associated_projects: assoc }).catch(()=>{}); } } catch {}
      // If only current is selected, treat as single-project mode (null)
      CTFD_SELECTED_PIDS = (cur && assoc.length>0) ? [cur, ...assoc] : null;
      ctfdProjectsBadgeUpdate();
      // Auto-enable Project column only when multiple are selected
      try {
        const multi = Array.isArray(CTFD_SELECTED_PIDS) && CTFD_SELECTED_PIDS.length > 1;
        const cols = readCtfdCols(PROJ?PROJ.id:'multi');
        cols.project = !!(multi || cols.project);
        // Reflect checkbox if present
        const chk = document.getElementById('ctfd-col-project'); if (chk) chk.checked = !!cols.project;
        // Persist under current project scope (or a shared key). Using current PROJ if available.
        writeCtfdCols(PROJ?PROJ.id:'multi', cols);
        CTFD_COLS = cols;
        renderCtfdTable(PROJ);
      } catch {}
      try { const el = document.getElementById('projectsModal'); if (el && window.bootstrap) { const m = bootstrap.Modal.getInstance(el) || bootstrap.Modal.getOrCreateInstance(el); m.hide(); } } catch {}
    } catch {}
  });
  const host = document.getElementById('projects-list');
  if (host) host.addEventListener('change', (e)=>{
    const cb = e.target && e.target.matches && e.target.matches('input[type="checkbox"][data-pid]') ? e.target : null;
    if (!cb) return;
    const pid = String(cb.getAttribute('data-pid'));
    // Ignore disabled (current project) — it cannot be unselected
    if (cb.disabled) return;
    const set = new Set(CTFD_SELECTED_PIDS || []);
    if (cb.checked) set.add(pid); else set.delete(pid);
    // Always include current project in the set
    const cur = ctfdCurrentPid(); if (cur) set.add(String(cur));
    CTFD_SELECTED_PIDS = Array.from(set);
  });
}

// --- Progress helpers (like VM Manager) ---
function ctfdSetProgress(text, percent=100, active=true){
  try {
    const wrap = document.getElementById('ctfd-progress');
    const bar = document.getElementById('ctfd-progress-bar');
    if (!wrap || !bar) return;
    wrap.classList.remove('d-none');
    wrap.removeAttribute('aria-hidden');
    bar.style.width = `${Math.max(0, Math.min(100, percent))}%`;
    bar.setAttribute('aria-valuenow', String(Math.max(0, Math.min(100, percent))));
  const label = text || (CTFD_AUTO_REFRESH_ACTIVE ? 'Auto-refresh in progress…' : 'Working…');
  bar.textContent = label;
    if (active) bar.classList.add('progress-bar-striped','progress-bar-animated');
    else bar.classList.remove('progress-bar-striped','progress-bar-animated');
  } catch {}
}
function ctfdHideProgress(){
  try {
    const wrap = document.getElementById('ctfd-progress');
    const bar = document.getElementById('ctfd-progress-bar');
    if (!wrap || !bar) return;
    wrap.classList.add('d-none');
    wrap.setAttribute('aria-hidden','true');
    bar.style.width = '100%';
    bar.textContent = 'Ready';
    bar.classList.remove('progress-bar-striped','progress-bar-animated');
  } catch {}
}

function sortIconCtfd(key){ if(CTFD_SORT.key!==key) return ''; const cls = CTFD_SORT.dir==='asc'?'bi-caret-up-fill':'bi-caret-down-fill'; return ' <i class="bi '+cls+'"></i>'; }
function ariaSortCtfd(key){ if(CTFD_SORT.key!==key) return 'none'; return CTFD_SORT.dir==='asc'?'ascending':'descending'; }

function applyCtfdFilter(list){
  if(!CTFD_FILTER_TEXT) return list;
  try {
    const norm = (v) => String(v==null? '': v).toLowerCase();
    if(CTFD_FILTER_IS_REGEX){
      const re = new RegExp(CTFD_FILTER_TEXT, 'i');
      return list.filter(r => Object.values(r||{}).some(v => re.test(String(v==null?'':v))));
    }
    const t = CTFD_FILTER_TEXT.toLowerCase();
    return list.filter(r => Object.values(r||{}).some(v => norm(v).includes(t)));
  } catch(e){
    const err = document.getElementById('ctfd-filter-error'); if(err) err.classList.remove('d-none');
    return list;
  }
}

function sanitizeSimple(s){ return (s||'').replace(/[<>]/g,''); }
function escHtml(s){ return (s||'').replace(/[&<>"]/g,c=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c])); }

// Format an ISO-like timestamp into "<x> hours <y> minutes ago" (or minutes-only when < 1 hour)
function formatRelativeTime(ts) {
  try {
    if (!ts) return '';
    const d = new Date(ts);
    if (isNaN(d.getTime())) return String(ts);
    const now = Date.now();
    let secs = Math.max(0, Math.floor((now - d.getTime()) / 1000));
    const mins = Math.floor(secs / 60);
    const hours = Math.floor(mins / 60);
    const remMins = mins % 60;
    if (hours > 0) {
      const hLabel = hours === 1 ? 'hour' : 'hours';
      const mLabel = remMins === 1 ? 'minute' : 'minutes';
      return `${hours} ${hLabel} ${remMins} ${mLabel} ago`;
    }
    if (mins > 0) {
      const mLabel = mins === 1 ? 'minute' : 'minutes';
      return `${mins} ${mLabel} ago`;
    }
    return 'just now';
  } catch { return String(ts||''); }
}

// Return age in seconds since timestamp; Infinity if invalid/missing
function ageSeconds(ts) {
  try {
    if (!ts) return Number.POSITIVE_INFINITY;
    const d = new Date(ts);
    const ms = Date.now() - d.getTime();
    if (!isFinite(ms) || isNaN(ms) || ms < 0) return Number.POSITIVE_INFINITY;
    return Math.floor(ms / 1000);
  } catch { return Number.POSITIVE_INFINITY; }
}

function rankNumber(val) {
  try {
    if (val === null || val === undefined || val === '') return Number.POSITIVE_INFINITY;
    const n = Number(String(val).toString().replace(/[^0-9.-]/g, ''));
    if (!isFinite(n) || isNaN(n) || n <= 0) return Number.POSITIVE_INFINITY;
    return n;
  } catch { return Number.POSITIVE_INFINITY; }
}

function ctfdProjectLabel(pid){
  try {
    const id = String(pid||'').trim();
    if (!id) return '';
    if (PROJ && String(PROJ.id) === id) return PROJ.name || id;
    const match = (CTFD_ALL_PROJECTS||[]).find(p => String(p.id) === id);
    return (match && match.name) ? match.name : id;
  } catch { return String(pid||''); }
}

function ctfdEnsureAudioContext(){
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    if (!CTFD_AUDIO_CONTEXT) {
      CTFD_AUDIO_CONTEXT = new Ctx();
    }
    if (CTFD_AUDIO_CONTEXT.state === 'suspended') {
      CTFD_AUDIO_CONTEXT.resume().catch(()=>{});
    }
    return CTFD_AUDIO_CONTEXT;
  } catch { return null; }
}

async function ctfdPlayFirstPlaceSound(kind, delaySeconds){
  const key = kind === 'team' ? 'ctfdFirstTeam' : 'ctfdFirstUser';
  const fallback = CTFD_AUDIO_FALLBACKS[key] || [];
  return await ctfdPlayNamedSound(key, fallback, delaySeconds);
}
function ctfdCompareScoreCandidates(a, b){
  const timeA = Number.isFinite(a?.solvedAt) ? a.solvedAt : Number.POSITIVE_INFINITY;
  const timeB = Number.isFinite(b?.solvedAt) ? b.solvedAt : Number.POSITIVE_INFINITY;
  if (timeA !== timeB) return timeA < timeB ? -1 : 1;
  const ptsA = Number.isFinite(a?.points) ? a.points : 0;
  const ptsB = Number.isFinite(b?.points) ? b.points : 0;
  if (ptsA !== ptsB) return ptsA > ptsB ? -1 : 1;
  const labelA = (a?.username || a?.team || '').toLowerCase();
  const labelB = (b?.username || b?.team || '').toLowerCase();
  if (labelA < labelB) return -1;
  if (labelA > labelB) return 1;
  return 0;
}
function ctfdSummarizeScore(meta){
  const summary = { hasScore: false, firstUser: null, firstTeam: null, firstPoints: null, firstChallenge: null, firstSolveTime: null };
  let bestUser = null;
  let bestTeam = null;
  try {
    Object.entries(meta || {}).forEach(([username, info]) => {
      if (!info) return;
      const userPointsRaw = Number(info?.user_points);
      const teamPointsRaw = Number(info?.team_points);
      const hasUserPoints = Number.isFinite(userPointsRaw) && userPointsRaw > 0;
      const hasTeamPoints = Number.isFinite(teamPointsRaw) && teamPointsRaw > 0;
      if (!hasUserPoints && !hasTeamPoints) return;
      summary.hasScore = true;
      const userSolve = info?.user_last_solve_time ? Date.parse(info.user_last_solve_time) : NaN;
      const teamSolve = info?.team_last_solve_time ? Date.parse(info.team_last_solve_time) : NaN;
      if (hasUserPoints) {
        const candidate = {
          username,
          team: String(info?.team_name || '').trim() || null,
          points: userPointsRaw,
          challenge: info?.user_last_solve_challenge ? String(info.user_last_solve_challenge) : null,
          solvedAt: Number.isFinite(userSolve) ? userSolve : (Number.isFinite(teamSolve) ? teamSolve : null)
        };
        if (!bestUser || ctfdCompareScoreCandidates(candidate, bestUser) < 0) bestUser = candidate;
      }
      if (!hasUserPoints && hasTeamPoints) {
        const candidate = {
          username: null,
          team: String(info?.team_name || '').trim() || null,
          points: teamPointsRaw,
          challenge: info?.team_last_solve_challenge ? String(info.team_last_solve_challenge) : null,
          solvedAt: Number.isFinite(teamSolve) ? teamSolve : null
        };
        if (!bestTeam || ctfdCompareScoreCandidates(candidate, bestTeam) < 0) bestTeam = candidate;
      }
    });
  } catch {}
  const pick = bestUser || bestTeam;
  if (pick) {
    summary.firstUser = pick.username;
    summary.firstTeam = pick.team;
    summary.firstPoints = pick.points;
    summary.firstChallenge = pick.challenge;
    summary.firstSolveTime = pick.solvedAt;
  }
  return summary;
}
function ctfdSpeechContextFirstScore(projectId, summary){
  const base = ctfdSpeechContextProject(projectId);
  const ctx = { ...base };
  const data = summary || {};
  const teamNameRaw = data.firstTeam ? String(data.firstTeam).trim() : '';
  const teamName = ctfdSpeechTrimTeamName(teamNameRaw);
  const userName = data.firstUser || '';
  const leader = userName || teamName;
  ctx.leader = leader;
  ctx.user_first = userName;
  ctx.team_first = teamName;
  if (userName && teamNameRaw && userName !== teamNameRaw) {
    ctx.team_clause = ` from team ${teamName}`;
  } else if (!userName && teamNameRaw) {
    ctx.team_clause = ` for team ${teamName}`;
  } else {
    ctx.team_clause = '';
  }
  const challenge = data.firstChallenge || '';
  ctx.challenge = challenge;
  ctx.challenge_clause = challenge ? ` on ${challenge}` : '';
  const rawPoints = Number(data.firstPoints);
  let points = Number.isFinite(rawPoints) ? rawPoints : NaN;
  if (!Number.isFinite(points)) {
    const alt = Number(data.points);
    points = Number.isFinite(alt) ? alt : 0;
  }
  ctx.points = points;
  if (points > 0) {
    const unit = points === 1 ? 'point' : 'points';
    ctx.points_clause = ` worth ${points} ${unit}`;
  } else {
    ctx.points_clause = '';
  }
  ctx.project = base.project;
  ctx.project_clause = base.project_clause;
  if (!ctx.first_team) ctx.first_team = teamName || leader || '';
  ctx.first_team = ctfdSpeechTrimTeamName(ctx.first_team);
  return ctx;
}
function ctfdSeedFirstScoreState(projectId, meta){
  try {
    const pid = String(projectId || '').trim();
    if (!pid || pid === 'multi') return;
    const snapshot = ctfdSummarizeScore(meta);
    CTFD_SCORE_STATE[pid] = {
      seeded: true,
      hasScore: !!snapshot.hasScore,
      lastUser: snapshot.firstUser || '',
      lastTeam: snapshot.firstTeam || '',
      lastPoints: Number(snapshot.firstPoints) || 0
    };
  } catch {}
}
function ctfdAnnounceFirstScore(projectId, summary){
  if (!summary || !summary.hasScore) return;
  const projectLabel = ctfdProjectLabel(projectId);
  const scope = projectLabel ? ` — ${projectLabel}` : '';
  const leader = summary.firstUser || summary.firstTeam || 'Unknown competitor';
  const teamSegment = summary.firstTeam && summary.firstUser && summary.firstTeam !== summary.firstUser
    ? ` [Team: ${summary.firstTeam}]`
    : (summary.firstTeam && !summary.firstUser ? ` [Team: ${summary.firstTeam}]` : '');
  const challengeSegment = summary.firstChallenge ? ` — ${summary.firstChallenge}` : '';
  const pts = Number(summary.firstPoints);
  const pointsSegment = Number.isFinite(pts) && pts > 0 ? ` (+${pts} pts)` : '';
  try { shell.logSuccess(`[CTFd] First score${scope}: ${leader}${teamSegment}${challengeSegment}${pointsSegment}`); } catch {}
  const speechScope = projectLabel ? ` in ${projectLabel}` : '';
  const speechTeamName = ctfdSpeechTrimTeamName(summary.firstTeam || '');
  const leaderSpeech = summary.firstUser || speechTeamName || 'Unknown competitor';
  let teamSpeech = '';
  if (summary.firstUser && summary.firstTeam && summary.firstTeam !== summary.firstUser) {
    teamSpeech = speechTeamName ? ` from team ${speechTeamName}` : '';
  }
  const challengeSpeech = summary.firstChallenge ? ` on ${summary.firstChallenge}` : '';
  let pointsSpeech = '';
  if (Number.isFinite(pts) && pts > 0) {
    const unit = pts === 1 ? 'point' : 'points';
    pointsSpeech = ` worth ${pts} ${unit}`;
  }
  const speechCtx = ctfdSpeechContextFirstScore(projectId, summary);
  const fallbackSpeech = `First score${speechScope} goes to ${leaderSpeech}${teamSpeech}${challengeSpeech}${pointsSpeech}.`;
  void ctfdSpeakForEvent('ctfdFirstScore', { context: speechCtx, fallbackText: fallbackSpeech }, 0, {
    onAudioRequest: (startDelay)=> ctfdPlayNamedSound('ctfdFirstScore', CTFD_AUDIO_FALLBACKS.ctfdFirstScore || [], startDelay)
  });
}
function ctfdHandleCategoryFirsts(projectId, payload){
  try {
    const pid = String(projectId || '').trim();
    if (!pid || pid === 'multi') return;
    const data = payload && typeof payload === 'object' ? payload : {};
    const state = ctfdCategoryState(pid);
    const errors = Array.isArray(data.errors) ? data.errors.filter(Boolean) : [];
    if (errors.length) {
      errors.slice(0, 3).forEach(msg => {
        try { shell.logWarn(`[CTFd] Category firsts warning: ${msg}`); } catch {}
      });
    }
    const newEvents = [];
    const process = (list, kind)=>{
      if (!Array.isArray(list)) return;
      list.forEach(item => {
        const normalized = ctfdNormalizeCategorySolve(kind, item);
        if (!normalized) return;
        const store = kind === 'user' ? state.user : state.team;
        const seedFlag = kind === 'user' ? 'seededUser' : 'seededTeam';
        const existing = store[normalized.key];
        const stamp = normalized.timestampEpoch;
        const changed = !existing || existing.timestampEpoch !== stamp || (kind === 'user' && existing.user !== normalized.user) || (kind === 'team' && existing.team !== normalized.team);
        const next = { ...normalized, announced: existing ? !!existing.announced : false };
        if (changed) next.announced = false;
        store[normalized.key] = next;
        const seeded = state[seedFlag];
        if (!seeded) return;
        if (!next.announced && changed) {
          newEvents.push({ kind, info: { ...next } });
        }
      });
      state[kind === 'user' ? 'seededUser' : 'seededTeam'] = true;
    };
    process(data.user, 'user');
    process(data.team, 'team');
    if (!newEvents.length) return;
    newEvents.sort((a, b)=>{
      const aEpoch = Number(a.info.timestampEpoch || 0);
      const bEpoch = Number(b.info.timestampEpoch || 0);
      if (Number.isFinite(aEpoch) && Number.isFinite(bEpoch) && aEpoch !== bEpoch) return aEpoch - bEpoch;
      return String(a.info.category || '').localeCompare(String(b.info.category || ''));
    });
    newEvents.forEach(evt => {
      ctfdAnnounceFirstCategorySolve(pid, evt.kind, evt.info);
      const store = evt.kind === 'user' ? state.user : state.team;
      const ref = store[evt.info.key];
      if (ref) ref.announced = true;
    });
  } catch {}
}
function ctfdDetectFirstScore(projectId, meta){
  try {
    const pid = String(projectId || '').trim();
    if (!pid || pid === 'multi') return;
    const summary = ctfdSummarizeScore(meta);
    let state = CTFD_SCORE_STATE[pid];
    if (!state) {
      ctfdSeedFirstScoreState(pid, meta);
      return;
    }
    if (!state.seeded) state.seeded = true;
    if (!state.hasScore && summary.hasScore) {
      state.hasScore = true;
      state.lastUser = summary.firstUser || '';
      state.lastTeam = summary.firstTeam || '';
      state.lastPoints = Number(summary.firstPoints) || 0;
      CTFD_SCORE_STATE[pid] = state;
      ctfdAnnounceFirstScore(pid, summary);
      return;
    }
    if (!summary.hasScore) {
      state.hasScore = false;
      state.lastUser = '';
      state.lastTeam = '';
      state.lastPoints = 0;
      CTFD_SCORE_STATE[pid] = state;
      return;
    }
    state.lastUser = summary.firstUser || state.lastUser || '';
    state.lastTeam = summary.firstTeam || state.lastTeam || '';
    state.lastPoints = Number(summary.firstPoints) || state.lastPoints || 0;
    CTFD_SCORE_STATE[pid] = state;
  } catch {}
}

function ctfdAnnounceFirstPlace(projectId, kind, name, delaySeconds){
  if (!name) return;
  const projectLabel = ctfdProjectLabel(projectId);
  const scope = projectLabel ? ` — ${projectLabel}` : '';
  const prefix = kind === 'team' ? 'Team' : 'User';
  try { shell.logSuccess(`[CTFd] ${prefix} now in first place${scope}: ${name}`); } catch {}
  const key = kind === 'team' ? 'ctfdFirstTeam' : 'ctfdFirstUser';
  const speechScope = projectLabel ? ` in ${projectLabel}` : '';
  const speechCtx = ctfdSpeechContextFirstPlace(projectId, kind, name);
  const fallback = `${prefix} ${name} is now in first place${speechScope}.`;
  const baseDelay = Number(delaySeconds) || 0;
  void ctfdSpeakForEvent(key, { context: speechCtx, fallbackText: fallback }, baseDelay, {
    onAudioRequest: (startDelay)=> ctfdPlayFirstPlaceSound(kind, startDelay)
  });
}

function ctfdComputeFirstPlace(meta){
  const result = { user: null, userRank: null, team: null, teamRank: null };
  let topUserRank = Number.POSITIVE_INFINITY;
  let topTeamRank = Number.POSITIVE_INFINITY;
  try {
    Object.entries(meta || {}).forEach(([username, info]) => {
      if (!info) return;
      if (info.exists === false) return;
      const uRank = rankNumber(info.user_rank);
      if (Number.isFinite(uRank) && uRank > 0 && uRank < topUserRank) {
        topUserRank = uRank;
        result.user = username;
        result.userRank = uRank;
      }
      const teamName = String(info.team_name || '').trim();
      if (teamName) {
        const tRank = rankNumber(info.team_rank);
        if (Number.isFinite(tRank) && tRank > 0 && tRank < topTeamRank) {
          topTeamRank = tRank;
          result.team = teamName;
          result.teamRank = tRank;
        }
      }
    });
  } catch {}
  if (!Number.isFinite(topUserRank)) { result.user = null; result.userRank = null; }
  if (!Number.isFinite(topTeamRank)) { result.team = null; result.teamRank = null; }
  return result;
}

function ctfdDetectFirstPlaceChange(projectId, meta){
  try {
    const pid = String(projectId||'').trim();
    if (!pid || pid === 'multi') return;
    const next = ctfdComputeFirstPlace(meta);
    const prev = CTFD_FIRST_PLACE_HISTORY[pid];
    if (!prev) {
      CTFD_FIRST_PLACE_HISTORY[pid] = next;
      return;
    }
    if (next.user && next.userRank === 1 && next.user !== prev.user) {
      ctfdAnnounceFirstPlace(pid, 'user', next.user, 0);
    }
    if (next.team && next.teamRank === 1 && next.team !== prev.team) {
      ctfdAnnounceFirstPlace(pid, 'team', next.team, 0.25);
    }
    CTFD_FIRST_PLACE_HISTORY[pid] = next;
  } catch {}
}

function ctfdSeedFirstPlaceHistory(projectId, meta){
  try {
    const pid = String(projectId||'').trim();
    if (!pid || pid === 'multi') return;
    CTFD_FIRST_PLACE_HISTORY[pid] = ctfdComputeFirstPlace(meta);
    ctfdSeedFirstScoreState(pid, meta);
  } catch {}
}

function ctfdApplyUserMeta(projectId, meta){
  const data = meta && typeof meta === 'object' ? meta : {};
  const pid = String(projectId||'').trim();
  if (pid && pid !== 'multi') {
    ctfdDetectFirstPlaceChange(pid, data);
    ctfdDetectFirstScore(pid, data);
  }
  CTFD_USER_META = data;
}

function ctfdUnlockAudioContext(){
  try {
    const ctx = ctfdEnsureAudioContext();
    if (ctx && ctx.state === 'suspended') ctx.resume().catch(()=>{});
  } catch {}
}

try {
  document.addEventListener('pointerdown', ctfdUnlockAudioContext, { once: true, passive: true });
  document.addEventListener('keydown', ctfdUnlockAudioContext, { once: true });
} catch {}

// --- Persist/restore simple UI state per project ---
function ctfdUiKey(pid){ return `toolhub.ctfd.ui.${pid}`; }
function readCtfdUiState(pid){ try { return JSON.parse(sessionStorage.getItem(ctfdUiKey(pid))||'{}'); } catch { return {}; } }
function writeCtfdUiState(pid, obj){
  try {
    const cur = readCtfdUiState(pid);
    sessionStorage.setItem(ctfdUiKey(pid), JSON.stringify({
      ...cur,
      filterText: (obj.filterText !== undefined ? obj.filterText : cur.filterText) || '',
      filterIsRegex: !!(obj.filterIsRegex !== undefined ? obj.filterIsRegex : (cur.filterIsRegex||false)),
      showPasswords: !!(obj.showPasswords !== undefined ? obj.showPasswords : (cur.showPasswords||false)),
      selectedIndices: Array.isArray(obj.selectedIndices) ? obj.selectedIndices : (Array.isArray(cur.selectedIndices) ? cur.selectedIndices : []),
      sort: (obj.sort !== undefined ? obj.sort : (cur.sort || { key: CTFD_SORT.key, dir: CTFD_SORT.dir })),
      userSortMode: (obj.userSortMode !== undefined ? obj.userSortMode : (cur.userSortMode || CTFD_USER_SORT_MODE)),
      teamSortMode: (obj.teamSortMode !== undefined ? obj.teamSortMode : (cur.teamSortMode || CTFD_TEAM_SORT_MODE)),
      sortNA: (obj.sortNA !== undefined ? obj.sortNA : (cur.sortNA !== undefined ? cur.sortNA : CTFD_SORT_NA))
    }));
  } catch {}
}

// Map VM power state to a styled badge (mirror VM Manager)
function mapProxmoxPowerState(raw){
  const s = String(raw || '').toLowerCase();
  const mk = (label, cls, weight) => ({ label, cls, weight });
  if (!s) return mk('n/a', 'bg-secondary', 6);
  if (['running','ok'].includes(s)) return mk('running','bg-success',0);
  if (['starting','prelaunch','booting','launching'].includes(s)) return mk('starting','bg-info text-dark',1);
  if (['paused','pause','suspended','suspend'].includes(s)) return mk('suspended','bg-warning text-dark',2);
  if (['stopped','down','shutoff','off','halted'].includes(s)) return mk('stopped','bg-secondary',3);
  if (['stopping','shutdown','shutting down'].includes(s)) return mk('stopping','bg-info text-dark',4);
  if (['resetting','rebooting','reboot'].includes(s)) return mk('rebooting','bg-info text-dark',1);
  if (['error','failed','failure','crashed','internal-error'].includes(s)) return mk('error','bg-danger',5);
  return mk(s,'bg-secondary',6);
}

// Status badge for created/missing/n/a
function mapRowStatus(raw){
  const s = String(raw || '').toLowerCase();
  if (s === 'created') return { label: 'created', cls: 'badge bg-success', weight: 0 };
  if (s === 'missing') return { label: 'missing', cls: 'badge bg-danger', weight: 2 };
  if (s === 'pending') return { label: 'pending', cls: 'badge bg-warning text-dark', weight: 1 };
  return { label: 'n/a', cls: 'badge bg-secondary', weight: 3 };
}

function renderCtfdTable(proj){
  // If multiple projects selected, delegate to merged renderer
  try {
    if (Array.isArray(CTFD_SELECTED_PIDS) && CTFD_SELECTED_PIDS.length > 1) {
      return ctfdRenderTableMerged();
    }
  } catch {}
  const host = document.getElementById('ctfd-table');
  if(!host) return;
  if(!proj){
    host.innerHTML = '<div class="text-center text-muted py-4">Select a project from the left to begin.</div>';
    return;
  }
  // One row per instance (removing per-VM rows)
  const inst = Number(proj.instances || 0);
  const creds = Array.isArray(proj.credentials) ? proj.credentials : [];
  const rows = [];
  for (let i = 1; i <= inst; i++) {
    const cred = creds[i-1] || {};
    const uname = (cred.username ?? '').trim();
    const pword = cred.password ?? '';
    rows.push({ index:i, uname, pword, key: `${i}` });
  }

  // Filter across all visible columns by building a searchable record per row
  const filterIndex = rows.map(r => {
    const meta = (r.uname && CTFD_USER_META[r.uname]) ? CTFD_USER_META[r.uname] : null;
    return {
      index: r.index,
      user: r.uname,
      team: meta?.team_name ?? '',
      user_points: (meta?.user_points ?? ''),
      team_points: (meta?.team_points ?? ''),
      user_last: `${meta?.user_last_solve_time ?? ''} ${meta?.user_last_solve_challenge ?? ''}`.trim(),
      team_last: `${meta?.team_last_solve_time ?? ''} ${meta?.team_last_solve_challenge ?? ''}`.trim(),
    };
  });
  const filtered = applyCtfdFilter(filterIndex).map(f => {
    const idx = Number(f.index);
    return rows.find(r => Number(r.index) === idx) || null;
  }).filter(Boolean);

  // Sort within groups using CTFD_SORT
  const compare = (a,b)=>{
    const dir = CTFD_SORT.dir === 'desc' ? -1 : 1;
    const k = CTFD_SORT.key;
    const numPresent = (v) => {
      if (v === null || v === undefined) return false;
      const s = String(v);
      if (s.trim() === '') return false; // treat empty string as missing
      const n = Number(s);
      return Number.isFinite(n);
    };
    // Helper: check if the row is missing data for the active sort key
    const isMissingForKey = (row) => {
      try {
        const m = (row.uname && CTFD_USER_META[row.uname]) ? CTFD_USER_META[row.uname] : null;
        if (k === 'cred') {
          if (CTFD_USER_SORT_MODE === 'rank') return !isFinite(rankNumber(m && m.user_rank));
          return !(row.uname && row.uname.trim());
        }
        if (k === 'team') {
          if (CTFD_TEAM_SORT_MODE === 'rank') return !isFinite(rankNumber(m && m.team_rank));
          return !(m && m.team_name);
        }
        if (k === 'user_points') return !(m && numPresent(m.user_points));
        if (k === 'team_points') return !(m && numPresent(m.team_points));
        if (k === 'user_last') return !Number.isFinite(ageSeconds(m && m.user_last_solve_time));
        if (k === 'team_last') return !Number.isFinite(ageSeconds(m && m.team_last_solve_time));
        // default to present
        return false;
      } catch { return false; }
    };
    // Always push rows missing the ACTIVE sort field to the end (toggle removed)
    const isMissingActive = (row) => {
      try {
        const m = (row.uname && CTFD_USER_META[row.uname]) ? CTFD_USER_META[row.uname] : null;
        if (k === 'cred') {
          if (CTFD_USER_SORT_MODE === 'rank') return !isFinite(rankNumber(m && m.user_rank));
          return !(row.uname && row.uname.trim());
        }
        if (k === 'team') {
          if (CTFD_TEAM_SORT_MODE === 'rank') return !isFinite(rankNumber(m && m.team_rank));
          return !(m && m.team_name);
        }
        if (k === 'user_points') return !(m && numPresent(m.user_points));
        if (k === 'team_points') return !(m && numPresent(m.team_points));
        if (k === 'user_last') return !Number.isFinite(ageSeconds(m && m.user_last_solve_time));
        if (k === 'team_last') return !Number.isFinite(ageSeconds(m && m.team_last_solve_time));
        return false;
      } catch { return false; }
    };
    {
      const aNA = isMissingActive(a);
      const bNA = isMissingActive(b);
      if (aNA !== bNA) return aNA ? 1 : -1;
    }
    // Column-specific missing handling: always place missing after present regardless of sort direction
    const aMiss = isMissingForKey(a);
    const bMiss = isMissingForKey(b);
    if (aMiss !== bMiss) return aMiss ? 1 : -1;

    let va, vb;
    if (k === 'project') {
      // Single-project view: all rows have same project; keep stable order
      // No-op compare, fall through to next comparisons
    }
    if (k === 'cred') {
      if (CTFD_USER_SORT_MODE === 'rank') {
        const ma = (a.uname && CTFD_USER_META[a.uname]) ? CTFD_USER_META[a.uname] : null;
        const mb = (b.uname && CTFD_USER_META[b.uname]) ? CTFD_USER_META[b.uname] : null;
        va = rankNumber(ma && ma.user_rank);
        vb = rankNumber(mb && mb.user_rank);
        if (va === vb) { va = (a.uname||'').toLowerCase(); vb = (b.uname||'').toLowerCase(); }
      } else {
        va = (a.uname||'').toLowerCase(); vb = (b.uname||'').toLowerCase();
      }
    }
    else if (k === 'team') {
      const ma = (a.uname && CTFD_USER_META[a.uname]) ? CTFD_USER_META[a.uname] : null;
      const mb = (b.uname && CTFD_USER_META[b.uname]) ? CTFD_USER_META[b.uname] : null;
      if (CTFD_TEAM_SORT_MODE === 'rank') {
        va = rankNumber(ma && ma.team_rank);
        vb = rankNumber(mb && mb.team_rank);
        if (va === vb) {
          va = (ma && ma.team_name ? String(ma.team_name) : '').toLowerCase();
          vb = (mb && mb.team_name ? String(mb.team_name) : '').toLowerCase();
        }
      } else {
        va = (ma && ma.team_name ? String(ma.team_name) : '').toLowerCase();
        vb = (mb && mb.team_name ? String(mb.team_name) : '').toLowerCase();
      }
    }
    else if (k === 'user_points') {
      const ma = (a.uname && CTFD_USER_META[a.uname]) ? CTFD_USER_META[a.uname] : null;
      const mb = (b.uname && CTFD_USER_META[b.uname]) ? CTFD_USER_META[b.uname] : null;
      va = Number(ma && ma.user_points);
      vb = Number(mb && mb.user_points);
    }
    else if (k === 'team_points') {
      const ma = (a.uname && CTFD_USER_META[a.uname]) ? CTFD_USER_META[a.uname] : null;
      const mb = (b.uname && CTFD_USER_META[b.uname]) ? CTFD_USER_META[b.uname] : null;
      va = Number(ma && ma.team_points);
      vb = Number(mb && mb.team_points);
    }
    else if (k === 'user_last') {
      const ma = (a.uname && CTFD_USER_META[a.uname]) ? CTFD_USER_META[a.uname] : null;
      const mb = (b.uname && CTFD_USER_META[b.uname]) ? CTFD_USER_META[b.uname] : null;
      va = ageSeconds(ma && ma.user_last_solve_time);
      vb = ageSeconds(mb && mb.user_last_solve_time);
    }
    else if (k === 'team_last') {
      const ma = (a.uname && CTFD_USER_META[a.uname]) ? CTFD_USER_META[a.uname] : null;
      const mb = (b.uname && CTFD_USER_META[b.uname]) ? CTFD_USER_META[b.uname] : null;
      va = ageSeconds(ma && ma.team_last_solve_time);
      vb = ageSeconds(mb && mb.team_last_solve_time);
    }
    else { va = (a.uname||'').toLowerCase(); vb = (b.uname||'').toLowerCase(); }

    // Final numeric/string compare
    if (va < vb) return -1*dir;
    if (va > vb) return 1*dir;
    return 0;
  };

  // Sort all filtered rows directly (no per-instance grouping)
  try { filtered.sort(compare); } catch {}

  // Render
  CTFD_LAST_VISIBLE_INDICES = [];
  let html = '<table class="table table-sm align-middle">';
  html += '<thead><tr>';
  if (CTFD_COLS.project) html += `<th role="columnheader" scope="col" aria-sort="${ariaSortCtfd('project')}" style="cursor:pointer;min-width:220px;white-space:nowrap" onclick="ctfdSort('project')">Project${sortIconCtfd('project')}</th>`;
  if (CTFD_COLS.cred) html +=
    `<th role="columnheader" scope="col" aria-sort="${ariaSortCtfd('cred')}" style="cursor:pointer;min-width:220px;white-space:nowrap">`+
      `<input type="checkbox" id="ctfd-chk-all" class="form-check-input me-2" title="Select all" />`+
      `<span role="button" onclick="ctfdSort('cred')">User${sortIconCtfd('cred')}</span>`+
      `<button type="button" class="btn btn-sm btn-link p-0 ms-2" title="Toggle User sort (currently ${CTFD_USER_SORT_MODE})" onclick="toggleUserSortMode(event)">⇅</button>`+
      `<button type="button" class="btn btn-sm btn-link p-0 ms-2" title="Show/Hide passwords" onclick="toggleCtfdPasswords()">&#128065;&#xFE0E;</button>`+
    `</th>`;
  if (CTFD_COLS.team) html +=
    `<th role="columnheader" scope="col" aria-sort="${ariaSortCtfd('team')}" style="cursor:pointer;min-width:200px;white-space:nowrap">`+
      `<span role="button" onclick="ctfdSort('team')">Team${sortIconCtfd('team')}</span>`+
      `<button type="button" class="btn btn-sm btn-link p-0 ms-2" title="Toggle Team sort (currently ${CTFD_TEAM_SORT_MODE})" onclick="toggleTeamSortMode(event)">⇅</button>`+
    `</th>`;
  if (CTFD_COLS.user_points) html += `<th role="columnheader" scope="col" aria-sort="${ariaSortCtfd('user_points')}" style="cursor:pointer;min-width:120px;white-space:nowrap" onclick="ctfdSort('user_points')">User Points${sortIconCtfd('user_points')}</th>`;
  if (CTFD_COLS.team_points) html += `<th role="columnheader" scope="col" aria-sort="${ariaSortCtfd('team_points')}" style="cursor:pointer;min-width:120px;white-space:nowrap" onclick="ctfdSort('team_points')">Team Points${sortIconCtfd('team_points')}</th>`;
  if (CTFD_COLS.user_last) html += `<th role="columnheader" scope="col" aria-sort="${ariaSortCtfd('user_last')}" style="cursor:pointer;min-width:220px;white-space:nowrap" onclick="ctfdSort('user_last')">User Last Solved${sortIconCtfd('user_last')}</th>`;
  if (CTFD_COLS.team_last) html += `<th role="columnheader" scope="col" aria-sort="${ariaSortCtfd('team_last')}" style="cursor:pointer;min-width:220px;white-space:nowrap" onclick="ctfdSort('team_last')">Team Last Solved${sortIconCtfd('team_last')}</th>`;
  html += '</tr></thead>';
  html += '<tbody>';
  const colCount = ['project','cred','team','user_points','team_points','user_last','team_last'].filter(id=>CTFD_COLS[id]).length || 1;
  if (filtered.length === 0) {
    html += `<tr><td colspan="${colCount}" class="text-center text-muted">No rows</td></tr>`;
  } else {
    // Track visible indices for header select-all
    const seen = new Set();
    for (const r of filtered) {
      const idx = r.index;
      const masked = r.pword ? '•'.repeat(Math.min(String(r.pword).length, 12)) : 'n/a';
      const meta = (r.uname && CTFD_USER_META[r.uname]) ? CTFD_USER_META[r.uname] : null;
      const urank = (meta && meta.user_rank != null && meta.user_rank !== '') ? ` <span class="text-muted">(#${escHtml(String(meta.user_rank))})</span>` : '';
      const baseUrl = (PROJ?.challenge_url||'').replace(/\/$/, '');
      const uAttrs = '';
      const ulink = (meta && meta.user_id!=null)
        ? `<a href="${escHtml(baseUrl)}/users/${encodeURIComponent(String(meta.user_id))}" target="_blank" rel="noopener"${uAttrs}>${escHtml(r.uname || 'n/a')}</a>`
        : `<span${uAttrs}>${escHtml(r.uname || 'n/a')}</span>`;
      const credText = (r.uname || r.pword)
        ? `${ulink}${urank} / ${CTFD_SHOW_PASSWORDS ? escHtml(r.pword || 'n/a') : masked}`
        : 'n/a';
      // Existence icon next to credentials
      let existIcon = '';
      if (r.uname) {
        const val = Object.prototype.hasOwnProperty.call(CTFD_USER_META, r.uname) ? !!CTFD_USER_META[r.uname]?.exists : null;
        if (val === true) existIcon = ' <i class="bi bi-person-check-fill text-success ms-2" title="CTFd user exists"></i>';
        else if (val === false) existIcon = ' <i class="bi bi-person-x-fill text-secondary ms-2" title="CTFd user not found"></i>';
        else existIcon = ' <i class="bi bi-person text-muted ms-2" title="CTFd user status unknown"></i>';
      }
      if (!seen.has(idx)) { seen.add(idx); CTFD_LAST_VISIBLE_INDICES.push(idx); }
      const checked = CTFD_SELECTED_INDICES.has(idx) ? 'checked' : '';
      // Team column content: name with rank if available
      const tname = meta && meta.team_name ? escHtml(String(meta.team_name)) : '';
      const tTips = [];
      if (meta && meta.team_captain) tTips.push(`Captain: ${escHtml(String(meta.team_captain))}`);
      if (meta && (meta.team_size!==null && meta.team_size!==undefined)) tTips.push(`Size: ${escHtml(String(meta.team_size))}`);
      const tTitle = tTips.join(' ');
      const tAttrs = tTitle ? ` data-bs-toggle=\"tooltip\" data-bs-placement=\"top\" title=\"${tTitle}\"` : '';
      const tlink = (meta && meta.team_id!=null)
        ? `<a href="${escHtml(baseUrl)}/teams/${encodeURIComponent(String(meta.team_id))}" target="_blank" rel="noopener"${tAttrs}>${tname||'team'}</a>`
        : (tTitle?`<span${tAttrs}>${tname||''}</span>`:tname);
      const trank = meta && meta.team_rank != null && meta.team_rank !== '' ? ` <span class="text-muted">(#${escHtml(String(meta.team_rank))})</span>` : '';
      const teamHtml = (tname || (meta && meta.team_id!=null)) ? `${tlink}${trank}` : 'n/a';
      // Points
      const fmtPts = (x) => {
        if (x === null || x === undefined || x === '' || isNaN(Number(x))) return 'n/a';
        const n = Number(x);
        return Number.isInteger(n) ? String(n) : n.toFixed(2);
      };
      const userPts = fmtPts(meta && meta.user_points);
      const teamPts = fmtPts(meta && meta.team_points);
      // Last solved
      const uTime = (meta && meta.user_last_solve_time) ? formatRelativeTime(String(meta.user_last_solve_time)) : '';
      const uChal = (meta && meta.user_last_solve_challenge) ? String(meta.user_last_solve_challenge) : '';
      const userLastHtml = (uTime || uChal) ? `${escHtml(uTime)}${(uTime&&uChal)?' / ':''}${escHtml(uChal)}` : 'n/a';
      const tTime = (meta && meta.team_last_solve_time) ? formatRelativeTime(String(meta.team_last_solve_time)) : '';
      const tChal = (meta && meta.team_last_solve_challenge) ? String(meta.team_last_solve_challenge) : '';
      const teamLastHtml = (tTime || tChal) ? `${escHtml(tTime)}${(tTime&&tChal)?' / ':''}${escHtml(tChal)}` : 'n/a';

      html += '<tr>';
      if (CTFD_COLS.project) html += `<td>${escHtml(PROJ?.name||'')}<div class="small text-muted">${escHtml(PROJ?.tag||'')}</div></td>`;
      if (CTFD_COLS.cred) html +=
        `<td>`+
          `<div class=\"d-flex align-items-center\">`+
            `<div class=\"flex-grow-1\">`+
              `<input type=\"checkbox\" class=\"ctfd-cred-chk form-check-input me-2\" data-index=\"${idx}\" ${checked} />`+
              `${credText}`+
            `</div>`+
            `<div class=\"ms-2\">${existIcon}</div>`+
          `</div>`+
        `</td>`;
      if (CTFD_COLS.team) html += `<td>${teamHtml}</td>`;
      if (CTFD_COLS.user_points) html += `<td>${userPts}</td>`;
      if (CTFD_COLS.team_points) html += `<td>${teamPts}</td>`;
      if (CTFD_COLS.user_last) html += `<td>${userLastHtml}</td>`;
      if (CTFD_COLS.team_last) html += `<td>${teamLastHtml}</td>`;
      html += `</tr>`;
    }
  }
  html += '</tbody></table>';
  host.innerHTML = html;
  ctfdEnsureScrollPersistence();
  // Snapshot latest single-project render
  try { ctfdCacheSnapshot('single'); } catch {}

  // Wire selection handlers
  try {
    // Initialize Bootstrap tooltips for any new elements
    if (window.bootstrap) {
      try {
        document.querySelectorAll('#ctfd-table [data-bs-toggle="tooltip"]').forEach(el => {
          try { bootstrap.Tooltip.getOrCreateInstance(el); } catch {}
        });
      } catch {}
    }
    const all = document.getElementById('ctfd-chk-all');
    const allSelected = (CTFD_LAST_VISIBLE_INDICES.length>0) && CTFD_LAST_VISIBLE_INDICES.every(i => CTFD_SELECTED_INDICES.has(i));
    if (all) all.checked = allSelected;
    if (all) {
      all.addEventListener('change', () => {
        if (all.checked) {
          CTFD_LAST_VISIBLE_INDICES.forEach(i => CTFD_SELECTED_INDICES.add(i));
        } else {
          CTFD_LAST_VISIBLE_INDICES.forEach(i => CTFD_SELECTED_INDICES.delete(i));
        }
        // Update all credential checkboxes to reflect new state without full re-render
        document.querySelectorAll('#ctfd-table .ctfd-cred-chk').forEach(cb => {
          const idx = Number(cb.getAttribute('data-index')||'0');
          cb.checked = CTFD_SELECTED_INDICES.has(idx);
        });
        // Persist selection
        if (PROJ) writeCtfdUiState(PROJ.id, { selectedIndices: Array.from(CTFD_SELECTED_INDICES) });
      });
    }
    document.querySelectorAll('#ctfd-table .ctfd-cred-chk').forEach(cb => {
      cb.addEventListener('change', () => {
        const idx = Number(cb.getAttribute('data-index')||'0');
        if (cb.checked) CTFD_SELECTED_INDICES.add(idx); else CTFD_SELECTED_INDICES.delete(idx);
        // Update header checkbox state
        const allSel = (CTFD_LAST_VISIBLE_INDICES.length>0) && CTFD_LAST_VISIBLE_INDICES.every(i => CTFD_SELECTED_INDICES.has(i));
        const hdr = document.getElementById('ctfd-chk-all'); if (hdr) hdr.checked = allSel;
        // Persist selection
        if (PROJ) writeCtfdUiState(PROJ.id, { selectedIndices: Array.from(CTFD_SELECTED_INDICES) });
      });
    });
  } catch {}
}

// --- Merged table renderer for multi-project view ---
function ctfdRenderTableMerged(){
  const host = document.getElementById('ctfd-table');
  if (!host) return;
  const pids = Array.isArray(CTFD_SELECTED_PIDS) ? CTFD_SELECTED_PIDS.slice() : [];
  if (!pids.length) { host.innerHTML = '<div class="text-muted">Select projects to merge.</div>'; return; }
  // Build rows by merging credentials layout across selected projects
  // We rely on PROJ for column preferences when single; for multi, use a shared 'multi' key.
  try { CTFD_COLS = readCtfdCols('multi'); const ids=['project','cred','team','user_points','team_points','user_last','team_last']; ids.forEach(id=>{ const el=document.getElementById(`ctfd-col-${id}`); if(el) el.checked = !!CTFD_COLS[id]; }); } catch {}
  // Read persisted multi selection keys
  try {
    const raw = sessionStorage.getItem('toolhub.ctfd.mgr.selectedKeys.v1') || '[]';
    const arr = JSON.parse(raw); if (Array.isArray(arr)) CTFD_SELECTED_KEYS = new Set(arr);
  } catch {}
  // Construct a merged flat row list
  const rows = [];
  const byId = {}; (CTFD_ALL_PROJECTS||[]).forEach(p=> byId[String(p.id)] = p);
  pids.forEach(pid => {
    const proj = byId[String(pid)]; if (!proj) return;
    const inst = Number(proj.instances || 0);
    const creds = Array.isArray(proj.credentials) ? proj.credentials : [];
    for (let i = 1; i <= inst; i++) {
      const cred = creds[i-1] || {};
      const uname = (cred.username ?? '').trim();
      const pword = cred.password ?? '';
      rows.push({ pid: String(proj.id), _proj: proj, index: i, uname, pword, key: `${proj.id}:${i}` });
    }
  });
  // Build filter index with meta from CTFD_USER_META per username (global map is OK across projects)
  const filterIndex = rows.map(r => {
    const meta = (r.uname && CTFD_USER_META[r.uname]) ? CTFD_USER_META[r.uname] : null;
    return {
      key: r.key,
      pid: r.pid,
      project_name: r._proj?.name||'',
      project_tag: r._proj?.tag||'',
      index: r.index,
      user: r.uname,
      team: meta?.team_name ?? '',
      user_points: (meta?.user_points ?? ''),
      team_points: (meta?.team_points ?? ''),
      user_last: `${meta?.user_last_solve_time ?? ''} ${meta?.user_last_solve_challenge ?? ''}`.trim(),
      team_last: `${meta?.team_last_solve_time ?? ''} ${meta?.team_last_solve_challenge ?? ''}`.trim(),
    };
  });
  const filtered = applyCtfdFilter(filterIndex).map(f => rows.find(r => r.key === f.key)).filter(Boolean);
  // Sorting across projects: reuse same compare but adapt lookups
  const compare = (a,b)=>{
    const dir = CTFD_SORT.dir === 'desc' ? -1 : 1;
    const k = CTFD_SORT.key;
    const numPresent = (v) => { if (v === null || v === undefined) return false; const s = String(v); if (s.trim()==='') return false; const n = Number(s); return Number.isFinite(n); };
    const metaA = (a.uname && CTFD_USER_META[a.uname]) ? CTFD_USER_META[a.uname] : null;
    const metaB = (b.uname && CTFD_USER_META[b.uname]) ? CTFD_USER_META[b.uname] : null;
    // Always place rows missing the active sort field at the end
    const missing = (row, meta) => {
      if (k==='cred') { if (CTFD_USER_SORT_MODE==='rank') return !isFinite(rankNumber(meta && meta.user_rank)); return !(row.uname && row.uname.trim()); }
      if (k==='team') { if (CTFD_TEAM_SORT_MODE==='rank') return !isFinite(rankNumber(meta && meta.team_rank)); return !(meta && meta.team_name); }
      if (k==='user_points') return !(meta && numPresent(meta.user_points));
      if (k==='team_points') return !(meta && numPresent(meta.team_points));
      if (k==='user_last') return !Number.isFinite(ageSeconds(meta && meta.user_last_solve_time));
      if (k==='team_last') return !Number.isFinite(ageSeconds(meta && meta.team_last_solve_time));
      return false;
    };
    const aNA = missing(a, metaA), bNA = missing(b, metaB); if (aNA!==bNA) return aNA?1:-1;
    let va, vb;
    if (k==='project') {
      va = String(a._proj?.name||'').toLowerCase();
      vb = String(b._proj?.name||'').toLowerCase();
    }
    else if (k==='cred') {
      if (CTFD_USER_SORT_MODE==='rank') { va = rankNumber(metaA && metaA.user_rank); vb = rankNumber(metaB && metaB.user_rank); if (va===vb){ va=(a.uname||'').toLowerCase(); vb=(b.uname||'').toLowerCase(); } }
      else { va=(a.uname||'').toLowerCase(); vb=(b.uname||'').toLowerCase(); }
    } else if (k==='team') {
      if (CTFD_TEAM_SORT_MODE==='rank') { va=rankNumber(metaA && metaA.team_rank); vb=rankNumber(metaB && metaB.team_rank); if (va===vb){ va=String(metaA&&metaA.team_name||'').toLowerCase(); vb=String(metaB&&metaB.team_name||'').toLowerCase(); } }
      else { va=String(metaA&&metaA.team_name||'').toLowerCase(); vb=String(metaB&&metaB.team_name||'').toLowerCase(); }
    } else if (k==='user_points') { va=Number(metaA&&metaA.user_points); vb=Number(metaB&&metaB.user_points); }
    else if (k==='team_points') { va=Number(metaA&&metaA.team_points); vb=Number(metaB&&metaB.team_points); }
    else if (k==='user_last') { va=ageSeconds(metaA&&metaA.user_last_solve_time); vb=ageSeconds(metaB&&metaB.user_last_solve_time); }
    else if (k==='team_last') { va=ageSeconds(metaA&&metaA.team_last_solve_time); vb=ageSeconds(metaB&&metaB.team_last_solve_time); }
    else { va=(a.uname||'').toLowerCase(); vb=(b.uname||'').toLowerCase(); }
    if (va<vb) return -1*dir; if (va>vb) return 1*dir; return 0;
  };
  try { filtered.sort(compare); } catch {}
  // Render
  CTFD_LAST_VISIBLE_KEYS = []; // track visible keys for header select-all
  let html = '<table class="table table-sm align-middle">';
  html += '<thead><tr>';
  if (CTFD_COLS.project) html += `<th role="columnheader" scope="col" aria-sort="${ariaSortCtfd('project')}" style="cursor:pointer;min-width:240px;white-space:nowrap" onclick="ctfdSort('project')">Project${sortIconCtfd('project')}</th>`;
  if (CTFD_COLS.cred) html +=
    `<th role="columnheader" scope="col" aria-sort="${ariaSortCtfd('cred')}" style="cursor:pointer;min-width:260px;white-space:nowrap">`
    + `<input type="checkbox" id="ctfd-chk-all-multi" class="form-check-input me-2" title="Select all" />`
    + `<span role="button" onclick="ctfdSort('cred')">User${sortIconCtfd('cred')}</span>`
    + `<button type="button" class="btn btn-sm btn-link p-0 ms-2" title="Toggle User sort (currently ${CTFD_USER_SORT_MODE})" onclick="toggleUserSortMode(event)">⇅</button>`
    + `<button type="button" class="btn btn-sm btn-link p-0 ms-2" title="Show/Hide passwords" onclick="toggleCtfdPasswords()">&#128065;&#xFE0E;</button>`
    + `</th>`;
  if (CTFD_COLS.team) html +=
    `<th role="columnheader" scope="col" aria-sort="${ariaSortCtfd('team')}" style="cursor:pointer;min-width:200px;white-space:nowrap">`
    + `<span role="button" onclick="ctfdSort('team')">Team${sortIconCtfd('team')}</span>`
    + `<button type="button" class="btn btn-sm btn-link p-0 ms-2" title="Toggle Team sort (currently ${CTFD_TEAM_SORT_MODE})" onclick="toggleTeamSortMode(event)">⇅</button>`
    + `</th>`;
  if (CTFD_COLS.user_points) html += `<th role="columnheader" scope="col" aria-sort="${ariaSortCtfd('user_points')}" style="cursor:pointer;min-width:120px;white-space:nowrap" onclick="ctfdSort('user_points')">User Points${sortIconCtfd('user_points')}</th>`;
  if (CTFD_COLS.team_points) html += `<th role="columnheader" scope="col" aria-sort="${ariaSortCtfd('team_points')}" style="cursor:pointer;min-width:120px;white-space:nowrap" onclick="ctfdSort('team_points')">Team Points${sortIconCtfd('team_points')}</th>`;
  if (CTFD_COLS.user_last) html += `<th role="columnheader" scope="col" aria-sort="${ariaSortCtfd('user_last')}" style="cursor:pointer;min-width:220px;white-space:nowrap" onclick="ctfdSort('user_last')">User Last Solved${sortIconCtfd('user_last')}</th>`;
  if (CTFD_COLS.team_last) html += `<th role="columnheader" scope="col" aria-sort="${ariaSortCtfd('team_last')}" style="cursor:pointer;min-width:220px;white-space:nowrap" onclick="ctfdSort('team_last')">Team Last Solved${sortIconCtfd('team_last')}</th>`;
  html += '</tr></thead>';
  html += '<tbody>';
  const colCount = ['project','cred','team','user_points','team_points','user_last','team_last'].filter(id=>CTFD_COLS[id]).length || 1;
  if (filtered.length === 0) {
    html += `<tr><td colspan="${colCount}" class="text-center text-muted">No rows</td></tr>`;
  } else {
    for (const r of filtered) {
      const meta = (r.uname && CTFD_USER_META[r.uname]) ? CTFD_USER_META[r.uname] : null;
      const masked = r.pword ? '•'.repeat(Math.min(String(r.pword).length, 12)) : 'n/a';
      const urank = (meta && meta.user_rank != null && meta.user_rank !== '') ? ` <span class="text-muted">(#${escHtml(String(meta.user_rank))})</span>` : '';
      const baseUrl = (r._proj?.challenge_url||'').replace(/\/$/, '');
      const ulink = (meta && meta.user_id!=null)
        ? `<a href="${escHtml(baseUrl)}/users/${encodeURIComponent(String(meta.user_id))}" target="_blank" rel="noopener">${escHtml(r.uname || 'n/a')}</a>`
        : `${escHtml(r.uname || 'n/a')}`;
      const credText = (r.uname || r.pword)
        ? `${ulink}${urank} / ${CTFD_SHOW_PASSWORDS ? escHtml(r.pword || 'n/a') : masked}`
        : 'n/a';
      let existIcon = '';
      if (r.uname) {
        const val = Object.prototype.hasOwnProperty.call(CTFD_USER_META, r.uname) ? !!CTFD_USER_META[r.uname]?.exists : null;
        if (val === true) existIcon = ' <i class="bi bi-person-check-fill text-success ms-2" title="CTFd user exists"></i>';
        else if (val === false) existIcon = ' <i class="bi bi-person-x-fill text-secondary ms-2" title="CTFd user not found"></i>';
        else existIcon = ' <i class="bi bi-person text-muted ms-2" title="CTFd user status unknown"></i>';
      }
      const key = `${r.pid}:${r.index}`;
      if (!CTFD_LAST_VISIBLE_KEYS.includes(key)) CTFD_LAST_VISIBLE_KEYS.push(key);
      const checked = CTFD_SELECTED_KEYS.has(key) ? 'checked' : '';
      // Team column
      const tname = meta && meta.team_name ? escHtml(String(meta.team_name)) : '';
      const tTips = [];
      if (meta && meta.team_captain) tTips.push(`Captain: ${escHtml(String(meta.team_captain))}`);
      if (meta && (meta.team_size!==null && meta.team_size!==undefined)) tTips.push(`Size: ${escHtml(String(meta.team_size))}`);
      const tTitle = tTips.join(' ');
      const tAttrs = tTitle ? ` data-bs-toggle=\"tooltip\" data-bs-placement=\"top\" title=\"${tTitle}\"` : '';
      const tlink = (meta && meta.team_id!=null)
        ? `<a href="${escHtml(baseUrl)}/teams/${encodeURIComponent(String(meta.team_id))}" target="_blank" rel="noopener"${tAttrs}>${tname||'team'}</a>`
        : (tTitle?`<span${tAttrs}>${tname||''}</span>`:tname);
      const trank = meta && meta.team_rank != null && meta.team_rank !== '' ? ` <span class="text-muted">(#${escHtml(String(meta.team_rank))})</span>` : '';
      const teamHtml = (tname || (meta && meta.team_id!=null)) ? `${tlink}${trank}` : 'n/a';
      // Points and last solved
      const fmtPts = (x)=>{ if (x===null||x===undefined||x===''||isNaN(Number(x))) return 'n/a'; const n=Number(x); return Number.isInteger(n)? String(n): n.toFixed(2); };
      const userPts = fmtPts(meta && meta.user_points);
      const teamPts = fmtPts(meta && meta.team_points);
      const uTime = (meta && meta.user_last_solve_time) ? formatRelativeTime(String(meta.user_last_solve_time)) : '';
      const uChal = (meta && meta.user_last_solve_challenge) ? String(meta.user_last_solve_challenge) : '';
      const userLastHtml = (uTime || uChal) ? `${escHtml(uTime)}${(uTime&&uChal)?' / ':''}${escHtml(uChal)}` : 'n/a';
      const tTime = (meta && meta.team_last_solve_time) ? formatRelativeTime(String(meta.team_last_solve_time)) : '';
      const tChal = (meta && meta.team_last_solve_challenge) ? String(meta.team_last_solve_challenge) : '';
      const teamLastHtml = (tTime || tChal) ? `${escHtml(tTime)}${(tTime&&tChal)?' / ':''}${escHtml(tChal)}` : 'n/a';
      html += '<tr>';
      if (CTFD_COLS.project) html += `<td>${escHtml(r._proj?.name||'')}<div class=\"small text-muted\">${escHtml(r._proj?.tag||'')}</div></td>`;
      if (CTFD_COLS.cred) html += `<td><div class=\"d-flex align-items-center\"><div class=\"flex-grow-1\">`+
        `<input type=\"checkbox\" class=\"ctfd-cred-chk-multi form-check-input me-2\" data-key=\"${key}\" ${checked} />`+
        `${credText}</div><div class=\"ms-2\">${existIcon}</div></div></td>`;
      if (CTFD_COLS.team) html += `<td>${teamHtml}</td>`;
      if (CTFD_COLS.user_points) html += `<td>${userPts}</td>`;
      if (CTFD_COLS.team_points) html += `<td>${teamPts}</td>`;
      if (CTFD_COLS.user_last) html += `<td>${userLastHtml}</td>`;
      if (CTFD_COLS.team_last) html += `<td>${teamLastHtml}</td>`;
      html += `</tr>`;
    }
  }
  html += '</tbody></table>';
  host.innerHTML = html;
  ctfdEnsureScrollPersistence();
  // Initialize tooltips for any rendered elements
  try { if (window.bootstrap) { document.querySelectorAll('#ctfd-table [data-bs-toggle="tooltip"]').forEach(el => { try { bootstrap.Tooltip.getOrCreateInstance(el); } catch {} }); } } catch {}
  // Snapshot latest merged render
  try { ctfdCacheSnapshot('multi'); } catch {}
  // Wire selection handlers (multi)
  try {
    const all = document.getElementById('ctfd-chk-all-multi');
    const allSel = (CTFD_LAST_VISIBLE_KEYS.length>0) && CTFD_LAST_VISIBLE_KEYS.every(k => CTFD_SELECTED_KEYS.has(k));
    if (all) all.checked = allSel;
    if (all) {
      all.addEventListener('change', ()=>{
        try {
          if (all.checked) { CTFD_LAST_VISIBLE_KEYS.forEach(k => CTFD_SELECTED_KEYS.add(k)); }
          else { CTFD_LAST_VISIBLE_KEYS.forEach(k => CTFD_SELECTED_KEYS.delete(k)); }
          document.querySelectorAll('#ctfd-table .ctfd-cred-chk-multi').forEach(cb => {
            const key = String(cb.getAttribute('data-key')||'');
            cb.checked = CTFD_SELECTED_KEYS.has(key);
          });
          sessionStorage.setItem('toolhub.ctfd.mgr.selectedKeys.v1', JSON.stringify(Array.from(CTFD_SELECTED_KEYS)));
        } catch {}
      });
    }
    document.querySelectorAll('#ctfd-table .ctfd-cred-chk-multi').forEach(cb => {
      cb.addEventListener('change', ()=>{
        const key = String(cb.getAttribute('data-key')||'');
        if (cb.checked) CTFD_SELECTED_KEYS.add(key); else CTFD_SELECTED_KEYS.delete(key);
        const allSel2 = (CTFD_LAST_VISIBLE_KEYS.length>0) && CTFD_LAST_VISIBLE_KEYS.every(k => CTFD_SELECTED_KEYS.has(k));
        const hdr = document.getElementById('ctfd-chk-all-multi'); if (hdr) hdr.checked = allSel2;
        sessionStorage.setItem('toolhub.ctfd.mgr.selectedKeys.v1', JSON.stringify(Array.from(CTFD_SELECTED_KEYS)));
      });
    });
  } catch {}
}

// Lightweight: load project configuration only (no CTFd calls, no progress modal)
async function ctfdLoadProjectConfig(pid){
  try {
    const id = String(pid||'').trim(); if(!id) return;
    const token = ++CTFD_CONFIG_REQUEST_TOKEN;
    const data = await http('GET','/api/projects');
    if (token !== CTFD_CONFIG_REQUEST_TOKEN || ctfdSelectionChanged(id)) return;
    const proj = (data.projects||[]).find(p => String(p.id) === id);
    const info = document.getElementById('ctfd-info');
    if(!proj){
      ctfdStopCountdown(false);
      CTFD_LAST_CHALLENGES_STATE = null;
      if(info) info.textContent='Project not found.';
      ctfdClearSkipped();
      ctfdRenderSkippedIndicatorRaw([], '');
      return;
    }
    if (token !== CTFD_CONFIG_REQUEST_TOKEN || ctfdSelectionChanged(id)) return;
    PROJ = proj;
    try { ctfdUpdateServerNavLinkForCurrent(); } catch {}
    ctfdStopCountdown(false);
    CTFD_LAST_CHALLENGES_STATE = null;
  if(info) info.textContent = '';
    // Restore UI state for this project (filters/sort etc.)
    try {
      const st = readCtfdUiState(PROJ.id)||{};
      CTFD_FILTER_TEXT = String(st.filterText||'');
      CTFD_FILTER_IS_REGEX = !!st.filterIsRegex;
      CTFD_SHOW_PASSWORDS = !!st.showPasswords;
      CTFD_SELECTED_INDICES = new Set(Array.isArray(st.selectedIndices)?st.selectedIndices:[]);
      if (st.sort && st.sort.key && st.sort.dir) { CTFD_SORT.key = st.sort.key; CTFD_SORT.dir = st.sort.dir; }
      if (st.userSortMode) CTFD_USER_SORT_MODE = st.userSortMode;
      if (st.teamSortMode) CTFD_TEAM_SORT_MODE = st.teamSortMode;
      const input = document.getElementById('ctfd-filter'); if (input) input.value = CTFD_FILTER_TEXT;
      const reg = document.getElementById('ctfd-filter-regex'); if (reg) reg.checked = CTFD_FILTER_IS_REGEX;
    } catch {}
    // Load column visibility and reflect Columns dropdown
    try {
      CTFD_COLS = readCtfdCols(PROJ.id);
      const ids = ['project','cred','team','user_points','team_points','user_last','team_last'];
      ids.forEach(id=>{ const el = document.getElementById(`ctfd-col-${id}`); if (el) el.checked = !!CTFD_COLS[id]; });
    } catch {}
    // Render table; most meta columns will show 'n/a' as intended
    renderCtfdTable(PROJ);
    updateCtfdControlsEnabled();
    ctfdRestoreSkippedIndicator();
  } catch (e) { try { shell.logError(`CTFd config load failed: ${e?.message||e}`); } catch {} }
}

function toggleCtfdPasswords(){
  CTFD_SHOW_PASSWORDS = !CTFD_SHOW_PASSWORDS;
  if (PROJ) writeCtfdUiState(PROJ.id, { showPasswords: CTFD_SHOW_PASSWORDS });
  renderCtfdTable(PROJ);
}

function toggleUserSortMode(ev){
  try { ev?.stopPropagation?.(); } catch {}
  CTFD_USER_SORT_MODE = (CTFD_USER_SORT_MODE === 'name') ? 'rank' : 'name';
  if (PROJ) writeCtfdUiState(PROJ.id, { userSortMode: CTFD_USER_SORT_MODE });
  renderCtfdTable(PROJ);
}

function toggleTeamSortMode(ev){
  try { ev?.stopPropagation?.(); } catch {}
  CTFD_TEAM_SORT_MODE = (CTFD_TEAM_SORT_MODE === 'name') ? 'rank' : 'name';
  if (PROJ) writeCtfdUiState(PROJ.id, { teamSortMode: CTFD_TEAM_SORT_MODE });
  renderCtfdTable(PROJ);
}

// toggleSortNA removed

function ctfdSort(key){
  if(CTFD_SORT.key===key){ CTFD_SORT.dir = CTFD_SORT.dir==='asc'?'desc':'asc'; }
  else { CTFD_SORT.key=key; CTFD_SORT.dir='asc'; }
  if (PROJ) writeCtfdUiState(PROJ.id, { sort: { key: CTFD_SORT.key, dir: CTFD_SORT.dir } });
  renderCtfdTable(PROJ);
}

async function ctfdLoadProjectById(pid){
  // Prevent any implicit auto-refresh on initial page load
  if (!CTFD_ALLOW_LOAD) { try { shell.logDebug('CTFd: load blocked until user action'); } catch {} return; }
  const id = String(pid || '').trim();
  if (!id) return;
  const loadToken = ++CTFD_LOAD_REQUEST_COUNTER;
  CTFD_LOAD_ACTIVE_TOKEN = loadToken;
  // If multiple projects are selected, run the multi refresh path
  try {
    if (Array.isArray(CTFD_SELECTED_PIDS) && CTFD_SELECTED_PIDS.length > 1) {
      return await ctfdRefreshMulti({ loadToken, basePid: id });
    }
  } catch {}
  const info = document.getElementById('ctfd-info');
  const totalSteps = 3;
  let categoryPayload = null;
  let animTimer = null;
  let aborted = false;
  let abortLogged = false;
  const abortIfStale = () => {
    const newerLoad = loadToken !== CTFD_LOAD_ACTIVE_TOKEN;
    const selectionMoved = ctfdSelectionChanged(id);
    if (!newerLoad && !selectionMoved) return false;
    if (animTimer) { try { clearInterval(animTimer); } catch {} animTimer = null; }
    if (!abortLogged && (selectionMoved || newerLoad)) {
      const current = String(ctfdCurrentPid() || '');
      try { shell?.logDebug?.(`CTFd load cancelled for ${id} (current selection ${current || 'none'}, newer=${newerLoad})`); } catch {}
      abortLogged = true;
    }
    if (selectionMoved && !newerLoad) {
      try { ctfdHideProgress(); } catch {}
      updateCtfdControlsEnabled();
    }
    aborted = true;
    return true;
  };
  // Use inline progress bar instead of modal
  try { ctfdSetProgress(`Step 1/${totalSteps}: Loading project…`, 10, true); } catch {}
  if (abortIfStale()) return;
  try {
    const data = await http('GET','/api/projects');
    if (abortIfStale()) return;
    const proj = (data.projects||[]).find(p=>p.id===id);
    if(!proj){
      ctfdStopCountdown(false);
      CTFD_LAST_CHALLENGES_STATE = null;
      if(info) info.textContent='Project not found.';
      PROJ=null;
      renderCtfdTable(null);
      ctfdClearPeriodicTimer();
      ctfdClearSkipped();
      ctfdRenderSkippedIndicatorRaw([], '');
      return;
    }
    if (abortIfStale()) return;
  PROJ = proj; if(info) info.textContent = '';
    try { ctfdUpdateServerNavLinkForCurrent(); } catch {}
    ctfdStopCountdown(false);
    CTFD_LAST_CHALLENGES_STATE = null;
    // Restore UI state for this project
    try {
      const st = readCtfdUiState(PROJ.id)||{};
      CTFD_FILTER_TEXT = String(st.filterText||'');
      CTFD_FILTER_IS_REGEX = !!st.filterIsRegex;
      CTFD_SHOW_PASSWORDS = !!st.showPasswords;
      CTFD_SELECTED_INDICES = new Set(Array.isArray(st.selectedIndices)?st.selectedIndices:[]);
      if (st.sort && st.sort.key && st.sort.dir) {
        CTFD_SORT.key = st.sort.key;
        CTFD_SORT.dir = st.sort.dir;
      }
      if (st.userSortMode) CTFD_USER_SORT_MODE = st.userSortMode;
      if (st.teamSortMode) CTFD_TEAM_SORT_MODE = st.teamSortMode;
      // reflect in filter controls without clearing
      const input = document.getElementById('ctfd-filter'); if (input) input.value = CTFD_FILTER_TEXT;
      const reg = document.getElementById('ctfd-filter-regex'); if (reg) reg.checked = CTFD_FILTER_IS_REGEX;
    } catch {}
    if (abortIfStale()) return;
    ctfdSetProgress(`Step 2/${totalSteps}: Rendering table…`, 50, true);
    // Load column visibility and reflect Columns dropdown
    try {
      CTFD_COLS = readCtfdCols(PROJ.id);
      const ids = ['project','cred','team','user_points','team_points','user_last','team_last'];
      ids.forEach(cid=>{ const el = document.getElementById(`ctfd-col-${cid}`); if (el) el.checked = !!CTFD_COLS[cid]; });
    } catch {}
    renderCtfdTable(PROJ);
    try { ctfdCacheSnapshot('single'); } catch {}
    ctfdSetProgress(`Step 2/${totalSteps}: Initializing tooltips…`, 60, true);
    if (abortIfStale()) return;
    try {
      if (window.bootstrap) {
        document.querySelectorAll('#ctfd-table [data-bs-toggle="tooltip"]').forEach(el => {
          try { bootstrap.Tooltip.getOrCreateInstance(el); } catch {}
        });
      }
    } catch {}
    if (abortIfStale()) return;
    // Progressive per-user existence check with x/y
    const creds = Array.isArray(PROJ.credentials) ? PROJ.credentials : [];
    const usernames = creds.map(c => String(c?.username||'').trim()).filter(Boolean);
    const total = usernames.length;
    const sess = readCtfdCreds(PROJ.id)||{};
    const hasValidatedAuth = !!(sess?.validated && (sess.token || (sess.username && sess.password)));
    if (!hasValidatedAuth) {
      try { shell?.logInfo?.(`CTFd: skipping state refresh for ${PROJ.name || PROJ.id}; credentials not validated.`); } catch {}
      try { ctfdSetProgress('CTFd credentials not validated. Showing configuration only.', 95, false); } catch {}
      try { ctfdHideProgress(); } catch {}
      updateCtfdControlsEnabled();
      return;
    }
    const baseUrl = (PROJ.challenge_url||'').trim();
    const port = Number(PROJ.challenge_port||443);
    const verifyEl = document.getElementById('ctfd-verify-ssl');
    const verifySSL = verifyEl ? !!verifyEl.checked : true;
    const payloadBase = { baseUrl, port, token: sess.token||'', verifySSL };
    const metaMap = { ...(CTFD_USER_META||{}) };
    // Optimization: perform a single bulk users_check (omit 'only') instead of one request per username.
    // Fallback: if bulk fails, revert to legacy per-username loop to preserve functionality.
    let bulkSucceeded = false;
    if (total === 0) {
      ctfdSetProgress(`Step 3/${totalSteps}: No users to check`, 85, false);
    } else {
      ctfdSetProgress(`Step 3/${totalSteps}: Checking CTFd users (bulk)…`, 72, true);
      let animPct = 72;
      animTimer = setInterval(()=>{
        try {
          animPct = Math.min(animPct + 2, 88);
          ctfdSetProgress(`Step 3/${totalSteps}: Checking CTFd users (bulk)…`, animPct, true);
        } catch {}
      }, 500);
      try {
        let resp;
        await runQueued(`Check CTFd users for ${PROJ?.name || PROJ?.id || ''}`, async () => {
          resp = await http('POST', `/api/projects/${PROJ.id}/ctfd/users_check`, { ...payloadBase });
        }, { projectId: PROJ?.id });
        if (abortIfStale()) return;
        if (animTimer) { clearInterval(animTimer); animTimer = null; }
        if (resp && Object.prototype.hasOwnProperty.call(resp, 'category_firsts')) {
          categoryPayload = resp.category_firsts || {};
        }
        const list = Array.isArray(resp?.users) ? resp.users : [];
        list.forEach(u => {
          const uname = String(u?.username || '').trim();
          if (!uname) return;
          metaMap[uname] = {
            exists: !!u?.exists,
            user_rank: (u?.user_rank ?? null),
            user_points: (u?.user_points ?? null),
            team_name: (u?.team_name ?? null),
            team_rank: (u?.team_rank ?? null),
            team_points: (u?.team_points ?? null),
            user_id: (u?.user_id ?? null),
            team_id: (u?.team_id ?? null),
            user_last_solve_time: (u?.user_last_solve_time ?? null),
            user_last_solve_challenge: (u?.user_last_solve_challenge ?? null),
            team_captain: (u?.team_captain ?? null),
            team_size: (u?.team_size ?? null),
            team_last_solve_time: (u?.team_last_solve_time ?? null),
            team_last_solve_challenge: (u?.team_last_solve_challenge ?? null),
          };
        });
        bulkSucceeded = true;
        ctfdSetProgress(`Step 3/${totalSteps}: Users loaded (${list.length})`, 90, false);
      } catch(bulkErr){
        try { console.warn('CTFd users bulk check failed; falling back to per-user mode:', bulkErr); } catch {}
        if (animTimer) { try { clearInterval(animTimer); } catch {} animTimer = null; }
      }
      if (!bulkSucceeded) {
        if (abortIfStale()) return;
        // Legacy fallback loop
        let done = 0;
        const baseStart = 70, baseEnd = 90;
        const computePercent = () => { if (total <= 0) return baseEnd; const frac = Math.min(1, Math.max(0, done/total)); return Math.floor(baseStart + frac*(baseEnd-baseStart)); };
        ctfdSetProgress(`Step 3/${totalSteps}: Checking CTFd users (0/${total})…`, computePercent(), true);
        for (const name of usernames){
          if (abortIfStale()) return;
          try {
            let resp;
            await runQueued(`Check CTFd user ${name}`, async () => {
              resp = await http('POST', `/api/projects/${PROJ.id}/ctfd/users_check`, { ...payloadBase, only: [name] });
            }, { projectId: PROJ?.id });
            if (abortIfStale()) return;
            const list = Array.isArray(resp?.users) ? resp.users : [];
            if (!categoryPayload && resp && Object.prototype.hasOwnProperty.call(resp, 'category_firsts')) {
              categoryPayload = resp.category_firsts || {};
            }
            list.forEach(u => {
              const uname = String(u?.username || '').trim();
              if (!uname) return;
              metaMap[uname] = {
                exists: !!u?.exists,
                user_rank: (u?.user_rank ?? null),
                user_points: (u?.user_points ?? null),
                team_name: (u?.team_name ?? null),
                team_rank: (u?.team_rank ?? null),
                team_points: (u?.team_points ?? null),
                user_id: (u?.user_id ?? null),
                team_id: (u?.team_id ?? null),
                user_last_solve_time: (u?.user_last_solve_time ?? null),
                user_last_solve_challenge: (u?.user_last_solve_challenge ?? null),
                team_captain: (u?.team_captain ?? null),
                team_size: (u?.team_size ?? null),
                team_last_solve_time: (u?.team_last_solve_time ?? null),
                team_last_solve_challenge: (u?.team_last_solve_challenge ?? null),
              };
            });
          } catch(e){ /* continue */ }
          done += 1;
          ctfdSetProgress(`Step 3/${totalSteps}: Checking CTFd users (${done}/${total})…`, computePercent(), true);
        }
      }
    }
    if (abortIfStale()) return;
    ctfdApplyUserMeta(PROJ?.id, metaMap);
    if (categoryPayload !== null) {
      ctfdHandleCategoryFirsts(PROJ?.id, categoryPayload);
    }
    if (abortIfStale()) return;
    ctfdSetProgress(`Step 3/${totalSteps}: Applying updates…`, 95, false);
    renderCtfdTable(PROJ);
    ctfdSetProgress('Done', 100, false);
    if (abortIfStale()) return;
    try { await ctfdLoadSettings(); } catch {}
  } catch (e) {
    if (!aborted) {
      try { shell.logError(`CTFd Refresh failed: ${e?.message||e}`); } catch {}
    }
  } finally {
    if (animTimer) { try { clearInterval(animTimer); } catch {} }
    if (!aborted && loadToken === CTFD_LOAD_ACTIVE_TOKEN) {
      try { ctfdHideProgress(); } catch {}
      try { ctfdReschedulePeriodicForProject(PROJ?.id); } catch {}
    }
    updateCtfdControlsEnabled();
  }
}

// Preflight helper: ensure tokens/urls exist for each pid selected
async function ctfdPreflightPids(pids){
  try {
    await ctfdEnsureProjects(); const byId = {}; (CTFD_ALL_PROJECTS||[]).forEach(p=> byId[String(p.id)] = p);
    const missing = []; const invalid = [];
    for (const pid of pids){
      const proj = byId[String(pid)] || null; if (!proj) { invalid.push(String(pid)); continue; }
      const sess = readCtfdCreds(String(pid)) || {};
      const url = (proj.challenge_url||'').trim();
      if (!url) invalid.push(String(pid));
      if (!(sess && (sess.token || (sess.username && sess.password)) && sess.validated)) missing.push(String(pid));
    }
    return { ok: !(missing.length||invalid.length), missing, invalid };
  } catch { return { ok: true, missing: [], invalid: [] }; }
}

// Multi-project refresh path: bulk users_check per pid and merge
// opts: { suppressLoginModal?: boolean }
async function ctfdRefreshMulti(opts){
  const options = opts || {};
  const pids = Array.isArray(CTFD_SELECTED_PIDS)? CTFD_SELECTED_PIDS.slice(): [];
  if (!pids.length) return;
  const loadToken = options.loadToken || ++CTFD_LOAD_REQUEST_COUNTER;
  if (!options.loadToken) CTFD_LOAD_ACTIVE_TOKEN = loadToken;
  const basePid = String(options.basePid || ctfdCurrentPid() || '').trim();
  let aborted = false;
  const abortIfStale = () => {
    const newerLoad = loadToken !== CTFD_LOAD_ACTIVE_TOKEN;
    const selectionMoved = basePid ? ctfdSelectionChanged(basePid) : false;
    if (!newerLoad && !selectionMoved) return false;
    if (selectionMoved && !newerLoad) {
      try { ctfdHideProgress(); } catch {}
      updateCtfdControlsEnabled();
    }
    aborted = true;
    return true;
  };
  ctfdClearPeriodicTimer();
  if (abortIfStale()) return;
  try { ctfdSetProgress('Preparing multi-project refresh…', 10, true); } catch {}
  if (abortIfStale()) return;
  // Preflight credentials
  const pf = await ctfdPreflightPids(pids);
  if (abortIfStale()) return;
  if (!pf.ok) {
    try {
      // Render visible indicator with Fix Tokens button
      ctfdRenderSkippedIndicator([...(pf.invalid||[]), ...(pf.missing||[])], pf.missing?.length? 'invalid or missing token' : 'configuration issue');
      if (pf.invalid.length) shell.logWarn(`Projects missing CTFd URL: ${pf.invalid.join(', ')}`);
      // In auto-refresh mode, do not interrupt with login modal
      if (pf.missing.length && !options.suppressLoginModal) {
        try {
          const targets = Array.from(new Set((pf.missing||[]).map(pid => String(pid||'')).filter(Boolean)));
          if (targets.length > 0) {
            openCtfdLoginMultiForPids(targets);
          } else {
            openCtfdLoginModal();
          }
        } catch { openCtfdLoginModal(); }
      }
    } catch {}
    try { ctfdHideProgress(); } catch {}
    return;
  }
  if (abortIfStale()) return;
  // Clear any previous indicator
  try { ctfdRenderSkippedIndicator([], ''); } catch {}
  const metaMap = { ...(CTFD_USER_META||{}) };
  const failures = [];
  let done = 0; const total = pids.length;
  for (const pid of pids){
    if (abortIfStale()) return;
    try {
      const proj = (CTFD_ALL_PROJECTS||[]).find(p=> String(p.id)===String(pid)); if (!proj) { failures.push(pid); continue; }
      const sess = readCtfdCreds(String(pid)) || {};
      const baseUrl = (proj.challenge_url||'').trim(); const port = Number(proj.challenge_port||443);
      ctfdSetProgress(`Checking CTFd users for ${proj.name}…`, Math.min(90, 20 + Math.floor((done/Math.max(1,total))*70)), true);
      let resp;
      await runQueued(`CTFd multi-check users for ${proj.name || pid}`, async () => {
        resp = await http('POST', `/api/projects/${pid}/ctfd/users_check`, { baseUrl, port, token: sess.token||'', verifySSL: true });
      }, { projectId: pid });
      if (abortIfStale()) return;
      const list = Array.isArray(resp?.users) ? resp.users : [];
      if (resp && Object.prototype.hasOwnProperty.call(resp, 'category_firsts')) {
        ctfdHandleCategoryFirsts(pid, resp.category_firsts || {});
      }
      const projectMeta = {};
      list.forEach(u => {
        const uname = String(u?.username||'').trim();
        if (!uname) return;
        const entry = {
          exists: !!u?.exists,
          user_rank: (u?.user_rank ?? null),
          user_points: (u?.user_points ?? null),
          team_name: (u?.team_name ?? null),
          team_rank: (u?.team_rank ?? null),
          team_points: (u?.team_points ?? null),
          user_id: (u?.user_id ?? null),
          team_id: (u?.team_id ?? null),
          user_last_solve_time: (u?.user_last_solve_time ?? null),
          user_last_solve_challenge: (u?.user_last_solve_challenge ?? null),
          team_captain: (u?.team_captain ?? null),
          team_size: (u?.team_size ?? null),
          team_last_solve_time: (u?.team_last_solve_time ?? null),
          team_last_solve_challenge: (u?.team_last_solve_challenge ?? null),
        };
        projectMeta[uname] = entry;
        metaMap[uname] = entry;
      });
      ctfdDetectFirstPlaceChange(String(pid), projectMeta);
      ctfdDetectFirstScore(String(pid), projectMeta);
    } catch (e) { failures.push(pid); }
    done += 1;
  }
  if (abortIfStale()) return;
  ctfdApplyUserMeta('multi', metaMap);
  if (abortIfStale()) return;
  ctfdSetProgress('Applying updates…', 95, false);
  ctfdRenderTableMerged();
  try { ctfdCacheSnapshot('multi'); } catch {}
  ctfdSetProgress('Done', 100, false);
  if (abortIfStale()) return;
  // Minimal indicator via console for now; can add UI alert similar to Challenges page in a follow-up
  try {
    if (failures.length) {
      shell.logWarn(`Failed to load CTFd data for: ${failures.join(', ')}`);
      ctfdRenderSkippedIndicator(failures, 'connection or authentication');
    } else {
      ctfdRenderSkippedIndicator([], '');
    }
  } catch {}
  if (!aborted && loadToken === CTFD_LOAD_ACTIVE_TOKEN) {
    try { ctfdHideProgress(); } catch {}
  }
  // Refresh settings toggles for the currently focused project (if any & validated)
  if (!aborted) {
    try { if (PROJ) await ctfdLoadSettings(); } catch {}
  }
}

function ctfdSkippedKey(){
  const base = String(ctfdCurrentPid() || '').trim();
  return base ? `toolhub.ctfd.skipped.${base}` : 'toolhub.ctfd.skipped.global';
}

function ctfdReadSkipped(){
  try {
    const raw = sessionStorage.getItem(ctfdSkippedKey());
    if (!raw) return { projects: [], reason: '' };
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return { projects: [], reason: '' };
    const projects = Array.isArray(parsed.projects) ? parsed.projects.map(id => String(id)).filter(Boolean) : [];
    const reason = parsed.reason ? String(parsed.reason) : '';
    return { projects, reason };
  } catch { return { projects: [], reason: '' }; }
}

function ctfdWriteSkipped(projects, reason){
  try {
    const payload = { projects: (projects||[]).map(id => String(id)).filter(Boolean), reason: reason ? String(reason) : '' };
    sessionStorage.setItem(ctfdSkippedKey(), JSON.stringify(payload));
  } catch {}
}

function ctfdClearSkipped(){
  try { sessionStorage.removeItem(ctfdSkippedKey()); } catch {}
}

function ctfdRenderSkippedIndicatorRaw(pids, reason){
  try {
    const box = document.getElementById('ctfd-proj-errors');
    if (!box) return;
    if (!pids || pids.length === 0) { box.classList.add('d-none'); box.textContent = ''; return; }
    const byId = {}; (CTFD_ALL_PROJECTS||[]).forEach(p=> byId[String(p.id)] = p);
    const names = pids.map(id=> (byId[String(id)]?.name || String(id)) );
    box.innerHTML = `<div class="d-flex flex-wrap align-items-center gap-2"><div><strong>Some projects were skipped</strong>:</div><div>${names.map(n=>`<span class="badge bg-light text-dark me-1">${escHtml(n)}</span>`).join(' ')}</div><button id="ctfd-proj-errors-fix" type="button" class="btn btn-sm btn-outline-primary" title="Enter/Update tokens">Fix tokens</button></div><div class="mt-1">Reason: ${escHtml(reason||'credential or connection issue')}.</div>`;
    box.classList.remove('d-none');
    const btn = document.getElementById('ctfd-proj-errors-fix');
      if (btn && !btn._bound){
        btn._bound = true;
        btn.addEventListener('click', ()=>{
          try {
            // Prefer multi-token modal if multiple PIDs, otherwise fall back to single login
            if (pids && pids.length > 1) {
              openCtfdLoginMultiForPids(pids);
            } else {
              const targetPid = String(pids[0]||'');
              if (targetPid) {
                try { if (window.shell && shell.setCurrentProjectId) shell.setCurrentProjectId(targetPid); } catch {}
                try { ctfdLoadProjectConfig(targetPid); } catch {}
              }
              openCtfdLoginModal();
            }
          } catch {}
        });
      }
  } catch {}
}

function ctfdRenderSkippedIndicator(pids, reason){
  try {
    const list = Array.isArray(pids) ? Array.from(new Set(pids.map(id => String(id)).filter(Boolean))) : [];
    if (!list.length) {
      ctfdClearSkipped();
      ctfdRenderSkippedIndicatorRaw([], '');
      return;
    }
    ctfdWriteSkipped(list, reason || '');
    ctfdRenderSkippedIndicatorRaw(list, reason);
  } catch {}
}

function ctfdRestoreSkippedIndicator(){
  const state = ctfdReadSkipped();
  if (state.projects.length) ctfdRenderSkippedIndicatorRaw(state.projects, state.reason);
  else ctfdRenderSkippedIndicatorRaw([], '');
}

async function ctfdRefresh(){
  try {
    CTFD_ALLOW_LOAD = true;
    const target = PROJ && PROJ.id !== undefined ? PROJ.id : ctfdCurrentPid();
    if (!target) {
      try { shell.logWarn('CTFd refresh skipped: no project selected.'); } catch {}
      return;
    }
    await ctfdLoadProjectById(target);
  } catch(e){ console.error('CTFd refresh failed', e); }
}
// Ensure the Refresh button is a user action that enables loading
document.addEventListener('DOMContentLoaded', () => {
  try {
    const btn = document.getElementById('btn-ctfd-refresh');
    if (btn) btn.addEventListener('click', () => { CTFD_ALLOW_LOAD = true; });
  } catch {}
});

function openImportOptionsCTFd(){ // reuse VM modal logic simplified
  const input = document.getElementById('import-file');
  if(!input || !input.files || !input.files[0]) return;
  // Direct import (no specialized modal for now)
  importProjectSidebar();
}

// Sidebar create/import reuse from vm_manager.js if loaded; otherwise provide minimal fallbacks
async function createProjectSidebar(){
  const input = document.getElementById('proj-name'); const name = (input && input.value || '').trim(); if(!name) return alert('Enter a project name.');
  const res = await http('POST','/api/projects',{ name }); if(input) input.value=''; const pid = res && (res.id||res.pid);
  if(window.shell && shell.setCurrentProjectId) shell.setCurrentProjectId(pid);
  try { if(window.shell && shell.refreshSidebar) await shell.refreshSidebar('config'); } catch {}
  // Redirect to configuration page to display new project
  try { location.href = '/'; } catch {}
}
async function importProjectSidebar(){
  const input = document.getElementById('import-file'); if(!input||!input.files||!input.files[0]) return;
  const toggleBusy = (flag) => {
    try {
      if (window.shell && typeof shell.setSidebarImportBusy === 'function') {
        shell.setSidebarImportBusy(flag);
        return;
      }
    } catch {}
    try {
      input.disabled = !!flag;
      const label = input.closest('label');
      if (label) {
        label.classList.toggle('disabled', !!flag);
        if (flag) label.setAttribute('aria-disabled', 'true'); else label.removeAttribute('aria-disabled');
        label.style.pointerEvents = flag ? 'none' : '';
        label.style.opacity = flag ? '0.65' : '';
      }
    } catch {}
  };
  toggleBusy(true);
  try {
    const fd = new FormData(); fd.append('file', input.files[0]);
    const resp = await http('POST','/api/projects/import', fd); input.value='';
    const importedId = (resp && resp.id) || (resp && resp.imported && resp.imported[0] && resp.imported[0].id) || '';
    if(importedId && window.shell && shell.setCurrentProjectId) shell.setCurrentProjectId(importedId);
    if(window.shell && shell.refreshSidebar) await shell.refreshSidebar('vm');
  } catch(e){
    alert('Failed to import project: ' + (e && e.message ? e.message : 'Unknown error'));
    try { (window.shell && shell.logError) ? shell.logError('CTFd: import project failed: ' + (e && e.message ? e.message : e)) : console.error('CTFd import project failed:', e); } catch {}
  } finally {
    toggleBusy(false);
  }
  // Do not auto-load after import; user must press Refresh or add valid credentials
}

// Filter wiring
function wireCtfdFilter(){
  const input = document.getElementById('ctfd-filter');
  const reg = document.getElementById('ctfd-filter-regex');
  if(input){ input.addEventListener('input', ()=>{ CTFD_FILTER_TEXT = input.value.trim(); const err = document.getElementById('ctfd-filter-error'); if(err) err.classList.add('d-none'); if (PROJ) writeCtfdUiState(PROJ.id, { filterText: CTFD_FILTER_TEXT }); renderCtfdTable(PROJ); }); }
  if(reg){ reg.addEventListener('change', ()=>{ CTFD_FILTER_IS_REGEX = !!reg.checked; const err = document.getElementById('ctfd-filter-error'); if(err) err.classList.add('d-none'); if (PROJ) writeCtfdUiState(PROJ.id, { filterIsRegex: CTFD_FILTER_IS_REGEX }); renderCtfdTable(PROJ); }); }
}

// Initialization
document.addEventListener('DOMContentLoaded', async () => {
  try { shell.logDebug('CTFd: init DOMContentLoaded'); } catch {}
  await shell.initShell('vm'); // reuse same sidebar population logic
  // First try to restore previous in-session view so page switch won't blank the table
  try { if (ctfdRestoreSnapshot()) { updateCtfdControlsEnabled(); } } catch {}
  try { ctfdUpdateServerNavLinkForCurrent(); } catch {}
  wireCtfdFilter();
  wireCtfdLogin();
  wireCtfdCols();
  try { ctfdWireNotifyConfig(); } catch {}
  try { ctfdWireNotifyTemplateVarsModal(); } catch {}
  // Projects selector UI (does not alter single-project flow yet)
  try { await ctfdSetupProjectsUi(); } catch {}
  ctfdRestoreSkippedIndicator();
  // Auto-refresh wiring with pause/resume controls
  (function(){
    let timer = null;
    const pausedReasons = new Set();
    function isPaused(){ return pausedReasons.size > 0; }
    function key(){ try { return `toolhub.ctfd.mgr.auto.${PROJ?PROJ.id:'none'}`; } catch { return 'toolhub.ctfd.mgr.auto.none'; } }
    function readAuto(){ try { const v = sessionStorage.getItem(key()); return parseInt(v||'0',10)||0; } catch { return 0; } }
    function writeAuto(v){ try { sessionStorage.setItem(key(), String(v||0)); } catch {} }
    function hasAuth(){ try { const s = PROJ? readCtfdCreds(PROJ.id):{}; return !!(PROJ && s?.validated && (s.token || (s.username && s.password))); } catch { return false; } }
    function busy(){
      try {
        const wrap = document.getElementById('ctfd-progress');
        if (wrap && !wrap.classList.contains('d-none')) return true;
      } catch {}
      try {
        const m = document.getElementById('actionProgressModal');
        if (m && m.classList.contains('show')) return true;
      } catch {}
      return false;
    }
    function stopTimer(){ if (timer) { clearInterval(timer); timer = null; } }
    function setAutoBadge(state){
      try {
        const badge = document.getElementById('ctfd-auto-badge');
        if (!badge) return;
        if (state === 'off') { badge.textContent = 'Off'; badge.className = 'badge bg-secondary align-self-center ms-1'; return; }
        if (state === 'auth') { badge.textContent = 'Auth'; badge.className = 'badge bg-warning text-dark align-self-center ms-1'; return; }
        if (state === 'busy') { badge.textContent = 'Busy'; badge.className = 'badge bg-info text-dark align-self-center ms-1'; return; }
        if (state === 'paused') { badge.textContent = 'Pause'; badge.className = 'badge bg-dark align-self-center ms-1'; return; }
        if (state === 'on') { badge.textContent = 'On'; badge.className = 'badge bg-success align-self-center ms-1'; return; }
      } catch {}
    }
    function tick(){
      try {
        if (!PROJ) { setAutoBadge('off'); return; }
        if (!hasAuth()) { setAutoBadge('auth'); return; }
        if (busy()) { setAutoBadge('busy'); return; }
        setAutoBadge('on');
        CTFD_ALLOW_LOAD = true;
        CTFD_AUTO_REFRESH_ACTIVE = true;
        let task;
        try {
          if (Array.isArray(CTFD_SELECTED_PIDS) && CTFD_SELECTED_PIDS.length > 1) {
            task = ctfdRefreshMulti({ suppressLoginModal: true });
          } else {
            task = ctfdLoadProjectById(PROJ.id);
          }
        } catch (err) {
          CTFD_AUTO_REFRESH_ACTIVE = false;
          throw err;
        }
        Promise.resolve(task).catch(()=>{}).finally(()=>{ CTFD_AUTO_REFRESH_ACTIVE = false; });
      } catch {}
    }
    function apply(){
      stopTimer();
      const sel = document.getElementById('ctfd-auto-interval');
      const interval = parseInt(sel?.value||'0',10)||0;
      writeAuto(interval);
      if (interval <= 0) { setAutoBadge('off'); return; }
      if (isPaused()) { setAutoBadge('paused'); return; }
      if (!PROJ) { setAutoBadge('off'); return; }
      if (!hasAuth()) { setAutoBadge('auth'); }
      else if (busy()) { setAutoBadge('busy'); }
      else { setAutoBadge('on'); }
      timer = setInterval(tick, interval * 1000);
    }
    function pause(reason){ if (reason) pausedReasons.add(reason); stopTimer(); if (readAuto() > 0) setAutoBadge('paused'); }
    function resume(reason){ if (reason) pausedReasons.delete(reason); if (!isPaused()) apply(); }
    document.addEventListener('project-selected', (e)=>{
      try {
        const pid = e.detail || '';
        try { ctfdUpdateServerNavLinkForCurrent(); } catch {}
        ctfdStopCountdown(false);
        CTFD_LAST_CHALLENGES_STATE = null;
        CTFD_CHALLENGE_REVEAL_EXPECTED = false;
        if (pid) {
          try { ctfdLoadProjectConfig(pid); } catch {}
          try {
            ctfdMigrateSelectedToAssoc(pid);
            const assoc = ctfdReadAssoc(pid);
            CTFD_SELECTED_PIDS = (assoc && assoc.length) ? [String(pid), ...assoc.map(String)] : null;
            ctfdProjectsBadgeUpdate();
          } catch {}
        }
        const sel = document.getElementById('ctfd-auto-interval');
        if (sel) { const v = readAuto(); sel.value = String(v||0); }
        apply();
      } catch {}
    });
    try {
      const sel = document.getElementById('ctfd-auto-interval');
      if (sel) {
        const v = readAuto(); sel.value = String(v||0);
        sel.addEventListener('change', apply);
      }
      apply();
    } catch {}
    window.CTFD_AUTO_CTRL = { pause, resume, apply, isPaused };
  })();
  // Sort Missing Fields toggle removed; no initialization needed
  const apply = async (pid) => {
    if(!pid){ try { shell.logDebug('CTFd: apply called with empty pid'); } catch {} return; }
    try { try { shell.logInfo(`CTFd: loading project ${pid}`); } catch {} await ctfdLoadProjectById(pid); } catch(e){ try { shell.logError(`CTFd: load project failed: ${e?.message||e}`); } catch {} }
  };
  // Do not auto-load on initial page open or background selection changes.
  // Users should explicitly click a project or press Refresh to load.
  // Initialize controls so login button is clickable before project selection
  try { updateCtfdControlsEnabled(); } catch {}
  // If a project is already selected (via query or saved), render its config immediately
  try {
    const pid = (window.shell && shell.getCurrentProjectId) ? shell.getCurrentProjectId() : '';
    if (pid) {
      ctfdLoadProjectConfig(pid);
      // Also derive multi-selection for this base project
      try {
        ctfdMigrateSelectedToAssoc(pid);
        const assoc = ctfdReadAssoc(pid);
        CTFD_SELECTED_PIDS = (assoc && assoc.length) ? [String(pid), ...assoc.map(String)] : null;
        ctfdProjectsBadgeUpdate();
      } catch {}
      // Mirror VM Manager: perform a best-effort initial refresh on load (non-interrupting)
      try {
        CTFD_ALLOW_LOAD = true;
        if (Array.isArray(CTFD_SELECTED_PIDS) && CTFD_SELECTED_PIDS.length > 1) {
          ctfdRefreshMulti({ suppressLoginModal: true });
        } else {
          ctfdLoadProjectById(pid);
        }
      } catch {}
    }
  } catch {}
  // Wire settings toggles to updates
  try {
    const ch = document.getElementById('ctfd-toggle-chals');
    const sc = document.getElementById('ctfd-toggle-scoreboard');
    const pa = document.getElementById('ctfd-toggle-paused');
    if (ch) ch.addEventListener('change', () => ctfdUpdateSettings({ challenges_visible: !!ch.checked }));
    if (sc) sc.addEventListener('change', () => ctfdUpdateSettings({ scoreboard_visible: !!sc.checked }));
    if (pa) pa.addEventListener('change', () => ctfdUpdateSettings({ ctfd_paused: !!pa.checked }));
    // Initialize tooltips on the toggle controls
    if (window.bootstrap) {
      [ch, sc, pa].forEach(el => { if (el) { try { const wrap = el.closest('[data-bs-toggle="tooltip"]'); if (wrap) bootstrap.Tooltip.getOrCreateInstance(wrap); } catch {} } });
    }
  } catch {}
  // Sort Missing Fields tooltip removed
});

// --- CTFd Settings: load + update ---
async function ctfdLoadSettings(){
  if (!PROJ) return;
  const sess = readCtfdCreds(PROJ.id)||{};
  if(!(sess?.validated && (sess.token || (sess.username && sess.password)))) return;
  const baseUrl = (PROJ.challenge_url||'').trim();
  const port = Number(PROJ.challenge_port||443);
  const verifyEl = document.getElementById('ctfd-verify-ssl');
  const verifySSL = verifyEl ? !!verifyEl.checked : true;
  const payload = { baseUrl, port, token: sess.token||'', verifySSL };
  try {
    let res;
    await runQueued(`CTFd load settings for ${PROJ?.name || PROJ?.id || ''}`, async () => {
      res = await http('POST', `/api/projects/${PROJ.id}/ctfd/settings`, payload);
    }, { projectId: PROJ?.id });
    const st = res?.settings || {};
    const ch = document.getElementById('ctfd-toggle-chals');
    if (ch) {
      ch.checked = !!st.challenges_visible;
      ch.indeterminate = false;
      ch.removeAttribute('data-ctfd-pending-reveal');
    }
    const sc = document.getElementById('ctfd-toggle-scoreboard'); if (sc) sc.checked = !!st.scoreboard_visible;
    const pa = document.getElementById('ctfd-toggle-paused'); if (pa) pa.checked = !!st.ctfd_paused;
    const challengesVisible = !!st.challenges_visible;
    if (CTFD_LAST_CHALLENGES_STATE === null) {
      CTFD_LAST_CHALLENGES_STATE = challengesVisible;
    } else {
      ctfdHandleChallengesStateChange(challengesVisible);
    }
  } catch (e) {
    try { shell.logWarn(`CTFd settings load failed: ${e?.message||e}`); } catch {}
  }
}

async function ctfdUpdateSettings(updates){
  if (!PROJ) return;
  const sess = readCtfdCreds(PROJ.id)||{};
  if(!(sess?.validated && (sess.token || (sess.username && sess.password)))) return;
  const baseUrl = (PROJ.challenge_url||'').trim();
  const port = Number(PROJ.challenge_port||443);
  const verifyEl = document.getElementById('ctfd-verify-ssl');
  const verifySSL = verifyEl ? !!verifyEl.checked : true;
  const payload = { baseUrl, port, token: sess.token||'', verifySSL, ...updates };
  const statusEl = document.getElementById('ctfd-settings-status');
  const tgls = [document.getElementById('ctfd-toggle-chals'), document.getElementById('ctfd-toggle-scoreboard'), document.getElementById('ctfd-toggle-paused')];
  const chToggle = document.getElementById('ctfd-toggle-chals');
  // Temporarily disable toggles to prevent flapping
  try { tgls.forEach(el => { if (el) el.disabled = true; }); } catch {}
  const togglingChallenges = updates && Object.prototype.hasOwnProperty.call(updates, 'challenges_visible');
  const targetChallenges = togglingChallenges ? !!updates.challenges_visible : null;
  const lastChallengesVisible = !!CTFD_LAST_CHALLENGES_STATE;
  const shouldDelayReveal = togglingChallenges && targetChallenges === true && !lastChallengesVisible && ctfdCountdownNotificationActive();
  const shouldDelayHide = togglingChallenges && targetChallenges === false && lastChallengesVisible && ctfdCountdownStopNotificationActive();
  let countdownCuePlayed = true;
  if (shouldDelayReveal) {
    CTFD_CHALLENGE_REVEAL_IN_PROGRESS = true;
    CTFD_CHALLENGE_REVEAL_EXPECTED = true;
    CTFD_CHALLENGE_HIDE_EXPECTED = false;
    if (statusEl) { statusEl.textContent = 'Countdown cue…'; statusEl.className = 'small text-muted'; }
    if (chToggle) {
      chToggle.checked = false;
      chToggle.indeterminate = true;
      chToggle.setAttribute('data-ctfd-pending-reveal', '1');
    }
    try {
      await ctfdPlayCountdownCueForChallenges();
    } catch (err) {
      countdownCuePlayed = false;
      try { shell.logWarn(`[CTFd] Countdown cue failed: ${err?.message||err}`); } catch {}
    }
    if (!countdownCuePlayed) CTFD_CHALLENGE_REVEAL_EXPECTED = false;
  } else if (shouldDelayHide) {
    CTFD_CHALLENGE_REVEAL_IN_PROGRESS = true;
    CTFD_CHALLENGE_REVEAL_EXPECTED = false;
    CTFD_CHALLENGE_HIDE_EXPECTED = true;
    if (statusEl) { statusEl.textContent = 'Countdown stop…'; statusEl.className = 'small text-muted'; }
    if (chToggle) {
      chToggle.checked = true;
      chToggle.indeterminate = true;
      chToggle.setAttribute('data-ctfd-pending-reveal', '1');
    }
    let countdownStopPlayed = true;
    try {
      await ctfdPlayCountdownStopForChallenges();
    } catch (err) {
      countdownStopPlayed = false;
      try { shell.logWarn(`[CTFd] Countdown stop cue failed: ${err?.message||err}`); } catch {}
    }
    if (!countdownStopPlayed) CTFD_CHALLENGE_HIDE_EXPECTED = false;
  } else if (togglingChallenges && targetChallenges === false) {
    CTFD_CHALLENGE_REVEAL_EXPECTED = false;
    CTFD_CHALLENGE_HIDE_EXPECTED = false;
    if (chToggle) {
      chToggle.indeterminate = false;
      chToggle.removeAttribute('data-ctfd-pending-reveal');
    }
  }
  // Mark the update as in-flight once any pre-reveal cue has completed
  try { if (statusEl) { statusEl.textContent = 'Applying…'; statusEl.className = 'small text-muted'; } } catch {}
  try {
    let res;
    await runQueued(`CTFd update settings for ${PROJ?.name || PROJ?.id || ''}`, async () => {
      res = await http('POST', `/api/projects/${PROJ.id}/ctfd/settings/update`, payload);
    }, { projectId: PROJ?.id });
    const st = res?.settings || {};
    CTFD_CHALLENGE_REVEAL_IN_PROGRESS = false;
    const ch = document.getElementById('ctfd-toggle-chals');
    if (ch) {
      ch.checked = !!st.challenges_visible;
      ch.indeterminate = false;
      ch.removeAttribute('data-ctfd-pending-reveal');
    }
    const sc = document.getElementById('ctfd-toggle-scoreboard'); if (sc) sc.checked = !!st.scoreboard_visible;
    const pa = document.getElementById('ctfd-toggle-paused'); if (pa) pa.checked = !!st.ctfd_paused;
    ctfdHandleChallengesStateChange(!!st.challenges_visible);
    try {
      if (statusEl) { statusEl.textContent = 'Applied'; statusEl.className = 'small text-success'; setTimeout(()=>{ try{ statusEl.textContent=''; statusEl.className='small text-muted'; }catch{} }, 1200); }
    } catch {}
  } catch (e) {
    CTFD_CHALLENGE_REVEAL_IN_PROGRESS = false;
    CTFD_CHALLENGE_REVEAL_EXPECTED = false;
    CTFD_CHALLENGE_HIDE_EXPECTED = false;
    if (chToggle) {
      chToggle.indeterminate = false;
      chToggle.removeAttribute('data-ctfd-pending-reveal');
    }
    // Reload last-known-good
    try { await ctfdLoadSettings(); } catch {}
    try { shell.logError(`CTFd settings update failed: ${e?.message||e}`); } catch {}
    try { if (statusEl) { statusEl.textContent = 'Error'; statusEl.className = 'small text-danger'; setTimeout(()=>{ try{ statusEl.textContent=''; statusEl.className='small text-muted'; }catch{} }, 2000); } } catch {}
  }
  finally {
    // Re-enable toggles based on auth state
    CTFD_CHALLENGE_REVEAL_IN_PROGRESS = false;
    CTFD_CHALLENGE_REVEAL_EXPECTED = false;
    CTFD_CHALLENGE_HIDE_EXPECTED = false;
    try {
      if (chToggle) chToggle.indeterminate = false;
      updateCtfdControlsEnabled();
    } catch {}
  }
}

// --- CSV Download ---
function ctfdDownloadCsv(opts){
  try {
    const includePasswords = !!(opts && opts.includePasswords);
    const onlyVisible = !!(opts && opts.onlyVisible);
    const inst = Number(PROJ?.instances || 0);
    const creds = Array.isArray(PROJ?.credentials) ? PROJ.credentials : [];
    const header = [
      'Index','Username','Password','User Rank','User Points','User Last Solve Time','User Last Solve Challenge',
      'Team Name','Team Rank','Team Points','Team Captain','Team Size','Team Last Solve Time','Team Last Solve Challenge'
    ];
    const rows = [];
    const indices = onlyVisible && Array.isArray(CTFD_LAST_VISIBLE_INDICES) && CTFD_LAST_VISIBLE_INDICES.length
      ? CTFD_LAST_VISIBLE_INDICES
      : Array.from({length: inst}, (_,k)=>k+1);
    for (const i of indices) {
      const cred = creds[i-1] || {};
      const uname = (cred.username ?? '').trim();
      const pword = cred.password ?? '';
      const meta = (uname && CTFD_USER_META[uname]) ? CTFD_USER_META[uname] : {};
      rows.push([
        i,
        uname,
        includePasswords ? pword : '',
        meta?.user_rank ?? '',
        meta?.user_points ?? '',
        meta?.user_last_solve_time ?? '',
        meta?.user_last_solve_challenge ?? '',
        meta?.team_name ?? '',
        meta?.team_rank ?? '',
        meta?.team_points ?? '',
        meta?.team_captain ?? '',
        meta?.team_size ?? '',
        meta?.team_last_solve_time ?? '',
        meta?.team_last_solve_challenge ?? '',
      ]);
    }
    const escapeCsv = (v)=>{
      const s = String(v==null?'':v);
      if (/[",\n]/.test(s)) return '"'+s.replace(/"/g,'""')+'"';
      return s;
    };
    const csv = [header.map(escapeCsv).join(','), ...rows.map(r=>r.map(escapeCsv).join(','))].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const projName = (PROJ?.name || 'ctfd').replace(/[^A-Za-z0-9_-]+/g,'_');
    a.href = url; a.download = `${projName}_ctfd_data.csv`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
  } catch (e) { try { shell.logError(`CSV download failed: ${e?.message||e}`);} catch {} }
}

function openCtfdDownloadModal(){
  const el = document.getElementById('ctfdDownloadModal'); if(!el || !window.bootstrap) return; const m = new bootstrap.Modal(el); m.show();
}

function confirmCtfdDownload(){
  try {
    const inc = document.getElementById('ctfd-dl-include-passwords');
    const vis = document.getElementById('ctfd-dl-only-visible');
    ctfdDownloadCsv({ includePasswords: !!(inc && inc.checked), onlyVisible: !!(vis && vis.checked) });
  } catch {}
  try {
    const el = document.getElementById('ctfdDownloadModal'); if(el && window.bootstrap){ const m=bootstrap.Modal.getInstance(el); if(m) m.hide(); }
  } catch {}
}

// --- CTFd session creds management ---
function ctfdCredKey(pid){ return `toolhub.session.ctfd.${pid}`; }
function readCtfdCreds(pid){ try { return JSON.parse(sessionStorage.getItem(ctfdCredKey(pid))||'{}'); } catch { return {}; } }
function writeCtfdCreds(pid, obj){
  try {
    sessionStorage.setItem(ctfdCredKey(pid), JSON.stringify({
      username: obj.username||'',
      password: obj.password||'',
      token: obj.token||'',
      validated: !!obj.validated,
    }));
    // Also persist a same-origin cookie so popups can read creds without window.opener
    try {
      const name = ctfdCredKey(pid);
      const payload = encodeURIComponent(JSON.stringify({ token: obj.token||'', validated: !!obj.validated }));
      const secure = (location.protocol === 'https:') ? '; Secure' : '';
      // Session cookie (no Max-Age) with SameSite=Lax for same-site requests
      document.cookie = `${name}=${payload}; Path=/; SameSite=Lax${secure}`;
    } catch {}
  } catch {}
}

function deleteCtfdCreds(pid){
  try { sessionStorage.removeItem(ctfdCredKey(pid)); } catch {}
  try {
    const name = ctfdCredKey(pid);
    const secure = (location.protocol === 'https:') ? '; Secure' : '';
    // Expire cookie immediately
    document.cookie = `${name}=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; SameSite=Lax${secure}`;
  } catch {}
}
function normalizeUrl(s){ if (!s) return ''; return /^https?:\/\//i.test(s) ? s : `https://${s}`; }
function updateCtfdControlsEnabled(){
  const btnLogin = document.getElementById('btn-ctfd-login');
  const refresh = document.getElementById('btn-ctfd-refresh');
  const wrap = document.getElementById('ctfd-refresh-wrapper');
  const usersBtn = document.getElementById('act-ctf-users');
  const statsBtn = document.getElementById('act-ctf-stats');
  const dlBtn = document.getElementById('ctfd-download');
  const activePid = PROJ?.id !== undefined ? PROJ.id : ctfdCurrentPid();
  const sess = activePid ? readCtfdCreds(activePid) : {};
  // Only enable controls when credentials have been validated
  const hasAuth = !!(activePid && sess?.validated && ((sess?.username && sess?.password) || sess?.token));
  const singleReady = !!PROJ && hasAuth;
  const multi = Array.isArray(CTFD_SELECTED_PIDS) && CTFD_SELECTED_PIDS.length > 1;
  if (btnLogin) {
    btnLogin.setAttribute('title', multi ? 'Update CTFd creds for all selected projects' : 'Set CTFd URL/port and token');
  }
  // Refresh is allowed in multi mode (we'll preflight per-pid) or when single-project auth is valid
  const refreshEnabled = (multi || hasAuth);
  if (refresh) refresh.disabled = !refreshEnabled;
  // Users actions: enabled if single-project auth OR multi-project mode (we'll preflight each pid)
  if (usersBtn) usersBtn.disabled = !(singleReady || (Array.isArray(CTFD_SELECTED_PIDS) && CTFD_SELECTED_PIDS.length > 1));
  if (statsBtn) statsBtn.disabled = !singleReady;
  if (dlBtn) dlBtn.disabled = !singleReady;
  // Toggle config-only notice visibility based on auth
  try {
    const notice = document.getElementById('ctfd-config-only-alert');
    if (notice) {
      if (hasAuth) { notice.classList.add('d-none'); notice.setAttribute('aria-hidden','true'); }
      else { notice.classList.remove('d-none'); notice.removeAttribute('aria-hidden'); }
    }
  } catch {}
  if (wrap && window.bootstrap) {
    const tip = bootstrap.Tooltip.getInstance(wrap) || new bootstrap.Tooltip(wrap);
    if (refreshEnabled) {
      try { tip.hide(); } catch {}
      tip.disable();
      ['title','data-bs-original-title','aria-label'].forEach(attr => wrap.removeAttribute(attr));
      wrap.removeAttribute('tabindex');
    } else {
      tip.enable();
      wrap.setAttribute('tabindex','0');
      wrap.setAttribute('title','Please set a CTFd API token first.');
      wrap.setAttribute('data-bs-original-title','Please set a CTFd API token first.');
    }
  }
  // Download button tooltip behavior mirrors refresh tooltip
  if (dlBtn && window.bootstrap) {
    const tip = bootstrap.Tooltip.getInstance(dlBtn) || new bootstrap.Tooltip(dlBtn);
    if (hasAuth) {
      try { tip.hide(); } catch {}
      tip.disable();
      ['title','data-bs-original-title','aria-label'].forEach(attr => dlBtn.removeAttribute(attr));
    } else {
      tip.enable();
      dlBtn.setAttribute('title','Please set a CTFd API token first.');
      dlBtn.setAttribute('data-bs-original-title','Please set a CTFd API token first.');
    }
  }
  // Settings toggles enablement
  const ch = document.getElementById('ctfd-toggle-chals');
  const sc = document.getElementById('ctfd-toggle-scoreboard');
  const pa = document.getElementById('ctfd-toggle-paused');
  [ch, sc, pa].forEach(el => { if (el) el.disabled = !singleReady; });
}
async function handleCtfdLoginClick(ev){
  try { ev?.preventDefault?.(); } catch {}
  const selection = Array.isArray(CTFD_SELECTED_PIDS) ? CTFD_SELECTED_PIDS : [];
  const unique = Array.from(new Set(selection.map(pid => String(pid||'')).filter(Boolean)));
  if (unique.length > 1) {
    try { await ctfdEnsureProjects(); } catch {}
    return openCtfdLoginMultiForPids(unique);
  }
  return openCtfdLoginModal();
}
// Ensure login button opens modal and tooltip is initialized
function wireCtfdLogin(){
  const btn = document.getElementById('btn-ctfd-login');
  if (btn && !btn._toolhubBound) {
    btn.addEventListener('click', handleCtfdLoginClick);
    btn._toolhubBound = true;
  }
  const wrap = document.getElementById('ctfd-refresh-wrapper');
  if (wrap && window.bootstrap) { try { new bootstrap.Tooltip(wrap); } catch {} }
}
// Stats menu handler: fetch quick info like Challenges list or current User
async function ctfdStats(kind){
  if(!PROJ) return;
  const sess = readCtfdCreds(PROJ.id)||{};
  if(!(sess?.validated && (sess.token || (sess.username && sess.password)))){
    return alert('Please set a CTFd API token first.');
  }
  const baseUrl = (PROJ.challenge_url||'').trim();
  const port = Number(PROJ.challenge_port||443);
  const verifyEl = document.getElementById('ctfd-verify-ssl');
  const verifySSL = verifyEl ? !!verifyEl.checked : true;
  try {
    shell.beginActionContext('CTFd Stats');
    showActionProgress('CTFd Stats', 'Fetching…');
    updateActionProgress(25, 'Submitting…');
    if (kind === 'challenges'){
      let res;
      await runQueued(`CTFd stats challenges`, async () => {
        res = await http('POST', `/api/ctfd/challenges`, { baseUrl, token: sess.token||'' });
      }, { projectId: PROJ?.id });
      updateActionProgress(80, 'Processing…');
      const items = Array.isArray(res?.challenges) ? res.challenges : [];
      const rows = items.map(c => `<tr><td>${escHtml(String(c?.id??''))}</td><td>${escHtml(String(c?.name??''))}</td><td>${escHtml(String(c?.category??''))}</td><td>${escHtml(String(c?.value??''))}</td></tr>`).join('');
      const table = `<div class="table-responsive"><table class="table table-sm"><thead><tr><th>ID</th><th>Name</th><th>Category</th><th>Value</th></tr></thead><tbody>${rows||'<tr><td colspan="4" class="text-muted">No challenges</td></tr>'}</tbody></table></div>`;
      showActionSummary('CTFd Challenges', `<div class="mb-2">Total: <strong>${items.length}</strong></div>${table}`);
      shell.endActionContext(true);
    } else if (kind === 'user'){
      let res;
      await runQueued(`CTFd stats user for ${PROJ?.name || PROJ?.id || ''}`, async () => {
        res = await http('POST', `/api/projects/${PROJ.id}/ctfd/login`, { baseUrl, port, token: sess.token||'', verifySSL });
      }, { projectId: PROJ?.id });
      updateActionProgress(80, 'Processing…');
      const me = res?.me || {};
      const pre = `<pre class="small bg-light p-2 border rounded" style="max-height:300px;overflow:auto;">${escHtml(JSON.stringify(me, null, 2))}</pre>`;
      showActionSummary('CTFd Current User', pre);
      shell.endActionContext(true);
    } else {
      updateActionProgress(100, 'Unknown stat');
      showActionSummary('CTFd Stats', '<div class="text-muted">Unknown option.</div>');
      shell.endActionContext(false);
    }
  } catch(e){
    showActionSummary('CTFd Stats', `<div class="text-danger">${escHtml(e?.message||e)}</div>`);
    try { shell.endActionContext(false); } catch {}
  } finally {
    try { updateActionProgress(100, 'Done'); hideActionProgress(); } catch {}
  }
}
async function openCtfdLoginModal(){ const el = document.getElementById('ctfdLoginModal'); if(!el || !window.bootstrap) return; const m = new bootstrap.Modal(el); // prefill
  try {
    const url = document.getElementById('ctfd-url');
    const port = document.getElementById('ctfd-port');
    const tokenEl = document.getElementById('ctfd-token');
    const fb = document.getElementById('ctfd-login-feedback');
    // Ensure fields reflect current project's Configuration values even if we haven't fully loaded CTFd data yet
    try {
      const pid = (window.shell && shell.getCurrentProjectId) ? shell.getCurrentProjectId() : '';
      if (pid && (!PROJ || PROJ.id !== pid)) {
        // Load lightweight config to prefill, without contacting CTFd (no await inside non-async)
        ctfdLoadProjectConfig(pid);
      }
    } catch {}
    if(PROJ){ if(url) url.value = PROJ.challenge_url || ''; if(port) port.value = PROJ.challenge_port ?? 443; }
    const sess = PROJ? readCtfdCreds(PROJ.id) : {};
    if(tokenEl) tokenEl.value = sess.token || '';
    // Load project-saved token if session empty
    try {
      if (PROJ && tokenEl && !tokenEl.value) {
        try {
          if (window.CREDS && typeof CREDS.fetchProjectSecrets === 'function') {
            await CREDS.fetchProjectSecrets(PROJ.id);
          }
        } catch {}

        let persisted = '';
        try {
          if (window.CREDS && typeof CREDS.readPersistCtfdToken === 'function') {
            persisted = CREDS.readPersistCtfdToken(PROJ.id) || '';
          }
        } catch {}
        if (persisted) {
          tokenEl.value = persisted;
          const chk = document.getElementById('ctfd-save-creds'); if (chk) chk.checked = true;
        } else {
          const chk = document.getElementById('ctfd-save-creds'); if (chk) chk.checked = false;
        }
      }
    } catch {}
    if (fb) { fb.textContent = ''; fb.className = 'me-auto small'; }
  } catch {}
  m.show();
}
async function saveCtfdCredsFromModal(){
  try {
    if (isCtfdLoginBusy()) return;
    const url = document.getElementById('ctfd-url')?.value.trim();
    const port = Number(document.getElementById('ctfd-port')?.value || 443);
    const token = document.getElementById('ctfd-token')?.value.trim() || '';
    const verify = !!document.getElementById('ctfd-verify-ssl')?.checked;
    const fb = document.getElementById('ctfd-login-feedback');
    if(PROJ){
      setCtfdLoginBusy(true);
      // Save project-side URL/port if changed
      const norm = normalizeUrl(url);
      const patch = {};
      if(norm && norm !== (PROJ.challenge_url||'')) patch['challenge_url'] = norm;
      if(port && port !== Number(PROJ.challenge_port||0)) patch['challenge_port'] = port;
  if(Object.keys(patch).length){ await http('PATCH', `/api/projects/${PROJ.id}`, patch); }
  // Save token in session storage (not yet validated)
  writeCtfdCreds(PROJ.id, { username: '', password: '', token, validated: false });
      try {
        const saveBox = document.getElementById('ctfd-save-creds');
        const wantsPersist = !!(saveBox && saveBox.checked);
        if (window.CREDS && typeof CREDS.setPersistCtfdToken === 'function') {
          await CREDS.setPersistCtfdToken(PROJ.id, token, wantsPersist);
        }
      } catch {}
      updateCtfdControlsEnabled();
  // Provide status feedback and attempt a server-side token "login" (validation)
      if (fb) { fb.textContent = 'Validating API token…'; fb.className = 'me-auto small text-muted'; }
      try {
        let res;
        await runQueued(`CTFd login for ${PROJ?.name || PROJ?.id || ''}`, async () => {
          res = await http('POST', `/api/projects/${PROJ.id}/ctfd/login`, { baseUrl: normalizeUrl(url), port, token, verifySSL: verify });
        }, { projectId: PROJ?.id });
        try {
          const logs = Array.isArray(res?.logs) ? res.logs : [];
          logs.forEach(l => {
            try {
              const urlStr = String(l?.url || '');
              const isMe = (l?.event === 'request') && (l?.method === 'GET') && urlStr.endsWith('/api/v1/users/me');
              if (isMe) {
                const authVal = l?.headers?.Authorization ?? null;
                const minimal = { method: 'GET', url: urlStr, headers: { Authorization: authVal } };
                shell.logDebug(`[CTFd] request: ${JSON.stringify(minimal)}`);
              } else {
                shell.logDebug(`[CTFd] ${l.event}: ${JSON.stringify(l)}`);
              }
            } catch {}
          });
          if (typeof res?.using_token !== 'undefined') { try { shell.logInfo(`[CTFd] auth mode: using_token=${!!res.using_token}`); } catch {} }
        } catch {}
        if (res && res.ok) {
          // Mark as validated and enable controls
          writeCtfdCreds(PROJ.id, { username: '', password: '', token, validated: true });
          // token persistence already handled above
          // Enable all CTFd action controls now that auth is confirmed (including Stats)
          try {
            const statsBtn = document.getElementById('act-ctf-stats'); if (statsBtn) statsBtn.disabled = false;
            const usersBtn = document.getElementById('act-ctf-users'); if (usersBtn) usersBtn.disabled = false;
            const dlBtn = document.getElementById('ctfd-download'); if (dlBtn) dlBtn.disabled = false;
            const refreshBtn = document.getElementById('btn-ctfd-refresh'); if (refreshBtn) refreshBtn.disabled = false;
          } catch {}
          updateCtfdControlsEnabled();
          if (fb) { fb.textContent = 'API token verified. Updating status…'; fb.className = 'me-auto small text-success'; }
          // After successful validation, allow and perform a full load
          try {
            CTFD_ALLOW_LOAD = true;
            // If multi-project selection is active, attempt a multi refresh; else load single project
            if (Array.isArray(CTFD_SELECTED_PIDS) && CTFD_SELECTED_PIDS.length > 1) {
              await ctfdRefreshMulti();
            } else {
              await ctfdLoadProjectById(PROJ.id);
            }
          } catch {}
          // Hide modal after a short delay to allow the user to see success
          setTimeout(() => {
            try {
              const el = document.getElementById('ctfdLoginModal');
              if(el && window.bootstrap){ const m=bootstrap.Modal.getInstance(el); if(m) m.hide(); }
            } catch {}
            if (fb) { fb.textContent = ''; fb.className = 'me-auto small'; }
            setCtfdLoginBusy(false);
          }, 500);
          return; // exit after success
        } else {
          const msg = (res && res.error) ? String(res.error) : 'Login failed';
          if (fb) { fb.textContent = msg; fb.className = 'me-auto small text-danger'; }
          // Clear stored session creds on failure
          try { sessionStorage.removeItem(ctfdCredKey(PROJ.id)); } catch {}
          updateCtfdControlsEnabled();
          setCtfdLoginBusy(false);
          return;
        }
      } catch (e) {
        let msg = String(e?.message || e || 'Login failed');
        // If backend bubbled HTML or 403, provide a helpful hint about base URL
        try {
          if (/403/.test(msg) || /<!DOCTYPE html>/i.test(msg)) {
            msg = msg + ' — Hint: ensure the CTFd Base URL is the site root (e.g., https://ctf.example.edu) without a path, and that Verify SSL matches your server.';
          }
        } catch {}
        if (fb) { fb.textContent = 'Login failed: ' + msg; fb.className = 'me-auto small text-danger'; }
        try { deleteCtfdCreds(PROJ.id); } catch {}
        updateCtfdControlsEnabled();
        setCtfdLoginBusy(false);
        return;
      }
    }
    const el = document.getElementById('ctfdLoginModal'); if(el && window.bootstrap){ const m=bootstrap.Modal.getInstance(el); if(m) m.hide(); }
  } catch(e){
    console.error('Failed to save CTFd creds', e);
    try {
      const fb=document.getElementById('ctfd-login-feedback');
      if(fb){ fb.textContent='Save failed'; fb.className='me-auto small text-danger'; }
    } catch{}
    setCtfdLoginBusy(false);
  }
}

// --- Multi-project CTFd login modal ---
function openCtfdLoginMultiForPids(pids){
  try {
    const listEl = document.getElementById('ctfd-multi-creds-list');
    if (!listEl) return;
    const byId = {}; (CTFD_ALL_PROJECTS||[]).forEach(p=> byId[String(p.id)] = p);
    const items = (pids||[]).map(pid => {
      const proj = byId[String(pid)];
      if (!proj) return '';
      const sess = readCtfdCreds(String(pid)) || {};
      const url = proj.challenge_url || '';
      const port = Number(proj.challenge_port||443);
      // Use project-saved token (if already cached) when session token absent
      let persistedToken = '';
      if (!sess.token) {
        try {
          if (window.CREDS && typeof CREDS.readPersistCtfdToken === 'function') {
            persistedToken = String(CREDS.readPersistCtfdToken(String(pid)) || '');
          }
        } catch {}
      }
      const tokenValue = sess.token || persistedToken || '';
      return `<div class=\"card\"><div class=\"card-body\">`
        + `<div class=\"mb-2\"><strong>${escHtml(proj.name||String(pid))}</strong><div class=\"small text-muted\">${escHtml(proj.tag||'')}</div></div>`
        + `<div class=\"row g-2\">`
        + `<div class=\"col-md-6\"><label class=\"form-label\">CTFd URL</label><input class=\"form-control\" data-pid=\"${pid}\" data-field=\"url\" value=\"${escHtml(url)}\" placeholder=\"https://ctfd.example.com\" /></div>`
        + `<div class=\"col-md-3\"><label class=\"form-label\">Port</label><input type=\"number\" class=\"form-control\" data-pid=\"${pid}\" data-field=\"port\" value=\"${port}\" /></div>`
  + `<div class=\"col-md-12\"><label class=\"form-label\">API Token</label><div class=\"input-group\"><input type=\"password\" class=\"form-control\" data-pid=\"${pid}\" data-field=\"token\" value=\"${escHtml(tokenValue)}\" placeholder=\"ctfd_...\" /><button class=\"btn btn-outline-secondary\" type=\"button\" data-act=\"toggle-visible\" title=\"Show\">\u{1F576}\u{FE0E}</button></div></div>`
        + `</div>`
        + `</div></div>`;
    }).filter(Boolean).join('');
    listEl.innerHTML = items || '<div class=\"text-muted\">No projects selected.</div>';
    const el = document.getElementById('ctfdLoginMultiModal'); if (!el || !window.bootstrap) return; const m = new bootstrap.Modal(el); m.show();
    // After showing, fetch server secrets to prefill empty token inputs
    try {
      if (window.CREDS && typeof CREDS.fetchProjectSecrets === 'function') {
        (pids||[]).forEach(pid => {
          try {
            CREDS.fetchProjectSecrets(String(pid)).then(()=>{
              try {
                const t = (window.CREDS && typeof CREDS.readPersistCtfdToken === 'function') ? (CREDS.readPersistCtfdToken(String(pid)) || '') : '';
                const inp = document.querySelector(`#ctfd-multi-creds-list [data-pid="${CSS.escape(String(pid))}"][data-field="token"]`);
                if (inp && !inp.value && t) inp.value = t;
              } catch {}
            }).catch(()=>{});
          } catch {}
        });
      }
    } catch {}
    const btn = document.getElementById('btn-ctfd-multi-save');
    if (btn && !btn._bound) {
      btn._bound = true;
      btn.addEventListener('click', async ()=>{
        if (btn.dataset.busyState === '1') return;
        setCtfdMultiLoginBusy(true);
        const fb = document.getElementById('ctfd-multi-login-feedback');
        try {
          if (fb) { fb.textContent = 'Validating…'; fb.className = 'me-auto small text-muted'; }
          const persist = !!document.getElementById('ctfd-multi-save-creds')?.checked;
          const cards = Array.from(document.querySelectorAll('#ctfd-multi-creds-list [data-pid][data-field]'));
          // Build map pid -> {url, port, token}
          const map = new Map();
          cards.forEach(inp => {
            const pid = String(inp.getAttribute('data-pid'));
            const field = String(inp.getAttribute('data-field'));
            const val = inp.value || '';
            if (!map.has(pid)) map.set(pid, { url:'', port:443, token:'' });
            const obj = map.get(pid);
            if (field==='url') obj.url = val;
            else if (field==='port') obj.port = Number(val||443);
            else if (field==='token') obj.token = val;
          });
          // Validate each via backend login
          let okCount = 0; let failCount = 0;
          for (const [pid, obj] of map.entries()){
            try {
              // Save URL/port to the project if changed
              const proj = (CTFD_ALL_PROJECTS||[]).find(p=> String(p.id)===String(pid));
              const normUrl = normalizeUrl(obj.url||'');
              const patch = {};
              if (proj) {
                if (normUrl && normUrl !== (proj.challenge_url||'')) patch['challenge_url'] = normUrl;
                if (obj.port && obj.port !== Number(proj.challenge_port||0)) patch['challenge_port'] = obj.port;
              }
              if (proj && Object.keys(patch).length) {
                await http('PATCH', `/api/projects/${pid}`, patch);
              }
              // Optimistically write creds then validate
              writeCtfdCreds(String(pid), { username:'', password:'', token: obj.token||'', validated:false });
              let res;
              await runQueued(`CTFd multi-login for project ${pid}`, async () => {
                res = await http('POST', `/api/projects/${pid}/ctfd/login`, { baseUrl: normUrl, port: Number(obj.port||443), token: obj.token||'', verifySSL: true });
              }, { projectId: pid });
              if (res && res.ok) {
                writeCtfdCreds(String(pid), { username:'', password:'', token: obj.token||'', validated:true });
                okCount += 1;
                try {
                  if (window.CREDS && typeof CREDS.setPersistCtfdToken === 'function') {
                    await CREDS.setPersistCtfdToken(String(pid), obj.token||'', persist);
                  }
                } catch {}
              } else { failCount += 1; }
            } catch { failCount += 1; }
          }
          try {
            if (fb) {
              if (failCount===0) { fb.textContent = `Saved ${okCount} token(s)`; fb.className = 'me-auto small text-success'; }
              else { fb.textContent = `Saved ${okCount}, ${failCount} failed`; fb.className = 'me-auto small text-warning'; }
            }
          } catch {}
          // Re-evaluate control enablement (Stats, Users, Download, Refresh) now that tokens may be validated
          try { updateCtfdControlsEnabled(); } catch {}
          // Auto-retry: if multi selection, run multi refresh
          try {
            if (Array.isArray(CTFD_SELECTED_PIDS) && CTFD_SELECTED_PIDS.length > 1) {
              CTFD_ALLOW_LOAD = true;
              await ctfdRefreshMulti();
            }
          } catch {}
          // Close after short delay
          setTimeout(()=>{
            try {
              const el = document.getElementById('ctfdLoginMultiModal'); if (el && window.bootstrap) { const m = bootstrap.Modal.getInstance(el); if (m) m.hide(); }
            } catch {}
            try { if (fb) { fb.textContent=''; fb.className='me-auto small'; } } catch {}
            setCtfdMultiLoginBusy(false);
          }, 500);
        } catch (err) {
          try {
            if (fb) { fb.textContent = `Save failed: ${err?.message || err || 'Unknown error'}`; fb.className = 'me-auto small text-danger'; }
          } catch {}
          setCtfdMultiLoginBusy(false);
        }
      });
    }
  } catch {}
}

// --- Actions ---
async function ctfdAction(kind){
  // If multi-project selection is active, run grouped multi-project action
  try {
    if (Array.isArray(CTFD_SELECTED_PIDS) && CTFD_SELECTED_PIDS.length > 1) {
      return await ctfdActionMulti(kind);
    }
  } catch {}
  if(!PROJ) return;
  const sess = readCtfdCreds(PROJ.id)||{};
  if(!(sess?.validated && (sess.token || (sess.username && sess.password)))){
    return alert('Please set a CTFd API token first.');
  }
  const baseUrl = (PROJ.challenge_url||'').trim();
  const port = Number(PROJ.challenge_port||443);
  const verifyEl = document.getElementById('ctfd-verify-ssl');
  const verifySSL = verifyEl ? !!verifyEl.checked : true;
  // If any credentials are selected, build an 'only' list of usernames for those instance indices
  let only = undefined;
  try {
    if (CTFD_SELECTED_INDICES && CTFD_SELECTED_INDICES.size > 0) {
      const indices = new Set(CTFD_SELECTED_INDICES);
      const creds = Array.isArray(PROJ.credentials) ? PROJ.credentials : [];
      const names = [];
      indices.forEach(i => { const c = creds[i-1]; if (c && c.username) names.push(String(c.username)); });
      if (names.length > 0) only = names;
    }
  } catch {}
  const payload = { baseUrl, port, token: sess.token, verifySSL, ...(only?{ only }: {}) };
  // Disable relevant controls during action
  const usersBtn = document.getElementById('act-ctf-users');
  const refreshBtn = document.getElementById('btn-ctfd-refresh');
  const loginBtn = document.getElementById('btn-ctfd-login');
  try {
    if (usersBtn) usersBtn.disabled = true;
    if (refreshBtn) refreshBtn.disabled = true;
    if (loginBtn) loginBtn.disabled = true;
  } catch {}
  try {
    let title = '';
    if (kind === 'users_create') title = 'CTFd Users Create';
    else if (kind === 'users_delete') title = 'CTFd Users Delete';
  else if (kind === 'upload') title = 'CTFd Upload';
  else title = 'CTFd Action';
    shell.beginActionContext(title);
    // Progress modal start
    showActionProgress(title, kind === 'users_create' ? 'Creating users…' : (kind === 'users_delete' ? 'Deleting users…' : 'Working…'));
    updateActionProgress(10, 'Submitting…');
  if (kind === 'users_create'){
      let res;
      await runQueued(`CTFd create users for ${PROJ?.name || PROJ?.id || ''}`, async () => {
        res = await http('POST', `/api/projects/${PROJ.id}/ctfd/users_create`, payload);
      }, { projectId: PROJ?.id });
      try {
        const logs = Array.isArray(res?.logs) ? res.logs : [];
        logs.forEach(l => { try { shell.logDebug(`[CTFd] ${l.event}: ${JSON.stringify(l)}`); } catch {} });
        if (typeof res?.using_token !== 'undefined') { try { shell.logInfo(`[CTFd] auth mode: using_token=${!!res.using_token}`); } catch {} }
      } catch {}
      if (res && res.ok === false && res.error) {
        try { shell.logError(`CTFd users create: ${res.error}`); } catch {}
      }
      // Logs per-result
      try {
        const results = Array.isArray(res?.results) ? res.results : [];
        results.forEach(r => {
          const u = r?.username || '';
          if (r?.action === 'created') shell.logSuccess(`CTFd: user created ${u}`);
          else if (r?.action === 'updated') shell.logSuccess(`CTFd: user updated ${u}`);
          else if (r?.error) shell.logError(`CTFd: user ${u} error — ${r.error}`);
          else shell.logDebug(`CTFd: user ${u} ${r?.action || ''}`);
        });
      } catch {}
      shell.logSuccess(`CTFd users create: created=${res.created} updated=${res.updated}`);
      updateActionProgress(80, 'Processing results…');
      try { showActionSummary('CTFd Users Create', buildCtfdResultsSummary('create', res)); } catch {}
      // Refresh existence and table
      try { await ctfdCheckExistence(); renderCtfdTable(PROJ); } catch {}
      shell.endActionContext(true);
    } else if (kind === 'users_delete'){
      let res;
      await runQueued(`CTFd delete users for ${PROJ?.name || PROJ?.id || ''}`, async () => {
        res = await http('POST', `/api/projects/${PROJ.id}/ctfd/users_delete`, payload);
      }, { projectId: PROJ?.id });
      try {
        const logs = Array.isArray(res?.logs) ? res.logs : [];
        logs.forEach(l => { try { shell.logDebug(`[CTFd] ${l.event}: ${JSON.stringify(l)}`); } catch {} });
        if (typeof res?.using_token !== 'undefined') { try { shell.logInfo(`[CTFd] auth mode: using_token=${!!res.using_token}`); } catch {} }
      } catch {}
      if (res && res.ok === false && res.error) {
        try { shell.logError(`CTFd users delete: ${res.error}`); } catch {}
      }
      try {
        const results = Array.isArray(res?.results) ? res.results : [];
        results.forEach(r => {
          const u = r?.username || '';
          if (r?.action === 'deleted') shell.logSuccess(`CTFd: user deleted ${u}`);
          else if (r?.action === 'missing') shell.logWarn(`CTFd: user not found ${u}`);
          else if (r?.error) shell.logError(`CTFd: user ${u} error — ${r.error}`);
          else shell.logDebug(`CTFd: user ${u} ${r?.action || ''}`);
        });
      } catch {}
      shell.logSuccess(`CTFd users delete: deleted=${res.deleted}`);
      updateActionProgress(80, 'Processing results…');
      try { showActionSummary('CTFd Users Delete', buildCtfdResultsSummary('delete', res)); } catch {}
      try { await ctfdCheckExistence(); renderCtfdTable(PROJ); } catch {}
      shell.endActionContext(true);
    } else if (kind === 'upload'){
      // Prompt for a previously exported CTFd file (zip)
      const picker = document.createElement('input');
      picker.type = 'file';
      picker.accept = '.zip,application/zip';
      picker.style.display = 'none';
      document.body.appendChild(picker);
      const file = await new Promise(resolve => {
        picker.addEventListener('change', () => resolve(picker.files && picker.files[0] ? picker.files[0] : null), { once: true });
        picker.click();
      });
      document.body.removeChild(picker);
      if (!file) { shell.endActionContext(false); return; }
      showActionProgress('CTFd Upload', 'Uploading export…');
      updateActionProgress(30, 'Preparing…');
      const fd = new FormData();
      fd.append('file', file);
      fd.append('baseUrl', baseUrl);
      fd.append('token', sess.token || '');
      fd.append('verifySSL', String(verifySSL));
      try {
        // Use fetch directly for multipart upload (queued)
        let resp, json;
        await runQueued(`CTFd upload for ${PROJ?.name || PROJ?.id || ''}`, async () => {
          resp = await fetch(`/api/projects/${PROJ.id}/ctfd/upload`, { method: 'POST', body: fd });
          json = await resp.json().catch(() => ({}));
        }, { projectId: PROJ?.id });
        if (!resp.ok || json?.error) {
          throw new Error(json?.error || `Upload failed (${resp.status})`);
        }
        updateActionProgress(80, 'Processing results…');
        const body = `<div>Uploaded: <strong>${file.name}</strong></div>`;
        showActionSummary('CTFd Upload', body);
        shell.endActionContext(true);
      } catch (e) {
        showActionSummary('CTFd Upload', `<div class="text-danger">${escHtml(e?.message||e)}</div>`);
        shell.endActionContext(false);
      }
    } else if (kind === 'download'){
      showActionProgress('CTFd', 'Working…');
      updateActionProgress(100, 'Not implemented');
      try { showActionSummary('CTFd', '<div class="text-muted">Download not implemented yet.</div>'); } catch {}
      shell.endActionContext(false);
    }
  } catch(e){
    shell.logError(`CTFd action ${kind} failed: ${e?.message||e}`);
    alert(`CTFd action failed: ${e?.message||e}`);
    try { shell.endActionContext(false); } catch {}
  } finally {
    // Hide progress modals and re-enable controls
    try { updateActionProgress(100, 'Done'); hideActionProgress(); } catch {}
    ctfdHideProgress();
    try {
      if (usersBtn) usersBtn.disabled = false;
      if (refreshBtn) refreshBtn.disabled = false;
      if (loginBtn) loginBtn.disabled = false;
    } catch {}
  }
}

// Multi-project variant for Users actions (create/delete) operating per selected project
async function ctfdActionMulti(kind){
  const pids = Array.isArray(CTFD_SELECTED_PIDS) ? CTFD_SELECTED_PIDS.slice() : [];
  if (!pids.length) return;
  await ctfdEnsureProjects();
  const pf = await ctfdPreflightPids(pids);
  // Determine targets (valid projects)
  const invalidSet = new Set([...(pf.invalid||[]), ...(pf.missing||[])]);
  const targets = pids.filter(pid => !invalidSet.has(String(pid)));
  if (!targets.length) {
    ctfdRenderSkippedIndicator([...(pf.invalid||[]), ...(pf.missing||[])], 'missing credentials or configuration');
    try {
      const needsLogin = Array.from(new Set([...(pf.invalid||[]), ...(pf.missing||[])]));
      if (needsLogin.length) openCtfdLoginMultiForPids(needsLogin);
      else openCtfdLoginModal();
    } catch { openCtfdLoginModal(); }
    return;
  }
  // Show indicator for skipped ones but continue for valid
  if (invalidSet.size) ctfdRenderSkippedIndicator(Array.from(invalidSet), 'missing credentials or configuration'); else ctfdRenderSkippedIndicator([], '');
  // Begin action context and modal
  let title = '';
  if (kind === 'users_create') title = 'CTFd Users Create (Multi)';
  else if (kind === 'users_delete') title = 'CTFd Users Delete (Multi)';
  else title = 'CTFd Action (Multi)';
  try { shell.beginActionContext(title); } catch {}
  showActionProgress(title, 'Working across projects…');
  // Disable some buttons while running
  const usersBtn = document.getElementById('act-ctf-users');
  const refreshBtn = document.getElementById('btn-ctfd-refresh');
  const loginBtn = document.getElementById('btn-ctfd-login');
  try { if (usersBtn) usersBtn.disabled = true; if (refreshBtn) refreshBtn.disabled = true; if (loginBtn) loginBtn.disabled = true; } catch {}
  const verifyEl = document.getElementById('ctfd-verify-ssl');
  const verifySSL = verifyEl ? !!verifyEl.checked : true;
  const byId = {}; (CTFD_ALL_PROJECTS||[]).forEach(p => byId[String(p.id)] = p);
  // Build per-project 'only' maps from composite selection (if any)
  const selMap = new Map();
  if (CTFD_SELECTED_KEYS && CTFD_SELECTED_KEYS.size > 0) {
    CTFD_SELECTED_KEYS.forEach(k => {
      const [pidStr, idxStr] = String(k).split(':');
      if (!pidStr || !idxStr) return;
      const pid = String(pidStr);
      const idx = parseInt(idxStr, 10);
      if (!Number.isFinite(idx) || idx <= 0) return;
      if (!selMap.has(pid)) selMap.set(pid, new Set());
      selMap.get(pid).add(idx);
    });
  }
  const summaries = [];
  let i = 0; const total = targets.length;
  for (const pid of targets){
    i += 1;
    const proj = byId[String(pid)];
    if (!proj) continue;
    const sess = readCtfdCreds(String(pid)) || {};
    const baseUrl = (proj.challenge_url||'').trim();
    const port = Number(proj.challenge_port||443);
    // Compute only list if selection provided
    let payload = { baseUrl, port, token: sess.token||'', verifySSL };
    try {
      const idxSet = selMap.get(String(pid));
      if (idxSet && idxSet.size > 0) {
        const creds = Array.isArray(proj.credentials) ? proj.credentials : [];
        const names = [];
        idxSet.forEach(iIdx => { const c = creds[iIdx-1]; if (c && c.username) names.push(String(c.username)); });
        if (names.length > 0) payload = { ...payload, only: names };
      }
    } catch {}
    updateActionProgress(Math.floor((i-1)/Math.max(1,total)*100), `Processing ${proj.name}…`);
    try {
      let res;
      if (kind === 'users_create') {
        await runQueued(`CTFd multi-create users for ${proj.name || pid}`, async () => {
          res = await http('POST', `/api/projects/${pid}/ctfd/users_create`, payload);
        }, { projectId: pid });
      } else if (kind === 'users_delete') {
        await runQueued(`CTFd multi-delete users for ${proj.name || pid}`, async () => {
          res = await http('POST', `/api/projects/${pid}/ctfd/users_delete`, payload);
        }, { projectId: pid });
      } else {
        // Unsupported in multi-mode for now
        res = { ok:false, error:'Unsupported action in multi mode' };
      }
      const good = !!(res && res.ok !== false);
      const sum = buildCtfdResultsSummary(kind === 'users_delete' ? 'delete' : (kind === 'users_create' ? 'create' : 'other'), res||{});
      summaries.push(`<div class="mb-3"><h6 class="mb-1">${escHtml(proj.name||String(pid))}</h6>${sum}</div>`);
      try {
        if (!good && res?.error) shell.logError(`CTFd ${kind} (${proj.name}): ${res.error}`);
      } catch {}
    } catch (e) {
      summaries.push(`<div class="mb-3"><h6 class="mb-1">${escHtml(proj.name||String(pid))}</h6><div class="text-danger">${escHtml(e?.message||e)}</div></div>`);
    }
    updateActionProgress(Math.floor(i/Math.max(1,total)*90), `Processed ${i}/${total} projects…`);
  }
  updateActionProgress(95, 'Refreshing view…');
  try { CTFD_ALLOW_LOAD = true; await ctfdRefreshMulti(); } catch {}
  updateActionProgress(100, 'Done');
  try { showActionSummary(title, summaries.join('') || '<div class="text-muted">No details.</div>'); shell.endActionContext(true); } catch {}
  // Re-enable controls
  try { if (usersBtn) usersBtn.disabled = false; if (refreshBtn) refreshBtn.disabled = false; if (loginBtn) loginBtn.disabled = false; } catch {}
}

function buildCtfdResultsSummary(kind, res){
  try {
    const safe = (s) => String(s ?? '').replace(/[&<>]/g, c=> ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
    const results = Array.isArray(res?.results) ? res.results : [];
    const counts = [];
    if (kind==='create') counts.push(`Created: <strong>${res?.created ?? 0}</strong>`, `Updated: <strong>${res?.updated ?? 0}</strong>`);
    if (kind==='delete') counts.push(`Deleted: <strong>${res?.deleted ?? 0}</strong>`);
    const head = `<div class="mb-2">${counts.join(' • ') || ''}</div>`;
    if (!results.length) return head + '<div class="text-muted">No per-user details.</div>';
    const rows = results.map(r => {
      const u = safe(r?.username);
      const act = safe(r?.action || '');
      const err = safe(r?.error || '');
      let badge = '';
      if (act==='created') badge = '<span class="badge bg-success">created</span>';
      else if (act==='updated') badge = '<span class="badge bg-primary">updated</span>';
      else if (act==='deleted') badge = '<span class="badge bg-success">deleted</span>';
      else if (act==='missing') badge = '<span class="badge bg-secondary">missing</span>';
      else if (err) badge = '<span class="badge bg-danger">error</span>';
      else badge = `<span class="badge bg-secondary">${act||'n/a'}</span>`;
      const msg = err ? `<div class="small text-danger">${err}</div>` : '';
      return `<tr><td>${u||'n/a'}</td><td>${badge}</td><td>${msg}</td></tr>`;
    }).join('');
    return head + `<div class="table-responsive"><table class="table table-sm"><thead><tr><th>User</th><th>Status</th><th>Info</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  } catch { return '<div class="text-muted">No details.</div>'; }
}

// Fetch CTFd existence map for current project's usernames
async function ctfdCheckExistence(){
  if (!PROJ) return;
  const sess = readCtfdCreds(PROJ.id) || {};
  if (!(sess?.validated && (sess.token || (sess.username && sess.password)))) { CTFD_USER_EXISTS = {}; return; }
  const baseUrl = (PROJ.challenge_url || '').trim();
  const port = Number(PROJ.challenge_port || 443);
  const verifyEl = document.getElementById('ctfd-verify-ssl');
  const verifySSL = verifyEl ? !!verifyEl.checked : true;
  const payload = { baseUrl, port, token: sess.token, verifySSL };
  const resp = await http('POST', `/api/projects/${PROJ.id}/ctfd/users_check`, payload);
  // Print detailed CTFd request/response logs to console
  try {
    const logs = Array.isArray(resp?.logs) ? resp.logs : [];
    logs.forEach(l => { try { shell.logDebug(`[CTFd] ${l.event}: ${JSON.stringify(l)}`); } catch {} });
  } catch {}
  const map = {};
  try {
    const list = Array.isArray(resp?.users) ? resp.users : [];
    list.forEach(u => {
      const name = String(u?.username || '').trim();
      if (!name) return;
      map[name] = {
        exists: !!u?.exists,
        user_rank: (u?.user_rank ?? null),
        user_points: (u?.user_points ?? null),
        team_name: (u?.team_name ?? null),
        team_rank: (u?.team_rank ?? null),
        team_points: (u?.team_points ?? null),
        user_id: (u?.user_id ?? null),
        team_id: (u?.team_id ?? null),
        user_last_solve_time: (u?.user_last_solve_time ?? null),
        user_last_solve_challenge: (u?.user_last_solve_challenge ?? null),
        team_captain: (u?.team_captain ?? null),
        team_size: (u?.team_size ?? null),
        team_last_solve_time: (u?.team_last_solve_time ?? null),
        team_last_solve_challenge: (u?.team_last_solve_challenge ?? null),
      };
    });
  } catch {}
  ctfdApplyUserMeta(PROJ?.id, map);
}

// Sidebar click fallback to ensure rows render when selecting a project
document.addEventListener('DOMContentLoaded', () => {
  const host = document.getElementById('sidebar-projects');
  if (!host) return;
  host.addEventListener('click', (e) => {
    const btn = e.target && e.target.closest('button.list-group-item');
    if (!btn) return;
    const pid = btn.getAttribute('data-pid');
    if (!pid) return;
    try { if (window.shell && shell.setCurrentProjectId) shell.setCurrentProjectId(pid); } catch {}
    // Selecting a project should not auto-load; user must press Refresh or add valid credentials
    // Load only the project config to display table with n/a values; do not contact CTFd
    try { ctfdLoadProjectConfig(pid); } catch {}
  });
});

// Defensive cleanup for modal backdrops if Cancel/Close leaves a grey screen
document.addEventListener('hidden.bs.modal', ()=>{
  try {
    document.querySelectorAll('.modal-backdrop').forEach(b => b.remove());
    document.body.classList.remove('modal-open');
    document.body.style.removeProperty('padding-right');
    document.body.style.removeProperty('overflow');
  } catch {}
});

function safeHideModalById(id) {
  try {
    const modal = document.getElementById(id);
    if (!modal || !window.bootstrap) return;
    const inst = bootstrap.Modal.getInstance(modal) || bootstrap.Modal.getOrCreateInstance(modal);
    try { inst.hide(); } catch {}
  } catch {}
}
function showActionSummary(title, htmlBody) {
  try {
    // Hide progress before showing summary (avoid overlaps)
    try { safeHideModalById('actionProgressModal'); } catch {}
    const modal = document.getElementById('actionSummaryModal');
    if (!modal || !window.bootstrap) return;
    const titleEl = document.getElementById('action-summary-title');
    const bodyEl = document.getElementById('action-summary-body');
    if (titleEl) titleEl.textContent = title || 'Action Results';
    if (bodyEl) bodyEl.innerHTML = htmlBody || '<div class="text-muted">No details.</div>';
    const bs = bootstrap.Modal.getOrCreateInstance(modal);
    setTimeout(() => { try { bs.show(); } catch {} }, 10);
  } catch {}
}
