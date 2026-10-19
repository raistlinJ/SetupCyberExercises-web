(() => {
  'use strict';

  const EVENTS = [
    {key: 'ctfrpgFirstUser', label: 'New #1 user', enabled: true, template: '{{user}} is now first in {{project}}.'},
    {key: 'ctfrpgFirstTeam', label: 'New #1 team', enabled: true, template: '{{team}} is now first in {{project}}.'},
    {key: 'ctfrpgFirstScore', label: 'First score', enabled: true, template: '{{user}} scored the first points in {{project}}.'},
    {key: 'ctfrpgScoreIncrease', label: 'Score increased', enabled: false, template: '{{user}} gained {{points}} points in {{project}}.'},
    {key: 'ctfrpgQuestComplete', label: 'Quest completed', enabled: false, template: '{{user}} completed a quest in {{project}}.'},
  ];
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const path = pid => `/api/projects/${encodeURIComponent(pid)}`;
  const settings = new Map();
  const media = new Map();
  const snapshots = new Map();
  const settingsLoads = new Map();
  const settingsVersions = new Map();
  const loadErrors = new Map();
  let projects = [];
  let sequence = 0;
  let loading = false;
  let saving = false;
  let pendingPlayback = Promise.resolve();
  let playbackGeneration = 0;
  let activePlayback = null;
  let previewButton = null;
  let audioContext = null;

  async function request(url, options = {}) {
    const response = await fetch(url, {credentials: 'same-origin', ...options});
    const body = await response.json();
    if (!response.ok || body.ok === false) throw new Error(body.error || `HTTP ${response.status}`);
    return body;
  }

  function status(message, kind = 'muted') {
    const host = document.getElementById('notify-status');
    if (!host) return;
    host.textContent = message;
    host.className = `small mt-2 text-${kind}`;
  }

  function updateControls() {
    const save = document.getElementById('notify-save');
    const reload = document.getElementById('notify-reload');
    if (save) save.disabled = loading || saving || !projects.length || loadErrors.size > 0;
    if (reload) reload.disabled = loading || saving || !projects.length;
  }

  async function ensureSettings(pid, force = false) {
    if (settingsLoads.has(pid)) return settingsLoads.get(pid);
    if (!force && settings.has(pid)) return;
    const version = settingsVersions.get(pid) || 0;
    const task = Promise.all([
      request(path(pid) + '/audio?prefix=ctfrpg&meta=1'),
      request(path(pid) + '/audio?prefix=media:&meta=1'),
    ]).then(([events, clips]) => {
      if ((settingsVersions.get(pid) || 0) !== version) return;
      settings.set(pid, events.audio || {});
      media.set(pid, clips.audio || {});
    });
    settingsLoads.set(pid, task);
    try { await task; }
    finally { if (settingsLoads.get(pid) === task) settingsLoads.delete(pid); }
  }

  function mediaOptions(pid, selected) {
    const entries = Object.entries(media.get(pid) || {}).filter(([, entry]) => entry?.enabled !== false);
    entries.sort((a, b) => Number(b[1]?.updated || 0) - Number(a[1]?.updated || 0));
    const options = ['<option value="">Built-in tone</option>'];
    for (const [key, entry] of entries) {
      const sound = entry?.sounds?.[0] || entry;
      options.push(`<option value="${esc(key)}" ${key === selected ? 'selected' : ''}>${esc(sound?.name || key)}</option>`);
    }
    if (selected && !entries.some(([key]) => key === selected)) options.push(`<option value="${esc(selected)}" selected>Unavailable clip</option>`);
    return options.join('');
  }

  function render() {
    const host = document.getElementById('notify-rows');
    if (!host) return;
    host.innerHTML = projects.length ? projects.map(project => {
      if (loadErrors.has(project.id)) return `<tr><td colspan="3" class="small text-danger">${esc(project.name)}: ${esc(loadErrors.get(project.id))}. Reload notification settings before saving.</td></tr>`;
      const entries = settings.get(project.id) || {};
      const heading = projects.length > 1 ? `<tr class="table-light"><th colspan="3">${esc(project.name)}</th></tr>` : '';
      return heading + EVENTS.map(event => {
        const entry = entries[event.key] || {};
        const enabled = entry.enabled === undefined ? event.enabled : !!entry.enabled;
        return `<tr data-pid="${esc(project.id)}" data-event="${event.key}">
          <td><input class="form-check-input notify-enabled" type="checkbox" aria-label="Enable ${esc(event.label)} for ${esc(project.name)}" ${enabled ? 'checked' : ''}></td>
          <td><span class="fw-semibold">${esc(event.label)}</span></td>
          <td><div class="d-flex flex-wrap align-items-center gap-2">
            <select class="form-select form-select-sm notify-sound" style="max-width:220px" aria-label="Audio for ${esc(event.label)}">${mediaOptions(project.id, entry.soundKey || '')}</select>
            <label class="small text-nowrap"><input class="form-check-input notify-speak" type="checkbox" ${entry.speak !== false ? 'checked' : ''}> Speak</label>
            <button class="btn btn-sm btn-outline-secondary notify-preview" type="button">Preview</button>
          </div><input class="form-control form-control-sm notify-template mt-2" type="text" value="${esc(entry.speakTemplates?.[0] ?? event.template)}" aria-label="Speech for ${esc(event.label)}"></td>
        </tr>`;
      }).join('');
    }).join('') : '<tr><td colspan="3" class="small text-muted">Select a project to configure notification audio.</td></tr>';
  }

  async function load(selectedProjects) {
    const seq = ++sequence;
    const nextProjects = selectedProjects.map(project => ({id: String(project.id), name: project.name}));
    if (projects.map(project => project.id).sort().join(',') !== nextProjects.map(project => project.id).sort().join(',')) stop();
    projects = nextProjects;
    const targets = [...projects];
    const selectedIds = new Set(projects.map(project => project.id));
    for (const pid of snapshots.keys()) if (!selectedIds.has(pid)) snapshots.delete(pid);
    loadErrors.clear();
    loading = !!projects.length;
    updateControls();
    if (!projects.length) { render(); status('Select a project to configure notification audio.'); return; }
    status(`Loading audio for ${projects.length} project${projects.length === 1 ? '' : 's'}…`);
    const results = await Promise.allSettled(targets.map(project => ensureSettings(project.id, true)));
    if (seq !== sequence) return;
    const failures = [];
    results.forEach((result, index) => {
      if (result.status === 'rejected') {
        const message = result.reason?.message || 'failed';
        loadErrors.set(targets[index].id, message);
        failures.push(`${targets[index].name}: ${message}`);
      }
    });
    loading = false;
    updateControls();
    render();
    status(failures.length ? failures.join(' · ') : 'Audio settings loaded.', failures.length ? 'danger' : 'success');
  }

  async function save() {
    if (!projects.length || loading || saving || loadErrors.size) return;
    const targets = [...projects];
    const seq = sequence;
    const byProject = new Map(targets.map(project => [project.id, {}]));
    document.querySelectorAll('#notify-rows tr[data-pid][data-event]').forEach(row => {
      if (!byProject.has(row.dataset.pid)) return;
      byProject.get(row.dataset.pid)[row.dataset.event] = {
        enabled: row.querySelector('.notify-enabled').checked,
        soundKey: row.querySelector('.notify-sound').value,
        speak: row.querySelector('.notify-speak').checked,
        speakTemplates: [row.querySelector('.notify-template').value.trim()].filter(Boolean),
      };
    });
    saving = true;
    updateControls();
    status('Saving audio settings…');
    try {
      const results = await Promise.allSettled(targets.map(project => request(path(project.id) + '/audio', {
        method: 'PATCH', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({audio: byProject.get(project.id)}),
      })));
      const failures = [];
      results.forEach((result, index) => {
        const target = targets[index];
        if (result.status === 'fulfilled') {
          settingsVersions.set(target.id, (settingsVersions.get(target.id) || 0) + 1);
          settings.set(target.id, byProject.get(target.id));
        } else failures.push(`${target.name}: ${result.reason?.message || 'failed'}`);
      });
      if (seq === sequence) status(failures.length ? failures.join(' · ') : 'Audio settings saved.', failures.length ? 'danger' : 'success');
    } finally { saving = false; updateControls(); }
  }

  function snapshot(result, previous) {
    const numeric = value => value === null || value === undefined || value === '' || !Number.isFinite(Number(value)) ? null : Number(value);
    const previousUsers = new Map((previous?.users || []).map(user => [user.name.toLowerCase(), user]));
    const users = (result.users || []).filter(user => user.exists).map(user => ({
      name: String(user.username || '').trim(), score: numeric(user.score),
      completed: numeric(user.completed), rank: numeric(user.rank),
    }));
    for (const user of users) {
      const old = previousUsers.get(user.name.toLowerCase());
      if (user.score === null) user.score = old?.score ?? null;
      if (user.completed === null) user.completed = old?.completed ?? null;
    }
    const teams = (result.teams || []).map(team => ({
      name: String(team.username || team.name || '').trim(), score: numeric(team.score), rank: numeric(team.rank),
    }));
    const knownRanks = rows => rows.some(row => row.name && row.rank !== null && row.rank > 0);
    const leader = rows => rows.find(row => row.name && row.rank === 1)?.name || '';
    const userLeaderKnown = knownRanks(users);
    const teamLeaderKnown = knownRanks(teams);
    const hasKnownScores = users.some(user => user.score !== null);
    const completeScores = users.length > 0 && users.every(user => user.score !== null);
    return {users, teams,
      userLeader: userLeaderKnown ? leader(users) : previous?.userLeader || '',
      teamLeader: teamLeaderKnown ? leader(teams) : previous?.teamLeader || '',
      userLeaderKnown: userLeaderKnown || !!previous?.userLeaderKnown,
      teamLeaderKnown: teamLeaderKnown || !!previous?.teamLeaderKnown,
      hasKnownScores: hasKnownScores || !!previous?.hasKnownScores,
      hasScore: users.some(user => user.score > 0) || (!completeScores && !!previous?.hasScore),
    };
  }

  function changes(previous, current, project) {
    if (!previous) return [];
    const events = [];
    const base = {project: project.name};
    const oldUsers = new Map(previous.users.map(user => [user.name.toLowerCase(), user]));
    if (previous.userLeaderKnown && current.userLeader && current.userLeader.toLowerCase() !== previous.userLeader.toLowerCase()) events.push({key: 'ctfrpgFirstUser', ...base, user: current.userLeader});
    if (previous.teamLeaderKnown && current.teamLeader && current.teamLeader.toLowerCase() !== previous.teamLeader.toLowerCase()) events.push({key: 'ctfrpgFirstTeam', ...base, team: current.teamLeader});
    if (previous.hasKnownScores && !previous.hasScore && current.hasScore) {
      const user = current.users.find(user => user.score > 0);
      if (user) events.push({key: 'ctfrpgFirstScore', ...base, user: user.name, score: user.score, points: user.score});
    }
    for (const user of current.users) {
      const old = oldUsers.get(user.name.toLowerCase());
      if (!old) continue;
      const points = user.score !== null && old.score !== null ? user.score - old.score : 0;
      if (points > 0) {
        events.push({key: 'ctfrpgScoreIncrease', ...base, user: user.name, score: user.score, points});
      }
      if (old.completed !== null && user.completed !== null && user.completed > old.completed) events.push({key: 'ctfrpgQuestComplete', ...base, user: user.name, completed: user.completed});
    }
    return events;
  }

  function speech(entry, event, definition) {
    const template = String(entry.speakTemplates?.[0] ?? definition.template);
    return template.replace(/\{\{\s*(project|user|team|score|points|completed|audio)\s*\}\}/gi,
      (_, key) => key.toLowerCase() === 'audio' ? '' : String(event[key.toLowerCase()] ?? '')).trim();
  }

  function remote() {
    try { return !!window.shell?.isRemote?.(); } catch { return false; }
  }

  function ensureAudioContext() {
    if (remote()) return null;
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) return null;
    try {
      if (!audioContext || audioContext.state === 'closed') audioContext = new AudioContext();
      if (audioContext.state === 'suspended') audioContext.resume().catch(() => {});
      return audioContext;
    } catch { return null; }
  }

  function resetPreview() {
    if (!previewButton) return;
    previewButton.textContent = 'Preview';
    delete previewButton.dataset.playing;
    previewButton = null;
  }

  function stop() {
    playbackGeneration++;
    pendingPlayback = Promise.resolve();
    const active = activePlayback;
    activePlayback = null;
    try { active?.stop(); } catch { }
    try { window.speechSynthesis?.cancel(); } catch { }
    resetPreview();
  }

  function tone() {
    const context = ensureAudioContext();
    if (!context || context.state === 'suspended') return Promise.resolve(false);
    return new Promise(resolve => {
      let oscillator;
      let gain;
      let settled = false;
      const active = { stop: () => {
        finish(false);
        try { oscillator?.stop(); } catch { }
      } };
      const finish = played => {
        if (settled) return;
        settled = true;
        try { oscillator?.disconnect(); gain?.disconnect(); } catch { }
        if (activePlayback === active) activePlayback = null;
        resolve(played);
      };
      try {
        oscillator = context.createOscillator();
        gain = context.createGain();
        oscillator.type = 'sine'; oscillator.frequency.value = 660;
        gain.gain.setValueAtTime(0.08, context.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, context.currentTime + 0.25);
        oscillator.connect(gain); gain.connect(context.destination);
        oscillator.onended = () => finish(true);
        activePlayback = active;
        oscillator.start(); oscillator.stop(context.currentTime + 0.25);
      } catch { finish(false); }
    });
  }

  function playClip(dataUrl) {
    return new Promise(resolve => {
      let audio;
      let settled = false;
      const active = { stop: () => {
        finish(false);
        try { audio?.pause(); audio.currentTime = 0; } catch { }
      } };
      const finish = played => {
        if (settled) return;
        settled = true;
        if (audio) {
          audio.removeEventListener('ended', ended);
          audio.removeEventListener('error', failed);
          audio.removeEventListener('abort', failed);
        }
        if (activePlayback === active) activePlayback = null;
        resolve(played);
      };
      const ended = () => finish(true);
      const failed = () => finish(false);
      try {
        audio = new Audio(dataUrl);
        audio.addEventListener('ended', ended);
        audio.addEventListener('error', failed);
        audio.addEventListener('abort', failed);
        activePlayback = active;
        audio.play()?.catch(failed);
      } catch { failed(); }
    });
  }

  function speak(text) {
    if (!text || !window.speechSynthesis || typeof window.SpeechSynthesisUtterance !== 'function') return Promise.resolve();
    return new Promise(resolve => {
      let settled = false;
      const active = { stop: () => finish() };
      const finish = () => {
        if (settled) return;
        settled = true;
        if (activePlayback === active) activePlayback = null;
        resolve();
      };
      try {
        const utterance = new window.SpeechSynthesisUtterance(text);
        utterance.onend = finish;
        utterance.onerror = finish;
        activePlayback = active;
        window.speechSynthesis.speak(utterance);
      } catch { finish(); }
    });
  }

  async function play(pid, event, force, override, cancelled) {
    if (cancelled()) return;
    const definition = EVENTS.find(item => item.key === event.key);
    if (!definition) return;
    if (!override) await ensureSettings(pid);
    if (cancelled()) return;
    const entry = override || settings.get(pid)?.[event.key] || {};
    if (!force && (entry.enabled === undefined ? !definition.enabled : !entry.enabled)) return;
    let played = false;
    if (entry.soundKey) {
      try {
        const body = await request(path(pid) + `/audio_entry?key=${encodeURIComponent(entry.soundKey)}`);
        if (cancelled()) return;
        const sound = body.entry?.sounds?.find(item => item?.dataUrl) || body.entry;
        if (body.entry?.enabled !== false && sound?.dataUrl) played = await playClip(sound.dataUrl);
      } catch { /* Fall back to the built-in tone. */ }
    }
    if (cancelled()) return;
    if (!played) await tone();
    if (!cancelled() && entry.speak !== false) {
      const text = speech(entry, event, definition);
      await speak(text);
    }
  }

  function enqueue(pid, event, force = false, override = null) {
    const generation = playbackGeneration;
    const cancelled = () => generation !== playbackGeneration || remote() || !projects.some(project => project.id === pid);
    const task = pendingPlayback.then(() => play(pid, event, force, override, cancelled)).catch(error => {
      if (!cancelled()) status(`Notification failed: ${error.message || error}`, 'danger');
    });
    pendingPlayback = task;
    return task;
  }

  function process(project, result) {
    const pid = String(project.id);
    const previous = snapshots.get(pid);
    const next = snapshot(result, previous);
    snapshots.set(pid, next);
    return Promise.all(changes(previous, next, project).map(event => enqueue(pid, event)));
  }

  let initialized = false;
  function init() {
    if (initialized) return;
    initialized = true;
    document.addEventListener('pointerdown', ensureAudioContext, {passive: true});
    document.addEventListener('keydown', ensureAudioContext);
    document.addEventListener('run-mode-changed', () => { if (remote()) stop(); });
    window.addEventListener('pagehide', stop);
    document.getElementById('notify-reload')?.addEventListener('click', () => load(projects));
    document.getElementById('notify-save')?.addEventListener('click', () => save().catch(error => status(error.message, 'danger')));
    document.getElementById('notify-stop')?.addEventListener('click', stop);
    document.getElementById('notify-rows')?.addEventListener('click', event => {
      const button = event.target.closest('.notify-preview');
      if (!button) return;
      if (button.dataset.playing === '1') { stop(); return; }
      if (remote()) { status('Audio is disabled in remote mode.'); return; }
      const row = button.closest('tr[data-pid][data-event]');
      const project = projects.find(item => item.id === row.dataset.pid);
      const definition = EVENTS.find(item => item.key === row.dataset.event);
      if (!project || !definition) return;
      const entry = {
        enabled: true, soundKey: row.querySelector('.notify-sound').value,
        speak: row.querySelector('.notify-speak').checked,
        speakTemplates: [row.querySelector('.notify-template').value.trim()].filter(Boolean),
      };
      const sample = {key: definition.key, project: project.name, user: 'Alex', team: 'Blue Team', score: 100, points: 25, completed: 3};
      stop();
      previewButton = button;
      button.dataset.playing = '1';
      button.textContent = 'Stop';
      const generation = playbackGeneration;
      return enqueue(project.id, sample, true, entry).finally(() => {
        if (generation === playbackGeneration && previewButton === button) resetPreview();
      });
    });
  }

  window.CTFRPG_Audio = {init, load, process, stop, snapshot, changes};
})();
