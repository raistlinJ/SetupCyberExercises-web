import json
import shlex
import subprocess
from unittest.mock import patch

import pytest

from app.routes.api import _push_staged_tar_to_qemu


@pytest.mark.parametrize('failure', [None, 'exit', 'timeout', 'host'])
def test_host_script_streams_binary_chunks_and_checks_guest_results(tmp_path, failure):
    content = bytes(range(256)) * 5000
    archive = tmp_path / "model 'quoted'.tar"
    archive.write_bytes(content)
    calls = []

    def qm(args, input=None, **kwargs):
        assert args[:4] == ['qm', 'guest', 'exec', '101']
        calls.append((args[-1], input))
        if input is not None:
            assert 0 < len(input) <= 512 * 1024
            assert '--pass-stdin' in args
            if failure == 'host':
                return subprocess.CompletedProcess(args, 1, b'', b'qm failed')
            if failure == 'exit':
                return subprocess.CompletedProcess(args, 0, json.dumps({'exited': 1, 'exitcode': 2, 'err-data': 'write failed'}).encode(), b'')
            if failure == 'timeout':
                return subprocess.CompletedProcess(args, 0, b'{"pid": 42}', b'')
        return subprocess.CompletedProcess(args, 0, b'{"exited": 1, "exitcode": 0}', b'')

    def ssh(client, command, **kwargs):
        args = shlex.split(command)
        assert args[:2] == ['python3', '-c']
        with patch('subprocess.run', side_effect=qm):
            exec(compile(args[2], '<host script>', 'exec'), {})
        return 0, '', ''

    with patch('app.routes.api._ssh_exec_result', side_effect=ssh):
        if failure:
            with pytest.raises(RuntimeError):
                _push_staged_tar_to_qemu(None, {'vmid': 101}, str(archive), len(content), '/models', True, 'secret')
        else:
            _push_staged_tar_to_qemu(None, {'vmid': 101}, str(archive), len(content), '/models', True, 'secret')
            assert b''.join(data for _, data in calls if data is not None) == content
            assert any('tar --overwrite' in command for command, _ in calls)
    assert calls[-1][0].startswith('rm -f -- '), 'Always clean the guest temporary archive'
    assert archive.exists(), 'Keep shared host archive for the other guests'
