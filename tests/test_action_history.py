import json

import pytest
from flask import Flask, jsonify, session

from app.action_queue import ActionQueue, init_action_queue


@pytest.fixture
def history_app(tmp_path, monkeypatch):
    app = Flask(__name__)
    app.config.update(TESTING=True, SECRET_KEY='test', DATA_DIR=str(tmp_path), AUTH_ENABLE=True)
    app.current_user = lambda: {'username': session['user']} if session.get('user') else None
    monkeypatch.setattr(ActionQueue, 'start', lambda self: None)
    @app.post('/api/projects/p/instances/actions/<action>')
    def execute(action):
        return jsonify(ok=True)
    @app.post('/api/projects/p/instances/refresh/vm')
    def refresh():
        return jsonify(ok=True)
    init_action_queue(app)
    client = app.test_client()
    with client.session_transaction() as sess:
        sess['user'] = 'alice'
    return app, client


def submit(client, action, body, *, multipart=False):
    step = {'method': 'POST', 'url': f'/api/projects/p/instances/actions/{action}'}
    step.update({'form': [['payload', json.dumps(body)]]} if multipart else {'body': body})
    response = client.post('/api/queue', json={'token': str(submit.counter), 'label': 'work', 'steps': [step]})
    submit.counter += 1
    assert response.status_code == 202
    return response.get_json()


submit.counter = 0


def drain(app):
    queue = app.extensions['action_queue']
    while (row := queue.claim()) is not None:
        queue.execute(row)


def entries(client, kind):
    response = client.get(f'/api/queue/history/{kind}')
    assert response.status_code == 200
    assert response.headers['Cache-Control'] == 'no-store'
    return response.get_json()['items']


def test_history_records_execution_not_submission_or_cancelled_waiting_jobs(history_app):
    app, client = history_app
    job = submit(client, 'run_stored_cmds', {'customCommand': 'hostname'})
    assert entries(client, 'custom') == []
    client.post(f"/api/queue/{job['id']}/cancel")
    drain(app)
    assert entries(client, 'custom') == []
    submit(client, 'run_stored_cmds', {'customCommand': 'hostname'})
    drain(app)
    assert entries(client, 'custom')[0]['settings'] == {'command': 'hostname', 'timeoutSeconds': 60}


@pytest.mark.parametrize('kind,action,body', [
    ('custom', 'run_stored_cmds', lambda i: {'customCommand': f'echo {i}', 'customCommandTimeoutSeconds': 600}),
    ('pull', 'guest_pull', lambda i: {'paths': [f'/data/{i}', '/var/log/*.log']}),
    ('push', 'guest_push', lambda i: {'destination': f'/data/{i}', 'relativePaths': ['folder/a.txt'],
                                     'selectionType': 'folder', 'ownerOnRemote': '1000', 'filePermissions': '0640'}),
])
def test_five_distinct_recent_entries_per_kind_and_repeats_move_to_top(history_app, kind, action, body):
    app, client = history_app
    for i in range(7):
        submit(client, action, body(i), multipart=kind == 'push')
        drain(app)
    saved = entries(client, kind)
    assert len(saved) == 5
    assert [item['id'] for item in saved] == sorted([item['id'] for item in saved], reverse=True)
    submit(client, action, body(4), multipart=kind == 'push')
    drain(app)
    repeated = entries(client, kind)
    assert len(repeated) == 5
    assert repeated[0]['settings'] == saved[2]['settings']
    assert len({json.dumps(item['settings'], sort_keys=True) for item in repeated}) == 5
    assert all(item['executedAt'] > 0 for item in repeated)


def test_histories_are_private_persistent_and_exclude_connection_credentials(history_app):
    app, client = history_app
    command = "printf 'one\\ntwo'\necho done"
    submit(client, 'run_stored_cmds', {'customCommand': command, 'password': 'do-not-store',
                                      'username': 'root', 'customCommandTimeoutSeconds': 600})
    drain(app)
    assert 'do-not-store' not in json.dumps(entries(client, 'custom'))
    with client.session_transaction() as sess:
        sess['user'] = 'bob'
    assert entries(client, 'custom') == []
    with client.session_transaction() as sess:
        sess['user'] = 'alice'
    assert entries(client, 'custom')[0]['settings']['command'] == command
    app.extensions.pop('action_queue')  # Simulate a fresh server instance opening the same database.
    assert entries(client, 'custom')[0]['settings']['timeoutSeconds'] == 600
    client.delete('/api/queue/completed')
    assert len(entries(client, 'custom')) == 1
    assert client.get('/api/queue/history/unknown').status_code == 404
    with client.session_transaction() as sess:
        sess.clear()
    assert client.get('/api/queue/history/custom').status_code in {401, 403}


def test_unrelated_actions_and_saved_commands_do_not_enter_history(history_app):
    app, client = history_app
    for action, body in [('run_stored_cmds', {}), ('start', {'customCommand': 'irrelevant'}),
                         ('guest_delete', {'path': '/tmp/file'})]:
        submit(client, action, body)
        drain(app)
    assert all(entries(client, kind) == [] for kind in ('push', 'pull', 'custom'))


def test_history_storage_failure_does_not_block_the_requested_action(history_app, monkeypatch):
    import app.action_queue as module
    app, client = history_app
    def fail(*args):
        raise OSError('history unavailable')
    monkeypatch.setattr(module, 'remember', fail)
    job = submit(client, 'run_stored_cmds', {'customCommand': 'hostname'})
    drain(app)
    assert client.get(f"/api/queue/{job['id']}").get_json()['status'] == 'completed'
