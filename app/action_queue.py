"""Server-owned FIFO actions with coalesced inventory refreshes.

Failure refreshes take priority; successful refreshes follow pending project work.
HTTP threads only submit work or read its result.

SQLite arbitrates claims across WSGI processes. A worker drains accepted plans
without browser polling; request/session data is captured before acknowledging.
"""
import io
import base64
import json
import math
import os
import sqlite3
import tempfile
import shutil
import threading
import time
import zipfile
from contextlib import contextmanager, ExitStack
from urllib.parse import quote, unquote, urlsplit

from flask import Blueprint, Response, g, jsonify, request, session
from werkzeug.datastructures import MultiDict, FileStorage
from .queue_labels import queue_label, request_label
from .guest_push_batch import GuestPushBatch


class ActionQueue:
    def __init__(self, app):
        self.app = app
        self.path = os.path.join(app.config['DATA_DIR'], 'action_queue.sqlite3')
        self.upload_dir = os.path.join(app.config['DATA_DIR'], 'queue_uploads')
        os.makedirs(self.upload_dir, mode=0o700, exist_ok=True)
        self.lock = threading.Lock()
        self.thread = None
        self.stopped = threading.Event()
        with self.connect() as db:
            db.execute('''CREATE TABLE IF NOT EXISTS actions (
                id INTEGER PRIMARY KEY AUTOINCREMENT, owner TEXT NOT NULL,
                token TEXT NOT NULL, label TEXT NOT NULL, project TEXT NOT NULL,
                status TEXT NOT NULL, created REAL NOT NULL, started REAL, finished REAL,
                payload TEXT, result BLOB, code INTEGER, headers TEXT,
                error TEXT DEFAULT '', cancel INTEGER DEFAULT 0, worker INTEGER,
                dismissed INTEGER DEFAULT 0, step INTEGER DEFAULT 0, total_steps INTEGER DEFAULT 0,
                UNIQUE(owner, token))''')
            db.execute('''CREATE TABLE IF NOT EXISTS uploads (
                job INTEGER, name TEXT, filename TEXT, content_type TEXT, body BLOB)''')
            # Existing queues are migrated without dropping accepted work.
            db.execute('BEGIN IMMEDIATE')
            columns = {row['name'] for row in db.execute('PRAGMA table_info(actions)')}
            if 'progress_state' not in columns:
                db.execute("ALTER TABLE actions ADD COLUMN progress_state TEXT NOT NULL DEFAULT '{}'")
            upload_columns = {row['name'] for row in db.execute('PRAGMA table_info(uploads)')}
            if 'path' not in upload_columns:
                db.execute('ALTER TABLE uploads ADD COLUMN path TEXT')
        os.chmod(self.path, 0o600)

    @contextmanager
    def connect(self):
        db = sqlite3.connect(self.path, timeout=30)
        db.row_factory = sqlite3.Row
        db.execute('PRAGMA secure_delete=ON')
        try:
            with db:
                yield db
        finally:
            db.close()

    def start(self):
        with self.lock:
            if self.thread is None or not self.thread.is_alive():
                self.thread = threading.Thread(target=self.work, daemon=True, name='action-queue')
                self.thread.start()

    def close(self):
        self.stopped.set()
        if self.thread:
            self.thread.join(timeout=5)

    def submit(self, owner, plan, uploads):
        payload = json.dumps({'steps': plan['steps'], 'session': dict(session),
                              'api_key': request.headers.get('X-API-Key') or request.args.get('api_key')})
        staged = []
        try:
            # Copy in bounded chunks before taking SQLite's write lock.
            for name, file in uploads:
                with tempfile.NamedTemporaryFile(dir=self.upload_dir, delete=False) as target:
                    staged.append((name, file.filename, file.content_type, target.name))
                    shutil.copyfileobj(file.stream, target, length=1024 * 1024)
            with self.connect() as db:
                db.execute('''INSERT OR IGNORE INTO actions
                    (owner, token, label, project, status, created, payload, total_steps)
                    VALUES (?, ?, ?, ?, 'queued', ?, ?, ?)''',
                    (owner, plan['token'], queue_label(plan.get('label'), plan['steps']), plan.get('projectId', ''), time.time(), payload, len(plan['steps'])))
                inserted = db.execute('SELECT changes()').fetchone()[0]
                row = db.execute('SELECT * FROM actions WHERE owner=? AND token=?', (owner, plan['token'])).fetchone()
                if inserted:
                    for name, filename, content_type, path in staged:
                        db.execute('INSERT INTO uploads (job, name, filename, content_type, path) VALUES (?, ?, ?, ?, ?)',
                                   (row['id'], name, filename, content_type, path))
            if inserted:
                staged = []  # The accepted job now owns these files.
        finally:
            for _, _, _, path in staged:
                os.unlink(path)
        self.start()
        return row

    def delete_uploads(self, db, job_id):
        for row in db.execute('SELECT path FROM uploads WHERE job=?', (job_id,)):
            if row['path']:
                try:
                    os.unlink(row['path'])
                except FileNotFoundError:
                    pass
        db.execute('DELETE FROM uploads WHERE job=?', (job_id,))

    def claim(self):
        with self.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            running = db.execute("SELECT id, worker FROM actions WHERE status='running'").fetchall()
            for row in running:
                try:
                    os.kill(row['worker'], 0)
                    return None
                except ProcessLookupError:
                    db.execute("UPDATE actions SET status='error', error='Server worker stopped during execution; action was not replayed', finished=?, payload=NULL WHERE id=?", (time.time(), row['id']))
                    self.delete_uploads(db, row['id'])
            queued = db.execute("SELECT * FROM actions WHERE status='queued' ORDER BY id").fetchall()
            row = None
            # Failure refreshes run next. Successful operations share a refresh
            # after all accepted work for the affected project has finished.
            for candidate in queued:
                plan = json.loads(candidate['payload'])
                if plan.get('refreshImmediate'):
                    row = candidate
                    break
            if row is None:
                for candidate in queued:
                    plan = json.loads(candidate['payload'])
                    pid = plan.get('refreshProject')
                    if pid and any(
                        other['id'] != candidate['id'] and pid in self.refresh_targets(json.loads(other['payload'])['steps'])
                        for other in queued
                    ):
                        continue
                    row = candidate
                    break
            if row:
                db.execute("UPDATE actions SET status='running', started=?, worker=? WHERE id=?", (time.time(), os.getpid(), row['id']))
            return row

    @staticmethod
    def refresh_targets(steps):
        targets = {}
        for step in steps:
            parts = urlsplit(step['url']).path.strip('/').split('/')
            if (step.get('method') != 'POST' or len(parts) != 6
                    or parts[:2] != ['api', 'projects'] or parts[3:5] != ['instances', 'actions']
                    or parts[5] in {'cancel', 'status', 'create-preflight', 'retry-check'}):
                continue
            body = step.get('body') or {}
            if 'form' in step:
                try:
                    body = json.loads(dict(step['form']).get('payload') or '{}')
                except (ValueError, TypeError):
                    body = {}
            if not isinstance(body, dict):
                body = {}
            targets[unquote(parts[2])] = {key: body[key] for key in
                ('username', 'password', 'baseUrl', 'apiPort', 'verifySSL') if key in body}
        return targets

    def schedule_refreshes(self, row, payload, steps, failed):
        with self.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            for pid, auth in self.refresh_targets(steps).items():
                refresh_payload = {**payload, 'steps': [{
                    'method': 'POST', 'url': f'/api/projects/{quote(pid, safe="")}/instances/refresh/vm',
                    'body': {**auth, 'forceRefresh': True},
                }], 'refreshProject': pid, 'refreshImmediate': failed}
                existing = None
                for candidate in db.execute("SELECT * FROM actions WHERE owner=? AND project=? AND status='queued'", (row['owner'], pid)):
                    previous = json.loads(candidate['payload'])
                    if previous.get('refreshProject') == pid:
                        existing = candidate
                        refresh_payload['refreshImmediate'] |= bool(previous.get('refreshImmediate'))
                        break
                if existing:
                    db.execute('UPDATE actions SET payload=? WHERE id=?', (json.dumps(refresh_payload), existing['id']))
                else:
                    db.execute("""INSERT INTO actions
                        (owner, token, label, project, status, created, payload, total_steps)
                        VALUES (?, ?, ?, ?, 'queued', ?, ?, 1)""",
                        (row['owner'], f"refresh:{row['id']}:{pid}", f'Refresh VMs for project {pid}',
                         pid, time.time(), json.dumps(refresh_payload)))

    def progress_reporter(self, job_id, step_number):
        state = {}
        lock = threading.Lock()

        def report(fields):
            # Only publish display fields, never credentials, callbacks or logs.
            patch = {}
            for key in ('message', 'phase', 'current', 'transferDirection'):
                if key in fields:
                    patch[key] = str(fields[key] or '')[:1000]
            for key in ('progress', 'transferProgress'):
                if key in fields:
                    try:
                        value = float(fields[key])
                        patch[key] = max(0, min(100, value)) if math.isfinite(value) else None
                    except (TypeError, ValueError):
                        patch[key] = None
            for key in ('item_total', 'item_completed'):
                if key in fields:
                    try:
                        patch[key] = max(0, int(fields[key])) if fields[key] is not None else None
                    except (TypeError, ValueError, OverflowError):
                        patch[key] = None
            with lock:
                updated = {**state, **patch}
                if updated == state:
                    return
                # Late reports from a finished step cannot overwrite the next
                # step or turn a finished action back into a running one.
                with self.connect() as db:
                    db.execute("UPDATE actions SET progress_state=? WHERE id=? AND step=? AND status='running'",
                               (json.dumps(updated), job_id, step_number))
                state.update(updated)
        return report

    def wait_for_child(self, step, result, job_id, report):
        """Existing import/export endpoints launch their own in-process worker."""
        from .routes import api
        path = urlsplit(step['url']).path
        if not isinstance(result, dict) or not result.get('job'):
            return
        if path == '/api/projects/import/start':
            key = api._import_job_key(result['job'])
        elif path.endswith('/export/start'):
            from urllib.parse import unquote
            key = api._job_key(unquote(path.split('/')[3]))
        else:
            return
        while True:
            rec = api._ACTIVE_JOBS.get(key)
            if not rec or rec.get('id') != result['job']:
                raise ValueError('Background operation is no longer available')
            report({key: rec.get(key) for key in ('progress', 'message', 'current', 'item_total', 'item_completed')}
                   | {'phase': rec.get('phase') or rec.get('status')})
            state = rec.get('status')
            if state in {'completed', 'error', 'cancelled'}:
                if state == 'error':
                    raise ValueError('Background operation failed; see import/export logs')
                if state == 'cancelled':
                    with self.connect() as db:
                        db.execute('UPDATE actions SET cancel=1 WHERE id=?', (job_id,))
                return
            if self.cancelled(job_id) and state != 'finalizing':
                rec['cancel'] = True
            time.sleep(0.25)

    def cancelled(self, job_id):
        with self.connect() as db:
            return bool(db.execute('SELECT cancel FROM actions WHERE id=?', (job_id,)).fetchone()[0])

    def dispatch(self, step, payload, job_id, report, push_batch=None):
        headers = dict(step.get('headers') or {})
        if payload.get('api_key'):
            headers['X-API-Key'] = payload['api_key']
        kwargs = {'method': step['method'], 'headers': headers}
        with ExitStack() as stack:
            form, files = None, MultiDict()
            if 'form' in step:
                form = MultiDict(step['form'])
                with self.connect() as db:
                    for field, key in step.get('files', []):
                        file = db.execute('SELECT * FROM uploads WHERE job=? AND name=?', (job_id, key)).fetchone()
                        if file is None:
                            raise ValueError('Queued upload is missing')
                        stream = stack.enter_context(open(file['path'], 'rb') if file['path'] else io.BytesIO(file['body']))
                        files.add(field, FileStorage(stream, filename=file['filename'], content_type=file['content_type']))
            elif 'body' in step:
                kwargs['json'] = step['body']
            elif 'raw' in step:
                kwargs['data'] = step['raw']
            with self.app.test_request_context(step['url'], **kwargs):
                # Reuse the accepted form and streams without encoding and parsing
                # another multi-gigabyte multipart request in the worker.
                if form is not None:
                    request.form = form
                    request.files = files
                session.update(payload['session'])
                g.guest_push_batch = push_batch
                g.guest_push_upload_keys = tuple((field, key) for field, key in step.get('files', []))
                g.action_queue_cancelled = lambda: self.cancelled(job_id)
                g.action_queue_progress = report
                response = self.app.full_dispatch_request()
                response.direct_passthrough = False
                try:
                    body = response.get_data()
                    return response.status_code, dict(response.headers), body
                finally:
                    response.close()

    def execute(self, row):
        job_id = row['id']
        status, error = 'completed', ''
        code, headers, body = 200, {'Content-Type': 'application/json'}, b'{}'
        results = []
        partial_errors = False
        partial_error_message = 'VM creation reported errors; see results.'
        push_batch = GuestPushBatch()
        attempted_steps = []
        payload = json.loads(row['payload'])
        try:
            for index, step in enumerate(payload['steps']):
                if self.cancelled(job_id):
                    status = 'cancelled'
                    break
                with self.connect() as db:
                    db.execute("UPDATE actions SET step=?, progress_state='{}' WHERE id=?", (index + 1, job_id))
                report = self.progress_reporter(job_id, index + 1)
                if 'projectFromStep' in step:
                    previous = results[step['projectFromStep']]
                    project_id = previous.get('id') or previous.get('pid')
                    if not project_id:
                        raise ValueError('Project creation did not return an ID')
                    step = {**step, 'url': step['url'].replace('$project', quote(str(project_id), safe=''))}
                    with self.connect() as db:
                        db.execute('UPDATE actions SET project=? WHERE id=?', (str(project_id), job_id))
                operation = request_label(step['method'], step['url'], step.get('body'))
                report({'phase': 'starting', 'progress': None, 'current': '',
                        'message': f'Step {index + 1}/{len(payload["steps"])} · {operation}…'})
                attempted_steps.append(step)
                code, headers, body = self.dispatch(step, payload, job_id, report, push_batch)
                try:
                    result = json.loads(body)
                except (ValueError, UnicodeDecodeError):
                    result = None
                results.append(result)
                if code >= 400:
                    raise ValueError((result.get('error') if isinstance(result, dict) else None) or f'HTTP {code}')
                if isinstance(result, dict):
                    if result.get('ok') is False or result.get('ambiguous'):
                        raise ValueError('Operation reported errors or unresolved templates; see results')
                    if result.get('errors') or result.get('network_apply_errors'):
                        # Create can successfully provision guests and then fail
                        # a snapshot or network operation. Those guests still
                        # need the queued permissions and setup steps. Preserve
                        # the errors and finish the plan before reporting failure.
                        created_guests = result.get('created')
                        partial_create = (
                            step['method'] == 'POST'
                            and urlsplit(step['url']).path.endswith('/instances/actions/create')
                            and isinstance(created_guests, list) and bool(created_guests)
                        )
                        # Independent pull steps should all finish, retaining
                        # each project's archive even when some guests fail.
                        partial_pull = (
                            step['method'] == 'POST'
                            and urlsplit(step['url']).path.endswith(('/instances/actions/guest_pull', '/instances/actions/lxc_pull'))
                            and isinstance(result.get('outputs_zip'), dict)
                        )
                        if not partial_create and not partial_pull:
                            raise ValueError('Operation reported errors or unresolved templates; see results')
                        partial_errors = True
                        if partial_pull:
                            partial_error_message = 'Guest pull reported errors; see the summaries in the downloaded ZIP files.'
                self.wait_for_child(step, result, job_id, report)
            if partial_errors and status == 'completed':
                status, error = 'error', partial_error_message
        except Exception as exc:
            status, error = 'error', str(exc)
            self.app.logger.exception('Queued action %s failed', job_id)
        finally:
            push_batch.close()
            if len(json.loads(row['payload'])['steps']) > 1:
                body = json.dumps({'results': results}).encode()
                headers = {'Content-Type': 'application/json'}
            if self.cancelled(job_id):
                status, error = 'cancelled', ''
            self.schedule_refreshes(row, payload, attempted_steps, status != 'completed')
            with self.connect() as db:
                db.execute('''UPDATE actions SET status=?, finished=?, result=?, code=?, headers=?, error=?, payload=NULL WHERE id=?''',
                           (status, time.time(), body, code, json.dumps(headers), error, job_id))
                self.delete_uploads(db, job_id)

    def work(self):
        while not self.stopped.is_set():
            try:
                row = self.claim()
                if row:
                    self.execute(row)
                    continue
            except Exception:
                self.app.logger.exception('Action queue worker failed')
            self.stopped.wait(0.25)


def result_summary(row):
    """Human-readable history, including actions with empty or binary responses."""
    status = row['status']
    if status not in {'completed', 'error', 'cancelled'}:
        return ''
    outcome = {'completed': 'Completed', 'error': 'Failed', 'cancelled': 'Cancelled'}[status]
    summary = f"{outcome}: {queue_label(row['label']) or 'Action'}."
    if row['error']:
        summary += f" {row['error']}"
    try:
        result = json.loads(row['result'] or b'{}')
    except (ValueError, UnicodeDecodeError, TypeError):
        result = {}
    counts = {}
    messages = []

    def collect(value):
        if not isinstance(value, dict):
            return
        for key in ('created', 'updated', 'deleted', 'started', 'stopped',
                    'restarted', 'restored', 'skipped', 'errors', 'uploaded',
                    'downloaded', 'deleted_users', 'updated_users', 'deleted_pools'):
            entries = value.get(key)
            count = len(entries) if isinstance(entries, list) else entries
            if isinstance(count, int) and not isinstance(count, bool) and count > 0:
                counts[key] = counts.get(key, 0) + count
        message = value.get('message')
        if isinstance(message, str) and message.strip() and message not in messages:
            messages.append(message[:300])
        children = value.get('results')
        if isinstance(children, list):
            for child in children:
                collect(child)

    collect(result)
    if counts:
        summary += ' ' + '; '.join(f"{key.replace('_', ' ').capitalize()}: {count}" for key, count in counts.items()) + '.'
    elif messages:
        summary += ' ' + ' '.join(messages[:3])
    elif status == 'completed':
        total = row['total_steps']
        summary += f" {total} step{'s' if total != 1 else ''} completed successfully."
    return summary


def result_details(row):
    """Readable summary details from retained responses, never request credentials."""
    try:
        result = json.loads(row['result'] or b'{}')
    except (ValueError, UnicodeDecodeError, TypeError):
        return ''
    hidden = {'base64', 'password', 'passwd', 'vm_pass', 'proxmox_api_token',
              'token', 'api_key', 'secret', 'authorization', 'cookie', 'csrfpreventiontoken'}
    lines = []

    def render(value, indent=0):
        prefix = '  ' * indent
        if isinstance(value, dict):
            for key, item in value.items():
                if key.lower() in hidden or key in {'log', 'logs'}:
                    continue
                label = key.replace('_', ' ').capitalize()
                if isinstance(item, (dict, list)):
                    if item:
                        lines.append(f'{prefix}{label}:')
                        render(item, indent + 1)
                else:
                    text = '' if item is None else str(item)
                    lines.append(f'{prefix}{label}: {text}')
        elif isinstance(value, list):
            for index, item in enumerate(value, 1):
                if isinstance(item, (dict, list)):
                    lines.append(f'{prefix}- Item {index}:')
                    render(item, indent + 1)
                else:
                    lines.append(f'{prefix}- {item}')
        else:
            lines.append(f'{prefix}{value}')

    render(result)
    return '\n'.join(lines)


def result_log_sources(row):
    """Find retained logs without decoding archives during queue polling."""
    if row['status'] not in {'completed', 'error', 'cancelled'}:
        return []
    try:
        result = json.loads(row['result'] or b'{}')
    except (ValueError, UnicodeDecodeError, TypeError):
        return []
    sources = []

    def collect(value):
        if not isinstance(value, dict):
            return
        archive = value.get('outputs_zip')
        if (isinstance(archive, dict) and archive.get('base64')
                and str(archive.get('filename', '')).startswith(('stored_cmd_outputs_', 'startup_cmd_outputs_'))):
            sources.append(archive)
        for key in ('log', 'logs'):
            log = value.get(key)
            if isinstance(log, str) and log.strip():
                sources.append(log)
            elif isinstance(log, list) and log:
                sources.append('\n'.join(entry if isinstance(entry, str) else json.dumps(entry, ensure_ascii=False) for entry in log))
        children = value.get('results')
        if isinstance(children, list):
            for child in children:
                collect(child)

    collect(result)
    return sources


def public_record(row):
    detail = json.loads(row['progress_state'] or '{}')
    step_progress = detail.get('progress')
    progress = None
    if row['status'] == 'completed':
        progress = 100
    elif step_progress is not None and row['total_steps'] and row['step']:
        progress = round(100 * (row['step'] - 1 + step_progress / 100) / row['total_steps'], 1)
        progress = min(99, progress)
    return {'id': row['id'], 'label': queue_label(row['label']), 'projectId': row['project'],
            'status': row['status'], 'summary': result_summary(row), 'createdAt': row['created'] * 1000,
            'logUrl': f"/api/queue/{row['id']}/log" if row['status'] in {'completed', 'error', 'cancelled'} else None,
            'startedAt': row['started'] * 1000 if row['started'] else None,
            'finishedAt': row['finished'] * 1000 if row['finished'] else None,
            'cancelRequested': bool(row['cancel']), 'errorMessage': row['error'],
            'durationMs': (row['finished'] - row['started']) * 1000 if row['finished'] and row['started'] else None,
            'step': row['step'], 'totalSteps': row['total_steps'],
            'inventoryRefresh': str(row['token']).startswith('refresh:'),
            'progress': progress, 'stepProgress': step_progress,
            'message': detail.get('message', ''), 'phase': detail.get('phase', ''),
            'current': detail.get('current', ''),
            'itemTotal': detail.get('item_total'),
            'itemCompleted': detail.get('item_completed'),
            'transferProgress': detail.get('transferProgress'),
            'transferDirection': detail.get('transferDirection', ''),
            'exclusive': True, 'lockProject': True, 'server': True}


def init_action_queue(app):
    from .routes.api import _secure_route
    bp = Blueprint('action_queue', __name__)
    # Lazy initialization avoids opening worker threads before gunicorn forks.
    init_lock = threading.Lock()

    def queue():
        with init_lock:
            if 'action_queue' not in app.extensions:
                app.extensions['action_queue'] = ActionQueue(app)
            return app.extensions['action_queue']

    def owner():
        user = app.current_user() if app.config.get('AUTH_ENABLE') else None
        return str((user or {}).get('username', 'local')).lower()

    def record(job_id):
        with queue().connect() as db:
            return db.execute('SELECT * FROM actions WHERE id=? AND owner=?', (job_id, owner())).fetchone()

    @bp.route('', methods=['POST'])
    @_secure_route()
    def submit():
        try:
            plan = json.loads(request.form['plan']) if 'plan' in request.form else request.get_json()
            if not isinstance(plan, dict) or not isinstance(plan.get('steps'), list) or not plan['steps']:
                raise ValueError('A nonempty action plan is required')
            if not isinstance(plan.get('token'), str) or not 1 <= len(plan['token']) <= 200:
                raise ValueError('An idempotency token is required')
            for index, step in enumerate(plan['steps']):
                if 'projectFromStep' in step:
                    ref = step['projectFromStep']
                    if type(ref) is not int or ref < 0 or ref >= index or not step['url'].startswith('/api/projects/$project/'):
                        raise ValueError('Invalid project reference')
                url = urlsplit(step['url'])
                if (url.scheme or url.netloc or url.fragment or not url.path.startswith('/api/')
                        or url.path.startswith('/api/queue') or '\\' in step['url']):
                    raise ValueError('Only local API operations can be queued')
                step['method'] = step.get('method', 'POST').upper()
                if step['method'] not in {'GET', 'POST', 'PUT', 'PATCH', 'DELETE'}:
                    raise ValueError('Unsupported method')
                # Validate against the router; dispatch still enforces endpoint authorization.
                endpoint, _ = app.url_map.bind('').match(url.path, method=step['method'])
                if endpoint.startswith('action_queue.'):
                    raise ValueError('Queue operations cannot queue themselves')
                step['headers'] = {k: v for k, v in (step.get('headers') or {}).items()
                                   if k.lower() in {'content-type', 'accept'}}
            row = queue().submit(owner(), plan, list(request.files.items(multi=True)))
            return jsonify(public_record(row)), 202
        except (ValueError, KeyError, TypeError, AttributeError) as exc:
            return jsonify(error=str(exc)), 400

    @bp.route('', methods=['GET'])
    @_secure_route(api_key=False)
    def listing():
        q = queue()
        q.start()
        with q.connect() as db:
            rows = db.execute("SELECT * FROM actions WHERE owner=? AND dismissed=0 AND (status IN ('queued', 'running') OR id IN (SELECT id FROM actions WHERE owner=? AND dismissed=0 ORDER BY id DESC LIMIT 50)) ORDER BY id", (owner(), owner())).fetchall()
        return jsonify(items=[public_record(row) for row in rows])

    @bp.route('/<int:job_id>', methods=['GET'])
    @_secure_route(api_key=False)
    def status(job_id):
        row = record(job_id)
        return (jsonify(public_record(row)), 200) if row else (jsonify(error='not found'), 404)

    @bp.route('/<int:job_id>/result', methods=['GET'])
    @_secure_route(api_key=False)
    def result(job_id):
        row = record(job_id)
        if not row:
            return jsonify(error='not found'), 404
        if row['status'] in {'queued', 'running'}:
            return jsonify(error='Action is still pending'), 409
        headers = json.loads(row['headers'] or '{}')
        headers = {k: v for k, v in headers.items() if k.lower() in {'content-type', 'content-disposition', 'x-deployforge-auth-failure'}}
        return Response(row['result'] or b'{}', status=row['code'] or 200, headers=headers)

    @bp.route('/<int:job_id>/log', methods=['GET'])
    @_secure_route(api_key=False)
    def full_log(job_id):
        row = record(job_id)
        if not row:
            return jsonify(error='not found'), 404
        if row['status'] in {'queued', 'running'}:
            return jsonify(error='Action is still pending'), 409
        sections = [f"Queue item #{job_id} — {queue_label(row['label'])}",
                    f"Project: {row['project'] or '(none)'}", result_summary(row)]
        details = result_details(row)
        if details:
            sections.append('Summary details\n' + details)
        for source in result_log_sources(row):
            if isinstance(source, str):
                sections.append(source)
                continue
            try:
                with zipfile.ZipFile(io.BytesIO(base64.b64decode(source['base64'], validate=True))) as archive:
                    for entry in archive.infolist():
                        if not entry.is_dir() and entry.filename.endswith(('.txt', '.json')):
                            sections.append(f"=== {entry.filename} ===\n" + archive.read(entry).decode('utf-8', errors='replace'))
            except (ValueError, zipfile.BadZipFile, KeyError, RuntimeError):
                sections.append('The retained command output archive could not be read; summary details are preserved above.')
        headers = {'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff'}
        if request.args.get('download') == '1':
            headers['Content-Disposition'] = f'attachment; filename="queue-{job_id}-log.txt"'
        return Response('\n\n'.join(sections) + '\n', content_type='text/plain; charset=utf-8', headers=headers)

    @bp.route('/<int:job_id>/cancel', methods=['POST'])
    @_secure_route()
    def cancel(job_id):
        if not record(job_id):
            return jsonify(error='not found'), 404
        with queue().connect() as db:
            db.execute("UPDATE actions SET cancel=1, status=CASE WHEN status='queued' THEN 'cancelled' ELSE status END, payload=CASE WHEN status='queued' THEN NULL ELSE payload END, finished=CASE WHEN status='queued' THEN ? ELSE finished END WHERE id=? AND status IN ('queued','running')", (time.time(), job_id))
            if db.execute('SELECT status FROM actions WHERE id=?', (job_id,)).fetchone()['status'] == 'cancelled':
                queue().delete_uploads(db, job_id)
        return jsonify(status='cancel requested')

    @bp.route('/completed', methods=['DELETE'])
    @_secure_route()
    def clear_completed():
        # Keep IDs/tokens for retry deduplication; dismiss only this user's history.
        with queue().connect() as db:
            db.execute("UPDATE actions SET dismissed=1 WHERE owner=? AND status NOT IN ('queued','running')", (owner(),))
        return jsonify(status='ok')

    app.register_blueprint(bp, url_prefix='/api/queue')
