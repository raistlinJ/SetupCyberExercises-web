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
        self.assertTrue(any(msg == 'Finalizing VM alpha-lab-1 (1/1): post-clone settings…' for msg in messages), messages)
        self.assertTrue(any(msg == 'Creating adaptor for alpha-lab-1 (1/1): bridge lab1 1/2…' for msg in messages), messages)
        self.assertTrue(any(msg == 'Assigning adaptor for alpha-lab-1 (1/1): bridge dmz1 2/2…' for msg in messages), messages)
        self.assertTrue(any(msg == 'Snapshot created for alpha-lab-1 (1/1); 1/1 complete' for msg in messages), messages)

    def test_create_can_skip_scenario_note_write_when_disabled(self):
        with ExitStack() as stack:
            stack.enter_context(patch('app.routes.api._store', return_value=_StoreStub(self.project)))
            stack.enter_context(patch('app.routes.api.random.randint', return_value=10001))
            stack.enter_context(patch('app.routes.api._safe_sleep', return_value=None))

            prox_cls = stack.enter_context(patch('app.routes.api.ProxmoxClient'))
            prox = MagicMock()
            prox_cls.return_value = prox

            prox.list_nodes.return_value = [{'node': 'node1'}]
            prox.list_qemu_vms.return_value = [{'vmid': 900, 'name': 'alpha', 'template': 1}]
            prox.clone_qemu.return_value = 'UPID:clone'
            prox._wait_task.return_value = None
            prox.list_qemu_snapshots.return_value = []
            prox.get_qemu_config.return_value = {}
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
                    'applyScenario': False,
                    'syncUserAccess': False,
                    'targets': [{'index': 1, 'name': 'alpha'}],
                },
            )

        self.assertEqual(resp.status_code, 200)
        prox.set_qemu_options.assert_not_called()

    def test_create_can_skip_network_and_snapshot_when_disabled(self):
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
            prox.list_network.return_value = []
            prox.create_bridge.return_value = None
            prox.set_qemu_nets.return_value = None
            prox.snapshot_qemu.return_value = 'UPID:snapshot'
            prox.list_snapshots_qemu.return_value = []
            prox.reload_network.return_value = None

            resp = self.client.post(
                f'/api/projects/{self.project.id}/instances/actions/create',
                json={
                    'baseUrl': self.project.proxmox_url,
                    'verifySSL': False,
                    'applyScenario': False,
                    'syncUserAccess': False,
                    'setNetworkInterfaces': False,
                    'takeSnapshot': False,
                    'targets': [{'index': 1, 'name': 'alpha'}],
                },
            )

        self.assertEqual(resp.status_code, 200)
        payload = resp.get_json() or {}
        notices = payload.get('notices') or []
        self.assertTrue(any('network interface assignment skipped by request' in str(item.get('reason') or '').lower() for item in notices), payload)
        self.assertTrue(any('post-clone snapshot skipped by request' in str(item.get('reason') or '').lower() for item in notices), payload)
        prox.create_bridge.assert_not_called()
        prox.set_qemu_nets.assert_not_called()
        prox.snapshot_qemu.assert_not_called()
        prox.reload_network.assert_not_called()
        self.assertFalse(any('Creating adaptor for' in msg for msg in messages), messages)
        self.assertFalse(any('Snapshot created for' in msg for msg in messages), messages)

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

    def test_refresh_vm_extracts_adaptors_for_lxc_and_qemu_correctly(self):
        self.app.config['AUTH_ENABLE'] = False
        # We set up two VMs in the project: one QEMU, one LXC
        vm_qemu = VMConfig(name='alpha', vmid=900, vm_type='qemu')
        vm_lxc = VMConfig(name='beta', vmid=901, vm_type='lxc')
        self.project.vms = [vm_qemu, vm_lxc]
        self.project.instances = 1
        
        store = MagicMock()
        store.get.return_value = self.project
        store.upsert.return_value = None

        with ExitStack() as stack:
            stack.enter_context(patch('app.routes.api._store', return_value=store))
            prox_cls = stack.enter_context(patch('app.routes.api.ProxmoxClient'))
            prox = MagicMock()
            prox_cls.return_value = prox

            # Mock node list and vm discovery listing
            prox.list_nodes.return_value = [{'node': 'node1'}]
            # QEMU listing returns alpha-lab-1
            prox.list_qemu_vms.return_value = [{'vmid': 900, 'name': 'alpha-lab-1', 'status': 'running'}]
            # LXC listing returns beta-lab-1
            prox.list_lxc_vms.return_value = [{'vmid': 901, 'name': 'beta-lab-1', 'status': 'running'}]

            # Mock configurations for prefetched config calls:
            # QEMU config has a classic net0 spec
            # LXC config has a classic net0 spec with name=eth0 and bridge=acosta1
            def mock_get_config(node, vmid):
                if vmid == 900:
                    return {'net0': 'e1000=AA:BB:CC:DD:EE:FF,bridge=lab1'}
                elif vmid == 901:
                    return {'net0': 'name=eth0,bridge=acosta1,hwaddr=11:22:33:44:55:66,ip=dhcp'}
                return {}
            
            prox.get_qemu_config.side_effect = mock_get_config
            prox.get_lxc_config.side_effect = mock_get_config

            resp = self.client.post(
                f'/api/projects/{self.project.id}/instances/refresh/vm',
                json={
                    'baseUrl': self.project.proxmox_url,
                    'verifySSL': False,
                    'username': 'root@pam',
                    'password': 'secret',
                },
            )

            self.assertEqual(resp.status_code, 200)
            payload = resp.get_json() or {}
            statuses = payload.get('instance_statuses') or []
            self.assertEqual(len(statuses), 1)
            
            details = statuses[0].get('vm_details') or []
            self.assertEqual(len(details), 2)
            
            # Map by name to make assertions clear
            details_map = {d['name']: d for d in details}
            
            # Assert QEMU parsed net0(lab1)
            qemu_detail = details_map.get('alpha-lab-1')
            self.assertIsNotNone(qemu_detail)
            self.assertEqual(qemu_detail.get('nets'), ['net0(lab1)'])
            
            # Assert LXC parsed net0(acosta1) preferring the bridge name over internal 'eth0' device
            lxc_detail = details_map.get('beta-lab-1')
            self.assertIsNotNone(lxc_detail)
            self.assertEqual(lxc_detail.get('nets'), ['net0(acosta1)'])

    def test_create_reloads_network_before_assigning_nics(self):
        with ExitStack() as stack:
            stack.enter_context(patch('app.routes.api._store', return_value=_StoreStub(self.project)))
            stack.enter_context(patch('app.routes.api.random.randint', return_value=10001))
            stack.enter_context(patch('app.routes.api._safe_sleep', return_value=None))

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
            prox.snapshot_qemu.return_value = 'UPID:snapshot'
            prox.list_snapshots_qemu.return_value = []

            # Attach parent mock to trace call order
            parent = MagicMock()
            prox.create_bridge = parent.create_bridge
            prox.reload_network = parent.reload_network
            prox.set_qemu_nets = parent.set_qemu_nets

            resp = self.client.post(
                f'/api/projects/{self.project.id}/instances/actions/create',
                json={
                    'baseUrl': self.project.proxmox_url,
                    'verifySSL': False,
                    'targets': [{'index': 1, 'name': 'alpha'}],
                },
            )

            self.assertEqual(resp.status_code, 200)

            # We expect the call order to be: create_bridge -> reload_network -> set_qemu_nets
            call_names = [call[0] for call in parent.mock_calls if call[0] in ('create_bridge', 'reload_network', 'set_qemu_nets')]
            
            self.assertIn('create_bridge', call_names)
            self.assertIn('reload_network', call_names)
            self.assertIn('set_qemu_nets', call_names)

            idx_create = call_names.index('create_bridge')
            idx_reload = call_names.index('reload_network')
            idx_set_nets = call_names.index('set_qemu_nets')

            self.assertTrue(idx_create < idx_reload, "create_bridge must occur before reload_network")
            self.assertTrue(idx_reload < idx_set_nets, "reload_network must occur before set_qemu_nets")


if __name__ == '__main__':
    unittest.main()