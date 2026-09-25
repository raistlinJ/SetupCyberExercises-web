import unittest
from contextlib import ExitStack
from unittest.mock import MagicMock, patch

from app import create_app
from app.storage.projects import Project, VMConfig
from test_users_access_sync_api import _StoreStub


class OrchestrationAccessTests(unittest.TestCase):
    def setUp(self):
        self.app = create_app()
        self.app.config.update(TESTING=True, AUTH_ENABLE=True, API_KEY=None)
        self.app.current_user = lambda: {'username': 'admin', 'roles': ['admin']}
        self.web = self.app.test_client()
        self.project = Project(id='orchestration-test', name='Lab')
        self.project.instances = 2
        self.project.tag = '-set-'
        self.project.vms = [VMConfig(name='app'), VMConfig(name='participant')]
        self.project.credentials = [{'username': 'alice', 'password': 'participant-secret'}, {'username': 'bob@pve'}]
        self.project.proxmox_url = 'https://pve.lab'
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.stack.enter_context(patch('app.routes.api._store', return_value=_StoreStub(self.project)))
        self.stack.enter_context(patch('app.routes.api._start_job'))
        self.end = self.stack.enter_context(patch('app.routes.api._end_job'))
        self.stack.enter_context(patch('app.routes.api._is_cancelled', return_value=False))
        self.stack.enter_context(patch('app.routes.api._job_items', side_effect=lambda pid, items, *args, **kwargs: iter(items)))
        self.factory = self.stack.enter_context(patch('app.routes.api.ProxmoxClient'))
        self.client = self.factory.return_value
        self.client.list_acls.return_value = []
        self.client.get_user.return_value = {'groups': ['students']}
        self.client.set_user_group.return_value = True
        self.body = {'confirmed': True, 'targets': [{'index': 1, 'name': 'app-set-1'}, {'index': 1, 'name': 'participant-set-1'}],
                     'expectedUsers': {'1': 'alice@pve'}, 'username': 'root@pam', 'password': 'host-secret'}

    def post(self, enable=True, body=None):
        action = 'enable' if enable else 'disable'
        return self.web.post(f'/api/projects/{self.project.id}/instances/actions/users_orchestration_{action}',
                             json=self.body if body is None else body)

    def test_enable_deduplicates_selected_users_and_only_enrolls(self):
        result = self.post()
        self.assertEqual(result.status_code, 200)
        self.client.ensure_group.assert_called_once()
        self.client.set_user_group.assert_called_once_with('alice@pve', 'caf-orchestrator', enabled=True)
        for name in ('create_user', 'update_user', 'set_acl', 'set_acl_user_vm', 'set_acl_user_pool', 'create_role'):
            getattr(self.client, name).assert_not_called()
        self.assertEqual(result.json['updated_users'][0]['indices'], [1])
        self.assertNotIn('secret', result.text)
        self.end.assert_called_once_with(self.project.id, status='completed')

    def test_disable_is_user_wide_and_does_not_create_group(self):
        result = self.post(False)
        self.assertEqual(result.status_code, 200)
        self.client.set_user_group.assert_called_once_with('alice@pve', 'caf-orchestrator', enabled=False)
        self.client.ensure_group.assert_not_called()
        self.client.delete_user.assert_not_called()
        self.client.delete_pool.assert_not_called()

    def test_no_confirmation_no_mutations(self):
        for value in (False, 'true', 1, None):
            with self.subTest(value=value):
                self.assertEqual(self.post(body=dict(self.body, confirmed=value)).status_code, 400)
        self.factory.assert_not_called()

    def test_anonymous_and_non_admin_cannot_enroll_or_revoke(self):
        for actor, code in [(None, 401), ({'username': 'learner', 'roles': []}, 403)]:
            self.app.current_user = lambda: actor
            for enable in (True, False):
                self.assertEqual(self.post(enable).status_code, code)
        self.factory.assert_not_called()

    def test_stale_confirmed_identity_is_rejected(self):
        self.project.credentials[0]['username'] = 'different-user'
        self.assertEqual(self.post().status_code, 409)
        self.factory.assert_not_called()

    def test_invalid_rows_and_extraneous_confirmed_users_rejected(self):
        for targets in ([], [{'index': 3, 'name': 'app-set-3'}], [{'index': True, 'name': 'app'}],
                        [{'index': 1, 'name': 'outside-project'}]):
            with self.subTest(targets=targets):
                self.assertEqual(self.post(body=dict(self.body, targets=targets)).status_code, 400)
        self.assertEqual(self.post(body=dict(self.body, expectedUsers={'1': 'alice@pve', '2': 'bob@pve'})).status_code, 400)
        self.factory.assert_not_called()

    def test_missing_user_prevents_enrollment_without_creating_accounts(self):
        self.client.get_user.return_value = None
        self.assertEqual(self.post().status_code, 409)
        self.client.ensure_group.assert_not_called()
        self.client.set_user_group.assert_not_called()
        self.client.create_user.assert_not_called()

    def test_group_with_native_pve_acl_is_not_reused(self):
        self.client.list_acls.return_value = [{'type': 'group', 'ugid': 'caf-orchestrator', 'roleid': 'Administrator', 'path': '/'}]
        self.assertEqual(self.post().status_code, 409)
        self.client.ensure_group.assert_not_called()
        self.client.set_user_group.assert_not_called()
        # Removing enrollment must remain possible even with an unsafe group.
        self.assertEqual(self.post(False).status_code, 200)

    def test_partial_failure_is_reported_without_secrets(self):
        self.body.update(targets=[{'index': 1, 'name': 'app-set-1'}, {'index': 2, 'name': 'app-set-2'}],
                         expectedUsers={'1': 'alice@pve', '2': 'bob@pve'})
        self.client.set_user_group.side_effect = [True, RuntimeError('PRIVATE PASSWORD host-secret')]
        result = self.post()
        self.assertEqual(result.status_code, 200)
        self.assertEqual(len(result.json['updated_users']), 1)
        self.assertEqual(len(result.json['errors']), 1)
        self.assertNotIn('host-secret', result.text)
        self.end.assert_called_once_with(self.project.id, status='error')

    def test_repeated_operation_reports_unchanged(self):
        self.client.set_user_group.return_value = False
        result = self.post()
        self.assertEqual(result.json['updated_users'], [])
        self.assertEqual(len(result.json['skipped']), 1)

    def test_connection_failure_does_not_enroll(self):
        self.client.list_acls.side_effect = RuntimeError('PRIVATE TOKEN')
        result = self.post()
        self.assertEqual(result.status_code, 502)
        self.client.set_user_group.assert_not_called()
        self.assertNotIn('PRIVATE', result.text)

    def test_cancellation_stops_before_the_next_user(self):
        self.body.update(targets=[{'index': 1, 'name': 'app-set-1'}, {'index': 2, 'name': 'app-set-2'}],
                         expectedUsers={'1': 'alice@pve', '2': 'bob@pve'})
        with patch('app.routes.api._is_cancelled', side_effect=[False, False, True, True, True]):
            result = self.post()
        self.assertEqual(result.status_code, 200)
        self.assertTrue(result.json['cancelled'])
        self.client.set_user_group.assert_called_once_with('alice@pve', 'caf-orchestrator', enabled=True)
        self.end.assert_called_once_with(self.project.id, status='cancelled')

    def test_explicit_admin_credentials_take_precedence_over_saved_token(self):
        self.project.proxmox_api_token = 'existing-token'
        self.post()
        self.assertIsNone(self.factory.call_args.kwargs['token'])
