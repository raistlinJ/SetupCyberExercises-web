"""Batch-scoped Proxmox archives; never share uploads across queue jobs."""
import threading
from contextlib import contextmanager


class GuestPushBatch:
    def __init__(self):
        self.lock = threading.Lock()
        self.hosts = {}

    @contextmanager
    def host(self, key):
        with self.lock:
            state = self.hosts.setdefault(key, {'lock': threading.Lock()})
        # Serialize staging only. Guest commands lease independent SSH clients
        # after the shared archive is ready.
        with state['lock']:
            yield state

    @contextmanager
    def command_client(self, state, connect):
        client = None
        while True:
            with state['lock']:
                available = state.setdefault('available', [state['ssh']])
                client = available.pop() if available else None
            if client is None or self._active(client):
                break
            client.close()
        if client is None:
            client = connect()
            with state['lock']:
                state.setdefault('extra_clients', []).append(client)
        try:
            yield client
        finally:
            if self._active(client):
                with state['lock']:
                    state['available'].append(client)
            else:
                client.close()

    @staticmethod
    def _active(client):
        get_transport = getattr(client, 'get_transport', None)
        if get_transport is None:
            return True
        transport = get_transport()
        return transport is not None and transport.is_active()

    def close(self):
        for state in self.hosts.values():
            for client in state.get('extra_clients', []):
                try:
                    client.close()
                except Exception:
                    pass
            sftp = state.get('sftp')
            if sftp is not None:
                try:
                    sftp.remove(state['archive'])
                except Exception:
                    pass
                try:
                    sftp.close()
                except Exception:
                    pass
            if state.get('ssh') is not None:
                try:
                    state['ssh'].close()
                except Exception:
                    pass
