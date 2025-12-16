import os
import tempfile
import unittest

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


if __name__ == '__main__':
    unittest.main()
