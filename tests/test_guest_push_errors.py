import io
import json
from unittest.mock import MagicMock, patch

import pytest
from flask import Flask

from app.routes import api
from app.storage.projects import Project


@pytest.mark.parametrize('guest_type', ['qemu', 'lxc'])
@pytest.mark.parametrize('source', ['upload', 'server', 'proxmox'])
def test_missing_owner_reports_actionable_error_for_each_push_source(tmp_path, guest_type, source):
    app = Flask(__name__)
    app.add_url_rule('/api/projects/<pid>/instances/actions/guest_push',
                     view_func=api.instances_lxc_push, methods=['POST'])
    project = Project(id='p', name='p')
    entry = {'vmid': 101, 'name': 'VM-homework-yeast-71', 'node': '127.0.0.1', 'type': guest_type}
    raw_error = (
        'Traceback (most recent call last):\n'
        '  File "/tmp/deployforge-qemu-helper-private.py", line 177, in run\n'
        'RuntimeError: chown: invalid user: âcorevmâ'
    )
    ssh = MagicMock()

    def execute(client, command, **kwargs):
        if command.startswith('rm -f -- '):
            return 0, b'', ''
        if command.startswith('python3 -c '):  # Proxmox source archive
            return 0, b'10240', ''
        return 1, b'', raw_error

    payload = {'ownerOnRemote': 'corevm', 'username': 'root@pam'}
    file = tmp_path / 'feedback.txt'
    file.write_text('feedback')
    if source == 'upload':
        request_kwargs = {'data': {
            'payload': json.dumps({**payload, 'destination': '/home/corevm'}),
            'files': (io.BytesIO(b'feedback'), 'feedback.txt'),
        }}
    else:
        request_kwargs = {'json': {
            **payload, 'source': 'host', 'sourceLocation': source,
            'transfers': [{'vmid': 101, 'sourcePath': str(file),
                           'destinationPath': '/home/corevm/feedback.txt'}],
        }}
    with patch.object(api, '_block_when_remote', return_value=None), \
            patch.object(api, '_guest_transfer_context', return_value=(
                project, MagicMock(), 'https://host', 'password', [entry], [], [])), \
            patch.object(api, '_ensure_linux_qemu_guest'), \
            patch.object(api, '_ssh_connect', return_value=ssh), \
            patch.object(api, '_ssh_exec_result', side_effect=execute), \
            patch.object(api, '_start_job'), patch.object(api, '_end_job'), \
            patch.object(api, '_update_job_detail'), patch.object(api, '_is_cancelled', return_value=False):
        response = app.test_client().post('/api/projects/p/instances/actions/guest_push', **request_kwargs)
    assert response.status_code == 200
    assert response.json['pushed'] == []
    error = response.json['errors'][0]
    assert error['name'] == entry['name']
    assert "Guest owner 'corevm' does not exist in this guest." in error['reason']
    assert 'existing guest username or numeric UID' in error['reason']
    assert 'Traceback' not in error['reason']
    assert 'deployforge-qemu-helper' not in error['reason']


def test_unrelated_push_errors_keep_their_diagnostic_details():
    reason = 'chown: changing ownership of /home/corevm/feedback.txt: Operation not permitted'
    assert api._guest_push_error_reason(RuntimeError(reason), 'corevm') == reason
