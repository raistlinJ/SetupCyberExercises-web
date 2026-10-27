from datetime import datetime, timedelta, timezone
from email.utils import format_datetime
from unittest.mock import Mock, call, patch

import pytest
import requests

from app import create_app
from app.connectors.ctfd import CTFdClient, CTFdError
from app.storage.projects import Project


def response(status=200, payload=None, retry_after=None):
    result = requests.Response()
    result.status_code = status
    result._content_consumed = True
    if payload is not None:
        import json
        result._content = json.dumps(payload).encode()
        result.headers['Content-Type'] = 'application/json'
    else:
        result._content = b'<html><h1>Too Many Requests</h1><hr>nginx</html>'
    if retry_after is not None:
        result.headers['Retry-After'] = retry_after
    return result


def ctfd_client(*responses):
    session = Mock(spec=requests.Session)
    session.cookies = requests.cookies.RequestsCookieJar()
    session.request.side_effect = responses
    return CTFdClient('https://ctfd.test', session=session, csrf_token='nonce')


def test_rejected_create_waits_for_retry_after_then_succeeds():
    client = ctfd_client(response(429, retry_after='3'), response(payload={'data': {'id': 8}}))
    with patch('app.connectors.ctfd.time.sleep') as sleep:
        assert client.create_user('alice', 'alice@example.com', 'secret') == {'id': 8}
    sleep.assert_called_once_with(3)
    assert client.session.request.call_count == 2
    assert client.session.request.call_args_list[0] == client.session.request.call_args_list[1]
    assert [event['status'] for event in client.logs if event['event'] == 'response'] == [429, 200]
    assert 'secret' not in str(client.logs)


@pytest.mark.parametrize('header', [None, 'invalid', '-1', 'NaN', 'Infinity'])
def test_missing_or_invalid_retry_after_uses_bounded_backoff(header):
    client = ctfd_client(*(response(429, retry_after=header) for _ in range(4)))
    with patch('app.connectors.ctfd.time.sleep') as sleep, pytest.raises(CTFdError) as caught:
        client.create_user('alice', 'alice@example.com', 'secret')
    assert sleep.call_args_list == [call(1), call(2), call(4)]
    assert client.session.request.call_count == 4
    assert caught.value.status_code == 429
    assert 'rate limit' in str(caught.value)
    assert '<html>' not in str(caught.value)
    assert '<html>' in caught.value.body


def test_retry_after_supports_http_dates():
    now = datetime(2026, 10, 26, 12, tzinfo=timezone.utc)
    retry_at = format_datetime(now + timedelta(seconds=9), usegmt=True)
    client = ctfd_client(response(429, retry_after=retry_at), response(payload={'data': []}))
    with patch('app.connectors.ctfd.datetime') as clock, patch('app.connectors.ctfd.time.sleep') as sleep:
        clock.now.return_value = now
        client.list_users()
    sleep.assert_called_once_with(9)


@pytest.mark.parametrize('header, expected_requests', [('120', 1), ('20', 2)])
def test_long_retry_after_stops_instead_of_retrying_early(header, expected_requests):
    client = ctfd_client(response(429, retry_after=header), response(429, retry_after=header))
    with patch('app.connectors.ctfd.time.sleep') as sleep, pytest.raises(CTFdError) as caught:
        client.list_users()
    assert client.session.request.call_count == expected_requests
    assert sleep.call_args_list == ([] if expected_requests == 1 else [call(20)])
    assert caught.value.retry_after == float(header)


@pytest.mark.parametrize('failure', [response(400), response(403), response(500), requests.Timeout('timed out')])
def test_other_failures_never_replay_a_write(failure):
    client = ctfd_client(failure)
    with patch('app.connectors.ctfd.time.sleep') as sleep, pytest.raises((CTFdError, requests.Timeout)):
        client.create_user('alice', 'alice@example.com', 'secret')
    assert client.session.request.call_count == 1
    sleep.assert_not_called()


def test_user_lookup_does_not_try_alternate_queries_after_rate_limit():
    client = ctfd_client(response(429, retry_after='120'))
    with pytest.raises(CTFdError):
        client.find_user_id_by_name('alice')
    assert client.session.request.call_count == 1


@pytest.fixture
def api(monkeypatch, tmp_path):
    monkeypatch.setenv('AUTH_ENABLE', '0')
    app = create_app()
    app.config.update(TESTING=True, DATA_DIR=str(tmp_path))
    project = Project(id='ctfd-rate-limit', name='CTFd Rate Limit', credentials=[
        {'username': 'Alice', 'password': 'alice-password'},
        {'username': 'bob', 'password': 'bob-password'},
        {'username': 'carol', 'password': 'carol-password'},
    ])
    monkeypatch.setattr('app.routes.api._store', lambda: Mock(get=Mock(return_value=project)))
    return app.test_client(), f'/api/projects/{project.id}/ctfd/users_create'


def test_batch_reuses_all_pages_of_one_admin_listing(api):
    client = ctfd_client(
        response(payload={'data': [{'id': 8, 'name': 'ALICE'}], 'meta': {'pagination': {'pages': 2}}}),
        response(payload={'data': [{'id': 9, 'name': 'bob'}], 'meta': {'pagination': {'pages': 2}}}),
        response(payload={'data': {'id': 8}}),
        response(payload={'data': {'id': 9}}),
        response(payload={'data': {'id': 10}}),
    )
    http, url = api
    with patch('app.routes.api._ctfd_client_from_req', return_value=client), patch.object(client, 'get_role', return_value='admin'):
        result = http.post(url, json={})
    assert result.status_code == 200
    body = result.get_json()
    assert (body['created'], body['updated'], body['skipped']) == (1, 2, 0)
    calls = client.session.request.call_args_list
    assert [c.args[0] for c in calls] == ['GET', 'GET', 'PATCH', 'PATCH', 'POST']
    assert [c.kwargs['params'] for c in calls[:2]] == [
        {'page': 1, 'per_page': 100, 'view': 'admin'},
        {'page': 2, 'per_page': 100, 'view': 'admin'},
    ]


def test_batch_stops_after_exhausted_rate_limit_preserving_completed_users(api):
    client = ctfd_client(
        response(payload={'data': []}),
        response(payload={'data': {'id': 8}}),
        *(response(429) for _ in range(4)),
    )
    http, url = api
    with patch('app.routes.api._ctfd_client_from_req', return_value=client), patch.object(client, 'get_role', return_value='admin'), patch('app.connectors.ctfd.time.sleep'):
        result = http.post(url, json={})
    assert result.status_code == 200
    body = result.get_json()
    assert (body['created'], body['updated'], body['skipped']) == (1, 0, 1)
    assert body['results'][0]['action'] == 'created'
    assert 'rate limit' in body['results'][1]['error']
    assert body['results'][2]['action'] == 'skipped'
    assert client.session.request.call_count == 6


def test_batch_updates_lookup_after_creating_a_repeated_username(api):
    client = ctfd_client(
        response(payload={'data': []}),
        response(payload={'data': {'id': 8}}),
        response(payload={'data': {'id': 8}}),
    )
    http, url = api
    project = Project(id='ctfd-rate-limit', name='Repeated users', credentials=[
        {'username': 'alice', 'password': 'first-password'},
        {'username': 'ALICE', 'password': 'second-password'},
    ])
    with patch('app.routes.api._store', return_value=Mock(get=Mock(return_value=project))), patch('app.routes.api._ctfd_client_from_req', return_value=client), patch.object(client, 'get_role', return_value='admin'):
        result = http.post(url, json={})
    body = result.get_json()
    assert (body['created'], body['updated']) == (1, 1)
    assert [c.args[0] for c in client.session.request.call_args_list] == ['GET', 'POST', 'PATCH']


def test_failed_bulk_lookup_does_not_create_users(api):
    client = ctfd_client(response(429, retry_after='120'))
    http, url = api
    with patch('app.routes.api._ctfd_client_from_req', return_value=client), patch.object(client, 'get_role', return_value='admin'):
        result = http.post(url, json={})
    assert result.status_code == 429
    assert result.get_json()['ok'] is False
    assert client.session.request.call_count == 1


@pytest.mark.parametrize('payload', [{}, {'success': False}, {'data': {}}])
def test_invalid_listing_is_not_treated_as_an_empty_complete_directory(payload):
    client = ctfd_client(response(payload=payload))
    with pytest.raises(ValueError, match='invalid user listing'):
        client.list_all_users()


@pytest.mark.parametrize('admin_failure', [None, CTFdError(403), CTFdError(429)])
def test_missing_user_checks_avoid_repeated_searches_after_complete_admin_listing(api, admin_failure):
    client = Mock(spec=CTFdClient)
    client.token, client.logs, client.base_url, client.verify_ssl = '', [], 'https://ctfd.test', True
    client.list_challenges_all.return_value = []
    client.find_user_id_by_name.return_value = None
    client.list_all_users.side_effect = [admin_failure, []] if admin_failure else None
    client.list_all_users.return_value = []
    http, url = api
    with patch('app.routes.api._ctfd_client_from_req', return_value=client):
        result = http.post(url.replace('users_create', 'users_check'), json={})
    if admin_failure and admin_failure.status_code == 429:
        assert result.status_code == 429
        assert client.list_all_users.call_count == 1
        client.find_user_id_by_name.assert_not_called()
    elif admin_failure:
        assert result.status_code == 200
        assert client.list_all_users.call_count == 2
        assert client.find_user_id_by_name.call_count == 3, 'a public listing cannot prove a hidden user is absent'
    else:
        assert result.status_code == 200
        assert all(not user['exists'] for user in result.get_json()['users'])
        client.find_user_id_by_name.assert_not_called()
