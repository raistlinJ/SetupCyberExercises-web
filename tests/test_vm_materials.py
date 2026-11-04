import json
import os
import tempfile
import unittest
from unittest.mock import MagicMock, Mock, patch

from app import create_app
from app.file_transfer import read_policy, write_policy
from app.materials import normalize_material_links
from app.routes import api
from app.storage.projects import Project, ProjectStore, VMConfig


LINKS = [{'title': 'Reference PDF', 'url': 'https://example.edu/reference.pdf'}]


def metadata(description):
    return next(obj['AccessForge'] for obj in api._iter_json_dicts_from_text(description)
                if 'AccessForge' in obj)


class VmMaterialsTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        with patch.dict(os.environ, {'AUTH_ENABLE': '0', 'DATA_DIR': self.tmp.name}):
            self.app = create_app()
        self.app.config.update(TESTING=True, AUTH_ENABLE=False, API_KEY=None)
        self.client = self.app.test_client()
        self.project = Project(id='p', name='Demo', instances=2, tag='-set-',
                               proxmox_url='https://node.test', proxmox_api_token='test',
                               vms=[VMConfig(name='web', materials=LINKS, material_category='Networking')])
        self.store = ProjectStore(self.tmp.name)
        self.store.upsert(self.project)
        self.store_patch = patch.object(api, '_store', return_value=self.store)
        self.store_patch.start()

    def tearDown(self):
        self.store_patch.stop()
        self.tmp.cleanup()

    def test_save_reload_rename_and_export_import_preserve_materials(self):
        route = '/api/projects/p/vms/web'
        result = self.client.patch(route, json={'materials': LINKS * 2, 'material_category': ' Lab guides '})
        self.assertEqual(result.status_code, 200)
        vm = ProjectStore(self.tmp.name).get('p').vms[0]
        self.assertEqual(vm.materials, LINKS)
        self.assertEqual(vm.material_category, 'Lab guides')
        # Navigation reloads configuration from this endpoint, not the browser cache.
        projects = self.client.get('/api/projects').json['projects']
        reloaded = next(project for project in projects if project['id'] == 'p')['vms'][0]
        self.assertEqual(reloaded['materials'], LINKS)
        self.assertEqual(reloaded['material_category'], 'Lab guides')
        with patch.dict(os.environ, {'AUTH_ENABLE': '0', 'DATA_DIR': self.tmp.name}):
            restarted = create_app()
        try:
            projects = restarted.test_client().get('/api/projects').json['projects']
            reloaded = next(project for project in projects if project['id'] == 'p')['vms'][0]
            self.assertEqual(reloaded['materials'], LINKS)
            self.assertEqual(reloaded['material_category'], 'Lab guides')
        finally:
            if queue := restarted.extensions.get('action_queue'):
                queue.close()
        renamed = self.store.rename_vm('p', 'web', 'renamed')
        self.assertEqual(renamed.vms[0].materials, LINKS)
        self.assertEqual(renamed.vms[0].material_category, 'Lab guides')
        with self.app.app_context():
            exported = api._project_to_json_filtered(renamed, include_creds=False, include_vms=False)
        imported = api._sanitize_import_vms(exported['vms'], keep_vmid=False, include_creds=False)
        vm = self.store._coerce_vm(imported[0])
        self.assertEqual(vm.materials, LINKS)
        self.assertEqual(vm.material_category, 'Lab guides')

    def test_configuration_save_does_not_require_proxmox_connection(self):
        with patch.object(api, 'ProxmoxClient', side_effect=AssertionError('Unexpected connection')):
            result = self.client.patch('/api/projects/p/vms/web', json={'materials': [], 'material_category': ''})
        self.assertEqual(result.status_code, 200)
        vm = self.store.get('p').vms[0]
        self.assertEqual(vm.materials, [])
        self.assertEqual(vm.material_category, '')

    def test_invalid_links_are_rejected_before_persistence(self):
        invalid = [None, {}, 'text', [None], [{}], [{'title': 'x', 'url': 'javascript:alert(1)'}],
                   [{'title': 'x', 'url': 'file:///tmp/test'}], [{'title': 'x', 'url': '/test.pdf'}],
                   [{'title': 'x', 'url': 'https://[bad'}], [{'title': 'x', 'url': 'https://example.edu:99999'}],
                   [{'title': 'x', 'url': 'https://example.edu/a\nb'}],
                   [{'title': ' ', 'url': 'https://example.edu'}]]
        for links in invalid:
            with self.subTest(links=links):
                result = self.client.patch('/api/projects/p/vms/web', json={'materials': links})
                self.assertEqual(result.status_code, 400)
                self.assertEqual(self.store.get('p').vms[0].materials, LINKS)
        self.assertEqual(self.client.patch('/api/projects/p/vms/web', json={'material_category': 123}).status_code, 400)

    def test_sync_updates_qemu_and_lxc_without_altering_live_policy_or_other_notes(self):
        for guest_type in ('qemu', 'lxc'):
            with self.subTest(guest_type=guest_type):
                target = {'index': 1, 'name': 'web-set-1', 'node': 'node', 'vmid': 101, 'type': guest_type}
                upstream = Mock()
                original = 'Human notes\n{"Scenario":"Demo","User":"student"}\n' + json.dumps({
                    'AccessForge': {'file_upload': True, 'file_download': False, 'custom': 'preserved'}})
                getter = upstream.get_lxc_config if guest_type == 'lxc' else upstream.get_qemu_config
                setter = upstream.set_lxc_options if guest_type == 'lxc' else upstream.set_qemu_options
                getter.return_value = {'digest': 'abc', 'description': original}
                with patch.object(api, 'ProxmoxClient', return_value=upstream), patch.object(
                    api, '_resolve_targets_to_vm_info', return_value=([target], [], [])):
                    result = self.client.post('/api/projects/p/instances/actions/materials', json={'templates': ['web']})
                self.assertEqual(result.status_code, 200)
                self.assertEqual(result.json['errors'], [])
                options = setter.call_args.kwargs['options']
                self.assertEqual(options['digest'], 'abc')
                self.assertIn('Human notes', options['description'])
                self.assertIn('"User":"student"', options['description'])
                self.assertEqual(metadata(options['description']), {
                    'Material Category': 'Networking', 'materials': LINKS,
                    'file_upload': True, 'file_download': False, 'custom': 'preserved'})

    def test_clearing_removes_previous_title_and_links(self):
        self.client.patch('/api/projects/p/vms/web', json={'materials': [], 'material_category': ''})
        upstream = Mock()
        upstream.get_qemu_config.return_value = {'description': json.dumps({'AccessForge': {
            'Material Category': 'Old', 'materials': LINKS, 'file_upload': True}})}
        target = {'index': 1, 'name': 'web-set-1', 'node': 'node', 'vmid': 101, 'type': 'qemu'}
        with patch.object(api, 'ProxmoxClient', return_value=upstream), patch.object(
            api, '_resolve_targets_to_vm_info', return_value=([target], [], [])):
            result = self.client.post('/api/projects/p/instances/actions/materials', json={'templates': ['web']})
        self.assertEqual(result.json['errors'], [])
        written = metadata(upstream.set_qemu_options.call_args.kwargs['options']['description'])
        self.assertEqual(written['Material Category'], 'Misc')
        self.assertEqual(written['materials'], [])
        self.assertTrue(written['file_upload'])

    def test_only_admin_can_apply_links_to_existing_instances(self):
        self.app.config['AUTH_ENABLE'] = True
        self.app.current_user = lambda: {'roles': ['user']}
        self.assertEqual(self.client.post('/api/projects/p/instances/actions/materials', json={'templates': ['web']}).status_code, 403)

    def test_transfer_changes_preserve_materials_and_category(self):
        original = json.dumps({'AccessForge': {'materials': LINKS, 'Material Category': 'Demo', 'file_upload': True}})
        written = write_policy(original, {'file_upload': False, 'file_download': True})
        self.assertEqual(metadata(written)['materials'], LINKS)
        self.assertEqual(metadata(written)['Material Category'], 'Demo')
        self.assertEqual(read_policy(written), {'file_upload': False, 'file_download': True})

    def test_apply_scenario_includes_materials_on_both_guest_types(self):
        self.store.update_vm('p', 'web', vm_user='student', vm_pass='guest-password')
        for guest_type in ('qemu', 'lxc'):
            with self.subTest(guest_type=guest_type):
                target = {'index': 1, 'name': 'web-set-1', 'node': 'node', 'vmid': 101, 'type': guest_type}
                upstream = Mock()
                getter = upstream.get_lxc_config if guest_type == 'lxc' else upstream.get_qemu_config
                setter = upstream.set_lxc_options if guest_type == 'lxc' else upstream.set_qemu_options
                getter.return_value = {'description': 'Human notes\n{"Scenario":"Old","User":"old-user"}\n' +
                                       json.dumps({'AccessForge': {'custom': 'preserved', 'materials': []}})}
                with patch.object(api, 'ProxmoxClient', return_value=upstream), patch.object(
                    api, '_resolve_targets_to_vm_info', return_value=([target], [], [])):
                    result = self.client.post('/api/projects/p/instances/actions/apply_scenario', json={'targets': [target]})
                self.assertEqual(result.status_code, 200)
                self.assertEqual(result.json['errors'], [])
                description = setter.call_args.kwargs['options']['description']
                self.assertIn('Human notes', description)
                credentials = next(obj for obj in api._iter_json_dicts_from_text(description) if 'Scenario' in obj)
                self.assertEqual(credentials, {'Scenario': 'Demo', 'User': 'student', 'Pass': 'guest-password'})
                published = metadata(description)
                self.assertEqual(published['materials'], LINKS)
                self.assertEqual(published['Material Category'], 'Networking')
                self.assertEqual(published['custom'], 'preserved')

    def test_new_qemu_and_lxc_clones_receive_materials(self):
        for guest_type in ('qemu', 'lxc'):
            with self.subTest(guest_type=guest_type):
                project = self.store.get('p')
                project.vms[0].vm_type = guest_type
                self.store.upsert(project)
                upstream = MagicMock()
                upstream.list_nodes.return_value = [{'node': 'node'}]
                source = [{'vmid': 900, 'name': 'web', 'template': 1}]
                upstream.list_qemu_vms.return_value = source if guest_type == 'qemu' else []
                upstream.list_lxc_vms.return_value = source if guest_type == 'lxc' else []
                upstream.clone_qemu.return_value = upstream.clone_lxc.return_value = 'UPID:clone'
                upstream._wait_task.return_value = None
                upstream.get_qemu_config.return_value = upstream.get_lxc_config.return_value = {}
                upstream.list_network.return_value = []
                with patch.object(api, 'ProxmoxClient', return_value=upstream), \
                        patch.object(api.random, 'randint', return_value=10001), \
                        patch.object(api, '_safe_sleep', return_value=None):
                    result = self.client.post('/api/projects/p/instances/actions/create', json={
                        'targets': [{'index': 1, 'name': 'web'}], 'applyScenario': True,
                        'syncUserAccess': False, 'setNetworkInterfaces': False, 'takeSnapshot': False,
                    })
                self.assertEqual(result.status_code, 200)
                self.assertEqual(len(result.json['created']), 1)
                self.assertFalse([error for error in result.json['errors']
                                  if not error.get('reason', '').startswith('ageing skipped:')])
                setter = upstream.set_lxc_options if guest_type == 'lxc' else upstream.set_qemu_options
                descriptions = [call.kwargs['options'].get('description', '') for call in setter.call_args_list]
                published = [metadata(desc) for desc in descriptions if 'AccessForge' in desc]
                self.assertTrue(published)
                self.assertEqual(published[-1]['materials'], LINKS)
                self.assertEqual(published[-1]['Material Category'], 'Networking')


class MaterialNormalizationTests(unittest.TestCase):
    def test_legacy_and_imported_data_have_safe_defaults(self):
        self.assertEqual(normalize_material_links(None), [])
        self.assertEqual(normalize_material_links([{}, *LINKS, *LINKS]), LINKS)
        normalized = normalize_material_links([{'title': ' A & B ', 'url': ' http://example.edu/?a=1&b=2 '}], strict=True)
        self.assertEqual(normalized, [{'title': 'A & B', 'url': 'http://example.edu/?a=1&b=2'}])
