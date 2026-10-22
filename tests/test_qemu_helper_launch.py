import shlex
import threading
from unittest.mock import MagicMock, patch

import pytest

from app.guest_push_batch import GuestPushBatch
from app.routes import api


@pytest.mark.parametrize('exitcode', [0, 1, -1])
def test_helper_is_private_staged_file_cleaned_after_each_result(exitcode):
    ssh = MagicMock()
    sftp = ssh.open_sftp.return_value
    helper = sftp.open.return_value.__enter__.return_value
    with patch.object(api, '_ssh_exec_result', return_value=(exitcode, b'', '')) as execute:
        if exitcode:
            with pytest.raises(RuntimeError, match='completion is unknown' if exitcode == -1 else 'exited with 1'):
                api._push_staged_tar_to_qemu(ssh, {'vmid': 101}, '/tmp/archive.tar', 512, '/files', False, '')
        else:
            api._push_staged_tar_to_qemu(ssh, {'vmid': 101}, '/tmp/archive.tar', 512, '/files', False, '')
    path, mode = sftp.open.call_args.args
    assert mode == 'wx'
    assert shlex.split(execute.call_args.args[1]) == ['python3', path]
    sftp.chmod.assert_called_once_with(path, 0o600)
    assert b'transfer(' in helper.write.call_args.args[0]
    sftp.remove.assert_called_once_with(path)
    sftp.close.assert_called_once()


def test_helper_cleanup_on_transport_exception():
    ssh = MagicMock()
    with patch.object(api, '_ssh_exec_result', side_effect=EOFError):
        with pytest.raises(EOFError):
            api._push_staged_tar_to_qemu(ssh, {'vmid': 101}, '/tmp/archive.tar', 512, '/files', False, '')
    ssh.open_sftp.return_value.remove.assert_called_once()
    ssh.open_sftp.return_value.close.assert_called_once()


def test_pool_discards_clients_that_die_before_or_during_use():
    old, first, replacement = MagicMock(), MagicMock(), MagicMock()
    old.get_transport.return_value.is_active.return_value = False
    first.get_transport.return_value.is_active.return_value = True
    replacement.get_transport.return_value.is_active.return_value = True
    state = {'lock': threading.Lock(), 'ssh': old}
    connect = MagicMock(side_effect=[first, replacement])
    batch = GuestPushBatch()
    with batch.command_client(state, connect) as client:
        assert client is first
        first.get_transport.return_value.is_active.return_value = False
    with batch.command_client(state, connect) as client:
        assert client is replacement
    with batch.command_client(state, connect) as client:
        assert client is replacement
    assert connect.call_count == 2
    assert state['available'] == [replacement]
    old.close.assert_called_once()
    first.close.assert_called_once()
