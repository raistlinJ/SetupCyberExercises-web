"""Host-side QEMU file upload over one guest-agent connection.

This module uses only the standard library so its source can run on Proxmox
over the existing SSH connection. It does not require guest networking.
"""
import base64
import json
import os
from pathlib import Path
import secrets
import shlex
import socket
import subprocess
import time


class StreamUnavailable(RuntimeError):
    """The file protocol is unavailable before any archive data is sent."""


class AgentConnection:
    def __init__(self, path, cancel_path, timeout=120, deadline=None):
        self.socket = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.socket.settimeout(1)
        self.buffer = b''
        self.sequence = 0
        self.cancel_path = cancel_path
        self.timeout = timeout
        self.deadline = deadline if deadline is not None else float('inf')
        try:
            self.socket.connect(path)
            # Discard stale protocol data from an earlier client. A unique
            # sync value and QGA's delimiter distinguish our response.
            nonce = secrets.randbits(52)
            self.socket.sendall(b'\xff')
            self.call('guest-sync-delimited', {'id': nonce}, sync=nonce)
            info = self.call('guest-info')
            enabled = {item['name'] for item in info.get('supported_commands', [])
                       if item.get('enabled') is True}
            required = {'guest-file-open', 'guest-file-write', 'guest-file-close'}
            if not required.issubset(enabled):
                raise StreamUnavailable('Guest-agent file commands are not enabled')
        except Exception as exc:
            self.socket.close()
            if isinstance(exc, RuntimeError) and str(exc) == 'Transfer cancelled':
                raise
            raise StreamUnavailable(f'Guest-agent file stream unavailable: {exc}') from exc

    def close(self):
        self.socket.close()

    def check_cancelled(self):
        if time.monotonic() >= self.deadline:
            raise TimeoutError('Guest-agent file transfer timed out')
        if os.path.exists(self.cancel_path):
            raise RuntimeError('Transfer cancelled')

    def call(self, command, arguments=None, sync=None):
        self.check_cancelled()
        self.sequence += 1
        request = {'execute': command, 'id': self.sequence}
        if arguments is not None:
            request['arguments'] = arguments
        # A full file-write frame is bounded to ~1.4 MiB. Give the write time
        # to drain on a busy host; reads check cancellation every second.
        self.socket.settimeout(min(self.timeout, max(.1, self.deadline - time.monotonic())))
        self.socket.sendall(json.dumps(request).encode('ascii') + b'\n')
        self.socket.settimeout(1)
        deadline = min(self.deadline, time.monotonic() + self.timeout)
        while True:
            self.check_cancelled()
            if time.monotonic() >= deadline:
                raise TimeoutError(f'{command} timed out')
            if b'\n' not in self.buffer:
                try:
                    data = self.socket.recv(65536)
                except socket.timeout:
                    continue
                if not data:
                    raise ConnectionError('Guest-agent stream disconnected')
                self.buffer += data
                if len(self.buffer) > 2 * 1024 * 1024:
                    raise RuntimeError('Guest-agent response exceeds the protocol limit')
                continue
            line, self.buffer = self.buffer.split(b'\n', 1)
            line = line.rsplit(b'\xff', 1)[-1]
            try:
                response = json.loads(line)
            except (ValueError, UnicodeDecodeError):
                if sync is not None:
                    continue
                raise RuntimeError('Invalid guest-agent response') from None
            if not isinstance(response, dict):
                if sync is not None:
                    continue
                raise RuntimeError('Invalid guest-agent response')
            if sync is not None:
                if response.get('return') == sync:
                    return sync
                continue
            if response.get('id') != self.sequence:
                continue
            if 'error' in response:
                error = response['error']
                raise RuntimeError(f"{command}: {error.get('desc') or error.get('class') or 'failed'}")
            if 'return' not in response:
                raise RuntimeError('Guest-agent response has no result')
            return response['return']


def stream_archive(config):
    """Write one archive through one QGA socket and one open guest file."""
    connection = AgentConnection(config['agent_socket'], config['cancel_path'], deadline=config.get('_deadline'))
    handle = None
    try:
        handle = connection.call('guest-file-open', {'path': config['guest_archive'], 'mode': 'wb'})
        loaded = 0
        with open(config['archive'], 'rb') as source:
            while True:
                chunk = source.read(1024 * 1024)
                if not chunk:
                    break
                offset = 0
                while offset < len(chunk):
                    result = connection.call('guest-file-write', {
                        'handle': handle,
                        'buf-b64': base64.b64encode(chunk[offset:]).decode('ascii'),
                    })
                    written = result.get('count')
                    if type(written) is not int or not 0 < written <= len(chunk) - offset:
                        raise RuntimeError('Guest-agent file write returned an invalid byte count')
                    offset += written
                    loaded += written
                    print('TRANSFER_BYTES=' + str(loaded), flush=True)
        if loaded != config['archive_size']:
            raise RuntimeError('Staged archive size changed during transfer')
        closing_handle, handle = handle, None
        connection.call('guest-file-close', {'handle': closing_handle})
    finally:
        if handle is not None:
            # Close even after cancellation; the host removes the temporary
            # archive only after releasing this connection.
            original = connection.cancel_path
            connection.cancel_path = ''
            connection.deadline = time.monotonic() + 5
            try:
                connection.call('guest-file-close', {'handle': handle})
            except Exception:
                pass
            finally:
                connection.cancel_path = original
        connection.close()


def transfer(config):
    """Copy, extract, and clean up on the Proxmox host."""
    import fcntl

    config = dict(config, _deadline=time.monotonic() + config['timeout'])

    def check_cancelled():
        if time.monotonic() >= config['_deadline']:
            raise TimeoutError('Guest-agent file transfer timed out')
        if os.path.exists(config['cancel_path']):
            raise RuntimeError('Transfer cancelled')

    def run(command, data=None, timeout=120):
        args = ['qm', 'guest', 'exec', str(config['vmid']), '--synchronous', '1', '--timeout', str(timeout)]
        if data is not None:
            args += ['--pass-stdin', '1']
        result = subprocess.run(args + ['--', '/bin/sh', '-c', command], input=data,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout + 30)
        if result.returncode:
            raise RuntimeError(result.stderr.decode(errors='replace') or 'qm guest exec failed')
        state = json.loads(result.stdout)
        if not state.get('exited') or state.get('exitcode') != 0:
            raise RuntimeError(state.get('err-data') or state.get('out-data') or 'Guest command failed or timed out')

    # Serialize our own transfers to the same VM, including different queue
    # workers, without holding the batch staging lock or blocking other VMs.
    flags = os.O_CREAT | os.O_RDWR | getattr(os, 'O_NOFOLLOW', 0)
    lock = os.open(config['lock_path'], flags, 0o600)
    try:
        deadline = config['_deadline']
        while True:
            check_cancelled()
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    raise TimeoutError('Another upload to this VM is still running')
                time.sleep(.1)
        try:
            try:
                stream_archive(config)
            except StreamUnavailable:
                # Only protocol preflight failures select the old transport.
                # Never retry a failed/partial write as an apparent success.
                check_cancelled()
                print('TRANSFER_FALLBACK', flush=True)
                run('rm -f -- ' + shlex.quote(config['guest_archive']))
                with open(config['archive'], 'rb') as source:
                    while True:
                        check_cancelled()
                        chunk = source.read(512 * 1024)
                        if not chunk:
                            break
                        run('cat >> ' + shlex.quote(config['guest_archive']), chunk)
                        print('TRANSFER_BYTES=' + str(source.tell()), flush=True)
            check_cancelled()
            print('TRANSFER_EXTRACTING', flush=True)
            run(config['extract'], timeout=max(1, int(config['_deadline'] - time.monotonic())))
        finally:
            # Close the streaming socket before asking qm to use the agent.
            try:
                run('rm -f -- ' + shlex.quote(config['guest_archive']))
            except Exception:
                pass
    finally:
        os.close(lock)
        if os.path.exists(config['cancel_path']):
            os.unlink(config['cancel_path'])


def build_host_script(config):
    """Send the tested standard-library implementation, not a shell pipeline."""
    return Path(__file__).read_text(encoding='utf-8') + '\ntransfer(' + repr(config) + ')\n'
