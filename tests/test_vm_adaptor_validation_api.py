import os
import tempfile
import unittest

from app import create_app
from app.routes.api import _bridge_iface_name


class VmAdaptorValidationApiTests(unittest.TestCase):

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
        resp = self.client.post('/api/projects', json={'name': 'Adaptor Validation Project'})
        self.assertIn(resp.status_code, (200, 201))
        data = resp.get_json() or {}
        pid = data.get('id')
        self.assertTrue(pid)
        return pid

    def test_update_vm_accepts_letter_only_adaptors(self):
        pid = self._create_project()
        add_resp = self.client.post(f'/api/projects/{pid}/vms', json={'name': 'web'})
        self.assertEqual(add_resp.status_code, 200)

        resp = self.client.patch(f'/api/projects/{pid}/vms/web', json={
            'internal_network_adaptors': ['lab', 'DMZ'],
        })

        self.assertEqual(resp.status_code, 200)
        payload = resp.get_json() or {}
        vms = payload.get('vms') or []
        vm = next((item for item in vms if (item or {}).get('name') == 'web'), None)
        self.assertIsNotNone(vm)
        self.assertEqual(vm.get('internal_network_adaptors') or [], ['lab', 'DMZ'])

    def test_update_vm_rejects_digit_suffixed_adaptors(self):
        pid = self._create_project()
        add_resp = self.client.post(f'/api/projects/{pid}/vms', json={'name': 'web'})
        self.assertEqual(add_resp.status_code, 200)

        resp = self.client.patch(f'/api/projects/{pid}/vms/web', json={
            'internal_network_adaptors': ['netA', 'net1'],
        })

        self.assertEqual(resp.status_code, 400)
        payload = resp.get_json() or {}
        self.assertIn('letters only, max 8 characters', payload.get('error') or '')
        self.assertEqual(payload.get('invalid') or [], ['net1'])

    def test_update_vm_accepts_literal_bridge_when_internet_connected(self):
        pid = self._create_project()
        add_resp = self.client.post(f'/api/projects/{pid}/vms', json={'name': 'web'})
        self.assertEqual(add_resp.status_code, 200)

        resp = self.client.patch(f'/api/projects/{pid}/vms/web', json={
            'internal_network_adaptors': ['lab', 'vmbr0'],
            'internet_connected_adaptors': ['vmbr0'],
        })

        self.assertEqual(resp.status_code, 200)
        payload = resp.get_json() or {}
        vms = payload.get('vms') or []
        vm = next((item for item in vms if (item or {}).get('name') == 'web'), None)
        self.assertIsNotNone(vm)
        self.assertEqual(vm.get('internal_network_adaptors') or [], ['lab', 'vmbr0'])
        self.assertEqual(vm.get('internet_connected_adaptors') or [], ['vmbr0'])

    def test_update_vm_rejects_invalid_internet_connected_iface(self):
        pid = self._create_project()
        add_resp = self.client.post(f'/api/projects/{pid}/vms', json={'name': 'web'})
        self.assertEqual(add_resp.status_code, 200)

        resp = self.client.patch(f'/api/projects/{pid}/vms/web', json={
            'internal_network_adaptors': ['lab'],
            'internet_connected_adaptors': ['vmbr0.10'],
        })

        self.assertEqual(resp.status_code, 400)
        payload = resp.get_json() or {}
        self.assertIn('Invalid internet-connected interface names', payload.get('error') or '')
        self.assertEqual(payload.get('invalid') or [], ['vmbr0.10'])

    def test_bridge_iface_name_preserves_distinct_numeric_wizard_adaptors(self):
        self.assertEqual(_bridge_iface_name(1, 'net0'), 'netA1')
        self.assertEqual(_bridge_iface_name(1, 'net1'), 'netB1')
        self.assertEqual(_bridge_iface_name(2, 'dmz9'), 'dmzJ2')


if __name__ == '__main__':
    unittest.main()