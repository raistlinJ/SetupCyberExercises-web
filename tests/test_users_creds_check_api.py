import unittest
from contextlib import ExitStack
from unittest.mock import MagicMock, patch

from app import create_app
from app.storage.projects import Project, VMConfig


class _StoreStub:
	def __init__(self, project: Project):
		self._project = project

	def get(self, pid: str):
		if pid == self._project.id:
			return self._project
		return None


class UsersCredsCheckApiTests(unittest.TestCase):

	def setUp(self):
		self.app = create_app()
		self.app.config['TESTING'] = True
		self.client = self.app.test_client()
		self.project = Project(id='proj-creds-check', name='Creds Check Project')
		self.project.instances = 1
		self.project.tag = '-set-'
		self.project.proxmox_url = 'https://proxmox.local'
		self.project.credentials = [{'username': 'alice', 'password': 'password1'}]
		self.project.vms = [VMConfig(name='web', viewable_to_user=True)]

	def _common_patches(self, mapped=None):
		mapped = mapped or [{'index': 1, 'name': f'web{self.project.tag}1', 'vmid': 101, 'node': 'node1'}]
		return [
			patch('app.routes.api._store', return_value=_StoreStub(self.project)),
			patch('app.routes.api._resolve_targets_to_vm_info', return_value=(mapped, [], [])),
			patch('app.routes.api._start_job'),
			patch('app.routes.api._end_job'),
		]

	def test_users_creds_check_reports_in_sync_row(self):
		with ExitStack() as stack:
			for ctx in self._common_patches():
				stack.enter_context(ctx)
			mock_client_cls = stack.enter_context(patch('app.routes.api.ProxmoxClient'))
			manager_client = MagicMock()
			participant_client = MagicMock()
			mock_client_cls.side_effect = [manager_client, participant_client]
			manager_client.get_user.return_value = {'userid': 'alice@pve'}
			manager_client.get_pool.return_value = {'poolid': 'alice'}
			manager_client.list_pool_members.return_value = [{'type': 'qemu', 'vmid': 101}]
			manager_client.list_acls.return_value = [
				{'ugid': 'alice@pve', 'path': '/vms/101', 'roleid': 'PVEUser', 'type': 'user', 'propagate': 1},
			]
			participant_client.list_nodes.return_value = [{'node': 'node1'}]

			resp = self.client.post(
				f'/api/projects/{self.project.id}/instances/actions/users_creds_check',
				json={
					'targets': [{'index': 1, 'name': f'web{self.project.tag}1'}],
					'username': 'root@pam',
					'password': 'secret',
					'baseUrl': 'https://proxmox.local',
					'verifySSL': False,
				},
			)

			self.assertEqual(resp.status_code, 200)
			body = resp.get_json() or {}
			checked = body.get('checked') or []
			self.assertEqual(len(checked), 1)
			row = checked[0]
			self.assertEqual(row.get('userid'), 'alice@pve')
			self.assertTrue(row.get('user_exists'))
			self.assertTrue(row.get('password_verified'))
			self.assertTrue(row.get('pool_exists'))
			self.assertTrue(row.get('pool_member'))
			self.assertEqual(row.get('expected_access'), 'user')
			self.assertEqual(row.get('actual_roles'), ['PVEUser'])
			self.assertEqual(row.get('status'), 'ok')

	def test_users_creds_check_reports_password_pool_and_role_drift(self):
		self.project.vms = [VMConfig(name='web', viewable_to_user=False)]
		self.project.proxmox_assign_rollback_on_non_viewable = True
		with ExitStack() as stack:
			for ctx in self._common_patches():
				stack.enter_context(ctx)
			mock_client_cls = stack.enter_context(patch('app.routes.api.ProxmoxClient'))
			manager_client = MagicMock()
			participant_client = MagicMock()
			mock_client_cls.side_effect = [manager_client, participant_client]
			manager_client.get_user.return_value = {'userid': 'alice@pve'}
			manager_client.get_pool.return_value = {'poolid': 'alice'}
			manager_client.list_pool_members.return_value = []
			manager_client.list_acls.return_value = [
				{'ugid': 'alice@pve', 'path': '/vms/101', 'roleid': 'PVEUser', 'type': 'user', 'propagate': 1},
			]
			participant_client.list_nodes.side_effect = RuntimeError('login failed')

			resp = self.client.post(
				f'/api/projects/{self.project.id}/instances/actions/users_creds_check',
				json={
					'targets': [{'index': 1, 'name': f'web{self.project.tag}1'}],
					'username': 'root@pam',
					'password': 'secret',
					'baseUrl': 'https://proxmox.local',
					'verifySSL': False,
				},
			)

			self.assertEqual(resp.status_code, 200)
			body = resp.get_json() or {}
			checked = body.get('checked') or []
			self.assertEqual(len(checked), 1)
			row = checked[0]
			self.assertFalse(row.get('password_verified'))
			self.assertTrue(row.get('pool_exists'))
			self.assertFalse(row.get('pool_member'))
			self.assertEqual(row.get('expected_access'), 'rollback')
			self.assertEqual(row.get('actual_roles'), ['PVEUser'])
			self.assertEqual(row.get('status'), 'drift')
			self.assertIn('password login failed', row.get('reason') or '')
			self.assertIn('vm missing from pool', row.get('reason') or '')
			self.assertIn('missing rollback role', row.get('reason') or '')
			self.assertIn('has user-access role unexpectedly', row.get('reason') or '')


if __name__ == '__main__':
	unittest.main()
