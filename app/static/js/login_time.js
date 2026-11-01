(() => {
  'use strict';
  function timestamp(value) {
    if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
    const raw = String(value).trim();
    if (!raw) return null;
    const numeric = Number(raw);
    const ms = Number.isFinite(numeric) ? numeric * (numeric < 1e12 ? 1000 : 1)
      : Date.parse(/[zZ]$|[+-]\d{2}:?\d{2}$/.test(raw) ? raw : `${raw.replace(' ', 'T')}Z`);
    return Number.isFinite(ms) && ms > 0 ? ms : null;
  }
  function format(value, now = Date.now()) {
    const ms = timestamp(value);
    if (ms === null) return 'Unavailable';
    const minutes = Math.max(0, Math.floor((now - ms) / 60000));
    return `${String(Math.floor(minutes / 60)).padStart(2, '0')}h ${String(minutes % 60).padStart(2, '0')}m ago`;
  }
  function cell(value) {
    const ms = timestamp(value);
    if (ms === null) return '<span class="text-muted" title="No successful authentication was found in the retained Proxmox log, or log access is unavailable">Unavailable</span>';
    const iso = new Date(ms).toISOString();
    return `<span data-last-login="${iso}" title="${iso}">${format(iso)}</span>`;
  }
  function update() {
    document.querySelectorAll('[data-last-login]').forEach(element => {
      element.textContent = format(element.dataset.lastLogin);
    });
  }
  document.addEventListener('DOMContentLoaded', () => { setInterval(update, 60000); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) update(); });
  window.LoginTime = {timestamp, format, cell};
})();
