from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from app import create_app
from app.routes import api
from app.storage.projects import Project


@pytest.fixture
def settings_client(monkeypatch, tmp_path):
    monkeypatch.setenv('AUTH_ENABLE', '0')
    app = create_app()
    app.config.update(TESTING=True, DATA_DIR=str(tmp_path))
    project = Project(id='settings', name='Settings', challenge_url='https://ctfd.test')
    monkeypatch.setattr(api, '_store', lambda: SimpleNamespace(get=lambda pid: project))
    remote = Mock(token='', logs=[])
    remote.get_role.return_value = 'admin'
    configs = {'allow_solve_retraction': False, 'challenge_visibility': 'private'}
    remote.list_configs.side_effect = lambda: dict(configs)
    remote.set_configs.side_effect = lambda updates: configs.update(updates) or {'success': True}
    monkeypatch.setattr(api, '_ctfd_client_from_req', lambda proj: remote)
    return app.test_client(), remote, configs


@pytest.mark.parametrize('value, expected', [(True, True), (False, False), ('true', True), ('false', False), (1, True), (0, False)])
def test_read_solve_retraction_setting(settings_client, value, expected):
    client, _, configs = settings_client
    configs['allow_solve_retraction'] = value
    response = client.post('/api/projects/settings/ctfd/settings', json={})
    assert response.status_code == 200
    assert response.json['settings']['users_can_clear_submissions'] is expected
    assert response.json['capabilities']['solve_retraction'] is True


@pytest.mark.parametrize('enabled', [True, False])
def test_solve_retraction_updates_are_written_and_verified(settings_client, enabled):
    client, remote, configs = settings_client
    configs['allow_solve_retraction'] = not enabled
    response = client.post('/api/projects/settings/ctfd/settings/update', json={'users_can_clear_submissions': enabled})
    assert response.status_code == 200
    remote.set_configs.assert_called_once_with({'allow_solve_retraction': enabled})
    assert response.json['settings']['users_can_clear_submissions'] is enabled
    assert response.json['capabilities']['solve_retraction'] is True
    assert configs['challenge_visibility'] == 'private'


def test_old_servers_report_unsupported_and_cannot_silently_accept_the_setting(settings_client):
    client, remote, configs = settings_client
    configs.pop('allow_solve_retraction')
    response = client.post('/api/projects/settings/ctfd/settings', json={})
    assert response.json['capabilities']['solve_retraction'] is False
    response = client.post('/api/projects/settings/ctfd/settings/update', json={'users_can_clear_submissions': True})
    assert response.status_code == 409
    remote.set_configs.assert_not_called()


@pytest.mark.parametrize('role', ['user', 'teacher'])
def test_only_ctfd_admin_can_enable_solve_retraction(settings_client, role):
    client, remote, _ = settings_client
    remote.get_role.return_value = role
    response = client.post('/api/projects/settings/ctfd/settings/update', json={'users_can_clear_submissions': True})
    assert response.status_code == 403
    remote.set_configs.assert_not_called()


def test_retraction_update_rejects_string_booleans(settings_client):
    client, remote, _ = settings_client
    response = client.post('/api/projects/settings/ctfd/settings/update', json={'users_can_clear_submissions': 'false'})
    assert response.status_code == 400
    remote.set_configs.assert_not_called()


def test_failed_remote_setting_change_is_not_reported_as_applied(settings_client):
    client, remote, _ = settings_client
    remote.set_configs.side_effect = lambda updates: {'error': 'Remote write failed'}
    response = client.post('/api/projects/settings/ctfd/settings/update', json={'users_can_clear_submissions': True})
    assert response.status_code == 502
    assert response.json['ok'] is False
