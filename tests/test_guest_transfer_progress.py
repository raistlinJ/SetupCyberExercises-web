import base64
import io
from unittest.mock import MagicMock, patch

from app.routes import api
from app.storage.projects import Project


def test_byte_progress_is_independent_of_completed_guest_count():
    updates = []
    entry = {'name': 'model-vm'}
    def transfer(guest):
        api._transfer_bytes('Uploading to host', 512, 1024)
        api._transfer_bytes('Extracting in guest', 0)
        return [], []
    with patch.object(api, '_update_job_detail', side_effect=lambda pid, **fields: updates.append(fields)):
        api._run_guest_transfer_tasks(Project(id='p', name='p'), 'p', [entry], 'guest_push', transfer)
    uploading = next(item for item in updates if item.get('transferDirection') == 'Uploading to host')
    assert uploading['transferProgress'] == 50
    assert uploading['progress'] == 0
    assert '50%' in uploading['message']
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
