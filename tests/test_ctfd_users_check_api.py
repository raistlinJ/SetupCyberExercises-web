import os
import tempfile
import unittest
from unittest.mock import MagicMock, patch

from app import create_app
from app.routes import api as api_module


class CtfdUsersCheckApiTests(unittest.TestCase):

    def setUp(self):
        os.environ['AUTH_ENABLE'] = '0'
        self.tmp = tempfile.TemporaryDirectory()
        self.app = create_app()
        self.app.config['TESTING'] = True
        self.app.config['DATA_DIR'] = self.tmp.name
        self.client = self.app.test_client()
        try:
            api_module._CTFD_CATEGORY_FIRSTS_CACHE.clear()
        except Exception:
            pass

    def tearDown(self):
        try:
            self.tmp.cleanup()
        except Exception:
            pass
        try:
            os.environ.pop('AUTH_ENABLE', None)
        except Exception:
            pass
        try:
            api_module._CTFD_CATEGORY_FIRSTS_CACHE.clear()
        except Exception:
            pass

    def _create_project(self) -> str:
        resp = self.client.post('/api/projects', json={'name': 'CTFd Check Project'})
        self.assertIn(resp.status_code, (200, 201))
        pid = (resp.get_json() or {}).get('id')
        self.assertTrue(pid)
        return pid

    def test_users_check_marks_existing_user_from_bulk_list(self):
        pid = self._create_project()
        patch_resp = self.client.patch(f'/api/projects/{pid}', json={
            'challenge_url': 'https://ctfd.local',
            'challenge_port': 443,
            'credentials': [{'username': 'alice', 'password': 'password1'}],
        })
        self.assertEqual(patch_resp.status_code, 200)

        fake_client = MagicMock()
        fake_client.token = 'token'
        fake_client.logs = []
        fake_client.list_all_users.return_value = [
            {'id': 77, 'name': 'alice', 'email': 'alice@example.com'}
        ]
        fake_client.get_user.return_value = {'id': 77, 'name': 'alice', 'score': 10}
        fake_client.list_user_solves.return_value = []

        with patch('app.routes.api._ctfd_client_from_req', return_value=fake_client):
            resp = self.client.post(
                f'/api/projects/{pid}/ctfd/users_check',
                json={
                    'baseUrl': 'https://ctfd.local',
                    'token': 'token',
                    'verifySSL': False,
                    'only': ['alice'],
                },
            )

        self.assertEqual(resp.status_code, 200)
        payload = resp.get_json() or {}
        users = payload.get('users') or []
        self.assertEqual(len(users), 1)
        self.assertTrue(users[0].get('exists'))
        self.assertEqual(users[0].get('user_id'), 77)
        fake_client.find_user_id_by_name.assert_not_called()

    def test_users_check_reuses_team_lookups_for_shared_team(self):
        pid = self._create_project()
        patch_resp = self.client.patch(f'/api/projects/{pid}', json={
            'challenge_url': 'https://ctfd.local',
            'challenge_port': 443,
            'credentials': [
                {'username': 'alice', 'password': 'password1'},
                {'username': 'bob', 'password': 'password2'},
            ],
        })
        self.assertEqual(patch_resp.status_code, 200)

        fake_client = MagicMock()
        fake_client.token = 'token'
        fake_client.logs = []
        fake_client.list_all_users.return_value = [
            {'id': 77, 'name': 'alice', 'email': 'alice@example.com'},
            {'id': 88, 'name': 'bob', 'email': 'bob@example.com'},
        ]

        def get_user_side_effect(user_id):
            if int(user_id) == 77:
                return {'id': 77, 'name': 'alice', 'score': 10, 'team_id': 5}
            if int(user_id) == 88:
                return {'id': 88, 'name': 'bob', 'score': 8, 'team_id': 5}
            return {}

        fake_client.get_user.side_effect = get_user_side_effect
        fake_client.list_user_solves.return_value = []
        fake_client.get_team.return_value = {'id': 5, 'name': 'shared-team', 'score': 18, 'captain_id': 77}
        fake_client.list_team_members.return_value = [
            {'id': 77, 'name': 'alice'},
            {'id': 88, 'name': 'bob'},
        ]
        fake_client.list_team_solves.return_value = []

        with patch('app.routes.api._ctfd_client_from_req', return_value=fake_client):
            resp = self.client.post(
                f'/api/projects/{pid}/ctfd/users_check',
                json={
                    'baseUrl': 'https://ctfd.local',
                    'token': 'token',
                    'verifySSL': False,
                    'only': ['alice', 'bob'],
                },
            )

        self.assertEqual(resp.status_code, 200)
        payload = resp.get_json() or {}
        users = payload.get('users') or []
        self.assertEqual(len(users), 2)
        self.assertEqual(fake_client.get_team.call_count, 1)
        self.assertEqual(fake_client.list_team_members.call_count, 1)
        self.assertEqual(fake_client.list_team_solves.call_count, 1)

    def test_users_check_caches_category_firsts_between_refreshes(self):
        pid = self._create_project()
        patch_resp = self.client.patch(f'/api/projects/{pid}', json={
            'challenge_url': 'https://ctfd.local',
            'challenge_port': 443,
            'credentials': [{'username': 'alice', 'password': 'password1'}],
        })
        self.assertEqual(patch_resp.status_code, 200)

        fake_client = MagicMock()
        fake_client.token = 'token'
        fake_client.base_url = 'https://ctfd.local'
        fake_client.verify_ssl = False
        fake_client.logs = []
        fake_client.list_all_users.return_value = [
            {'id': 77, 'name': 'alice', 'email': 'alice@example.com'}
        ]
        fake_client.get_user.return_value = {'id': 77, 'name': 'alice', 'score': 10}
        fake_client.list_user_solves.return_value = []
        fake_client.list_challenges_all.return_value = [
            {'id': 1, 'name': 'Web 100', 'category': 'Web'}
        ]
        fake_client.list_challenge_solves.return_value = []

        with patch('app.routes.api._ctfd_client_from_req', return_value=fake_client):
            first = self.client.post(
                f'/api/projects/{pid}/ctfd/users_check',
                json={
                    'baseUrl': 'https://ctfd.local',
                    'token': 'token',
                    'verifySSL': False,
                },
            )
            second = self.client.post(
                f'/api/projects/{pid}/ctfd/users_check',
                json={
                    'baseUrl': 'https://ctfd.local',
                    'token': 'token',
                    'verifySSL': False,
                },
            )

        self.assertEqual(first.status_code, 200)
        self.assertEqual(second.status_code, 200)
        first_payload = first.get_json() or {}
        second_payload = second.get_json() or {}
        self.assertIn('category_firsts', first_payload)
        self.assertIn('category_firsts', second_payload)
        self.assertEqual(fake_client.list_challenges_all.call_count, 1)
        self.assertEqual(fake_client.list_challenge_solves.call_count, 1)

    def test_users_check_uses_scoreboard_fallback_when_user_fields_hidden(self):
        pid = self._create_project()
        patch_resp = self.client.patch(f'/api/projects/{pid}', json={
            'challenge_url': 'https://ctfd.local',
            'challenge_port': 443,
            'credentials': [{'username': 'alice', 'password': 'password1'}],
        })
        self.assertEqual(patch_resp.status_code, 200)

        fake_client = MagicMock()
        fake_client.token = 'token'
        fake_client.logs = []
        fake_client.list_all_users.return_value = [
            {'id': 77, 'name': 'alice', 'email': 'alice@example.com'}
        ]
        fake_client.get_user.return_value = {'id': 77, 'name': 'alice'}
        fake_client.list_user_solves.return_value = []
        fake_client.list_scoreboard.return_value = [
            {'account_id': 77, 'pos': 3, 'score': 42, 'name': 'alice'}
        ]

        with patch('app.routes.api._ctfd_client_from_req', return_value=fake_client):
            resp = self.client.post(
                f'/api/projects/{pid}/ctfd/users_check',
                json={
                    'baseUrl': 'https://ctfd.local',
                    'token': 'token',
                    'verifySSL': False,
                    'only': ['alice'],
                },
            )

        self.assertEqual(resp.status_code, 200)
        payload = resp.get_json() or {}
        users = payload.get('users') or []
        self.assertEqual(len(users), 1)
        self.assertEqual(users[0].get('user_rank'), 3)
        self.assertEqual(users[0].get('user_points'), 42.0)
        fake_client.list_scoreboard.assert_called_once()

    def test_users_check_uses_team_scoreboard_fallback_when_team_fields_hidden(self):
        pid = self._create_project()
        patch_resp = self.client.patch(f'/api/projects/{pid}', json={
            'challenge_url': 'https://ctfd.local',
            'challenge_port': 443,
            'credentials': [{'username': 'alice', 'password': 'password1'}],
        })
        self.assertEqual(patch_resp.status_code, 200)

        fake_client = MagicMock()
        fake_client.token = 'token'
        fake_client.logs = []
        fake_client.list_all_users.return_value = [
            {'id': 77, 'name': 'alice', 'email': 'alice@example.com'}
        ]
        fake_client.get_user.return_value = {'id': 77, 'name': 'alice', 'team_id': 5}
        fake_client.list_user_solves.return_value = []
        fake_client.get_team.return_value = {'id': 5, 'captain_id': 77}
        fake_client.list_team_members.return_value = [
            {'id': 77, 'name': 'alice'}
        ]
        fake_client.list_team_solves.return_value = []
        fake_client.list_scoreboard.return_value = [
            {
                'account_id': 5,
                'pos': 1,
                'score': 125,
                'name': 'blue-team',
                'members': [
                    {'id': 77, 'name': 'alice', 'score': 40}
                ],
            }
        ]

        with patch('app.routes.api._ctfd_client_from_req', return_value=fake_client):
            resp = self.client.post(
                f'/api/projects/{pid}/ctfd/users_check',
                json={
                    'baseUrl': 'https://ctfd.local',
                    'token': 'token',
                    'verifySSL': False,
                    'only': ['alice'],
                },
            )

        self.assertEqual(resp.status_code, 200)
        payload = resp.get_json() or {}
        users = payload.get('users') or []
        self.assertEqual(len(users), 1)
        self.assertEqual(users[0].get('team_id'), 5)
        self.assertEqual(users[0].get('team_name'), 'blue-team')
        self.assertEqual(users[0].get('team_rank'), 1)
        self.assertEqual(users[0].get('team_points'), 125.0)
        self.assertEqual(users[0].get('user_points'), 40.0)
        fake_client.list_scoreboard.assert_called_once()

    def test_users_check_preserves_bulk_match_when_user_id_is_unavailable(self):
        pid = self._create_project()
        patch_resp = self.client.patch(f'/api/projects/{pid}', json={
            'challenge_url': 'https://ctfd.local',
            'challenge_port': 443,
            'credentials': [{'username': 'alice@example.com', 'password': 'password1'}],
        })
        self.assertEqual(patch_resp.status_code, 200)

        fake_client = MagicMock()
        fake_client.token = 'token'
        fake_client.logs = []
        fake_client.list_all_users.return_value = [
            {'name': 'alice', 'email': 'alice@example.com'}
        ]
        fake_client.find_user_id_by_name.return_value = None

        with patch('app.routes.api._ctfd_client_from_req', return_value=fake_client):
            resp = self.client.post(
                f'/api/projects/{pid}/ctfd/users_check',
                json={
                    'baseUrl': 'https://ctfd.local',
                    'token': 'token',
                    'verifySSL': False,
                    'only': ['alice@example.com'],
                },
            )

        self.assertEqual(resp.status_code, 200)
        payload = resp.get_json() or {}
        users = payload.get('users') or []
        self.assertEqual(len(users), 1)
        self.assertTrue(users[0].get('exists'))
        self.assertIsNone(users[0].get('user_id'))


if __name__ == '__main__':
    unittest.main()