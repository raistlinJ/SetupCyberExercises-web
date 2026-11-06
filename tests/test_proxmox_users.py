import unittest
from unittest.mock import MagicMock, patch

from app.connectors.proxmox import ProxmoxClient


class _Response:
    def __init__(self, status_code=200, data=None, text=''):
        self.status_code = status_code
        self._data = data
        self.text = text

    def json(self):
        return {'data': self._data}


class ProxmoxUserTests(unittest.TestCase):

    def test_get_user_falls_back_to_user_list_when_direct_get_is_not_implemented(self):
        client = ProxmoxClient(base_url='https://proxmox.local:8006', token='abc', verify=False)
        session = MagicMock()
        session.get.side_effect = [
            _Response(status_code=501, text="Method 'GET /access/users/alice@pve' not implemented"),
            _Response(status_code=200, data=[
                {'userid': 'other@pve'},
                {'userid': 'alice@pve', 'enable': 1},
            ]),
        ]

        with patch.object(client, '_ensure_session', return_value=session):
            result = client.get_user('alice@pve')

        self.assertEqual(result, {'userid': 'alice@pve', 'enable': 1})
        self.assertEqual(session.get.call_count, 2)
        self.assertEqual(
            session.get.call_args_list[1].args[0],
            'https://proxmox.local:8006/api2/json/access/users',
        )
        self.assertEqual(session.get.call_args_list[1].kwargs.get('params'), {'full': 1})


    def test_password_reset_uses_password_endpoint_and_preserves_disabled_state(self):
        client = ProxmoxClient(base_url='https://proxmox.local:8006', username='root@pam', password='admin-secret')
        session = MagicMock()
        session.put.return_value = _Response(status_code=200)
        with patch.object(client, '_ensure_session', return_value=session):
            client.update_user('alice@pve', password='new-password', enable=False)
        self.assertEqual(session.put.call_count, 2)
        self.assertEqual(session.put.call_args_list[0].kwargs['data'], {'enable': 0})
        self.assertTrue(session.put.call_args_list[1].args[0].endswith('/api2/json/access/password'))
        self.assertEqual(session.put.call_args_list[1].kwargs['data'], {
            'userid': 'alice@pve', 'password': 'new-password', 'confirmation-password': 'admin-secret'})


if __name__ == '__main__':
    unittest.main()
