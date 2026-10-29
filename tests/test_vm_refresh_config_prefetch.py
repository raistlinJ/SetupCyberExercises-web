import unittest
import threading
from types import SimpleNamespace

from app.routes import api


class VmRefreshConfigPrefetchTests(unittest.TestCase):

    def test_prefetch_reuses_thread_confined_clients_and_closes_after_failures(self):
        for kind in ('config', 'pool'):
            with self.subTest(kind=kind):
                clients = []
                barrier = threading.Barrier(2)
                updates = []

                def report(*fields):
                    updates.append(fields)

                class DummyClient:
                    def __init__(self):
                        self.owner = threading.get_ident()
                        self.calls = 0
                        self.closed = False
                        clients.append(self)

                    def read(self, key):
                        if self.owner != threading.get_ident() or self.closed:
                            raise AssertionError('HTTP sessions must stay within their worker')
                        self.calls += 1
                        if self.calls == 1:
                            barrier.wait(timeout=3)
                        if key == 105 or key == 'pool-105':
                            raise RuntimeError('one read failed')

                    def get_qemu_config(self, node, vmid):
                        self.read(vmid)
                        return {'vmid': vmid}

                    def list_pool_members(self, poolid):
                        self.read(poolid)
                        return [{'vmid': 101}]

                    def close(self):
                        self.closed = True

                project = SimpleNamespace(proxmox_max_create_jobs=2)
                if kind == 'config':
                    results = api._prefetch_vm_configs_parallel(
                        project, [('node', vmid) for vmid in range(101, 113)],
                        force_refresh=True, client_factory=DummyClient,
                        on_progress=report,
                    )
                    self.assertEqual(len(results), 11)
                    self.assertNotIn(('node', 105), results)
                else:
                    results = api._prefetch_pool_members_parallel(
                        project, [f'pool-{vmid}' for vmid in range(101, 113)],
                        force_refresh=True, client_factory=DummyClient,
                        on_progress=report,
                    )
                    self.assertEqual(results['pool-105'], set())
                    self.assertEqual(sum(bool(members) for members in results.values()), 11)
                self.assertEqual(len(clients), 2)
                self.assertEqual(sum(client.calls for client in clients), 12)
                self.assertTrue(all(client.closed for client in clients))
                self.assertEqual([fields[0] for fields in updates], list(range(13)))
                self.assertTrue(all(fields[1] == 12 for fields in updates))
                self.assertEqual(updates[-1][3], 1)

    def test_empty_batches_report_zero_without_creating_connections(self):
        for prefetch in (api._prefetch_vm_configs_parallel, api._prefetch_pool_members_parallel):
            with self.subTest(prefetch=prefetch.__name__):
                updates = []
                def unexpected_client():
                    self.fail('Empty batches must not connect to Proxmox')
                self.assertEqual(prefetch(None, [], force_refresh=True, client_factory=unexpected_client,
                                          on_progress=lambda *fields: updates.append(fields)), {})
                self.assertEqual(updates, [(0, 0, '', 0)])

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
