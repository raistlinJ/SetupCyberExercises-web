import json
from unittest.mock import Mock, patch
from unittest import TestCase

import pytest
from app.clipboard_policy import parse_clipboard_policy, validate_clipboard_update
from app.file_transfer import read_accessforge_metadata
from app.routes import api
import test_file_transfer_policy as transfer_tests


@pytest.mark.parametrize('limit', [-1, True, 1.5, '100', 1_000_000_001])
def test_invalid_limits_are_rejected(limit):
    with pytest.raises(ValueError):
        validate_clipboard_update({'clipboard_to_vm_limit': limit})
    assert not parse_clipboard_policy({'clipboard_to_vm_limit': limit})['to_vm']['enabled']


@pytest.mark.parametrize('notes', [None, 'Human notes only', '{"AccessForge":{}}'])
def test_unconfigured_clipboard_in_vm_notes_defaults_to_enabled(notes):
    rules = parse_clipboard_policy(read_accessforge_metadata(notes, default={}))
    assert all(rule['enabled'] and rule['limit'] is None for rule in rules.values())


class ClipboardApiTests(TestCase):
    setUp = transfer_tests.TransferPolicyTests.setUp
    tearDown = transfer_tests.TransferPolicyTests.tearDown
    update_vm = transfer_tests.TransferPolicyTests.update_vm

    def test_clipboard_update_preserves_other_direction_files_materials_and_digest(self):
        target = {'index': 1, 'name': 'web-set-1', 'node': 'n', 'vmid': 101, 'type': 'qemu'}
        existing = {'file_upload': True, 'clipboard_from_vm': False, 'clipboard_from_vm_limit': 300,
                    'clipboard_from_vm_reset': 'old', 'materials': [{'title': 'Lab', 'url': 'https://example.org'}]}
        upstream = Mock()
        upstream.get_qemu_config.return_value = {'digest': 'abc', 'description': 'Notes\n'+json.dumps({'AccessForge': existing})}
        with patch.object(api, 'ProxmoxClient', return_value=upstream), patch.object(api, '_resolve_targets_to_vm_info', return_value=([target], [], [])):
            result = self.client.post('/api/projects/p/instances/actions/clipboard', json={
                'targets': [target], 'clipboard_to_vm': True, 'clipboard_to_vm_limit': 50})
        assert result.status_code == 200 and not result.json['errors']
        options = upstream.set_qemu_options.call_args.kwargs['options']
        assert options['digest'] == 'abc'
        metadata = read_accessforge_metadata(options['description'])
        for key, value in existing.items():
            assert metadata[key] == value
        assert metadata['clipboard_to_vm_limit'] == 50
        assert len(metadata['clipboard_id']) == 32
        assert 'clipboard_to_vm_reset' not in metadata

    def test_reset_changes_epochs_without_changing_policy_or_scope(self):
        self.project.vms[0].viewable_to_user = False
        target = {'index': 1, 'name': 'web-set-1', 'node': 'n', 'vmid': 101, 'type': 'qemu'}
        existing = {'clipboard_id': 'vm-scope', 'clipboard_to_vm': True, 'clipboard_to_vm_limit': 10,
                    'clipboard_to_vm_reset': 'old', 'clipboard_from_vm_limit': 30, 'file_download': True}
        upstream = Mock()
        upstream.get_qemu_config.return_value = {'description': json.dumps({'AccessForge': existing})}
        with patch.object(api, 'ProxmoxClient', return_value=upstream), patch.object(api, '_resolve_targets_to_vm_info', return_value=([target], [], [])):
            result = self.client.post('/api/projects/p/instances/actions/clipboard', json={'targets': [target], 'reset_counts': True})
        assert result.status_code == 200 and not result.json['errors']
        metadata = read_accessforge_metadata(upstream.set_qemu_options.call_args.kwargs['options']['description'])
        assert metadata['clipboard_to_vm_reset'] != 'old'
        assert len(metadata['clipboard_from_vm_reset']) == 32
        for key in ('clipboard_id', 'clipboard_to_vm', 'clipboard_to_vm_limit', 'clipboard_from_vm_limit', 'file_download'):
            assert metadata[key] == existing[key]

    def test_non_admin_and_invalid_request_cannot_modify_clipboard(self):
        for invalid in ({'clipboard_to_vm_limit': True}, {'clipboard_to_vm': 'true'}, {'reset_counts': 'true'}, {}):
            assert self.client.post('/api/projects/p/instances/actions/clipboard', json=invalid).status_code == 400
        self.app.config['AUTH_ENABLE'] = True
        self.app.current_user = lambda: {'roles': ['user']}
        assert self.client.post('/api/projects/p/instances/actions/clipboard', json={'clipboard_to_vm': True}).status_code == 403

    def test_first_allowance_and_reset_keep_default_access_enabled(self):
        target = {'index': 1, 'name': 'web-set-1', 'node': 'n', 'vmid': 101, 'type': 'qemu'}
        upstream = Mock()
        upstream.get_qemu_config.return_value = {'description': 'Human notes only'}
        with patch.object(api, 'ProxmoxClient', return_value=upstream), patch.object(api, '_resolve_targets_to_vm_info', return_value=([target], [], [])):
            result = self.client.post('/api/projects/p/instances/actions/clipboard', json={
                'targets': [target], 'clipboard_to_vm_limit': 2000, 'reset_counts': True})
        assert result.status_code == 200 and not result.json['errors']
        metadata = read_accessforge_metadata(upstream.set_qemu_options.call_args.kwargs['options']['description'])
        rules = parse_clipboard_policy(metadata)
        assert rules['to_vm']['enabled'] is True and rules['to_vm']['limit'] == 2000
        assert rules['from_vm']['enabled'] is True and rules['from_vm']['limit'] is None
        assert metadata['clipboard_to_vm_reset'] and metadata['clipboard_from_vm_reset']

    def test_malformed_policy_cannot_be_reset_into_default_access(self):
        target = {'index': 1, 'name': 'web-set-1', 'node': 'n', 'vmid': 101, 'type': 'qemu'}
        upstream = Mock()
        upstream.get_qemu_config.return_value = {'description': '{"AccessForge":false}'}
        with patch.object(api, 'ProxmoxClient', return_value=upstream), patch.object(api, '_resolve_targets_to_vm_info', return_value=([target], [], [])):
            result = self.client.post('/api/projects/p/instances/actions/clipboard', json={
                'targets': [target], 'reset_counts': True})
        assert 'Repair malformed AccessForge policy' in result.json['errors'][0]['reason']
        upstream.set_qemu_options.assert_not_called()
