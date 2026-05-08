import unittest
from unittest.mock import MagicMock, patch

from app.connectors.proxmox import ProxmoxClient


class _Response:
    def __init__(self, status_code=200, data=None, text=''):
        self.status_code = status_code
        self._data = data or {}
        self.text = text

    def json(self):
        return {'data': self._data}


class ProxmoxWaitTaskTests(unittest.TestCase):

    def test_wait_task_returns_when_vm_is_running_even_if_task_status_lags(self):
        client = ProxmoxClient(base_url='https://proxmox.local', token='abc', verify=False)
        session = MagicMock()
        session.get.side_effect = [
            _Response(status_code=200, data={'status': 'running', 'qmpstatus': 'running'}),
            _Response(status_code=200, data={'status': 'running'}),
        ]

        with patch.object(client, '_ensure_session', return_value=session):
            with patch('app.connectors.proxmox.time.sleep'):
                result = client._wait_task(
                    'node1',
                    'UPID:node1:00000001',
                    timeout=5,
                    poll=0,
                    vmid=101,
                    completed_vm_statuses=['running'],
                )

        self.assertEqual(result.get('exitstatus'), 'OK')
        self.assertEqual(result.get('completed_via'), 'vm_state')
        self.assertEqual(result.get('vm_status'), 'running')

    def test_wait_task_uses_vm_state_fallback_when_task_status_endpoint_errors(self):
        client = ProxmoxClient(base_url='https://proxmox.local', token='abc', verify=False)
        session = MagicMock()
        session.get.side_effect = [
            _Response(status_code=595, text='connection timed out'),
            _Response(status_code=200, data={'status': 'running', 'qmpstatus': 'running'}),
        ]

        with patch.object(client, '_ensure_session', return_value=session):
            with patch('app.connectors.proxmox.time.sleep'):
                result = client._wait_task(
                    'node1',
                    'UPID:node1:00000001',
                    timeout=5,
                    poll=0,
                    vmid=101,
                    completed_vm_statuses=['running'],
                )

        self.assertEqual(result.get('exitstatus'), 'OK')
        self.assertEqual(result.get('completed_via'), 'vm_state')
        self.assertEqual(result.get('vm_status'), 'running')


if __name__ == '__main__':
    unittest.main()