import base64
import io
from unittest.mock import MagicMock, patch

import pytest

from app.routes import api
from app.storage.projects import Project


@pytest.mark.parametrize('phase', ['guest_push', 'guest_pull'])
def test_byte_progress_is_independent_of_completed_guest_count(phase):
    updates = []
    entry = {'name': 'model-vm'}
    def transfer(guest):
        api._transfer_bytes('Uploading to host', 512, 1024)
        api._transfer_bytes('Extracting in guest', 0)
        return [], []
    with patch.object(api, '_update_job_detail', side_effect=lambda pid, **fields: updates.append(fields)):
        api._run_guest_transfer_tasks(Project(id='p', name='p'), 'p', [entry] * 3, phase, transfer)
    assert updates[0]['message'].startswith('3/3 machines remaining')
    completed_updates = [item for item in updates if 'step' in item]
    assert [item['message'].split(' · ')[0] for item in completed_updates] == [
        '2/3 machines remaining', '1/3 machines remaining', '0/3 machines remaining',
    ]
    uploading = next(item for item in updates if item.get('transferDirection') == 'Uploading to host')
    assert uploading['transferProgress'] == 50
    assert uploading['progress'] == 0
    assert '50%' in uploading['message']
    assert uploading['message'].startswith('3/3 machines remaining')
    assert uploading['current'] == 'model-vm'
    extracting = next(item for item in updates if item.get('transferDirection') == 'Extracting in guest')
    assert extracting['transferProgress'] is None
    assert updates[-1]['transferDirection'] == ''
    assert not hasattr(api._TRANSFER_PROGRESS, 'report')


def test_qemu_download_reports_actual_archive_byte_percentage():
    client = MagicMock()
    client.agent_file_read.side_effect = [
        {'content': base64.b64encode(b'a' * (4 * 1024 * 1024)).decode(), 'truncated': True, 'bytes-read': 4 * 1024 * 1024},
        {'content': base64.b64encode(b'b' * (4 * 1024 * 1024)).decode(), 'bytes-read': 4 * 1024 * 1024},
    ]
    def execute(*args, **kwargs):
        return {'stdout': str(8 * 1024 * 1024)}
    with patch.object(api, '_ensure_linux_qemu_guest'), patch.object(api, '_guest_agent_exec_checked', side_effect=execute), \
            patch.object(api, '_transfer_bytes') as progress:
        stream = api._pull_tar_through_guest_agent(client, {'vmid': 101, 'node': 'n'}, ['/model.gguf'])
        stream.close()
    progress.assert_any_call('Downloading from guest', 4 * 1024 * 1024, 8 * 1024 * 1024)
    progress.assert_any_call('Downloading from guest', 8 * 1024 * 1024, 8 * 1024 * 1024)


def test_remote_progress_lines_are_delivered_before_ssh_result():
    stdout = io.BytesIO(b'TRANSFER_BYTES=512\nTRANSFER_EXTRACTING\n')
    stdout.channel = MagicMock()
    stdout.channel.recv_exit_status.return_value = 0
    lines = []
    with patch.object(api, '_ssh_run_cmd', return_value=(stdout, io.BytesIO())):
        code, output, error = api._ssh_exec_result(None, 'test', on_stdout_line=lines.append)
    assert code == 0
    assert lines == [b'TRANSFER_BYTES=512\n', b'TRANSFER_EXTRACTING\n']


@pytest.mark.parametrize('phase', ['guest_push', 'guest_pull'])
def test_cancel_stops_active_transfer_and_skips_waiting_machines(phase):
    cancelled = False
    started, cleaned = [], []

    def transfer(entry):
        nonlocal cancelled
        started.append(entry['name'])
        try:
            api._transfer_bytes('Transferring', 0, 100)
            cancelled = True
            api._transfer_bytes('Transferring', 10, 100)
            pytest.fail('Transfer continued after cancellation')
        finally:
            cleaned.append(entry['name'])

    with patch.object(api, '_is_cancelled', side_effect=lambda pid: cancelled), \
            patch.object(api, '_update_job_detail'), \
            patch.object(api, '_pool_workers_for', return_value=1):
        results = api._run_guest_transfer_tasks(
            Project(id='p', name='p'), 'p', [{'name': str(i)} for i in range(5)], phase, transfer,
        )
    assert started == cleaned == ['0']
    assert results == [([], [])] * 5


@pytest.mark.parametrize('direction', ['push', 'pull'])
def test_guest_agent_cancel_removes_remote_temporary_archive(direction):
    commands = []
    def execute(client, entry, command, **kwargs):
        commands.append(command[-1])
        return {'stdout': '1024'}

    api._TRANSFER_PROGRESS.cancelled = lambda: True
    try:
        with patch.object(api, '_ensure_linux_qemu_guest'), \
                patch.object(api, '_guest_agent_exec_checked', side_effect=execute):
            with pytest.raises(api._GuestTransferCancelled):
                if direction == 'push':
                    api._push_tar_through_guest_agent(None, {}, io.BytesIO(b'hello'), 5, '/tmp/files')
                else:
                    api._pull_tar_through_guest_agent(None, {}, ['/tmp/files'])
    finally:
        del api._TRANSFER_PROGRESS.cancelled
    assert commands[-1].startswith('rm -f -- /tmp/deployforge-qemu-')


def test_staged_push_cancel_waits_for_remote_cleanup():
    cancelled = False
    events = []

    def ssh(client, command, **kwargs):
        nonlocal cancelled
        if command.startswith('touch -- '):
            events.append('signal')
            return 0, b'', ''
        if command.startswith('rm -f -- '):
            events.append('remove signal')
            return 0, b'', ''
        cancelled = True
        kwargs['on_stdout_line'](b'TRANSFER_BYTES=512\n')
        kwargs['on_stdout_line'](b'TRANSFER_BYTES=1024\n')
        events.append('remote cleanup finished')
        return 1, b'', 'Transfer cancelled'

    api._TRANSFER_PROGRESS.cancelled = lambda: cancelled
    try:
        with patch.object(api, '_ssh_exec_result', side_effect=ssh):
            with pytest.raises(api._GuestTransferCancelled):
                api._push_staged_tar_to_qemu(None, {'vmid': 101}, '/tmp/staged.tar', 2048, '/files', False, '')
    finally:
        del api._TRANSFER_PROGRESS.cancelled
    assert events == ['signal', 'remote cleanup finished', 'remove signal']
