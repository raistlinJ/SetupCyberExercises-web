import unittest
from contextlib import ExitStack
from unittest.mock import MagicMock, patch

from app import create_app
from app.storage.projects import Project


class _StoreStub:
    def __init__(self, project: Project):
        self._project = project

    def get(self, pid: str):
        if pid == self._project.id:
            return self._project
        return None


class UsersAccessSyncApiTests(unittest.TestCase):

    def setUp(self):
        self.app = create_app()
        self.app.config['TESTING'] = True
        self.client = self.app.test_client()
        self.project = Project(id='proj-ua-sync', name='UA Sync Project')
        self.project.proxmox_assign_rollback_on_non_viewable = False
        self.project.instances = 2
        self.project.tag = '-set-'
        self.project.proxmox_url = 'https://proxmox.local'
        self.project.credentials = [
            {'username': 'alice', 'password': 'pw1'},
            {'username': 'bob', 'password': 'pw2'},
        ]

    def _common_patches(self, mapped=None):
        mapped = mapped or [{'index': 1, 'name': f"web{self.project.tag}1", 'vmid': 101, 'node': 'node1'}]
        return [
            patch('app.routes.api._store', return_value=_StoreStub(self.project)),
            patch('app.routes.api._resolve_targets_to_vm_info', return_value=(mapped, [], [])),
            patch('app.routes.api._start_job'),
            patch('app.routes.api._end_job'),
        ]

    def test_enable_adds_pveuser_role(self):
        with ExitStack() as stack:
            store_patch, resolve_patch, start_patch, end_patch = self._common_patches()
            stack.enter_context(store_patch)
            resolve_mock = stack.enter_context(resolve_patch)
            stack.enter_context(start_patch)
            stack.enter_context(end_patch)
            mock_client_cls = stack.enter_context(patch('app.routes.api.ProxmoxClient'))
            mock_client = MagicMock()
            mock_client_cls.return_value = mock_client
            mock_client.get_user.return_value = {'userid': 'alice@pve'}
            mock_client.list_acls.return_value = []

            resp = self.client.post(
                f'/api/projects/{self.project.id}/instances/actions/users_access_sync',
                json={
                    'templates': ['web'],
                    'enable': True,
                    'indices': [1],
                    'username': 'root@pam',
                    'password': 'secret',
                    'baseUrl': 'https://proxmox.local',
                    'verifySSL': False,
                },
            )

            self.assertEqual(resp.status_code, 200)
            mock_client.set_acl_user_vm.assert_called_once()
            _, kwargs = mock_client.set_acl_user_vm.call_args
            self.assertEqual(kwargs.get('roles'), 'PVEUser')

            # Ensure we only targeted the selected row
            resolve_mock.assert_called_once()
            resolve_call = resolve_mock.call_args
            sent_targets = resolve_call.args[2]
            self.assertEqual(sent_targets, [{'index': 1, 'name': f"web{self.project.tag}1"}])

    def test_disable_removes_pveuser_and_legacy_role(self):
        with ExitStack() as stack:
            store_patch, resolve_patch, start_patch, end_patch = self._common_patches()
            stack.enter_context(store_patch)
            stack.enter_context(resolve_patch)
            stack.enter_context(start_patch)
            stack.enter_context(end_patch)
            mock_client_cls = stack.enter_context(patch('app.routes.api.ProxmoxClient'))
            mock_client = MagicMock()
            mock_client_cls.return_value = mock_client
            mock_client.get_user.return_value = {'userid': 'alice@pve'}
            mock_client.list_acls.return_value = [
                {'ugid': 'alice@pve', 'path': '/vms/101', 'roleid': 'PVEUser', 'type': 'user', 'propagate': 1},
                {'ugid': 'alice@pve', 'path': '/vms/101', 'roleid': 'PVEVMUser', 'type': 'user', 'propagate': 1},
            ]

            resp = self.client.post(
                f'/api/projects/{self.project.id}/instances/actions/users_access_sync',
                json={
                    'templates': ['web'],
                    'enable': False,
                    'indices': [1],
                    'username': 'root@pam',
                    'password': 'secret',
                    'baseUrl': 'https://proxmox.local',
                    'verifySSL': False,
                },
            )

            self.assertEqual(resp.status_code, 200)
            calls = mock_client.delete_acl_user_vm.call_args_list
            self.assertEqual(len(calls), 2)
            roles = [c.kwargs.get('roles') for c in calls]
            self.assertCountEqual(roles, ['PVEUser', 'PVEVMUser'])

            # Also removes any legacy pool ACL grants (best-effort cleanup)
            pool_calls = mock_client.delete_acl_user_pool.call_args_list
            self.assertEqual(len(pool_calls), 2)
            pool_roles = [c.kwargs.get('roles') for c in pool_calls]
            self.assertCountEqual(pool_roles, ['PVEUser', 'PVEVMUser'])
            pool_ids = [c.args[1] for c in pool_calls]  # (userid, poolid, ...)
            self.assertTrue(all(p == 'alice' for p in pool_ids))

    def test_enable_falls_back_to_pvevmuser_when_pveuser_missing(self):
        with ExitStack() as stack:
            store_patch, resolve_patch, start_patch, end_patch = self._common_patches()
            stack.enter_context(store_patch)
            stack.enter_context(resolve_patch)
            stack.enter_context(start_patch)
            stack.enter_context(end_patch)
            mock_client_cls = stack.enter_context(patch('app.routes.api.ProxmoxClient'))
            mock_client = MagicMock()
            mock_client_cls.return_value = mock_client
            mock_client.get_user.return_value = {'userid': 'alice@pve'}
            mock_client.list_acls.return_value = []
            mock_client.set_acl_user_vm.side_effect = [
                RuntimeError('role does not exist'),
                None,
            ]

            resp = self.client.post(
                f'/api/projects/{self.project.id}/instances/actions/users_access_sync',
                json={
                    'templates': ['web'],
                    'enable': True,
                    'indices': [1],
                    'username': 'root@pam',
                    'password': 'secret',
                    'baseUrl': 'https://proxmox.local',
                    'verifySSL': False,
                },
            )

            self.assertEqual(resp.status_code, 200)
            self.assertEqual(mock_client.set_acl_user_vm.call_count, 2)
            roles = [c.kwargs.get('roles') for c in mock_client.set_acl_user_vm.call_args_list]
            self.assertEqual(roles, ['PVEUser', 'PVEVMUser'])

    def test_disable_adds_rollback_role_when_toggle_enabled(self):
        self.project.proxmox_assign_rollback_on_non_viewable = True
        with ExitStack() as stack:
            store_patch, resolve_patch, start_patch, end_patch = self._common_patches()
            stack.enter_context(store_patch)
            stack.enter_context(resolve_patch)
            stack.enter_context(start_patch)
            stack.enter_context(end_patch)
            mock_client_cls = stack.enter_context(patch('app.routes.api.ProxmoxClient'))
            mock_client = MagicMock()
            mock_client_cls.return_value = mock_client
            mock_client.get_user.return_value = {'userid': 'alice@pve'}
            mock_client.list_acls.return_value = [
                {'ugid': 'alice@pve', 'path': '/vms/101', 'roleid': 'PVEVMUser', 'type': 'user', 'propagate': 1},
            ]
            mock_client.get_role.return_value = {'roleid': 'AcostaRollback'}

            resp = self.client.post(
                f'/api/projects/{self.project.id}/instances/actions/users_access_sync',
                json={
                    'templates': ['web'],
                    'enable': False,
                    'indices': [1],
                    'username': 'root@pam',
                    'password': 'secret',
                    'baseUrl': 'https://proxmox.local',
                    'verifySSL': False,
                },
            )

            self.assertEqual(resp.status_code, 200)
            mock_client.delete_acl_user_vm.assert_called_once_with('alice@pve', 101, roles='PVEVMUser', propagate=True)
            mock_client.set_acl_user_vm.assert_called_once_with('alice@pve', 101, roles='AcostaRollback', propagate=True)

    def test_enable_removes_rollback_role_before_access_role(self):
        self.project.proxmox_assign_rollback_on_non_viewable = True
        with ExitStack() as stack:
            store_patch, resolve_patch, start_patch, end_patch = self._common_patches()
            stack.enter_context(store_patch)
            stack.enter_context(resolve_patch)
            stack.enter_context(start_patch)
            stack.enter_context(end_patch)
            mock_client_cls = stack.enter_context(patch('app.routes.api.ProxmoxClient'))
            mock_client = MagicMock()
            mock_client_cls.return_value = mock_client
            mock_client.get_user.return_value = {'userid': 'alice@pve'}
            mock_client.list_acls.return_value = [
                {'ugid': 'alice@pve', 'path': '/vms/101', 'roleid': 'AcostaRollback', 'type': 'user', 'propagate': 1},
            ]

            resp = self.client.post(
                f'/api/projects/{self.project.id}/instances/actions/users_access_sync',
                json={
                    'templates': ['web'],
                    'enable': True,
                    'indices': [1],
                    'username': 'root@pam',
                    'password': 'secret',
                    'baseUrl': 'https://proxmox.local',
                    'verifySSL': False,
                },
            )

            self.assertEqual(resp.status_code, 200)
            mock_client.delete_acl_user_vm.assert_called_once_with('alice@pve', 101, roles='AcostaRollback', propagate=True)
            mock_client.set_acl_user_vm.assert_called_once_with('alice@pve', 101, roles='PVEUser', propagate=True)


if __name__ == '__main__':
    unittest.main()
