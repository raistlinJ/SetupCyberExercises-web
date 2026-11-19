import io
import json
import threading
import time
import zipfile
from unittest.mock import patch

import pytest

from app import create_app
from app.archive_progress import ArchiveEntries, ArchiveProgress


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv('DATA_DIR', str(tmp_path))
    monkeypatch.setenv('AUTH_ENABLE', '0')
    app = create_app()
    app.config['TESTING'] = True
    return app.test_client()


def wait_finished(client, url):
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        result = client.get(url).get_json()
        if result['status'] in {'completed', 'error', 'cancelled'}:
            assert result['status'] == 'completed', result
            return result
        time.sleep(0.01)
    pytest.fail('Archive job did not finish')


def block_mid_file(monkeypatch, phase):
    started, release = threading.Event(), threading.Event()
    original = ArchiveProgress.update

    def update(progress, **fields):
        original(progress, **fields)
        record = progress.record
        if (record.get('phase') == phase and not started.is_set()
                and 0 < (record.get('file_bytes_done') or 0) < (record.get('file_bytes_total') or 0)):
            started.set()
            assert release.wait(5), 'Test did not release archive worker'

    monkeypatch.setattr(ArchiveProgress, 'update', update)
    return started, release


def test_configuration_export_exposes_live_zip_steps_bytes_and_download(client, monkeypatch):
    pid = client.post('/api/projects', json={'name': 'Measured export'}).get_json()['id']
    payload = b'guide' * (700 * 1024)
    assert client.post(f'/api/projects/{pid}/materials', data={
        'file': (io.BytesIO(payload), 'guide.txt'),
    }, content_type='multipart/form-data').status_code == 201
    started, release = block_mid_file(monkeypatch, 'zip')
    try:
        with patch('app.routes.api._ssh_connect', side_effect=AssertionError('Configuration export must not use SSH')):
            response = client.post(f'/api/projects/{pid}/export/start', json={'includeVms': False})
            assert response.status_code == 200
            assert started.wait(3)
            state = client.get(f'/api/projects/{pid}/export/status').get_json()
            assert (state['step'], state['total_steps']) == (2, 3)
            assert state['phase'] == 'zip'
            assert 0 < state['bytes_done'] < state['bytes_total']
            assert 0 < state['file_bytes_done'] < state['file_bytes_total'] == len(payload)
            assert 33 <= state['progress'] < 67
            assert 0 < state['phase_progress'] < 100
            assert state['current'].startswith('materials/')
    finally:
        release.set()
    final = wait_finished(client, f'/api/projects/{pid}/export/status')
    assert (final['step'], final['total_steps'], final['progress']) == (3, 3, 100)
    exported = client.get(f'/api/projects/{pid}/export/download')
    assert final['archive_bytes'] == len(exported.data)
    with zipfile.ZipFile(io.BytesIO(exported.data)) as archive:
        material = next(name for name in archive.namelist() if name.startswith('materials/'))
        assert archive.read(material) == payload


def test_import_exposes_live_unzip_steps_and_uncompressed_bytes(client, monkeypatch):
    payload = b'guide' * (700 * 1024)
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr('project.json', json.dumps({'project': {'id': 'source', 'name': 'Measured import'}}))
        archive.writestr('materials/source/guide.txt', payload)
    buf.seek(0)
    started, release = block_mid_file(monkeypatch, 'unzip')
    try:
        response = client.post('/api/projects/import/start', data={
            'file': (buf, 'measured.zip'), 'includeVms': 'false',
        }, content_type='multipart/form-data')
        assert response.status_code == 200
        url = '/api/projects/import/status?id=' + response.get_json()['job']
        assert started.wait(3)
        state = client.get(url).get_json()
        assert (state['step'], state['total_steps']) == (3, 5)
        assert state['phase'] == 'unzip'
        assert 0 < state['bytes_done'] < state['bytes_total'] == len(payload)
        assert 0 < state['phase_progress'] < 100
        assert state['item_total'] == 1
        assert state['item_completed'] == 0
    finally:
        release.set()
    final = wait_finished(client, url)
    assert (final['step'], final['total_steps'], final['progress']) == (5, 5, 100)
    pid = final['imported'][0]['id']
    material = client.get(f'/api/projects/{pid}/materials').get_json()['materials'][0]
    assert client.get(f'/api/projects/{pid}/materials/{material}').data == payload


def test_archive_copy_is_bounded_and_counts_zero_byte_files(tmp_path):
    snapshots = []
    record = {'status': 'processing'}
    progress = ArchiveProgress(record, ['zip'], report=lambda fields: snapshots.append(dict(fields)))
    entries = ArchiveEntries()
    entries.writestr('empty.txt', b'')
    entries.writestr('large.txt', b'x' * (3 * 1024 * 1024 + 7))
    entries.pack(tmp_path / 'archive.zip', progress, 0)
    assert record['bytes_done'] == record['bytes_total'] == 3 * 1024 * 1024 + 7
    assert record['item_completed'] == record['item_total'] == 2
    assert record['phase_progress'] == 100
    assert record['progress'] < 100, 'Finalization must finish before overall progress reaches 100%'
    progress.finish('Complete')
    assert record['progress'] == 100
    assert [row['progress'] for row in snapshots] == sorted(row['progress'] for row in snapshots)


def test_pack_preserves_compressed_backups_without_recompression(tmp_path):
    entries = ArchiveEntries()
    backup = b'already compressed disk bytes'
    entries.writestr('backups/vm-one/backup.vma.zst', backup)
    entries.writestr('backups/vm-one/backup.log', b'backup details')
    entries.writestr('project.json', '{}')
    path = tmp_path / 'export.zip'
    entries.pack(path, ArchiveProgress({}, ['zip']), 0)
    with zipfile.ZipFile(path) as archive:
        assert archive.read('backups/vm-one/backup.vma.zst') == backup
        assert archive.getinfo('backups/vm-one/backup.vma.zst').compress_type == zipfile.ZIP_STORED
        assert archive.getinfo('backups/vm-one/backup.log').compress_type == zipfile.ZIP_DEFLATED
        assert archive.getinfo('project.json').compress_type == zipfile.ZIP_DEFLATED


def test_cancelling_mid_zip_removes_partial_archive(tmp_path):
    record = {'status': 'processing'}
    progress = ArchiveProgress(record, ['zip'])
    entries = ArchiveEntries()
    entries.writestr('large.txt', b'x' * (3 * 1024 * 1024))
    original = progress.update

    def cancel(**fields):
        original(**fields)
        if (record.get('bytes_done') or 0) >= 1024 * 1024:
            record['cancel'] = True

    progress.update = cancel
    path = tmp_path / 'cancelled.zip'
    with pytest.raises(InterruptedError):
        entries.pack(path, progress, 0)
    assert not path.exists()
    assert record['progress'] < 100


def test_vm_export_exposes_download_bytes_and_uses_reported_backup_percentage(client, monkeypatch):
    from types import SimpleNamespace
    from app.storage.projects import ProjectStore, VMConfig

    pid = client.post('/api/projects', json={'name': 'Measured VM export'}).get_json()['id']
    store = ProjectStore(client.application.config['DATA_DIR'])
    project = store.get(pid)
    project.proxmox_url = 'https://proxmox.example.test:8006'
    project.vms = [VMConfig(name='vm-one', vmid=101)]
    store.upsert(project)
    payload = b'x' * (3 * 1024 * 1024)

    class SFTP:
        def listdir(self, path):
            return ['backup.vma.zst']

        def stat(self, path):
            return SimpleNamespace(st_size=len(payload))

        def close(self):
            pass

    from test_backup_transfer import Channel, connection
    channel = Channel([payload[i:i + 1024 * 1024] for i in range(0, len(payload), 1024 * 1024)])
    ssh = connection(channel)
    ssh.open_sftp = SFTP
    ssh.close = lambda: None
    monkeypatch.setattr('app.routes.api.ProxmoxClient', lambda **kwargs: SimpleNamespace(list_nodes=lambda: []))
    monkeypatch.setattr('app.routes.api._ssh_connect', lambda *args: ssh)
    monkeypatch.setattr('app.routes.api._ssh_run_cmd', lambda *args, **kwargs: (io.BytesIO(), io.BytesIO()))
    backup_percentages = []

    def stream(*args, **kwargs):
        callback = kwargs.get('on_stdout_line')
        if callback:
            from app.routes.api import _ACTIVE_JOBS, _job_key
            for line in ['Starting backup', '10% transferred', 'Still working', '50% transferred']:
                callback(line)
                backup_percentages.append(_ACTIVE_JOBS[_job_key(pid)]['phase_progress'])
        return '', ''

    monkeypatch.setattr('app.routes.api._ssh_run_stream', stream)
    started, release = block_mid_file(monkeypatch, 'download')
    try:
        response = client.post(f'/api/projects/{pid}/export/start', json={
            'includeVms': True, 'username': 'root@pam', 'password': 'test',
        })
        assert response.status_code == 200
        assert started.wait(3)
        state = client.get(f'/api/projects/{pid}/export/status').get_json()
        assert (state['step'], state['total_steps']) == (3, 6)
        assert state['bytes_done'] == 1024 * 1024
        assert state['bytes_total'] == len(payload)
        assert state['current'] == 'vm-one/backup.vma.zst'
        assert backup_percentages == [0, 10, 10, 50], 'Log lines without percentages must not invent progress'
    finally:
        release.set()
    final = wait_finished(client, f'/api/projects/{pid}/export/status')
    assert final['downloadReady']
    assert any('MiB/s' in line for line in final['log'])
    exported = client.get(f'/api/projects/{pid}/export/download')
    with zipfile.ZipFile(io.BytesIO(exported.data)) as archive:
        assert archive.read('backups/vm-one/backup.vma.zst') == payload


def test_vm_import_exposes_bytes_while_unzipping_and_uploading_backup(client, monkeypatch):
    from types import SimpleNamespace
    payload = b'x' * (3 * 1024 * 1024)
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr('project.json', json.dumps({'project': {
            'id': 'source', 'name': 'Measured VM import', 'vms': [{'name': 'vm-one', 'vmid': 101}],
        }}))
        archive.writestr('backups/vm-one/backup.vma.zst', payload)
    buf.seek(0)

    class SFTP:
        def putfo(self, source, remote, file_size=None, callback=None):
            transferred = 0
            while chunk := source.read(1024 * 1024):
                transferred += len(chunk)
                callback(transferred, file_size)

    monkeypatch.setattr('app.routes.api.ProxmoxClient', lambda **kwargs: SimpleNamespace(cluster_nextid=lambda: 9001))
    monkeypatch.setattr('app.routes.api._ssh_connect', lambda *args: SimpleNamespace(open_sftp=SFTP, close=lambda: None))
    monkeypatch.setattr('app.routes.api._ssh_run_cmd', lambda *args, **kwargs: (None, None))
    monkeypatch.setattr('app.routes.api._ssh_run_stream', lambda *args, **kwargs: ('', ''))
    started, release = block_mid_file(monkeypatch, 'restore')
    try:
        response = client.post('/api/projects/import/start', data={
            'file': (buf, 'restore.zip'), 'includeVms': 'true', 'baseUrl': 'https://proxmox.example.test',
            'username': 'root@pam', 'password': 'test',
        }, content_type='multipart/form-data')
        assert response.status_code == 200
        url = '/api/projects/import/status?id=' + response.get_json()['job']
        assert started.wait(3)
        state = client.get(url).get_json()
        assert (state['step'], state['total_steps']) == (4, 5)
        assert state['bytes_done'] == 1024 * 1024
        assert state['bytes_total'] == len(payload)
        assert 'Extracting and uploading' in state['message']
        assert state['current'] == 'backups/vm-one/backup.vma.zst'
        assert state['phase_progress'] < 50, 'VM restore still remains after the upload'
    finally:
        release.set()
    final = wait_finished(client, url)
    assert final['imported'][0]['vms'][0]['vmid'] == 9001
