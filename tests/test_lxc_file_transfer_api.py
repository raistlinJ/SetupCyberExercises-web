import base64
import io
import json
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
        self.assertFalse(body['errors'])
        self.assertIn('pct exec 101', ssh.commands[0])
        self.assertIn('/opt/scenario files', ssh.commands[0])
        uploaded = next(iter(ssh.sftp.uploads.values()))
        with tarfile.open(fileobj=io.BytesIO(uploaded), mode='r:') as archive:
            self.assertEqual(archive.getnames(), ['bundle/a.txt', 'bundle/nested/b.txt'])
            self.assertEqual(archive.extractfile('bundle/a.txt').read(), b'alpha')
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

    def test_push_accepts_manual_proxmox_host_file_or_folder_paths(self):
        ssh = _Ssh()
        payload = {
            **self.payload,
            'destination': '/opt/scenario',
            'hostPaths': ['/srv/scenario/config.json', '/srv/scenario/assets'],
        }
        with patch('app.routes.api._block_when_remote', return_value=None), \
                patch('app.routes.api._store', return_value=_StoreStub(self.project)), \
                patch('app.routes.api._resolve_targets_to_vm_info', return_value=(self._mapped(), [], [])), \
                patch('app.routes.api.ProxmoxClient'), \
                patch('app.routes.api._ssh_connect', return_value=ssh):
            response = self.client.post(
                f'/api/projects/{self.project.id}/instances/actions/lxc_push',
                data={'payload': json.dumps(payload)},
                content_type='multipart/form-data',
            )

        self.assertEqual(response.status_code, 200)
        body = response.get_json()
        self.assertEqual(body['pushed'][0]['host_path_count'], 2)
        self.assertEqual(body['pushed'][0]['item_count'], 2)
        self.assertEqual(len(ssh.commands), 2)
        self.assertTrue(all(command.startswith('bash -o pipefail -c ') for command in ssh.commands))
        self.assertIn('config.json', ssh.commands[0])
        self.assertIn('assets', ssh.commands[1])
        self.assertFalse(ssh.sftp.uploads)

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
                json={**self.payload, 'paths': ['/etc/hosts', '/var/log/app']},
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
        self.assertIn('pct exec 101 -- tar -C / -cf - -- etc/hosts var/log/app', ssh.commands[0])

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
