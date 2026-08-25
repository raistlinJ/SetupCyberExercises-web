import os
import unittest
from unittest.mock import patch

from app import create_app
from app.routes.api import _summarize_proxmox_node_resources


class ProxmoxServerResourcesApiTests(unittest.TestCase):

    def setUp(self):
        os.environ['AUTH_ENABLE'] = '0'
        self.app = create_app()
        self.app.config['TESTING'] = True
        self.client = self.app.test_client()

    def tearDown(self):
        os.environ.pop('AUTH_ENABLE', None)

    @staticmethod
    def _nodes():
        gib = 1024 ** 3
        return [
            {
                'node': 'pve1',
                'status': 'online',
                'disk': 20 * gib,
                'maxdisk': 100 * gib,
                'mem': 8 * gib,
                'maxmem': 32 * gib,
            },
            {
                'node': 'pve2',
                'status': 'online',
                'disk': 30 * gib,
                'maxdisk': 200 * gib,
                'mem': 16 * gib,
                'maxmem': 64 * gib,
            },
            {
                'node': 'pve-offline',
                'status': 'offline',
                'disk': 99 * gib,
                'maxdisk': 999 * gib,
                'mem': 99 * gib,
                'maxmem': 999 * gib,
            },
        ]

    def test_summary_uses_only_the_configured_node(self):
        gib = 1024 ** 3
        summary = _summarize_proxmox_node_resources(self._nodes(), preferred_node='pve2')
        self.assertEqual(summary['node'], 'pve2')
        self.assertEqual(summary['node_count'], 1)
        self.assertEqual(summary['space_used_bytes'], 30 * gib)
        self.assertEqual(summary['space_total_bytes'], 200 * gib)
        self.assertEqual(summary['memory_used_bytes'], 16 * gib)
        self.assertEqual(summary['memory_total_bytes'], 64 * gib)

    def test_summary_aggregates_online_nodes_when_no_node_is_configured(self):
        gib = 1024 ** 3
        summary = _summarize_proxmox_node_resources(self._nodes())
        self.assertEqual(summary['node'], 'cluster')
        self.assertEqual(summary['node_count'], 2)
        self.assertEqual(summary['space_used_bytes'], 50 * gib)
        self.assertEqual(summary['space_total_bytes'], 300 * gib)
        self.assertEqual(summary['memory_used_bytes'], 24 * gib)
        self.assertEqual(summary['memory_total_bytes'], 96 * gib)

    def test_nodes_endpoint_returns_resources_and_applies_api_port(self):
        with patch('app.routes.api.ProxmoxClient') as client_cls:
            client_cls.return_value.list_nodes.return_value = self._nodes()
            response = self.client.post('/api/proxmox/nodes', json={
                'baseUrl': 'https://prox.example',
                'apiPort': 9443,
                'username': 'root@pam',
                'password': 'secret',
                'verifySSL': False,
                'preferredNode': 'pve1',
            })

        self.assertEqual(response.status_code, 200)
        client_cls.assert_called_once_with(
            base_url='https://prox.example:9443',
            token=None,
            username='root@pam',
            password='secret',
            verify=False,
        )
        payload = response.get_json() or {}
        self.assertEqual(len(payload.get('nodes') or []), 3)
        self.assertEqual((payload.get('server_resources') or {}).get('node'), 'pve1')


if __name__ == '__main__':
    unittest.main()
