import io
import json
import os
import tempfile
import unittest
import zipfile

from app import create_app
from app.storage.projects import (
    ProjectStore,
    StartCommand,
    StartCommandStep,
    VMConfig,
)


class ImportExportRoundTripTests(unittest.TestCase):

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        os.environ['DATA_DIR'] = self.tmp.name
        os.environ['AUTH_ENABLE'] = '0'
        self.app = create_app()
        self.app.config['TESTING'] = True
        self.client = self.app.test_client()

    def tearDown(self):
        self.tmp.cleanup()
        os.environ.pop('DATA_DIR', None)
        os.environ.pop('AUTH_ENABLE', None)

    def _seed_project(self):
        created = self.client.post('/api/projects', json={'name': 'Complete Round Trip'})
        self.assertEqual(created.status_code, 201)
        pid = created.get_json()['id']

        store = ProjectStore(self.tmp.name)
        project = store.get(pid)
        project.proxmox_node = 'node-a'
        project.proxmox_api_token = 'user@pam!export=test-token'
        project.proxmox_verify_ssl = False
        project.proxmox_use_linked_clones = False
        project.proxmox_assign_rollback_on_non_viewable = False
        project.proxmox_clone_timeout_seconds = 2468
        project.proxmox_skip_post_clone_snapshot = True
        project.proxmox_ssh_host = '10.20.30.40'
        project.proxmox_node_host_map = {'node-a': '10.20.30.40'}
        project.proxmox_update_delay_seconds = 1.25
        project.instance_statuses = [{'index': 1, 'created': True, 'managers': {'vm': 'ok'}}]
        project.vms = [
            VMConfig(
                name='container-template',
                vmid=321,
                vm_type='lxc',
                viewable_to_user=True,
                start_commands=[
                    StartCommandStep(
                        delay_seconds=1.5,
                        commands=[StartCommand(command='echo startup', timeout_seconds=45)],
                    )
                ],
                stored_commands=[
                    StartCommandStep(
                        delay_seconds=2.5,
                        commands=[
                            StartCommand(
                                command='echo stored',
                                enabled=False,
                                long_running=True,
                                timeout_seconds=120,
                            )
                        ],
                    )
                ],
                validation_commands=[{
                    'command': 'systemctl is-active demo',
                    'enabled': True,
                    'match': '^active$',
                    'is_regex': True,
                    'timeout_seconds': 19,
                }],
                internal_network_adaptors=['LAN'],
                internet_connected_adaptors=['vmbr0'],
            ),
            VMConfig(name='database-template', vmid=322, viewable_to_user=False),
            VMConfig(name='admin-template', vmid=323, viewable_to_user=False),
        ]
        project.audio = ProjectStore._sanitize_audio_map({
            'event:test': {
                'enabled': True,
                'soundKey': 'media:test',
                'speakTemplates': ['Imported {{name}}'],
            },
            'media:test': {
                'sounds': [{
                    'name': 'roundtrip.wav',
                    'type': 'audio/wav',
                    'dataUrl': 'data:audio/wav;base64,YXVkaW8tYnl0ZXM=',
                }],
            },
        })
        store.upsert(project)

        material = self.client.post(
            f'/api/projects/{pid}/materials',
            data={'file': (io.BytesIO(b'material-bytes'), 'instructions.txt')},
            content_type='multipart/form-data',
        )
        self.assertEqual(material.status_code, 201)
        return pid

    @staticmethod
    def _remove_embedded_audio_data(export_bytes: bytes) -> io.BytesIO:
        """Keep audio files but emulate a compact bundle without base64 in project.json."""
        source = zipfile.ZipFile(io.BytesIO(export_bytes), mode='r')
        out = io.BytesIO()
        with source, zipfile.ZipFile(out, mode='w', compression=zipfile.ZIP_DEFLATED) as target:
            for info in source.infolist():
                payload = source.read(info.filename)
                if info.filename == 'project.json':
                    manifest = json.loads(payload.decode('utf-8'))
                    media = manifest['project']['audio']['media:test']
                    media['sounds'] = []
                    payload = json.dumps(manifest).encode('utf-8')
                target.writestr(info, payload)
        out.seek(0)
        return out

    def test_complete_configuration_files_and_audio_round_trip(self):
        pid = self._seed_project()
        response = self.client.get(
            f'/api/projects/{pid}/export?includeCreds=true&includeVms=false&includeNotifyAudio=true'
        )
        self.assertEqual(response.status_code, 200)

        with zipfile.ZipFile(io.BytesIO(response.data), mode='r') as exported:
            names = exported.namelist()
            self.assertIn('project.json', names)
            self.assertIn('audio/manifest.json', names)
            self.assertEqual(len([name for name in names if name.startswith('materials/')]), 1)
            self.assertTrue(any(name.startswith('audio/') and name != 'audio/manifest.json' for name in names))

            project_json = json.loads(exported.read('project.json').decode('utf-8'))['project']
            vm_json = project_json['vms'][0]
            self.assertIn('stored_commands', vm_json)
            self.assertIn('validation_commands', vm_json)
            self.assertEqual(vm_json['vm_type'], 'lxc')
            self.assertNotIn('vmid', vm_json)
            exported_access = {vm['name']: vm['viewable_to_user'] for vm in project_json['vms']}
            self.assertEqual(exported_access, {
                'container-template': True,
                'database-template': False,
                'admin-template': False,
            })

        compact_bundle = self._remove_embedded_audio_data(response.data)
        imported = self.client.post(
            '/api/projects/import',
            data={
                'file': (compact_bundle, 'complete-round-trip.zip'),
                'includeCreds': 'true',
                'includeVms': 'false',
                'includeNotifyAudio': 'true',
            },
            content_type='multipart/form-data',
        )
        self.assertEqual(imported.status_code, 201, imported.get_data(as_text=True))
        imported_pid = imported.get_json()['id']

        projects = self.client.get('/api/projects').get_json()['projects']
        restored = next(project for project in projects if project['id'] == imported_pid)
        self.assertEqual(restored['proxmox_node'], 'node-a')
        self.assertEqual(restored['proxmox_api_token'], 'user@pam!export=test-token')
        self.assertFalse(restored['proxmox_verify_ssl'])
        self.assertFalse(restored['proxmox_use_linked_clones'])
        self.assertFalse(restored['proxmox_assign_rollback_on_non_viewable'])
        self.assertEqual(restored['proxmox_clone_timeout_seconds'], 2468)
        self.assertTrue(restored['proxmox_skip_post_clone_snapshot'])
        self.assertEqual(restored['proxmox_ssh_host'], '10.20.30.40')
        self.assertEqual(restored['proxmox_node_host_map'], {'node-a': '10.20.30.40'})
        self.assertEqual(restored['instance_statuses'][0]['index'], 1)

        vm = restored['vms'][0]
        self.assertEqual(vm['vm_type'], 'lxc')
        self.assertEqual(vm['stored_commands'][0]['commands'][0]['command'], 'echo stored')
        self.assertFalse(vm['stored_commands'][0]['commands'][0]['enabled'])
        self.assertEqual(vm['validation_commands'][0]['command'], 'systemctl is-active demo')
        self.assertEqual(vm['validation_commands'][0]['match'], '^active$')
        restored_access = {vm_config['name']: vm_config['viewable_to_user'] for vm_config in restored['vms']}
        self.assertEqual(restored_access, {
            'container-template': True,
            'database-template': False,
            'admin-template': False,
        })

        audio = self.client.get(f'/api/projects/{imported_pid}/audio').get_json()['audio']
        sounds = audio['media:test']['sounds']
        self.assertEqual(len(sounds), 1)
        self.assertEqual(sounds[0]['dataUrl'], 'data:audio/wav;base64,YXVkaW8tYnl0ZXM=')

        materials = self.client.get(f'/api/projects/{imported_pid}/materials').get_json()['materials']
        self.assertEqual(len(materials), 1)
        downloaded = self.client.get(f'/api/projects/{imported_pid}/materials/{materials[0]}')
        self.assertEqual(downloaded.data, b'material-bytes')


if __name__ == '__main__':
    unittest.main()
