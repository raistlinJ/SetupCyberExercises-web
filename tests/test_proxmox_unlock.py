from unittest.mock import MagicMock, patch

import pytest

from app import create_app
from app.connectors.proxmox import ProxmoxClient
from app.storage.projects import Project


@pytest.mark.parametrize('kind,method,result', [('qemu', 'post', 'UPID:node1:unlock'), ('lxc', 'put', None)])
def test_unlock_uses_config_api(kind, method, result):
    client = ProxmoxClient(base_url='https://proxmox.local', token='test')
    session = MagicMock()
    response = getattr(session, method).return_value
    response.status_code = 200
    response.json.return_value = {'data': result}
    with patch.object(client, '_ensure_session', return_value=session):
        assert getattr(client, f'unlock_{kind}')('node1', 101) == result
    getattr(session, method).assert_called_once_with(
        f'https://proxmox.local/api2/json/nodes/node1/{kind}/101/config',
        data={'delete': 'lock', 'skiplock': 1}, timeout=30)


@pytest.mark.parametrize('kind,method', [('qemu', 'post'), ('lxc', 'put')])
def test_unlock_preserves_permission_errors(kind, method):
    client = ProxmoxClient(base_url='https://proxmox.local', token='test')
    session = MagicMock()
    response = getattr(session, method).return_value
    response.status_code = 403
    response.text = 'Only root can use skiplock'
    with patch.object(client, '_ensure_session', return_value=session):
        with pytest.raises(RuntimeError, match='Only root can use skiplock'):
            getattr(client, f'unlock_{kind}')('node1', 101)


@pytest.mark.parametrize('kind,program', [('qemu', 'qm'), ('lxc', 'pct')])
@pytest.mark.parametrize('username,sudo', [('operator@pam', True), ('root@pam', False)])
@pytest.mark.parametrize('failure', [None, 'lock', 'command', 'connect', 'read'])
def test_unlock_route_uses_ssh_sudo_and_verifies(kind, program, username, sudo, failure):
    app = create_app()
    app.config['TESTING'] = True
    project = Project(id='unlock-test', name='Unlock', proxmox_url='https://proxmox.local',
                      proxmox_api_token='test', proxmox_ssh_port=2222,
                      proxmox_node_host_map={'node1': 'node1.example'})
    mapped = [{'index': 1, 'name': 'alpha', 'vmid': 101, 'node': 'node1', 'type': kind}]
    with patch('app.routes.api._store') as store, \
            patch('app.routes.api._resolve_targets_to_vm_info', return_value=(mapped, [], [])), \
            patch('app.routes.api._start_job'), patch('app.routes.api._end_job'), \
            patch('app.routes.api._is_cancelled', return_value=False), \
            patch('app.routes.api._ssh_connect') as connect, \
            patch('app.routes.api._ssh_exec_result') as execute, \
            patch('app.routes.api.ProxmoxClient') as client_cls:
        store.return_value.get.return_value = project
        client = client_cls.return_value
        config = getattr(client, f'get_{kind}_config')
        config.return_value = {'lock': 'backup'} if failure == 'lock' else {}
        execute.return_value = (1, b'', 'sudo denied') if failure == 'command' else (0, b'', '')
        if failure == 'connect':
            connect.side_effect = RuntimeError('SSH unavailable')
        if failure == 'read':
            config.side_effect = RuntimeError('config unavailable')
        response = app.test_client().post('/api/projects/unlock-test/instances/actions/unlock', json={
            'targets': [{'index': 1, 'name': 'alpha'}], 'username': username, 'password': 'secret'})
        assert response.status_code == 200
        payload = response.get_json()
        assert len(payload['errors']) == int(failure is not None)
        assert len(payload['unlocked']) == int(failure is None)
        connect.assert_called_once_with('node1.example', 2222, username.split('@')[0], 'secret')
        if failure != 'connect':
            execute.assert_called_once_with(connect.return_value, f'{program} unlock 101',
                                            timeout=600, sudo=sudo, sudo_password='secret')
            connect.return_value.close.assert_called_once()
        else:
            execute.assert_not_called()
        client.unlock_qemu.assert_not_called()
        client.unlock_lxc.assert_not_called()
        client._wait_task.assert_not_called()


def test_unlock_requires_ssh_credentials_even_with_api_token():
    app = create_app()
    app.config['TESTING'] = True
    project = Project(id='unlock-test', name='Unlock', proxmox_url='https://proxmox.local',
                      proxmox_api_token='test')
    with patch('app.routes.api._store') as store, patch('app.routes.api._start_job'), \
            patch('app.routes.api._end_job') as end, patch('app.routes.api._ssh_connect') as connect:
        store.return_value.get.return_value = project
        response = app.test_client().post('/api/projects/unlock-test/instances/actions/unlock',
                                          json={'targets': [{'index': 1, 'name': 'alpha'}]})
        assert response.status_code == 400
        assert 'SSH username/password' in response.get_json()['error']
        connect.assert_not_called()
        end.assert_called_once_with('unlock-test')
