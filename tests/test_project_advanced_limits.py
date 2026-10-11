import math

import pytest

from app import create_app
from app.storage.projects import ProjectStore


@pytest.fixture
def client(monkeypatch, tmp_path):
    monkeypatch.setenv("DATA_DIR", str(tmp_path))
    monkeypatch.setenv("AUTH_ENABLE", "0")
    monkeypatch.delenv("API_KEY", raising=False)
    application = create_app()
    application.config["TESTING"] = True
    yield application.test_client()
    if queue := application.extensions.get("action_queue"):
        queue.close()


def test_parallel_agent_limit_defaults_and_persists_with_advanced_delays(client):
    created = client.post("/api/projects", json={"id": "p", "name": "Parallel grading"}).get_json()
    assert created["agent_max_parallel_agents"] == 1
    response = client.patch(
        "/api/projects/p",
        json={"agent_max_parallel_agents": 5, "proxmox_snapshot_delay_seconds": 0, "proxmox_update_delay_seconds": 0.2},
    )
    assert response.status_code == 200
    reopened = ProjectStore(client.application.config["DATA_DIR"]).get("p")
    assert reopened.agent_max_parallel_agents == 5
    assert reopened.proxmox_snapshot_delay_seconds == 0
    assert reopened.proxmox_update_delay_seconds == 0.2


@pytest.mark.parametrize(
    "key, value",
    [
        *[("agent_max_parallel_agents", value) for value in [-1, 0, 6, 1.5, True, "2", None]],
        *[("proxmox_max_create_jobs", value) for value in [-1, 0, 2.5, True]],
        *[
            (key, value)
            for key in ["proxmox_snapshot_delay_seconds", "proxmox_update_delay_seconds"]
            for value in [-1, math.inf, math.nan, True]
        ],
    ],
)
def test_advanced_limits_reject_invalid_create_and_patch_without_changing_project(client, key, value):
    response = client.post("/api/projects", json={"id": "bad", "name": "Invalid", key: value})
    assert response.status_code == 400
    assert key in " ".join(response.get_json()["errors"])
    original = client.post("/api/projects", json={"id": "p", "name": "Valid"}).get_json()
    response = client.patch("/api/projects/p", json={key: value})
    assert response.status_code == 400
    saved = ProjectStore(client.application.config["DATA_DIR"]).get("p")
    assert getattr(saved, key) == original[key]
