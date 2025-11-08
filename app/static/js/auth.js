// Simple auth client for session-based login
window.AUTH = (function(){
  let currentUser = null;
  async function me(){
    try {
      const r = await fetch('/auth/me');
      if (!r.ok) return null;
      const d = await r.json();
      currentUser = d.user || null;
      return d;
    } catch { return null; }
  }
  async function login(username, password){
    const r = await fetch('/auth/login', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ username, password }) });
    if (!r.ok) throw new Error((await r.text())||'Login failed');
    const d = await r.json();
    currentUser = d.user || null;
    document.dispatchEvent(new CustomEvent('auth-changed', { detail: { user: currentUser } }));
    return d;
  }
  async function logout(){
    try { await fetch('/auth/logout', { method:'POST' }); } catch {}
    currentUser = null;
    document.dispatchEvent(new CustomEvent('auth-changed', { detail: { user: null } }));
  }
  function getUser(){ return currentUser; }
  return { me, login, logout, getUser };
})();

// Redirect to a dedicated login page if unauthenticated
document.addEventListener('DOMContentLoaded', async () => {
  try {
    const meData = await AUTH.me();
    if (meData && meData.user) return;
  } catch {}
  // If we are already on the login page, do nothing here
  const here = window.location.pathname || '';
  if (here.endsWith('/static/login.html')) return;
  const next = encodeURIComponent(window.location.pathname + window.location.search + window.location.hash);
  window.location.replace(`/static/login.html?next=${next}`);
});