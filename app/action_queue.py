"""Server-owned FIFO actions. HTTP threads only submit work or read its result.

SQLite arbitrates claims across WSGI processes. A worker drains accepted plans
without browser polling; request/session data is captured before acknowledging.
"""
import io
import json
import math
import os
import sqlite3
import threading
import time
from contextlib import contextmanager
from urllib.parse import quote, urlsplit

from flask import Blueprint, Response, g, jsonify, request, session
from werkzeug.datastructures import MultiDict
from .queue_labels import queue_label, request_label


class ActionQueue:
    def __init__(self, app):
        self.app = app
        self.path = os.path.join(app.config['DATA_DIR'], 'action_queue.sqlite3')
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
        with self.connect() as db:
            db.execute('''INSERT OR IGNORE INTO actions
                (owner, token, label, project, status, created, payload, total_steps)
                VALUES (?, ?, ?, ?, 'queued', ?, ?, ?)''',
                (owner, plan['token'], queue_label(plan.get('label'), plan['steps']), plan.get('projectId', ''), time.time(), payload, len(plan['steps'])))
            inserted = db.execute('SELECT changes()').fetchone()[0]
            row = db.execute('SELECT * FROM actions WHERE owner=? AND token=?', (owner, plan['token'])).fetchone()
            if inserted:
                for name, file in uploads:
                    db.execute('INSERT INTO uploads VALUES (?, ?, ?, ?, ?)',
                               (row['id'], name, file.filename, file.content_type, file.read()))
        self.start()
        return row

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
                    db.execute('DELETE FROM uploads WHERE job=?', (row['id'],))
            row = db.execute("SELECT * FROM actions WHERE status='queued' ORDER BY id LIMIT 1").fetchone()
            if row:
                db.execute("UPDATE actions SET status='running', started=?, worker=? WHERE id=?", (time.time(), os.getpid(), row['id']))
            return row

    def progress_reporter(self, job_id, step_number):
        state = {}
        lock = threading.Lock()

        def report(fields):
            # Only publish display fields, never credentials, callbacks or logs.
            patch = {}
            for key in ('message', 'phase', 'current'):
                if key in fields:
                    patch[key] = str(fields[key] or '')[:1000]
            if 'progress' in fields:
                try:
                    value = float(fields['progress'])
                    patch['progress'] = max(0, min(100, value)) if math.isfinite(value) else None
                except (TypeError, ValueError):
                    patch['progress'] = None
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
            report({key: rec.get(key) for key in ('progress', 'message', 'current')}
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

    def dispatch(self, step, payload, job_id, report):
        headers = dict(step.get('headers') or {})
        if payload.get('api_key'):
            headers['X-API-Key'] = payload['api_key']
        kwargs = {'method': step['method'], 'headers': headers}
        if 'form' in step:
            data = MultiDict(step['form'])
            with self.connect() as db:
                for field, key in step.get('files', []):
                    file = db.execute('SELECT * FROM uploads WHERE job=? AND name=?', (job_id, key)).fetchone()
                    if file is None:
                        raise ValueError('Queued upload is missing')
                    data.add(field, (io.BytesIO(file['body']), file['filename'], file['content_type']))
            kwargs['data'] = data
        elif 'body' in step:
            kwargs['json'] = step['body']
        elif 'raw' in step:
            kwargs['data'] = step['raw']
        with self.app.test_request_context(step['url'], **kwargs):
            session.update(payload['session'])
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
        try:
            payload = json.loads(row['payload'])
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
                code, headers, body = self.dispatch(step, payload, job_id, report)
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
                        if not partial_create:
                            raise ValueError('Operation reported errors or unresolved templates; see results')
                        partial_errors = True
                self.wait_for_child(step, result, job_id, report)
            if partial_errors and status == 'completed':
                status, error = 'error', 'VM creation reported errors; see results.'
        except Exception as exc:
            status, error = 'error', str(exc)
            self.app.logger.exception('Queued action %s failed', job_id)
        finally:
            if len(json.loads(row['payload'])['steps']) > 1:
                body = json.dumps({'results': results}).encode()
                headers = {'Content-Type': 'application/json'}
            if self.cancelled(job_id) and status == 'completed':
                status = 'cancelled'
            with self.connect() as db:
                db.execute('''UPDATE actions SET status=?, finished=?, result=?, code=?, headers=?, error=?, payload=NULL WHERE id=?''',
                           (status, time.time(), body, code, json.dumps(headers), error, job_id))
                db.execute('DELETE FROM uploads WHERE job=?', (job_id,))

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
            'status': row['status'], 'createdAt': row['created'] * 1000,
            'startedAt': row['started'] * 1000 if row['started'] else None,
            'finishedAt': row['finished'] * 1000 if row['finished'] else None,
            'cancelRequested': bool(row['cancel']), 'errorMessage': row['error'],
            'durationMs': (row['finished'] - row['started']) * 1000 if row['finished'] and row['started'] else None,
            'step': row['step'], 'totalSteps': row['total_steps'],
            'progress': progress, 'stepProgress': step_progress,
            'message': detail.get('message', ''), 'phase': detail.get('phase', ''),
            'current': detail.get('current', ''),
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

    @bp.route('/<int:job_id>/cancel', methods=['POST'])
    @_secure_route()
    def cancel(job_id):
        if not record(job_id):
            return jsonify(error='not found'), 404
        with queue().connect() as db:
            db.execute("UPDATE actions SET cancel=1, status=CASE WHEN status='queued' THEN 'cancelled' ELSE status END, payload=CASE WHEN status='queued' THEN NULL ELSE payload END, finished=CASE WHEN status='queued' THEN ? ELSE finished END WHERE id=? AND status IN ('queued','running')", (time.time(), job_id))
            db.execute("DELETE FROM uploads WHERE job=? AND EXISTS (SELECT 1 FROM actions WHERE id=? AND status='cancelled')", (job_id, job_id))
        return jsonify(status='cancel requested')

    @bp.route('/completed', methods=['DELETE'])
    @_secure_route()
    def clear_completed():
        # Keep IDs/tokens for retry deduplication; dismiss only this user's history.
        with queue().connect() as db:
            db.execute("UPDATE actions SET dismissed=1 WHERE owner=? AND status NOT IN ('queued','running')", (owner(),))
        return jsonify(status='ok')

    app.register_blueprint(bp, url_prefix='/api/queue')
