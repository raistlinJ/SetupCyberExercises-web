import json
import pytest

from app import create_app
from app.command_templates import CommandTemplateError, VARIABLES, command_context, render_command
from app.storage.projects import Project, ProjectStore, VMConfig


def project(**kwargs):
    return Project(id='course', name='Course', instances=60, **kwargs)


def test_generic_metadata_and_recreated_guest_identity():
    p = project()
    first = command_context(p, {'index': 7, 'name': 'vm-set-7', 'vmid': 907})
    recreated = command_context(p, {'index': 7, 'name': 'vm-set-7', 'vmid': 1707})
    assert first == {'instance_index': 7, 'vmid': 907, 'vm_name': 'vm-set-7', 'project_id': 'course'}
    assert first['instance_index'] == recreated['instance_index']
    assert first['vmid'] != recreated['vmid']
    assert set(VARIABLES) == set(first)


@pytest.mark.parametrize('index', [0, 61, -1, True, '1', None])
def test_invalid_instance_index(index):
    with pytest.raises(CommandTemplateError, match='Invalid instance'):
        command_context(project(), {'index': index})


def test_literal_templates_preserve_shell_syntax_and_reject_unknown_or_unsafe_values():
    p = project()
    guest = {'index': 2, 'name': 'vm-set-2', 'vmid': 902}
    original = "echo ${HOME} | awk '{print $1}'; echo '{\"count\": 1}'"
    assert render_command(original, p, guest) == original
    assert render_command('configure {{instance_index}} {{vmid}}', p, guest) == 'configure 2 902'
    with pytest.raises(CommandTemplateError, match='Unknown'):
        render_command('{{typo}}', p, guest)
    guest['name'] = 'vm; touch /tmp/injected'
    with pytest.raises(CommandTemplateError, match='not safe'):
        render_command('{{vm_name}}', p, guest)
    with pytest.raises(CommandTemplateError, match='unavailable'):
        render_command('{{vmid}}', p, {'index': 1})


@pytest.fixture
def client(monkeypatch, tmp_path):
    monkeypatch.setenv('DATA_DIR', str(tmp_path))
    monkeypatch.setenv('AUTH_ENABLE', '0')
    monkeypatch.delenv('API_KEY', raising=False)
    application = create_app()
    application.config['TESTING'] = True
    yield application.test_client()
    if queue := application.extensions.get('action_queue'):
        queue.close()


def create(client, pid='one', **fields):
    return client.post('/api/projects', json={'id': pid, 'name': pid, 'instances': 60, **fields})

def test_preview_needs_no_proxmox_and_never_executes(client, monkeypatch):
    assert create(client).status_code == 201
    store = ProjectStore(client.application.config['DATA_DIR'])
    p = store.get('one')
    p.vms = [VMConfig(name='core')]
    store.upsert(p)
    monkeypatch.setattr('app.routes.api.ProxmoxClient', lambda *a, **kw: pytest.fail('Preview contacted Proxmox'))
    response = client.post('/api/projects/one/commands/preview', json={
        'targets': [{'index': 7, 'name': 'core', 'vmid': 1707}],
        'commands': ['configure {{instance_index}} {{vmid}} {{vm_name}}']})
    assert response.status_code == 200
    item = response.get_json()['previews'][0]
    assert item['commands'] == ['configure 7 1707 core-set-7']
    assert set(item['variables']) == {'instance_index', 'vmid', 'vm_name', 'project_id'}
    response = client.post('/api/projects/one/commands/preview', json={
        'targets': [{'index': 1, 'name': 'core'}], 'commands': ['{{vmid}}']})
    assert 'unavailable' in response.get_json()['previews'][0]['error']
    assert client.post('/api/projects/one/commands/preview', json={
        'targets': [{'index': 61, 'name': 'core'}], 'commands': ['echo okay']
    }).get_json()['previews'][0].get('error')


def test_literal_mode_skips_substitution_and_unavailable_values():
    p = project()
    text = 'echo {{unknown}} {{vmid}}'
    assert render_command(text, p, {}, enabled=False) == text


def test_preview_supports_mixed_rendered_and_literal_commands(client, monkeypatch):
    assert create(client).status_code == 201
    store = ProjectStore(client.application.config['DATA_DIR'])
    p = store.get('one')
    p.vms = [VMConfig(name='core')]
    store.upsert(p)
    monkeypatch.setattr('app.routes.api.ProxmoxClient', lambda *a, **kw: pytest.fail('Preview contacted Proxmox'))
    response = client.post('/api/projects/one/commands/preview', json={
        'targets': [{'index': 2, 'name': 'core'}],
        'commands': [
            {'command': 'echo {{instance_index}}', 'render_template_variables': True},
            {'command': 'echo {{unknown}} {{vmid}}', 'render_template_variables': False},
        ]})
    assert response.status_code == 200
    assert response.get_json()['previews'][0]['commands'] == ['echo 2', 'echo {{unknown}} {{vmid}}']
    response = client.post('/api/projects/one/commands/preview', json={
        'targets': [{'index': 2, 'name': 'core'}],
        'commands': [{'command': '{{instance_index}}', 'render_template_variables': 'false'}]})
    assert response.status_code == 400


def test_saved_render_choice_survives_project_reload(client):
    assert create(client).status_code == 201
    store = ProjectStore(client.application.config['DATA_DIR'])
    p = store.get('one')
    p.vms = [VMConfig(name='core')]
    store.upsert(p)
    steps = [{'commands': [
        {'command': 'echo {{literal}}', 'render_template_variables': False},
        {'command': 'echo {{instance_index}}'},
    ]}]
    store.update_vm('one', 'core', start_commands=steps, stored_commands=steps,
                    validation_commands=steps[0]['commands'])
    loaded = ProjectStore(client.application.config['DATA_DIR']).get('one')
    for name in ('start_commands', 'stored_commands'):
        commands = getattr(loaded.vms[0], name)[0].commands
        assert commands[0].render_template_variables is False
        assert commands[1].render_template_variables is True
    commands = loaded.vms[0].validation_commands
    assert commands[0]['render_template_variables'] is False
    assert commands[1]['render_template_variables'] is True


def test_legacy_network_metadata_does_not_prevent_project_loading(client):
    assert create(client).status_code == 201
    store = ProjectStore(client.application.config['DATA_DIR'])
    path = store.db_path
    with open(path) as stream:
        saved = json.load(stream)
    saved['one']['core_network'] = {'obsolete': 'ignored'}
    with open(path, 'w') as stream:
        json.dump(saved, stream)
    loaded = store.get('one')
    assert loaded.id == 'one'
    assert not hasattr(loaded, 'core_network')
    store.upsert(loaded)
    with open(path) as stream:
        assert 'core_network' not in json.load(stream)['one']
