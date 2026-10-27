"""Share overlapping authenticated reads without retaining stale results."""
from concurrent.futures import Future
from functools import wraps
import hashlib
import json
import threading

from flask import current_app, make_response, request, session


class ReadCoalescer:
    def __init__(self):
        self.lock = threading.Lock()
        self.pending = {}
        self.generation = 0

    def invalidate(self):
        with self.lock:
            self.generation += 1

    def run(self, key, operation):
        with self.lock:
            key = (self.generation, key)
            future = self.pending.get(key)
            leader = future is None
            if leader:
                future = self.pending[key] = Future()
        if not leader:
            return future.result()
        try:
            result = operation()
            future.set_result(result)
            return result
        except BaseException as exc:
            future.set_exception(exc)
            raise
        finally:
            with self.lock:
                self.pending.pop(key, None)


_init_lock = threading.Lock()


def _state():
    with _init_lock:
        state = current_app.extensions.get('read_coalescer')
        if state is None:
            state = current_app.extensions['read_coalescer'] = ReadCoalescer()
        return state


def invalidate_reads_for_write():
    """Separate reads on both sides of a mutation, including queued dispatch."""
    view = current_app.view_functions.get(request.endpoint)
    if request.method not in ('GET', 'HEAD', 'OPTIONS') and not getattr(view, 'coalesced_read', False):
        _state().invalidate()


def coalesce_read(view):
    """Apply inside authentication, only to non-streaming read endpoints."""
    @wraps(view)
    def wrapped(*args, **kwargs):
        # Hash credentials and session identity; never share across users or
        # connection settings, and never keep plaintext credentials as map keys.
        body = request.get_json(silent=True)
        identity = [request.method, request.full_path, dict(session),
                    request.headers.get('Authorization'), request.headers.get('X-API-Key'),
                    body if body is not None else request.get_data().hex()]
        key = hashlib.sha256(json.dumps(identity, sort_keys=True, default=str).encode()).digest()

        def execute():
            response = make_response(view(*args, **kwargs))
            return response.get_data(), response.status_code, list(response.headers)

        body, status, headers = _state().run(key, execute)
        # Each request gets its own response and after-request processing.
        return current_app.response_class(body, status=status, headers=headers)

    wrapped.coalesced_read = True
    return wrapped
