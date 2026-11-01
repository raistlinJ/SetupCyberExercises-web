// Recall settings only: selecting history never submits work or changes targets.
(function () {
  // Keep File references for this page only; history on the server stores names/settings.
  const HISTORY_LIMIT = 10;
  const pushSelections = new Map();
  let pushSelectionGeneration = 0;
  const pushInput = type => document.getElementById(type === 'folder' ? 'lxc-push-folder' : 'lxc-push-files');
  const sourceNames = files => Array.from(files || [], file => String(file.webkitRelativePath || file.name || ''));
  const selectionKey = (type, names) => JSON.stringify([type, [...names].sort()]);

  function rememberPushSelection(type) {
    const files = Array.from(pushInput(type)?.files || []);
    if (!files.length) return;
    const key = selectionKey(type, sourceNames(files));
    pushSelections.delete(key);
    pushSelections.set(key, files);
    while (pushSelections.size > HISTORY_LIMIT) pushSelections.delete(pushSelections.keys().next().value);
  }

  function selectionWarning(type, messages = []) {
    const warning = document.getElementById(`lxc-push-${type === 'folder' ? 'folder' : 'files'}-warning`);
    if (!warning) return;
    warning.classList.toggle('d-none', !messages.length);
    warning.title = messages.join('\n');
    warning.setAttribute('aria-label', warning.title);
  }

  async function restorePushSelection(type, settings, executedAt) {
    const input = pushInput(type);
    if (!input) return;
    const names = Array.isArray(settings.sourceNames) ? settings.sourceNames : [];
    const key = selectionKey(type, names);
    // Recall changes settings; an existing selection always takes precedence.
    if (!input.files?.length && pushSelections.has(key)) {
      try {
        const transfer = new DataTransfer();
        pushSelections.get(key).forEach(file => transfer.items.add(file));
        input.files = transfer.files;
      } catch { /* Browsers without assignable FileLists require another selection. */ }
    }
    input.dispatchEvent(new Event('change', { bubbles: true }));
    const generation = ++pushSelectionGeneration;
    const files = Array.from(input.files || []);
    const checkFile = async file => {
      const name = String(file.webkitRelativePath || file.name || '');
      let message = names.includes(name) && Number(executedAt) > 0 && file.lastModified > Number(executedAt)
        ? `${name}: changed since this run.` : '';
      try {
        // Read only one byte, including for large uploads. File snapshots can
        // become unreadable after a local edit; browsers cannot re-stat them.
        if (typeof file.slice === 'function') await file.slice(0, 1).arrayBuffer();
      } catch (error) {
        if (error?.name === 'NotFoundError') return { file, missing: true };
        message = `${name}: ${error?.name === 'NotReadableError' ? 'changed or is no longer readable' : 'could not be checked'}. Select it again to use the current file.`;
      }
      return { file, message };
    };
    const checks = [];
    for (let offset = 0; offset < files.length; offset += 16) {
      checks.push(...await Promise.all(files.slice(offset, offset + 16).map(checkFile)));
      if (generation !== pushSelectionGeneration) return;
    }
    if (generation !== pushSelectionGeneration || files.some((file, index) => input.files?.[index] !== file)
        || input.files?.length !== files.length) return;
    const missing = checks.filter(check => check.missing);
    if (missing.length) {
      pushSelections.delete(selectionKey(type, sourceNames(files)));
      const remaining = checks.filter(check => !check.missing).map(check => check.file);
      if (!remaining.length) input.value = '';
      else {
        try {
          const transfer = new DataTransfer();
          remaining.forEach(file => transfer.items.add(file));
          input.files = transfer.files;
        } catch {
          checks.push({ message: 'Some selected files no longer exist. Select the remaining files again.' });
        }
      }
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }
    selectionWarning(type, checks.map(check => check.message).filter(Boolean));
    const help = document.getElementById('lxc-push-history-help');
    if (help) help.textContent = input.files?.length
      ? 'Your file selection is ready. Check the files and destination before pushing.'
      : missing.length ? 'The selected files no longer exist. Choose files or a folder again.'
        : 'Choose the original files or folder again. File selections can only be recalled while this page remains open.';
  }

  function setValue(id, value, event = 'input') {
    const element = document.getElementById(id);
    if (!element) return;
    element.value = value ?? '';
    element.dispatchEvent(new Event(event, { bubbles: true }));
  }

  async function apply(kind, settings, executedAt) {
    if (kind === 'custom') {
      setValue('custom-command-input', settings.command);
      setValue('custom-command-timeout', settings.timeoutSeconds);
      const render = document.getElementById('custom-render-template-variables');
      if (render) {
        render.checked = settings.renderTemplateVariables !== false;
        render.dispatchEvent(new Event('change', { bubbles: true }));
      }
    } else if (kind === 'pull') {
      setValue('lxc-pull-paths', settings.paths);
    } else {
      const csvMode = document.getElementById('lxc-push-csv-mode');
      if (csvMode) { csvMode.checked = false; csvMode.dispatchEvent(new Event('change', { bubbles: true })); }
      // The mode-change handler clears the inactive picker, so cache both first.
      ['file', 'folder'].forEach(rememberPushSelection);
      const preferredType = settings.selectionType === 'folder' ? 'folder' : 'file';
      const currentType = ['file', 'folder'].find(type => document.getElementById(`lxc-push-type-${type}`)?.checked && pushInput(type)?.files?.length)
        || ['file', 'folder'].find(type => pushInput(type)?.files?.length);
      const type = currentType || preferredType;
      const radio = document.getElementById(`lxc-push-type-${type}`);
      if (radio && !radio.checked) { radio.checked = true; radio.dispatchEvent(new Event('change', { bubbles: true })); }
      setValue('lxc-push-destination', settings.destination);
      setValue('lxc-push-owner', settings.ownerOnRemote);
      setValue('lxc-push-permissions', settings.filePermissions);
      const advanced = document.getElementById('lxc-push-advanced');
      if (advanced) advanced.open = !!(settings.ownerOnRemote || settings.filePermissions);
      await restorePushSelection(type, settings, executedAt);
    }
  }

  function description(kind, entry) {
    const settings = entry.settings;
    let text = settings.command || settings.paths;
    if (kind === 'push') {
      const names = settings.sourceNames || [];
      text = `${names[0] || settings.selectionType}${names.length > 1 ? ` (+${names.length - 1})` : ''} → ${settings.destination}`;
      if (settings.ownerOnRemote) text += ` · owner ${settings.ownerOnRemote}`;
      if (settings.filePermissions) text += ` · mode ${settings.filePermissions}`;
    }
    if (kind === 'custom') text = `${text} · ${settings.timeoutSeconds}s`;
    return String(text || '').replace(/\s+/g, ' ').slice(0, 140);
  }

  function wire(kind, modalId, selectId) {
    const modal = document.getElementById(modalId);
    const select = document.getElementById(selectId);
    if (!modal || !select || select.dataset.historyBound) return;
    select.dataset.historyBound = 'true';
    let entries = [];
    let generation = 0;
    const placeholder = text => {
      select.replaceChildren(new Option(text, ''));
      select.disabled = true;
    };
    select.addEventListener('change', async () => {
      const entry = entries.find(item => String(item.id) === select.value);
      if (entry) { select.value = ''; await apply(kind, entry.settings, entry.executedAt); }
    });
    modal.addEventListener('show.bs.modal', async () => {
      const current = ++generation;
      entries = [];
      placeholder('Loading history…');
      try {
        const fetch = window.ServerQueue?.nativeFetch || window.fetch.bind(window);
        const response = await fetch(`/api/queue/history/${kind}`, { credentials: 'same-origin', cache: 'no-store' });
        if (!response.ok) throw new Error('History unavailable');
        const data = await response.json();
        if (current !== generation) return;
        entries = (Array.isArray(data.items) ? data.items : []).slice(0, HISTORY_LIMIT);
        placeholder(entries.length ? 'Recall a previous run…' : 'No recent runs');
        entries.forEach(entry => {
          const option = new Option(description(kind, entry), String(entry.id));
          option.title = entry.settings.command || entry.settings.paths || entry.settings.destination;
          select.append(option);
        });
        select.disabled = !entries.length;
      } catch {
        if (current === generation) placeholder('History unavailable');
      }
    });
  }

  document.addEventListener('DOMContentLoaded', () => {
    ['file', 'folder'].forEach(type => {
      pushInput(type)?.addEventListener('change', () => {
        pushSelectionGeneration++;
        selectionWarning(type);
        rememberPushSelection(type);
      });
    });
    wire('push', 'lxcPushModal', 'lxc-push-history');
    wire('pull', 'lxcPullModal', 'lxc-pull-history');
    wire('custom', 'customCommandModal', 'custom-command-history');
  });
})();
