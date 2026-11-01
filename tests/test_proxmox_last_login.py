from unittest.mock import Mock

import pytest

from app import create_app
from app.connectors.proxmox import ProxmoxClient
from app.routes import api
from app.storage.projects import Project, ProjectStore, VMConfig


def test_cluster_auth_log_returns_latest_matching_success_for_each_exact_account():
    session = Mock()
    session.get.return_value.json.return_value = {'data': [
        {'msg': "successful auth for user 'alice@pve'", 'time': 100},
        {'msg': "successful auth for user 'alice@pve'", 'time': 300},
        {'msg': "successful auth for user 'alice@pam'", 'time': 250},
        {'msg': "successful auth for user 'alice2@pve'", 'time': 200},
        {'msg': "authentication failure for user 'alice@pve'", 'time': 400},
        {'msg': "task successful auth for user 'alice@pve'", 'time': 500},
        {'msg': "successful auth for user 'alice@pve'", 'time': 'nan'},
        {'msg': "successful auth for user 'alice@pve'", 'time': 'inf'},
        {'msg': "successful auth for user 'alice@pve'", 'time': None},
    ]}
    client = ProxmoxClient(base_url='https://proxmox.test', token='test')
    client._ensure_session = lambda: session
    assert client.last_user_authentications() == {'alice@pve': 300, 'alice@pam': 250, 'alice2@pve': 200}
    session.get.assert_called_once_with('https://proxmox.test/api2/json/cluster/log', params={'max': 1000}, timeout=20)


@pytest.mark.parametrize('enabled,read_error', [(False, False), (True, False), (True, True)])
def test_refresh_reads_auth_times_only_when_requested_and_keeps_inventory_on_log_error(monkeypatch, tmp_path, enabled, read_error):
    monkeypatch.setenv('AUTH_ENABLE', '0')
    app = create_app()
    app.config.update(TESTING=True, DATA_DIR=str(tmp_path))
    store = ProjectStore(str(tmp_path))
    project = Project(id='one', name='Example', instances=1, credentials=[{'username': 'alice'}],
                      vms=[VMConfig(name='web')], proxmox_api_token='test')
    store.upsert(project)
    monkeypatch.setattr(api, '_store', lambda: store)
    remote = Mock()
    remote.list_nodes.return_value = [{'node': 'n'}]
    remote.list_qemu_vms.return_value = []
    remote.list_lxc_vms.return_value = []
    remote.list_lxc_containers.return_value = []
    remote.list_pools.return_value = []
    remote.list_acls.return_value = []
    remote.last_user_authentications.return_value = {'alice@pve': 1793286000, 'alice2@pve': 1793287000}
    if read_error:
        remote.last_user_authentications.side_effect = RuntimeError('Permission denied')
    monkeypatch.setattr(api, 'ProxmoxClient', lambda **_: remote)
    api._clear_vm_cache('one')
    response = app.test_client().post('/api/projects/one/instances/refresh/vm', json={
        'forceRefresh': True, 'includeLastLogin': enabled,
    })
    assert response.status_code == 200, response.json
    status = response.json['instance_statuses'][0]
    if enabled:
        assert status['proxmox_login_user'] == 'alice@pve'
        assert status['proxmox_last_login'] == (None if read_error else 1793286000)
        assert ProjectStore(str(tmp_path)).get('one').instance_statuses[0]['proxmox_last_login'] == status['proxmox_last_login']
        remote.last_user_authentications.assert_called_once()
    else:
        assert 'proxmox_last_login' not in status
        remote.last_user_authentications.assert_not_called()
