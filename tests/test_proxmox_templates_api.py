import os
import unittest
from unittest.mock import MagicMock, patch

from app import create_app


class ProxmoxTemplatesApiTests(unittest.TestCase):

    def setUp(self):
        os.environ['AUTH_ENABLE'] = '0'
        os.environ.pop('API_KEY', None)
        self.app = create_app()
        self.app.config['TESTING'] = True
        self.client = self.app.test_client()

    def tearDown(self):
        try:
            os.environ.pop('AUTH_ENABLE', None)
        except Exception:
            pass

    def test_templates_include_qemu_agent_enabled(self):
        with patch('app.routes.api.ProxmoxClient') as prox_cls:
            prox = MagicMock()
            prox_cls.return_value = prox
            prox.list_nodes.return_value = [{'node': 'pve1'}]
            prox.list_qemu_vms.return_value = [
                {'template': 1, 'vmid': 101, 'name': 'tmpl-enabled-kv'},
                {'template': 1, 'vmid': 102, 'name': 'tmpl-enabled-prefix'},
                {'template': 1, 'vmid': 103, 'name': 'tmpl-disabled'},
                {'template': 1, 'vmid': 104, 'name': 'tmpl-missing'},
                {'template': 0, 'vmid': 999, 'name': 'skip-not-template'},
            ]

            def _cfg(_node, vmid):
                table = {
                    101: {'agent': 'enabled=1,fstrim_cloned_disks=1', 'net0': 'virtio,bridge=vmbr10'},
                    102: {'agent': '1,fstrim_cloned_disks=1', 'net0': 'virtio,bridge=vmbr11'},
                    103: {'agent': '0', 'net0': 'virtio,bridge=vmbr12'},
                    104: {'net0': 'virtio,bridge=vmbr13'},
                }
                return table[int(vmid)]

            prox.get_qemu_config.side_effect = _cfg

            resp = self.client.post(
                '/api/proxmox/templates',
                json={
                    'baseUrl': 'https://proxmox.local',
                    'username': 'root@pam',
                    'password': 'secret',
                    'verifySSL': False,
                },
            )

        self.assertEqual(resp.status_code, 200)
        payload = resp.get_json() or {}
        templates = payload.get('templates') or []
        self.assertEqual(len(templates), 4)

        by_name = {item.get('name'): item for item in templates}

        self.assertTrue(by_name['tmpl-enabled-kv'].get('qemu_agent_enabled'))
        self.assertTrue(by_name['tmpl-enabled-prefix'].get('qemu_agent_enabled'))
        self.assertFalse(by_name['tmpl-disabled'].get('qemu_agent_enabled'))
        self.assertFalse(by_name['tmpl-missing'].get('qemu_agent_enabled'))

        self.assertEqual(by_name['tmpl-enabled-kv'].get('bridges'), ['vmbr10'])
        self.assertEqual(by_name['tmpl-disabled'].get('bridges'), ['vmbr12'])


if __name__ == '__main__':
    unittest.main()
