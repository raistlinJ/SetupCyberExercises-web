import pytest

from app.queue_labels import queue_label, request_label
from app.action_queue import public_record


@pytest.mark.parametrize('method,path,expected', [
    ('PATCH', '/api/projects/project-id/vms/agentic-VM', 'Save VM settings · agentic-VM'),
    ('PUT', '/api/projects/project-id/secrets', 'Save connection credentials'),
    ('POST', '/api/projects/project-id/instances/actions/users_perms', 'Set user permissions'),
    ('POST', '/api/projects/project-id/instances/refresh/vm', 'Refresh VM inventory'),
    ('POST', '/api/proxmox/nodes', 'Load Proxmox nodes'),
    ('POST', '/api/projects/project-id/ctfd/users_create', 'Create CTFd users'),
    ('DELETE', '/api/projects/project-id/materials/Example%20File.pdf', 'Delete material · Example File.pdf'),
    ('PATCH', '/api/projects/project-id', 'Save project settings'),
    ('POST', '/api/projects/import/start', 'Import project'),
    ('PATCH', '/api/unrecognized/private-id?token=secret', 'Save settings'),
])
def test_raw_request_titles_become_readable(method, path, expected):
    assert request_label(method, path) == expected
    assert queue_label(f'{method} {path}') == expected


def test_settings_label_uses_only_the_accessibility_flag():
    steps = [{'method': 'PATCH', 'url': '/api/projects/p/vms/agentic-VM', 'body': {'viewable_to_user': True}}]
    assert queue_label(None, steps) == 'Enable user-access setting · agentic-VM'
    steps[0]['body'] = {'viewable_to_user': False}
    assert queue_label(None, steps) == 'Disable user-access setting · agentic-VM'
    steps[0]['body']['password'] = 'secret'
    assert queue_label(None, steps) == 'Save VM settings · agentic-VM'
    assert queue_label('Create lab VMs (67 items)', steps) == 'Create lab VMs (67 items)'


def test_existing_history_is_formatted_without_payload_or_replaying_actions():
    row = dict(id=1, label='PATCH /api/projects/p/vms/agentic-VM', project='p',
               status='completed', created=1, started=2, finished=3, cancel=0,
               error='', step=1, total_steps=1, progress_state='{}')
    assert public_record(row)['label'] == 'Save VM settings · agentic-VM'
    assert row['label'].startswith('PATCH ')
