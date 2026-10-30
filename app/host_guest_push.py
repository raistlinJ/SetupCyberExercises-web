"""Small host-side archive builder for CSV guest file pushes."""
import json
import os
import stat
import tarfile
import tempfile
from contextlib import contextmanager


@contextmanager
def server_file_archive(source, filename):
    """Read a file on the app host into a private, seekable upload archive."""
    with os.fdopen(os.open(source, os.O_RDONLY | os.O_NONBLOCK), 'rb') as stream:
        details = os.fstat(stream.fileno())
        if not stat.S_ISREG(details.st_mode):
            raise ValueError(f'Server source must be a regular file: {source}')
        with tempfile.TemporaryFile(mode='w+b') as output:
            with tarfile.open(fileobj=output, mode='w') as archive:
                info = tarfile.TarInfo(filename)
                info.size = details.st_size
                info.mode = 0o644
                info.mtime = int(details.st_mtime)
                archive.addfile(info, stream)
            size = output.tell()
            output.seek(0)
            yield output, size


def build_host_file_archive_script(source, filename, archive):
    # Pass paths as Python data, never as shell syntax or tar options. Opening
    # the source first lets fstat reject directories/devices before archiving.
    return f'''import json, os, stat, tarfile
source, filename, archive = json.loads({json.dumps(json.dumps([source, filename, archive]))})
with os.fdopen(os.open(source, os.O_RDONLY | os.O_NONBLOCK), 'rb') as stream:
    details = os.fstat(stream.fileno())
    if not stat.S_ISREG(details.st_mode):
        raise ValueError('Host source must be a regular file: ' + source)
    fd = os.open(archive, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'wb') as output, tarfile.open(fileobj=output, mode='w') as tar:
        info = tarfile.TarInfo(filename)
        info.size = details.st_size
        info.mode = 0o644
        info.mtime = int(details.st_mtime)
        tar.addfile(info, stream)
print(os.path.getsize(archive))
'''
