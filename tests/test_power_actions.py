import threading

from unittest.mock import MagicMock, patch

import pytest
from flask import Flask, g

from app.routes import api
from app.storage.projects import Project


@pytest.mark.parametrize('guest_type', ['qemu', 'lxc'])
@pytest.mark.parametrize('paused', [True, False])
def test_start_resumes_paused_guests_and_reports_remaining(guest_type, paused):
    project = Project(id='power-test', name='Power', proxmox_url='https://pve.local')
    target = {'name': 'vm', 'index': 1, 'vmid': 101, 'node': 'n', 'type': guest_type, 'status': 'running'}
    client = MagicMock()
    client.get_qemu_config.return_value = {}
    state = {'status': 'running', 'qmpstatus': 'paused'} if paused and guest_type == 'qemu' else {'status': 'suspended' if paused else 'stopped'}
    getattr(client, f'get_{guest_type}_status_current').return_value = state
    reports = []
    with Flask(__name__).test_request_context(json={'username': 'root', 'password': 'pw', 'targets': [target]}), \
            patch.object(api, '_store') as store, patch.object(api, 'ProxmoxClient', return_value=client), \
            patch.object(api, '_resolve_targets_to_vm_info', return_value=([target], [], [])):
        store.return_value.get.return_value = project
        g.action_queue_progress = reports.append
        payload = api.instances_start(project.id).get_json()
    getattr(client, f'{"resume" if paused else "start"}_{guest_type}').assert_called_once_with(node='n', vmid=101)
    getattr(client, f'{"start" if paused else "resume"}_{guest_type}').assert_not_called()
    assert len(payload['resumed' if paused else 'started']) == 1
    assert any(r.get('message', '').startswith('1/1 machines remaining') for r in reports)
    assert reports[-1]['message'].startswith('0/1 machines remaining')


@pytest.mark.parametrize('guest_type', ['qemu', 'lxc'])
def test_pause_uses_suspend_and_reports_remaining(guest_type):
    project = Project(id='power-test', name='Power', proxmox_url='https://pve.local')
    target = {'name': 'vm', 'index': 1, 'vmid': 101, 'node': 'n', 'type': guest_type}
    client = MagicMock()
    client.get_qemu_config.return_value = {}
    reports = []
    with Flask(__name__).test_request_context(json={'username': 'root', 'password': 'pw', 'targets': [target]}), \
            patch.object(api, '_store') as store, patch.object(api, 'ProxmoxClient', return_value=client), \
            patch.object(api, '_resolve_targets_to_vm_info', return_value=([target], [], [{'reason': 'unresolved target'}])):
        store.return_value.get.return_value = project
        g.action_queue_progress = reports.append
        payload = api.instances_suspend(project.id).get_json()
    getattr(client, f'suspend_{guest_type}').assert_called_once_with(node='n', vmid=101)
    assert client._wait_task.call_args.kwargs['completed_vm_statuses'] == ['paused', 'suspended']
    assert len(payload['suspended']) == 1
    assert reports[-1]['message'].startswith('0/1 machines remaining')
    assert reports[-1]['detail']['completed'] == 1


def test_paused_qemu_is_not_treated_as_already_started():
    assert not api._vm_retry_state_matches('start', {'power_status': 'running', 'qmp_status': 'paused'})[0]


@pytest.mark.parametrize('limit', [1, 2, 4])
@pytest.mark.parametrize('action', ['pause', 'start_resume', 'hibernate'])
def test_power_operations_hold_max_jobs_slots_until_remote_tasks_finish(limit, action):
    project = Project(id='power-limit', name='Power', proxmox_url='https://pve.local',
                      proxmox_max_create_jobs=limit)
    targets = [{'name': f'vm{i}', 'index': i + 1, 'vmid': 100 + i, 'node': 'n',
                'type': 'qemu' if action == 'hibernate' or i % 2 == 0 else 'lxc'} for i in range(8)]
    client = MagicMock()
    client.get_qemu_config.return_value = {}
    client.get_qemu_status_current.return_value = {'status': 'running', 'qmpstatus': 'paused'}
    client.get_lxc_status_current.return_value = {'status': 'stopped'}
    lock = threading.Lock()
    barrier = threading.Barrier(limit)
    active = peak = finished = 0

    def submit(**kwargs):
        nonlocal active, peak
        with lock:
            active += 1
            peak = max(peak, active)
        return f"task-{kwargs['vmid']}"

    def wait(*args, **kwargs):
        nonlocal active, finished
        try:
            # A job continues occupying its slot while Proxmox is working.
            barrier.wait(timeout=3)
        finally:
            with lock:
                active -= 1
                finished += 1

    for method in ('suspend_qemu', 'suspend_lxc', 'resume_qemu', 'start_lxc', 'hibernate_qemu'):
        getattr(client, method).side_effect = submit
    client._wait_task.side_effect = wait
    with Flask(__name__).test_request_context('/hibernate' if action == 'hibernate' else '/', json={'username': 'root', 'password': 'pw', 'targets': targets}), \
            patch.object(api, '_store') as store, patch.object(api, 'ProxmoxClient', return_value=client), \
            patch.object(api, '_resolve_targets_to_vm_info', return_value=(targets, [], [])):
        store.return_value.get.return_value = project
        endpoint = api.instances_start if action == 'start_resume' else api.instances_suspend
        payload = endpoint(project.id).get_json()
    assert payload['errors'] == []
    assert peak == limit
    assert active == 0
    assert finished == len(targets)
    if action == 'start_resume':
        assert len(payload['started']) == len(payload['resumed']) == 4
    else:
        assert len(payload['suspended']) == len(targets)


def test_start_resumes_saved_disk_state():
    project = Project(id='disk-resume', name='Power', proxmox_url='https://pve.local')
    target = {'name': 'vm', 'index': 1, 'vmid': 101, 'node': 'n', 'type': 'qemu'}
    client = MagicMock()
    client.get_qemu_status_current.return_value = {'status': 'stopped'}
    client.get_qemu_config.return_value = {'lock': 'suspended', 'vmstate': 'local:state'}
    with Flask(__name__).test_request_context(json={'username': 'root', 'password': 'pw', 'targets': [target]}), \
            patch.object(api, '_store') as store, patch.object(api, 'ProxmoxClient', return_value=client), \
            patch.object(api, '_resolve_targets_to_vm_info', return_value=([target], [], [])):
        store.return_value.get.return_value = project
        payload = api.instances_start(project.id).get_json()
    client.resume_qemu.assert_called_once_with(node='n', vmid=101)
    client.start_qemu.assert_not_called()
    assert len(payload['resumed']) == 1


def test_hibernate_connector_requests_disk_state():
    from app.connectors.proxmox import ProxmoxClient
    with patch.object(ProxmoxClient, '_qemu_status_action', return_value='task') as action:
        client = ProxmoxClient(base_url='https://pve.local', token='token')
        assert client.hibernate_qemu('n', 101) == 'task'
    action.assert_called_once_with('n', 101, 'suspend', data={'todisk': 1})


def test_disk_suspend_skips_containers_without_pausing_them():
    project = Project(id='disk-container', name='Power', proxmox_url='https://pve.local')
    target = {'name': 'ct', 'index': 1, 'vmid': 101, 'node': 'n', 'type': 'lxc'}
    client = MagicMock()
    with Flask(__name__).test_request_context('/hibernate', json={'username': 'root', 'password': 'pw', 'targets': [target]}), \
            patch.object(api, '_store') as store, patch.object(api, 'ProxmoxClient', return_value=client), \
            patch.object(api, '_resolve_targets_to_vm_info', return_value=([target], [], [])):
        store.return_value.get.return_value = project
        payload = api.instances_suspend(project.id).get_json()
    client.suspend_lxc.assert_not_called()
    client.hibernate_qemu.assert_not_called()
    assert len(payload['skipped']) == 1
    assert 'use Pause' in payload['skipped'][0]['reason']
