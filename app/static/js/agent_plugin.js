(function () {
  const menu = document.querySelector('#act-control + .dropdown-menu');
  if (!menu || document.getElementById('agent-command')) return;
  if (!menu.querySelector('[data-plugin-section]')) {
    const divider = document.createElement('li');
    const line = document.createElement('hr'); line.className = 'dropdown-divider'; divider.appendChild(line);
    const heading = document.createElement('li'); heading.dataset.pluginSection = '';
    const label = document.createElement('h6'); label.className = 'dropdown-header'; label.textContent = 'Plugins';
    heading.appendChild(label); menu.append(divider, heading);
  }
  const item = document.createElement('li');
  const command = document.createElement('button');
  command.id = 'agent-command';
  command.type = 'button';
  command.className = 'dropdown-item';
  command.textContent = 'Run Agent';
  command.title = 'Run an LLM agent on selected VMs and LXC containers';
  item.appendChild(command);
  menu.appendChild(item);

  const root = document.createElement('div');
  const style = document.createElement('style');
  style.textContent = '#agentModal .modal-dialog{height:calc(100% - 84px);margin:16px auto;}@media(max-width:575.98px){#agentModal .modal-dialog{margin:8px;height:calc(100% - 80px);}}';
  document.head.appendChild(style);
  root.id = 'agentModal';
  root.className = 'modal fade';
  root.tabIndex = -1;
  root.setAttribute('aria-labelledby', 'agent-title');
  root.innerHTML = `<div class="modal-dialog modal-xl modal-dialog-scrollable"><div class="modal-content">
    <div class="modal-header"><h5 class="modal-title" id="agent-title">agent</h5><button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Close"></button></div>
    <div class="modal-body">
      <p id="agent-selection" class="small text-muted"></p>
      <form id="agent-form">
        <div class="row g-3">
          <div class="col-md-8"><label for="agent-url" class="form-label">LLM endpoint URL (OpenAI compatible)</label><input id="agent-url" type="url" inputmode="url" pattern="https?://.+" class="form-control" placeholder="http://localhost:8081/v1" required><div class="form-text">Enter an HTTP or HTTPS base URL. Requests are sent from the DeployForge server. Model must support Chat Completions function tools.</div></div>
          <div class="col-md-4"><label for="agent-api-key" class="form-label">API key</label><input id="agent-api-key" type="password" autocomplete="off" class="form-control"><div class="form-text">Remembered for this browser tab, including page reloads.</div></div>
          <div class="col-12"><div class="form-check"><input id="agent-ssl" type="checkbox" class="form-check-input" checked><label for="agent-ssl" class="form-check-label">Require SSL certificate verification</label></div></div>
          <div class="col-md-8"><label for="agent-model" class="form-label">Model</label><div class="input-group"><input id="agent-model" class="form-control" list="agent-models" placeholder="Fetch or enter a model ID" required><button type="button" id="agent-fetch" class="btn btn-outline-secondary">Fetch</button></div><datalist id="agent-models"></datalist></div>
          <div class="col-md-4"><label for="agent-context" class="form-label">Context window (tokens)</label><input id="agent-context" type="number" min="1" step="1" value="16384" class="form-control" aria-describedby="agent-context-limit" required><button id="agent-context-max" type="button" class="btn btn-sm btn-outline-secondary mt-2" disabled>Use provider max</button><div id="agent-context-limit" class="form-text"></div></div>
          <div class="col-md-3"><label for="agent-turns" class="form-label">Max turns per guest</label><input id="agent-turns" type="number" min="1" max="100" value="20" class="form-control" required></div>
          <div class="col-md-3"><label for="agent-tool-timeout" class="form-label">Command timeout (seconds)</label><input id="agent-tool-timeout" type="number" min="1" max="86400" value="60" class="form-control" required></div>
          <div class="col-md-3"><label for="agent-request-timeout" class="form-label">LLM timeout (seconds)</label><input id="agent-request-timeout" type="number" min="1" max="600" value="120" class="form-control" required></div>
          <div class="col-md-3"><label for="agent-tokens" class="form-label">Max response tokens</label><input id="agent-tokens" type="number" min="256" step="1" value="2048" class="form-control" aria-describedby="agent-token-limit" required><div id="agent-token-limit" class="form-text"></div></div>
          <div class="col-md-3"><label for="agent-temperature" class="form-label">Temperature (optional)</label><input id="agent-temperature" type="number" min="0" max="2" step="0.1" placeholder="Endpoint default" class="form-control"></div>
          <div class="col-12"><label for="agent-prompt" class="form-label">Prompt</label><textarea id="agent-prompt" rows="4" class="form-control" required placeholder="Grade this assignment. Verify x.py, y.py and z.md are in /home/student/assignment. Run the required tests. If files are missing, search likely directories quickly, report their actual locations, and return a rubric with scores and evidence. Do not modify submissions."></textarea></div>
          <div class="col-12"><label for="agent-assignment-file" class="form-label">Assignment document (.md)</label><input id="agent-assignment-file" type="file" accept=".md,.markdown,text/markdown,text/plain" class="form-control"><label for="agent-assignment" class="form-label mt-2">Assignment Markdown (upload above or paste here)</label><textarea id="agent-assignment" rows="6" class="form-control"></textarea></div>
          <div class="col-12"><label for="agent-uploads" class="form-label">Files the agent may push (optional)</label><input id="agent-uploads" type="file" multiple class="form-control"><div class="form-text">For example, test scripts or reference data. 25 MiB total; unique filenames. The agent can also push generated text files.</div></div>
        </div>
        <div class="form-text mt-3">One independent run per selected guest. Results include criteria, scores, evidence and feedback. Cancellation takes effect between operations; a running command or request may finish first. One extra model turn is reserved for the final rubric when the turn limit is reached.</div>
      </form>
      <div id="agent-status" class="small mt-3" role="status" aria-live="polite"></div>
      <div id="agent-error" class="alert alert-danger mt-3 d-none" role="alert"></div>
    </div>
    <div class="modal-footer"><button type="button" class="btn btn-secondary" data-bs-dismiss="modal">Close</button><button type="button" id="agent-live" class="btn btn-outline-primary d-none">Live transcript</button><button type="button" id="agent-cancel" class="btn btn-outline-danger d-none">Cancel run</button><button type="submit" form="agent-form" id="agent-run" class="btn btn-primary">Run agent</button></div>
  </div></div>`;
  document.body.appendChild(root);
  const el = id => document.getElementById(`agent-${id}`);
  const settingsKey = 'deployforge.agent.config.v1';
  const fields = ['url', 'model', 'ssl', 'context', 'turns', 'tool-timeout', 'request-timeout', 'tokens', 'temperature', 'prompt', 'assignment'];
  const keyStorage = 'deployforge.agent.api-key.v1';
  const filesStorage = 'agent-form-files-v1';
  let groups = new Map(), job = null, busy = false;
  let contextAuto = false, initialContext = true, modelLimits = {}, limitsConnection = '';
  try {
    const saved = JSON.parse(localStorage.getItem(settingsKey) || '{}');
    fields.forEach(id => { if (saved[id] !== undefined) { if (id === 'ssl') el(id).checked = saved[id]; else el(id).value = saved[id]; } });
    contextAuto = saved['context-auto'] === true;
    initialContext = saved.context === undefined;
  } catch { }
  try { el('api-key').value = sessionStorage.getItem(keyStorage) || ''; } catch { }
  function connectionKey() { return JSON.stringify([el('url').value.trim(), el('api-key').value, el('ssl').checked]); }
  function selectedLimits() { return limitsConnection === connectionKey() ? modelLimits[el('model').value.trim()] || {} : {}; }
  function syncTokenLimit() {
    const limits = selectedLimits(), context = limits.context_window;
    el('context-max').disabled = !context;
    if (context) el('context').max = String(context); else el('context').removeAttribute('max');
    if (context && contextAuto) el('context').value = String(context);
    const contextBudget = Number(el('context').value) - 1601;
    const maximum = limits.max_output_tokens ? Math.min(contextBudget, limits.max_output_tokens) : contextBudget;
    el('tokens').max = String(maximum);
    const output = limits.max_output_tokens ? ` Provider output limit: ${limits.max_output_tokens.toLocaleString()}.` : ' Provider output limit is not reported.';
    el('token-limit').textContent = `Up to ${Math.max(0, maximum).toLocaleString()} with this context budget.${output} Prompts and tool results also use context.`;
    const advertised = limits.model_context_window ? ` Model advertised context: ${limits.model_context_window.toLocaleString()}.` : '';
    el('context-limit').textContent = context
      ? `${limits.source || 'Provider'}: ${context.toLocaleString()} tokens.${advertised} ${contextAuto ? 'Using provider max; refreshed when the run starts.' : 'Custom context; use the button above to select the maximum.'}`
      : `${contextAuto ? 'Provider max will be refreshed when the run starts.' : 'Enter the context configured in your runtime, or Fetch to discover its limit. 16,384 is only the form default.'}${advertised} The usable runtime limit is not reported.`;
  }
  el('context').addEventListener('input', () => { contextAuto = false; initialContext = false; syncTokenLimit(); });
  el('context-max').addEventListener('click', () => { contextAuto = true; initialContext = false; syncTokenLimit(); saveSettings(); });
  el('model').addEventListener('input', () => { syncTokenLimit(); });
  for (const id of ['url', 'api-key', 'ssl']) {
    el(id).addEventListener(id === 'ssl' ? 'change' : 'input', () => { modelLimits = {}; limitsConnection = ''; syncTokenLimit(); });
  }
  syncTokenLimit();
  const filesReady = (async () => {
    try {
      const saved = await window.PersistentQueuePayloads?.get(filesStorage);
      for (const id of ['assignment-file', 'uploads']) {
        if (!saved?.[id]?.length) continue;
        const transfer = new DataTransfer();
        saved[id].forEach(file => transfer.items.add(file));
        el(id).files = transfer.files;
      }
    } catch (err) { window.shell?.logWarn?.(`Could not restore agent attachments: ${err.message}`); }
  })();
  function saveSettings() {
    const values = Object.fromEntries(fields.map(id => [id, id === 'ssl' ? el(id).checked : el(id).value]));
    values['context-auto'] = contextAuto;
    try { localStorage.setItem(settingsKey, JSON.stringify(values)); } catch { }
    try { sessionStorage.setItem(keyStorage, el('api-key').value); } catch { }
  }
  async function saveFiles() {
    const values = Object.fromEntries(['assignment-file', 'uploads'].map(id => [id, Array.from(el(id).files || [])]));
    await window.PersistentQueuePayloads?.put(filesStorage, values);
  }
  root.addEventListener('hide.bs.modal', () => {
    saveSettings(); saveFiles().catch(err => window.shell?.logWarn?.(err.message));
  });
  function validEndpoint() {
    const input = el('url');
    input.setCustomValidity('');
    try {
      const url = new URL(input.value.trim());
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error();
    } catch { input.setCustomValidity('Enter an HTTP or HTTPS endpoint URL without credentials, query parameters or a fragment.'); }
    return input.reportValidity();
  }
  el('url').addEventListener('input', () => el('url').setCustomValidity(''));
  function config() {
    const cfg = { url: el('url').value.trim(), model: el('model').value.trim(), api_key: el('api-key').value,
      ssl_verify: el('ssl').checked, context_window: Number(el('context').value), max_turns: Number(el('turns').value),
      tool_timeout: Number(el('tool-timeout').value), request_timeout: Number(el('request-timeout').value), max_tokens: Number(el('tokens').value),
      context_auto: contextAuto, discover_limits: true };
    if (el('temperature').value !== '') cfg.temperature = Number(el('temperature').value);
    return cfg;
  }
  function error(message = '') { el('error').textContent = message; el('error').classList.toggle('d-none', !message); }
  command.addEventListener('click', async () => {
    await filesReady;
    if (!busy) {
      groups = groupSelectedGuestEntriesByProject();
      const targets = Array.from(groups.values()).flat();
      el('selection').textContent = targets.length ? `${targets.length} selected guests: ${targets.map(t => t.name).join(', ')}` : 'Select existing VMs or LXC containers, then open agent. Refresh states if needed.';
      el('run').disabled = !targets.length;
    }
    bootstrap.Modal.getOrCreateInstance(root).show();
  });
  el('assignment-file').addEventListener('change', async () => {
    const file = el('assignment-file').files[0];
    if (!file) return;
    if (file.size > 1024 * 1024) { error('Assignment exceeds 1 MiB; choose a smaller Markdown document.'); return; }
    try { el('assignment').value = await file.text(); saveSettings(); await saveFiles(); error(); } catch (err) { error(err.message); }
  });
  el('uploads').addEventListener('change', () => saveFiles().catch(err => error(err.message)));
  el('fetch').addEventListener('click', async () => {
    if (!validEndpoint()) return;
    el('fetch').disabled = true;
    error();
    try {
      const connection = connectionKey();
      const response = await ServerQueue.nativeFetch('/api/plugins/agent/models', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify(config()) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Model discovery failed');
      if (connection !== connectionKey()) return;
      el('models').replaceChildren(...data.models.map(model => { const option = document.createElement('option'); option.value = model; return option; }));
      if (!el('model').value && data.models.length) el('model').value = data.models[0];
      modelLimits = data.model_limits || {}; limitsConnection = connection;
      if (initialContext && selectedLimits().context_window) { contextAuto = true; initialContext = false; }
      syncTokenLimit();
      el('status').textContent = `Fetched ${data.models.length} models.`;
      saveSettings();
    } catch (err) { error(err.message); } finally { el('fetch').disabled = false; }
  });
  el('form').addEventListener('submit', async event => {
    event.preventDefault();
    if (busy || !groups.size || !validEndpoint() || !el('form').reportValidity()) return;
    error();
    const attachments = Array.from(el('uploads').files || []);
    if (attachments.reduce((size, file) => size + file.size, 0) > 25 * 1024 * 1024) { error('Attachments exceed the 25 MiB limit.'); return; }
    if (new Set(attachments.map(file => file.name)).size !== attachments.length) { error('Attachment filenames must be unique.'); return; }
    const llm = config(), prompt = el('prompt').value, assignment = el('assignment').value;
    busy = true; el('run').disabled = true;
    el('status').textContent = 'Preparing agent run…'; saveSettings();
    try {
      await saveFiles();
      const steps = [], files = attachments.map((file, index) => [`agent-upload-${index}`, file]);
      for (const [pid, targets] of groups) {
        const auth = await guestTransferAuthPayload(pid, targets);
        const body = { ...auth, targets, llm, prompt, assignment };
        const step = { method: 'POST', url: `/api/projects/${encodeURIComponent(pid)}/instances/actions/agent` };
        if (files.length) { step.form = [['payload', JSON.stringify(body)]]; step.files = files.map(([key]) => ['files', key]); }
        else step.body = body;
        steps.push(step);
      }
      job = await ServerQueue.submit('Run agent', steps, { projectId: groups.keys().next().value }, files);
      el('live').textContent = 'Live transcript';
      el('live').dataset.job = job.id;
      el('live').classList.remove('d-none');
      el('status').textContent = `Queue #${job.id}: agent accepted. You can close this modal; the run stays in Queue.`;
      el('cancel').classList.remove('d-none');
      await window.AgentTranscript.open(job.id);
      const state = await ServerQueue.wait(job, state => { el('status').textContent = state.message || `Agent ${state.status} (step ${state.step}/${state.totalSteps})`; });
      el('status').textContent = `Agent ${state.status}. Reports and files are retained in Queue.`;
      el('live').textContent = 'Transcript';
      if (root.classList.contains('show')) {
        await new Promise(resolve => {
          root.addEventListener('hidden.bs.modal', resolve, { once: true });
          bootstrap.Modal.getOrCreateInstance(root).hide();
        });
      }
      window.shell?.showAgentResults?.(job.id);
    } catch (err) { error(err.message); }
    finally { busy = false; job = null; el('run').disabled = false; el('cancel').classList.add('d-none'); }
  });
  el('cancel').addEventListener('click', () => { if (job) { ServerQueue.cancel(job.id); el('status').textContent = 'Cancellation requested…'; } });
  el('live').addEventListener('click', () => window.AgentTranscript?.open(Number(el('live').dataset.job)));
})();
