import io
import json
import os
import tempfile
from unittest.mock import patch
import unittest
import zipfile
from app.routes import api as api_module

from app import create_app


class RuntimeModeApiTests(unittest.TestCase):

    def setUp(self):
        os.environ['AUTH_ENABLE'] = '0'
        self.tmp = tempfile.TemporaryDirectory()
        self.app = create_app()
        self.app.config['TESTING'] = True
        # Ensure we write into a temp data dir for tests
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

    def test_secure_route_marks_session_auth_failures_with_header(self):
        os.environ['AUTH_ENABLE'] = '1'
        app = create_app()
        app.config['TESTING'] = True
        app.config['DATA_DIR'] = self.tmp.name

        @app.get('/__secure_test')
        @api_module._secure_route()
        def _secure_test():
            return {'ok': True}

        client = app.test_client()
        resp = client.get('/__secure_test')

        self.assertEqual(resp.status_code, 401)
        self.assertEqual(resp.headers.get('X-DeployForge-Auth-Failure'), '1')

    def test_secure_route_does_not_mark_api_key_failures_as_session_auth(self):
        app = create_app()
        app.config['TESTING'] = True
        app.config['DATA_DIR'] = self.tmp.name
        app.config['API_KEY'] = 'expected-key'

        @app.get('/__secure_api_key_test')
        @api_module._secure_route()
        def _secure_api_key_test():
            return {'ok': True}

        client = app.test_client()
        resp = client.get('/__secure_api_key_test')

        self.assertEqual(resp.status_code, 401)
        self.assertIsNone(resp.headers.get('X-DeployForge-Auth-Failure'))

    def _make_zip(self) -> io.BytesIO:
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, mode='w', compression=zipfile.ZIP_DEFLATED) as zf:
            manifest = {
                'schemaVersion': 1,
                'project': {'id': 'orig-1', 'name': 'BlockedImportTest'},
            }
            zf.writestr('project.json', json.dumps(manifest))
        buf.seek(0)
        return buf

    def _create_project(self) -> str:
        resp = self.client.post('/api/projects', json={'name': 'BlockedExportTest'})
        self.assertIn(resp.status_code, (200, 201))
        payload = resp.get_json() or {}
        pid = payload.get('id')
        self.assertTrue(pid)
        return pid

    def test_runtime_defaults_to_local(self):
        resp = self.client.get('/api/runtime')
        self.assertEqual(resp.status_code, 200)
        payload = resp.get_json() or {}
        self.assertTrue(payload.get('ok'))
        self.assertEqual(payload.get('runMode'), 'local')

    def test_runtime_persists_remote_then_local(self):
        resp = self.client.post('/api/runtime', json={'runMode': 'remote'})
        self.assertEqual(resp.status_code, 200)
        payload = resp.get_json() or {}
        self.assertTrue(payload.get('ok'))
        self.assertEqual(payload.get('runMode'), 'remote')

        # File should exist now
        runtime_path = os.path.join(self.tmp.name, 'runtime.json')
        self.assertTrue(os.path.exists(runtime_path))

        # Read back
        resp2 = self.client.get('/api/runtime')
        self.assertEqual(resp2.status_code, 200)
        payload2 = resp2.get_json() or {}
        self.assertEqual(payload2.get('runMode'), 'remote')

        # Back to local clears the flag
        resp3 = self.client.post('/api/runtime', json={'runMode': 'local'})
        self.assertEqual(resp3.status_code, 200)
        payload3 = resp3.get_json() or {}
        self.assertEqual(payload3.get('runMode'), 'local')

        resp4 = self.client.get('/api/runtime')
        payload4 = resp4.get_json() or {}
        self.assertEqual(payload4.get('runMode'), 'local')

    def test_remote_mode_blocks_import_and_export(self):
        # Turn on remote mode
        resp = self.client.post('/api/runtime', json={'runMode': 'remote'})
        self.assertEqual(resp.status_code, 200)
        self.assertEqual((resp.get_json() or {}).get('runMode'), 'remote')

        # Import (async)
        zip_buf = self._make_zip()
        r_imp = self.client.post(
            '/api/projects/import/start',
            data={'file': (zip_buf, 'proj.zip')},
            content_type='multipart/form-data',
        )
        self.assertEqual(r_imp.status_code, 403)

        # Export
        pid = self._create_project()
        r_exp = self.client.get(f'/api/projects/{pid}/export')
        self.assertEqual(r_exp.status_code, 403)

        # Exports list
        r_list = self.client.get(f'/api/projects/{pid}/exports')
        self.assertEqual(r_list.status_code, 403)


if __name__ == '__main__':
    unittest.main()
