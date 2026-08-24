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


if __name__ == '__main__':
    unittest.main()
