(() => {
  'use strict';
  const listeners = new Set(), revisions = new Map(), pending = new Map(), seen = new Set();
  const signalKey = 'toolhub.checkout.changed';
  const enabled = () => document.documentElement?.dataset?.accessforgePlugin === 'on';
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  let channel;
  try { channel = new BroadcastChannel(signalKey); } catch { /* Storage events also sync open tabs. */ }
  function interested(pid) {
    return [...listeners].some(item => item.projects().map(String).includes(pid));
  }
  function apply(pid, checkout) {
    for (const item of listeners) {
      if (item.projects().map(String).includes(pid)) item.callback(pid, checkout);
    }
  }
  function refresh(project) {
    const pid = String(project);
    if (!enabled() || !interested(pid)) return Promise.resolve();
    if (pending.has(pid)) return pending.get(pid);
    const revision = (revisions.get(pid) || 0) + 1;
    revisions.set(pid, revision);
    const task = (async () => {
      try {
        const send = window.ServerQueue?.nativeFetch || window.fetch.bind(window);
        // Read SCE-web's cached snapshot; never trigger another AccessForge request.
        const response = await send(`/api/projects/${encodeURIComponent(pid)}/accessforge/accounts`, {credentials:'same-origin', cache:'no-store'});
        if (!response.ok) return;
        const data = await response.json();
        if (revisions.get(pid) === revision && data.checkout) apply(pid, data.checkout);
      } catch { /* Keep the previous snapshot; retry when this page is shown again. */ }
      finally { pending.delete(pid); }
    })();
    pending.set(pid, task);
    return task;
  }
  function remember(id) {
    seen.add(id);
    if (seen.size > 100) seen.delete(seen.values().next().value);
  }
  function receive(signal) {
    if (!signal || typeof signal.pid !== 'string' || typeof signal.id !== 'string' || seen.has(signal.id)) return;
    remember(signal.id);
    // A newer signal invalidates any in-flight cached read and requests another.
    if (pending.has(signal.pid)) {
      revisions.set(signal.pid, (revisions.get(signal.pid) || 0) + 1);
      pending.get(signal.pid).then(() => refresh(signal.pid));
    } else refresh(signal.pid);
  }
  function publish(project, checkout) {
    const pid = String(project);
    revisions.set(pid, (revisions.get(pid) || 0) + 1);
    apply(pid, checkout);
    const signal = {pid, id: `${Date.now()}-${Math.random()}`};
    remember(signal.id);
    // Only an invalidation notice is persisted, never credentials or account details.
    try { localStorage.setItem(signalKey, JSON.stringify(signal)); } catch { /* BroadcastChannel may still work. */ }
    channel?.postMessage(signal);
  }
  function catchUp() {
    if (document.hidden || !enabled()) return;
    new Set([...listeners].flatMap(item => item.projects().map(String))).forEach(refresh);
  }
  if (channel) channel.onmessage = event => receive(event.data);
  window.addEventListener('storage', event => {
    if (event.key === signalKey && event.newValue) { try { receive(JSON.parse(event.newValue)); } catch {} }
  });
  window.addEventListener('pageshow', catchUp);
  document.addEventListener('visibilitychange', catchUp);
  function label(checkout, username) {
    const account = checkout?.accounts?.[username];
    const marked = account?.eligible ? 'Marked for checkout' : 'Not marked for checkout';
    const status = !account || account.sync_status==='unknown' ? 'Unknown' : account.sync_status==='not_synced' ? 'Not synced' : account.sync_status==='not_enabled' ? 'Not enabled' : account.releasing ? 'Release pending'
      : account.awaiting_checkout ? 'Available · AccessForge login requires checkout' : account.login_disabled ? 'AccessForge login disabled' : account.email ? `Checked out to ${account.name ? `${account.name} (${account.email})` : account.email}` : account.remote_eligible===true&&!account.eligible ? 'Enabled in AccessForge' : account.eligible ? 'Available according to checkout policy' : 'Checkout off';
    return `${marked} · ${status}`;
  }
  function icon(checkout, username) {
    const account = checkout?.accounts?.[username], marked = !!account?.eligible;
    const color = ['unknown','not_synced','not_enabled'].includes(account?.sync_status) ? 'text-secondary' : account?.releasing ? 'text-warning' : account?.awaiting_checkout ? 'text-success' : account?.login_disabled ? 'text-danger' : account?.email ? 'text-primary' : marked ? 'text-success' : 'text-secondary';
    const title = esc(label(checkout, username));
    const shape = marked ? '<path d="m7 12 3 3 7-7"/>' : '<path d="M8 12h8"/>';
    return `<span class="credential-checkout-state d-inline-flex align-items-center ${color}" data-checkout-marked="${marked}" role="img" tabindex="0" aria-label="${title}" title="${title}" data-bs-toggle="tooltip" data-bs-placement="top" data-bs-container="body" data-bs-custom-class="credential-state-tooltip"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/>${shape}</svg></span>`;
  }
  window.CheckoutState = {publish, refresh, label, icon, markedIcon:(checkout,username)=>enabled()&&checkout?.accounts?.[username]?.eligible?icon(checkout,username):'', subscribe(callback, projects) {
    const item = {callback, projects}; listeners.add(item); return () => listeners.delete(item);
  }};
})();
