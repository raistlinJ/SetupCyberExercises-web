import shutil
import subprocess
from pathlib import Path

import pytest


def test_archive_progress_javascript_behavior():
    node = shutil.which('node')
    if not node:
        pytest.skip('Node.js is required for archive progress checks')
    subprocess.run([node, '--test', 'tests/archive_progress_client.test.cjs'],
                   cwd=Path(__file__).resolve().parents[1], check=True, timeout=30)
