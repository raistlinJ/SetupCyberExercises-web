import shutil
import subprocess
from pathlib import Path

import pytest


def test_stored_command_picker_javascript_behavior():
    node = shutil.which('node')
    if not node:
        pytest.skip('Node.js is required for stored command picker checks')
    root = Path(__file__).resolve().parents[1]
    subprocess.run([node, '--test', 'tests/stored_command_picker_client.test.cjs'], cwd=root, check=True, timeout=30)
