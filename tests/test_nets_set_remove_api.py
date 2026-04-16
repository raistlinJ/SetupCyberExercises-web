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


class NetsSetRemoveApiTests(unittest.TestCase):

    def setUp(self):
        self.app = create_app()
        self.app.config['TESTING'] = True
        self.client = self.app.test_client()

        vm = VMConfig(name='alpha')
        vm.internal_network_adaptors = ['lab', 'dmz']
        self.project = Project(id='proj-nets', name='Nets Project', tag='-lab-', vms=[vm])
        self.target_name = f"{vm.name}{self.project.tag}1"

    def _common_patches(self):
        mapped = [{'index': 1, 'name': self.target_name, 'vmid': 101, 'node': 'node1'}]
        return [
            patch('app.routes.api._store', return_value=_StoreStub(self.project)),
            patch('app.routes.api._resolve_targets_to_vm_info', return_value=(mapped, [], [])),
            patch('app.routes.api._start_job'),
            patch('app.routes.api._end_job'),
        ]

    def test_nets_set_idempotent_and_applies_network_once(self):
        existing_cfg = {
            'net0': 'e1000=AA:BB:CC:DD:EE:FF,bridge=lab1,firewall=1',
            'net1': 'e1000=11:22:33:44:55:66,bridge=wrong,firewall=1',
            'net2': 'virtio=DE:AD:BE:EF:00:01,bridge=extra0',
        }

        with ExitStack() as stack:
            for ctx in self._common_patches():
                stack.enter_context(ctx)

            prox_cls = stack.enter_context(patch('app.routes.api.ProxmoxClient'))
            prox = MagicMock()
            prox_cls.return_value = prox

            prox.list_network.return_value = [{'iface': 'lab1'}]
            prox.get_qemu_config.return_value = existing_cfg

            resp = self.client.post(
                f'/api/projects/{self.project.id}/instances/actions/nets_set',
                json={
                    'username': 'root@pam',
                    'password': 'secret',
                    'baseUrl': 'https://proxmox.local',
                    'targets': [{'index': 1, 'name': self.target_name}],
                },
            )

            self.assertEqual(resp.status_code, 200)
            payload = resp.get_json() or {}
            updated = payload.get('updated') or []
            self.assertEqual(len(updated), 1)

            # Missing bridge should be created, and networking reloaded once per node after the batch.
            prox.create_bridge.assert_called_with(node='node1', iface='dmz1', autostart=True, ports=None, comments='SCE-BRIDGE pid=proj-nets idx=1 adaptor=dmz source=nets_set')
            prox.reload_network.assert_called_once_with('node1')

            # net0 already matches (model + bridge); net1 corrected and net2 deleted.
            calls = prox.set_qemu_options.call_args_list
            self.assertEqual(len(calls), 1)
            options = calls[0].kwargs.get('options') or {}
            self.assertEqual(options.get('delete'), 'net2')
            self.assertNotIn('net0', options)
            self.assertIn('net1', options)
            self.assertIn('bridge=dmz1', options['net1'])
            self.assertTrue(options['net1'].startswith('e1000='), options['net1'])
            self.assertIn('firewall=1', options['net1'])

    def test_nets_remove_deletes_all_net_keys(self):
        existing_cfg = {
            'net0': 'e1000=AA:BB:CC:DD:EE:FF,bridge=lab1',
            'net1': 'e1000=11:22:33:44:55:66,bridge=dmz1',
        }

        with ExitStack() as stack:
            for ctx in self._common_patches():
                stack.enter_context(ctx)

            prox_cls = stack.enter_context(patch('app.routes.api.ProxmoxClient'))
            prox = MagicMock()
            prox_cls.return_value = prox

            prox.get_qemu_config.return_value = existing_cfg

            resp = self.client.post(
                f'/api/projects/{self.project.id}/instances/actions/nets_remove',
                json={
                    'username': 'root@pam',
                    'password': 'secret',
                    'baseUrl': 'https://proxmox.local',
                    'targets': [{'index': 1, 'name': self.target_name}],
                },
            )

            self.assertEqual(resp.status_code, 200)
            payload = resp.get_json() or {}
            cleared = payload.get('cleared') or []
            self.assertEqual(len(cleared), 1)
            prox.delete_qemu_options.assert_called_once()
            prox.reload_network.assert_called_once_with('node1')
            kwargs = prox.delete_qemu_options.call_args.kwargs
            self.assertEqual(kwargs.get('node'), 'node1')
            self.assertEqual(kwargs.get('vmid'), 101)
            self.assertCountEqual(kwargs.get('keys') or [], ['net0', 'net1'])

    def test_unlock_calls_proxmox_unlock_for_selected_vm(self):
        with ExitStack() as stack:
            for ctx in self._common_patches():
                stack.enter_context(ctx)

            prox_cls = stack.enter_context(patch('app.routes.api.ProxmoxClient'))
            prox = MagicMock()
            prox_cls.return_value = prox
            prox.unlock_qemu.return_value = 'UPID:node1:unlock'

            resp = self.client.post(
                f'/api/projects/{self.project.id}/instances/actions/unlock',
                json={
                    'username': 'root@pam',
                    'password': 'secret',
                    'baseUrl': 'https://proxmox.local',
                    'targets': [{'index': 1, 'name': self.target_name}],
                },
            )

            self.assertEqual(resp.status_code, 200)
            payload = resp.get_json() or {}
            unlocked = payload.get('unlocked') or []
            self.assertEqual(len(unlocked), 1)
            self.assertEqual(unlocked[0]['name'], self.target_name)
            prox.unlock_qemu.assert_called_once_with(node='node1', vmid=101)
            prox._wait_task.assert_called_once_with('node1', 'UPID:node1:unlock', timeout=600)
