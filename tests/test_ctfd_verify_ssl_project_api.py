import os
import tempfile
import unittest

from app import create_app


class CtfdVerifySslProjectApiTests(unittest.TestCase):

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

    def test_project_patch_persists_ctfd_verify_ssl(self):
        created = self.client.post('/api/projects', json={'name': 'SSL Project'})
        self.assertIn(created.status_code, (200, 201))
        pid = (created.get_json() or {}).get('id')
        self.assertTrue(pid)

        updated = self.client.patch(f'/api/projects/{pid}', json={'challenge_verify_ssl': False})
        self.assertEqual(updated.status_code, 200)
        payload = updated.get_json() or {}
        self.assertIn('challenge_verify_ssl', payload)
        self.assertFalse(payload.get('challenge_verify_ssl'))

        listed = self.client.get('/api/projects')
        self.assertEqual(listed.status_code, 200)
        projects = (listed.get_json() or {}).get('projects') or []
        proj = next((item for item in projects if str((item or {}).get('id')) == str(pid)), None)
        self.assertIsNotNone(proj)
        self.assertFalse(proj.get('challenge_verify_ssl'))


if __name__ == '__main__':
    unittest.main()