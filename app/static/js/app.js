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
  } catch {}
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
  } catch {}
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
  } catch {}
  const res = await fetch(url, opts);
  if (!res.ok) {
    let msg = res.statusText;
    let bodyText = '';
    try { bodyText = (await res.text()) || ''; } catch {}
    if (bodyText) msg = bodyText;
    // Remote-mode enforcement uses HTTP 403; show a friendly message when possible.
    try {
      if (res.status === 403) {
        let extracted = '';
        try {
          const parsed = JSON.parse(bodyText || '{}');
          extracted = (parsed && (parsed.error || parsed.message)) ? String(parsed.error || parsed.message) : '';
        } catch {}
        const warn = extracted || (bodyText || 'Action is disabled when app is running in remote mode.');
        try { if (typeof window.showToast === 'function') window.showToast(warn, 'warning'); } catch {}
      }
    } catch {}
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
  // Prefer dedicated UI settings key.
  try {
    const raw = localStorage.getItem(UI_SETTINGS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw || '{}') || {};
      if (parsed && typeof parsed === 'object') return parsed;
    }
  } catch {}
  // Legacy migration: older versions stored UI settings in `toolhub.settings.v1`.
  // That key is now owned by `shell.js` for runMode, so copy everything except `runMode`.
  try {
    const legacy = JSON.parse(localStorage.getItem(UI_SETTINGS_KEY_LEGACY) || '{}') || {};
    if (legacy && typeof legacy === 'object') {
      try { delete legacy.runMode; } catch {}
      try {
        if (Object.keys(legacy).length) {
          localStorage.setItem(UI_SETTINGS_KEY, JSON.stringify(legacy));
        }
      } catch {}
      return legacy;
    }
  } catch {}
  return {};
}
function writeSettings(s) { try { localStorage.setItem(UI_SETTINGS_KEY, JSON.stringify(s || {})); } catch {} }

const PROJECT_AUDIO_CACHE = {};
const PROJECT_AUDIO_LOADED = new Set();

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
  ctfdFirstCategoryTeam: { category: 'Reverse Engineering', team_first: 'Team Aurora' },
  ctfdCountdownStop: { reason: 'challenges_hidden', reason_clause: ' while challenges are hidden' }
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
  try { if (window.shell && shell.isRemote && shell.isRemote()) return; } catch {}
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
function cloneAudioEntry(entry){ try { return JSON.parse(JSON.stringify(entry || {})); } catch { return {}; } }
function projectAudioCacheKey(pid){ return String(pid || '').trim(); }
async function loadProjectAudio(pid, options){
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
      try { (window.shell && shell.logWarn) ? shell.logWarn(`Settings: failed to load audio for project ${id}: ${err?.message || err}`) : console.warn('Settings: failed to load audio', id, err); } catch {}
    }
    if (!PROJECT_AUDIO_LOADED.has(id)) return {};
    return cloneSettingsAudio(PROJECT_AUDIO_CACHE[id] || {});
  }
}
function peekProjectAudio(pid){
  const id = projectAudioCacheKey(pid);
  if (!id) return null;
  if (!PROJECT_AUDIO_LOADED.has(id)) return null;
  return PROJECT_AUDIO_CACHE[id] || {};
}
function getProjectAudio(pid){
  const cached = peekProjectAudio(pid);
  if (cached === null) return {};
  return cloneSettingsAudio(cached || {});
}
function projectAudioIsLoaded(pid){
  const id = projectAudioCacheKey(pid);
  if (!id) return false;
  return PROJECT_AUDIO_LOADED.has(id);
}
async function saveProjectAudio(pid, audio){
  const id = projectAudioCacheKey(pid);
  if (!id) throw new Error('Project id required to save audio');
  const payload = { audio: cloneSettingsAudio(audio || {}) };
  const res = await http('PUT', `/api/projects/${id}/audio`, payload);
  const normalized = res && typeof res.audio === 'object' ? res.audio : {};
  const sanitized = cloneSettingsAudio(normalized);
  PROJECT_AUDIO_CACHE[id] = sanitized;
  PROJECT_AUDIO_LOADED.add(id);
  const detailAudio = cloneSettingsAudio(sanitized);
  try { document.dispatchEvent(new CustomEvent('project-audio-updated', { detail: { pid: id, audio: detailAudio } })); } catch {}
  return detailAudio;
}
window.loadProjectAudio = loadProjectAudio;
window.saveProjectAudio = saveProjectAudio;
window.getProjectAudio = getProjectAudio;
window.peekProjectAudio = peekProjectAudio;
window.projectAudioIsLoaded = projectAudioIsLoaded;

// Project audio store prefixes
const AUDIO_MEDIA_PREFIX = 'media:';
const AUDIO_EVENT_PREFIX = 'event:';

function audioMakeMediaKey(){
  let id = '';
  try {
    if (typeof crypto !== 'undefined' && crypto && typeof crypto.randomUUID === 'function') {
      id = crypto.randomUUID();
    }
  } catch {}
  if (!id) {
    id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }
  return `${AUDIO_MEDIA_PREFIX}${id}`;
}

function audioIsMediaKey(key){
  return typeof key === 'string' && key.startsWith(AUDIO_MEDIA_PREFIX);
}

function audioNormalizeSingleSound(entry){
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

function audioListMediaItems(audioStore){
  const store = audioStore && typeof audioStore === 'object' ? audioStore : {};
  const items = [];
  Object.entries(store).forEach(([key, entry]) => {
    if (!audioIsMediaKey(String(key))) return;
    const sound = audioNormalizeSingleSound(entry);
    if (!sound) return;
    items.push({ key: String(key), ...sound });
  });
  items.sort((a, b) => (b.updated || 0) - (a.updated || 0) || String(a.name).localeCompare(String(b.name)));
  return items;
}

function mediaManagerReadCurrentPid(){
  try {
    return (window.shell && shell.getCurrentProjectId) ? String(shell.getCurrentProjectId() || '').trim() : '';
  } catch {
    return '';
  }
}

function mediaManagerRemoteBlocked(){
  try { return !!(window.shell && shell.isRemote && shell.isRemote()); } catch { return false; }
}

function mediaManagerReadFileAsDataUrl(file){
  return new Promise((resolve, reject) => {
    try {
      const reader = new FileReader();
      reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
      reader.onerror = () => reject(new Error('Failed to read file'));
      reader.readAsDataURL(file);
    } catch (err) {
      reject(err);
    }
  });
}

async function mediaManagerUploadFile(file){
  if (!file) return;
  if (mediaManagerRemoteBlocked()) return;
  if (file.size > SETTINGS_AUDIO_MAX_BYTES) {
    alert('Audio file too large. Limit is 600 KB per file.');
    return;
  }
  const pid = mediaManagerReadCurrentPid();
  if (!pid) {
    alert('Select a project first.');
    return;
  }
  const dataUrl = await mediaManagerReadFileAsDataUrl(file);
  if (!dataUrl || !dataUrl.startsWith('data:')) {
    alert('Unsupported audio format.');
    return;
  }
  const audioStore = await loadProjectAudio(pid, { force: true, silent: true });
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
}

async function mediaManagerDeleteItem(mediaKey){
  if (mediaManagerRemoteBlocked()) return;
  const pid = mediaManagerReadCurrentPid();
  if (!pid) return;
  const key = String(mediaKey || '');
  if (!audioIsMediaKey(key)) return;
  const audioStore = await loadProjectAudio(pid, { force: true, silent: true });
  if (!Object.prototype.hasOwnProperty.call(audioStore, key)) return;
  delete audioStore[key];
  // Clear any per-event references to this media key
  Object.entries(audioStore).forEach(([k, v]) => {
    if (!k || typeof k !== 'string') return;
    if (!k.startsWith(AUDIO_EVENT_PREFIX)) return;
    if (!v || typeof v !== 'object') return;
    if (v.soundKey === key) {
      try { delete v.soundKey; } catch {}
    }
  });
  await saveProjectAudio(pid, audioStore);
}

async function mediaManagerRefreshList(options){
  const opts = options && typeof options === 'object' ? options : {};
  const listEl = document.getElementById('settings-media-list');
  const statusEl = document.getElementById('settings-media-status');
  if (!listEl) return;

  const pid = mediaManagerReadCurrentPid();
  if (!pid) {
    if (statusEl) statusEl.textContent = 'Select a project to manage media.';
    listEl.innerHTML = '<li class="list-group-item small text-muted">No project selected.</li>';
    return;
  }
  if (statusEl) statusEl.textContent = 'Loading…';
  let audioStore = {};
  try {
    audioStore = await loadProjectAudio(pid, { force: !!opts.force, silent: true });
  } catch {
    audioStore = getProjectAudio(pid) || {};
  }
  const items = audioListMediaItems(audioStore);
  if (!items.length) {
    listEl.innerHTML = '<li class="list-group-item small text-muted">No uploaded audio yet.</li>';
    if (statusEl) statusEl.textContent = '';
    return;
  }
  listEl.innerHTML = items.map(item => {
    const safeName = escHtml(item.name || 'Audio');
    const sizeKb = item.size ? `${Math.round(item.size / 1024)} KB` : 'Size unknown';
    const typeLabel = item.type ? escHtml(item.type) : 'Audio';
    const meta = `${sizeKb} | ${typeLabel}`;
    return `<li class="list-group-item d-flex align-items-center justify-content-between gap-2" data-media-key="${escHtml(item.key)}">
  <div class="flex-grow-1">
    <div>${safeName}</div>
    <div class="small text-muted">${meta}</div>
  </div>
  <div class="btn-group btn-group-sm">
    <button type="button" class="btn btn-outline-secondary" data-action="media-preview">Preview</button>
    <button type="button" class="btn btn-outline-danger" data-action="media-delete">Delete</button>
  </div>
</li>`;
  }).join('');
  if (statusEl) statusEl.textContent = '';
}

function mediaManagerOpenCollapse(){
  const el = document.getElementById('settings-media-collapse');
  if (!el) return;
  try {
    if (window.bootstrap && bootstrap.Collapse) {
      const inst = bootstrap.Collapse.getInstance(el) || new bootstrap.Collapse(el, { toggle: false });
      inst.show();
      return;
    }
  } catch {}
  try { el.classList.add('show'); } catch {}
}

function wireMediaManagerControls(){
  const upload = document.getElementById('settings-media-upload');
  const refresh = document.getElementById('settings-media-refresh');
  const list = document.getElementById('settings-media-list');
  if (upload && !upload._toolhubBound) {
    upload.addEventListener('change', async (ev) => {
      const file = ev.target && ev.target.files && ev.target.files[0];
      const hadFile = !!file;
      let uploadedOk = false;
      try {
        if (file) {
          await mediaManagerUploadFile(file);
          uploadedOk = true;
        }
      } catch (err) {
        try { showToast(`Media upload failed: ${err?.message || err}`, 'warning'); } catch {}
      }
      try { ev.target.value = ''; } catch {}
      try { await mediaManagerRefreshList({ force: true }); } catch {}
      if (hadFile && uploadedOk) {
        try { mediaManagerOpenCollapse(); } catch {}
      }
    });
    upload._toolhubBound = true;
  }
  if (refresh && !refresh._toolhubBound) {
    refresh.addEventListener('click', () => mediaManagerRefreshList({ force: true }));
    refresh._toolhubBound = true;
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
          const pid = mediaManagerReadCurrentPid();
          if (!pid) return;
          const audioStore = getProjectAudio(pid) || {};
          const entry = audioStore[key];
          const sound = audioNormalizeSingleSound(entry);
          if (!sound || !sound.dataUrl) return;
          const audio = new Audio(sound.dataUrl);
          audio.play().catch(()=>{});
        } catch {}
        return;
      }
      if (action === 'media-delete') {
        if (!confirm('Delete this uploaded audio file?')) return;
        try {
          await mediaManagerDeleteItem(key);
        } catch (err) {
          try { showToast(`Delete failed: ${err?.message || err}`, 'warning'); } catch {}
        }
        try { await mediaManagerRefreshList({ force: true }); } catch {}
      }
    });
    list._toolhubBound = true;
  }
}
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
async function settingsModalResetFromStorage(){
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
  try {
    const remoteToggle = document.getElementById('settings-run-remote');
    if (remoteToggle) {
      let checked = false;
      try { checked = !!(window.shell && shell.isRemote && shell.isRemote()); } catch {}
      if (!checked) checked = (settings && settings.runMode === 'remote');
      remoteToggle.checked = !!checked;
    }
  } catch {}
  try { if (window.shell && shell.applyRemoteModeUI) shell.applyRemoteModeUI(); } catch {}
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
  Object.keys(SETTINGS_AUDIO_FIELDS).forEach((key)=>{
    const saved = projectAudio && typeof projectAudio[key] === 'object' ? cloneAudioEntry(projectAudio[key]) : {};
    if (saved && saved.enabled === undefined) saved.enabled = settingsAudioDefaultEnabled(key);
    if (saved && saved.speak === undefined) saved.speak = settingsAudioDefaultSpeak(key);
    settingsAudioNormalizeLegacyTemplate(saved, key);
    _settingsAudioWorking[key] = saved && typeof saved === 'object' ? saved : {};
    settingsAudioEnsureEntry(key);
  });
  settingsModalUpdateAllAudio();
  if (loadError && currentPid) {
    try { showToast('Project audio could not be loaded. Using local copy.', 'warning'); } catch {}
  }
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
  try { if (window.shell && shell.isRemote && shell.isRemote()) return; } catch {}
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
  // Legacy notifications/audio editor removed; Media Manager owns uploads.
  wireSettingsTtsControls();
  wireMediaManagerControls();
  modal.addEventListener('show.bs.modal', settingsModalResetFromStorage);
  modal.addEventListener('show.bs.modal', () => { try { mediaManagerRefreshList({ force: true }); } catch {} });
  modal.addEventListener('hidden.bs.modal', settingsModalResetFromStorage);
  settingsModalResetFromStorage();
}
window.prepareSettingsModal = wireSettingsModal;
async function saveSettingsInternal(){
  const settings = readSettings();
  const defCfg = document.getElementById('def-cfg');
  const defVm = document.getElementById('def-vm');
  const defMat = document.getElementById('def-mat');
  if (defCfg) settings.defaultCfgExpanded = !!defCfg.checked;
  if (defVm) settings.defaultVmExpanded = !!defVm.checked;
  if (defMat) settings.defaultMatExpanded = !!defMat.checked;
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
    try { delete settings.runMode; } catch {}
  } catch {}
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
  try { document.dispatchEvent(new CustomEvent('settings-changed', { detail: { settings } })); } catch {}
  let resetFailed = false;
  try {
    await settingsModalResetFromStorage();
  } catch (err) {
    resetFailed = true;
    try { (window.shell && shell.logWarn) ? shell.logWarn(`Settings: failed to refresh UI after save: ${err?.message || err}`) : console.warn('Settings: failed to refresh settings UI after save', err); } catch {}
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
  try { showToast(toastMessage, toastLevel); } catch {}
  const modal = document.getElementById('settingsModal');
  if (modal && window.bootstrap && window.bootstrap.Modal) {
    // Ensure remote-mode UI changes apply immediately after the settings modal closes.
    try {
      modal.addEventListener('hidden.bs.modal', () => {
        try { if (window.shell && shell.applyRemoteModeUI) shell.applyRemoteModeUI(); } catch {}
      }, { once: true });
    } catch {}
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
    // Ensure any dynamically rendered controls get remote-mode disabling.
    try { if (window.shell && shell.applyRemoteModeUI) shell.applyRemoteModeUI(container); } catch {}
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

function escHtml(s) {
  if (s === null || s === undefined) return '';
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;','\'':'&#39;'}[c]));
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
  const startSteps = getStartCommandsFromDom(pid, idx);
  const startCommands = stepsToServerPayload(startSteps);
  const storedSteps = getStoredCommandsFromDom(pid, idx);
  const storedCommands = stepsToServerPayload(storedSteps);
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
  try { wireStartCommandsModal(); } catch {}
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
    try { showToast('Start commands updated.', 'success'); } catch {}
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
  try { wireStoredCommandsModal(); } catch {}
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
    try { showToast('Stored commands updated.', 'success'); } catch {}
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
        ${(function(){
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
        <div class="col-md-4">
          <label class="form-label">Stored Commands</label>
          ${(function(){
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
            ${(v.internal_network_adaptors||[]).map((c, idx) => listItemTemplate(`vm-${p.id}-${i}-nets-list`, c, idx)).join('')}
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
function readPersistProxCreds(pid){
  try {
    if (window.CREDS && typeof CREDS.readPersistProxCreds === 'function') return CREDS.readPersistProxCreds(pid) || {};
  } catch {}
  return {};
}
function readBestProxCreds(pid){
  const sess = readProxCreds(pid) || {};
  const persisted = readPersistProxCreds(pid) || {};
  return {
    username: (sess.username || persisted.username || ''),
    password: (sess.password || persisted.password || ''),
  };
}
function proxMetaKey(pid){ return `toolhub.session.proxmox.meta.${pid}`; }
function writeProxMeta(pid,obj){ try { sessionStorage.setItem(proxMetaKey(pid), JSON.stringify(obj||{})); } catch {} }
function normalizeUrl(s){ if (!s) return ''; return /^https?:\/\//i.test(s) ? s : `https://${s}`; }

function normalizeHost(raw){
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

function hostRoot(host){
  if (!host) return '';
  try { return String(host).split('.')[0].toLowerCase(); } catch { return ''; }
}

function deriveAfsCurrentNode(pid, templates, urlBase){
  const proj = (window.PROJ_CACHE||{})[pid] || {};
  const hostFull = normalizeHost(urlBase || proj.proxmox_url || '');
  const hostPrefix = hostRoot(hostFull);
  const tplNodes = Array.isArray(templates) ? templates.map(t => String(t.node||'')) : [];
  const tplLower = tplNodes.map(n => n.toLowerCase());

  const mapping = proj.proxmox_node_host_map || {};
  for (const [node, target] of Object.entries(mapping)){
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

function setAfsLoading(isLoading){
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

function setAfsFeedback(kind, message){
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

function describeAfsError(err){
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
    } catch {}
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

function openAddFromServer(pid){
  AFS_CTX = { pid, templates: [], selected: new Set(), currentNode: '' };
  // prefill from project cache and session creds
  const p = (window.PROJ_CACHE||{})[pid] || {};
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
        } catch {}
      }).catch(()=>{});
    }
  } catch {}
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
  const saveEl = document.getElementById('afs-save-creds');
  const list = document.getElementById('afs-list');
  const filterGroup = document.getElementById('afs-filter-group');
  const urlBase = normalizeUrl((urlEl?.value||'').trim());
  const apiPort = Number(portEl?.value||8006)||8006;
  if (!urlBase){
    setAfsFeedback('warning', 'Enter the Proxmox URL before fetching.');
    try { showToast('Enter Proxmox URL', 'warning'); } catch { alert('Enter Proxmox URL'); }
    return;
  }
  const baseUrl = urlBase.replace(/\/$/, '') + (apiPort ? '' : '') ; // API endpoints include /api2/json internally
  const body = { baseUrl, apiPort, verifySSL: !!(verEl?.checked), username: (uEl?.value||'').trim() || undefined, password: (pwEl?.value||'') || undefined };
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
        AFS_CTX.templates = items.map(t => ({ node: String(t.node||''), vmid: Number(t.vmid||0), name: String(t.name||''), bridges: Array.isArray(t.bridges)? t.bridges.map(b=>String(b||'')) : [] }));
        AFS_CTX.currentNode = deriveAfsCurrentNode(pid, AFS_CTX.templates, urlBase);
        // persist creds and meta for VM Manager prefill
        writeProxCreds(pid, { username: body.username||'', password: body.password||'' });
        writeProxMeta(pid, { url: urlBase, apiPort: apiPort, sshPort: Number(p.proxmox_ssh_port||22)||22 });
        // Optional: persist creds per project across sessions (server-side project secrets)
        try {
          const wantsPersist = !!(saveEl && saveEl.checked);
          if (window.CREDS && typeof CREDS.setPersistProxCreds === 'function') {
            if (wantsPersist) CREDS.setPersistProxCreds(pid, body.username || '', body.password || '', true);
            else CREDS.setPersistProxCreds(pid, '', '', false);
          }
        } catch {}
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
  } catch (e){
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
  const currentNode = String(AFS_CTX.currentNode||'').toLowerCase();
  const hasCurrent = currentNode && (AFS_CTX.templates||[]).some(t => String(t.node||'').toLowerCase() === currentNode);
  const restrict = !!hasCurrent;
  const ordered = items.slice().sort((a, b) => {
    if (restrict){
      const aPreferred = String(a.node||'').toLowerCase() === currentNode;
      const bPreferred = String(b.node||'').toLowerCase() === currentNode;
      if (aPreferred !== bPreferred) return aPreferred ? -1 : 1;
    }
    const nameCmp = String(a.name||'').localeCompare(String(b.name||''));
    if (nameCmp !== 0) return nameCmp;
    return Number(a.vmid||0) - Number(b.vmid||0);
  });
  let hasPreferredInFilter = false;
  const rows = ordered.map(t => {
    const key = `${t.node}|${t.vmid}|${t.name}`;
    const checked = AFS_CTX.selected.has(key) ? 'checked' : '';
    const bridges = (t.bridges||[]).join(', ');
    const nodeName = String(t.node||'');
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
    if (restrict){
      const info = hasPreferredInFilter ? 'Templates on other nodes are disabled.' : 'No templates on the current node match this filter.';
      notice = `<div class="small text-muted px-3 py-2 border-bottom">Current node: <strong>${escHtml(AFS_CTX.currentNode)}</strong>. ${escHtml(info)}</div>`;
    }
    list.innerHTML = `${notice}<div class="list-group list-group-flush">${rows}</div>`;
  }
  // wire checkbox changes
  try {
    if (!list) return;
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
  try {
    if (window.shell && typeof window.shell.refreshSidebar === 'function') {
      window.shell.refreshSidebar('config');
    }
  } catch {}
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

async function duplicateProject(id) {
  try {
    try { (window.shell && shell.logInfo) ? shell.logInfo(`Config: duplicating project ${id}…`) : console.log('Duplicating project', id); } catch {}
    const res = await http('POST', `/api/projects/${encodeURIComponent(id)}/duplicate`);
    const newId = res && (res.id || res.pid) ? (res.id || res.pid) : '';
    const newName = res && typeof res.name === 'string' ? res.name : '';
    try { if (newId && window.shell && shell.setCurrentProjectId) shell.setCurrentProjectId(newId); } catch {}
    await loadProjects();
    try { if (window.shell && shell.refreshSidebar) shell.refreshSidebar('config'); } catch {}
    const tail = newName ? ` as ${newName}` : '';
    try { showToast(`Project duplicated${tail}.`, 'success'); } catch {}
  } catch (e) {
    try { showToast('Failed to duplicate project: ' + (e?.message || e), 'danger'); } catch {}
    try { (window.shell && shell.logError) ? shell.logError('Config: duplicate project failed: ' + (e?.message || e)) : console.error('Duplicate project failed:', e); } catch {}
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

function getMaterialInputs(pid){
  return {
    files: document.getElementById(`file-${pid}`),
    folder: document.getElementById(`folder-${pid}`),
  };
}

function openMaterialPicker(pid, kind){
  try {
    const input = document.getElementById(`${kind}-${pid}`);
    if (input) input.click();
  } catch {}
}

function getMaterialPendingStore(pid){
  const key = String(pid ?? '');
  if (!window.MATERIAL_PENDING[key]) window.MATERIAL_PENDING[key] = [];
  return window.MATERIAL_PENDING[key];
}

function materialKeyFor(file, relPath){
  const pathPart = relPath ? String(relPath) : '';
  return `${pathPart}::${file.name}::${file.size}::${file.lastModified}`;
}

function materialFormatSize(bytes){
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

function getPendingMaterialFiles(pid){
  const store = getMaterialPendingStore(pid);
  const files = store.map(entry => entry.file);
  const folderCount = store.reduce((count, entry) => count + (entry.relativePath ? 1 : 0), 0);
  files.folderCount = folderCount;
  return files;
}

function renderMaterialPending(pid){
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

function stageMaterialSelection(pid){
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
  } catch {}
  try {
    if (inputs.folder?.files?.length) {
      Array.from(inputs.folder.files).forEach(file => {
        const rel = file.webkitRelativePath || '';
        pushFile(file, rel);
      });
    }
  } catch {}
  if (inputs.files) {
    try { inputs.files.value = ''; } catch {}
  }
  if (inputs.folder) {
    try { inputs.folder.value = ''; } catch {}
  }
  if (added.length) {
    store.sort((a, b) => a.sortKey.localeCompare(b.sortKey));
  }
  return added.length;
}

function onPendingMaterialsSelectionChange(pid){
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

function removeSelectedPendingMaterials(pid){
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

function onExistingMaterialsSelectionChange(pid){
  const select = document.getElementById(`mat-existing-${pid}`);
  const btn = document.getElementById(`btn-remove-existing-${pid}`);
  if (!btn) return;
  if (!select || !select.options.length) {
    btn.disabled = true;
    return;
  }
  btn.disabled = select.selectedOptions.length === 0;
}

async function removeSelectedExistingMaterials(pid){
  const select = document.getElementById(`mat-existing-${pid}`);
  if (!select) return;
  const names = Array.from(select.selectedOptions || []).map(opt => opt.value).filter(Boolean);
  if (!names.length) {
    try { showToast('Select materials to remove first.', 'warning'); } catch { alert('Select materials to remove first.'); }
    return;
  }
  const proj = (window.PROJ_CACHE||{})[pid] || {};
  const projectName = proj.name || pid;
  const count = names.length;
  const confirmMsg = `Remove ${count} selected material${count === 1 ? '' : 's'} from this project? This will delete the files from the server.`;
  if (!window.confirm(confirmMsg)) return;
  const errors = [];
  try {
    if (window.shell && typeof window.shell.beginActionContext === 'function') {
      window.shell.beginActionContext('Remove materials');
    }
  } catch {}
  try {
    if (window.shell && typeof window.shell.logWarn === 'function') {
      window.shell.logWarn(`Config: removing ${count} selected material${count === 1 ? '' : 's'} for ${projectName}`);
    }
  } catch {}
  const queueResult = await runQueued(`Remove selected materials for ${projectName}`, async () => {
    for (const fname of names) {
      try {
        try {
          if (window.shell && typeof window.shell.step === 'function') {
            window.shell.step(`Removing ${fname}`);
          }
        } catch {}
        await http('DELETE', `/api/projects/${pid}/materials/${encodeURIComponent(fname)}`);
      } catch (err) {
        errors.push({ name: fname, error: err });
      }
    }
  }, { projectId: pid });
  if (queueResult?.status === 'canceled' || queueResult?.status === 'skipped') {
    try { showToast('Material removal canceled.', 'warning'); } catch { alert('Material removal canceled.'); }
    try { if (window.shell && typeof window.shell.endActionContext === 'function') window.shell.endActionContext(false); } catch {}
    return;
  }
  try { await loadProjects(); } catch { loadProjects(); }
  try {
    if (window.shell && typeof window.shell.refreshSidebar === 'function') {
      window.shell.refreshSidebar('config');
    }
  } catch {}
  if (errors.length) {
    const failedNames = errors.map(e => e.name || 'unknown').join(', ');
    try { showToast(`Some materials failed to delete: ${failedNames}`, 'danger'); } catch { alert(`Some materials failed to delete: ${failedNames}`); }
    try {
      if (window.shell && typeof window.shell.logError === 'function') {
        window.shell.logError(`Config: remove materials failed for ${failedNames}`);
      }
    } catch {}
    try { if (window.shell && typeof window.shell.endActionContext === 'function') window.shell.endActionContext(false); } catch {}
    onExistingMaterialsSelectionChange(pid);
    return;
  }
  try { showToast('Selected materials removed.', 'success'); } catch { alert('Selected materials removed.'); }
  try {
    if (window.shell && typeof window.shell.logSuccess === 'function') {
      window.shell.logSuccess(`Config: removed selected materials for ${projectName}`);
    }
  } catch {}
  onExistingMaterialsSelectionChange(pid);
  const removeAllBtn = document.getElementById(`btn-remove-mat-${pid}`);
  if (removeAllBtn) removeAllBtn.disabled = !((window.PROJ_CACHE||{})[pid]?.materials || []).length;
  try { if (window.shell && typeof window.shell.endActionContext === 'function') window.shell.endActionContext(true); } catch {}
}

function collectMaterialFiles(pid){
  return getPendingMaterialFiles(pid);
}

function updateMaterialSelectionSummary(pid, files){
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

function onMaterialSelectionChange(pid){
  stageMaterialSelection(pid);
  renderMaterialPending(pid);
  const files = collectMaterialFiles(pid);
  updateMaterialSelectionSummary(pid, files);
}

function clearMaterialSelections(pid){
  const inputs = getMaterialInputs(pid);
  try { if (inputs.files) inputs.files.value = ''; } catch {}
  try { if (inputs.folder) inputs.folder.value = ''; } catch {}
  window.MATERIAL_PENDING[pid] = [];
  renderMaterialPending(pid);
  updateMaterialSelectionSummary(pid, []);
  onPendingMaterialsSelectionChange(pid);
}

function clearMaterialSelection(pid){
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
  const proj = (window.PROJ_CACHE||{})[id] || {};
  const label = files.length === 1 ? `Uploading 1 material` : `Uploading ${files.length} materials`;
  const projectName = proj.name || id;
  const errors = [];
  const btn = document.getElementById(`btn-upload-mat-${id}`);
  if (btn) btn.disabled = true;
  try {
    if (window.shell && typeof window.shell.beginActionContext === 'function') {
      window.shell.beginActionContext('Upload materials');
    }
  } catch {}
  try {
    if (window.shell && typeof window.shell.logInfo === 'function') {
      window.shell.logInfo(`Config: ${label} for ${projectName}`);
    } else {
      console.log('Uploading materials', projectName, files.length);
    }
  } catch {}
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
        } catch {}
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
    } catch {}
    try { if (window.shell && typeof window.shell.endActionContext === 'function') window.shell.endActionContext(false); } catch {}
    try { showToast('Material upload canceled.', 'warning'); } catch { alert('Material upload canceled.'); }
    return;
  }
  try { await loadProjects(); } catch { loadProjects(); }
  try { if (window.shell && shell.refreshSidebar) shell.refreshSidebar('config'); } catch {}
  if (errors.length) {
    const failedNames = errors.map(e => e.file?.name || 'unknown').join(', ');
    try { showToast(`Some materials failed to upload: ${failedNames}`, 'danger'); } catch { alert(`Some materials failed to upload: ${failedNames}`); }
    try {
      if (window.shell && typeof window.shell.logError === 'function') {
        window.shell.logError(`Config: material upload failed for ${failedNames}`);
      } else {
        console.error('Material upload failed for', failedNames);
      }
    } catch {}
    try { if (window.shell && typeof window.shell.endActionContext === 'function') window.shell.endActionContext(false); } catch {}
    return;
  }
  try { showToast('Materials uploaded.', 'success'); } catch { alert('Materials uploaded.'); }
  try {
    if (window.shell && typeof window.shell.logSuccess === 'function') {
      window.shell.logSuccess('Config: materials uploaded');
    } else {
      console.log('Materials uploaded');
    }
  } catch {}
  try { if (window.shell && typeof window.shell.endActionContext === 'function') window.shell.endActionContext(true); } catch {}
}

async function removeAllMaterials(pid) {
  const proj = (window.PROJ_CACHE||{})[pid] || {};
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
  } catch {}
  try {
    if (window.shell && typeof window.shell.logWarn === 'function') {
      window.shell.logWarn(`Config: removing ${count} material${count === 1 ? '' : 's'} for ${projectName}`);
    }
  } catch {}
  const queueResult = await runQueued(`Remove materials for ${projectName}`, async () => {
    for (const fname of mats) {
      try {
        try {
          if (window.shell && typeof window.shell.step === 'function') {
            window.shell.step(`Removing ${fname}`);
          }
        } catch {}
        await http('DELETE', `/api/projects/${pid}/materials/${encodeURIComponent(fname)}`);
      } catch (e) {
        errors.push({ name: fname, error: e });
      }
    }
  }, { projectId: pid });
  if (queueResult?.status === 'canceled' || queueResult?.status === 'skipped') {
    try { showToast('Material removal canceled.', 'warning'); } catch { alert('Material removal canceled.'); }
    try { if (window.shell && typeof window.shell.endActionContext === 'function') window.shell.endActionContext(false); } catch {}
    return;
  }
  try { await loadProjects(); } catch { loadProjects(); }
  try {
    if (window.shell && typeof window.shell.refreshSidebar === 'function') {
      window.shell.refreshSidebar('config');
    }
  } catch {}
  clearMaterialSelections(pid);
  onExistingMaterialsSelectionChange(pid);
  if (errors.length) {
    const failedNames = errors.map(e => e.name || 'unknown').join(', ');
    try { showToast(`Some materials failed to delete: ${failedNames}`, 'danger'); } catch { alert(`Some materials failed to delete: ${failedNames}`); }
    try {
      if (window.shell && typeof window.shell.logError === 'function') {
        window.shell.logError(`Config: remove materials failed for ${failedNames}`);
      }
    } catch {}
    try { if (window.shell && typeof window.shell.endActionContext === 'function') window.shell.endActionContext(false); } catch {}
    const removeBtn = document.getElementById(`btn-remove-mat-${pid}`);
    if (removeBtn) removeBtn.disabled = false;
    const removeSelectedBtn = document.getElementById(`btn-remove-existing-${pid}`);
    if (removeSelectedBtn) removeSelectedBtn.disabled = !((window.PROJ_CACHE||{})[pid]?.materials || []).length;
    return;
  }
  try { showToast('All materials removed.', 'success'); } catch { alert('All materials removed.'); }
  try {
    if (window.shell && typeof window.shell.logSuccess === 'function') {
      window.shell.logSuccess(`Config: removed materials for ${projectName}`);
    }
  } catch {}
  const removeBtn = document.getElementById(`btn-remove-mat-${pid}`);
  if (removeBtn) removeBtn.disabled = true;
  const removeSelectedBtn = document.getElementById(`btn-remove-existing-${pid}`);
  if (removeSelectedBtn) removeSelectedBtn.disabled = true;
  try { if (window.shell && typeof window.shell.endActionContext === 'function') window.shell.endActionContext(true); } catch {}
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
  try {
    if (window.shell && shell.isRemote && shell.isRemote()) {
      try { showToast('Export is disabled in remote mode.', 'warning'); } catch { alert('Export is disabled in remote mode.'); }
      return;
    }
  } catch {}
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
      setBusy(true);
      let proceed = true;
      try {
        if (includeVms) {
          proceed = confirm('Exporting VMs can be very time-consuming. This will run on the remote machine, download disk files, and compress them. Continue?');
          if (!proceed) { return; }
        }
        if (includeVms) {
          try { m.hide(); } catch {}
          await gateExportThroughProxLogin(EXPORT_CONTEXT.pid, { includeCreds, includeVms });
        } else {
          try {
            if (typeof window.showActionProgress === 'function') {
              window.showActionProgress('Export', 'Preparing download…');
              if (typeof window.openActionProgressModal === 'function') window.openActionProgressModal();
            }
          } catch {}
          const a = document.createElement('a');
          a.href = `/api/projects/${encodeURIComponent(EXPORT_CONTEXT.pid)}/export?includeCreds=${includeCreds}&includeVms=${includeVms}`;
          // Give the modal a moment to render before starting the download
          setTimeout(() => { try { a.click(); } catch {} }, 50);
          try { (window.shell && shell.logSuccess) ? shell.logSuccess('Config: export started') : console.log('Export started'); } catch {}
          try { m.hide(); } catch {}
          // Best-effort: hide progress shortly after initiating download
          setTimeout(() => {
            try { if (typeof window.hideActionProgress === 'function') window.hideActionProgress(); } catch {}
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

async function performProjectImport(options = {}) {
  try {
    if (window.shell && shell.isRemote && shell.isRemote()) {
      try { showToast('Import is disabled in remote mode.', 'warning'); } catch { alert('Import is disabled in remote mode.'); }
      return false;
    }
  } catch {}
  const input = document.getElementById('import-file');
  if (!input || !input.files || !input.files[0]) return false;
  const file = input.files[0];
  const fd = new FormData();
  fd.append('file', file);
  if (options.includeCreds !== undefined) fd.append('includeCreds', options.includeCreds ? 'true' : 'false');
  if (options.includeVms !== undefined) fd.append('includeVms', options.includeVms ? 'true' : 'false');
  if (options.importAsTemplates !== undefined) fd.append('importAsTemplates', options.importAsTemplates ? 'true' : 'false');
  const label = `Import project: ${file.name}`;

  // Publish progress into the global queue/progress system so the user can hide/show
  // via the Queue dock, just like other tasks.
  try { if (typeof window.showActionProgress === 'function') window.showActionProgress('Import', 'Uploading…'); } catch {}

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
      if (bar) { bar.style.width = '0%'; bar.textContent = '0%'; bar.setAttribute('aria-valuenow','0'); }
      if (stat) stat.textContent = 'Uploading…';
      if (log) log.textContent = 'Preparing upload…';
      modalInst.show();
    } catch {}
  } else {
    // Fallback to action progress (only if import modal isn't available).
    try {
      if (typeof window.showActionProgress === 'function') {
        window.showActionProgress('Import', 'Uploading…');
        if (typeof window.openActionProgressModal === 'function') window.openActionProgressModal();
      }
    } catch {}
  }
  try {
    if (window.shell && typeof shell.setSidebarImportBusy === 'function') shell.setSidebarImportBusy(true);
  } catch {}
  let resp = null;
  try {
    await runQueued(label, async () => {
      // Use XHR for legacy import so we can show byte upload progress.
      resp = await _xhrPostFormData('/api/projects/import', fd, {
        onProgress: (pct, loaded, total) => {
          const mapped = Math.max(0, Math.min(35, Math.round((pct * 35) / 100)));
          const bytes = _fmtByteProgress(loaded, total);
          const line = bytes ? `Uploading… ${pct}% (${bytes})` : `Uploading… ${pct}%`;
          try { if (typeof window.updateActionProgress === 'function') window.updateActionProgress(mapped, line, line); } catch {}
          if (hasImportModal) {
            try {
              if (bar) { bar.style.width = `${mapped}%`; bar.textContent = `${mapped}%`; bar.setAttribute('aria-valuenow', String(mapped)); }
              if (stat) stat.textContent = line;
              if (log) log.textContent = line;
            } catch {}
          } else {
            try { if (typeof window.updateActionProgress === 'function') window.updateActionProgress(mapped, line, line); } catch {}
          }
        }
      });
      if (hasImportModal) {
        try {
          if (bar) { bar.style.width = '90%'; bar.textContent = '90%'; bar.setAttribute('aria-valuenow','90'); }
          if (stat) stat.textContent = 'Finalizing…';
          if (log) log.textContent = 'Applying imported configuration…';
        } catch {}
      } else {
        try { if (typeof window.updateActionProgress === 'function') window.updateActionProgress(90, 'Finalizing…', 'Applying imported configuration…'); } catch {}
      }
      try { if (typeof window.updateActionProgress === 'function') window.updateActionProgress(90, 'Finalizing…', 'Applying imported configuration…'); } catch {}
    }, { projectId: options.queueKey || 'import' });
  } catch (err) {
    if (hasImportModal) {
      try {
        if (bar) { bar.style.width = '100%'; bar.textContent = 'Error'; bar.setAttribute('aria-valuenow','100'); bar.classList.remove('progress-bar-animated'); }
        if (stat) stat.textContent = 'error';
        if (log) log.textContent = 'Failed to import project: ' + (err?.message || err);
      } catch {}
    }
    try { showToast('Failed to import project: ' + (err?.message || err), 'danger'); } catch {}
    try {
      (window.shell && shell.logError)
        ? shell.logError('Config: import project failed: ' + (err?.message || err))
        : console.error('Import project failed:', err);
    } catch {}
    return false;
  } finally {
    try {
      if (window.shell && typeof shell.setSidebarImportBusy === 'function') shell.setSidebarImportBusy(false);
    } catch {}
    if (!hasImportModal) {
      try { if (typeof window.hideActionProgress === 'function') window.hideActionProgress(); } catch {}
    }
  }
  if (!resp) return false;
  try { input.value = ''; } catch {}
  const importedId = resp?.id || (Array.isArray(resp?.imported) && resp.imported[0]?.id) || '';
  if (importedId && window.shell && typeof shell.setCurrentProjectId === 'function') {
    try { shell.setCurrentProjectId(importedId); } catch {}
  }
  try { await loadProjects(); } catch {}
  try {
    if (window.shell && typeof shell.refreshSidebar === 'function') await shell.refreshSidebar('config');
  } catch {}
  try { showToast('Project imported.', 'success'); } catch {}
  if (hasImportModal) {
    try {
      if (bar) { bar.style.width = '100%'; bar.textContent = '100%'; bar.setAttribute('aria-valuenow','100'); bar.classList.remove('progress-bar-animated'); }
      if (stat) stat.textContent = 'completed';
      if (log) log.textContent = 'Import completed.';
    } catch {}
  }
  try { if (typeof window.hideActionProgress === 'function') window.hideActionProgress(); } catch {}
  try {
    (window.shell && shell.logSuccess)
      ? shell.logSuccess('Config: project imported')
      : console.log('Project imported');
  } catch {}
  return true;
}

// --- Proxmox gating + async import (for VM restores) ---

function _readImportProxCreds(){
  try { return JSON.parse(sessionStorage.getItem('toolhub.session.proxmox.import') || '{}'); } catch { return {}; }
}
function _writeImportProxCreds(creds){
  try { sessionStorage.setItem('toolhub.session.proxmox.import', JSON.stringify(creds || {})); } catch {}
}

function _ensureHttpsUrl(raw){
  try {
    const s = (raw || '').trim();
    if (!s) return '';
    return /^https?:\/\//i.test(s) ? s : `https://${s}`;
  } catch { return ''; }
}

function _xhrPostFormData(url, formData, { onProgress } = {}){
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
        } catch {}
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

function _fmtBytes(n){
  try {
    const v = Number(n);
    if (!Number.isFinite(v) || v < 0) return '0 B';
    const units = ['B','KB','MB','GB','TB'];
    let x = v;
    let i = 0;
    while (x >= 1024 && i < units.length - 1) { x /= 1024; i += 1; }
    const prec = i === 0 ? 0 : (x >= 10 ? 1 : 2);
    return `${x.toFixed(prec)} ${units[i]}`;
  } catch { return '0 B'; }
}

function _fmtByteProgress(loaded, total){
  try {
    const l = Number(loaded);
    const t = Number(total);
    if (Number.isFinite(l) && Number.isFinite(t) && t > 0) return `${_fmtBytes(l)} / ${_fmtBytes(t)}`;
    if (Number.isFinite(l)) return `${_fmtBytes(l)} / ?`;
    return '';
  } catch { return ''; }
}

async function _runAsyncImportWithProx({ file, includeCreds, includeVms, importAsTemplates, prox }){
  const fd = new FormData();
  fd.append('file', file);
  fd.append('includeCreds', includeCreds ? 'true' : 'false');
  fd.append('includeVms', includeVms ? 'true' : 'false');
  if (importAsTemplates !== undefined) fd.append('importAsTemplates', importAsTemplates ? 'true' : 'false');
  if (prox) {
    if (prox.baseUrl) fd.append('baseUrl', String(prox.baseUrl));
    if (prox.apiPort !== undefined && prox.apiPort !== null && String(prox.apiPort) !== '') fd.append('apiPort', String(prox.apiPort));
    if (prox.sshPort !== undefined && prox.sshPort !== null && String(prox.sshPort) !== '') fd.append('sshPort', String(prox.sshPort));
    if (prox.username) fd.append('username', String(prox.username));
    if (prox.password) fd.append('password', String(prox.password));
    if (prox.verifySSL !== undefined) fd.append('verifySSL', prox.verifySSL ? 'true' : 'false');
  }

  const label = `Import project: ${file?.name || 'archive'}`;

  // Publish progress state for the Queue dock (do not auto-open the generic modal).
  try { if (typeof window.showActionProgress === 'function') window.showActionProgress('Import', 'Uploading…'); } catch {}

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
      if (bar) { bar.style.width = '0%'; bar.textContent = '0%'; bar.setAttribute('aria-valuenow','0'); }
      if (stat) stat.textContent = 'Uploading…';
      if (log) log.textContent = 'Waiting…';
      modalInst.show();
    } catch {}
  }

  // Only use action progress as a fallback when the Import Progress modal isn't present.
  if (!hasImportModal) {
    try {
      if (typeof window.showActionProgress === 'function') {
        window.showActionProgress('Import', 'Uploading…');
        if (typeof window.openActionProgressModal === 'function') window.openActionProgressModal();
      }
    } catch {}
  }

  let jobId = '';
  let lastLogCount = 0;
  try {
    await runQueued(label, async () => {
      const resp = await _xhrPostFormData('/api/projects/import/start', fd, {
        onProgress: (pct, loaded, total) => {
          try {
            if (typeof window.updateActionProgress === 'function') {
              // Reserve 0-30% for upload.
              const mapped = Math.max(0, Math.min(30, Math.round((pct * 30) / 100)));
              const bytes = _fmtByteProgress(loaded, total);
              const line = bytes ? `Uploading… ${pct}% (${bytes})` : `Uploading… ${pct}%`;
              window.updateActionProgress(mapped, line, `Uploading ${file?.name || 'archive'}…`);
            }
          } catch {}
          try {
            if (bar) {
              const mapped = Math.max(0, Math.min(30, Math.round((pct * 30) / 100)));
              bar.style.width = `${mapped}%`;
              bar.textContent = `${mapped}%`;
              bar.setAttribute('aria-valuenow', String(mapped));
            }
            const bytes = _fmtByteProgress(loaded, total);
            const line = bytes ? `Uploading… ${pct}% (${bytes})` : `Uploading… ${pct}%`;
            if (stat) stat.textContent = line;
            if (log) log.textContent = line;
          } catch {}
        }
      });
      jobId = resp && typeof resp === 'object' ? String(resp.job || '') : '';
      if (!jobId) throw new Error('Import did not return a job id');
    }, { projectId: 'import' });
  } catch (e) {
    // Friendly remote-mode message if backend blocks
    if (e && (e.status === 403 || e.status === 401)) {
      try {
        const msg = (e.body && e.body.error) ? e.body.error : 'Import is not allowed.';
        showToast(msg, e.status === 403 ? 'warning' : 'danger');
      } catch {}
    }
    throw e;
  }

  const poll = async () => {
    const s = await http('GET', `/api/projects/import/status?id=${encodeURIComponent(jobId)}`);
    const p = Math.max(0, Math.min(100, Number(s.progress || 0)));
    const statusText = String(s.status || 'processing');
    const mapped = (statusText === 'completed')
      ? 100
      : Math.max(30, Math.min(99, 30 + Math.round((p * 70) / 100)));
    let detail = '';
    try {
      if (Array.isArray(s.log) && s.log.length) {
        detail = String(s.log[s.log.length - 1] || '');
        // Stream only new lines to console dock as DEBUG
        try {
          const start = Math.max(0, lastLogCount);
          for (let i = start; i < s.log.length; i++) {
            if (window.shell && shell.logDebug) shell.logDebug(`[IMPORT] ${s.log[i]}`);
            else console.debug('[IMPORT]', s.log[i]);
          }
          lastLogCount = s.log.length;
        } catch {}
      }
    } catch {}
    try {
      if (typeof window.updateActionProgress === 'function') {
        window.updateActionProgress(mapped, statusText, detail || 'Importing…');
      }
    } catch {}

    // Update import progress modal with full log.
    try {
      if (bar) {
        bar.style.width = `${Math.max(0, Math.min(100, mapped))}%`;
        bar.textContent = `${Math.max(0, Math.min(100, mapped))}%`;
        bar.setAttribute('aria-valuenow', String(Math.max(0, Math.min(100, mapped))));
        if (statusText === 'completed') bar.classList.remove('progress-bar-animated');
      }
      if (stat) stat.textContent = statusText;
      if (log) {
        if (Array.isArray(s.log) && s.log.length) {
          log.textContent = s.log.join('\n');
          try {
            const box = log.parentElement;
            if (box) requestAnimationFrame(() => { box.scrollTop = box.scrollHeight; });
          } catch {}
        } else {
          log.textContent = detail || '';
        }
      }
    } catch {}

    if (statusText === 'completed') return { done: true, ok: true, status: s };
    if (statusText === 'error' || statusText === 'cancelled') return { done: true, ok: false, status: s };
    return { done: false, ok: false, status: s };
  };

  let finalStatus = null;
  while (true) {
    const res = await poll();
    if (res.done) { finalStatus = res.status; if (!res.ok) throw new Error((res.status?.errors && res.status.errors[0]) || 'Import failed'); break; }
    await new Promise(r => setTimeout(r, 1500));
  }

  try { if (typeof window.hideActionProgress === 'function') window.hideActionProgress(); } catch {}
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
} catch {}

async function gateImportThroughProxLogin({ file, includeCreds, includeVms, importAsTemplates }){
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
    const st = await _runAsyncImportWithProx({ file, includeCreds, includeVms, importAsTemplates, prox });
    // Handle success UX
    const importedId = (Array.isArray(st?.imported) && st.imported[0]?.id) || (st?.imported?.id) || '';
    try {
      if (importedId && window.shell && typeof shell.setCurrentProjectId === 'function') shell.setCurrentProjectId(importedId);
    } catch {}
    try { await loadProjects(); } catch {}
    try { if (window.shell && typeof shell.refreshSidebar === 'function') await shell.refreshSidebar('config'); } catch {}
    try { showToast('Project imported.', 'success'); } catch {}
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

  window.__IMPORT_NEXT__ = { file, includeCreds, includeVms, importAsTemplates: !!importAsTemplates };
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
  } catch {}
  const input = document.getElementById('import-file');
  if (!input || !input.files || !input.files[0]) return;
  const modalEl = document.getElementById('importOptionsModal');
  if (!modalEl || !window.bootstrap) {
    performProjectImport({ includeCreds: true, includeVms: true });
    return;
  }
  const credsEl = document.getElementById('imp-creds');
  const vmsEl = document.getElementById('imp-vms');
  const templatesEl = document.getElementById('imp-as-templates');
  const warnEl = document.getElementById('imp-vms-warning');
  if (credsEl) credsEl.checked = true;
  if (vmsEl) vmsEl.checked = true;
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
      const importAsTemplates = includeVms && !!document.getElementById('imp-as-templates')?.checked;
      if (includeVms) {
        const proceed = confirm('Importing VMs can be very time-consuming. This will run on the remote machine, download disk files, and compress them. Continue?');
        if (!proceed) return;
      }
      setBusy(true);
      try {
        // If importing VMs, prompt for Proxmox target and run async import job.
        if (includeVms) {
          try { modal.hide(); } catch {}
          const input = document.getElementById('import-file');
          const file = input && input.files && input.files[0] ? input.files[0] : null;
          if (!file) return;
          const ok = await gateImportThroughProxLogin({ file, includeCreds, includeVms, importAsTemplates });
          if (ok) { try { input.value = ''; } catch {} }
        } else {
          const ok = await performProjectImport({ includeCreds, includeVms, importAsTemplates, queueKey: 'import' });
          if (ok) {
            try { modal.hide(); } catch {}
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
  } catch {}
  // Read Proxmox session creds from sessionStorage
  const creds = readBestProxCreds(pid) || {};
  const body = { includeCreds: !!opts.includeCreds, includeVms: !!opts.includeVms, username: creds.username || '', password: creds.password || '' };
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

async function exportProxLoginSave(){
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
    const ensure = (s)=>{ if (!s) return ''; return /^https?:\/\//i.test(s) ? s : `https://${s}`; };
    const urlRaw = (urlEl?.value || '').trim();
    const url = ensure(urlRaw);
    const apiPort = Number((apiEl?.value || 8006));
    const sshPort = Number((sshEl?.value || 22));
    const username = (userEl?.value||'').trim();
    const password = passEl?.value || '';
    const verifySSL = !!(vsslEl?.checked);
    if (!url){ if (feedback){ feedback.textContent='Enter Proxmox URL'; feedback.className='me-auto small text-danger'; } return; }
    if (!username || !password){ if (feedback){ feedback.textContent='Enter username and password'; feedback.className='me-auto small text-danger'; } return; }

    // If exporting, we can verify and persist onto the project.
    if (exportNext) {
      const data = await http('GET', '/api/projects');
      const proj = (data.projects || []).find(p => p.id === pid);
      if (!proj) { alert('Project not found.'); return; }
      try {
        await http('PATCH', `/api/projects/${encodeURIComponent(pid)}`, {
          proxmox_url: url, proxmox_api_port: apiPort, proxmox_ssh_port: sshPort, proxmox_verify_ssl: verifySSL
        });
      } catch {}
      try { sessionStorage.setItem(`toolhub.session.proxmox.${pid}`, JSON.stringify({ username, password })); } catch {}
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
        if (feedback){ feedback.textContent = `${msg} ${details}`.trim(); feedback.className='me-auto small text-danger'; }
        try { sessionStorage.removeItem(`toolhub.session.proxmox.${pid}`); } catch {}
        return;
      }
      try {
        const modalEl = document.getElementById('proxLoginModal');
        const bs = window.bootstrap;
        const m = (bs && modalEl) ? bs.Modal.getInstance(modalEl) : null;
        if (m) m.hide();
      } catch {}
      try { (window.shell && shell.logSuccess) ? shell.logSuccess('Proxmox login verified (API + SSH)') : console.log('Proxmox login verified'); } catch {}
      await startExportJob(pid, opts);
      return;
    }

    // Import path: store session creds and start async import job.
    if (importNext) {
      const file = importNext.file;
      if (!file) { if (feedback){ feedback.textContent='No import file selected.'; feedback.className='me-auto small text-danger'; } return; }
      _writeImportProxCreds({ baseUrl: url, apiPort, sshPort, username, password, verifySSL });
      try {
        const modalEl = document.getElementById('proxLoginModal');
        const bs = window.bootstrap;
        const m = (bs && modalEl) ? bs.Modal.getInstance(modalEl) : null;
        if (m) m.hide();
      } catch {}
      window.__IMPORT_NEXT__ = null;
      const prox = { baseUrl: url, apiPort, sshPort, username, password, verifySSL };
      const st = await _runAsyncImportWithProx({
        file,
        includeCreds: !!importNext.includeCreds,
        includeVms: !!importNext.includeVms,
        importAsTemplates: !!importNext.importAsTemplates,
        prox,
      });
      // Post-success refresh
      const importedId = (Array.isArray(st?.imported) && st.imported[0]?.id) || '';
      try {
        const input = document.getElementById('import-file');
        if (input) input.value = '';
      } catch {}
      try { if (importedId && window.shell && typeof shell.setCurrentProjectId === 'function') shell.setCurrentProjectId(importedId); } catch {}
      try { await loadProjects(); } catch {}
      try { if (window.shell && typeof shell.refreshSidebar === 'function') await shell.refreshSidebar('config'); } catch {}
      try { showToast('Project imported.', 'success'); } catch {}
      return;
    }
  } catch (err) {
    if (feedback){
      feedback.textContent = 'Login failed: ' + (err && err.message ? err.message : 'Unknown error');
      feedback.className = 'me-auto small text-danger';
    }
    try { (window.shell && shell.logError) ? shell.logError('Proxmox login failed: ' + (err && err.message ? err.message : err)) : console.error('Proxmox login failed:', err); } catch {}
  } finally {
    setBusy(false);
  }
}

// If the Proxmox login modal is dismissed, clear any pending action.
try {
  document.addEventListener('hidden.bs.modal', (ev) => {
    try {
      if (!ev || !ev.target || ev.target.id !== 'proxLoginModal') return;
      window.__EXPORT_NEXT__ = null;
      window.__IMPORT_NEXT__ = null;
    } catch {}
  });
} catch {}

// Toast helper for this page
function showToast(message, type) {
  try {
    let container = document.getElementById('toastContainer');
    if (!container) {
      container = document.createElement('div');
      container.id = 'toastContainer';
      container.className = 'toast-container position-fixed top-0 end-0 p-3';
      container.style.zIndex = '1080';
      document.body.appendChild(container);
    }
    if (!window.bootstrap) {
      try { console.log(String(message || '')); } catch {}
      return;
    }
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
  } catch {
    try { console.log(String(message || '')); } catch {}
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
    const existing = collectCredentials(pid);
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
