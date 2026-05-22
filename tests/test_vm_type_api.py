import os
import tempfile
import unittest

from app import create_app


class VmTypeApiTests(unittest.TestCase):

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
        resp = self.client.post('/api/projects', json={'name': 'Type Project'})
        self.assertIn(resp.status_code, (200, 201))
        data = resp.get_json() or {}
        pid = data.get('id')
        self.assertTrue(pid)
        return pid

    def test_create_vm_defaults_to_qemu(self):
        pid = self._create_project()

        # Create VM without type
        resp = self.client.post(f'/api/projects/{pid}/vms', json={'name': 'vm-default'})
        self.assertEqual(resp.status_code, 200)
        proj = resp.get_json() or {}
        vms = proj.get('vms') or []
        vm = next((v for v in vms if v.get('name') == 'vm-default'), None)
        self.assertIsNotNone(vm)
        self.assertEqual(vm.get('vm_type'), 'qemu')

    def test_create_vm_with_type_lxc(self):
        pid = self._create_project()

        # Create VM with type LXC
        resp = self.client.post(f'/api/projects/{pid}/vms', json={'name': 'vm-lxc', 'vm_type': 'lxc'})
        self.assertEqual(resp.status_code, 200)
        proj = resp.get_json() or {}
        vms = proj.get('vms') or []
        vm = next((v for v in vms if v.get('name') == 'vm-lxc'), None)
        self.assertIsNotNone(vm)
        self.assertEqual(vm.get('vm_type'), 'lxc')

    def test_create_vm_with_invalid_type_defaults_to_qemu(self):
        pid = self._create_project()

        # Create VM with invalid type
        resp = self.client.post(f'/api/projects/{pid}/vms', json={'name': 'vm-invalid', 'vm_type': 'invalid-type'})
        self.assertEqual(resp.status_code, 200)
        proj = resp.get_json() or {}
        vms = proj.get('vms') or []
        vm = next((v for v in vms if v.get('name') == 'vm-invalid'), None)
        self.assertIsNotNone(vm)
        self.assertEqual(vm.get('vm_type'), 'qemu')

    def test_patch_vm_type(self):
        pid = self._create_project()

        # Create VM (defaults to qemu)
        resp = self.client.post(f'/api/projects/{pid}/vms', json={'name': 'web'})
        self.assertEqual(resp.status_code, 200)

        # PATCH to lxc
        resp = self.client.patch(f'/api/projects/{pid}/vms/web', json={'vm_type': 'lxc'})
        self.assertEqual(resp.status_code, 200)
        proj = resp.get_json() or {}
        vms = proj.get('vms') or []
        vm = next((v for v in vms if v.get('name') == 'web'), None)
        self.assertIsNotNone(vm)
        self.assertEqual(vm.get('vm_type'), 'lxc')

        # PATCH back to qemu
        resp = self.client.patch(f'/api/projects/{pid}/vms/web', json={'vm_type': 'qemu'})
        self.assertEqual(resp.status_code, 200)
        proj = resp.get_json() or {}
        vms = proj.get('vms') or []
        vm = next((v for v in vms if v.get('name') == 'web'), None)
        self.assertIsNotNone(vm)
        self.assertEqual(vm.get('vm_type'), 'qemu')

        # PATCH to invalid type defaults to qemu
        resp = self.client.patch(f'/api/projects/{pid}/vms/web', json={'vm_type': 'whatever'})
        self.assertEqual(resp.status_code, 200)
        proj = resp.get_json() or {}
        vms = proj.get('vms') or []
        vm = next((v for v in vms if v.get('name') == 'web'), None)
        self.assertIsNotNone(vm)
        self.assertEqual(vm.get('vm_type'), 'qemu')


if __name__ == '__main__':
    unittest.main()
