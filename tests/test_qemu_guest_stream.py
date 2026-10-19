"""Exercise the host program against an actual framed QGA socket."""
import base64
from contextlib import contextmanager
import json
from pathlib import Path
import socket
import shlex
import subprocess
import tempfile
import threading
from unittest.mock import patch

import pytest

from app.qemu_guest_stream import build_host_script, transfer


@contextmanager
def guest_agent(config, *, write_mode='normal', disabled=False, close_error=False):
    with tempfile.TemporaryDirectory(prefix='sce-qga-', dir='/tmp') as temp:
        path = str(Path(temp) / 'agent.sock')
        server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        server.bind(path)
        server.listen(1)
        state = {'requests': [], 'connections': 0, 'error': None, 'closed': False}

        def serve():
            handle = None
            try:
                connection, _ = server.accept()
                state['connections'] += 1
                with connection:
                    source = connection.makefile('rb')
                    for line in source:
                        request = json.loads(line.lstrip(b'\xff'))
                        command = request['execute']
                        args = request.get('arguments', {})
                        state['requests'].append(command)
                        result, error = {}, None
                        if command == 'guest-sync-delimited':
                            connection.sendall(b'stale-invalid-data\n\xff')
                            result = args['id']
                        elif command == 'guest-info':
                            result = {'supported_commands': [
                                {'name': name, 'enabled': not disabled}
                                for name in ['guest-file-open', 'guest-file-write', 'guest-file-close']]}
                        elif command == 'guest-file-open':
                            assert args == {'path': config['guest_archive'], 'mode': 'wb'}
                            handle = open(args['path'], 'wb')
                            result = 42
                        elif command == 'guest-file-write':
                            assert args['handle'] == 42
                            data = base64.b64decode(args['buf-b64'], validate=True)
                            if write_mode == 'partial':
                                data = data[:65536]
                            count = handle.write(data)
                            handle.flush()
                            if write_mode == 'disconnect':
                                return
                            if write_mode == 'stall':
                                continue
                            if write_mode == 'zero':
                                count = 0
                            elif write_mode == 'oversize':
                                count = len(data) + 1
                            elif write_mode == 'error':
                                error = {'class': 'GenericError', 'desc': 'No space left on device'}
                            result = {'count': count, 'eof': False}
                        elif command == 'guest-file-close':
                            handle.close()
                            handle = None
                            state['closed'] = True
                            if close_error:
                                error = {'class': 'GenericError', 'desc': 'flush failed'}
                        else:
                            raise AssertionError(command)
                        response = {'id': request['id'], 'error': error} if error else {'id': request['id'], 'return': result}
                        # Deliberately fragment protocol responses over the stream.
                        encoded = json.dumps(response).encode() + b'\n'
                        connection.sendall(encoded[:5])
                        connection.sendall(encoded[5:])
            except (BrokenPipeError, ConnectionResetError):
                pass
            except BaseException as exc:
                state['error'] = exc
            finally:
                if handle is not None:
                    handle.close()
                server.close()

        thread = threading.Thread(target=serve, daemon=True)
        thread.start()
        try:
            yield path, state
        finally:
            thread.join(5)
            assert not thread.is_alive(), 'Host failed to close the guest-agent socket'
            if state['error']:
                raise state['error']


def configuration(tmp_path, content):
    archive = tmp_path / "archive 'quoted'.tar"
    archive.write_bytes(content)
    return {'vmid': 101, 'archive': str(archive), 'archive_size': len(content),
            'guest_archive': str(tmp_path / 'guest.tar'),
            'cancel_path': str(tmp_path / 'cancel'), 'lock_path': str(tmp_path / 'guest.lock'),
            'extract': 'extract-the-verified-archive', 'timeout': 5}


@pytest.mark.parametrize('write_mode', ['normal', 'partial'])
@pytest.mark.parametrize('size', [0, 1024, 3 * 1024 * 1024 + 71])
def test_exported_host_program_keeps_one_connection_and_file_handle(tmp_path, write_mode, size):
    content = (bytes(range(256)) * (size // 256 + 1))[:size]
    config = configuration(tmp_path, content)
    commands, progress = [], []

    def qm(args, input=None, **kwargs):
        assert input is None, 'Streaming must not launch qm for archive chunks'
        command = args[-1]
        commands.append(command)
        if command == config['extract']:
            assert Path(config['guest_archive']).read_bytes() == content
        else:
            assert command.startswith('rm -f -- ')
            Path(config['guest_archive']).unlink(missing_ok=True)
        return subprocess.CompletedProcess(args, 0, b'{"exited":true,"exitcode":0}', b'')

    with guest_agent(config, write_mode=write_mode) as (path, state), \
            patch('subprocess.run', side_effect=qm), patch('builtins.print', side_effect=lambda value, **kw: progress.append(value)):
        # Execute exactly the source sent over SSH, not an alternate test implementation.
        exec(compile(build_host_script({**config, 'agent_socket': path}), '<host program>', 'exec'), {})
    assert state['connections'] == 1
    assert state['requests'].count('guest-file-open') == 1
    assert state['requests'].count('guest-file-close') == 1
    assert commands == [config['extract'], 'rm -f -- ' + shlex.quote(config['guest_archive'])]
    counts = [int(line.split('=')[1]) for line in progress if line.startswith('TRANSFER_BYTES=')]
    assert counts == sorted(counts)
    if size:
        assert counts[-1] == size
    assert 'TRANSFER_FALLBACK' not in progress
    assert not Path(config['guest_archive']).exists()
    assert Path(config['archive']).exists(), 'Shared host archive must survive until batch cleanup'


@pytest.mark.parametrize('write_mode,close_error', [
    ('zero', False), ('oversize', False), ('error', False), ('disconnect', False), ('normal', True)])
def test_write_or_close_failure_never_extracts_or_retries_partial_data(tmp_path, write_mode, close_error):
    config = configuration(tmp_path, b'payload' * 100)
    commands = []

    def qm(args, input=None, **kwargs):
        assert input is None
        commands.append(args[-1])
        Path(config['guest_archive']).unlink(missing_ok=True)
        return subprocess.CompletedProcess(args, 0, b'{"exited":true,"exitcode":0}', b'')

    with guest_agent(config, write_mode=write_mode, close_error=close_error) as (path, state), \
            patch('subprocess.run', side_effect=qm), pytest.raises((RuntimeError, ConnectionError, OSError)):
        transfer({**config, 'agent_socket': path})
    assert len(commands) == 1 and commands[0].startswith('rm -f -- ')
    assert not Path(config['guest_archive']).exists()


def test_cancel_closes_file_and_socket_before_guest_cleanup(tmp_path):
    config = configuration(tmp_path, b'a' * (3 * 1024 * 1024))
    events = []

    def progress(value, **kwargs):
        if value.startswith('TRANSFER_BYTES='):
            Path(config['cancel_path']).touch()

    with guest_agent(config) as (path, state):
        def qm(args, input=None, **kwargs):
            assert state['closed'], 'Close the file before using qm for cleanup'
            assert args[-1].startswith('rm -f -- ')
            events.append('cleanup')
            Path(config['guest_archive']).unlink(missing_ok=True)
            return subprocess.CompletedProcess(args, 0, b'{"exited":true,"exitcode":0}', b'')
        with patch('subprocess.run', side_effect=qm), patch('builtins.print', side_effect=progress), \
                pytest.raises(RuntimeError, match='Transfer cancelled'):
            transfer({**config, 'agent_socket': path})
    assert state['requests'].count('guest-file-write') == 1
    assert events == ['cleanup']
    assert not Path(config['cancel_path']).exists()


def test_disabled_commands_select_fallback_before_opening_file(tmp_path):
    content = bytes(range(256)) * 5000
    config = configuration(tmp_path, content)
    chunks, commands, progress = [], [], []

    def qm(args, input=None, **kwargs):
        commands.append(args[-1])
        if input is not None:
            chunks.append(input)
        return subprocess.CompletedProcess(args, 0, b'{"exited":true,"exitcode":0}', b'')

    with guest_agent(config, disabled=True) as (path, state), \
            patch('subprocess.run', side_effect=qm), patch('builtins.print', side_effect=lambda value, **kw: progress.append(value)):
        transfer({**config, 'agent_socket': path})
    assert 'guest-file-open' not in state['requests']
    assert 'TRANSFER_FALLBACK' in progress
    assert b''.join(chunks) == content
    assert commands[-2:] == [config['extract'], 'rm -f -- ' + shlex.quote(config['guest_archive'])]


def test_stalled_write_obeys_total_timeout_and_cleans_up(tmp_path):
    config = configuration(tmp_path, b'payload' * 100)
    config['timeout'] = .1
    commands = []

    def qm(args, input=None, **kwargs):
        commands.append(args[-1])
        Path(config['guest_archive']).unlink(missing_ok=True)
        return subprocess.CompletedProcess(args, 0, b'{"exited":true,"exitcode":0}', b'')

    with guest_agent(config, write_mode='stall') as (path, state), \
            patch('subprocess.run', side_effect=qm), pytest.raises(TimeoutError):
        transfer({**config, 'agent_socket': path})
    assert state['closed']
    assert len(commands) == 1 and commands[0].startswith('rm -f -- ')


def test_same_vm_transfers_are_serialized_even_from_separate_jobs(tmp_path):
    first = configuration(tmp_path, b'payload')
    second = dict(first, guest_archive=str(tmp_path / 'second.tar'), cancel_path=str(tmp_path / 'cancel-second'))
    entered, release, second_started = threading.Event(), threading.Event(), threading.Event()
    calls, errors = [], []

    def stream(config):
        calls.append(config['guest_archive'])
        if config['guest_archive'] == first['guest_archive']:
            entered.set()
            assert release.wait(3)
        else:
            second_started.set()

    def qm(args, **kwargs):
        return subprocess.CompletedProcess(args, 0, b'{"exited":true,"exitcode":0}', b'')

    def execute(config):
        try:
            transfer(config)
        except BaseException as exc:
            errors.append(exc)

    with patch('app.qemu_guest_stream.stream_archive', side_effect=stream), patch('subprocess.run', side_effect=qm):
        threads = [threading.Thread(target=execute, args=(config,)) for config in [first, second]]
        threads[0].start()
        try:
            assert entered.wait(2)
            threads[1].start()
            assert not second_started.wait(.2), 'Second job must wait until the VM channel is released'
        finally:
            release.set()
            for thread in threads:
                if thread.ident is not None:
                    thread.join(4)
    assert not errors
    assert all(not thread.is_alive() for thread in threads)
    assert calls == [first['guest_archive'], second['guest_archive']]
