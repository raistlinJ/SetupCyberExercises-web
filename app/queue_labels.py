"""User-facing queue titles derived from routes, never request secrets."""
import re
from urllib.parse import unquote, urlsplit


ACTION_LABELS = {
    'create': 'Create VMs', 'delete': 'Delete VMs', 'start': 'Start VMs',
    'suspend': 'Suspend VMs', 'unlock': 'Unlock VMs', 'poweroff': 'Power off VMs',
    'snapshot': 'Create snapshots', 'restore': 'Restore snapshots',
    'apply_scenario': 'Apply scenario settings', 'fix_ageing': 'Fix bridge ageing',
    'purge_leftovers': 'Clean up remaining resources',
    'nets_set': 'Assign network interfaces', 'nets_assign': 'Assign network interfaces',
    'nets_remove': 'Remove network interfaces', 'nets_clear': 'Remove network interfaces',
    'users_create': 'Create users and permissions', 'users_delete': 'Delete users and pools',
    'users_perms': 'Set user permissions', 'users_access_sync': 'Sync user access',
    'users_creds_check': 'Check user credentials', 'users_creds_set': 'Sync user credentials',
    'run_startup_cmds': 'Run startup commands', 'run_stored_cmds': 'Run stored commands',
    'guest_push': 'Upload guest files', 'lxc_push': 'Upload container files',
    'guest_pull': 'Download guest files', 'lxc_pull': 'Download container files',
    'guest_delete': 'Delete guest files', 'lxc_delete': 'Delete container files',
    'reset_ageing_cache': 'Reset bridge ageing cache',
}


def request_label(method, url, body=None):
    method = str(method or 'GET').upper()
    parts = urlsplit(str(url or '')).path.strip('/').split('/')
    # Split before decoding so encoded slashes in item names remain one item.
    parts = [unquote(part) for part in parts]
    if parts[:2] == ['api', 'proxmox']:
        return 'Load network interfaces' if parts[-1] == 'network' else ('Load VM templates' if parts[-1] == 'templates' else 'Load Proxmox nodes')
    if parts[:2] == ['api', 'ctfd']:
        return 'Load CTFd challenges'
    if parts[:2] == ['api', 'projects']:
        if len(parts) == 2:
            return 'Create project' if method == 'POST' else 'Load projects'
        if parts[2] in ('import', 'export'):
            return 'Import project' if parts[2] == 'import' else 'Export project'
        tail = parts[3:]
        if not tail:
            return {'GET': 'Load project', 'DELETE': 'Delete project'}.get(method, 'Save project settings')
        if tail[:2] == ['instances', 'actions'] and len(tail) > 2:
            return ACTION_LABELS.get(tail[2], 'Run VM action')
        if tail[:2] == ['instances', 'refresh']:
            return 'Refresh VM inventory'
        resource = tail[0]
        name = tail[1] if len(tail) > 1 else ''
        if resource == 'vms':
            title = {'GET': 'Load VM settings', 'POST': 'Add VM configuration', 'DELETE': 'Remove VM configuration'}.get(method, 'Save VM settings')
            if isinstance(body, dict) and set(body) == {'viewable_to_user'} and isinstance(body['viewable_to_user'], bool):
                title = 'Enable user-access setting' if body['viewable_to_user'] else 'Disable user-access setting'
            return f'{title} · {name}' if name else title
        if resource == 'ctfd':
            return {
                'users_create': 'Create CTFd users', 'users_delete': 'Delete CTFd users',
                'users_check': 'Check CTFd users', 'login': 'Connect to CTFd',
                'upload': 'Upload CTFd archive', 'settings': 'Load CTFd settings' if method == 'GET' else 'Save CTFd settings',
                'stats': 'Load CTFd statistics', 'challenges': 'Update CTFd challenge visibility' if 'visibility' in tail else 'Load CTFd challenges',
            }.get(name, 'Update CTFd')
        if resource in ('export', 'exports'):
            return 'Delete export' if method == 'DELETE' else 'Export project'
        if resource == 'secrets':
            return 'Save connection credentials' if method != 'GET' else 'Load connection credentials'
        if resource == 'materials':
            title = {'POST': 'Upload material', 'DELETE': 'Delete material'}.get(method, 'Load materials')
            return f'{title} · {name}' if name else title
        if resource == 'audio':
            return 'Save notification audio' if method != 'DELETE' else 'Delete notification audio'
        if resource == 'credentials':
            return 'Generate user credentials' if 'generate' in tail else 'Save user credentials'
        if resource in ('clone', 'duplicate'):
            return 'Duplicate project'
    # Unknown routes still get a readable title without exposing paths or queries.
    return {'GET': 'Load data', 'POST': 'Run operation', 'PUT': 'Save settings',
            'PATCH': 'Save settings', 'DELETE': 'Delete item'}.get(method, 'Run operation')


def queue_label(label, steps=()):
    label = str(label or '').strip()
    raw = re.fullmatch(r'(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(/api/\S+)', label, flags=re.IGNORECASE)
    if raw:
        # Also formats old completed records whose request payload was discarded.
        return request_label(raw[1], raw[2], steps[0].get('body') if steps else None)
    if label and label != 'Action':
        return label
    if steps:
        first = steps[0]
        return request_label(first.get('method'), first.get('url'), first.get('body'))
    return 'Run operation'
