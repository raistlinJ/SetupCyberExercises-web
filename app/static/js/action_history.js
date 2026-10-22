// Recall settings only: selecting history never submits work or changes targets.
(function () {
  // Keep File references for this page only; history on the server stores names/settings.
  const pushSelections = new Map();
  const pushInput = type => document.getElementById(type === 'folder' ? 'lxc-push-folder' : 'lxc-push-files');
  const sourceNames = files => Array.from(files || [], file => String(file.webkitRelativePath || file.name || ''));
  const selectionKey = (type, names) => JSON.stringify([type, [...names].sort()]);

  function rememberPushSelection(type) {
    const files = Array.from(pushInput(type)?.files || []);
    if (!files.length) return;
    const key = selectionKey(type, sourceNames(files));
    pushSelections.delete(key);
    pushSelections.set(key, files);
    while (pushSelections.size > 5) pushSelections.delete(pushSelections.keys().next().value);
  }

  function restorePushSelection(type, settings) {
    const input = pushInput(type);
    if (!input) return;
    const names = Array.isArray(settings.sourceNames) ? settings.sourceNames : [];
    const key = selectionKey(type, names);
    let retained = names.length && selectionKey(type, sourceNames(input.files)) === key;
    if (!retained && pushSelections.has(key)) {
      try {
        const transfer = new DataTransfer();
        pushSelections.get(key).forEach(file => transfer.items.add(file));
        input.files = transfer.files;
        retained = selectionKey(type, sourceNames(input.files)) === key;
      } catch { /* Browsers without assignable FileLists require another selection. */ }
    }
    if (!retained) input.value = '';
    input.dispatchEvent(new Event('change', { bubbles: true }));
    const help = document.getElementById('lxc-push-history-help');
    if (help) help.textContent = retained
      ? 'Previous file selection is ready. Check the files and destination before pushing.'
      : 'Choose the original files or folder again. File selections can only be recalled while this page remains open.';
  }

  function setValue(id, value, event = 'input') {
    const element = document.getElementById(id);
    if (!element) return;
    element.value = value ?? '';
    element.dispatchEvent(new Event(event, { bubbles: true }));
  }

  function apply(kind, settings) {
    if (kind === 'custom') {
      setValue('custom-command-input', settings.command);
      setValue('custom-command-timeout', settings.timeoutSeconds);
    } else if (kind === 'pull') {
      setValue('lxc-pull-paths', settings.paths);
    } else {
      // The mode-change handler clears the inactive picker, so cache both first.
      ['file', 'folder'].forEach(rememberPushSelection);
      const type = settings.selectionType === 'folder' ? 'folder' : 'file';
      const radio = document.getElementById(`lxc-push-type-${type}`);
      if (radio) { radio.checked = true; radio.dispatchEvent(new Event('change', { bubbles: true })); }
      restorePushSelection(type, settings);
      setValue('lxc-push-destination', settings.destination);
      setValue('lxc-push-owner', settings.ownerOnRemote);
      setValue('lxc-push-permissions', settings.filePermissions);
      const advanced = document.getElementById('lxc-push-advanced');
      if (advanced) advanced.open = !!(settings.ownerOnRemote || settings.filePermissions);
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
    select.addEventListener('change', () => {
      const entry = entries.find(item => String(item.id) === select.value);
      if (entry) { apply(kind, entry.settings); select.value = ''; }
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
        entries = (Array.isArray(data.items) ? data.items : []).slice(0, 5);
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
      pushInput(type)?.addEventListener('change', () => rememberPushSelection(type));
    });
    wire('push', 'lxcPushModal', 'lxc-push-history');
    wire('pull', 'lxcPullModal', 'lxc-pull-history');
    wire('custom', 'customCommandModal', 'custom-command-history');
  });
})();
