import io
import json
import os
import tempfile
import time
import unittest
import zipfile

from app import create_app


class ImportSelectionApiTests(unittest.TestCase):

    def setUp(self):
        self._tmpdir = tempfile.TemporaryDirectory()
        os.environ['DATA_DIR'] = self._tmpdir.name
        os.environ['AUTH_ENABLE'] = '0'
        self.app = create_app()
        self.app.config['TESTING'] = True
        self.client = self.app.test_client()

    def tearDown(self):
        try:
            self._tmpdir.cleanup()
        finally:
            os.environ.pop('DATA_DIR', None)
            os.environ.pop('AUTH_ENABLE', None)

    def _make_zip(self, project_dict: dict) -> io.BytesIO:
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, mode='w', compression=zipfile.ZIP_DEFLATED) as zf:
            manifest = {
                'schemaVersion': 1,
                'project': project_dict,
            }
            zf.writestr('project.json', json.dumps(manifest))
        buf.seek(0)
        return buf

    def _start_import_job(self, zip_buf: io.BytesIO, include_creds: bool, include_vms: bool) -> str:
        resp = self.client.post(
            '/api/projects/import/start',
            data={
                'file': (zip_buf, 'proj.zip'),
                'includeCreds': 'true' if include_creds else 'false',
                'includeVms': 'true' if include_vms else 'false',
            },
            content_type='multipart/form-data',
        )
        self.assertEqual(resp.status_code, 200)
        payload = resp.get_json()
        self.assertIn('job', payload)
        return payload['job']

    def _wait_job_completed(self, job_id: str, timeout_sec: float = 5.0) -> dict:
        deadline = time.time() + timeout_sec
        last = None
        while time.time() < deadline:
            r = self.client.get(f'/api/projects/import/status?id={job_id}')
            self.assertEqual(r.status_code, 200)
            last = r.get_json()
            if last.get('status') in {'completed', 'error', 'cancelled'}:
                return last
            time.sleep(0.05)
        self.fail(f"Import job did not finish within {timeout_sec}s (last={last})")

    def test_import_respects_unchecked_items(self):
        project = {
            'id': 'orig-1',
            'name': 'ImportSelectionTestUnchecked',
            'credentials': [{'username': 'user1', 'password': '12345678'}],
            'vms': [{'name': 'vmA', 'vmid': 100, 'internal_network_adaptors': ['LAN', 'BAD-ADAPTOR', 'DMZ']}],
        }
        zip_buf = self._make_zip(project)
        job = self._start_import_job(zip_buf, include_creds=False, include_vms=False)
        status = self._wait_job_completed(job)
        self.assertEqual(status.get('status'), 'completed')

        # Verify persisted project has neither creds nor vms
        resp = self.client.get('/api/projects')
        self.assertEqual(resp.status_code, 200)
        projects = (resp.get_json() or {}).get('projects') or []
        created = next((p for p in projects if p.get('name') == project['name']), None)
        self.assertIsNotNone(created)
        self.assertEqual(created.get('credentials') or [], [])
        vms = created.get('vms') or []
        self.assertEqual(len(vms), 1)
        self.assertEqual(vms[0].get('name'), 'vmA')
        # vmid should not be imported when VMs are unchecked
        self.assertTrue(('vmid' not in vms[0]) or (vms[0].get('vmid') in (None, '', 0)))
        # adaptor names should be preserved (and invalid ones filtered)
        self.assertEqual(vms[0].get('internal_network_adaptors') or [], ['LAN', 'DMZ'])

    def test_import_includes_checked_items(self):
        project = {
            'id': 'orig-2',
            'name': 'ImportSelectionTestChecked',
            'credentials': [{'username': 'user2', 'password': '12345678'}],
            'vms': [{'name': 'vmB', 'vmid': 101, 'start_commands': []}],
        }
        zip_buf = self._make_zip(project)
        job = self._start_import_job(zip_buf, include_creds=True, include_vms=True)
        status = self._wait_job_completed(job)
        self.assertEqual(status.get('status'), 'completed')

        resp = self.client.get('/api/projects')
        self.assertEqual(resp.status_code, 200)
        projects = (resp.get_json() or {}).get('projects') or []
        created = next((p for p in projects if p.get('name') == project['name']), None)
        self.assertIsNotNone(created)
        self.assertEqual(len(created.get('credentials') or []), 1)
        self.assertEqual(len(created.get('vms') or []), 1)


if __name__ == '__main__':
    unittest.main()
