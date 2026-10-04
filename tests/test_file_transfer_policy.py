import os
import tempfile
from unittest.mock import Mock, patch
import unittest

from app import create_app
from app.file_transfer import write_policy, config_policy, read_policy
from app.routes import api
from app.storage.projects import Project, VMConfig


class TransferPolicyTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        with patch.dict(os.environ, {'AUTH_ENABLE': '0', 'DATA_DIR': self.tmp.name}):
            self.app = create_app()
        self.app.config.update(TESTING=True, AUTH_ENABLE=False)
        self.client = self.app.test_client()
        self.project = Project(id='p', name='Demo', instances=2, tag='-set-',
                               proxmox_url='https://node.test', proxmox_api_token='test',
                               vms=[VMConfig(name='web', file_upload=True)])
        self.store = Mock()
        self.store.get.return_value = self.project
        self.store.update_vm.side_effect = self.update_vm
        self.patches = [patch.object(api, '_store', return_value=self.store)]
        for item in self.patches: item.start()

    def tearDown(self):
        for item in self.patches: item.stop()
        self.tmp.cleanup()

    def update_vm(self, pid, name, **fields):
        for key, value in fields.items(): setattr(self.project.vms[0], key, value)
        return self.project

    def test_configuration_guard_and_accessibility_revocation(self):
        route = '/api/projects/p/vms/web'
        self.assertEqual(self.client.patch(route, json={'file_upload': 'true'}).status_code, 400)
        self.store.update_vm.assert_not_called()
        self.project.vms[0].viewable_to_user = False
        self.assertEqual(self.client.patch(route, json={'file_download': True}).status_code, 400)
        self.project.vms[0].viewable_to_user = True
        self.assertEqual(self.client.patch(route, json={'file_download': True}).status_code, 200)
        self.assertEqual(self.client.patch(route, json={'viewable_to_user': False}).status_code, 200)
        self.assertFalse(self.project.vms[0].file_upload)
        self.assertFalse(self.project.vms[0].file_download)

    def test_only_admin_can_change_policy(self):
        self.app.config['AUTH_ENABLE'] = True
        self.app.current_user = lambda: {'roles': ['user']}
        self.assertEqual(self.client.patch('/api/projects/p/vms/web', json={'file_upload': True}).status_code, 403)
        self.assertEqual(self.client.post('/api/projects/p/instances/actions/file_transfer', json={'targets': []}).status_code, 403)

    def test_notes_preserve_other_data_and_replace_duplicates(self):
        notes = 'Human notes\n{"Scenario":"Demo","User":"student"}\n{"AccessForge":{"file_upload":true}}\n{"AccessForge":{"file_download":true}}'
        written = write_policy(notes, {'file_upload': False, 'file_download': True})
        self.assertIn('Human notes', written)
        self.assertIn('"User":"student"', written)
        self.assertEqual(written.count('"AccessForge"'), 1)
        self.assertFalse(config_policy(VMConfig(name='web', viewable_to_user=False, file_upload=True))['file_upload'])

    def test_per_vm_action_preserves_other_direction_and_uses_digest(self):
        target = {'index': 1, 'name': 'web-set-1', 'node': 'node', 'vmid': 101, 'type': 'qemu'}
        upstream = Mock()
        upstream.get_qemu_config.return_value = {'digest': 'abc', 'description': 'Human notes\n{"AccessForge":{"file_upload":true,"file_download":false}}'}
        with patch.object(api, 'ProxmoxClient', return_value=upstream), patch.object(api, '_resolve_targets_to_vm_info', return_value=([target], [], [])):
            response = self.client.post('/api/projects/p/instances/actions/file_transfer', json={'targets': [target], 'file_download': True})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json['errors'], [])
        options = upstream.set_qemu_options.call_args.kwargs['options']
        self.assertEqual(options['digest'], 'abc')
        metadata = list(api._iter_json_dicts_from_text(options['description']))[0]['AccessForge']
        self.assertEqual(metadata, {'file_upload': True, 'file_download': True})
        self.assertTrue(self.project.vms[0].file_upload)
        self.assertFalse(self.project.vms[0].file_download)  # instance override does not change templates

    def test_configuration_and_actions_do_not_require_console_discovery(self):
        target = {'index': 1, 'name': 'web-set-1', 'node': 'node', 'vmid': 101, 'type': 'qemu'}
        upstream = Mock()
        upstream.get_qemu_config.return_value = {'description': ''}
        with patch.dict(os.environ, {'CIT_VM_ACCESSOR_URL': '', 'ENABLE_VM_FILE_UPLOAD': 'false', 'ENABLE_VM_FILE_DOWNLOAD': 'false'}), patch('requests.get', side_effect=AssertionError('Unexpected console discovery')) as get, patch.object(api, 'ProxmoxClient', return_value=upstream), patch.object(api, '_resolve_targets_to_vm_info', return_value=([target], [], [])):
            self.project.vms[0].viewable_to_user = True
            for direction in ('upload', 'download'):
                for enabled in (True, False):
                    with self.subTest(direction=direction, enabled=enabled):
                        policy = {'file_' + direction: enabled}
                        response = self.client.patch('/api/projects/p/vms/web', json=policy)
                        self.assertEqual(response.status_code, 200)
                        self.assertEqual(getattr(self.project.vms[0], 'file_' + direction), enabled)
                        response = self.client.post('/api/projects/p/instances/actions/file_transfer', json={'targets': [target], **policy})
                        self.assertEqual(response.status_code, 200)
                        self.assertEqual(response.json['errors'], [])
                        written = upstream.set_qemu_options.call_args.kwargs['options']['description']
                        self.assertEqual(read_policy(written)['file_' + direction], enabled)
            with self.app.test_request_context('/'):
                self.assertNotIn('file_transfer_capabilities', api._project_to_json(self.project))
            get.assert_not_called()

    def test_sync_applies_template_defaults_to_all_instances(self):
        targets = []
        upstream = Mock()
        upstream.get_qemu_config.return_value = {'description': ''}
        def resolve(project, client, requested):
            targets.extend(requested)
            return ([{'index': row['index'], 'name': 'web-set-' + str(row['index']), 'node': 'node', 'vmid': 100 + row['index'], 'type': 'qemu'} for row in requested], [], [])
        with patch.object(api, 'ProxmoxClient', return_value=upstream), patch.object(api, '_resolve_targets_to_vm_info', side_effect=resolve):
            response = self.client.post('/api/projects/p/instances/actions/file_transfer', json={'templates': ['web']})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json['errors'], [])
        self.assertEqual([row['index'] for row in targets], [1, 2])
        self.assertEqual(upstream.set_qemu_options.call_count, 2)


class StrictNotesPolicyTests(unittest.TestCase):
    def test_ambiguous_notes_do_not_enable_other_direction(self):
        for notes in ['', '{"AccessForge":{"file_upload":"true"}}',
                      '{"AccessForge":{"file_upload":false,"file_upload":true}}',
                      '{"AccessForge":{"file_upload":true}}\n{"AccessForge":{"file_upload":true}}',
                      '{broken "AccessForge":{"file_upload":true}}']:
            self.assertEqual(read_policy(notes), {'file_upload': False, 'file_download': False})
        self.assertEqual(read_policy('{"AccessForge":{"file_upload":true,"file_download":false}}'),
                         {'file_upload': True, 'file_download': False})
