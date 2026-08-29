import unittest
from unittest.mock import patch
from requests.cookies import RequestsCookieJar

from app.connectors.ctfd import CTFdClient


class _FakeResponse:
    def __init__(self, payload=None, status_code=200, text=''):
        self.payload = payload
        self.status_code = status_code
        self.text = text
        self.content = b'x' if payload is not None else text.encode()
        self.headers = {'Content-Type': 'application/json'} if payload is not None else {'Content-Type': 'text/html'}

    def json(self):
        return self.payload


class CtfdConnectorUserLookupTests(unittest.TestCase):

    def test_username_password_login_uses_session_and_captures_admin_csrf(self):
        class FakeSession:
            def __init__(self):
                self.cookies = RequestsCookieJar()
                self.verify = True
                self.posted = None
                self.requests = []

            def get(self, url, **kwargs):
                if url.endswith('/login'):
                    return _FakeResponse(
                        text='<form action="/login"><input name="nonce" value="login-nonce"></form>'
                    )
                return _FakeResponse(text='<meta name="csrf-token" content="admin-csrf">')

            def post(self, url, data=None, **kwargs):
                self.posted = dict(data or {})
                return _FakeResponse(status_code=302)

            def request(self, method, url, **kwargs):
                self.requests.append((method, url, kwargs))
                if method.upper() == 'POST' and url.endswith('/api/v1/users'):
                    return _FakeResponse({'success': True, 'data': {'id': 8, 'name': 'new-user'}})
                return _FakeResponse({'success': True, 'data': {'id': 7, 'name': 'admin'}})

        session = FakeSession()
        client = CTFdClient(base_url='https://ctfd.local', verify_ssl=False)

        with patch('app.connectors.ctfd.requests.Session', return_value=session):
            ok, message = client.login_with_credentials('admin', 'secret')

        self.assertTrue(ok, message)
        self.assertIs(client.session, session)
        self.assertEqual(session.posted.get('name'), 'admin')
        self.assertEqual(session.posted.get('password'), 'secret')
        self.assertEqual(session.posted.get('nonce'), 'login-nonce')
        self.assertEqual(client.csrf_token, 'admin-csrf')

        created = client.create_user('new-user', 'new-user@example.com', 'new-secret')
        self.assertEqual(created.get('id'), 8)
        create_call = next(call for call in session.requests if call[0] == 'POST')
        headers = create_call[2].get('headers') or {}
        self.assertEqual(headers.get('CSRF-Token'), 'admin-csrf')
        self.assertEqual(headers.get('X-CSRF-Token'), 'admin-csrf')
        self.assertEqual(headers.get('Referer'), 'https://ctfd.local/admin/users')

    def test_find_user_id_by_name_uses_ctfd_38_query_params(self):
        client = CTFdClient(base_url='https://ctfd.local', token='token')
        calls = []

        def fake_request(method, path, *, params=None, json=None, data=None):
            calls.append({'method': method, 'path': path, 'params': dict(params or {})})
            return _FakeResponse({'success': True, 'data': [{'id': 42, 'name': 'alice'}]})

        with patch.object(client, '_request', side_effect=fake_request), \
             patch.object(client, '_safe_json', side_effect=lambda resp: resp.payload):
            user_id = client.find_user_id_by_name('alice')

        self.assertEqual(user_id, 42)
        self.assertGreaterEqual(len(calls), 1)
        first = calls[0]
        self.assertEqual(first['method'], 'GET')
        self.assertEqual(first['path'], '/api/v1/users')
        self.assertEqual(first['params'].get('q'), 'alice')
        self.assertEqual(first['params'].get('field'), 'name')
        self.assertEqual(first['params'].get('view'), 'admin')

    def test_find_user_id_by_name_scans_all_pages(self):
        client = CTFdClient(base_url='https://ctfd.local', token='token')
        calls = []

        def fake_request(method, path, *, params=None, json=None, data=None):
            params = dict(params or {})
            calls.append(params)
            page = int(params.get('page', 1))
            if params.get('q'):
                return _FakeResponse({'success': True, 'data': [], 'meta': {'pagination': {'page': 1, 'pages': 1}}})
            payload = {
                'success': True,
                'data': [{'id': 99, 'name': 'target-user'}] if page == 6 else [],
                'meta': {'pagination': {'page': page, 'pages': 6}},
            }
            return _FakeResponse(payload)

        with patch.object(client, '_request', side_effect=fake_request), \
             patch.object(client, '_safe_json', side_effect=lambda resp: resp.payload):
            user_id = client.find_user_id_by_name('target-user')

        self.assertEqual(user_id, 99)
        scanned_pages = [int(call.get('page', 1)) for call in calls if not call.get('q')]
        self.assertEqual(scanned_pages, [1, 2, 3, 4, 5, 6])

    def test_find_user_id_by_name_tries_email_field_for_email_targets(self):
        client = CTFdClient(base_url='https://ctfd.local', token='token')
        calls = []

        def fake_request(method, path, *, params=None, json=None, data=None):
            params = dict(params or {})
            calls.append(params)
            if params.get('field') == 'email':
                return _FakeResponse({'success': True, 'data': [{'id': 24, 'email': 'alice@example.com', 'name': 'alice'}]})
            return _FakeResponse({'success': True, 'data': [], 'meta': {'pagination': {'page': 1, 'pages': 1}}})

        with patch.object(client, '_request', side_effect=fake_request), \
             patch.object(client, '_safe_json', side_effect=lambda resp: resp.payload):
            user_id = client.find_user_id_by_name('alice@example.com')

        self.assertEqual(user_id, 24)
        self.assertTrue(any(call.get('field') == 'email' for call in calls))


if __name__ == '__main__':
    unittest.main()
