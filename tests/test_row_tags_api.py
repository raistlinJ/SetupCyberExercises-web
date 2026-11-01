import json
from concurrent.futures import ThreadPoolExecutor

import pytest

from app import create_app
from app.routes import api
from app.storage.projects import Project, ProjectStore


@pytest.fixture
def tag_client(monkeypatch, tmp_path):
    monkeypatch.setenv('AUTH_ENABLE', '0')
    app = create_app()
    app.config.update(TESTING=True, DATA_DIR=str(tmp_path))
    monkeypatch.setattr(api, '_store', lambda: ProjectStore(str(tmp_path)))
    store = ProjectStore(str(tmp_path))
    for pid in ('one', 'two'):
        store.upsert(Project(id=pid, name=pid))
    return app.test_client(), tmp_path


@pytest.mark.parametrize('scope,row', [('vm', '1|web-set-1'), ('ctfd', '1'), ('ctfrpg', 'alice')])
def test_multiple_tags_survive_app_and_store_restart(tag_client, scope, row):
    client, path = tag_client
    endpoint = f'/api/projects/one/row-tags/{scope}'
    for tag_id in (1, 4, 1):
        response = client.patch(endpoint, json={'rows': [row], 'tag_id': tag_id})
        assert response.status_code == 200
    assert response.json == {'row_tags': {row: [1, 4]}}
    assert ProjectStore(str(path)).get('one').row_tags == {scope: {row: [1, 4]}}
    with open(path / 'projects.json') as saved:
        assert json.load(saved)['one']['row_tags'][scope][row] == [1, 4]
    # New Flask application and client: no cookies or browser storage are needed.
    reopened = create_app()
    reopened.config.update(TESTING=True, DATA_DIR=str(path))
    assert reopened.test_client().get(endpoint).json == {'row_tags': {row: [1, 4]}}
    assert client.get(f'/api/projects/two/row-tags/{scope}').json == {'row_tags': {}}
    response = client.patch(endpoint, json={'rows': [row], 'tag_id': 1, 'enabled': False})
    assert response.json == {'row_tags': {row: [4]}}
    assert client.patch(endpoint, json={'rows': [row], 'tag_id': None}).json == {'row_tags': {}}


def test_bulk_add_and_migration_do_not_replace_other_tags_or_pages(tag_client):
    client, _ = tag_client
    endpoint = '/api/projects/one/row-tags/ctfd'
    client.patch(endpoint, json={'rows': ['1', '2'], 'tag_id': 3})
    client.patch('/api/projects/one/row-tags/vm', json={'rows': ['1|web'], 'tag_id': 5})
    response = client.patch(endpoint, json={'merge': {'1': [1, 3], '3': [4]}})
    assert response.json == {'row_tags': {'1': [1, 3], '2': [3], '3': [4]}}
    assert client.get('/api/projects/one/row-tags/vm').json == {'row_tags': {'1|web': [5]}}


def test_stale_inventory_or_settings_save_cannot_erase_new_assignments(tag_client):
    client, path = tag_client
    store = ProjectStore(str(path))
    stale = store.get('one')
    client.patch('/api/projects/one/row-tags/vm', json={'rows': ['1|web'], 'tag_id': 2})
    stale.name = 'Renamed after slow operation'
    stale.instance_statuses = [{'index': 1, 'vm_details': []}]
    store.upsert(stale)
    saved = ProjectStore(str(path)).get('one')
    assert saved.name == stale.name
    assert saved.row_tags == {'vm': {'1|web': [2]}}


def test_overlapping_additions_preserve_both_tags(tag_client):
    _, path = tag_client
    with ThreadPoolExecutor(max_workers=5) as pool:
        list(pool.map(lambda tag: ProjectStore(str(path)).patch_row_tags('one', 'ctfd', rows=['1'], tag_id=tag), range(1, 6)))
    assert ProjectStore(str(path)).get('one').row_tags == {'ctfd': {'1': [1, 2, 3, 4, 5]}}


@pytest.mark.parametrize('body', [
    None, [], {'rows': [], 'tag_id': 1}, {'rows': ['1']}, {'rows': ['1'], 'tag_id': 6},
    {'rows': ['1'], 'tag_id': True}, {'rows': ['1'], 'tag_id': 1, 'enabled': 'false'},
    {'rows': [42], 'tag_id': 1}, {'merge': []}, {'merge': {'1': [True]}},
    {'merge': {'1': [9]}}, {'merge': {'1': [1]}, 'rows': ['2']},
])
def test_invalid_operations_do_not_modify_saved_tags(tag_client, body):
    client, _ = tag_client
    endpoint = '/api/projects/one/row-tags/ctfd'
    response = client.patch(endpoint, data=json.dumps(body), content_type='application/json')
    assert response.status_code == 400
    assert client.get(endpoint).json == {'row_tags': {}}


def test_tag_endpoint_rejects_unknown_projects_and_requires_authentication(tag_client):
    client, _ = tag_client
    assert client.get('/api/projects/missing/row-tags/vm').status_code == 404
    assert client.get('/api/projects/one/row-tags/unknown').status_code == 400
    client.application.config['AUTH_ENABLE'] = True
    assert client.get('/api/projects/one/row-tags/vm').status_code == 401
    assert client.patch('/api/projects/one/row-tags/vm', json={'rows': ['1|web'], 'tag_id': 1}).status_code == 401
