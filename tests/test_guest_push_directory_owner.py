import shlex
import subprocess

import pytest

from app.routes.api import _lxc_prepare_directory_command


@pytest.mark.parametrize('owner', ['', 'www-data', '1000'])
@pytest.mark.parametrize('conflict', [False, True])
def test_destination_owner_only_applies_to_created_directories(tmp_path, owner, conflict):
    existing = tmp_path / 'existing'
    existing.mkdir()
    parent = existing / "new 'folder'"
    if conflict:
        parent.write_text('replaced by directory')
    destination = parent / 'nested'
    log = tmp_path / 'chown.log'
    # Exercise the generated shell without requiring root or a guest account.
    command = (
        f'chown() {{ printf "%s\\n" "$@" >> {shlex.quote(str(log))}; }}; '
        + _lxc_prepare_directory_command(str(destination), owner)
    )
    subprocess.run(['/bin/sh', '-c', command], check=True)
    assert destination.is_dir()
    if owner:
        assert log.read_text().splitlines() == ['--', owner, str(parent), '--', owner, str(destination)]
        log.unlink()
    else:
        assert not log.exists()
    subprocess.run(['/bin/sh', '-c', command], check=True)
    assert not log.exists()


def test_destination_creation_stops_when_ownership_fails(tmp_path):
    destination = tmp_path / 'parent' / 'child'
    command = 'chown() { return 1; }; ' + _lxc_prepare_directory_command(str(destination), 'missing-user')
    result = subprocess.run(['/bin/sh', '-c', command])
    assert result.returncode != 0
    assert not destination.exists()
