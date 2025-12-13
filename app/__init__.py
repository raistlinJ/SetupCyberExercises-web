import os
import tempfile
from flask import Flask, send_from_directory


def create_app():
    app = Flask(__name__, static_folder="static", static_url_path="/static")
    # Capture env-provided secret key (persisted later once DATA_DIR is known)
    env_secret_key = os.environ.get('SECRET_KEY')
    # Enable DEBUG logging so we can emit detailed export command traces
    try:
        import logging
        app.logger.setLevel(logging.DEBUG)
    except Exception:
        pass

    # Toggle for verbose ACL troubleshooting logs (default off)
    # Set environment variable ACL_DEBUG=1 to re-enable detailed ACL logging.
    try:
        app.config['ACL_DEBUG'] = bool(int(os.environ.get('ACL_DEBUG', '0')))
    except Exception:
        app.config['ACL_DEBUG'] = False

    # Optional request body size cap (disabled by default).
    # If you need a limit, set MAX_CONTENT_MB to a positive integer.
    try:
        raw_max_mb = os.environ.get('MAX_CONTENT_MB')
        if raw_max_mb is not None:
            max_mb = int(raw_max_mb)
            if max_mb > 0:
                app.config['MAX_CONTENT_LENGTH'] = max_mb * 1024 * 1024
    except Exception:
        pass

    # Optional simple API key (shared secret) for all modifying endpoints
    app.config['API_KEY'] = os.environ.get('API_KEY') or None

    # Basic auth/authorization config
    app.config['AUTH_ENABLE'] = bool(int(os.environ.get('AUTH_ENABLE', '1')))  # toggle
    # Comma-separated admin usernames (case-insensitive)
    app.config['ADMIN_USERS'] = [u.strip() for u in os.environ.get('ADMIN_USERS','').split(',') if u.strip()]

    # Persistent user store (JSON) - simple, not for production scale
    # Wrap Werkzeug helpers to always use PBKDF2 (portable) and to provide a single import site
    from werkzeug.security import generate_password_hash as _w_generate_password_hash, check_password_hash as _w_check_password_hash
    import json, threading
    _USERS_LOCK = threading.Lock()
    _USERS_FILE = os.environ.get('USERS_FILE')  # allow override before DATA_DIR known; if relative will join later
    _USERS = {}

    # Always use PBKDF2 for new/updated password hashes to avoid environments lacking hashlib.scrypt
    def _gen_pw_hash(password: str) -> str:
        return _w_generate_password_hash(password, method='pbkdf2:sha256')

    def _check_pw_hash(pwhash: str, password: str) -> bool:
        # Delegate to Werkzeug; callers should have ensured any unsupported hashes were migrated
        try:
            return _w_check_password_hash(pwhash, password)
        except AttributeError:
            # e.g., hashlib.scrypt missing on this Python build
            return False

    def _users_path():
        base_dir = app.config.get('DATA_DIR') or os.getcwd()
        path = _USERS_FILE or os.path.join(base_dir, 'users.json')
        if not os.path.isabs(path):
            path = os.path.join(base_dir, path)
        return path

    def _load_users():
        path = _users_path()
        if not os.path.exists(path):
            return
        try:
            with open(path, 'r', encoding='utf-8') as f:
                data = json.load(f)
            users = data.get('users') if isinstance(data, dict) else data
            if isinstance(users, list):
                for rec in users:
                    try:
                        uname = str(rec.get('username') or '').strip()
                        ph = rec.get('password_hash') or ''
                        roles = rec.get('roles') or []
                        must_change = bool(rec.get('must_change', False))
                        if uname and ph and isinstance(roles, list):
                            _USERS[uname.lower()] = { 'username': uname, 'password_hash': ph, 'roles': roles, 'must_change': must_change }
                    except Exception:
                        continue
        except Exception as e:
            try:
                app.logger.error('Failed loading users.json: %s', e)
            except Exception:
                pass

    def _migrate_unsupported_hashes_if_needed():
        """
        If the environment doesn't support scrypt (hashlib.scrypt missing) but stored users
        have scrypt-based hashes (e.g., 'scrypt:...'), migrate them to PBKDF2 by assigning
        a temporary password and forcing password change on next login. Details are logged
        and written to DATA_DIR/password_resets.txt.
        """
        import hashlib, secrets, time
        try:
            force = bool(int(os.environ.get('FORCE_PWHASH_MIGRATION', '0')))
        except Exception:
            force = False
        try:
            if hasattr(hashlib, 'scrypt') and not force:
                return  # nothing to do
        except Exception:
            # In the unlikely event hashlib itself fails, proceed with migration for safety
            pass

        resets = []
        changed = False
        for key, rec in list(_USERS.items()):
            try:
                ph = rec.get('password_hash') or ''
                if isinstance(ph, str) and ph.startswith('scrypt:'):
                    # Determine a temporary password
                    uname = rec.get('username') or ''
                    if uname.lower() == 'setupadmin':
                        temp = os.environ.get('SETUPADMIN_TEMP_PASS') or 'setupadmin'
                    else:
                        alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#-_=+'
                        temp = ''.join(secrets.choice(alphabet) for _ in range(12))
                    rec['password_hash'] = _gen_pw_hash(temp)
                    rec['must_change'] = True
                    resets.append((uname, temp))
                    changed = True
            except Exception:
                continue
        if changed:
            _save_users()
            try:
                app.logger.warning("Migrated %d user(s) from unsupported 'scrypt' hashes to PBKDF2. Temporary passwords written to password_resets.txt.", len(resets))
            except Exception:
                pass
            try:
                outp = os.path.join(app.config.get('DATA_DIR') or os.getcwd(), 'password_resets.txt')
                with open(outp, 'a', encoding='utf-8') as f:
                    f.write(f"# {time.strftime('%Y-%m-%d %H:%M:%S')} auto-migration due to missing hashlib.scrypt\n")
                    for u, p in resets:
                        f.write(f"{u}:{p}\n")
            except Exception as e:
                try:
                    app.logger.error('Failed writing password_resets.txt: %s', e)
                except Exception:
                    pass

    def _save_users():
        path = _users_path()
        try:
            tmp = path + '.tmp'
            payload = { 'users': list(_USERS.values()) }
            with open(tmp, 'w', encoding='utf-8') as f:
                json.dump(payload, f, indent=2)
            os.replace(tmp, path)
        except Exception as e:
            try:
                app.logger.error('Failed saving users.json: %s', e)
            except Exception:
                pass

    # Load existing users (after DATA_DIR assignment later we might re-load, so guard duplicate)
    # We'll defer initial load until after DATA_DIR configured; store a flag.
    _USERS_LOADED = False

    def _ensure_users_loaded():
        nonlocal _USERS_LOADED
        if _USERS_LOADED:
            return
        with _USERS_LOCK:
            if _USERS_LOADED:
                return
            _load_users()
            # If needed, migrate any unsupported hashes (e.g., scrypt) to PBKDF2
            _migrate_unsupported_hashes_if_needed()
            # Seed admin (env-provided)
            seed_admin = os.environ.get('SEED_ADMIN_USER')
            seed_pass = os.environ.get('SEED_ADMIN_PASS')
            if seed_admin and seed_pass and seed_admin.lower() not in _USERS:
                _USERS[seed_admin.lower()] = {
                    'username': seed_admin,
                    'password_hash': _gen_pw_hash(seed_pass),
                    'roles': ['admin'],
                    'must_change': False
                }
                try: app.logger.warning("Seeded admin user '%s' from environment", seed_admin)
                except Exception: pass
                _save_users()
            # If still no users, create default setupadmin/setupadmin that must change password
            if not _USERS:
                _USERS['setupadmin'] = {
                    'username': 'setupadmin',
                    'password_hash': _gen_pw_hash('setupadmin'),
                    'roles': ['admin'],
                    'must_change': True
                }
                try: app.logger.warning("Created default 'setupadmin' user with temporary password. CHANGE IT IMMEDIATELY.")
                except Exception: pass
                _save_users()
            _USERS_LOADED = True

    # Attach auth helpers
    from functools import wraps
    from flask import session, abort, jsonify, request

    def _current_user_record():
        _ensure_users_loaded()
        uname = session.get('user')
        if not uname:
            return None
        key = str(uname).lower()
        rec = _USERS.get(key)
        if rec:
            return rec
        # Fallback: treat configured ADMIN_USERS as admins only if they already exist (we don't want passwordless login)
        # So just return None here to force proper stored user usage.
        return None

    def current_user():
        rec = _current_user_record()
        if not rec:
            return None
        return {'username': rec['username'], 'roles': rec.get('roles', []), 'must_change': bool(rec.get('must_change'))}
    app.current_user = current_user

    def login_required(fn):
        @wraps(fn)
        def inner(*args, **kwargs):
            if not app.config.get('AUTH_ENABLE'):
                return fn(*args, **kwargs)
            if not _current_user_record():
                return jsonify({'error': 'authentication required'}), 401
            return fn(*args, **kwargs)
        return inner
    app.login_required = login_required

    def roles_required(*roles):
        def deco(fn):
            @wraps(fn)
            def inner(*args, **kwargs):
                if not app.config.get('AUTH_ENABLE'):
                    return fn(*args, **kwargs)
                rec = _current_user_record()
                if not rec:
                    return jsonify({'error': 'authentication required'}), 401
                have = set([r.lower() for r in rec.get('roles', [])])
                need = {r.lower() for r in roles}
                if not need.intersection(have):
                    return jsonify({'error': 'forbidden'}), 403
                return fn(*args, **kwargs)
            return inner
        return deco
    app.roles_required = roles_required

    # Public auth endpoints blueprint (lightweight inline to avoid new file)
    from flask import Blueprint
    auth_bp = Blueprint('auth', __name__)

    @auth_bp.route('/login', methods=['POST'])
    def login():
        try:
            if not app.config.get('AUTH_ENABLE'):
                return jsonify({'error': 'auth disabled'}), 400
            try:
                data = request.get_json(force=True) or {}
            except Exception:
                data = {}
            uname = str(data.get('username') or '').strip()
            passwd = str(data.get('password') or '')
            if not uname or not passwd:
                return jsonify({'error': 'missing credentials'}), 400
            _ensure_users_loaded()
            rec = _USERS.get(uname.lower())
            if not rec:
                return jsonify({'error': 'invalid credentials'}), 401
            if not _check_pw_hash(rec['password_hash'], passwd):
                return jsonify({'error': 'invalid credentials'}), 401
            session['user'] = rec['username']
            try:
                session.permanent = bool(app.config.get('SESSION_ENABLE_PERMANENT', True))
            except Exception:
                pass
            return jsonify({'user': current_user(), 'auth_enabled': True })
        except Exception as e:
            try:
                app.logger.exception('Auth login failed')
            except Exception:
                pass
            return jsonify({'error': 'internal', 'message': str(e)}), 500

    @auth_bp.route('/logout', methods=['POST'])
    def logout():
        session.pop('user', None)
        return jsonify({'status': 'ok'})

    @auth_bp.route('/me', methods=['GET'])
    def me():
        _ensure_users_loaded()
        return jsonify({'user': current_user(), 'auth_enabled': app.config.get('AUTH_ENABLE')})

    # Admin: create a user (admin role required)
    @auth_bp.route('/users', methods=['POST'])
    def create_user():
        if not app.config.get('AUTH_ENABLE'):
            return jsonify({'error': 'auth disabled'}), 400
        # Must already be logged in and be admin
        rec = _current_user_record()
        if not rec:
            return jsonify({'error': 'authentication required'}), 401
        if 'admin' not in [r.lower() for r in rec.get('roles', [])]:
            return jsonify({'error': 'forbidden'}), 403
        try:
            data = request.get_json(force=True) or {}
        except Exception:
            data = {}
        uname = str(data.get('username') or '').strip()
        passwd = str(data.get('password') or '')
        roles = data.get('roles') or []
        must_change = bool(data.get('must_change', False))
        # Validation helpers
        import re
        def _username_valid(u: str):
            return bool(re.fullmatch(r'[A-Za-z0-9_.-]{3,32}', u or ''))
        def _password_valid(p: str, username: str):
            # Minimum 8, must contain at least 3 of 4 classes, cannot contain username (>=3 chars segment)
            if len(p) < 8:
                return False, 'password too short (min 8)'
            classes = sum([bool(re.search(r'[a-z]', p)), bool(re.search(r'[A-Z]', p)), bool(re.search(r'\d', p)), bool(re.search(r'[^A-Za-z0-9]', p))])
            if classes < 3:
                return False, 'password must include 3 of: lower, upper, digit, symbol'
            if username and len(username) >= 3 and username.lower() in p.lower():
                return False, 'password must not contain username'
            weak = {'password','admin','administrator','123456','qwerty','setupadmin'}
            if p.lower() in weak:
                return False, 'password too common'
            return True, ''
        if not uname:
            return jsonify({'error': 'missing username'}), 400
        if not passwd:
            return jsonify({'error': 'missing password'}), 400
        if not _username_valid(uname):
            return jsonify({'error': 'invalid username (3-32 chars: A-Z a-z 0-9 _ . -)'}), 400
        ok_pw, msg_pw = _password_valid(passwd, uname)
        if not ok_pw:
            return jsonify({'error': msg_pw}), 400
        if not isinstance(roles, list):
            return jsonify({'error': 'roles must be list'}), 400
        # Only allow known roles
        allowed_roles = {'admin'}
        for r in roles:
            if r.lower() not in allowed_roles:
                return jsonify({'error': f'invalid role: {r}'}), 400
        _ensure_users_loaded()
        if uname.lower() in _USERS:
            return jsonify({'error': 'user exists'}), 409
        with _USERS_LOCK:
            _USERS[uname.lower()] = { 'username': uname, 'password_hash': _gen_pw_hash(passwd), 'roles': roles, 'must_change': must_change }
            _save_users()
        return jsonify({'created': uname, 'count': len(_USERS)})

    # List users (admin)
    @auth_bp.route('/users', methods=['GET'])
    def list_users():
        if not app.config.get('AUTH_ENABLE'):
            return jsonify({'error': 'auth disabled'}), 400
        rec = _current_user_record()
        if not rec:
            return jsonify({'error': 'authentication required'}), 401
        if 'admin' not in [r.lower() for r in rec.get('roles', [])]:
            return jsonify({'error': 'forbidden'}), 403
        _ensure_users_loaded()
        users = [ {'username': u['username'], 'roles': u.get('roles', []), 'must_change': bool(u.get('must_change')) } for u in _USERS.values() ]
        return jsonify({'users': users, 'count': len(users)})

    # Update user (password / roles / must_change)
    @auth_bp.route('/users/<username>', methods=['PATCH'])
    def update_user(username):
        if not app.config.get('AUTH_ENABLE'):
            return jsonify({'error': 'auth disabled'}), 400
        actor = _current_user_record()
        if not actor:
            return jsonify({'error': 'authentication required'}), 401
        target_key = (username or '').lower()
        _ensure_users_loaded()
        if target_key not in _USERS:
            return jsonify({'error': 'not found'}), 404
        is_admin = 'admin' in [r.lower() for r in actor.get('roles', [])]
        if not is_admin and target_key != actor['username'].lower():
            return jsonify({'error': 'forbidden'}), 403
        try:
            data = request.get_json(force=True) or {}
        except Exception:
            data = {}
        changed = False
        with _USERS_LOCK:
            targ = _USERS[target_key]
            new_pass = data.get('password')
            if new_pass:
                import re
                def _password_valid(p: str, username: str):
                    if len(p) < 8: return False, 'password too short (min 8)'
                    classes = sum([bool(re.search(r'[a-z]', p)), bool(re.search(r'[A-Z]', p)), bool(re.search(r'\d', p)), bool(re.search(r'[^A-Za-z0-9]', p))])
                    if classes < 3: return False, 'password must include 3 of: lower, upper, digit, symbol'
                    if username and len(username) >=3 and username.lower() in p.lower(): return False, 'password must not contain username'
                    weak={'password','admin','administrator','123456','qwerty','setupadmin'}
                    if p.lower() in weak: return False, 'password too common'
                    return True, ''
                ok_pw, msg_pw = _password_valid(str(new_pass), targ['username'])
                if not ok_pw:
                    return jsonify({'error': msg_pw}), 400
                targ['password_hash'] = _gen_pw_hash(str(new_pass))
                targ['must_change'] = False
                changed = True
            if is_admin and 'roles' in data:
                roles = data.get('roles')
                if isinstance(roles, list):
                    allowed_roles = {'admin'}
                    for r in roles:
                        if r.lower() not in allowed_roles:
                            return jsonify({'error': f'invalid role: {r}'}), 400
                    targ['roles'] = roles
                    changed = True
            if is_admin and 'must_change' in data:
                targ['must_change'] = bool(data.get('must_change'))
                changed = True
            if changed:
                _save_users()
            view = {'username': targ['username'], 'roles': targ.get('roles', []), 'must_change': bool(targ.get('must_change'))}
        # If current user changed own password, keep session (already ok)
        return jsonify({'updated': view})

    # Delete user
    @auth_bp.route('/users/<username>', methods=['DELETE'])
    def delete_user(username):
        if not app.config.get('AUTH_ENABLE'):
            return jsonify({'error': 'auth disabled'}), 400
        actor = _current_user_record()
        if not actor:
            return jsonify({'error': 'authentication required'}), 401
        if 'admin' not in [r.lower() for r in actor.get('roles', [])]:
            return jsonify({'error': 'forbidden'}), 403
        target_key = (username or '').lower()
        _ensure_users_loaded()
        with _USERS_LOCK:
            if target_key not in _USERS:
                return jsonify({'error': 'not found'}), 404
            # Prevent deleting last admin
            admins = [u for u in _USERS.values() if 'admin' in [r.lower() for r in u.get('roles', [])]]
            targ = _USERS[target_key]
            if 'admin' in [r.lower() for r in targ.get('roles', [])] and len(admins) <= 1:
                return jsonify({'error': 'cannot delete last admin'}), 400
            del _USERS[target_key]
            _save_users()
        return jsonify({'deleted': username})

    app.register_blueprint(auth_bp, url_prefix='/auth')

    # Provide a small helper to validate paths stay within DATA_DIR
    def _safe_join_data(*parts):
        base = app.config['DATA_DIR']
        import os
        candidate = os.path.realpath(os.path.join(base, *parts))
        if not candidate.startswith(os.path.realpath(base) + os.sep):
            raise ValueError('unsafe path outside data dir')
        return candidate
    app.safe_data_path = _safe_join_data  # attach helper

    # Decorator for API key enforcement (import locally to avoid circular imports)
    from functools import wraps
    def require_api_key(fn):
        @wraps(fn)
        def wrapper(*args, **kwargs):
            key = app.config.get('API_KEY')
            if key:
                from flask import request, jsonify
                supplied = request.headers.get('X-API-Key') or request.args.get('api_key')
                if supplied != key:
                    return jsonify({ 'error': 'invalid or missing API key' }), 401
            return fn(*args, **kwargs)
        return wrapper
    app.require_api_key = require_api_key

    # Data directory for persistent storage (projects, materials)
    # Prefer env var DATA_DIR; if not set or not writable, fall back to local project data folder,
    # and finally to a temp directory. This avoids read-only FS errors during local dev.
    env_data_dir = os.environ.get("DATA_DIR")

    def try_init_dir(path: str):
        try:
            os.makedirs(path, exist_ok=True)
            os.makedirs(os.path.join(path, "materials"), exist_ok=True)
            return True
        except OSError:
            return False

    chosen = None
    candidates = []
    if env_data_dir:
        candidates.append(env_data_dir)
    # project-root/data
    project_root = os.path.abspath(os.path.join(os.path.dirname(__file__), os.pardir))
    candidates.append(os.path.join(project_root, "data"))
    # last resort: temp dir
    candidates.append(os.path.join(tempfile.gettempdir(), "toolhub-data"))

    for c in candidates:
        if try_init_dir(c):
            chosen = c
            # log if we had to fall back from env
            if env_data_dir and os.path.abspath(c) != os.path.abspath(env_data_dir):
                app.logger.warning("DATA_DIR '%s' not usable; falling back to '%s'", env_data_dir, c)
            break

    if not chosen:
        # As a last-ditch effort, raise a clear error
        raise OSError("Unable to initialize a writable DATA_DIR from candidates: %r" % candidates)

    app.config["DATA_DIR"] = chosen

    # Finalize secret key configuration: prefer explicit env, else persist within DATA_DIR
    secret_key = env_secret_key
    if not secret_key:
        try:
            secret_file = os.path.join(app.config["DATA_DIR"], "secret.key")
            if os.path.exists(secret_file):
                with open(secret_file, 'r', encoding='utf-8') as fh:
                    secret_key = fh.read().strip()
            if not secret_key:
                import secrets
                secret_key = secrets.token_hex(32)
                with open(secret_file, 'w', encoding='utf-8') as fh:
                    fh.write(secret_key)
        except Exception:
            secret_key = None
    if not secret_key:
        secret_key = os.urandom(32)
    try:
        app.secret_key = secret_key
    except Exception:
        pass

    # Session lifetime tuning (default 12 hours, override via SESSION_LIFETIME_HOURS)
    from datetime import timedelta
    try:
        lifetime_hours = int(os.environ.get('SESSION_LIFETIME_HOURS', '12'))
    except Exception:
        lifetime_hours = 12
    if lifetime_hours > 0:
        app.permanent_session_lifetime = timedelta(hours=lifetime_hours)
        app.config['SESSION_ENABLE_PERMANENT'] = True
    else:
        # Treat zero/negative as "session-only" (cookie tied to browser session)
        app.permanent_session_lifetime = timedelta(hours=12)
        app.config['SESSION_ENABLE_PERMANENT'] = False
    app.config.setdefault('SESSION_COOKIE_NAME', 'an3s_session')
    # If users were loaded before DATA_DIR was set (pointed to CWD), attempt migration
    try:
        users_rel = os.path.join(os.getcwd(), 'users.json')
        users_target = os.path.join(app.config["DATA_DIR"], 'users.json')
        if os.path.exists(users_rel) and not os.path.exists(users_target):
            import shutil
            shutil.copy2(users_rel, users_target)
            app.logger.warning("Migrated users.json from working directory to DATA_DIR")
    except Exception:
        pass

    # Register blueprints
    from .routes.api import api_bp
    app.register_blueprint(api_bp, url_prefix="/api")

    @app.route("/")
    def index():
        return send_from_directory(app.static_folder, "index.html")

    return app


if __name__ == "__main__":
    # Run with a production WSGI server when executed directly
    from waitress import serve
    app = create_app()
    port = int(os.environ.get("PORT", "8080"))
    def _env_int(name: str, default: int) -> int:
        try:
            value = os.environ.get(name)
            if value is None:
                return default
            parsed = int(value)
            return parsed
        except Exception:
            return default

    def _waitress_body_cap() -> int:
        # Default to unlimited unless explicitly capped.
        default_cap = 0
        cap = _env_int("WAITRESS_MAX_REQUEST_BODY", default_cap)
        if cap == 0:
            return (2**63) - 1
        if cap < 0:
            return 50 * 1024 * 1024 * 1024
        return cap

    serve(
        app,
        host="0.0.0.0",
        port=port,
        max_request_body_size=_waitress_body_cap(),
        inbuf_overflow=_env_int("WAITRESS_INBUF_OVERFLOW", 512 * 1024 * 1024),
        outbuf_overflow=_env_int("WAITRESS_OUTBUF_OVERFLOW", 512 * 1024 * 1024),
    )
