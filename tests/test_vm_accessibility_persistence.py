import threading
from concurrent.futures import ThreadPoolExecutor

import pytest

from app import create_app
from app.storage.projects import ProjectStore


@pytest.mark.parametrize('overlapping_save', ['vm', 'project', 'add', 'remove', 'rename'])
@pytest.mark.parametrize('accessible', [False, True])
def test_accessibility_survives_overlapping_configuration_save(monkeypatch, tmp_path, overlapping_save, accessible):
    monkeypatch.setenv('AUTH_ENABLE', '0')
    monkeypatch.setenv('DATA_DIR', str(tmp_path))
    app = create_app()
    app.config['TESTING'] = True
    with app.test_client() as client:
        response = client.post('/api/projects', json={
            'id': 'p', 'name': 'Original', 'vms': [
                {'name': 'web', 'viewable_to_user': not accessible}, {'name': 'other'},
            ],
        })
        assert response.status_code == 201

    saving = threading.Event()
    release_save = threading.Event()
    toggle_finished = threading.Event()
    local = threading.local()
    original_upsert = ProjectStore.upsert

    def delayed_upsert(store, project, **kwargs):
        if getattr(local, 'delay_save', False):
            saving.set()
            assert release_save.wait(5), 'Overlapping save was not released'
        return original_upsert(store, project, **kwargs)

    monkeypatch.setattr(ProjectStore, 'upsert', delayed_upsert)

    def save_configuration():
        local.delay_save = True
        with app.test_client() as client:
            if overlapping_save == 'vm':
                return client.patch('/api/projects/p/vms/web', json={'vm_user': 'student'})
            if overlapping_save == 'add':
                return client.post('/api/projects/p/vms', json={'name': 'new'})
            if overlapping_save == 'remove':
                return client.delete('/api/projects/p/vms/other')
            if overlapping_save == 'rename':
                return client.post('/api/projects/p/vms/other/rename', json={'new_name': 'renamed'})
            return client.patch('/api/projects/p', json={'name': 'Renamed'})

    def toggle_access():
        try:
            with app.test_client() as client:
                return client.patch('/api/projects/p/vms/web', json={'viewable_to_user': accessible})
        finally:
            toggle_finished.set()

    try:
        with ThreadPoolExecutor(max_workers=2) as pool:
            first = pool.submit(save_configuration)
            assert saving.wait(5), 'Configuration save did not start'
            second = pool.submit(toggle_access)
            # Before the fix the toggle saves immediately, then the paused save
            # writes its older copy of the accessibility flag over that change.
            try:
                toggle_finished.wait(0.25)
            finally:
                release_save.set()
            assert first.result(timeout=5).status_code == 200
            assert second.result(timeout=5).status_code == 200

        reopened = ProjectStore(str(tmp_path)).get('p')
        assert reopened.vms[0].viewable_to_user is accessible
        if overlapping_save == 'vm':
            assert reopened.vms[0].vm_user == 'student'
        elif overlapping_save == 'project':
            assert reopened.name == 'Renamed'
        else:
            names = {vm.name for vm in reopened.vms}
            if overlapping_save == 'add':
                assert names == {'web', 'other', 'new'}
            elif overlapping_save == 'remove':
                assert names == {'web'}
            else:
                assert names == {'web', 'renamed'}
        with app.test_client() as client:
            project = next(p for p in client.get('/api/projects').json['projects'] if p['id'] == 'p')
            assert project['vms'][0]['viewable_to_user'] is accessible
    finally:
        release_save.set()
        if queue := app.extensions.get('action_queue'):
            queue.close()
