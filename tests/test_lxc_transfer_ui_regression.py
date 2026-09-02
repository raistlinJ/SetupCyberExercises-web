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
    assert 'onclick="openLxcDeleteModal()"' in html
    assert 'id="lxcDeleteModal"' in html
    assert 'id="lxc-delete-type-file"' in html
    assert 'id="lxc-delete-type-folder"' in html
    assert 'id="lxc-delete-confirm-irreversible"' in html
    assert 'I understand this cannot be undone.' in html
    assert 'id="lxc-delete-confirm" type="button" class="btn btn-danger" disabled' in html
    assert 'lxc-push-host-paths' not in html

    assert 'openActionProgressModal()' in javascript
    assert 'await hideLxcSetupModal(modal)' in javascript
    assert 'selectionType' in javascript
    assert 'paths: rawPaths' in javascript
    assert 'GUEST_TRANSFER_QUEUE_PERSIST_KEY' in javascript
    assert "destination: descriptor.destination" not in javascript
    assert "payload.destination || descriptor?.destination" in javascript
    assert "queued upload destination must be an absolute guest directory" in javascript
    assert "form.append('destination', destination)" in javascript
    assert "guest_push?destination=${encodeURIComponent(destination)}" in javascript
    assert 'const runtimePayload = {' in javascript
    assert 'await window.PersistentQueuePayloads.put(payloadId, runtimePayload)' in javascript
    assert 'executePersistedGuestTransfer(descriptor, runtimePayload)' in javascript
    assert "const payload = runtimePayload || await window.PersistentQueuePayloads.get(payloadId)" in javascript
    assert 'body: form' in javascript
    assert 'vm_manager.js?v=20260902e' in html
    assert '/instances/actions/guest_push' in javascript
    assert '/instances/actions/guest_pull' in javascript
    assert '/instances/actions/guest_delete' in javascript
    assert 'openLxcDeleteModal' in javascript
    assert "kind: 'delete'" in javascript
    assert 'confirmed: true' in javascript
    assert 'window.confirm(' in javascript
    assert 'This cannot be undone.' in javascript
    assert 'removed_guest_paths' in javascript
    assert 'getSelectedGuestEntries' in javascript
    assert 'hostPaths' not in javascript
