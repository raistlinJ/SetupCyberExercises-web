"""Session-based administrator client for CTF-RPG."""

from urllib.parse import urlsplit

import requests


class CTFRPGError(Exception):
    def __init__(self, status_code, message):
        super().__init__(message)
        self.status_code = status_code


class CTFRPGClient:
    def __init__(self, base_url, username, password, verify_ssl=True):
        clean_url = str(base_url or '').strip()
        parsed = urlsplit(clean_url)
        if parsed.scheme not in ('http', 'https') or not parsed.hostname or parsed.username or parsed.password:
            raise ValueError('Enter a valid CTF-RPG URL starting with http:// or https://')
        if parsed.query or parsed.fragment:
            raise ValueError('CTF-RPG URL must not contain a query or fragment')
        self.base_url = clean_url.rstrip('/')
        self.origin = f'{parsed.scheme}://{parsed.netloc}'
        self.username = str(username or '').strip()
        self.password = str(password or '')
        if not self.username or not self.password:
            raise ValueError('CTF-RPG admin username and password are required')
        self.verify_ssl = verify_ssl
        self.session = requests.Session()
        self._user = None
        self._users_cache = None
        self._characters = None

    def _request(self, method, path, **kwargs):
        headers = {'Accept': 'application/json'}
        if method not in ('GET', 'HEAD'):
            headers['Origin'] = self.origin
        try:
            response = self.session.request(
                method, self.base_url + path, headers=headers,
                verify=self.verify_ssl, timeout=20, allow_redirects=False, **kwargs,
            )
        except requests.RequestException as exc:
            raise CTFRPGError(502, f'CTF-RPG connection failed: {exc}') from exc
        try:
            data = response.json()
        except ValueError:
            raise CTFRPGError(502, f'CTF-RPG returned a non-JSON response (HTTP {response.status_code})')
        if not response.ok:
            message = data.get('error') if isinstance(data, dict) else None
            raise CTFRPGError(response.status_code, str(message or f'CTF-RPG returned HTTP {response.status_code}'))
        if not isinstance(data, dict):
            raise CTFRPGError(502, 'CTF-RPG returned an invalid response')
        return data

    def _login(self):
        if self._user is not None:
            return self._user
        data = self._request('POST', '/api/auth', json={
            'mode': 'login', 'username': self.username, 'password': self.password,
        })
        if not data.get('admin') or not isinstance(data.get('user'), dict):
            raise CTFRPGError(403, 'CTF-RPG administrator access is required')
        self._user = data['user']
        return self._user

    def _load_users(self, *, refresh=False):
        self._login()
        if refresh or self._users_cache is None:
            data = self._request('GET', '/api/admin/users')
            self._users_cache = data.get('users') or []
            self._characters = data.get('characters') or []
        return self._users_cache

    def me(self):
        user = self._login()
        self._load_users()
        return {'user': user, 'characters': self._characters}

    def users(self):
        accounts = self._load_users(refresh=True)
        return {'users': [
            {**account, 'team': (account.get('team') or {}).get('name') if isinstance(account.get('team'), dict) else account.get('team')}
            for account in accounts if isinstance(account, dict)
        ]}

    def scoreboard(self):
        self._login()
        individuals = self._request('GET', '/api/scoreboard?mode=individual')
        teams = self._request('GET', '/api/scoreboard?mode=team')
        return {'users': individuals.get('players') or [], 'teams': teams.get('players') or []}

    def put_user(self, username, password, hero=None):
        name = str(username or '').strip().lower()
        if not name:
            raise ValueError('CTF-RPG username is required')
        accounts = self._load_users(refresh=True)
        existing = next((account for account in accounts if str(account.get('username') or '').casefold() == name.casefold()), None)
        if existing and existing.get('role') == 'admin':
            raise CTFRPGError(409, 'Refusing to update a CTF-RPG administrator account')
        character = hero or (existing or {}).get('hero') or next((c.get('id') for c in self._characters if c.get('id')), None)
        if not character:
            raise CTFRPGError(400, 'CTF-RPG has no available character for a new user')
        payload = {
            'username': name,
            'password': str(password or ''),
            'hero': character,
            'role': 'student',
            'disabled': bool((existing or {}).get('disabled', False)),
            'editing': bool(existing),
            'revision': int((existing or {}).get('revision') or 0),
        }
        data = self._request('POST', '/api/admin/users', json=payload)
        self._users_cache = data.get('users') or None
        if data.get('characters') is not None:
            self._characters = data['characters']
        return {'action': 'updated' if existing else 'created'}

    def delete_user(self, username):
        name = str(username or '').strip().lower()
        accounts = self._load_users(refresh=True)
        existing = next((account for account in accounts if str(account.get('username') or '').casefold() == name.casefold()), None)
        if not existing:
            raise CTFRPGError(404, 'User not found')
        if existing.get('role') == 'admin':
            raise CTFRPGError(409, 'Refusing to delete a CTF-RPG administrator account')
        data = self._request('POST', '/api/admin/users', json={
            'action': 'delete', 'users': [{'username': name, 'revision': int(existing.get('revision') or 0)}],
        })
        self._users_cache = data.get('users') or None
        return {'action': 'deleted'}
