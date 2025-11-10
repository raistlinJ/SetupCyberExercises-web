const UI_STATE_KEY = 'toolhub.uiState.v1';
const UI_SETTINGS_KEY = 'toolhub.settings.v1';
// Project cache for UI-only previews
window.PROJ_CACHE = window.PROJ_CACHE || {};

// Basic HTTP helper (restored after refactor removed it inadvertently)
async function http(method, url, body) {
  const opts = { method, headers: {}, credentials: 'same-origin' };
  if (body instanceof FormData) {
    opts.body = body;
  } else if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  try {
    (window.shell && shell.logDebug) ? shell.logDebug(`[HTTP] ${method} ${url}`) : null;
  } catch {}
  const res = await fetch(url, opts);
  if (!res.ok) {
    let msg = res.statusText;
    try { msg = (await res.text()) || msg; } catch {}
    throw new Error(msg || `HTTP ${res.status}`);
  }
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('application/json')) return res.json();
  return res.text();
}

// UI state helpers (restored)
function readUIState() { try { return JSON.parse(localStorage.getItem(UI_STATE_KEY) || '{}'); } catch { return {}; } }
function writeUIState(s) { try { localStorage.setItem(UI_STATE_KEY, JSON.stringify(s)); } catch {} }
function getProjState(pid) { const s = readUIState(); s.projects = s.projects || {}; s.projects[pid] = s.projects[pid] || {}; return s.projects[pid]; }
function setProjState(pid, patch) {
  const s = readUIState();
  s.projects = s.projects || {};
  s.projects[pid] = { ...(s.projects[pid] || {}), ...(patch || {}) };
  writeUIState(s);
}

// Settings helpers
function readSettings() {
  try { return JSON.parse(localStorage.getItem(UI_SETTINGS_KEY) || '{}'); } catch { return {}; }
}
function writeSettings(s) { localStorage.setItem(UI_SETTINGS_KEY, JSON.stringify(s || {})); }

// Settings modal + audio customization
const SETTINGS_AUDIO_MAX_BYTES = 600 * 1024;
const SETTINGS_AUDIO_FIELDS = {
  ctfdFirstUser: {
    inputId: 'settings-audio-ctfd-user',
    previewId: 'settings-audio-ctfd-user-preview',
    clearId: 'settings-audio-ctfd-user-clear',
    listId: 'settings-audio-ctfd-user-list',
    labelId: 'settings-audio-ctfd-user-label',
    toggleId: 'settings-audio-ctfd-user-toggle',
    speakToggleId: 'settings-audio-ctfd-user-speak',
    speakLabelId: 'settings-audio-ctfd-user-speak-label',
    templateInputId: 'settings-audio-ctfd-user-speak-template-input',
    templateAddId: 'settings-audio-ctfd-user-speak-template-add',
    templateListId: 'settings-audio-ctfd-user-speak-template-list',
    speakHelpId: 'settings-audio-ctfd-user-speak-help',
    placeholderHint: '{{audio}}, {{leader}}, {{user_first}}, {{team_first}}, {{team_clause}}, {{project}}, {{project_clause}}, {{first_team}}, {{second_team}}, {{third_team}}',
    defaultEnabled: true,
    defaultSpeak: true,
    defaultSpeakTemplate: '{{audio}} {{leader}} is now in first place{{project_clause}}.',
    legacyDefaultSpeakBefore: '',
    legacyDefaultSpeakAfter: 'User {{user_first}}{{team_clause}} is now in first place{{project_clause}}.'
  },
  ctfdFirstTeam: {
    inputId: 'settings-audio-ctfd-team',
    previewId: 'settings-audio-ctfd-team-preview',
    clearId: 'settings-audio-ctfd-team-clear',
    listId: 'settings-audio-ctfd-team-list',
    labelId: 'settings-audio-ctfd-team-label',
    toggleId: 'settings-audio-ctfd-team-toggle',
    speakToggleId: 'settings-audio-ctfd-team-speak',
    speakLabelId: 'settings-audio-ctfd-team-speak-label',
    templateInputId: 'settings-audio-ctfd-team-speak-template-input',
    templateAddId: 'settings-audio-ctfd-team-speak-template-add',
    templateListId: 'settings-audio-ctfd-team-speak-template-list',
    speakHelpId: 'settings-audio-ctfd-team-speak-help',
    placeholderHint: '{{audio}}, {{first_team}}, {{second_team}}, {{third_team}}, {{project}}, {{project_clause}}',
    defaultEnabled: true,
    defaultSpeak: true,
    defaultSpeakTemplate: '{{audio}} {{first_team}} is now in first place{{project_clause}}.',
    legacyDefaultSpeakBefore: '',
    legacyDefaultSpeakAfter: 'Team {{team_first}} is now in first place{{project_clause}}.'
  },
  ctfdFirstScore: {
    inputId: 'settings-audio-ctfd-score',
    previewId: 'settings-audio-ctfd-score-preview',
    clearId: 'settings-audio-ctfd-score-clear',
    listId: 'settings-audio-ctfd-score-list',
    labelId: 'settings-audio-ctfd-score-label',
    toggleId: 'settings-audio-ctfd-score-toggle',
    speakToggleId: 'settings-audio-ctfd-score-speak',
    speakLabelId: 'settings-audio-ctfd-score-speak-label',
    templateInputId: 'settings-audio-ctfd-score-speak-template-input',
    templateAddId: 'settings-audio-ctfd-score-speak-template-add',
    templateListId: 'settings-audio-ctfd-score-speak-template-list',
    speakHelpId: 'settings-audio-ctfd-score-speak-help',
    placeholderHint: '{{audio}}, {{leader}}, {{user_first}}, {{team_first}}, {{team_clause}}, {{challenge}}, {{challenge_clause}}, {{points}}, {{points_clause}}, {{project}}, {{project_clause}}, {{first_team}}, {{second_team}}, {{third_team}}',
    defaultEnabled: true,
    defaultSpeak: true,
    defaultSpeakTemplate: '{{audio}} First score{{project_clause}} goes to {{leader}}{{team_clause}}{{challenge_clause}}{{points_clause}}.',
    legacyDefaultSpeakBefore: '',
    legacyDefaultSpeakAfter: 'First score{{project_clause}} goes to {{leader}}{{team_clause}}{{challenge_clause}}{{points_clause}}.'
  },
  ctfdCountdown: {
    inputId: 'settings-audio-ctfd-countdown',
    previewId: 'settings-audio-ctfd-countdown-preview',
    clearId: 'settings-audio-ctfd-countdown-clear',
    listId: 'settings-audio-ctfd-countdown-list',
    labelId: 'settings-audio-ctfd-countdown-label',
    toggleId: 'settings-audio-ctfd-countdown-toggle',
    speakToggleId: 'settings-audio-ctfd-countdown-speak',
    speakLabelId: 'settings-audio-ctfd-countdown-speak-label',
    templateInputId: 'settings-audio-ctfd-countdown-speak-template-input',
    templateAddId: 'settings-audio-ctfd-countdown-speak-template-add',
    templateListId: 'settings-audio-ctfd-countdown-speak-template-list',
    speakHelpId: 'settings-audio-ctfd-countdown-speak-help',
    placeholderHint: '{{audio}}, {{reason}}, {{reason_clause}}, {{countdown_seconds}}, {{project}}, {{project_clause}}, {{first_team}}, {{second_team}}, {{third_team}}',
    defaultEnabled: false,
    defaultSpeak: false,
    defaultSpeakTemplate: '{{audio}} Countdown complete{{reason_clause}}.',
    legacyDefaultSpeakBefore: '',
    legacyDefaultSpeakAfter: 'Countdown complete{{reason_clause}}.'
  },
  ctfdPeriodic: {
    inputId: 'settings-audio-ctfd-periodic',
    previewId: 'settings-audio-ctfd-periodic-preview',
    clearId: 'settings-audio-ctfd-periodic-clear',
    listId: 'settings-audio-ctfd-periodic-list',
    labelId: 'settings-audio-ctfd-periodic-label',
    toggleId: 'settings-audio-ctfd-periodic-toggle',
    speakToggleId: 'settings-audio-ctfd-periodic-speak',
    speakLabelId: 'settings-audio-ctfd-periodic-speak-label',
    templateInputId: 'settings-audio-ctfd-periodic-speak-template-input',
    templateAddId: 'settings-audio-ctfd-periodic-speak-template-add',
    templateListId: 'settings-audio-ctfd-periodic-speak-template-list',
    speakHelpId: 'settings-audio-ctfd-periodic-speak-help',
    placeholderHint: '{{audio}}, {{interval_minutes}}, {{project}}, {{project_clause}}',
    numericFields: [
      {
        key: 'intervalMinutes',
        inputId: 'settings-audio-ctfd-periodic-interval',
        defaultValue: 30,
        min: 1,
        max: 1440,
        step: 1,
        contextKey: 'interval_minutes'
      }
    ],
    defaultEnabled: false,
    defaultSpeak: true,
    defaultSpeakTemplate: '{{audio}} Periodic update{{project_clause}}. Next check in {{interval_minutes}} minutes.',
    legacyDefaultSpeakBefore: '',
    legacyDefaultSpeakAfter: 'Periodic update{{project_clause}}. Next check in {{interval_minutes}} minutes.'
  },
  ctfdFirstCategoryUser: {
    inputId: 'settings-audio-ctfd-cat-user',
    previewId: 'settings-audio-ctfd-cat-user-preview',
    clearId: 'settings-audio-ctfd-cat-user-clear',
    listId: 'settings-audio-ctfd-cat-user-list',
    labelId: 'settings-audio-ctfd-cat-user-label',
    toggleId: 'settings-audio-ctfd-cat-user-toggle',
    speakToggleId: 'settings-audio-ctfd-cat-user-speak',
    speakLabelId: 'settings-audio-ctfd-cat-user-speak-label',
    templateInputId: 'settings-audio-ctfd-cat-user-speak-template-input',
    templateAddId: 'settings-audio-ctfd-cat-user-speak-template-add',
    templateListId: 'settings-audio-ctfd-cat-user-speak-template-list',
    speakHelpId: 'settings-audio-ctfd-cat-user-speak-help',
    placeholderHint: '{{audio}}, {{category}}, {{category_clause}}, {{leader}}, {{user_first}}, {{team_clause}}, {{challenge}}, {{challenge_clause}}, {{project}}, {{project_clause}}',
    defaultEnabled: true,
    defaultSpeak: true,
    defaultSpeakTemplate: '{{audio}} {{leader}} just solved the first challenge in {{category}}{{project_clause}}.',
    legacyDefaultSpeakBefore: '',
    legacyDefaultSpeakAfter: '{{leader}} just solved the first challenge in {{category}}{{project_clause}}.'
  },
  ctfdFirstCategoryTeam: {
    inputId: 'settings-audio-ctfd-cat-team',
    previewId: 'settings-audio-ctfd-cat-team-preview',
    clearId: 'settings-audio-ctfd-cat-team-clear',
    listId: 'settings-audio-ctfd-cat-team-list',
    labelId: 'settings-audio-ctfd-cat-team-label',
    toggleId: 'settings-audio-ctfd-cat-team-toggle',
    speakToggleId: 'settings-audio-ctfd-cat-team-speak',
    speakLabelId: 'settings-audio-ctfd-cat-team-speak-label',
    templateInputId: 'settings-audio-ctfd-cat-team-speak-template-input',
    templateAddId: 'settings-audio-ctfd-cat-team-speak-template-add',
    templateListId: 'settings-audio-ctfd-cat-team-speak-template-list',
    speakHelpId: 'settings-audio-ctfd-cat-team-speak-help',
  placeholderHint: '{{audio}}, {{category}}, {{category_clause}}, {{team_first}}, {{challenge}}, {{challenge_clause}}, {{project}}, {{project_clause}}',
    defaultEnabled: true,
    defaultSpeak: true,
    defaultSpeakTemplate: '{{audio}} {{team_first}} is first to solve a {{category}} challenge{{project_clause}}.',
    legacyDefaultSpeakBefore: '',
    legacyDefaultSpeakAfter: '{{team_first}} is first to solve a {{category}} challenge{{project_clause}}.'
  }
};
const SETTINGS_AUDIO_DEFAULTS = Object.fromEntries(Object.entries(SETTINGS_AUDIO_FIELDS).map(([key, cfg]) => [key, cfg.defaultEnabled !== undefined ? !!cfg.defaultEnabled : true]));
window.SETTINGS_AUDIO_DEFAULTS = SETTINGS_AUDIO_DEFAULTS;
window.SETTINGS_AUDIO_FIELDS_META = SETTINGS_AUDIO_FIELDS;
const SETTINGS_AUDIO_PREVIEW_DEFAULT_CONTEXT = {
  leader: 'Alex Jordan',
  user_first: 'Alex Jordan',
  team_first: 'Team Eclipse',
  team_clause: ' from Team Eclipse',
  project: 'Cyber Shield',
  project_clause: ' in Cyber Shield',
  first_team: 'Team Eclipse',
  second_team: 'Team Orion',
  third_team: 'Team Nova',
  challenge: 'Forensics Intro',
  challenge_clause: ' for challenge Forensics Intro',
  category: 'Forensics',
  category_clause: ' in Forensics',
  points: '100',
  points_clause: ' worth 100 points',
  reason: 'scoreboard reveal',
  reason_clause: ' for scoreboard reveal',
  countdown_seconds: '10',
  interval_minutes: '30'
};
const SETTINGS_AUDIO_PREVIEW_CONTEXT = {
  ctfdFirstTeam: { leader: 'Team Eclipse' },
  ctfdPeriodic: { interval_minutes: '30' },
  ctfdFirstCategoryUser: { category: 'Web Exploitation', leader: 'Alex Jordan' },
  ctfdFirstCategoryTeam: { category: 'Reverse Engineering', team_first: 'Team Aurora' }
};
function settingsModalPreviewContext(key){
  const overrides = SETTINGS_AUDIO_PREVIEW_CONTEXT[key];
  return overrides && typeof overrides === 'object'
    ? { ...SETTINGS_AUDIO_PREVIEW_DEFAULT_CONTEXT, ...overrides }
    : { ...SETTINGS_AUDIO_PREVIEW_DEFAULT_CONTEXT };
}
function settingsModalRenderSpeechTemplate(template, context){
  const raw = typeof template === 'string' ? template : '';
  if (!raw.trim()) return '';
  const ctx = context && typeof context === 'object' ? context : {};
  const replaced = raw.replace(/{{\s*([a-zA-Z0-9_]+)\s*}}/g, (_, key) => {
    if (!key) return '';
    if (key === 'audio') return '';
    if (Object.prototype.hasOwnProperty.call(ctx, key) && ctx[key] != null) {
      return String(ctx[key]);
    }
    return '';
  });
  return replaced.replace(/\s{2,}/g, ' ').replace(/\s+([.,!?;:])/g, '$1').trim();
}
function settingsModalBuildPreviewSpeechText(key, entry){
  const templates = settingsAudioValidTemplates(entry);
  const tpl = templates.length ? templates[0] : settingsAudioDefaultSpeakTemplate(key);
  if (!tpl) return '';
  const context = settingsModalPreviewContext(key);
  const cfg = SETTINGS_AUDIO_FIELDS[key];
  if (cfg && Array.isArray(cfg.numericFields)) {
    cfg.numericFields.forEach(field => {
      if (!field) return;
      const ctxKey = field.contextKey || field.key;
      if (!ctxKey) return;
      const value = entry ? entry[field.key] : undefined;
      if (value !== undefined && value !== null && value !== '') {
        context[ctxKey] = String(value);
      }
    });
  }
  return settingsModalRenderSpeechTemplate(tpl, context);
}
function settingsModalSpeakPreview(text){
  if (!text || !settingsSpeechSupported()) return;
  try {
    settingsModalSyncTtsWorkingFromInputs();
    const synth = window.speechSynthesis;
    if (!synth) return;
    const utterance = new SpeechSynthesisUtterance(String(text));
    const rate = settingsClampNumber(_settingsTtsWorking.rate ?? SETTINGS_TTS_DEFAULT_RATE, SETTINGS_TTS_MIN_RATE, SETTINGS_TTS_MAX_RATE, SETTINGS_TTS_DEFAULT_RATE);
    const pitch = settingsClampNumber(_settingsTtsWorking.pitch ?? SETTINGS_TTS_DEFAULT_PITCH, SETTINGS_TTS_MIN_PITCH, SETTINGS_TTS_MAX_PITCH, SETTINGS_TTS_DEFAULT_PITCH);
    if (Number.isFinite(rate)) utterance.rate = rate;
    if (Number.isFinite(pitch)) utterance.pitch = pitch;
    try { synth.cancel(); } catch {}
    synth.speak(utterance);
  } catch {}
}
let _settingsAudioWorking = {};
const SETTINGS_TTS_DEFAULT_RATE = 1.0;
const SETTINGS_TTS_DEFAULT_PITCH = 1.0;
const SETTINGS_TTS_MIN_RATE = 0.5;
const SETTINGS_TTS_MAX_RATE = 2.0;
const SETTINGS_TTS_MIN_PITCH = 0;
const SETTINGS_TTS_MAX_PITCH = 2.0;
let _settingsSpeechSupported = false;
let _settingsTtsWorking = { rate: SETTINGS_TTS_DEFAULT_RATE, pitch: SETTINGS_TTS_DEFAULT_PITCH };
function settingsSpeechSupported(){
  try {
    return typeof window !== 'undefined'
      && 'speechSynthesis' in window
      && window.speechSynthesis
      && typeof window.speechSynthesis.speak === 'function'
      && typeof window.SpeechSynthesisUtterance === 'function';
  } catch { return false; }
}
function settingsClampNumber(value, min, max, fallback){
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  if (num < min) return min;
  if (num > max) return max;
  return num;
}
function settingsRoundTts(value){
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  return Math.round(num * 100) / 100;
}
function settingsReadStoredTts(settings){
  const payload = (settings && typeof settings.tts === 'object') ? settings.tts : {};
  const rateRaw = Object.prototype.hasOwnProperty.call(payload || {}, 'rate') ? payload.rate : settings?.ttsRate;
  const pitchRaw = Object.prototype.hasOwnProperty.call(payload || {}, 'pitch') ? payload.pitch : settings?.ttsPitch;
  const rate = settingsClampNumber(rateRaw, SETTINGS_TTS_MIN_RATE, SETTINGS_TTS_MAX_RATE, SETTINGS_TTS_DEFAULT_RATE);
  const pitch = settingsClampNumber(pitchRaw, SETTINGS_TTS_MIN_PITCH, SETTINGS_TTS_MAX_PITCH, SETTINGS_TTS_DEFAULT_PITCH);
  return {
    rate: settingsRoundTts(rate) ?? SETTINGS_TTS_DEFAULT_RATE,
    pitch: settingsRoundTts(pitch) ?? SETTINGS_TTS_DEFAULT_PITCH
  };
}
function settingsModalUpdateTtsSupportNote(){
  const note = document.getElementById('settings-tts-support-note');
  if (!note) return;
  if (_settingsSpeechSupported) {
    note.textContent = 'Applies to supported browsers.';
    note.classList.remove('text-danger');
  } else {
    note.textContent = 'Text-to-speech is not available in this browser.';
    note.classList.add('text-danger');
  }
}
function settingsModalHandleTtsInput(kind, input){
  if (!input) return;
  const num = Number(input.value);
  if (!Number.isFinite(num)) return;
  if (kind === 'rate') _settingsTtsWorking.rate = num;
  else _settingsTtsWorking.pitch = num;
}
function settingsModalHandleTtsChange(kind, input){
  if (!input) return;
  const fallback = kind === 'rate' ? (_settingsTtsWorking.rate ?? SETTINGS_TTS_DEFAULT_RATE) : (_settingsTtsWorking.pitch ?? SETTINGS_TTS_DEFAULT_PITCH);
  const min = kind === 'rate' ? SETTINGS_TTS_MIN_RATE : SETTINGS_TTS_MIN_PITCH;
  const max = kind === 'rate' ? SETTINGS_TTS_MAX_RATE : SETTINGS_TTS_MAX_PITCH;
  const clamped = settingsClampNumber(input.value, min, max, fallback);
  const rounded = settingsRoundTts(clamped) ?? fallback;
  if (kind === 'rate') _settingsTtsWorking.rate = rounded;
  else _settingsTtsWorking.pitch = rounded;
  input.value = String(rounded);
}
function settingsModalSyncTtsWorkingFromInputs(){
  const rateInput = document.getElementById('settings-tts-rate');
  const pitchInput = document.getElementById('settings-tts-pitch');
  if (rateInput) settingsModalHandleTtsChange('rate', rateInput);
  if (pitchInput) settingsModalHandleTtsChange('pitch', pitchInput);
}
function wireSettingsTtsControls(){
  const bindings = [
    { el: document.getElementById('settings-tts-rate'), kind: 'rate' },
    { el: document.getElementById('settings-tts-pitch'), kind: 'pitch' }
  ];
  bindings.forEach(({ el, kind }) => {
    if (!el || el._toolhubBound) return;
    el.addEventListener('input', () => settingsModalHandleTtsInput(kind, el));
    el.addEventListener('change', () => settingsModalHandleTtsChange(kind, el));
    el.addEventListener('blur', () => settingsModalHandleTtsChange(kind, el));
    el._toolhubBound = true;
  });
}
function cloneSettingsAudio(src){ try { return JSON.parse(JSON.stringify(src || {})); } catch { return {}; } }
function settingsAudioValidSounds(entry){
  const list = Array.isArray(entry && entry.sounds) ? entry.sounds : [];
  return list.filter(sound => {
    if (!sound) return false;
    const dataUrl = typeof sound.dataUrl === 'string' ? sound.dataUrl : '';
    return dataUrl.startsWith('data:');
  });
}
function settingsAudioValidTemplates(entry){
  const list = Array.isArray(entry && entry.speakTemplates) ? entry.speakTemplates : [];
  return list.map(t => {
    if (typeof t === 'string') return t.trim();
    if (t != null) return String(t).trim();
    return '';
  }).filter(Boolean);
}
function describeAudioEntry(entry){
  const sounds = settingsAudioValidSounds(entry);
  if (!sounds.length) return 'Using built-in tone.';
  if (sounds.length === 1) {
    const sound = sounds[0] || {};
    const name = sound.name ? String(sound.name) : 'Custom audio';
    const sizeKb = Number(sound.size);
    const sizeLabel = Number.isFinite(sizeKb) && sizeKb > 0 ? ` (${Math.round(sizeKb / 1024)} KB)` : '';
    return `Custom: ${name}${sizeLabel}`;
  }
  return `Custom: ${sounds.length} clips`;
}
function settingsAudioDefaultEnabled(key){
  const cfg = SETTINGS_AUDIO_FIELDS[key];
  if (!cfg || cfg.defaultEnabled === undefined) return true;
  return !!cfg.defaultEnabled;
}
function settingsAudioDefaultSpeak(key){
  const cfg = SETTINGS_AUDIO_FIELDS[key];
  if (!cfg || cfg.defaultSpeak === undefined) return false;
  return !!cfg.defaultSpeak;
}
function settingsAudioDefaultSpeakTemplate(key){
  const cfg = SETTINGS_AUDIO_FIELDS[key];
  if (!cfg || cfg.defaultSpeakTemplate === undefined) return '';
  return String(cfg.defaultSpeakTemplate || '') || '';
}
function settingsAudioLegacyDefaultSpeakBefore(key){
  const cfg = SETTINGS_AUDIO_FIELDS[key];
  if (!cfg || cfg.legacyDefaultSpeakBefore === undefined) return '';
  return String(cfg.legacyDefaultSpeakBefore || '') || '';
}
function settingsAudioLegacyDefaultSpeakAfter(key){
  const cfg = SETTINGS_AUDIO_FIELDS[key];
  if (!cfg || cfg.legacyDefaultSpeakAfter === undefined) return '';
  return String(cfg.legacyDefaultSpeakAfter || '') || '';
}
function settingsAudioNormalizeLegacyTemplate(entry, key){
  if (!entry || typeof entry !== 'object') return;
  const hasLegacyBefore = typeof entry.speakBefore === 'string';
  const hasLegacyAfter = typeof entry.speakAfter === 'string';
  if (entry.speakTemplate === undefined && (hasLegacyBefore || hasLegacyAfter)) {
    const before = hasLegacyBefore ? entry.speakBefore : settingsAudioLegacyDefaultSpeakBefore(key);
    const after = hasLegacyAfter ? entry.speakAfter : settingsAudioLegacyDefaultSpeakAfter(key);
    const pieces = [];
    if (before) pieces.push(before);
    if (after) pieces.push(after);
    const combined = pieces.join(pieces.length > 1 ? ' ' : '');
    entry.speakTemplate = combined;
  }
  delete entry.speakBefore;
  delete entry.speakAfter;
}
function settingsAudioClampNumeric(raw, field){
  if (!field) return undefined;
  let value = Number(raw);
  if (!Number.isFinite(value)) {
    if (field.defaultValue !== undefined) value = Number(field.defaultValue);
  }
  if (!Number.isFinite(value)) return undefined;
  if (field.min !== undefined && Number.isFinite(Number(field.min))) value = Math.max(Number(field.min), value);
  if (field.max !== undefined && Number.isFinite(Number(field.max))) value = Math.min(Number(field.max), value);
  if (field.step !== undefined && Number.isFinite(Number(field.step)) && Number(field.step) > 0) {
    const step = Number(field.step);
    value = Math.round(value / step) * step;
  }
  return Number.isFinite(value) ? value : undefined;
}
function settingsAudioApplyNumericFields(entry, key){
  if (!entry || typeof entry !== 'object') return;
  const cfg = SETTINGS_AUDIO_FIELDS[key];
  if (!cfg || !Array.isArray(cfg.numericFields)) return;
  cfg.numericFields.forEach(field => {
    if (!field || !field.key) return;
    const clamped = settingsAudioClampNumeric(entry[field.key], field);
    if (clamped === undefined) {
      if (field.defaultValue !== undefined) {
        const fallback = settingsAudioClampNumeric(field.defaultValue, field);
        if (fallback !== undefined) entry[field.key] = fallback;
        else delete entry[field.key];
      } else {
        delete entry[field.key];
      }
    } else {
      entry[field.key] = clamped;
    }
  });
}
function settingsAudioEnsureEntry(key){
  const defEnabled = settingsAudioDefaultEnabled(key);
  const defSpeak = settingsAudioDefaultSpeak(key);
  const defTemplate = settingsAudioDefaultSpeakTemplate(key);
  let entry = _settingsAudioWorking[key];
  if (!entry || typeof entry !== 'object') {
    entry = {};
    _settingsAudioWorking[key] = entry;
  }
  if (entry.enabled === undefined) entry.enabled = defEnabled;
  if (entry.speak === undefined && defSpeak !== undefined) entry.speak = defSpeak;
  settingsAudioNormalizeLegacyTemplate(entry, key);
  if (!Array.isArray(entry.sounds)) entry.sounds = Array.isArray(entry.sounds) ? entry.sounds : [];
  if (entry.dataUrl) {
    entry.sounds.push({
      name: entry.name || '',
      size: entry.size || 0,
      type: entry.type || '',
      dataUrl: entry.dataUrl,
      updated: entry.updated || Date.now()
    });
  }
  entry.sounds = settingsAudioValidSounds(entry).map(sound => ({
    name: sound.name || '',
    size: Number(sound.size) || 0,
    type: sound.type || '',
    dataUrl: sound.dataUrl,
    updated: sound.updated || 0
  }));
  delete entry.dataUrl;
  delete entry.name;
  delete entry.size;
  delete entry.type;
  delete entry.updated;

  if (!Array.isArray(entry.speakTemplates)) {
    entry.speakTemplates = Array.isArray(entry.speakTemplates) ? entry.speakTemplates : [];
  }
  if (entry.speakTemplate !== undefined && entry.speakTemplate !== null) {
    entry.speakTemplates.push(String(entry.speakTemplate));
  }
  entry.speakTemplates = settingsAudioValidTemplates(entry);
  if (!entry.speakTemplates.length && defTemplate) entry.speakTemplates = [String(defTemplate)];
  delete entry.speakTemplate;
  settingsAudioApplyNumericFields(entry, key);
  return entry;
}
function settingsModalUpdateAudioUi(key){
  const cfg = SETTINGS_AUDIO_FIELDS[key];
  if (!cfg) return;
  const label = document.getElementById(cfg.labelId);
  const preview = document.getElementById(cfg.previewId);
  const clear = document.getElementById(cfg.clearId);
  const toggle = cfg.toggleId ? document.getElementById(cfg.toggleId) : null;
  const speakToggle = cfg.speakToggleId ? document.getElementById(cfg.speakToggleId) : null;
  const speakLabel = cfg.speakLabelId ? document.getElementById(cfg.speakLabelId) : null;
  const templateInput = cfg.templateInputId ? document.getElementById(cfg.templateInputId) : null;
  const templateAdd = cfg.templateAddId ? document.getElementById(cfg.templateAddId) : null;
  const templateList = cfg.templateListId ? document.getElementById(cfg.templateListId) : null;
  const audioList = cfg.listId ? document.getElementById(cfg.listId) : null;
  const speakHelp = cfg.speakHelpId ? document.getElementById(cfg.speakHelpId) : null;
  const entry = settingsAudioEnsureEntry(key);
  const sounds = settingsAudioValidSounds(entry);
  const templates = settingsAudioValidTemplates(entry);
  if (toggle) toggle.checked = !!entry.enabled;
  const speechSupported = settingsSpeechSupported();
  if (speakToggle) {
    speakToggle.checked = !!entry.speak;
    speakToggle.disabled = !speechSupported;
  }
  const speechInputsEnabled = speechSupported && !!entry.speak;
  const numericFields = Array.isArray(cfg.numericFields) ? cfg.numericFields : [];
  numericFields.forEach(field => {
    if (!field || !field.inputId) return;
    const input = document.getElementById(field.inputId);
    if (!input) return;
    const value = entry[field.key];
    if (Number.isFinite(value)) {
      input.value = String(value);
    } else if (field.defaultValue !== undefined) {
      const fallback = settingsAudioClampNumeric(field.defaultValue, field);
      input.value = fallback !== undefined ? String(fallback) : '';
    } else {
      input.value = '';
    }
    input.disabled = false;
  });
  const previewSpeech = entry.speak ? settingsModalBuildPreviewSpeechText(key, entry) : '';
  const canSpeak = speechSupported && !!entry.speak && !!previewSpeech;
  if (speakLabel) {
    if (!speakLabel.dataset.labelDefault) speakLabel.dataset.labelDefault = speakLabel.textContent || '';
    const base = speakLabel.dataset.labelDefault || '';
    speakLabel.textContent = speechSupported ? base : `${base} (not supported in this browser)`;
  }
  if (speakHelp) {
    const hint = cfg.placeholderHint ? `Speech template placeholders: ${cfg.placeholderHint}` : (speakHelp.dataset.placeholderBase || speakHelp.textContent || '');
    if (!speakHelp.dataset.placeholderBase) speakHelp.dataset.placeholderBase = speakHelp.textContent || '';
    speakHelp.textContent = hint;
    speakHelp.style.display = speechInputsEnabled ? '' : 'none';
  }
  if (templateInput) {
    templateInput.disabled = !speechInputsEnabled;
  }
  if (templateAdd) {
    const readyValue = templateInput ? templateInput.value.trim() : '';
    templateAdd.disabled = !speechInputsEnabled || !readyValue;
  }
  if (templateList) {
    if (templates.length) {
      templateList.innerHTML = templates.map((tpl, idx) => {
        const safe = escHtml(tpl);
        return `<li class="list-group-item d-flex align-items-center gap-2" data-template-index="${idx}">
  <input class="form-control form-control-sm flex-grow-1" value="${safe}" data-template-index="${idx}">
  <button type="button" class="btn btn-outline-danger btn-sm" data-action="remove-template">Remove</button>
</li>`;
      }).join('');
    } else {
      templateList.innerHTML = '<li class="list-group-item small text-muted">Default template will be used.</li>';
    }
    templateList.querySelectorAll('input[data-template-index]').forEach(inputEl => {
      inputEl.disabled = !speechInputsEnabled;
    });
    templateList.querySelectorAll('[data-action="remove-template"]').forEach(btn => {
      btn.disabled = !speechInputsEnabled;
    });
  }
  if (audioList) {
    if (sounds.length) {
      audioList.innerHTML = sounds.map((sound, idx) => {
        const name = sound.name ? escHtml(String(sound.name)) : `Clip ${idx + 1}`;
        const sizeBytes = Number(sound.size);
        const sizeLabel = Number.isFinite(sizeBytes) && sizeBytes > 0 ? `${Math.round(sizeBytes / 1024)} KB` : 'Size unknown';
        const typeLabel = sound.type ? sound.type : 'Audio';
  const meta = `${sizeLabel}${typeLabel ? ` | ${escHtml(String(typeLabel))}` : ''}`;
        return `<li class="list-group-item d-flex align-items-center justify-content-between gap-2" data-sound-index="${idx}">
  <div class="flex-grow-1">
    <div>${name}</div>
    <div class="small text-muted">${meta}</div>
  </div>
  <div class="btn-group btn-group-sm">
    <button type="button" class="btn btn-outline-secondary" data-action="preview-sound">Preview</button>
    <button type="button" class="btn btn-outline-danger" data-action="remove-sound">Remove</button>
  </div>
</li>`;
      }).join('');
    } else {
      audioList.innerHTML = '<li class="list-group-item small text-muted">No custom clips.</li>';
    }
  }
  const desc = describeAudioEntry(entry);
  if (label) label.textContent = entry && entry.enabled ? desc : `${desc} (disabled)`;
  const hasCustomAudio = sounds.length > 0;
  if (preview) preview.disabled = !(hasCustomAudio || canSpeak);
  if (clear) clear.disabled = !hasCustomAudio;
}
function settingsModalUpdateAllAudio(){ Object.keys(SETTINGS_AUDIO_FIELDS).forEach(settingsModalUpdateAudioUi); }
function settingsModalResetFromStorage(){
  const settings = readSettings();
  _settingsSpeechSupported = settingsSpeechSupported();
  settingsModalUpdateTtsSupportNote();
  const storedTts = settingsReadStoredTts(settings);
  _settingsTtsWorking = { rate: storedTts.rate, pitch: storedTts.pitch };
  const rateInput = document.getElementById('settings-tts-rate');
  const pitchInput = document.getElementById('settings-tts-pitch');
  if (rateInput) rateInput.value = String(storedTts.rate ?? SETTINGS_TTS_DEFAULT_RATE);
  if (pitchInput) pitchInput.value = String(storedTts.pitch ?? SETTINGS_TTS_DEFAULT_PITCH);
  settingsModalSyncTtsWorkingFromInputs();
  const defCfg = document.getElementById('def-cfg');
  const defVm = document.getElementById('def-vm');
  const defMat = document.getElementById('def-mat');
  if (defCfg) defCfg.checked = !!settings.defaultCfgExpanded;
  if (defVm) defVm.checked = !!settings.defaultVmExpanded;
  if (defMat) defMat.checked = !!settings.defaultMatExpanded;
  const storedAudio = cloneSettingsAudio(settings.audio);
  _settingsAudioWorking = {};
  Object.keys(SETTINGS_AUDIO_FIELDS).forEach((key)=>{
    const saved = storedAudio && typeof storedAudio[key] === 'object' ? cloneSettingsAudio(storedAudio[key]) : {};
    if (saved && saved.enabled === undefined) saved.enabled = settingsAudioDefaultEnabled(key);
    if (saved && saved.speak === undefined) saved.speak = settingsAudioDefaultSpeak(key);
    settingsAudioNormalizeLegacyTemplate(saved, key);
    _settingsAudioWorking[key] = saved && typeof saved === 'object' ? saved : {};
    settingsAudioEnsureEntry(key);
  });
  settingsModalUpdateAllAudio();
}
function settingsModalHandleFile(key, file){
  if (!file) return;
  if (file.size > SETTINGS_AUDIO_MAX_BYTES) {
    alert('Audio file too large. Limit is 600 KB per sound.');
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    const dataUrl = typeof reader.result === 'string' ? reader.result : '';
    if (!dataUrl.startsWith('data:')) {
      alert('Unsupported audio format.');
      return;
    }
    const entry = settingsAudioEnsureEntry(key);
    entry.sounds.push({
      name: file.name || `Clip ${entry.sounds.length + 1}`,
      size: file.size || 0,
      type: file.type || '',
      dataUrl,
      updated: Date.now()
    });
    settingsModalUpdateAudioUi(key);
  };
  reader.onerror = () => {
    alert('Failed to read audio file.');
  };
  reader.readAsDataURL(file);
}
function settingsModalPreviewAudio(key, soundIndex){
  try {
    const entry = settingsAudioEnsureEntry(key);
    if (!entry) return;
    const speechSupported = settingsSpeechSupported();
    const wantsSpeech = speechSupported && !!entry.speak;
    const speechText = wantsSpeech ? settingsModalBuildPreviewSpeechText(key, entry) : '';
    const hasSpeech = !!speechText;
    const sounds = settingsAudioValidSounds(entry);
    const idx = Number.isFinite(soundIndex) ? Number(soundIndex) : NaN;
    const clip = Number.isFinite(idx) && idx >= 0 && idx < sounds.length ? sounds[idx] : (sounds[0] || null);
    let fallbackTimer = null;
    let speechTriggered = false;
    const triggerSpeech = ()=>{
      if (!hasSpeech || speechTriggered) return;
      speechTriggered = true;
      if (fallbackTimer) { clearTimeout(fallbackTimer); fallbackTimer = null; }
      settingsModalSpeakPreview(speechText);
    };
    const scheduleFallback = (audio)=>{
      if (!hasSpeech) return;
      // Keep speech aligned with audio completion even if metadata is missing.
      let waitMs = 4000;
      const durationMs = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration * 1000 : 0;
      if (durationMs > 0) waitMs = Math.min(10000, Math.max(600, durationMs + 300));
      if (fallbackTimer) clearTimeout(fallbackTimer);
      fallbackTimer = setTimeout(triggerSpeech, waitMs);
    };
    if (clip && clip.dataUrl) {
      const audio = new Audio(clip.dataUrl);
      if (hasSpeech) {
        scheduleFallback(audio);
        audio.addEventListener('loadedmetadata', ()=> scheduleFallback(audio), { once: true });
        audio.addEventListener('ended', triggerSpeech, { once: true });
        audio.addEventListener('error', triggerSpeech, { once: true });
        audio.addEventListener('abort', triggerSpeech, { once: true });
      }
      audio.play().catch(()=> triggerSpeech());
    } else {
      triggerSpeech();
    }
  } catch {}
}
function settingsModalClearAudio(key){
  const entry = settingsAudioEnsureEntry(key);
  entry.sounds = [];
  settingsModalUpdateAudioUi(key);
}
function settingsModalRemoveSound(key, index){
  const entry = settingsAudioEnsureEntry(key);
  if (!Array.isArray(entry.sounds)) entry.sounds = [];
  const idx = Number(index);
  if (!Number.isFinite(idx) || idx < 0 || idx >= entry.sounds.length) return;
  entry.sounds.splice(idx, 1);
  settingsModalUpdateAudioUi(key);
}
function settingsModalAddTemplate(key){
  const cfg = SETTINGS_AUDIO_FIELDS[key];
  if (!cfg) return;
  const entry = settingsAudioEnsureEntry(key);
  if (!Array.isArray(entry.speakTemplates)) entry.speakTemplates = [];
  const input = cfg.templateInputId ? document.getElementById(cfg.templateInputId) : null;
  const addBtn = cfg.templateAddId ? document.getElementById(cfg.templateAddId) : null;
  const raw = input ? input.value.trim() : '';
  if (!raw) {
    if (addBtn) addBtn.disabled = true;
    return;
  }
  entry.speakTemplates.push(raw);
  if (input) input.value = '';
  settingsModalUpdateAudioUi(key);
}
function settingsModalRemoveTemplate(key, index){
  const entry = settingsAudioEnsureEntry(key);
  if (!Array.isArray(entry.speakTemplates)) entry.speakTemplates = [];
  const idx = Number(index);
  if (!Number.isFinite(idx) || idx < 0 || idx >= entry.speakTemplates.length) return;
  entry.speakTemplates.splice(idx, 1);
  settingsModalUpdateAudioUi(key);
}
function settingsModalSetTemplate(key, index, value){
  const entry = settingsAudioEnsureEntry(key);
  if (!Array.isArray(entry.speakTemplates)) entry.speakTemplates = [];
  const idx = Number(index);
  if (!Number.isFinite(idx) || idx < 0 || idx >= entry.speakTemplates.length) return;
  entry.speakTemplates[idx] = value;
}
function wireSettingsAudioControls(){
  Object.entries(SETTINGS_AUDIO_FIELDS).forEach(([key, cfg]) => {
    const input = document.getElementById(cfg.inputId);
    const preview = document.getElementById(cfg.previewId);
    const clear = document.getElementById(cfg.clearId);
    const toggle = cfg.toggleId ? document.getElementById(cfg.toggleId) : null;
    const speakToggle = cfg.speakToggleId ? document.getElementById(cfg.speakToggleId) : null;
    const templateInput = cfg.templateInputId ? document.getElementById(cfg.templateInputId) : null;
    const templateAdd = cfg.templateAddId ? document.getElementById(cfg.templateAddId) : null;
    const templateList = cfg.templateListId ? document.getElementById(cfg.templateListId) : null;
    const audioList = cfg.listId ? document.getElementById(cfg.listId) : null;
    const numericFields = Array.isArray(cfg.numericFields) ? cfg.numericFields : [];
    if (input && !input._toolhubBound) {
      input.addEventListener('change', (ev)=>{
        const file = ev.target && ev.target.files && ev.target.files[0];
        settingsModalHandleFile(key, file || null);
        try { ev.target.value = ''; } catch {}
      });
      input._toolhubBound = true;
    }
    numericFields.forEach(field => {
      if (!field || !field.inputId) return;
      const numInput = document.getElementById(field.inputId);
      if (!numInput || numInput._toolhubBound) return;
      const commitValue = ()=>{
        const entry = settingsAudioEnsureEntry(key);
        const raw = String(numInput.value || '').trim();
        if (!raw) {
          if (field.defaultValue !== undefined) {
            const fallback = settingsAudioClampNumeric(field.defaultValue, field);
            if (fallback !== undefined) entry[field.key] = fallback;
            else delete entry[field.key];
          } else {
            delete entry[field.key];
          }
        } else {
          const clamped = settingsAudioClampNumeric(raw, field);
          if (clamped === undefined) {
            const existing = entry[field.key];
            if (Number.isFinite(existing)) numInput.value = String(existing);
            else if (field.defaultValue !== undefined) {
              const fallback = settingsAudioClampNumeric(field.defaultValue, field);
              if (fallback !== undefined) numInput.value = String(fallback);
            } else {
              numInput.value = '';
            }
            return;
          }
          entry[field.key] = clamped;
        }
        settingsAudioApplyNumericFields(entry, key);
        settingsModalUpdateAudioUi(key);
      };
      numInput.addEventListener('change', commitValue);
      numInput.addEventListener('blur', commitValue);
      numInput.addEventListener('keydown', ev => {
        if (ev.key === 'Enter') {
          ev.preventDefault();
          commitValue();
          numInput.blur();
        }
      });
      numInput._toolhubBound = true;
    });
    if (preview && !preview._toolhubBound) {
      preview.addEventListener('click', ()=> settingsModalPreviewAudio(key));
      preview._toolhubBound = true;
    }
    if (clear && !clear._toolhubBound) {
      clear.addEventListener('click', ()=> settingsModalClearAudio(key));
      clear._toolhubBound = true;
    }
    if (toggle && !toggle._toolhubBound) {
      toggle.addEventListener('change', ()=>{
        const entry = settingsAudioEnsureEntry(key);
        entry.enabled = !!toggle.checked;
        settingsModalUpdateAudioUi(key);
      });
      toggle._toolhubBound = true;
    }
    if (speakToggle && !speakToggle._toolhubBound) {
      speakToggle.addEventListener('change', ()=>{
        const entry = settingsAudioEnsureEntry(key);
        entry.speak = !!speakToggle.checked;
        settingsModalUpdateAudioUi(key);
      });
      speakToggle._toolhubBound = true;
    }
    if (templateInput && !templateInput._toolhubBound) {
      const refreshAddState = ()=>{
        if (templateAdd) {
          templateAdd.disabled = templateInput.disabled || !templateInput.value.trim();
        }
      };
      templateInput.addEventListener('input', refreshAddState);
      templateInput.addEventListener('blur', refreshAddState);
      templateInput.addEventListener('keydown', (ev)=>{
        if (ev.key === 'Enter') {
          ev.preventDefault();
          settingsModalAddTemplate(key);
        }
      });
      refreshAddState();
      templateInput._toolhubBound = true;
    }
    if (templateAdd && !templateAdd._toolhubBound) {
      templateAdd.addEventListener('click', ()=> settingsModalAddTemplate(key));
      templateAdd._toolhubBound = true;
    }
    if (templateList && !templateList._toolhubBound) {
      templateList.addEventListener('input', (ev)=>{
        const inputEl = ev.target && ev.target.closest('input[data-template-index]');
        if (!inputEl) return;
        const idx = Number(inputEl.getAttribute('data-template-index'));
        settingsModalSetTemplate(key, idx, inputEl.value);
      });
      templateList.addEventListener('blur', (ev)=>{
        const inputEl = ev.target && ev.target.closest('input[data-template-index]');
        if (!inputEl) return;
        const idx = Number(inputEl.getAttribute('data-template-index'));
        const trimmed = inputEl.value.trim();
        settingsModalSetTemplate(key, idx, trimmed);
        inputEl.value = trimmed;
      }, true);
      templateList.addEventListener('click', (ev)=>{
        const btn = ev.target && ev.target.closest('[data-action="remove-template"]');
        if (!btn) return;
        ev.preventDefault();
        const parent = btn.closest('[data-template-index]');
        if (!parent) return;
        const rawIdx = parent.getAttribute('data-template-index');
        if (rawIdx == null) return;
        settingsModalRemoveTemplate(key, Number(rawIdx));
      });
      templateList._toolhubBound = true;
    }
    if (audioList && !audioList._toolhubBound) {
      audioList.addEventListener('click', (ev)=>{
        const previewBtn = ev.target && ev.target.closest('[data-action="preview-sound"]');
        if (previewBtn) {
          const row = previewBtn.closest('[data-sound-index]');
          const rawIdx = row ? row.getAttribute('data-sound-index') : null;
          const idx = rawIdx != null ? Number(rawIdx) : NaN;
          settingsModalPreviewAudio(key, Number.isFinite(idx) ? idx : undefined);
          return;
        }
        const removeBtn = ev.target && ev.target.closest('[data-action="remove-sound"]');
        if (removeBtn) {
          const row = removeBtn.closest('[data-sound-index]');
          const rawIdx = row ? row.getAttribute('data-sound-index') : null;
          const idx = rawIdx != null ? Number(rawIdx) : NaN;
          settingsModalRemoveSound(key, idx);
        }
      });
      audioList._toolhubBound = true;
    }
  });
}
function wireSettingsModal(){
  const modal = document.getElementById('settingsModal');
  if (!modal || modal._toolhubBound) return;
  modal._toolhubBound = true;
  wireSettingsAudioControls();
  wireSettingsTtsControls();
  modal.addEventListener('show.bs.modal', settingsModalResetFromStorage);
  modal.addEventListener('hidden.bs.modal', settingsModalResetFromStorage);
  settingsModalResetFromStorage();
}
window.prepareSettingsModal = wireSettingsModal;
function saveSettingsInternal(){
  const settings = readSettings();
  const defCfg = document.getElementById('def-cfg');
  const defVm = document.getElementById('def-vm');
  const defMat = document.getElementById('def-mat');
  if (defCfg) settings.defaultCfgExpanded = !!defCfg.checked;
  if (defVm) settings.defaultVmExpanded = !!defVm.checked;
  if (defMat) settings.defaultMatExpanded = !!defMat.checked;
  settingsModalSyncTtsWorkingFromInputs();
  const nextRate = settingsClampNumber(_settingsTtsWorking.rate ?? SETTINGS_TTS_DEFAULT_RATE, SETTINGS_TTS_MIN_RATE, SETTINGS_TTS_MAX_RATE, SETTINGS_TTS_DEFAULT_RATE);
  const nextPitch = settingsClampNumber(_settingsTtsWorking.pitch ?? SETTINGS_TTS_DEFAULT_PITCH, SETTINGS_TTS_MIN_PITCH, SETTINGS_TTS_MAX_PITCH, SETTINGS_TTS_DEFAULT_PITCH);
  const roundedRate = settingsRoundTts(nextRate) ?? SETTINGS_TTS_DEFAULT_RATE;
  const roundedPitch = settingsRoundTts(nextPitch) ?? SETTINGS_TTS_DEFAULT_PITCH;
  _settingsTtsWorking = { rate: roundedRate, pitch: roundedPitch };
  if (roundedRate === SETTINGS_TTS_DEFAULT_RATE && roundedPitch === SETTINGS_TTS_DEFAULT_PITCH) {
    delete settings.tts;
    delete settings.ttsRate;
    delete settings.ttsPitch;
  } else {
    settings.tts = { rate: roundedRate, pitch: roundedPitch };
    delete settings.ttsRate;
    delete settings.ttsPitch;
  }
  const mergedAudio = {};
  Object.keys(SETTINGS_AUDIO_FIELDS).forEach((key)=>{
    const entry = settingsAudioEnsureEntry(key);
    const defEnabled = settingsAudioDefaultEnabled(key);
    const defSpeak = settingsAudioDefaultSpeak(key);
    const defTemplate = settingsAudioDefaultSpeakTemplate(key);
    const enabled = entry.enabled === undefined ? defEnabled : !!entry.enabled;
    const speak = entry.speak === undefined ? defSpeak : !!entry.speak;
    const sounds = settingsAudioValidSounds(entry);
    const templates = settingsAudioValidTemplates(entry);
    const payload = {};
    if (enabled !== defEnabled) payload.enabled = enabled;
    if (speak !== defSpeak) payload.speak = speak;
    if (sounds.length) {
      payload.sounds = sounds.map(sound => ({
        name: sound.name || '',
        size: Number(sound.size) || 0,
        type: sound.type || '',
        dataUrl: sound.dataUrl,
        updated: sound.updated || Date.now()
      }));
    }
    const defTemplateTrimmed = typeof defTemplate === 'string' ? defTemplate.trim() : '';
    const normalizedTemplates = templates.map(t => t.trim()).filter(Boolean);
    const shouldStoreTemplates = normalizedTemplates.length > 0 && !(normalizedTemplates.length === 1 && normalizedTemplates[0] === defTemplateTrimmed);
    if (shouldStoreTemplates) payload.speakTemplates = normalizedTemplates;
    const cfg = SETTINGS_AUDIO_FIELDS[key];
    if (cfg && Array.isArray(cfg.numericFields)) {
      cfg.numericFields.forEach(field => {
        if (!field || !field.key) return;
        const value = entry[field.key];
        const defaultValue = field.defaultValue !== undefined ? settingsAudioClampNumeric(field.defaultValue, field) : undefined;
        if (Number.isFinite(value)) {
          if (defaultValue === undefined || value !== defaultValue) payload[field.key] = value;
        } else if (defaultValue !== undefined && payload[field.key] !== undefined) {
          delete payload[field.key];
        }
      });
    }
    if (!Object.keys(payload).length) return;
    mergedAudio[key] = payload;
  });
  if (Object.keys(mergedAudio).length) settings.audio = mergedAudio;
  else delete settings.audio;
  writeSettings(settings);
  settingsModalResetFromStorage();
  try { document.dispatchEvent(new CustomEvent('settings-changed', { detail: { settings } })); } catch {}
  try { showToast('Settings saved.', 'success'); } catch {}
  const modal = document.getElementById('settingsModal');
  if (modal && window.bootstrap && window.bootstrap.Modal) {
    const inst = bootstrap.Modal.getInstance(modal) || null;
    if (inst) inst.hide();
  }
}
window.saveSettings = saveSettingsInternal;

async function loadProjects() {
  const container = document.getElementById('projects');
  container.innerHTML = '<div class="text-muted">Loading...</div>';
  try {
  try { (window.shell && shell.logInfo) ? shell.logInfo('Config: loading projects…') : console.log('Config: loading projects…'); } catch {}
    const data = await http('GET', '/api/projects');
    container.innerHTML = '';
    // Reset cache
    window.PROJ_CACHE = {};
    for (const p of data.projects) window.PROJ_CACHE[p.id] = p;
    const selected = (window.shell && shell.getCurrentProjectId) ? shell.getCurrentProjectId() : '';
    if (selected) {
      const p = (data.projects || []).find(x => x.id === selected);
      if (p) {
        container.appendChild(renderProjectCard(p));
      } else {
        container.innerHTML = '<div class="text-muted">Selected project not found. Choose a project from the left.</div>';
      }
    } else {
      if (!data.projects.length) {
        container.innerHTML = '<div class="text-muted">No projects yet. Create one using the sidebar.</div>';
      } else {
        container.innerHTML = '<div class="text-muted">Select a project from the left to view its configuration.</div>';
      }
    }
    try { (window.shell && shell.logSuccess) ? shell.logSuccess(`Config: loaded ${(data.projects||[]).length} project(s)`) : console.log('Config: projects loaded'); } catch {}
  } catch (e) {
    container.innerHTML = `<div class="text-danger">Error: ${e.message}</div>`;
    try { (window.shell && shell.logError) ? shell.logError('Config: load projects failed: ' + e.message) : console.error('Config load failed:', e); } catch {}
  }
}

// Create a new project from the sidebar input
async function createProject() {
  const input = document.getElementById('proj-name');
  const name = (input && input.value ? input.value.trim() : '');
  if (!name) { try { showToast('Enter a project name.', 'warning'); } catch {} return; }
  try {
    try { (window.shell && shell.logInfo) ? shell.logInfo(`Config: creating project \"${name}\"…`) : console.log('Creating project', name); } catch {}
    const res = await http('POST', '/api/projects', { name });
    // Clear input
    try { if (input) input.value = ''; } catch {}
    const pid = res && (res.id || res.pid) ? (res.id || res.pid) : '';
    // Select the newly created project and refresh views
    try { if (pid && window.shell && shell.setCurrentProjectId) shell.setCurrentProjectId(pid); } catch {}
    // Always navigate (or stay) on configuration page so the new project loads expanded
    try {
      if (location.pathname !== '/' && location.pathname !== '/index.html') {
        // Persist selection then redirect; index page on load will call loadProjects and show it
        return location.href = '/';
      }
    } catch {}
    await loadProjects(); // already on configuration page
    try { if (window.shell && shell.refreshSidebar) await shell.refreshSidebar('config'); } catch {}
    try { showToast('Project created.', 'success'); } catch {}
  } catch (e) {
    try { showToast('Failed to create project: ' + (e?.message || e), 'danger'); } catch {}
    try { (window.shell && shell.logError) ? shell.logError('Config: create project failed: ' + (e?.message || e)) : console.error('Create project failed:', e); } catch {}
  }
}

// Allow pressing Enter in the project name input to create
window.addEventListener('DOMContentLoaded', () => {
  const input = document.getElementById('proj-name');
  if (input) {
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        createProject();
      }
    });
  }
});

function escHtml(s) { return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;','\'':'&#39;'}[c])); }

// Simple validators
function isValidVmName(name) {
  // Letters/numbers with internal dashes, no leading/trailing dash
  return /^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/.test(String(name || ''));
}
function isValidTag(tag) {
  // Allow empty or letters/dashes only (no other chars)
  const t = String(tag || '');
  return t === '' || /^[A-Za-z-]+$/.test(t);
}

let _pendingSaveTimers = {};
const _pendingVmSaveTimers = {};
const _vmSavePending = {};
const _vmSaveInflight = {};

function setVmStatus(pid, idx, message, tone = 'text-muted') {
  const el = document.getElementById(`vm-save-status-${pid}-${idx}`);
  if (!el) return;
  if (!message) {
    el.textContent = '';
    el.className = 'small text-muted';
    return;
  }
  el.textContent = message;
  el.className = `small ${tone}`;
}

function debounceVmSave(pid, idx, delay = 600) {
  const key = `${pid}:${idx}`;
  _vmSavePending[key] = true;
  if (_pendingVmSaveTimers[key]) clearTimeout(_pendingVmSaveTimers[key]);
  _pendingVmSaveTimers[key] = setTimeout(() => {
    delete _pendingVmSaveTimers[key];
    processVmAutoSave(pid, idx, key);
  }, delay);
  setVmStatus(pid, idx, 'Pending save…', 'text-muted');
}

async function processVmAutoSave(pid, idx, key) {
  if (_vmSaveInflight[key]) {
    _vmSavePending[key] = true;
    return;
  }
  _vmSaveInflight[key] = true;
  _vmSavePending[key] = false;
  try {
    await autoSaveVm(pid, idx);
  } finally {
    _vmSaveInflight[key] = false;
    if (_vmSavePending[key]) {
      _vmSavePending[key] = false;
      processVmAutoSave(pid, idx, key);
    }
  }
}

function debounceProjectSave(pid, field, delay=600) {
  const key = pid + ':' + field;
  if (_pendingSaveTimers[key]) clearTimeout(_pendingSaveTimers[key]);
  _pendingSaveTimers[key] = setTimeout(() => {
    try { autoSaveProjectField(pid); } catch(e) { console.error('Auto-save failed', e); }
    delete _pendingSaveTimers[key];
  }, delay);
}

async function autoSaveProjectField(pid) {
  const card = document.getElementById('proj-card-' + pid);
  if (!card) return;
  // Build minimal payload from current DOM values (respect disabled future fields)
  const tagVal = document.getElementById(`cfg-${pid}-tag`)?.value || '';
  if (!isValidTag(tagVal)) { return; }
  const payload = {
    name: (function(){ const el = card.querySelector('input[aria-label="Project name"]'); return (el && el.value ? el.value.trim() : ''); })(),
    proxmox_url: document.getElementById(`cfg-${pid}-proxmox_url`)?.value?.trim(),
    proxmox_api_port: Number(document.getElementById(`cfg-${pid}-proxmox_api_port`)?.value),
    proxmox_ssh_port: Number(document.getElementById(`cfg-${pid}-proxmox_ssh_port`)?.value),
    instances: Number(document.getElementById(`cfg-${pid}-instances`)?.value),
    tag: tagVal,
    // Advanced Proxmox
    proxmox_vm_config_path: document.getElementById(`cfg-${pid}-proxmox_vm_config_path`)?.value?.trim(),
    proxmox_qm_path: document.getElementById(`cfg-${pid}-proxmox_qm_path`)?.value?.trim(),
    proxmox_pvesh_path: document.getElementById(`cfg-${pid}-proxmox_pvesh_path`)?.value?.trim(),
    proxmox_qmrestore_path: document.getElementById(`cfg-${pid}-proxmox_qmrestore_path`)?.value?.trim(),
    proxmox_storage_volume: document.getElementById(`cfg-${pid}-proxmox_storage_volume`)?.value?.trim(),
    proxmox_max_create_jobs: Number(document.getElementById(`cfg-${pid}-proxmox_max_create_jobs`)?.value),
    proxmox_snapshot_delay_seconds: Number(document.getElementById(`cfg-${pid}-proxmox_snapshot_delay_seconds`)?.value),
    proxmox_use_linked_clones: !!(document.getElementById(`cfg-${pid}-proxmox_use_linked_clones`)?.checked),
  };
  // Optional future fields (skip if disabled)
  const optIds = ['keycloak_url','keycloak_port','keycloak_nodename','challenge_url','challenge_port'];
  optIds.forEach(id => {
    const el = document.getElementById(`cfg-${pid}-`+id);
    if (el && !el.disabled) {
      let v = el.value;
      if (id.endsWith('_port') || id==='keycloak_port' || id==='challenge_port') v = Number(v);
      payload[id] = v;
    }
  });
  try {
    await http('PATCH', `/api/projects/${pid}`, payload);
    try {
      const cache = window.PROJ_CACHE || {};
      const prev = cache[pid] || {};
      const next = { ...prev };
      Object.entries(payload).forEach(([k, v]) => {
        if (v !== undefined) next[k] = v;
      });
      cache[pid] = next;
      window.PROJ_CACHE = cache;
      const prevName = typeof prev.name === 'string' ? prev.name : '';
      const newName = typeof next.name === 'string' ? next.name : prevName;
      if (newName && newName !== prevName) {
        try { if (window.shell && shell.refreshSidebar) shell.refreshSidebar('config'); } catch {}
      }
    } catch {}
    try { showStatusDot(pid, 'saved'); } catch {}
  } catch(e) {
    try { showStatusDot(pid, 'error'); } catch {}
  }
}

async function autoSaveVm(pid, idx) {
  const nameEl = document.getElementById(`vm-name-display-${pid}-${idx}`);
  const name = (nameEl?.textContent || '').trim();
  if (!pid || !name) {
    setVmStatus(pid, idx, '', 'text-muted');
    return;
  }
  setVmStatus(pid, idx, 'Saving…', 'text-muted');
  const vmidEl = document.getElementById(`vm-${pid}-${idx}-vmid`);
  let vmid = null;
  if (vmidEl) {
    const raw = String(vmidEl.value ?? '').trim();
    if (raw) {
      const parsed = Number(raw);
      vmid = Number.isFinite(parsed) ? parsed : null;
    }
  }
  const collectValues = (selector) => Array.from(document.querySelectorAll(selector)).map(input => (input.value || '').trim()).filter(v => v !== '');
  const startCommands = collectValues(`#vm-${pid}-${idx}-start-list input`);
  const storedCommands = collectValues(`#vm-${pid}-${idx}-stored-list input`);
  const adaptors = collectValues(`#vm-${pid}-${idx}-nets-list input`).map(val => val.replace(/[^A-Za-z]/g, '').slice(0, 8)).filter(Boolean);
  const payload = {
    vmid: vmid,
    start_commands: startCommands,
    stored_commands: storedCommands,
    internal_network_adaptors: adaptors
  };
  try {
    await saveVM(pid, name, payload, { silent: true });
    try {
      if (window.PROJ_CACHE && window.PROJ_CACHE[pid] && Array.isArray(window.PROJ_CACHE[pid].vms)) {
        const list = window.PROJ_CACHE[pid].vms;
        const vmIdx = list.findIndex(v => v && v.name === name);
        if (vmIdx >= 0) {
          list[vmIdx] = {
            ...list[vmIdx],
            vmid: payload.vmid,
            start_commands: payload.start_commands,
            stored_commands: payload.stored_commands,
            internal_network_adaptors: payload.internal_network_adaptors
          };
        }
      }
    } catch {}
    setVmStatus(pid, idx, 'Saved', 'text-success');
    setTimeout(() => {
      const el = document.getElementById(`vm-save-status-${pid}-${idx}`);
      if (el && el.textContent === 'Saved') {
        el.textContent = '';
        el.className = 'small text-muted';
      }
    }, 1600);
  } catch (e) {
    setVmStatus(pid, idx, 'Save failed', 'text-danger');
    try { console.error('Auto-save VM failed', pid, name, e); } catch {}
  }
}

function showStatusDot(pid, state) {
  // state: 'saved' | 'error'
  let el = document.getElementById('save-status-'+pid);
  if (!el) return;
  el.textContent = state === 'saved' ? '●' : '⚠';
  el.className = state === 'saved' ? 'text-success ms-2 small' : 'text-danger ms-2 small';
  if (state === 'saved') {
    setTimeout(()=>{ if(el) el.textContent=''; }, 1600);
  }
}

function renderProjectCard(p) {
  const col = document.createElement('div');
  col.className = 'project-card';
  const vms = (p.vms || []).map((v, i) => `
    <div class="border rounded p-2 mb-2">
      <div id="vm-header-${p.id}-${i}" class="d-flex align-items-center justify-content-between vm-header" role="button" aria-controls="vm-collapse-${p.id}-${i}">
        <div class="d-flex align-items-center gap-2">
          <button class="btn btn-sm btn-link p-0" type="button" data-bs-toggle="collapse" data-bs-target="#vm-collapse-${p.id}-${i}" aria-expanded="false" aria-controls="vm-collapse-${p.id}-${i}" title="Toggle VM">
            <span id="vm-chevron-${p.id}-${i}" class="chevron">▶</span>
          </button>
          <strong id="vm-name-display-${p.id}-${i}">${escHtml(v.name)}</strong>
          <input id="vm-name-input-${p.id}-${i}" class="form-control form-control-sm d-none" value="${escHtml(v.name)}"
                 onkeydown="vmNameKey('${p.id}',${i}, event)" />
        </div>
        <div class="d-flex align-items-center gap-2">
          <button class="btn btn-sm btn-outline-secondary" onclick="startVmRename('${p.id}',${i})">Rename</button>
          <div class="form-check form-switch">
            <input class="form-check-input" type="checkbox" ${v.viewable_to_user ? 'checked' : ''} onchange="saveVM('${p.id}','${escHtml(v.name)}', {viewable_to_user: this.checked})">
            <label class="form-check-label">User-Accessible</label>
          </div>
          <button class="btn btn-sm btn-outline-danger" onclick="removeVM('${p.id}','${escHtml(v.name)}')">Remove</button>
        </div>
      </div>
      <div class="row g-2 mt-2 collapse" id="vm-collapse-${p.id}-${i}">
        <div class="col-md-3">
          <label class="form-label" title="Optional explicit VMID for the template">VM ID (optional)</label>
          <input type="number" min="0" id="vm-${p.id}-${i}-vmid" class="form-control form-control-sm" value="${(v.vmid ?? '')}" placeholder="e.g., 101" title="Explicit VMID to clone from (optional)" aria-label="VM ID" oninput="debounceVmSave('${p.id}', ${i})" />
        </div>
        <div class="col-md-4">
          <label class="form-label">Start Commands</label>
          <div class="d-flex gap-2 mb-2">
            <input class="form-control form-control-sm" id="vm-${p.id}-${i}-start-input" placeholder="Add command" title="Command run during startup" onkeydown="vmListKey('${p.id}',${i},'start',event)" />
            <button class="btn btn-sm btn-outline-primary" onclick="addListItem('vm-${p.id}-${i}-start-list','vm-${p.id}-${i}-start-input')">Add</button>
          </div>
          <ul class="list-group list-group-sm" id="vm-${p.id}-${i}-start-list">
            ${(v.start_commands||[]).map((c, idx) => listItemTemplate(`vm-${p.id}-${i}-start-list`, c, idx)).join('')}
          </ul>
        </div>
        <div class="col-md-4">
          <label class="form-label">Stored Commands</label>
          <div class="d-flex gap-2 mb-2">
            <input class="form-control form-control-sm" id="vm-${p.id}-${i}-stored-input" placeholder="Add stored command" title="Reusable command to run later" onkeydown="vmListKey('${p.id}',${i},'stored',event)" />
            <button class="btn btn-sm btn-outline-primary" onclick="addListItem('vm-${p.id}-${i}-stored-list','vm-${p.id}-${i}-stored-input')">Add</button>
          </div>
          <ul class="list-group list-group-sm" id="vm-${p.id}-${i}-stored-list">
            ${(v.stored_commands||[]).map((c, idx) => listItemTemplate(`vm-${p.id}-${i}-stored-list`, c, idx)).join('')}
          </ul>
        </div>
    <div class="col-md-4">
          <label class="form-label">Internal Network Adaptors</label>
          <div class="d-flex gap-2 mb-2">
            <input class="form-control form-control-sm" id="vm-${p.id}-${i}-nets-input" placeholder="Add adaptor" title="Internal network adaptor base name" oninput="onAdaptorInput('${p.id}', ${i}, this)" onkeydown="onAdaptorKeydown('${p.id}', ${i}, event)" />
            <button id="btn-add-net-${p.id}-${i}" class="btn btn-sm btn-outline-primary" onclick="addListItem('vm-${p.id}-${i}-nets-list','vm-${p.id}-${i}-nets-input')" disabled>Add</button>
          </div>
          <ul class="list-group list-group-sm" id="vm-${p.id}-${i}-nets-list">
            ${(v.internal_network_adaptors||[]).map((c, idx) => listItemTemplate(`vm-${p.id}-${i}-nets-list`, c, idx)).join('')}
          </ul>
        </div>
  <div class="col-12"><div class="small text-muted" id="vm-save-status-${p.id}-${i}"></div></div>
      </div>
    </div>
  `).join('');
  const mats = (p.materials || []).map(m => `
    <li class="list-group-item d-flex justify-content-between align-items-center">
      <a href="/api/projects/${p.id}/materials/${encodeURIComponent(m)}">${m}</a>
      <button class="btn btn-sm btn-outline-danger" onclick="deleteMaterial('${p.id}','${m}')">Delete</button>
    </li>
  `).join('');
  const cfgId = `cfg-${p.id}`;
  const matId = `mat-${p.id}`;
  const advId = `adv-${p.id}`;
  const instId = `inst-${p.id}`;
  const credsId = `creds-${p.id}`;
  const pstate = getProjState(p.id);
  const settings = readSettings();
  const cfgShow = pstate.cfgExpanded ?? !!settings.defaultCfgExpanded;
  const matShow = pstate.matExpanded ?? !!settings.defaultMatExpanded;
  const advShow = pstate.advExpanded ?? false;
  const vmShow = pstate.vmExpanded ?? !!settings.defaultVmExpanded;
  const credShow = pstate.credExpanded ?? false;
  const instShow = false; // Instances preview removed from Configuration
  const projShow = true; // always expanded; remove project-level collapse arrow
  col.innerHTML = `
  <div class="card h-100 expanded" id="proj-card-${p.id}">
      <div class="card-header d-flex align-items-center flex-wrap">
        <div class="d-flex align-items-center gap-2 flex-wrap">
          <input class="form-control form-control-sm" value="${p.name}" title="Project display name" aria-label="Project name" oninput="debounceProjectSave('${p.id}','name')" />
          <span id="save-status-${p.id}" class="ms-2 small text-muted" aria-label="Save status"></span>
        </div>
        <div class="ms-auto d-flex gap-2">
          <button class="btn btn-sm btn-outline-secondary" onclick="openExportOptions('${p.id}')">Export</button>
          <button class="btn btn-sm btn-outline-danger" onclick="deleteProject('${p.id}')">Delete</button>
        </div>
      </div>
  <div class="card-body d-flex flex-column">
        <div id="proj-collapse-${p.id}">
  <div class="section-box mb-3">
    <div id="cfg-header-${p.id}" class="d-flex align-items-center gap-2 section-header" role="button" aria-controls="${cfgId}">
      <span id="cfg-chevron-${p.id}" class="chevron">${cfgShow ? '▼' : '▶'}</span>
      <span>Configuration</span>
    </div>
    <div class="collapse ${cfgShow ? 'show' : ''}" id="${cfgId}">
          <h6>Connection Parameters</h6>
          <div class="row g-2">
            <div class="col-md-6">
              <label class="form-label" title="Base URL to your Proxmox node or cluster (e.g., https://host)">Proxmox URL</label>
              <input id="cfg-${p.id}-proxmox_url" class="form-control form-control-sm" value="${p.proxmox_url || ''}" placeholder="https://proxmox.example.com" title="Base URL to your Proxmox host (https://…)" oninput="debounceProjectSave('${p.id}','proxmox_url')" />
            </div>
            <div class="col-md-3">
              <label class="form-label" title="Proxmox API port (default 8006)">API Port</label>
              <input id="cfg-${p.id}-proxmox_api_port" type="number" class="form-control form-control-sm" value="${p.proxmox_api_port ?? 8006}" placeholder="8006" title="Proxmox API port" oninput="debounceProjectSave('${p.id}','proxmox_api_port')" />
            </div>
            <div class="col-md-3">
              <label class="form-label" title="SSH port used for VM commands">SSH Port</label>
              <input id="cfg-${p.id}-proxmox_ssh_port" type="number" class="form-control form-control-sm" value="${p.proxmox_ssh_port ?? 22}" placeholder="22" title="SSH port" oninput="debounceProjectSave('${p.id}','proxmox_ssh_port')" />
            </div>
            <div class="col-12"><hr class="my-3"/></div>
            <div class="col-md-6">
              <label class="form-label" title="Base URL to the CTFd platform">CTFd URL</label>
              <input id="cfg-${p.id}-challenge_url" class="form-control form-control-sm" value="${p.challenge_url || ''}" placeholder="https://ctfd.example.com" title="CTFd platform URL" oninput="debounceProjectSave('${p.id}','challenge_url')" />
            </div>
            <div class="col-md-3">
              <label class="form-label" title="CTFd platform port">CTFd Port</label>
              <input id="cfg-${p.id}-challenge_port" type="number" class="form-control form-control-sm" value="${p.challenge_port ?? 443}" placeholder="443" title="CTFd port" oninput="debounceProjectSave('${p.id}','challenge_port')" />
            </div>
              <div class="col-md-3">
                <label class="form-label" title="Number of student/participant instances">Instances</label>
                <input id="cfg-${p.id}-instances" type="number" min="1" class="form-control form-control-sm" value="${p.instances ?? 10}" oninput="onInstancesChange('${p.id}'); debounceProjectSave('${p.id}','instances')" onchange="onInstancesChange('${p.id}'); debounceProjectSave('${p.id}','instances')" title="Total instances to provision" />
              </div>
            <div class="col-md-3">
              <label class="form-label" title="Suffix inserted before the instance index (letters and dashes)">Tag</label>
              <input id="cfg-${p.id}-tag" class="form-control form-control-sm" value="${p.tag || '-set-'}" oninput="onTagChange('${p.id}'); debounceProjectSave('${p.id}','tag')" onchange="onTagChange('${p.id}'); debounceProjectSave('${p.id}','tag')" title="Letters and dashes only" />
            </div>
            
          </div>
        </div> <!-- end cfg collapse -->
  </div> <!-- end section-box cfg -->
  <div class="section-box mb-3">
    <div id="vms-header-${p.id}" class="d-flex align-items-center gap-2 section-header" role="button" aria-controls="vms-${p.id}">
      <span id="vms-chevron-${p.id}" class="chevron">${vmShow ? '▼' : '▶'}</span>
      <span>Virtual Machines</span>
    </div>
    <div class="collapse ${vmShow ? 'show' : ''}" id="vms-${p.id}">
          <div class="d-flex flex-wrap align-items-center gap-2">
            <div class="d-flex align-items-center gap-2 flex-grow-1" style="min-width: 300px;">
              <input id="vm-${p.id}" class="form-control form-control-sm" placeholder="Add VM name" pattern="[A-Za-z0-9]+(-[A-Za-z0-9]+)*" title="Letters, numbers, and internal dashes only (no leading/trailing dash)" aria-label="Add VM name" oninput="onVmNameInput('${p.id}')" />
              <button id="btn-add-vm-${p.id}" class="btn btn-sm btn-primary btn-equal" onclick="addVM('${p.id}')" disabled>Add VM Manually</button>
            </div>
            <button class="btn btn-sm btn-soft-success btn-equal" onclick="openAddFromServer('${p.id}')">Add VM from Server</button>
          </div>
          <div class="mt-2">${vms || '<span class="text-muted">No VMs</span>'}</div>
        </div> <!-- end vms collapse -->
  </div> <!-- end section-box vms -->
  <div class="section-box mb-3">
    <div id="creds-header-${p.id}" class="d-flex align-items-center gap-2 section-header" role="button" aria-controls="${credsId}">
      <span id="creds-chevron-${p.id}" class="chevron">${credShow ? '▼' : '▶'}</span>
      <span>Credentials</span>
    </div>
    <div class="collapse ${credShow ? 'show' : ''}" id="${credsId}">
          <div class="row g-2">
            <div class="col-12">
              <label class="form-label" title="One credential pair per instance">Credentials (username / password)</label>
              <div class="d-flex flex-wrap gap-2 mb-2">
                <label class="btn btn-outline-secondary btn-sm mb-0">
                  Upload CSV <input type="file" id="cfg-${p.id}-cred-file" accept=".csv,.txt" hidden onchange="uploadCredentialsFile('${p.id}')" />
                </label>
                <button class="btn btn-sm btn-outline-primary" onclick="generateCredentials('${p.id}')">Auto-generate</button>
                <button id="cred-add-${p.id}" class="btn btn-sm btn-outline-success" onclick="addCredentialRow('${p.id}')">Add Row</button>
                <button id="cred-download-${p.id}" class="btn btn-sm btn-outline-dark" onclick="downloadCredentials('${p.id}')" disabled>Download Credentials (CSV)</button>
              </div>
              <div id="cred-${p.id}-list">
                ${renderCredentials(p.id, p.credentials)}
              </div>
              <div id="cred-warn-${p.id}" class="text-danger small mt-1"></div>
              <small class="text-muted">Upload file with two columns: username,password (comma- or space-separated). Generate creates one per Instance with 8-char uppercase passwords.</small>
            </div>
          </div>
        </div> <!-- end creds collapse -->
  </div> <!-- end section-box creds -->
  <div class="section-box mb-3">
    <div id="mat-header-${p.id}" class="d-flex align-items-center gap-2 section-header" role="button" aria-controls="${matId}">
      <span id="mat-chevron-${p.id}" class="chevron">${matShow ? '▼' : '▶'}</span>
      <span>Materials</span>
    </div>
    <div class="collapse ${matShow ? 'show' : ''}" id="${matId}">
          <div class="d-flex align-items-center gap-2">
            <input id="file-${p.id}" type="file" class="form-control form-control-sm" title="Upload a file to Materials" />
            <button class="btn btn-sm btn-secondary" onclick="uploadMaterial('${p.id}')">Upload</button>
          </div>
          <div class="materials-scroll mt-2">
            <ul class="list-group list-group-flush">${mats || '<li class="list-group-item text-muted">No materials</li>'}</ul>
          </div>
        </div>
  <!-- Advanced moved to bottom -->
  <!-- Advanced moved to bottom -->
  </div> <!-- end section-box materials -->
  <div class="section-box mb-3">
    <div id="adv-header-${p.id}" class="d-flex align-items-center gap-2 section-header" role="button" aria-controls="${advId}">
      <span id="adv-chevron-${p.id}" class="chevron">${advShow ? '▼' : '▶'}</span>
      <span>Advanced</span>
    </div>
    <div class="collapse ${advShow ? 'show' : ''}" id="${advId}">
          <h6>Proxmox Configuration</h6>
          <div class="row g-2">
            <div class="col-md-6">
              <label class="form-label" title="Path on Proxmox for VM config files">VM Config Path</label>
              <input id="cfg-${p.id}-proxmox_vm_config_path" class="form-control form-control-sm" value="${p.proxmox_vm_config_path || '/etc/pve/qemu-server'}" oninput="debounceProjectSave('${p.id}','proxmox_vm_config_path')" />
            </div>
            <div class="col-md-3">
              <label class="form-label" title="qm binary path (if non-default)">qm Path</label>
              <input id="cfg-${p.id}-proxmox_qm_path" class="form-control form-control-sm" value="${p.proxmox_qm_path || 'qm'}" oninput="debounceProjectSave('${p.id}','proxmox_qm_path')" />
            </div>
            <div class="col-md-3">
              <label class="form-label" title="pvesh binary path (if non-default)">pvesh Path</label>
              <input id="cfg-${p.id}-proxmox_pvesh_path" class="form-control form-control-sm" value="${p.proxmox_pvesh_path || 'pvesh'}" oninput="debounceProjectSave('${p.id}','proxmox_pvesh_path')" />
            </div>
            <div class="col-md-3">
              <label class="form-label" title="qmrestore binary path (if non-default)">qmrestore Path</label>
              <input id="cfg-${p.id}-proxmox_qmrestore_path" class="form-control form-control-sm" value="${p.proxmox_qmrestore_path || 'qmrestore'}" oninput="debounceProjectSave('${p.id}','proxmox_qmrestore_path')" />
            </div>
            <div class="col-md-3">
              <label class="form-label" title="Target storage for full clones">Storage Volume</label>
              <input id="cfg-${p.id}-proxmox_storage_volume" class="form-control form-control-sm" value="${p.proxmox_storage_volume || 'local-lvm'}" oninput="debounceProjectSave('${p.id}','proxmox_storage_volume')" />
            </div>
            <div class="col-md-3">
              <label class="form-label" title="Limit concurrent create jobs">Max Create Jobs</label>
              <input id="cfg-${p.id}-proxmox_max_create_jobs" type="number" class="form-control form-control-sm" value="${p.proxmox_max_create_jobs ?? 20}" oninput="debounceProjectSave('${p.id}','proxmox_max_create_jobs')" />
            </div>
            <div class="col-md-3">
              <label class="form-label" title="Delay between snapshot operations">Snapshot Delay (seconds)</label>
              <input id="cfg-${p.id}-proxmox_snapshot_delay_seconds" type="number" step="0.1" class="form-control form-control-sm" value="${p.proxmox_snapshot_delay_seconds ?? 2.0}" oninput="debounceProjectSave('${p.id}','proxmox_snapshot_delay_seconds')" />
            </div>
            <div class="col-md-3">
              <label class="form-label">Use Linked Clones</label>
              <div class="form-check form-switch mt-1">
                <input class="form-check-input" type="checkbox" id="cfg-${p.id}-proxmox_use_linked_clones" ${p.proxmox_use_linked_clones !== false ? 'checked' : ''} title="Linked clones share disks with the template; uncheck for full clones" onchange="debounceProjectSave('${p.id}','proxmox_use_linked_clones', 50)" />
                <label class="form-check-label" for="cfg-${p.id}-proxmox_use_linked_clones">Linked (unchecked = Full)</label>
              </div>
            </div>
            <!-- Auto-save active: manual save button removed -->
          </div>
    </div> <!-- end advanced collapse -->
  </div> <!-- end section-box advanced -->
      </div>
      <div class="card-footer"><small class="text-muted">ID: ${p.id}</small></div>
    </div>`;

  // Remember collapse state for Config, Materials, and each VM Details
  const cfgEl = col.querySelector(`#${cfgId}`);
  if (cfgEl) {
    const cchev = col.querySelector(`#cfg-chevron-${p.id}`);
  cfgEl.addEventListener('shown.bs.collapse', () => { setProjState(p.id, { cfgExpanded: true }); if (cchev) { cchev.textContent = '▼'; cchev.classList.add('rotate'); } updateCredDownloadState(p.id); });
  cfgEl.addEventListener('hidden.bs.collapse', () => { setProjState(p.id, { cfgExpanded: false }); if (cchev) { cchev.textContent = '▶'; cchev.classList.remove('rotate'); } });
  }
  // When Proxmox connection inputs change in Configuration, broadcast an event
  try {
    const urlInput = col.querySelector(`#cfg-${p.id}-proxmox_url`);
    const apiInput = col.querySelector(`#cfg-${p.id}-proxmox_api_port`);
    const sshInput = col.querySelector(`#cfg-${p.id}-proxmox_ssh_port`);
    const tagInput = col.querySelector(`#cfg-${p.id}-tag`);
    const emit = () => {
      const ev = new CustomEvent('proxmox-conn-changed', { detail: { pid: p.id } });
      window.dispatchEvent(ev);
    };
    [urlInput, apiInput, sshInput].forEach(el => { if (el) el.addEventListener('input', emit); });
    // Tag validation styling
    if (tagInput) {
      const applyTagValidity = () => { tagInput.classList.toggle('is-invalid', !isValidTag(tagInput.value)); };
      tagInput.addEventListener('input', applyTagValidity);
      applyTagValidity();
    }
  } catch {}
  // Credentials section collapse state
  const credsEl = col.querySelector(`#${credsId}`);
  if (credsEl) {
    const crchev = col.querySelector(`#creds-chevron-${p.id}`);
    credsEl.addEventListener('shown.bs.collapse', () => { setProjState(p.id, { credExpanded: true }); if (crchev) { crchev.textContent = '▼'; crchev.classList.add('rotate'); } updateCredDownloadState(p.id); updateCredControls(p.id); });
    credsEl.addEventListener('hidden.bs.collapse', () => { setProjState(p.id, { credExpanded: false }); if (crchev) { crchev.textContent = '▶'; crchev.classList.remove('rotate'); } });
  }
  const credsHeader = col.querySelector(`#creds-header-${p.id}`);
  if (credsHeader && credsEl) {
    credsHeader.addEventListener('click', () => {
      const bs = window.bootstrap && window.bootstrap.Collapse ? window.bootstrap.Collapse : null;
      if (bs) {
        const instance = bs.getOrCreateInstance(credsEl, { toggle: false });
        instance.toggle();
      } else {
        credsEl.classList.toggle('show');
        const show = credsEl.classList.contains('show');
        const crchev = col.querySelector(`#creds-chevron-${p.id}`);
        setProjState(p.id, { credExpanded: show });
        if (crchev) { crchev.textContent = show ? '▼' : '▶'; crchev.classList.toggle('rotate', show); }
      }
    });
  }
  // Proxmox credentials are managed in VM Manager; no prefill on Configuration
  const cfgHeader = col.querySelector(`#cfg-header-${p.id}`);
  if (cfgHeader && cfgEl) {
    cfgHeader.addEventListener('click', () => {
      const bs = window.bootstrap && window.bootstrap.Collapse ? window.bootstrap.Collapse : null;
      if (bs) {
        const instance = bs.getOrCreateInstance(cfgEl, { toggle: false });
        instance.toggle();
      } else {
        cfgEl.classList.toggle('show');
        const show = cfgEl.classList.contains('show');
        const cchev = col.querySelector(`#cfg-chevron-${p.id}`);
        setProjState(p.id, { cfgExpanded: show });
        if (cchev) { cchev.textContent = show ? '▼' : '▶'; cchev.classList.toggle('rotate', show); }
      }
    });
  }
  const matEl = col.querySelector(`#${matId}`);
  if (matEl) {
    const mchev = col.querySelector(`#mat-chevron-${p.id}`);
    matEl.addEventListener('shown.bs.collapse', () => { setProjState(p.id, { matExpanded: true }); if (mchev) { mchev.textContent = '▼'; mchev.classList.add('rotate'); } });
    matEl.addEventListener('hidden.bs.collapse', () => { setProjState(p.id, { matExpanded: false }); if (mchev) { mchev.textContent = '▶'; mchev.classList.remove('rotate'); } });
  }
  // Instances preview removed from Configuration
  const matHeader = col.querySelector(`#mat-header-${p.id}`);
  if (matHeader && matEl) {
    matHeader.addEventListener('click', () => {
      const bs = window.bootstrap && window.bootstrap.Collapse ? window.bootstrap.Collapse : null;
      if (bs) {
        const instance = bs.getOrCreateInstance(matEl, { toggle: false });
        instance.toggle();
      } else {
        matEl.classList.toggle('show');
        const show = matEl.classList.contains('show');
        const mchev = col.querySelector(`#mat-chevron-${p.id}`);
        setProjState(p.id, { matExpanded: show });
        if (mchev) { mchev.textContent = show ? '▼' : '▶'; mchev.classList.toggle('rotate', show); }
      }
    });
  }
  // VM section collapse state
  const vmsEl = col.querySelector(`#vms-${p.id}`);
  if (vmsEl) {
    const vchev = col.querySelector(`#vms-chevron-${p.id}`);
    vmsEl.addEventListener('shown.bs.collapse', () => { setProjState(p.id, { vmExpanded: true }); if (vchev) { vchev.textContent = '▼'; vchev.classList.add('rotate'); } });
    vmsEl.addEventListener('hidden.bs.collapse', () => { setProjState(p.id, { vmExpanded: false }); if (vchev) { vchev.textContent = '▶'; vchev.classList.remove('rotate'); } });
  }
  const vmsHeader = col.querySelector(`#vms-header-${p.id}`);
  if (vmsHeader && vmsEl) {
    vmsHeader.addEventListener('click', () => {
      const bs = window.bootstrap && window.bootstrap.Collapse ? window.bootstrap.Collapse : null;
      if (bs) {
        const instance = bs.getOrCreateInstance(vmsEl, { toggle: false });
        instance.toggle();
      } else {
        vmsEl.classList.toggle('show');
        const show = vmsEl.classList.contains('show');
        const vchev = col.querySelector(`#vms-chevron-${p.id}`);
        setProjState(p.id, { vmExpanded: show });
        if (vchev) { vchev.textContent = show ? '▼' : '▶'; vchev.classList.toggle('rotate', show); }
      }
    });
  }

  // Advanced section collapse state
  const advEl = col.querySelector(`#${advId}`);
  if (advEl) {
    const achev = col.querySelector(`#adv-chevron-${p.id}`);
    advEl.addEventListener('shown.bs.collapse', () => { setProjState(p.id, { advExpanded: true }); if (achev) { achev.textContent = '▼'; achev.classList.add('rotate'); } });
    advEl.addEventListener('hidden.bs.collapse', () => { setProjState(p.id, { advExpanded: false }); if (achev) { achev.textContent = '▶'; achev.classList.remove('rotate'); } });
  }
  const advHeader = col.querySelector(`#adv-header-${p.id}`);
  if (advHeader && advEl) {
    advHeader.addEventListener('click', () => {
      const bs = window.bootstrap && window.bootstrap.Collapse ? window.bootstrap.Collapse : null;
      if (bs) {
        const instance = bs.getOrCreateInstance(advEl, { toggle: false });
        instance.toggle();
      } else {
        advEl.classList.toggle('show');
        const show = advEl.classList.contains('show');
        const achev = col.querySelector(`#adv-chevron-${p.id}`);
        setProjState(p.id, { advExpanded: show });
        if (achev) { achev.textContent = show ? '▼' : '▶'; achev.classList.toggle('rotate', show); }
      }
    });
  }
  
  // Project-level collapse removed; always expanded
  (p.vms || []).forEach((v, i) => {
    const vmId = `vm-collapse-${p.id}-${i}`;
    const vmEl = col.querySelector(`#${vmId}`);
    const chev = col.querySelector(`#vm-chevron-${p.id}-${i}`);
    const vmHeader = col.querySelector(`#vm-header-${p.id}-${i}`);
    if (!vmEl) return;
    const state = getProjState(p.id);
    state.vmDetails = state.vmDetails || {};
    const settings = readSettings();
    const expanded = (state.vmDetails[v.name] !== undefined) ? !!state.vmDetails[v.name] : !!settings.defaultVmExpanded;
    if (expanded) {
      vmEl.classList.add('show');
      if (chev) { chev.textContent = '▼'; chev.classList.add('rotate'); }
    }
    vmEl.addEventListener('shown.bs.collapse', () => {
      const s = getProjState(p.id);
      s.vmDetails = s.vmDetails || {};
      s.vmDetails[v.name] = true;
      setProjState(p.id, { vmDetails: s.vmDetails });
      if (chev) { chev.textContent = '▼'; chev.classList.add('rotate'); }
    });
    vmEl.addEventListener('hidden.bs.collapse', () => {
      const s = getProjState(p.id);
      s.vmDetails = s.vmDetails || {};
      delete s.vmDetails[v.name];
      setProjState(p.id, { vmDetails: s.vmDetails });
      if (chev) { chev.textContent = '▶'; chev.classList.remove('rotate'); }
    });

    // Make the VM header area toggle collapse, ignoring clicks on controls and buttons
    if (vmHeader) {
      vmHeader.addEventListener('click', (ev) => {
        const target = ev.target;
        // Avoid toggling when clicking on any buttons, inputs, labels, or the switch area
        if (target.closest('button')) return;
        if (target.tagName === 'INPUT' || target.closest('input')) return;
        if (target.tagName === 'LABEL' || target.closest('label')) return;
        const bs = window.bootstrap && window.bootstrap.Collapse ? window.bootstrap.Collapse : null;
        if (bs) {
          const instance = bs.getOrCreateInstance(vmEl, { toggle: false });
          instance.toggle();
        } else {
          vmEl.classList.toggle('show');
          const show = vmEl.classList.contains('show');
          const s = getProjState(p.id);
          s.vmDetails = s.vmDetails || {};
          if (show) s.vmDetails[v.name] = true; else delete s.vmDetails[v.name];
          setProjState(p.id, { vmDetails: s.vmDetails });
          if (chev) { chev.textContent = show ? '▼' : '▶'; chev.classList.toggle('rotate', show); }
        }
      });
    }
    // Live validation on inline rename input
    try {
      const nameInput = col.querySelector(`#vm-name-input-${p.id}-${i}`);
      if (nameInput) {
        const applyVmValidity = () => { nameInput.classList.toggle('is-invalid', !!nameInput.value && !isValidVmName(nameInput.value)); };
        nameInput.addEventListener('input', applyVmValidity);
        applyVmValidity();
      }
    } catch {}
  });
  // Initialize credential download button and controls state on first render
  setTimeout(() => { updateCredDownloadState(p.id); updateCredControls(p.id); }, 0);
  return col;
}


// --- Add from Server flow (Proxmox templates) ---
function proxCredKey(pid){ return `toolhub.session.proxmox.${pid}`; }
function readProxCreds(pid){ try { return JSON.parse(sessionStorage.getItem(proxCredKey(pid))||'{}'); } catch { return {}; } }
function writeProxCreds(pid,obj){ try { sessionStorage.setItem(proxCredKey(pid), JSON.stringify({ username: obj.username||'', password: obj.password||'' })); } catch {} }
function proxMetaKey(pid){ return `toolhub.session.proxmox.meta.${pid}`; }
function writeProxMeta(pid,obj){ try { sessionStorage.setItem(proxMetaKey(pid), JSON.stringify(obj||{})); } catch {} }
function normalizeUrl(s){ if (!s) return ''; return /^https?:\/\//i.test(s) ? s : `https://${s}`; }

let AFS_CTX = { pid: null, templates: [], selected: new Set() };

function openAddFromServer(pid){
  AFS_CTX = { pid, templates: [], selected: new Set() };
  // prefill from project cache and session creds
  const p = (window.PROJ_CACHE||{})[pid] || {};
  const modal = document.getElementById('addFromServerModal');
  if (!modal) { alert('Modal not found'); return; }
  const urlEl = document.getElementById('afs-url');
  const portEl = document.getElementById('afs-port');
  const verEl = document.getElementById('afs-verify');
  const uEl = document.getElementById('afs-username');
  const pwEl = document.getElementById('afs-password');
  const list = document.getElementById('afs-list');
  const addBtn = document.getElementById('afs-add');
  const filterEl = document.getElementById('afs-filter');
  const filterGroup = document.getElementById('afs-filter-group');
  if (urlEl) urlEl.value = p.proxmox_url || '';
  if (portEl) portEl.value = (p.proxmox_api_port ?? 8006);
  if (verEl) verEl.checked = (p.proxmox_verify_ssl !== false);
  const sess = readProxCreds(pid) || {};
  if (uEl) uEl.value = sess.username || '';
  if (pwEl) pwEl.value = sess.password || '';
  if (list) { list.innerHTML = ''; list.style.display = 'none'; }
  if (addBtn) addBtn.disabled = true;
  if (filterEl) filterEl.value = '';
  if (filterGroup) filterGroup.style.display = 'none';
  // wire events (idempotent)
  try {
    document.getElementById('afs-fetch').onclick = fetchTemplatesForAFS;
    document.getElementById('afs-add').onclick = addSelectedTemplates;
    document.getElementById('afs-filter').oninput = renderAFSList;
  } catch {}
  // show modal
  try {
    const bs = window.bootstrap && window.bootstrap.Modal ? window.bootstrap.Modal : null;
    if (bs) bs.getOrCreateInstance(modal).show(); else modal.classList.add('show');
  } catch {}
}

async function fetchTemplatesForAFS(){
  const pid = AFS_CTX.pid; if (!pid) return;
  const p = (window.PROJ_CACHE||{})[pid] || {};
  const urlEl = document.getElementById('afs-url');
  const portEl = document.getElementById('afs-port');
  const verEl = document.getElementById('afs-verify');
  const uEl = document.getElementById('afs-username');
  const pwEl = document.getElementById('afs-password');
  const list = document.getElementById('afs-list');
  const filterGroup = document.getElementById('afs-filter-group');
  const urlBase = normalizeUrl((urlEl?.value||'').trim());
  const apiPort = Number(portEl?.value||8006)||8006;
  if (!urlBase){ try { showToast('Enter Proxmox URL', 'warning'); } catch { alert('Enter Proxmox URL'); } return; }
  const baseUrl = urlBase.replace(/\/$/, '') + (apiPort ? '' : '') ; // API endpoints include /api2/json internally
  const body = { baseUrl, apiPort, verifySSL: !!(verEl?.checked), username: (uEl?.value||'').trim() || undefined, password: (pwEl?.value||'') || undefined };
  try {
    await runQueued(`Fetch templates for ${pid}`, async () => {
      const resp = await http('POST', '/api/proxmox/templates', body);
      const items = Array.isArray(resp?.templates) ? resp.templates : [];
      AFS_CTX.templates = items.map(t => ({ node: String(t.node||''), vmid: Number(t.vmid||0), name: String(t.name||''), bridges: Array.isArray(t.bridges)? t.bridges.map(b=>String(b||'')) : [] }));
      // persist creds and meta for VM Manager prefill
      writeProxCreds(pid, { username: body.username||'', password: body.password||'' });
      writeProxMeta(pid, { url: urlBase, apiPort: apiPort, sshPort: Number(p.proxmox_ssh_port||22)||22 });
      if (filterGroup) filterGroup.style.display = '';
      if (list) list.style.display = '';
      renderAFSList();
    }, { projectId: pid });
  } catch (e){
  if (list) { list.innerHTML = `<div class="text-danger small p-2">Fetch failed: ${e.message}</div>`; list.style.display = ''; }
  }
}

function renderAFSList(){
  const list = document.getElementById('afs-list');
  const addBtn = document.getElementById('afs-add');
  const filter = (document.getElementById('afs-filter')?.value||'').trim().toLowerCase();
  const items = (AFS_CTX.templates||[]).filter(t => {
    if (!filter) return true;
    const s = `${t.name} ${t.vmid} ${t.node}`.toLowerCase();
    return s.includes(filter);
  });
  if (!items.length){ if (list) list.innerHTML = '<div class="text-muted small p-2">No templates found.</div>'; if (addBtn) addBtn.disabled = true; return; }
  const rows = items.map(t => {
    const key = `${t.node}|${t.vmid}|${t.name}`;
    const checked = AFS_CTX.selected.has(key) ? 'checked' : '';
    const bridges = (t.bridges||[]).join(', ');
    return `<label class="list-group-item d-flex align-items-center gap-2">
      <input type="checkbox" class="form-check-input me-2" data-key="${key}" ${checked} />
      <span class="badge bg-secondary">${t.node}</span>
      <strong>${escHtml(t.name)}</strong>
      <span class="text-muted">#${t.vmid}</span>
      ${bridges ? `<span class="ms-auto small text-muted">bridges: ${escHtml(bridges)}</span>` : ''}
    </label>`;
  }).join('');
  if (list) list.innerHTML = `<div class="list-group list-group-flush">${rows}</div>`;
  // wire checkbox changes
  try {
    (list.querySelectorAll('input[type=checkbox]')||[]).forEach(cb => {
      cb.onchange = (e) => {
        const k = e.target.getAttribute('data-key');
        if (e.target.checked) AFS_CTX.selected.add(k); else AFS_CTX.selected.delete(k);
        if (addBtn) addBtn.disabled = AFS_CTX.selected.size === 0;
      };
    });
  } catch {}
  if (addBtn) addBtn.disabled = AFS_CTX.selected.size === 0;
}

async function addSelectedTemplates(){
  const pid = AFS_CTX.pid; if (!pid) return;
  const selected = Array.from(AFS_CTX.selected||[]);
  if (!selected.length) return;
  // For each selection, add a VM using the template name and set vmid
  // We will batch sequentially to keep API simple
  const sanitizeAdaptor = (s) => {
    // Letters only, up to 8 chars per UI rules
    try { return (String(s||'').replace(/[^A-Za-z]/g, '').slice(0,8)); } catch { return ''; }
  };
  // collect a mapping from name->sanitized adaptors derived from bridges
  const adaptorByName = {};
  for (const k of selected){
    const parts = String(k).split('|');
    const node = parts[0];
    const vmid = Number(parts[1]||0) || 0;
    const name = parts.slice(2).join('|');
    if (!name || !vmid) continue;
    try {
      const t = (AFS_CTX.templates||[]).find(x => x.node===node && x.vmid===vmid && x.name===name);
      if (t && Array.isArray(t.bridges)) {
        const sans = t.bridges.map(b => sanitizeAdaptor(b)).filter(x => !!x);
        if (sans.length) adaptorByName[name] = Array.from(new Set(sans));
      }
    } catch {}
    try {
      await http('POST', `/api/projects/${pid}/vms`, { name });
    } catch (e) {
      // if already exists, continue to update
    }
    try {
      const patch = { vmid };
      if (adaptorByName[name] && adaptorByName[name].length) {
        patch.internal_network_adaptors = adaptorByName[name];
      }
      await http('PATCH', `/api/projects/${pid}/vms/${encodeURIComponent(name)}`, patch);
    } catch (e) {
      try { showToast(`Failed to set VMID for ${name}: ${e.message}`, 'danger'); } catch {}
    }
  }
  try {
    const modal = document.getElementById('addFromServerModal');
    const bs = window.bootstrap && window.bootstrap.Modal ? window.bootstrap.Modal : null;
    if (bs) { const inst = bs.getOrCreateInstance(modal); inst.hide(); }
  } catch {}
  // reload
  try { await loadProjects(); } catch { loadProjects(); }
  try { if (window.shell && shell.refreshSidebar) shell.refreshSidebar('config'); } catch {}
  try { showToast('Templates added.', 'success'); } catch {}
}

// Rename project from the header input (on blur)
async function renameProject(id, newName) {
  const name = String(newName || '').trim();
  if (!name) { try { showToast('Project name cannot be empty.', 'danger'); } catch {} return; }
  try {
    try { (window.shell && shell.logInfo) ? shell.logInfo(`Config: renaming project ${id} → ${name}`) : console.log('Renaming project', id, '->', name); } catch {}
    await http('PATCH', `/api/projects/${id}`, { name });
    loadProjects();
    try { if (window.shell && shell.refreshSidebar) shell.refreshSidebar('config'); } catch {}
    try { (window.shell && shell.logSuccess) ? shell.logSuccess('Config: project name saved') : console.log('Project name saved'); } catch {}
  } catch (e) {
    try { showToast('Error renaming project: ' + (e?.message || e), 'danger'); } catch {}
  }
}

// Delete a project from the header button
async function deleteProject(id) {
  try {
    const ok = window.confirm('Delete this project? This cannot be undone.');
    if (!ok) return;
    try { (window.shell && shell.logInfo) ? shell.logInfo(`Config: deleting project ${id}…`) : console.log('Deleting project', id); } catch {}
    await http('DELETE', `/api/projects/${encodeURIComponent(id)}`);
    try { showToast('Project deleted.', 'success'); } catch {}
    // Clear current selection if it was this project
    try { if (window.shell && shell.getCurrentProjectId && shell.setCurrentProjectId) {
      if (String(shell.getCurrentProjectId()||'') === String(id)) shell.setCurrentProjectId('');
    }} catch {}
    // Refresh views
    try { await loadProjects(); } catch { loadProjects(); }
    try { if (window.shell && shell.refreshSidebar) shell.refreshSidebar('config'); } catch {}
  } catch (e) {
    try { showToast('Failed to delete project: ' + (e?.message || e), 'danger'); } catch {}
  }
}

function renderInstancesPreview(p) {
  const inst = Number(p.instances || 0);
  const tag = String(p.tag || '').trim();
  const vms = p.vms || [];
  if (!inst || !vms.length) {
    return '<div class="text-muted">Add VMs and set Instances to preview instance names.</div>';
  }
  const managers = ['vm','guacamole','pools','keycloak','rocketchat','ctfd'];
  const statuses = (p.instance_statuses || []);
  const statusMap = new Map(statuses.map(s => [Number(s.index||0), s]));
  let html = '<div class="table-responsive"><table class="table table-sm align-middle"><thead><tr><th>#</th><th>Preview VM Names</th><th>Preview Adaptors</th><th>Managers</th></tr></thead><tbody>';
  for (let i = 1; i <= inst; i++) {
    const suffix = `${tag}${i}`;
    const names = vms.map(v => `${v.name}${suffix}`);
    const adaptors = (vms.flatMap(v => (v.internal_network_adaptors||[]).map(a => `${a}${suffix}`)));
    const st = statusMap.get(i) || {};
    const mgr = st.managers || {};
    const mgrBadges = managers.map(m => badgeForStatus(m, mgr[m])).join(' ');
    html += `<tr><td>${i}</td><td>${names.map(escHtml).join('<br>')}</td><td>${adaptors.map(escHtml).join('<br>')||'<span class="text-muted">—</span>'}</td><td>${mgrBadges}</td></tr>`;
  }
  html += '</tbody></table></div>';
  html += '<div class="text-muted small">Names are concatenated with the Tag and an incremental number to ensure uniqueness per instance.</div>';
  return html;
}

function badgeForStatus(name, value) {
  const label = {
    vm: 'VM', guacamole: 'Guac', pools: 'Pools', keycloak: 'Keycloak', rocketchat: 'RocketChat', ctfd: 'CTFd'
  }[name] || name;
  const v = String(value || '').toLowerCase();
  const cls = v === 'ready' || v === 'ok' || v === 'created' ? 'bg-success' : (v === 'error' ? 'bg-danger' : (v === 'pending' ? 'bg-warning text-dark' : 'bg-secondary'));
  const text = v ? v : 'n/a';
  return `<span class="badge ${cls}">${label}: ${escHtml(text)}</span>`;
}

// Helpers for dynamic list add/remove within VM sections
function listItemTemplate(listId, value, idx) {
  const safe = escHtml(value ?? '');
  return `<li class="list-group-item d-flex align-items-center justify-content-between" data-index="${idx}">
    <input class="form-control form-control-sm me-2" value="${safe}" oninput="onListItemEdit('${listId}', this)"/>
    <button class="btn btn-sm btn-outline-danger" onclick="removeListItem('${listId}', this)">Remove</button>
  </li>`;
}

function onListItemEdit(listId, inputEl) {
  // Live validation for adaptor names list
  try {
    if (String(listId).includes('-nets-list')) {
      const v = (inputEl.value || '').trim();
      const valid = /^[A-Za-z]{0,8}$/.test(v); // allow empty while typing
      inputEl.classList.toggle('is-invalid', !valid);
      if (!valid) showToast('Invalid adaptor name: letters only, up to 8 characters.', 'danger');
    }
  } catch {}
  // Auto-save after edits (debounced)
  try {
  const m = String(listId).match(/^vm-(.+)-(\d+)-/);
    if (m) debounceVmSave(m[1], Number(m[2]), 600);
  } catch {}
}

// Handle Remove button clicks for dynamic lists
function removeListItem(listId, btnEl) {
  try {
    const li = btnEl && (btnEl.closest ? btnEl.closest('li') : null);
    if (li) li.remove();
  } catch {}
  try {
  const m = String(listId).match(/^vm-(.+)-(\d+)-/);
    if (m) debounceVmSave(m[1], Number(m[2]), 200);
  } catch {}
}

function onVmNameInput(pid) {
  try {
    const input = document.getElementById(`vm-${pid}`);
    const btn = document.getElementById(`btn-add-vm-${pid}`);
    const val = (input?.value || '').trim();
    const ok = !!val && isValidVmName(val);
    if (input) input.classList.toggle('is-invalid', !ok && val.length>0);
    if (btn) btn.disabled = !ok;
  } catch {}
}

function onAdaptorInput(pid, idx, el) {
  try {
    const input = el || document.getElementById(`vm-${pid}-${idx}-nets-input`);
    const btn = document.getElementById(`btn-add-net-${pid}-${idx}`);
    const v = (input?.value || '').trim();
    const ok = /^[A-Za-z]{1,8}$/.test(v);
    if (input) input.classList.toggle('is-invalid', !ok && v.length>0);
    if (btn) btn.disabled = !ok;
  } catch {}
}

// Allow pressing Enter in adaptor input to add when valid
function onAdaptorKeydown(pid, idx, ev) {
  try {
    if (ev && ev.key === 'Enter') {
      ev.preventDefault();
      const btn = document.getElementById(`btn-add-net-${pid}-${idx}`);
      if (btn && !btn.disabled) {
        addListItem(`vm-${pid}-${idx}-nets-list`, `vm-${pid}-${idx}-nets-input`);
      }
    }
  } catch {}
}

// Strengthen Add list item to enforce adaptor validation
function addListItem(listId, inputId) {
  const list = document.getElementById(listId);
  const input = document.getElementById(inputId);
  if (!list || !input) return;
  const val = (input.value || '').trim();
  if (!val) return;
  // If this is a nets list, enforce letters-only up to 8
  if (String(listId).includes('-nets-list')) {
    if (!/^[A-Za-z]{1,8}$/.test(val)) {
      input.classList.add('is-invalid');
      try { showToast('Invalid adaptor name: letters only, up to 8 characters.', 'danger'); } catch { alert('Invalid adaptor name: letters only, up to 8 characters.'); }
      return;
    }
    // Prevent duplicates (case-insensitive) within the same VM list
    const existing = Array.from(list.querySelectorAll('input')).map(i => (i.value||'').trim().toLowerCase());
    if (existing.includes(val.toLowerCase())) {
      try { showToast('Adaptor already added for this VM.', 'warning'); } catch {}
      input.value = '';
  const [_, pid, idx] = String(listId).match(/^vm-(.+)-(\d+)-nets-list$/) || [];
      if (pid && idx) {
        const btn = document.getElementById(`btn-add-net-${pid}-${idx}`);
        if (btn) btn.disabled = true;
      }
      return;
    }
  }
  const li = document.createElement('li');
  li.className = 'list-group-item d-flex align-items-center justify-content-between';
  li.innerHTML = `<input class="form-control form-control-sm me-2" value="${escHtml(val)}" oninput="onListItemEdit('${listId}', this)"/><button class="btn btn-sm btn-outline-danger" onclick="removeListItem('${listId}', this)">Remove</button>`;
  list.appendChild(li);
  input.value = '';
  input.classList.remove('is-invalid');
  // Debounce save for VM lists
  try {
  const m = String(listId).match(/^vm-(.+)-(\d+)-/);
    if (m) debounceVmSave(m[1], Number(m[2]), 300);
  } catch {}
  // Disable Add button until next valid input
  try {
    if (String(listId).includes('-nets-list')) {
  const [_, pid, idx] = String(listId).match(/^vm-(.+)-(\d+)-nets-list$/) || [];
      if (pid && idx) {
        const btn = document.getElementById(`btn-add-net-${pid}-${idx}`);
        if (btn) btn.disabled = true;
      }
    }
  } catch {}
}

async function addVM(id) {
  const el = document.getElementById(`vm-${id}`);
  const name = (el.value || '').trim();
  if (!name) return;
  if (!isValidVmName(name)) {
    try { showToast('Invalid VM Name. Use letters, numbers, and internal dashes only (no leading/trailing dash).', 'danger'); } catch { alert('Invalid VM Name. Use letters, numbers, and internal dashes only (no leading/trailing dash).'); }
    if (el) el.classList.add('is-invalid');
    const btn = document.getElementById(`btn-add-vm-${id}`);
    if (btn) btn.disabled = true;
    return;
  }
  try {
  try { shell.beginActionContext('Add VM'); } catch {}
    try { (window.shell && shell.logInfo) ? shell.logInfo(`Config: adding VM ${name}`) : console.log('Adding VM', name); } catch {}
  try { shell.step('Sending POST request'); } catch {}
    await http('POST', `/api/projects/${id}/vms`, { name });
  try { shell.step('Server acknowledged VM add'); } catch {}
    el.value='';
    el.classList.remove('is-invalid');
    const btn = document.getElementById(`btn-add-vm-${id}`);
    if (btn) btn.disabled = true;
  try { shell.step('Cleared form input'); } catch {}
    loadProjects();
  try { shell.step('Reloaded projects'); } catch {}
    try { if (window.shell && shell.refreshSidebar) shell.refreshSidebar('config'); } catch {}
  try { shell.step('Sidebar refresh requested'); } catch {}
    try { (window.shell && shell.logSuccess) ? shell.logSuccess('Config: VM added') : console.log('VM added'); } catch {}
  try { shell.endActionContext(true); } catch {}
  }
  catch (e) { try { showToast('Error adding VM: ' + e.message, 'danger'); } catch { alert('Error adding VM: ' + e.message); } try { (window.shell && shell.logError) ? shell.logError('Config: add VM failed: ' + e.message) : console.error('Add VM failed:', e); } catch {} }
  try { shell.endActionContext(false); } catch {}
}

async function removeVM(id, name) {
  try {
    try { (window.shell && shell.logWarn) ? shell.logWarn(`Config: removing VM ${name}`) : console.warn('Removing VM', name); } catch {}
    await http('DELETE', `/api/projects/${id}/vms/${encodeURIComponent(name)}`);
    loadProjects();
    try { if (window.shell && shell.refreshSidebar) shell.refreshSidebar('config'); } catch {}
    try { (window.shell && shell.logSuccess) ? shell.logSuccess('Config: VM removed') : console.log('VM removed'); } catch {}
  }
  catch (e) { alert('Error removing VM: ' + e.message); try { (window.shell && shell.logError) ? shell.logError('Config: remove VM failed: ' + e.message) : console.error('Remove VM failed:', e); } catch {} }
}

async function saveVM(id, name, fields, opts={}) {
  const silent = !!opts.silent;
  try {
    if(!silent) { try { (window.shell && shell.logInfo) ? shell.logInfo(`Config: saving VM ${name}`) : console.log('Saving VM', name); } catch {} }
    await http('PATCH', `/api/projects/${id}/vms/${encodeURIComponent(name)}`, fields);
    if(!silent){
      loadProjects();
      try { if (window.shell && shell.refreshSidebar) shell.refreshSidebar('config'); } catch {}
      try { (window.shell && shell.logSuccess) ? shell.logSuccess('Config: VM saved') : console.log('VM saved'); } catch {}
    }
  }
  catch (e) {
    if(!silent) alert('Error saving VM: ' + e.message);
    try { (window.shell && shell.logError) ? shell.logError('Config: save VM failed: ' + e.message) : console.error('Save VM failed:', e); } catch {}
  }
}

function startVmRename(pid, idx) {
  const disp = document.getElementById(`vm-name-display-${pid}-${idx}`);
  const input = document.getElementById(`vm-name-input-${pid}-${idx}`);
  if (!disp || !input) return;
  disp.classList.add('d-none');
  input.classList.remove('d-none');
  input.focus();
  input.select();
}

async function vmNameKey(pid, idx, ev) {
  const input = document.getElementById(`vm-name-input-${pid}-${idx}`);
  const disp = document.getElementById(`vm-name-display-${pid}-${idx}`);
  if (!input || !disp) return;
  const oldName = disp.textContent;
  if (ev.key === 'Escape') {
    input.classList.add('d-none');
    disp.classList.remove('d-none');
    input.value = oldName;
    return;
  }
  if (ev.key === 'Enter') {
    const newName = (input.value || '').trim();
    if (!newName || newName === oldName) {
      input.classList.add('d-none');
      disp.classList.remove('d-none');
      input.value = oldName;
      return;
    }
    if (!isValidVmName(newName)) {
      alert('Invalid VM Name. Use letters, numbers, and internal dashes only (no leading/trailing dash).');
      input.classList.add('d-none');
      disp.classList.remove('d-none');
      input.value = oldName;
      return;
    }
    try {
      await http('POST', `/api/projects/${pid}/vms/${encodeURIComponent(oldName)}/rename`, { new_name: newName });
      loadProjects();
  try { (window.shell && shell.logSuccess) ? shell.logSuccess(`Config: VM renamed ${oldName} → ${newName}`) : console.log('VM renamed', oldName, '->', newName); } catch {}
    } catch (e) {
      alert('Error renaming VM: ' + e.message);
  try { (window.shell && shell.logError) ? shell.logError('Config: VM rename failed: ' + e.message) : console.error('VM rename failed:', e); } catch {}
      input.classList.add('d-none');
      disp.classList.remove('d-none');
      input.value = oldName;
    }
  }
}

async function uploadMaterial(id) {
  const input = document.getElementById(`file-${id}`);
  if (!input.files || !input.files[0]) return;
  const fd = new FormData();
  fd.append('file', input.files[0]);
  try {
    try { (window.shell && shell.logInfo) ? shell.logInfo(`Config: uploading material ${input.files[0].name}`) : console.log('Uploading material', input.files[0].name); } catch {}
    await http('POST', `/api/projects/${id}/materials`, fd);
    input.value='';
    loadProjects();
    try { if (window.shell && shell.refreshSidebar) shell.refreshSidebar('config'); } catch {}
    try { (window.shell && shell.logSuccess) ? shell.logSuccess('Config: material uploaded') : console.log('Material uploaded'); } catch {}
  }
  catch (e) { alert('Error uploading: ' + e.message); try { (window.shell && shell.logError) ? shell.logError('Config: upload material failed: ' + e.message) : console.error('Upload material failed:', e); } catch {} }
}

async function deleteMaterial(id, fname) {
  try {
    try { (window.shell && shell.logWarn) ? shell.logWarn(`Config: deleting material ${fname}`) : console.warn('Deleting material', fname); } catch {}
    await http('DELETE', `/api/projects/${id}/materials/${encodeURIComponent(fname)}`);
    loadProjects();
    try { if (window.shell && shell.refreshSidebar) shell.refreshSidebar('config'); } catch {}
    try { (window.shell && shell.logSuccess) ? shell.logSuccess('Config: material deleted') : console.log('Material deleted'); } catch {}
  }
  catch (e) { alert('Error deleting material: ' + e.message); try { (window.shell && shell.logError) ? shell.logError('Config: delete material failed: ' + e.message) : console.error('Delete material failed:', e); } catch {} }
}

document.addEventListener('DOMContentLoaded', () => {
  try { wireSettingsModal(); } catch {}
  if (document.getElementById('projects')) {
    try { loadProjects(); } catch {}
  }
});

// Export options state (per-session)
let EXPORT_CONTEXT = { pid: null };

function openExportOptions(pid) {
  EXPORT_CONTEXT.pid = pid;
  try { (window.shell && shell.logInfo) ? shell.logInfo(`Config: open export options for ${pid}`) : console.log('Open export options', pid); } catch {}
  const modalEl = document.getElementById('exportOptionsModal');
  if (!modalEl || !window.bootstrap) { window.location.href = `/api/projects/${encodeURIComponent(pid)}/export`; return; }
  // Default to include both
  try {
    const c = document.getElementById('exp-creds');
    const v = document.getElementById('exp-vms');
  const warn = document.getElementById('exp-vms-warning');
    if (c) c.checked = true;
    if (v) v.checked = true;
  if (warn && v) warn.style.display = v.checked ? 'block' : 'none';
  if (v && warn) v.onchange = () => { warn.style.display = v.checked ? 'block' : 'none'; };
  } catch {}
  const m = new bootstrap.Modal(modalEl);
  m.show();
  const dl = document.getElementById('exp-download');
  if (dl) {
    dl.onclick = () => {
      const includeCreds = !!document.getElementById('exp-creds')?.checked;
      const includeVms = !!document.getElementById('exp-vms')?.checked;
      if (includeVms) {
        const proceed = confirm('Exporting VMs can be very time-consuming. This will run on the remote machine, download disk files, and compress them. Continue?');
        if (!proceed) { return; }
      }
      if (includeVms) {
        // Require Proxmox login first; show modal and continue on success
        try { m.hide(); } catch {}
        gateExportThroughProxLogin(EXPORT_CONTEXT.pid, { includeCreds, includeVms });
      } else {
        // Simple export (no VM images) via direct download
        const a = document.createElement('a');
        a.href = `/api/projects/${encodeURIComponent(EXPORT_CONTEXT.pid)}/export?includeCreds=${includeCreds}&includeVms=${includeVms}`;
        a.click();
        try { (window.shell && shell.logSuccess) ? shell.logSuccess('Config: export started') : console.log('Export started'); } catch {}
        try { m.hide(); } catch {}
      }
    };
  }
}

async function startExportJob(pid, opts) {
  // Read Proxmox session creds from sessionStorage
  const sess = readProxCreds(pid) || {};
  const body = { includeCreds: !!opts.includeCreds, includeVms: !!opts.includeVms, username: sess.username || '', password: sess.password || '' };
  if (!body.username || !body.password) { alert('Please log into Proxmox (Update Proxmox Creds) before exporting VMs.'); return; }
  // Ensure console dock shows debug-level messages
  try { if (window.shell && shell.enableConsoleDebug) shell.enableConsoleDebug(true); } catch {}
  try { (window.shell && shell.logInfo) ? shell.logInfo('Config: starting export job…') : console.log('Starting export job…'); } catch {}
  try {
    let resp;
    await runQueued(`Start export for ${pid}`, async () => {
      resp = await http('POST', `/api/projects/${encodeURIComponent(pid)}/export/start`, body);
    }, { projectId: pid });
    if (!resp || !resp.job) throw new Error('No job id returned');
    const modalEl = document.getElementById('exportProgressModal');
    if (!modalEl || !window.bootstrap) { alert('Export started. Keep this page open.'); return; }
    const bar = document.getElementById('exp-prog-bar');
    const stat = document.getElementById('exp-status');
    const log = document.getElementById('exp-log');
  const dl = document.getElementById('exp-download-final');
  const openBtn = document.getElementById('exp-open-folder');
  const pathNote = document.getElementById('exp-path-note');
    if (bar) { bar.style.width = '0%'; bar.textContent = '0%'; bar.setAttribute('aria-valuenow','0'); }
    if (stat) stat.textContent = 'Queued…';
    if (log) log.textContent = 'Waiting…';
  if (dl) { dl.classList.add('disabled'); dl.href = '#'; dl.setAttribute('aria-disabled','true'); }
  if (openBtn) { openBtn.disabled = true; }
  if (pathNote) { pathNote.textContent = ''; }
  const m = new bootstrap.Modal(modalEl);
    m.show();
    // Poll
    let lastLogCount = 0;
    let completed = false;
    let finalZipPath = '';
    // Wire Close button with confirmation when completed
    try {
      const closeBtn = document.getElementById('exp-close-btn');
      if (closeBtn) {
        closeBtn.onclick = () => {
          if (completed) {
            const msg = `The export has completed. If you close this dialog, the in-browser download link will be lost.\n\nYou can re-run the export later, or fetch the ZIP directly on the server at:\n${finalZipPath || '(path will be shown in export logs)'}\n\nClose now?`;
            const sure = confirm(msg);
            if (!sure) return;
          }
          try { m.hide(); } catch {}
        };
      }
    } catch {}
  const poll = async () => {
           try {
        const s = await http('GET', `/api/projects/${encodeURIComponent(pid)}/export/status`);
        const p = Math.max(0, Math.min(100, Number(s.progress||0)));
        if (bar) { bar.style.width = p + '%'; bar.textContent = p + '%'; bar.setAttribute('aria-valuenow', String(p)); }
        if (stat) stat.textContent = String(s.status||'');
        if (Array.isArray(s.log)) {
          // Update modal log area
          if (log) {
            log.textContent = s.log.join('\n');
            // Auto-scroll the scrollable container to the latest line
            try {
              const box = log.parentElement; // the div with overflow:auto
              if (box) {
                // Use rAF to ensure layout is updated before scrolling
                requestAnimationFrame(() => { box.scrollTop = box.scrollHeight; });
              }
            } catch {}
          }
          // Stream only new lines to bottom console as DEBUG
          try {
            const start = Math.max(0, lastLogCount);
            for (let i = start; i < s.log.length; i++) {
              if (window.shell && shell.logDebug) shell.logDebug(`[EXPORT] ${s.log[i]}`);
              else console.debug('[EXPORT]', s.log[i]);
            }
            lastLogCount = s.log.length;
          } catch {}
          // Try to extract the ZIP destination path from logs
          try {
            // Look for a line like: [CMD] package -> /path/to/export_xxx.zip
            for (let i = s.log.length - 1; i >= 0; i--) {
              const line = String(s.log[i] || '');
              const m = line.match(/\[CMD\]\s+package\s+->\s+(.+\.zip)\s*$/);
              if (m) { finalZipPath = m[1]; break; }
            }
          } catch {}
        } else if (log) { log.textContent = ''; }
        if (s.status === 'completed') {
          completed = true;
          const hasDl = !!s.downloadReady;
          const href = hasDl ? `/api/projects/${encodeURIComponent(pid)}/export/download` : '#';
          if (stat) stat.textContent = 'completed';
          if (dl){
            dl.href = href;
            dl.classList.toggle('disabled', !hasDl);
            dl.setAttribute('aria-disabled', String(!hasDl));
            dl.textContent = 'Download ZIP';
          }
          if (pathNote){ pathNote.textContent = s.downloadPath ? `Saved: ${s.downloadPath}` : ''; }
          if (openBtn){
            openBtn.disabled = !s.downloadPath;
            openBtn.onclick = async () => {
              try {
                // Find export id in list by matching path (best-effort): refresh Exports page later
                // For immediate UX, ask backend to reveal by id isn't available here; fallback to just opening downloads dir.
                // We can navigate to Exports page where Open Folder is available per export.
                window.location.href = `/static/exports.html?id=${encodeURIComponent(pid)}`;
              } catch {}
            };
          }
          try { (window.shell && shell.logSuccess) ? shell.logSuccess('Export completed and ready to download') : console.log('Export completed and ready'); } catch {}
          return; // stop polling
        }
        if (s.status === 'error' || s.status === 'cancelled') { return; }
        setTimeout(poll, 1500);
      } catch (e) {
        setTimeout(poll, 2500);
      }
    };
    setTimeout(poll, 1200);
  } catch (e) {
    alert('Failed to start export: ' + (e && e.message ? e.message : 'Unknown error'));
    try { (window.shell && shell.logError) ? shell.logError('Config: export start failed: ' + (e && e.message ? e.message : e)) : console.error('Export start failed:', e); } catch {}
  }
}

// Open Proxmox login modal and continue export after successful verify
async function gateExportThroughProxLogin(pid, opts){
  try { (window.shell && shell.logInfo) ? shell.logInfo('Config: gating export through Proxmox login') : console.log('Gate export: Proxmox login'); } catch {}
  const data = await http('GET', '/api/projects');
  const proj = (data.projects || []).find(p => p.id === pid);
  if (!proj) { alert('Project not found.'); return; }
  // Prefill modal
  const url = document.getElementById('prox-url');
  const api = document.getElementById('prox-api-port');
  const ssh = document.getElementById('prox-ssh-port');
  const u = document.getElementById('prox-username');
  const p = document.getElementById('prox-password');
  const vssl = document.getElementById('prox-verify-ssl');
  const sess = readProxCreds(pid) || {};
  if (url) url.value = proj.proxmox_url || '';
  if (api) api.value = proj.proxmox_api_port ?? 8006;
  if (ssh) ssh.value = proj.proxmox_ssh_port ?? 22;
  if (u) u.value = sess.username || '';
  if (p) p.value = sess.password || '';
  if (vssl) vssl.checked = (proj.proxmox_verify_ssl !== false);
  // Stash next action
  window.__EXPORT_NEXT__ = { pid, opts };
  const modalEl = document.getElementById('proxLoginModal');
  if (!modalEl || !window.bootstrap) { alert('Proxmox login UI not found.'); return; }
  const m = new bootstrap.Modal(modalEl);
  m.show();
}

async function exportProxLoginSave(){
  const next = window.__EXPORT_NEXT__;
  if (!next) return;
  const { pid, opts } = next;
  // Read fields
  const urlEl = document.getElementById('prox-url');
  const apiEl = document.getElementById('prox-api-port');
  const sshEl = document.getElementById('prox-ssh-port');
  const userEl = document.getElementById('prox-username');
  const passEl = document.getElementById('prox-password');
  const vsslEl = document.getElementById('prox-verify-ssl');
  const feedback = document.getElementById('prox-login-feedback');
  const data = await http('GET', '/api/projects');
  const proj = (data.projects || []).find(p => p.id === pid);
  if (!proj) { alert('Project not found.'); return; }
  const ensure = (s)=>{ if (!s) return ''; return /^https?:\/\//i.test(s) ? s : `https://${s}`; };
  const url = ensure((urlEl?.value||proj.proxmox_url||'').trim());
  const apiPort = Number((apiEl?.value||proj.proxmox_api_port||8006));
  const sshPort = Number((sshEl?.value||proj.proxmox_ssh_port||22));
  const username = (userEl?.value||'').trim();
  const password = passEl?.value || '';
  const verifySSL = !!(vsslEl?.checked);
  if (!url){ if (feedback){ feedback.textContent='Enter Proxmox URL'; feedback.className='me-auto small text-danger'; } return; }
  if (!username || !password){ if (feedback){ feedback.textContent='Enter username and password'; feedback.className='me-auto small text-danger'; } return; }
  // Persist project connection params if changed
  try {
    await http('PATCH', `/api/projects/${encodeURIComponent(pid)}`, {
      proxmox_url: url, proxmox_api_port: apiPort, proxmox_ssh_port: sshPort, proxmox_verify_ssl: verifySSL
    });
  } catch {}
  // Cache session creds
  try { sessionStorage.setItem(`toolhub.session.proxmox.${pid}`, JSON.stringify({ username, password })); } catch {}
  // Verify (queued)
  let verify;
  try {
    await runQueued(`Verify Proxmox login for ${proj?.name || pid}`, async () => {
      verify = await http('POST', `/api/projects/${encodeURIComponent(pid)}/proxmox/verify`, {
        baseUrl: url, apiPort, sshPort, username, password, verifySSL
      });
    }, { projectId: pid });
  } catch(e) {
    verify = { ok:false, proxmox_ok:false, ssh_ok:false, proxmox_error: e?.message || 'verify failed' };
  }
  if (!verify || !verify.ok){
    const apiOk = !!(verify && verify.proxmox_ok);
    const sshOk = !!(verify && verify.ssh_ok);
    const apiErr = (verify && verify.proxmox_error) ? String(verify.proxmox_error) : '';
    const sshErr = (verify && verify.ssh_error) ? String(verify.ssh_error) : '';
    const details = [apiErr, sshErr].filter(Boolean).join(' | ');
    const msg = (!apiOk && !sshOk) ? 'Neither Proxmox API nor SSH could be reached.' : (!apiOk ? 'Proxmox API could not be reached.' : 'SSH could not be reached.');
    if (feedback){ feedback.textContent = `${msg} ${details}`; feedback.className='me-auto small text-danger'; }
    try { sessionStorage.removeItem(`toolhub.session.proxmox.${pid}`); } catch {}
    return;
  }
  // Success: close modal and start export
  try {
    const modalEl = document.getElementById('proxLoginModal');
    const m = window.bootstrap && modalEl ? bootstrap.Modal.getInstance(modalEl) : null;
    if (m) m.hide();
  } catch {}
  try { (window.shell && shell.logSuccess) ? shell.logSuccess('Proxmox login verified (API + SSH)') : console.log('Proxmox login verified'); } catch {}
  await startExportJob(pid, opts);
}

// Toast helper for this page
function showToast(message, type) {
  try {
    const container = document.getElementById('toastContainer');
    if (!container || !window.bootstrap) { alert(message); return; }
    const el = document.createElement('div');
    el.className = `toast align-items-center text-bg-${type||'info'} border-0`;
    el.role = 'alert';
    el.ariaLive = 'assertive';
    el.ariaAtomic = 'true';
    el.innerHTML = `
      <div class="d-flex">
        <div class="toast-body">${escHtml(String(message||''))}</div>
        <button type="button" class="btn-close btn-close-white me-2 m-auto" data-bs-dismiss="toast" aria-label="Close"></button>
      </div>`;
    container.appendChild(el);
    const t = new bootstrap.Toast(el, { delay: 3500 });
    t.show();
    el.addEventListener('hidden.bs.toast', () => el.remove());
  } catch { try { alert(message); } catch {} }
}
// Credentials UI Helpers
function sanitizeSimple(s) { try { return String(s || '').trim(); } catch { return ''; } }

function renderCredentials(pid, creds) {
  const list = Array.isArray(creds) ? creds : [];
  if (list.length === 0) {
    return '<div class="text-muted small">No credentials yet.</div>';
  }
  const items = list.map((c, idx) => {
    const u = sanitizeSimple(c && c.username);
    const p = sanitizeSimple(c && c.password);
    return `<div class="row g-2 align-items-center mb-1" data-index="${idx}">
      <div class="col-md-5"><input class="form-control form-control-sm" placeholder="username" title="Credential username" value="${escHtml(u)}" oninput="onCredentialChanged('${pid}')"></div>
      <div class="col-md-5"><input class="form-control form-control-sm" placeholder="password" title="Credential password (8+ chars)" value="${escHtml(p)}" oninput="onCredentialChanged('${pid}')"></div>
      <div class="col-md-2 d-flex justify-content-end"><button class="btn btn-sm btn-outline-danger" onclick="removeCredentialRow('${pid}', this)">Remove</button></div>
    </div>`;
  }).join('');
  return items;
}
function addCredentialRow(pid) {
  try {
    const host = document.getElementById(`cred-${pid}-list`);
    if (!host) return;
    const wrapper = document.createElement('div');
    wrapper.className = 'row g-2 align-items-center mb-1';
    wrapper.innerHTML = `<div class="col-md-5"><input class="form-control form-control-sm" placeholder="username" title="Credential username"></div>
      <div class="col-md-5"><input class="form-control form-control-sm" placeholder="password" title="Credential password (8+ chars)"></div>
      <div class="col-md-2 d-flex justify-content-end"><button class="btn btn-sm btn-outline-danger">Remove</button></div>`;
    wrapper.querySelector('button')?.addEventListener('click', () => { wrapper.remove(); onCredentialChanged(pid); });
    host.appendChild(wrapper);
    updateCredControls(pid);
    try { wrapper.querySelectorAll('input').forEach(inp => inp.addEventListener('input', () => onCredentialChanged(pid))); } catch {}
    onCredentialChanged(pid);
  } catch {}
}
function removeCredentialRow(pid, btn) {
  try { const row = btn.closest('.row'); if (row) row.remove(); updateCredControls(pid); onCredentialChanged(pid); } catch {}
}
function collectCredentials(pid) {
  const host = document.getElementById(`cred-${pid}-list`);
  if (!host) return [];
  const rows = Array.from(host.querySelectorAll('.row'));
  return rows.map(r => {
    const inputs = r.querySelectorAll('input');
    return { username: (inputs[0]?.value || '').trim(), password: (inputs[1]?.value || '').trim() };
  }).filter(c => c.username);
}
function harmonizeCredentialsToInstances(pid, creds) {
  const inst = Number(document.getElementById(`cfg-${pid}-instances`)?.value || 0);
  const arr = Array.isArray(creds) ? creds.slice(0, Math.max(inst, 0)) : [];
  while (arr.length < inst) arr.push({ username: '', password: '' });
  return arr;
}
function updateCredControls(pid) {
  try {
    const inst = Number(document.getElementById(`cfg-${pid}-instances`)?.value || 0);
    const list = collectCredentials(pid);
    const addBtn = document.getElementById(`cred-add-${pid}`);
    if (addBtn) addBtn.disabled = list.length >= inst && inst > 0;
    updateCredDownloadState(pid);
  } catch {}
}
function updateCredDownloadState(pid) {
  try {
    const btn = document.getElementById(`cred-download-${pid}`);
    if (!btn) return;
    const list = collectCredentials(pid);
    const ok = list.some(c => c.username && c.password && c.password.length >= 8);
    btn.disabled = !ok;
  } catch {}
}

// Harmonize credential rows when Instances or Tag change
function onInstancesChange(pid){
  try {
    const inst = Number(document.getElementById(`cfg-${pid}-instances`)?.value || 0);
    const warn = document.getElementById(`cred-warn-${pid}`);
    const current = collectCredentials(pid);
    const next = harmonizeCredentialsToInstances(pid, current);
    // Re-render only if row count differs or we need to pad/trim
    if (next.length !== current.length) {
      const host = document.getElementById(`cred-${pid}-list`);
      if (host) host.innerHTML = renderCredentials(pid, next);
      if (warn) warn.textContent = '';
      updateCredControls(pid);
      onCredentialChanged(pid);
    } else {
      updateCredControls(pid);
    }
  } catch {}
}

function onTagChange(pid){
  try {
    const el = document.getElementById(`cfg-${pid}-tag`);
    if (!el) return;
    const ok = /^[A-Za-z-]+$/.test((el.value||'').trim());
    el.classList.toggle('is-invalid', !ok);
  } catch {}
}

// CSV upload: replace credentials up to Instances
async function uploadCredentialsFile(pid){
  try {
    const input = document.getElementById(`cfg-${pid}-cred-file`);
    const warn = document.getElementById(`cred-warn-${pid}`);
    if (!input || !input.files || input.files.length === 0) return;
    const file = input.files[0];
    const text = await file.text();
    const lines = String(text||'').split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);
    const creds = [];
    const stripBom = s => s && s.charCodeAt(0) === 0xFEFF ? s.slice(1) : s;
    const isHeader = (a,b) => (String(a||'').toLowerCase()==='username' && String(b||'').toLowerCase()==='password');
    for (let i=0;i<lines.length;i++){
      let line = stripBom(lines[i]);
      // Basic CSV splitting with quotes support for two fields
      let a = '', b = '';
      const parseTwo = (s) => {
        const out = [];
        let cur = '';
        let inQ = false;
        for (let j=0;j<s.length;j++){
          const ch = s[j];
          if (ch === '"') { inQ = !inQ; continue; }
          if (!inQ && ch === ',') { out.push(cur); cur=''; continue; }
          cur += ch;
        }
        out.push(cur);
        return out;
      };
      // Try comma first, then semicolon, then tab; finally fallback to whitespace split (single space or multi-space)
      let parts = parseTwo(line);
      if (parts.length < 2) parts = line.split(';');
      if (parts.length < 2) parts = line.split('\t');
      if (parts.length < 2) parts = line.split(/\s+/);
      a = (parts[0]||'').trim();
      b = (parts[1]||'').trim();
      if (i===0 && isHeader(a,b)) continue; // skip header
      if (!a && !b) continue;
      creds.push({ username: a, password: b });
    }
    const inst = Number(document.getElementById(`cfg-${pid}-instances`)?.value || 0);
    let applied = creds;
    if (inst > 0) applied = creds.slice(0, inst);
    const host = document.getElementById(`cred-${pid}-list`);
    if (host) host.innerHTML = renderCredentials(pid, harmonizeCredentialsToInstances(pid, applied));
    if (warn){
      if (creds.length === 0) warn.textContent = 'No valid rows found. Expected two columns: username,password';
      else if (inst > 0 && creds.length > inst) warn.textContent = `Imported ${applied.length} of ${creds.length} rows (trimmed to Instances=${inst}).`;
      else warn.textContent = `Imported ${applied.length} rows.`;
    }
    // Clear the file input so the same file can be re-selected later
    try { input.value = ''; } catch {}
    updateCredControls(pid);
    onCredentialChanged(pid);
    try { showToast('Credentials imported from CSV','success'); } catch {}
  } catch (e) {
    try { showToast('Failed to import CSV: ' + (e?.message||e),'danger'); } catch {}
  }
}

// Auto-generate credentials: one per Instance with 8-char uppercase passwords
function generateCredentials(pid){
  try {
    const inst = Number(document.getElementById(`cfg-${pid}-instances`)?.value || 0);
    const digits = String(inst).length;
    const pad = (n)=> String(n).padStart(digits, '0');
    const randPwd = ()=>{
      const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
      let s='';
      for (let i=0;i<8;i++) s += chars[Math.floor(Math.random()*chars.length)];
      return s;
    };
    const list = [];
    for (let i=1;i<=inst;i++) list.push({ username: `user${pad(i)}`, password: randPwd() });
    const host = document.getElementById(`cred-${pid}-list`);
    if (host) host.innerHTML = renderCredentials(pid, list);
    const warn = document.getElementById(`cred-warn-${pid}`);
    if (warn) warn.textContent = '';
    updateCredControls(pid);
    onCredentialChanged(pid);
    try { showToast(`Generated ${inst} credentials`,`info`); } catch {}
  } catch {}
}

// Download credentials as CSV
function downloadCredentials(pid){
  try {
    const rows = collectCredentials(pid).filter(c => c && c.username);
    if (rows.length === 0) { showToast('No credentials to download','warning'); return; }
    const header = 'username,password';
    const csv = [header].concat(rows.map(c => {
      const u = String(c.username||'').replaceAll('"','""');
      const p = String(c.password||'').replaceAll('"','""');
      return /[,\n\r]/.test(u) || /[,\n\r]/.test(p) ? `"${u}","${p}"` : `${u},${p}`;
    })).join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `credentials_${pid}.csv`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 0);
  } catch {}
}
// Credential auto-save (usernames/passwords)
const _credSaveTimers = {};
function onCredentialChanged(pid){
  updateCredDownloadState(pid);
  if(_credSaveTimers[pid]) clearTimeout(_credSaveTimers[pid]);
  let status = document.getElementById(`cred-status-${pid}`);
  if(!status){
    try {
      const container = document.getElementById(`cred-${pid}-list`);
      if(container){
        status = document.createElement('div');
        status.id = `cred-status-${pid}`;
        status.className = 'small text-muted mb-1';
        container.parentElement.insertBefore(status, container);
      }
    } catch {}
  }
  if(status){ status.textContent='Saving…'; status.className='small text-muted'; }
  _credSaveTimers[pid] = setTimeout(()=>_saveCredentialsNow(pid), 600);
}
async function _saveCredentialsNow(pid){
  delete _credSaveTimers[pid];
  try {
    const creds = harmonizeCredentialsToInstances(pid, collectCredentials(pid));
    await http('PATCH', `/api/projects/${pid}`, { credentials: creds });
    const status = document.getElementById(`cred-status-${pid}`);
    if(status){ status.textContent='Saved'; status.className='small text-success'; setTimeout(()=>{ if(status && status.textContent==='Saved') status.textContent=''; }, 1500); }
  } catch(e){
    const status = document.getElementById(`cred-status-${pid}`);
    if(status){ status.textContent='Error'; status.className='small text-danger'; }
    try { showToast('Failed to auto-save credentials','danger'); } catch {}
  }
}
