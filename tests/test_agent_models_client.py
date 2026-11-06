import shutil
import subprocess
from pathlib import Path

import pytest


def test_agent_model_picker_javascript_behavior():
    node = shutil.which('node')
    if not node:
        pytest.skip('Node.js is required for agent model picker checks')
    subprocess.run([node, '--test', 'tests/agent_models_client.test.cjs'],
                   cwd=Path(__file__).resolve().parents[1], check=True, timeout=30)
