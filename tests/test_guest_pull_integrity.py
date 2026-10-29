import base64
import io
import tarfile
import zipfile
from unittest.mock import MagicMock, patch

import pytest
import requests

from app.routes import api
from app.connectors.proxmox import GuestAgentFileReadError


@pytest.fixture
def guest_pull():
    client = MagicMock()
    commands = []
    expected_size = [None]

    def execute(client, entry, command, **kwargs):
        commands.append(command[-1])
        if 'for part in' in command[-1]:
            return {'stdout': '/tmp/archive.b64.part.aa\n/tmp/archive.b64.part.ab\n'}
        return {'stdout': str(expected_size[0]) if expected_size[0] is not None else ''}

    with patch.object(api, '_ensure_linux_qemu_guest'), \
            patch.object(api, '_guest_agent_exec_checked', side_effect=execute):
        yield client, expected_size, commands


def response(data, **fields):
    return {'content': base64.b64encode(data).decode('ascii'), 'bytes-read': len(data), **fields}


def pull(client):
    return api._pull_tar_through_guest_agent(client, {'vmid': 101, 'node': 'n'}, ['/example.bin'])


@pytest.mark.parametrize('truncated', [True, False, None])
def test_short_reads_preserve_full_file_even_without_truncated_flag(guest_pull, truncated):
    client, size, commands = guest_pull
    data = bytes(range(256)) * 80
    archive = io.BytesIO()
    with tarfile.open(fileobj=archive, mode='w') as tar:
        member = tarfile.TarInfo('example.bin')
        member.size = len(data)
        tar.addfile(member, io.BytesIO(data))
    raw = archive.getvalue()
    size[0] = len(raw)
    fields = {'truncated': truncated} if truncated is not None else {}
    client.agent_file_read.side_effect = [
        response(raw[:8192], **fields), response(raw[8192:16384], **fields),
        response(raw[16384:], **fields),
    ]

    with pull(client) as stream, io.BytesIO() as output:
        with zipfile.ZipFile(output, 'w') as archive:
            assert api._copy_lxc_tar_into_zip(stream, archive, 'guest') == 1
        with zipfile.ZipFile(output) as archive:
            assert archive.read('guest/example.bin') == data

    assert [call.kwargs['offset'] for call in client.agent_file_read.call_args_list] == [0, 8192, 16384]
    assert [call.kwargs['count'] for call in client.agent_file_read.call_args_list] == [
        len(raw), len(raw) - 8192, len(raw) - 16384,
    ]
    assert commands[-1].startswith('rm -f -- /tmp/deployforge-qemu-pull-')


@pytest.mark.parametrize('file_size', [1024 * 1024 + 19, 5 * 1024 * 1024 + 42])
def test_proxmox_concatenated_base64_blocks_preserve_full_archive(guest_pull, file_size):
    client, size, _ = guest_pull
    data = (bytes(range(256)) * (file_size // 256 + 1))[:file_size]
    archive = io.BytesIO()
    with tarfile.open(fileobj=archive, mode='w') as tar:
        member = tarfile.TarInfo('example.bin')
        member.size = len(data)
        tar.addfile(member, io.BytesIO(data))
    raw = archive.getvalue()
    size[0] = len(raw)

    def file_read(**kwargs):
        offset, count = kwargs['offset'], kwargs['count']
        chunk = raw[offset:offset + count]
        # Proxmox appends each guest-agent read's base64 string directly,
        # including padding at internal guest-agent read boundaries. Simulate
        # short internal reads so a 1 MiB response still has multiple blocks.
        block_size = 64 * 1024
        content = ''.join(base64.b64encode(chunk[start:start + block_size]).decode('ascii')
                          for start in range(0, len(chunk), block_size))
        return {'content': content, 'bytes-read': len(chunk), 'truncated': offset + len(chunk) < len(raw)}

    client.agent_file_read.side_effect = file_read
    with pull(client) as stream, io.BytesIO() as output:
        with zipfile.ZipFile(output, 'w') as archive:
            assert api._copy_lxc_tar_into_zip(stream, archive, 'guest') == 1
        with zipfile.ZipFile(output) as archive:
            assert archive.read('guest/example.bin') == data
    assert client.agent_file_read.call_count == (len(raw) + 1024 * 1024 - 1) // (1024 * 1024)


@pytest.mark.parametrize('blocks', [
    [], [b'a'], [b'ab'], [b'abc'], [b'a', b'ab', b'abc', b'd'],
    [b'abc', b'def', b'gh'], [bytes(range(256)), b'\x00\xff'],
])
def test_base64_decoder_accepts_independently_padded_blocks_and_line_breaks(blocks):
    content = '\n'.join(base64.b64encode(block).decode('ascii') for block in blocks)
    assert api._decode_guest_agent_file_chunks(content) == b''.join(blocks)


@pytest.mark.parametrize('content', ['YQ==!', 'YQ==YW!j', 'YQ===', '=YQ==', 'YQ==Yg', 'YW=Jj'])
def test_base64_decoder_rejects_malformed_blocks_including_after_valid_padding(content):
    with pytest.raises(ValueError):
        api._decode_guest_agent_file_chunks(content)


def test_unknown_size_continues_after_short_truncated_read(guest_pull):
    client, _, _ = guest_pull
    client.agent_file_read.side_effect = [response(b'abc', truncated=True), response(b'def')]
    with pull(client) as stream:
        assert stream.read() == b'abcdef'
    assert client.agent_file_read.call_args_list[1].kwargs['offset'] == 3


@pytest.mark.parametrize('legacy', [False, True])
def test_incomplete_download_reports_expected_and_received_bytes_and_cleans_up(guest_pull, legacy):
    client, size, commands = guest_pull
    size[0] = 12
    client.agent_file_read.side_effect = [
        RuntimeError('Proxmox guest agent file-read error 400: Parameter verification failed')
        if legacy else response(b'abc'),
        response(b'abc') if legacy else response(b''),
        response(b'def'),
    ]
    received = 6 if legacy else 3
    stream = io.BytesIO()
    with patch.object(api.tempfile, 'SpooledTemporaryFile', return_value=stream):
        with pytest.raises(RuntimeError, match=f'received {received} of 12 expected bytes'):
            pull(client)
    assert stream.closed
    assert commands[-1].startswith('rm -f -- /tmp/deployforge-qemu-pull-')


@pytest.mark.parametrize('result', [
    response(b'abc', **{'bytes-read': 4}),
    response(b'abc', **{'bytes-read': 0}),
    response(b'abcdefg'),
])
def test_inconsistent_chunk_byte_counts_are_rejected(guest_pull, result):
    client, size, _ = guest_pull
    size[0] = 6
    client.agent_file_read.return_value = result
    with pytest.raises(RuntimeError, match='inconsistent byte count'):
        pull(client)


def test_invalid_base64_is_rejected(guest_pull):
    client, size, _ = guest_pull
    size[0] = 3
    client.agent_file_read.return_value = {'content': 'YW!Jj', 'bytes-read': 3}
    with pytest.raises(ValueError, match='Only base64 data is allowed'):
        pull(client)


def test_legacy_chunks_are_combined_and_size_verified(guest_pull):
    client, size, _ = guest_pull
    size[0] = 6
    client.agent_file_read.side_effect = [
        RuntimeError('Proxmox guest agent file-read error 400: Parameter verification failed'),
        response(b'abc'), response(b'def'),
    ]
    with pull(client) as stream:
        assert stream.read() == b'abcdef'
    assert all(call.kwargs['legacy'] for call in client.agent_file_read.call_args_list[1:])


def test_legacy_truncated_chunk_is_rejected(guest_pull):
    client, _, _ = guest_pull
    client.agent_file_read.side_effect = [
        RuntimeError('Proxmox guest agent file-read error 400: Parameter verification failed'),
        response(b'abc', truncated=True),
    ]
    with pytest.raises(RuntimeError, match='truncated archive chunk in compatible mode'):
        pull(client)


def test_transport_timeout_is_preserved_and_temporary_archive_removed(guest_pull):
    client, size, commands = guest_pull
    size[0] = 6
    client.agent_file_read.side_effect = TimeoutError('file-read timed out')
    with pytest.raises(TimeoutError, match='file-read timed out'):
        pull(client)
    assert commands[-1].startswith('rm -f -- /tmp/deployforge-qemu-pull-')


@pytest.mark.parametrize('failure', [
    GuestAgentFileReadError(596, 'Connection timed out'),
    GuestAgentFileReadError(597, 'Connection reset by peer'),
    requests.Timeout('read timed out'),
    requests.ConnectionError('connection reset'),
    requests.exceptions.ChunkedEncodingError('incomplete response'),
])
def test_transient_read_failure_resumes_at_same_offset_without_duplicate_bytes(guest_pull, failure):
    client, size, _ = guest_pull
    size[0] = 9
    client.agent_file_read.side_effect = [response(b'abc'), failure, response(b'def'), response(b'ghi')]
    with patch.object(api, '_wait_for_guest_read_retry') as wait, patch.object(api, '_transfer_bytes') as progress:
        with pull(client) as stream:
            assert stream.read() == b'abcdefghi'
    assert [call.kwargs['offset'] for call in client.agent_file_read.call_args_list] == [0, 3, 3, 6]
    wait.assert_called_once_with(1)
    progress.assert_any_call('Retrying download (2/4)', 3, 9)


def test_transient_errors_shrink_subsequent_reads_and_exhaust_finite_retry_budget(guest_pull):
    client, size, commands = guest_pull
    size[0] = 4 * 1024 * 1024
    client.agent_file_read.side_effect = GuestAgentFileReadError(597, 'read timeout')
    with patch.object(api, '_wait_for_guest_read_retry') as wait:
        with pytest.raises(RuntimeError, match=r'failed after 4 attempts at byte 0 .*error 597: read timeout'):
            pull(client)
    assert [call.kwargs['count'] for call in client.agent_file_read.call_args_list] == [
        1024 * 1024, 512 * 1024, 256 * 1024, 256 * 1024,
    ]
    assert [call.args[0] for call in wait.call_args_list] == [1, 2, 4]
    assert commands[-1].startswith('rm -f -- /tmp/deployforge-qemu-pull-')


def test_successful_smaller_read_keeps_smaller_requests_for_remaining_archive(guest_pull):
    client, size, _ = guest_pull
    size[0] = 2 * 1024 * 1024
    data = b'abcd' * (size[0] // 4)
    calls = []

    def file_read(**kwargs):
        calls.append(kwargs)
        if len(calls) == 1:
            raise GuestAgentFileReadError(596, 'Connection timed out')
        return response(data[kwargs['offset']:kwargs['offset'] + kwargs['count']])

    client.agent_file_read.side_effect = file_read
    with patch.object(api, '_wait_for_guest_read_retry'):
        with pull(client) as stream:
            assert stream.read() == data
    assert [item['count'] for item in calls] == [1024 * 1024] + [512 * 1024] * 4
    assert [item['offset'] for item in calls] == [0, 0, 512 * 1024, 1024 * 1024, 1536 * 1024]


@pytest.mark.parametrize('failure', [GuestAgentFileReadError(403, 'permission denied'),
                                    requests.exceptions.SSLError('certificate verify failed')])
def test_permanent_read_errors_are_not_retried(guest_pull, failure):
    client, size, _ = guest_pull
    size[0] = 12
    client.agent_file_read.side_effect = failure
    with patch.object(api, '_wait_for_guest_read_retry') as wait:
        with pytest.raises(type(failure)):
            pull(client)
    client.agent_file_read.assert_called_once()
    wait.assert_not_called()


def test_legacy_part_read_retries_without_switching_to_offset_parameters(guest_pull):
    client, size, _ = guest_pull
    size[0] = 6
    client.agent_file_read.side_effect = [
        GuestAgentFileReadError(400, 'Parameter verification failed'),
        GuestAgentFileReadError(597, 'read timeout'), response(b'abc'), response(b'def'),
    ]
    with patch.object(api, '_wait_for_guest_read_retry'):
        with pull(client) as stream:
            assert stream.read() == b'abcdef'
    calls = client.agent_file_read.call_args_list
    assert calls[1].kwargs == calls[2].kwargs
    assert all(call.kwargs['legacy'] and 'offset' not in call.kwargs for call in calls[1:])


def test_cancellation_during_backoff_stops_read_retries_and_removes_archive(guest_pull):
    client, size, commands = guest_pull
    size[0] = 12
    client.agent_file_read.side_effect = GuestAgentFileReadError(597, 'read timeout')
    cancelled = False

    def sleep(delay):
        nonlocal cancelled
        cancelled = True

    api._TRANSFER_PROGRESS.cancelled = lambda: cancelled
    try:
        with patch.object(api.time, 'sleep', side_effect=sleep):
            with pytest.raises(api._GuestTransferCancelled):
                pull(client)
    finally:
        del api._TRANSFER_PROGRESS.cancelled
    client.agent_file_read.assert_called_once()
    assert commands[-1].startswith('rm -f -- /tmp/deployforge-qemu-pull-')
