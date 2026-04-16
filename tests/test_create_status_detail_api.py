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


class CreateStatusDetailApiTests(unittest.TestCase):

    def setUp(self):
        self.app = create_app()
        self.app.config['TESTING'] = True
        self.client = self.app.test_client()

        vm = VMConfig(name='alpha', vmid=900)
        vm.internal_network_adaptors = ['lab', 'dmz']
        self.project = Project(id='proj-create-status', name='Create Status', tag='-lab-', vms=[vm])
        self.project.proxmox_url = 'https://proxmox.local'
        self.project.proxmox_api_token = 'user@pam!token=secret'
        self.target_name = f'{vm.name}{self.project.tag}1'

    def test_create_emits_fine_grained_status_messages(self):
        messages = []

        def capture_status(pid: str, **fields):
            message = fields.get('message')
            if isinstance(message, str) and message:
                messages.append(message)

        with ExitStack() as stack:
            stack.enter_context(patch('app.routes.api._store', return_value=_StoreStub(self.project)))
            stack.enter_context(patch('app.routes.api.random.randint', return_value=10001))
            stack.enter_context(patch('app.routes.api._safe_sleep', return_value=None))
            stack.enter_context(patch('app.routes.api._update_job_detail', side_effect=capture_status))

            prox_cls = stack.enter_context(patch('app.routes.api.ProxmoxClient'))
            prox = MagicMock()
            prox_cls.return_value = prox

            prox.list_nodes.return_value = [{'node': 'node1'}]
            prox.list_qemu_vms.return_value = [{'vmid': 900, 'name': 'alpha', 'template': 1}]
            prox.clone_qemu.return_value = 'UPID:clone'
            prox._wait_task.return_value = None
            prox.list_qemu_snapshots.return_value = []
            prox.get_qemu_config.return_value = {}
            prox.set_qemu_options.return_value = None
            prox.list_network.return_value = []
            prox.create_bridge.return_value = None
            prox.set_qemu_nets.return_value = None
            prox.snapshot_qemu.return_value = 'UPID:snapshot'
            prox.list_snapshots_qemu.return_value = [{'name': 'post-clone'}]
            prox.reload_network.return_value = None

            resp = self.client.post(
                f'/api/projects/{self.project.id}/instances/actions/create',
                json={
                    'baseUrl': self.project.proxmox_url,
                    'verifySSL': False,
                    'targets': [{'index': 1, 'name': 'alpha'}],
                },
            )

        self.assertEqual(resp.status_code, 200)
        self.assertTrue(any(msg == 'Creating VM alpha-lab-1 (1/1): cloning template…' for msg in messages), messages)
        self.assertTrue(any(msg == 'Finalizing VM alpha-lab-1 (1/1): notes, pools, and access…' for msg in messages), messages)
        self.assertTrue(any(msg == 'Creating adaptor for alpha-lab-1 (1/1): bridge lab1 1/2…' for msg in messages), messages)
        self.assertTrue(any(msg == 'Assigning adaptor for alpha-lab-1 (1/1): bridge dmz1 2/2…' for msg in messages), messages)
        self.assertTrue(any(msg == 'Snapshot created for alpha-lab-1 (1/1); 1/1 complete' for msg in messages), messages)

    def test_create_does_not_fallback_to_full_clone_when_linked_clone_is_selected(self):
        self.project.proxmox_use_linked_clones = True

        with ExitStack() as stack:
            stack.enter_context(patch('app.routes.api._store', return_value=_StoreStub(self.project)))
            stack.enter_context(patch('app.routes.api.random.randint', return_value=10001))
            stack.enter_context(patch('app.routes.api._safe_sleep', return_value=None))

            prox_cls = stack.enter_context(patch('app.routes.api.ProxmoxClient'))
            prox = MagicMock()
            prox_cls.return_value = prox

            prox.list_nodes.return_value = [{'node': 'node1'}]
            prox.list_qemu_vms.return_value = [{'vmid': 900, 'name': 'alpha', 'template': 1}]
            prox.list_qemu_snapshots.return_value = []
            prox.get_qemu_config.return_value = {}
            prox.clone_qemu.side_effect = RuntimeError('linked clone is not permitted for this source')

            resp = self.client.post(
                f'/api/projects/{self.project.id}/instances/actions/create',
                json={
                    'baseUrl': self.project.proxmox_url,
                    'verifySSL': False,
                    'targets': [{'index': 1, 'name': 'alpha'}],
                },
            )

        self.assertEqual(resp.status_code, 200)
        payload = resp.get_json() or {}
        self.assertEqual(payload.get('created') or [], [])
        errors = payload.get('errors') or []
        self.assertTrue(any('Full clone fallback is disabled when linked clone is selected.' in (entry.get('reason') or '') for entry in errors), payload)
        prox.clone_qemu.assert_called_once()
        self.assertFalse(prox.clone_qemu.call_args.kwargs.get('full'))


if __name__ == '__main__':
    unittest.main()