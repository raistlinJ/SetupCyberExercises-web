import os
import tempfile
import unittest
from unittest.mock import patch

from app import create_app
from app.connectors.ctfrpg import CTFRPGClient, CTFRPGError


class CtfrpgManagerApiTests(unittest.TestCase):
    def setUp(self):
        os.environ['AUTH_ENABLE'] = '0'
        self.tmp = tempfile.TemporaryDirectory()
        self.app = create_app()
        self.app.config.update(TESTING=True, DATA_DIR=self.tmp.name)
        self.client = self.app.test_client()
        response = self.client.post('/api/projects', json={'name': 'Quest', 'credentials': [
            {'username': 'alice', 'password': 'password-one'},
            {'username': 'bob', 'password': 'password-two'},
        ]})
        self.assertEqual(response.status_code, 201)
        self.pid = response.get_json()['id']
        self.base = f'/api/projects/{self.pid}'

    def tearDown(self):
        self.tmp.cleanup()
        os.environ.pop('AUTH_ENABLE', None)

    def test_connection_settings_and_credentials_are_separate_from_ctfd(self):
        response = self.client.patch(self.base, json={'ctfrpg_url': 'https://quest.example', 'ctfrpg_verify_ssl': False})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()['ctfrpg_url'], 'https://quest.example')
        response = self.client.patch(self.base + '/secrets', json={'ctfrpg': {'username': 'rpg-admin', 'password': 'rpg-secret'}})
        self.assertTrue(response.get_json()['ctfrpg_saved'])
        response = self.client.get(self.base + '/secrets').get_json()
        self.assertEqual(response['ctfrpg']['username'], 'rpg-admin')
        self.assertEqual(response['ctfrpg']['password'], 'rpg-secret')
        self.assertNotIn('token', response['ctfrpg'])
        self.assertEqual(response['ctfd']['token'], '')
        project = self.client.get('/api/projects').get_json()['projects'][0]
        self.assertNotIn('rpg-secret', str(project))
        with open(os.path.join(self.tmp.name, 'user_secrets.json'), encoding='utf-8') as stored:
            self.assertNotIn('rpg-secret', stored.read())

    def test_check_merges_credential_users_and_team_scores(self):
        with patch('app.routes.api._ctfrpg_client_from_req') as factory:
            remote = factory.return_value
            remote.users.return_value = {'users': [{'username': 'alice', 'role': 'student', 'hero': 'web', 'team': 'Blue', 'score': 25, 'completed': 2}]}
            remote.scoreboard.return_value = {'users': [{'username': 'alice', 'rank': 1}], 'teams': [{'username': 'Blue', 'score': 25, 'rank': 1}]}
            response = self.client.post(self.base + '/ctfrpg/users_check', json={})
        self.assertEqual(response.status_code, 200)
        result = response.get_json()
        self.assertEqual([(u['username'], u['exists']) for u in result['users']], [('alice', True), ('bob', False)])
        self.assertEqual(result['users'][0]['rank'], 1)
        self.assertEqual(result['teams'][0]['username'], 'Blue')

    def test_create_and_delete_limit_actions_to_selected_credentials(self):
        with patch('app.routes.api._ctfrpg_client_from_req') as factory:
            remote = factory.return_value
            remote.me.return_value = {'characters': [{'id': 'web'}]}
            remote.put_user.return_value = {'action': 'created'}
            response = self.client.post(self.base + '/ctfrpg/users_create', json={'only': ['alice'], 'hero': 'web'})
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.get_json()['created'], 1)
            remote.put_user.assert_called_once_with('alice', 'password-one', 'web')
            remote.delete_user.side_effect = CTFRPGError(404, 'User not found')
            response = self.client.post(self.base + '/ctfrpg/users_delete', json={'only': ['bob']})
            self.assertEqual(response.get_json()['results'], [{'username': 'bob', 'action': 'missing'}])
            remote.delete_user.assert_called_once_with('bob')

    def test_empty_selection_does_not_contact_ctfrpg(self):
        with patch('app.routes.api._ctfrpg_client_from_req') as factory:
            created = self.client.post(self.base + '/ctfrpg/users_create', json={'only': []})
            deleted = self.client.post(self.base + '/ctfrpg/users_delete', json={'only': []})
            checked = self.client.post(self.base + '/ctfrpg/users_check', json={'only': []})
        self.assertEqual(created.get_json()['results'], [])
        self.assertEqual(deleted.get_json()['results'], [])
        self.assertEqual(checked.get_json()['users'], [])
        factory.assert_not_called()

    def test_browser_notification_settings_use_project_audio_store(self):
        entry = {
            'enabled': True, 'soundKey': 'media:bell', 'speak': True,
            'speakTemplates': ['{{user}} scored in {{project}}.'],
        }
        response = self.client.patch(self.base + '/audio', json={'audio': {'ctfrpgFirstScore': entry}})
        self.assertEqual(response.status_code, 200)
        saved = self.client.get(self.base + '/audio?prefix=ctfrpg&meta=1').get_json()['audio']
        self.assertEqual(saved['ctfrpgFirstScore'], entry)

    def test_saved_credentials_are_used_for_login_without_sending_them_again(self):
        self.client.patch(self.base, json={'ctfrpg_url': 'https://quest.example'})
        self.client.patch(self.base + '/secrets', json={'ctfrpg': {'username': 'rpg-admin', 'password': 'rpg-secret'}})
        with patch('app.routes.api.CTFRPGClient') as factory:
            factory.return_value.me.return_value = {'user': {'username': 'rpg-admin'}, 'characters': []}
            response = self.client.post(self.base + '/ctfrpg/login', json={})
        self.assertEqual(response.status_code, 200)
        factory.assert_called_once_with('https://quest.example', 'rpg-admin', 'rpg-secret', verify_ssl=True)

    def test_incorrect_password_is_rejected(self):
        with patch('app.routes.api._ctfrpg_client_from_req', side_effect=CTFRPGError(401, 'Invalid credentials')):
            response = self.client.post(self.base + '/ctfrpg/login', json={})
        self.assertEqual(response.status_code, 401)
        self.assertIn('Invalid credentials', response.get_json()['error'])

    def test_legacy_token_cannot_authenticate_and_saved_password_stays_on_project_url(self):
        self.client.patch(self.base, json={'ctfrpg_url': 'https://quest.example'})
        response = self.client.post(self.base + '/ctfrpg/login', json={'token': 'old-token'})
        self.assertEqual(response.status_code, 400)
        self.client.patch(self.base + '/secrets', json={'ctfrpg': {'username': 'rpg-admin', 'password': 'rpg-secret'}})
        response = self.client.post(self.base + '/ctfrpg/login', json={'baseUrl': 'https://other.example'})
        self.assertEqual(response.status_code, 400)
        self.assertIn('different URL', response.get_json()['error'])


class CtfrpgConnectorTests(unittest.TestCase):
    def test_logs_in_with_credentials_and_uses_admin_session_endpoints(self):
        client = CTFRPGClient('https://quest.example/', 'rpg-admin', 'rpg-secret', verify_ssl=False)
        class Response:
            ok = True
            status_code = 200
            def __init__(self, data):
                self.data = data
            def json(self):
                return self.data
        replies = [
            Response({'user': {'username': 'rpg-admin', 'role': 'admin'}, 'admin': True}),
            Response({'users': [], 'characters': [{'id': 'web'}]}),
            Response({'users': [{'username': 'alice', 'revision': 1}], 'characters': [{'id': 'web'}]}),
        ]
        with patch.object(client.session, 'request', side_effect=replies) as request:
            result = client.put_user('alice', 'password-one', 'web')
        self.assertEqual(result['action'], 'created')
        self.assertEqual([call.args[:2] for call in request.call_args_list], [
            ('POST', 'https://quest.example/api/auth'),
            ('GET', 'https://quest.example/api/admin/users'),
            ('POST', 'https://quest.example/api/admin/users'),
        ])
        self.assertEqual(request.call_args_list[0].kwargs['json'], {
            'mode': 'login', 'username': 'rpg-admin', 'password': 'rpg-secret',
        })
        self.assertEqual(request.call_args_list[2].kwargs['json']['username'], 'alice')
        self.assertEqual(request.call_args_list[2].kwargs['headers']['Origin'], 'https://quest.example')
        self.assertFalse(request.call_args_list[2].kwargs['verify'])
        self.assertNotIn('Authorization', request.call_args_list[2].kwargs['headers'])

    def test_non_admin_login_is_rejected(self):
        client = CTFRPGClient('https://quest.example', 'student', 'student-password')
        with patch.object(client, '_request', return_value={'user': {'username': 'student'}, 'admin': False}):
            with self.assertRaises(CTFRPGError) as raised:
                client.me()
        self.assertEqual(raised.exception.status_code, 403)

    def test_existing_user_uses_revision_and_delete_bulk_action(self):
        client = CTFRPGClient('https://quest.example', 'rpg-admin', 'rpg-secret')
        client._user = {'username': 'rpg-admin'}
        account = {'username': 'alice', 'role': 'student', 'hero': 'web', 'revision': 4, 'disabled': False}
        with patch.object(client, '_request', side_effect=[
            {'users': [account], 'characters': [{'id': 'web'}]},
            {'users': [{**account, 'revision': 5}]},
            {'users': [{**account, 'revision': 5}], 'characters': [{'id': 'web'}]},
            {'users': []},
        ]) as request:
            self.assertEqual(client.put_user('alice', 'new-password')['action'], 'updated')
            self.assertEqual(client.delete_user('alice')['action'], 'deleted')
        self.assertEqual(request.call_args_list[1].kwargs['json']['revision'], 4)
        self.assertEqual(request.call_args_list[1].kwargs['json']['editing'], True)
        self.assertEqual(request.call_args_list[3].kwargs['json'], {
            'action': 'delete', 'users': [{'username': 'alice', 'revision': 5}],
        })


if __name__ == '__main__':
    unittest.main()
