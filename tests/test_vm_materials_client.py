import shutil
import subprocess
from pathlib import Path

import pytest


def test_vm_materials_javascript_behavior():
    node = shutil.which('node')
    if not node:
        pytest.skip('Node.js is required for materials client checks')
    subprocess.run([node, '--test', 'tests/vm_materials_client.test.cjs'],
                   cwd=Path(__file__).resolve().parents[1], check=True, timeout=30)
