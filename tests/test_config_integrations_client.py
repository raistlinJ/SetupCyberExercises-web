import shutil
import subprocess
from pathlib import Path

import pytest


def test_configuration_integrations_javascript_behavior():
    node = shutil.which('node')
    if not node:
        pytest.skip('Node.js is required for Configuration integration client checks')
    subprocess.run(
        [node, '--test', 'tests/config_integrations.test.cjs', 'tests/checkout_state.test.cjs'],
        cwd=Path(__file__).resolve().parents[1], check=True, timeout=30,
    )
