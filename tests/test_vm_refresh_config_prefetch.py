import unittest

from app.routes import api


class VmRefreshConfigPrefetchTests(unittest.TestCase):

    def test_prefetch_deduplicates_and_returns_configs(self):
        seen = []

        class DummyClient:
            def get_qemu_config(self, node, vmid):
                seen.append((node, vmid))
                return {'node': node, 'vmid': vmid, 'pool': 'demo'}

        refs = [('node-a', 101), ('node-a', 101), ('node-b', 202)]
        result = api._prefetch_vm_configs_parallel(
            None,
            refs,
            force_refresh=True,
            client_factory=DummyClient,
        )

        self.assertEqual(set(seen), {('node-a', 101), ('node-b', 202)})
        self.assertEqual(result[('node-a', 101)]['vmid'], 101)
        self.assertEqual(result[('node-b', 202)]['pool'], 'demo')

    def test_pool_member_prefetch_deduplicates_and_extracts_qemu_vmids(self):
        seen = []

        class DummyClient:
            def list_pool_members(self, poolid):
                seen.append(poolid)
                return [
                    {'type': 'qemu', 'vmid': 101},
                    {'type': 'storage', 'vmid': 999},
                    {'type': 'qemu', 'vmid': 202},
                    {'type': 'qemu', 'id': 'qemu/303'},
                    {'id': '/vm/404'},
                ]

        result = api._prefetch_pool_members_parallel(
            None,
            ['alpha', 'alpha', 'beta'],
            force_refresh=True,
            client_factory=DummyClient,
        )

        self.assertEqual(set(seen), {'alpha', 'beta'})
        self.assertEqual(result['alpha'], {101, 202, 303, 404})
        self.assertEqual(result['beta'], {101, 202, 303, 404})


if __name__ == '__main__':
    unittest.main()