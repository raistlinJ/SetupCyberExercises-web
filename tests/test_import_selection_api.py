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

    def _start_import_job(
        self,
        zip_buf: io.BytesIO,
        include_creds: bool,
        include_vms: bool,
        include_notify_audio: bool = True,
        file_name: str = 'proj.zip',
        allow_best_effort: bool = False,
    ) -> str:
        resp = self.client.post(
            '/api/projects/import/start',
            data={
                'file': (zip_buf, file_name),
                'includeCreds': 'true' if include_creds else 'false',
                'includeVms': 'true' if include_vms else 'false',
                'includeNotifyAudio': 'true' if include_notify_audio else 'false',
                'allowBestEffort': 'true' if allow_best_effort else 'false',
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

    def _cancel_job(self, job_id: str):
        r = self.client.post(f'/api/projects/import/cancel?id={job_id}')
        self.assertIn(r.status_code, (200, 204))

    def test_import_cancelled_does_not_persist_or_leave_artifacts(self):
        # Use a project with many materials to make the worker spend time staging,
        # giving us a reliable window to cancel.
        buf = io.BytesIO()
        project = {
            'id': 'orig-cancel-1',
            'name': 'ImportCancelledShouldNotPersist',
            'credentials': [{'username': 'user1', 'password': '12345678'}],
            'vms': [{'name': 'vmA', 'vmid': 100, 'internal_network_adaptors': ['LAN']}],
        }
        with zipfile.ZipFile(buf, mode='w', compression=zipfile.ZIP_DEFLATED) as zf:
            manifest = { 'schemaVersion': 1, 'project': project }
            zf.writestr('project.json', json.dumps(manifest))
            for i in range(200):
                zf.writestr(f'materials/file_{i}.txt', ('x' * 1024))
        buf.seek(0)

        job = self._start_import_job(buf, include_creds=True, include_vms=True, include_notify_audio=True)
        # Cancel immediately; worker should stop and clean up staging.
        self._cancel_job(job)
        status = self._wait_job_completed(job, timeout_sec=8.0)
        self.assertEqual(status.get('status'), 'cancelled')

        # Project should not appear in list.
        resp = self.client.get('/api/projects')
        self.assertEqual(resp.status_code, 200)
        projects = (resp.get_json() or {}).get('projects') or []
        created = next((p for p in projects if p.get('name') == project['name']), None)
        self.assertIsNone(created)

        # No staged work dirs or uploaded zips should remain.
        uploads_dir = os.path.join(self._tmpdir.name, 'uploads')
        if os.path.isdir(uploads_dir):
            leftovers = [n for n in os.listdir(uploads_dir) if n.startswith('import_') or n.startswith('import_work_')]
            self.assertEqual(leftovers, [])

        # No materials should have been committed (since project never persisted).
        mats_dir = os.path.join(self._tmpdir.name, 'materials')
        if os.path.isdir(mats_dir):
            mats = os.listdir(mats_dir)
            self.assertEqual(mats, [])

    def test_import_respects_unchecked_items(self):
        project = {
            'id': 'orig-1',
            'name': 'ImportSelectionTestUnchecked',
            'credentials': [{'username': 'user1', 'password': '12345678'}],
            'vms': [{'name': 'vmA', 'vmid': 100, 'internal_network_adaptors': ['LAN', 'LAN1', 'BAD-ADAPTOR', 'DMZ']}],
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
        self.assertEqual(vms[0].get('internal_network_adaptors') or [], ['LAN', 'LAN1', 'DMZ'])

    def test_import_includes_checked_items(self):
        project = {
            'id': 'orig-2',
            'name': 'ImportSelectionTestChecked',
            'credentials': [{'username': 'user2', 'password': '12345678'}],
            'vms': [{
                'name': 'vmB',
                'vmid': 101,
                'vm_type': 'lxc',
                'start_commands': [],
                'stored_commands': [{
                    'delay_seconds': 1,
                    'commands': [{'command': 'echo stored', 'enabled': False}],
                }],
                'validation_commands': [{
                    'command': 'echo valid',
                    'match': '^valid$',
                    'timeout_seconds': 17,
                }],
            }],
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
        imported_vm = created['vms'][0]
        self.assertEqual(imported_vm.get('vm_type'), 'lxc')
        self.assertEqual(imported_vm['stored_commands'][0]['commands'][0]['command'], 'echo stored')
        self.assertFalse(imported_vm['stored_commands'][0]['commands'][0]['enabled'])
        self.assertEqual(imported_vm['validation_commands'][0]['command'], 'echo valid')
        self.assertEqual(imported_vm['validation_commands'][0]['match'], '^valid$')

    def test_import_notify_audio_unchecked_drops_media_audio(self):
        # Minimal valid data URL (base64 for 'abc')
        data_url = 'data:audio/wav;base64,YWJj'
        project = {
            'id': 'orig-3',
            'name': 'ImportNotifyAudioUnchecked',
            'audio': {
                'event:test': {'soundKey': 'media:ding'},
                'media:ding': {'sounds': [{'dataUrl': data_url, 'name': 'ding.wav'}]},
            },
        }
        zip_buf = self._make_zip(project)
        job = self._start_import_job(zip_buf, include_creds=True, include_vms=True, include_notify_audio=False)
        status = self._wait_job_completed(job)
        self.assertEqual(status.get('status'), 'completed')

        resp = self.client.get('/api/projects')
        self.assertEqual(resp.status_code, 200)
        projects = (resp.get_json() or {}).get('projects') or []
        created = next((p for p in projects if p.get('name') == project['name']), None)
        self.assertIsNotNone(created)
        pid = created.get('id')
        self.assertTrue(pid)

        audio_resp = self.client.get(f'/api/projects/{pid}/audio')
        self.assertEqual(audio_resp.status_code, 200)
        audio = (audio_resp.get_json() or {}).get('audio') or {}
        self.assertIn('event:test', audio)
        self.assertTrue(all(not str(k).startswith('media:') for k in audio.keys()))

    def test_import_dedupes_duplicate_media_audio_by_hash(self):
        data_url = 'data:audio/wav;base64,YWJj'
        project = {
            'id': 'orig-4',
            'name': 'ImportNotifyAudioDedupe',
            'audio': {
                'media:one': {'sounds': [{'dataUrl': data_url, 'name': 'one.wav'}]},
                'media:two': {'sounds': [{'dataUrl': data_url, 'name': 'two.wav'}]},
                # Reference the duplicate key; import should remap it to the retained key.
                'event:test': {'soundKey': 'media:two'},
            },
        }
        zip_buf = self._make_zip(project)
        job = self._start_import_job(zip_buf, include_creds=True, include_vms=True, include_notify_audio=True)
        status = self._wait_job_completed(job)
        self.assertEqual(status.get('status'), 'completed')

        resp = self.client.get('/api/projects')
        self.assertEqual(resp.status_code, 200)
        projects = (resp.get_json() or {}).get('projects') or []
        created = next((p for p in projects if p.get('name') == project['name']), None)
        self.assertIsNotNone(created)
        pid = created.get('id')
        self.assertTrue(pid)

        audio_resp = self.client.get(f'/api/projects/{pid}/audio')
        self.assertEqual(audio_resp.status_code, 200)
        audio = (audio_resp.get_json() or {}).get('audio') or {}

        media_keys = [k for k in audio.keys() if str(k).startswith('media:')]
        self.assertEqual(len(media_keys), 1)
        self.assertIn('event:test', audio)
        self.assertEqual(audio['event:test'].get('soundKey'), media_keys[0])

    def test_import_without_manifest_uses_backups(self):
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, mode='w', compression=zipfile.ZIP_DEFLATED) as zf:
            zf.writestr('backups/vm-one/vzdump-qemu-101-2025_01_01-00_00_00.vma.zst', b'dummy')
        buf.seek(0)

        job = self._start_import_job(
            buf,
            include_creds=True,
            include_vms=True,
            file_name='backups-only.zip',
            allow_best_effort=True,
        )
        status = self._wait_job_completed(job)
        self.assertEqual(status.get('status'), 'completed')

        resp = self.client.get('/api/projects')
        self.assertEqual(resp.status_code, 200)
        projects = (resp.get_json() or {}).get('projects') or []
        created = next((p for p in projects if p.get('name') == 'backups-only'), None)
        self.assertIsNotNone(created)
        vms = created.get('vms') or []
        self.assertEqual(len(vms), 1)
        self.assertEqual(vms[0].get('name'), 'vm-one')

    def test_legacy_import_cleans_uploads_temp_artifacts(self):
        project = {
            'id': 'orig-legacy-1',
            'name': 'LegacyImportCleansUploads',
            'credentials': [{'username': 'user1', 'password': '12345678'}],
            'vms': [{'name': 'vmA', 'vmid': 100, 'internal_network_adaptors': ['LAN']}],
        }
        zip_buf = self._make_zip(project)

        resp = self.client.post(
            '/api/projects/import',
            data={
                'file': (zip_buf, 'proj.zip'),
                'includeCreds': 'true',
                'includeVms': 'true',
                'includeNotifyAudio': 'true',
            },
            content_type='multipart/form-data',
        )
        self.assertEqual(resp.status_code, 201)

        uploads_dir = os.path.join(self._tmpdir.name, 'uploads')
        if os.path.isdir(uploads_dir):
            leftovers = [n for n in os.listdir(uploads_dir) if n.startswith('import_') or n.startswith('import_work_')]
            self.assertEqual(leftovers, [])


if __name__ == '__main__':
    unittest.main()
