from concurrent.futures import Future, ThreadPoolExecutor
import threading

import pytest
from flask import Blueprint, Flask, jsonify, request, session

from app.read_coalescing import coalesce_read, invalidate_reads_for_write
from app.routes.api import _secure_route


@pytest.fixture
def reads_app():
    app = Flask(__name__)
    app.config.update(TESTING=True, SECRET_KEY='test', AUTH_ENABLE=True)
    app.current_user = lambda: {'username': session['user']} if session.get('user') else None
    bp = Blueprint('reads', __name__)
    bp.before_request(invalidate_reads_for_write)

    @bp.after_request
    def separate_after_write(response):
        invalidate_reads_for_write()
        return response

    operations = {'calls': 0}

    @bp.post('/read/<pid>')
    @_secure_route()
    @coalesce_read
    def read(pid):
        operations['calls'] += 1
        value = operations['run']()
        return jsonify(value=value, user=session['user'], project=pid), 200, {'X-Read': 'yes'}

    @bp.post('/write')
    @_secure_route()
    def write():
        return jsonify(ok=True)

    app.register_blueprint(bp)
    return app, operations


def fetch(app, user='alice', body=None, url='/read/one', headers=None):
    with app.test_client() as client:
        if user:
            with client.session_transaction() as state:
                state['user'] = user
        response = client.post(url, json=body or {'password': 'secret'}, headers=headers)
        return response.status_code, response.get_json(), response.headers.get('X-Read')


def observe_follower(monkeypatch):
    waiting = threading.Event()

    class ObservedFuture(Future):
        def result(self, timeout=None):
            waiting.set()
            return super().result(timeout)

    monkeypatch.setattr('app.read_coalescing.Future', ObservedFuture)
    return waiting


def test_overlapping_reads_share_work_and_completed_results_are_not_cached(reads_app, monkeypatch):
    app, operations = reads_app
    started, release = threading.Event(), threading.Event()
    waiting = observe_follower(monkeypatch)

    def run():
        started.set()
        assert release.wait(3)
        return 'snapshot'

    operations['run'] = run
    with ThreadPoolExecutor(2) as pool:
        first = pool.submit(fetch, app)
        assert started.wait(3)
        second = pool.submit(fetch, app)
        try:
            assert waiting.wait(3)
            assert operations['calls'] == 1
        finally:
            release.set()
        assert first.result() == second.result() == (200, {'value': 'snapshot', 'user': 'alice', 'project': 'one'}, 'yes')
    fetch(app)
    assert operations['calls'] == 2
    assert not app.extensions['read_coalescer'].pending


@pytest.mark.parametrize('different', [
    {'user': 'bob'},
    {'body': {'password': 'different-secret'}},
    {'url': '/read/two'},
    {'url': '/read/one?only=bob'},
    {'headers': {'X-API-Key': 'different-key'}},
])
def test_different_users_credentials_and_targets_run_independently(reads_app, different):
    app, operations = reads_app
    started, release = threading.Event(), threading.Event()

    def run():
        if not started.is_set():
            started.set()
            assert release.wait(3)
        return 'snapshot'

    operations['run'] = run
    with ThreadPoolExecutor(2) as pool:
        first = pool.submit(fetch, app)
        assert started.wait(3)
        try:
            second = pool.submit(fetch, app, **different)
            assert second.result(timeout=2)[0] == 200
            assert not first.done(), 'independent reads must not wait behind slow reads'
            assert operations['calls'] == 2
        finally:
            release.set()
        first.result()


def test_failed_reads_release_followers_and_allow_retry(reads_app, monkeypatch):
    app, operations = reads_app
    started, release = threading.Event(), threading.Event()
    waiting = observe_follower(monkeypatch)

    def run():
        started.set()
        assert release.wait(3)
        raise ValueError('upstream unavailable')

    operations['run'] = run
    with ThreadPoolExecutor(2) as pool:
        first = pool.submit(fetch, app)
        assert started.wait(3)
        second = pool.submit(fetch, app)
        try:
            assert waiting.wait(3)
        finally:
            release.set()
        for future in (first, second):
            with pytest.raises(ValueError, match='upstream unavailable'):
                future.result()
    operations['run'] = lambda: 'recovered'
    assert fetch(app)[1]['value'] == 'recovered'
    assert operations['calls'] == 2


def test_read_after_mutation_does_not_join_pre_mutation_read(reads_app):
    app, operations = reads_app
    started, release = threading.Event(), threading.Event()

    def run():
        if operations['calls'] == 1:
            started.set()
            assert release.wait(3)
            return 'old'
        return 'new'

    operations['run'] = run
    with ThreadPoolExecutor(2) as pool:
        old = pool.submit(fetch, app)
        assert started.wait(3)
        try:
            assert fetch(app, url='/write')[0] == 200
            fresh = pool.submit(fetch, app)
            assert fresh.result(timeout=2)[1]['value'] == 'new'
            assert not old.done()
        finally:
            release.set()
        assert old.result()[1]['value'] == 'old'


def test_every_request_still_requires_authentication(reads_app):
    app, operations = reads_app
    operations['run'] = lambda: 'private'
    assert fetch(app, user=None)[0] == 401
    assert operations['calls'] == 0
