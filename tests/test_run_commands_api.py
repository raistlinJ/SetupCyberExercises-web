import base64
import concurrent.futures
import io
import json
import unittest
import threading
import time
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


class _RuntimeStoreStub:
    def __init__(self):
        self.calls = []

    def set_vm_validation_state(self, project_id, vm_name, passed, vmid=None, node=None):
        self.calls.append({
            'project_id': project_id,
            'vm_name': vm_name,
            'passed': bool(passed),
            'vmid': vmid,
            'node': node,
        })
        return bool(passed)


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
        self.project.credentials = [{'username': 'student/one', 'password': 'private-password'}]
        self.template_key = f"{self.project.id}|{vm.template_name}|{vm.template_id}"
        self.target_name = f"{vm.name}{self.project.tag}1"

    def _decode_outputs_zip(self, zip_info: dict):
        self.assertIsInstance(zip_info, dict)
        raw = base64.b64decode(zip_info['base64'])
        with zipfile.ZipFile(io.BytesIO(raw)) as zf:
            summary_bytes = zf.read('summary.json')
            logs = [name for name in zf.namelist() if name.endswith('.txt')]
            self.assertTrue(logs)
            for name in logs:
                if name.split('/')[0].startswith(self.target_name):
                    self.assertTrue(name.split('/')[0].endswith('_student_one'), name)
                    self.assertIn('Username: student/one', zf.read(name).decode('utf-8'))
                self.assertNotIn('private-password', zf.read(name).decode('utf-8'))
            summary = json.loads(summary_bytes)
            for entry in summary['commands']:
                expected = 'student/one' if entry['vm_name'] == self.target_name else ''
                self.assertEqual(entry['username'], expected)
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

    def test_startup_and_stored_commands_render_resolved_instance_variables(self):
        template = 'configure {{instance_index}} {{vmid}} {{vm_name}}'
        for field, action in [('start_commands', 'run_startup_cmds'), ('stored_commands', 'run_stored_cmds')]:
            with self.subTest(action=action), ExitStack() as stack:
                setattr(self.project.vms[0], field, [StartCommandStep(commands=[StartCommand(command=template)])])
                for ctx in self._common_patches():
                    stack.enter_context(ctx)
                guest = stack.enter_context(patch('app.routes.api.ProxmoxClient')).return_value
                guest.agent_exec.return_value = {'exitcode': 0, 'stdout': 'configured', 'stderr': ''}
                response = self.client.post(
                    f'/api/projects/{self.project.id}/instances/actions/{action}',
                    json={'username': 'root@pam', 'password': 'secret', 'targets': [{'index': 1, 'name': self.target_name}]})
                self.assertEqual(response.status_code, 200)
                rendered = f'configure 1 101 {self.target_name}'
                self.assertEqual(guest.agent_exec.call_args.kwargs['command'], rendered)
                self.assertEqual(response.get_json()['ran'][0]['cmds'][0]['cmd'], rendered)
                self.assertEqual(getattr(self.project.vms[0], field)[0].commands[0].command, template)

    def test_saved_literal_mode_reaches_guest_unchanged(self):
        text = 'echo {{unknown}} {{vmid}}'
        for field, action in [('start_commands', 'run_startup_cmds'), ('stored_commands', 'run_stored_cmds')]:
            with self.subTest(action=action), ExitStack() as stack:
                setattr(self.project.vms[0], field, [StartCommandStep(commands=[
                    StartCommand(command=text, render_template_variables=False)])])
                for ctx in self._common_patches():
                    stack.enter_context(ctx)
                guest = stack.enter_context(patch('app.routes.api.ProxmoxClient')).return_value
                guest.agent_exec.return_value = {'exitcode': 0, 'stdout': '', 'stderr': ''}
                response = self.client.post(
                    f'/api/projects/{self.project.id}/instances/actions/{action}',
                    json={'username': 'root@pam', 'password': 'secret', 'targets': [{'index': 1, 'name': self.target_name}]})
                self.assertEqual(response.status_code, 200)
                self.assertEqual(guest.agent_exec.call_args.kwargs['command'], text)
                self.assertEqual(response.get_json()['ran'][0]['cmds'][0]['cmd'], text)

    def test_custom_command_render_toggle(self):
        for enabled in (False, True):
            with self.subTest(enabled=enabled), ExitStack() as stack:
                for ctx in self._common_patches():
                    stack.enter_context(ctx)
                guest = stack.enter_context(patch('app.routes.api.ProxmoxClient')).return_value
                guest.agent_exec.return_value = {'exitcode': 0, 'stdout': '', 'stderr': ''}
                response = self.client.post(
                    f'/api/projects/{self.project.id}/instances/actions/run_stored_cmds',
                    json={'username': 'root@pam', 'password': 'secret',
                          'targets': [{'index': 1, 'name': self.target_name}],
                          'customCommand': 'echo {{instance_index}}', 'renderTemplateVariables': enabled})
                self.assertEqual(response.status_code, 200)
                self.assertEqual(guest.agent_exec.call_args.kwargs['command'],
                                 'echo 1' if enabled else 'echo {{instance_index}}')
        with ExitStack() as stack:
            for ctx in self._common_patches():
                stack.enter_context(ctx)
            response = self.client.post(
                f'/api/projects/{self.project.id}/instances/actions/run_stored_cmds',
                json={'customCommand': 'echo hello', 'renderTemplateVariables': 'false'})
            self.assertEqual(response.status_code, 400)

    def test_validation_commands_render_per_guest_and_preserve_literal_mode(self):
        template = 'check {{instance_index}} {{vmid}} {{vm_name}} {{project_id}}'
        commands = [
            {'command': template, 'match': 'ready'},
            {'command': 'echo {{literal}}', 'match': '{{literal}}', 'is_regex': False,
             'render_template_variables': False},
        ]
        self.project.instances = 2
        self.project.vms[0].validation_commands = commands
        mapped = [
            {'index': index, 'name': f'alpha-lab-{index}', 'vmid': 100 + index, 'node': 'node1'}
            for index in (1, 2)
        ]
        with ExitStack() as stack:
            for ctx in self._common_patches():
                stack.enter_context(ctx)
            stack.enter_context(patch('app.routes.api._resolve_targets_to_vm_info', return_value=(mapped, [], [])))
            runtime = _RuntimeStoreStub()
            stack.enter_context(patch('app.routes.api._runtime_store', return_value=runtime))
            guest = stack.enter_context(patch('app.routes.api.ProxmoxClient')).return_value
            guest.agent_exec.return_value = {'exitcode': 0, 'stdout': 'ready {{literal}}', 'stderr': ''}
            response = self.client.post(
                f'/api/projects/{self.project.id}/instances/actions/run_stored_cmds',
                json={'username': 'root@pam', 'password': 'secret', 'validateOnly': True,
                      'targets': [{'index': m['index'], 'name': m['name']} for m in mapped]})
        self.assertEqual(response.status_code, 200)
        expected = [f'check {m["index"]} {m["vmid"]} {m["name"]} {self.project.id}' for m in mapped]
        expected += ['echo {{literal}}'] * 2
        self.assertCountEqual([call.kwargs['command'] for call in guest.agent_exec.call_args_list], expected)
        payload = response.get_json()
        self.assertTrue(all(entry['validation']['all_passed'] for entry in payload['ran']))
        self.assertCountEqual([result['command'] for entry in payload['ran']
                               for result in entry['validation']['results']], expected)
        summary = self._decode_outputs_zip(payload['outputs_zip'])
        self.assertCountEqual([entry['command'] for entry in summary['commands']], expected)
        self.assertEqual(commands[0]['command'], template)
        self.assertTrue(all(call['passed'] for call in runtime.calls))

    def test_invalid_validation_template_fails_without_dispatching_and_continues(self):
        self.project.vms[0].validation_commands = [
            {'command': 'echo {{unknown}}', 'match': 'ready'},
            {'command': 'echo {{instance_index}}', 'match': 'ready'},
        ]
        with ExitStack() as stack:
            for ctx in self._common_patches():
                stack.enter_context(ctx)
            runtime = _RuntimeStoreStub()
            stack.enter_context(patch('app.routes.api._runtime_store', return_value=runtime))
            guest = stack.enter_context(patch('app.routes.api.ProxmoxClient')).return_value
            guest.agent_exec.return_value = {'exitcode': 0, 'stdout': 'ready', 'stderr': ''}
            response = self.client.post(
                f'/api/projects/{self.project.id}/instances/actions/run_stored_cmds',
                json={'username': 'root@pam', 'password': 'secret', 'validateOnly': True,
                      'targets': [{'index': 1, 'name': self.target_name}]})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(guest.agent_exec.call_count, 1)
        self.assertEqual(guest.agent_exec.call_args.kwargs['command'], 'echo 1')
        payload = response.get_json()
        self.assertIn('Unknown command variable', payload['errors'][0]['reason'])
        validation = payload['ran'][0]['validation']
        self.assertFalse(validation['all_passed'])
        self.assertEqual([result['passed'] for result in validation['results']], [False, True])
        self.assertFalse(runtime.calls[0]['passed'])

    def test_unknown_command_variable_never_reaches_guest(self):
        self.project.vms[0].stored_commands = [StartCommandStep(commands=[StartCommand(command='echo {{wrong_name}}')])]
        with ExitStack() as stack:
            for ctx in self._common_patches():
                stack.enter_context(ctx)
            guest = stack.enter_context(patch('app.routes.api.ProxmoxClient')).return_value
            response = self.client.post(
                f'/api/projects/{self.project.id}/instances/actions/run_stored_cmds',
                json={'username': 'root@pam', 'password': 'secret', 'targets': [{'index': 1, 'name': self.target_name}]})
            self.assertEqual(response.status_code, 200)
            guest.agent_exec.assert_not_called()
            self.assertIn('Unknown command variable', str(response.get_json()['errors']))

    def test_custom_command_runs_without_saved_commands(self):
        self.project.vms[0].stored_commands = []
        command = 'echo custom\nprintf "done\\n"'
        with ExitStack() as stack:
            for ctx in self._common_patches():
                stack.enter_context(ctx)
            client = stack.enter_context(patch('app.routes.api.ProxmoxClient')).return_value
            client.agent_exec.return_value = {'exitcode': 0, 'stdout': 'custom done', 'stderr': ''}
            response = self.client.post(
                f'/api/projects/{self.project.id}/instances/actions/run_stored_cmds',
                json={'username': 'root@pam', 'password': 'secret',
                      'baseUrl': 'https://proxmox.local',
                      'targets': [{'index': 1, 'name': self.target_name}],
                      'customCommand': command},
            )
            self.assertEqual(response.status_code, 200)
            self.assertEqual([call.kwargs['command'] for call in client.agent_exec.call_args_list], [command])
            self.assertEqual(client.agent_exec.call_args.kwargs['timeout'], 60)
            self.assertEqual(len(response.get_json()['ran']), 1)
            self.assertIsNotNone(response.get_json().get('outputs_zip'))
            self.assertEqual(self.project.vms[0].stored_commands, [])

    def test_custom_command_uses_requested_timeout(self):
        self.project.vms[0].stored_commands = []
        command = 'echo custom\nprintf "done\\n"'
        with ExitStack() as stack:
            for ctx in self._common_patches():
                stack.enter_context(ctx)
            client = stack.enter_context(patch('app.routes.api.ProxmoxClient')).return_value
            client.agent_exec.return_value = {'exitcode': 0, 'stdout': 'custom done', 'stderr': ''}
            response = self.client.post(
                f'/api/projects/{self.project.id}/instances/actions/run_stored_cmds',
                json={'username': 'root@pam', 'password': 'secret',
                      'baseUrl': 'https://proxmox.local',
                      'targets': [{'index': 1, 'name': self.target_name}],
                      'customCommand': command, 'customCommandTimeoutSeconds': 12000},
            )
            self.assertEqual(response.status_code, 200)
            self.assertEqual([call.kwargs['command'] for call in client.agent_exec.call_args_list], [command])
            self.assertEqual(client.agent_exec.call_args.kwargs['timeout'], 12000)
            self.assertEqual(len(response.get_json()['ran']), 1)
            self.assertIsNotNone(response.get_json().get('outputs_zip'))
            self.assertEqual(self.project.vms[0].stored_commands, [])

    def test_custom_command_rejects_invalid_timeout(self):
        for timeout in (0, -1, 1.5, True, '60', None, 86401):
            with self.subTest(timeout=timeout), ExitStack() as stack:
                for ctx in self._common_patches():
                    stack.enter_context(ctx)
                response = self.client.post(
                    f'/api/projects/{self.project.id}/instances/actions/run_stored_cmds',
                    json={'customCommand': 'hostname', 'customCommandTimeoutSeconds': timeout},
                )
                self.assertEqual(response.status_code, 400)
                self.assertIn('timeout', response.get_json()['error'])

    def test_commands_run_in_parallel_with_project_limit(self):
        mapped = [
            {'index': i, 'name': f'alpha{self.project.tag}{i}',
             'vmid': 100 + i, 'node': 'node1'}
            for i in range(1, 5)
        ]
        for custom in (True, False):
            for limit in (1, 2):
                with self.subTest(custom=custom, limit=limit), ExitStack() as stack:
                    self.project.proxmox_max_create_jobs = limit
                    for ctx in self._common_patches():
                        stack.enter_context(ctx)
                    stack.enter_context(patch('app.routes.api._resolve_targets_to_vm_info',
                                              return_value=(mapped, [], [])))
                    client = stack.enter_context(patch('app.routes.api.ProxmoxClient')).return_value
                    lock = threading.Lock()
                    overlap = threading.Event()
                    active = peak = 0
                    commands_by_vm = {}

                    def execute(**kwargs):
                        nonlocal active, peak
                        with lock:
                            active += 1
                            peak = max(peak, active)
                            commands_by_vm.setdefault(kwargs['vmid'], []).append(kwargs['command'])
                            if active == limit:
                                overlap.set()
                        try:
                            self.assertTrue(overlap.wait(2), 'Commands did not overlap')
                            time.sleep(0.01)
                            return {'exitcode': 0, 'stdout': 'ok', 'stderr': ''}
                        finally:
                            with lock:
                                active -= 1

                    client.agent_exec.side_effect = execute
                    body = {'username': 'root@pam', 'password': 'secret',
                            'baseUrl': 'https://proxmox.local', 'targets': mapped}
                    if custom:
                        body['customCommand'] = 'hostname'
                    response = self.client.post(
                        f'/api/projects/{self.project.id}/instances/actions/run_stored_cmds',
                        json=body,
                    )
                    self.assertEqual(response.status_code, 200)
                    payload = response.get_json()
                    self.assertEqual(payload['errors'], [])
                    self.assertEqual(peak, limit)
                    self.assertEqual([entry['vmid'] for entry in payload['ran']],
                                     [entry['vmid'] for entry in mapped])
                    expected = ['hostname'] if custom else ['echo ready', 'uptime']
                    self.assertEqual(commands_by_vm, {m['vmid']: expected for m in mapped})
                    summary = self._decode_outputs_zip(payload['outputs_zip'])
                    self.assertEqual(len(summary['commands']), len(mapped) * len(expected))

    def test_custom_command_rejects_empty_or_non_string_input(self):
        with ExitStack() as stack:
            for ctx in self._common_patches():
                stack.enter_context(ctx)
            for command in ('   ', True, ['hostname']):
                response = self.client.post(
                    f'/api/projects/{self.project.id}/instances/actions/run_stored_cmds',
                    json={'customCommand': command},
                )
                self.assertEqual(response.status_code, 400)

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

    def test_stored_command_run_render_choice_overrides_saved_setting_only_for_selected_command(self):
        original = 'echo {{instance_index}}'
        for saved_mode in (False, True):
            for run_mode in (False, True):
                for override_text in (None, 'echo override {{instance_index}}'):
                    with self.subTest(saved=saved_mode, run=run_mode, text=override_text), ExitStack() as stack:
                        saved_command = StartCommand(command=original, render_template_variables=saved_mode)
                        self.project.vms[0].stored_commands = [StartCommandStep(commands=[
                            saved_command, StartCommand(command='echo {{project_id}}', render_template_variables=False),
                        ])]
                        for ctx in self._common_patches():
                            stack.enter_context(ctx)
                        guest = stack.enter_context(patch('app.routes.api.ProxmoxClient')).return_value
                        guest.agent_exec.return_value = {'exitcode': 0, 'stdout': '', 'stderr': ''}
                        override = {'templateKey': self.template_key, 'stepIndex': 1, 'commandIndex': 1,
                                    'renderTemplateVariables': run_mode}
                        if override_text:
                            override['text'] = override_text
                        response = self.client.post(
                            f'/api/projects/{self.project.id}/instances/actions/run_stored_cmds',
                            json={'username': 'root@pam', 'password': 'secret',
                                  'targets': [{'index': 1, 'name': self.target_name}],
                                  'commands': [original, 'echo {{project_id}}'], 'storedCommandOverrides': [override]})
                        self.assertEqual(response.status_code, 200)
                        expected = override_text or original
                        if run_mode:
                            expected = expected.replace('{{instance_index}}', '1')
                        self.assertCountEqual([call.kwargs['command'] for call in guest.agent_exec.call_args_list],
                                              [expected, 'echo {{project_id}}'])
                        summary = self._decode_outputs_zip(response.json['outputs_zip'])
                        self.assertCountEqual([item['command'] for item in summary['commands']],
                                              [expected, 'echo {{project_id}}'])
                        self.assertEqual(saved_command.command, original)
                        self.assertIs(saved_command.render_template_variables, saved_mode)

    def test_stored_command_run_render_choice_rejects_non_boolean(self):
        with ExitStack() as stack:
            for ctx in self._common_patches():
                stack.enter_context(ctx)
            guest = stack.enter_context(patch('app.routes.api.ProxmoxClient')).return_value
            response = self.client.post(
                f'/api/projects/{self.project.id}/instances/actions/run_stored_cmds',
                json={'storedCommandOverrides': [{'templateKey': self.template_key, 'stepIndex': 1,
                       'commandIndex': 1, 'renderTemplateVariables': 'false'}]})
            self.assertEqual(response.status_code, 400)
            self.assertIn('must be a boolean', response.json['error'])
            guest.agent_exec.assert_not_called()

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

    def test_run_stored_cmds_validation_passes_on_timeout_match(self):
        vm = self.project.vms[0]
        vm.validation_commands = [
            {
                'command': 'systemctl is-active nginx',
                'match': 'active',
                'enabled': True,
                'timeout_seconds': 7,
            }
        ]
        with ExitStack() as stack:
            for ctx in self._common_patches():
                stack.enter_context(ctx)
            mock_client_cls = stack.enter_context(patch('app.routes.api.ProxmoxClient'))
            mock_client = MagicMock()
            mock_client_cls.return_value = mock_client
            mock_client.agent_exec.side_effect = [
                {'exitcode': None, 'stdout': 'active', 'stderr': '', 'timed_out': True},
            ]

            resp = self.client.post(
                f'/api/projects/{self.project.id}/instances/actions/run_stored_cmds',
                json={
                    'username': 'root@pam',
                    'password': 'secret',
                    'baseUrl': 'https://proxmox.local',
                    'targets': [{'index': 1, 'name': self.target_name}],
                    'validateOnly': True,
                },
            )

            self.assertEqual(resp.status_code, 200)
            payload = resp.get_json()
            ran = payload.get('ran') or []
            self.assertEqual(len(ran), 1)
            validation = ran[0].get('validation') or {}
            self.assertTrue(validation.get('all_passed'))
            results = validation.get('results') or []
            self.assertEqual(len(results), 1)
            self.assertTrue(results[0].get('passed'))
            self.assertTrue(results[0].get('timed_out'))
            self.assertEqual(payload.get('errors'), [])
            self.assertEqual(mock_client.agent_exec.call_count, 1)
            first_kwargs = mock_client.agent_exec.call_args_list[0].kwargs
            self.assertTrue(first_kwargs.get('return_partial_on_timeout'))

    def test_run_stored_cmds_validation_requires_all_pass(self):
        vm = self.project.vms[0]
        vm.validation_commands = [
            {
                'command': 'systemctl is-active nginx',
                'match': 'active',
                'enabled': True,
                'timeout_seconds': 7,
            },
            {
                'command': 'cat /tmp/health.txt',
                'match': 'OK',
                'enabled': True,
                'timeout_seconds': 7,
            },
        ]
        with ExitStack() as stack:
            for ctx in self._common_patches():
                stack.enter_context(ctx)
            mock_client_cls = stack.enter_context(patch('app.routes.api.ProxmoxClient'))
            mock_client = MagicMock()
            mock_client_cls.return_value = mock_client
            mock_client.agent_exec.side_effect = [
                {'exitcode': 0, 'stdout': 'active', 'stderr': ''},
                {'exitcode': 0, 'stdout': 'DOWN', 'stderr': ''},
            ]

            resp = self.client.post(
                f'/api/projects/{self.project.id}/instances/actions/run_stored_cmds',
                json={
                    'username': 'root@pam',
                    'password': 'secret',
                    'baseUrl': 'https://proxmox.local',
                    'targets': [{'index': 1, 'name': self.target_name}],
                    'validateOnly': True,
                },
            )

            self.assertEqual(resp.status_code, 200)
            payload = resp.get_json()
            ran = payload.get('ran') or []
            self.assertEqual(len(ran), 1)
            validation = ran[0].get('validation') or {}
            self.assertFalse(validation.get('all_passed'))
            results = validation.get('results') or []
            self.assertEqual(len(results), 2)
            self.assertTrue(results[0].get('passed'))
            self.assertFalse(results[1].get('passed'))
            errors = payload.get('errors') or []
            self.assertTrue(errors)
            self.assertTrue(all(err.get('username') == 'student/one' for err in errors))
            self.assertTrue(any('validation regex did not match output' in str(err.get('reason', '')) for err in errors if isinstance(err, dict)))

    def test_run_stored_cmds_validate_only_runs_without_stored_commands(self):
        vm = self.project.vms[0]
        vm.stored_commands = []
        vm.validation_commands = [
            {
                'command': 'systemctl is-active nginx',
                'match': 'active',
                'enabled': True,
                'timeout_seconds': 7,
            }
        ]
        with ExitStack() as stack:
            for ctx in self._common_patches():
                stack.enter_context(ctx)
            runtime_store = _RuntimeStoreStub()
            stack.enter_context(patch('app.routes.api._runtime_store', return_value=runtime_store))
            mock_client_cls = stack.enter_context(patch('app.routes.api.ProxmoxClient'))
            mock_client = MagicMock()
            mock_client_cls.return_value = mock_client
            mock_client.agent_exec.return_value = {'exitcode': 0, 'stdout': 'active', 'stderr': ''}

            resp = self.client.post(
                f'/api/projects/{self.project.id}/instances/actions/run_stored_cmds',
                json={
                    'username': 'root@pam',
                    'password': 'secret',
                    'baseUrl': 'https://proxmox.local',
                    'targets': [{'index': 1, 'name': self.target_name}],
                    'validateOnly': True,
                },
            )

            self.assertEqual(resp.status_code, 200)
            payload = resp.get_json()
            ran = payload.get('ran') or []
            self.assertEqual(len(ran), 1)
            self.assertEqual(ran[0].get('count'), 0)
            self.assertEqual(ran[0].get('steps'), 0)
            self.assertTrue(ran[0].get('validate_only'))
            validation = ran[0].get('validation') or {}
            self.assertTrue(validation.get('all_passed'))
            results = validation.get('results') or []
            self.assertEqual(len(results), 1)
            self.assertTrue(results[0].get('passed'))
            self.assertNotIn('requested_commands', payload)
            self.assertNotIn('requested_command', payload)
            zip_info = payload.get('outputs_zip')
            self.assertIsNotNone(zip_info, 'expected outputs_zip in response')
            summary = self._decode_outputs_zip(zip_info)
            command_list = summary.get('commands') or []
            self.assertEqual(len(command_list), 1)
            self.assertEqual(command_list[0].get('command'), 'systemctl is-active nginx')
            self.assertEqual(mock_client.agent_exec.call_count, 1)
            self.assertTrue(mock_client.agent_exec.call_args.kwargs.get('return_partial_on_timeout'))
            self.assertEqual(len(runtime_store.calls), 1)
            self.assertEqual(runtime_store.calls[0]['project_id'], self.project.id)
            self.assertEqual(runtime_store.calls[0]['vm_name'], self.target_name)
            self.assertTrue(runtime_store.calls[0]['passed'])

    def test_validation_response_includes_slower_failures_and_project_identity(self):
        self.project.vms[0].validation_commands = [
            {'command': 'check-service', 'match': '^active$', 'is_regex': True, 'enabled': True},
        ]
        mapped = [
            {'index': 1, 'name': self.target_name, 'vmid': 101, 'node': 'node1'},
            {'index': 2, 'name': 'alpha-lab-2', 'vmid': 102, 'node': 'node1'},
        ]
        fast_persisted = threading.Event()
        runtime = _RuntimeStoreStub()
        original_set = runtime.set_vm_validation_state

        def persist(*args, **kwargs):
            result = original_set(*args, **kwargs)
            if kwargs.get('vmid') == 101:
                fast_persisted.set()
            return result

        runtime.set_vm_validation_state = persist

        def execute(**kwargs):
            if kwargs['m']['vmid'] == 102:
                self.assertTrue(fast_persisted.wait(2))
                return {'stdout': 'inactive', 'stderr': '', 'exitcode': 0}
            return {'stdout': 'active', 'stderr': '', 'exitcode': 0}

        with ExitStack() as stack:
            for context in self._common_patches():
                stack.enter_context(context)
            stack.enter_context(patch('app.routes.api._resolve_targets_to_vm_info', return_value=(mapped, [], [])))
            stack.enter_context(patch('app.routes.api._runtime_store', return_value=runtime))
            stack.enter_context(patch('app.routes.api._pool_workers_for', return_value=2))
            stack.enter_context(patch('app.routes.api.ProxmoxClient'))
            stack.enter_context(patch('app.routes.api._execute_instance_command', side_effect=execute))
            response = self.client.post(f'/api/projects/{self.project.id}/instances/actions/run_stored_cmds', json={
                'username': 'root@pam', 'password': 'secret', 'baseUrl': 'https://proxmox.local',
                'validateOnly': True, 'targets': [{'index': item['index'], 'name': item['name']} for item in mapped],
            })
        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertEqual(payload['project_id'], self.project.id)
        self.assertEqual([item['validation']['all_passed'] for item in payload['ran']], [True, False])
        self.assertEqual(len(runtime.calls), 2)

    def test_run_stored_cmds_validate_only_uses_project_limited_parallel_workers(self):
        vm = self.project.vms[0]
        vm.validation_commands = [
            {
                'command': 'systemctl is-active nginx',
                'match': 'active',
                'enabled': True,
                'timeout_seconds': 7,
            }
        ]
        mapped = [
            {'index': 1, 'name': self.target_name, 'vmid': 101, 'node': 'node1'},
            {'index': 2, 'name': f"{vm.name}{self.project.tag}2", 'vmid': 102, 'node': 'node1'},
            {'index': 3, 'name': f"{vm.name}{self.project.tag}3", 'vmid': 103, 'node': 'node1'},
        ]

        captured = {}

        def _executor_factory(*args, **kwargs):
            if 'max_workers' in kwargs:
                captured['max_workers'] = kwargs.get('max_workers')
            elif args:
                captured['max_workers'] = args[0]
            else:
                captured['max_workers'] = None
            return concurrent.futures.ThreadPoolExecutor(*args, **kwargs)

        with ExitStack() as stack:
            stack.enter_context(patch('app.routes.api._store', return_value=_StoreStub(self.project)))
            stack.enter_context(patch('app.routes.api._resolve_targets_to_vm_info', return_value=(mapped, [], [])))
            stack.enter_context(patch('app.routes.api._start_job'))
            stack.enter_context(patch('app.routes.api._end_job'))
            stack.enter_context(patch('app.routes.api._job_emit_batch_progress'))
            stack.enter_context(patch('app.routes.api._pool_workers_for', return_value=2))
            stack.enter_context(patch('app.routes.api.ThreadPoolExecutor', side_effect=_executor_factory))
            mock_client_cls = stack.enter_context(patch('app.routes.api.ProxmoxClient'))
            mock_client = MagicMock()
            mock_client_cls.return_value = mock_client
            mock_client.agent_exec.return_value = {'exitcode': 0, 'stdout': 'active', 'stderr': ''}

            resp = self.client.post(
                f'/api/projects/{self.project.id}/instances/actions/run_stored_cmds',
                json={
                    'username': 'root@pam',
                    'password': 'secret',
                    'baseUrl': 'https://proxmox.local',
                    'targets': [{'index': 1, 'name': self.target_name}, {'index': 2, 'name': mapped[1]['name']}, {'index': 3, 'name': mapped[2]['name']}],
                    'validateOnly': True,
                },
            )

            self.assertEqual(resp.status_code, 200)
            payload = resp.get_json()
            ran = payload.get('ran') or []
            self.assertEqual(len(ran), 3)
            self.assertEqual(captured.get('max_workers'), 2)
            self.assertEqual(mock_client.agent_exec.call_count, 3)
            self.assertEqual(payload.get('errors'), [])
            self.assertEqual(payload.get('skipped'), [])


if __name__ == '__main__':
    unittest.main()
