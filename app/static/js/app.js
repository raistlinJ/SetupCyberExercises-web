const UI_STATE_KEY = 'toolhub.uiState.v1';
// IMPORTANT: Do not share storage with `shell.js` runtime settings.
// `shell.js` uses `toolhub.settings.v1` for runMode persistence. This UI layer has its own key.
const UI_SETTINGS_KEY = 'toolhub.uiSettings.v2';
const UI_SETTINGS_KEY_LEGACY = 'toolhub.settings.v1';
// Project cache for UI-only previews
window.PROJ_CACHE = window.PROJ_CACHE || {};
window.MATERIAL_PENDING = window.MATERIAL_PENDING || {};

const START_COMMAND_MODAL_STATE = { pid: null, idx: null, vmName: '', steps: [] };
const STORED_COMMAND_MODAL_STATE = { pid: null, idx: null, vmName: '', steps: [] };
const DEFAULT_COMMAND_TIMEOUT_SECONDS = 300;

function normalizeCommandTimeout(rawValue, defaultValue = DEFAULT_COMMAND_TIMEOUT_SECONDS) {
  if (rawValue === undefined || rawValue === null || rawValue === '') {
    return defaultValue;
  }
  let value = Number(rawValue);
  if (!Number.isFinite(value) || value <= 0) {
    return defaultValue;
  }
  value = Math.round(value);
  if (value > 86400) {
    return 86400;
  }
  return value;
}

function createEmptyCommandEntry() {
  return { command: '', enabled: true, longRunning: false, timeoutSeconds: DEFAULT_COMMAND_TIMEOUT_SECONDS };
}

function applyCommandLongRunningState(cmdElement, isLongRunning) {
  if (!cmdElement || !cmdElement.querySelector) return;
  const longRunning = !!isLongRunning;
  const timeoutInput = cmdElement.querySelector('input[data-role="cmd-timeout"]');
  if (timeoutInput) {
    timeoutInput.disabled = longRunning;
    timeoutInput.setAttribute('aria-disabled', longRunning ? 'true' : 'false');
    timeoutInput.classList.toggle('bg-light', longRunning);
    timeoutInput.classList.toggle('text-muted', longRunning);
  }
  const hint = cmdElement.querySelector('[data-role="timeout-hint"]');
  if (hint) {
    hint.classList.toggle('d-none', !longRunning);
  }
  if (cmdElement.dataset) {
    cmdElement.dataset.longRunning = longRunning ? '1' : '0';
  }
}

function stepHasLongRunningCommands(step) {
  if (!step || !Array.isArray(step.commands)) return false;
  return step.commands.some(cmd => cmd && (cmd.longRunning === true || cmd.long_running === true));
}

function stepDelayIsBlocked(steps, index) {
  if (!Array.isArray(steps) || index <= 0) return false;
  return stepHasLongRunningCommands(steps[index - 1]);
}

function syncStepDelayBlockedStates(kind = 'start') {
  const state = kind === 'stored' ? STORED_COMMAND_MODAL_STATE : START_COMMAND_MODAL_STATE;
  const containerId = kind === 'stored' ? 'stored-commands-steps' : 'start-commands-steps';
  const container = document.getElementById(containerId);
  const steps = Array.isArray(state.steps) ? state.steps : [];
  if (!container || !steps.length) return;
  steps.forEach((_, idx) => {
    const blocked = stepDelayIsBlocked(steps, idx);
    const stepEl = container.querySelector(`[data-step-index="${idx}"]`);
    if (!stepEl) return;
    const delayInput = stepEl.querySelector('input[data-role="step-delay"]');
    const hint = stepEl.querySelector('[data-role="delay-hint"]');
    if (delayInput) {
      delayInput.disabled = blocked;
      if (blocked) {
        delayInput.setAttribute('aria-disabled', 'true');
      } else {
        delayInput.removeAttribute('aria-disabled');
      }
      delayInput.classList.toggle('bg-light', blocked);
      delayInput.classList.toggle('text-muted', blocked);
    }
    if (hint) {
      hint.classList.toggle('d-none', !blocked);
    }
  });
}

if (typeof window !== 'undefined') {
  window.DEFAULT_COMMAND_TIMEOUT_SECONDS = DEFAULT_COMMAND_TIMEOUT_SECONDS;
}

function sanitizeStartCommandSteps(steps) {
  if (!Array.isArray(steps)) return [];

  const toBool = (raw, defaultValue = true) => {
    if (raw === undefined || raw === null) return defaultValue;
    if (typeof raw === 'boolean') return raw;
    if (typeof raw === 'number') return raw !== 0;
    if (typeof raw === 'string') {
      const normalized = raw.trim().toLowerCase();
      if (!normalized) return defaultValue;
      if (['false', '0', 'no', 'off', 'disabled'].includes(normalized)) return false;
      if (['true', '1', 'yes', 'on', 'enabled'].includes(normalized)) return true;
    }
    return !!raw;
  };

  const normalizeCommand = (entry) => {
    if (entry === undefined || entry === null) return null;
    if (typeof entry === 'string' || typeof entry === 'number') {
      const text = String(entry).trim();
      return text ? { command: text, enabled: true, longRunning: false, timeoutSeconds: DEFAULT_COMMAND_TIMEOUT_SECONDS } : null;
    }
    if (typeof entry === 'object') {
      if (Array.isArray(entry)) {
        const nested = [];
        for (const sub of entry) {
          const normalized = normalizeCommand(sub);
          if (normalized) nested.push(normalized);
        }
        return nested.length ? nested : null;
      }
      if (entry.command instanceof Object && Array.isArray(entry.command)) {
        const nested = [];
        for (const sub of entry.command) {
          const normalized = normalizeCommand(sub);
          if (normalized) nested.push(normalized);
        }
        return nested.length ? nested : null;
      }
      const textSource = entry.command ?? entry.cmd ?? entry.value ?? entry.text;
      const text = textSource === undefined || textSource === null ? '' : String(textSource).trim();
      if (!text) return null;
      let enabled = entry.enabled;
      if (enabled === undefined && entry.disabled !== undefined) {
        enabled = !entry.disabled;
      }
      let longRunning = entry.longRunning;
      if (longRunning === undefined) longRunning = entry.long_running;
      if (longRunning === undefined) longRunning = entry.longRun ?? entry.long ?? entry.isLongRunning;
      let timeoutHint = entry.timeoutSeconds;
      if (timeoutHint === undefined) timeoutHint = entry.timeout_seconds;
      if (timeoutHint === undefined) timeoutHint = entry.timeout_sec;
      if (timeoutHint === undefined) timeoutHint = entry.timeout;
      return {
        command: text,
        enabled: toBool(enabled, true),
        longRunning: toBool(longRunning, false),
        timeoutSeconds: normalizeCommandTimeout(timeoutHint, DEFAULT_COMMAND_TIMEOUT_SECONDS),
      };
    }
    const fallback = String(entry).trim();
    return fallback ? { command: fallback, enabled: true, longRunning: false, timeoutSeconds: DEFAULT_COMMAND_TIMEOUT_SECONDS } : null;
  };

  const coerceDelay = (raw) => {
    try {
      let val = Number(raw || 0);
      if (!Number.isFinite(val) || val < 0) val = 0;
      return Math.round(val * 1000) / 1000;
    } catch {
      return 0;
    }
  };

  const clean = [];
  for (const rawStep of steps) {
    if (!rawStep) continue;
    const commandsSource = Array.isArray(rawStep.commands)
      ? rawStep.commands
      : Array.isArray(rawStep.cmds)
        ? rawStep.cmds
        : Array.isArray(rawStep.command)
          ? rawStep.command
          : Array.isArray(rawStep.parallel)
            ? rawStep.parallel
            : null;
    const commands = [];
    const ingest = (value) => {
      const normalized = normalizeCommand(value);
      if (!normalized) return;
      if (Array.isArray(normalized)) {
        normalized.forEach(cmd => commands.push(cmd));
      } else {
        commands.push(normalized);
      }
    };
    if (commandsSource) {
      for (const cmd of commandsSource) ingest(cmd);
    } else {
      const single = rawStep.command ?? rawStep.cmd ?? rawStep.value ?? rawStep.text;
      ingest(single);
    }
    if (!commands.length) continue;
    let delayRaw = rawStep.delaySeconds;
    if (delayRaw == null) delayRaw = rawStep.delay_seconds;
    if (delayRaw == null) delayRaw = rawStep.delay;
    if (delayRaw == null) delayRaw = rawStep.wait;
    if (delayRaw == null) delayRaw = rawStep.pause;
    const delay = coerceDelay(delayRaw);
    const cleanedCommands = commands
      .map(cmd => {
        const text = (cmd?.command ?? '').toString().trim();
        if (!text) return null;
        const enabled = toBool(cmd?.enabled, true);
        const longRunning = toBool(cmd?.longRunning ?? cmd?.long_running, false);
        const timeoutSeconds = normalizeCommandTimeout(cmd?.timeoutSeconds ?? cmd?.timeout_seconds ?? cmd?.timeout);
        return { command: text, enabled, longRunning, timeoutSeconds };
      })
      .filter(Boolean);
    if (!cleanedCommands.length) continue;
    clean.push({ delaySeconds: delay, commands: cleanedCommands });
  }
  return clean;
}

function normalizeStartCommandSteps(raw) {
  if (Array.isArray(raw)) {
    const steps = [];
    for (const item of raw) {
      if (typeof item === 'string') {
        const value = item.trim();
        if (value) steps.push({ delaySeconds: 0, commands: [value] });
        continue;
      }
      if (Array.isArray(item)) {
        const commands = [];
        for (const cmd of item) {
          const value = cmd == null ? '' : String(cmd).trim();
          if (value) commands.push(value);
        }
        if (commands.length) steps.push({ delaySeconds: 0, commands });
        continue;
      }
      if (item && typeof item === 'object') {
        steps.push(item);
      }
    }
    return sanitizeStartCommandSteps(steps);
  }
  if (typeof raw === 'string' && raw.trim()) {
    const lines = raw.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    return sanitizeStartCommandSteps(lines.map(cmd => ({ delaySeconds: 0, commands: [cmd] })));
  }
  return [];
}

function stepsToServerPayload(steps) {
  return sanitizeStartCommandSteps(steps).map(step => ({
    delay_seconds: step.delaySeconds,
    commands: step.commands.map(cmd => ({
      command: cmd.command,
      enabled: cmd.enabled !== false,
      long_running: cmd.longRunning === true,
      timeout_seconds: normalizeCommandTimeout(cmd.timeoutSeconds),
    }))
  }));
}

function encodeStartCommandsValue(steps) {
  try {
    return JSON.stringify(stepsToServerPayload(steps));
  } catch {
    return '[]';
  }
}

function parseStartCommandsValue(raw) {
  if (!raw) return [];
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return normalizeStartCommandSteps(parsed);
    } catch {
      return normalizeStartCommandSteps(raw);
    }
  }
  return normalizeStartCommandSteps(raw);
}

function formatStartCommandsSummary(steps) {
  const clean = sanitizeStartCommandSteps(steps);
  const stepCount = clean.length;
  let totalCommands = 0;
  let enabledCommands = 0;
  for (const step of clean) {
    const stepTotal = Array.isArray(step.commands) ? step.commands.length : 0;
    const stepEnabled = step.commands.filter(cmd => cmd && cmd.enabled !== false).length;
    totalCommands += stepTotal;
    enabledCommands += stepEnabled;
  }
  if (!totalCommands) return 'No commands configured';
  const disabledCommands = totalCommands - enabledCommands;
  if (stepCount === 1) {
    const first = clean[0];
    const firstTotal = first.commands.length;
    const firstEnabled = first.commands.filter(cmd => cmd && cmd.enabled !== false).length;
    const firstDisabled = firstTotal - firstEnabled;
    if (firstTotal === 1) {
      if (!firstEnabled) return '1 command (disabled)';
      return first.delaySeconds ? `1 command (delay ${first.delaySeconds}s)` : '1 command configured';
    }
    if (!firstEnabled) return `${firstTotal} commands (all disabled)`;
    if (!firstDisabled) return `${firstTotal} commands (parallel)`;
    return `${firstTotal} commands (${firstEnabled} enabled, ${firstDisabled} disabled)`;
  }
  if (!disabledCommands) return `${stepCount} steps / ${enabledCommands} commands`;
  return `${stepCount} steps / ${enabledCommands} enabled / ${disabledCommands} disabled`;
}

function formatStartCommandsTooltip(steps) {
  const clean = sanitizeStartCommandSteps(steps);
  if (!clean.length) return 'No commands configured';
  return clean.map((step, idx) => {
    const delay = step.delaySeconds ? `${step.delaySeconds}s` : '0s';
    const joined = step.commands.map(cmd => {
      if (!cmd) return '';
      const text = cmd.command || '';
      return cmd.enabled === false ? `[disabled] ${text}` : text;
    }).filter(Boolean).join(' || ');
    return `Step ${idx + 1} (delay ${delay}): ${joined || '[no enabled commands]'}`;
  }).join('\n');
}

function getStartCommandsFromDom(pid, idx) {
  const hidden = document.getElementById(`vm-${pid}-${idx}-start-data`);
  if (!hidden) return [];
  return parseStartCommandsValue(hidden.value);
}

function updateStartCommandsDomState(pid, idx, steps) {
  const clean = sanitizeStartCommandSteps(steps);
  const hidden = document.getElementById(`vm-${pid}-${idx}-start-data`);
  if (hidden) hidden.value = encodeStartCommandsValue(clean);
  const summary = document.getElementById(`vm-${pid}-${idx}-start-summary`);
  if (summary) {
    summary.textContent = formatStartCommandsSummary(clean);
    summary.title = formatStartCommandsTooltip(clean);
  }
  return clean;
}

function updateStartCommandsCache(pid, vmName, steps, idxHint) {
  const clean = sanitizeStartCommandSteps(steps);
  const payload = stepsToServerPayload(clean);
  try {
    const proj = (window.PROJ_CACHE || {})[pid];
    const list = proj && Array.isArray(proj.vms) ? proj.vms : null;
    if (list) {
      let targetIdx = typeof idxHint === 'number' ? idxHint : -1;
      if (targetIdx < 0 || !list[targetIdx] || list[targetIdx].name !== vmName) {
        targetIdx = list.findIndex(vm => vm && vm.name === vmName);
      }
      if (targetIdx >= 0 && list[targetIdx]) {
        list[targetIdx] = { ...list[targetIdx], start_commands: payload.slice() };
      }
    }
  } catch { }
  return clean;
}

function getStoredCommandsFromDom(pid, idx) {
  const hidden = document.getElementById(`vm-${pid}-${idx}-stored-data`);
  if (!hidden) return [];
  return parseStartCommandsValue(hidden.value);
}

function updateStoredCommandsDomState(pid, idx, steps) {
  const clean = sanitizeStartCommandSteps(steps);
  const hidden = document.getElementById(`vm-${pid}-${idx}-stored-data`);
  if (hidden) hidden.value = encodeStartCommandsValue(clean);
  const summary = document.getElementById(`vm-${pid}-${idx}-stored-summary`);
  if (summary) {
    summary.textContent = formatStartCommandsSummary(clean);
    summary.title = formatStartCommandsTooltip(clean);
  }
  return clean;
}

function updateStoredCommandsCache(pid, vmName, steps, idxHint) {
  const clean = sanitizeStartCommandSteps(steps);
  const payload = stepsToServerPayload(clean);
  try {
    const proj = (window.PROJ_CACHE || {})[pid];
    const list = proj && Array.isArray(proj.vms) ? proj.vms : null;
    if (list) {
      let targetIdx = typeof idxHint === 'number' ? idxHint : -1;
      if (targetIdx < 0 || !list[targetIdx] || list[targetIdx].name !== vmName) {
        targetIdx = list.findIndex(vm => vm && vm.name === vmName);
      }
      if (targetIdx >= 0 && list[targetIdx]) {
        list[targetIdx] = { ...list[targetIdx], stored_commands: payload.slice() };
      }
    }
  } catch { }
  return clean;
}

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
  } catch { }
  const res = await fetch(url, opts);
  if (!res.ok) {
    let msg = res.statusText;
    let bodyText = '';
    try { bodyText = (await res.text()) || ''; } catch { }
    if (bodyText) msg = bodyText;
    // Remote-mode enforcement uses HTTP 403; show a friendly message when possible.
    try {
      if (res.status === 403) {
        let extracted = '';
        try {
          const parsed = JSON.parse(bodyText || '{}');
          extracted = (parsed && (parsed.error || parsed.message)) ? String(parsed.error || parsed.message) : '';
        } catch { }
        const warn = extracted || (bodyText || 'Action is disabled when app is running in remote mode.');
        try { if (typeof window.showToast === 'function') window.showToast(warn, 'warning'); } catch { }
      }
    } catch { }
    throw new Error(msg || `HTTP ${res.status}`);
  }
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('application/json')) return res.json();
  return res.text();
}

// UI state helpers (restored)
function readUIState() { try { return JSON.parse(localStorage.getItem(UI_STATE_KEY) || '{}'); } catch { return {}; } }
function writeUIState(s) { try { localStorage.setItem(UI_STATE_KEY, JSON.stringify(s)); } catch { } }
function getProjState(pid) { const s = readUIState(); s.projects = s.projects || {}; s.projects[pid] = s.projects[pid] || {}; return s.projects[pid]; }
function setProjState(pid, patch) {
  const s = readUIState();
  s.projects = s.projects || {};
  s.projects[pid] = { ...(s.projects[pid] || {}), ...(patch || {}) };
  writeUIState(s);
}

// Settings helpers
function readSettings() {
  // Prefer dedicated UI settings key.
  try {
    const raw = localStorage.getItem(UI_SETTINGS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw || '{}') || {};
      if (parsed && typeof parsed === 'object') return parsed;
    }
  } catch { }
  // Legacy migration: older versions stored UI settings in `toolhub.settings.v1`.
  // That key is now owned by `shell.js` for runMode, so copy everything except `runMode`.
  try {
    const legacy = JSON.parse(localStorage.getItem(UI_SETTINGS_KEY_LEGACY) || '{}') || {};
    if (legacy && typeof legacy === 'object') {
      try { delete legacy.runMode; } catch { }
      try {
        if (Object.keys(legacy).length) {
          localStorage.setItem(UI_SETTINGS_KEY, JSON.stringify(legacy));
        }
      } catch { }
      return legacy;
    }
  } catch { }
  return {};
}
function writeSettings(s) { try { localStorage.setItem(UI_SETTINGS_KEY, JSON.stringify(s || {})); } catch { } }

const PROJECT_AUDIO_CACHE = {};
const PROJECT_AUDIO_LOADED = new Set();

// Settings modal + audio customization
// Must match backend ProjectStore._MAX_AUDIO_BYTES
const SETTINGS_AUDIO_MAX_BYTES = 10 * 1024 * 1024;
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
    placeholderHint: '{{audio}}, {{user_first}}, {{user_second}}, {{user_third}}, {{first_team}}, {{event_user}}, {{event_team}}, {{team_clause}}, {{project}}, {{project_clause}}, {{second_team}}, {{third_team}}',
    defaultEnabled: true,
    defaultSpeak: true,
    defaultSpeakTemplate: '{{audio}} {{user_first}} is now in first place{{project_clause}}.',
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
    placeholderHint: '{{audio}}, {{first_team}}, {{second_team}}, {{third_team}}, {{user_first}}, {{user_second}}, {{user_third}}, {{event_team}}, {{project}}, {{project_clause}}',
    defaultEnabled: true,
    defaultSpeak: true,
    defaultSpeakTemplate: '{{audio}} {{first_team}} is now in first place{{project_clause}}.',
    legacyDefaultSpeakBefore: '',
    legacyDefaultSpeakAfter: 'Team {{first_team}} is now in first place{{project_clause}}.'
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
    placeholderHint: '{{audio}}, {{user_first}}, {{user_second}}, {{user_third}}, {{first_team}}, {{event_user}}, {{event_team}}, {{team_clause}}, {{challenge}}, {{challenge_clause}}, {{points}}, {{points_clause}}, {{project}}, {{project_clause}}, {{second_team}}, {{third_team}}',
    defaultEnabled: true,
    defaultSpeak: true,
    defaultSpeakTemplate: '{{audio}} First score{{project_clause}} goes to {{event_user}}{{event_team}}{{team_clause}}{{challenge_clause}}{{points_clause}}.',
    legacyDefaultSpeakBefore: '',
    legacyDefaultSpeakAfter: 'First score{{project_clause}} goes to {{event_user}}{{event_team}}{{team_clause}}{{challenge_clause}}{{points_clause}}.'
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
    placeholderHint: '{{audio}}, {{reason}}, {{reason_clause}}, {{countdown_seconds}}, {{project}}, {{project_clause}}, {{second_team}}, {{third_team}}',
    defaultEnabled: false,
    defaultSpeak: false,
    defaultSpeakTemplate: '{{audio}} Countdown complete{{reason_clause}}.',
    legacyDefaultSpeakBefore: '',
    legacyDefaultSpeakAfter: 'Countdown complete{{reason_clause}}.'
  },
  ctfdCountdownStop: {
    inputId: 'settings-audio-ctfd-countdown-stop',
    previewId: 'settings-audio-ctfd-countdown-stop-preview',
    clearId: 'settings-audio-ctfd-countdown-stop-clear',
    listId: 'settings-audio-ctfd-countdown-stop-list',
    labelId: 'settings-audio-ctfd-countdown-stop-label',
    toggleId: 'settings-audio-ctfd-countdown-stop-toggle',
    speakToggleId: 'settings-audio-ctfd-countdown-stop-speak',
    speakLabelId: 'settings-audio-ctfd-countdown-stop-speak-label',
    templateInputId: 'settings-audio-ctfd-countdown-stop-speak-template-input',
    templateAddId: 'settings-audio-ctfd-countdown-stop-speak-template-add',
    templateListId: 'settings-audio-ctfd-countdown-stop-speak-template-list',
    speakHelpId: 'settings-audio-ctfd-countdown-stop-speak-help',
    placeholderHint: '{{audio}}, {{reason}}, {{reason_clause}}, {{project}}, {{project_clause}}',
    defaultEnabled: false,
    defaultSpeak: false,
    defaultSpeakTemplate: '{{audio}} Countdown cancelled{{reason_clause}}.',
    legacyDefaultSpeakBefore: '',
    legacyDefaultSpeakAfter: 'Countdown cancelled{{reason_clause}}.'
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
    placeholderHint: '{{audio}}, {{category}}, {{category_clause}}, {{user_first}}, {{user_second}}, {{user_third}}, {{event_user}}, {{event_team}}, {{team_clause}}, {{challenge}}, {{challenge_clause}}, {{project}}, {{project_clause}}',
    defaultEnabled: true,
    defaultSpeak: true,
    defaultSpeakTemplate: '{{audio}} {{event_user}} just solved the first challenge in {{category}}{{project_clause}}.',
    legacyDefaultSpeakBefore: '',
    legacyDefaultSpeakAfter: '{{event_user}} just solved the first challenge in {{category}}{{project_clause}}.'
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
    placeholderHint: '{{audio}}, {{category}}, {{category_clause}}, {{first_team}}, {{event_team}}, {{challenge}}, {{challenge_clause}}, {{project}}, {{project_clause}}',
    defaultEnabled: true,
    defaultSpeak: true,
    defaultSpeakTemplate: '{{audio}} {{event_team}} is first to solve a {{category}} challenge{{project_clause}}.',
    legacyDefaultSpeakBefore: '',
    legacyDefaultSpeakAfter: '{{event_team}} is first to solve a {{category}} challenge{{project_clause}}.'
  }
};
const SETTINGS_AUDIO_DEFAULTS = Object.fromEntries(Object.entries(SETTINGS_AUDIO_FIELDS).map(([key, cfg]) => [key, cfg.defaultEnabled !== undefined ? !!cfg.defaultEnabled : true]));
window.SETTINGS_AUDIO_DEFAULTS = SETTINGS_AUDIO_DEFAULTS;
window.SETTINGS_AUDIO_FIELDS_META = SETTINGS_AUDIO_FIELDS;
const SETTINGS_AUDIO_PREVIEW_DEFAULT_CONTEXT = {
  user_first: 'Alex Jordan',
  user_second: 'Jamie Lee',
  user_third: 'Morgan Vale',
  first_team: 'Team Eclipse',
  event_user: 'Alex Jordan',
  event_team: '',
  team_clause: ' from Team Eclipse',
  project: 'Cyber Shield',
  project_clause: ' in Cyber Shield',

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
  ctfdFirstTeam: { first_team: 'Team Eclipse', event_team: 'Team Eclipse' },
  ctfdPeriodic: { interval_minutes: '30' },
  ctfdFirstCategoryUser: { category: 'Web Exploitation', event_user: 'Alex Jordan' },
  ctfdFirstCategoryTeam: { category: 'Reverse Engineering', event_team: 'Team Aurora' },
  ctfdCountdownStop: { reason: 'challenges_hidden', reason_clause: ' while challenges are hidden' }
};
function settingsModalPreviewContext(key) {
  const overrides = SETTINGS_AUDIO_PREVIEW_CONTEXT[key];
  return overrides && typeof overrides === 'object'
    ? { ...SETTINGS_AUDIO_PREVIEW_DEFAULT_CONTEXT, ...overrides }
    : { ...SETTINGS_AUDIO_PREVIEW_DEFAULT_CONTEXT };
}
function settingsModalRenderSpeechTemplate(template, context) {
  const raw = typeof template === 'string' ? template : '';
  if (!raw.trim()) return '';
  const ctx = context && typeof context === 'object' ? context : {};
  const replaced = raw.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, key) => {
    if (!key) return '';
    if (key === 'audio') return '';
    if (Object.prototype.hasOwnProperty.call(ctx, key) && ctx[key] != null) {
      return String(ctx[key]);
    }
    return '';
  });
  return replaced.replace(/\s{2,}/g, ' ').replace(/\s+([.,!?;:])/g, '$1').trim();
}
function settingsModalBuildPreviewSpeechText(key, entry) {
  const templates = settingsAudioValidTemplates(entry, key);
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
function settingsModalSpeakPreview(text) {
  try { if (window.shell && shell.isRemote && shell.isRemote()) return; } catch { }
  if (!text || !settingsSpeechSupported()) return Promise.resolve(false);
  try {
    settingsModalSyncTtsWorkingFromInputs();
    const synth = window.speechSynthesis;
    if (!synth) return Promise.resolve(false);
    return new Promise((resolve) => {
      let settled = false;
      const utterance = new SpeechSynthesisUtterance(String(text));
      const rate = settingsClampNumber(_settingsTtsWorking.rate ?? SETTINGS_TTS_DEFAULT_RATE, SETTINGS_TTS_MIN_RATE, SETTINGS_TTS_MAX_RATE, SETTINGS_TTS_DEFAULT_RATE);
      const pitch = settingsClampNumber(_settingsTtsWorking.pitch ?? SETTINGS_TTS_DEFAULT_PITCH, SETTINGS_TTS_MIN_PITCH, SETTINGS_TTS_MAX_PITCH, SETTINGS_TTS_DEFAULT_PITCH);
      if (Number.isFinite(rate)) utterance.rate = rate;
      if (Number.isFinite(pitch)) utterance.pitch = pitch;

      const finish = (ok) => {
        if (settled) return;
        settled = true;
        if (APP_ACTIVE_SPEECH_PLAYBACK && APP_ACTIVE_SPEECH_PLAYBACK._utterance === utterance) APP_ACTIVE_SPEECH_PLAYBACK = null;
        resolve(!!ok);
      };

      utterance.onend = () => finish(true);
      utterance.onerror = () => finish(false);

      APP_ACTIVE_SPEECH_PLAYBACK = {
        _utterance: utterance,
        stop: () => {
          if (settled) return;
          try { synth.cancel(); } catch { }
          finish(false);
        }
      };

      try { synth.cancel(); } catch { }
      synth.speak(utterance);
    });
  } catch {
    return Promise.resolve(false);
  }
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
function settingsSpeechSupported() {
  try {
    return typeof window !== 'undefined'
      && 'speechSynthesis' in window
      && window.speechSynthesis
      && typeof window.speechSynthesis.speak === 'function'
      && typeof window.SpeechSynthesisUtterance === 'function';
  } catch { return false; }
}
function settingsClampNumber(value, min, max, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  if (num < min) return min;
  if (num > max) return max;
  return num;
}
function settingsRoundTts(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  return Math.round(num * 100) / 100;
}
function settingsReadStoredTts(settings) {
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
function settingsModalUpdateTtsSupportNote() {
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
function settingsModalHandleTtsInput(kind, input) {
  if (!input) return;
  const num = Number(input.value);
  if (!Number.isFinite(num)) return;
  if (kind === 'rate') _settingsTtsWorking.rate = num;
  else _settingsTtsWorking.pitch = num;
}
function settingsModalHandleTtsChange(kind, input) {
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
function settingsModalSyncTtsWorkingFromInputs() {
  const rateInput = document.getElementById('settings-tts-rate');
  const pitchInput = document.getElementById('settings-tts-pitch');
  if (rateInput) settingsModalHandleTtsChange('rate', rateInput);
  if (pitchInput) settingsModalHandleTtsChange('pitch', pitchInput);
}
function wireSettingsTtsControls() {
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
function cloneSettingsAudio(src) { try { return JSON.parse(JSON.stringify(src || {})); } catch { return {}; } }
function cloneAudioEntry(entry) { try { return JSON.parse(JSON.stringify(entry || {})); } catch { return {}; } }
function projectAudioCacheKey(pid) { return String(pid || '').trim(); }
async function loadProjectAudio(pid, options) {
  const id = projectAudioCacheKey(pid);
  if (!id) return {};
  const opts = options && typeof options === 'object' ? options : {};
  if (!opts.force && PROJECT_AUDIO_LOADED.has(id)) {
    return cloneSettingsAudio(PROJECT_AUDIO_CACHE[id] || {});
  }
  try {
    const res = await http('GET', `/api/projects/${id}/audio`);
    const audio = res && typeof res.audio === 'object' ? res.audio : {};
    const sanitized = cloneSettingsAudio(audio);
    PROJECT_AUDIO_CACHE[id] = sanitized;
    PROJECT_AUDIO_LOADED.add(id);
    return cloneSettingsAudio(sanitized);
  } catch (err) {
    if (!opts.silent) {
      try { (window.shell && shell.logWarn) ? shell.logWarn(`Settings: failed to load audio for project ${id}: ${err?.message || err}`) : console.warn('Settings: failed to load audio', id, err); } catch { }
    }
    if (!PROJECT_AUDIO_LOADED.has(id)) return {};
    return cloneSettingsAudio(PROJECT_AUDIO_CACHE[id] || {});
  }
}
function peekProjectAudio(pid) {
  const id = projectAudioCacheKey(pid);
  if (!id) return null;
  if (!PROJECT_AUDIO_LOADED.has(id)) return null;
  return PROJECT_AUDIO_CACHE[id] || {};
}
function getProjectAudio(pid) {
  const cached = peekProjectAudio(pid);
  if (cached === null) return {};
  return cloneSettingsAudio(cached || {});
}
function projectAudioIsLoaded(pid) {
  const id = projectAudioCacheKey(pid);
  if (!id) return false;
  return PROJECT_AUDIO_LOADED.has(id);
}
function dispatchProjectAudioUpdated(pid, audio) {
  const id = projectAudioCacheKey(pid);
  if (!id) return cloneSettingsAudio(audio || {});
  const detailAudio = cloneSettingsAudio(audio || PROJECT_AUDIO_CACHE[id] || {});
  try { document.dispatchEvent(new CustomEvent('project-audio-updated', { detail: { pid: id, audio: detailAudio } })); } catch { }
  return detailAudio;
}
async function refreshProjectAudioCache(pid, options) {
  const id = projectAudioCacheKey(pid);
  if (!id) return {};
  const opts = options && typeof options === 'object' ? options : {};
  const audio = await loadProjectAudio(id, { force: true, silent: opts.silent !== false });
  return dispatchProjectAudioUpdated(id, audio);
}
async function saveProjectAudio(pid, audio) {
  const id = projectAudioCacheKey(pid);
  if (!id) throw new Error('Project id required to save audio');
  const payload = { audio: cloneSettingsAudio(audio || {}) };
  const res = await http('PUT', `/api/projects/${id}/audio`, payload);
  const normalized = res && typeof res.audio === 'object' ? res.audio : {};
  const sanitized = cloneSettingsAudio(normalized);
  PROJECT_AUDIO_CACHE[id] = sanitized;
  PROJECT_AUDIO_LOADED.add(id);
  return dispatchProjectAudioUpdated(id, sanitized);
}
window.loadProjectAudio = loadProjectAudio;
window.saveProjectAudio = saveProjectAudio;
window.getProjectAudio = getProjectAudio;
window.peekProjectAudio = peekProjectAudio;
window.projectAudioIsLoaded = projectAudioIsLoaded;

// Project audio store prefixes
const AUDIO_MEDIA_PREFIX = 'media:';
const AUDIO_EVENT_PREFIX = 'event:';

let APP_ACTIVE_AUDIO_PLAYBACK = null;
let APP_ACTIVE_SPEECH_PLAYBACK = null;
let APP_ACTIVE_PLAY_BUTTON = null;
let APP_ACTIVE_PLAY_TOKEN = 0;

function appSetPlayStopButtonState(btn, playing) {
  if (!btn) return;
  const isPlaying = !!playing;
  if (!btn.dataset.playLabel) btn.dataset.playLabel = btn.textContent || 'Preview';
  const playLabel = btn.dataset.playLabel || 'Preview';
  const stopLabel = 'Stop';
  btn.textContent = isPlaying ? stopLabel : playLabel;
  if (isPlaying) btn.dataset.playing = '1';
  else delete btn.dataset.playing;
}

function appClearActivePlayButton() {
  if (!APP_ACTIVE_PLAY_BUTTON) return;
  try { appSetPlayStopButtonState(APP_ACTIVE_PLAY_BUTTON, false); } catch { }
  APP_ACTIVE_PLAY_BUTTON = null;
}

function appStopActiveAudioPlayback() {
  const active = APP_ACTIVE_AUDIO_PLAYBACK;
  if (!active) return;
  APP_ACTIVE_AUDIO_PLAYBACK = null;
  try { if (active && typeof active.stop === 'function') active.stop(); } catch { }
}

function appStopActiveSpeechPlayback() {
  const active = APP_ACTIVE_SPEECH_PLAYBACK;
  APP_ACTIVE_SPEECH_PLAYBACK = null;
  try { if (active && typeof active.stop === 'function') active.stop(); } catch { }
  try {
    const synth = window.speechSynthesis;
    if (synth && typeof synth.cancel === 'function') synth.cancel();
  } catch { }
}

function appStopActivePlayback() {
  // Bump the play token so any in-flight preview chains (timers/events/promises)
  // can detect cancellation and avoid starting new playback.
  APP_ACTIVE_PLAY_TOKEN++;
  appStopActiveAudioPlayback();
  appStopActiveSpeechPlayback();
  appClearActivePlayButton();
}

try { window.appStopActivePlayback = appStopActivePlayback; } catch { }

function audioMakeMediaKey() {
  let id = '';
  try {
    if (typeof crypto !== 'undefined' && crypto && typeof crypto.randomUUID === 'function') {
      id = crypto.randomUUID();
    }
  } catch { }
  if (!id) {
    id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }
  return `${AUDIO_MEDIA_PREFIX}${id}`;
}

function audioIsMediaKey(key) {
  return typeof key === 'string' && key.startsWith(AUDIO_MEDIA_PREFIX);
}

function audioNormalizeSingleSound(entry) {
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

function audioNormalizeSingleSoundLoose(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const sounds = Array.isArray(entry.sounds) ? entry.sounds : [];
  const sound = sounds.find(s => s && typeof s === 'object') || null;
  if (!sound) return null;
  const dataUrl = (sound && typeof sound.dataUrl === 'string') ? sound.dataUrl : '';
  return {
    dataUrl: (typeof dataUrl === 'string' && dataUrl.startsWith('data:')) ? dataUrl : '',
    name: sound.name ? String(sound.name) : 'Audio',
    size: Number(sound.size) || 0,
    type: sound.type ? String(sound.type) : '',
    updated: Number(sound.updated) || 0,
  };
}

function audioListMediaItems(audioStore) {
  const store = audioStore && typeof audioStore === 'object' ? audioStore : {};
  const items = [];
  Object.entries(store).forEach(([key, entry]) => {
    if (!audioIsMediaKey(String(key))) return;
    const sound = audioNormalizeSingleSoundLoose(entry);
    if (!sound) return;
    items.push({ key: String(key), ...sound });
  });
  items.sort((a, b) => (b.updated || 0) - (a.updated || 0) || String(a.name).localeCompare(String(b.name)));
  return items;
}

async function mediaManagerLoadMediaMeta(pid) {
  const id = projectAudioCacheKey(pid);
  if (!id) return {};
  const pfx = encodeURIComponent(AUDIO_MEDIA_PREFIX);
  const res = await http('GET', `/api/projects/${id}/audio?prefix=${pfx}&meta=1`);
  const audio = res && typeof res.audio === 'object' ? res.audio : {};
  return cloneSettingsAudio(audio);
}

function mediaManagerUpsertCacheEntry(pid, key, entry) {
  const id = projectAudioCacheKey(pid);
  if (!id || !key) return;
  try {
    const existing = PROJECT_AUDIO_CACHE[id];
    if (existing && typeof existing === 'object') {
      existing[String(key)] = cloneSettingsAudio(entry || {});
      PROJECT_AUDIO_CACHE[id] = existing;
      PROJECT_AUDIO_LOADED.add(id);
    }
  } catch { }
}

function mediaManagerReadCurrentPid() {
  try {
    return (window.shell && shell.getCurrentProjectId) ? String(shell.getCurrentProjectId() || '').trim() : '';
  } catch {
    return '';
  }
}

function mediaManagerRemoteBlocked() {
  try { return !!(window.shell && shell.isRemote && shell.isRemote()); } catch { return false; }
}

function mediaManagerReadFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    try {
      const reader = new FileReader();
      reader.onprogress = null;
      reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
      reader.onerror = () => reject(new Error('Failed to read file'));
      reader.readAsDataURL(file);
    } catch (err) {
      reject(err);
    }
  });
}

function mediaManagerReadFileAsDataUrlWithProgress(file, onProgress) {
  return new Promise((resolve, reject) => {
    try {
      const reader = new FileReader();
      reader.onprogress = (ev) => {
        try {
          if (!ev || !ev.lengthComputable) return;
          const pct = ev.total ? Math.round((ev.loaded / ev.total) * 100) : 0;
          if (typeof onProgress === 'function') onProgress(pct);
        } catch { }
      };
      reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
      reader.onerror = () => reject(new Error('Failed to read file'));
      reader.readAsDataURL(file);
    } catch (err) {
      reject(err);
    }
  });
}

function mediaManagerXhrJson(method, url, body, onProgress) {
  return new Promise((resolve, reject) => {
    try {
      const xhr = new XMLHttpRequest();
      xhr.open(method, url, true);
      xhr.withCredentials = true;
      xhr.setRequestHeader('Content-Type', 'application/json');
      xhr.responseType = 'text';
      if (xhr.upload && typeof xhr.upload.addEventListener === 'function') {
        xhr.upload.addEventListener('progress', (ev) => {
          try {
            if (!ev || !ev.lengthComputable) return;
            const pct = ev.total ? Math.round((ev.loaded / ev.total) * 100) : 0;
            if (typeof onProgress === 'function') onProgress(pct);
          } catch { }
        });
      }
      xhr.onload = () => {
        const ok = xhr.status >= 200 && xhr.status < 300;
        const text = xhr.responseText || '';
        if (!ok) return reject(new Error(text || xhr.statusText || `HTTP ${xhr.status}`));
        try {
          const parsed = JSON.parse(text || '{}');
          return resolve(parsed);
        } catch {
          return resolve(text);
        }
      };
      xhr.onerror = () => reject(new Error('Network error'));
      xhr.send(JSON.stringify(body || {}));
    } catch (err) {
      reject(err);
    }
  });
}

function mediaManagerLooks404(err) {
  const msg = String(err && err.message ? err.message : err || '');
  return msg.includes('404') || msg.toLowerCase().includes('not found') || msg.includes('requested URL was not found');
}

async function mediaManagerSha256HexFromDataUrl(dataUrl) {
  try {
    if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:')) return '';
    const comma = dataUrl.indexOf(',');
    if (comma < 0) return '';
    const header = dataUrl.slice(0, comma);
    const payload = dataUrl.slice(comma + 1);
    if (!header.includes(';base64')) return '';
    if (!payload) return '';
    // Decode base64 to bytes
    const bin = atob(payload);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    if (!crypto || !crypto.subtle || typeof crypto.subtle.digest !== 'function') return '';
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    const out = Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
    return out || '';
  } catch {
    return '';
  }
}

function mediaManagerFindDuplicateKeyBySha256(mediaMeta, sha256Hex) {
  if (!sha256Hex) return '';
  const store = mediaMeta && typeof mediaMeta === 'object' ? mediaMeta : {};
  for (const [k, v] of Object.entries(store)) {
    if (!k || typeof k !== 'string' || !k.startsWith(AUDIO_MEDIA_PREFIX)) continue;
    if (!v || typeof v !== 'object') continue;
    const sounds = Array.isArray(v.sounds) ? v.sounds : [];
    const s0 = sounds.find(s => s && typeof s === 'object') || null;
    const h = s0 && typeof s0.sha256 === 'string' ? String(s0.sha256) : '';
    if (h && h === sha256Hex) return k;
  }
  return '';
}

function mediaManagerFindDuplicateKeyByDataUrl(audioStore, dataUrl) {
  if (!dataUrl) return '';
  const store = audioStore && typeof audioStore === 'object' ? audioStore : {};
  for (const [k, v] of Object.entries(store)) {
    if (!k || typeof k !== 'string' || !k.startsWith(AUDIO_MEDIA_PREFIX)) continue;
    const s = audioNormalizeSingleSound(v);
    if (s && s.dataUrl && s.dataUrl === dataUrl) return k;
  }
  return '';
}

function mediaManagerGetSelectedKeys() {
  const listEl = document.getElementById('settings-media-list');
  if (!listEl) return [];
  const keys = Array.from(listEl.querySelectorAll('input.media-select:checked')).map(el => String(el.getAttribute('data-media-key') || '')).filter(Boolean);
  // De-dupe while preserving order
  const seen = new Set();
  const out = [];
  for (const k of keys) {
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(k);
  }
  return out;
}

function mediaManagerUpdateBatchDeleteButton() {
  const btn = document.getElementById('settings-media-delete-selected');
  if (!btn) return;
  try { btn.disabled = mediaManagerGetSelectedKeys().length === 0; } catch { btn.disabled = true; }
}

function mediaManagerSetSelectAllState({ disabled, checked } = {}) {
  const el = document.getElementById('settings-media-select-all');
  if (!el) return;
  if (disabled !== undefined) el.disabled = !!disabled;
  if (checked !== undefined) el.checked = !!checked;
}

async function mediaManagerDeleteItems(mediaKeys) {
  if (mediaManagerRemoteBlocked()) return { deleted: 0, failed: 0 };
  const pid = mediaManagerReadCurrentPid();
  if (!pid) return { deleted: 0, failed: 0 };
  const keys = Array.isArray(mediaKeys) ? mediaKeys.map(k => String(k || '')).filter(audioIsMediaKey) : [];
  const unique = Array.from(new Set(keys));
  if (!unique.length) return { deleted: 0, failed: 0 };

  let deleted = 0;
  let failed = 0;
  let fellBackToLegacy = false;

  try {
    try { if (typeof window.showActionProgress === 'function') window.showActionProgress('Media Delete', `Deleting ${unique.length} file(s)…`); } catch { }
    for (let i = 0; i < unique.length; i++) {
      const key = unique[i];
      const pct = Math.max(0, Math.min(95, Math.round((i / unique.length) * 95)));
      try {
        if (typeof window.updateActionProgress === 'function') window.updateActionProgress({ text: `Deleting ${i + 1}/${unique.length}…`, percent: pct, barText: `${pct}%` });
      } catch { }
      try {
        await http('DELETE', `/api/projects/${encodeURIComponent(pid)}/audio_entry?key=${encodeURIComponent(key)}`);
        deleted += 1;
      } catch (err) {
        if (mediaManagerLooks404(err)) {
          fellBackToLegacy = true;
          break;
        }
        failed += 1;
      }
    }

    if (fellBackToLegacy) {
      const audioStore = await loadProjectAudio(pid, { force: true, silent: true });
      let legacyDeleted = 0;
      unique.forEach((key) => {
        if (!Object.prototype.hasOwnProperty.call(audioStore, key)) return;
        delete audioStore[key];
        legacyDeleted += 1;
        // Clear any per-event references to this media key
        Object.entries(audioStore).forEach(([k, v]) => {
          if (!k || typeof k !== 'string') return;
          if (!k.startsWith(AUDIO_EVENT_PREFIX)) return;
          if (!v || typeof v !== 'object') return;
          if (v.soundKey === key) {
            try { delete v.soundKey; } catch { }
          }
        });
      });
      await saveProjectAudio(pid, audioStore);
      deleted = legacyDeleted;
      // if legacy save worked, treat as no per-key failures
      failed = 0;
    }

    try {
      const id = projectAudioCacheKey(pid);
      if (id && PROJECT_AUDIO_CACHE[id] && typeof PROJECT_AUDIO_CACHE[id] === 'object') {
        unique.forEach(k => { try { delete PROJECT_AUDIO_CACHE[id][k]; } catch { } });
      }
    } catch { }
  } finally {
    try { if (typeof window.updateActionProgress === 'function') window.updateActionProgress({ text: 'Done', percent: 100, barText: 'Done' }); } catch { }
    try { if (typeof window.hideActionProgress === 'function') window.hideActionProgress(); } catch { }
  }

  return { deleted, failed };
}

async function mediaManagerUploadFilesBatch(files) {
  if (mediaManagerRemoteBlocked()) return { uploaded: 0, duplicated: 0, failed: 0 };
  const pid = mediaManagerReadCurrentPid();
  if (!pid) return { uploaded: 0, duplicated: 0, failed: 0 };
  const list = Array.isArray(files) ? files.filter(Boolean) : [];
  if (!list.length) return { uploaded: 0, duplicated: 0, failed: 0 };

  let uploaded = 0;
  let duplicated = 0;
  let failed = 0;

  // Build sha->key map if server meta includes hashes
  const existingShaToKey = {};
  try {
    const meta = await mediaManagerLoadMediaMeta(pid);
    Object.entries(meta || {}).forEach(([k, v]) => {
      if (!audioIsMediaKey(k)) return;
      const sounds = Array.isArray(v && v.sounds) ? v.sounds : [];
      const s0 = sounds.find(s => s && typeof s === 'object') || null;
      const h = s0 && typeof s0.sha256 === 'string' ? String(s0.sha256) : '';
      if (h) existingShaToKey[h] = k;
    });
  } catch { }
  const seenSha = new Set();
  const legacyModeSeenDataUrls = new Set();

  let legacyMode = false;
  let legacyAudioStore = null;
  let legacyLoaded = false;

  const total = list.length;
  const mapOverall = (fileIndex, innerPct) => {
    const span = 100 / Math.max(1, total);
    const base = fileIndex * span;
    const v = base + (Math.max(0, Math.min(100, innerPct)) / 100) * span;
    return Math.max(0, Math.min(100, Math.round(v)));
  };
  const setProgress = (pct, text) => {
    try {
      if (typeof window.updateActionProgress === 'function') window.updateActionProgress({ text, percent: pct, barText: `${pct}%` });
    } catch { }
  };

  try {
    try { if (typeof window.showActionProgress === 'function') window.showActionProgress('Media Upload', `Uploading ${total} file(s)…`); } catch { }

    for (let idx = 0; idx < total; idx++) {
      const file = list[idx];
      const name = file && file.name ? file.name : 'file';
      setProgress(mapOverall(idx, 0), `Reading ${idx + 1}/${total}: ${name}…`);

      let dataUrl = '';
      try {
        dataUrl = await mediaManagerReadFileAsDataUrlWithProgress(file, (pct) => {
          setProgress(mapOverall(idx, Math.round((pct / 100) * 40)), `Reading ${idx + 1}/${total}: ${name}…`);
        });
      } catch {
        failed += 1;
        continue;
      }
      if (!dataUrl || !dataUrl.startsWith('data:')) {
        failed += 1;
        continue;
      }

      setProgress(mapOverall(idx, 42), `Checking ${idx + 1}/${total}: ${name}…`);
      const sha256Hex = await mediaManagerSha256HexFromDataUrl(dataUrl);

      if (sha256Hex) {
        if (existingShaToKey[sha256Hex]) { duplicated += 1; continue; }
        if (seenSha.has(sha256Hex)) { duplicated += 1; continue; }
      } else {
        // hash unavailable: only intra-batch dedupe by dataUrl (legacy mode will also check store)
        if (legacyModeSeenDataUrls.has(dataUrl)) { duplicated += 1; continue; }
      }

      // Upload path
      if (legacyMode) {
        if (!legacyLoaded) {
          legacyAudioStore = await loadProjectAudio(pid, { force: true, silent: true });
          legacyLoaded = true;
        }
        const dupKey = mediaManagerFindDuplicateKeyByDataUrl(legacyAudioStore, dataUrl);
        if (dupKey) {
          duplicated += 1;
          continue;
        }
        const mediaKey = audioMakeMediaKey();
        legacyAudioStore[mediaKey] = {
          sounds: [{
            name: file.name || 'Audio',
            size: file.size || 0,
            type: file.type || '',
            dataUrl,
            updated: Date.now()
          }]
        };
        uploaded += 1;
        if (sha256Hex) { existingShaToKey[sha256Hex] = mediaKey; seenSha.add(sha256Hex); }
        else { legacyModeSeenDataUrls.add(dataUrl); }
        continue;
      }

      setProgress(mapOverall(idx, 45), `Uploading ${idx + 1}/${total}: ${name}…`);
      try {
        const res = await mediaManagerXhrJson('POST', `/api/projects/${encodeURIComponent(pid)}/audio_media`, {
          name: file.name || 'Audio',
          size: file.size || 0,
          type: file.type || '',
          dataUrl,
        }, (pct) => {
          // Map upload progress roughly into 45..95 inner range
          const inner = 45 + Math.max(0, Math.min(50, Math.round((pct / 100) * 50)));
          setProgress(mapOverall(idx, inner), `Uploading ${idx + 1}/${total}: ${name}…`);
        });
        const isDup = !!(res && res.duplicated);
        if (isDup) {
          duplicated += 1;
        } else {
          uploaded += 1;
          if (sha256Hex) {
            const key = res && res.key ? String(res.key) : '';
            existingShaToKey[sha256Hex] = key || existingShaToKey[sha256Hex] || '';
            seenSha.add(sha256Hex);
          }
        }
      } catch (err) {
        if (mediaManagerLooks404(err)) {
          legacyMode = true;
          idx -= 1; // re-process this file in legacy mode
          continue;
        }
        failed += 1;
      }
    }

    if (legacyMode && legacyLoaded && legacyAudioStore) {
      setProgress(95, 'Saving…');
      try {
        await saveProjectAudio(pid, legacyAudioStore);
      } catch {
        // If final save fails, mark as failed (best effort)
        failed += 1;
      }
    }
    if (!legacyMode && uploaded > 0) {
      try { await refreshProjectAudioCache(pid, { silent: true }); } catch { }
    }
  } finally {
    try { if (typeof window.updateActionProgress === 'function') window.updateActionProgress({ text: 'Done', percent: 100, barText: 'Done' }); } catch { }
    try { if (typeof window.hideActionProgress === 'function') window.hideActionProgress(); } catch { }
  }

  return { uploaded, duplicated, failed };
}

async function mediaManagerUploadFile(file) {
  if (!file) return;
  if (mediaManagerRemoteBlocked()) return;
  if (file.size > SETTINGS_AUDIO_MAX_BYTES) {
    alert('Audio file too large. Limit is 10 MB per file.');
    return;
  }
  const pid = mediaManagerReadCurrentPid();
  if (!pid) {
    alert('Select a project first.');
    return;
  }

  try {
    if (typeof window.showActionProgress === 'function') {
      window.showActionProgress('Media Upload', `Reading ${file.name || 'file'}…`);
      if (typeof window.openActionProgressModal === 'function') window.openActionProgressModal();
    }
  } catch { }

  let dataUrl = '';
  try {
    dataUrl = await mediaManagerReadFileAsDataUrlWithProgress(file, (pct) => {
      try {
        if (typeof window.updateActionProgress === 'function') {
          const scaled = Math.max(0, Math.min(40, Math.round((pct / 100) * 40)));
          window.updateActionProgress({ text: `Reading ${file.name || 'file'}…`, percent: scaled, barText: `${scaled}%` });
        }
      } catch { }
    });
    if (!dataUrl || !dataUrl.startsWith('data:')) {
      alert('Unsupported audio format.');
      return;
    }

    // Client-side dedupe: prefer hash-based (fast) if available, else fall back to dataUrl match.
    let sha256Hex = '';
    try {
      if (typeof window.updateActionProgress === 'function') {
        window.updateActionProgress({ text: `Checking duplicates…`, percent: 42, barText: 'Checking…' });
      }
    } catch { }
    sha256Hex = await mediaManagerSha256HexFromDataUrl(dataUrl);

    let dupKey = '';
    try {
      const meta = await mediaManagerLoadMediaMeta(pid);
      dupKey = mediaManagerFindDuplicateKeyBySha256(meta, sha256Hex);
    } catch { }

    if (!dupKey) {
      // If meta doesn't include hashes (older backend), fall back to full store equality.
      try {
        const full = await loadProjectAudio(pid, { force: false, silent: true });
        dupKey = mediaManagerFindDuplicateKeyByDataUrl(full, dataUrl);
      } catch { }
      if (!dupKey) {
        try {
          const full = await loadProjectAudio(pid, { force: true, silent: true });
          dupKey = mediaManagerFindDuplicateKeyByDataUrl(full, dataUrl);
        } catch { }
      }
    }

    if (dupKey) {
      try { if (typeof window.showToast === 'function') window.showToast(`Already uploaded: ${file.name || 'Audio'}`, 'info'); } catch { }
      return;
    }

    try {
      if (typeof window.updateActionProgress === 'function') {
        window.updateActionProgress({ text: `Uploading ${file.name || 'file'}…`, percent: 45, barText: 'Uploading…' });
      }
    } catch { }

    let res = null;
    try {
      res = await mediaManagerXhrJson('POST', `/api/projects/${encodeURIComponent(pid)}/audio_media`, {
        name: file.name || 'Audio',
        size: file.size || 0,
        type: file.type || '',
        dataUrl,
      }, (pct) => {
        try {
          if (typeof window.updateActionProgress === 'function') {
            const scaled = 45 + Math.max(0, Math.min(50, Math.round((pct / 100) * 50)));
            window.updateActionProgress({ text: `Uploading ${file.name || 'file'}…`, percent: scaled, barText: `${scaled}%` });
          }
        } catch { }
      });
    } catch (err) {
      // Backward compatible fallback: if the server doesn't have the new endpoint yet,
      // fall back to the legacy full-store update path.
      if (!mediaManagerLooks404(err)) throw err;

      try {
        if (typeof window.updateActionProgress === 'function') {
          window.updateActionProgress({ text: `Uploading ${file.name || 'file'}…`, percent: 60, barText: 'Saving…' });
        }
      } catch { }

      const audioStore = await loadProjectAudio(pid, { force: true, silent: true });

      // Dedupe even in legacy path
      const legacyDup = mediaManagerFindDuplicateKeyByDataUrl(audioStore, dataUrl);
      if (legacyDup) {
        res = { duplicated: true, key: legacyDup, legacy: true };
      } else {
        const mediaKey = audioMakeMediaKey();
        audioStore[mediaKey] = {
          sounds: [{
            name: file.name || 'Audio',
            size: file.size || 0,
            type: file.type || '',
            dataUrl,
            updated: Date.now()
          }]
        };
        await saveProjectAudio(pid, audioStore);
        res = { duplicated: false, key: mediaKey, legacy: true };
      }
    }

    const duplicated = !!(res && res.duplicated);
    if (duplicated) {
      try { if (typeof window.showToast === 'function') window.showToast(`Already uploaded: ${file.name || 'Audio'}`, 'info'); } catch { }
    } else {
      if (!(res && res.legacy)) {
        try { await refreshProjectAudioCache(pid, { silent: true }); } catch { }
      }
      try { if (typeof window.showToast === 'function') window.showToast(`Uploaded: ${file.name || 'Audio'}`, 'success'); } catch { }
    }
  } finally {
    try {
      if (typeof window.updateActionProgress === 'function') window.updateActionProgress({ text: 'Done', percent: 100, barText: 'Done' });
    } catch { }
    try { if (typeof window.hideActionProgress === 'function') window.hideActionProgress(); } catch { }
  }
}

async function mediaManagerDeleteItem(mediaKey) {
  if (mediaManagerRemoteBlocked()) return;
  const pid = mediaManagerReadCurrentPid();
  if (!pid) return;
  const key = String(mediaKey || '');
  if (!audioIsMediaKey(key)) return;
  let deleted = false;
  try {
    await http('DELETE', `/api/projects/${encodeURIComponent(pid)}/audio_entry?key=${encodeURIComponent(key)}`);
    deleted = true;
  } catch (err) {
    // Backward compatible fallback: some deployments may not yet have the
    // single-entry delete endpoint. If we got a 404, fall back to the legacy
    // full-store update.
    const msg = String(err && err.message ? err.message : err || '');
    const looks404 = msg.includes('404') || msg.toLowerCase().includes('not found') || msg.includes('requested URL was not found');
    if (!looks404) throw err;

    const audioStore = await loadProjectAudio(pid, { force: true, silent: true });
    if (!Object.prototype.hasOwnProperty.call(audioStore, key)) return;
    delete audioStore[key];
    // Clear any per-event references to this media key
    Object.entries(audioStore).forEach(([k, v]) => {
      if (!k || typeof k !== 'string') return;
      if (!k.startsWith(AUDIO_EVENT_PREFIX)) return;
      if (!v || typeof v !== 'object') return;
      if (v.soundKey === key) {
        try { delete v.soundKey; } catch { }
      }
    });
    await saveProjectAudio(pid, audioStore);
  }
  if (deleted) {
    try { await refreshProjectAudioCache(pid, { silent: true }); } catch { }
  }
}

async function mediaManagerRefreshList(options) {
  const opts = options && typeof options === 'object' ? options : {};
  const listEl = document.getElementById('settings-media-list');
  const statusEl = document.getElementById('settings-media-status');
  if (!listEl) return;

  const pid = mediaManagerReadCurrentPid();
  if (!pid) {
    if (statusEl) statusEl.textContent = 'Select a project to manage media.';
    listEl.innerHTML = '<li class="list-group-item small text-muted">No project selected.</li>';
    mediaManagerUpdateBatchDeleteButton();
    mediaManagerSetSelectAllState({ disabled: true, checked: false });
    return;
  }
  if (statusEl) statusEl.textContent = 'Loading…';
  let mediaMeta = {};
  try {
    mediaMeta = await mediaManagerLoadMediaMeta(pid);
  } catch (err) {
    listEl.innerHTML = '<li class="list-group-item small text-muted">Failed to load uploaded audio.</li>';
    if (statusEl) statusEl.textContent = `Load failed: ${err?.message || err}`;
    mediaManagerUpdateBatchDeleteButton();
    mediaManagerSetSelectAllState({ disabled: true, checked: false });
    return;
  }
  const items = audioListMediaItems(mediaMeta);
  if (!items.length) {
    listEl.innerHTML = '<li class="list-group-item small text-muted">No uploaded audio yet.</li>';
    if (statusEl) statusEl.textContent = '';
    mediaManagerUpdateBatchDeleteButton();
    mediaManagerSetSelectAllState({ disabled: true, checked: false });
    return;
  }
  listEl.innerHTML = items.map(item => {
    const safeName = escHtml(item.name || 'Audio');
    const sizeKb = item.size ? `${Math.round(item.size / 1024)} KB` : 'Size unknown';
    const typeLabel = item.type ? escHtml(item.type) : 'Audio';
    const meta = `${sizeKb} | ${typeLabel}`;
    return `<li class="list-group-item d-flex align-items-center justify-content-between gap-2" data-media-key="${escHtml(item.key)}">
  <input class="form-check-input me-2 media-select" type="checkbox" data-media-key="${escHtml(item.key)}" aria-label="Select audio file">
  <div class="flex-grow-1">
    <div>${safeName}</div>
    <div class="small text-muted">${meta}</div>
  </div>
  <div class="btn-group btn-group-sm">
    <button type="button" class="btn btn-outline-secondary" data-action="media-preview">Preview</button>
  </div>
</li>`;
  }).join('');
  if (statusEl) statusEl.textContent = '';
  mediaManagerUpdateBatchDeleteButton();
  mediaManagerSetSelectAllState({ disabled: false, checked: false });
}

function wireMediaManagerControls() {
  const upload = document.getElementById('settings-media-upload');
  const refresh = document.getElementById('settings-media-refresh');
  const delSelected = document.getElementById('settings-media-delete-selected');
  const selectAll = document.getElementById('settings-media-select-all');
  const list = document.getElementById('settings-media-list');
  if (upload && !upload._toolhubBound) {
    upload.addEventListener('change', async (ev) => {
      const files = (ev.target && ev.target.files) ? Array.from(ev.target.files) : [];
      try {
        const res = await mediaManagerUploadFilesBatch(files);
        const up = res && Number.isFinite(res.uploaded) ? res.uploaded : 0;
        const dup = res && Number.isFinite(res.duplicated) ? res.duplicated : 0;
        const fail = res && Number.isFinite(res.failed) ? res.failed : 0;
        const msgParts = [];
        if (up) msgParts.push(`Uploaded ${up}`);
        if (dup) msgParts.push(`Skipped ${dup} duplicate${dup === 1 ? '' : 's'}`);
        if (fail) msgParts.push(`${fail} failed`);
        const msg = msgParts.length ? msgParts.join(' • ') : 'No files uploaded.';
        try { showToast(msg, fail ? 'warning' : 'success'); } catch { }
      } catch (err) {
        try { showToast(`Media upload failed: ${err?.message || err}`, 'warning'); } catch { }
      }
      try { ev.target.value = ''; } catch { }
      try { await mediaManagerRefreshList({ force: true }); } catch { }
    });
    upload._toolhubBound = true;
  }
  if (refresh && !refresh._toolhubBound) {
    refresh.addEventListener('click', () => mediaManagerRefreshList({ force: true }));
    refresh._toolhubBound = true;
  }
  if (delSelected && !delSelected._toolhubBound) {
    delSelected.addEventListener('click', async () => {
      if (mediaManagerRemoteBlocked()) return;
      const keys = mediaManagerGetSelectedKeys();
      if (!keys.length) return;
      if (!confirm(`Delete ${keys.length} selected audio file${keys.length === 1 ? '' : 's'}?`)) return;
      delSelected.disabled = true;
      try {
        const res = await mediaManagerDeleteItems(keys);
        const del = res && Number.isFinite(res.deleted) ? res.deleted : 0;
        const fail = res && Number.isFinite(res.failed) ? res.failed : 0;
        try { showToast(fail ? `Deleted ${del}. ${fail} failed.` : `Deleted ${del} audio file${del === 1 ? '' : 's'}.`, fail ? 'warning' : 'success'); } catch { }
      } catch (err) {
        try { showToast(`Delete failed: ${err?.message || err}`, 'warning'); } catch { }
      }
      try { await mediaManagerRefreshList({ force: true }); } catch { }
    });
    delSelected._toolhubBound = true;
  }
  if (selectAll && !selectAll._toolhubBound) {
    selectAll.addEventListener('change', () => {
      const listEl = document.getElementById('settings-media-list');
      if (!listEl) return;
      const desired = !!selectAll.checked;
      listEl.querySelectorAll('input.media-select').forEach(cb => {
        try { cb.checked = desired; } catch { }
      });
      mediaManagerUpdateBatchDeleteButton();
    });
    selectAll._toolhubBound = true;
  }
  if (list && !list._toolhubBound) {
    list.addEventListener('click', async (ev) => {
      const row = ev.target && ev.target.closest ? ev.target.closest('[data-media-key]') : null;
      const key = row ? row.getAttribute('data-media-key') : '';
      const actionBtn = ev.target && ev.target.closest ? ev.target.closest('[data-action]') : null;
      const action = actionBtn ? actionBtn.getAttribute('data-action') : '';
      if (!key || !action) return;
      if (action === 'media-preview') {
        if (mediaManagerRemoteBlocked()) return;
        try {
          if (actionBtn && actionBtn.dataset.playing === '1') {
            try { if (typeof window.ctfdStopActivePlayback === 'function') window.ctfdStopActivePlayback(); } catch { }
            appStopActivePlayback();
            return;
          }
          try { if (typeof window.ctfdStopActivePlayback === 'function') window.ctfdStopActivePlayback(); } catch { }
          appStopActivePlayback();
          const pid = mediaManagerReadCurrentPid();
          if (!pid) return;
          let entry = (getProjectAudio(pid) || {})[key];
          let sound = audioNormalizeSingleSound(entry);
          if (!sound || !sound.dataUrl) {
            const fetched = await http('GET', `/api/projects/${encodeURIComponent(pid)}/audio_entry?key=${encodeURIComponent(key)}`);
            entry = fetched && fetched.entry ? fetched.entry : null;
            sound = audioNormalizeSingleSound(entry);
            if (entry) mediaManagerUpsertCacheEntry(pid, key, entry);
          }
          if (!sound || !sound.dataUrl) return;

          APP_ACTIVE_PLAY_BUTTON = actionBtn;
          const token = String(++APP_ACTIVE_PLAY_TOKEN);
          if (actionBtn) actionBtn.dataset.playToken = token;
          appSetPlayStopButtonState(actionBtn, true);

          const audio = new Audio(sound.dataUrl);
          let settled = false;
          const cleanup = () => {
            try { audio.removeEventListener('ended', onEnded); } catch { }
            try { audio.removeEventListener('error', onError); } catch { }
            try { audio.removeEventListener('abort', onError); } catch { }
          };
          const finish = () => {
            if (settled) return;
            settled = true;
            cleanup();
            if (APP_ACTIVE_AUDIO_PLAYBACK && APP_ACTIVE_AUDIO_PLAYBACK._audio === audio) APP_ACTIVE_AUDIO_PLAYBACK = null;
            if (APP_ACTIVE_PLAY_BUTTON === actionBtn && (!actionBtn || actionBtn.dataset.playToken === token)) {
              try { appSetPlayStopButtonState(actionBtn, false); } catch { }
              if (APP_ACTIVE_PLAY_BUTTON === actionBtn) APP_ACTIVE_PLAY_BUTTON = null;
            }
          };
          const onEnded = () => finish();
          const onError = () => finish();
          audio.addEventListener('ended', onEnded);
          audio.addEventListener('error', onError);
          audio.addEventListener('abort', onError);
          APP_ACTIVE_AUDIO_PLAYBACK = {
            _audio: audio,
            stop: () => {
              if (settled) return;
              try { audio.pause(); } catch { }
              try { audio.currentTime = 0; } catch { }
              finish();
            }
          };
          audio.play().catch(() => finish());
        } catch {
          try {
            if (actionBtn) appSetPlayStopButtonState(actionBtn, false);
            if (APP_ACTIVE_PLAY_BUTTON === actionBtn) APP_ACTIVE_PLAY_BUTTON = null;
          } catch { }
        }
        return;
      }
    });
    list.addEventListener('change', (ev) => {
      const cb = ev.target;
      if (!cb || !cb.classList || !cb.classList.contains('media-select')) return;
      mediaManagerUpdateBatchDeleteButton();
      try {
        const all = document.getElementById('settings-media-select-all');
        if (all) {
          const listEl = document.getElementById('settings-media-list');
          const boxes = listEl ? Array.from(listEl.querySelectorAll('input.media-select')) : [];
          const allChecked = boxes.length ? boxes.every(b => !!b.checked) : false;
          all.checked = allChecked;
        }
      } catch { }
    });
    list._toolhubBound = true;
  }
}
function settingsAudioValidSounds(entry) {
  const list = Array.isArray(entry && entry.sounds) ? entry.sounds : [];
  return list.filter(sound => {
    if (!sound) return false;
    const dataUrl = typeof sound.dataUrl === 'string' ? sound.dataUrl : '';
    return dataUrl.startsWith('data:');
  });
}
function settingsAudioValidTemplates(entry, key) {
  const list = Array.isArray(entry && entry.speakTemplates) ? entry.speakTemplates : [];
  return list.map(t => {
    if (typeof t === 'string') return settingsAudioNormalizeTemplateText(t, key).trim();
    if (t != null) return settingsAudioNormalizeTemplateText(t, key).trim();
    return '';
  }).filter(Boolean);
}
function describeAudioEntry(entry) {
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
function settingsAudioDefaultEnabled(key) {
  const cfg = SETTINGS_AUDIO_FIELDS[key];
  if (!cfg || cfg.defaultEnabled === undefined) return true;
  return !!cfg.defaultEnabled;
}
function settingsAudioDefaultSpeak(key) {
  const cfg = SETTINGS_AUDIO_FIELDS[key];
  if (!cfg || cfg.defaultSpeak === undefined) return false;
  return !!cfg.defaultSpeak;
}
function settingsAudioDefaultSpeakTemplate(key) {
  const cfg = SETTINGS_AUDIO_FIELDS[key];
  if (!cfg || cfg.defaultSpeakTemplate === undefined) return '';
  return String(cfg.defaultSpeakTemplate || '') || '';
}
function settingsAudioLegacyDefaultSpeakBefore(key) {
  const cfg = SETTINGS_AUDIO_FIELDS[key];
  if (!cfg || cfg.legacyDefaultSpeakBefore === undefined) return '';
  return String(cfg.legacyDefaultSpeakBefore || '') || '';
}
function settingsAudioLegacyDefaultSpeakAfter(key) {
  const cfg = SETTINGS_AUDIO_FIELDS[key];
  if (!cfg || cfg.legacyDefaultSpeakAfter === undefined) return '';
  return String(cfg.legacyDefaultSpeakAfter || '') || '';
}
function settingsAudioNormalizeTemplateText(value, key) {
  const text = String(value || '');
  const eventKey = String(key || '').trim();
  if (eventKey === 'ctfdFirstUser') {
    return text.replace(/\{\{\s*leader\s*\}\}/g, '{{user_first}}');
  }
  if (eventKey === 'ctfdFirstTeam') {
    return text.replace(/\{\{\s*leader\s*\}\}/g, '{{first_team}}');
  }
  if (eventKey === 'ctfdFirstScore') {
    return text.replace(/\{\{\s*leader\s*\}\}/g, '{{event_user}}{{event_team}}');
  }
  if (eventKey === 'ctfdFirstCategoryUser') {
    return text.replace(/\{\{\s*leader\s*\}\}/g, '{{event_user}}');
  }
  if (eventKey === 'ctfdFirstCategoryTeam') {
    return text.replace(/\{\{\s*leader\s*\}\}/g, '{{event_team}}');
  }
  return text;
}
function settingsAudioNormalizeLegacyTemplate(entry, key) {
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
    entry.speakTemplate = settingsAudioNormalizeTemplateText(combined, key);
  }
  if (typeof entry.speakTemplate === 'string') entry.speakTemplate = settingsAudioNormalizeTemplateText(entry.speakTemplate, key);
  delete entry.speakBefore;
  delete entry.speakAfter;
}
function settingsAudioClampNumeric(raw, field) {
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
function settingsAudioApplyNumericFields(entry, key) {
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
function settingsAudioEnsureEntry(key) {
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
  entry.speakTemplates = settingsAudioValidTemplates(entry, key);
  if (!entry.speakTemplates.length && defTemplate) entry.speakTemplates = [String(defTemplate)];
  delete entry.speakTemplate;
  settingsAudioApplyNumericFields(entry, key);
  return entry;
}
function settingsModalUpdateAudioUi(key) {
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
  const templates = settingsAudioValidTemplates(entry, key);
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
function settingsModalUpdateAllAudio() { Object.keys(SETTINGS_AUDIO_FIELDS).forEach(settingsModalUpdateAudioUi); }
async function settingsModalResetFromStorage() {
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
  const hackerThemeToggle = document.getElementById('settings-hacker-theme');
  if (defCfg) defCfg.checked = !!settings.defaultCfgExpanded;
  if (defVm) defVm.checked = !!settings.defaultVmExpanded;
  if (defMat) defMat.checked = !!settings.defaultMatExpanded;
  if (hackerThemeToggle) hackerThemeToggle.checked = settings.hackerTheme !== false;
  try {
    const remoteToggle = document.getElementById('settings-run-remote');
    if (remoteToggle) {
      let checked = false;
      try { checked = !!(window.shell && shell.isRemote && shell.isRemote()); } catch { }
      if (!checked) checked = (settings && settings.runMode === 'remote');
      remoteToggle.checked = !!checked;
    }
  } catch { }
  try { if (window.shell && shell.applyRemoteModeUI) shell.applyRemoteModeUI(); } catch { }
  const currentPid = (window.shell && shell.getCurrentProjectId) ? String(shell.getCurrentProjectId() || '').trim() : '';
  let projectAudio = {};
  let audioLoaded = false;
  let loadError = null;
  if (currentPid) {
    try {
      projectAudio = await loadProjectAudio(currentPid);
      audioLoaded = true;
    } catch (err) {
      loadError = err;
    }
  }
  if (!audioLoaded) {
    if (currentPid && settings && settings.projectAudio && typeof settings.projectAudio === 'object' && settings.projectAudio[currentPid]) {
      projectAudio = cloneSettingsAudio(settings.projectAudio[currentPid]);
    } else {
      projectAudio = cloneSettingsAudio(settings.audio);
    }
  }
  _settingsAudioWorking = {};
  Object.keys(SETTINGS_AUDIO_FIELDS).forEach((key) => {
    const saved = projectAudio && typeof projectAudio[key] === 'object' ? cloneAudioEntry(projectAudio[key]) : {};
    if (saved && saved.enabled === undefined) saved.enabled = settingsAudioDefaultEnabled(key);
    if (saved && saved.speak === undefined) saved.speak = settingsAudioDefaultSpeak(key);
    settingsAudioNormalizeLegacyTemplate(saved, key);
    _settingsAudioWorking[key] = saved && typeof saved === 'object' ? saved : {};
    settingsAudioEnsureEntry(key);
  });
  settingsModalUpdateAllAudio();
  if (loadError && currentPid) {
    try { showToast('Project audio could not be loaded. Using local copy.', 'warning'); } catch { }
  }
}
function settingsModalHandleFile(key, file) {
  if (!file) return;
  if (file.size > SETTINGS_AUDIO_MAX_BYTES) {
    alert('Audio file too large. Limit is 10 MB per sound.');
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
function settingsModalPreviewAudio(key, soundIndex, sourceBtn) {
  try { if (window.shell && shell.isRemote && shell.isRemote()) return; } catch { }
  let token = '';
  const revert = () => {
    try {
      if (!sourceBtn) return;
      appSetPlayStopButtonState(sourceBtn, false);
      if (APP_ACTIVE_PLAY_BUTTON === sourceBtn) APP_ACTIVE_PLAY_BUTTON = null;
    } catch { }
  };
  try {
    if (sourceBtn && sourceBtn.dataset && sourceBtn.dataset.playing === '1') {
      try { if (typeof window.ctfdStopActivePlayback === 'function') window.ctfdStopActivePlayback(); } catch { }
      appStopActivePlayback();
      return;
    }
    try { if (typeof window.ctfdStopActivePlayback === 'function') window.ctfdStopActivePlayback(); } catch { }
    appStopActivePlayback();

    const entry = settingsAudioEnsureEntry(key);
    if (!entry) return;
    const speechSupported = settingsSpeechSupported();
    const wantsSpeech = speechSupported && !!entry.speak;
    const speechText = wantsSpeech ? settingsModalBuildPreviewSpeechText(key, entry) : '';
    const hasSpeech = !!speechText;
    const sounds = settingsAudioValidSounds(entry);
    const idx = Number.isFinite(soundIndex) ? Number(soundIndex) : NaN;
    const clip = Number.isFinite(idx) && idx >= 0 && idx < sounds.length ? sounds[idx] : (sounds[0] || null);

    APP_ACTIVE_PLAY_BUTTON = sourceBtn || null;
    token = String(++APP_ACTIVE_PLAY_TOKEN);
    if (sourceBtn) sourceBtn.dataset.playToken = token;
    appSetPlayStopButtonState(sourceBtn, true);
    let fallbackTimer = null;
    let speechTriggered = false;
    let cancelled = false;
    let previewAudioEl = null;
    const isCancelled = () => cancelled || String(APP_ACTIVE_PLAY_TOKEN) !== token;
    const triggerSpeech = () => {
      if (isCancelled()) return;
      if (!hasSpeech || speechTriggered) return;
      speechTriggered = true;
      if (fallbackTimer) { clearTimeout(fallbackTimer); fallbackTimer = null; }

      // Never overlap audio + speech: pause the current preview audio (if any) without
      // ending the session / resetting the button state.
      try {
        if (previewAudioEl) {
          previewAudioEl.pause();
          previewAudioEl.currentTime = 0;
        }
      } catch { }
      try {
        if (APP_ACTIVE_AUDIO_PLAYBACK && APP_ACTIVE_AUDIO_PLAYBACK._audio === previewAudioEl) APP_ACTIVE_AUDIO_PLAYBACK = null;
      } catch { }

      const p = settingsModalSpeakPreview(speechText);
      if (p && typeof p.finally === 'function') {
        p.finally(() => finishSession());
      } else {
        // Best-effort fallback: clear button after a short delay.
        setTimeout(() => finishSession(), 1500);
      }
    };

    const finishSession = () => {
      try {
        cancelled = true;
        if (fallbackTimer) { clearTimeout(fallbackTimer); fallbackTimer = null; }
      } catch { }
      if (APP_ACTIVE_PLAY_BUTTON === sourceBtn && (!sourceBtn || sourceBtn.dataset.playToken === token)) {
        try { appSetPlayStopButtonState(sourceBtn, false); } catch { }
        if (APP_ACTIVE_PLAY_BUTTON === sourceBtn) APP_ACTIVE_PLAY_BUTTON = null;
      }
    };
    const scheduleFallback = (audio) => {
      if (isCancelled()) return;
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
      previewAudioEl = audio;
      const stop = () => {
        cancelled = true;
        try { if (fallbackTimer) { clearTimeout(fallbackTimer); fallbackTimer = null; } } catch { }
        try {
          audio.pause();
          audio.currentTime = 0;
        } catch { }
        try { finishSession(); } catch { }
      };
      APP_ACTIVE_AUDIO_PLAYBACK = { _audio: audio, stop };
      if (hasSpeech) {
        scheduleFallback(audio);
        audio.addEventListener('loadedmetadata', () => scheduleFallback(audio), { once: true });
        audio.addEventListener('ended', triggerSpeech, { once: true });
        audio.addEventListener('error', triggerSpeech, { once: true });
        audio.addEventListener('abort', triggerSpeech, { once: true });
      }
      if (!hasSpeech) {
        audio.addEventListener('ended', finishSession, { once: true });
        audio.addEventListener('error', finishSession, { once: true });
        audio.addEventListener('abort', finishSession, { once: true });
      }
      audio.play().catch(() => (hasSpeech ? triggerSpeech() : finishSession()));
    } else {
      if (hasSpeech) triggerSpeech();
      else finishSession();
    }
  } catch {
    revert();
  }
}
function settingsModalClearAudio(key) {
  const entry = settingsAudioEnsureEntry(key);
  entry.sounds = [];
  settingsModalUpdateAudioUi(key);
}
function settingsModalRemoveSound(key, index) {
  const entry = settingsAudioEnsureEntry(key);
  if (!Array.isArray(entry.sounds)) entry.sounds = [];
  const idx = Number(index);
  if (!Number.isFinite(idx) || idx < 0 || idx >= entry.sounds.length) return;
  entry.sounds.splice(idx, 1);
  settingsModalUpdateAudioUi(key);
}
function settingsModalAddTemplate(key) {
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
function settingsModalRemoveTemplate(key, index) {
  const entry = settingsAudioEnsureEntry(key);
  if (!Array.isArray(entry.speakTemplates)) entry.speakTemplates = [];
  const idx = Number(index);
  if (!Number.isFinite(idx) || idx < 0 || idx >= entry.speakTemplates.length) return;
  entry.speakTemplates.splice(idx, 1);
  settingsModalUpdateAudioUi(key);
}
function settingsModalSetTemplate(key, index, value) {
  const entry = settingsAudioEnsureEntry(key);
  if (!Array.isArray(entry.speakTemplates)) entry.speakTemplates = [];
  const idx = Number(index);
  if (!Number.isFinite(idx) || idx < 0 || idx >= entry.speakTemplates.length) return;
  entry.speakTemplates[idx] = value;
}
function wireSettingsAudioControls() {
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
      input.addEventListener('change', (ev) => {
        const file = ev.target && ev.target.files && ev.target.files[0];
        settingsModalHandleFile(key, file || null);
        try { ev.target.value = ''; } catch { }
      });
      input._toolhubBound = true;
    }
    numericFields.forEach(field => {
      if (!field || !field.inputId) return;
      const numInput = document.getElementById(field.inputId);
      if (!numInput || numInput._toolhubBound) return;
      const commitValue = () => {
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
      preview.addEventListener('click', (ev) => settingsModalPreviewAudio(key, undefined, ev.currentTarget));
      preview._toolhubBound = true;
    }
    if (clear && !clear._toolhubBound) {
      clear.addEventListener('click', () => settingsModalClearAudio(key));
      clear._toolhubBound = true;
    }
    if (toggle && !toggle._toolhubBound) {
      toggle.addEventListener('change', () => {
        const entry = settingsAudioEnsureEntry(key);
        entry.enabled = !!toggle.checked;
        settingsModalUpdateAudioUi(key);
      });
      toggle._toolhubBound = true;
    }
    if (speakToggle && !speakToggle._toolhubBound) {
      speakToggle.addEventListener('change', () => {
        const entry = settingsAudioEnsureEntry(key);
        entry.speak = !!speakToggle.checked;
        settingsModalUpdateAudioUi(key);
      });
      speakToggle._toolhubBound = true;
    }
    if (templateInput && !templateInput._toolhubBound) {
      const refreshAddState = () => {
        if (templateAdd) {
          templateAdd.disabled = templateInput.disabled || !templateInput.value.trim();
        }
      };
      templateInput.addEventListener('input', refreshAddState);
      templateInput.addEventListener('blur', refreshAddState);
      templateInput.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') {
          ev.preventDefault();
          settingsModalAddTemplate(key);
        }
      });
      refreshAddState();
      templateInput._toolhubBound = true;
    }
    if (templateAdd && !templateAdd._toolhubBound) {
      templateAdd.addEventListener('click', () => settingsModalAddTemplate(key));
      templateAdd._toolhubBound = true;
    }
    if (templateList && !templateList._toolhubBound) {
      templateList.addEventListener('input', (ev) => {
        const inputEl = ev.target && ev.target.closest('input[data-template-index]');
        if (!inputEl) return;
        const idx = Number(inputEl.getAttribute('data-template-index'));
        settingsModalSetTemplate(key, idx, inputEl.value);
      });
      templateList.addEventListener('blur', (ev) => {
        const inputEl = ev.target && ev.target.closest('input[data-template-index]');
        if (!inputEl) return;
        const idx = Number(inputEl.getAttribute('data-template-index'));
        const trimmed = inputEl.value.trim();
        settingsModalSetTemplate(key, idx, trimmed);
        inputEl.value = trimmed;
      }, true);
      templateList.addEventListener('click', (ev) => {
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
      audioList.addEventListener('click', (ev) => {
        const previewBtn = ev.target && ev.target.closest('[data-action="preview-sound"]');
        if (previewBtn) {
          const row = previewBtn.closest('[data-sound-index]');
          const rawIdx = row ? row.getAttribute('data-sound-index') : null;
          const idx = rawIdx != null ? Number(rawIdx) : NaN;
          settingsModalPreviewAudio(key, Number.isFinite(idx) ? idx : undefined, previewBtn);
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
function wireSettingsModal() {
  const modal = document.getElementById('settingsModal');
  if (!modal || modal._toolhubBound) return;
  modal._toolhubBound = true;
  // Legacy notifications/audio editor removed; Media Manager owns uploads.
  wireSettingsTtsControls();
  wireMediaManagerControls();
  modal.addEventListener('show.bs.modal', settingsModalResetFromStorage);
  modal.addEventListener('show.bs.modal', () => { try { mediaManagerRefreshList({ force: true }); } catch { } });
  modal.addEventListener('hidden.bs.modal', settingsModalResetFromStorage);
  settingsModalResetFromStorage();
}
window.prepareSettingsModal = wireSettingsModal;
async function saveSettingsInternal() {
  const settings = readSettings();
  const defCfg = document.getElementById('def-cfg');
  const defVm = document.getElementById('def-vm');
  const defMat = document.getElementById('def-mat');
  const hackerThemeToggle = document.getElementById('settings-hacker-theme');
  if (defCfg) settings.defaultCfgExpanded = !!defCfg.checked;
  if (defVm) settings.defaultVmExpanded = !!defVm.checked;
  if (defMat) settings.defaultMatExpanded = !!defMat.checked;
  if (hackerThemeToggle) settings.hackerTheme = !!hackerThemeToggle.checked;
  let remoteMode = false;
  let runModeSavedOk = true;
  let runModeSaveStatus = 0;
  try {
    const remoteToggle = document.getElementById('settings-run-remote');
    remoteMode = !!remoteToggle?.checked;
    // Persist via shell (localStorage + server). Don't pin to per-browser settings.
    try {
      if (window.shell && shell.setRunModeAsync) {
        const res = await shell.setRunModeAsync(remoteMode ? 'remote' : 'local');
        runModeSavedOk = !!res?.ok;
        runModeSaveStatus = Number(res?.status || 0);
      } else if (window.shell && shell.setRunMode) {
        shell.setRunMode(remoteMode ? 'remote' : 'local');
        runModeSavedOk = true;
      }
    } catch { runModeSavedOk = false; }
    try { delete settings.runMode; } catch { }
  } catch { }
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
  writeSettings(settings);
  // run mode already persisted above
  try { document.dispatchEvent(new CustomEvent('settings-changed', { detail: { settings } })); } catch { }
  let resetFailed = false;
  try {
    await settingsModalResetFromStorage();
  } catch (err) {
    resetFailed = true;
    try { (window.shell && shell.logWarn) ? shell.logWarn(`Settings: failed to refresh UI after save: ${err?.message || err}`) : console.warn('Settings: failed to refresh settings UI after save', err); } catch { }
  }
  let toastMessage = 'Settings saved.';
  let toastLevel = 'success';
  if (!runModeSavedOk) {
    if (runModeSaveStatus === 404) {
      toastMessage = 'Settings saved locally, but this server does not support Remote mode persistence yet (404 /api/runtime). Rebuild/restart the containers.';
    } else if (runModeSaveStatus) {
      toastMessage = `Settings saved locally, but failed to persist Remote mode on the server (HTTP ${runModeSaveStatus}).`;
    } else {
      toastMessage = 'Settings saved locally, but failed to persist Remote mode on the server.';
    }
    toastLevel = 'warning';
  }
  if (resetFailed) {
    toastMessage = 'Settings saved, but the UI may be out of date. Please reload.';
    toastLevel = 'warning';
  }
  try { showToast(toastMessage, toastLevel); } catch { }
  const modal = document.getElementById('settingsModal');
  if (modal && window.bootstrap && window.bootstrap.Modal) {
    // Ensure remote-mode UI changes apply immediately after the settings modal closes.
    try {
      modal.addEventListener('hidden.bs.modal', () => {
        try { if (window.shell && shell.applyRemoteModeUI) shell.applyRemoteModeUI(); } catch { }
      }, { once: true });
    } catch { }
    const inst = bootstrap.Modal.getInstance(modal) || null;
    if (inst) inst.hide();
  }
}
window.saveSettings = saveSettingsInternal;
window.importProject = importProject;
window.openStartCommandsManager = openStartCommandsManager;
window.addEventListener('DOMContentLoaded', wireStartCommandsModal);
window.addEventListener('DOMContentLoaded', wireStoredCommandsModal);

async function loadProjects() {
  const container = document.getElementById('projects');
  container.innerHTML = '<div class="text-muted">Loading...</div>';
  try {
    try { (window.shell && shell.logInfo) ? shell.logInfo('Config: loading projects…') : console.log('Config: loading projects…'); } catch { }
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
    try { (window.shell && shell.logSuccess) ? shell.logSuccess(`Config: loaded ${(data.projects || []).length} project(s)`) : console.log('Config: projects loaded'); } catch { }
    // Ensure any dynamically rendered controls get remote-mode disabling.
    try { if (window.shell && shell.applyRemoteModeUI) shell.applyRemoteModeUI(container); } catch { }
  } catch (e) {
    container.innerHTML = `<div class="text-danger">Error: ${e.message}</div>`;
    try { (window.shell && shell.logError) ? shell.logError('Config: load projects failed: ' + e.message) : console.error('Config load failed:', e); } catch { }
  }
}

// --- New Scenario Wizard State Machine ---
let currentWizardStep = 0;
const totalWizardSteps = 5;
let wizFetchedTemplates = [];
let wizSelectedTemplates = [];
let wizTemplateCreds = {};
let wizActiveTemplateCredsVmid = '';

function wizardGetTemplateCreds(vmid) {
  const key = String(vmid || '').trim();
  if (!key) return { username: '', password: '' };
  const creds = wizTemplateCreds[key];
  if (!creds || typeof creds !== 'object') return { username: '', password: '' };
  return {
    username: typeof creds.username === 'string' ? creds.username : '',
    password: typeof creds.password === 'string' ? creds.password : ''
  };
}

function wizardHasTemplateCreds(vmid) {
  const creds = wizardGetTemplateCreds(vmid);
  return !!(creds.username && creds.password);
}

function wizardRefreshTemplateCredsButton(vmid) {
  const button = document.querySelector(`[data-wiz-template-creds="${String(vmid || '').replace(/"/g, '&quot;')}"]`);
  if (!button) return;
  const hasCreds = wizardHasTemplateCreds(vmid);
  button.textContent = hasCreds ? 'Stored' : 'Specify';
  button.classList.toggle('btn-outline-success', hasCreds);
  button.classList.toggle('btn-outline-secondary', !hasCreds);
  button.setAttribute('aria-label', hasCreds ? 'Edit stored VM credentials' : 'Specify VM credentials');
  button.title = hasCreds ? 'Edit stored VM credentials' : 'Specify VM credentials';
}

window.openWizardTemplateCreds = function(vmid, templateName) {
  const key = String(vmid || '').trim();
  const modalEl = document.getElementById('wizardTemplateCredsModal');
  if (!key || !modalEl) return;
  wizActiveTemplateCredsVmid = key;
  const titleEl = document.getElementById('wiz-template-creds-name');
  if (titleEl) titleEl.textContent = templateName || key;
  const creds = wizardGetTemplateCreds(key);
  const userEl = document.getElementById('wiz-template-creds-user');
  const passEl = document.getElementById('wiz-template-creds-pass');
  if (userEl) userEl.value = creds.username;
  if (passEl) passEl.value = creds.password;
  if (window.bootstrap && window.bootstrap.Modal) {
    window.bootstrap.Modal.getOrCreateInstance(modalEl).show();
  }
};

window.saveWizardTemplateCreds = function() {
  const key = String(wizActiveTemplateCredsVmid || '').trim();
  const modalEl = document.getElementById('wizardTemplateCredsModal');
  if (!key || !modalEl) return;
  const userEl = document.getElementById('wiz-template-creds-user');
  const passEl = document.getElementById('wiz-template-creds-pass');
  const username = userEl ? userEl.value.trim() : '';
  const password = passEl ? passEl.value : '';
  if ((username && !password) || (!username && password)) {
    return showToast('Enter both VM username and password, or leave both blank to clear them.', 'warning');
  }
  if (username && password) {
    wizTemplateCreds[key] = { username, password };
  } else {
    delete wizTemplateCreds[key];
  }
  wizardRefreshTemplateCredsButton(key);
  const selected = (wizSelectedTemplates || []).find(item => String(item.vmid) === key);
  if (selected) {
    selected.vm_user = username;
    selected.vm_pass = password;
  }
  if (window.bootstrap && window.bootstrap.Modal) {
    const modal = window.bootstrap.Modal.getInstance(modalEl);
    if (modal) modal.hide();
  }
};

window.wizToggleVmActions = function() {
  const isCreate = document.getElementById('wiz-act-vm-create')?.checked;
  const deps = document.getElementById('wiz-act-vm-deps');
  if (deps) deps.classList.toggle('d-none', !isCreate);
};

window.toggleWizCapMode = function() {
  const mode = document.querySelector('input[name="wiz-cap-mode"]:checked')?.value || 'num';
  const numCont = document.getElementById('wiz-users');
  const csvCont = document.getElementById('wiz-cap-csv-container');
  if (numCont) numCont.classList.toggle('d-none', mode !== 'num');
  if (csvCont) csvCont.classList.toggle('d-none', mode !== 'csv');
};

window.checkWizCsvFile = async function() {
  const fileIn = document.getElementById('wiz-csv-file');
  const feedback = document.getElementById('wiz-csv-feedback');
  if (!fileIn || !feedback) return;

  if (!fileIn.files || fileIn.files.length === 0) {
    feedback.innerHTML = 'CSV should not have a header row. Format: username,password';
    feedback.className = 'text-muted d-block mt-1';
    return;
  }

  try {
    const fileContent = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = e => resolve(e.target.result);
      reader.onerror = e => reject(e);
      reader.readAsText(fileIn.files[0]);
    });
    
    let validCount = 0;
    const lines = fileContent.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;
        const parts = line.split(',');
        let a = (parts[0] || '').trim();
        let b = (parts[1] || '').trim();
        
        const isHeader = (x, y) => {
          if (!y) return false;
          return x.toLowerCase() === 'username' || x.toLowerCase() === 'user' || y.toLowerCase() === 'password' || y.toLowerCase() === 'pass';
        };
        if (i === 0 && isHeader(a, b)) continue; // skip header
        if (!a && !b) continue;
        validCount++;
    }

    if (validCount > 0) {
      feedback.innerHTML = `<i class="bi bi-check-circle text-success pe-1"></i> Successfully read <strong>${validCount}</strong> user${validCount === 1 ? '' : 's'}.`;
      feedback.className = 'text-success d-block mt-1';
    } else {
      feedback.innerHTML = `<i class="bi bi-exclamation-triangle-fill text-warning pe-1"></i> No pairs found.`;
      feedback.className = 'text-warning d-block mt-1';
    }
  } catch (e) {
    feedback.innerHTML = `<i class="bi bi-exclamation-triangle-fill text-danger pe-1"></i> Failed to read.`;
    feedback.className = 'text-danger d-block mt-1';
  }
};

// ═══════════════════════════════════════════════════════════════
// Wizard Step 4 — Interactive Network Topology Graph
// ═══════════════════════════════════════════════════════════════
(function() {
  // Palette of distinct colors for network adapters
  const ADAPTER_COLORS = [
    '#0d6efd','#198754','#dc3545','#fd7e14','#6f42c1',
    '#20c997','#d63384','#0dcaf0','#ffc107','#6c757d'
  ];

  const NODE_W = 164, NODE_H = 78, NODE_R = 18;

  let nodes    = [];   // { id, vmid, name, finalName, user_accessible, x, y, el }
  let links    = [];   // { id, a, b, adapter, color, el }
  let adapters = [];   // { name, color }
  let dragSrc  = null;
  let selectedNode = null;
  let adapterCounter = 0;
  let svgEl, linksG, nodesG, dragLine, legendEl;
  let activePopover = null;

  function svgNS() { return 'http://www.w3.org/2000/svg'; }

  function getAdapterForPair(aId, bId) {
    return links.find(l => (l.a === aId && l.b === bId) || (l.a === bId && l.b === aId)) || null;
  }

  function getNodeAdapters(nodeId) {
    // Returns adapters sorted by their iface number on this node
    const ifaceMap = {};
    for (const l of links) {
      if (l.a === nodeId) ifaceMap[l.ifaceA] = l.adapter;
      if (l.b === nodeId) ifaceMap[l.ifaceB] = l.adapter;
    }
    return Object.keys(ifaceMap).map(Number).sort((a,b) => a-b).map(i => ifaceMap[i]);
  }

  function getNextIface(nodeId, excludeLinkId) {
    const used = new Set();
    for (const l of links) {
      if (l.id === excludeLinkId) continue;
      if (l.a === nodeId) used.add(l.ifaceA);
      if (l.b === nodeId) used.add(l.ifaceB);
    }
    let n = 0; while (used.has(n)) n++;
    return n;
  }

  function adapterSuffixFromOrdinal(value) {
    let n = Number(value);
    if (!Number.isFinite(n) || n < 0) return 'A';
    let out = '';
    do {
      out = String.fromCharCode(65 + (n % 26)) + out;
      n = Math.floor(n / 26) - 1;
    } while (n >= 0);
    return out;
  }

  function adapterOrdinalFromSuffix(value) {
    const suffix = String(value || '').trim().toUpperCase();
    if (!/^[A-Z]+$/.test(suffix)) return -1;
    let out = 0;
    for (let i = 0; i < suffix.length; i += 1) {
      out = (out * 26) + (suffix.charCodeAt(i) - 64);
    }
    return out - 1;
  }

  function getAdapterOrdinal(adapter) {
    const direct = Number(adapter && adapter.ordinal);
    if (Number.isFinite(direct) && direct >= 0) return direct;
    const suffixOrdinal = adapterOrdinalFromSuffix(adapter && adapter.suffix);
    if (suffixOrdinal >= 0) return suffixOrdinal;
    const numericMatch = String(adapter && adapter.name || '').match(/(\d+)$/);
    if (numericMatch) {
      const numeric = Number(numericMatch[1]);
      if (Number.isFinite(numeric) && numeric >= 0) return numeric;
    }
    const alphaMatch = String(adapter && adapter.name || '').match(/([A-Z]+)$/);
    if (alphaMatch) return adapterOrdinalFromSuffix(alphaMatch[1]);
    return -1;
  }

  function getAdapterSuffix(adapter) {
    const explicit = String(adapter && adapter.suffix || '').trim().toUpperCase();
    if (/^[A-Z]+$/.test(explicit)) return explicit;
    const ordinal = getAdapterOrdinal(adapter);
    return ordinal >= 0 ? adapterSuffixFromOrdinal(ordinal) : '';
  }

  function getWizardAdapterBase() {
    const input = document.getElementById('wiz-adapter-base');
    const sanitized = String(input && input.value || 'net').replace(/[^A-Za-z]/g, '').trim();
    return sanitized || 'net';
  }

  // Returns the point on a VM's rect edge in the direction toward (tx,ty)
  function rectEdgePoint(cx, cy, tx, ty) {
    const dx = tx - cx, dy = ty - cy;
    if (!dx && !dy) return { x: cx, y: cy };
    const hw = NODE_W / 2 + 2, hh = NODE_H / 2 + 2;
    const scaleX = dx ? hw / Math.abs(dx) : Infinity;
    const scaleY = dy ? hh / Math.abs(dy) : Infinity;
    const s = Math.min(scaleX, scaleY);
    return { x: Math.round(cx + dx * s), y: Math.round(cy + dy * s) };
  }

  function allocateAdapter() {
    // Find the lowest free adapter suffix.
    const usedNums = new Set(adapters.map(a => getAdapterOrdinal(a)).filter(n => n >= 0));
    let n = 0;
    while (usedNums.has(n)) n++;
    adapterCounter = n + 1;
    const suffix = adapterSuffixFromOrdinal(n);
    const name = getWizardAdapterBase() + suffix;
    const color = ADAPTER_COLORS[n % ADAPTER_COLORS.length];
    const a = { name, color, suffix, ordinal: n };
    adapters.push(a);
    return a;
  }

  function pruneAdapter(adapterName) {
    // If no remaining links reference this adapter, remove it from the list
    const stillUsed = links.some(l => l.adapter === adapterName);
    if (!stillUsed) {
      adapters = adapters.filter(a => a.name !== adapterName);
      // Reset counter to lowest free suffix so next alloc reuses the gap.
      const usedNums = new Set(adapters.map(a => getAdapterOrdinal(a)).filter(n => n >= 0));
      let n = 0;
      while (usedNums.has(n)) n++;
      adapterCounter = n;
    }
  }

  function renderLegend() {
    if (!legendEl) return;
    legendEl.innerHTML = adapters.map(a =>
      `<span class="me-2 d-inline-flex align-items-center gap-1">
         <span style="display:inline-block;width:12px;height:12px;border-radius:50%;background:${a.color};"></span>
         <span>${a.name}</span>
       </span>`
    ).join('');
  }

  function dismissPopover() {
    if (activePopover) { activePopover.remove(); activePopover = null; }
    if (svgEl) svgEl.style.pointerEvents = '';
  }

  // Appends a popover div, focuses an optional input, and wires outside-click dismiss.
  // Stops mousedown inside the div so e.preventDefault() on SVG nodes can't block focus.
  function mountPopover(div, focusSelector) {
    document.body.appendChild(div);
    activePopover = div;
    div.addEventListener('keydown', (ev) => {
      if (!ev || ev.defaultPrevented || ev.key !== 'Enter') return;
      if (ev.isComposing || ev.shiftKey || ev.ctrlKey || ev.metaKey || ev.altKey) return;
      const target = ev.target instanceof Element ? ev.target : null;
      if (target) {
        const tag = (target.tagName || '').toLowerCase();
        if (tag === 'textarea' || target.isContentEditable) return;
        if (target.closest('button, a, [role="button"]')) return;
      }
      const buttons = Array.from(div.querySelectorAll('button')).filter((btn) => {
        if (!btn) return false;
        if (btn.disabled || btn.classList.contains('disabled')) return false;
        if (btn.offsetParent === null) return false;
        return true;
      });
      if (buttons.length !== 1) return;
      ev.preventDefault();
      buttons[0].click();
    });
    // Focus the target input after a short delay so the opening click settles first
    if (focusSelector) {
      setTimeout(() => {
        const el = div.querySelector(focusSelector);
        if (el) { el.focus(); }
      }, 40);
    }
    // Outside-mousedown dismiss — composedPath reliably includes div when clicking any child
    setTimeout(() => {
      document.addEventListener('mousedown', function oc(e) {
        const path = e.composedPath ? e.composedPath() : [];
        if (!path.includes(div) && !div.contains(e.target)) {
          dismissPopover();
          document.removeEventListener('mousedown', oc);
        }
      });
    }, 0);
  }

  function showLinkPopover(linkObj, svgMx, svgMy) {
    dismissPopover();
    if (svgEl) svgEl.style.pointerEvents = 'none';
    const svgRect = svgEl.getBoundingClientRect();
    const px = svgRect.left + svgMx;
    const py = svgRect.top + svgMy;
    const div = document.createElement('div');
    div.style.cssText = `position:fixed;z-index:9999;background:var(--bs-body-bg,#fff);
      border:1px solid var(--bs-border-color,#dee2e6);border-radius:10px;
      box-shadow:0 6px 20px rgba(0,0,0,0.2);padding:14px 16px;min-width:240px;font-size:1rem;`;
    div.style.left = Math.min(px + 12, window.innerWidth - 230) + 'px';
    div.style.top = (py - 10) + 'px';
    div.innerHTML = `
      <div class="mb-2 fw-semibold small d-flex align-items-center gap-2">
        <span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${linkObj.color};"></span>
        Adapter: <code>${linkObj.adapter}</code>
      </div>
      <button class="btn btn-sm btn-danger w-100" id="wiz-pop-del" type="button"><i class="bi bi-trash me-1"></i>Delete</button>`;
    div.querySelector('#wiz-pop-del').addEventListener('click', () => {
      const deletedName = linkObj.adapter;
      links = links.filter(x => x.id !== linkObj.id);
      pruneAdapter(deletedName);
      dismissPopover(); renderAll();
    });
    mountPopover(div);
  }

  function showIfacePopover(linkObj, isA, portX, portY) {
    dismissPopover();
    if (svgEl) svgEl.style.pointerEvents = 'none';
    const nodeId  = isA ? linkObj.a : linkObj.b;
    const node    = nodes.find(n => n.id === nodeId);
    const current = isA ? linkObj.ifaceA : linkObj.ifaceB;
    const svgRect = svgEl.getBoundingClientRect();
    const div = document.createElement('div');
    div.style.cssText = `position:fixed;z-index:9999;background:var(--bs-body-bg,#fff);
      border:1px solid var(--bs-border-color,#dee2e6);border-radius:10px;
      box-shadow:0 6px 20px rgba(0,0,0,0.2);padding:14px 16px;min-width:240px;font-size:1rem;`;
    div.style.left = Math.min(svgRect.left + portX + 14, window.innerWidth - 210) + 'px';
    div.style.top  = (svgRect.top + portY - 10) + 'px';
    div.innerHTML = `
      <div class="mb-2 fw-semibold small">
        Interface on <em>${node ? node.finalName || node.name : nodeId}</em>
      </div>
      <div class="d-flex align-items-center gap-2 mb-2">
        <span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${linkObj.color};"></span>
        <span class="small text-muted">${linkObj.adapter}</span>
      </div>
      <div class="input-group input-group-sm">
        <span class="input-group-text">net</span>
        <input type="number" class="form-control" id="wiz-iface-inp" min="0" max="15" value="${current}" style="width:84px;">
        <button class="btn btn-outline-primary" id="wiz-iface-ok" type="button">Set</button>
      </div>`;
    document.body.appendChild(div);
    activePopover = div;
    div.querySelector('#wiz-iface-ok').addEventListener('click', () => {
      const val = parseInt(div.querySelector('#wiz-iface-inp').value);
      if (isNaN(val) || val < 0) return;
      const nodeId = isA ? linkObj.a : linkObj.b;
      const oldVal = isA ? linkObj.ifaceA : linkObj.ifaceB;
      if (val === oldVal) { dismissPopover(); return; }
      // Find any other link on this node that already uses the target number → swap
      const conflict = links.find(l => {
        if (l.id === linkObj.id) return false;
        if (l.a === nodeId && l.ifaceA === val) return true;
        if (l.b === nodeId && l.ifaceB === val) return true;
        return false;
      });
      if (conflict) {
        // Swap: give the conflicting link the number we're vacating
        if (conflict.a === nodeId) conflict.ifaceA = oldVal;
        else                       conflict.ifaceB = oldVal;
      }
      if (isA) linkObj.ifaceA = val; else linkObj.ifaceB = val;
      dismissPopover(); renderAll();
      if (selectedNode) updateSettingsPanel();
    });
    mountPopover(div, '#wiz-iface-inp');
  }

  function renderLinks() {
    if (!linksG) return;
    linksG.innerHTML = '';
    for (const l of links) {
      const na = nodes.find(n => n.id === l.a);
      const nb = nodes.find(n => n.id === l.b);
      if (!na || !nb) continue;
      // Edge intersection points on each VM's rect
      const epA = rectEdgePoint(na.x, na.y, nb.x, nb.y);
      const epB = rectEdgePoint(nb.x, nb.y, na.x, na.y);
      const mx  = (epA.x + epB.x) / 2, my = (epA.y + epB.y) / 2;
      // Thick invisible hit target on the line
      const hit = document.createElementNS(svgNS(), 'line');
      hit.setAttribute('x1', epA.x); hit.setAttribute('y1', epA.y);
      hit.setAttribute('x2', epB.x); hit.setAttribute('y2', epB.y);
      hit.setAttribute('stroke', 'transparent'); hit.setAttribute('stroke-width', '14');
      hit.style.cursor = 'pointer';
      // Visible line
      const line = document.createElementNS(svgNS(), 'line');
      line.setAttribute('x1', epA.x); line.setAttribute('y1', epA.y);
      line.setAttribute('x2', epB.x); line.setAttribute('y2', epB.y);
      line.setAttribute('stroke', l.color); line.setAttribute('stroke-width', '2.5');
      line.setAttribute('stroke-linecap', 'round'); line.setAttribute('pointer-events', 'none');
      // Midpoint adapter label
      const text = document.createElementNS(svgNS(), 'text');
      text.setAttribute('x', mx); text.setAttribute('y', my - 7);
      text.setAttribute('text-anchor', 'middle'); text.setAttribute('font-size', '13');
      text.setAttribute('fill', l.color); text.setAttribute('font-weight', 'bold');
      text.setAttribute('pointer-events', 'none'); text.textContent = l.adapter;
      const capturedL = l;
      hit.addEventListener('click', (e) => { e.stopPropagation(); showLinkPopover(capturedL, mx, my); });
      linksG.appendChild(line); linksG.appendChild(hit); linksG.appendChild(text);
      // ── Port nodes at each VM edge ──
      [[epA, l.ifaceA, true], [epB, l.ifaceB, false]].forEach(([ep, iface, isA]) => {
        const PORT_R = 12;
        // Hit target
        const portHit = document.createElementNS(svgNS(), 'circle');
        portHit.setAttribute('cx', ep.x); portHit.setAttribute('cy', ep.y);
        portHit.setAttribute('r', PORT_R + 4);
        portHit.setAttribute('fill', 'transparent');
        portHit.style.cursor = 'pointer';
        // Visible circle
        const portCircle = document.createElementNS(svgNS(), 'circle');
        portCircle.setAttribute('cx', ep.x); portCircle.setAttribute('cy', ep.y);
        portCircle.setAttribute('r', PORT_R);
        portCircle.setAttribute('fill', '#fff');
        portCircle.setAttribute('stroke', l.color); portCircle.setAttribute('stroke-width', '2');
        portCircle.setAttribute('pointer-events', 'none');
        // Interface number label
        const portLabel = document.createElementNS(svgNS(), 'text');
        portLabel.setAttribute('x', ep.x); portLabel.setAttribute('y', ep.y + 4);
        portLabel.setAttribute('text-anchor', 'middle'); portLabel.setAttribute('font-size', '11');
        portLabel.setAttribute('font-weight', 'bold'); portLabel.setAttribute('fill', l.color);
        portLabel.setAttribute('pointer-events', 'none');
        portLabel.textContent = iface;
        portHit.addEventListener('click', (e) => {
          e.stopPropagation();
          showIfacePopover(capturedL, isA, ep.x, ep.y);
        });
        linksG.appendChild(portCircle); linksG.appendChild(portLabel); linksG.appendChild(portHit);
      });
    }
  }

  function renderNodes() {
    if (!nodesG) return;
    nodesG.innerHTML = '';
    for (const n of nodes) {
      const g = document.createElementNS(svgNS(), 'g');
      g.style.cursor = 'cell';
      g.setAttribute('transform', `translate(${n.x},${n.y})`);
      const hw = NODE_W / 2, hh = NODE_H / 2;
      // Selection ring
      if (selectedNode && selectedNode.id === n.id) {
        const ring = document.createElementNS(svgNS(), 'rect');
        ring.setAttribute('x', -(hw + 4)); ring.setAttribute('y', -(hh + 4));
        ring.setAttribute('width', NODE_W + 8); ring.setAttribute('height', NODE_H + 8);
        ring.setAttribute('rx', NODE_R + 3); ring.setAttribute('ry', NODE_R + 3);
        ring.setAttribute('fill', 'none');
        ring.setAttribute('stroke', '#0d6efd'); ring.setAttribute('stroke-width', '2');
        ring.setAttribute('stroke-dasharray', '5,3');
        g.appendChild(ring);
      }
      // Rounded rect body
      const rect = document.createElementNS(svgNS(), 'rect');
      rect.setAttribute('x', -hw); rect.setAttribute('y', -hh);
      rect.setAttribute('width', NODE_W); rect.setAttribute('height', NODE_H);
      rect.setAttribute('rx', NODE_R); rect.setAttribute('ry', NODE_R);
      rect.setAttribute('fill', n.user_accessible ? '#0d6efd' : '#6c757d');
      rect.setAttribute('stroke', '#fff'); rect.setAttribute('stroke-width', '2');
      g.appendChild(rect);
      // Name label
      const label = document.createElementNS(svgNS(), 'text');
      label.setAttribute('text-anchor', 'middle'); label.setAttribute('dy', '-8');
      label.setAttribute('font-size', '17'); label.setAttribute('font-weight', 'bold');
      label.setAttribute('fill', '#fff'); label.setAttribute('pointer-events', 'none');
      label.textContent = (n.finalName || n.name || '').slice(0, 18);
      g.appendChild(label);
      // VMID sub-label
      const sublabel = document.createElementNS(svgNS(), 'text');
      sublabel.setAttribute('text-anchor', 'middle'); sublabel.setAttribute('dy', '20');
      sublabel.setAttribute('font-size', '13'); sublabel.setAttribute('font-weight', '600');
      sublabel.setAttribute('fill', 'rgba(255,255,255,0.88)');
      sublabel.setAttribute('pointer-events', 'none'); sublabel.textContent = 'ID:' + n.vmid;
      g.appendChild(sublabel);
      // No extra adapter dots — ports on link edges show that info

      // Drag start
      g.addEventListener('mousedown', (e) => {
        e.preventDefault();
        if (e.button !== 0) return;
        dismissPopover();
        dragSrc = n;
        dragLine.style.display = '';
        dragLine.setAttribute('x1', n.x); dragLine.setAttribute('y1', n.y);
        dragLine.setAttribute('x2', n.x); dragLine.setAttribute('y2', n.y);
      });
      // Click = select
      g.addEventListener('click', (e) => {
        e.stopPropagation();
        selectedNode = (selectedNode && selectedNode.id === n.id) ? null : n;
        updateSettingsPanel();
        renderNodes();
      });
      n.el = g;
      nodesG.appendChild(g);
    }
  }

  function renderAll() {
    renderLinks();
    renderNodes();
    renderLegend();
  }

  function updateSettingsPanel() {
    const hint = document.getElementById('wiz-vm-settings-hint');
    const form = document.getElementById('wiz-vm-settings-form');
    if (!selectedNode) {
      hint && (hint.style.display = '');
      form && form.classList.add('d-none');
      return;
    }
    hint && (hint.style.display = 'none');
    form && form.classList.remove('d-none');
    const title = document.getElementById('wiz-vm-settings-title');
    if (title) title.textContent = 'Selected VM';
    const nameValue = document.getElementById('wiz-vm-set-name');
    if (nameValue) {
      nameValue.textContent = selectedNode.finalName || selectedNode.name || '–';
    }
    const accIn = document.getElementById('wiz-vm-set-acc');
    const accLabel = document.getElementById('wiz-vm-set-acc-label');
    if (accIn) {
      accIn.checked = selectedNode.user_accessible;
      if (accLabel) accLabel.textContent = accIn.checked ? 'Enabled' : 'Disabled';
      accIn.onchange = () => {
        selectedNode.user_accessible = accIn.checked;
        if (accLabel) accLabel.textContent = accIn.checked ? 'Enabled' : 'Disabled';
        renderNodes();
      };
    }
    const netsDiv = document.getElementById('wiz-vm-set-nets');
    if (netsDiv) {
      const adps = getNodeAdapters(selectedNode.id);
      if (adps.length > 0) {
        netsDiv.classList.remove('wiz-vm-summary-value--muted');
        netsDiv.innerHTML = adps.map((name) => `<span class="wiz-net-chip">${name}</span>`).join('');
      } else {
        netsDiv.classList.add('wiz-vm-summary-value--muted');
        netsDiv.textContent = '–';
      }
    }
  }

  function init(templates) {
    svgEl    = document.getElementById('wiz-net-canvas');
    linksG   = document.getElementById('wiz-net-links');
    nodesG   = document.getElementById('wiz-net-nodes');
    dragLine = document.getElementById('wiz-drag-line');
    legendEl = document.getElementById('wiz-net-legend');
    if (!svgEl) return;

    // Reset state
    nodes = []; links = []; adapters = [];
    adapterCounter = 0; dragSrc = null; selectedNode = null;

    // Layout nodes in a circle
    const cx = svgEl.clientWidth / 2 || 320;
    const cy = Math.max((svgEl.clientHeight || 560) / 2, 240);
    const r  = Math.min(cx - 100, cy - 90, 220);
    templates.forEach((t, i) => {
      const angle = (i / templates.length) * 2 * Math.PI - Math.PI / 2;
      nodes.push({
        id: t._wizId,
        vmid: t.vmid,
        name: t.name,
        finalName: t.finalName || t.name,
        user_accessible: t.user_accessible !== false,
        x: Math.round(cx + r * Math.cos(angle)),
        y: Math.round(cy + r * Math.sin(angle)),
        el: null
      });
    });

    // SVG mouse events
    svgEl.addEventListener('mousemove', onMouseMove);
    svgEl.addEventListener('mouseup', onMouseUp);
    svgEl.addEventListener('click', () => {
      if (!dragSrc) { dismissPopover(); selectedNode = null; updateSettingsPanel(); renderNodes(); }
    });

    renderAll();
    updateSettingsPanel();
  }

  function onMouseMove(e) {
    if (!dragSrc) return;
    const rect = svgEl.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    dragLine.setAttribute('x2', mx);
    dragLine.setAttribute('y2', my);
  }

  function onMouseUp(e) {
    if (!dragSrc) return;
    const rect = svgEl.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    dragLine.style.display = 'none';

    // Hit detection uses rounded-rect bounds
    const target = nodes.find(n => {
      if (n.id === dragSrc.id) return false;
      const dx = n.x - mx, dy = n.y - my;
      return Math.abs(dx) < NODE_W/2 + 8 && Math.abs(dy) < NODE_H/2 + 8;
    });

    if (target) {
      const adapter = allocateAdapter();
      const ifaceA  = getNextIface(dragSrc.id, null);
      const ifaceB  = getNextIface(target.id, null);
      links.push({ id: Date.now() + Math.random(), a: dragSrc.id, b: target.id, adapter: adapter.name, color: adapter.color, ifaceA, ifaceB });
      renderAll();
      if (selectedNode) updateSettingsPanel();
    }

    dragSrc = null;
  }

  function saveState() {
    for (const n of nodes) {
      const t = wizSelectedTemplates && wizSelectedTemplates.find(t => t._wizId === n.id);
      if (!t) continue;
      t.finalName = n.finalName || n.name;
      t.user_accessible = n.user_accessible;
      // Build nets list sorted by assigned iface number
      const ifaceMap = {};
      for (const l of links) {
        if (l.a === n.id) ifaceMap[l.ifaceA] = l.adapter;
        if (l.b === n.id) ifaceMap[l.ifaceB] = l.adapter;
      }
      const sorted = Object.keys(ifaceMap).map(Number).sort((a, b) => a - b);
      t.nets = sorted.map(i => ifaceMap[i]);
    }
  }

  window.wizNetGraph = { init, saveState, restore };
  window.wizVmSettingsClear = () => { selectedNode = null; updateSettingsPanel(); renderNodes(); };

  // Rename all adapter basenames (e.g. "net" -> "lab"), preserving their alphabetic suffix.
  window.wizRenameAdapterBase = function(newBase) {
    newBase = String(newBase || '').replace(/[^A-Za-z]/g, '').trim();
    if (!newBase) return;
    const baseInp = document.getElementById('wiz-adapter-base');
    adapters.forEach(a => {
      const suffix = getAdapterSuffix(a);
      if (!suffix) return;
      const oldName = a.name;
      const newName = newBase + suffix;
      a.name = newName;
      a.suffix = suffix;
      links.forEach(l => { if (l.adapter === oldName) l.adapter = newName; });
    });
    if (baseInp) baseInp.value = newBase;
    renderAll();
    if (selectedNode) updateSettingsPanel();
  };

  function restore() {
    // Re-grab DOM refs (in case the modal was hidden/shown) and re-render without resetting state
    svgEl    = document.getElementById('wiz-net-canvas');
    linksG   = document.getElementById('wiz-net-links');
    nodesG   = document.getElementById('wiz-net-nodes');
    dragLine = document.getElementById('wiz-drag-line');
    legendEl = document.getElementById('wiz-net-legend');
    if (!svgEl) return;
    // Re-attach mouse events (may have been lost if element was recreated)
    svgEl.addEventListener('mousemove', onMouseMove);
    svgEl.addEventListener('mouseup', onMouseUp);
    svgEl.addEventListener('click', () => {
      if (!dragSrc) { dismissPopover(); selectedNode = null; updateSettingsPanel(); renderNodes(); }
    });
    renderAll();
    updateSettingsPanel();
  }
})();


function resetWizard() {
  currentWizardStep = 0;
  wizFetchedTemplates = [];
  wizSelectedTemplates = [];
  wizTemplateCreds = {};
  wizActiveTemplateCredsVmid = '';
  wizardResetRunState();
  try {
    const credsModalEl = document.getElementById('wizardTemplateCredsModal');
    if (credsModalEl && window.bootstrap && window.bootstrap.Modal) {
      const credsModal = window.bootstrap.Modal.getInstance(credsModalEl);
      if (credsModal) credsModal.hide();
    }
    const numRadio = document.getElementById('wiz-cap-mode-num');
    if (numRadio) { numRadio.checked = true; window.toggleWizCapMode(); }
    document.getElementById('wiz-users').value = '1';
    const csvFile = document.getElementById('wiz-csv-file');
    if (csvFile) csvFile.value = '';
    
    const feedback = document.getElementById('wiz-csv-feedback');
    if (feedback) {
       feedback.innerHTML = 'CSV should not have a header row. Format: username,password';
       feedback.className = 'text-muted d-block mt-1';
    }
    
    document.getElementById('wiz-feat-vm').checked = true;
    document.getElementById('wiz-feat-ctfd').checked = false;
    document.getElementById('wiz-proxmox-url').value = '';
    document.getElementById('wiz-proxmox-user').value = '';
    document.getElementById('wiz-proxmox-pass').value = '';
    document.getElementById('wiz-proxmox-node').value = '';
    const tagIn = document.getElementById('wiz-scenario-tag');
    if (tagIn) tagIn.value = '';
    
    // Clear graph selection cache if template list re-fetched
    window._wizNetGraphTemplateIds = [];
    document.getElementById('wiz-proxmox-verify').checked = true;
    document.getElementById('wiz-ctfd-url').value = '';
    document.getElementById('wiz-ctfd-token').value = '';
    document.getElementById('wiz-ctfd-verify').checked = true;
    
    document.getElementById('wiz-act-vm-create').checked = true;
    document.getElementById('wiz-act-vm-start').checked = true;
    document.getElementById('wiz-act-vm-users').checked = true;
    document.getElementById('wiz-act-ctfd-users').checked = true;
    window.wizToggleVmActions && window.wizToggleVmActions();
  } catch {}
  wizardGotoStep(0);
}

function setWizardLayout(layout) {
  const modalEl = document.getElementById('projectWizardModal');
  if (!modalEl) return;
  modalEl.setAttribute('data-wiz-layout', layout || 'form');
}

function getWizardLayoutForStep(step) {
  switch (step) {
    case 0:
      return 'choice';
    case 1:
    case 2:
      return 'form';
    case 3:
      return 'list';
    case 4:
      return 'graph';
    case 5:
      return 'summary';
    default:
      return 'form';
  }
}

window.wizardGotoStep = function(step) {
  if (step < 0) step = 0;
  if (step > totalWizardSteps) step = totalWizardSteps;
  
  const vmChecked = document.getElementById('wiz-feat-vm')?.checked;
  const ctfdChecked = document.getElementById('wiz-feat-ctfd')?.checked;

  try {
    if (step === 2) {
      if (!vmChecked && !ctfdChecked) {
        submitProjectCreation('wizard');
        return;
      }
      document.getElementById('wiz-creds-vm')?.classList.toggle('d-none', !vmChecked);
      document.getElementById('wiz-creds-ctfd')?.classList.toggle('d-none', !ctfdChecked);
    }
    if (step === 3 && !vmChecked) step = 5;
    if (step === 4 && !vmChecked) step = 5;
    if (step === 5) {
      document.getElementById('wiz-act-vm')?.classList.toggle('d-none', !vmChecked);
      document.getElementById('wiz-act-ctfd')?.classList.toggle('d-none', !ctfdChecked);
    }
  } catch {}

  // Hide all steps
  for (let i = 0; i <= totalWizardSteps; i++) {
    const el = document.getElementById('wiz-step-' + i);
    if (el) el.classList.add('d-none');
  }
  const loadingEl = document.getElementById('wiz-step-loading');
  if (loadingEl) loadingEl.classList.add('d-none');
  
  // Show target
  const targetEl = document.getElementById('wiz-step-' + step);
  if (targetEl) targetEl.classList.remove('d-none');
  setWizardLayout(getWizardLayoutForStep(step));
  
  // Step Indicator & Progress bar handling
  const indicator = document.getElementById('wiz-step-indicator');
  const progressContainer = document.getElementById('wiz-progress-container');
  const progressBar = document.getElementById('wiz-progress-bar');
  const footer = document.getElementById('wiz-footer');
  
  if (step === 0) {
    if (indicator) indicator.classList.add('d-none');
    if (progressContainer) progressContainer.classList.add('d-none');
    if (footer) footer.classList.add('d-none');
  } else {
    if (indicator) {
      indicator.classList.remove('d-none');
      indicator.innerText = `Step ${step} of ${totalWizardSteps}`;
    }
    if (progressContainer) {
      progressContainer.classList.remove('d-none');
      const progressPercent = (step / totalWizardSteps) * 100;
      if (progressBar) progressBar.style.width = progressPercent + '%';
    }
    if (footer) {
      footer.classList.remove('d-none');
      const nextBtn = document.getElementById('wiz-btn-next');
      if (nextBtn) {
        nextBtn.innerText = (step === totalWizardSteps) ? "Create Scenario" : "Next";
      }
      const backBtn = document.getElementById('wiz-btn-back');
      if (backBtn) {
        backBtn.classList.toggle('invisible', step <= 1);
      }
    }
  }

  currentWizardStep = step;
};

window.wizardNext = async function() {
  const vmChecked = document.getElementById('wiz-feat-vm')?.checked;

  // Step 1 Check
  if (currentWizardStep === 1) {
    const mode = document.querySelector('input[name="wiz-cap-mode"]:checked')?.value || 'num';
    if (mode === 'num') {
      const users = document.getElementById('wiz-users');
      if (!users || !users.value || parseInt(users.value) < 1) {
        return showToast('Please specify a valid number of VM clones/users.', 'warning');
      }
    } else {
      const csvFile = document.getElementById('wiz-csv-file');
      if (!csvFile || !csvFile.files || csvFile.files.length === 0) {
        return showToast('Please select a CSV file to upload.', 'warning');
      }
    }

    // Scenario Tag Uniqueness & Generation
    const tagIn = document.getElementById('wiz-scenario-tag');
    let tag = (tagIn && tagIn.value ? tagIn.value.trim() : '');
    const existingTags = Object.values(window.PROJ_CACHE || {}).map(p => (p.tag || '').toLowerCase());

    if (!tag) {
      // Auto-generate using only lowercase letters to satisfy backend validation
      const genTag = () => {
        const letters = 'abcdefghijklmnopqrstuvwxyz';
        let res = 'scen-';
        for (let i = 0; i < 4; i++) res += letters.charAt(Math.floor(Math.random() * letters.length));
        return res;
      };
      let newTag = genTag();
      let attempts = 0;
      while (existingTags.includes(newTag) && attempts < 10) {
        newTag = genTag();
        attempts++;
      }
      tag = newTag;
      if (tagIn) tagIn.value = tag;
    } else {
      // Validate provided tag
      if (existingTags.includes(tag.toLowerCase())) {
        return showToast(`The tag "${tag}" is already in use by another scenario. Please choose a different one.`, 'danger');
      }
    }
  }
  
  // Step 2 -> 3 Check (Fetch Templates if VM enabled)
  if (currentWizardStep === 2 && vmChecked) {
    const url = document.getElementById('wiz-proxmox-url')?.value?.trim();
    const user = document.getElementById('wiz-proxmox-user')?.value?.trim();
    const pwd = document.getElementById('wiz-proxmox-pass')?.value;
    const verifySSL = document.getElementById('wiz-proxmox-verify')?.checked;
    
    const ctfdChecked = document.getElementById('wiz-feat-ctfd')?.checked;
    let ctfdCreds = undefined;
    if (ctfdChecked) {
      const ctfdUrl = document.getElementById('wiz-ctfd-url')?.value?.trim();
      const ctfdToken = document.getElementById('wiz-ctfd-token')?.value?.trim();
      const ctfdVerify = document.getElementById('wiz-ctfd-verify')?.checked;
      ctfdCreds = { url: ctfdUrl, token: ctfdToken, verify_ssl: ctfdVerify };
    }
    
    if (!url || !user || !pwd) {
      return showToast('Proxmox credentials are required to fetch templates.', 'warning');
    }

    // Show loading
    document.getElementById('wiz-step-2').classList.add('d-none');
    document.getElementById('wiz-footer').classList.add('d-none');
    document.getElementById('wiz-step-loading').classList.remove('d-none');
    document.getElementById('wiz-loading-text').innerText = 'Validating credentials and fetching templates...';
    setWizardLayout('loading');

    try {
      const testRes = await http('POST', '/api/test/credentials', { proxmox: { url, username: user, password: pwd, verify_ssl: verifySSL }, ctfd: ctfdCreds });
      if (testRes && testRes.ok === false) throw new Error(testRes.error || 'Validation failed');
      
      const res = await http('POST', '/api/proxmox/templates', { baseUrl: url, username: user, password: pwd, verifySSL: verifySSL });
      wizFetchedTemplates = res.templates || [];
      
      const tplContainer = document.getElementById('wiz-templates-list');
      tplContainer.innerHTML = '';
      
      if (wizFetchedTemplates.length === 0) {
         tplContainer.innerHTML = '<div class="text-muted text-center py-3">No templates found in Proxmox.</div>';
      } else {
         let filterNode = document.getElementById('wiz-proxmox-node')?.value?.trim();
         if (!filterNode) {
             filterNode = wizFetchedTemplates[0].node;
             const nodeInput = document.getElementById('wiz-proxmox-node');
             if (nodeInput) nodeInput.value = filterNode;
         }
         
         const filtered = wizFetchedTemplates.filter(t => t.node === filterNode);
         
         tplContainer.innerHTML = `<div class="alert alert-info py-2 small mb-3">Only templates from Proxmox node <strong>${escHtml(filterNode)}</strong> are shown.</div>`;
         
         if (filtered.length === 0) {
             tplContainer.insertAdjacentHTML('beforeend', '<div class="text-muted text-center py-3">No templates found on this node.</div>');
         } else {
             tplContainer.insertAdjacentHTML('beforeend', `
               <table class="table table-sm table-hover mb-0">
                 <thead class="table-light">
                   <tr>
                     <th style="width:32px;"></th>
                     <th>VM Name</th>
                     <th>Node</th>
                     <th class="text-center" style="width:120px;">Creds</th>
                     <th class="text-center" style="width:150px; cursor:help;" title="These VMs will be directly accessible by participants">Make User Accessible</th>
                   </tr>
                 </thead>
                 <tbody id="wiz-tpl-tbody"></tbody>
               </table>`);
             const tbody = tplContainer.querySelector('#wiz-tpl-tbody');
             filtered.forEach(t => {
                const creds = wizardGetTemplateCreds(t.vmid);
                const hasCreds = !!(creds.username && creds.password);
                const row = document.createElement('tr');
                row.innerHTML = `
                  <td class="align-middle">
                    <input class="form-check-input" type="checkbox" value="${t.vmid}" data-name="${escHtml(t.name)}" id="wiz-tpl-chk-${t.vmid}">
                  </td>
                  <td class="align-middle">
                    <label for="wiz-tpl-chk-${t.vmid}" class="mb-0" style="cursor:pointer;">
                      <strong>${escHtml(t.name)}</strong>
                      <small class="text-muted ms-1">[${escHtml(t.vmid)}]</small>
                    </label>
                  </td>
                  <td class="align-middle text-muted small">${escHtml(t.node)}</td>
                  <td class="text-center align-middle">
                    <button type="button" class="btn btn-sm d-none ${hasCreds ? 'btn-outline-success' : 'btn-outline-secondary'}" data-wiz-template-creds="${t.vmid}">${hasCreds ? 'Stored' : 'Specify'}</button>
                  </td>
                  <td class="text-center align-middle">
                    <input class="form-check-input" type="checkbox" id="wiz-tpl-acc-${t.vmid}" checked
                      title="Mark VMs from this template as user-accessible"
                      style="visibility:hidden;">
                  </td>
                `;
                // Wire selection checkbox to show/hide the user-accessible checkbox
                const selChk = row.querySelector(`#wiz-tpl-chk-${t.vmid}`);
                const accChk = row.querySelector(`#wiz-tpl-acc-${t.vmid}`);
                const credsBtn = row.querySelector('[data-wiz-template-creds]');
                selChk.addEventListener('change', () => {
                  accChk.style.visibility = selChk.checked ? '' : 'hidden';
                  if (credsBtn) credsBtn.classList.toggle('d-none', !selChk.checked);
                });
                if (credsBtn) {
                  credsBtn.addEventListener('click', () => {
                    if (window.openWizardTemplateCreds) window.openWizardTemplateCreds(String(t.vmid), t.name);
                  });
                }
                tbody.appendChild(row);
             });
         }
      }
      wizardGotoStep(3);
      return;
    } catch (e) {
      // Restore UI on error so buttons come back
      const loadingEl = document.getElementById('wiz-step-loading');
      if (loadingEl) loadingEl.classList.add('d-none');
      const footer = document.getElementById('wiz-footer');
      if (footer) footer.classList.remove('d-none');
      
      showToast('Fetch failed: ' + (e?.message || e), 'danger');
      wizardGotoStep(2);
      return;
    }
  }

  // Step 3 -> 4 Check (Build network topology graph)
  if (currentWizardStep === 3) {
     wizSelectedTemplates = [];
     const chks = document.querySelectorAll('input[id^="wiz-tpl-chk-"]:checked');
     chks.forEach(c => {
       const vmid = c.value;
       const accEl = document.getElementById('wiz-tpl-acc-' + vmid);
       const creds = wizardGetTemplateCreds(vmid);
       wizSelectedTemplates.push({
        _wizId: Date.now() + Math.random(),
         vmid,
         name: c.getAttribute('data-name'),
         finalName: c.getAttribute('data-name'),
         user_accessible: accEl ? accEl.checked : true,
         vm_user: creds.username,
         vm_pass: creds.password,
         nets: []
       });
     });
     
     if (wizSelectedTemplates.length === 0) {
       return showToast('Please select at least one template, or go back and disable VM features.', 'warning');
     }

     // Clean names
     wizSelectedTemplates.forEach(t => {
       let n = t.name;
       n = n.replace(/base-?/gi, '').replace(/template-?/gi, '').trim() || t.name;
       t.finalName = n;
     });

     wizardGotoStep(4);
     if (window.wizNetGraph) {
       // Only fully re-init if the template selection changed
       const prevIds = (window._wizNetGraphTemplateIds || []).join(',');
       const newIds  = wizSelectedTemplates.map(t => t.vmid).join(',');
       if (prevIds !== newIds) {
         window._wizNetGraphTemplateIds = wizSelectedTemplates.map(t => t.vmid);
         window.wizNetGraph.init(wizSelectedTemplates);
       } else {
         window.wizNetGraph.restore();
       }
     }
     return;
  }

  // Step 4 -> 5 (Save graph state into wizSelectedTemplates)
  if (currentWizardStep === 4) {
     if (window.wizNetGraph) window.wizNetGraph.saveState();
     return wizardGotoStep(5);
  }

  if (currentWizardStep === totalWizardSteps) {
    submitProjectCreation('wizard');
  } else {
    wizardGotoStep(currentWizardStep + 1);
  }
};

window.wizardBack = function() {
  // Save graph state when navigating away from step 4
  if (currentWizardStep === 4 && window.wizNetGraph) window.wizNetGraph.saveState();
  let prev = currentWizardStep - 1;
  const vmChecked = document.getElementById('wiz-feat-vm')?.checked;
  if (!vmChecked) {
     if (currentWizardStep === 5) prev = 2;
  }
  wizardGotoStep(prev);
};

let wizardRunState = { items: [], projectId: '', done: false, failed: false, summary: '', detail: '' };
let wizardAutoRedirectTimer = null;

function clearWizardAutoRedirect() {
  if (!wizardAutoRedirectTimer) return;
  try { clearTimeout(wizardAutoRedirectTimer); } catch { }
  wizardAutoRedirectTimer = null;
}

function scheduleWizardAutoRedirect(delayMs = 1600) {
  clearWizardAutoRedirect();
  wizardAutoRedirectTimer = setTimeout(() => {
    wizardAutoRedirectTimer = null;
    try {
      if (wizardRunState.done && !wizardRunState.failed && typeof window.finishWizardRun === 'function') {
        window.finishWizardRun();
      }
    } catch { }
  }, Math.max(0, Number(delayMs) || 0));
}

function wizardFindRunItem(key) {
  return (wizardRunState.items || []).find(item => item.key === key) || null;
}

function wizardRunStatusLabel(status) {
  switch (String(status || 'pending').toLowerCase()) {
    case 'running': return 'Running';
    case 'success': return 'Success';
    case 'error': return 'Error';
    case 'skipped': return 'Skipped';
    default: return 'Pending';
  }
}

function wizardDeriveJobStatusText(status) {
  if (!status || typeof status !== 'object') return '';
  const detail = status.detail && typeof status.detail === 'object' ? status.detail : {};
  const bits = [];
  const message = typeof status.message === 'string' ? status.message.trim() : '';
  const current = typeof status.current === 'string' ? status.current.trim() : '';
  const command = typeof detail.command === 'string' ? detail.command.trim() : '';
  const delayLabel = typeof detail.delay_label === 'string' ? detail.delay_label.trim() : '';
  if (message) bits.push(message);
  if (current && (!message || !message.includes(current))) bits.push(current);
  if (command && (!message || !message.includes(command))) bits.push(command);
  if (delayLabel) bits.push(`delay ${delayLabel}`);
  return bits.join(' - ');
}

function wizardRenderRunState() {
  const queueEl = document.getElementById('wiz-run-queue');
  const statusEl = document.getElementById('wiz-run-status');
  const progressBar = document.getElementById('wiz-run-progress-bar');
  const closeBtn = document.getElementById('wiz-btn-close-after-run');
  const spinner = document.getElementById('wiz-loading-spinner');
  const loadingText = document.getElementById('wiz-loading-text');
  const subtext = document.getElementById('wiz-loading-subtext');
  const items = Array.isArray(wizardRunState.items) ? wizardRunState.items : [];
  const total = items.length || 1;
  let completedUnits = 0;
  items.forEach(item => {
    const status = String(item.status || 'pending').toLowerCase();
    if (status === 'running') completedUnits += Math.max(0, Math.min(100, Number(item.progress) || 0)) / 100;
    else if (status === 'success' || status === 'error' || status === 'skipped') completedUnits += 1;
  });
  const percent = Math.max(0, Math.min(100, Math.round((completedUnits / total) * 100)));
  if (progressBar) progressBar.style.width = `${percent}%`;
  if (loadingText) loadingText.textContent = wizardRunState.summary || (wizardRunState.done ? 'Wizard run complete' : 'Running selected operations...');
  if (subtext) subtext.textContent = wizardRunState.detail || (wizardRunState.done ? 'Review the results, then close the wizard.' : 'The queue will update live as each operation runs.');
  const active = items.find(item => String(item.status || '').toLowerCase() === 'running') || null;
  if (statusEl) {
    statusEl.textContent = wizardRunState.done
      ? (wizardRunState.failed ? 'One or more operations failed.' : 'All queued operations completed successfully.')
      : (active?.detail || 'Preparing wizard queue...');
    statusEl.className = wizardRunState.failed ? 'small text-danger text-center' : 'small text-muted text-center';
  }
  if (spinner) spinner.classList.toggle('d-none', !!wizardRunState.done);
  if (closeBtn) closeBtn.classList.toggle('d-none', !wizardRunState.done);
  if (closeBtn) {
    const shouldOpenVmManager = !!(
      wizardRunState.done
      && !wizardRunState.failed
      && String(wizardRunState.projectId || '').trim()
      && Array.isArray(wizSelectedTemplates)
      && wizSelectedTemplates.length > 0
    );
    closeBtn.textContent = shouldOpenVmManager ? 'Open VM Manager' : 'Close';
  }
  if (queueEl) {
    queueEl.innerHTML = items.map(item => {
      const status = String(item.status || 'pending').toLowerCase();
      const summaryText = item.summary || item.detail || '';
      const summary = summaryText ? `<div class="wiz-run-item-summary small">${escHtml(summaryText)}</div>` : '';
      const runningDetail = (status === 'running' && item.detail)
        ? `<div class="wiz-run-item-detail small">${escHtml(item.detail)}</div>`
        : '';
      const issues = Array.isArray(item.issues) ? item.issues.filter(Boolean) : [];
      const issuePreviewLimit = 5;
      const shownIssues = issues.slice(0, issuePreviewLimit);
      const issueLabel = shownIssues.length ? '<div class="wiz-run-item-issues-label">Issues</div>' : '';
      const issueList = shownIssues.length
        ? `<ul class="wiz-run-item-issues small">${shownIssues.map(issue => {
            const text = String(issue || '').trim();
            const splitAt = text.indexOf(': ');
            const title = splitAt > 0 ? text.slice(0, splitAt).trim() : '';
            const body = splitAt > 0 ? text.slice(splitAt + 2).trim() : text;
            const titleHtml = title ? `<div class="wiz-run-issue-title">${escHtml(title)}</div>` : '';
            const bodyHtml = body ? `<div class="wiz-run-issue-body">${escHtml(body)}</div>` : '';
            return `<li class="wiz-run-issue">${titleHtml}${bodyHtml}</li>`;
          }).join('')}</ul>`
        : '';
      const issueMore = issues.length > issuePreviewLimit
        ? `<div class="wiz-run-item-more small">${escHtml(`+${issues.length - issuePreviewLimit} more issue${issues.length - issuePreviewLimit === 1 ? '' : 's'} in the log dock`)}</div>`
        : '';
      return `
        <div class="wiz-run-item wiz-run-item--${status}">
          <div class="wiz-run-item-head">
            <div class="wiz-run-item-label">${escHtml(item.label || item.key || 'Operation')}</div>
            <span class="wiz-run-badge wiz-run-badge--${status}">${escHtml(wizardRunStatusLabel(status))}</span>
          </div>
          ${runningDetail || summary}
          ${status !== 'running' ? issueLabel : ''}
          ${status !== 'running' ? issueList : ''}
          ${status !== 'running' ? issueMore : ''}
        </div>`;
    }).join('');
  }
}

function wizardSetRunState(summary, detail) {
  if (summary !== undefined) wizardRunState.summary = String(summary || '');
  if (detail !== undefined) wizardRunState.detail = String(detail || '');
  wizardRenderRunState();
}

function wizardResetRunState() {
  clearWizardAutoRedirect();
  wizardRunState = { items: [], projectId: '', done: false, failed: false, summary: '', detail: '' };
  const progressBar = document.getElementById('wiz-run-progress-bar');
  if (progressBar) progressBar.style.width = '0%';
  const queueEl = document.getElementById('wiz-run-queue');
  if (queueEl) queueEl.innerHTML = '';
  const statusEl = document.getElementById('wiz-run-status');
  if (statusEl) { statusEl.textContent = ''; statusEl.className = 'small text-muted text-center'; }
  const closeBtn = document.getElementById('wiz-btn-close-after-run');
  if (closeBtn) closeBtn.classList.add('d-none');
  const spinner = document.getElementById('wiz-loading-spinner');
  if (spinner) spinner.classList.remove('d-none');
  const subtext = document.getElementById('wiz-loading-subtext');
  if (subtext) subtext.textContent = 'This may take a few moments...';
  const loadingText = document.getElementById('wiz-loading-text');
  if (loadingText) loadingText.textContent = 'Creating scenario...';
}

function wizardShowLoadingStep(summary, detail) {
  for (let i = 0; i <= totalWizardSteps; i++) {
    const el = document.getElementById('wiz-step-' + i);
    if (el) el.classList.add('d-none');
  }
  const loadingEl = document.getElementById('wiz-step-loading');
  if (loadingEl) loadingEl.classList.remove('d-none');
  const footer = document.getElementById('wiz-footer');
  if (footer) footer.classList.add('d-none');
  const indicator = document.getElementById('wiz-step-indicator');
  if (indicator) indicator.classList.add('d-none');
  const progressContainer = document.getElementById('wiz-progress-container');
  if (progressContainer) progressContainer.classList.add('d-none');
  setWizardLayout('loading');
  wizardSetRunState(summary, detail);
}

function wizardStartQueue(items, summary, detail) {
  wizardRunState = {
    items: (Array.isArray(items) ? items : []).map(item => ({ ...item, status: item.status || 'pending', progress: Number(item.progress) || 0, detail: item.detail || '', summary: item.summary || '', issues: Array.isArray(item.issues) ? item.issues : [] })),
    projectId: '',
    done: false,
    failed: false,
    summary: summary || '',
    detail: detail || ''
  };
  wizardShowLoadingStep(summary, detail);
}

function wizardUpdateRunItem(key, patch) {
  const item = wizardFindRunItem(key);
  if (!item) return;
  Object.assign(item, patch || {});
  wizardRenderRunState();
}

function wizardFinishQueue(ok, summary, detail) {
  clearWizardAutoRedirect();
  const hasItemErrors = (wizardRunState.items || []).some(item => String(item.status || '').toLowerCase() === 'error');
  wizardRunState.done = true;
  wizardRunState.failed = !ok || hasItemErrors;
  if (summary !== undefined) {
    wizardRunState.summary = hasItemErrors && ok ? 'Wizard run completed with issues.' : summary;
  }
  if (detail !== undefined) {
    wizardRunState.detail = hasItemErrors && ok
      ? 'Review the queue below for operations that need attention.'
      : detail;
  }
  wizardRenderRunState();
}

function wizardBuildRunItems(options) {
  const opts = options || {};
  const items = [{ key: 'project-create', label: 'Create scenario', status: 'pending', detail: 'Waiting to submit the project.' }];
  if (opts.hasSecrets) items.push({ key: 'save-secrets', label: 'Save manager credentials', status: 'pending', detail: 'Will persist credentials for later manager refreshes.', blocking: false });
  if (opts.createVms) items.push({ key: 'vm-create', label: 'Create VMs', status: 'pending', detail: 'Templates will be cloned into scenario instances.' });
  if (opts.startVms) items.push({ key: 'vm-start', label: 'Start VMs', status: 'pending', detail: 'Created instances will be powered on.' });
  if (opts.syncUsers) items.push({ key: 'user-sync', label: opts.syncLabel || 'Sync external users', status: 'pending', detail: 'Selected user integrations will be synchronized.' });
  return items;
}

function wizardCountEntries(value) {
  if (Array.isArray(value)) return value.length;
  const num = Number(value);
  return Number.isFinite(num) ? num : 0;
}

function wizardSummarizeActionResult(action, result) {
  const res = (result && typeof result === 'object') ? result : {};
  if (action === 'create') {
    const created = wizardCountEntries(res.created);
    const skipped = wizardCountEntries(res.skipped);
    const issues = wizardCountEntries(res.errors) + wizardCountEntries(res.network_apply_errors) + wizardCountEntries(res?.verify?.issues);
    const bits = [`Created ${created} VM${created === 1 ? '' : 's'}`];
    if (skipped) bits.push(`${skipped} skipped`);
    if (issues) bits.push(`${issues} issue${issues === 1 ? '' : 's'}`);
    return bits.join(', ');
  }
  if (action === 'start') {
    const started = wizardCountEntries(res.started);
    const resumed = wizardCountEntries(res.resumed);
    const errors = wizardCountEntries(res.errors);
    const total = started + resumed;
    const bits = [`Started ${total} VM${total === 1 ? '' : 's'}`];
    if (errors) bits.push(`${errors} issue${errors === 1 ? '' : 's'}`);
    return bits.join(', ');
  }
  if (action === 'users_access_sync') {
    const applied = wizardCountEntries(res.applied);
    const unchanged = wizardCountEntries(res.unchanged);
    const errors = wizardCountEntries(res.errors);
    const bits = [`Applied ${applied} change${applied === 1 ? '' : 's'}`];
    if (unchanged) bits.push(`${unchanged} unchanged`);
    if (errors) bits.push(`${errors} issue${errors === 1 ? '' : 's'}`);
    return bits.join(', ');
  }
  return 'Completed';
}

function wizardFormatCreateVerifyIssue(issue) {
  const item = (issue && typeof issue === 'object') ? issue : {};
  const label = String(item.name || item.vmid || 'VM').trim();
  const parts = [];
  if (item.missing_snapshot) parts.push('missing post-clone snapshot');
  if (item.nets_ok === false) {
    const expected = Array.isArray(item.nets_expected) ? item.nets_expected.filter(Boolean).join(', ') : '';
    const actual = Array.isArray(item.nets_actual) ? item.nets_actual.filter(Boolean).join(', ') : '';
    if (expected || actual) parts.push(`network mismatch${expected ? ` expected [${expected}]` : ''}${actual ? ` actual [${actual}]` : ''}`);
    else parts.push('network mismatch');
  }
  if (Array.isArray(item.ageing_missing) && item.ageing_missing.length) {
    parts.push(`ageing missing [${item.ageing_missing.join(', ')}]`);
  }
  if (!parts.length) return label;
  return `${label}: ${parts.join('; ')}`;
}

function wizardCollectActionIssues(action, result) {
  const res = (result && typeof result === 'object') ? result : {};
  const issues = [];
  if (action === 'create') {
    (Array.isArray(res.errors) ? res.errors : []).forEach(entry => {
      if (!entry) return;
      const name = String(entry.name || entry.index || '').trim();
      const reason = String(entry.reason || entry.error || '').trim();
      if (name && reason) issues.push(`${name}: ${reason}`);
      else if (reason) issues.push(reason);
    });
    (Array.isArray(res.network_apply_errors) ? res.network_apply_errors : []).forEach(entry => {
      if (!entry) return;
      const node = String(entry.node || '').trim();
      const reason = String(entry.reason || entry.error || '').trim();
      if (node && reason) issues.push(`network ${node}: ${reason}`);
      else if (reason) issues.push(reason);
    });
    (Array.isArray(res?.verify?.issues) ? res.verify.issues : []).forEach(entry => {
      const text = wizardFormatCreateVerifyIssue(entry);
      if (text) issues.push(text);
    });
    return issues;
  }
  if (action === 'start' || action === 'users_access_sync') {
    (Array.isArray(res.errors) ? res.errors : []).forEach(entry => {
      if (!entry) return;
      const name = String(entry.name || entry.index || '').trim();
      const reason = String(entry.reason || entry.error || '').trim();
      if (name && reason) issues.push(`${name}: ${reason}`);
      else if (reason) issues.push(reason);
    });
    return issues;
  }
  return issues;
}

function wizardPreviewActionIssues(issues, limit = 3) {
  const list = Array.isArray(issues) ? issues.filter(Boolean) : [];
  if (!list.length) return '';
  const shown = list.slice(0, limit);
  const suffix = list.length > limit ? ` (+${list.length - limit} more)` : '';
  return `${shown.join(' | ')}${suffix}`;
}

function wizardLogActionIssues(action, issues) {
  const list = Array.isArray(issues) ? issues.filter(Boolean) : [];
  if (!list.length) return;
  const prefix = `Wizard ${action}`;
  list.forEach(issue => {
    try {
      if (window.shell && typeof shell.logError === 'function') shell.logError(`${prefix}: ${issue}`);
      else console.error(prefix, issue);
    } catch { }
  });
}

function wizardActionHasErrors(action, result) {
  const res = (result && typeof result === 'object') ? result : {};
  if (action === 'create') {
    return wizardCountEntries(res.errors) > 0 || wizardCountEntries(res.network_apply_errors) > 0 || wizardCountEntries(res?.verify?.issues) > 0;
  }
  if (action === 'start' || action === 'users_access_sync') {
    return wizardCountEntries(res.errors) > 0;
  }
  return false;
}

function startWizardJobStatusPolling(pid, options = {}) {
  const projectId = String(pid || '').trim();
  if (!projectId || typeof http !== 'function') return () => { };
  const interval = Math.max(600, Number(options.interval) || 1200);
  const onStatus = typeof options.onStatus === 'function' ? options.onStatus : null;
  const initialDelay = Math.max(0, Number(options.initialDelay) || 0);
  let stopped = false;
  let timer = null;
  let seenActive = false;

  const clearTimer = () => { if (timer) { try { clearTimeout(timer); } catch { } timer = null; } };
  const stop = () => { stopped = true; clearTimer(); };
  const schedule = () => {
    if (stopped) return;
    clearTimer();
    timer = setTimeout(run, interval);
  };
  const handleNoActive = () => {
    if (seenActive) {
      stop();
      return true;
    }
    return false;
  };
  const run = async () => {
    if (stopped) return;
    try {
      const status = await http('GET', `/api/projects/${encodeURIComponent(projectId)}/instances/actions/status`);
      if (status && !status.error) {
        seenActive = true;
        if (onStatus) onStatus(status);
        const normalized = String(status.status || '').toLowerCase();
        if (normalized && normalized !== 'running') {
          stop();
          return;
        }
      } else if (status && status.error) {
        const errText = String(status.error || '').toLowerCase();
        if (errText.includes('no active job') && handleNoActive()) return;
      }
    } catch (err) {
      const msg = String(err?.message || err || '').toLowerCase();
      if (msg.includes('no active job') && handleNoActive()) return;
    }
    schedule();
  };

  if (initialDelay > 0) timer = setTimeout(run, initialDelay);
  else run();
  return stop;
}

async function wizardRunTrackedAction(pid, itemKey, actionKey, requestFactory) {
  wizardUpdateRunItem(itemKey, { status: 'running', progress: 2, detail: 'Submitting request...', summary: '', issues: [] });
  const stopPoll = startWizardJobStatusPolling(pid, {
    initialDelay: 150,
    onStatus: (status) => {
      wizardUpdateRunItem(itemKey, {
        progress: Math.max(2, Math.min(100, Number(status.progress) || 0)),
        detail: wizardDeriveJobStatusText(status) || 'Processing...'
      });
    }
  });
  try {
    const result = await requestFactory();
    stopPoll();
    const summary = wizardSummarizeActionResult(actionKey, result);
    const hasErrors = wizardActionHasErrors(actionKey, result);
    const issues = wizardCollectActionIssues(actionKey, result);
    wizardUpdateRunItem(itemKey, {
      status: hasErrors ? 'error' : 'success',
      progress: 100,
      detail: summary,
      summary,
      issues
    });
    if (hasErrors) {
      wizardLogActionIssues(actionKey, issues);
      throw new Error(wizardPreviewActionIssues(issues, 1) || summary || `${actionKey} failed`);
    }
    return result;
  } catch (err) {
    stopPoll();
    const message = String(err?.message || err || `${actionKey} failed`);
    wizardUpdateRunItem(itemKey, { status: 'error', progress: 100, detail: message, summary: message });
    throw err;
  }
}

window.finishWizardRun = function() {
  const projectId = String(wizardRunState.projectId || '').trim();
  const shouldOpenVmManager = !!(
    wizardRunState.done
    && !wizardRunState.failed
    && projectId
    && Array.isArray(wizSelectedTemplates)
    && wizSelectedTemplates.length > 0
  );
  const modalEl = document.getElementById('projectWizardModal');
  if (modalEl) {
    try {
      const modal = bootstrap.Modal.getInstance(modalEl) || bootstrap.Modal.getOrCreateInstance(modalEl);
      modal.hide();
    } catch { }
  }
  resetWizard();
  if (shouldOpenVmManager) {
    try {
      const url = new URL('/static/vm_manager.html', window.location.origin);
      url.searchParams.set('id', projectId);
      url.searchParams.set('refresh', '1');
      window.location.href = url.pathname + url.search;
      return;
    } catch { }
  }
};

// Create a new project from the sidebar input
async function createProject() {
  const input = document.getElementById('proj-name');
  const name = (input && input.value ? input.value.trim() : '');
  if (!name) { try { showToast('Enter a project/scenario name first.', 'warning'); } catch { } return; }
  
  resetWizard();
  const modalEl = document.getElementById('projectWizardModal');
  if (modalEl) {
    const modal = bootstrap.Modal.getOrCreateInstance(modalEl);
    modal.show();
  } else {
    // Fallback if UI not loaded
    submitProjectCreation('manual');
  }
}

window.submitProjectCreation = async function(mode) {
  const input = document.getElementById('proj-name');
  const name = (input && input.value ? input.value.trim() : '');
  if (!name) { try { showToast('Project name is missing.', 'warning'); } catch { } return; }

  let vmUrl = '', vmUser = '', vmPass = '', ctfdToken = '';
  let payload = { name };
  let wizardRunOptions = null;

  if (mode === 'wizard') {
    try {
      if (window.wizNetGraph && (currentWizardStep >= 4 || (wizSelectedTemplates && wizSelectedTemplates.length > 0))) {
        window.wizNetGraph.saveState();
      }
    } catch { }

    const tagVal = document.getElementById('wiz-scenario-tag')?.value?.trim();
    if (tagVal) payload.tag = tagVal;
    
    const capMode = document.querySelector('input[name="wiz-cap-mode"]:checked')?.value || 'num';
    if (capMode === 'num') {
      const inst = document.getElementById('wiz-users')?.value;
      if (inst) payload.instances = parseInt(inst, 10);
    } else {
      const fileIn = document.getElementById('wiz-csv-file');
      if (fileIn && fileIn.files && fileIn.files.length > 0) {
        let fileContent = '';
        try {
          fileContent = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = e => resolve(e.target.result);
            reader.onerror = e => reject(e);
            reader.readAsText(fileIn.files[0]);
          });
        } catch (e) {
          showToast('Failed to read CSV file: ' + e, 'danger');
          return;
        }
        
        let creds = [];
        const lines = fileContent.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i].trim();
          if (!line) continue;
          const parts = line.split(',');
          let a = (parts[0] || '').trim();
          let b = (parts[1] || '').trim();
          
          const isHeader = (x, y) => {
            if (!y) return false;
            return x.toLowerCase() === 'username' || x.toLowerCase() === 'user' || y.toLowerCase() === 'password' || y.toLowerCase() === 'pass';
          };
          if (i === 0 && isHeader(a, b)) continue; // skip header
          if (!a && !b) continue;
          creds.push({ username: a, password: b });
        }
        
        if (creds.length > 0) {
          payload.credentials = creds;
          payload.instances = creds.length;
        } else {
          payload.instances = 0;
        }
      } else {
        showToast('Please select a CSV file.', 'warning');
        return;
      }
    }
    
    if (document.getElementById('wiz-feat-vm')?.checked) {
      vmUrl = document.getElementById('wiz-proxmox-url')?.value || '';
      vmUser = document.getElementById('wiz-proxmox-user')?.value || '';
      vmPass = document.getElementById('wiz-proxmox-pass')?.value || '';
      if (vmUrl) payload.proxmox_url = vmUrl;
      const vmNode = document.getElementById('wiz-proxmox-node')?.value?.trim();
      if (vmNode) payload.proxmox_node = vmNode;
      const vmVerify = document.getElementById('wiz-proxmox-verify')?.checked;
      payload.proxmox_verify_ssl = vmVerify === true;
    }
    
    if (document.getElementById('wiz-feat-ctfd')?.checked) {
      const ctfdUrl = document.getElementById('wiz-ctfd-url')?.value || '';
      if (ctfdUrl) payload.challenge_url = ctfdUrl;
      ctfdToken = document.getElementById('wiz-ctfd-token')?.value || '';
      const ctfdVerify = document.getElementById('wiz-ctfd-verify')?.checked;
      payload.challenge_verify_ssl = ctfdVerify === true;
    }

    if (document.getElementById('wiz-feat-vm')?.checked && wizSelectedTemplates && wizSelectedTemplates.length > 0) {
      payload.vms = wizSelectedTemplates.map(t => ({
        name: t.finalName,
        vmid: t.vmid,
        viewable_to_user: t.user_accessible,
        vm_user: t.vm_user || null,
        vm_pass: t.vm_pass || null,
        internal_network_adaptors: Array.isArray(t.nets) && t.nets.length > 0 ? t.nets : []
      }));
    }
    
    const isCreate = !!document.getElementById('wiz-act-vm-create')?.checked;
    const isStart = !!document.getElementById('wiz-act-vm-start')?.checked;
    const isUsersVm = !!document.getElementById('wiz-act-vm-users')?.checked;
    const isUsersCtfd = !!document.getElementById('wiz-act-ctfd-users')?.checked;
    const syncUsers = isUsersVm || isUsersCtfd;
    const syncLabel = isUsersVm && isUsersCtfd
      ? 'Sync Proxmox and CTFd users'
      : (isUsersCtfd ? 'Sync CTFd users' : 'Sync external users');
    wizardRunOptions = {
      createVms: isCreate,
      startVms: isCreate && isStart,
      syncUsers,
      syncLabel,
      hasSecrets: !!(vmUser || vmPass || ctfdToken)
    };
    wizardStartQueue(
      wizardBuildRunItems(wizardRunOptions),
      'Preparing wizard queue...',
      'Validating credentials and staging the selected operations.'
    );

    // Live validation
    if (vmUrl || vmUser || ctfdToken || payload.challenge_url) {
      wizardSetRunState('Validating credentials...', 'Checking the manager connections before scenario creation starts.');
      const testPayload = {
         proxmox: (vmUrl || vmUser) ? { url: vmUrl, username: vmUser, password: vmPass } : null,
         ctfd: (payload.challenge_url || ctfdToken) ? { url: payload.challenge_url, token: ctfdToken } : null
      };
      try {
        const testRes = await http('POST', '/api/test/credentials', testPayload);
        if (testRes && testRes.ok === false) {
           throw new Error(testRes.error || 'Validation failed');
        }
      } catch (e) {
         wizardResetRunState();
         showToast('Credential validation failed: ' + (e?.message || e), 'danger');
         wizardGotoStep(2); // Return to credential screen for retry
         return;
      }
    }
    wizardSetRunState('Creating scenario...', 'Submitting the scenario definition and preparing follow-up actions.');
  }

  try {
    if (mode === 'wizard') {
      wizardUpdateRunItem('project-create', { status: 'running', progress: 15, detail: 'Sending create request...' });
    }
    try { (window.shell && shell.logInfo) ? shell.logInfo(`Config: creating project \"${name}\"…`) : console.log('Creating project', name); } catch { }
    const res = await http('POST', '/api/projects', payload);
    const pid = res && (res.id || res.pid) ? (res.id || res.pid) : '';
    if (mode === 'wizard') {
      wizardRunState.projectId = pid;
      wizardUpdateRunItem('project-create', { status: 'success', progress: 100, detail: pid ? `Scenario created with project id ${pid}.` : 'Scenario created.' });
      wizardSetRunState('Scenario created.', 'Running the selected follow-up operations.');
    }

    // Clear input after a successful create request so a stale name is not retained.
    try { if (input) input.value = ''; } catch { }

    try { if (pid && window.shell && shell.setCurrentProjectId) shell.setCurrentProjectId(pid); } catch { }

    if (mode !== 'wizard') {
      // Always navigate (or stay) on configuration page so the new project loads expanded
      try {
        if (location.pathname !== '/' && location.pathname !== '/index.html') {
          return location.href = '/';
        }
      } catch { }
    }

    try { await loadProjects(); } catch { }
    try { if (window.shell && shell.refreshSidebar) await shell.refreshSidebar('config'); } catch { }
    
    // If wizard mode and we collected credentials, send the secrets
    if (mode === 'wizard' && pid && (vmUser || vmPass || ctfdToken)) {
      const secretsPayload = {
        proxmox: (vmUser || vmPass) ? { username: vmUser, password: vmPass } : undefined,
        ctfd: ctfdToken ? { token: ctfdToken } : undefined
      };
      try {
        wizardUpdateRunItem('save-secrets', { status: 'running', progress: 15, detail: 'Saving credentials for manager pages...' });
        await http('PUT', `/api/projects/${pid}/secrets`, secretsPayload);
        wizardUpdateRunItem('save-secrets', { status: 'success', progress: 100, detail: 'Credentials saved.' });
      } catch (e) {
        console.error("Secrets sync failed", e);
        wizardUpdateRunItem('save-secrets', { status: 'error', progress: 100, detail: `Credentials were not saved: ${e?.message || e}` });
      }
    } else if (mode === 'wizard' && wizardFindRunItem('save-secrets')) {
      wizardUpdateRunItem('save-secrets', { status: 'skipped', progress: 100, detail: 'No credentials were provided.' });
    }

    if (mode === 'wizard' && pid) {
      const proxmoxActionBody = {
        username: vmUser || undefined,
        password: vmPass || undefined,
        baseUrl: vmUrl || payload.proxmox_url || undefined,
        verifySSL: payload.proxmox_verify_ssl !== false,
      };
      const instanceCount = Math.max(0, parseInt(String(payload.instances || 0), 10) || 0);
      const templateNames = Array.isArray(payload.vms)
        ? payload.vms.map(vm => String(vm?.name || '').trim()).filter(Boolean)
        : [];
      const targets = [];
      for (let index = 1; index <= instanceCount; index += 1) {
        templateNames.forEach(name => {
          targets.push({ index, name });
        });
      }
      const indices = Array.from({ length: instanceCount }, (_, idx) => idx + 1);
      const createStartBody = { ...proxmoxActionBody, targets };
      try {
        if (wizardRunOptions?.createVms) {
          wizardSetRunState('Running selected operations...', 'Creating the selected VMs for the new scenario.');
          await wizardRunTrackedAction(pid, 'vm-create', 'create', () => http('POST', `/api/projects/${pid}/instances/actions/create`, createStartBody));
        } else if (wizardFindRunItem('vm-create')) {
          wizardUpdateRunItem('vm-create', { status: 'skipped', progress: 100, detail: 'VM creation was not selected.' });
        }
        if (wizardRunOptions?.startVms) {
          wizardSetRunState('Running selected operations...', 'Starting the created VMs.');
          await wizardRunTrackedAction(pid, 'vm-start', 'start', () => http('POST', `/api/projects/${pid}/instances/actions/start`, createStartBody));
        } else if (wizardFindRunItem('vm-start')) {
          wizardUpdateRunItem('vm-start', { status: 'skipped', progress: 100, detail: 'VM start was not selected.' });
        }
        if (wizardRunOptions?.syncUsers && templateNames.length > 0 && indices.length > 0) {
          wizardSetRunState('Running selected operations...', 'Synchronizing the selected user integrations.');
          await wizardRunTrackedAction(pid, 'user-sync', 'users_access_sync', () => http('POST', `/api/projects/${pid}/instances/actions/users_access_sync`, {
            ...proxmoxActionBody,
            templates: templateNames,
            indices,
            enable: true,
          }));
        } else if (wizardFindRunItem('user-sync')) {
          wizardUpdateRunItem('user-sync', {
            status: 'skipped',
            progress: 100,
            detail: wizardRunOptions?.syncUsers
              ? 'No VM templates were available to synchronize.'
              : 'User synchronization was not selected.'
          });
        }
      } finally {
        if (window.vmRefresh) setTimeout(() => window.vmRefresh(), 1000);
      }

      try { await loadProjects(); } catch { }
      try { if (window.shell && shell.refreshSidebar) await shell.refreshSidebar('config'); } catch { }
      wizardFinishQueue(true, 'Wizard run complete.', 'The scenario and all selected operations finished successfully.');
      if (Array.isArray(wizSelectedTemplates) && wizSelectedTemplates.length > 0) {
        wizardSetRunState('Wizard run complete.', 'Opening VM Manager and refreshing the new scenario...');
        scheduleWizardAutoRedirect(1400);
      }
      try { showToast('Project created and selected operations completed.', 'success'); } catch { }
      return;
    }

    try { showToast('Project created.', 'success'); } catch { }
  } catch (e) {
    if (mode === 'wizard') {
      const item = wizardFindRunItem('project-create');
      if (item && item.status === 'running') {
        wizardUpdateRunItem('project-create', { status: 'error', progress: 100, detail: String(e?.message || e || 'Failed to create scenario') });
      }
      try { await loadProjects(); } catch { }
      try { if (window.shell && shell.refreshSidebar) await shell.refreshSidebar('config'); } catch { }
      wizardFinishQueue(false, 'Wizard run stopped.', String(e?.message || e || 'One or more operations failed.'));
      try { showToast('Wizard run failed: ' + (e?.message || e), 'danger'); } catch { }
      try { (window.shell && shell.logError) ? shell.logError('Config: create project failed: ' + (e?.message || e)) : console.error('Create project failed:', e); } catch { }
      return;
    }
    try { showToast('Failed to create project: ' + (e?.message || e), 'danger'); } catch { }
    try { (window.shell && shell.logError) ? shell.logError('Config: create project failed: ' + (e?.message || e)) : console.error('Create project failed:', e); } catch { }
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

function escHtml(s) {
  if (s === null || s === undefined) return '';
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[c]));
}

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

function debounceProjectSave(pid, field, delay = 600) {
  const key = pid + ':' + field;
  if (_pendingSaveTimers[key]) clearTimeout(_pendingSaveTimers[key]);
  _pendingSaveTimers[key] = setTimeout(() => {
    try { autoSaveProjectField(pid); } catch (e) { console.error('Auto-save failed', e); }
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
    name: (function () { const el = card.querySelector('input[aria-label="Project name"]'); return (el && el.value ? el.value.trim() : ''); })(),
    proxmox_url: document.getElementById(`cfg-${pid}-proxmox_url`)?.value?.trim(),
    proxmox_api_port: Number(document.getElementById(`cfg-${pid}-proxmox_api_port`)?.value),
    proxmox_ssh_port: Number(document.getElementById(`cfg-${pid}-proxmox_ssh_port`)?.value),
    proxmox_node: document.getElementById(`cfg-${pid}-proxmox_node`)?.value?.trim() || '',
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
    proxmox_update_delay_seconds: Number(document.getElementById(`cfg-${pid}-proxmox_update_delay_seconds`)?.value),
    proxmox_use_linked_clones: !!(document.getElementById(`cfg-${pid}-proxmox_use_linked_clones`)?.checked),
    proxmox_assign_rollback_on_non_viewable: !!(document.getElementById(`cfg-${pid}-proxmox_assign_rollback_on_non_viewable`)?.checked),
  };
  // Optional future fields (skip if disabled)
  const optIds = ['keycloak_url', 'keycloak_port', 'keycloak_nodename', 'challenge_url', 'challenge_port'];
  optIds.forEach(id => {
    const el = document.getElementById(`cfg-${pid}-` + id);
    if (el && !el.disabled) {
      let v = el.value;
      if (id.endsWith('_port') || id === 'keycloak_port' || id === 'challenge_port') v = Number(v);
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
      const prevTag = typeof prev.tag === 'string' ? prev.tag : '';
      const newTag = typeof next.tag === 'string' ? next.tag : prevTag;
      if ((newName && newName !== prevName) || (newTag && newTag !== prevTag)) {
        try { if (window.shell && shell.refreshSidebar) shell.refreshSidebar('config'); } catch { }
      }
    } catch { }
    try { showStatusDot(pid, 'saved'); } catch { }
  } catch (e) {
    try { showStatusDot(pid, 'error'); } catch { }
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
  const userEl = document.getElementById(`vm-${pid}-${idx}-user`);
  const passEl = document.getElementById(`vm-${pid}-${idx}-pass`);
  let vmid = null;
  let vm_user = null;
  let vm_pass = null;
  if (vmidEl) {
    const raw = String(vmidEl.value ?? '').trim();
    if (raw) {
      const parsed = Number(raw);
      vmid = Number.isFinite(parsed) ? parsed : null;
    }
  }
  const collectValues = (selector) => Array.from(document.querySelectorAll(selector)).map(input => (input.value || '').trim()).filter(v => v !== '');
  const startSteps = getStartCommandsFromDom(pid, idx);
  const startCommands = stepsToServerPayload(startSteps);
  const storedSteps = getStoredCommandsFromDom(pid, idx);
  const storedCommands = stepsToServerPayload(storedSteps);
  const adaptors = collectValues(`#vm-${pid}-${idx}-nets-list input`).map(val => val.replace(/[^A-Za-z]/g, '').slice(0, 8)).filter(Boolean);
  if (userEl && userEl.value.trim() !== '') {
    vm_user = userEl.value.trim();
  }
  if (passEl && passEl.value.trim() !== '') {
    vm_pass = passEl.value.trim();
  }
  const payload = {
    vmid: vmid,
    vm_user: vm_user,
    vm_pass: vm_pass,
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
            internal_network_adaptors: payload.internal_network_adaptors,
            vm_user: payload.vm_user,
            vm_pass: payload.vm_pass
          };
        }
      }
    } catch { }
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
    try { console.error('Auto-save VM failed', pid, name, e); } catch { }
  }
}

function renderStartCommandsModal() {
  const modalTitle = document.getElementById('startCommandsModalLabel');
  if (modalTitle) {
    const name = START_COMMAND_MODAL_STATE.vmName ? ` — ${START_COMMAND_MODAL_STATE.vmName}` : '';
    modalTitle.textContent = `Manage Start Commands${name}`;
  }
  const stepsEl = document.getElementById('start-commands-steps');
  const emptyEl = document.getElementById('start-commands-empty');
  if (!stepsEl) return;
  const steps = START_COMMAND_MODAL_STATE.steps || [];
  if (!steps.length) {
    stepsEl.innerHTML = '';
    if (emptyEl) emptyEl.classList.remove('d-none');
    return;
  }
  const html = steps.map((step, stepIdx) => {
    const commands = Array.isArray(step.commands) ? step.commands : [];
    const delayValue = Number(step.delaySeconds || 0);
    const delayInput = Number.isFinite(delayValue)
      ? (Math.abs(delayValue - Math.round(delayValue)) < 1e-6 ? String(Math.round(delayValue)) : String(delayValue))
      : '0';
    const delayBlocked = stepDelayIsBlocked(steps, stepIdx);
    const delayInputClasses = ['form-control', 'form-control-sm'];
    if (delayBlocked) delayInputClasses.push('bg-light', 'text-muted');
    const delayHintClasses = ['text-muted', 'small', 'mt-1'];
    if (!delayBlocked) delayHintClasses.push('d-none');
    const delayHintId = `start-step-${stepIdx}-delay-hint`;
    const delayDisabledAttr = delayBlocked ? 'disabled aria-disabled="true"' : '';
    const stepUpDisabled = stepIdx === 0 ? 'disabled' : '';
    const stepDownDisabled = stepIdx === steps.length - 1 ? 'disabled' : '';
    const commandsMarkup = commands.length ? commands.map((cmd, cmdIdx) => {
      const commandObj = cmd && typeof cmd === 'object' ? cmd : { command: cmd, enabled: true };
      const commandText = escHtml((commandObj.command ?? '').toString());
      const isEnabled = commandObj.enabled !== false;
      const toggleTitle = isEnabled ? 'Disable command' : 'Enable command';
      const cmdUpDisabled = cmdIdx === 0 ? 'disabled' : '';
      const cmdDownDisabled = cmdIdx === commands.length - 1 ? 'disabled' : '';
      const inputClasses = ['form-control', 'form-control-sm'];
      if (!isEnabled) {
        inputClasses.push('text-decoration-line-through', 'opacity-50');
      }
      const longRunning = commandObj.longRunning === true;
      const timeoutValue = normalizeCommandTimeout(commandObj.timeoutSeconds);
      const timeoutText = escHtml(String(timeoutValue));
      const longId = `start-cmd-${stepIdx}-${cmdIdx}-long`;
      const timeoutId = `start-cmd-${stepIdx}-${cmdIdx}-timeout`;
      const timeoutHintId = `start-cmd-${stepIdx}-${cmdIdx}-timeout-hint`;
      const longTitle = 'Mark if this command may exceed the guest agent timeout or run indefinitely';
      const timeoutDisabledAttr = longRunning ? 'disabled aria-disabled="true"' : '';
      const timeoutInputClasses = ['form-control', 'form-control-sm'];
      if (longRunning) timeoutInputClasses.push('bg-light', 'text-muted');
      const timeoutHintClasses = ['text-muted', 'small', 'mt-1'];
      if (!longRunning) timeoutHintClasses.push('d-none');
      return `<div class="mb-3" data-cmd-index="${cmdIdx}" data-enabled="${isEnabled ? '1' : '0'}">
        <div class="d-flex align-items-center gap-2 flex-wrap">
          <span class="badge bg-secondary flex-shrink-0">Cmd ${cmdIdx + 1}</span>
          <div class="form-check form-switch m-0 flex-shrink-0">
            <input class="form-check-input" type="checkbox" data-role="cmd-toggle" ${isEnabled ? 'checked' : ''} title="${toggleTitle}" aria-label="${toggleTitle}">
          </div>
          <input type="text" class="${inputClasses.join(' ')}" data-role="cmd-input" placeholder="Command" value="${commandText}">
          <div class="btn-group btn-group-sm flex-shrink-0">
            <button type="button" class="btn btn-outline-secondary" data-role="cmd-up" ${cmdUpDisabled} title="Move command up">
              <span aria-hidden="true">&#8593;</span><span class="visually-hidden">Move command up</span>
            </button>
            <button type="button" class="btn btn-outline-secondary" data-role="cmd-down" ${cmdDownDisabled} title="Move command down">
              <span aria-hidden="true">&#8595;</span><span class="visually-hidden">Move command down</span>
            </button>
            <button type="button" class="btn btn-outline-danger" data-role="cmd-delete">Remove</button>
          </div>
        </div>
        <div class="row g-2 align-items-center ms-4 mt-1" data-role="cmd-meta-row">
          <div class="col-sm-6 col-md-4">
            <div class="form-check form-switch m-0">
              <input class="form-check-input" type="checkbox" id="${escHtml(longId)}" data-role="cmd-long" ${longRunning ? 'checked' : ''} title="${longTitle}" aria-label="${longTitle}">
              <label class="form-check-label small" for="${escHtml(longId)}">Long-running</label>
            </div>
          </div>
          <div class="col-sm-6 col-md-4">
            <label class="form-label small mb-1" for="${escHtml(timeoutId)}">Timeout (seconds)</label>
            <input type="number" min="1" step="1" class="${timeoutInputClasses.join(' ')}" id="${escHtml(timeoutId)}" data-role="cmd-timeout" value="${timeoutText}" aria-label="Timeout in seconds" aria-describedby="${escHtml(timeoutHintId)}" ${timeoutDisabledAttr}>
            <small id="${escHtml(timeoutHintId)}" class="${timeoutHintClasses.join(' ')}" data-role="timeout-hint">Timeout is ignored while long-running is enabled.</small>
          </div>
        </div>
      </div>`;
    }).join('') : '<div class="text-muted small" data-role="empty-step">No commands in this step.</div>';
    return `<div class="list-group-item" data-step-index="${stepIdx}">
      <div class="d-flex justify-content-between align-items-center flex-wrap gap-2">
        <div class="d-flex align-items-center gap-2">
          <span class="badge bg-primary">Step ${stepIdx + 1}</span>
          <span class="small text-muted">Commands in this step run together after the delay.</span>
        </div>
        <div class="btn-group btn-group-sm">
          <button type="button" class="btn btn-outline-secondary" data-role="step-up" ${stepUpDisabled} title="Move step up">
            <span aria-hidden="true">&#9650;</span><span class="visually-hidden">Move step up</span>
          </button>
          <button type="button" class="btn btn-outline-secondary" data-role="step-down" ${stepDownDisabled} title="Move step down">
            <span aria-hidden="true">&#9660;</span><span class="visually-hidden">Move step down</span>
          </button>
          <button type="button" class="btn btn-outline-danger" data-role="step-delete">Remove</button>
        </div>
      </div>
      <div class="row g-2 align-items-center mt-2 mb-3">
        <div class="col-sm-6 col-md-4">
          <label class="form-label small mb-1" for="start-step-delay-${stepIdx}">Delay before step (seconds)</label>
          <input type="number" min="0" step="0.1" id="start-step-delay-${stepIdx}" class="${delayInputClasses.join(' ')}" data-role="step-delay" value="${delayInput}" aria-describedby="${escHtml(delayHintId)}" ${delayDisabledAttr}>
          <small id="${escHtml(delayHintId)}" class="${delayHintClasses.join(' ')}" data-role="delay-hint">Delays after a long-running command are ignored.</small>
        </div>
      </div>
      <div data-role="command-wrapper">
        ${commandsMarkup}
      </div>
      <button type="button" class="btn btn-outline-secondary btn-sm mt-2" data-role="cmd-add">Add Command</button>
    </div>`;
  }).join('');
  stepsEl.innerHTML = html;
  syncStepDelayBlockedStates('start');
  if (emptyEl) emptyEl.classList.add('d-none');
}

function focusStartCommandInput(stepIdx, cmdIdx) {
  setTimeout(() => {
    const selector = `#start-commands-steps [data-step-index="${stepIdx}"] [data-cmd-index="${cmdIdx}"] input[data-role="cmd-input"]`;
    const input = document.querySelector(selector);
    if (input) {
      input.focus();
      input.select();
    }
  }, 60);
}

function resetStartCommandsModal() {
  START_COMMAND_MODAL_STATE.pid = null;
  START_COMMAND_MODAL_STATE.idx = null;
  START_COMMAND_MODAL_STATE.vmName = '';
  START_COMMAND_MODAL_STATE.steps = [];
  renderStartCommandsModal();
}

function openStartCommandsManager(pid, idx) {
  try { wireStartCommandsModal(); } catch { }
  const proj = (window.PROJ_CACHE || {})[pid];
  const vmList = proj && Array.isArray(proj.vms) ? proj.vms : [];
  const vm = vmList[idx] || vmList.find(entry => entry && entry.id === idx);
  const fallback = getStartCommandsFromDom(pid, idx);
  const rawSteps = Array.isArray(vm?.start_commands) ? vm.start_commands : fallback;
  const steps = normalizeStartCommandSteps(rawSteps);
  START_COMMAND_MODAL_STATE.pid = pid;
  START_COMMAND_MODAL_STATE.idx = idx;
  START_COMMAND_MODAL_STATE.vmName = vm?.name || '';
  START_COMMAND_MODAL_STATE.steps = steps.map(step => ({
    delaySeconds: step.delaySeconds,
    commands: (Array.isArray(step.commands) ? step.commands : []).map(cmd => ({
      command: cmd.command,
      enabled: cmd.enabled !== false,
      longRunning: cmd.longRunning === true,
      timeoutSeconds: normalizeCommandTimeout(cmd.timeoutSeconds),
    }))
  }));
  renderStartCommandsModal();
  const modalEl = document.getElementById('startCommandsModal');
  if (modalEl && window.bootstrap && typeof bootstrap.Modal === 'function') {
    const modal = bootstrap.Modal.getOrCreateInstance(modalEl);
    modal.show();
  } else {
    alert('Start command manager unavailable.');
  }
}

async function saveStartCommandsFromModal() {
  const { pid, idx, vmName } = START_COMMAND_MODAL_STATE;
  if (!pid || idx === null || !vmName) return;
  const saveBtn = document.getElementById('start-commands-save');
  if (saveBtn) saveBtn.disabled = true;
  setVmStatus(pid, idx, 'Saving…', 'text-muted');
  const sanitized = sanitizeStartCommandSteps(START_COMMAND_MODAL_STATE.steps);
  const payload = stepsToServerPayload(sanitized);
  try {
    await saveVM(pid, vmName, { start_commands: payload }, { silent: true });
    updateStartCommandsCache(pid, vmName, sanitized, idx);
    updateStartCommandsDomState(pid, idx, sanitized);
    START_COMMAND_MODAL_STATE.steps = sanitized.map(step => ({
      delaySeconds: step.delaySeconds,
      commands: step.commands.map(cmd => ({
        command: cmd.command,
        enabled: cmd.enabled !== false,
        longRunning: cmd.longRunning === true,
        timeoutSeconds: normalizeCommandTimeout(cmd.timeoutSeconds),
      }))
    }));
    setVmStatus(pid, idx, 'Saved', 'text-success');
    setTimeout(() => {
      const el = document.getElementById(`vm-save-status-${pid}-${idx}`);
      if (el && el.textContent === 'Saved') {
        el.textContent = '';
        el.className = 'small text-muted';
      }
    }, 1600);
    try { showToast('Start commands updated.', 'success'); } catch { }
    const modalEl = document.getElementById('startCommandsModal');
    if (modalEl && window.bootstrap && typeof bootstrap.Modal === 'function') {
      const modal = bootstrap.Modal.getInstance(modalEl);
      if (modal) modal.hide();
    }
  } catch (e) {
    try { showToast('Failed to save start commands: ' + (e?.message || e), 'danger'); } catch { alert('Failed to save start commands: ' + (e?.message || e)); }
    setVmStatus(pid, idx, 'Save failed', 'text-danger');
  } finally {
    if (saveBtn) saveBtn.disabled = false;
  }
}

function wireStartCommandsModal() {
  const modalEl = document.getElementById('startCommandsModal');
  if (!modalEl || modalEl._startCommandsBound) return;
  modalEl._startCommandsBound = true;
  const addStepBtn = document.getElementById('start-commands-add-step');
  if (addStepBtn) {
    addStepBtn.addEventListener('click', () => {
      const steps = START_COMMAND_MODAL_STATE.steps;
      const newStep = { delaySeconds: 0, commands: [createEmptyCommandEntry()] };
      steps.push(newStep);
      renderStartCommandsModal();
      focusStartCommandInput(steps.length - 1, 0);
    });
  }
  const stepsEl = document.getElementById('start-commands-steps');
  if (stepsEl) {
    stepsEl.addEventListener('input', (ev) => {
      const target = ev.target;
      if (!target) return;
      const stepEl = target.closest && target.closest('[data-step-index]');
      if (!stepEl) return;
      const stepIdx = Number(stepEl.dataset.stepIndex);
      if (Number.isNaN(stepIdx) || !START_COMMAND_MODAL_STATE.steps[stepIdx]) return;
      const role = target.getAttribute('data-role');
      if (role === 'cmd-input') {
        const cmdEl = target.closest('[data-cmd-index]');
        if (!cmdEl) return;
        const cmdIdx = Number(cmdEl.dataset.cmdIndex);
        if (Number.isNaN(cmdIdx)) return;
        const commands = START_COMMAND_MODAL_STATE.steps[stepIdx].commands = Array.isArray(START_COMMAND_MODAL_STATE.steps[stepIdx].commands) ? START_COMMAND_MODAL_STATE.steps[stepIdx].commands : [];
        if (!commands[cmdIdx] || typeof commands[cmdIdx] !== 'object') {
          commands[cmdIdx] = createEmptyCommandEntry();
        }
        commands[cmdIdx].command = target.value;
      } else if (role === 'cmd-timeout') {
        const cmdEl = target.closest('[data-cmd-index]');
        if (!cmdEl) return;
        const cmdIdx = Number(cmdEl.dataset.cmdIndex);
        if (Number.isNaN(cmdIdx)) return;
        const commands = START_COMMAND_MODAL_STATE.steps[stepIdx].commands = Array.isArray(START_COMMAND_MODAL_STATE.steps[stepIdx].commands) ? START_COMMAND_MODAL_STATE.steps[stepIdx].commands : [];
        if (!commands[cmdIdx] || typeof commands[cmdIdx] !== 'object') {
          commands[cmdIdx] = createEmptyCommandEntry();
        }
        let timeoutVal = Number(target.value);
        if (!Number.isFinite(timeoutVal) || timeoutVal <= 0) {
          timeoutVal = DEFAULT_COMMAND_TIMEOUT_SECONDS;
        } else {
          timeoutVal = Math.round(timeoutVal);
        }
        commands[cmdIdx].timeoutSeconds = timeoutVal;
        target.value = String(timeoutVal);
      } else if (role === 'step-delay') {
        const raw = target.value;
        let parsed = Number(raw);
        if (!Number.isFinite(parsed) || parsed < 0) parsed = 0;
        START_COMMAND_MODAL_STATE.steps[stepIdx].delaySeconds = parsed;
      }
    });
    stepsEl.addEventListener('change', (ev) => {
      const target = ev.target;
      if (!target) return;
      const role = target.getAttribute('data-role');
      if (role !== 'cmd-toggle' && role !== 'cmd-long') return;
      const stepEl = target.closest('[data-step-index]');
      const cmdEl = target.closest('[data-cmd-index]');
      if (!stepEl || !cmdEl) return;
      const stepIdx = Number(stepEl.dataset.stepIndex);
      const cmdIdx = Number(cmdEl.dataset.cmdIndex);
      if (Number.isNaN(stepIdx) || Number.isNaN(cmdIdx)) return;
      const commands = START_COMMAND_MODAL_STATE.steps[stepIdx].commands = Array.isArray(START_COMMAND_MODAL_STATE.steps[stepIdx].commands) ? START_COMMAND_MODAL_STATE.steps[stepIdx].commands : [];
      if (!commands[cmdIdx] || typeof commands[cmdIdx] !== 'object') {
        commands[cmdIdx] = createEmptyCommandEntry();
      }
      if (role === 'cmd-long') {
        commands[cmdIdx].longRunning = !!target.checked;
        const title = target.checked ? 'Marked as long-running' : 'Not marked as long-running';
        target.title = title;
        target.setAttribute('aria-label', title);
        applyCommandLongRunningState(cmdEl, target.checked);
        syncStepDelayBlockedStates('start');
        return;
      }
      commands[cmdIdx].enabled = !!target.checked;
      const input = cmdEl.querySelector('input[data-role="cmd-input"]');
      if (input) {
        input.classList.toggle('text-decoration-line-through', !target.checked);
        input.classList.toggle('opacity-50', !target.checked);
      }
      target.title = target.checked ? 'Disable command' : 'Enable command';
      target.setAttribute('aria-label', target.title);
      cmdEl.dataset.enabled = target.checked ? '1' : '0';
    });
    stepsEl.addEventListener('click', (ev) => {
      const btn = ev.target && ev.target.closest ? ev.target.closest('button[data-role]') : null;
      if (!btn) return;
      const stepEl = btn.closest('[data-step-index]');
      if (!stepEl) return;
      const stepIdx = Number(stepEl.dataset.stepIndex);
      if (Number.isNaN(stepIdx)) return;
      const steps = START_COMMAND_MODAL_STATE.steps;
      const step = steps[stepIdx];
      if (!step) return;
      const role = btn.dataset.role;
      if (role === 'cmd-add') {
        step.commands = Array.isArray(step.commands) ? step.commands : [];
        step.commands.push(createEmptyCommandEntry());
        renderStartCommandsModal();
        focusStartCommandInput(stepIdx, step.commands.length - 1);
        return;
      }
      if (role === 'step-delete') {
        steps.splice(stepIdx, 1);
        renderStartCommandsModal();
        return;
      }
      if (role === 'step-up' && stepIdx > 0) {
        [steps[stepIdx - 1], steps[stepIdx]] = [steps[stepIdx], steps[stepIdx - 1]];
        renderStartCommandsModal();
        focusStartCommandInput(stepIdx - 1, 0);
        return;
      }
      if (role === 'step-down' && stepIdx < steps.length - 1) {
        [steps[stepIdx + 1], steps[stepIdx]] = [steps[stepIdx], steps[stepIdx + 1]];
        renderStartCommandsModal();
        focusStartCommandInput(stepIdx + 1, 0);
        return;
      }
      const cmdContainer = btn.closest('[data-cmd-index]');
      if (!cmdContainer) return;
      const cmdIdx = Number(cmdContainer.dataset.cmdIndex);
      if (Number.isNaN(cmdIdx)) return;
      step.commands = Array.isArray(step.commands) ? step.commands : [];
      if (role === 'cmd-delete') {
        step.commands.splice(cmdIdx, 1);
        if (!step.commands.length) {
          steps.splice(stepIdx, 1);
        }
        renderStartCommandsModal();
        return;
      }
      if (role === 'cmd-up' && cmdIdx > 0) {
        [step.commands[cmdIdx - 1], step.commands[cmdIdx]] = [step.commands[cmdIdx], step.commands[cmdIdx - 1]];
        renderStartCommandsModal();
        focusStartCommandInput(stepIdx, cmdIdx - 1);
        return;
      }
      if (role === 'cmd-down' && cmdIdx < step.commands.length - 1) {
        [step.commands[cmdIdx + 1], step.commands[cmdIdx]] = [step.commands[cmdIdx], step.commands[cmdIdx + 1]];
        renderStartCommandsModal();
        focusStartCommandInput(stepIdx, cmdIdx + 1);
      }
    });
  }
  const saveBtn = document.getElementById('start-commands-save');
  if (saveBtn) saveBtn.addEventListener('click', saveStartCommandsFromModal);
  modalEl.addEventListener('hidden.bs.modal', resetStartCommandsModal);
}

function renderStoredCommandsModal() {
  const modalTitle = document.getElementById('storedCommandsModalLabel');
  if (modalTitle) {
    const name = STORED_COMMAND_MODAL_STATE.vmName ? ` — ${STORED_COMMAND_MODAL_STATE.vmName}` : '';
    modalTitle.textContent = `Manage Stored Commands${name}`;
  }
  const stepsEl = document.getElementById('stored-commands-steps');
  const emptyEl = document.getElementById('stored-commands-empty');
  if (!stepsEl) return;
  const steps = STORED_COMMAND_MODAL_STATE.steps || [];
  if (!steps.length) {
    stepsEl.innerHTML = '';
    if (emptyEl) emptyEl.classList.remove('d-none');
    return;
  }
  const html = steps.map((step, stepIdx) => {
    const commands = Array.isArray(step.commands) ? step.commands : [];
    const delayValue = Number(step.delaySeconds || 0);
    const delayInput = Number.isFinite(delayValue)
      ? (Math.abs(delayValue - Math.round(delayValue)) < 1e-6 ? String(Math.round(delayValue)) : String(delayValue))
      : '0';
    const delayBlocked = stepDelayIsBlocked(steps, stepIdx);
    const delayInputClasses = ['form-control', 'form-control-sm'];
    if (delayBlocked) delayInputClasses.push('bg-light', 'text-muted');
    const delayHintClasses = ['text-muted', 'small', 'mt-1'];
    if (!delayBlocked) delayHintClasses.push('d-none');
    const delayHintId = `stored-step-${stepIdx}-delay-hint`;
    const delayDisabledAttr = delayBlocked ? 'disabled aria-disabled="true"' : '';
    const stepUpDisabled = stepIdx === 0 ? 'disabled' : '';
    const stepDownDisabled = stepIdx === steps.length - 1 ? 'disabled' : '';
    const commandsMarkup = commands.length ? commands.map((cmd, cmdIdx) => {
      const commandObj = cmd && typeof cmd === 'object' ? cmd : { command: cmd, enabled: true };
      const commandText = escHtml((commandObj.command ?? '').toString());
      const isEnabled = commandObj.enabled !== false;
      const toggleTitle = isEnabled ? 'Disable command' : 'Enable command';
      const cmdUpDisabled = cmdIdx === 0 ? 'disabled' : '';
      const cmdDownDisabled = cmdIdx === commands.length - 1 ? 'disabled' : '';
      const inputClasses = ['form-control', 'form-control-sm'];
      if (!isEnabled) {
        inputClasses.push('text-decoration-line-through', 'opacity-50');
      }
      const longRunning = commandObj.longRunning === true;
      const timeoutValue = normalizeCommandTimeout(commandObj.timeoutSeconds);
      const timeoutText = escHtml(String(timeoutValue));
      const longId = `stored-cmd-${stepIdx}-${cmdIdx}-long`;
      const timeoutId = `stored-cmd-${stepIdx}-${cmdIdx}-timeout`;
      const timeoutHintId = `stored-cmd-${stepIdx}-${cmdIdx}-timeout-hint`;
      const longTitle = 'Mark if this command may exceed the guest agent timeout or run indefinitely';
      const timeoutDisabledAttr = longRunning ? 'disabled aria-disabled="true"' : '';
      const timeoutInputClasses = ['form-control', 'form-control-sm'];
      if (longRunning) timeoutInputClasses.push('bg-light', 'text-muted');
      const timeoutHintClasses = ['text-muted', 'small', 'mt-1'];
      if (!longRunning) timeoutHintClasses.push('d-none');
      return `<div class="mb-3" data-cmd-index="${cmdIdx}" data-enabled="${isEnabled ? '1' : '0'}">
        <div class="d-flex align-items-center gap-2 flex-wrap">
          <span class="badge bg-secondary flex-shrink-0">Cmd ${cmdIdx + 1}</span>
          <div class="form-check form-switch m-0 flex-shrink-0">
            <input class="form-check-input" type="checkbox" data-role="cmd-toggle" ${isEnabled ? 'checked' : ''} title="${toggleTitle}" aria-label="${toggleTitle}">
          </div>
          <input type="text" class="${inputClasses.join(' ')}" data-role="cmd-input" placeholder="Command" value="${commandText}">
          <div class="btn-group btn-group-sm flex-shrink-0">
            <button type="button" class="btn btn-outline-secondary" data-role="cmd-up" ${cmdUpDisabled} title="Move command up"><span aria-hidden="true">&#8593;</span><span class="visually-hidden">Move command up</span></button>
            <button type="button" class="btn btn-outline-secondary" data-role="cmd-down" ${cmdDownDisabled} title="Move command down"><span aria-hidden="true">&#8595;</span><span class="visually-hidden">Move command down</span></button>
            <button type="button" class="btn btn-outline-danger" data-role="cmd-delete">Remove</button>
          </div>
        </div>
        <div class="row g-2 align-items-center ms-4 mt-1" data-role="cmd-meta-row">
          <div class="col-sm-6 col-md-4">
            <div class="form-check form-switch m-0">
              <input class="form-check-input" type="checkbox" id="${escHtml(longId)}" data-role="cmd-long" ${longRunning ? 'checked' : ''} title="${longTitle}" aria-label="${longTitle}">
              <label class="form-check-label small" for="${escHtml(longId)}">Long-running</label>
            </div>
          </div>
          <div class="col-sm-6 col-md-4">
            <label class="form-label small mb-1" for="${escHtml(timeoutId)}">Timeout (seconds)</label>
            <input type="number" min="1" step="1" class="${timeoutInputClasses.join(' ')}" id="${escHtml(timeoutId)}" data-role="cmd-timeout" value="${timeoutText}" aria-label="Timeout in seconds" aria-describedby="${escHtml(timeoutHintId)}" ${timeoutDisabledAttr}>
            <small id="${escHtml(timeoutHintId)}" class="${timeoutHintClasses.join(' ')}" data-role="timeout-hint">Timeout is ignored while long-running is enabled.</small>
          </div>
        </div>
      </div>`;
    }).join('') : '<div class="text-muted small" data-role="empty-step">No commands in this step.</div>';
    return `<div class="list-group-item" data-step-index="${stepIdx}">
      <div class="d-flex justify-content-between align-items-center flex-wrap gap-2">
        <div class="d-flex align-items-center gap-2">
          <span class="badge bg-primary">Step ${stepIdx + 1}</span>
          <span class="small text-muted">Commands in this step run together after the delay.</span>
        </div>
        <div class="btn-group btn-group-sm">
          <button type="button" class="btn btn-outline-secondary" data-role="step-up" ${stepUpDisabled} title="Move step up"><span aria-hidden="true">&#9650;</span><span class="visually-hidden">Move step up</span></button>
          <button type="button" class="btn btn-outline-secondary" data-role="step-down" ${stepDownDisabled} title="Move step down"><span aria-hidden="true">&#9660;</span><span class="visually-hidden">Move step down</span></button>
          <button type="button" class="btn btn-outline-danger" data-role="step-delete">Remove</button>
        </div>
      </div>
      <div class="row g-2 align-items-center mt-2 mb-3">
        <div class="col-sm-6 col-md-4">
          <label class="form-label small mb-1" for="stored-step-delay-${stepIdx}">Delay before step (seconds)</label>
          <input type="number" min="0" step="0.1" id="stored-step-delay-${stepIdx}" class="${delayInputClasses.join(' ')}" data-role="step-delay" value="${delayInput}" aria-describedby="${escHtml(delayHintId)}" ${delayDisabledAttr}>
          <small id="${escHtml(delayHintId)}" class="${delayHintClasses.join(' ')}" data-role="delay-hint">Delays after a long-running command are ignored.</small>
        </div>
      </div>
      <div data-role="command-wrapper">
        ${commandsMarkup}
      </div>
      <button type="button" class="btn btn-outline-secondary btn-sm mt-2" data-role="cmd-add">Add Command</button>
    </div>`;
  }).join('');
  stepsEl.innerHTML = html;
  syncStepDelayBlockedStates('stored');
  if (emptyEl) emptyEl.classList.add('d-none');
}

function focusStoredCommandInput(stepIdx, cmdIdx) {
  setTimeout(() => {
    const selector = `#stored-commands-steps [data-step-index="${stepIdx}"] [data-cmd-index="${cmdIdx}"] input[data-role="cmd-input"]`;
    const input = document.querySelector(selector);
    if (input) {
      input.focus();
      input.select();
    }
  }, 60);
}

function resetStoredCommandsModal() {
  STORED_COMMAND_MODAL_STATE.pid = null;
  STORED_COMMAND_MODAL_STATE.idx = null;
  STORED_COMMAND_MODAL_STATE.vmName = '';
  STORED_COMMAND_MODAL_STATE.steps = [];
  renderStoredCommandsModal();
}

function openStoredCommandsManager(pid, idx) {
  try { wireStoredCommandsModal(); } catch { }
  const proj = (window.PROJ_CACHE || {})[pid];
  const vmList = proj && Array.isArray(proj.vms) ? proj.vms : [];
  const vm = vmList[idx] || vmList.find(entry => entry && entry.id === idx);
  const fallback = getStoredCommandsFromDom(pid, idx);
  const rawSteps = Array.isArray(vm?.stored_commands) ? vm.stored_commands : fallback;
  const steps = normalizeStartCommandSteps(rawSteps);
  STORED_COMMAND_MODAL_STATE.pid = pid;
  STORED_COMMAND_MODAL_STATE.idx = idx;
  STORED_COMMAND_MODAL_STATE.vmName = vm?.name || '';
  STORED_COMMAND_MODAL_STATE.steps = steps.map(step => ({
    delaySeconds: step.delaySeconds,
    commands: (Array.isArray(step.commands) ? step.commands : []).map(cmd => ({
      command: cmd.command,
      enabled: cmd.enabled !== false,
      longRunning: cmd.longRunning === true,
      timeoutSeconds: normalizeCommandTimeout(cmd.timeoutSeconds),
    }))
  }));
  renderStoredCommandsModal();
  const modalEl = document.getElementById('storedCommandsModal');
  if (modalEl && window.bootstrap && typeof bootstrap.Modal === 'function') {
    const modal = bootstrap.Modal.getOrCreateInstance(modalEl);
    modal.show();
  } else {
    alert('Stored command manager unavailable.');
  }
}

async function saveStoredCommandsFromModal() {
  const { pid, idx, vmName } = STORED_COMMAND_MODAL_STATE;
  if (!pid || idx === null || !vmName) return;
  const saveBtn = document.getElementById('stored-commands-save');
  if (saveBtn) saveBtn.disabled = true;
  setVmStatus(pid, idx, 'Saving…', 'text-muted');
  const sanitized = sanitizeStartCommandSteps(STORED_COMMAND_MODAL_STATE.steps);
  const payload = stepsToServerPayload(sanitized);
  try {
    await saveVM(pid, vmName, { stored_commands: payload }, { silent: true });
    updateStoredCommandsCache(pid, vmName, sanitized, idx);
    updateStoredCommandsDomState(pid, idx, sanitized);
    STORED_COMMAND_MODAL_STATE.steps = sanitized.map(step => ({
      delaySeconds: step.delaySeconds,
      commands: step.commands.map(cmd => ({
        command: cmd.command,
        enabled: cmd.enabled !== false,
        longRunning: cmd.longRunning === true,
        timeoutSeconds: normalizeCommandTimeout(cmd.timeoutSeconds),
      }))
    }));
    setVmStatus(pid, idx, 'Saved', 'text-success');
    setTimeout(() => {
      const el = document.getElementById(`vm-save-status-${pid}-${idx}`);
      if (el && el.textContent === 'Saved') {
        el.textContent = '';
        el.className = 'small text-muted';
      }
    }, 1600);
    try { showToast('Stored commands updated.', 'success'); } catch { }
    const modalEl = document.getElementById('storedCommandsModal');
    if (modalEl && window.bootstrap && typeof bootstrap.Modal === 'function') {
      const modal = bootstrap.Modal.getInstance(modalEl);
      if (modal) modal.hide();
    }
  } catch (e) {
    try { showToast('Failed to save stored commands: ' + (e?.message || e), 'danger'); } catch { alert('Failed to save stored commands: ' + (e?.message || e)); }
    setVmStatus(pid, idx, 'Save failed', 'text-danger');
  } finally {
    if (saveBtn) saveBtn.disabled = false;
  }
}

function wireStoredCommandsModal() {
  const modalEl = document.getElementById('storedCommandsModal');
  if (!modalEl || modalEl._storedCommandsBound) return;
  modalEl._storedCommandsBound = true;
  const addStepBtn = document.getElementById('stored-commands-add-step');
  if (addStepBtn) {
    addStepBtn.addEventListener('click', () => {
      const steps = STORED_COMMAND_MODAL_STATE.steps;
      const newStep = { delaySeconds: 0, commands: [createEmptyCommandEntry()] };
      steps.push(newStep);
      renderStoredCommandsModal();
      focusStoredCommandInput(steps.length - 1, 0);
    });
  }
  const stepsEl = document.getElementById('stored-commands-steps');
  if (stepsEl) {
    stepsEl.addEventListener('input', (ev) => {
      const target = ev.target;
      if (!target) return;
      const stepEl = target.closest && target.closest('[data-step-index]');
      if (!stepEl) return;
      const stepIdx = Number(stepEl.dataset.stepIndex);
      if (Number.isNaN(stepIdx) || !STORED_COMMAND_MODAL_STATE.steps[stepIdx]) return;
      const role = target.getAttribute('data-role');
      if (role === 'cmd-input') {
        const cmdEl = target.closest('[data-cmd-index]');
        if (!cmdEl) return;
        const cmdIdx = Number(cmdEl.dataset.cmdIndex);
        if (Number.isNaN(cmdIdx)) return;
        const commands = STORED_COMMAND_MODAL_STATE.steps[stepIdx].commands = Array.isArray(STORED_COMMAND_MODAL_STATE.steps[stepIdx].commands) ? STORED_COMMAND_MODAL_STATE.steps[stepIdx].commands : [];
        if (!commands[cmdIdx] || typeof commands[cmdIdx] !== 'object') {
          commands[cmdIdx] = createEmptyCommandEntry();
        }
        commands[cmdIdx].command = target.value;
      } else if (role === 'cmd-timeout') {
        const cmdEl = target.closest('[data-cmd-index]');
        if (!cmdEl) return;
        const cmdIdx = Number(cmdEl.dataset.cmdIndex);
        if (Number.isNaN(cmdIdx)) return;
        const commands = STORED_COMMAND_MODAL_STATE.steps[stepIdx].commands = Array.isArray(STORED_COMMAND_MODAL_STATE.steps[stepIdx].commands) ? STORED_COMMAND_MODAL_STATE.steps[stepIdx].commands : [];
        if (!commands[cmdIdx] || typeof commands[cmdIdx] !== 'object') {
          commands[cmdIdx] = createEmptyCommandEntry();
        }
        let timeoutVal = Number(target.value);
        if (!Number.isFinite(timeoutVal) || timeoutVal <= 0) {
          timeoutVal = DEFAULT_COMMAND_TIMEOUT_SECONDS;
        } else {
          timeoutVal = Math.round(timeoutVal);
        }
        commands[cmdIdx].timeoutSeconds = timeoutVal;
        target.value = String(timeoutVal);
      } else if (role === 'step-delay') {
        const raw = target.value;
        let parsed = Number(raw);
        if (!Number.isFinite(parsed) || parsed < 0) parsed = 0;
        STORED_COMMAND_MODAL_STATE.steps[stepIdx].delaySeconds = parsed;
      }
    });
    stepsEl.addEventListener('change', (ev) => {
      const target = ev.target;
      if (!target) return;
      const role = target.getAttribute('data-role');
      if (role !== 'cmd-toggle' && role !== 'cmd-long') return;
      const stepEl = target.closest('[data-step-index]');
      const cmdEl = target.closest('[data-cmd-index]');
      if (!stepEl || !cmdEl) return;
      const stepIdx = Number(stepEl.dataset.stepIndex);
      const cmdIdx = Number(cmdEl.dataset.cmdIndex);
      if (Number.isNaN(stepIdx) || Number.isNaN(cmdIdx)) return;
      const commands = STORED_COMMAND_MODAL_STATE.steps[stepIdx].commands = Array.isArray(STORED_COMMAND_MODAL_STATE.steps[stepIdx].commands) ? STORED_COMMAND_MODAL_STATE.steps[stepIdx].commands : [];
      if (!commands[cmdIdx] || typeof commands[cmdIdx] !== 'object') {
        commands[cmdIdx] = createEmptyCommandEntry();
      }
      if (role === 'cmd-long') {
        commands[cmdIdx].longRunning = !!target.checked;
        const title = target.checked ? 'Marked as long-running' : 'Not marked as long-running';
        target.title = title;
        target.setAttribute('aria-label', title);
        applyCommandLongRunningState(cmdEl, target.checked);
        syncStepDelayBlockedStates('stored');
        return;
      }
      commands[cmdIdx].enabled = !!target.checked;
      const input = cmdEl.querySelector('input[data-role="cmd-input"]');
      if (input) {
        input.classList.toggle('text-decoration-line-through', !target.checked);
        input.classList.toggle('opacity-50', !target.checked);
      }
      target.title = target.checked ? 'Disable command' : 'Enable command';
      target.setAttribute('aria-label', target.title);
      cmdEl.dataset.enabled = target.checked ? '1' : '0';
    });
    stepsEl.addEventListener('click', (ev) => {
      const btn = ev.target && ev.target.closest ? ev.target.closest('button[data-role]') : null;
      if (!btn) return;
      const stepEl = btn.closest('[data-step-index]');
      if (!stepEl) return;
      const stepIdx = Number(stepEl.dataset.stepIndex);
      if (Number.isNaN(stepIdx)) return;
      const steps = STORED_COMMAND_MODAL_STATE.steps;
      const step = steps[stepIdx];
      if (!step) return;
      const role = btn.dataset.role;
      if (role === 'cmd-add') {
        step.commands = Array.isArray(step.commands) ? step.commands : [];
        step.commands.push(createEmptyCommandEntry());
        renderStoredCommandsModal();
        focusStoredCommandInput(stepIdx, step.commands.length - 1);
        return;
      }
      if (role === 'step-delete') {
        steps.splice(stepIdx, 1);
        renderStoredCommandsModal();
        return;
      }
      if (role === 'step-up' && stepIdx > 0) {
        [steps[stepIdx - 1], steps[stepIdx]] = [steps[stepIdx], steps[stepIdx - 1]];
        renderStoredCommandsModal();
        focusStoredCommandInput(stepIdx - 1, 0);
        return;
      }
      if (role === 'step-down' && stepIdx < steps.length - 1) {
        [steps[stepIdx + 1], steps[stepIdx]] = [steps[stepIdx], steps[stepIdx + 1]];
        renderStoredCommandsModal();
        focusStoredCommandInput(stepIdx + 1, 0);
        return;
      }
      const cmdContainer = btn.closest('[data-cmd-index]');
      if (!cmdContainer) return;
      const cmdIdx = Number(cmdContainer.dataset.cmdIndex);
      if (Number.isNaN(cmdIdx)) return;
      step.commands = Array.isArray(step.commands) ? step.commands : [];
      if (role === 'cmd-delete') {
        step.commands.splice(cmdIdx, 1);
        if (!step.commands.length) {
          steps.splice(stepIdx, 1);
        }
        renderStoredCommandsModal();
        return;
      }
      if (role === 'cmd-up' && cmdIdx > 0) {
        [step.commands[cmdIdx - 1], step.commands[cmdIdx]] = [step.commands[cmdIdx], step.commands[cmdIdx - 1]];
        renderStoredCommandsModal();
        focusStoredCommandInput(stepIdx, cmdIdx - 1);
        return;
      }
      if (role === 'cmd-down' && cmdIdx < step.commands.length - 1) {
        [step.commands[cmdIdx + 1], step.commands[cmdIdx]] = [step.commands[cmdIdx], step.commands[cmdIdx + 1]];
        renderStoredCommandsModal();
        focusStoredCommandInput(stepIdx, cmdIdx + 1);
      }
    });
  }
  const saveBtn = document.getElementById('stored-commands-save');
  if (saveBtn) saveBtn.addEventListener('click', saveStoredCommandsFromModal);
  modalEl.addEventListener('hidden.bs.modal', resetStoredCommandsModal);
}

function showStatusDot(pid, state) {
  // state: 'saved' | 'error'
  let el = document.getElementById('save-status-' + pid);
  if (!el) return;
  el.textContent = state === 'saved' ? '●' : '⚠';
  el.className = state === 'saved' ? 'text-success ms-2 small' : 'text-danger ms-2 small';
  if (state === 'saved') {
    setTimeout(() => { if (el) el.textContent = ''; }, 1600);
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
        ${(function () {
      const startSteps = normalizeStartCommandSteps(v.start_commands || []);
      const startSummary = formatStartCommandsSummary(startSteps);
      const startTooltip = formatStartCommandsTooltip(startSteps);
      const startTitleAttr = escHtml(startTooltip).replace(/\n/g, '&#10;');
      const startDataValue = escHtml(encodeStartCommandsValue(startSteps));
      const pidLiteral = JSON.stringify(String(p.id));
      return `
        <div class="col-md-4">
          <label class="form-label">Start Commands</label>
          <div class="d-flex align-items-center gap-2 mb-2">
            <button class="btn btn-sm btn-outline-primary flex-shrink-0" type="button" onclick='openStartCommandsManager(${pidLiteral},${i})'>Manage</button>
            <div id="vm-${p.id}-${i}-start-summary" class="small text-muted flex-grow-1" title="${startTitleAttr}">${escHtml(startSummary)}</div>
          </div>
          <input type="hidden" id="vm-${p.id}-${i}-start-data" value="${startDataValue}">
        </div>`;
    })()}
        <div class="row gx-2 mb-2">
          <div class="col-6">
          <label class="form-label" title="Optional Username appended to notes">VM User (optional)</label>
          <input type="text" id="vm-${p.id}-${i}-user" class="form-control form-control-sm" value="${(v.vm_user ?? '')}" placeholder="Optional user" title="Optional Username appended to notes" oninput="debounceVmSave('${p.id}', ${i})" />
          </div>
          <div class="col-6">
          <label class="form-label" title="Optional Password appended to notes">VM Pass (optional)</label>
          <input type="text" id="vm-${p.id}-${i}-pass" class="form-control form-control-sm" value="${(v.vm_pass ?? '')}" placeholder="Optional pass" title="Optional Password appended to notes" oninput="debounceVmSave('${p.id}', ${i})" />
          </div>
        </div>
        <div class="col-md-4">
          <label class="form-label">Stored Commands</label>
          ${(function () {
      const storedSteps = normalizeStartCommandSteps(v.stored_commands || []);
      const storedSummary = formatStartCommandsSummary(storedSteps);
      const storedTooltip = formatStartCommandsTooltip(storedSteps);
      const storedTitleAttr = escHtml(storedTooltip).replace(/\n/g, '&#10;');
      const storedDataValue = escHtml(encodeStartCommandsValue(storedSteps));
      const pidLiteralStored = JSON.stringify(String(p.id));
      return `
          <div class="d-flex align-items-center gap-2 mb-2">
            <button class="btn btn-sm btn-outline-primary flex-shrink-0" type="button" onclick='openStoredCommandsManager(${pidLiteralStored},${i})'>Manage</button>
            <div id="vm-${p.id}-${i}-stored-summary" class="small text-muted flex-grow-1" title="${storedTitleAttr}">${escHtml(storedSummary)}</div>
          </div>
          <input type="hidden" id="vm-${p.id}-${i}-stored-data" value="${storedDataValue}">`;
    })()}
        </div>
    <div class="col-md-4">
          <label class="form-label">Internal Network Adaptors</label>
          <div class="d-flex gap-2 mb-2">
            <input class="form-control form-control-sm" id="vm-${p.id}-${i}-nets-input" placeholder="Add adaptor" title="Internal network adaptor base name" oninput="onAdaptorInput('${p.id}', ${i}, this)" onkeydown="onAdaptorKeydown('${p.id}', ${i}, event)" />
            <button id="btn-add-net-${p.id}-${i}" class="btn btn-sm btn-outline-primary" onclick="addListItem('vm-${p.id}-${i}-nets-list','vm-${p.id}-${i}-nets-input')" disabled>Add</button>
          </div>
          <ul class="list-group list-group-sm" id="vm-${p.id}-${i}-nets-list">
            ${(v.internal_network_adaptors || v.internal_network_adapters || []).map((c, idx) => listItemTemplate(`vm-${p.id}-${i}-nets-list`, c, idx)).join('')}
          </ul>
        </div>
  <div class="col-12"><div class="small text-muted" id="vm-save-status-${p.id}-${i}"></div></div>
      </div>
    </div>
  `).join('');
  const pendingStore = getMaterialPendingStore(p.id);
  const pendingOptions = pendingStore.length
    ? pendingStore.map(entry => {
      const optValue = escHtml(entry.key);
      const optTitle = escHtml(entry.relativePath || entry.file?.name || entry.display || '');
      const optLabel = escHtml(entry.display || '');
      return `<option value="${optValue}" title="${optTitle}">${optLabel}</option>`;
    }).join('')
    : '<option value="" disabled>No pending files</option>';
  const pendingFiles = getPendingMaterialFiles(p.id);
  const pendingCount = pendingFiles.length;
  const pendingFolderCount = pendingFiles.folderCount || 0;
  const pendingSummary = pendingCount ? `${pendingCount} item${pendingCount === 1 ? '' : 's'} selected${pendingFolderCount ? ` (${pendingFolderCount} from folders)` : ''}` : '';
  const pendingFolderSummary = pendingFolderCount ? `${pendingFolderCount} file${pendingFolderCount === 1 ? '' : 's'} in folder` : '';
  const existingOptions = (p.materials || []).map(m => {
    const label = escHtml(m);
    return `<option value="${label}" title="${label}">${label}</option>`;
  }).join('');
  const hasPending = pendingCount > 0;
  const hasMaterials = Array.isArray(p.materials) && p.materials.length > 0;
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
          <button class="btn btn-sm btn-outline-primary" onclick="duplicateProject('${p.id}')">Duplicate</button>
          <button class="btn btn-sm btn-outline-secondary" data-remote-disable="export" data-remote-tooltip="Export is disabled when app is running in remote mode." onclick="openExportOptions('${p.id}')">Export</button>
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
            <div class="col-md-3">
              <label class="form-label" title="Proxmox node name (leave empty to auto-detect from URL)">Node Name</label>
              <input id="cfg-${p.id}-proxmox_node" class="form-control form-control-sm" value="${p.proxmox_node || ''}" placeholder="(auto)" title="Explicit Proxmox node name for export validation" oninput="debounceProjectSave('${p.id}','proxmox_node')" />
            </div>
            <div class="col-12"><hr class="my-3"/></div>
            <div class="col-md-9">
              <label class="form-label" title="Base URL to the CTFd platform">CTFd URL</label>
              <input id="cfg-${p.id}-challenge_url" class="form-control form-control-sm" value="${p.challenge_url || ''}" placeholder="https://ctfd.example.com" title="CTFd platform URL" oninput="debounceProjectSave('${p.id}','challenge_url')" />
            </div>
            <div class="col-md-3">
              <label class="form-label" title="CTFd platform port">CTFd Port</label>
              <input id="cfg-${p.id}-challenge_port" type="number" class="form-control form-control-sm" value="${p.challenge_port ?? 443}" placeholder="443" title="CTFd port" oninput="debounceProjectSave('${p.id}','challenge_port')" />
            </div>
            <div class="col-12"><hr class="my-3"/></div>
            <div class="col-md-6">
              <label class="form-label" title="Number of student/participant instances">Number of VM Clones to Create</label>
              <input id="cfg-${p.id}-instances" type="number" min="1" class="form-control form-control-sm" value="${p.instances ?? 10}" oninput="onInstancesChange('${p.id}'); debounceProjectSave('${p.id}','instances')" onchange="onInstancesChange('${p.id}'); debounceProjectSave('${p.id}','instances')" title="Total instances to provision" />
            </div>
            <div class="col-md-6">
              <label class="form-label" title="Suffix inserted before the instance index (letters and dashes)">Project Tag</label>
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
              <div class="d-flex justify-content-between align-items-end mb-2">
                <label class="form-label mb-0" title="One credential pair per instance">Credentials (username / password)</label>
                <div class="d-flex align-items-center gap-2">
                  <label class="form-label mb-0 small text-muted" style="white-space: nowrap;">Number of VM Clones/Users:</label>
                  <input type="number" id="cred-${p.id}-instances" min="1" class="form-control form-control-sm" style="width: 70px;" value="${p.instances ?? 10}" 
                    oninput="document.getElementById('cfg-${p.id}-instances').value = this.value; onInstancesChange('${p.id}'); debounceProjectSave('${p.id}','instances')" 
                    onchange="document.getElementById('cfg-${p.id}-instances').value = this.value; onInstancesChange('${p.id}'); debounceProjectSave('${p.id}','instances')" />
                </div>
              </div>
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
          <div class="d-flex flex-column gap-2">
            <div class="d-flex align-items-center gap-2 flex-wrap">
              <input id="file-${p.id}" type="file" class="material-input-hidden" title="Select one or more files" multiple onchange="onMaterialSelectionChange('${p.id}')" />
              <button type="button" class="btn btn-outline-secondary btn-sm" onclick="openMaterialPicker('${p.id}','file')">Choose Files</button>
              <input id="folder-${p.id}" type="file" class="material-input-hidden" title="Choose a folder to import all files within" aria-label="Choose folder" webkitdirectory directory multiple onchange="onMaterialSelectionChange('${p.id}')" />
              <button type="button" class="btn btn-outline-secondary btn-sm" onclick="openMaterialPicker('${p.id}','folder')">Choose Folder</button>
            </div>
            <div class="row g-3 mt-1">
              <div class="col-12 col-lg-6">
                <label class="form-label small text-uppercase text-muted mb-1">Pending Uploads</label>
                <div class="d-flex gap-2 align-items-start flex-wrap">
                  <select id="mat-pending-${p.id}" class="form-select form-select-sm material-select" size="6" multiple onchange="onPendingMaterialsSelectionChange('${p.id}')">${pendingOptions}</select>
                  <div class="btn-group-vertical btn-group-sm flex-shrink-0" role="group" aria-label="Pending uploads actions">
                    <button id="btn-remove-pending-${p.id}" type="button" class="btn btn-outline-secondary" onclick="removeSelectedPendingMaterials('${p.id}')" disabled>Remove Selected</button>
                    <button id="btn-clear-mat-${p.id}" type="button" class="btn btn-outline-secondary" onclick="clearMaterialSelection('${p.id}')" ${hasPending ? '' : 'disabled'}>Clear All</button>
                  </div>
                </div>
                <div class="d-flex align-items-center justify-content-between gap-2 mt-1 flex-wrap">
                  <small id="mat-selection-summary-${p.id}" class="text-muted">${pendingSummary}</small>
                  <small id="mat-folder-summary-${p.id}" class="text-muted">${pendingFolderSummary}</small>
                  <button id="btn-upload-mat-${p.id}" class="btn btn-sm btn-secondary ms-sm-auto" onclick="uploadMaterial('${p.id}')" ${hasPending ? '' : 'disabled'}>Upload</button>
                </div>
              </div>
              <div class="col-12 col-lg-6">
                <label class="form-label small text-uppercase text-muted mb-1">Existing Materials</label>
                <div class="d-flex gap-2 align-items-start flex-wrap">
                  <select id="mat-existing-${p.id}" class="form-select form-select-sm material-select" size="6" multiple onchange="onExistingMaterialsSelectionChange('${p.id}')">${existingOptions || '<option value="" disabled>No materials</option>'}</select>
                  <div class="btn-group-vertical btn-group-sm flex-shrink-0" role="group" aria-label="Existing materials actions">
                    <button id="btn-remove-existing-${p.id}" type="button" class="btn btn-outline-danger" onclick="removeSelectedExistingMaterials('${p.id}')" disabled>Remove Selected</button>
                    <button id="btn-remove-mat-${p.id}" type="button" class="btn btn-outline-danger" onclick="removeAllMaterials('${p.id}')" ${hasMaterials ? '' : 'disabled'}>Remove All</button>
                  </div>
                </div>
              </div>
            </div>
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
              <input id="cfg-${p.id}-proxmox_max_create_jobs" type="number" class="form-control form-control-sm" value="${p.proxmox_max_create_jobs ?? 5}" oninput="debounceProjectSave('${p.id}','proxmox_max_create_jobs')" />
            </div>
            <div class="col-md-3">
              <label class="form-label mb-1">Snapshot Delay (s)</label>
              <input id="cfg-${p.id}-proxmox_snapshot_delay_seconds" type="number" step="0.1" class="form-control form-control-sm" value="${p.proxmox_snapshot_delay_seconds ?? 5.0}" oninput="debounceProjectSave('${p.id}','proxmox_snapshot_delay_seconds')" />
            </div>
            <div class="col-md-3 mb-2">
              <label class="form-label mb-1">VM Update Delay (s)</label>
              <input id="cfg-${p.id}-proxmox_update_delay_seconds" type="number" step="0.1" class="form-control form-control-sm" value="${p.proxmox_update_delay_seconds ?? 0.5}" oninput="debounceProjectSave('${p.id}','proxmox_update_delay_seconds')" />
            </div>
            <div class="col-md-6 mb-2">
              <label class="form-label">Use Linked Clones</label>
              <div class="form-check form-switch mt-1">
                <input class="form-check-input" type="checkbox" id="cfg-${p.id}-proxmox_use_linked_clones" ${p.proxmox_use_linked_clones !== false ? 'checked' : ''} title="Linked clones share disks with the template; uncheck for full clones" onchange="debounceProjectSave('${p.id}','proxmox_use_linked_clones', 50)" />
                <label class="form-check-label" for="cfg-${p.id}-proxmox_use_linked_clones">Linked (unchecked = Full)</label>
              </div>
            </div>
            <div class="col-md-6 mb-2">
              <label class="form-label">Rollback ACL For Non-Viewable VMs</label>
              <div class="form-check form-switch mt-1">
                <input class="form-check-input" type="checkbox" id="cfg-${p.id}-proxmox_assign_rollback_on_non_viewable" ${p.proxmox_assign_rollback_on_non_viewable !== false ? 'checked' : ''} title="Grant AcostaRollback on pool-member VMs that are not marked user accessible" onchange="debounceProjectSave('${p.id}','proxmox_assign_rollback_on_non_viewable', 50)" />
                <label class="form-check-label" for="cfg-${p.id}-proxmox_assign_rollback_on_non_viewable">Enable AcostaRollback handoff</label>
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
  } catch { }
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
    } catch { }
  });
  // Initialize credential download button and controls state on first render
  setTimeout(() => { updateCredDownloadState(p.id); updateCredControls(p.id); }, 0);
  return col;
}


// --- Add from Server flow (Proxmox templates) ---
function proxCredKey(pid) { return `toolhub.session.proxmox.${pid}`; }
function readProxCreds(pid) { try { return JSON.parse(sessionStorage.getItem(proxCredKey(pid)) || '{}'); } catch { return {}; } }
function writeProxCreds(pid, obj) { try { sessionStorage.setItem(proxCredKey(pid), JSON.stringify({ username: obj.username || '', password: obj.password || '' })); } catch { } }
function readPersistProxCreds(pid) {
  try {
    if (window.CREDS && typeof CREDS.readPersistProxCreds === 'function') return CREDS.readPersistProxCreds(pid) || {};
  } catch { }
  return {};
}
function readBestProxCreds(pid) {
  const sess = readProxCreds(pid) || {};
  const persisted = readPersistProxCreds(pid) || {};
  return {
    username: (sess.username || persisted.username || ''),
    password: (sess.password || persisted.password || ''),
  };
}
function proxMetaKey(pid) { return `toolhub.session.proxmox.meta.${pid}`; }
function writeProxMeta(pid, obj) { try { sessionStorage.setItem(proxMetaKey(pid), JSON.stringify(obj || {})); } catch { } }
function normalizeUrl(s) { if (!s) return ''; return /^https?:\/\//i.test(s) ? s : `https://${s}`; }

function normalizeHost(raw) {
  if (!raw) return '';
  try {
    const str = String(raw).trim();
    const trimmed = str.replace(/^.*@/, '');
    if (/^https?:\/\//i.test(trimmed)) {
      const u = new URL(trimmed);
      return (u.hostname || '').split(':')[0].toLowerCase();
    }
    return trimmed.split(/[/:]/)[0].toLowerCase();
  } catch {
    return '';
  }
}

function hostRoot(host) {
  if (!host) return '';
  try { return String(host).split('.')[0].toLowerCase(); } catch { return ''; }
}

function deriveAfsCurrentNode(pid, templates, urlBase) {
  const proj = (window.PROJ_CACHE || {})[pid] || {};
  const hostFull = normalizeHost(urlBase || proj.proxmox_url || '');
  const hostPrefix = hostRoot(hostFull);
  const tplNodes = Array.isArray(templates) ? templates.map(t => String(t.node || '')) : [];
  const tplLower = tplNodes.map(n => n.toLowerCase());

  const mapping = proj.proxmox_node_host_map || {};
  for (const [node, target] of Object.entries(mapping)) {
    const mappedHost = normalizeHost(target);
    const mappedRoot = hostRoot(mappedHost);
    if (mappedHost && hostFull && mappedHost === hostFull) return String(node);
    if (mappedRoot && hostPrefix && mappedRoot === hostPrefix) return String(node);
  }

  const sshHost = normalizeHost(proj.proxmox_ssh_host || '');
  const sshRoot = hostRoot(sshHost);
  if (sshRoot) {
    const matchIdx = tplLower.findIndex(n => n === sshRoot);
    if (matchIdx !== -1) return tplNodes[matchIdx];
  }

  if (hostPrefix) {
    const matchIdx = tplLower.findIndex(n => n === hostPrefix);
    if (matchIdx !== -1) return tplNodes[matchIdx];
  }

  const uniques = Array.from(new Set(tplNodes.filter(Boolean)));
  if (uniques.length === 1) return uniques[0];
  return hostPrefix || '';
}

function setAfsLoading(isLoading) {
  const btn = document.getElementById('afs-fetch');
  const spinner = document.getElementById('afs-fetch-spinner');
  const label = document.getElementById('afs-fetch-label');
  if (btn) {
    btn.disabled = !!isLoading;
    btn.setAttribute('aria-busy', isLoading ? 'true' : 'false');
  }
  if (spinner) spinner.classList.toggle('d-none', !isLoading);
  if (label) label.textContent = isLoading ? 'Fetching...' : 'Fetch';
}

function setAfsFeedback(kind, message) {
  const el = document.getElementById('afs-feedback');
  if (!el) return;
  const base = 'alert small py-2 px-3';
  if (!message) {
    el.textContent = '';
    el.className = `${base} d-none`;
    el.removeAttribute('role');
    return;
  }
  const clsMap = {
    info: 'alert-info',
    success: 'alert-success',
    warning: 'alert-warning text-dark',
    error: 'alert-danger',
  };
  const cls = clsMap[kind] || clsMap.info;
  el.textContent = message;
  el.className = `${base} ${cls}`;
  el.setAttribute('role', kind === 'error' ? 'alert' : 'status');
}

function describeAfsError(err) {
  if (!err) return 'Request failed. Check the credentials and try again.';
  const raw = (err && err.message) ? String(err.message) : String(err);
  const trimmed = (raw || '').trim();
  if (!trimmed) return 'Request failed. Check the credentials and try again.';
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && parsed.error) {
        return String(parsed.error).trim() || 'Request failed. Check the credentials and try again.';
      }
    } catch { }
  }
  if (/401|unauthorized|permission/i.test(trimmed)) {
    return 'Authentication failed. Confirm the username, password, and Proxmox realm.';
  }
  if (/ssl/i.test(trimmed)) {
    return 'SSL verification failed. Try disabling Verify SSL if using a self-signed certificate.';
  }
  return trimmed;
}

let AFS_CTX = { pid: null, templates: [], selected: new Set(), currentNode: '' };

function openAddFromServer(pid) {
  AFS_CTX = { pid, templates: [], selected: new Set(), currentNode: '' };
  // prefill from project cache and session creds
  const p = (window.PROJ_CACHE || {})[pid] || {};
  const modal = document.getElementById('addFromServerModal');
  if (!modal) { alert('Modal not found'); return; }
  const urlEl = document.getElementById('afs-url');
  const portEl = document.getElementById('afs-port');
  const verEl = document.getElementById('afs-verify');
  const uEl = document.getElementById('afs-username');
  const pwEl = document.getElementById('afs-password');
  const saveEl = document.getElementById('afs-save-creds');
  const list = document.getElementById('afs-list');
  const addBtn = document.getElementById('afs-add');
  const filterEl = document.getElementById('afs-filter');
  const filterGroup = document.getElementById('afs-filter-group');
  setAfsFeedback();
  if (urlEl) urlEl.value = p.proxmox_url || '';
  if (portEl) portEl.value = (p.proxmox_api_port ?? 8006);
  if (verEl) verEl.checked = (p.proxmox_verify_ssl !== false);
  const sess = readProxCreds(pid) || {};
  const persisted = readPersistProxCreds(pid) || {};
  if (uEl) uEl.value = sess.username || persisted.username || '';
  if (pwEl) pwEl.value = sess.password || persisted.password || '';
  if (saveEl) saveEl.checked = !!(persisted.username || persisted.password);

  // Prefer server-stored project secrets when available
  try {
    if (window.CREDS && typeof CREDS.fetchProjectSecrets === 'function') {
      CREDS.fetchProjectSecrets(pid).then(sec => {
        try {
          const prox = sec && sec.proxmox ? sec.proxmox : null;
          const su = (prox && prox.username) ? String(prox.username) : '';
          const sp = (prox && prox.password) ? String(prox.password) : '';
          if (saveEl) saveEl.checked = !!(prox && prox.saved);
          if (uEl && !uEl.value && su) uEl.value = su;
          if (pwEl && !pwEl.value && sp) pwEl.value = sp;
        } catch { }
      }).catch(() => { });
    }
  } catch { }
  if (list) { list.innerHTML = ''; list.style.display = 'none'; }
  if (addBtn) addBtn.disabled = true;
  if (filterEl) filterEl.value = '';
  if (filterGroup) filterGroup.style.display = 'none';
  setAfsLoading(false);
  // wire events (idempotent)
  try {
    document.getElementById('afs-fetch').onclick = fetchTemplatesForAFS;
    document.getElementById('afs-add').onclick = addSelectedTemplates;
    document.getElementById('afs-filter').oninput = renderAFSList;
  } catch { }
  // show modal
  try {
    const bs = window.bootstrap && window.bootstrap.Modal ? window.bootstrap.Modal : null;
    if (bs) bs.getOrCreateInstance(modal).show(); else modal.classList.add('show');
  } catch { }
}

async function fetchTemplatesForAFS() {
  const pid = AFS_CTX.pid; if (!pid) return;
  const p = (window.PROJ_CACHE || {})[pid] || {};
  const urlEl = document.getElementById('afs-url');
  const portEl = document.getElementById('afs-port');
  const verEl = document.getElementById('afs-verify');
  const uEl = document.getElementById('afs-username');
  const pwEl = document.getElementById('afs-password');
  const saveEl = document.getElementById('afs-save-creds');
  const list = document.getElementById('afs-list');
  const filterGroup = document.getElementById('afs-filter-group');
  const urlBase = normalizeUrl((urlEl?.value || '').trim());
  const apiPort = Number(portEl?.value || 8006) || 8006;
  if (!urlBase) {
    setAfsFeedback('warning', 'Enter the Proxmox URL before fetching.');
    try { showToast('Enter Proxmox URL', 'warning'); } catch { alert('Enter Proxmox URL'); }
    return;
  }
  const baseUrl = urlBase.replace(/\/$/, '') + (apiPort ? '' : ''); // API endpoints include /api2/json internally
  const body = { baseUrl, apiPort, verifySSL: !!(verEl?.checked), username: (uEl?.value || '').trim() || undefined, password: (pwEl?.value || '') || undefined };
  setAfsLoading(true);
  setAfsFeedback('info', 'Connecting to Proxmox…');
  let fetchError = null;
  if (list) {
    list.style.display = '';
    list.innerHTML = '<div class="text-muted small p-2"><span class="spinner-border spinner-border-sm me-2" role="status" aria-hidden="true"></span>Fetching templates...</div>';
  }
  try {
    await runQueued(`Fetch templates for ${pid}`, async () => {
      try {
        const resp = await http('POST', '/api/proxmox/templates', body);
        const items = Array.isArray(resp?.templates) ? resp.templates : [];
        AFS_CTX.templates = items.map(t => ({ node: String(t.node || ''), vmid: Number(t.vmid || 0), name: String(t.name || ''), bridges: Array.isArray(t.bridges) ? t.bridges.map(b => String(b || '')) : [] }));
        AFS_CTX.currentNode = deriveAfsCurrentNode(pid, AFS_CTX.templates, urlBase);
        // persist creds and meta for VM Manager prefill
        writeProxCreds(pid, { username: body.username || '', password: body.password || '' });
        writeProxMeta(pid, { url: urlBase, apiPort: apiPort, sshPort: Number(p.proxmox_ssh_port || 22) || 22 });
        // Optional: persist creds per project across sessions (server-side project secrets)
        try {
          const wantsPersist = !!(saveEl && saveEl.checked);
          if (window.CREDS && typeof CREDS.setPersistProxCreds === 'function') {
            if (wantsPersist) CREDS.setPersistProxCreds(pid, body.username || '', body.password || '', true);
            else CREDS.setPersistProxCreds(pid, '', '', false);
          }
        } catch { }
        if (filterGroup) filterGroup.style.display = '';
        if (list) list.style.display = '';
        renderAFSList();
        const count = AFS_CTX.templates.length;
        if (count > 0) {
          setAfsFeedback('success', `Fetched ${count} template${count === 1 ? '' : 's'} successfully.`);
        } else {
          setAfsFeedback('warning', 'Connected successfully, but no templates were returned.');
        }
      } catch (err) {
        fetchError = err;
        throw err;
      }
    }, { projectId: pid });
  } catch (e) {
    fetchError = fetchError || e;
  } finally {
    setAfsLoading(false);
  }
  if (fetchError) {
    const msg = describeAfsError(fetchError);
    if (list) {
      list.innerHTML = `<div class="text-danger small p-2">${escHtml(msg)}</div>`;
      list.style.display = '';
    }
    if (filterGroup) filterGroup.style.display = 'none';
    const addBtn = document.getElementById('afs-add');
    if (addBtn) addBtn.disabled = true;
    setAfsFeedback('error', msg);
  }
}

function renderAFSList() {
  const list = document.getElementById('afs-list');
  const addBtn = document.getElementById('afs-add');
  const filter = (document.getElementById('afs-filter')?.value || '').trim().toLowerCase();
  const items = (AFS_CTX.templates || []).filter(t => {
    if (!filter) return true;
    const s = `${t.name} ${t.vmid} ${t.node}`.toLowerCase();
    return s.includes(filter);
  });
  if (!items.length) { if (list) list.innerHTML = '<div class="text-muted small p-2">No templates found.</div>'; if (addBtn) addBtn.disabled = true; return; }
  const currentNode = String(AFS_CTX.currentNode || '').toLowerCase();
  const hasCurrent = currentNode && (AFS_CTX.templates || []).some(t => String(t.node || '').toLowerCase() === currentNode);
  const restrict = !!hasCurrent;
  const ordered = items.slice().sort((a, b) => {
    if (restrict) {
      const aPreferred = String(a.node || '').toLowerCase() === currentNode;
      const bPreferred = String(b.node || '').toLowerCase() === currentNode;
      if (aPreferred !== bPreferred) return aPreferred ? -1 : 1;
    }
    const nameCmp = String(a.name || '').localeCompare(String(b.name || ''));
    if (nameCmp !== 0) return nameCmp;
    return Number(a.vmid || 0) - Number(b.vmid || 0);
  });
  let hasPreferredInFilter = false;
  const rows = ordered.map(t => {
    const key = `${t.node}|${t.vmid}|${t.name}`;
    const checked = AFS_CTX.selected.has(key) ? 'checked' : '';
    const bridges = (t.bridges || []).join(', ');
    const nodeName = String(t.node || '');
    const isPreferred = restrict && nodeName.toLowerCase() === currentNode;
    if (isPreferred) hasPreferredInFilter = true;
    const disableRow = restrict && !isPreferred;
    if (disableRow) AFS_CTX.selected.delete(key);
    const reason = disableRow ? (AFS_CTX.currentNode ? `Template is on node ${nodeName}. Current node is ${AFS_CTX.currentNode}.` : `Template is on node ${nodeName}.`) : '';
    const tooltip = disableRow ? ` title="${escHtml(reason)}"` : '';
    const labelCls = `list-group-item d-flex align-items-center gap-2${disableRow ? ' opacity-50' : ''}`;
    const checkboxAttrs = `type="checkbox" class="form-check-input me-2" data-key="${key}" ${checked}${disableRow ? ' disabled' : ''}`;
    const nodeBadgeCls = disableRow ? 'badge bg-light text-dark border' : 'badge bg-secondary';
    const trailingBits = [];
    if (bridges) trailingBits.push(`<span class="small text-muted">bridges: ${escHtml(bridges)}</span>`);
    if (disableRow) trailingBits.push('<span class="badge bg-warning text-dark">Other node</span>');
    const trailing = trailingBits.length ? `<span class="ms-auto d-flex align-items-center gap-2 flex-wrap">${trailingBits.join('')}</span>` : '';
    return `<label class="${labelCls}"${tooltip}>
      <input ${checkboxAttrs} />
      <span class="${nodeBadgeCls}">${escHtml(nodeName || 'unknown')}</span>
      <strong>${escHtml(t.name)}</strong>
      <span class="text-muted">#${t.vmid}</span>
      ${trailing || ''}
    </label>`;
  }).join('');
  if (list) {
    let notice = '';
    if (restrict) {
      const info = hasPreferredInFilter ? 'Templates on other nodes are disabled.' : 'No templates on the current node match this filter.';
      notice = `<div class="small text-muted px-3 py-2 border-bottom">Current node: <strong>${escHtml(AFS_CTX.currentNode)}</strong>. ${escHtml(info)}</div>`;
    }
    list.innerHTML = `${notice}<div class="list-group list-group-flush">${rows}</div>`;
  }
  // wire checkbox changes
  try {
    if (!list) return;
    (list.querySelectorAll('input[type=checkbox]') || []).forEach(cb => {
      cb.onchange = (e) => {
        const k = e.target.getAttribute('data-key');
        if (e.target.checked) AFS_CTX.selected.add(k); else AFS_CTX.selected.delete(k);
        if (addBtn) addBtn.disabled = AFS_CTX.selected.size === 0;
      };
    });
  } catch { }
  if (addBtn) addBtn.disabled = AFS_CTX.selected.size === 0;
}

async function addSelectedTemplates() {
  const pid = AFS_CTX.pid; if (!pid) return;
  const selected = Array.from(AFS_CTX.selected || []);
  if (!selected.length) return;
  // For each selection, add a VM using the template name and set vmid
  // We will batch sequentially to keep API simple
  const sanitizeAdaptor = (s) => {
    // Letters only, up to 8 chars per UI rules
    try { return (String(s || '').replace(/[^A-Za-z]/g, '').slice(0, 8)); } catch { return ''; }
  };
  // collect a mapping from name->sanitized adaptors derived from bridges
  const adaptorByName = {};
  for (const k of selected) {
    const parts = String(k).split('|');
    const node = parts[0];
    const vmid = Number(parts[1] || 0) || 0;
    const name = parts.slice(2).join('|');
    if (!name || !vmid) continue;
    try {
      const t = (AFS_CTX.templates || []).find(x => x.node === node && x.vmid === vmid && x.name === name);
      if (t && Array.isArray(t.bridges)) {
        const sans = t.bridges.map(b => sanitizeAdaptor(b)).filter(x => !!x);
        if (sans.length) adaptorByName[name] = Array.from(new Set(sans));
      }
    } catch { }
    try {
      await http('POST', `/api/projects/${pid}/vms`, { name });
    } catch (e) {
      // if already exists, continue to update
    }
    try {
      const patch = { vmid };
      if (adaptorByName[name] && adaptorByName[name].length) {
        // Support both naming variants during patch creation
        patch.internal_network_adaptors = adaptorByName[name];
        patch.internal_network_adapters = adaptorByName[name];
      }
      await http('PATCH', `/api/projects/${pid}/vms/${encodeURIComponent(name)}`, patch);
    } catch (e) {
      try { showToast(`Failed to set VMID for ${name}: ${e.message}`, 'danger'); } catch { }
    }
  }
  try {
    const modal = document.getElementById('addFromServerModal');
    const bs = window.bootstrap && window.bootstrap.Modal ? window.bootstrap.Modal : null;
    if (bs) { const inst = bs.getOrCreateInstance(modal); inst.hide(); }
  } catch { }
  // reload
  try { await loadProjects(); } catch { loadProjects(); }
  try {
    if (window.shell && typeof window.shell.refreshSidebar === 'function') {
      window.shell.refreshSidebar('config');
    }
  } catch { }
  try { showToast('Templates added.', 'success'); } catch { }
}

// Rename project from the header input (on blur)
async function renameProject(id, newName) {
  const name = String(newName || '').trim();
  if (!name) { try { showToast('Project name cannot be empty.', 'danger'); } catch { } return; }
  try {
    try { (window.shell && shell.logInfo) ? shell.logInfo(`Config: renaming project ${id} → ${name}`) : console.log('Renaming project', id, '->', name); } catch { }
    await http('PATCH', `/api/projects/${id}`, { name });
    loadProjects();
    try { if (window.shell && shell.refreshSidebar) shell.refreshSidebar('config'); } catch { }
    try { (window.shell && shell.logSuccess) ? shell.logSuccess('Config: project name saved') : console.log('Project name saved'); } catch { }
  } catch (e) {
    try { showToast('Error renaming project: ' + (e?.message || e), 'danger'); } catch { }
  }
}

async function duplicateProject(id) {
  try {
    try { (window.shell && shell.logInfo) ? shell.logInfo(`Config: duplicating project ${id}…`) : console.log('Duplicating project', id); } catch { }
    const res = await http('POST', `/api/projects/${encodeURIComponent(id)}/duplicate`);
    const newId = res && (res.id || res.pid) ? (res.id || res.pid) : '';
    const newName = res && typeof res.name === 'string' ? res.name : '';
    try { if (newId && window.shell && shell.setCurrentProjectId) shell.setCurrentProjectId(newId); } catch { }
    await loadProjects();
    try { if (window.shell && shell.refreshSidebar) shell.refreshSidebar('config'); } catch { }
    const tail = newName ? ` as ${newName}` : '';
    try { showToast(`Project duplicated${tail}.`, 'success'); } catch { }
  } catch (e) {
    try { showToast('Failed to duplicate project: ' + (e?.message || e), 'danger'); } catch { }
    try { (window.shell && shell.logError) ? shell.logError('Config: duplicate project failed: ' + (e?.message || e)) : console.error('Duplicate project failed:', e); } catch { }
  }
}

// Delete a project from the header button
async function deleteProject(id) {
  try {
    const ok = window.confirm('Delete this project? This cannot be undone.');
    if (!ok) return;
    try { (window.shell && shell.logInfo) ? shell.logInfo(`Config: deleting project ${id}…`) : console.log('Deleting project', id); } catch { }
    await http('DELETE', `/api/projects/${encodeURIComponent(id)}`);
    try { showToast('Project deleted.', 'success'); } catch { }
    // Clear current selection if it was this project
    try {
      if (window.shell && shell.getCurrentProjectId && shell.setCurrentProjectId) {
        if (String(shell.getCurrentProjectId() || '') === String(id)) shell.setCurrentProjectId('');
      }
    } catch { }
    // Refresh views
    try { await loadProjects(); } catch { loadProjects(); }
    try { if (window.shell && shell.refreshSidebar) shell.refreshSidebar('config'); } catch { }
  } catch (e) {
    try { showToast('Failed to delete project: ' + (e?.message || e), 'danger'); } catch { }
  }
}

function renderInstancesPreview(p) {
  const inst = Number(p.instances || 0);
  const tag = String(p.tag || '').trim();
  const vms = p.vms || [];
  if (!inst || !vms.length) {
    return '<div class="text-muted">Add VMs and set Instances to preview instance names.</div>';
  }
  const managers = ['vm', 'guacamole', 'pools', 'keycloak', 'rocketchat', 'ctfd'];
  const statuses = (p.instance_statuses || []);
  const statusMap = new Map(statuses.map(s => [Number(s.index || 0), s]));
  let html = '<div class="table-responsive"><table class="table table-sm align-middle"><thead><tr><th>#</th><th>Preview VM Names</th><th>Preview Adaptors</th><th>Managers</th></tr></thead><tbody>';
  for (let i = 1; i <= inst; i++) {
    const suffix = `${tag}${i}`;
    const names = vms.map(v => `${v.name}${suffix}`);
    const adaptors = (vms.flatMap(v => (v.internal_network_adaptors || v.internal_network_adapters || []).map(a => `${a}${suffix}`)));
    const st = statusMap.get(i) || {};
    const mgr = st.managers || {};
    const mgrBadges = managers.map(m => badgeForStatus(m, mgr[m])).join(' ');
    html += `<tr><td>${i}</td><td>${names.map(escHtml).join('<br>')}</td><td>${adaptors.map(escHtml).join('<br>') || '<span class="text-muted">—</span>'}</td><td>${mgrBadges}</td></tr>`;
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
      const valid = /^[A-Za-z]{0,8}$/.test(v);
      inputEl.classList.toggle('is-invalid', !valid);
      if (!valid) showToast('Invalid adaptor name: letters only, up to 8 characters.', 'danger');
    }
  } catch { }
  // Auto-save after edits (debounced)
  try {
    const m = String(listId).match(/^vm-(.+)-(\d+)-/);
    if (m) debounceVmSave(m[1], Number(m[2]), 600);
  } catch { }
}

// Handle Remove button clicks for dynamic lists
function removeListItem(listId, btnEl) {
  try {
    const li = btnEl && (btnEl.closest ? btnEl.closest('li') : null);
    if (li) li.remove();
  } catch { }
  try {
    const m = String(listId).match(/^vm-(.+)-(\d+)-/);
    if (m) debounceVmSave(m[1], Number(m[2]), 200);
  } catch { }
}

function onVmNameInput(pid) {
  try {
    const input = document.getElementById(`vm-${pid}`);
    const btn = document.getElementById(`btn-add-vm-${pid}`);
    const val = (input?.value || '').trim();
    const ok = !!val && isValidVmName(val);
    if (input) input.classList.toggle('is-invalid', !ok && val.length > 0);
    if (btn) btn.disabled = !ok;
  } catch { }
}

function onAdaptorInput(pid, idx, el) {
  try {
    const input = el || document.getElementById(`vm-${pid}-${idx}-nets-input`);
    const btn = document.getElementById(`btn-add-net-${pid}-${idx}`);
    const v = (input?.value || '').trim();
    const ok = /^[A-Za-z]{1,8}$/.test(v);
    if (input) input.classList.toggle('is-invalid', !ok && v.length > 0);
    if (btn) btn.disabled = !ok;
  } catch { }
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
  } catch { }
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
    const existing = Array.from(list.querySelectorAll('input')).map(i => (i.value || '').trim().toLowerCase());
    if (existing.includes(val.toLowerCase())) {
      try { showToast('Adaptor already added for this VM.', 'warning'); } catch { }
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
  } catch { }
  // Disable Add button until next valid input
  try {
    if (String(listId).includes('-nets-list')) {
      const [_, pid, idx] = String(listId).match(/^vm-(.+)-(\d+)-nets-list$/) || [];
      if (pid && idx) {
        const btn = document.getElementById(`btn-add-net-${pid}-${idx}`);
        if (btn) btn.disabled = true;
      }
    }
  } catch { }
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
    try { shell.beginActionContext('Add VM'); } catch { }
    try { (window.shell && shell.logInfo) ? shell.logInfo(`Config: adding VM ${name}`) : console.log('Adding VM', name); } catch { }
    try { shell.step('Sending POST request'); } catch { }
    await http('POST', `/api/projects/${id}/vms`, { name });
    try { shell.step('Server acknowledged VM add'); } catch { }
    el.value = '';
    el.classList.remove('is-invalid');
    const btn = document.getElementById(`btn-add-vm-${id}`);
    if (btn) btn.disabled = true;
    try { shell.step('Cleared form input'); } catch { }
    loadProjects();
    try { shell.step('Reloaded projects'); } catch { }
    try { if (window.shell && shell.refreshSidebar) shell.refreshSidebar('config'); } catch { }
    try { shell.step('Sidebar refresh requested'); } catch { }
    try { (window.shell && shell.logSuccess) ? shell.logSuccess('Config: VM added') : console.log('VM added'); } catch { }
    try { shell.endActionContext(true); } catch { }
  }
  catch (e) { try { showToast('Error adding VM: ' + e.message, 'danger'); } catch { alert('Error adding VM: ' + e.message); } try { (window.shell && shell.logError) ? shell.logError('Config: add VM failed: ' + e.message) : console.error('Add VM failed:', e); } catch { } }
  try { shell.endActionContext(false); } catch { }
}

async function removeVM(id, name) {
  try {
    try { (window.shell && shell.logWarn) ? shell.logWarn(`Config: removing VM ${name}`) : console.warn('Removing VM', name); } catch { }
    await http('DELETE', `/api/projects/${id}/vms/${encodeURIComponent(name)}`);
    loadProjects();
    try { if (window.shell && shell.refreshSidebar) shell.refreshSidebar('config'); } catch { }
    try { (window.shell && shell.logSuccess) ? shell.logSuccess('Config: VM removed') : console.log('VM removed'); } catch { }
  }
  catch (e) { alert('Error removing VM: ' + e.message); try { (window.shell && shell.logError) ? shell.logError('Config: remove VM failed: ' + e.message) : console.error('Remove VM failed:', e); } catch { } }
}

async function saveVM(id, name, fields, opts = {}) {
  const silent = !!opts.silent;
  try {
    if (!silent) { try { (window.shell && shell.logInfo) ? shell.logInfo(`Config: saving VM ${name}`) : console.log('Saving VM', name); } catch { } }
    await http('PATCH', `/api/projects/${id}/vms/${encodeURIComponent(name)}`, fields);
    if (!silent) {
      loadProjects();
      try { if (window.shell && shell.refreshSidebar) shell.refreshSidebar('config'); } catch { }
      try { (window.shell && shell.logSuccess) ? shell.logSuccess('Config: VM saved') : console.log('VM saved'); } catch { }
    }
  }
  catch (e) {
    if (!silent) alert('Error saving VM: ' + e.message);
    try { (window.shell && shell.logError) ? shell.logError('Config: save VM failed: ' + e.message) : console.error('Save VM failed:', e); } catch { }
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
      try { (window.shell && shell.logSuccess) ? shell.logSuccess(`Config: VM renamed ${oldName} → ${newName}`) : console.log('VM renamed', oldName, '->', newName); } catch { }
    } catch (e) {
      alert('Error renaming VM: ' + e.message);
      try { (window.shell && shell.logError) ? shell.logError('Config: VM rename failed: ' + e.message) : console.error('VM rename failed:', e); } catch { }
      input.classList.add('d-none');
      disp.classList.remove('d-none');
      input.value = oldName;
    }
  }
}

function getMaterialInputs(pid) {
  return {
    files: document.getElementById(`file-${pid}`),
    folder: document.getElementById(`folder-${pid}`),
  };
}

function openMaterialPicker(pid, kind) {
  try {
    const input = document.getElementById(`${kind}-${pid}`);
    if (input) input.click();
  } catch { }
}

function getMaterialPendingStore(pid) {
  const key = String(pid ?? '');
  if (!window.MATERIAL_PENDING[key]) window.MATERIAL_PENDING[key] = [];
  return window.MATERIAL_PENDING[key];
}

function materialKeyFor(file, relPath) {
  const pathPart = relPath ? String(relPath) : '';
  return `${pathPart}::${file.name}::${file.size}::${file.lastModified}`;
}

function materialFormatSize(bytes) {
  const num = Number(bytes);
  if (!Number.isFinite(num) || num <= 0) return '';
  const units = ['bytes', 'KB', 'MB', 'GB', 'TB'];
  let value = num;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const precision = value < 10 && unitIndex > 0 ? 1 : 0;
  return `${value.toFixed(precision)} ${units[unitIndex]}`;
}

function getPendingMaterialFiles(pid) {
  const store = getMaterialPendingStore(pid);
  const files = store.map(entry => entry.file);
  const folderCount = store.reduce((count, entry) => count + (entry.relativePath ? 1 : 0), 0);
  files.folderCount = folderCount;
  return files;
}

function renderMaterialPending(pid) {
  const select = document.getElementById(`mat-pending-${pid}`);
  if (!select) return;
  const store = getMaterialPendingStore(pid);
  if (!store.length) {
    select.innerHTML = '<option value="" disabled>No pending files</option>';
  } else {
    const opts = store.map(entry => {
      const value = escHtml(entry.key);
      const title = escHtml(entry.relativePath || entry.file?.name || entry.display || '');
      const label = escHtml(entry.display || '');
      return `<option value="${value}" title="${title}">${label}</option>`;
    }).join('');
    select.innerHTML = opts;
  }
  onPendingMaterialsSelectionChange(pid);
}

function stageMaterialSelection(pid) {
  const inputs = getMaterialInputs(pid);
  const store = getMaterialPendingStore(pid);
  const existingKeys = new Set(store.map(entry => entry.key));
  const added = [];
  const pushFile = (file, relPath) => {
    if (!file) return;
    const key = materialKeyFor(file, relPath);
    if (existingKeys.has(key)) return;
    existingKeys.add(key);
    const baseLabel = relPath || file.name || 'unnamed';
    const sizeLabel = materialFormatSize(file.size);
    const display = sizeLabel ? `${baseLabel} (${sizeLabel})` : baseLabel;
    store.push({ key, file, display, relativePath: relPath || '', sortKey: baseLabel.toLowerCase() });
    added.push(key);
  };
  try {
    if (inputs.files?.files?.length) {
      Array.from(inputs.files.files).forEach(file => pushFile(file, ''));
    }
  } catch { }
  try {
    if (inputs.folder?.files?.length) {
      Array.from(inputs.folder.files).forEach(file => {
        const rel = file.webkitRelativePath || '';
        pushFile(file, rel);
      });
    }
  } catch { }
  if (inputs.files) {
    try { inputs.files.value = ''; } catch { }
  }
  if (inputs.folder) {
    try { inputs.folder.value = ''; } catch { }
  }
  if (added.length) {
    store.sort((a, b) => a.sortKey.localeCompare(b.sortKey));
  }
  return added.length;
}

function onPendingMaterialsSelectionChange(pid) {
  const select = document.getElementById(`mat-pending-${pid}`);
  const btn = document.getElementById(`btn-remove-pending-${pid}`);
  if (!btn) return;
  const store = getMaterialPendingStore(pid);
  if (!select || !store.length) {
    btn.disabled = true;
    return;
  }
  btn.disabled = select.selectedOptions.length === 0;
}

function removeSelectedPendingMaterials(pid) {
  const select = document.getElementById(`mat-pending-${pid}`);
  if (!select) return;
  const values = Array.from(select.selectedOptions || []).map(opt => opt.value).filter(Boolean);
  if (!values.length) {
    try { showToast('Select pending files to remove first.', 'warning'); } catch { alert('Select pending files to remove first.'); }
    return;
  }
  const store = getMaterialPendingStore(pid);
  const before = store.length;
  window.MATERIAL_PENDING[pid] = store.filter(entry => !values.includes(entry.key));
  renderMaterialPending(pid);
  updateMaterialSelectionSummary(pid, getPendingMaterialFiles(pid));
  onPendingMaterialsSelectionChange(pid);
  const after = getMaterialPendingStore(pid).length;
  if (after < before) {
    try { showToast('Removed selected pending files.', 'info'); } catch { alert('Removed selected pending files.'); }
  }
}

function onExistingMaterialsSelectionChange(pid) {
  const select = document.getElementById(`mat-existing-${pid}`);
  const btn = document.getElementById(`btn-remove-existing-${pid}`);
  if (!btn) return;
  if (!select || !select.options.length) {
    btn.disabled = true;
    return;
  }
  btn.disabled = select.selectedOptions.length === 0;
}

async function removeSelectedExistingMaterials(pid) {
  const select = document.getElementById(`mat-existing-${pid}`);
  if (!select) return;
  const names = Array.from(select.selectedOptions || []).map(opt => opt.value).filter(Boolean);
  if (!names.length) {
    try { showToast('Select materials to remove first.', 'warning'); } catch { alert('Select materials to remove first.'); }
    return;
  }
  const proj = (window.PROJ_CACHE || {})[pid] || {};
  const projectName = proj.name || pid;
  const count = names.length;
  const confirmMsg = `Remove ${count} selected material${count === 1 ? '' : 's'} from this project? This will delete the files from the server.`;
  if (!window.confirm(confirmMsg)) return;
  const errors = [];
  try {
    if (window.shell && typeof window.shell.beginActionContext === 'function') {
      window.shell.beginActionContext('Remove materials');
    }
  } catch { }
  try {
    if (window.shell && typeof window.shell.logWarn === 'function') {
      window.shell.logWarn(`Config: removing ${count} selected material${count === 1 ? '' : 's'} for ${projectName}`);
    }
  } catch { }
  const queueResult = await runQueued(`Remove selected materials for ${projectName}`, async () => {
    for (const fname of names) {
      try {
        try {
          if (window.shell && typeof window.shell.step === 'function') {
            window.shell.step(`Removing ${fname}`);
          }
        } catch { }
        await http('DELETE', `/api/projects/${pid}/materials/${encodeURIComponent(fname)}`);
      } catch (err) {
        errors.push({ name: fname, error: err });
      }
    }
  }, { projectId: pid });
  if (queueResult?.status === 'canceled' || queueResult?.status === 'skipped') {
    try { showToast('Material removal canceled.', 'warning'); } catch { alert('Material removal canceled.'); }
    try { if (window.shell && typeof window.shell.endActionContext === 'function') window.shell.endActionContext(false); } catch { }
    return;
  }
  try { await loadProjects(); } catch { loadProjects(); }
  try {
    if (window.shell && typeof window.shell.refreshSidebar === 'function') {
      window.shell.refreshSidebar('config');
    }
  } catch { }
  if (errors.length) {
    const failedNames = errors.map(e => e.name || 'unknown').join(', ');
    try { showToast(`Some materials failed to delete: ${failedNames}`, 'danger'); } catch { alert(`Some materials failed to delete: ${failedNames}`); }
    try {
      if (window.shell && typeof window.shell.logError === 'function') {
        window.shell.logError(`Config: remove materials failed for ${failedNames}`);
      }
    } catch { }
    try { if (window.shell && typeof window.shell.endActionContext === 'function') window.shell.endActionContext(false); } catch { }
    onExistingMaterialsSelectionChange(pid);
    return;
  }
  try { showToast('Selected materials removed.', 'success'); } catch { alert('Selected materials removed.'); }
  try {
    if (window.shell && typeof window.shell.logSuccess === 'function') {
      window.shell.logSuccess(`Config: removed selected materials for ${projectName}`);
    }
  } catch { }
  onExistingMaterialsSelectionChange(pid);
  const removeAllBtn = document.getElementById(`btn-remove-mat-${pid}`);
  if (removeAllBtn) removeAllBtn.disabled = !((window.PROJ_CACHE || {})[pid]?.materials || []).length;
  try { if (window.shell && typeof window.shell.endActionContext === 'function') window.shell.endActionContext(true); } catch { }
}

function collectMaterialFiles(pid) {
  return getPendingMaterialFiles(pid);
}

function updateMaterialSelectionSummary(pid, files) {
  const lbl = document.getElementById(`mat-selection-summary-${pid}`);
  const btn = document.getElementById(`btn-upload-mat-${pid}`);
  const folderLbl = document.getElementById(`mat-folder-summary-${pid}`);
  const clearBtn = document.getElementById(`btn-clear-mat-${pid}`);
  const count = files.length;
  const folderCount = files.folderCount || 0;
  if (btn) btn.disabled = count === 0;
  if (clearBtn) clearBtn.disabled = count === 0;
  if (folderLbl) folderLbl.textContent = folderCount ? `${folderCount} file${folderCount === 1 ? '' : 's'} in folder` : '';
  if (lbl) {
    if (!count) {
      lbl.textContent = '';
    } else {
      const base = `${count} item${count === 1 ? '' : 's'} selected`;
      lbl.textContent = folderCount ? `${base} (${folderCount} from folders)` : base;
    }
  }
}

function onMaterialSelectionChange(pid) {
  stageMaterialSelection(pid);
  renderMaterialPending(pid);
  const files = collectMaterialFiles(pid);
  updateMaterialSelectionSummary(pid, files);
}

function clearMaterialSelections(pid) {
  const inputs = getMaterialInputs(pid);
  try { if (inputs.files) inputs.files.value = ''; } catch { }
  try { if (inputs.folder) inputs.folder.value = ''; } catch { }
  window.MATERIAL_PENDING[pid] = [];
  renderMaterialPending(pid);
  updateMaterialSelectionSummary(pid, []);
  onPendingMaterialsSelectionChange(pid);
}

function clearMaterialSelection(pid) {
  clearMaterialSelections(pid);
  try { showToast('Material selection cleared.', 'info'); } catch { alert('Material selection cleared.'); }
}

async function uploadMaterial(id) {
  const files = collectMaterialFiles(id);
  if (!files.length) {
    try { showToast('Select files or a folder first.', 'warning'); } catch { alert('Select files or a folder first.'); }
    return;
  }
  const folderFiles = files.filter(file => file && (file.webkitRelativePath || '').length);
  if (folderFiles.length) {
    const folderNames = [];
    folderFiles.forEach(file => {
      const rel = (file.webkitRelativePath || '').replace(/\\/g, '/');
      const top = rel.split('/').filter(Boolean)[0];
      if (top && !folderNames.includes(top)) folderNames.push(top);
    });
    const preview = folderNames.slice(0, 3).join(', ');
    const extra = folderNames.length > 3 ? folderNames.length - 3 : 0;
    const suffix = preview ? ` (${preview}${extra ? `, +${extra} more` : ''})` : '';
    const confirmMsg = `Upload all files from the selected folder${folderNames.length === 1 ? '' : 's'}${suffix}? This will include every file inside each folder.`;
    const proceed = window.confirm(confirmMsg);
    if (!proceed) {
      try { showToast('Folder upload canceled.', 'info'); } catch { alert('Folder upload canceled.'); }
      return;
    }
  }
  const proj = (window.PROJ_CACHE || {})[id] || {};
  const label = files.length === 1 ? `Uploading 1 material` : `Uploading ${files.length} materials`;
  const projectName = proj.name || id;
  const errors = [];
  const btn = document.getElementById(`btn-upload-mat-${id}`);
  if (btn) btn.disabled = true;
  try {
    if (window.shell && typeof window.shell.beginActionContext === 'function') {
      window.shell.beginActionContext('Upload materials');
    }
  } catch { }
  try {
    if (window.shell && typeof window.shell.logInfo === 'function') {
      window.shell.logInfo(`Config: ${label} for ${projectName}`);
    } else {
      console.log('Uploading materials', projectName, files.length);
    }
  } catch { }
  const queueResult = await runQueued(`Upload materials for ${projectName}`, async () => {
    for (let i = 0; i < files.length; i += 1) {
      const file = files[i];
      const fd = new FormData();
      fd.append('file', file);
      const rel = file.webkitRelativePath || '';
      if (rel) fd.append('relative_path', rel);
      try {
        try {
          if (window.shell && typeof window.shell.step === 'function') {
            window.shell.step(`Uploading ${rel || file.name}`);
          } else {
            console.log('Uploading material', rel || file.name);
          }
        } catch { }
        await http('POST', `/api/projects/${id}/materials`, fd);
      } catch (e) {
        errors.push({ file, error: e });
      }
    }
  }, { projectId: id });
  clearMaterialSelections(id);
  if (queueResult?.status === 'canceled' || queueResult?.status === 'skipped') {
    try {
      if (window.shell && typeof window.shell.logWarn === 'function') {
        window.shell.logWarn('Config: material upload canceled');
      } else {
        console.warn('Material upload canceled');
      }
    } catch { }
    try { if (window.shell && typeof window.shell.endActionContext === 'function') window.shell.endActionContext(false); } catch { }
    try { showToast('Material upload canceled.', 'warning'); } catch { alert('Material upload canceled.'); }
    return;
  }
  try { await loadProjects(); } catch { loadProjects(); }
  try { if (window.shell && shell.refreshSidebar) shell.refreshSidebar('config'); } catch { }
  if (errors.length) {
    const failedNames = errors.map(e => e.file?.name || 'unknown').join(', ');
    try { showToast(`Some materials failed to upload: ${failedNames}`, 'danger'); } catch { alert(`Some materials failed to upload: ${failedNames}`); }
    try {
      if (window.shell && typeof window.shell.logError === 'function') {
        window.shell.logError(`Config: material upload failed for ${failedNames}`);
      } else {
        console.error('Material upload failed for', failedNames);
      }
    } catch { }
    try { if (window.shell && typeof window.shell.endActionContext === 'function') window.shell.endActionContext(false); } catch { }
    return;
  }
  try { showToast('Materials uploaded.', 'success'); } catch { alert('Materials uploaded.'); }
  try {
    if (window.shell && typeof window.shell.logSuccess === 'function') {
      window.shell.logSuccess('Config: materials uploaded');
    } else {
      console.log('Materials uploaded');
    }
  } catch { }
  try { if (window.shell && typeof window.shell.endActionContext === 'function') window.shell.endActionContext(true); } catch { }
}

async function removeAllMaterials(pid) {
  const proj = (window.PROJ_CACHE || {})[pid] || {};
  const mats = Array.isArray(proj.materials) ? [...proj.materials] : [];
  if (!mats.length) {
    try { showToast('No materials to remove.', 'info'); } catch { alert('No materials to remove.'); }
    return;
  }
  const count = mats.length;
  const confirmMsg = `Remove all ${count} material${count === 1 ? '' : 's'} from this project? This will delete the files from the server.`;
  const proceed = window.confirm(confirmMsg);
  if (!proceed) return;
  const projectName = proj.name || pid;
  const errors = [];
  try {
    if (window.shell && typeof window.shell.beginActionContext === 'function') {
      window.shell.beginActionContext('Remove materials');
    }
  } catch { }
  try {
    if (window.shell && typeof window.shell.logWarn === 'function') {
      window.shell.logWarn(`Config: removing ${count} material${count === 1 ? '' : 's'} for ${projectName}`);
    }
  } catch { }
  const queueResult = await runQueued(`Remove materials for ${projectName}`, async () => {
    for (const fname of mats) {
      try {
        try {
          if (window.shell && typeof window.shell.step === 'function') {
            window.shell.step(`Removing ${fname}`);
          }
        } catch { }
        await http('DELETE', `/api/projects/${pid}/materials/${encodeURIComponent(fname)}`);
      } catch (e) {
        errors.push({ name: fname, error: e });
      }
    }
  }, { projectId: pid });
  if (queueResult?.status === 'canceled' || queueResult?.status === 'skipped') {
    try { showToast('Material removal canceled.', 'warning'); } catch { alert('Material removal canceled.'); }
    try { if (window.shell && typeof window.shell.endActionContext === 'function') window.shell.endActionContext(false); } catch { }
    return;
  }
  try { await loadProjects(); } catch { loadProjects(); }
  try {
    if (window.shell && typeof window.shell.refreshSidebar === 'function') {
      window.shell.refreshSidebar('config');
    }
  } catch { }
  clearMaterialSelections(pid);
  onExistingMaterialsSelectionChange(pid);
  if (errors.length) {
    const failedNames = errors.map(e => e.name || 'unknown').join(', ');
    try { showToast(`Some materials failed to delete: ${failedNames}`, 'danger'); } catch { alert(`Some materials failed to delete: ${failedNames}`); }
    try {
      if (window.shell && typeof window.shell.logError === 'function') {
        window.shell.logError(`Config: remove materials failed for ${failedNames}`);
      }
    } catch { }
    try { if (window.shell && typeof window.shell.endActionContext === 'function') window.shell.endActionContext(false); } catch { }
    const removeBtn = document.getElementById(`btn-remove-mat-${pid}`);
    if (removeBtn) removeBtn.disabled = false;
    const removeSelectedBtn = document.getElementById(`btn-remove-existing-${pid}`);
    if (removeSelectedBtn) removeSelectedBtn.disabled = !((window.PROJ_CACHE || {})[pid]?.materials || []).length;
    return;
  }
  try { showToast('All materials removed.', 'success'); } catch { alert('All materials removed.'); }
  try {
    if (window.shell && typeof window.shell.logSuccess === 'function') {
      window.shell.logSuccess(`Config: removed materials for ${projectName}`);
    }
  } catch { }
  const removeBtn = document.getElementById(`btn-remove-mat-${pid}`);
  if (removeBtn) removeBtn.disabled = true;
  const removeSelectedBtn = document.getElementById(`btn-remove-existing-${pid}`);
  if (removeSelectedBtn) removeSelectedBtn.disabled = true;
  try { if (window.shell && typeof window.shell.endActionContext === 'function') window.shell.endActionContext(true); } catch { }
}

async function deleteMaterial(id, fname) {
  try {
    try { (window.shell && shell.logWarn) ? shell.logWarn(`Config: deleting material ${fname}`) : console.warn('Deleting material', fname); } catch { }
    await http('DELETE', `/api/projects/${id}/materials/${encodeURIComponent(fname)}`);
    loadProjects();
    try { if (window.shell && shell.refreshSidebar) shell.refreshSidebar('config'); } catch { }
    try { (window.shell && shell.logSuccess) ? shell.logSuccess('Config: material deleted') : console.log('Material deleted'); } catch { }
  }
  catch (e) { alert('Error deleting material: ' + e.message); try { (window.shell && shell.logError) ? shell.logError('Config: delete material failed: ' + e.message) : console.error('Delete material failed:', e); } catch { } }
}

document.addEventListener('DOMContentLoaded', () => {
  try { wireSettingsModal(); } catch { }
  if (document.getElementById('projects')) {
    try { loadProjects(); } catch { }
  }
});

// Export options state (per-session)
let EXPORT_CONTEXT = { pid: null };

function openExportOptions(pid) {
  try {
    if (window.shell && shell.isRemote && shell.isRemote()) {
      try { showToast('Export is disabled in remote mode.', 'warning'); } catch { alert('Export is disabled in remote mode.'); }
      return;
    }
  } catch { }
  EXPORT_CONTEXT.pid = pid;
  try { (window.shell && shell.logInfo) ? shell.logInfo(`Config: open export options for ${pid}`) : console.log('Open export options', pid); } catch { }
  const modalEl = document.getElementById('exportOptionsModal');
  if (!modalEl || !window.bootstrap) { window.location.href = `/api/projects/${encodeURIComponent(pid)}/export`; return; }
  // Default to include both
  try {
    const c = document.getElementById('exp-creds');
    const v = document.getElementById('exp-vms');
    const a = document.getElementById('exp-notify-audio');
    const warn = document.getElementById('exp-vms-warning');
    if (c) c.checked = true;
    if (v) v.checked = true;
    if (a) a.checked = true;
    if (warn && v) warn.style.display = v.checked ? 'block' : 'none';
    if (v && warn) v.onchange = () => { warn.style.display = v.checked ? 'block' : 'none'; };
  } catch { }
  const m = new bootstrap.Modal(modalEl);
  m.show();
  const dl = document.getElementById('exp-download');
  if (dl) {
    const setBusy = (flag) => {
      if (flag) dl.dataset.busy = '1'; else delete dl.dataset.busy;
      dl.disabled = !!flag;
      dl.classList.toggle('disabled', !!flag);
      if (flag) dl.setAttribute('aria-disabled', 'true'); else dl.removeAttribute('aria-disabled');
    };
    dl.onclick = async () => {
      if (dl.dataset.busy === '1' || dl.disabled) return;
      const includeCreds = !!document.getElementById('exp-creds')?.checked;
      const includeVms = !!document.getElementById('exp-vms')?.checked;
      const includeNotifyAudio = !!document.getElementById('exp-notify-audio')?.checked;
      setBusy(true);
      let proceed = true;
      try {
        if (includeVms) {
          proceed = confirm('Exporting VMs can be very time-consuming. This will run on the remote machine, download disk files, and compress them. Continue?');
          if (!proceed) { return; }
        }
        if (includeVms) {
          try { m.hide(); } catch { }
          await gateExportThroughProxLogin(EXPORT_CONTEXT.pid, { includeCreds, includeVms, includeNotifyAudio });
        } else {
          try {
            if (typeof window.showActionProgress === 'function') {
              window.showActionProgress('Export', 'Preparing download…');
              if (typeof window.openActionProgressModal === 'function') window.openActionProgressModal();
            }
          } catch { }
          const a = document.createElement('a');
          a.href = `/api/projects/${encodeURIComponent(EXPORT_CONTEXT.pid)}/export?includeCreds=${includeCreds}&includeVms=${includeVms}&includeNotifyAudio=${includeNotifyAudio}`;
          // Give the modal a moment to render before starting the download
          setTimeout(() => { try { a.click(); } catch { } }, 50);
          try { (window.shell && shell.logSuccess) ? shell.logSuccess('Config: export started') : console.log('Export started'); } catch { }
          try { m.hide(); } catch { }
          // Best-effort: hide progress shortly after initiating download
          setTimeout(() => {
            try { if (typeof window.hideActionProgress === 'function') window.hideActionProgress(); } catch { }
          }, 1200);
        }
      } finally {
        if (!includeVms || proceed) {
          // Reset immediately for non-VM exports or confirmed VM exports
          setTimeout(() => setBusy(false), 0);
        } else {
          setBusy(false);
        }
      }
    };
  }
}

function _isMissingManifestError(err) {
  try {
    const code = err?.body?.code || err?.body?.errorCode || err?.code;
    if (String(code || '').toLowerCase() === 'missing_manifest') return true;
    const msg = String(err?.message || err?.body?.error || '').toLowerCase();
    return msg.includes('missing project.json') || msg.includes('missing manifest');
  } catch {
    return false;
  }
}

function _confirmBestEffortImport(file) {
  const name = (file && file.name) ? file.name : 'archive';
  const msg = `The archive "${name}" does not include project.json.\n\nWe can try a best-effort import (VMs from backups/ only). Continue?`;
  try { return confirm(msg); } catch { return false; }
}

function _makeImportCancelledError() {
  const err = new Error('Import cancelled by user');
  err.code = 'import_cancelled';
  return err;
}

async function performProjectImport(options = {}) {
  try {
    if (window.shell && shell.isRemote && shell.isRemote()) {
      try { showToast('Import is disabled in remote mode.', 'warning'); } catch { alert('Import is disabled in remote mode.'); }
      return false;
    }
  } catch { }
  const input = document.getElementById('import-file');
  if (!input || !input.files || !input.files[0]) return false;
  const file = input.files[0];
  const buildFormData = (allowBestEffort = false) => {
    const fd = new FormData();
    fd.append('file', file);
    if (options.includeCreds !== undefined) fd.append('includeCreds', options.includeCreds ? 'true' : 'false');
    if (options.includeVms !== undefined) fd.append('includeVms', options.includeVms ? 'true' : 'false');
    if (options.includeNotifyAudio !== undefined) fd.append('includeNotifyAudio', options.includeNotifyAudio ? 'true' : 'false');
    if (options.importAsTemplates !== undefined) fd.append('importAsTemplates', options.importAsTemplates ? 'true' : 'false');
    if (allowBestEffort) fd.append('allowBestEffort', 'true');
    return fd;
  };
  const label = `Import project: ${file.name}`;

  // Publish progress into the global queue/progress system so the user can hide/show
  // via the Queue dock, just like other tasks.
  try { if (typeof window.showActionProgress === 'function') window.showActionProgress('Import', 'Uploading…'); } catch { }

  // Prefer the dedicated Import Progress modal (scrolling log) when available.
  const modalEl = document.getElementById('importProgressModal');
  const hasImportModal = !!(modalEl && window.bootstrap);
  const bar = document.getElementById('imp-prog-bar');
  const stat = document.getElementById('imp-status');
  const log = document.getElementById('imp-log');
  let modalInst = null;
  if (hasImportModal) {
    try {
      modalInst = new window.bootstrap.Modal(modalEl);
      if (bar) { bar.style.width = '0%'; bar.textContent = '0%'; bar.setAttribute('aria-valuenow', '0'); }
      if (stat) stat.textContent = 'Uploading…';
      if (log) log.textContent = 'Preparing upload…';
      modalInst.show();
    } catch { }
  } else {
    // Fallback to action progress (only if import modal isn't available).
    try {
      if (typeof window.showActionProgress === 'function') {
        window.showActionProgress('Import', 'Uploading…');
        if (typeof window.openActionProgressModal === 'function') window.openActionProgressModal();
      }
    } catch { }
  }
  try {
    if (window.shell && typeof shell.setSidebarImportBusy === 'function') shell.setSidebarImportBusy(true);
  } catch { }
  let resp = null;
  try {
    await runQueued(label, async () => {
      // Use XHR for legacy import so we can show byte upload progress.
      const attemptUpload = async (allowBestEffort) => {
        return await _xhrPostFormData('/api/projects/import', buildFormData(allowBestEffort), {
          onProgress: (pct, loaded, total) => {
            const mapped = Math.max(0, Math.min(35, Math.round((pct * 35) / 100)));
            const bytes = _fmtByteProgress(loaded, total);
            const line = bytes ? `Uploading… ${pct}% (${bytes})` : `Uploading… ${pct}%`;
            try { if (typeof window.updateActionProgress === 'function') window.updateActionProgress(mapped, line, line); } catch { }
            if (hasImportModal) {
              try {
                if (bar) { bar.style.width = `${mapped}%`; bar.textContent = `${mapped}%`; bar.setAttribute('aria-valuenow', String(mapped)); }
                if (stat) stat.textContent = line;
                if (log) log.textContent = line;
              } catch { }
            } else {
              try { if (typeof window.updateActionProgress === 'function') window.updateActionProgress(mapped, line, line); } catch { }
            }
          }
        });
      };
      try {
        resp = await attemptUpload(false);
      } catch (err) {
        if (_isMissingManifestError(err)) {
          const ok = _confirmBestEffortImport(file);
          if (!ok) throw _makeImportCancelledError();
          resp = await attemptUpload(true);
        } else {
          throw err;
        }
      }
      if (hasImportModal) {
        try {
          if (bar) { bar.style.width = '90%'; bar.textContent = '90%'; bar.setAttribute('aria-valuenow', '90'); }
          if (stat) stat.textContent = 'Finalizing…';
          if (log) log.textContent = 'Applying imported configuration…';
        } catch { }
      } else {
        try { if (typeof window.updateActionProgress === 'function') window.updateActionProgress(90, 'Finalizing…', 'Applying imported configuration…'); } catch { }
      }
      try { if (typeof window.updateActionProgress === 'function') window.updateActionProgress(90, 'Finalizing…', 'Applying imported configuration…'); } catch { }
    }, { projectId: options.queueKey || 'import' });
  } catch (err) {
    if (err && err.code === 'import_cancelled') {
      if (hasImportModal) {
        try {
          if (bar) { bar.style.width = '100%'; bar.textContent = 'Cancelled'; bar.setAttribute('aria-valuenow', '100'); bar.classList.remove('progress-bar-animated'); }
          if (stat) stat.textContent = 'cancelled';
          if (log) log.textContent = 'Import cancelled.';
        } catch { }
      }
      try { showToast('Import cancelled.', 'warning'); } catch { }
      return false;
    }
    if (hasImportModal) {
      try {
        if (bar) { bar.style.width = '100%'; bar.textContent = 'Error'; bar.setAttribute('aria-valuenow', '100'); bar.classList.remove('progress-bar-animated'); }
        if (stat) stat.textContent = 'error';
        if (log) log.textContent = 'Failed to import project: ' + (err?.message || err);
      } catch { }
    }
    try { showToast('Failed to import project: ' + (err?.message || err), 'danger'); } catch { }
    try {
      (window.shell && shell.logError)
        ? shell.logError('Config: import project failed: ' + (err?.message || err))
        : console.error('Import project failed:', err);
    } catch { }
    return false;
  } finally {
    try {
      if (window.shell && typeof shell.setSidebarImportBusy === 'function') shell.setSidebarImportBusy(false);
    } catch { }
    if (!hasImportModal) {
      try { if (typeof window.hideActionProgress === 'function') window.hideActionProgress(); } catch { }
    }
  }
  if (!resp) return false;
  try { input.value = ''; } catch { }
  const importedId = resp?.id || (Array.isArray(resp?.imported) && resp.imported[0]?.id) || '';
  if (importedId && window.shell && typeof shell.setCurrentProjectId === 'function') {
    try { shell.setCurrentProjectId(importedId); } catch { }
  }
  try { await loadProjects(); } catch { }
  try {
    if (window.shell && typeof shell.refreshSidebar === 'function') await shell.refreshSidebar('config');
  } catch { }
  try { showToast('Project imported.', 'success'); } catch { }
  if (hasImportModal) {
    try {
      if (bar) { bar.style.width = '100%'; bar.textContent = '100%'; bar.setAttribute('aria-valuenow', '100'); bar.classList.remove('progress-bar-animated'); }
      if (stat) stat.textContent = 'completed';
      if (log) log.textContent = 'Import completed.';
    } catch { }
  }
  try { if (typeof window.hideActionProgress === 'function') window.hideActionProgress(); } catch { }
  try {
    (window.shell && shell.logSuccess)
      ? shell.logSuccess('Config: project imported')
      : console.log('Project imported');
  } catch { }
  return true;
}

// --- Proxmox gating + async import (for VM restores) ---

function _readImportProxCreds() {
  try { return JSON.parse(sessionStorage.getItem('toolhub.session.proxmox.import') || '{}'); } catch { return {}; }
}
function _writeImportProxCreds(creds) {
  try { sessionStorage.setItem('toolhub.session.proxmox.import', JSON.stringify(creds || {})); } catch { }
}

function _ensureHttpsUrl(raw) {
  try {
    const s = (raw || '').trim();
    if (!s) return '';
    return /^https?:\/\//i.test(s) ? s : `https://${s}`;
  } catch { return ''; }
}

function _xhrPostFormData(url, formData, { onProgress } = {}) {
  return new Promise((resolve, reject) => {
    try {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', url, true);
      xhr.responseType = 'text';
      xhr.upload.onprogress = (ev) => {
        try {
          if (!onProgress || !ev || !ev.lengthComputable) return;
          const pct = Math.max(0, Math.min(100, Math.round((ev.loaded * 100) / Math.max(ev.total, 1))));
          onProgress(pct, ev.loaded, ev.total);
        } catch { }
      };
      xhr.onload = () => {
        try {
          const status = xhr.status || 0;
          const text = xhr.responseText || '';
          let body = null;
          try { body = text ? JSON.parse(text) : null; } catch { body = text; }
          if (status >= 200 && status < 300) return resolve(body);
          const msg = (body && typeof body === 'object' && body.error) ? body.error : (typeof body === 'string' && body ? body : `HTTP ${status}`);
          const err = new Error(msg);
          err.status = status;
          err.body = body;
          return reject(err);
        } catch (e) { return reject(e); }
      };
      xhr.onerror = () => reject(new Error('Network error'));
      xhr.send(formData);
    } catch (e) {
      reject(e);
    }
  });
}

function _fmtBytes(n) {
  try {
    const v = Number(n);
    if (!Number.isFinite(v) || v < 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let x = v;
    let i = 0;
    while (x >= 1024 && i < units.length - 1) { x /= 1024; i += 1; }
    const prec = i === 0 ? 0 : (x >= 10 ? 1 : 2);
    return `${x.toFixed(prec)} ${units[i]}`;
  } catch { return '0 B'; }
}

function _fmtByteProgress(loaded, total) {
  try {
    const l = Number(loaded);
    const t = Number(total);
    if (Number.isFinite(l) && Number.isFinite(t) && t > 0) return `${_fmtBytes(l)} / ${_fmtBytes(t)}`;
    if (Number.isFinite(l)) return `${_fmtBytes(l)} / ?`;
    return '';
  } catch { return ''; }
}

function _queueLongAction(label, fn, { projectId, dedupeKey, allowDuplicate, onCancel, onTaskCreated } = {}) {
  return new Promise((resolve, reject) => {
    try {
      if (typeof window.queueRemoteAction !== 'function') {
        Promise.resolve().then(fn).then(resolve).catch(reject);
        return;
      }
      let entry = null;
      const entryFn = async () => {
        try {
          const res = await Promise.resolve(fn());
          try { resolve(res); } catch { }
          return res;
        } catch (e) {
          try { reject(e); } catch { }
          throw e;
        }
      };
      entry = window.queueRemoteAction(label, entryFn, {
        projectId,
        dedupeKey,
        allowDuplicate,
        onCancel: () => {
          try { onCancel && onCancel(); } catch { }
          // If cancelled before the task starts, the function never runs;
          // resolve to avoid leaving the UI waiting forever.
          try {
            if (!entry || !entry.startedAt) resolve({ status: 'cancelled' });
          } catch { }
        }
      });
      try { if (entry && onTaskCreated) onTaskCreated(entry); } catch { }
      if (!entry) {
        try { resolve(null); } catch { }
      }
    } catch (e) {
      reject(e);
    }
  });
}

async function _runAsyncImportWithProx({ file, includeCreds, includeVms, includeNotifyAudio, importAsTemplates, prox }) {
  const buildFormData = (allowBestEffort = false) => {
    const fd = new FormData();
    fd.append('file', file);
    fd.append('includeCreds', includeCreds ? 'true' : 'false');
    fd.append('includeVms', includeVms ? 'true' : 'false');
    if (includeNotifyAudio !== undefined) fd.append('includeNotifyAudio', includeNotifyAudio ? 'true' : 'false');
    if (importAsTemplates !== undefined) fd.append('importAsTemplates', importAsTemplates ? 'true' : 'false');
    if (allowBestEffort) fd.append('allowBestEffort', 'true');
    if (prox) {
      if (prox.baseUrl) fd.append('baseUrl', String(prox.baseUrl));
      if (prox.apiPort !== undefined && prox.apiPort !== null && String(prox.apiPort) !== '') fd.append('apiPort', String(prox.apiPort));
      if (prox.sshPort !== undefined && prox.sshPort !== null && String(prox.sshPort) !== '') fd.append('sshPort', String(prox.sshPort));
      if (prox.username) fd.append('username', String(prox.username));
      if (prox.password) fd.append('password', String(prox.password));
      if (prox.verifySSL !== undefined) fd.append('verifySSL', prox.verifySSL ? 'true' : 'false');
    }
    return fd;
  };

  const label = `Import project: ${file?.name || 'archive'}`;

  // Publish progress state for the Queue dock (do not auto-open the generic modal).
  try { if (typeof window.showActionProgress === 'function') window.showActionProgress('Import', 'Uploading…'); } catch { }

  // Optional rich import progress modal (shows full backend logs).
  const modalEl = document.getElementById('importProgressModal');
  const hasImportModal = !!(modalEl && window.bootstrap);
  const bar = document.getElementById('imp-prog-bar');
  const stat = document.getElementById('imp-status');
  const log = document.getElementById('imp-log');
  let modalInst = null;
  if (hasImportModal) {
    try {
      modalInst = new window.bootstrap.Modal(modalEl);
      if (bar) { bar.style.width = '0%'; bar.textContent = '0%'; bar.setAttribute('aria-valuenow', '0'); }
      if (stat) stat.textContent = 'Uploading…';
      if (log) log.textContent = 'Waiting…';
      modalInst.show();
    } catch { }
  }

  // Only use action progress as a fallback when the Import Progress modal isn't present.
  if (!hasImportModal) {
    try {
      if (typeof window.showActionProgress === 'function') {
        window.showActionProgress('Import', 'Uploading…');
        if (typeof window.openActionProgressModal === 'function') window.openActionProgressModal();
      }
    } catch { }
  }

  const state = { jobId: '', taskId: null, cancelRequested: false };
  try { window.__ACTIVE_IMPORT_STATE__ = state; } catch { }

  const cancelBtn = document.getElementById('imp-cancel-btn');
  const setCancelEnabled = (enabled) => {
    try {
      if (!cancelBtn) return;
      cancelBtn.disabled = !enabled;
      cancelBtn.classList.toggle('disabled', !enabled);
    } catch { }
  };
  const markCancelling = () => {
    try {
      if (!cancelBtn) return;
      cancelBtn.disabled = true;
      cancelBtn.textContent = 'Cancelling…';
      cancelBtn.classList.add('disabled');
    } catch { }
    try {
      if (stat) stat.textContent = 'cancelling';
    } catch { }
  };

  async function requestCancel() {
    state.cancelRequested = true;
    markCancelling();
    if (!state.jobId) return;
    try {
      await http('POST', `/api/projects/import/cancel?id=${encodeURIComponent(state.jobId)}`);
    } catch { }
  }

  // Wire Cancel button: cancel the active queue task (preferred), otherwise best-effort cancel by job id.
  try {
    if (cancelBtn) {
      cancelBtn.onclick = async () => {
        if (state.cancelRequested) return;
        if (state.taskId && typeof window.cancelRemoteAction === 'function') {
          try { window.cancelRemoteAction(state.taskId); } catch { }
        } else {
          await requestCancel();
        }
      };
    }
  } catch { }

  let lastLogCount = 0;
  // Enable Cancel immediately (even while uploading). If clicked before a job id exists,
  // we mark cancel requested and cancel as soon as the backend returns a job id.
  setCancelEnabled(true);
  let finalStatus;
  try {
    finalStatus = await _queueLongAction(label, async () => {
      // Start import job (upload archive)
      let resp;
      const attemptUpload = async (allowBestEffort) => {
        return await _xhrPostFormData('/api/projects/import/start', buildFormData(allowBestEffort), {
          onProgress: (pct, loaded, total) => {
            const mapped = Math.max(0, Math.min(30, Math.round((pct * 30) / 100)));
            const bytes = _fmtByteProgress(loaded, total);
            const line = bytes ? `Uploading… ${pct}% (${bytes})` : `Uploading… ${pct}%`;
            try { if (typeof window.updateActionProgress === 'function') window.updateActionProgress(mapped, line, `Uploading ${file?.name || 'archive'}…`); } catch { }
            try {
              if (bar) {
                bar.style.width = `${mapped}%`;
                bar.textContent = `${mapped}%`;
                bar.setAttribute('aria-valuenow', String(mapped));
              }
              if (stat) stat.textContent = line;
              if (log) log.textContent = line;
            } catch { }
          }
        });
      };
      try {
        resp = await attemptUpload(false);
      } catch (e) {
        if (_isMissingManifestError(e)) {
          const ok = _confirmBestEffortImport(file);
          if (!ok) return { status: 'cancelled' };
          resp = await attemptUpload(true);
        } else {
          // Friendly remote-mode message if backend blocks
          if (e && (e.status === 403 || e.status === 401)) {
            try {
              const msg = (e.body && e.body.error) ? e.body.error : 'Import is not allowed.';
              showToast(msg, e.status === 403 ? 'warning' : 'danger');
            } catch { }
          }
          throw e;
        }
      }

      state.jobId = resp && typeof resp === 'object' ? String(resp.job || '') : '';
      if (!state.jobId) throw new Error('Import did not return a job id');
      if (state.cancelRequested) {
        await requestCancel();
      }

      // Poll until done
      while (true) {
        const s = await http('GET', `/api/projects/import/status?id=${encodeURIComponent(state.jobId)}`);
        const p = Math.max(0, Math.min(100, Number(s.progress || 0)));
        const statusText = String(s.status || 'processing');
        const mapped = (statusText === 'completed')
          ? 100
          : Math.max(30, Math.min(99, 30 + Math.round((p * 70) / 100)));
        let detail = '';
        try {
          if (Array.isArray(s.log) && s.log.length) {
            detail = String(s.log[s.log.length - 1] || '');
            try {
              const start = Math.max(0, lastLogCount);
              for (let i = start; i < s.log.length; i++) {
                if (window.shell && shell.logDebug) shell.logDebug(`[IMPORT] ${s.log[i]}`);
                else console.debug('[IMPORT]', s.log[i]);
              }
              lastLogCount = s.log.length;
            } catch { }
          }
        } catch { }
        try { if (typeof window.updateActionProgress === 'function') window.updateActionProgress(mapped, statusText, detail || 'Importing…'); } catch { }

        try {
          if (bar) {
            bar.style.width = `${Math.max(0, Math.min(100, mapped))}%`;
            bar.textContent = `${Math.max(0, Math.min(100, mapped))}%`;
            bar.setAttribute('aria-valuenow', String(Math.max(0, Math.min(100, mapped))));
            if (statusText === 'completed' || statusText === 'cancelled' || statusText === 'error') {
              bar.classList.remove('progress-bar-animated');
            }
          }
          if (stat) stat.textContent = statusText;
          if (log) {
            if (Array.isArray(s.log) && s.log.length) {
              log.textContent = s.log.join('\n');
              try {
                const box = log.parentElement;
                if (box) requestAnimationFrame(() => { box.scrollTop = box.scrollHeight; });
              } catch { }
            } else {
              log.textContent = detail || '';
            }
          }
        } catch { }

        if (statusText === 'completed') return s;
        if (statusText === 'cancelled') return s;
        if (statusText === 'error') {
          const msg = (s?.errors && s.errors[0]) ? String(s.errors[0]) : 'Import failed';
          throw new Error(msg);
        }
        await new Promise(r => setTimeout(r, 1500));
      }
    }, {
      projectId: 'import',
      allowDuplicate: true,
      onTaskCreated: (task) => { state.taskId = task?.id; },
      onCancel: () => { requestCancel(); },
    });
  } catch (e) {
    // Update modal to show error
    try {
      if (bar) {
        bar.style.width = '100%';
        bar.textContent = 'Error';
        bar.classList.remove('progress-bar-animated');
        bar.classList.add('bg-danger');
      }
      if (stat) stat.textContent = 'error';
      if (log) {
        const errMsg = e?.message || String(e) || 'Import failed';
        log.textContent = 'Error: ' + errMsg;
      }
    } catch { }
    try { if (typeof window.hideActionProgress === 'function') window.hideActionProgress(); } catch { }
    try { setCancelEnabled(false); } catch { }
    try { if (cancelBtn) cancelBtn.textContent = 'Cancel Import'; } catch { }
    throw e;
  }

  try { if (typeof window.hideActionProgress === 'function') window.hideActionProgress(); } catch { }
  try { setCancelEnabled(false); } catch { }
  try { if (cancelBtn) cancelBtn.textContent = 'Cancel Import'; } catch { }
  try {
    if (finalStatus && typeof finalStatus === 'object' && String(finalStatus.status || '') === 'cancelled') {
      if (stat) stat.textContent = 'cancelled';
      if (log && (!Array.isArray(finalStatus.log) || !finalStatus.log.length)) log.textContent = 'Import cancelled.';
    }
  } catch { }
  return finalStatus;
}

// Allow the Queue dock's "View Progress" action to re-open the import log modal.
// shell.js will call this (if present) before falling back to the generic action progress modal.
try {
  window.openProgressDetailsModal = (progressState) => {
    try {
      const t = String(progressState && progressState.title ? progressState.title : '');
      if (!t || !/^import\b/i.test(t)) return false;
      const modalEl = document.getElementById('importProgressModal');
      if (!modalEl || !window.bootstrap || !window.bootstrap.Modal) return false;
      const inst = window.bootstrap.Modal.getOrCreateInstance(modalEl);
      inst.show();
      return true;
    } catch {
      return false;
    }
  };
} catch { }

async function gateImportThroughProxLogin({ file, includeCreds, includeVms, includeNotifyAudio, importAsTemplates }) {
  // If no modal, fall back to prompts.
  if (!document.getElementById('proxLoginModal') || !window.bootstrap) {
    const baseUrl = _ensureHttpsUrl(window.prompt('Proxmox URL (https://host or host):', '') || '');
    if (!baseUrl) return false;
    const username = (window.prompt('Proxmox username (e.g., root@pam):', '') || '').trim();
    if (!username) return false;
    const password = (window.prompt('Proxmox password:', '') || '');
    if (!password) return false;
    const apiPort = Number(window.prompt('API Port:', '8006') || 8006);
    const sshPort = Number(window.prompt('SSH Port:', '22') || 22);
    const verifySSL = true;
    const prox = { baseUrl, apiPort, sshPort, username, password, verifySSL };
    _writeImportProxCreds({ baseUrl, apiPort, sshPort, username, password, verifySSL });
    const st = await _runAsyncImportWithProx({ file, includeCreds, includeVms, includeNotifyAudio, importAsTemplates, prox });
    if (st && typeof st === 'object' && String(st.status || '') === 'cancelled') {
      try { showToast('Import cancelled.', 'warning'); } catch { }
      return false;
    }
    // Handle success UX
    const importedId = (Array.isArray(st?.imported) && st.imported[0]?.id) || (st?.imported?.id) || '';
    try {
      if (importedId && window.shell && typeof shell.setCurrentProjectId === 'function') shell.setCurrentProjectId(importedId);
    } catch { }
    try { await loadProjects(); } catch { }
    try { if (window.shell && typeof shell.refreshSidebar === 'function') await shell.refreshSidebar('config'); } catch { }
    try { showToast('Project imported.', 'success'); } catch { }
    return true;
  }

  // Prefill from last-used import creds
  const sess = _readImportProxCreds() || {};
  const urlEl = document.getElementById('prox-url');
  const apiEl = document.getElementById('prox-api-port');
  const sshEl = document.getElementById('prox-ssh-port');
  const userEl = document.getElementById('prox-username');
  const passEl = document.getElementById('prox-password');
  const vsslEl = document.getElementById('prox-verify-ssl');
  const feedback = document.getElementById('prox-login-feedback');
  if (feedback) { feedback.textContent = ''; feedback.className = 'me-auto small'; }
  if (urlEl) urlEl.value = sess.baseUrl || '';
  if (apiEl) apiEl.value = (sess.apiPort ?? 8006);
  if (sshEl) sshEl.value = (sess.sshPort ?? 22);
  if (userEl) userEl.value = sess.username || '';
  if (passEl) passEl.value = sess.password || '';
  if (vsslEl) vsslEl.checked = (sess.verifySSL !== false);

  window.__IMPORT_NEXT__ = { file, includeCreds, includeVms, includeNotifyAudio: includeNotifyAudio !== false, importAsTemplates: !!importAsTemplates };
  const modalEl = document.getElementById('proxLoginModal');
  const m = new window.bootstrap.Modal(modalEl);
  m.show();
  return true;
}

function importProject() {
  try {
    if (window.shell && shell.isRemote && shell.isRemote()) {
      try { showToast('Import is disabled in remote mode.', 'warning'); } catch { alert('Import is disabled in remote mode.'); }
      return;
    }
  } catch { }
  const input = document.getElementById('import-file');
  if (!input || !input.files || !input.files[0]) return;
  const modalEl = document.getElementById('importOptionsModal');
  if (!modalEl || !window.bootstrap) {
    performProjectImport({ includeCreds: true, includeVms: true });
    return;
  }
  const credsEl = document.getElementById('imp-creds');
  const vmsEl = document.getElementById('imp-vms');
  const notifyAudioEl = document.getElementById('imp-notify-audio');
  const templatesEl = document.getElementById('imp-as-templates');
  const warnEl = document.getElementById('imp-vms-warning');
  if (credsEl) credsEl.checked = true;
  if (vmsEl) vmsEl.checked = true;
  if (notifyAudioEl) notifyAudioEl.checked = true;
  if (templatesEl) { templatesEl.checked = false; templatesEl.disabled = !(vmsEl && vmsEl.checked); }
  if (warnEl) warnEl.style.display = vmsEl && vmsEl.checked ? 'block' : 'none';
  if (vmsEl) {
    vmsEl.onchange = () => {
      if (warnEl) warnEl.style.display = vmsEl.checked ? 'block' : 'none';
      if (templatesEl) {
        templatesEl.disabled = !vmsEl.checked;
        if (!vmsEl.checked) templatesEl.checked = false;
      }
    };
  }
  const modal = new window.bootstrap.Modal(modalEl);
  const continueBtn = document.getElementById('imp-continue');
  if (continueBtn) {
    const setBusy = (flag) => {
      if (flag) continueBtn.dataset.busy = '1'; else delete continueBtn.dataset.busy;
      continueBtn.disabled = !!flag;
      continueBtn.classList.toggle('disabled', !!flag);
      if (flag) continueBtn.setAttribute('aria-disabled', 'true'); else continueBtn.removeAttribute('aria-disabled');
    };
    continueBtn.onclick = null;
    continueBtn.onclick = async () => {
      if (continueBtn.dataset.busy === '1' || continueBtn.disabled) return;
      const includeCreds = !!document.getElementById('imp-creds')?.checked;
      const includeVms = !!document.getElementById('imp-vms')?.checked;
      const includeNotifyAudio = !!document.getElementById('imp-notify-audio')?.checked;
      const importAsTemplates = includeVms && !!document.getElementById('imp-as-templates')?.checked;
      if (includeVms) {
        const proceed = confirm('Importing VMs can be very time-consuming. This will run on the remote machine, download disk files, and compress them. Continue?');
        if (!proceed) return;
      }
      setBusy(true);
      try {
        // If importing VMs, prompt for Proxmox target and run async import job.
        if (includeVms) {
          try { modal.hide(); } catch { }
          const input = document.getElementById('import-file');
          const file = input && input.files && input.files[0] ? input.files[0] : null;
          if (!file) return;
          const ok = await gateImportThroughProxLogin({ file, includeCreds, includeVms, includeNotifyAudio, importAsTemplates });
          if (ok) { try { input.value = ''; } catch { } }
        } else {
          const ok = await performProjectImport({ includeCreds, includeVms, includeNotifyAudio, importAsTemplates, queueKey: 'import' });
          if (ok) {
            try { modal.hide(); } catch { }
          }
        }
      } finally {
        setBusy(false);
      }
    };
  }
  modal.show();
}

async function startExportJob(pid, opts) {
  try {
    if (window.shell && shell.isRemote && shell.isRemote()) {
      try { showToast('Export is disabled in remote mode.', 'warning'); } catch { alert('Export is disabled in remote mode.'); }
      return;
    }
  } catch { }
  // Read Proxmox session creds from sessionStorage
  const creds = readBestProxCreds(pid) || {};
  const body = { includeCreds: !!opts.includeCreds, includeVms: !!opts.includeVms, includeNotifyAudio: opts.includeNotifyAudio !== false, username: creds.username || '', password: creds.password || '' };
  if (!body.username || !body.password) { alert('Please log into Proxmox (Authenticate to Proxmox) before exporting VMs.'); return; }
  // Ensure console dock shows debug-level messages
  try { if (window.shell && shell.enableConsoleDebug) shell.enableConsoleDebug(true); } catch { }
  try { (window.shell && shell.logInfo) ? shell.logInfo('Config: starting export job…') : console.log('Starting export job…'); } catch { }
  try {
    // Make the HTTP request directly and await it - runQueued doesn't propagate return values
    const resp = await http('POST', `/api/projects/${encodeURIComponent(pid)}/export/start`, body);
    if (!resp || !resp.job) throw new Error('No job id returned');
    const modalEl = document.getElementById('exportProgressModal');
    if (!modalEl || !window.bootstrap) { alert('Export started. Keep this page open.'); return; }
    const bar = document.getElementById('exp-prog-bar');
    const stat = document.getElementById('exp-status');
    const log = document.getElementById('exp-log');
    const dl = document.getElementById('exp-download-final');
    const openBtn = document.getElementById('exp-open-folder');
    const pathNote = document.getElementById('exp-path-note');
    if (bar) { bar.style.width = '0%'; bar.textContent = '0%'; bar.setAttribute('aria-valuenow', '0'); }
    if (stat) stat.textContent = 'Queued…';
    if (log) log.textContent = 'Waiting…';
    if (dl) { dl.classList.add('disabled'); dl.href = '#'; dl.setAttribute('aria-disabled', 'true'); }
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
          try { m.hide(); } catch { }
        };
      }
    } catch { }
    const poll = async () => {
      try {
        const s = await http('GET', `/api/projects/${encodeURIComponent(pid)}/export/status`);
        const p = Math.max(0, Math.min(100, Number(s.progress || 0)));
        if (bar) { bar.style.width = p + '%'; bar.textContent = p + '%'; bar.setAttribute('aria-valuenow', String(p)); }
        if (stat) stat.textContent = String(s.status || '');
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
            } catch { }
          }
          // Stream only new lines to bottom console as DEBUG
          try {
            const start = Math.max(0, lastLogCount);
            for (let i = start; i < s.log.length; i++) {
              if (window.shell && shell.logDebug) shell.logDebug(`[EXPORT] ${s.log[i]}`);
              else console.debug('[EXPORT]', s.log[i]);
            }
            lastLogCount = s.log.length;
          } catch { }
          // Try to extract the ZIP destination path from logs
          try {
            // Look for a line like: [CMD] package -> /path/to/export_xxx.zip
            for (let i = s.log.length - 1; i >= 0; i--) {
              const line = String(s.log[i] || '');
              const m = line.match(/\[CMD\]\s+package\s+->\s+(.+\.zip)\s*$/);
              if (m) { finalZipPath = m[1]; break; }
            }
          } catch { }
        } else if (log) { log.textContent = ''; }
        if (s.status === 'completed') {
          completed = true;
          const hasDl = !!s.downloadReady;
          const href = hasDl ? `/api/projects/${encodeURIComponent(pid)}/export/download` : '#';
          if (stat) stat.textContent = 'completed';
          if (dl) {
            dl.href = href;
            dl.classList.toggle('disabled', !hasDl);
            dl.setAttribute('aria-disabled', String(!hasDl));
            dl.textContent = 'Download ZIP';
          }
          if (pathNote) { pathNote.textContent = s.downloadPath ? `Saved: ${s.downloadPath}` : ''; }
          if (openBtn) {
            openBtn.disabled = !s.downloadPath;
            openBtn.onclick = async () => {
              try {
                // Find export id in list by matching path (best-effort): refresh Exports page later
                // For immediate UX, ask backend to reveal by id isn't available here; fallback to just opening downloads dir.
                // We can navigate to Exports page where Open Folder is available per export.
                window.location.href = `/static/exports.html?id=${encodeURIComponent(pid)}`;
              } catch { }
            };
          }
          try { (window.shell && shell.logSuccess) ? shell.logSuccess('Export completed and ready to download') : console.log('Export completed and ready'); } catch { }
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
    // Format error message to be more human-readable
    let displayMsg = 'Unknown error';
    try {
      const raw = e && e.message ? e.message : '';
      // Check if the message is JSON (starts with {)
      if (raw.startsWith('{')) {
        const parsed = JSON.parse(raw);
        const lines = [];
        if (parsed.error) lines.push(parsed.error);
        if (parsed.message) lines.push('\n' + parsed.message);
        if (Array.isArray(parsed.details) && parsed.details.length) {
          lines.push('\nAffected VMs:');
          parsed.details.forEach(d => {
            lines.push(`  • ${d.name || 'unknown'} (VMID ${d.vmid || '?'}, node: ${d.node || '?'})`);
          });
        }
        displayMsg = lines.join('\n');
      } else {
        displayMsg = raw || displayMsg;
      }
    } catch { displayMsg = e && e.message ? e.message : 'Unknown error'; }
    alert('Failed to start export:\n\n' + displayMsg);
    try { (window.shell && shell.logError) ? shell.logError('Config: export start failed: ' + (e && e.message ? e.message : e)) : console.error('Export start failed:', e); } catch { }
  }
}

// Open Proxmox login modal and continue export after successful verify
async function gateExportThroughProxLogin(pid, opts) {
  try { (window.shell && shell.logInfo) ? shell.logInfo('Config: gating export through Proxmox login') : console.log('Gate export: Proxmox login'); } catch { }
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
  const persisted = readPersistProxCreds(pid) || {};
  if (url) url.value = proj.proxmox_url || '';
  if (api) api.value = proj.proxmox_api_port ?? 8006;
  if (ssh) ssh.value = proj.proxmox_ssh_port ?? 22;
  if (u) u.value = sess.username || persisted.username || '';
  if (p) p.value = sess.password || persisted.password || '';
  if (vssl) vssl.checked = (proj.proxmox_verify_ssl !== false);
  // Stash next action
  window.__EXPORT_NEXT__ = { pid, opts };
  const modalEl = document.getElementById('proxLoginModal');
  if (!modalEl || !window.bootstrap) { alert('Proxmox login UI not found.'); return; }
  const m = new bootstrap.Modal(modalEl);
  m.show();
}

async function exportProxLoginSave() {
  const exportNext = window.__EXPORT_NEXT__;
  const importNext = window.__IMPORT_NEXT__;
  if (!exportNext && !importNext) return;
  const pid = exportNext ? exportNext.pid : null;
  const opts = exportNext ? exportNext.opts : null;
  const saveBtn = document.getElementById('btn-prox-save');
  const setBusy = (flag) => { if (saveBtn) saveBtn.disabled = !!flag; };
  const urlEl = document.getElementById('prox-url');
  const apiEl = document.getElementById('prox-api-port');
  const sshEl = document.getElementById('prox-ssh-port');
  const userEl = document.getElementById('prox-username');
  const passEl = document.getElementById('prox-password');
  const vsslEl = document.getElementById('prox-verify-ssl');
  const feedback = document.getElementById('prox-login-feedback');
  setBusy(true);
  try {
    const ensure = (s) => { if (!s) return ''; return /^https?:\/\//i.test(s) ? s : `https://${s}`; };
    const urlRaw = (urlEl?.value || '').trim();
    const url = ensure(urlRaw);
    const apiPort = Number((apiEl?.value || 8006));
    const sshPort = Number((sshEl?.value || 22));
    const username = (userEl?.value || '').trim();
    const password = passEl?.value || '';
    const verifySSL = !!(vsslEl?.checked);
    if (!url) { if (feedback) { feedback.textContent = 'Enter Proxmox URL'; feedback.className = 'me-auto small text-danger'; } return; }
    if (!username || !password) { if (feedback) { feedback.textContent = 'Enter username and password'; feedback.className = 'me-auto small text-danger'; } return; }

    // If exporting, we can verify and persist onto the project.
    if (exportNext) {
      const data = await http('GET', '/api/projects');
      const proj = (data.projects || []).find(p => p.id === pid);
      if (!proj) { alert('Project not found.'); return; }
      try {
        await http('PATCH', `/api/projects/${encodeURIComponent(pid)}`, {
          proxmox_url: url, proxmox_api_port: apiPort, proxmox_ssh_port: sshPort, proxmox_verify_ssl: verifySSL
        });
      } catch { }
      try { sessionStorage.setItem(`toolhub.session.proxmox.${pid}`, JSON.stringify({ username, password })); } catch { }
      let verify;
      try {
        await runQueued(`Verify Proxmox login for ${proj?.name || pid}`, async () => {
          verify = await http('POST', `/api/projects/${encodeURIComponent(pid)}/proxmox/verify`, {
            baseUrl: url, apiPort, sshPort, username, password, verifySSL
          });
        }, { projectId: pid });
      } catch (e) {
        verify = { ok: false, proxmox_ok: false, ssh_ok: false, proxmox_error: e?.message || 'verify failed' };
      }
      if (!verify || !verify.ok) {
        const apiOk = !!(verify && verify.proxmox_ok);
        const sshOk = !!(verify && verify.ssh_ok);
        const apiErr = (verify && verify.proxmox_error) ? String(verify.proxmox_error) : '';
        const sshErr = (verify && verify.ssh_error) ? String(verify.ssh_error) : '';
        const details = [apiErr, sshErr].filter(Boolean).join(' | ');
        const msg = (!apiOk && !sshOk) ? 'Neither Proxmox API nor SSH could be reached.' : (!apiOk ? 'Proxmox API could not be reached.' : 'SSH could not be reached.');
        if (feedback) { feedback.textContent = `${msg} ${details}`.trim(); feedback.className = 'me-auto small text-danger'; }
        try { sessionStorage.removeItem(`toolhub.session.proxmox.${pid}`); } catch { }
        return;
      }
      try {
        const modalEl = document.getElementById('proxLoginModal');
        const bs = window.bootstrap;
        const m = (bs && modalEl) ? bs.Modal.getInstance(modalEl) : null;
        if (m) m.hide();
      } catch { }
      try { (window.shell && shell.logSuccess) ? shell.logSuccess('Proxmox login verified (API + SSH)') : console.log('Proxmox login verified'); } catch { }
      await startExportJob(pid, opts);
      return;
    }

    // Import path: store session creds and start async import job.
    if (importNext) {
      const file = importNext.file;
      if (!file) { if (feedback) { feedback.textContent = 'No import file selected.'; feedback.className = 'me-auto small text-danger'; } return; }
      _writeImportProxCreds({ baseUrl: url, apiPort, sshPort, username, password, verifySSL });
      try {
        const modalEl = document.getElementById('proxLoginModal');
        const bs = window.bootstrap;
        const m = (bs && modalEl) ? bs.Modal.getInstance(modalEl) : null;
        if (m) m.hide();
      } catch { }
      window.__IMPORT_NEXT__ = null;
      const prox = { baseUrl: url, apiPort, sshPort, username, password, verifySSL };

      // Do not keep the modal's Save button disabled for the entire import.
      // Imports can take a long time; users may close/re-open the dialog.
      try { setBusy(false); } catch { }

      const st = await _runAsyncImportWithProx({
        file,
        includeCreds: !!importNext.includeCreds,
        includeVms: !!importNext.includeVms,
        importAsTemplates: !!importNext.importAsTemplates,
        prox,
      });
      if (st && typeof st === 'object' && String(st.status || '') === 'cancelled') {
        try { showToast('Import cancelled.', 'warning'); } catch { }
        return;
      }
      // Post-success refresh
      const importedId = (Array.isArray(st?.imported) && st.imported[0]?.id) || '';
      try {
        const input = document.getElementById('import-file');
        if (input) input.value = '';
      } catch { }
      try { if (importedId && window.shell && typeof shell.setCurrentProjectId === 'function') shell.setCurrentProjectId(importedId); } catch { }
      try { await loadProjects(); } catch { }
      try { if (window.shell && typeof shell.refreshSidebar === 'function') await shell.refreshSidebar('config'); } catch { }
      try { showToast('Project imported.', 'success'); } catch { }
      return;
    }
  } catch (err) {
    if (feedback) {
      feedback.textContent = 'Login failed: ' + (err && err.message ? err.message : 'Unknown error');
      feedback.className = 'me-auto small text-danger';
    }
    try { (window.shell && shell.logError) ? shell.logError('Proxmox login failed: ' + (err && err.message ? err.message : err)) : console.error('Proxmox login failed:', err); } catch { }
  } finally {
    setBusy(false);
  }
}

// If the Proxmox login modal is dismissed, clear any pending action.
try {
  document.addEventListener('shown.bs.modal', (ev) => {
    try {
      if (!ev || !ev.target || ev.target.id !== 'proxLoginModal') return;
      const btn = document.getElementById('btn-prox-save');
      if (btn) btn.disabled = false;
      const feedback = document.getElementById('prox-login-feedback');
      if (feedback) { feedback.textContent = ''; feedback.className = 'me-auto small'; }
    } catch { }
  });
  document.addEventListener('hidden.bs.modal', (ev) => {
    try {
      if (!ev || !ev.target || ev.target.id !== 'proxLoginModal') return;
      window.__EXPORT_NEXT__ = null;
      window.__IMPORT_NEXT__ = null;
    } catch { }
  });
} catch { }

// Toast helper for this page
function showToast(message, type) {
  try {
    // Style: avoid a trailing "hard stop" on toast messages.
    try {
      let s = String(message ?? '');
      // Remove a single trailing period, but keep ellipses.
      if (s.endsWith('.') && !s.endsWith('...')) s = s.slice(0, -1);
      message = s;
    } catch { }

    let container = document.getElementById('toastContainer');
    if (!container) {
      container = document.createElement('div');
      container.id = 'toastContainer';
      container.className = 'toast-container position-fixed top-0 end-0 p-3';
      container.style.zIndex = '1080';
      document.body.appendChild(container);
    }
    if (!window.bootstrap) {
      try { console.log(String(message || '')); } catch { }
      return;
    }
    const el = document.createElement('div');
    el.className = `toast align-items-center text-bg-${type || 'info'} border-0`;
    el.role = 'alert';
    el.ariaLive = 'assertive';
    el.ariaAtomic = 'true';
    el.innerHTML = `
      <div class="d-flex">
        <div class="toast-body">${escHtml(String(message || ''))}</div>
        <button type="button" class="btn-close btn-close-white me-2 m-auto" data-bs-dismiss="toast" aria-label="Close"></button>
      </div>`;
    container.appendChild(el);
    const t = new bootstrap.Toast(el, { delay: 3500 });
    t.show();
    el.addEventListener('hidden.bs.toast', () => el.remove());
  } catch {
    try { console.log(String(message || '')); } catch { }
  }
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
    const currentList = collectCredentials(pid);
    const inst = Number(document.getElementById(`cfg-${pid}-instances`)?.value || 0);
    const digits = Math.max(String(inst).length, 1);
    const pad = (n) => String(n).padStart(digits, '0');
    const randPwd = () => {
      const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
      let s = '';
      for (let i = 0; i < 8; i++) s += chars[Math.floor(Math.random() * chars.length)];
      return s;
    };
    const nextIdx = currentList.length + 1;
    const username = `user${pad(nextIdx)}`;
    const password = randPwd();

    const wrapper = document.createElement('div');
    wrapper.className = 'row g-2 align-items-center mb-1';
    wrapper.innerHTML = `<div class="col-md-5"><input class="form-control form-control-sm" placeholder="username" title="Credential username" value="${username}"></div>
      <div class="col-md-5"><input class="form-control form-control-sm" placeholder="password" title="Credential password (8+ chars)" value="${password}"></div>
      <div class="col-md-2 d-flex justify-content-end"><button class="btn btn-sm btn-outline-danger">Remove</button></div>`;
    wrapper.querySelector('button')?.addEventListener('click', () => { wrapper.remove(); onCredentialChanged(pid); });
    host.appendChild(wrapper);
    updateCredControls(pid);
    try { wrapper.querySelectorAll('input').forEach(inp => inp.addEventListener('input', () => onCredentialChanged(pid))); } catch { }
    onCredentialChanged(pid);
  } catch { }
}
function removeCredentialRow(pid, btn) {
  try { const row = btn.closest('.row'); if (row) row.remove(); updateCredControls(pid); onCredentialChanged(pid); } catch { }
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
  if (arr.length < inst) {
    const digits = Math.max(String(inst).length, 1);
    const pad = (n) => String(n).padStart(digits, '0');
    const randPwd = () => {
      const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
      let s = '';
      for (let i = 0; i < 8; i++) s += chars[Math.floor(Math.random() * chars.length)];
      return s;
    };
    while (arr.length < inst) {
      arr.push({ username: `user${pad(arr.length + 1)}`, password: randPwd() });
    }
  }
  return arr;
}
function updateCredControls(pid) {
  try {
    const inst = Number(document.getElementById(`cfg-${pid}-instances`)?.value || 0);
    const list = collectCredentials(pid);
    const addBtn = document.getElementById(`cred-add-${pid}`);
    if (addBtn) addBtn.disabled = list.length >= inst && inst > 0;
    updateCredDownloadState(pid);
  } catch { }
}
function updateCredDownloadState(pid) {
  try {
    const btn = document.getElementById(`cred-download-${pid}`);
    if (!btn) return;
    const list = collectCredentials(pid);
    const ok = list.some(c => c.username && c.password && c.password.length >= 8);
    btn.disabled = !ok;
  } catch { }
}

// Harmonize credential rows when Instances or Tag change
function onInstancesChange(pid) {
  try {
    const instInput = document.getElementById(`cfg-${pid}-instances`);
    const inst = Number(instInput?.value || 0);
    const credInst = document.getElementById(`cred-${pid}-instances`);
    if (credInst && Number(credInst.value) !== inst) {
      credInst.value = inst;
    }
    if (instInput && Number(instInput.value) !== inst) {
      instInput.value = inst;
    }
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
  } catch { }
}

function onTagChange(pid) {
  try {
    const el = document.getElementById(`cfg-${pid}-tag`);
    if (!el) return;
    const ok = /^[A-Za-z-]+$/.test((el.value || '').trim());
    el.classList.toggle('is-invalid', !ok);
  } catch { }
}

// CSV upload: replace credentials up to Instances
async function uploadCredentialsFile(pid) {
  try {
    const input = document.getElementById(`cfg-${pid}-cred-file`);
    const warn = document.getElementById(`cred-warn-${pid}`);
    if (!input || !input.files || input.files.length === 0) return;
    const file = input.files[0];
    const existing = collectCredentials(pid);
    const text = await file.text();
    const lines = String(text || '').split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);
    const creds = [];
    const stripBom = s => s && s.charCodeAt(0) === 0xFEFF ? s.slice(1) : s;
    const isHeader = (a, b) => (String(a || '').toLowerCase() === 'username' && String(b || '').toLowerCase() === 'password');
    for (let i = 0; i < lines.length; i++) {
      let line = stripBom(lines[i]);
      // Basic CSV splitting with quotes support for two fields
      let a = '', b = '';
      const parseTwo = (s) => {
        const out = [];
        let cur = '';
        let inQ = false;
        for (let j = 0; j < s.length; j++) {
          const ch = s[j];
          if (ch === '"') { inQ = !inQ; continue; }
          if (!inQ && ch === ',') { out.push(cur); cur = ''; continue; }
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
      a = (parts[0] || '').trim();
      b = (parts[1] || '').trim();
      if (i === 0 && isHeader(a, b)) continue; // skip header
      if (!a && !b) continue;
      creds.push({ username: a, password: b });
    }
    let inst = Number(document.getElementById(`cfg-${pid}-instances`)?.value || 0);
    if (inst > 0 && creds.length !== inst && creds.length > 0) {
      const msg = `The CSV contains ${creds.length} rows, but the number of VM clones/users is currently set to ${inst}.\n\nWould you like to change the number of clones/users to ${creds.length} to match the file?`;
      const selection = await window.showConfirmModal("Update Instance Count?", msg, {
        confirmText: "Yes, Change Count",
        confirmClass: "btn-primary",
        noText: "No, Keep Count",
        noClass: "btn-outline-secondary",
        cancelText: "Cancel Import"
      });
      if (selection === 'cancel') {
        try { input.value = ''; } catch { }
        return;
      }
      if (selection === 'yes') {
        const instInput = document.getElementById(`cfg-${pid}-instances`);
        if (instInput) {
          instInput.value = creds.length;
          onInstancesChange(pid);
          debounceProjectSave(pid, 'instances');
          inst = creds.length;
        }
      }
    }
    let applied = creds;
    if (inst > 0) applied = creds.slice(0, inst);
    const targetLength = inst > 0 ? inst : Math.max(existing.length, applied.length);
    const merged = [];
    for (let i = 0; i < targetLength; i++) {
      if (i < applied.length) {
        const item = applied[i] || { username: '', password: '' };
        merged.push({ username: item.username || '', password: item.password || '' });
      } else if (i < existing.length) {
        const item = existing[i] || { username: '', password: '' };
        merged.push({ username: item.username || '', password: item.password || '' });
      } else {
        merged.push({ username: '', password: '' });
      }
    }
    const host = document.getElementById(`cred-${pid}-list`);
    if (host) {
      const renderList = targetLength > 0 ? merged : applied;
      host.innerHTML = renderCredentials(pid, renderList);
    }
    if (warn) {
      if (creds.length === 0) warn.textContent = 'No valid rows found. Expected two columns: username,password';
      else if (inst > 0 && creds.length > inst) warn.textContent = `Imported ${applied.length} of ${creds.length} rows (trimmed to Instances=${inst}).`;
      else warn.textContent = `Imported ${applied.length} rows.`;
    }
    // Clear the file input so the same file can be re-selected later
    try { input.value = ''; } catch { }
    updateCredControls(pid);
    onCredentialChanged(pid);
    try { showToast('Credentials imported from CSV', 'success'); } catch { }
  } catch (e) {
    try { showToast('Failed to import CSV: ' + (e?.message || e), 'danger'); } catch { }
  }
}

// Auto-generate credentials: one per Instance with 8-char uppercase passwords
function generateCredentials(pid) {
  try {
    const inst = Number(document.getElementById(`cfg-${pid}-instances`)?.value || 0);
    const digits = String(inst).length;
    const pad = (n) => String(n).padStart(digits, '0');
    const randPwd = () => {
      const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
      let s = '';
      for (let i = 0; i < 8; i++) s += chars[Math.floor(Math.random() * chars.length)];
      return s;
    };
    const list = [];
    for (let i = 1; i <= inst; i++) list.push({ username: `user${pad(i)}`, password: randPwd() });
    const host = document.getElementById(`cred-${pid}-list`);
    if (host) host.innerHTML = renderCredentials(pid, list);
    const warn = document.getElementById(`cred-warn-${pid}`);
    if (warn) warn.textContent = '';
    updateCredControls(pid);
    onCredentialChanged(pid);
    try { showToast(`Generated ${inst} credentials`, `info`); } catch { }
  } catch { }
}

// Download credentials as CSV
function downloadCredentials(pid) {
  try {
    const rows = collectCredentials(pid).filter(c => c && c.username);
    if (rows.length === 0) { showToast('No credentials to download', 'warning'); return; }
    const header = 'username,password';
    const csv = [header].concat(rows.map(c => {
      const u = String(c.username || '').replaceAll('"', '""');
      const p = String(c.password || '').replaceAll('"', '""');
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
  } catch { }
}
// Credential auto-save (usernames/passwords)
const _credSaveTimers = {};
function onCredentialChanged(pid) {
  updateCredDownloadState(pid);
  if (_credSaveTimers[pid]) clearTimeout(_credSaveTimers[pid]);
  let status = document.getElementById(`cred-status-${pid}`);
  if (!status) {
    try {
      const container = document.getElementById(`cred-${pid}-list`);
      if (container) {
        status = document.createElement('div');
        status.id = `cred-status-${pid}`;
        status.className = 'small text-muted mb-1';
        container.parentElement.insertBefore(status, container);
      }
    } catch { }
  }
  if (status) { status.textContent = 'Saving…'; status.className = 'small text-muted'; }
  _credSaveTimers[pid] = setTimeout(() => _saveCredentialsNow(pid), 600);
}
async function _saveCredentialsNow(pid) {
  delete _credSaveTimers[pid];
  try {
    const creds = harmonizeCredentialsToInstances(pid, collectCredentials(pid));
    await http('PATCH', `/api/projects/${pid}`, { credentials: creds });
    const status = document.getElementById(`cred-status-${pid}`);
    if (status) { status.textContent = 'Saved'; status.className = 'small text-success'; setTimeout(() => { if (status && status.textContent === 'Saved') status.textContent = ''; }, 1500); }
  } catch (e) {
    const status = document.getElementById(`cred-status-${pid}`);
    if (status) { status.textContent = 'Error'; status.className = 'small text-danger'; }
    try { showToast('Failed to auto-save credentials', 'danger'); } catch { }
  }
}
