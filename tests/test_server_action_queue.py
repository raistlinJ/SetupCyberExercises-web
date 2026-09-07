import io
import json
import threading
import time

import pytest
from flask import Flask, jsonify, request, session

from app.action_queue import ActionQueue, init_action_queue
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
