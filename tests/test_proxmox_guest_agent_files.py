import base64
import unittest
from unittest.mock import MagicMock, patch

from app.connectors.proxmox import ProxmoxClient, GuestAgentFileReadError, GuestAgentUnavailableError, _decode_guest_output


class ProxmoxGuestAgentFileTests(unittest.TestCase):
    def setUp(self):
        self.client = ProxmoxClient(
            base_url='https://proxmox.local:8006',
            token='token-id=secret',
            verify=False,
        )
        self.session = MagicMock()
        self.client._ensure_session = MagicMock(return_value=self.session)
        self.client.get_qemu_config = MagicMock(return_value={'ostype': 'l26'})
        self.client.get_guest_osinfo = MagicMock(side_effect=RuntimeError('get-osinfo unsupported'))

    def _complete_exec(self, exitcode=0, stdout='', stderr=''):
        started = MagicMock(status_code=200, content=b'{}')
        started.json.return_value = {'data': {'pid': 44}}
        completed = MagicMock(status_code=200, content=b'{}')
        completed.json.return_value = {'data': {
            'exited': 1, 'exitcode': exitcode, 'out-data': stdout, 'err-data': stderr,
        }}
        self.session.post.return_value = started
        self.session.get.return_value = completed

    def test_windows_shell_preserves_script_and_execution_result(self):
        script = '$p = "C:\\Program Files\\café\\test.txt"\r\nGet-Content -LiteralPath $p\nexit 7'
        for ostype in ('win11', 'win10', 'win8', 'win7', 'w2k8', 'w2k3', 'w2k', 'wxp', 'wvista'):
            with self.subTest(ostype=ostype):
                self.client._guest_windows.clear()
                self.client.get_qemu_config.return_value = {'ostype': ostype}
                self._complete_exec(exitcode=7, stdout='output', stderr='error')
                result = self.client.agent_exec('node1', 101, script, input_data='stdin')
                argv = self.session.post.call_args.kwargs['json']['command']
                self.assertEqual(argv[0], r'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe')
                self.assertIn('-NonInteractive', argv)
                self.assertEqual(argv[-2], '-EncodedCommand')
                self.assertEqual(base64.b64decode(argv[-1]).decode('utf-16le'), script)
                self.assertEqual(self.session.post.call_args.kwargs['json']['input-data'], 'stdin')
                self.assertEqual(result, {'exitcode': 7, 'stdout': 'output', 'stderr': 'error'})

    def test_shell_detection_is_scoped_to_node_and_vmid(self):
        self.client.get_qemu_config.side_effect = [
            {'ostype': 'win11'}, {'ostype': 'l26'}, {},
        ]
        self._complete_exec()
        for node, vmid, executable in (
            ('node1', 101, 'powershell.exe'), ('node1', 101, 'powershell.exe'),
            ('node1', 102, '/bin/sh'), ('node2', 101, '/bin/sh'),
        ):
            self.client.agent_exec(node, vmid, 'hostname')
            argv = self.session.post.call_args.kwargs['json']['command']
            self.assertEqual(argv[0].split('\\')[-1], executable)
            if executable == '/bin/sh':
                self.assertEqual(argv, ['/bin/sh', '-lc', 'hostname'])
        self.assertEqual(self.client.get_qemu_config.call_count, 3)

    def test_os_detection_failure_does_not_dispatch_or_cache_wrong_shell(self):
        self.client.get_qemu_config.side_effect = [RuntimeError('403 denied'), {'ostype': 'win11'}]
        with self.assertRaisesRegex(RuntimeError, 'Cannot determine guest OS.*403 denied'):
            self.client.agent_exec('node1', 101, 'hostname')
        self.session.post.assert_not_called()
        self._complete_exec()
        self.client.agent_exec('node1', 101, 'hostname')
        self.assertTrue(self.session.post.call_args.kwargs['json']['command'][0].endswith('\\powershell.exe'))

    def test_reported_windows_overrides_incorrect_proxmox_os_type(self):
        self.client.get_guest_osinfo.side_effect = None
        self.client.get_guest_osinfo.return_value = {'id': 'mswindows', 'name': 'Microsoft Windows 11'}
        self.client.get_qemu_config.return_value = {'ostype': 'l26'}
        self._complete_exec(stdout='Directory: C:\\Windows')
        result = self.client.agent_exec('node1', 101, 'dir')
        argv = self.session.post.call_args.kwargs['json']['command']
        self.assertTrue(argv[0].endswith('\\powershell.exe'))
        self.assertEqual(base64.b64decode(argv[-1]).decode('utf-16le'), 'dir')
        self.assertIn('Directory:', result['stdout'])
        self.client.get_qemu_config.assert_not_called()

    def test_reported_linux_overrides_incorrect_proxmox_os_type(self):
        self.client.get_guest_osinfo.side_effect = None
        self.client.get_guest_osinfo.return_value = {'id': 'ubuntu', 'kernel-name': 'Linux'}
        self.client.get_qemu_config.return_value = {'ostype': 'win11'}
        self._complete_exec()
        self.client.agent_exec('node1', 101, 'ls')
        self.assertEqual(self.session.post.call_args.kwargs['json']['command'], ['/bin/sh', '-lc', 'ls'])
        self.client.get_qemu_config.assert_not_called()

    def test_guest_osinfo_unwraps_proxmox_result(self):
        # Exercise the real API helper rather than the default unsupported stub.
        del self.client.get_guest_osinfo
        response = MagicMock(status_code=200)
        response.json.return_value = {'data': {'result': {'id': 'mswindows'}}}
        self.session.get.return_value = response
        self.assertTrue(self.client._guest_uses_windows('node1', 101))
        self.session.get.assert_called_once_with(
            'https://proxmox.local:8006/api2/json/nodes/node1/qemu/101/agent/get-osinfo', timeout=10)
        self.client.get_qemu_config.assert_not_called()

    def test_guest_osinfo_failure_falls_back_to_config(self):
        for data, status in (({'result': {}}, 200), ({}, 403), ({}, 501)):
            with self.subTest(data=data, status=status):
                self.client._guest_windows.clear()
                self.client.get_qemu_config.return_value = {'ostype': 'win11'}
                response = MagicMock(status_code=status, text='unavailable')
                response.json.return_value = {'data': data}
                self.session.get.return_value = response
                with patch.object(self.client, 'get_guest_osinfo', wraps=ProxmoxClient.get_guest_osinfo.__get__(self.client)):
                    self.assertTrue(self.client._guest_uses_windows('node1', 101))

    def test_windows_shell_retries_path_search_only_after_definite_spawn_failure(self):
        self.client.get_qemu_config.return_value = {'ostype': 'win11'}
        self._complete_exec()
        started = self.session.post.return_value
        missing = MagicMock(status_code=500, text='Agent error: Failed to execute child process (No such file or directory)')
        self.session.post.side_effect = [missing, started]
        result = self.client.agent_exec('node1', 101, 'dir', input_data='input')
        calls = self.session.post.call_args_list
        first, second = [call.kwargs['json'] for call in calls]
        self.assertTrue(first['command'][0].startswith('C:\\Windows\\'))
        self.assertEqual(second['command'][0], 'powershell.exe')
        self.assertEqual(first['command'][1:], second['command'][1:])
        self.assertEqual(second['input-data'], 'input')
        self.assertEqual(result['exitcode'], 0)

    def test_windows_shell_does_not_retry_other_errors_or_command_failures(self):
        self.client.get_qemu_config.return_value = {'ostype': 'win11'}
        for status, message in ((403, 'permission denied'), (500, 'guest agent timeout'),
                                (500, 'Failed to execute child process (Permission denied)')):
            with self.subTest(status=status, message=message):
                self.session.post.reset_mock()
                self.session.post.return_value = MagicMock(status_code=status, text=message)
                with self.assertRaisesRegex(RuntimeError, 'executable: C:'):
                    self.client.agent_exec('node1', 101, 'dir')
                self.session.post.assert_called_once()
        self.session.post.reset_mock()
        self._complete_exec(exitcode=1, stderr='script failed')
        self.assertEqual(self.client.agent_exec('node1', 101, 'dir')['exitcode'], 1)
        self.session.post.assert_called_once()

    def test_failed_explicit_argv_is_not_retried(self):
        self.session.post.return_value = MagicMock(
            status_code=500, text='Failed to execute child process (No such file or directory)')
        with self.assertRaisesRegex(RuntimeError, 'executable: missing.exe'):
            self.client.agent_exec('node1', 101, ['missing.exe'], shell=False)
        self.session.post.assert_called_once()
        self.client.get_guest_osinfo.assert_not_called()

    def test_explicit_windows_argv_skips_shell_detection(self):
        self._complete_exec()
        argv = ['C:\\Windows\\System32\\cmd.exe', '/c', 'echo ready']
        self.client.agent_exec('node1', 101, argv, shell=False)
        self.assertEqual(self.session.post.call_args.kwargs['json']['command'], argv)
        self.client.get_qemu_config.assert_not_called()

    def test_readiness_uses_agent_ping_without_guest_programs(self):
        self.session.post.return_value = MagicMock(status_code=200)
        self.client.ensure_guest_agent_ready('node1', 101, timeout=12)
        self.session.post.assert_called_once_with(
            'https://proxmox.local:8006/api2/json/nodes/node1/qemu/101/agent/ping', timeout=12)
        self.session.get.assert_not_called()
        self.client.get_qemu_config.assert_not_called()

    def test_readiness_reports_unavailable_agent_and_permission_errors(self):
        for status, error in ((500, GuestAgentUnavailableError), (501, GuestAgentUnavailableError), (403, RuntimeError)):
            with self.subTest(status=status):
                self.session.post.return_value = MagicMock(status_code=status, text='failure detail')
                with self.assertRaisesRegex(error, f'ping error {status}: failure detail'):
                    self.client.ensure_guest_agent_ready('node1', 101)

    def test_agent_exec_forwards_input_data(self):
        started = MagicMock(status_code=200, content=b'{}')
        started.json.return_value = {'data': {'pid': 44}}
        completed = MagicMock(status_code=200, content=b'{}')
        completed.json.return_value = {
            'data': {'exited': 1, 'exitcode': 0, 'out-data': '', 'err-data': ''},
        }
        self.session.post.return_value = started
        self.session.get.return_value = completed

        result = self.client.agent_exec(
            node='node1',
            vmid=101,
            command=['/bin/sh', '-c', 'base64 -d >> /tmp/archive.tar'],
            shell=False,
            input_data='YWxwaGE=',
        )

        self.assertEqual(result['exitcode'], 0)
        payload = self.session.post.call_args.kwargs['json']
        self.assertEqual(payload['input-data'], 'YWxwaGE=')
        self.assertEqual(payload['command'][0], '/bin/sh')

    def test_agent_exec_large_timeout_keeps_polling_after_ten_minutes(self):
        started = MagicMock(status_code=200, content=b'{}')
        started.json.return_value = {'data': {'pid': 44}}
        running = MagicMock(status_code=200, content=b'{}')
        running.json.return_value = {'data': {'exited': 0}}
        completed = MagicMock(status_code=200, content=b'{}')
        completed.json.return_value = {'data': {'exited': 1, 'exitcode': 0}}
        self.session.post.return_value = started
        self.session.get.side_effect = [running, running, completed]
        self.client._guest_uses_windows('node1', 101)
        with patch('time.time', side_effect=[0, 72, 601, 700]), patch('time.sleep'):
            result = self.client.agent_exec('node1', 101, 'sleep 700', timeout=12000)
        self.assertEqual(result['exitcode'], 0)
        self.assertEqual(self.session.get.call_count, 3)
        self.session.post.assert_called_once()

    def test_agent_exec_timeout_reports_actual_limit(self):
        started = MagicMock(status_code=200, content=b'{}')
        started.json.return_value = {'data': {'pid': 44}}
        self.session.post.return_value = started
        self.client._guest_uses_windows('node1', 101)
        with patch('time.time', side_effect=[0, 72]):
            with self.assertRaisesRegex(RuntimeError, r'configured timeout: 60s; elapsed: 72s'):
                self.client.agent_exec('node1', 101, 'sleep 100', timeout=60)

    def test_agent_exec_decodes_remote_error_quotes(self):
        started = MagicMock(status_code=200, content=b'{}')
        started.json.return_value = {'data': {'pid': 44}}
        completed = MagicMock(status_code=200, content=b'{}')
        error = 'chown: invalid user: ‘agentic’'
        completed.json.return_value = {'data': {
            'exited': 1, 'exitcode': 1,
            'out-data': 'Uploaded café'.encode('utf-8').decode('latin-1'),
            'err-data': error.encode('utf-8').decode('latin-1'),
        }}
        self.session.post.return_value = started
        self.session.get.return_value = completed
        result = self.client.agent_exec('node1', 101, ['chown', 'agentic', '/tmp/grader.py'], shell=False)
        self.assertEqual(result['stderr'], error)
        self.assertEqual(result['stdout'], 'Uploaded café')
        self.assertEqual(result['exitcode'], 1)

    def test_guest_output_preserves_unicode_and_malformed_sequences(self):
        for text in ('ASCII error', 'café ‘agentic’ 中文 😀', 'literal â', '\xe0\x80\x80', '\xf4\xbf\xbf\xbf'):
            with self.subTest(text=text):
                self.assertEqual(_decode_guest_output(text), text)
        mixed = '中文: ' + '‘café 😀’'.encode('utf-8').decode('latin-1')
        self.assertEqual(_decode_guest_output(mixed), '中文: ‘café 😀’')
        self.assertEqual(_decode_guest_output(None), '')

    def test_agent_file_read_requests_encoded_chunk_with_offset(self):
        response = MagicMock(status_code=200, content=b'{}')
        response.json.return_value = {
            'data': {'content': 'YWxwaGE=', 'bytes-read': 5, 'truncated': 0},
        }
        self.session.get.return_value = response

        result = self.client.agent_file_read(
            node='node1',
            vmid=101,
            path='/tmp/archive.tar',
            offset=4096,
            count=8192,
            decode=False,
        )

        self.assertEqual(result['bytes-read'], 5)
        params = self.session.get.call_args.kwargs['params']
        self.assertEqual(params, {
            'file': '/tmp/archive.tar',
            'offset': 4096,
            'count': 8192,
            'decode': 0,
        })

    def test_agent_file_read_legacy_omits_new_chunk_parameters(self):
        response = MagicMock(status_code=200, content=b'{}')
        response.json.return_value = {'data': {'content': 'YWxwaGE='}}
        self.session.get.return_value = response

        self.client.agent_file_read(
            node='node1',
            vmid=101,
            path='/tmp/archive.part.aa',
            legacy=True,
        )

        params = self.session.get.call_args.kwargs['params']
        self.assertEqual(params, {'file': '/tmp/archive.part.aa'})

    def test_agent_file_read_preserves_empty_body_proxy_reason_and_status(self):
        for status in (596, 597):
            with self.subTest(status=status):
                self.session.get.return_value = MagicMock(status_code=status, text='', reason='Connection timed out')
                with self.assertRaises(GuestAgentFileReadError) as raised:
                    self.client.agent_file_read('n', 101, '/tmp/archive.tar')
                self.assertEqual(raised.exception.status_code, status)
                self.assertTrue(raised.exception.retryable)
                self.assertIn('Connection timed out', str(raised.exception))

    def test_agent_file_read_reports_proxy_failure_when_reason_also_empty(self):
        self.session.get.return_value = MagicMock(status_code=597, text='', reason='')
        with self.assertRaisesRegex(GuestAgentFileReadError, 'upstream response body transfer failed'):
            self.client.agent_file_read('n', 101, '/tmp/archive.tar')

    def test_agent_file_read_permission_failure_is_not_retryable(self):
        self.session.get.return_value = MagicMock(status_code=403, text='permission denied', reason='Forbidden')
        with self.assertRaises(GuestAgentFileReadError) as raised:
            self.client.agent_file_read('n', 101, '/tmp/archive.tar')
        self.assertFalse(raised.exception.retryable)
        self.assertIn('permission denied', str(raised.exception))


if __name__ == '__main__':
    unittest.main()
