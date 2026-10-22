import shutil
import subprocess
from pathlib import Path

import pytest


def test_history_recall_in_the_browser():
    node = shutil.which('node')
    if not node:
        pytest.skip('Node.js is required for history recall checks')
    subprocess.run([node, '--test', 'tests/action_history_client.test.cjs'],
                   cwd=Path(__file__).resolve().parents[1], check=True, timeout=30)
