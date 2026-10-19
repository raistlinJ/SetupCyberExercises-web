"""Built-in integration plugins can be toggled independently at startup."""

import os

import pytest

import app as application


@pytest.fixture(autouse=True)
def restore_plugin_environment():
    original = {key: os.environ.get(key) for key in ('CTFD_PLUGIN_ENABLE', 'CTFRPG_PLUGIN_ENABLE')}
    yield
    for key, value in original.items():
        if value is None:
            os.environ.pop(key, None)
        else:
            os.environ[key] = value


@pytest.mark.parametrize('ctfd,ctfrpg', [('0', '1'), ('1', '0'), ('0', '0'), ('1', '1')])
def test_integration_plugin_flags_control_discovery_pages_and_routes(monkeypatch, tmp_path, ctfd, ctfrpg):
    monkeypatch.setenv('DATA_DIR', str(tmp_path))
    monkeypatch.setenv('AUTH_ENABLE', '0')
    monkeypatch.setenv('AGENT_PLUGIN_ENABLE', '0')
    monkeypatch.setenv('CTFD_PLUGIN_ENABLE', ctfd)
    monkeypatch.setenv('CTFRPG_PLUGIN_ENABLE', ctfrpg)
    app = application.create_app()
    app.config.update(TESTING=True)
    client = app.test_client()
    names = {entry['name'] for entry in client.get('/api/plugins').get_json()['plugins']}
    assert ('ctfd' in names) is (ctfd == '1')
    assert ('ctfrpg' in names) is (ctfrpg == '1')
    assert client.get('/static/ctfd_manager.html').status_code == (200 if ctfd == '1' else 404)
    assert client.get('/static/ctfd_challenges.html').status_code == (200 if ctfd == '1' else 404)
    assert client.get('/static/ctfrpg_manager.html').status_code == (200 if ctfrpg == '1' else 404)

    project = client.post('/api/projects', json={'name': 'Flags'}).get_json()
    pid = project['id']
    ctfd_response = client.post(f'/api/projects/{pid}/ctfd/login', json={})
    rpg_response = client.post(f'/api/projects/{pid}/ctfrpg/login', json={})
    if ctfd == '0':
        assert ctfd_response.status_code == 404
        assert ctfd_response.get_json()['error'] == 'CTFd plugin is disabled'
        assert client.post('/api/ctfd/challenges', json={}).status_code == 404
        assert client.post('/api/test/credentials', json={'ctfd': {'url': 'https://example.test'}}).status_code == 404
    else:
        assert ctfd_response.status_code != 404
    if ctfrpg == '0':
        assert rpg_response.status_code == 404
        assert rpg_response.get_json()['error'] == 'CTF-RPG plugin is disabled'
    else:
        assert rpg_response.status_code != 404


def test_dotenv_can_disable_integrations_independently(monkeypatch, tmp_path):
    env_file = tmp_path / '.env'
    env_file.write_text('CTFD_PLUGIN_ENABLE=0\nCTFRPG_PLUGIN_ENABLE=1\n')
    monkeypatch.setattr(application, '_DOTENV_PATH', str(env_file))
    monkeypatch.setenv('DATA_DIR', str(tmp_path / 'data'))
    monkeypatch.setenv('AUTH_ENABLE', '0')
    monkeypatch.delenv('CTFD_PLUGIN_ENABLE', raising=False)
    monkeypatch.delenv('CTFRPG_PLUGIN_ENABLE', raising=False)
    app = application.create_app()
    assert app.config['CTFD_PLUGIN_ENABLE'] is False
    assert app.config['CTFRPG_PLUGIN_ENABLE'] is True

    monkeypatch.setenv('CTFD_PLUGIN_ENABLE', '1')
    app = application.create_app()
    assert app.config['CTFD_PLUGIN_ENABLE'] is True
