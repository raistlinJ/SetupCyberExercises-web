import os
import tempfile
import unittest
from contextlib import ExitStack
from unittest.mock import patch

from app import create_app
from app.storage.projects import Project


class _StoreStub:
    def __init__(self, project: Project):
        self._project = project
        self.upsert_calls = 0

    def get(self, pid: str):
        if pid == self._project.id:
            return self._project
        return None

    def upsert(self, project: Project):
        self._project = project
        self.upsert_calls += 1

    def list(self):
        return [self._project]


class ProjectSecretsApiTests(unittest.TestCase):

    def setUp(self):
        # Disable auth so tests don't need to establish a session.
        os.environ['AUTH_ENABLE'] = '0'
        self.app = create_app()
        self.app.config['TESTING'] = True
        self.app.config['SECRET_KEY'] = 'unit-test-secret-key'
        self._tmpdir = tempfile.TemporaryDirectory()
        self.app.config['DATA_DIR'] = self._tmpdir.name
        self.client = self.app.test_client()

        self.project = Project(id='proj-secrets', name='Secrets Project')
        self.store = _StoreStub(self.project)

    def tearDown(self):
        os.environ.pop('AUTH_ENABLE', None)
        try:
            self._tmpdir.cleanup()
        except Exception:
            pass

    def test_set_and_get_project_secrets_roundtrip(self):
        with ExitStack() as stack:
            stack.enter_context(patch('app.routes.api._store', return_value=self.store))
            stack.enter_context(patch('app.routes.api._acting_username', return_value='alice'))

            resp = self.client.patch(
                f'/api/projects/{self.project.id}/secrets',
                json={
                    'proxmox': {'username': 'root@pam', 'password': 'pw123'},
                    'ctfd': {'token': 'ctfdtoken'},
                },
            )
            self.assertEqual(resp.status_code, 200)
            body = resp.get_json() or {}
            self.assertTrue(body.get('ok'))
            self.assertTrue(body.get('proxmox_saved'))
            self.assertTrue(body.get('ctfd_saved'))

            # GET returns decrypted values.
            resp2 = self.client.get(f'/api/projects/{self.project.id}/secrets')
            self.assertEqual(resp2.status_code, 200)
            got = resp2.get_json() or {}
            self.assertEqual(got.get('projectId'), self.project.id)
            self.assertEqual(got.get('proxmox', {}).get('username'), 'root@pam')
            self.assertEqual(got.get('proxmox', {}).get('password'), 'pw123')
            self.assertEqual(got.get('ctfd', {}).get('token'), 'ctfdtoken')
            self.assertTrue(got.get('proxmox', {}).get('saved'))
            self.assertTrue(got.get('ctfd', {}).get('saved'))

            # Different user should not see alice's secrets
            with ExitStack() as stack2:
                stack2.enter_context(patch('app.routes.api._store', return_value=self.store))
                stack2.enter_context(patch('app.routes.api._acting_username', return_value='bob'))
                resp3 = self.client.get(f'/api/projects/{self.project.id}/secrets')
                self.assertEqual(resp3.status_code, 200)
                got2 = resp3.get_json() or {}
                self.assertEqual(got2.get('proxmox', {}).get('username'), '')
                self.assertEqual(got2.get('proxmox', {}).get('password'), '')
                self.assertEqual(got2.get('ctfd', {}).get('token'), '')

    def test_clear_project_secrets(self):
        with ExitStack() as stack:
            stack.enter_context(patch('app.routes.api._store', return_value=self.store))
            stack.enter_context(patch('app.routes.api._acting_username', return_value='alice'))

            # Set first
            self.client.patch(
                f'/api/projects/{self.project.id}/secrets',
                json={'proxmox_username': 'root@pam', 'proxmox_password': 'pw123', 'ctfd_token': 'ctfdtoken'},
            )

            # Clear by sending empty strings
            resp = self.client.patch(
                f'/api/projects/{self.project.id}/secrets',
                json={'proxmox': {'username': '', 'password': ''}, 'ctfd': {'token': ''}},
            )
            self.assertEqual(resp.status_code, 200)
            body = resp.get_json() or {}
            self.assertFalse(body.get('proxmox_saved'))
            self.assertFalse(body.get('ctfd_saved'))

            resp2 = self.client.get(f'/api/projects/{self.project.id}/secrets')
            got = resp2.get_json() or {}
            self.assertEqual(got.get('proxmox', {}).get('username'), '')
            self.assertEqual(got.get('proxmox', {}).get('password'), '')
            self.assertEqual(got.get('ctfd', {}).get('token'), '')
            self.assertFalse(got.get('proxmox', {}).get('saved'))
            self.assertFalse(got.get('ctfd', {}).get('saved'))

    def test_list_projects_does_not_expose_secret_fields(self):
        with ExitStack() as stack:
            stack.enter_context(patch('app.routes.api._store', return_value=self.store))
            stack.enter_context(patch('app.routes.api._acting_username', return_value='alice'))

            # Write secrets to the project instance via endpoint
            self.client.patch(
                f'/api/projects/{self.project.id}/secrets',
                json={'proxmox_username': 'root@pam', 'proxmox_password': 'pw123', 'ctfd_token': 'ctfdtoken'},
            )

            resp = self.client.get('/api/projects')
            self.assertEqual(resp.status_code, 200)
            payload = resp.get_json() or {}
            projects = payload.get('projects') or []
            self.assertEqual(len(projects), 1)
            p0 = projects[0]
            self.assertNotIn('proxmox_username_enc', p0)
            self.assertNotIn('proxmox_password_enc', p0)
            self.assertNotIn('ctfd_token_enc', p0)

    def test_non_admin_user_can_manage_own_secrets_when_auth_enabled(self):
        # Enable auth and simulate a logged-in non-admin user via app.current_user()
        self.app.config['AUTH_ENABLE'] = True
        self.app.current_user = lambda: {'username': 'carol', 'roles': ['user']}
        with ExitStack() as stack:
            stack.enter_context(patch('app.routes.api._store', return_value=self.store))

            resp = self.client.patch(
                f'/api/projects/{self.project.id}/secrets',
                json={'ctfd': {'token': 'ctfdtoken-user'}},
            )
            self.assertEqual(resp.status_code, 200)
            body = resp.get_json() or {}
            self.assertTrue(body.get('ok'))
            self.assertTrue(body.get('ctfd_saved'))

            resp2 = self.client.get(f'/api/projects/{self.project.id}/secrets')
            self.assertEqual(resp2.status_code, 200)
            got = resp2.get_json() or {}
            self.assertEqual(got.get('ctfd', {}).get('token'), 'ctfdtoken-user')

            # Another non-admin user should not see carol's secret
            self.app.current_user = lambda: {'username': 'dave', 'roles': ['user']}
            resp3 = self.client.get(f'/api/projects/{self.project.id}/secrets')
            self.assertEqual(resp3.status_code, 200)
            got2 = resp3.get_json() or {}
            self.assertEqual(got2.get('ctfd', {}).get('token'), '')

    def test_anonymous_mode_can_read_existing_project_secret_owner(self):
        with ExitStack() as stack:
            stack.enter_context(patch('app.routes.api._store', return_value=self.store))
            stack.enter_context(patch('app.routes.api._acting_username', return_value='setupadmin'))

            save_resp = self.client.patch(
                f'/api/projects/{self.project.id}/secrets',
                json={'ctfd': {'token': 'ctfdtoken-owner'}},
            )
            self.assertEqual(save_resp.status_code, 200)

        with ExitStack() as stack:
            stack.enter_context(patch('app.routes.api._store', return_value=self.store))
            stack.enter_context(patch('app.routes.api._acting_username', return_value='__anonymous__'))

            resp = self.client.get(f'/api/projects/{self.project.id}/secrets')
            self.assertEqual(resp.status_code, 200)
            body = resp.get_json() or {}
            self.assertEqual(body.get('ctfd', {}).get('token'), 'ctfdtoken-owner')
            self.assertTrue(body.get('ctfd', {}).get('saved'))


if __name__ == '__main__':
    unittest.main()
