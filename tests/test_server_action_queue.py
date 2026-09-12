import io
import json
import sqlite3
import threading
import time

import pytest
from flask import Flask, jsonify, request, session

from app.action_queue import ActionQueue, init_action_queue, public_record
from app.routes import api


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
            'queue-test', progress=40, phase='cloning', current='vm1',
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
