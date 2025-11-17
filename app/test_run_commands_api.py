import base64
import io
import json
import unittest
import zipfile
from contextlib import ExitStack
from unittest.mock import MagicMock, patch

from app import create_app
from app.storage.projects import Project, StartCommand, StartCommandStep, VMConfig


class _StoreStub:
    def __init__(self, project: Project):
        self._project = project

    def get(self, pid: str):
        if pid == self._project.id:
            return self._project
        return None


class RunCommandsApiTests(unittest.TestCase):

    def setUp(self):
        self.app = create_app()
        self.app.config['TESTING'] = True
        self.client = self.app.test_client()
        start_steps = [
            StartCommandStep(commands=[StartCommand(command='echo start', timeout_seconds=90)]),
            StartCommandStep(commands=[StartCommand(command='hostname', timeout_seconds=60)]),
        ]
        stored_steps = [
            StartCommandStep(commands=[StartCommand(command='echo ready')]),
            StartCommandStep(commands=[StartCommand(command='uptime')]),
        ]
        vm = VMConfig(name='alpha', start_commands=start_steps, stored_commands=stored_steps)
        vm.template_name = 'tmplAlpha'
        vm.template_id = '9000'
        self.project = Project(id='proj-run', name='Run Project', tag='-lab-', vms=[vm])
        self.template_key = f"{self.project.id}|{vm.template_name}|{vm.template_id}"
        self.target_name = f"{vm.name}{self.project.tag}1"

    def _decode_outputs_zip(self, zip_info: dict):
        self.assertIsInstance(zip_info, dict)
        raw = base64.b64decode(zip_info['base64'])
        with zipfile.ZipFile(io.BytesIO(raw)) as zf:
            summary_bytes = zf.read('summary.json')
        return json.loads(summary_bytes.decode('utf-8'))

    def _common_patches(self, project: Project = None):
        project = project or self.project
        mapped = [{'index': 1, 'name': self.target_name, 'vmid': 101, 'node': 'node1'}]
        return [
            patch('app.routes.api._store', return_value=_StoreStub(project)),
            patch('app.routes.api._resolve_targets_to_vm_info', return_value=(mapped, [], [])),
            patch('app.routes.api._start_job'),
            patch('app.routes.api._end_job'),
            patch('app.routes.api._job_emit_command_status'),
            patch('app.routes.api._job_emit_delay_status'),
            patch('app.routes.api._safe_sleep'),
        ]

    def test_run_startup_cmds_executes_commands_and_returns_zip(self):
        with ExitStack() as stack:
            for ctx in self._common_patches():
                stack.enter_context(ctx)
            mock_client_cls = stack.enter_context(patch('app.routes.api.ProxmoxClient'))
            mock_client = MagicMock()
            mock_client_cls.return_value = mock_client
            mock_client.ensure_guest_agent_ready.return_value = None
            mock_client.agent_exec.side_effect = [
                {'exitcode': 0, 'stdout': 'start ok', 'stderr': ''},
                {'exitcode': 0, 'stdout': 'host ok', 'stderr': ''},
            ]

            resp = self.client.post(
                f'/api/projects/{self.project.id}/instances/actions/run_startup_cmds',
                json={
                    'username': 'root@pam',
                    'password': 'secret',
                    'baseUrl': 'https://proxmox.local',
                    'targets': [{'index': 1, 'name': self.target_name}],
                },
            )

            self.assertEqual(resp.status_code, 200)
            payload = resp.get_json()
            ran = payload.get('ran') or []
            self.assertEqual(len(ran), 1)
            cmds = ran[0].get('cmds') or []
            self.assertEqual(len(cmds), 2)
            issued_commands = [call.kwargs['command'] for call in mock_client.agent_exec.call_args_list]
            self.assertCountEqual(issued_commands, ['echo start', 'hostname'])
            zip_info = payload.get('outputs_zip')
            self.assertIsNotNone(zip_info, 'expected outputs_zip in response')
            self.assertTrue(zip_info['filename'].startswith('startup_cmd_outputs_'))
            self.assertGreater(len(base64.b64decode(zip_info['base64'])), 0)
            summary = self._decode_outputs_zip(zip_info)
            self.assertEqual(summary.get('ran_hosts'), 1)
            command_list = summary.get('commands') or []
            self.assertEqual(len(command_list), 2)
            self.assertCountEqual([c.get('command') for c in command_list], ['echo start', 'hostname'])

    def test_run_stored_cmds_honors_selection_and_overrides(self):
        override_text = 'sudo echo override'
        with ExitStack() as stack:
            for ctx in self._common_patches():
                stack.enter_context(ctx)
            mock_client_cls = stack.enter_context(patch('app.routes.api.ProxmoxClient'))
            mock_client = MagicMock()
            mock_client_cls.return_value = mock_client
            mock_client.agent_exec.return_value = {'exitcode': 0, 'stdout': 'override ok', 'stderr': ''}

            resp = self.client.post(
                f'/api/projects/{self.project.id}/instances/actions/run_stored_cmds',
                json={
                    'username': 'root@pam',
                    'password': 'secret',
                    'baseUrl': 'https://proxmox.local',
                    'targets': [{'index': 1, 'name': self.target_name}],
                    'commands': ['echo ready'],
                    'storedCommandOverrides': [
                        {
                            'templateKey': self.template_key,
                            'stepIndex': 1,
                            'commandIndex': 1,
                            'text': override_text,
                        }
                    ],
                },
            )

            self.assertEqual(resp.status_code, 200)
            payload = resp.get_json()
            ran = payload.get('ran') or []
            self.assertEqual(len(ran), 1)
            cmds = ran[0].get('cmds') or []
            self.assertEqual(len(cmds), 1)
            self.assertEqual(cmds[0].get('cmd'), override_text)
            mock_client.agent_exec.assert_called_once()
            self.assertEqual(mock_client.agent_exec.call_args.kwargs['command'], override_text)
            self.assertEqual(ran[0].get('selected_command'), 'echo ready')
            self.assertEqual(payload.get('requested_command'), 'echo ready')
            zip_info = payload.get('outputs_zip')
            self.assertIsNotNone(zip_info, 'expected outputs_zip in response')
            self.assertTrue(zip_info['filename'].startswith('stored_cmd_outputs_'))
            self.assertGreater(len(base64.b64decode(zip_info['base64'])), 0)
            summary = self._decode_outputs_zip(zip_info)
            self.assertEqual(summary.get('requested_command'), 'echo ready')
            command_list = summary.get('commands') or []
            self.assertEqual(len(command_list), 1)
            self.assertEqual(command_list[0].get('command'), override_text)

    def test_run_startup_cmds_reports_skipped_when_no_commands(self):
        vm = VMConfig(name='alpha', start_commands=[], stored_commands=[])
        project = Project(id='proj-run', name='Run Project', tag='-lab-', vms=[vm])
        with ExitStack() as stack:
            for ctx in self._common_patches(project):
                stack.enter_context(ctx)
            mock_client_cls = stack.enter_context(patch('app.routes.api.ProxmoxClient'))
            mock_client = MagicMock()
            mock_client.ensure_guest_agent_ready.return_value = None
            mock_client.agent_exec.return_value = {'exitcode': 0, 'stdout': '', 'stderr': ''}
            mock_client_cls.return_value = mock_client

            resp = self.client.post(
                f'/api/projects/{project.id}/instances/actions/run_startup_cmds',
                json={
                    'username': 'root@pam',
                    'password': 'secret',
                    'baseUrl': 'https://proxmox.local',
                    'targets': [{'index': 1, 'name': self.target_name}],
                },
            )

            self.assertEqual(resp.status_code, 200)
            payload = resp.get_json()
            self.assertEqual(payload.get('ran'), [])
            skipped = payload.get('skipped') or []
            self.assertEqual(len(skipped), 1)
            self.assertIn('no startup commands', skipped[0].get('reason', ''))
            self.assertNotIn('outputs_zip', payload)
            mock_client.agent_exec.assert_not_called()

    def test_run_stored_cmds_flags_missing_selected_command(self):
        missing_command = 'echo missing'
        with ExitStack() as stack:
            for ctx in self._common_patches():
                stack.enter_context(ctx)
            mock_client_cls = stack.enter_context(patch('app.routes.api.ProxmoxClient'))
            mock_client = MagicMock()
            mock_client.agent_exec.return_value = {'exitcode': 0, 'stdout': 'ok', 'stderr': ''}
            mock_client_cls.return_value = mock_client

            resp = self.client.post(
                f'/api/projects/{self.project.id}/instances/actions/run_stored_cmds',
                json={
                    'username': 'root@pam',
                    'password': 'secret',
                    'baseUrl': 'https://proxmox.local',
                    'targets': [{'index': 1, 'name': self.target_name}],
                    'commands': [missing_command],
                },
            )

            self.assertEqual(resp.status_code, 200)
            payload = resp.get_json()
            self.assertEqual(payload.get('ran'), [])
            skipped = payload.get('skipped') or []
            self.assertEqual(len(skipped), 1)
            self.assertIn('stored command not configured', skipped[0].get('reason', ''))
            self.assertEqual(payload.get('requested_commands'), [missing_command])
            self.assertEqual(payload.get('requested_command'), missing_command)
            self.assertNotIn('outputs_zip', payload)
            mock_client.agent_exec.assert_not_called()


if __name__ == '__main__':
    unittest.main()
