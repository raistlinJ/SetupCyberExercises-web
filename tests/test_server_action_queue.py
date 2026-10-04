import io
import base64
import zipfile
import json
import sqlite3
import threading
import time

import pytest
from flask import Flask, jsonify, request, session

from app.action_queue import ActionQueue, init_action_queue, public_record
from app.routes import api


@pytest.mark.parametrize('status', ['completed', 'error'])
def test_queue_full_log_preserves_all_command_output_and_owner_access(harness, status):
    app, client, *_ = harness
    job = enqueue(client, 'logs').get_json()
    wait_terminal(client, job['id'])
    output = 'long output\n' * 1000 + '<script>literal output</script>\nEND OF LOG'
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, 'w') as archive:
        archive.writestr('vm1/step_01/cmd_01.txt', output)
        archive.writestr('vm2/step_01/cmd_01.txt', 'STDERR: guest agent error')
    result = {'outputs_zip': {'filename': 'stored_cmd_outputs_test.zip',
                             'base64': base64.b64encode(buffer.getvalue()).decode()}}
    with app.extensions['action_queue'].connect() as db:
        db.execute('UPDATE actions SET result=?, status=? WHERE id=?',
                   (json.dumps(result).encode(), status, job['id']))
    record = client.get(f"/api/queue/{job['id']}").get_json()
    response = client.get(record['logUrl'])
    assert response.status_code == 200
    assert response.mimetype == 'text/plain'
    assert output in response.get_data(as_text=True)
    assert 'STDERR: guest agent error' in response.get_data(as_text=True)
    assert 'base64' not in response.get_data(as_text=True)
    with client.session_transaction() as sess:
        sess['user'] = 'bob'
    assert client.get(record['logUrl']).status_code == 404


@pytest.mark.parametrize('result, expected', [
    ({'results': [{'log': ['first', 'last']}, {'logs': 'second step'}]}, 'first\nlast\n\nsecond step'),
    ({'ok': True}, None),
    ({'outputs_zip': {'filename': 'guest_pull_test.zip', 'base64': 'file-data'}}, None),
])
def test_queue_log_available_even_without_command_output(harness, result, expected):
    app, client, *_ = harness
    job = enqueue(client, 'log-availability').get_json()
    wait_terminal(client, job['id'])
    with app.extensions['action_queue'].connect() as db:
        db.execute('UPDATE actions SET result=? WHERE id=?', (json.dumps(result).encode(), job['id']))
    record = client.get(f"/api/queue/{job['id']}").get_json()
    response = client.get(f"/api/queue/{job['id']}/log")
    assert record['logUrl']
    assert response.status_code == 200
    assert 'Completed:' in response.get_data(as_text=True)
    assert 'base64' not in response.get_data(as_text=True).lower()
    if expected:
        assert expected in response.get_data(as_text=True)


@pytest.fixture
def harness(tmp_path):
    app = Flask(__name__)
    app.config.update(TESTING=True, SECRET_KEY='test', DATA_DIR=str(tmp_path), AUTH_ENABLE=True)
    app.current_user = lambda: {'username': session['user']} if session.get('user') else None
    started, release, finished = threading.Event(), threading.Event(), threading.Event()
    calls = []

    @app.get('/page/<name>')
    def page(name):
        return name

    @app.post('/api/work/<name>')
    @api._secure_route()
    def work(name):
        calls.append((name, session['user'], request.get_json(silent=True)))
        if name == 'first':
            started.set()
            assert release.wait(5)
        if name == 'last':
            finished.set()
        if name == 'error':
            return jsonify(error='Failure'), 422
        if name == 'partial':
            return jsonify(errors=[{'reason': 'Remote operation failed'}])
        return jsonify(name=name)

    @app.post('/api/upload')
    def upload():
        calls.append((request.form['destination'], [(file.filename, file.read()) for file in request.files.getlist('files')]))
        finished.set()
        return jsonify(ok=True)

    @app.post('/api/projects')
    def create_project():
        calls.append('create-project')
        return jsonify(id='new-project'), 201

    @app.post('/api/projects/<pid>/follow-up')
    def project_follow_up(pid):
        calls.append(pid)
        finished.set()
        return jsonify(ok=True)

    @app.post('/api/projects/<pid>/instances/actions/create')
    def create_vms(pid):
        calls.append('create-vms')
        body = request.get_json()
        return jsonify(body['result']), body.get('status', 200)

    app.add_url_rule('/api/projects/<pid>/instances/actions/start',
                     view_func=api.instances_start, methods=['POST'])

    app.add_url_rule('/api/projects/<pid>/instances/actions/run_stored_cmds',
                     view_func=api.instances_run_stored_cmds, methods=['POST'])

    @app.post('/api/projects/import/start')
    def async_import():
        api._ACTIVE_JOBS[api._import_job_key('child')] = {'id': 'child', 'status': 'running'}
        started.set()
        return jsonify(job='child')

    @app.get('/api/download')
    def download():
        return app.response_class(b'\x00\xff\x01', headers={'Content-Type': 'application/zip', 'Content-Disposition': 'attachment; filename=archive.zip'})

    @app.post('/api/cooperative')
    def cooperative():
        api._start_job('queue-test', 'test')
        started.set()
        deadline = time.monotonic() + 5
        while not api._is_cancelled('queue-test') and time.monotonic() < deadline:
            time.sleep(.01)
        finished.set()
        return jsonify(cancelled=api._is_cancelled('queue-test'))

    @app.post('/api/progress')
    def progress():
        api._start_job('queue-test', 'create')
        # Real action endpoints also report from pool threads without a Flask
        # request context. Keep the operation blocked so we can inspect it live.
        reporter = threading.Thread(target=lambda: api._update_job_detail(
            'queue-test', progress=40, phase='cloning', current='vm1', item_total=5, item_completed=2,
            message='Cloning vm1', detail={'password': 'must-not-be-published'}))
        reporter.start()
        reporter.join()
        started.set()
        assert release.wait(5)
        return jsonify(ok=True)

    init_action_queue(app)
    client = app.test_client()
    with client.session_transaction() as sess:
        sess['user'] = 'alice'
    yield app, client, started, release, finished, calls
    release.set()
    if 'action_queue' in app.extensions:
        app.extensions['action_queue'].close()
    with api._JOB_LOCK:
        api._ACTIVE_JOBS.pop(api._job_key('queue-test'), None)
        api._ACTIVE_JOBS.pop(api._import_job_key('child'), None)


def enqueue(client, name, **extra):
    return client.post('/api/queue', json={'token': name, 'label': name,
        'steps': [{'method': 'POST', 'url': f'/api/work/{name}', 'body': {'captured': name}}], **extra})


def test_failed_pull_retains_archives_and_finishes_other_projects(harness):
    app, client, *_ = harness

    def pull(pid):
        return jsonify(errors=[{'reason': 'guest agent unavailable'}] if pid == 'one' else [],
                       outputs_zip={'filename': f'{pid}.zip', 'base64': 'archive', 'auto_download': True})

    app.add_url_rule('/api/projects/<pid>/instances/actions/guest_pull', view_func=pull, methods=['POST'])
    job = enqueue(client, 'pull-projects', steps=[
        {'method': 'POST', 'url': f'/api/projects/{pid}/instances/actions/guest_pull'}
        for pid in ('one', 'two')
    ]).get_json()
    state = wait_terminal(client, job['id'])
    assert state['status'] == 'error'
    assert 'Guest pull reported errors' in state['errorMessage']
    result = client.get(f"/api/queue/{job['id']}/result").get_json()
    assert [entry['outputs_zip']['filename'] for entry in result['results']] == ['one.zip', 'two.zip']


def wait_terminal(client, job_id):
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        state = client.get(f'/api/queue/{job_id}').get_json()
        if state['status'] not in {'queued', 'running'}:
            return state
        time.sleep(.01)
    pytest.fail('Worker did not finish')


@pytest.mark.parametrize('error_field', ['errors', 'network_apply_errors'])
def test_partial_create_runs_permissions_and_other_followups_but_preserves_errors(harness, error_field):
    app, client, started, release, finished, calls = harness
    partial = {'created': [{'index': 1, 'name': 'agentic-VM1', 'vmid': 101}],
               error_field: [{'reason': 'snapshot or network update failed'}]}
    job = client.post('/api/queue', json={'token': 'partial-create', 'steps': [
        {'method': 'POST', 'url': '/api/projects/lab/instances/actions/create', 'body': {'result': partial}},
        {'method': 'POST', 'url': '/api/work/permissions'},
        {'method': 'POST', 'url': '/api/work/scenario'},
        {'method': 'POST', 'url': '/api/work/last'},
    ]}).get_json()
    state = wait_terminal(client, job['id'])
    assert calls == ['create-vms', ('permissions', 'alice', None), ('scenario', 'alice', None), ('last', 'alice', None)]
    assert state['status'] == 'error'
    assert state['step'] == 4
    results = client.get(f'/api/queue/{job["id"]}/result').get_json()['results']
    assert results[0] == partial
    assert len(results) == 4


@pytest.mark.parametrize('result,code', [
    ({'created': [], 'errors': [{'reason': 'clone failed'}]}, 200),
    ({'created': [{'vmid': 101}], 'ambiguous': [{'name': 'template'}]}, 200),
    ({'created': [{'vmid': 101}], 'ok': False}, 200),
    ({'created': [{'vmid': 101}], 'error': 'Not authorized'}, 403),
])
def test_failed_or_unresolved_create_still_stops_followups(harness, result, code):
    app, client, started, release, finished, calls = harness
    job = client.post('/api/queue', json={'token': 'failed-create', 'steps': [
        {'method': 'POST', 'url': '/api/projects/lab/instances/actions/create', 'body': {'result': result, 'status': code}},
        {'method': 'POST', 'url': '/api/work/permissions'},
    ]}).get_json()
    assert wait_terminal(client, job['id'])['status'] == 'error'
    assert calls == ['create-vms']


def test_drains_fifo_with_no_browser_requests_and_pages_remain_available(harness):
    app, client, started, release, finished, calls = harness
    first = enqueue(client, 'first')
    assert first.status_code == 202
    assert started.wait(2)
    last = enqueue(client, 'last').get_json()
    assert last['status'] == 'queued'
    for page in ['vm_manager', 'configuration', 'ctfd', 'exports']:
        assert client.get('/page/' + page).status_code == 200
    # Discard the submitting browser's session and make no status requests.
    with client.session_transaction() as sess:
        sess.clear()
    release.set()
    assert finished.wait(2)
    assert [call[0] for call in calls] == ['first', 'last']
    assert all(call[1] == 'alice' for call in calls)


def test_whole_plan_and_upload_are_captured_before_acceptance(harness):
    app, client, started, release, finished, calls = harness
    enqueue(client, 'first')
    assert started.wait(2)
    plan = {'token': 'upload', 'steps': [
        {'method': 'POST', 'url': '/api/work/middle', 'body': {'x': 2}},
        {'method': 'POST', 'url': '/api/upload', 'form': [['destination', '/opt/lab']],
         'files': [['files', 'part1'], ['files', 'part2']]},
    ]}
    response = client.post('/api/queue', data={'plan': json.dumps(plan),
        'part1': (io.BytesIO(b'one'), 'a.txt'), 'part2': (io.BytesIO(b'two'), 'b.txt')})
    assert response.status_code == 202
    release.set()
    assert finished.wait(2)
    job = response.get_json()['id']
    assert wait_terminal(client, job)['status'] == 'completed'
    assert calls[-1] == ('/opt/lab', [('a.txt', b'one'), ('b.txt', b'two')])
    with app.extensions['action_queue'].connect() as db:
        assert db.execute('SELECT payload FROM actions WHERE id=?', (job,)).fetchone()[0] is None
        assert not db.execute('SELECT * FROM uploads WHERE job=?', (job,)).fetchall()


def test_repeated_submission_and_second_worker_do_not_duplicate_work(harness):
    app, client, started, release, finished, calls = harness
    original = enqueue(client, 'first').get_json()
    assert started.wait(2)
    duplicate = enqueue(client, 'first').get_json()
    assert duplicate['id'] == original['id']
    enqueue(client, 'last')
    second = ActionQueue(app)
    second.start()
    try:
        release.set()
        assert finished.wait(2)
        wait_terminal(client, original['id'])
        assert [call[0] for call in calls] == ['first', 'last']
    finally:
        second.close()


def test_queued_cancellation_skips_action_and_continues(harness):
    app, client, started, release, finished, calls = harness
    enqueue(client, 'first')
    assert started.wait(2)
    cancelled = enqueue(client, 'cancelled').get_json()['id']
    assert client.post(f'/api/queue/{cancelled}/cancel').status_code == 200
    enqueue(client, 'last')
    release.set()
    assert finished.wait(2)
    assert [call[0] for call in calls] == ['first', 'last']
    assert wait_terminal(client, cancelled)['status'] == 'cancelled'


def test_running_cancellation_reaches_endpoint_worker(harness):
    app, client, started, release, finished, calls = harness
    job = enqueue(client, 'cancel', steps=[{'method': 'POST', 'url': '/api/cooperative'}]).get_json()['id']
    assert started.wait(2)
    client.post(f'/api/queue/{job}/cancel')
    assert finished.wait(2)
    assert wait_terminal(client, job)['status'] == 'cancelled'
    assert client.get(f'/api/queue/{job}/result').get_json()['cancelled'] is True


@pytest.mark.parametrize('name', ['error', 'partial'])
def test_failure_is_retained_and_does_not_stop_next_job(harness, name):
    app, client, started, release, finished, calls = harness
    job = enqueue(client, name).get_json()['id']
    enqueue(client, 'last')
    assert finished.wait(2)
    state = wait_terminal(client, job)
    assert state['status'] == 'error'
    assert state['errorMessage']
    response = client.get(f'/api/queue/{job}/result')
    assert response.status_code == (422 if name == 'error' else 200)


def test_authentication_owner_isolation_and_local_routes(harness):
    app, client, started, release, finished, calls = harness
    job = enqueue(client, 'owned').get_json()['id']
    wait_terminal(client, job)
    stranger = app.test_client()
    assert stranger.get('/api/queue').status_code == 401
    assert enqueue(stranger, 'denied').status_code == 401
    with stranger.session_transaction() as sess:
        sess['user'] = 'bob'
    assert stranger.get('/api/queue').get_json()['items'] == []
    for suffix in ['', '/result']:
        assert stranger.get(f'/api/queue/{job}{suffix}').status_code == 404
    assert stranger.post(f'/api/queue/{job}/cancel').status_code == 404
    for url in ['https://example.com/api/work/test', '/auth/logout', '/api/queue']:
        assert enqueue(client, 'invalid', steps=[{'method': 'POST', 'url': url}]).status_code == 400
    app.config['API_KEY'] = 'required'
    assert enqueue(client, 'missing-key').status_code == 401


def test_payload_and_credentials_are_not_in_queue_listing(harness):
    app, client, started, release, finished, calls = harness
    enqueue(client, 'first')
    assert started.wait(2)
    text = client.get('/api/queue').get_data(as_text=True)
    assert 'captured' not in text
    assert 'session' not in text
    assert 'payload' not in text


def test_project_creation_and_dependent_steps_run_without_browser(harness):
    app, client, started, release, finished, calls = harness
    job = enqueue(client, 'wizard', steps=[
        {'method': 'POST', 'url': '/api/projects'},
        {'method': 'POST', 'url': '/api/projects/$project/follow-up', 'projectFromStep': 0},
    ]).get_json()['id']
    assert finished.wait(2)
    assert calls == ['create-project', 'new-project']
    state = wait_terminal(client, job)
    assert state['status'] == 'completed'
    assert state['projectId'] == 'new-project'
    assert state['step'] == state['totalSteps'] == 2
    assert client.get(f'/api/queue/{job}/result').get_json()['results'][0]['id'] == 'new-project'


def test_async_child_holds_queue_until_actual_completion(harness):
    app, client, started, release, finished, calls = harness
    job = enqueue(client, 'import', steps=[{'method': 'POST', 'url': '/api/projects/import/start'}]).get_json()['id']
    assert started.wait(2)
    last = enqueue(client, 'last').get_json()['id']
    assert client.get(f'/api/queue/{job}').get_json()['status'] == 'running'
    assert client.get(f'/api/queue/{last}').get_json()['status'] == 'queued'
    api._ACTIVE_JOBS[api._import_job_key('child')]['status'] = 'completed'
    assert finished.wait(2)
    assert wait_terminal(client, job)['status'] == 'completed'


def test_downloads_retain_bytes_and_headers_after_navigation(harness):
    app, client, started, release, finished, calls = harness
    job = enqueue(client, 'download', steps=[{'method': 'GET', 'url': '/api/download'}]).get_json()['id']
    assert wait_terminal(client, job)['status'] == 'completed'
    response = client.get(f'/api/queue/{job}/result')
    assert response.data == b'\x00\xff\x01'
    assert response.headers['Content-Disposition'] == 'attachment; filename=archive.zip'
    assert response.mimetype == 'application/zip'


def test_clearing_history_preserves_deduplication_and_active_work(harness):
    app, client, started, release, finished, calls = harness
    job = enqueue(client, 'completed').get_json()['id']
    wait_terminal(client, job)
    active = enqueue(client, 'first').get_json()['id']
    assert started.wait(2)
    assert client.delete('/api/queue/completed').status_code == 200
    assert [item['id'] for item in client.get('/api/queue').get_json()['items']] == [active]
    assert enqueue(client, 'completed').get_json()['id'] == job
    assert [call[0] for call in calls] == ['completed', 'first']


def test_worker_progress_is_shared_and_combined_across_plan_steps(harness):
    app, client, started, release, finished, calls = harness
    job = enqueue(client, 'progress', steps=[
        {'method': 'POST', 'url': '/api/work/preparation'},
        {'method': 'POST', 'url': '/api/progress'},
    ]).get_json()['id']
    assert started.wait(2)
    state = client.get(f'/api/queue/{job}').get_json()
    assert state['progress'] == 70  # One complete step, then 40% of the second.
    assert state['stepProgress'] == 40
    assert state['phase'] == 'cloning'
    assert state['current'] == 'vm1'
    assert state['itemTotal'] == 5
    assert state['itemCompleted'] == 2
    assert state['message'] == 'Cloning vm1'
    assert 'must-not-be-published' not in json.dumps(state)
    assert client.get('/api/queue').get_json()['items'][0]['progress'] == 70
    other_worker = ActionQueue(app)
    with other_worker.connect() as db:
        persisted = public_record(db.execute('SELECT * FROM actions WHERE id=?', (job,)).fetchone())
    assert persisted == state
    stale_report = api._ACTIVE_JOBS[api._job_key('queue-test')]['queue_progress']
    release.set()
    assert wait_terminal(client, job)['progress'] == 100
    stale_report({'progress': 2, 'message': 'Late update'})
    assert client.get(f'/api/queue/{job}').get_json()['progress'] == 100
    assert client.get(f'/api/queue/{job}').get_json()['message'] == 'Cloning vm1'


def test_progress_without_a_measurement_is_indeterminate(harness):
    app, client, started, release, finished, calls = harness
    job = enqueue(client, 'first').get_json()['id']
    assert started.wait(2)
    state = client.get(f'/api/queue/{job}').get_json()
    assert state['status'] == 'running'
    assert state['progress'] is None
    assert state['stepProgress'] is None
    assert state['message'] == 'Step 1/1 · Run operation…'


def test_automatic_request_label_is_saved_as_readable_title(harness):
    app, client, started, release, finished, calls = harness
    path = '/api/projects/lab/instances/actions/create'
    response = client.post('/api/queue', json={'token': 'readable-label', 'label': f'POST {path}',
        'steps': [{'method': 'POST', 'url': path, 'body': {'result': {'created': []}}}]})
    assert response.status_code == 202
    job = response.get_json()
    assert job['label'] == 'Create VMs'
    assert wait_terminal(client, job['id'])['label'] == 'Create VMs'
    with app.extensions['action_queue'].connect() as db:
        assert db.execute('SELECT label FROM actions WHERE id=?', (job['id'],)).fetchone()['label'] == 'Create VMs'


def test_parallel_vm_worker_publishes_current_guest_before_remote_call_finishes(harness, monkeypatch):
    from types import SimpleNamespace
    from unittest.mock import MagicMock
    from app.storage.projects import Project

    app, client, started, release, finished, calls = harness
    project = Project(id='p', name='Lab', proxmox_url='https://proxmox.local', proxmox_api_token='test')
    guest = {'index': 1, 'name': 'vm1', 'vmid': 101, 'node': 'node1', 'status': 'stopped'}
    proxmox = MagicMock()
    def start(**kwargs):
        started.set()
        assert release.wait(5)
        return 'task'
    proxmox.start_qemu.side_effect = start
    monkeypatch.setattr(api, '_store', lambda: SimpleNamespace(get=lambda pid: project))
    monkeypatch.setattr(api, 'ProxmoxClient', lambda **kwargs: proxmox)
    monkeypatch.setattr(api, '_resolve_targets_to_vm_info', lambda *args: ([guest], [], []))
    try:
        job = enqueue(client, 'start-progress', steps=[{'method': 'POST',
            'url': '/api/projects/p/instances/actions/start', 'body': {'targets': [guest]}}]).get_json()['id']
        assert started.wait(2)
        state = client.get(f'/api/queue/{job}').get_json()
        assert state['status'] == 'running'
        assert 'Starting vm1' in state['message']
        assert 'VM 101' in state['message']
        assert 'node node1' in state['message']
        release.set()
        assert wait_terminal(client, job)['status'] == 'completed'
    finally:
        release.set()
        with api._JOB_LOCK:
            api._ACTIVE_JOBS.pop(api._job_key('p'), None)


def test_async_child_progress_is_published_without_browser_polling(harness):
    app, client, started, release, finished, calls = harness
    job = enqueue(client, 'import-progress', steps=[{'method': 'POST', 'url': '/api/projects/import/start'}]).get_json()['id']
    assert started.wait(2)
    rec = api._ACTIVE_JOBS[api._import_job_key('child')]
    rec.update(progress=63, phase='uploading', message='Uploading archive')
    try:
        deadline = time.monotonic() + 2
        state = {}
        while time.monotonic() < deadline:
            # Read the shared database directly; no request drives progress.
            with app.extensions['action_queue'].connect() as db:
                state = public_record(db.execute('SELECT * FROM actions WHERE id=?', (job,)).fetchone())
            if state['progress'] == 63:
                break
            time.sleep(.01)
        assert state['progress'] == 63
        assert state['message'] == 'Uploading archive'
        assert state['phase'] == 'uploading'
    finally:
        rec['status'] = 'completed'
    assert wait_terminal(client, job)['progress'] == 100


def test_progress_schema_migration_preserves_existing_work(tmp_path):
    path = tmp_path / 'action_queue.sqlite3'
    with sqlite3.connect(path) as db:
        db.execute('CREATE TABLE actions (id INTEGER PRIMARY KEY, status TEXT, payload TEXT)')
        db.execute("INSERT INTO actions VALUES (1, 'queued', 'accepted payload')")
    app = Flask(__name__)
    app.config['DATA_DIR'] = str(tmp_path)
    for _ in range(2):  # Safe when another WSGI worker initializes the same DB.
        queue = ActionQueue(app)
        with queue.connect() as db:
            row = dict(db.execute('SELECT * FROM actions WHERE id=1').fetchone())
        assert row == {'id': 1, 'status': 'queued', 'payload': 'accepted payload', 'progress_state': '{}'}


def test_upload_storage_uses_bounded_reads_and_cleans_duplicates(harness, monkeypatch):
    from pathlib import Path
    from werkzeug.datastructures import FileStorage

    app, client, *_ = harness
    q = ActionQueue(app)
    monkeypatch.setattr(q, 'start', lambda: None)

    class BoundedStream(io.BytesIO):
        def read(self, size=-1):
            assert 0 < size <= 1024 * 1024, 'Must never read an entire model into RAM'
            return super().read(size)

    content = b'GGUF' * (600 * 1024)
    plan = {'token': 'disk-upload', 'steps': [{'method': 'POST', 'url': '/api/upload',
            'form': [['destination', '/models']], 'files': [['files', 'model']]}]}
    with app.test_request_context('/api/queue'):
        session['user'] = 'alice'
        row = q.submit('alice', plan, [('model', FileStorage(BoundedStream(content), filename='model.gguf'))])
        duplicate = q.submit('alice', plan, [('model', FileStorage(BoundedStream(b'other'), filename='other.gguf'))])
    assert row['id'] == duplicate['id']
    with q.connect() as db:
        uploaded = db.execute('SELECT * FROM uploads WHERE job=?', (row['id'],)).fetchone()
    assert uploaded['body'] is None
    assert Path(uploaded['path']).read_bytes() == content
    assert len(list(Path(q.upload_dir).iterdir())) == 1
    q.execute(row)
    assert list(Path(q.upload_dir).iterdir()) == []
    with q.connect() as db:
        assert db.execute('SELECT status FROM actions WHERE id=?', (row['id'],)).fetchone()['status'] == 'completed'


def test_failed_upload_copy_leaves_no_job_or_partial_file(harness, monkeypatch):
    from pathlib import Path
    from werkzeug.datastructures import FileStorage

    app, *_ = harness
    q = ActionQueue(app)
    monkeypatch.setattr(q, 'start', lambda: None)

    class FailedStream:
        def read(self, size):
            raise OSError('disk read failed')

    with app.test_request_context('/api/queue'):
        with pytest.raises(OSError, match='disk read failed'):
            q.submit('alice', {'token': 'failed-copy', 'steps': [{'url': '/api/upload'}]},
                     [('model', FileStorage(FailedStream(), filename='model.gguf'))])
    assert list(Path(q.upload_dir).iterdir()) == []
    with q.connect() as db:
        assert not db.execute('SELECT id FROM actions').fetchall()


def test_cancelling_waiting_upload_removes_disk_payload(harness):
    from pathlib import Path

    app, client, started, release, *_ = harness
    enqueue(client, 'first')
    assert started.wait(2)
    plan = {'token': 'cancel-upload', 'steps': [{'method': 'POST', 'url': '/api/upload',
            'form': [['destination', '/models']], 'files': [['files', 'model']]}]}
    response = client.post('/api/queue', data={'plan': json.dumps(plan),
                           'model': (io.BytesIO(b'GGUF'), 'model.gguf')})
    assert response.status_code == 202
    q = app.extensions['action_queue']
    assert list(Path(q.upload_dir).iterdir())
    assert client.post(f"/api/queue/{response.get_json()['id']}/cancel").status_code == 200
    assert not list(Path(q.upload_dir).iterdir())
    release.set()


def test_worker_dispatches_multigigabyte_file_without_materializing_it(harness, monkeypatch):
    from pathlib import Path

    app, *_ = harness
    q = ActionQueue(app)
    monkeypatch.setattr(q, 'start', lambda: None)
    size = 3 * 1024 ** 3

    @app.post('/api/model-size')
    def model_size():
        upload = request.files['files']
        assert upload.filename == 'model.gguf'
        assert upload.stream.read(4) == b'GGUF'
        upload.stream.seek(0, 2)
        return jsonify(size=upload.stream.tell())

    path = Path(q.upload_dir) / 'large-model'
    with path.open('wb') as stream:
        stream.write(b'GGUF')
        stream.truncate(size)  # Sparse fixture: no multi-gigabyte allocation.
    plan = {'token': 'large-model', 'steps': [{'method': 'POST', 'url': '/api/model-size',
            'form': [], 'files': [['files', 'model']]}]}
    with app.test_request_context('/api/queue'):
        row = q.submit('alice', plan, [])
    with q.connect() as db:
        db.execute('INSERT INTO uploads (job, name, filename, path) VALUES (?, ?, ?, ?)',
                   (row['id'], 'model', 'model.gguf', str(path)))
    q.execute(row)
    with q.connect() as db:
        result = db.execute('SELECT status, result FROM actions WHERE id=?', (row['id'],)).fetchone()
    assert result['status'] == 'completed'
    assert json.loads(result['result'])['size'] == size
    assert not path.exists()


def test_push_batch_reuses_host_archive_across_project_steps(harness, monkeypatch):
    from unittest.mock import MagicMock
    from app.storage.projects import Project

    app, client, *_ = harness
    app.add_url_rule('/api/projects/<pid>/instances/actions/guest_push',
                     view_func=api.instances_lxc_push, methods=['POST'])
    ssh = MagicMock()
    sftp = ssh.open_sftp.return_value
    monkeypatch.setattr(api, '_block_when_remote', lambda *args: None)
    monkeypatch.setattr(api, '_guest_transfer_context', lambda pid, body, **kwargs: (
        Project(id=pid, name=pid), MagicMock(), 'https://node1:8006', 'secret',
        [{'index': 1, 'name': pid, 'vmid': 101 if pid == 'a' else 102, 'node': 'node1', 'type': 'lxc'}], [], [],
    ))
    monkeypatch.setattr(api, '_lxc_transfer_ssh_host', lambda *args: 'node1')
    connect = MagicMock(return_value=ssh)
    monkeypatch.setattr(api, '_ssh_connect', connect)
    commands = []

    def execute(client, command, **kwargs):
        sftp.remove.assert_not_called()
        commands.append(command)
        return 0, '', ''

    monkeypatch.setattr(api, '_ssh_exec_result', execute)
    plan = {'token': 'shared-project-upload', 'steps': [
        {'method': 'POST', 'url': f'/api/projects/{pid}/instances/actions/guest_push',
         'form': [['payload', json.dumps({'destination': '/models', 'relativePaths': ['model.gguf']})]],
         'files': [['files', 'model']]} for pid in ('a', 'b')
    ]}
    response = client.post('/api/queue', data={'plan': json.dumps(plan),
                           'model': (io.BytesIO(b'GGUF'), 'model.gguf')})
    assert response.status_code == 202
    assert wait_terminal(client, response.get_json()['id'])['status'] == 'completed'
    connect.assert_called_once()
    sftp.putfo.assert_called_once()
    sftp.remove.assert_called_once()
    ssh.close.assert_called_once()
    assert len(commands) == 2
    assert 'pct exec 101' in commands[0]
    assert 'pct exec 102' in commands[1]


def test_transfer_percentage_survives_queue_polling_and_clears_for_extraction(harness):
    app, client, started, release, *_ = harness
    job = enqueue(client, 'first').get_json()['id']
    assert started.wait(2)
    q = app.extensions['action_queue']
    report = q.progress_reporter(job, 1)
    report({'progress': 0, 'transferProgress': 42, 'transferDirection': 'Downloading from guest',
            'current': 'model-vm', 'message': '42% (42 MiB / 100 MiB)'})
    state = client.get(f'/api/queue/{job}').get_json()
    assert state['transferProgress'] == 42
    assert state['transferDirection'] == 'Downloading from guest'
    assert state['progress'] == 0
    report({'transferProgress': None, 'transferDirection': 'Preparing download archive'})
    state = client.get(f'/api/queue/{job}').get_json()
    assert state['transferProgress'] is None
    assert state['transferDirection'] == 'Preparing download archive'
    release.set()


def test_queue_counts_survive_detail_updates_and_can_be_cleared(harness):
    app, client, started, release, *_ = harness
    job = enqueue(client, 'first').get_json()['id']
    assert started.wait(2)
    report = app.extensions['action_queue'].progress_reporter(job, 1)
    report({'item_total': 5, 'item_completed': 2})
    report({'current': 'vm3', 'message': 'Waiting for command'})
    state = client.get(f'/api/queue/{job}').get_json()
    assert (state['itemCompleted'], state['itemTotal']) == (2, 5)
    report({'item_total': None, 'item_completed': None})
    state = client.get(f'/api/queue/{job}').get_json()
    assert state['itemTotal'] is None
    assert state['itemCompleted'] is None
    release.set()


@pytest.mark.parametrize(('result', 'expected'), [
    (b'', '2 steps completed successfully.'),
    (b'\x89PNG\xff', '2 steps completed successfully.'),
    (json.dumps({'results': [{'created': [{}, {}]}, {'created': [{}], 'skipped': [{}]}]}).encode(),
     'Created: 3; Skipped: 1.'),
    (b'{"message":"Settings saved."}', 'Settings saved.'),
])
def test_completed_result_summary_handles_empty_binary_and_multistep_results(result, expected):
    from app.action_queue import result_summary
    row = {'status': 'completed', 'label': 'Create VMs', 'error': '',
           'result': result, 'total_steps': 2}
    summary = result_summary(row)
    assert summary.startswith('Completed: Create VMs.')
    assert expected in summary


@pytest.mark.parametrize('status', ['error', 'cancelled'])
def test_result_summary_does_not_claim_failed_or_cancelled_work_succeeded(status):
    from app.action_queue import result_summary
    summary = result_summary({'status': status, 'label': 'Create VMs',
                              'error': 'Connection lost' if status == 'error' else '',
                              'result': b'', 'total_steps': 2})
    assert ('Failed:' if status == 'error' else 'Cancelled:') in summary
    assert 'successfully' not in summary
    if status == 'error':
        assert 'Connection lost' in summary


@pytest.mark.parametrize('guest_type', ['qemu', 'lxc'])
@pytest.mark.parametrize('first_fails', [False, True])
def test_commands_refresh_inventory_in_fifo_order_without_browser_refresh(harness, monkeypatch, guest_type, first_fails):
    from types import SimpleNamespace
    from app.storage.projects import Project, VMConfig

    app, client, started, release, finished, calls = harness
    project = Project(id='queue-test', name='Queue Test', tag='-lab-', vms=[VMConfig(name='alpha')])
    monkeypatch.setattr(api, '_store', lambda: SimpleNamespace(get=lambda pid: project))
    monkeypatch.setattr(api, '_runtime_store', lambda: None)
    monkeypatch.setattr(api, 'ProxmoxClient', lambda **kwargs: object())
    inventory = {'vmid': 101}
    events = []

    def refresh(_client):
        events.append(('refresh', inventory['vmid']))
        return {'alpha-lab-1': {'node': 'node1', 'vmid': inventory['vmid'], 'type': guest_type}}, None

    def execute(proj, url, password, remote, target, command, timeout, **kwargs):
        events.append((command, target['vmid']))
        if command == 'first':
            started.set()
            assert release.wait(5)
            inventory['vmid'] = 202
            if first_fails:
                raise RuntimeError('agent exec timed out (configured timeout: 60s)')
        return {'exitcode': 0, 'stdout': command, 'stderr': ''}

    monkeypatch.setattr(api, '_list_cluster_vms_by_name', refresh)
    monkeypatch.setattr(api, '_execute_instance_command', execute)

    def command_job(command):
        return enqueue(client, command, steps=[{
            'method': 'POST', 'url': '/api/projects/queue-test/instances/actions/run_stored_cmds',
            'body': {'customCommand': command, 'customCommandTimeoutSeconds': 60,
                     'username': 'root', 'password': 'test', 'baseUrl': 'https://proxmox.local',
                     'targets': [{'index': 1, 'name': 'alpha-lab-1'}]},
        }]).get_json()['id']

    first = command_job('first')
    assert started.wait(2)
    second = command_job('second')
    assert events == [('refresh', 101), ('first', 101)]
    release.set()
    assert wait_terminal(client, first)['status'] == ('error' if first_fails else 'completed')
    assert wait_terminal(client, second)['status'] == 'completed'
    assert events == [('refresh', 101), ('first', 101), ('refresh', 202), ('second', 202)]

@pytest.fixture
def inventory_queue(tmp_path, monkeypatch):
    app = Flask(__name__)
    app.config.update(TESTING=True, SECRET_KEY='test', DATA_DIR=str(tmp_path))
    calls = []

    @app.post('/api/projects/<pid>/instances/actions/<action>')
    def action(pid, action):
        calls.append((pid, action))
        if request.json.get('fail'):
            return jsonify(errors=[{'reason': 'partial failure'}])
        return jsonify(ok=True)

    @app.post('/api/projects/<pid>/instances/refresh/vm')
    def refresh(pid):
        calls.append((pid, 'refresh'))
        assert request.json == {'username': 'operator@pam', 'password': 'secret', 'forceRefresh': True}
        assert session['user'] == 'alice'
        return jsonify(instance_statuses=[])

    queue = ActionQueue(app)
    monkeypatch.setattr(queue, 'start', lambda: None)
    counter = iter(range(100))

    def submit(operations):
        with app.test_request_context('/'):
            session['user'] = 'alice'
            return queue.submit('alice', {'token': str(next(counter)), 'projectId': operations[0][0],
                'steps': [{'method': 'POST', 'url': f'/api/projects/{pid}/instances/actions/{action}',
                           'body': {'username': 'operator@pam', 'password': 'secret', 'fail': fail}}
                          for pid, action, fail in operations]}, [])

    def drain():
        for _ in range(30):
            row = queue.claim()
            if row is None:
                return
            queue.execute(row)
        pytest.fail('refresh queue did not drain (possible refresh loop)')

    return queue, submit, drain, calls


@pytest.mark.parametrize('action', ['create', 'delete', 'start', 'unlock', 'suspend', 'hibernate',
    'poweroff', 'snapshot', 'restore', 'nets_set', 'nets_remove', 'apply_scenario',
    'run_startup_cmds', 'run_stored_cmds', 'users_create', 'users_delete', 'users_access_sync',
    'users_orchestration_enable', 'guest_push', 'guest_delete', 'guest_pull', 'file_transfer'])
def test_every_vm_operation_gets_one_forced_refresh(inventory_queue, action):
    queue, submit, drain, calls = inventory_queue
    submit([('one', action, False)])
    drain()
    assert calls == [('one', action), ('one', 'refresh')]
    with queue.connect() as db:
        records = db.execute('SELECT * FROM actions ORDER BY id').fetchall()
        assert len(records) == 2
        assert all(row['payload'] is None for row in records)
        assert public_record(records[-1])['inventoryRefresh'] is True


def test_refresh_coalesces_queued_jobs_and_all_steps_per_project(inventory_queue):
    queue, submit, drain, calls = inventory_queue
    submit([('one', 'unlock', False), ('two', 'unlock', False)])
    submit([('one', 'start', False), ('one', 'snapshot', False)])
    drain()
    assert calls == [('one', 'unlock'), ('two', 'unlock'), ('one', 'start'), ('one', 'snapshot'),
                     ('one', 'refresh'), ('two', 'refresh')]


def test_new_work_queued_after_refresh_is_scheduled_still_coalesces(inventory_queue):
    queue, submit, drain, calls = inventory_queue
    submit([('one', 'unlock', False)])
    queue.execute(queue.claim())
    submit([('one', 'start', False)])
    drain()
    assert calls == [('one', 'unlock'), ('one', 'start'), ('one', 'refresh')]


def test_failed_job_refreshes_before_next_operation_then_refreshes_at_end(inventory_queue):
    queue, submit, drain, calls = inventory_queue
    submit([('one', 'unlock', True), ('two', 'start', False)])
    submit([('one', 'start', False)])
    drain()
    assert calls == [('one', 'unlock'), ('one', 'refresh'), ('one', 'start'), ('one', 'refresh')]


def test_cancelled_waiting_work_does_not_lose_deferred_refresh(inventory_queue):
    queue, submit, drain, calls = inventory_queue
    submit([('one', 'unlock', False)])
    other = submit([('one', 'start', False)])
    queue.execute(queue.claim())
    with queue.connect() as db:
        db.execute("UPDATE actions SET status='cancelled', payload=NULL WHERE id=?", (other['id'],))
    drain()
    assert calls == [('one', 'unlock'), ('one', 'refresh')]


def test_pending_refresh_survives_worker_recreation(inventory_queue):
    queue, submit, drain, calls = inventory_queue
    submit([('one', 'unlock', False)])
    queue.execute(queue.claim())
    restarted = ActionQueue(queue.app)
    row = restarted.claim()
    assert row is not None
    restarted.execute(row)
    assert restarted.claim() is None
    assert calls == [('one', 'unlock'), ('one', 'refresh')]


def test_refresh_target_extraction_keeps_only_connection_data():
    steps = [{'method': 'POST', 'url': '/api/projects/project%20one/instances/actions/guest_push',
              'form': [['payload', json.dumps({'username': 'operator', 'password': 'secret',
                                               'destination': '/tmp', 'targets': [{'vmid': 101}]})]]},
             {'method': 'POST', 'url': '/api/projects/one/instances/actions/start/retry-check'},
             {'method': 'POST', 'url': '/api/projects/one/instances/refresh/vm'}]
    assert ActionQueue.refresh_targets(steps) == {'project one': {'username': 'operator', 'password': 'secret'}}


@pytest.mark.parametrize('status', ['completed', 'error', 'cancelled'])
def test_queue_download_contains_summary_details_for_every_outcome(harness, status):
    app, client, *_ = harness
    job = enqueue(client, 'download-summary').get_json()
    wait_terminal(client, job['id'])
    result = {'results': [
        {'unlocked': [{'name': 'alpha', 'node': 'node1', 'vmid': 101}]},
        {'skipped': [{'name': 'beta', 'reason': 'already unlocked'}],
         'errors': [{'name': 'gamma', 'reason': 'sudo denied'}],
         'ran': [{'name': 'delta', 'commands': [{'cmd': 'hostname', 'exitcode': 1,
                                               'stderr_preview': 'command failed'}]}],
         'password': 'must-not-export', 'outputs_zip': {'filename': 'guest_pull.zip', 'base64': 'encoded-file-data'}}]}
    with app.extensions['action_queue'].connect() as db:
        db.execute('UPDATE actions SET result=?, status=?, error=? WHERE id=?',
                   (json.dumps(result).encode(), status, 'Operation reported errors' if status == 'error' else '', job['id']))
    record = client.get(f"/api/queue/{job['id']}").get_json()
    response = client.get(record['logUrl'] + '?download=1')
    assert response.status_code == 200
    assert response.mimetype == 'text/plain'
    assert response.headers['Content-Disposition'] == f'attachment; filename="queue-{job["id"]}-log.txt"'
    text = response.get_data(as_text=True)
    for expected in ('Unlocked:', 'alpha', 'node1', '101', 'beta', 'already unlocked',
                     'gamma', 'sudo denied', 'hostname', 'command failed'):
        assert expected in text
    assert 'must-not-export' not in text
    assert 'encoded-file-data' not in text
    if status == 'error':
        assert 'Operation reported errors' in text
    # Download is still available after rebuilding the queue service from disk.
    app.extensions['action_queue'].close()
    app.extensions['action_queue'] = ActionQueue(app)
    assert client.get(record['logUrl'] + '?download=1').get_data() == response.get_data()
    with client.session_transaction() as sess:
        sess['user'] = 'bob'
    assert client.get(record['logUrl'] + '?download=1').status_code == 404


def test_corrupt_command_archive_does_not_hide_summary_log(harness):
    app, client, *_ = harness
    job = enqueue(client, 'bad-log-archive').get_json()
    wait_terminal(client, job['id'])
    result = {'errors': [{'name': 'alpha', 'reason': 'operation failed'}],
              'outputs_zip': {'filename': 'stored_cmd_outputs_bad.zip', 'base64': 'not-an-archive'}}
    with app.extensions['action_queue'].connect() as db:
        db.execute('UPDATE actions SET result=? WHERE id=?', (json.dumps(result).encode(), job['id']))
    response = client.get(f"/api/queue/{job['id']}/log?download=1")
    assert response.status_code == 200
    assert 'operation failed' in response.get_data(as_text=True)
    assert 'could not be read' in response.get_data(as_text=True)


def test_queue_log_is_not_available_until_finished(harness):
    app, client, started, release, *_ = harness
    job = enqueue(client, 'first').get_json()
    assert started.wait(2)
    assert client.get(f"/api/queue/{job['id']}").get_json()['logUrl'] is None
    assert client.get(f"/api/queue/{job['id']}/log?download=1").status_code == 409
    release.set()


@pytest.mark.parametrize('direction', ['upload', 'download'])
@pytest.mark.parametrize('enabled', [True, False])
@pytest.mark.parametrize('write_fails', [True, False])
def test_queued_vm_transfer_policy_updates_notes_reports_outcome_and_refreshes(harness, monkeypatch, direction, enabled, write_fails):
    from types import SimpleNamespace
    from unittest.mock import Mock
    from app.storage.projects import Project, VMConfig
    from app.file_transfer import read_policy

    app, client, started, release, finished, calls = harness
    app.current_user = lambda: {'username': session['user'], 'roles': ['admin']} if session.get('user') else None
    project = Project(id='queue-test', name='Lab', proxmox_url='https://node.test',
                      vms=[VMConfig(name='web', viewable_to_user=True)])
    monkeypatch.setattr(api, '_store', lambda: SimpleNamespace(get=lambda pid: project))
    target = {'index': 1, 'name': 'web-set-1', 'node': 'node', 'vmid': 101, 'type': 'qemu'}
    monkeypatch.setattr(api, '_resolve_targets_to_vm_info', lambda *args: ([target], [], []))
    upstream = Mock()
    upstream.get_qemu_config.return_value = {'digest': 'abc', 'description': 'Human notes\n{"AccessForge":{"file_upload":true,"file_download":true}}'}

    def write(**kwargs):
        started.set()
        assert release.wait(5)
        if write_fails:
            raise RuntimeError('VM.Config.Options denied')

    upstream.set_qemu_options.side_effect = write
    monkeypatch.setattr(api, 'ProxmoxClient', lambda **kwargs: upstream)
    app.add_url_rule('/api/projects/<pid>/instances/actions/file_transfer', view_func=api.instances_file_transfer, methods=['POST'])

    @app.post('/api/projects/<pid>/instances/refresh/vm')
    def refresh_transfer_policy(pid):
        calls.append(('refresh', pid))
        return jsonify(instance_statuses=[])

    job = enqueue(client, f'policy-{direction}-{enabled}', projectId=project.id, steps=[{
        'method': 'POST', 'url': f'/api/projects/{project.id}/instances/actions/file_transfer',
        'body': {'targets': [target], 'username': 'root@pam', 'password': 'secret', f'file_{direction}': enabled},
    }]).get_json()
    try:
        assert started.wait(2)
        active = client.get(f"/api/queue/{job['id']}").get_json()
        assert active['status'] == 'running'
        assert active['phase'] == 'file_transfer'
        assert active['current'].startswith('web-set-1')
    finally:
        release.set()
    state = wait_terminal(client, job['id'])
    assert state['status'] == ('error' if write_fails else 'completed')
    result = client.get(f"/api/queue/{job['id']}/result").get_json()
    if write_fails:
        assert result['errors'][0]['reason'] == 'VM.Config.Options denied'
    else:
        assert len(result['infos']) == 1
        assert f"{direction.capitalize()} {'enabled' if enabled else 'disabled'}" in result['infos'][0]['reason']
        written = upstream.set_qemu_options.call_args.kwargs['options']
        assert written['digest'] == 'abc'
        assert 'Human notes' in written['description']
        policy = read_policy(written['description'])
        assert policy[f'file_{direction}'] is enabled
        assert policy[f"file_{'download' if direction == 'upload' else 'upload'}"] is True
    deadline = time.monotonic() + 2
    while ('refresh', project.id) not in calls and time.monotonic() < deadline:
        time.sleep(.01)
    assert calls.count(('refresh', project.id)) == 1
