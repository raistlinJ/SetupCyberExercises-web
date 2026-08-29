import io
import hashlib
import json
import os
import tempfile
import time
import unittest
import zipfile

from unittest.mock import patch

from app import create_app


class _FakeFile:
    def __init__(self, data: bytes = b''):
        self._data = data

    def read(self):
        return self._data


class _FakeSFTP:
    def listdir(self, _remote_dir):
        return []

    def stat(self, _path):
        class _St:
            st_size = 0
        return _St()

    def get(self, _rpath, _lpath, callback=None):
        if callback:
            callback(0)

    def close(self):
        return None


class _FakeSSHConn:
    def open_sftp(self):
        return _FakeSFTP()

    def close(self):
        return None


class _FakeProxmoxClient:
    def __init__(self, *args, **kwargs):
        self._session = None

    def list_nodes(self):
        return []

    def list_qemu_vms(self, _node_name):
        return []


class ExportNotifyAudioOptionTests(unittest.TestCase):

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
        resp = self.client.post('/api/projects', json={'name': 'ExportNotifyAudioOptionTest'})
        self.assertIn(resp.status_code, (200, 201))
        pid = (resp.get_json() or {}).get('id')
        self.assertTrue(pid)
        return pid

    def _seed_project_audio(self, pid: str):
        # Include notification config (event:*) and uploaded audio media (media:*).
        # The audio bytes can be any non-empty payload; the server only validates decode + size.
        data_url = 'data:audio/wav;base64,YWJj'  # base64("abc")
        payload = {
            'audio': {
                'event:challenge_solved': {
                    'enabled': True,
                    'soundKey': 'media:uploaded1',
                    'speak': True,
                    'speakTemplates': [
                        {
                            'id': 'tmpl1',
                            'template': 'Solved: {challenge}'
                        }
                    ],
                },
                'media:uploaded1': {
                    'sounds': [
                        {
                            'name': 'test',
                            'type': 'audio/wav',
                            'dataUrl': data_url,
                        }
                    ]
                },
            }
        }
        r = self.client.put(f'/api/projects/{pid}/audio', json=payload)
        self.assertEqual(r.status_code, 200)
        audio = (r.get_json() or {}).get('audio') or {}
        self.assertIn('event:challenge_solved', audio)
        self.assertIn('media:uploaded1', audio)

    def test_audio_patch_preserves_unrelated_uploaded_media(self):
        pid = self._create_project()
        self._seed_project_audio(pid)

        response = self.client.patch(
            f'/api/projects/{pid}/audio',
            json={
                'audio': {
                    'event:challenge_solved': {
                        'enabled': False,
                        'speakTemplates': ['Updated {{challenge}}'],
                    }
                },
                'removeFields': {
                    'event:challenge_solved': ['soundKey'],
                },
            },
        )
        self.assertEqual(response.status_code, 200)
        audio = (response.get_json() or {}).get('audio') or {}
        self.assertIn('media:uploaded1', audio)
        self.assertTrue((audio['media:uploaded1'].get('sounds') or [])[0].get('dataUrl'))
        event = audio.get('event:challenge_solved') or {}
        self.assertFalse(event.get('enabled'))
        self.assertNotIn('soundKey', event)
        self.assertEqual(event.get('speakTemplates'), ['Updated {{challenge}}'])

    def test_media_enabled_patch_preserves_clip_payload_and_events(self):
        pid = self._create_project()
        self._seed_project_audio(pid)

        response = self.client.patch(
            f'/api/projects/{pid}/audio',
            json={'audio': {'media:uploaded1': {'enabled': False}}},
        )
        self.assertEqual(response.status_code, 200)
        audio = (response.get_json() or {}).get('audio') or {}
        self.assertIn('event:challenge_solved', audio)
        media = audio.get('media:uploaded1') or {}
        self.assertFalse(media.get('enabled'))
        sounds = media.get('sounds') or []
        self.assertEqual(len(sounds), 1)
        self.assertTrue((sounds[0] or {}).get('dataUrl'))

    def test_audio_notify_templates_sanitize_to_strings(self):
        pid = self._create_project()
        self._seed_project_audio(pid)

        r = self.client.get(f'/api/projects/{pid}/audio')
        self.assertEqual(r.status_code, 200)
        audio = (r.get_json() or {}).get('audio') or {}
        evt = audio.get('event:challenge_solved') or {}
        templates = evt.get('speakTemplates') or []
        self.assertTrue(isinstance(templates, list) and templates)
        self.assertEqual(templates[0], 'Solved: {challenge}')

    def test_audio_notify_templates_recovers_stringified_dict(self):
        pid = self._create_project()

        payload = {
            'audio': {
                'event:challenge_solved': {
                    'enabled': True,
                    'soundKey': 'media:none',
                    'speak': True,
                    'speakTemplates': ["{'text': 'Solved: {challenge}', 'enabled': True}"],
                },
            }
        }
        r_put = self.client.put(f'/api/projects/{pid}/audio', json=payload)
        self.assertEqual(r_put.status_code, 200)

        r = self.client.get(f'/api/projects/{pid}/audio')
        self.assertEqual(r.status_code, 200)
        audio = (r.get_json() or {}).get('audio') or {}
        evt = audio.get('event:challenge_solved') or {}
        templates = evt.get('speakTemplates') or []
        self.assertTrue(isinstance(templates, list) and templates)
        self.assertEqual(templates[0], 'Solved: {challenge}')

    def _read_export_zip(self, resp_bytes: bytes) -> zipfile.ZipFile:
        buf = io.BytesIO(resp_bytes)
        return zipfile.ZipFile(buf, mode='r')

    def _wait_for_export_complete(self, pid: str, timeout_s: float = 5.0):
        deadline = time.time() + timeout_s
        last = None
        while time.time() < deadline:
            r = self.client.get(f'/api/projects/{pid}/export/status')
            if r.status_code == 200:
                last = r.get_json() or {}
                if last.get('status') == 'completed' and last.get('downloadReady'):
                    return last
                if last.get('status') == 'error':
                    self.fail(f"export job errored: {last.get('log')}")
            time.sleep(0.05)
        self.fail(f"export job did not complete in time; last={last}")

    def test_export_excludes_notify_audio_files_when_flag_false(self):
        pid = self._create_project()
        self._seed_project_audio(pid)

        resp = self.client.get(f'/api/projects/{pid}/export?includeNotifyAudio=false')
        self.assertEqual(resp.status_code, 200)

        with self._read_export_zip(resp.data) as zf:
            names = zf.namelist()
            self.assertIn('project.json', names)
            self.assertFalse(any(n.startswith('audio/') for n in names))

            manifest = json.loads(zf.read('project.json').decode('utf-8'))
            proj = (manifest or {}).get('project') or {}
            audio_map = proj.get('audio') or {}
            self.assertIn('event:challenge_solved', audio_map)
            self.assertFalse(any(str(k).startswith('media:') for k in audio_map.keys()))

    def test_export_includes_notify_audio_files_by_default(self):
        pid = self._create_project()
        self._seed_project_audio(pid)

        resp = self.client.get(f'/api/projects/{pid}/export')
        self.assertEqual(resp.status_code, 200)

        with self._read_export_zip(resp.data) as zf:
            names = zf.namelist()
            self.assertIn('project.json', names)
            self.assertTrue(any(n.startswith('audio/') for n in names))
            self.assertIn('audio/manifest.json', names)

            manifest = json.loads(zf.read('project.json').decode('utf-8'))
            proj = (manifest or {}).get('project') or {}
            audio_map = proj.get('audio') or {}
            self.assertIn('event:challenge_solved', audio_map)
            self.assertIn('media:uploaded1', audio_map)

    def test_selected_project_export_keeps_audio_when_materials_are_excluded(self):
        pid = self._create_project()
        self._seed_project_audio(pid)

        resp = self.client.get(
            f'/api/projects/export?ids={pid}&includeMaterials=false&includeNotifyAudio=true'
        )
        self.assertEqual(resp.status_code, 200)
        with self._read_export_zip(resp.data) as zf:
            names = zf.namelist()
            self.assertIn('audio/manifest.json', names)
            self.assertTrue(any(name.startswith('audio/') and name != 'audio/manifest.json' for name in names))
            self.assertFalse(any(name.startswith('materials/') for name in names))

        def test_project_audio_meta_and_entry_endpoints(self):
            pid = self._create_project()
            self._seed_project_audio(pid)

            # Meta query should filter to media:* keys and strip dataUrl payloads.
            r = self.client.get(f'/api/projects/{pid}/audio?prefix=media:&meta=1')
            self.assertEqual(r.status_code, 200)
            audio = (r.get_json() or {}).get('audio') or {}
            self.assertIn('media:uploaded1', audio)
            self.assertTrue(all(str(k).startswith('media:') for k in audio.keys()))
            meta_entry = audio.get('media:uploaded1') or {}
            sounds = meta_entry.get('sounds') or []
            self.assertTrue(isinstance(sounds, list) and len(sounds) == 1)
            self.assertNotIn('dataUrl', sounds[0])

            # Single-entry endpoint should return the full entry including dataUrl.
            r2 = self.client.get(f'/api/projects/{pid}/audio_entry?key=media:uploaded1')
            self.assertEqual(r2.status_code, 200)
            entry = (r2.get_json() or {}).get('entry') or {}
            sounds2 = entry.get('sounds') or []
            self.assertTrue(isinstance(sounds2, list) and len(sounds2) == 1)
            self.assertIn('dataUrl', sounds2[0])

        def test_audio_media_upload_dedupes_by_hash(self):
            pid = self._create_project()

            data_url = 'data:audio/wav;base64,YWJj'  # base64("abc")
            expected = hashlib.sha256(b'abc').hexdigest()

            r1 = self.client.post(f'/api/projects/{pid}/audio_media', json={
                'name': 'one.wav',
                'type': 'audio/wav',
                'size': 3,
                'dataUrl': data_url,
            })
            self.assertEqual(r1.status_code, 200)
            j1 = r1.get_json() or {}
            self.assertTrue(j1.get('ok'))
            self.assertFalse(j1.get('duplicated'))
            key1 = j1.get('key')
            self.assertTrue(isinstance(key1, str) and key1.startswith('media:'))

            r2 = self.client.post(f'/api/projects/{pid}/audio_media', json={
                'name': 'two.wav',
                'type': 'audio/wav',
                'size': 3,
                'dataUrl': data_url,
            })
            self.assertEqual(r2.status_code, 200)
            j2 = r2.get_json() or {}
            self.assertTrue(j2.get('ok'))
            self.assertTrue(j2.get('duplicated'))
            self.assertEqual(j2.get('key'), key1)

            a = self.client.get(f'/api/projects/{pid}/audio').get_json() or {}
            audio = a.get('audio') or {}
            media_keys = [k for k in audio.keys() if str(k).startswith('media:')]
            self.assertEqual(len(media_keys), 1)
            stored = audio.get(key1) or {}
            sounds = stored.get('sounds') or []
            self.assertTrue(isinstance(sounds, list) and len(sounds) == 1)
            self.assertEqual((sounds[0] or {}).get('sha256'), expected)
    @patch('app.routes.api.ProxmoxClient', new=_FakeProxmoxClient)
    @patch('app.routes.api._ssh_connect', autospec=True, return_value=_FakeSSHConn())
    @patch('app.routes.api._ssh_run_stream', autospec=True, return_value=('', ''))
    @patch('app.routes.api._ssh_run_cmd', autospec=True, return_value=(_FakeFile(b''), _FakeFile(b'')))
    def test_vm_export_excludes_notify_audio_files_when_flag_false(self, *_mocks):
        pid = self._create_project()
        self._seed_project_audio(pid)

        # VM export requires includeVms true + credentials; we mock Proxmox/SSH so it can run in tests.
        r_patch = self.client.patch(
            f'/api/projects/{pid}',
            json={'proxmox_url': 'https://example.com:8006', 'proxmox_ssh_port': 22, 'proxmox_verify_ssl': False},
        )
        self.assertEqual(r_patch.status_code, 200)

        r_start = self.client.post(
            f'/api/projects/{pid}/export/start',
            json={
                'includeVms': True,
                'includeCreds': False,
                'includeNotifyAudio': False,
                'baseUrl': 'https://example.com:8006',
                'username': 'root@pam',
                'password': 'x',
            },
        )
        self.assertEqual(r_start.status_code, 200)
        self.assertTrue((r_start.get_json() or {}).get('job'))

        self._wait_for_export_complete(pid)
        r_zip = self.client.get(f'/api/projects/{pid}/export/download')
        self.assertEqual(r_zip.status_code, 200)

        with self._read_export_zip(r_zip.data) as zf:
            names = zf.namelist()
            self.assertIn('project.json', names)
            self.assertFalse(any(n.startswith('audio/') for n in names))
            manifest = json.loads(zf.read('project.json').decode('utf-8'))
            proj = (manifest or {}).get('project') or {}
            audio_map = proj.get('audio') or {}
            self.assertIn('event:challenge_solved', audio_map)
            self.assertFalse(any(str(k).startswith('media:') for k in audio_map.keys()))

    @patch('app.routes.api.ProxmoxClient', new=_FakeProxmoxClient)
    @patch('app.routes.api._ssh_connect', autospec=True, return_value=_FakeSSHConn())
    @patch('app.routes.api._ssh_run_stream', autospec=True, return_value=('', ''))
    @patch('app.routes.api._ssh_run_cmd', autospec=True, return_value=(_FakeFile(b''), _FakeFile(b'')))
    def test_vm_export_includes_notify_audio_files_when_flag_true(self, *_mocks):
        pid = self._create_project()
        self._seed_project_audio(pid)

        r_patch = self.client.patch(
            f'/api/projects/{pid}',
            json={'proxmox_url': 'https://example.com:8006', 'proxmox_ssh_port': 22, 'proxmox_verify_ssl': False},
        )
        self.assertEqual(r_patch.status_code, 200)

        r_start = self.client.post(
            f'/api/projects/{pid}/export/start',
            json={
                'includeVms': True,
                'includeCreds': False,
                'includeNotifyAudio': True,
                'baseUrl': 'https://example.com:8006',
                'username': 'root@pam',
                'password': 'x',
            },
        )
        self.assertEqual(r_start.status_code, 200)

        self._wait_for_export_complete(pid)
        r_zip = self.client.get(f'/api/projects/{pid}/export/download')
        self.assertEqual(r_zip.status_code, 200)

        with self._read_export_zip(r_zip.data) as zf:
            names = zf.namelist()
            self.assertIn('project.json', names)
            # Should include audio/manifest.json and at least one clip
            self.assertIn('audio/manifest.json', names)
            self.assertTrue(any(n.startswith('audio/') and n != 'audio/manifest.json' for n in names))
            manifest = json.loads(zf.read('project.json').decode('utf-8'))
            proj = (manifest or {}).get('project') or {}
            audio_map = proj.get('audio') or {}
            self.assertIn('event:challenge_solved', audio_map)
            self.assertIn('media:uploaded1', audio_map)


if __name__ == '__main__':
    unittest.main()
