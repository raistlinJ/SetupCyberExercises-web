"""Download large Proxmox backups as a bounded SSH byte stream."""

import os
import shlex
import socket
import time


CHUNK_SIZE = 1024 * 1024
WINDOW_SIZE = 16 * CHUNK_SIZE


def download_backup(ssh, remote_path, local_path, size, *, callback=None, cancelled=None):
    """Reuse authenticated SSH without SFTP's per-block read requests.

    Publish the file only after checking the remote exit status and byte count.
    A stalled connection still checks cancellation once a second.
    """
    partial = f'{local_path}.part'
    channel = None
    received = 0
    errors = bytearray()
    last_data = time.monotonic()

    def check():
        if cancelled and cancelled():
            raise InterruptedError('Archive operation cancelled')
        if time.monotonic() - last_data >= 120:
            raise TimeoutError('Backup download stalled for 120 seconds')

    def drain_errors():
        while channel.recv_stderr_ready():
            data = channel.recv_stderr(32768)
            if not data:
                break
            errors.extend(data[:max(0, 8192 - len(errors))])

    try:
        check()
        channel = ssh.get_transport().open_session(window_size=WINDOW_SIZE)
        channel.settimeout(1)
        channel.exec_command(f'cat -- {shlex.quote(remote_path)}')
        with open(partial, 'wb', buffering=CHUNK_SIZE) as target:
            while True:
                check()
                drain_errors()
                try:
                    chunk = channel.recv(CHUNK_SIZE)
                except socket.timeout:
                    continue
                if not chunk:
                    if channel.exit_status_ready():
                        break
                    time.sleep(0.01)
                    continue
                received += len(chunk)
                if received > size:
                    raise IOError(f'Backup size changed: expected {size} bytes, received at least {received}')
                target.write(chunk)
                last_data = time.monotonic()
                if callback:
                    callback(received, size)
            drain_errors()
            status = channel.recv_exit_status()
            if status != 0:
                detail = errors.decode('utf-8', errors='replace').strip()
                raise IOError(f'Backup download failed (exit {status}): {detail}')
            if received != size:
                raise IOError(f'Incomplete backup download: expected {size} bytes, received {received}')
        check()
        os.replace(partial, local_path)
    finally:
        if channel is not None:
            channel.close()
        if os.path.exists(partial):
            os.remove(partial)
    return received
