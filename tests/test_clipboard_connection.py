from unittest.mock import patch

from app.storage.projects import ProjectStore
from test_account_checkout import checkout, connect, reply


def test_usage_uses_saved_accessforge_connection_and_checks_cluster(checkout):
    app, client, _ = checkout
    store = ProjectStore(app.config['DATA_DIR'])
    project = store.get('lab')
    project.proxmox_url = 'https://pve.example'
    store.upsert(project)
    connect(client)
    payload = {'usage': {'101': {'to_vm': {'used': 20}}}, 'cluster': {'host': 'pve.example', 'port': 8006}}
    with patch('app.account_checkout.requests.request', return_value=reply(payload)) as remote:
        result = client.post('/api/projects/lab/accessforge/clipboard/usage', json={'vmids': [101]})
    assert result.status_code == 200 and result.json['usage']['101']['to_vm']['used'] == 20
    assert remote.call_args.args[1].endswith('/api/admin/clipboard/usage?vmids=101')
    assert remote.call_args.kwargs['auth'] == ('root@pam', 'admin-password')
    payload['cluster']['host'] = 'different.example'
    with patch('app.account_checkout.requests.request', return_value=reply(payload)):
        assert client.post('/api/projects/lab/accessforge/clipboard/usage', json={'vmids': [101]}).status_code == 409


def test_clipboard_connection_does_not_require_account_checkout_enabled(checkout):
    _, client, _ = checkout
    responses = [reply({'error': 'Account checkout is disabled on this AccessForge server.'}, 404),
                 reply({'service': 'AccessForge', 'clipboard_api': 1, 'administrator': 'root@pam'})]
    with patch('app.account_checkout.requests.request', side_effect=responses) as remote:
        result = client.post('/api/projects/lab/accessforge/connection', json={
            'url': 'https://accessforge.example', 'username': 'root@pam', 'password': 'admin-password'})
    assert result.status_code == 200 and result.json['connected']
    assert remote.call_args.args[1].endswith('/api/admin/clipboard/status')
