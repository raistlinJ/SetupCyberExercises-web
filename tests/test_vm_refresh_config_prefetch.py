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


if __name__ == '__main__':
    unittest.main()