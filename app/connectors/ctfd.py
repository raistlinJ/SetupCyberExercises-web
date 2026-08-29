from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple
import re
from urllib.parse import urlparse
import requests


class CTFdError(Exception):
    """Raised for non-2xx responses from CTFd, carrying status and body."""
    def __init__(self, status_code: int, body: str = "", url: str = "", method: str = ""):
        super().__init__(f"CTFd error {status_code}: {body}")
        self.status_code = status_code
        self.body = body
        self.url = url
        self.method = method


@dataclass
class CTFdClient:
    base_url: str
    token: str = ""
    verify_ssl: bool = True
    session: Optional[requests.Session] = field(default=None, repr=False)
    csrf_token: Optional[str] = field(default=None, repr=False)
    logs: List[Dict[str, Any]] = field(default_factory=list, repr=False)
    _challenge_name_cache: Dict[int, str] = field(default_factory=dict, repr=False)
    _user_name_cache: Dict[int, str] = field(default_factory=dict, repr=False)
    _team_name_cache: Dict[int, str] = field(default_factory=dict, repr=False)

    def _log(self, event: str, **data):
        try:
            rec = {"event": event}
            # Shallow copy and redact sensitive values
            for k, v in (data or {}).items():
                if k in ("password",):
                    rec[k] = "***"
                else:
                    rec[k] = v
            self.logs.append(rec)
        except Exception:
            pass

    def _headers(self) -> Dict[str, str]:
        h: Dict[str, str] = {}
        if self.token:
            h["Authorization"] = f"Token {self.token}"
        else:
            # When using a session (cookie) for API writes, include CSRF and Referer
            try:
                if self.session is not None:
                    csrf = self.csrf_token
                    try:
                        if not csrf:
                            csrf = self.session.cookies.get('csrf_token')
                    except Exception:
                        csrf = None
                    if csrf:
                        h['CSRF-Token'] = csrf
                        h['X-CSRF-Token'] = csrf
                    # Many deployments expect X-Requested-With for API writes (AJAX)
                    h['X-Requested-With'] = 'XMLHttpRequest'
                    # Provide a Referer to satisfy stricter CSRF checks
                    base = self.base_url.rstrip('/') + '/'
                    h['Referer'] = base + 'admin/users'
                    # Provide Origin as well (some proxies/frameworks require both)
                    origin = self.base_url.rstrip('/')
                    h['Origin'] = origin
            except Exception:
                pass
        # Use Content-Type to indicate JSON payloads (instead of Accept)
        h.setdefault('Content-Type', 'application/json')
        return h

    @staticmethod
    def _extract_csrf_token(html: str) -> Optional[str]:
        """Extract CTFd's session nonce from current and legacy page formats."""
        source = str(html or '')
        if not source:
            return None
        try:
            # Hidden form fields. Inspect each tag so name/value attribute order
            # does not matter.
            for match in re.finditer(r"<input\b[^>]*>", source, flags=re.IGNORECASE):
                tag = match.group(0)
                name_match = re.search(
                    r"\bname\s*=\s*['\"](csrf_token|nonce)['\"]",
                    tag,
                    flags=re.IGNORECASE,
                )
                value_match = re.search(
                    r"\bvalue\s*=\s*['\"]([^'\"]+)['\"]",
                    tag,
                    flags=re.IGNORECASE,
                )
                if name_match and value_match:
                    return value_match.group(1)

            # Custom themes sometimes expose a meta csrf-token. Support either
            # attribute order.
            for match in re.finditer(r"<meta\b[^>]*>", source, flags=re.IGNORECASE):
                tag = match.group(0)
                if not re.search(r"\bname\s*=\s*['\"]csrf-token['\"]", tag, flags=re.IGNORECASE):
                    continue
                content_match = re.search(
                    r"\bcontent\s*=\s*['\"]([^'\"]+)['\"]",
                    tag,
                    flags=re.IGNORECASE,
                )
                if content_match:
                    return content_match.group(1)

            # CTFd 3.x admin/core templates expose Session.nonce as either
            # window.init = {'csrfNonce': "..."} or var init = {...}.
            js_match = re.search(
                r"['\"]?csrfNonce['\"]?\s*[:=]\s*['\"]([^'\"]+)['\"]",
                source,
                flags=re.IGNORECASE,
            )
            if js_match:
                return js_match.group(1)
        except Exception:
            return None
        return None

    def _refresh_session_csrf(self, path: str = '/admin/users') -> Optional[str]:
        """Fetch an authenticated CTFd page and capture its current nonce."""
        if self.session is None:
            return None
        url = self._url(path)
        try:
            response = self.session.get(
                url,
                headers={'Referer': self.base_url.rstrip('/') + '/'},
                timeout=30,
                verify=self.verify_ssl,
            )
            self._log('request', method='GET', url=url)
            self._log('response', status=getattr(response, 'status_code', None), url=url)
            if getattr(response, 'status_code', 500) >= 400:
                return None
            token = self._extract_csrf_token(getattr(response, 'text', '') or '')
            if token:
                self.csrf_token = token
                self._log('csrf', captured=True, source='authenticated_page', token_length=len(token))
            return token
        except Exception:
            return None

    def _url(self, path: str) -> str:
        base = self.base_url.rstrip('/')
        if not path.startswith('/'):
            path = '/' + path
        return base + path

    def _ensure_session_cookies(self) -> None:
        """Ensure we have a requests.Session with any default cookies that CTFd sets
        (e.g., anonymous 'session' or 'by'). This is useful even in token mode
        so our logs and subsequent requests carry these cookies, matching browser behavior.
        """
        try:
            if self.session is None:
                s = requests.Session()
                # Carry SSL verification preference
                try:
                    s.verify = self.verify_ssl  # type: ignore[attr-defined]
                except Exception:
                    pass
                root = self.base_url.rstrip('/') + '/'
                try:
                    # Warm up cookies by hitting the root
                    self._log("request", event="request", method="GET", url=root)
                except Exception:
                    pass
                try:
                    r = s.get(root, timeout=15, verify=self.verify_ssl)
                    try:
                        self._log("response", status=getattr(r, 'status_code', None), url=root)
                    except Exception:
                        pass
                except Exception:
                    # Ignore failures; still assign the session so that any future
                    # successful requests can accumulate cookies.
                    r = None
                # Ensure a benign 'by' cookie is present alongside 'session' to
                # mirror typical browser state and help with environments that expect it.
                try:
                    host = ''
                    try:
                        host = urlparse(self.base_url).hostname or ''
                    except Exception:
                        host = ''
                    has_by = False
                    try:
                        for c in s.cookies:  # type: ignore
                            if getattr(c, 'name', None) == 'by':
                                has_by = True
                                break
                    except Exception:
                        has_by = False
                    if (not has_by) and host:
                        # Value is arbitrary preference; using 'name' is harmless
                        s.cookies.set('by', 'name', domain=host, path='/')
                except Exception:
                    pass
                self.session = s
        except Exception:
            # Non-fatal; operate without a session if creation fails
            pass

    def _request(self, method: str, path: str, *, params: Optional[Dict[str, Any]] = None, json: Optional[Dict[str, Any]] = None, data: Optional[Dict[str, Any]] = None) -> requests.Response:
        url = self._url(path)
        # In token mode we still warm up a session to pick up default cookies
        if self.session is None and self.token:
            self._ensure_session_cookies()
        sess = self.session or requests
        headers = self._headers()
        # Prepare safe payload for logging (redact password keys)
        def _redact(obj):
            try:
                if isinstance(obj, dict):
                    out = {}
                    for k, v in obj.items():
                        if str(k).lower() in ("password","pass","pwd"):
                            out[k] = "***"
                        else:
                            out[k] = v
                    return out
            except Exception:
                pass
            return obj
        # Summarize sensitive headers and cookies
        is_token_me = bool(self.token) and (path == '/api/v1/users/me' or path.endswith('/api/v1/users/me'))
        try:
            # Redact Authorization value but indicate presence and scheme
            auth_hdr = headers.get('Authorization')
            if auth_hdr:
                if auth_hdr.startswith('Token '):
                    auth_display = 'Token ******'
                else:
                    auth_display = '******'
            else:
                auth_display = None
            if is_token_me:
                # Minimal header log for /me in token mode
                hdr_summary = {
                    'Authorization': auth_display,
                }
            else:
                hdr_summary = {
                    'Referer': headers.get('Referer'),
                    'Origin': headers.get('Origin'),
                    'Authorization': auth_display,
                    'CSRF-Token': headers.get('CSRF-Token'),
                    'X-CSRF-Token': headers.get('X-CSRF-Token'),
                }
        except Exception:
            hdr_summary = {}
        cookie_names: Optional[List[str]] = None
        try:
            if (not is_token_me) and self.session is not None and hasattr(self.session, 'cookies'):
                cookie_names = []
                for c in self.session.cookies:  # type: ignore
                    try:
                        cookie_names.append(getattr(c, 'name', str(c)))
                    except Exception:
                        continue
        except Exception:
            cookie_names = None
        # Also capture current csrf cookie value if present for debugging
        csrf_cookie = None
        try:
            if (not is_token_me) and self.session is not None and hasattr(self.session, 'cookies'):
                csrf_cookie = self.session.cookies.get('csrf_token')
        except Exception:
            csrf_cookie = None
        if is_token_me:
            # Minimal request log: only method, url, and Authorization header
            self._log(
                "request",
                method=method.upper(),
                url=url,
                headers=hdr_summary,
            )
        else:
            self._log(
                "request",
                method=method.upper(),
                url=url,
                auth=("token" if (self.token) else ("session" if self.session is not None else "none")),
                headers=hdr_summary,
                cookies=cookie_names,
                csrf_cookie=csrf_cookie,
                params=_redact(params) if params else None,
                json=_redact(json) if json else None,
                data=_redact(data) if data else None,
            )
        resp = sess.request(method.upper(), url, headers=headers, params=params, json=json, data=data, timeout=30, verify=self.verify_ssl)
        # Log response summary (truncate body)
        try:
            body_preview = (resp.text or "")[:300]
        except Exception:
            body_preview = ""
        self._log("response", status=resp.status_code, url=url, body=body_preview)
        if resp.status_code >= 400:
            raise CTFdError(resp.status_code, resp.text, url=url, method=method.upper())
        return resp

    def _safe_json(self, resp: requests.Response) -> Dict[str, Any]:
        """Parse JSON if present; return empty dict on empty/non-JSON bodies.
        Avoids ValueError (e.g., 204 No Content) during .json()."""
        try:
            # Empty body fast-path
            if resp is None:
                return {}
            if getattr(resp, 'status_code', None) == 204:
                return {}
            # requests.Response.content is bytes; empty when no body
            content = getattr(resp, 'content', None)
            if content is None or len(content) == 0:
                return {}
            ct = (resp.headers.get('Content-Type') or '').lower()
            if 'application/json' in ct:
                return resp.json()
            # Fallback: try json() anyway; if it fails, return {}
            try:
                return resp.json()
            except Exception:
                return {}
        except Exception:
            return {}

    def login_with_credentials(self, username: str, password: str) -> Tuple[bool, str]:
        """Attempt a session login using the HTML login form with CSRF/nonce.
        Returns (ok, message). On success, self.session will be a logged-in Session with cookies.
        """
        s = requests.Session()
        s.verify = self.verify_ssl
        # Step 1: fetch login page to obtain a CSRF/nonce token
        login_url = self._url('/login')
        r1 = s.get(login_url, timeout=30)
        try:
            self._log("request", method="GET", url=login_url)
            self._log("response", status=r1.status_code, url=login_url)
        except Exception:
            pass
        if r1.status_code >= 400:
            return False, f"login page error {r1.status_code}"
        html = r1.text or ''
        token_value = self._extract_csrf_token(html)
        token_name: Optional[str] = 'nonce'
        try:
            if re.search(r"\bname\s*=\s*['\"]csrf_token['\"]", html, flags=re.IGNORECASE):
                token_name = 'csrf_token'
        except Exception:
            pass
        form = {
            'name': username,
            'username': username,  # some deployments use 'username' instead of 'name'
            'password': password,
        }
        if token_name and token_value:
            form[token_name] = token_value
            # Persist token for API CSRF headers later
            self.csrf_token = token_value
            try:
                self._log("csrf", captured=True, token=token_value, token_length=len(token_value))
            except Exception:
                pass
        # Step 2: submit credentials (include Referer for CSRF protection middlewares)
        # Include Referer and Origin for stricter CSRF/proxy checks
        headers = {
            'Referer': login_url,
            'Origin': self.base_url.rstrip('/'),
        }
        r2 = s.post(login_url, data=form, headers=headers, allow_redirects=False, timeout=30)
        try:
            # Redact sensitive form fields
            safe_form = dict(form)
            if 'password' in safe_form:
                safe_form['password'] = '***'
            if 'username' in safe_form:
                safe_form['username'] = str(safe_form.get('username', ''))
            if 'name' in safe_form:
                safe_form['name'] = str(safe_form.get('name', ''))
            self._log("request", method="POST", url=login_url, data=safe_form)
            self._log("response", status=r2.status_code, url=login_url)
        except Exception:
            pass
        # CTFd often redirects to / after successful login (302)
        if r2.status_code not in (200, 302, 303):
            return False, f"login failed {r2.status_code}: {r2.text[:200]}"
        # If not redirected, ensure we actually got logged in by accessing /api/v1/users/me
        self.session = s
        # Capture CSRF cookie if available
        try:
            if not self.csrf_token:
                self.csrf_token = s.cookies.get('csrf_token')
        except Exception:
            pass
        try:
            me_resp = self._request('GET', '/api/v1/users/me')
            data = self._safe_json(me_resp)
            # CTFd typically returns { success: bool, data: {...} }
            if isinstance(data, dict):
                success = data.get('success')
                user = data.get('data') if isinstance(data.get('data'), dict) else {}
                uid = user.get('id') if isinstance(user, dict) else None
                if (success is True) and uid:
                    self._refresh_session_csrf('/admin/users')
                    return True, 'ok'
                # If success flag missing, consider uid presence as signal
                if (success is None) and uid:
                    self._refresh_session_csrf('/admin/users')
                    return True, 'ok'
                msg = data.get('message') or 'not authenticated'
                return False, f"login verify failed: {msg}"
        except Exception as e:
            return False, f"login verify failed: {e}"
        return False, 'login verification failed'

    def get_current_user(self) -> Dict[str, Any]:
        resp = self._request('GET', '/api/v1/users/me')
        data = self._safe_json(resp)
        return (data.get('data') if isinstance(data, dict) else {}) or {}

    def get_role(self) -> str:
        """Return the current user's role/type as a lowercase string if available.
        Obtains the current user id via /api/v1/users/me, then fetches /api/v1/users/<id>
        and extracts 'type' or 'role' from that object. Falls back to /me parsing.
        """
        # Helper to pick role/type from a dict
        def pick(d: Dict[str, Any]) -> str:
            try:
                for k in ('type', 'role'):
                    v = d.get(k)
                    if isinstance(v, str) and v.strip():
                        return v.strip().lower()
            except Exception:
                pass
            return ''
        # First, get /me to learn our id
        me = {}
        try:
            me = self.get_current_user() or {}
        except Exception:
            me = {}
        # Try to locate id in common places
        uid = None
        try:
            cand = None
            if isinstance(me, dict):
                if isinstance(me.get('id'), (int, str)):
                    cand = me.get('id')
                elif isinstance(me.get('user'), dict) and isinstance(me['user'].get('id'), (int, str)):
                    cand = me['user'].get('id')
            if cand is not None:
                uid = int(cand)
        except Exception:
            uid = None
        # If we have a user id, fetch the canonical user object
        if uid is not None:
            try:
                resp = self._request('GET', f'/api/v1/users/{uid}')
                data = self._safe_json(resp)
                user = {}
                if isinstance(data, dict):
                    user = data.get('data') or data.get('user') or {}
                # For /users/<id>, CTFd provides the role in the 'type' field
                utype = user.get('type') if isinstance(user, dict) else None
                if isinstance(utype, str) and utype.strip():
                    return utype.strip().lower()
                # Fallback to generic picker if needed
                role = pick(user)
                if role:
                    return role
            except Exception:
                pass
        # Fallback: attempt to pick from /me result
        if isinstance(me, dict):
            role = pick(me)
            if role:
                return role
            if isinstance(me.get('user'), dict):
                role = pick(me['user'])
                if role:
                    return role
        return ''

    def list_challenges(self) -> List[Dict[str, Any]]:
        resp = self._request('GET', '/api/v1/challenges')
        data = resp.json()
        return data.get("data", [])

    def list_challenges_all(self) -> List[Dict[str, Any]]:
        """Return all challenges including hidden, using admin-capable views.
        Tries, in order:
        - /api/v1/challenges?view=admin (seen on newer versions)
        - /api/v1/admin/challenges (older admin namespace)
        - Fallback to regular list (visible only)
        """
        # Try query param view=admin
        try:
            r = self._request('GET', '/api/v1/challenges', params={'view': 'admin'})
            j = self._safe_json(r)
            arr = j.get('data') if isinstance(j, dict) else None
            if isinstance(arr, list) and arr:
                return arr
        except Exception:
            pass
        # Try admin namespace
        try:
            r2 = self._request('GET', '/api/v1/admin/challenges')
            j2 = self._safe_json(r2)
            arr2 = j2.get('data') if isinstance(j2, dict) else None
            if isinstance(arr2, list) and arr2:
                return arr2
        except Exception:
            pass
        # Fallback to regular list
        try:
            return self.list_challenges()
        except Exception:
            return []

    def get_challenge(self, challenge_id: int) -> Dict[str, Any]:
        """Return a single challenge object dict from /api/v1/challenges/<id> (data dict)."""
        try:
            cid = int(challenge_id)
        except Exception:
            return {}
        resp = self._request('GET', f'/api/v1/challenges/{cid}')
        j = self._safe_json(resp)
        if isinstance(j, dict):
            d = j.get('data') or j.get('challenge') or {}
            return d or {}
        return {}

    def update_challenge_state(self, challenge_id: int, visible: bool) -> Dict[str, Any]:
        """Update a challenge visibility state via PATCH /api/v1/challenges/<id>.
        Uses CTFd's 'state' field where allowed values typically include 'visible' and 'hidden'.
        Returns updated challenge data when available; empty dict on 204-like responses.
        """
        try:
            cid = int(challenge_id)
        except Exception:
            raise ValueError(f"invalid challenge id: {challenge_id}")
        payload = { 'state': ('visible' if visible else 'hidden') }
        try:
            resp = self._request('PATCH', f'/api/v1/challenges/{cid}', json=payload)
            j = self._safe_json(resp)
            if isinstance(j, dict):
                return (j.get('data') or j.get('challenge') or {}) or {}
            return {}
        except CTFdError as e:
            # Fallback for deployments that expect boolean hidden flag
            if int(getattr(e, 'status_code', 0) or 0) in (400, 422):
                try:
                    alt = { 'hidden': (not bool(visible)) }
                    resp2 = self._request('PATCH', f'/api/v1/challenges/{cid}', json=alt)
                    j2 = self._safe_json(resp2)
                    if isinstance(j2, dict):
                        return (j2.get('data') or j2.get('challenge') or {}) or {}
                    # Read back to verify when body is empty
                    try:
                        return self.get_challenge(cid)
                    except Exception:
                        return {}
                except Exception:
                    # Re-raise original error if fallback also fails
                    raise e
            # Non-compat error: re-raise
            raise e

    def get_challenge_name(self, chall_id: int) -> Optional[str]:
        try:
            cid = int(chall_id)
        except Exception:
            return None
        # Cache first
        try:
            if cid in self._challenge_name_cache:
                return self._challenge_name_cache[cid]
        except Exception:
            pass
        # Try fetch single challenge (if supported)
        name: Optional[str] = None
        try:
            r = self._request('GET', f'/api/v1/challenges/{cid}')
            j = self._safe_json(r)
            d = j.get('data') if isinstance(j, dict) else None
            if isinstance(d, dict):
                nm = d.get('name')
                if isinstance(nm, str) and nm.strip():
                    name = nm.strip()
        except Exception:
            name = None
        # Fallback: scan list
        if not name:
            try:
                for c in self.list_challenges():
                    try:
                        if int(c.get('id')) == cid:
                            nm = c.get('name')
                            if isinstance(nm, str) and nm.strip():
                                name = nm.strip()
                                break
                    except Exception:
                        continue
            except Exception:
                pass
        if name:
            try:
                self._challenge_name_cache[cid] = name
            except Exception:
                pass
        return name

    def list_challenge_solves(self, challenge_id: int) -> List[Dict[str, Any]]:
        """Return solves for a given challenge id via /api/v1/challenges/<id>/solves if supported.
        Some CTFd versions expose this; otherwise we may need to infer via global solves, but we'll try the direct endpoint first.
        """
        try:
            cid = int(challenge_id)
        except Exception:
            return []
        # Preferred per-challenge endpoint
        try:
            r = self._request('GET', f'/api/v1/challenges/{cid}/solves')
            j = self._safe_json(r)
            arr = j.get('data') if isinstance(j, dict) else None
            if isinstance(arr, list):
                return arr
        except Exception:
            pass
        # Fallback: try global solves with filter (if supported)
        try:
            r2 = self._request('GET', '/api/v1/solves', params={"challenge_id": cid})
            j2 = self._safe_json(r2)
            arr2 = j2.get('data') if isinstance(j2, dict) else None
            if isinstance(arr2, list):
                # Some deployments may ignore the param; filter locally as a safeguard
                out = []
                for s in arr2:
                    try:
                        sid = s.get('challenge_id') if isinstance(s, dict) else None
                        if sid is None:
                            sid = s.get('challenge') if isinstance(s, dict) else None
                        if sid is not None and int(sid) == cid:
                            out.append(s)
                    except Exception:
                        continue
                return out
        except Exception:
            pass
        return []

    def get_user_name(self, user_id: int) -> Optional[str]:
        try:
            uid = int(user_id)
        except Exception:
            return None
        if uid in self._user_name_cache:
            return self._user_name_cache[uid]
        try:
            r = self._request('GET', f'/api/v1/users/{uid}')
            j = self._safe_json(r)
            d = j.get('data') if isinstance(j, dict) else None
            nm = (d.get('name') if isinstance(d, dict) else None)
            if isinstance(nm, str) and nm.strip():
                self._user_name_cache[uid] = nm.strip()
                return self._user_name_cache[uid]
        except Exception:
            pass
        return None

    def get_team_name(self, team_id: int) -> Optional[str]:
        try:
            tid = int(team_id)
        except Exception:
            return None
        if tid in self._team_name_cache:
            return self._team_name_cache[tid]
        try:
            r = self._request('GET', f'/api/v1/teams/{tid}')
            j = self._safe_json(r)
            d = j.get('data') if isinstance(j, dict) else None
            nm = (d.get('name') if isinstance(d, dict) else None)
            if isinstance(nm, str) and nm.strip():
                self._team_name_cache[tid] = nm.strip()
                return self._team_name_cache[tid]
        except Exception:
            pass
        return None

    # --- Solve & membership helpers ---
    def list_user_solves(self, user_id: int) -> List[Dict[str, Any]]:
        """Return solves for a given user id via /api/v1/users/<id>/solves."""
        try:
            uid = int(user_id)
        except Exception:
            return []
        try:
            r = self._request('GET', f'/api/v1/users/{uid}/solves')
            j = self._safe_json(r)
            arr = j.get('data') if isinstance(j, dict) else None
            return arr if isinstance(arr, list) else []
        except Exception:
            return []

    def list_team_solves(self, team_id: int) -> List[Dict[str, Any]]:
        """Return solves for a given team id via /api/v1/teams/<id>/solves."""
        try:
            tid = int(team_id)
        except Exception:
            return []
        try:
            r = self._request('GET', f'/api/v1/teams/{tid}/solves')
            j = self._safe_json(r)
            arr = j.get('data') if isinstance(j, dict) else None
            return arr if isinstance(arr, list) else []
        except Exception:
            return []

    def list_team_members(self, team_id: int) -> List[Dict[str, Any]]:
        """Return team members via /api/v1/teams/<id>/members if available; try /teams/<id> for embedded info otherwise."""
        try:
            tid = int(team_id)
        except Exception:
            return []
        # Preferred endpoint
        try:
            r = self._request('GET', f'/api/v1/teams/{tid}/members')
            j = self._safe_json(r)
            arr = j.get('data') if isinstance(j, dict) else None
            if isinstance(arr, list):
                return arr
        except Exception:
            pass
        # Fallback: some deployments return members embedded in team object
        try:
            team = self.get_team(tid)
            for key in ('members','users','memberships'):
                val = team.get(key)
                if isinstance(val, list):
                    return val
        except Exception:
            pass
        return []

    def list_scoreboard(self) -> List[Dict[str, Any]]:
        """Return scoreboard rows from /api/v1/scoreboard."""
        try:
            r = self._request('GET', '/api/v1/scoreboard')
            j = self._safe_json(r)
            arr = j.get('data') if isinstance(j, dict) else None
            return arr if isinstance(arr, list) else []
        except Exception:
            return []

    # --- Users API ---
    def _list_payload_items(self, payload: Dict[str, Any]) -> List[Dict[str, Any]]:
        if not isinstance(payload, dict):
            return []
        data = payload.get('data')
        if isinstance(data, list):
            return [item for item in data if isinstance(item, dict)]
        results = payload.get('results')
        if isinstance(results, list):
            return [item for item in results if isinstance(item, dict)]
        return []

    def _list_payload_pages(self, payload: Dict[str, Any], fallback_page: int) -> int:
        if not isinstance(payload, dict):
            return fallback_page
        try:
            meta = payload.get('meta') or {}
            pagination = meta.get('pagination') if isinstance(meta, dict) else {}
            pages = pagination.get('pages') if isinstance(pagination, dict) else None
            if pages is not None:
                return max(int(pages), fallback_page)
        except Exception:
            pass
        return fallback_page

    def list_users(self, page: int = 1, per_page: int = 100, *, q: str = "", field: str = "", view_admin: bool = False) -> Dict[str, Any]:
        params: Dict[str, Any] = {
            "page": max(1, int(page or 1)),
            "per_page": min(100, max(1, int(per_page or 100))),
        }
        if q:
            params["q"] = q
        if field:
            params["field"] = field
        if view_admin:
            params["view"] = "admin"
        resp = self._request('GET', '/api/v1/users', params=params)
        return self._safe_json(resp)

    def list_all_users(self, per_page: int = 100, *, view_admin: bool = True) -> List[Dict[str, Any]]:
        page = 1
        total_pages = 1
        out: List[Dict[str, Any]] = []
        while page <= total_pages:
            payload = self.list_users(page=page, per_page=per_page, view_admin=view_admin)
            out.extend(self._list_payload_items(payload))
            next_total = self._list_payload_pages(payload, page)
            if next_total <= page:
                break
            total_pages = next_total
            page += 1
        return out

    def find_user_id_by_name(self, name: str) -> Optional[int]:
        wanted = name.strip().lower()
        if not wanted:
            return None

        def _match_user_id(payload: Dict[str, Any]) -> Optional[int]:
            for user in self._list_payload_items(payload):
                current = str(user.get('name') or user.get('username') or '').strip().lower()
                email = str(user.get('email') or '').strip().lower()
                if current != wanted and email != wanted:
                    continue
                value = user.get('id')
                try:
                    return int(value)
                except Exception:
                    try:
                        return int(str(value))
                    except Exception:
                        continue
            return None

        # CTFd 3.8 expects q/field and admin listings may require view=admin.
        search_variants = [
            {"q": name, "field": "name", "view_admin": True},
            {"q": name, "field": "name", "view_admin": False},
        ]
        if '@' in wanted:
            search_variants.extend([
                {"q": name, "field": "email", "view_admin": True},
                {"q": name, "field": "email", "view_admin": False},
            ])
        search_variants.extend([
            {"q": name, "view_admin": True},
            {"q": name, "view_admin": False},
        ])
        for params in search_variants:
            try:
                data = self.list_users(page=1, per_page=100, **params)
            except Exception:
                continue
            matched = _match_user_id(data)
            if matched is not None:
                return matched

        # Fallback: scan all available pages instead of only the first few.
        page = 1
        total_pages = 1
        while page <= total_pages:
            try:
                data = self.list_users(page=page, per_page=100, view_admin=True)
            except Exception:
                if page == 1:
                    data = self.list_users(page=page, per_page=100)
                else:
                    break
            matched = _match_user_id(data)
            if matched is not None:
                return matched
            next_total = self._list_payload_pages(data, page)
            if next_total <= page:
                break
            total_pages = next_total
            page += 1
        return None

    def create_user(self, name: str, email: str, password: str) -> Dict[str, Any]:
        payload = {
            "name": name,
            "email": email,
            "password": password,
            "type": "user",
            "verified": True,
        }
        resp = self._request('POST', '/api/v1/users', json=payload)
        data = self._safe_json(resp)
        # Some CTFd versions may return only {success:true} or minimal data
        return (data.get("data") if isinstance(data, dict) else {}) or {}

    def update_user_password(self, user_id: int, password: str) -> Dict[str, Any]:
        payload = {"password": password}
        resp = self._request('PATCH', f'/api/v1/users/{user_id}', json=payload)
        data = self._safe_json(resp)  # may be empty on 204
        return (data.get("data") if isinstance(data, dict) else {}) or {}

    def delete_user(self, user_id: int) -> None:
        resp = self._request('DELETE', f'/api/v1/users/{user_id}')

    # --- Additional helpers for rank/team info ---
    def get_user(self, user_id: int) -> Dict[str, Any]:
        """Return canonical user object from /api/v1/users/<id> (data dict).
        Some CTFd deployments put rank info under data.rank or within nested fields.
        """
        resp = self._request('GET', f'/api/v1/users/{user_id}')
        data = self._safe_json(resp)
        user = {}
        if isinstance(data, dict):
            user = data.get('data') or data.get('user') or {}
        return user or {}

    def get_team(self, team_id: int) -> Dict[str, Any]:
        """Return canonical team object from /api/v1/teams/<id> (data dict)."""
        resp = self._request('GET', f'/api/v1/teams/{team_id}')
        data = self._safe_json(resp)
        team = {}
        if isinstance(data, dict):
            team = data.get('data') or data.get('team') or {}
        return team or {}

    # --- Config helpers (visibility, paused, etc.) ---
    def get_config(self, key: str) -> Optional[Any]:
        """Fetch a single configuration value from /api/v1/configs/<key>.
        Returns the raw value field if present, else None.
        """
        try:
            resp = self._request('GET', f'/api/v1/configs/{key}')
            j = self._safe_json(resp)
            # Typical shape: { success: true, data: { key: 'challenge_visibility', value: 'private' } }
            if isinstance(j, dict):
                d = j.get('data') or {}
                return d.get('value') if isinstance(d, dict) else None
        except Exception:
            pass
        return None

    def list_configs(self) -> Dict[str, Any]:
        """Return a mapping of config key -> value by calling /api/v1/configs.
        Some CTFd versions return an array of {key,value} under data.
        """
        out: Dict[str, Any] = {}
        try:
            resp = self._request('GET', '/api/v1/configs')
            j = self._safe_json(resp)
            arr = j.get('data') if isinstance(j, dict) else None
            if isinstance(arr, list):
                for item in arr:
                    try:
                        k = item.get('key')
                        if not k:
                            continue
                        out[str(k)] = item.get('value')
                    except Exception:
                        continue
        except Exception:
            pass
        return out

    def set_configs(self, updates: Dict[str, Any]) -> Dict[str, Any]:
        """Update configuration values via PATCH /api/v1/configs.
        Expects updates as a dict of key -> value. Returns server JSON (may be empty on success).
        """
        try:
            resp = self._request('PATCH', '/api/v1/configs', json=updates)
            return self._safe_json(resp)
        except Exception as e:
            # Some deployments may require individual key updates: try fallbacks
            for k, v in (updates or {}).items():
                try:
                    self._request('PATCH', f'/api/v1/configs/{k}', json={'value': v})
                except Exception:
                    # If even fallback fails, re-raise original at the end
                    pass
            # Return best-effort response structure
            return { 'error': str(e) }
