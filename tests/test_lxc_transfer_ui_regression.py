from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def test_lxc_transfer_ui_has_progress_and_typed_push_controls():
    html = (ROOT / 'app/static/vm_manager.html').read_text(encoding='utf-8')
    javascript = (ROOT / 'app/static/js/vm_manager.js').read_text(encoding='utf-8')

    assert 'id="lxc-push-type-file"' in html
    assert 'id="lxc-push-type-folder"' in html
    assert 'name="lxc-push-type"' in html
    assert 'name="lxc-pull-type"' not in html
    assert 'id="act-guest-files"' in html
    assert '>Guest Files</button>' in html
    assert 'existing files and conflicting paths are replaced without another warning' in html
    assert 'lxc-push-host-paths' not in html

    assert 'openActionProgressModal()' in javascript
    assert 'await hideLxcSetupModal(modal)' in javascript
    assert 'selectionType' in javascript
    assert 'targets, paths: raw' in javascript
    assert '/instances/actions/guest_push' in javascript
    assert '/instances/actions/guest_pull' in javascript
    assert 'getSelectedGuestEntries' in javascript
    assert 'hostPaths' not in javascript
