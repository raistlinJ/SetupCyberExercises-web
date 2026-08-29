import base64
import io
import json
import shlex
import tarfile
import unittest
import zipfile
from unittest.mock import MagicMock, patch

from app import create_app
from app.storage.projects import Project, VMConfig


class _StoreStub:
    def __init__(self, project):
        self.project = project

    def get(self, pid):
        return self.project if pid == self.project.id else None


class _Channel:
    def __init__(self, code=0):
        self.code = code

    def recv_exit_status(self):
        return self.code


class _Stream(io.BytesIO):
    def __init__(self, data=b'', code=0):
        super().__init__(data)
        self.channel = _Channel(code)


class _Sftp:
    def __init__(self):
        self.uploads = {}
        self.removed = []

    def putfo(self, stream, remote_path, file_size=None):
        self.uploads[remote_path] = stream.read()

    def remove(self, remote_path):
        self.removed.append(remote_path)

    def close(self):
        pass


class _Ssh:
    def __init__(self, stdout=b'', stderr=b'', code=0):
        self.stdout = stdout
        self.stderr = stderr
        self.code = code
        self.commands = []
        self.sftp = _Sftp()
        self.closed = False

    def open_sftp(self):
        return self.sftp

    def exec_command(self, command, timeout=None):
        self.commands.append(command)
        return io.BytesIO(), _Stream(self.stdout, self.code), io.BytesIO(self.stderr)

    def close(self):
        self.closed = True


def _tar_bytes(entries):
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode='w') as archive:
        for path, content in entries.items():
            info = tarfile.TarInfo(path)
            info.size = len(content)
            archive.addfile(info, io.BytesIO(content))
    return output.getvalue()


class LxcFileTransferApiTests(unittest.TestCase):
    def setUp(self):
        self.app = create_app()
        self.app.config['TESTING'] = True
        self.client = self.app.test_client()
        self.project = Project(
            id='lxc-project',
            name='LXC Project',
            tag='-lab-',
            proxmox_url='https://node1:8006',
            vms=[VMConfig(name='alpha', vm_type='lxc')],
        )
        self.target_name = 'alpha-lab-1'
        self.payload = {
            'username': 'root@pam',
            'password': 'secret',
            'baseUrl': self.project.proxmox_url,
            'targets': [{'index': 1, 'name': self.target_name}],
        }

    def _mapped(self, vm_type='lxc'):
        return [{
            'index': 1,
            'name': self.target_name,
            'vmid': 101,
            'node': 'node1',
            'type': vm_type,
        }]

    def test_push_preserves_folder_paths_and_reports_success(self):
        ssh = _Ssh()
        payload = {
            **self.payload,
            'destination': '/opt/scenario files',
            'relativePaths': ['bundle/a.txt', 'bundle/nested/b.txt'],
            'selectionType': 'folder',
        }
        with patch('app.routes.api._block_when_remote', return_value=None), \
                patch('app.routes.api._store', return_value=_StoreStub(self.project)), \
                patch('app.routes.api._resolve_targets_to_vm_info', return_value=(self._mapped(), [], [])), \
                patch('app.routes.api.ProxmoxClient'), \
                patch('app.routes.api._ssh_connect', return_value=ssh):
            response = self.client.post(
                f'/api/projects/{self.project.id}/instances/actions/lxc_push',
                data={
                    'payload': json.dumps(payload),
                    'files': [
                        (io.BytesIO(b'alpha'), 'a.txt'),
                        (io.BytesIO(b'beta'), 'b.txt'),
                    ],
                },
                content_type='multipart/form-data',
            )

        self.assertEqual(response.status_code, 200)
        body = response.get_json()
        self.assertEqual(len(body['pushed']), 1)
        self.assertEqual(body['pushed'][0]['file_count'], 2)
        self.assertEqual(body['pushed'][0]['selection_type'], 'folder')
        self.assertFalse(body['errors'])
        self.assertIn('pct exec 101', ssh.commands[0])
        self.assertIn('/opt/scenario files', ssh.commands[0])
        uploaded = next(iter(ssh.sftp.uploads.values()))
        with tarfile.open(fileobj=io.BytesIO(uploaded), mode='r:') as archive:
            self.assertEqual(archive.getnames(), ['bundle', 'bundle/nested', 'bundle/a.txt', 'bundle/nested/b.txt'])
            self.assertEqual(archive.extractfile('bundle/a.txt').read(), b'alpha')
        self.assertIn('mkdir -p', ssh.commands[0])
        self.assertIn('rm -rf', ssh.commands[0])
        self.assertIn('/opt/scenario files', ssh.commands[0])
        self.assertIn('tar --overwrite -xpf', ssh.commands[0])
        self.assertEqual(len(ssh.sftp.removed), 1)
        self.assertTrue(ssh.closed)

    def test_push_rejects_relative_destination_and_path_traversal(self):
        for destination, relative_path, expected in [
            ('tmp/files', 'file.txt', 'Destination must be an absolute'),
            ('/tmp/files', '../file.txt', 'Invalid upload path'),
        ]:
            payload = {
                **self.payload,
                'destination': destination,
                'relativePaths': [relative_path],
            }
            with patch('app.routes.api._block_when_remote', return_value=None):
                response = self.client.post(
                    f'/api/projects/{self.project.id}/instances/actions/lxc_push',
                    data={
                        'payload': json.dumps(payload),
                        'files': (io.BytesIO(b'data'), 'file.txt'),
                    },
                    content_type='multipart/form-data',
                )
            self.assertEqual(response.status_code, 400)
            self.assertIn(expected, response.get_json()['error'])

    def test_push_rejects_payload_without_uploaded_content(self):
        with patch('app.routes.api._block_when_remote', return_value=None):
            response = self.client.post(
                f'/api/projects/{self.project.id}/instances/actions/lxc_push',
                data={'payload': json.dumps({**self.payload, 'destination': '/opt/scenario'})},
                content_type='multipart/form-data',
            )

        self.assertEqual(response.status_code, 400)
        self.assertIn('Select at least one file or folder', response.get_json()['error'])

    def test_qemu_push_streams_archive_through_guest_agent_without_ssh(self):
        prox = MagicMock()
        prox.get_qemu_config.return_value = {'ostype': 'l26'}
        prox.agent_exec.return_value = {'exitcode': 0, 'stdout': '', 'stderr': ''}
        self.project.proxmox_api_token = 'token-id=secret'
        payload = {
            'baseUrl': self.project.proxmox_url,
            'targets': [{'index': 1, 'name': self.target_name}],
            'destination': '/opt/scenario',
            'relativePaths': ['bundle/a.txt'],
            'selectionType': 'folder',
        }
        with patch('app.routes.api._block_when_remote', return_value=None), \
                patch('app.routes.api._store', return_value=_StoreStub(self.project)), \
                patch('app.routes.api._resolve_targets_to_vm_info', return_value=(self._mapped('qemu'), [], [])), \
                patch('app.routes.api.ProxmoxClient', return_value=prox), \
                patch('app.routes.api._ssh_connect') as ssh_connect:
            response = self.client.post(
                f'/api/projects/{self.project.id}/instances/actions/guest_push',
                data={
                    'payload': json.dumps(payload),
                    'files': (io.BytesIO(b'alpha'), 'a.txt'),
                },
                content_type='multipart/form-data',
            )

        self.assertEqual(response.status_code, 200)
        body = response.get_json()
        self.assertFalse(body['errors'])
        self.assertEqual(body['pushed'][0]['type'], 'qemu')
        self.assertEqual(body['pushed'][0]['transfer_method'], 'qemu-guest-agent')
        input_chunks = [
            call.kwargs['input_data'] for call in prox.agent_exec.call_args_list
            if call.kwargs.get('input_data')
        ]
        self.assertTrue(input_chunks)
        uploaded = b''.join(base64.b64decode(chunk) for chunk in input_chunks)
        with tarfile.open(fileobj=io.BytesIO(uploaded), mode='r:') as archive:
            self.assertEqual(archive.extractfile('bundle/a.txt').read(), b'alpha')
        ssh_connect.assert_not_called()

    def test_pull_zip_uses_one_vmname_vmid_directory(self):
        ssh = _Ssh(stdout=_tar_bytes({
            'etc/hosts': b'127.0.0.1 localhost\n',
            'var/log/app/output.log': b'ok\n',
        }))
        with patch('app.routes.api._block_when_remote', return_value=None), \
                patch('app.routes.api._store', return_value=_StoreStub(self.project)), \
                patch('app.routes.api._resolve_targets_to_vm_info', return_value=(self._mapped(), [], [])), \
                patch('app.routes.api.ProxmoxClient'), \
                patch('app.routes.api._ssh_connect', return_value=ssh):
            response = self.client.post(
                f'/api/projects/{self.project.id}/instances/actions/lxc_pull',
                json={**self.payload, 'paths': '/etc/hosts\n/var/log/app'},
            )

        self.assertEqual(response.status_code, 200)
        body = response.get_json()
        self.assertEqual(len(body['pulled']), 1)
        self.assertEqual(body['pulled'][0]['file_count'], 2)
        archive_bytes = base64.b64decode(body['outputs_zip']['base64'])
        with zipfile.ZipFile(io.BytesIO(archive_bytes)) as archive:
            names = set(archive.namelist())
            prefix = f'{self.target_name}-101'
            self.assertIn(f'{prefix}/', names)
            self.assertIn(f'{prefix}/etc/hosts', names)
            self.assertIn(f'{prefix}/var/log/app/output.log', names)
            self.assertEqual(archive.read(f'{prefix}/etc/hosts'), b'127.0.0.1 localhost\n')
        self.assertIn('pct exec 101 -- sh -c ', ssh.commands[0])
        self.assertIn('cd / && tar -cf - -- etc/hosts var/log/app', ssh.commands[0])

    def test_qemu_pull_reads_archive_in_chunks_through_guest_agent_without_ssh(self):
        prox = MagicMock()
        prox.get_qemu_config.return_value = {'ostype': 'l26'}
        prox.agent_exec.return_value = {'exitcode': 0, 'stdout': '', 'stderr': ''}
        archive_bytes = _tar_bytes({'etc/hosts': b'127.0.0.1 localhost\n'})
        prox.agent_file_read.return_value = {
            'content': base64.b64encode(archive_bytes).decode('ascii'),
            'bytes-read': len(archive_bytes),
            'truncated': 0,
        }
        self.project.proxmox_api_token = 'token-id=secret'
        with patch('app.routes.api._block_when_remote', return_value=None), \
                patch('app.routes.api._store', return_value=_StoreStub(self.project)), \
                patch('app.routes.api._resolve_targets_to_vm_info', return_value=(self._mapped('qemu'), [], [])), \
                patch('app.routes.api.ProxmoxClient', return_value=prox), \
                patch('app.routes.api._ssh_connect') as ssh_connect:
            response = self.client.post(
                f'/api/projects/{self.project.id}/instances/actions/guest_pull',
                json={
                    'baseUrl': self.project.proxmox_url,
                    'targets': [{'index': 1, 'name': self.target_name}],
                    'paths': '/etc/hosts',
                },
            )

        self.assertEqual(response.status_code, 200)
        body = response.get_json()
        self.assertFalse(body['errors'])
        self.assertEqual(body['pulled'][0]['type'], 'qemu')
        self.assertEqual(body['pulled'][0]['transfer_method'], 'qemu-guest-agent')
        output = base64.b64decode(body['outputs_zip']['base64'])
        with zipfile.ZipFile(io.BytesIO(output)) as archive:
            self.assertEqual(
                archive.read(f'{self.target_name}-101/etc/hosts'),
                b'127.0.0.1 localhost\n',
            )
        prox.agent_file_read.assert_called_once()
        ssh_connect.assert_not_called()

    def test_qemu_pull_falls_back_to_legacy_proxmox_file_read(self):
        prox = MagicMock()
        prox.get_qemu_config.return_value = {'ostype': 'l26'}
        archive_bytes = _tar_bytes({'etc/hosts': b'legacy endpoint\n'})

        def exec_result(**kwargs):
            command = str((kwargs.get('command') or [''])[-1])
            if 'for part in' in command:
                return {'exitcode': 0, 'stdout': '/tmp/archive.b64.part.aa\n', 'stderr': ''}
            return {'exitcode': 0, 'stdout': '', 'stderr': ''}

        prox.agent_exec.side_effect = exec_result
        prox.agent_file_read.side_effect = [
            RuntimeError('Proxmox guest agent file-read error 400: Parameter verification failed'),
            {'content': base64.b64encode(archive_bytes).decode('ascii')},
        ]
        self.project.proxmox_api_token = 'token-id=secret'
        with patch('app.routes.api._block_when_remote', return_value=None), \
                patch('app.routes.api._store', return_value=_StoreStub(self.project)), \
                patch('app.routes.api._resolve_targets_to_vm_info', return_value=(self._mapped('qemu'), [], [])), \
                patch('app.routes.api.ProxmoxClient', return_value=prox):
            response = self.client.post(
                f'/api/projects/{self.project.id}/instances/actions/guest_pull',
                json={
                    'baseUrl': self.project.proxmox_url,
                    'targets': [{'index': 1, 'name': self.target_name}],
                    'paths': '/etc/hosts',
                },
            )

        self.assertEqual(response.status_code, 200)
        body = response.get_json()
        self.assertFalse(body['errors'])
        output = base64.b64decode(body['outputs_zip']['base64'])
        with zipfile.ZipFile(io.BytesIO(output)) as archive:
            self.assertEqual(
                archive.read(f'{self.target_name}-101/etc/hosts'),
                b'legacy endpoint\n',
            )
        self.assertTrue(prox.agent_file_read.call_args_list[-1].kwargs['legacy'])

    def test_qemu_windows_guest_reports_clear_transfer_error(self):
        prox = MagicMock()
        prox.get_qemu_config.return_value = {'ostype': 'win11'}
        self.project.proxmox_api_token = 'token-id=secret'
        with patch('app.routes.api._block_when_remote', return_value=None), \
                patch('app.routes.api._store', return_value=_StoreStub(self.project)), \
                patch('app.routes.api._resolve_targets_to_vm_info', return_value=(self._mapped('qemu'), [], [])), \
                patch('app.routes.api.ProxmoxClient', return_value=prox):
            response = self.client.post(
                f'/api/projects/{self.project.id}/instances/actions/guest_push',
                data={
                    'payload': json.dumps({
                        'baseUrl': self.project.proxmox_url,
                        'targets': [{'index': 1, 'name': self.target_name}],
                        'destination': '/opt/scenario',
                        'relativePaths': ['a.txt'],
                    }),
                    'files': (io.BytesIO(b'alpha'), 'a.txt'),
                },
                content_type='multipart/form-data',
            )

        self.assertEqual(response.status_code, 200)
        body = response.get_json()
        self.assertFalse(body['pushed'])
        self.assertIn('supports Linux guests only', body['errors'][0]['reason'])

    def test_pull_expands_one_wildcard_pattern_per_line_and_quotes_literals(self):
        ssh = _Ssh(stdout=_tar_bytes({
            'var/log/app/one.log': b'one\n',
            'var/log/app/two.log': b'two\n',
        }))
        with patch('app.routes.api._block_when_remote', return_value=None), \
                patch('app.routes.api._store', return_value=_StoreStub(self.project)), \
                patch('app.routes.api._resolve_targets_to_vm_info', return_value=(self._mapped(), [], [])), \
                patch('app.routes.api.ProxmoxClient'), \
                patch('app.routes.api._ssh_connect', return_value=ssh):
            response = self.client.post(
                f'/api/projects/{self.project.id}/instances/actions/lxc_pull',
                json={
                    **self.payload,
                    'paths': '/var/log/app/*.log\n/opt/folder with spaces/[0-9]?.txt',
                },
            )

        self.assertEqual(response.status_code, 200)
        body = response.get_json()
        self.assertFalse(body['errors'])
        self.assertEqual(body['pulled'][0]['paths'], [
            '/var/log/app/*.log',
            '/opt/folder with spaces/[0-9]?.txt',
        ])
        inner_command = shlex.split(ssh.commands[0])[-1]
        self.assertIn('var/log/app/*.log', inner_command)
        self.assertIn("'opt/folder with spaces/'[0-9]?.txt", inner_command)

    def test_pull_pattern_cannot_inject_shell_commands(self):
        ssh = _Ssh(stdout=_tar_bytes({'tmp/report.txt': b'ok'}))
        with patch('app.routes.api._block_when_remote', return_value=None), \
                patch('app.routes.api._store', return_value=_StoreStub(self.project)), \
                patch('app.routes.api._resolve_targets_to_vm_info', return_value=(self._mapped(), [], [])), \
                patch('app.routes.api.ProxmoxClient'), \
                patch('app.routes.api._ssh_connect', return_value=ssh):
            response = self.client.post(
                f'/api/projects/{self.project.id}/instances/actions/lxc_pull',
                json={**self.payload, 'paths': '/tmp/*.txt; touch /tmp/injected'},
            )

        self.assertEqual(response.status_code, 200)
        inner_command = shlex.split(ssh.commands[0])[-1]
        inner_arguments = shlex.split(inner_command)
        self.assertEqual(inner_arguments, [
            'cd', '/', '&&', 'tar', '-cf', '-', '--',
            'tmp/*.txt; touch /tmp/injected',
        ])

    def test_pull_reports_failure_per_lxc_without_an_archive(self):
        ssh = _Ssh(stderr=b'file not found', code=2)
        with patch('app.routes.api._block_when_remote', return_value=None), \
                patch('app.routes.api._store', return_value=_StoreStub(self.project)), \
                patch('app.routes.api._resolve_targets_to_vm_info', return_value=(self._mapped(), [], [])), \
                patch('app.routes.api.ProxmoxClient'), \
                patch('app.routes.api._ssh_connect', return_value=ssh):
            response = self.client.post(
                f'/api/projects/{self.project.id}/instances/actions/lxc_pull',
                json={**self.payload, 'paths': ['/missing']},
            )

        self.assertEqual(response.status_code, 200)
        body = response.get_json()
        self.assertFalse(body['pulled'])
        self.assertEqual(len(body['errors']), 1)
        self.assertEqual(body['errors'][0]['name'], self.target_name)
        self.assertIn('file not found', body['errors'][0]['reason'])
        self.assertIsNone(body['outputs_zip'])

    def test_non_lxc_target_is_skipped_without_ssh(self):
        with patch('app.routes.api._block_when_remote', return_value=None), \
                patch('app.routes.api._store', return_value=_StoreStub(self.project)), \
                patch('app.routes.api._resolve_targets_to_vm_info', return_value=(self._mapped('qemu'), [], [])), \
                patch('app.routes.api.ProxmoxClient'), \
                patch('app.routes.api._ssh_connect') as ssh_connect:
            response = self.client.post(
                f'/api/projects/{self.project.id}/instances/actions/lxc_pull',
                json={**self.payload, 'paths': ['/etc/hosts']},
            )

        self.assertEqual(response.status_code, 200)
        body = response.get_json()
        self.assertFalse(body['pulled'])
        self.assertEqual(body['skipped'][0]['reason'], 'not an LXC container')
        ssh_connect.assert_not_called()


if __name__ == '__main__':
    unittest.main()
