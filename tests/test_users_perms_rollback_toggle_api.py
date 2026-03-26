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


class UsersPermsRollbackToggleApiTests(unittest.TestCase):

    def setUp(self):
        self.app = create_app()
        self.app.config['TESTING'] = True
        self.client = self.app.test_client()
        self.project = Project(id='proj-users-perms', name='Users Perms Project')
        self.project.instances = 1
        self.project.tag = '-set-'
        self.project.proxmox_url = 'https://proxmox.local'
        self.project.credentials = [{'username': 'alice', 'password': 'password123'}]
        self.project.vms = [VMConfig(name='web', viewable_to_user=False)]

    def _common_patches(self):
        mapped = [{'index': 1, 'name': f'web{self.project.tag}1', 'vmid': 101, 'node': 'node1'}]
        return [
            patch('app.routes.api._store', return_value=_StoreStub(self.project)),
            patch('app.routes.api._resolve_targets_to_vm_info', return_value=(mapped, [], [])),
            patch('app.routes.api._start_job'),
            patch('app.routes.api._end_job'),
        ]

    def test_non_viewable_vm_gets_rollback_role_when_toggle_enabled(self):
        self.project.proxmox_assign_rollback_on_non_viewable = True
        with ExitStack() as stack:
            for ctx in self._common_patches():
                stack.enter_context(ctx)
            mock_client_cls = stack.enter_context(patch('app.routes.api.ProxmoxClient'))
            mock_client = MagicMock()
            mock_client_cls.return_value = mock_client
            mock_client.get_user.return_value = {'userid': 'alice@pve'}
            mock_client.list_nodes.return_value = [{'node': 'node1'}]
            mock_client.list_qemu_vms.return_value = [{'vmid': 101, 'name': 'web-set-1'}]
            mock_client.get_qemu_config.return_value = {'description': '{"project_id": "proj-users-perms"}'}
            mock_client.get_role.return_value = {'roleid': 'AcostaRollback'}

            resp = self.client.post(
                f'/api/projects/{self.project.id}/instances/actions/users_perms',
                json={
                    'targets': [{'index': 1, 'name': 'web-set-1'}],
                    'username': 'root@pam',
                    'password': 'secret',
                    'baseUrl': 'https://proxmox.local',
                    'verifySSL': False,
                },
            )

            self.assertEqual(resp.status_code, 200)
            mock_client.set_acl_user_vm.assert_called_once_with('alice@pve', 101, roles='AcostaRollback', propagate=True)
            removed_roles = [call.kwargs.get('roles') for call in mock_client.delete_acl_user_vm.call_args_list]
            self.assertCountEqual(removed_roles, ['PVEUser', 'PVEVMUser'])

    def test_non_viewable_vm_gets_rollback_role_when_notes_include_scenario_block(self):
        self.project.proxmox_assign_rollback_on_non_viewable = True
        with ExitStack() as stack:
            for ctx in self._common_patches():
                stack.enter_context(ctx)
            mock_client_cls = stack.enter_context(patch('app.routes.api.ProxmoxClient'))
            mock_client = MagicMock()
            mock_client_cls.return_value = mock_client
            mock_client.get_user.return_value = {'userid': 'alice@pve'}
            mock_client.list_nodes.return_value = [{'node': 'node1'}]
            mock_client.list_qemu_vms.return_value = [{'vmid': 101, 'name': 'web-set-1'}]
            mock_client.get_qemu_config.return_value = {
                'description': 'Existing notes\n\n{\n    "Scenario": "Users Perms Project",\n    "User": "student",\n    "Pass": "secret"\n}'
            }
            mock_client.get_role.return_value = {'roleid': 'AcostaRollback'}

            resp = self.client.post(
                f'/api/projects/{self.project.id}/instances/actions/users_perms',
                json={
                    'targets': [{'index': 1, 'name': 'web-set-1'}],
                    'username': 'root@pam',
                    'password': 'secret',
                    'baseUrl': 'https://proxmox.local',
                    'verifySSL': False,
                },
            )

            self.assertEqual(resp.status_code, 200)
            mock_client.set_acl_user_vm.assert_called_once_with('alice@pve', 101, roles='AcostaRollback', propagate=True)


    def test_non_viewable_vm_drops_rollback_role_when_toggle_disabled(self):
        self.project.proxmox_assign_rollback_on_non_viewable = False
        with ExitStack() as stack:
            for ctx in self._common_patches():
                stack.enter_context(ctx)
            mock_client_cls = stack.enter_context(patch('app.routes.api.ProxmoxClient'))
            mock_client = MagicMock()
            mock_client_cls.return_value = mock_client
            mock_client.get_user.return_value = {'userid': 'alice@pve'}
            mock_client.list_nodes.return_value = [{'node': 'node1'}]
            mock_client.list_qemu_vms.return_value = [{'vmid': 101, 'name': 'web-set-1'}]
            mock_client.get_qemu_config.return_value = {'description': '{"project_id": "proj-users-perms"}'}

            resp = self.client.post(
                f'/api/projects/{self.project.id}/instances/actions/users_perms',
                json={
                    'targets': [{'index': 1, 'name': 'web-set-1'}],
                    'username': 'root@pam',
                    'password': 'secret',
                    'baseUrl': 'https://proxmox.local',
                    'verifySSL': False,
                },
            )

            self.assertEqual(resp.status_code, 200)
            mock_client.set_acl_user_vm.assert_not_called()
            removed_roles = [call.kwargs.get('roles') for call in mock_client.delete_acl_user_vm.call_args_list]
            self.assertCountEqual(removed_roles, ['PVEUser', 'PVEVMUser', 'AcostaRollback'])


if __name__ == '__main__':
    unittest.main()