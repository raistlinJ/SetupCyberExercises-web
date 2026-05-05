import os
import tempfile
import unittest
from unittest.mock import MagicMock, patch

from app import create_app


class VmUserAccessibilityApiTests(unittest.TestCase):

    def setUp(self):
        os.environ['AUTH_ENABLE'] = '0'
        self.tmp = tempfile.TemporaryDirectory()
        self.app = create_app()
        self.app.config['TESTING'] = True
        self.app.config['DATA_DIR'] = self.tmp.name
        self.client = self.app.test_client()

    def tearDown(self):
        try:
            self.tmp.cleanup()
        except Exception:
            pass
        try:
            os.environ.pop('AUTH_ENABLE', None)
        except Exception:
            pass

    def _create_project(self) -> str:
        resp = self.client.post('/api/projects', json={'name': 'UA Project'})
        self.assertIn(resp.status_code, (200, 201))
        data = resp.get_json() or {}
        pid = data.get('id')
        self.assertTrue(pid)
        return pid

    def test_toggle_viewable_to_user(self):
        pid = self._create_project()

        # Add a VM template
        r_add = self.client.post(f'/api/projects/{pid}/vms', json={'name': 'web'})
        self.assertEqual(r_add.status_code, 200)

        # Enable
        r_on = self.client.patch(f'/api/projects/{pid}/vms/web', json={'viewable_to_user': True})
        self.assertEqual(r_on.status_code, 200)
        proj = r_on.get_json() or {}
        vms = proj.get('vms') or []
        vm = next((v for v in vms if (v or {}).get('name') == 'web'), None)
        self.assertIsNotNone(vm)
        self.assertTrue(bool(vm.get('viewable_to_user')))

        # Disable
        r_off = self.client.patch(f'/api/projects/{pid}/vms/web', json={'viewable_to_user': False})
        self.assertEqual(r_off.status_code, 200)
        proj2 = r_off.get_json() or {}
        vms2 = proj2.get('vms') or []
        vm2 = next((v for v in vms2 if (v or {}).get('name') == 'web'), None)
        self.assertIsNotNone(vm2)
        self.assertFalse(bool(vm2.get('viewable_to_user')))

    def test_create_reconciles_non_viewable_vm_to_rollback_role(self):
        pid = self._create_project()

        proj_resp = self.client.patch(f'/api/projects/{pid}', json={
            'instances': 1,
            'tag': '-set-',
            'proxmox_url': 'https://proxmox.local',
            'credentials': [{'username': 'alice', 'password': 'password1'}],
        })
        self.assertEqual(proj_resp.status_code, 200)

        add_resp = self.client.post(f'/api/projects/{pid}/vms', json={'name': 'web'})
        self.assertEqual(add_resp.status_code, 200)

        vm_resp = self.client.patch(f'/api/projects/{pid}/vms/web', json={
            'vmid': 900,
            'viewable_to_user': False,
        })
        self.assertEqual(vm_resp.status_code, 200)

        with patch('app.routes.api.ProxmoxClient') as mock_client_cls, \
             patch('app.routes.api._reconcile_vm_access_roles') as reconcile_mock, \
             patch('app.routes.api.random.randint', return_value=10001):
            mock_client = MagicMock()
            mock_client_cls.return_value = mock_client
            mock_client.list_nodes.return_value = [{'node': 'node1'}]
            mock_client.list_qemu_vms.return_value = [{'vmid': 900, 'name': 'web-template', 'template': 1}]
            mock_client.clone_qemu.return_value = 'UPID:clone'
            mock_client.list_qemu_snapshots.return_value = []
            mock_client.get_qemu_config.return_value = {}
            mock_client.set_qemu_options.return_value = None
            mock_client.get_pool.return_value = {'poolid': 'alice'}
            mock_client.add_pool_member.return_value = None
            mock_client.get_user.return_value = {'userid': 'alice@pve'}
            mock_client.list_acls.return_value = []
            mock_client.list_network.return_value = []
            mock_client.list_snapshots_qemu.return_value = [{'name': 'post-clone'}]
            mock_client.snapshot_qemu.return_value = 'UPID:snapshot'
            reconcile_mock.return_value = {
                'granted': 'AcostaRollback',
                'removed': ['PVEUser', 'PVEVMUser'],
                'current_roles': {'AcostaRollback'},
            }

            create_resp = self.client.post(
                f'/api/projects/{pid}/instances/actions/create',
                json={
                    'targets': [{'index': 1, 'name': 'web'}],
                    'username': 'root@pam',
                    'password': 'secret',
                    'baseUrl': 'https://proxmox.local',
                    'verifySSL': False,
                },
            )

        self.assertEqual(create_resp.status_code, 200)
        self.assertEqual(reconcile_mock.call_count, 1)
        self.assertFalse(reconcile_mock.call_args.kwargs.get('accessible'))
        self.assertTrue(reconcile_mock.call_args.kwargs.get('rollback_enabled'))

    def test_create_can_skip_pool_and_acl_sync_when_disabled(self):
        pid = self._create_project()

        proj_resp = self.client.patch(f'/api/projects/{pid}', json={
            'instances': 1,
            'tag': '-set-',
            'proxmox_url': 'https://proxmox.local',
            'credentials': [{'username': 'alice', 'password': 'password1'}],
        })
        self.assertEqual(proj_resp.status_code, 200)

        add_resp = self.client.post(f'/api/projects/{pid}/vms', json={'name': 'web'})
        self.assertEqual(add_resp.status_code, 200)

        vm_resp = self.client.patch(f'/api/projects/{pid}/vms/web', json={
            'vmid': 900,
            'viewable_to_user': True,
        })
        self.assertEqual(vm_resp.status_code, 200)

        with patch('app.routes.api.ProxmoxClient') as mock_client_cls, \
             patch('app.routes.api._reconcile_vm_access_roles') as reconcile_mock, \
             patch('app.routes.api.random.randint', return_value=10001):
            mock_client = MagicMock()
            mock_client_cls.return_value = mock_client
            mock_client.list_nodes.return_value = [{'node': 'node1'}]
            mock_client.list_qemu_vms.return_value = [{'vmid': 900, 'name': 'web-template', 'template': 1}]
            mock_client.clone_qemu.return_value = 'UPID:clone'
            mock_client.list_qemu_snapshots.return_value = []
            mock_client.get_qemu_config.return_value = {}
            mock_client.set_qemu_options.return_value = None
            mock_client.list_network.return_value = []
            mock_client.list_snapshots_qemu.return_value = [{'name': 'post-clone'}]
            mock_client.snapshot_qemu.return_value = 'UPID:snapshot'

            create_resp = self.client.post(
                f'/api/projects/{pid}/instances/actions/create',
                json={
                    'targets': [{'index': 1, 'name': 'web'}],
                    'username': 'root@pam',
                    'password': 'secret',
                    'baseUrl': 'https://proxmox.local',
                    'verifySSL': False,
                    'applyScenario': False,
                    'syncUserAccess': False,
                },
            )

        self.assertEqual(create_resp.status_code, 200)
        reconcile_mock.assert_not_called()
        mock_client.get_pool.assert_not_called()
        mock_client.get_user.assert_not_called()


if __name__ == '__main__':
    unittest.main()
