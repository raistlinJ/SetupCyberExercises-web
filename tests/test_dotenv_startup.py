"""Startup reads .env before plugin registration and respects shell overrides."""

import os
from pathlib import Path

import pytest

import app as application


@pytest.fixture
def env_file(monkeypatch, tmp_path):
    path = tmp_path / ".env"
    monkeypatch.setattr(application, "_DOTENV_PATH", str(path))
    monkeypatch.setenv("DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setenv("USERS_FILE", str(tmp_path / "users.json"))
    monkeypatch.setenv("AUTH_ENABLE", "0")
    monkeypatch.delenv("AGENT_PLUGIN_ENABLE", raising=False)
    monkeypatch.delenv("CTFD_PLUGIN_ENABLE", raising=False)
    monkeypatch.delenv("CTFRPG_PLUGIN_ENABLE", raising=False)
    monkeypatch.delenv("ORCHESTRATION_PERMISSIONS_ENABLE", raising=False)
    monkeypatch.delenv("SECRET_KEY", raising=False)
    monkeypatch.delenv("PORT", raising=False)
    monkeypatch.delenv("PYTHON_DOTENV_DISABLED", raising=False)
    return path


@pytest.mark.parametrize("setting", ["1", "true", "TRUE", "yes", "on", '" 1 "'])
def test_plugin_enabled_from_dotenv(env_file, setting):
    env_file.write_text(f"AGENT_PLUGIN_ENABLE={setting}\n")
    app = application.create_app()
    assert app.config["AGENT_PLUGIN_ENABLE"] is True
    assert app.test_client().get("/api/plugins").get_json()["plugins"][0]["name"] == "agent"
    assert app.test_client().post("/api/plugins/agent/models", json={}).status_code == 400


def test_shell_can_disable_plugin_enabled_in_dotenv(env_file, monkeypatch):
    env_file.write_text("AGENT_PLUGIN_ENABLE=1\nSECRET_KEY=file-secret\n")
    monkeypatch.setenv("AGENT_PLUGIN_ENABLE", "0")
    monkeypatch.setenv("SECRET_KEY", "shell-secret")
    app = application.create_app()
    assert app.config["AGENT_PLUGIN_ENABLE"] is False
    assert app.secret_key == "shell-secret"
    assert {entry["name"] for entry in app.test_client().get("/api/plugins").get_json()["plugins"]} == {"ctfd", "ctfrpg"}


def test_dotenv_loads_before_configuration_from_other_working_directory(env_file, monkeypatch, tmp_path):
    env_file.write_text("export AGENT_PLUGIN_ENABLE='1' # enabled\nSECRET_KEY='file-secret'\nPORT=9137\n")
    unrelated = tmp_path / "elsewhere"
    unrelated.mkdir()
    (unrelated / ".env").write_text("AGENT_PLUGIN_ENABLE=0\nSECRET_KEY=wrong-secret\n")
    monkeypatch.chdir(unrelated)
    app = application.create_app()
    assert app.config["AGENT_PLUGIN_ENABLE"] is True
    assert app.secret_key == "file-secret"
    assert os.environ["PORT"] == "9137"


def test_missing_dotenv_keeps_plugin_disabled_by_default(env_file):
    assert not env_file.exists()
    app = application.create_app()
    assert app.config["AGENT_PLUGIN_ENABLE"] is False
    assert {entry["name"] for entry in app.test_client().get("/api/plugins").get_json()["plugins"]} == {"ctfd", "ctfrpg"}


def test_default_dotenv_location_is_project_root():
    assert Path(application._DOTENV_PATH) == Path(application.__file__).resolve().parent.parent / ".env"


@pytest.mark.parametrize(
    "setting, enabled", [(None, False), ("0", False), ("false", False), ("1", True), ("true", True)]
)
def test_orchestration_feature_flag_from_dotenv(env_file, setting, enabled):
    env_file.write_text("" if setting is None else f"ORCHESTRATION_PERMISSIONS_ENABLE={setting}\n")
    app = application.create_app()
    assert app.config["ORCHESTRATION_PERMISSIONS_ENABLE"] is enabled
    assert app.test_client().get("/api/features").get_json() == {"orchestration_permissions": enabled}


def test_shell_can_disable_orchestration_enabled_in_dotenv(env_file, monkeypatch):
    env_file.write_text("ORCHESTRATION_PERMISSIONS_ENABLE=1\n")
    monkeypatch.setenv("ORCHESTRATION_PERMISSIONS_ENABLE", "0")
    app = application.create_app()
    assert app.test_client().get("/api/features").get_json()["orchestration_permissions"] is False
