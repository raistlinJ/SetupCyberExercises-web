import unittest
from contextlib import ExitStack
from unittest.mock import MagicMock, patch
from flask import g

from app import create_app
from app.routes import api
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

    def test_permission_progress_reaches_queue_for_each_vm_and_reports_errors(self):
        self.project.instances = 2
        self.project.vms[0].viewable_to_user = True
        self.project.credentials.append({'username': 'bob', 'password': 'private-password'})
        mapped = [
            {'index': i, 'name': f'web-set-{i}', 'vmid': 100 + i, 'node': 'node1'}
            for i in (1, 2)
        ]
        reports = []
        client = MagicMock()
        client.list_nodes.return_value = []
        client.get_user.side_effect = lambda userid: {'userid': userid} if userid == 'alice@pve' else None
        during_grant = []
        client.set_acl_user_vm.side_effect = lambda *args, **kwargs: during_grant.append(dict(reports[-1]))
        body = {'targets': mapped, 'username': 'root@pam', 'password': 'connection-password'}
        try:
            with self.app.test_request_context(json=body), \
                    patch('app.routes.api._store', return_value=_StoreStub(self.project)), \
                    patch('app.routes.api.ProxmoxClient', return_value=client), \
                    patch('app.routes.api._resolve_targets_to_vm_info', return_value=(mapped, [], [])), \
                    patch('app.routes.api._vm_is_in_project_notes', return_value=True):
                g.action_queue_progress = reports.append
                response = api.instances_users_perms(self.project.id)
            self.assertEqual(response.status_code, 200)
            self.assertEqual(len(during_grant), 1)
            self.assertIn('Setting user access for alice@pve', during_grant[0]['message'])
            self.assertIn('web-set-1 (VM 101, node1)', during_grant[0]['message'])
            self.assertIn('Instance 1/2 · VM 1/1', during_grant[0]['message'])
            messages = ' '.join(r.get('message', '') for r in reports)
            self.assertIn('Adding web-set-1', messages)
            self.assertIn('Checking user bob@pve', messages)
            self.assertIn('1 VM(s) updated, 0 skipped, 1 error(s)', reports[-1]['message'])
            percentages = [r['progress'] for r in reports if 'progress' in r]
            self.assertEqual(percentages, sorted(percentages))
            self.assertEqual(percentages[-1], 100)
            self.assertNotIn('connection-password', str(reports))
            self.assertNotIn('private-password', str(reports))
            self.assertEqual(api._ACTIVE_JOBS[api._job_key(self.project.id)]['status'], 'error')
        finally:
            with api._JOB_LOCK:
                api._ACTIVE_JOBS.pop(api._job_key(self.project.id), None)

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
