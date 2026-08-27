from pathlib import Path


SHELL_JS = Path(__file__).resolve().parents[1] / "app" / "static" / "js" / "shell.js"


def _function_source(source: str, name: str, next_name: str) -> str:
    start = source.index(f"function {name}(")
    end = source.index(f"function {next_name}(", start)
    return source[start:end]


def test_action_progress_updates_queue_counts_without_opening_dock():
    source = SHELL_JS.read_text(encoding="utf-8")
    show_progress = _function_source(source, "showActionProgress", "updateActionProgress")

    assert "actionProgressEmit();" in show_progress
    assert "showQueuePanel(" not in show_progress


def test_queue_changes_refresh_dock_labels_while_closed():
    source = SHELL_JS.read_text(encoding="utf-8")

    assert "document.addEventListener('remote-queue-changed'" in source
    assert "refreshQueueModeLabelsFromState();" in source
