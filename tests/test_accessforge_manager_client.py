import shutil
import subprocess
from pathlib import Path

import pytest


def test_accessforge_manager_javascript_behavior():
    node = shutil.which('node')
    if not node:
        pytest.skip('Node.js is required for AccessForge manager client checks')
    subprocess.run(
        [node, '--test', 'tests/accessforge_manager.test.cjs'],
        cwd=Path(__file__).resolve().parents[1], check=True, timeout=30,
    )
