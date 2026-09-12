"""Paramiko progress lines can be text while archive reads remain binary."""
import io
from unittest.mock import MagicMock, patch

import pytest

from app.routes import api


@pytest.mark.parametrize('text_lines', [False, True])
def test_staged_push_accepts_text_and_binary_progress_and_stops_at_eof(text_lines):
    lines = [b'TRANSFER_BYTES=512\n', b'TRANSFER_EXTRACTING\n', b'']
    if text_lines:
        lines = [line.decode('utf-8') for line in lines]
    stdout = MagicMock()
    # A read past EOF raises instead of allowing the old byte-sentinel loop to hang.
    stdout.readline.side_effect = lines
    stdout.channel.recv_exit_status.return_value = 0
    with patch.object(api, '_ssh_run_cmd', return_value=(stdout, io.BytesIO())), \
            patch.object(api, '_transfer_bytes') as progress:
        api._push_staged_tar_to_qemu(
            None, {'vmid': 101}, '/tmp/archive.tar', 512, '/home/agentic', False, '')
    assert stdout.readline.call_count == 3
    progress.assert_any_call('Copying to guest', 512, 512)
    progress.assert_any_call('Extracting in guest', 0)
