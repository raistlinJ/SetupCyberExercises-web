import shlex
import socket
import io
import time
from types import SimpleNamespace

import pytest

from app.backup_transfer import CHUNK_SIZE, WINDOW_SIZE, download_backup


class Channel:
    def __init__(self, chunks, status=0, stderr=b''):
        self.chunks = iter(chunks)
        self.status = status
        self.stderr = stderr
        self.closed = False

    def settimeout(self, timeout):
        assert timeout == 1

    def exec_command(self, command):
        self.command = command

    def recv(self, size):
        assert size <= CHUNK_SIZE
        result = next(self.chunks, b'')
        if isinstance(result, Exception):
            raise result
        return result

    def recv_stderr_ready(self):
        return bool(self.stderr)

    def recv_stderr(self, size):
        result, self.stderr = self.stderr[:size], self.stderr[size:]
        return result

    def exit_status_ready(self):
        return True

    def recv_exit_status(self):
        return self.status

    def close(self):
        self.closed = True


def connection(channel):
    def open_session(*, window_size):
        assert window_size == WINDOW_SIZE
        return channel
    return SimpleNamespace(get_transport=lambda: SimpleNamespace(open_session=open_session))


@pytest.mark.parametrize('size', [0, 7, 2 * CHUNK_SIZE + 37])
def test_stream_preserves_binary_bytes_and_reports_actual_progress(tmp_path, size):
    payload = (bytes(range(256)) * (size // 256 + 1))[:size]
    channel = Channel([payload[i:i + CHUNK_SIZE] for i in range(0, size, CHUNK_SIZE)])
    path = tmp_path / 'backup.vma.zst'
    progress = []
    assert download_backup(connection(channel), '/tmp/backup', path, size,
                           callback=lambda *args: progress.append(args)) == size
    assert path.read_bytes() == payload
    assert not path.with_suffix('.zst.part').exists()
    assert channel.closed
    if size:
        assert progress[-1] == (size, size)
        assert [done for done, _ in progress] == sorted(done for done, _ in progress)


def test_remote_path_is_shell_quoted(tmp_path):
    path = "/tmp/vm's backup/$(touch bad);.zst"
    channel = Channel([])
    download_backup(connection(channel), path, tmp_path / 'backup', 0)
    assert shlex.split(channel.command) == ['cat', '--', path]


@pytest.mark.parametrize(('chunks', 'size', 'status', 'stderr', 'message'), [
    ([b'abc'], 10, 0, b'', 'expected 10 bytes, received 3'),
    ([b'abc'], 2, 0, b'', 'Backup size changed'),
    ([], 0, 1, b'Permission denied', 'Permission denied'),
    ([], 0, -1, b'', 'exit -1'),
    ([ConnectionError('Disconnected')], 10, 0, b'', 'Disconnected'),
])
def test_failed_transfer_removes_partial_and_keeps_existing_file(tmp_path, chunks, size, status, stderr, message):
    channel = Channel(chunks, status, stderr)
    path = tmp_path / 'backup'
    path.write_bytes(b'previous')
    with pytest.raises((OSError, ConnectionError), match=message):
        download_backup(connection(channel), '/tmp/backup', path, size)
    assert path.read_bytes() == b'previous'
    assert not (tmp_path / 'backup.part').exists()
    assert channel.closed


@pytest.mark.parametrize('stalled', [False, True])
def test_cancel_during_stream_or_stall_removes_partial(tmp_path, stalled):
    channel = Channel([socket.timeout()] if stalled else [b'abc'])
    checks = 0

    def cancelled():
        nonlocal checks
        checks += 1
        return checks == 3

    with pytest.raises(InterruptedError):
        download_backup(connection(channel), '/tmp/backup', tmp_path / 'backup', 10, cancelled=cancelled)
    assert channel.closed
    assert not list(tmp_path.iterdir())


def test_stalled_stream_times_out_and_cleans_up(tmp_path, monkeypatch):
    ticks = iter([0, 0, 0, 121])
    monkeypatch.setattr('app.backup_transfer.time.monotonic', lambda: next(ticks))
    channel = Channel([socket.timeout()])
    with pytest.raises(TimeoutError, match='stalled'):
        download_backup(connection(channel), '/tmp/backup', tmp_path / 'backup', 10)
    assert channel.closed
    assert not list(tmp_path.iterdir())


@pytest.mark.parametrize('mode', ['truncated', 'remote_error', 'cancelled'])
def test_vm_export_stops_on_failed_download_without_packaging_or_deleting_remote_backups(tmp_path, monkeypatch, mode):
    from app import create_app
    from app.routes.api import _ACTIVE_JOBS, _job_key
    from app.storage.projects import ProjectStore, VMConfig

    monkeypatch.setenv('DATA_DIR', str(tmp_path))
    monkeypatch.setenv('AUTH_ENABLE', '0')
    app = create_app()
    client = app.test_client()
    pid = client.post('/api/projects', json={'name': 'Failed export'}).get_json()['id']
    store = ProjectStore(str(tmp_path))
    project = store.get(pid)
    project.proxmox_url = 'https://example.test:8006'
    project.vms = [VMConfig(name='vm-one', vmid=101)]
    store.upsert(project)
    commands = []

    class SFTP:
        def listdir(self, path):
            return ['backup.vma.zst']

        def stat(self, path):
            return SimpleNamespace(st_size=10)

        def close(self):
            self.closed = True

    class ExportChannel(Channel):
        def recv(self, size):
            if mode == 'cancelled':
                _ACTIVE_JOBS[_job_key(pid)]['cancel'] = True
            return super().recv(size)

    channel = ExportChannel([b'abc'], status=1 if mode == 'remote_error' else 0, stderr=b'Read failed')
    ssh = connection(channel)
    sftp = SFTP()
    ssh.open_sftp = lambda: sftp
    ssh.close = lambda: None

    def command(_ssh, cmd, **kwargs):
        commands.append(cmd)
        return io.BytesIO(), io.BytesIO()

    monkeypatch.setattr('app.routes.api.ProxmoxClient', lambda **kwargs: SimpleNamespace(list_nodes=lambda: []))
    monkeypatch.setattr('app.routes.api._ssh_connect', lambda *args: ssh)
    monkeypatch.setattr('app.routes.api._ssh_run_cmd', command)
    monkeypatch.setattr('app.routes.api._ssh_run_stream', lambda *args, **kwargs: ('', ''))
    assert client.post(f'/api/projects/{pid}/export/start', json={
        'includeVms': True, 'username': 'root@pam', 'password': 'test',
    }).status_code == 200
    deadline = time.monotonic() + 3
    while time.monotonic() < deadline:
        state = client.get(f'/api/projects/{pid}/export/status').get_json()
        if state['status'] in {'error', 'cancelled', 'completed'}:
            break
        time.sleep(0.01)
    assert state['status'] == ('cancelled' if mode == 'cancelled' else 'error'), state
    assert not state['downloadReady']
    assert not store.get(pid).exports
    assert not list(tmp_path.rglob('*.zip'))
    assert not list(tmp_path.rglob('*.part'))
    assert not any(cmd.startswith('rm -rf') for cmd in commands)
    assert sftp.closed and channel.closed
