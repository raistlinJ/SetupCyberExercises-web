// Observes server-owned agent jobs. Closing a viewer only stops observation.
(function () {
  let root, body, status, guestSelect, follow, cancel;
  let currentId = null, cursor = 0, version = 0, controller = null;
  let closing = false, setupClosing = false;
  let events = [], seen = new Set(), blocks = new Map(), guests = new Map();
  const terminal = value => ['completed', 'error', 'cancelled'].includes(value);
  const nativeFetch = (...args) => (window.ServerQueue?.nativeFetch || window.fetch)(...args);
  const guestKey = event => JSON.stringify([String(event.projectId || ''), Number(event.index), String(event.guest || event.name || '')]);
  function allJobs() {
    const state = window.ServerQueue?.state() || {};
    return [...(state.activeItems || []), ...(state.items || []), ...(state.completed || [])];
  }
  function syncIndicators() {
    const jobs = allJobs().filter(job => job.liveTranscriptUrl).sort((a, b) => {
      const aActive = !terminal(a.status), bActive = !terminal(b.status);
      return Number(bActive) - Number(aActive) || b.id - a.id;
    });
    document.querySelectorAll('[data-agent-indicator]').forEach(element => {
      const key = JSON.stringify([element.dataset.projectId, Number(element.dataset.instanceIndex), element.dataset.guestName]);
      const job = jobs.find(job => (job.agentTargets || []).some(target => guestKey(target) === key));
      element.classList.toggle('agent-running', !!job && !terminal(job.status));
      element.classList.toggle('agent-has-transcript', !!job);
      if (job) {
        element.dataset.agentJob = String(job.id);
        element.setAttribute('role', 'button'); element.tabIndex = 0;
        element.setAttribute('aria-label', `${terminal(job.status) ? 'View' : 'View live'} agent transcript for ${element.dataset.guestName}`);
        element.title = terminal(job.status) ? 'View agent transcript' : `Agent ${job.status} — click for live transcript`;
      } else {
        delete element.dataset.agentJob;
        element.removeAttribute('role'); element.removeAttribute('tabindex'); element.removeAttribute('aria-label'); element.removeAttribute('title');
      }
    });
  }
  document.addEventListener('remote-queue-changed', syncIndicators);
  document.addEventListener('vm-table-rendered', syncIndicators);
  document.addEventListener('hide.bs.modal', event => { if (event.target.id === 'agentModal') setupClosing = true; });
  document.addEventListener('hidden.bs.modal', event => { if (event.target.id === 'agentModal') setupClosing = false; });
  function activateIndicator(event) {
    const indicator = event.target.closest?.('[data-agent-indicator][data-agent-job]');
    if (!indicator) return;
    event.preventDefault(); event.stopPropagation();
    open(Number(indicator.dataset.agentJob), { projectId: indicator.dataset.projectId, index: Number(indicator.dataset.instanceIndex), name: indicator.dataset.guestName });
  }
  document.addEventListener('click', activateIndicator);
  document.addEventListener('keydown', event => {
    if (['Enter', ' '].includes(event.key) && event.target.matches?.('[data-agent-indicator][data-agent-job]')) activateIndicator(event);
  });
  function create() {
    if (root) return;
    const style = document.createElement('style');
    style.textContent = '#agentTranscriptModal .modal-dialog{height:calc(100% - 84px);margin:16px auto;}#agentTranscriptModal pre{white-space:pre-wrap;overflow-wrap:anywhere;margin:0;font-size:.85rem;}#agentTranscriptModal .agent-event{border-bottom:1px solid var(--bs-border-color);padding:.75rem 0;}#agentTranscriptModal .agent-event h6{font-size:.85rem;}@media(max-width:575.98px){#agentTranscriptModal .modal-dialog{margin:8px;height:calc(100% - 80px);}}';
    document.head.appendChild(style);
    root = document.createElement('div'); root.id = 'agentTranscriptModal'; root.className = 'modal fade'; root.tabIndex = -1;
    root.setAttribute('aria-labelledby', 'agent-transcript-title');
    root.innerHTML = `<div class="modal-dialog modal-xl modal-dialog-scrollable"><div class="modal-content">
      <div class="modal-header"><h5 class="modal-title" id="agent-transcript-title">Live agent transcript</h5><button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Close"></button></div>
      <div class="px-3 pt-3"><p class="small text-muted mb-2">Prompts, endpoint output, returned reasoning, and tool activity. You can close this viewer; the run stays in Queue.</p>
        <div class="d-flex flex-wrap gap-3 align-items-center mb-2"><label class="small" for="agent-transcript-guest">Guest</label><select id="agent-transcript-guest" class="form-select form-select-sm" style="width:auto;max-width:100%"><option value="">All guests</option></select>
        <div class="form-check small"><input type="checkbox" class="form-check-input" id="agent-transcript-follow" checked><label class="form-check-label" for="agent-transcript-follow">Follow live output</label></div></div>
        <div id="agent-transcript-status" class="small pb-2" role="status" aria-live="polite"></div></div>
      <div class="modal-body pt-0" id="agent-transcript-body"></div>
      <div class="modal-footer"><button type="button" class="btn btn-secondary" data-bs-dismiss="modal">Close</button><button type="button" class="btn btn-outline-danger" id="agent-transcript-cancel">Cancel run</button></div>
    </div></div>`;
    document.body.appendChild(root);
    body = root.querySelector('#agent-transcript-body'); status = root.querySelector('#agent-transcript-status');
    guestSelect = root.querySelector('#agent-transcript-guest'); follow = root.querySelector('#agent-transcript-follow'); cancel = root.querySelector('#agent-transcript-cancel');
    guestSelect.addEventListener('change', applyFilter);
    cancel.addEventListener('click', () => { if (currentId) { window.ServerQueue?.cancel(currentId); status.textContent = 'Cancellation requested…'; } });
    root.addEventListener('hide.bs.modal', () => { closing = true; });
    root.addEventListener('hidden.bs.modal', () => { closing = false; version++; controller?.abort(); });
  }
  function addGuest(event) {
    if (!event.guest && !event.name) return;
    const key = guestKey(event);
    if (guests.has(key)) return;
    guests.set(key, event.guest || event.name);
    const option = document.createElement('option'); option.value = key;
    option.textContent = `${event.guest || event.name} · ${event.projectId || ''}`;
    guestSelect.appendChild(option);
  }
  function applyFilter() {
    body.querySelectorAll('[data-transcript-guest]').forEach(element => {
      element.classList.toggle('d-none', !!guestSelect.value && element.dataset.transcriptGuest !== guestSelect.value);
    });
  }
  const labels = { system_prompt: 'System prompt', prompt: 'Prompt', assignment: 'Assignment', turn_start: 'Model request', reasoning: 'Reasoning returned by endpoint', response: 'Model response', tool_start: 'Tool call', tool_result: 'Tool result', rubric: 'Rubric', error: 'Error', status: 'Status', usage: 'Usage', guest_complete: 'Guest finished' };
  const label = key => key.replaceAll('_', ' ').replace(/^./, first => first.toUpperCase());
  function formatData(value, depth = 0) {
    if (value === null || value === undefined) return '';
    if (Array.isArray(value)) return value.map((item, index) => `${'  '.repeat(depth)}${index + 1}. ${formatData(item, depth + 1).trimStart()}`).join('\n');
    if (typeof value === 'object') return Object.entries(value).map(([key, item]) => {
      const prefix = `${'  '.repeat(depth)}${label(key)}:`;
      if (item && typeof item === 'object') return `${prefix}\n${formatData(item, depth + 1)}`;
      return `${prefix} ${String(item ?? '')}`;
    }).join('\n');
    return String(value);
  }
  function eventText(event) {
    if (event.kind === 'turn_start') return event.text || '';
    if (event.kind === 'rubric' && event.data?.criteria) {
      const criteria = event.data.criteria.map(criterion =>
        `${criterion.criterion} — ${criterion.status} — ${criterion.score}/${criterion.max_score}\nEvidence: ${criterion.evidence}\nFeedback: ${criterion.feedback}`);
      return [event.data.summary || event.text, ...criteria].filter(Boolean).join('\n\n');
    }
    if (event.kind === 'usage' && typeof event.text === 'string') {
      try { return formatData(JSON.parse(event.text)); } catch { /* Some endpoints already send text. */ }
    }
    return [event.text || '', formatData(event.data)].filter(Boolean).join('\n');
  }
  function append(event) {
    if (seen.has(event.id)) return;
    seen.add(event.id); events.push(event); addGuest(event);
    // Tool arguments arrive as JSON fragments; the parsed tool_start event below
    // shows the same information as readable text when the call is complete.
    if (['tool_name', 'tool_arguments'].includes(event.kind)) return;
    const streaming = ['reasoning', 'response'].includes(event.kind);
    const key = JSON.stringify([guestKey(event), event.turn, event.kind, event.toolCallIndex]);
    let block = streaming ? blocks.get(key) : null;
    if (!block) {
      const section = document.createElement('section'); section.className = 'agent-event'; section.dataset.transcriptGuest = guestKey(event);
      const title = `${event.guest || 'Agent'} · ${labels[event.kind] || event.kind}${event.turn ? ` · turn ${event.turn}` : ''}`;
      const heading = document.createElement('h6'); heading.textContent = title;
      let contentHost = section;
      if (['system_prompt', 'assignment'].includes(event.kind)) {
        const details = document.createElement('details'), summary = document.createElement('summary'); summary.textContent = title;
        details.appendChild(summary); section.appendChild(details); contentHost = details;
      } else section.appendChild(heading);
      const pre = document.createElement('pre'); contentHost.appendChild(pre); body.appendChild(section);
      block = { section, pre }; if (streaming) blocks.set(key, block);
    }
    block.pre.appendChild(document.createTextNode(eventText(event) + (event.truncated ? '\n[Preview truncated; full output is retained in the report ZIP.]' : '')));
    applyFilter();
  }
  async function observe(runVersion) {
    while (runVersion === version) {
      controller = new AbortController();
      try {
        const response = await nativeFetch(`/api/queue/${currentId}/transcript?after=${cursor}`, { credentials: 'same-origin', signal: controller.signal });
        if (!response.ok) {
          if ([401, 403, 404].includes(response.status)) { status.textContent = 'Cannot access this agent transcript.'; return; }
          throw new Error('Transcript temporarily unavailable');
        }
        const result = await response.json();
        if (runVersion !== version) return;
        (result.job.agentTargets || []).forEach(addGuest);
        (result.events || []).forEach(append); cursor = result.nextCursor;
        cancel.disabled = terminal(result.job.status) || result.job.cancelRequested;
        status.textContent = `Queue #${currentId} · ${result.job.status}${result.job.message ? ' · ' + result.job.message : ''}${result.job.errorMessage ? ' · ' + result.job.errorMessage : ''}`;
        if (!events.length) status.textContent += ' · Waiting for agent output…';
        if (follow.checked) body.scrollTop = body.scrollHeight;
        if (result.hasMore) continue;
        if (terminal(result.job.status)) { window.ServerQueue?.refresh().catch(() => {}); return; }
      } catch (error) {
        if (error.name === 'AbortError' || runVersion !== version) return;
        status.textContent = 'Reconnecting to live transcript…';
      }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }
  async function open(id, target) {
    id = Number(id); if (!Number.isInteger(id) || id < 1) return;
    create();
    // Queue controls remain clickable while this window fades out. Finish that
    // close before starting a new observer, so hidden.bs.modal cannot abort it.
    if (closing || (!root.classList.contains('show') && root.style.display === 'block')) {
      await new Promise(resolve => root.addEventListener('hidden.bs.modal', resolve, { once: true }));
    }
    controller?.abort(); const runVersion = ++version;
    if (id !== currentId) {
      currentId = id; cursor = 0; events = []; seen = new Set(); blocks = new Map(); guests = new Map(); body.replaceChildren();
      guestSelect.replaceChildren(); const option = document.createElement('option'); option.value = ''; option.textContent = 'All guests'; guestSelect.appendChild(option);
    }
    const job = allJobs().find(job => job.id === id);
    (job?.agentTargets || []).forEach(addGuest);
    if (target) { addGuest(target); guestSelect.value = guestKey(target); }
    else guestSelect.value = '';
    applyFilter(); status.textContent = `Opening queue item #${id}…`;
    const setup = document.getElementById('agentModal');
    if (setup && (setupClosing || setup.classList.contains('show') || setup.style.display === 'block')) {
      await new Promise(resolve => {
        const modal = bootstrap.Modal.getOrCreateInstance(setup);
        // A fast acceptance can arrive during Bootstrap's opening transition.
        // hide() is ignored during that transition; retry once it is shown.
        const onShown = () => modal.hide();
        setup.addEventListener('shown.bs.modal', onShown, { once: true });
        setup.addEventListener('hidden.bs.modal', () => {
          setup.removeEventListener('shown.bs.modal', onShown); resolve();
        }, { once: true });
        modal.hide();
      });
    }
    if (runVersion !== version) return;
    bootstrap.Modal.getOrCreateInstance(root).show(); observe(runVersion);
  }
  window.AgentTranscript = { open, syncIndicators };
  syncIndicators();
  const requested = new URL(window.location.href).searchParams.get('agentJob');
  if (requested) open(Number(requested));
})();
