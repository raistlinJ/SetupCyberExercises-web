import tempfile
import unittest
import os
from unittest.mock import patch

from app import create_app
from app.storage.projects import Project, VMConfig


class _StoreStub:
    def __init__(self, project: Project):
        self._project = project

    def get(self, pid: str):
        if pid == self._project.id:
            return self._project
        return None

    def upsert(self, project: Project):
        self._project = project


class _ClientStub:
    def __init__(self, *args, **kwargs):
        pass

    def list_nodes(self):
        return [{'node': 'node1'}]

    def list_qemu_vms(self, node):
        return [
            {'vmid': 101, 'name': 'WEB-set-1', 'status': 'running'},
            {'vmid': 102, 'name': 'DB-set-1', 'status': 'running'},
            {'vmid': 103, 'name': 'CACHE-set-1', 'status': 'running'},
        ]

    def list_pools(self):
        return [{'poolid': 'alice'}]

    def list_pool_members(self, poolid):
        return [
            {'id': 'qemu/101'},
            {'id': 'qemu/102'},
            {'id': 'qemu/103'},
        ]

    def list_acls(self):
        return []


class VmRefreshPoolMembershipApiTests(unittest.TestCase):

    def setUp(self):
        os.environ['AUTH_ENABLE'] = '0'
        self.tmp = tempfile.TemporaryDirectory()
        self.app = create_app()
        self.app.config['TESTING'] = True
        self.app.config['DATA_DIR'] = self.tmp.name
        self.client = self.app.test_client()
        self.project = Project(id='cs5390-bashbug', name='cs5390-Bashbug')
        self.project.instances = 1
        self.project.tag = '-set-'
        self.project.proxmox_url = 'https://proxmox.local'
        self.project.proxmox_api_token = 'token'
        self.project.credentials = [{'username': 'alice', 'password': 'password123'}]
        self.project.vms = [
            VMConfig(name='web', viewable_to_user=True),
            VMConfig(name='db', viewable_to_user=True),
            VMConfig(name='cache', viewable_to_user=True),
        ]

    def tearDown(self):
        try:
            self.tmp.cleanup()
        except Exception:
            pass
        try:
            os.environ.pop('AUTH_ENABLE', None)
        except Exception:
            pass

    def test_refresh_counts_pool_members_when_proxmox_names_have_different_case(self):
        store = _StoreStub(self.project)
        with patch('app.routes.api._store', return_value=store):
            with patch('app.routes.api.ProxmoxClient', _ClientStub):
                with patch('app.routes.api._prefetch_vm_configs_parallel', return_value={}):
                    resp = self.client.post(
                        f'/api/projects/{self.project.id}/instances/refresh/vm',
                        json={'baseUrl': 'https://proxmox.local'}
                    )

        self.assertEqual(resp.status_code, 200)
        payload = resp.get_json() or {}
        statuses = payload.get('instance_statuses') or []
        self.assertEqual(len(statuses), 1)
        managers = (statuses[0] or {}).get('managers') or {}
        self.assertEqual(managers.get('pools_member_total'), 3)
        self.assertEqual(managers.get('pools_member_count'), 3)
        self.assertEqual(managers.get('pools_member_state'), 'all')


if __name__ == '__main__':
    unittest.main()