import unittest
from unittest.mock import MagicMock

from app.connectors.proxmox import ProxmoxClient


class ProxmoxGuestAgentFileTests(unittest.TestCase):
    def setUp(self):
        self.client = ProxmoxClient(
            base_url='https://proxmox.local:8006',
            token='token-id=secret',
            verify=False,
        )
        self.session = MagicMock()
        self.client._ensure_session = MagicMock(return_value=self.session)

    def test_agent_exec_forwards_input_data(self):
        started = MagicMock(status_code=200, content=b'{}')
        started.json.return_value = {'data': {'pid': 44}}
        completed = MagicMock(status_code=200, content=b'{}')
        completed.json.return_value = {
            'data': {'exited': 1, 'exitcode': 0, 'out-data': '', 'err-data': ''},
        }
        self.session.post.return_value = started
        self.session.get.return_value = completed

        result = self.client.agent_exec(
            node='node1',
            vmid=101,
            command=['/bin/sh', '-c', 'base64 -d >> /tmp/archive.tar'],
            shell=False,
            input_data='YWxwaGE=',
        )

        self.assertEqual(result['exitcode'], 0)
        payload = self.session.post.call_args.kwargs['json']
        self.assertEqual(payload['input-data'], 'YWxwaGE=')
        self.assertEqual(payload['command'][0], '/bin/sh')

    def test_agent_file_read_requests_encoded_chunk_with_offset(self):
        response = MagicMock(status_code=200, content=b'{}')
        response.json.return_value = {
            'data': {'content': 'YWxwaGE=', 'bytes-read': 5, 'truncated': 0},
        }
        self.session.get.return_value = response

        result = self.client.agent_file_read(
            node='node1',
            vmid=101,
            path='/tmp/archive.tar',
            offset=4096,
            count=8192,
            decode=False,
        )

        self.assertEqual(result['bytes-read'], 5)
        params = self.session.get.call_args.kwargs['params']
        self.assertEqual(params, {
            'file': '/tmp/archive.tar',
            'offset': 4096,
            'count': 8192,
            'decode': 0,
        })

    def test_agent_file_read_legacy_omits_new_chunk_parameters(self):
        response = MagicMock(status_code=200, content=b'{}')
        response.json.return_value = {'data': {'content': 'YWxwaGE='}}
        self.session.get.return_value = response

        self.client.agent_file_read(
            node='node1',
            vmid=101,
            path='/tmp/archive.part.aa',
            legacy=True,
        )

        params = self.session.get.call_args.kwargs['params']
        self.assertEqual(params, {'file': '/tmp/archive.part.aa'})


if __name__ == '__main__':
    unittest.main()
