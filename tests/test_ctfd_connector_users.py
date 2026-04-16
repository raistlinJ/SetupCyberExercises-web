import unittest
from unittest.mock import patch

from app.connectors.ctfd import CTFdClient


class _FakeResponse:
    def __init__(self, payload, status_code=200):
        self.payload = payload
        self.status_code = status_code


class CtfdConnectorUserLookupTests(unittest.TestCase):

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