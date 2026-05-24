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


class InstancesDeleteApiTests(unittest.TestCase):

    def setUp(self):
        self.app = create_app()
        self.app.config['TESTING'] = True
        self.client = self.app.test_client()

        vm = VMConfig(name='alpha')
        vm.internal_network_adaptors = ['lab']
        self.project = Project(id='proj-delete', name='Delete Project', tag='-lab-', vms=[vm])
        self.target_name = f"{vm.name}{self.project.tag}1"

    def test_delete_can_skip_expensive_post_verify(self):
        with ExitStack() as stack:
            stack.enter_context(patch('app.routes.api._store', return_value=_StoreStub(self.project)))
            stack.enter_context(patch('app.routes.api._start_job'))
            stack.enter_context(patch('app.routes.api._end_job'))
            stack.enter_context(patch('app.routes.api._clear_vm_cache'))
            stack.enter_context(patch('app.routes.api._is_cancelled', return_value=False))
            cleanup_scheduler = stack.enter_context(patch('app.routes.api._schedule_delete_bridge_cleanup', return_value=True))

            prox_cls = stack.enter_context(patch('app.routes.api.ProxmoxClient'))
            prox = MagicMock()
            prox_cls.return_value = prox

            prox.list_nodes.return_value = [{'node': 'node1'}]
            prox.list_qemu_vms.side_effect = [
                [{'name': self.target_name, 'vmid': 101}],
                [],
            ]
            prox.delete_qemu.return_value = 'UPID:node1:delete'
            prox._wait_task.return_value = {'status': 'stopped', 'exitstatus': 'OK'}
            prox.delete_bridge.return_value = True
            prox.reload_network.return_value = True

            resp = self.client.post(
                f'/api/projects/{self.project.id}/instances/actions/delete',
                json={
                    'username': 'root@pam',
                    'password': 'secret',
                    'baseUrl': 'https://proxmox.local',
                    'verifyCleanup': False,
                    'targets': [{'index': 1, 'name': 'alpha'}],
                },
            )

            self.assertEqual(resp.status_code, 200)
            payload = resp.get_json() or {}
            deleted = payload.get('deleted') or []
            self.assertEqual(len(deleted), 1)
            self.assertEqual(deleted[0]['name'], self.target_name)

            verify = payload.get('verify') or {}
            self.assertTrue(verify.get('skipped'))
            self.assertEqual(verify.get('issues') or [], [])
            self.assertEqual((verify.get('summary') or {}).get('disks_left'), 0)
            self.assertEqual((verify.get('summary') or {}).get('snaps_left'), 0)
            deferred = payload.get('deferred_cleanup') or {}
            self.assertTrue(deferred.get('scheduled'))
            self.assertEqual(deferred.get('nodes') or [], ['node1'])

            prox.delete_qemu.assert_called_once_with(node='node1', vmid=101, purge=True, destroy_unreferenced_disks=True)
            prox._wait_task.assert_called_once_with('node1', 'UPID:node1:delete', timeout=1200)
            cleanup_scheduler.assert_called_once()
            prox.reload_network.assert_not_called()
            prox.list_node_storages.assert_not_called()
            prox.list_storage_content.assert_not_called()

    def test_delete_can_remove_users_and_pools_when_instance_has_no_remaining_vms(self):
        self.project.credentials = [{'username': 'student1', 'password': 'secret1'}]
        with ExitStack() as stack:
            stack.enter_context(patch('app.routes.api._store', return_value=_StoreStub(self.project)))
            stack.enter_context(patch('app.routes.api._start_job'))
            stack.enter_context(patch('app.routes.api._end_job'))
            stack.enter_context(patch('app.routes.api._clear_vm_cache'))
            stack.enter_context(patch('app.routes.api._is_cancelled', return_value=False))
            cleanup_scheduler = stack.enter_context(patch('app.routes.api._schedule_delete_bridge_cleanup', return_value=True))

            prox_cls = stack.enter_context(patch('app.routes.api.ProxmoxClient'))
            prox = MagicMock()
            prox_cls.return_value = prox

            prox.list_nodes.return_value = [{'node': 'node1'}]
            prox.list_qemu_vms.side_effect = [
                [{'name': self.target_name, 'vmid': 101}],
                [],
                [],
            ]
            prox.delete_qemu.return_value = 'UPID:node1:delete'
            prox._wait_task.return_value = {'status': 'stopped', 'exitstatus': 'OK'}
            prox.get_pool.return_value = {'poolid': 'student1'}
            prox.list_pool_members.return_value = []
            prox.get_user.return_value = {'userid': 'student1@pve'}

            resp = self.client.post(
                f'/api/projects/{self.project.id}/instances/actions/delete',
                json={
                    'username': 'root@pam',
                    'password': 'secret',
                    'baseUrl': 'https://proxmox.local',
                    'verifyCleanup': False,
                    'deleteUsersAndPools': True,
                    'targets': [{'index': 1, 'name': 'alpha'}],
                },
            )

            self.assertEqual(resp.status_code, 200)
            payload = resp.get_json() or {}
            self.assertEqual(len(payload.get('deleted') or []), 1)
            self.assertEqual(len(payload.get('deleted_users') or []), 1)
            self.assertEqual(len(payload.get('deleted_pools') or []), 1)

            prox.delete_pool.assert_called_once_with('student1')
            prox.delete_user.assert_called_once_with('student1@pve')
            cleanup_scheduler.assert_called_once()

    def test_delete_skips_user_pool_removal_when_other_instance_vms_remain(self):
        vm_alpha = VMConfig(name='alpha')
        vm_beta = VMConfig(name='beta')
        project = Project(id='proj-delete-remain', name='Delete Project', tag='-lab-', vms=[vm_alpha, vm_beta])
        project.credentials = [{'username': 'student1', 'password': 'secret1'}]
        alpha_name = f'alpha{project.tag}1'
        beta_name = f'beta{project.tag}1'

        with ExitStack() as stack:
            stack.enter_context(patch('app.routes.api._store', return_value=_StoreStub(project)))
            stack.enter_context(patch('app.routes.api._start_job'))
            stack.enter_context(patch('app.routes.api._end_job'))
            stack.enter_context(patch('app.routes.api._clear_vm_cache'))
            stack.enter_context(patch('app.routes.api._is_cancelled', return_value=False))
            stack.enter_context(patch('app.routes.api._schedule_delete_bridge_cleanup', return_value=True))

            prox_cls = stack.enter_context(patch('app.routes.api.ProxmoxClient'))
            prox = MagicMock()
            prox_cls.return_value = prox

            prox.list_nodes.return_value = [{'node': 'node1'}]
            prox.list_qemu_vms.side_effect = [
                [
                    {'name': alpha_name, 'vmid': 101},
                    {'name': beta_name, 'vmid': 102},
                ],
                [
                    {'name': beta_name, 'vmid': 102},
                ],
            ]
            prox.delete_qemu.return_value = 'UPID:node1:delete'
            prox._wait_task.return_value = {'status': 'stopped', 'exitstatus': 'OK'}

            resp = self.client.post(
                f'/api/projects/{project.id}/instances/actions/delete',
                json={
                    'username': 'root@pam',
                    'password': 'secret',
                    'baseUrl': 'https://proxmox.local',
                    'verifyCleanup': False,
                    'deleteUsersAndPools': True,
                    'targets': [{'index': 1, 'name': 'alpha'}],
                },
            )

            self.assertEqual(resp.status_code, 200)
            payload = resp.get_json() or {}
            self.assertEqual(len(payload.get('deleted') or []), 1)
            self.assertEqual(payload.get('deleted_users') or [], [])
            self.assertEqual(payload.get('deleted_pools') or [], [])
            self.assertTrue(any('cleanup skipped' in str(item.get('reason') or '').lower() for item in (payload.get('notices') or [])))

            prox.delete_pool.assert_not_called()
            prox.delete_user.assert_not_called()

    def test_delete_stops_running_lxc_and_qemu_before_destroying(self):
        vm = VMConfig(name='alpha', vm_type='lxc')
        project = Project(id='proj-delete-running', name='Delete Running Project', tag='-lab-', vms=[vm])
        target_name = f"{vm.name}{project.tag}1"

        with ExitStack() as stack:
            stack.enter_context(patch('app.routes.api._store', return_value=_StoreStub(project)))
            stack.enter_context(patch('app.routes.api._start_job'))
            stack.enter_context(patch('app.routes.api._end_job'))
            stack.enter_context(patch('app.routes.api._clear_vm_cache'))
            stack.enter_context(patch('app.routes.api._is_cancelled', return_value=False))
            stack.enter_context(patch('app.routes.api._schedule_delete_bridge_cleanup', return_value=True))

            prox_cls = stack.enter_context(patch('app.routes.api.ProxmoxClient'))
            prox = MagicMock()
            prox_cls.return_value = prox

            prox.list_nodes.return_value = [{'node': 'node1'}]
            # Mark the discovered LXC container as running
            prox.list_lxc_vms.return_value = [{'name': target_name, 'vmid': 101, 'status': 'running'}]
            prox.list_qemu_vms.return_value = []
            
            prox.stop_lxc.return_value = 'UPID:node1:stop'
            prox.delete_lxc.return_value = 'UPID:node1:delete'
            prox._wait_task.return_value = {'status': 'stopped', 'exitstatus': 'OK'}

            # Attach parent mock to trace call order
            parent = MagicMock()
            prox.stop_lxc = parent.stop_lxc
            prox.delete_lxc = parent.delete_lxc

            resp = self.client.post(
                f'/api/projects/{project.id}/instances/actions/delete',
                json={
                    'username': 'root@pam',
                    'password': 'secret',
                    'baseUrl': 'https://proxmox.local',
                    'verifyCleanup': False,
                    'targets': [{'index': 1, 'name': 'alpha'}],
                },
            )

            self.assertEqual(resp.status_code, 200)
            
            # Assert stop_lxc is called before delete_lxc
            call_names = [call[0] for call in parent.mock_calls if call[0] in ('stop_lxc', 'delete_lxc')]
            self.assertEqual(call_names, ['stop_lxc', 'delete_lxc'])