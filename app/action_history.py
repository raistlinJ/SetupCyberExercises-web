"""The last five distinct executed settings per user and operation."""
import json
import time
from urllib.parse import urlsplit

KINDS = {'push', 'pull', 'custom'}


def init_history(db):
    db.execute('''CREATE TABLE IF NOT EXISTS action_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT, owner TEXT NOT NULL,
        kind TEXT NOT NULL, settings TEXT NOT NULL, executed REAL NOT NULL)''')
    db.execute('CREATE INDEX IF NOT EXISTS action_history_owner_kind ON action_history(owner, kind, id)')


def history_settings(step):
    parts = urlsplit(step.get('url', '')).path.strip('/').split('/')
    if (step.get('method') != 'POST' or len(parts) != 6
            or parts[:2] != ['api', 'projects'] or parts[3:5] != ['instances', 'actions']):
        return None
    body = step.get('body') or {}
    if 'form' in step:
        try:
            body = json.loads(dict(step['form']).get('payload') or '{}')
        except (ValueError, TypeError):
            return None
    if not isinstance(body, dict):
        return None
    action = parts[-1]
    if action in {'guest_push', 'lxc_push'}:
        destination = body.get('destination', '')
        if not isinstance(destination, str) or not destination.strip().startswith('/'):
            return None
        names = body.get('relativePaths', [])
        return 'push', {
            'destination': destination.strip(),
            'selectionType': 'folder' if body.get('selectionType') == 'folder' else 'file',
            'ownerOnRemote': str(body.get('ownerOnRemote') or '').strip(),
            'filePermissions': str(body.get('filePermissions') or '').strip(),
            'sourceNames': [name for name in names if isinstance(name, str)] if isinstance(names, list) else [],
        }
    if action in {'guest_pull', 'lxc_pull'}:
        paths = body.get('paths')
        if isinstance(paths, list) and all(isinstance(path, str) for path in paths):
            paths = '\n'.join(paths)
        if not isinstance(paths, str) or not paths.strip():
            return None
        return 'pull', {'paths': paths.strip()}
    if action == 'run_stored_cmds':
        command = body.get('customCommand')
        if not isinstance(command, str) or not command.strip():
            return None
        timeout = body.get('customCommandTimeoutSeconds', 60)
        if type(timeout) is not int or not 1 <= timeout <= 86400:
            return None
        return 'custom', {'command': command.strip(), 'timeoutSeconds': timeout}
    return None


def remember(db, owner, kind, settings):
    encoded = json.dumps(settings, sort_keys=True, ensure_ascii=False)
    db.execute('DELETE FROM action_history WHERE owner=? AND kind=? AND settings=?', (owner, kind, encoded))
    db.execute('INSERT INTO action_history(owner,kind,settings,executed) VALUES (?,?,?,?)',
               (owner, kind, encoded, time.time()))
    db.execute('''DELETE FROM action_history WHERE owner=? AND kind=? AND id NOT IN
        (SELECT id FROM action_history WHERE owner=? AND kind=? ORDER BY id DESC LIMIT 5)''',
               (owner, kind, owner, kind))


def recent(db, owner, kind):
    return [{'id': row['id'], 'executedAt': row['executed'] * 1000,
             'settings': json.loads(row['settings'])}
            for row in db.execute('SELECT * FROM action_history WHERE owner=? AND kind=? ORDER BY id DESC LIMIT 5',
                                  (owner, kind))]
