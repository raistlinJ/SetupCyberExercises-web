import unittest
from contextlib import ExitStack
from unittest.mock import MagicMock, patch

from app import create_app
from app.storage.projects import Project, VMConfig


class _StoreStub:
    def __init__(self, project: Project):
        self._project = project

    def get(self, pid: str):
        if pid == self._project.id:
            return self._project
        return None


class UsersCredsSetApiTests(unittest.TestCase):

    def setUp(self):
        self.app = create_app()
        self.app.config['TESTING'] = True
        self.client = self.app.test_client()
        self.project = Project(id='proj-creds-set', name='Creds Set Project')
        self.project.instances = 1
        self.project.tag = '-set-'
        self.project.proxmox_url = 'https://proxmox.local'
        self.project.credentials = [{'username': 'alice', 'password': 'password1'}]
        self.project.vms = [VMConfig(name='web', viewable_to_user=False)]
        self.project.proxmox_assign_rollback_on_non_viewable = True

    def _common_patches(self):
        mapped = [{'index': 1, 'name': f'web{self.project.tag}1', 'vmid': 101, 'node': 'node1'}]
        return [
            patch('app.routes.api._store', return_value=_StoreStub(self.project)),
            patch('app.routes.api._resolve_targets_to_vm_info', return_value=(mapped, [], [])),
            patch('app.routes.api._start_job'),
            patch('app.routes.api._end_job'),
            patch('app.routes.api._vm_is_in_project_notes', return_value=True),
        ]

    def test_users_creds_set_updates_existing_user_and_repairs_access(self):
        with ExitStack() as stack:
            for ctx in self._common_patches():
                stack.enter_context(ctx)
            mock_client_cls = stack.enter_context(patch('app.routes.api.ProxmoxClient'))
            reconcile_mock = stack.enter_context(patch('app.routes.api._reconcile_vm_access_roles'))
            mock_client = MagicMock()
            mock_client_cls.return_value = mock_client
            mock_client.get_user.return_value = {'userid': 'alice@pve'}
            mock_client.get_pool.return_value = {'poolid': 'alice'}
            mock_client.list_nodes.return_value = [{'node': 'node1'}]
            mock_client.list_qemu_vms.return_value = [{'vmid': 101, 'name': 'web-set-1'}]
            reconcile_mock.return_value = {'granted': 'AcostaRollback', 'removed': ['PVEUser'], 'current_roles': {'AcostaRollback'}}

            resp = self.client.post(
                f'/api/projects/{self.project.id}/instances/actions/users_creds_set',
                json={
                    'targets': [{'index': 1, 'name': 'web-set-1'}],
                    'username': 'root@pam',
                    'password': 'secret',
                    'baseUrl': 'https://proxmox.local',
                    'verifySSL': False,
                },
            )

            self.assertEqual(resp.status_code, 200)
            mock_client.update_user.assert_called_once_with('alice@pve', password='password1', enable=True)
            mock_client.create_user.assert_not_called()
            mock_client.set_acl_user_pool.assert_called_once_with('alice@pve', 'alice', roles='AcostaPowerRollback', propagate=True)
            mock_client.add_pool_member.assert_called_once_with('alice', 101)
            reconcile_mock.assert_called_once()
            self.assertFalse(reconcile_mock.call_args.kwargs.get('accessible'))
            self.assertTrue(reconcile_mock.call_args.kwargs.get('rollback_enabled'))
            body = resp.get_json() or {}
            self.assertEqual(len(body.get('updated_users') or []), 1)
            self.assertEqual(body.get('created_users') or [], [])

    def test_users_creds_set_creates_missing_user_and_pool(self):
        with ExitStack() as stack:
            for ctx in self._common_patches():
                stack.enter_context(ctx)
            mock_client_cls = stack.enter_context(patch('app.routes.api.ProxmoxClient'))
            reconcile_mock = stack.enter_context(patch('app.routes.api._reconcile_vm_access_roles'))
            mock_client = MagicMock()
            mock_client_cls.return_value = mock_client
            mock_client.get_user.return_value = None
            mock_client.get_pool.return_value = None
            mock_client.list_nodes.return_value = [{'node': 'node1'}]
            mock_client.list_qemu_vms.return_value = [{'vmid': 101, 'name': 'web-set-1'}]
            reconcile_mock.return_value = {'granted': 'AcostaRollback', 'removed': ['PVEUser'], 'current_roles': {'AcostaRollback'}}

            resp = self.client.post(
                f'/api/projects/{self.project.id}/instances/actions/users_creds_set',
                json={
                    'targets': [{'index': 1, 'name': 'web-set-1'}],
                    'username': 'root@pam',
                    'password': 'secret',
                    'baseUrl': 'https://proxmox.local',
                    'verifySSL': False,
                },
            )

            self.assertEqual(resp.status_code, 200)
            mock_client.create_user.assert_called_once_with(
                'alice@pve',
                password='password1',
                enable=True,
                comment='Synced from project credentials for instance 1',
            )
            mock_client.update_user.assert_not_called()
            mock_client.create_pool.assert_called_once_with('alice', comment='Synced from project credentials for alice@pve')
            mock_client.add_pool_member.assert_called_once_with('alice', 101)
            reconcile_mock.assert_called_once()
            body = resp.get_json() or {}
            self.assertEqual(len(body.get('created_users') or []), 1)
            self.assertEqual(len(body.get('created_pools') or []), 1)


if __name__ == '__main__':
    unittest.main()