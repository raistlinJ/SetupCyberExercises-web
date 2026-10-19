import os
import unittest
from unittest.mock import Mock, patch

from app import create_app
from app.storage.projects import Project


class _StoreStub:
    def __init__(self, project):
        self.project = project

    def get(self, pid):
        return self.project if pid == self.project.id else None


class CtfdCredentialsApiTests(unittest.TestCase):
    def setUp(self):
        os.environ['AUTH_ENABLE'] = '0'
        self.app = create_app()
        self.app.config.update(TESTING=True)
        self.client = self.app.test_client()
        self.project = Project(
            id='ctfd-creds',
            name='CTFd Credentials',
            challenge_url='https://ctfd.example.test',
            challenge_port=443,
        )

    def tearDown(self):
        os.environ.pop('AUTH_ENABLE', None)

    def test_project_login_accepts_username_and_password(self):
        client = Mock()
        client.token = ''
        client.session = object()
        client.logs = []
        client.login_with_credentials.return_value = (True, 'ok')
        client.get_current_user.return_value = {'id': 7, 'name': 'admin'}
        client.get_role.return_value = 'admin'

        with patch('app.routes.api._store', return_value=_StoreStub(self.project)), \
             patch('app.routes.api.CTFdClient', return_value=client) as client_cls:
            response = self.client.post(
                f'/api/projects/{self.project.id}/ctfd/login',
                json={'username': 'admin', 'password': 'secret', 'verifySSL': False},
            )

        self.assertEqual(response.status_code, 200)
        body = response.get_json() or {}
        self.assertTrue(body.get('ok'))
        self.assertFalse(body.get('using_token'))
        self.assertEqual(body.get('me', {}).get('name'), 'admin')
        client_cls.assert_called_once_with(
            base_url='https://ctfd.example.test', token='', verify_ssl=False
        )
        client.login_with_credentials.assert_called_once_with('admin', 'secret')

    def test_project_login_requires_a_complete_auth_method(self):
        with patch('app.routes.api._store', return_value=_StoreStub(self.project)):
            response = self.client.post(
                f'/api/projects/{self.project.id}/ctfd/login',
                json={'username': 'admin'},
            )

        self.assertEqual(response.status_code, 400)
        self.assertIn('username and password', (response.get_json() or {}).get('error', ''))

    def test_project_login_rejects_token_only_credentials(self):
        with patch('app.routes.api._store', return_value=_StoreStub(self.project)), \
             patch('app.routes.api.CTFdClient') as client_cls:
            response = self.client.post(
                f'/api/projects/{self.project.id}/ctfd/login',
                json={'token': 'legacy-token'},
            )
        self.assertEqual(response.status_code, 400)
        client_cls.assert_not_called()

    def test_project_login_uses_saved_username_and_password(self):
        client = Mock()
        client.session = object()
        client.logs = []
        client.login_with_credentials.return_value = (True, 'ok')
        client.get_current_user.return_value = {'name': 'admin'}
        client.get_role.return_value = 'admin'
        secrets = Mock()
        secrets.get_enc.return_value = {
            'ctfd_username_enc': 'admin', 'ctfd_password_enc': 'secret',
            'ctfd_token_enc': 'legacy-token',
        }
        with patch('app.routes.api._store', return_value=_StoreStub(self.project)), \
             patch('app.routes.api._user_secrets_store', return_value=secrets), \
             patch('app.routes.api._effective_secrets_username', return_value='admin'), \
             patch('app.routes.api._dec_secret', side_effect=lambda _key, value: value), \
             patch('app.routes.api.CTFdClient', return_value=client) as client_cls:
            response = self.client.post(f'/api/projects/{self.project.id}/ctfd/login', json={})
        self.assertEqual(response.status_code, 200, response.get_json())
        client_cls.assert_called_once_with(
            base_url='https://ctfd.example.test', token='', verify_ssl=True
        )
        client.login_with_credentials.assert_called_once_with('admin', 'secret')

    def test_create_users_reports_that_stock_ctfd_requires_admin(self):
        self.project.credentials = [{'username': 'student', 'password': 'student-password'}]
        client = Mock()
        client.token = ''
        client.session = object()
        client.logs = []
        client.login_with_credentials.return_value = (True, 'ok')
        client.get_role.return_value = 'teacher'

        with patch('app.routes.api._store', return_value=_StoreStub(self.project)), \
             patch('app.routes.api.CTFdClient', return_value=client):
            response = self.client.post(
                f'/api/projects/{self.project.id}/ctfd/users_create',
                json={'username': 'teacher', 'password': 'secret'},
            )

        self.assertEqual(response.status_code, 403)
        self.assertIn('admin account is required', (response.get_json() or {}).get('error', ''))

    def test_empty_user_selection_does_not_contact_ctfd(self):
        self.project.credentials = [{'username': 'student', 'password': 'student-password'}]
        with patch('app.routes.api._store', return_value=_StoreStub(self.project)), \
             patch('app.routes.api._ctfd_client_from_req') as factory:
            created = self.client.post(f'/api/projects/{self.project.id}/ctfd/users_create', json={'only': []})
            deleted = self.client.post(f'/api/projects/{self.project.id}/ctfd/users_delete', json={'only': []})
            checked = self.client.post(f'/api/projects/{self.project.id}/ctfd/users_check', json={'only': []})
        self.assertEqual(created.get_json()['results'], [])
        self.assertEqual(deleted.get_json()['results'], [])
        self.assertEqual(checked.get_json()['users'], [])
        factory.assert_not_called()

    def test_invalid_user_selection_is_rejected(self):
        self.project.credentials = [{'username': 'student', 'password': 'student-password'}]
        with patch('app.routes.api._store', return_value=_StoreStub(self.project)):
            for action in ('users_create', 'users_delete', 'users_check'):
                response = self.client.post(f'/api/projects/{self.project.id}/ctfd/{action}', json={'only': 'student'})
                self.assertEqual(response.status_code, 400)


if __name__ == '__main__':
    unittest.main()
