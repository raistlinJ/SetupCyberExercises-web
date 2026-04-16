// Simple auth client for session-based login
window.AUTH = (function(){
  let currentUser = null;
  let authState = 'unknown'; // 'unknown' | 'authenticated' | 'unauthenticated'
  let redirecting = false;

  function isLoginPage(){
    try {
      const here = window.location.pathname || '';
      return here.endsWith('/static/login.html');
    } catch { return false; }
  }

  function buildLoginUrl(nextOverride){
    const base = '/static/login.html';
    const nextRaw = (typeof nextOverride === 'string') ? nextOverride : (window.location.pathname + window.location.search + window.location.hash);
    const next = encodeURIComponent(nextRaw || '/');
    return `${base}?next=${next}`;
  }

  function redirectToLogin(nextOverride){
    if (redirecting || isLoginPage()) return;
    authState = 'unauthenticated';
    redirecting = true;
    const target = buildLoginUrl(nextOverride);
    try {
      window.location.replace(target);
    } catch {
      window.location.href = target;
    }
  }

  async function me(){
    try {
      const r = await fetch('/auth/me');
      if (!r.ok) {
        if (r.status === 401 || r.status === 403) authState = 'unauthenticated';
        currentUser = null;
        return null;
      }
      const d = await r.json();
      currentUser = d.user || null;
      authState = currentUser ? 'authenticated' : 'unauthenticated';
      return d;
    } catch {
      return null;
    }
  }

  async function login(username, password){
    const r = await fetch('/auth/login', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ username, password }) });
    if (!r.ok) throw new Error((await r.text())||'Login failed');
    const d = await r.json();
    currentUser = d.user || null;
    authState = currentUser ? 'authenticated' : 'unauthenticated';
    document.dispatchEvent(new CustomEvent('auth-changed', { detail: { user: currentUser } }));
    return d;
  }

  async function logout(){
    try { await fetch('/auth/logout', { method:'POST' }); } catch {}
    currentUser = null;
    authState = 'unauthenticated';
    document.dispatchEvent(new CustomEvent('auth-changed', { detail: { user: null } }));
  }

  function getUser(){ return currentUser; }
  function getState(){ return authState; }

  return { me, login, logout, getUser, getState, redirectToLogin, isLoginPage };
})();

// Global fetch guard: redirect on unauthorized responses
(function(){
  if (typeof window === 'undefined' || typeof window.fetch !== 'function') return;
  const originalFetch = window.fetch;
  if (originalFetch && originalFetch._authWrapped) return;
  const wrapped = async function(...args){
    const res = await originalFetch.apply(this, args);
    try {
      if (res && (res.status === 401 || res.status === 403)) {
        const authFailure = (() => {
          try {
            const marker = res.headers && typeof res.headers.get === 'function'
              ? res.headers.get('X-DeployForge-Auth-Failure')
              : '';
            return String(marker || '').trim() === '1';
          } catch {
            return false;
          }
        })();
        if (authFailure && window.AUTH && typeof AUTH.redirectToLogin === 'function' && typeof AUTH.isLoginPage === 'function' && !AUTH.isLoginPage()) {
          AUTH.redirectToLogin();
        }
      }
    } catch {}
    return res;
  };
  wrapped._authWrapped = true;
  if (originalFetch) originalFetch._authWrapped = true;
  window.fetch = wrapped;
})();

// Redirect to login once we know the user is unauthenticated
document.addEventListener('DOMContentLoaded', async () => {
  try {
    const meData = await AUTH.me();
    if (meData && meData.user) return;
  } catch {}
  AUTH.redirectToLogin();
});

// Block user interactions once we know the user is unauthenticated
(function(){
  function guard(ev){
    try {
      if (!window.AUTH || typeof AUTH.getState !== 'function') return;
      if (AUTH.getState() !== 'unauthenticated') return;
      if (typeof AUTH.isLoginPage === 'function' && AUTH.isLoginPage()) return;
      ev.preventDefault();
      ev.stopImmediatePropagation();
      AUTH.redirectToLogin();
    } catch {}
  }
  ['click','submit','keydown'].forEach(evt => {
    document.addEventListener(evt, guard, true);
  });
})();