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