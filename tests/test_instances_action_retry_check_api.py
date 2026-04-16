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


class InstancesActionRetryCheckApiTests(unittest.TestCase):

    def setUp(self):
        self.app = create_app()
        self.app.config['TESTING'] = True
        self.client = self.app.test_client()

        vm = VMConfig(name='alpha')
        self.project = Project(id='proj-retry', name='Retry Project', tag='-lab-', vms=[vm])
        self.project.proxmox_url = 'https://proxmox.local'
        self.generated_name = f'{vm.name}{self.project.tag}1'
        self.base_request = {
            'username': 'root@pam',
            'password': 'secret',
            'baseUrl': self.project.proxmox_url,
            'verifySSL': False,
        }

    def _patch_context(self, stack: ExitStack):
        stack.enter_context(patch('app.routes.api._store', return_value=_StoreStub(self.project)))
        prox_cls = stack.enter_context(patch('app.routes.api.ProxmoxClient'))
        prox = MagicMock()
        prox_cls.return_value = prox
        prox.list_nodes.return_value = [{'node': 'node1'}]
        return prox

    def test_retry_check_create_reports_existing_vm_as_completed(self):
        with ExitStack() as stack:
            prox = self._patch_context(stack)
            prox.list_qemu_vms.return_value = [
                {'name': self.generated_name, 'vmid': 101, 'status': 'stopped', 'qmpstatus': 'stopped'}
            ]

            resp = self.client.post(
                f'/api/projects/{self.project.id}/instances/actions/create/retry-check',
                json={**self.base_request, 'targets': [{'index': 1, 'name': 'alpha'}]},
            )

        self.assertEqual(resp.status_code, 200)
        payload = resp.get_json() or {}
        self.assertEqual(payload.get('remaining') or [], [])
        completed = payload.get('completed') or []
        self.assertEqual(len(completed), 1)
        self.assertEqual(completed[0]['name'], 'alpha')
        self.assertEqual(completed[0]['resolved_name'], self.generated_name)
        self.assertEqual(completed[0]['reason'], 'VM already exists')

    def test_retry_check_delete_reports_missing_vm_as_completed(self):
        with ExitStack() as stack:
            prox = self._patch_context(stack)
            prox.list_qemu_vms.return_value = []

            resp = self.client.post(
                f'/api/projects/{self.project.id}/instances/actions/delete/retry-check',
                json={**self.base_request, 'targets': [{'index': 1, 'name': 'alpha'}]},
            )

        self.assertEqual(resp.status_code, 200)
        payload = resp.get_json() or {}
        self.assertEqual(payload.get('remaining') or [], [])
        completed = payload.get('completed') or []
        self.assertEqual(len(completed), 1)
        self.assertEqual(completed[0]['reason'], 'VM is already absent')

    def test_retry_check_start_reports_running_vm_as_completed(self):
        with ExitStack() as stack:
            prox = self._patch_context(stack)
            prox.list_qemu_vms.return_value = [
                {'name': self.generated_name, 'vmid': 101, 'status': 'running', 'qmpstatus': 'running'}
            ]

            resp = self.client.post(
                f'/api/projects/{self.project.id}/instances/actions/start/retry-check',
                json={**self.base_request, 'targets': [{'index': 1, 'name': self.generated_name}]},
            )

        self.assertEqual(resp.status_code, 200)
        payload = resp.get_json() or {}
        completed = payload.get('completed') or []
        self.assertEqual(len(completed), 1)
        self.assertEqual(completed[0]['reason'], 'vm is already running')
        self.assertEqual(payload.get('remaining') or [], [])

    def test_retry_check_snapshot_reports_existing_snapshot_as_completed(self):
        with ExitStack() as stack:
            prox = self._patch_context(stack)
            prox.list_qemu_vms.return_value = [
                {'name': self.generated_name, 'vmid': 101, 'status': 'running', 'qmpstatus': 'running'}
            ]
            prox.list_snapshots_qemu.return_value = [{'name': 'manual-20240501-010101'}]

            resp = self.client.post(
                f'/api/projects/{self.project.id}/instances/actions/snapshot/retry-check',
                json={
                    **self.base_request,
                    'snapname': 'manual-20240501-010101',
                    'targets': [{'index': 1, 'name': self.generated_name}],
                },
            )

        self.assertEqual(resp.status_code, 200)
        payload = resp.get_json() or {}
        completed = payload.get('completed') or []
        self.assertEqual(len(completed), 1)
        self.assertEqual(completed[0]['snapname'], 'manual-20240501-010101')
        self.assertEqual(completed[0]['reason'], 'snapshot manual-20240501-010101 already exists')
        self.assertEqual(payload.get('remaining') or [], [])

    def test_retry_check_apply_scenario_reports_existing_notes_as_completed(self):
        with ExitStack() as stack:
            prox = self._patch_context(stack)
            prox.list_qemu_vms.return_value = [
                {'name': self.generated_name, 'vmid': 101, 'status': 'running', 'qmpstatus': 'running'}
            ]
            prox.get_qemu_config.return_value = {'description': '{"Scenario": "Retry Project"}'}

            resp = self.client.post(
                f'/api/projects/{self.project.id}/instances/actions/apply_scenario/retry-check',
                json={**self.base_request, 'targets': [{'index': 1, 'name': self.generated_name}]},
            )

        self.assertEqual(resp.status_code, 200)
        payload = resp.get_json() or {}
        completed = payload.get('completed') or []
        self.assertEqual(len(completed), 1)
        self.assertEqual(completed[0]['reason'], 'Scenario notes already match this project')
        self.assertEqual(payload.get('remaining') or [], [])

    def test_snapshot_action_returns_snapname(self):
        with ExitStack() as stack:
            stack.enter_context(patch('app.routes.api._store', return_value=_StoreStub(self.project)))
            stack.enter_context(patch('app.routes.api._start_job'))
            stack.enter_context(patch('app.routes.api._end_job'))
            prox_cls = stack.enter_context(patch('app.routes.api.ProxmoxClient'))
            prox = MagicMock()
            prox_cls.return_value = prox
            prox.list_nodes.return_value = [{'node': 'node1'}]
            prox.list_qemu_vms.return_value = [
                {'name': self.generated_name, 'vmid': 101, 'status': 'running', 'qmpstatus': 'running'}
            ]
            prox.snapshot_qemu.return_value = 'UPID:snapshot'
            prox._wait_task.return_value = None

            resp = self.client.post(
                f'/api/projects/{self.project.id}/instances/actions/snapshot',
                json={**self.base_request, 'targets': [{'index': 1, 'name': self.generated_name}]},
            )

        self.assertEqual(resp.status_code, 200)
        payload = resp.get_json() or {}
        self.assertTrue(payload.get('snapname'))
        snapshotted = payload.get('snapshotted') or []
        self.assertEqual(len(snapshotted), 1)
        self.assertEqual(snapshotted[0]['snapname'], payload['snapname'])


if __name__ == '__main__':
    unittest.main()
