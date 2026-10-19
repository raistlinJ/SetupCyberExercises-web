import shutil
import subprocess
from pathlib import Path

import pytest


def test_ctfrpg_notification_behavior():
    node = shutil.which('node')
    if not node:
        pytest.skip('Node.js is required for CTF-RPG notification checks')
    root = Path(__file__).resolve().parents[1]
    subprocess.run([node, '--test', 'tests/ctfrpg_audio.test.cjs'], cwd=root, check=True, timeout=30)
