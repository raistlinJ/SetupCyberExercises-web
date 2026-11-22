from unittest.mock import Mock, patch

import pytest
import requests

from app.account_checkout import ConnectionStore
from app.routes import api
from app.storage.projects import Project, ProjectStore
from test_account_checkout import checkout, reply


@pytest.mark.parametrize(('mode', 'verify_ssl'), [
    ('project-token', False),
    ('shared-url-token', False),
    ('project-ticket', True),
])
def test_vm_refresh_reads_accessforge_times_and_preserves_them_during_failures(checkout, monkeypatch, mode, verify_ssl):
    app, client, project = checkout
    project.proxmox_url = 'https://pve.example'
    project.proxmox_api_port = 8443
    project.proxmox_api_token = '' if mode == 'project-ticket' else 'root@pam!refresh=example'
    project.credentials[1]['username'] = 'student01@pam'
    store = ProjectStore(app.config['DATA_DIR'])
    store.upsert(project)
    url_project = 'lab'
    if mode == 'shared-url-token':
        url_project = 'other-lab'
        store.upsert(Project(id=url_project, name='Other lab', proxmox_url=project.proxmox_url,
                             proxmox_api_port=project.proxmox_api_port))
    with app.app_context():
        connections = ConnectionStore()
        if verify_ssl:
            connections.configure_url('instructor', url_project, 'https://accessforge.example')
        else:
            connections.save('instructor', url_project, 'https://accessforge.example',
                             '', '', False, persist=False)
    credentials = {'username': 'teacher@pam', 'password': 'example-password'} if mode == 'project-ticket' else {}
    auth_headers = ({'X-AccessForge-Proxmox-Ticket': 'refresh-ticket'} if credentials else
                    {'Authorization': 'PVEAPIToken=root@pam!refresh=example'})

    proxmox = Mock()
    proxmox.list_nodes.return_value = [{'node': 'n'}]
    for method in ('list_qemu_vms', 'list_lxc_vms', 'list_lxc_containers', 'list_pools', 'list_acls'):
        getattr(proxmox, method).return_value = []
    proxmox.accessforge_sign_in_headers.return_value = auth_headers
    monkeypatch.setattr(api, 'ProxmoxClient', lambda **_: proxmox)
    api._clear_vm_cache('lab')

    def refresh(enabled=True, **overrides):
        result = client.post('/api/projects/lab/instances/refresh/vm',
                             json={'forceRefresh': True, 'includeLastLogin': enabled, **credentials, **overrides})
        assert result.status_code == 200, result.json
        return result.json['instance_statuses']

    latest = {'student01@pve': 1793286000, 'student01@pam': 1793287000, 'unrelated@pve': 1793288000}
    finished = {'timestamp': 1793287001, 'estimated': False}
    payload = {'cluster': {'host': 'pve.example', 'port': 8443}, 'latest': latest, 'observed_at': 1793287002,
               'active': ['student01@pve', 'unrelated@pve'],
               'ends': {'student01@pve': {'timestamp': 1793285999, 'estimated': True},
                        'student01@pam': finished, 'unrelated@pve': finished}}
    with patch('app.account_checkout.requests.request', return_value=reply(payload)) as accessforge:
        assert all('accessforge_last_login' not in row for row in refresh(enabled=False))
        accessforge.assert_not_called()
        statuses = refresh(apiPort=8443)
        accessforge.assert_called_once()
        assert accessforge.call_args.args == ('POST', 'https://accessforge.example/api/admin/sign-ins/latest')
        assert accessforge.call_args.kwargs['headers'] == auth_headers
        assert accessforge.call_args.kwargs['verify'] is verify_ssl
        assert 'auth' not in accessforge.call_args.kwargs
        assert accessforge.call_args.kwargs['json'] == {'usernames': ['student01@pam', 'student01@pve'],
                                                      'cluster': {'host': 'pve.example', 'port': 8443}}
        session = requests.Session()
        session.cookies.set('PVEAuthCookie', 'refresh-ticket')
        with patch('app.account_checkout.ProxmoxClient._ensure_session', return_value=session):
            endpoint = '/api/projects/lab/accessforge/sign-ins/latest'
            live = client.post(endpoint, json=credentials) if credentials else client.get(endpoint)
        assert live.status_code == 200
        assert accessforge.call_args.kwargs['verify'] is verify_ssl
        assert live.headers['Cache-Control'] == 'no-store'
        assert live.json == {'latest': {'student01@pve': 1793286000, 'student01@pam': 1793287000},
                             'observed_at': 1793287002, 'active': ['student01@pve'],
                             'ends': {'student01@pam': finished}}
    assert [row['accessforge_login_user'] for row in statuses] == ['student01@pve', 'student01@pam']
    assert [row['accessforge_last_login'] for row in statuses] == [1793286000, 1793287000]
    assert [row['accessforge_last_login_end'] for row in statuses] == [None, finished]
    assert store.get('lab').instance_statuses == statuses
    proxmox.last_user_authentications.assert_not_called()

    with patch('app.account_checkout.requests.request', side_effect=requests.Timeout):
        statuses = refresh()
        assert [row['accessforge_last_login'] for row in statuses] == [1793286000, 1793287000]
        assert [row['accessforge_last_login_end'] for row in statuses] == [None, finished]

    legacy_payload = {key: value for key, value in payload.items() if key != 'ends'}
    with patch('app.account_checkout.requests.request', return_value=reply(legacy_payload)):
        assert [row['accessforge_last_login_end'] for row in refresh()] == [None, finished]

    with patch('app.account_checkout.requests.request', return_value=reply(payload)):
        statuses = refresh(baseUrl='https://other.example', apiPort=8443)
        assert all(row['accessforge_last_login'] is None for row in statuses)
        assert all(row['accessforge_last_login_end'] is None for row in statuses)

    missing = requests.Response()
    missing.status_code = 404
    missing._content = b'<!doctype html><title>Not Found</title>'
    with patch('app.account_checkout.requests.request', return_value=missing):
        with patch('app.account_checkout.ProxmoxClient._ensure_session', return_value=session):
            unavailable = client.post(endpoint, json=credentials) if credentials else client.get(endpoint)
    assert unavailable.status_code == 501
    assert 'Update AccessForge and restart' in unavailable.json['error']
