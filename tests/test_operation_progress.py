from concurrent.futures import Future

from flask import Flask, g

from app.routes import api


def test_batch_progress_counts_processed_items_and_keeps_credentials_private():
    reports = []
    items = [{'name': 'vm1', 'vmid': 101, 'node': 'node1', 'password': 'secret'},
             {'name': 'vm2', 'vmid': 102, 'username': 'alice', 'token': 'private'}]
    errors = []
    for item in api._job_items('p', items, 'networking', 'Updating network for',
                               report=reports.append, summary=lambda: f'{len(errors)} errors'):
        assert item['name'] in reports[-1]['message']
        assert reports[-1]['progress'] < 95
        if item['vmid'] == 101:
            errors.append('failed')
            continue
    assert '2/2 processed' in reports[-1]['message']
    assert '1 errors' in reports[-1]['message']
    assert reports[-1]['progress'] == 95
    assert 'VM 101' in str(reports)
    assert 'node node1' in str(reports)
    assert 'secret' not in str(reports)
    assert 'private' not in str(reports)
    percentages = [r['progress'] for r in reports]
    assert percentages == sorted(percentages)


def test_interrupted_batch_does_not_count_unfinished_item():
    reports = []
    iterator = api._job_items('p', ['first', 'second'], 'users', 'Updating', report=reports.append)
    assert next(iterator) == 'first'
    iterator.close()
    assert reports[-1]['progress'] == 10
    assert '0/2 processed' in reports[-1]['message']


def test_streaming_futures_keep_active_worker_status_until_a_result_arrives():
    reports = []
    future = Future()
    for value in api._job_items('p', iter([future]), 'networking', 'Applying', total=1,
                                label=lambda f: 'vm1', report=reports.append):
        assert value is future
    assert 'message' not in reports[0]
    assert reports[-1]['progress'] == 95


def test_reporting_failure_does_not_interrupt_operation():
    def broken_report(fields):
        raise RuntimeError('status store unavailable')
    assert list(api._job_items('p', [1, 2], 'users', 'Checking', report=broken_report)) == [1, 2]


def test_ctfd_progress_is_isolated_from_overlapping_vm_action():
    app = Flask(__name__)
    api._start_job('p', 'create')
    api._update_job_detail('p', progress=42, message='Cloning VM')
    original = dict(api._ACTIVE_JOBS[api._job_key('p')])
    reports = []
    try:
        with app.test_request_context():
            g.action_queue_progress = reports.append
            list(api._job_items('p', [{'username': 'alice', 'password': 'secret'}],
                                'ctfd_users', 'Creating user', report=api._queue_progress_reporter()))
        assert api._ACTIVE_JOBS[api._job_key('p')] == original
        assert 'alice' in reports[-1]['message']
        assert 'secret' not in str(reports)
    finally:
        api._ACTIVE_JOBS.pop(api._job_key('p'), None)


def test_ctfd_user_delete_reports_active_user_and_partial_errors(monkeypatch):
    from types import SimpleNamespace
    from unittest.mock import MagicMock

    app = Flask(__name__)
    reports = []
    project = SimpleNamespace(credentials=[{'username': 'alice', 'password': 'secret'}, {'username': 'bob'}])
    client = MagicMock(token='', logs=[])
    client.get_role.return_value = 'admin'
    client.find_user_id_by_name.side_effect = [1, 2]
    active = []
    def delete_user(user_id):
        active.append(dict(reports[-1]))
        if user_id == 2:
            raise RuntimeError('remote delete failed')
    client.delete_user.side_effect = delete_user
    monkeypatch.setattr(api, '_store', lambda: SimpleNamespace(get=lambda pid: project))
    monkeypatch.setattr(api, '_ctfd_client_from_req', lambda proj: client)
    with app.test_request_context(json={}):
        g.action_queue_progress = reports.append
        response = api.ctfd_users_delete.__wrapped__('p')
    assert response.status_code == 200
    assert 'Deleting CTFd user alice' in active[0]['message']
    assert 'Deleting CTFd user bob' in active[1]['message']
    assert '2/2 processed' in reports[-1]['message']
    assert '1 errors' in reports[-1]['message']
    assert 'secret' not in str(reports)


def test_empty_phase_keeps_previous_detail():
    reports = []
    assert list(api._job_items('p', [], 'network', 'Reloading', report=reports.append)) == []
    assert reports == []
