from unittest.mock import MagicMock, patch

import pytest

from app.routes import api
from app.storage.projects import Project, VMConfig


@pytest.mark.parametrize("failed_read", ["list_qemu_vms", "list_lxc_vms"])
def test_inventory_failure_is_reported_instead_of_silently_skipping_guest(failed_read):
    client = MagicMock()
    client.list_nodes.return_value = [{"node": "node1"}]
    client.list_qemu_vms.return_value = []
    client.list_lxc_vms.return_value = []
    getattr(client, failed_read).side_effect = RuntimeError("inventory connection lost")
    project = Project(id="inventory-test", name="Inventory", tag="-lab-", vms=[VMConfig(name="alpha")])
    with patch.object(api, "ProxmoxClient", return_value=client):
        mapped, skipped, errors = api._resolve_targets_to_vm_info(
            project, client, [{"index": 1, "name": "alpha-lab-1"}])
    assert mapped == []
    assert skipped == []
    assert len(errors) == 1
    assert "Failed to refresh guest inventory" in errors[0]["reason"]
    assert "inventory connection lost" in errors[0]["reason"]
