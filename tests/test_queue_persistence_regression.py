from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
STATIC = ROOT / "app" / "static"
JS = STATIC / "js"


def test_every_queue_page_loads_cross_page_persistence_after_shell():
    pages = [
        "index.html",
        "vm_manager.html",
        "ctfd_manager.html",
        "ctfd_challenges.html",
        "exports.html",
    ]
    for name in pages:
        source = (STATIC / name).read_text(encoding="utf-8")
        shell_at = source.index("/static/js/shell.js")
        persistence_at = source.index("/static/js/queue_persistence.js")
        assert persistence_at > shell_at, f"{name} must load queue persistence after shell.js"


def test_shell_keeps_unclaimed_restored_tasks_and_progress_state():
    source = (JS / "shell.js").read_text(encoding="utf-8")

    assert "REMOTE_QUEUE_BACKLOG.set(key, back);" in source
    assert "ACTION_PROGRESS_STORE_KEY" in source
    assert "saveActionProgressState();" in source
    assert "restoreActionProgressState();" in source
    assert source.index("task.startedAt = Date.now();") < source.index("_remoteQueue_saveState();", source.index("function _remoteQueue_start"))


def test_vm_actions_and_guest_transfers_have_restore_descriptors():
    source = (JS / "vm_manager.js").read_text(encoding="utf-8")

    assert "VM_ACTION_QUEUE_PERSIST_KEY" in source
    assert "makeVmActionQueuePersist(action, options" in source
    assert "restoreQueuedVmAction" in source
    assert "GUEST_TRANSFER_QUEUE_PERSIST_KEY" in source
    assert "PersistentQueuePayloads.put" in source
    assert "executePersistedGuestTransfer" in source
    assert "serializeGuestTransferGroups" in source


def test_active_vm_actions_are_tracked_not_replayed_cross_page():
    source = (JS / "queue_persistence.js").read_text(encoding="utf-8")

    assert "String(saved?.status || '') !== 'active'" in source
    assert "trackActiveVmAction" in source
    assert "/instances/actions/status" in source
    assert "GUEST_TRANSFER_HANDLER" in source
    assert "IndexedDB is unavailable" in source


def test_guest_transfer_api_publishes_action_status_for_cross_page_tracking():
    source = (ROOT / "app" / "routes" / "api.py").read_text(encoding="utf-8")

    assert "_start_job(pid, 'guest_push'" in source
    assert "_start_job(pid, 'guest_pull'" in source
    assert "phase='guest_push'" in source
    assert "phase='guest_pull'" in source
