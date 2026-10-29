import json
import os
import shlex
import shutil
import subprocess
import sys
import tarfile
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest
from flask import Flask

from app.host_guest_push import build_host_file_archive_script
from app.routes import api
from app.storage.projects import Project


@pytest.fixture
def host_push():
    app = Flask(__name__)
    app.add_url_rule('/api/projects/<pid>/instances/actions/guest_push', view_func=api.instances_lxc_push, methods=['POST'])
    project = Project(id='p', name='p')
    guests = [{'vmid': vmid, 'name': str(vmid), 'type': guest_type, 'node': f'node-{vmid}'}
              for vmid, guest_type in [(101, 'qemu'), (102, 'lxc')]]
    context = (project, MagicMock(), 'https://host', 'password', guests, [], [])
    with patch.object(api, '_block_when_remote', return_value=None), \
            patch.object(api, '_guest_transfer_context', return_value=context) as resolve, \
            patch.object(api, '_push_host_files_to_guest', return_value=([{'file_count': 1}], [])) as push, \
            patch.object(api, '_start_job'), patch.object(api, '_end_job'), \
            patch.object(api, '_update_job_detail'), patch.object(api, '_is_cancelled', return_value=False):
        yield app.test_client(), resolve, push


def body():
    return {'source': 'host', 'targets': [{'index': 1, 'name': '101'}, {'index': 1, 'name': '102'}],
            'transfers': [{'vmid': 101, 'sourcePath': '/srv/one', 'destinationPath': '/etc/renamed'},
                          {'vmid': 102, 'sourcePath': '/srv/two', 'destinationPath': '/opt/another'}]}


def test_host_csv_routes_only_each_vmids_files_and_preserves_metadata(host_push):
    client, resolve, push = host_push
    payload = {**body(), 'ownerOnRemote': ' www-data ', 'filePermissions': ' 0600 '}
    payload['transfers'].append(payload['transfers'][0])
    response = client.post('/api/projects/p/instances/actions/guest_push', json=payload)
    assert response.status_code == 200
    assert response.json['errors'] == []
    calls = {call.args[5]['vmid']: call.args for call in push.call_args_list}
    assert calls[101][6] == [{'sourcePath': '/srv/one', 'destinationPath': '/etc/renamed'}]
    assert calls[102][6] == [{'sourcePath': '/srv/two', 'destinationPath': '/opt/another'}]
    assert calls[101][7:] == ('www-data', '0600')
    resolve.assert_called_once()


@pytest.mark.parametrize('field,value', [('vmid', 999), ('vmid', '101'), ('vmid', True), ('vmid', 0),
    ('sourcePath', 'relative'), ('sourcePath', '/srv/'), ('sourcePath', '/srv/../secret'),
    ('sourcePath', '/srv/\0bad'), ('destinationPath', '/'), ('destinationPath', 'relative'),
    ('destinationPath', '/opt/../secret'), ('destinationPath', '/opt/')])
def test_invalid_or_changed_csv_target_never_reads_host_files(host_push, field, value):
    client, resolve, push = host_push
    payload = body()
    payload['transfers'][0][field] = value
    response = client.post('/api/projects/p/instances/actions/guest_push', json=payload)
    assert response.status_code == 400
    push.assert_not_called()


@pytest.mark.parametrize('change', ['missing', 'extra', 'duplicate', 'inventory_error', 'no_password', 'conflict'])
def test_csv_requires_exact_resolved_vmids_and_host_credentials(host_push, change):
    client, resolve, push = host_push
    context = list(resolve.return_value)
    payload = body()
    if change == 'missing':
        context[4] = context[4][:1]
    elif change == 'extra':
        context[4] = context[4] + [{**context[4][0], 'vmid': 103}]
    elif change == 'duplicate':
        context[4] = context[4] + context[4][:1]
    elif change == 'inventory_error':
        context[6] = [{'reason': 'inventory unavailable'}]
    elif change == 'no_password':
        context[3] = ''
    else:
        payload['transfers'].append({**payload['transfers'][0], 'sourcePath': '/srv/different'})
    resolve.return_value = tuple(context)
    response = client.post('/api/projects/p/instances/actions/guest_push', json=payload)
    assert response.status_code == 400
    push.assert_not_called()


@pytest.mark.parametrize('changes', [
    {'source': 'other'}, {'transfers': []}, {'transfers': [None]},
    {'ownerOnRemote': '-R'}, {'ownerOnRemote': 'root;id'}, {'ownerOnRemote': None},
    {'filePermissions': '888'}, {'filePermissions': 644},
])
def test_invalid_host_payload_is_rejected_before_inventory_lookup(host_push, changes):
    client, resolve, push = host_push
    response = client.post('/api/projects/p/instances/actions/guest_push', json={**body(), **changes})
    assert response.status_code == 400
    resolve.assert_not_called()
    push.assert_not_called()


def test_archive_builder_reads_binary_file_and_renames_entry_without_changing_source(tmp_path):
    source = tmp_path / "source 'quote', $literal.bin"
    content = bytes(range(256)) * 17
    source.write_bytes(content)
    archive = tmp_path / 'stage.tar'
    filename = "dest 'quote', $literal.bin"
    script = build_host_file_archive_script(str(source), filename, str(archive))
    result = subprocess.run([sys.executable, '-c', script], capture_output=True, check=True, timeout=5)
    assert int(result.stdout.strip()) == archive.stat().st_size
    assert archive.stat().st_mode & 0o777 == 0o600
    with tarfile.open(archive) as tar:
        assert tar.getnames() == [filename]
        assert tar.extractfile(filename).read() == content
    assert source.read_bytes() == content
    # Existing archives are never overwritten, including symlinks.
    retry = subprocess.run([sys.executable, '-c', script], capture_output=True, timeout=5)
    assert retry.returncode != 0


@pytest.mark.parametrize('kind', ['missing', 'directory', 'fifo'])
def test_archive_builder_rejects_nonfiles_without_blocking(tmp_path, kind):
    source = tmp_path / 'source'
    if kind == 'directory':
        source.mkdir()
    elif kind == 'fifo':
        os.mkfifo(source)
    archive = tmp_path / 'stage.tar'
    script = build_host_file_archive_script(str(source), 'dest', str(archive))
    result = subprocess.run([sys.executable, '-c', script], capture_output=True, timeout=5)
    assert result.returncode != 0
    assert not archive.exists()


@pytest.mark.parametrize('guest_type', ['lxc', 'qemu'])
@pytest.mark.parametrize('failure', [None, 'copy', 'missing_source'])
def test_host_source_copy_and_cleanup_for_both_guest_types(tmp_path, guest_type, failure):
    source = tmp_path / "source 'quoted'.bin"
    if failure != 'missing_source':
        source.write_bytes(b'\0binary\xff')
    destination = "/opt/new 'folder'/renamed.bin"
    ssh = MagicMock()
    archives, copied, commands = [], [], []

    def copy_archive(archive, directory):
        with tarfile.open(archive) as tar:
            copied.append((directory, tar.getnames(), tar.extractfile('renamed.bin').read()))
        if failure == 'copy':
            raise RuntimeError('copy failed')

    def ssh_exec(client, command, **kwargs):
        assert client is ssh
        assert kwargs['sudo'] is True
        commands.append(command)
        args = shlex.split(command)
        if args[:2] == ['python3', '-c']:
            result = subprocess.run([sys.executable, '-c', args[2]], capture_output=True, timeout=5)
            # Recover the generated archive path as data from the script.
            line = next(line for line in args[2].splitlines() if line.startswith('source, filename, archive = '))
            archive = json.loads(json.loads(line.split('json.loads(', 1)[1][:-1]))[2]
            archives.append(archive)
            return result.returncode, result.stdout, result.stderr.decode()
        if args[:3] == ['rm', '-f', '--']:
            Path(args[3]).unlink(missing_ok=True)
        elif args[:2] == ['sh', '-c']:
            inner = shlex.split(args[2])
            assert inner[:3] == ['pct', 'exec', '101']
            assert inner[-2] == '<'
            assert "mkdir -p -- '/opt/new" in inner[6]
            copy_archive(inner[-1], "/opt/new 'folder'")
        return 0, b'', ''

    def qemu_copy(client, entry, archive, size, directory, sudo, password, owner):
        assert entry['vmid'] == 101
        assert owner == '1000'
        copy_archive(archive, directory)

    with patch.object(api, '_ssh_connect', return_value=ssh) as connect, \
            patch.object(api, '_ssh_exec_result', side_effect=ssh_exec), \
            patch.object(api, '_ensure_linux_qemu_guest'), \
            patch.object(api, '_push_staged_tar_to_qemu', side_effect=qemu_copy), \
            patch.object(api, '_guest_agent_exec_checked') as metadata:
        pushed, errors = api._push_host_files_to_guest(
            Project(id='p', name='p'), MagicMock(), 'https://host', 'password', 'operator@pam',
            {'vmid': 101, 'name': 'one', 'node': '127.0.0.1', 'type': guest_type},
            [{'sourcePath': str(source), 'destinationPath': destination}], '1000', '0600',
        )
    assert archives and all(not Path(archive).exists() for archive in archives)
    connect.assert_called_once_with('127.0.0.1', 22, 'operator', 'password')
    ssh.close.assert_called_once()
    if failure:
        assert not pushed and errors
    else:
        assert not errors and pushed[0]['destination'] == destination
        assert copied == [("/opt/new 'folder'", ['renamed.bin'], b'\0binary\xff')]
        if guest_type == 'qemu':
            assert metadata.call_count == 2
        else:
            assert any('chown' in command for command in commands)
            assert any('chmod' in command for command in commands)
    if source.exists():
        assert source.read_bytes() == b'\0binary\xff'


def test_csv_browser_behavior():
    node = shutil.which('node')
    if not node:
        pytest.skip('Node.js is required for CSV upload checks')
    subprocess.run([node, '--test', 'tests/guest_push_csv_client.test.cjs'],
                   cwd=Path(__file__).resolve().parents[1], check=True, timeout=30)
