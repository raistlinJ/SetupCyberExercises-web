import shutil
import subprocess
from pathlib import Path

import pytest


def test_server_queue_javascript_behavior():
    node = shutil.which('node')
    if not node:
        pytest.skip('Node.js is required for queue client checks')
    root = Path(__file__).resolve().parents[1]
    subprocess.run([node, '--test', 'tests/server_queue_client.test.cjs'], cwd=root, check=True, timeout=30)
