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
        self.assertIn('token or username/password', (response.get_json() or {}).get('error', ''))

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


if __name__ == '__main__':
    unittest.main()
