import unittest
from unittest.mock import MagicMock, patch

from app.connectors.proxmox import ProxmoxClient
from test_proxmox_users import _Response


class OrchestrationGroupTests(unittest.TestCase):
    def setUp(self):
        self.client = ProxmoxClient(base_url='https://pve.lab', token='test-token')
        self.session = MagicMock()
        self.session.put.return_value = _Response()
        self.patch = patch.object(self.client, '_ensure_session', return_value=self.session)
        self.patch.start()
        self.addCleanup(self.patch.stop)

    def test_enable_appends_without_replacing_existing_groups_or_password(self):
        with patch.object(self.client, 'get_user', side_effect=[{'groups': ['students']}, {'groups': ['students', 'caf-orchestrator']}]):
            self.assertTrue(self.client.set_user_group('alice@pve', 'caf-orchestrator', enabled=True))
        self.assertEqual(self.session.put.call_args.kwargs['data'], {'groups': 'caf-orchestrator', 'append': 1})
        self.assertTrue(self.session.put.call_args.args[0].endswith('/access/users/alice%40pve'))

    def test_disable_removes_only_orchestrator_group(self):
        with patch.object(self.client, 'get_user', side_effect=[{'groups': 'students,caf-orchestrator,other'}, {'groups': ['students', 'other']}]):
            self.assertTrue(self.client.set_user_group('alice@pve', 'caf-orchestrator', enabled=False))
        self.assertEqual(self.session.put.call_args.kwargs['data'], {'groups': 'students,other', 'append': 0})

    def test_removing_last_group_uses_explicit_empty_membership(self):
        with patch.object(self.client, 'get_user', side_effect=[{'groups': ['caf-orchestrator']}, {'groups': []}]):
            self.client.set_user_group('alice@pve', 'caf-orchestrator', enabled=False)
        self.assertEqual(self.session.put.call_args.kwargs['data'], {'groups': '', 'append': 0})

    def test_already_in_requested_state_does_not_mutate(self):
        for enabled, groups in [(True, ['caf-orchestrator']), (False, ['students'])]:
            with patch.object(self.client, 'get_user', return_value={'groups': groups}):
                self.assertFalse(self.client.set_user_group('alice@pve', 'caf-orchestrator', enabled=enabled))
        self.session.put.assert_not_called()

    def test_missing_or_incomplete_user_data_cannot_erase_other_memberships(self):
        for record in (None, {}, {'groups': None}, {'groups': {'students': True}}):
            with patch.object(self.client, 'get_user', return_value=record), self.assertRaises(ValueError):
                self.client.set_user_group('alice@pve', 'caf-orchestrator', enabled=False)
        self.session.put.assert_not_called()

    def test_write_failure_and_verification_mismatch_are_not_success(self):
        with patch.object(self.client, 'get_user', return_value={'groups': []}):
            self.session.put.return_value = _Response(status_code=403, text='PRIVATE')
            with self.assertRaisesRegex(RuntimeError, 'HTTP 403'):
                self.client.set_user_group('alice@pve', 'caf-orchestrator', enabled=True)
            self.session.put.return_value = _Response()
            with self.assertRaisesRegex(RuntimeError, 'verification failed'):
                self.client.set_user_group('alice@pve', 'caf-orchestrator', enabled=True)

    def test_group_created_once_without_roles(self):
        self.session.get.return_value = _Response(data=[])
        self.session.post.return_value = _Response()
        self.assertTrue(self.client.ensure_group('caf-orchestrator', 'Enrollment'))
        self.assertEqual(self.session.post.call_args.kwargs['data'], {'groupid': 'caf-orchestrator', 'comment': 'Enrollment'})
        self.session.get.return_value = _Response(data=[{'groupid': 'caf-orchestrator'}])
        self.assertFalse(self.client.ensure_group('caf-orchestrator', 'Enrollment'))
        self.session.post.assert_called_once()

    def test_group_lookup_failure_never_creates_or_swallows_error(self):
        self.session.get.return_value = _Response(status_code=403)
        with self.assertRaisesRegex(RuntimeError, 'HTTP 403'):
            self.client.ensure_group('caf-orchestrator')
        self.session.post.assert_not_called()
