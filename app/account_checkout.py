"""Optional one-way AccessForge connector: publish credentials and request status."""
import hashlib
import ipaddress
import json
import os
import sqlite3
import time
import uuid
from contextlib import contextmanager
from urllib.parse import quote, unquote, urlsplit, urlunsplit

import requests
from flask import Blueprint, current_app, jsonify, request

from .storage.secrets import encrypt_str, decrypt_str


class AccessForgeError(Exception):
    def __init__(self,message,status=400):
        self.message,self.status=message,status


CHECKOUT_POLICY_DEFAULTS = {
    'allowed_email_patterns': [], 'allowed_subnets': [], 'subnet_checkout_limit': 0,
    'ipv4_prefix': 24, 'ipv6_prefix': 64, 'global_delay_seconds': 0, 'subnet_delay_seconds': 0,
}


def validate_checkout_policy(value):
    if not isinstance(value, dict) or set(value)-CHECKOUT_POLICY_DEFAULTS.keys():
        raise AccessForgeError('Provide valid checkout policy settings.')
    result = {**CHECKOUT_POLICY_DEFAULTS, **value}
    for key, maximum in [('subnet_checkout_limit', 2000), ('ipv4_prefix', 32), ('ipv6_prefix', 128),
                         ('global_delay_seconds', 604800), ('subnet_delay_seconds', 604800)]:
        if type(result[key]) is not int or not 0 <= result[key] <= maximum:
            raise AccessForgeError(f'{key} must be a whole number between 0 and {maximum}.')
    for key in ('allowed_email_patterns', 'allowed_subnets'):
        entries = result[key]
        if not isinstance(entries, list) or len(entries) > 50 or any(not isinstance(v, str) for v in entries):
            raise AccessForgeError(f'{key} must contain at most 50 entries.')
        normalized = []
        for entry in entries:
            entry = entry.strip().casefold()
            if key == 'allowed_email_patterns':
                if not 3 <= len(entry) <= 254 or entry.count('@') != 1 or not all(entry.split('@')) or any(c.isspace() or ord(c)<32 or c in '<>[],;\\' for c in entry):
                    raise AccessForgeError('Use email patterns such as *@example.edu; * matches any text and ? matches one character.')
            else:
                try:
                    entry = str(ipaddress.ip_network(entry, strict=False))
                except ValueError:
                    raise AccessForgeError('Allowed checkout networks must be valid IPv4 or IPv6 CIDRs.') from None
            if entry not in normalized:
                normalized.append(entry)
        result[key] = normalized
    return result


def canonical_username(value):
    return value if '@' in value else value+'@pve'


class ConnectionStore:
    def __init__(self):
        self.path=os.path.join(current_app.config['DATA_DIR'],'accessforge_connections.sqlite3')
        with self.connect() as db:
            db.executescript('''
                CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY,value TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS connections (
                    owner TEXT NOT NULL,pid TEXT NOT NULL,url TEXT NOT NULL,username TEXT NOT NULL,password_enc TEXT NOT NULL,
                    verify_ssl INTEGER NOT NULL,summary TEXT,checked_at REAL,migrated TEXT NOT NULL DEFAULT '[]',
                    PRIMARY KEY(owner,pid));
                CREATE TABLE IF NOT EXISTS credential_types (
                    pid TEXT NOT NULL,username TEXT NOT NULL,on_demand INTEGER NOT NULL,
                    updated_at REAL NOT NULL DEFAULT 0,PRIMARY KEY(pid,username));
            ''')
            db.execute('INSERT OR IGNORE INTO metadata VALUES(?,?)',('source',uuid.uuid4().hex))
            if not db.execute('SELECT 1 FROM metadata WHERE key=?',('credential_types_migrated',)).fetchone():
                for row in db.execute('SELECT pid,summary FROM connections WHERE summary IS NOT NULL ORDER BY checked_at'):
                    try:
                        self._remember_types(db,row['pid'],json.loads(row['summary']))
                    except (ValueError,TypeError,AttributeError):
                        continue
                db.execute('INSERT OR IGNORE INTO metadata VALUES(?,?)',('credential_types_migrated','1'))

    @staticmethod
    def _remember_types(db,pid,summary):
        for username,state in summary.get('accounts',{}).items():
            db.execute('''INSERT INTO credential_types(pid,username,on_demand,updated_at) VALUES(?,?,?,0)
                          ON CONFLICT(pid,username) DO UPDATE SET on_demand=excluded.on_demand WHERE credential_types.updated_at=0''',
                       (pid,canonical_username(username),int(bool(state.get('eligible')))))

    def credential_types(self,pid):
        with self.connect() as db:
            return {row['username']:dict(row) for row in db.execute('SELECT * FROM credential_types WHERE pid=?',(pid,))}

    def mark_credentials(self,pid,usernames,on_demand):
        with self.connect() as db:
            db.executemany('''INSERT INTO credential_types VALUES(?,?,?,?) ON CONFLICT(pid,username)
                              DO UPDATE SET on_demand=excluded.on_demand,updated_at=excluded.updated_at''',
                           [(pid,canonical_username(name),int(on_demand),time.time()) for name in usernames])

    @contextmanager
    def connect(self):
        db=sqlite3.connect(self.path,timeout=30)
        db.row_factory=sqlite3.Row
        try:
            yield db
            db.commit()
        except Exception:
            db.rollback()
            raise
        finally:
            db.close()

    def pool_id(self,pid):
        with self.connect() as db:
            source=db.execute('SELECT value FROM metadata WHERE key=?',('source',)).fetchone()[0]
        return source+'_'+hashlib.sha256(pid.encode()).hexdigest()[:32]

    def get(self,owner,pid):
        with self.connect() as db:
            row=db.execute('SELECT * FROM connections WHERE owner=? AND pid=?',(owner,pid)).fetchone()
        return dict(row) if row else None

    def save(self,owner,pid,url,username,password,verify,*,persist=True):
        previous=self.get(owner,pid)
        same_target=previous and previous['url']==url
        with self.connect() as db:
            db.execute('INSERT OR REPLACE INTO connections VALUES(?,?,?,?,?,?,?,?,?)',
                       (owner,pid,url,username,encrypt_str(current_app.secret_key,password) if persist else '',int(verify),
                        previous['summary'] if same_target else None,previous['checked_at'] if same_target else None,previous['migrated'] if same_target else '[]'))

    def cache(self,owner,pid,summary,*,migrated_names=()):
        summary = safe_summary(summary)
        with self.connect() as db:
            self._remember_types(db,pid,summary)
            row=db.execute('SELECT migrated FROM connections WHERE owner=? AND pid=?',(owner,pid)).fetchone()
            saved=json.loads(str(row['migrated'])) if row else []
            names=set(saved if isinstance(saved,list) else []) | set(migrated_names)
            db.execute('UPDATE connections SET summary=?,checked_at=?,migrated=? WHERE owner=? AND pid=?',
                       (json.dumps(summary),time.time(),json.dumps(sorted(names)),owner,pid))

    def configure_url(self,owner,pid,url):
        previous=self.get(owner,pid)
        if previous and previous['url']==url:
            return
        if previous and previous['url'] and url:
            parsed=urlsplit(previous['url'])
            if connection_url(previous['url'],parsed.port or (443 if parsed.scheme=='https' else 80))==url:
                return
        with self.connect() as db:
            db.execute('INSERT OR REPLACE INTO connections VALUES(?,?,?,?,?,?,?,?,?)',
                       (owner,pid,url,previous['username'] if previous else '', '',
                        previous['verify_ssl'] if previous else 1,None,None,'[]'))


def safe_summary(data):
    accounts=data.get('accounts')
    if not isinstance(accounts,dict) or len(accounts)>5000:
        raise AccessForgeError('Invalid AccessForge status response.',502)
    fields=('eligible','email','name','assigned_at','releasing','password_rotated','checked_out_at','checkout_ip','relinquished_at','relinquished_ip','login_disabled','awaiting_checkout')
    clean={key:data[key] for key in ('id','name','enabled','verify_email','secret_set','smtp_configured','published','login_management_ready') if key in data}
    if 'policy' in data:
        if not isinstance(data['policy'],dict):
            raise AccessForgeError('Invalid AccessForge checkout policy.',502)
        try:
            clean['policy']=validate_checkout_policy({key:value for key,value in data['policy'].items() if key in CHECKOUT_POLICY_DEFAULTS})
        except AccessForgeError:
            raise AccessForgeError('Invalid AccessForge checkout policy.',502) from None
    clean['accounts']={}
    for username,state in accounts.items():
        if not isinstance(username,str) or len(username)>128 or not isinstance(state,dict):
            raise AccessForgeError('Invalid AccessForge account status.',502)
        clean['accounts'][username]={key:state[key] for key in fields if key in state}
    return clean


def _owner():
    app=current_app._get_current_object()
    user=app.current_user() if app.config.get('AUTH_ENABLE') else None
    return str((user or {}).get('username') or '__anonymous__')


def checkout_summary(project):
    """Local status snapshot only: ordinary project reads never contact AccessForge."""
    app=current_app._get_current_object()
    if not app.config.get('ACCESSFORGE_PLUGIN_ENABLE'):
        return None
    user=app.current_user() if app.config.get('AUTH_ENABLE') else None
    if app.config.get('AUTH_ENABLE') and (not user or 'admin' not in {str(r).lower() for r in user.get('roles',[])}):
        return None
    path=os.path.join(app.config['DATA_DIR'],'accessforge_connections.sqlite3')
    if not os.path.exists(path):
        return {'accounts':{},'checked_at':None,'connected':False}
    store=ConnectionStore()
    row=store.get(_owner(),project.id)
    local=store.credential_types(project.id)
    result=json.loads(row['summary']) if row and row['summary'] else {'accounts':{}}
    # Map canonical Proxmox IDs back to the project's original credential spelling.
    remote=result.get('accounts',{})
    result['accounts']={}
    for credential in project.credentials or []:
        username=credential.get('username')
        if not username:
            continue
        canonical=canonical_username(username)
        state=remote.get(canonical)
        kind=local.get(canonical)
        if state is None and kind is None:
            continue
        marked=bool(kind['on_demand']) if kind else bool(state.get('eligible'))
        checked=row['checked_at'] if row else None
        sync='unknown' if not checked or (kind and kind['updated_at']>checked) else 'not_synced' if state is None else 'synced' if state.get('eligible') else 'not_enabled'
        result['accounts'][username]={**(state or {}),'eligible':marked,'remote_eligible':bool(state and state.get('eligible')),'sync_status':sync}
    result['checked_at']=row['checked_at'] if row else None
    result['connected']=bool(row and row['password_enc'])
    result['connection_url']=row['url'] if row else ''
    return result


def admin_username(value):
    value=value.strip()
    return value+'@pam' if value and '@' not in value else value


def connection_url(value,port=None):
    if not isinstance(value,str) or len(value)>2048:
        raise AccessForgeError('Provide an AccessForge URL.')
    value=value.strip().rstrip('/')
    try:
        parsed=urlsplit(value)
        parsed.port
    except ValueError:
        raise AccessForgeError('Invalid AccessForge URL.') from None
    if parsed.scheme not in ('http','https') or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise AccessForgeError('Use an HTTP/HTTPS base URL without credentials, query, or fragment.')
    if parsed.scheme!='https' and parsed.hostname not in ('localhost','127.0.0.1','::1'):
        raise AccessForgeError('Use HTTPS for an AccessForge administrator connection.')
    if port is not None:
        if type(port) is not int or not 1<=port<=65535:
            raise AccessForgeError('API port must be between 1 and 65535.')
        host='['+parsed.hostname+']' if ':' in parsed.hostname else parsed.hostname
        default=443 if parsed.scheme=='https' else 80
        value=urlunsplit((parsed.scheme,host+(f':{port}' if port!=default else ''),parsed.path,'',''))
    return value


def validate_connection(data,previous=None):
    url=data.get('url')
    username=data.get('username')
    if not isinstance(url,str) or len(url)>2048 or not isinstance(username,str) or not 1<=len(username.strip())<=128:
        raise AccessForgeError('Provide an AccessForge URL and administrator username.')
    username=admin_username(username)
    if len(username)>128:
        raise AccessForgeError('Administrator username is too long.')
    url=connection_url(url,data.get('api_port'))
    password=data.get('password')
    if not password and previous and previous['password_enc'] and previous['url']==url and admin_username(previous['username'])==username:
        password=decrypt_str(current_app.secret_key,previous['password_enc'])
    if not isinstance(password,str) or not 1<=len(password)<=1024:
        raise AccessForgeError('Enter the administrator password when configuring a new connection.')
    verify=data.get('verify_ssl',True)
    if type(verify) is not bool:
        raise AccessForgeError('verify_ssl must be a boolean.')
    return {'url':url,'username':username,'password':password,'verify_ssl':verify}


def remote(connection,method,path,data=None):
    try:
        response=requests.request(method,connection['url']+path,auth=(connection['username'],connection['password']),
                                  json=data,verify=connection['verify_ssl'],timeout=(5,45),allow_redirects=False)
    except requests.exceptions.SSLError:
        message=('AccessForge TLS certificate verification failed. For a self-signed certificate, uncheck Verify SSL certificates in Connection, or install a trusted certificate.'
                 if connection['verify_ssl'] else 'Could not establish TLS with AccessForge. Check its HTTPS URL, port, and TLS configuration.')
        raise AccessForgeError(message,502) from None
    except requests.Timeout:
        raise AccessForgeError('AccessForge timed out. Check that its URL and port are reachable from the SCE-web server.',502) from None
    except requests.ConnectionError:
        raise AccessForgeError('Could not connect to AccessForge. Check the hostname, port, and network access from the SCE-web server.',502) from None
    except requests.RequestException:
        raise AccessForgeError('Could not reach AccessForge. Check its URL and TLS configuration.',502) from None
    if response.status_code in (401,403):
        try:
            rejected=response.json()
            reason=rejected.get('error') if isinstance(rejected,dict) else None
        except ValueError:
            reason=None
        if not isinstance(reason,str):
            reason=None
        # Only translate known API messages; never relay arbitrary upstream bodies.
        reasons={
            'Administrator authentication failed.':'Proxmox rejected the administrator login. Check the password and AccessForge’s configured PROXMOX_HOST. Usernames without a realm use @pam; include @realm to use a different realm.',
            'Use an administrator account supported by the password login integration.':'This Proxmox account requires two-factor authentication. The saved AccessForge connection requires an administrator account that supports non-interactive password login.',
            'Checkout administration requires Sys.Modify on / in the configured Proxmox cluster.':'The Proxmox login succeeded, but the account lacks Sys.Modify on / in AccessForge’s configured cluster. Check its Proxmox permissions; Linux sudo access alone does not grant this privilege.',
            'Administrator session expired. Sign in again.':'Proxmox accepted the login but rejected the administrator ticket when checking permissions. Check AccessForge’s configured cluster and Proxmox authentication logs.',
            'An AccessForge administrator account is required.':'Enter an administrator username and password in Connection. Usernames without a realm use @pam.',
            'Sign in with an administrator account.':'AccessForge did not receive administrator credentials. Save the connection again; if it persists, check that the reverse proxy forwards the Authorization header.',
        }
        fallback=('AccessForge rejected administrator authentication. Check the Proxmox username, password, and configured cluster; usernames without a realm use @pam.'
                  if response.status_code==401 else 'AccessForge denied checkout administration. Check that the Proxmox account has Sys.Modify on / in the configured cluster.')
        raise AccessForgeError(reasons.get(reason,fallback),502)
    if 300<=response.status_code<400:
        raise AccessForgeError('AccessForge redirected the request. Enter its final HTTPS base URL in Connection.',502)
    if response.status_code>=500:
        try:
            failed=response.json()
            reason=failed.get('error') if isinstance(failed,dict) else None
        except ValueError:
            reason=None
        # Relay only known application diagnostics; never arbitrary upstream pages or exception details.
        known_errors={
            "AccessForge could not verify the configured Proxmox API's TLS certificate. Check VERIFY_SSL and the Proxmox certificate trust on AccessForge.",
            'AccessForge could not establish TLS with the configured Proxmox API. Check PROXMOX_HOST, PROXMOX_PORT, and its TLS configuration.',
            'AccessForge timed out contacting its configured Proxmox API. Check PROXMOX_HOST, PROXMOX_PORT, and network access from the AccessForge container.',
            'AccessForge could not connect to its configured Proxmox API. Check PROXMOX_HOST, PROXMOX_PORT, and container DNS/network access.',
            'AccessForge could not request its configured Proxmox API. Check PROXMOX_HOST and PROXMOX_PORT.',
            'AccessForge received an invalid Proxmox API response while validating the administrator. Check PROXMOX_HOST, PROXMOX_PORT, and reverse-proxy routing.',
            'The configured Proxmox API returned a server error during administrator authentication.',
            'The configured Proxmox API returned a server error while checking administrator permissions.',
        }
        if isinstance(reason,str) and reason in known_errors:
            raise AccessForgeError(reason,502)
        if reason=='Could not validate the administrator with Proxmox.':
            raise AccessForgeError('AccessForge is reachable but could not validate the administrator with its configured Proxmox API. Check PROXMOX_HOST, PROXMOX_PORT, VERIFY_SSL, and container network access on AccessForge.',502)
        raise AccessForgeError(f'AccessForge returned HTTP {response.status_code}. Check its application and reverse-proxy logs.',502)
    try:
        result=response.json()
    except ValueError:
        raise AccessForgeError('AccessForge did not return its checkout API response. Check the base URL and enable account checkout on that server.',502) from None
    if response.status_code != 200 or not isinstance(result,dict):
        message=result.get('error') if isinstance(result,dict) else None
        if response.status_code in (400,404,409,413) and isinstance(message,str) and len(message)<=512:
            raise AccessForgeError(message,response.status_code)
        raise AccessForgeError('AccessForge rejected the request. Check the remote server.',502)
    return result


def legacy_assignments(pid):
    path=os.path.join(current_app.config['DATA_DIR'],'account_checkout.sqlite3')
    if not os.path.exists(path):
        return {}
    # Read the previous implementation without changing or removing its data.
    db=sqlite3.connect('file:'+quote(path,safe='/')+'?mode=ro',uri=True)
    db.row_factory=sqlite3.Row
    try:
        columns={row['name'] for row in db.execute('PRAGMA table_info(accounts)')}
        pending=',pending_password' if 'pending_password' in columns else ''
        result={}
        for row in db.execute('SELECT username,email,assigned_at'+pending+' FROM accounts WHERE pid=? AND email IS NOT NULL',(pid,)):
            state={'email':row['email'],'assigned_at':row['assigned_at']}
            if pending and row['pending_password']:
                value=decrypt_str(current_app.secret_key,row['pending_password'])
                if not value:
                    raise AccessForgeError('Restore the SCE-web secret key before migrating pending releases.',409)
                state['pending_release_password']=value
            result[row['username']]=state
        return result
    except sqlite3.Error:
        return {}
    finally:
        db.close()


def register_accessforge_plugin(app):
    from .routes.api import _secure_route,_store
    bp=Blueprint('accessforge_plugin',__name__)

    @bp.errorhandler(AccessForgeError)
    def error(exc):
        return jsonify(error=exc.message),exc.status

    @bp.after_request
    def private(response):
        response.headers['Cache-Control']='no-store'
        return response

    def project(pid):
        result=_store().get(pid)
        if not result:
            raise AccessForgeError('Project not found.',404)
        return result

    def body():
        if request.content_length is not None and request.content_length>32768:
            raise AccessForgeError('Request is too large.',413)
        data=request.get_json(silent=True)
        if not isinstance(data,dict):
            raise AccessForgeError('A JSON object is required.')
        return data

    def connection(pid):
        store=ConnectionStore()
        row=store.get(_owner(),pid)
        if not row:
            raise AccessForgeError('Configure an AccessForge administrator connection first.',409)
        temporary=temporary_connection()
        if temporary:
            if temporary['url']!=row['url']:
                raise AccessForgeError('The AccessForge URL changed. Open Connection and save credentials for the new URL.',409)
            return store,row,temporary
        if not row['password_enc']:
            raise AccessForgeError('Enter AccessForge credentials in Connection for this browser session.',409)
        return store,row,{'url':row['url'],'username':admin_username(row['username']),'password':decrypt_str(app.secret_key,row['password_enc']),'verify_ssl':bool(row['verify_ssl'])}

    def temporary_connection():
        encoded=request.headers.get('X-AccessForge-Connection')
        if encoded is None:
            return None
        if len(encoded)>16384:
            raise AccessForgeError('Connection credentials are too large.',413)
        try:
            data=json.loads(unquote(encoded))
        except (ValueError,TypeError):
            raise AccessForgeError('Invalid browser-session connection credentials.') from None
        if not isinstance(data,dict):
            raise AccessForgeError('Invalid browser-session connection credentials.')
        return validate_connection(data)

    @bp.route('/api/projects/<pid>/accessforge/connection',methods=['GET','POST','PATCH','DELETE'])
    @_secure_route(required_roles=['admin'])
    def configure_connection(pid):
        selected=project(pid)
        store=ConnectionStore()
        previous=store.get(_owner(),pid)
        if request.method=='PATCH':
            submitted=body()
            url=connection_url(submitted.get('url'),submitted.get('api_port')) if submitted.get('url') else ''
            store.configure_url(_owner(),pid,url)
            return jsonify(checkout=checkout_summary(selected))
        if request.method=='DELETE':
            with store.connect() as db:
                db.execute('DELETE FROM connections WHERE owner=? AND pid=?',(_owner(),pid))
            return jsonify(connected=False)
        if request.method=='GET':
            temporary=temporary_connection()
            session_valid=not temporary or bool(previous and temporary['url']==previous['url'])
            if not session_valid:
                temporary=None
            persisted=bool(previous and previous['password_enc'])
            source=temporary or previous or {}
            return jsonify(connected=bool(previous and (persisted or temporary)),persist=persisted,session_valid=session_valid,
                           url=source.get('url',''),username=admin_username(source.get('username','')),
                           verify_ssl=bool(source.get('verify_ssl',True)),pool_id=store.pool_id(pid),
                           checked_at=previous['checked_at'] if previous else None)
        submitted=body()
        persist=submitted.get('persist',True)
        if type(persist) is not bool:
            raise AccessForgeError('persist must be a boolean.')
        data=validate_connection(submitted,previous if persist else None)
        status=remote(data,'GET','/api/admin/checkouts/status')
        if status.get('service')!='AccessForge' or status.get('checkout_api')!=1:
            raise AccessForgeError('That server does not support the AccessForge checkout administration API.',502)
        store.save(_owner(),pid,data['url'],data['username'],data['password'],data['verify_ssl'],persist=persist)
        return jsonify(connected=True,persist=persist,administrator=status.get('administrator'),cluster=status.get('cluster'),pool_id=store.pool_id(pid),checkout=checkout_summary(selected))

    @bp.get('/api/projects/<pid>/accessforge/accounts')
    @_secure_route(required_roles=['admin'])
    def accounts(pid):
        selected=project(pid)
        return jsonify(accounts=[{'username':c['username'],'index':i+1} for i,c in enumerate(selected.credentials or []) if c.get('username')],
                       checkout=checkout_summary(selected),legacy_assignments=len(legacy_assignments(pid)))

    def publish_accounts(pid,submitted):
        selected=project(pid)
        store,row,config=connection(pid)
        usernames=submitted.get('usernames')
        if not isinstance(usernames,list) or not 1<=len(usernames)<=2000 or any(not isinstance(u,str) for u in usernames):
            raise AccessForgeError('Select at least one saved account to publish.')
        known={c.get('username'):c for c in selected.credentials or []}
        if len(known)!=len(selected.credentials or []) or any(u not in known for u in usernames):
            raise AccessForgeError('Select unique usernames from the saved project credentials.')
        migrated=json.loads(str(row['migrated']))
        migrated=set(migrated if isinstance(migrated,list) else [])
        legacy={name:state for name,state in legacy_assignments(pid).items() if name not in migrated}
        entries=[{**known[u],**legacy.get(u,{})} for u in dict.fromkeys(usernames)]
        result=remote(config,'PUT','/api/admin/checkouts/pools/'+store.pool_id(pid),{'name':selected.name,'accounts':entries})
        # Migrate only once; publishing old snapshots must not reassign released students.
        store.cache(_owner(),pid,result,migrated_names=set(legacy)&set(usernames))
        return selected,store,config

    def enable_existing_api(pid,usernames,known,store,config,payload):
        """Register checkout accounts using the original API without disabling active logins."""
        latest=json.loads(store.get(_owner(),pid)['summary'])
        results={};disabled=[]
        path='/api/admin/checkouts/pools/'+store.pool_id(pid)
        def updated(response):
            if not isinstance(response.get('checkout'),dict):
                raise AccessForgeError('AccessForge did not return updated checkout status.',502)
            store.cache(_owner(),pid,response['checkout'])
            return response['checkout']
        for username in usernames:
            canonical=canonical_username(username)
            state=latest['accounts'].get(canonical)
            row={'username':canonical,'success':False};results[username]=row
            if state is None:
                row['error']='AccessForge did not confirm this account was published.'
            elif state.get('email') or state.get('releasing'):
                row['error']='Relinquish the assigned account before enabling it.'
            elif state.get('login_disabled'):
                disabled.append(username)
            else:
                # This login is already active; only checkout eligibility needs setting.
                row['success']=True
        if disabled:
            try:
                response=remote(config,'POST',path,{'action':'reenable_logins','accounts':[known[u] for u in disabled]})
                latest=updated(response)
                confirmed={canonical_username(row['username']):row for row in response.get('results',[]) if isinstance(row,dict) and isinstance(row.get('username'),str)}
                for username in disabled:
                    canonical=canonical_username(username);row=confirmed.get(canonical,{})
                    success=row.get('success') is True and latest['accounts'].get(canonical,{}).get('login_disabled') is False
                    results[username].update(success=success)
                    if not success:
                        results[username]['error']=row.get('error') or 'AccessForge did not confirm that this login was re-enabled.'
            except AccessForgeError as exc:
                for username in disabled:
                    results[username]['error']='Could not confirm login enable: '+exc.message
        checkout_names={canonical_username(entry['username']) for entry in payload['accounts'] if entry.get('enable_checkout')}
        activate=[u for u in usernames if results[u]['success'] and canonical_username(u) in checkout_names
                  and not latest['accounts'].get(canonical_username(u),{}).get('eligible')]
        if activate:
            try:
                latest=updated(remote(config,'POST',path,{'action':'enable','usernames':activate}))
                for username in activate:
                    if latest['accounts'].get(canonical_username(username),{}).get('eligible') is not True:
                        results[username].update(success=False,error='AccessForge did not confirm checkout was enabled.')
            except AccessForgeError as exc:
                for username in activate:
                    results[username].update(success=False,error='Could not confirm checkout enable: '+exc.message)
        return {'checkout':latest,'results':[results[u] for u in usernames]}

    @bp.post('/api/projects/<pid>/accessforge/publish')
    @_secure_route(required_roles=['admin'])
    def publish(pid):
        selected,store,config=publish_accounts(pid,body())
        return jsonify(checkout=checkout_summary(selected),pool_id=store.pool_id(pid),admin_url=config['url']+'/admin/checkouts',student_url=config['url']+'/checkout')

    @bp.post('/api/projects/<pid>/credential-types')
    @bp.post('/api/projects/<pid>/accessforge/credential-types')
    @_secure_route(required_roles=['admin'])
    def credential_types(pid):
        submitted=body();selected=project(pid)
        usernames=submitted.get('usernames');enabled=submitted.get('enabled')
        known={c.get('username') for c in selected.credentials or []}
        if type(enabled) is not bool or not isinstance(usernames,list) or not 1<=len(usernames)<=2000 or any(not isinstance(u,str) or u not in known for u in usernames):
            raise AccessForgeError('Select saved credential usernames and whether checkout is enabled.')
        usernames=list(dict.fromkeys(usernames))
        ConnectionStore().mark_credentials(pid,usernames,enabled)
        return jsonify(checkout=checkout_summary(selected))

    @bp.post('/api/projects/<pid>/accessforge/checkout-accounts')
    @_secure_route(required_roles=['admin'])
    def checkout_accounts(pid):
        submitted=body();selected=project(pid)
        usernames=submitted.get('usernames');enabled=submitted.get('enabled')
        known={c.get('username') for c in selected.credentials or []}
        if type(enabled) is not bool or not isinstance(usernames,list) or not 1<=len(usernames)<=2000 or any(not isinstance(u,str) or u not in known for u in usernames):
            raise AccessForgeError('Select saved credential usernames and whether checkout is enabled.')
        usernames=list(dict.fromkeys(usernames))
        selected_names=list(usernames)
        if enabled:
            selected,store,config=publish_accounts(pid,submitted)
        else:
            store,row,config=connection(pid)
            try:
                status=remote(config,'GET','/api/admin/checkouts/pools/'+store.pool_id(pid))
            except AccessForgeError as exc:
                if exc.status!=404 or exc.message!='Checkout pool not found.':
                    raise
                status={'accounts':{},'published':False}
            usernames=[u for u in usernames if canonical_username(u) in status['accounts']]
            if not usernames:
                store.mark_credentials(pid,selected_names,False)
                store.cache(_owner(),pid,status)
                return jsonify(checkout=checkout_summary(selected))
        result=remote(config,'POST','/api/admin/checkouts/pools/'+store.pool_id(pid),{'action':'enable' if enabled else 'disable','usernames':usernames})
        store.mark_credentials(pid,selected_names,enabled)
        store.cache(_owner(),pid,result['checkout'])
        return jsonify(checkout=checkout_summary(selected))

    @bp.post('/api/projects/<pid>/accessforge/<operation>')
    @_secure_route(required_roles=['admin'])
    def manage_login(pid,operation):
        actions={'disable-logins':'disable_logins','reset-passwords':'reset_passwords','reenable-logins':'enable_accounts','relinquish-accounts':'release'}
        if operation not in actions:
            raise AccessForgeError('Unknown account operation.',404)
        selected=project(pid)
        store,row,config=connection(pid)
        submitted=body()
        if operation=='relinquish-accounts' and submitted.get('confirmed') is not True:
            raise AccessForgeError('Confirm relinquishing the selected accounts and disabling their logins.')
        usernames=submitted.get('usernames')
        if not isinstance(usernames,list) or not 1<=len(usernames)<=2000 or any(not isinstance(u,str) for u in usernames):
            raise AccessForgeError('Select at least one saved account.')
        known={c.get('username'):c for c in selected.credentials or []}
        if len(known)!=len(selected.credentials or []) or any(u not in known for u in usernames):
            raise AccessForgeError('Select unique usernames from the current saved credentials.')
        usernames=list(dict.fromkeys(usernames))
        payload={'action':actions[operation]}
        if operation in ('disable-logins','relinquish-accounts'):
            payload['usernames']=usernames
        else:
            marked=(checkout_summary(selected) or {}).get('accounts',{})
            payload['accounts']=[{**known[u],**({'enable_checkout':bool(marked.get(u,{}).get('eligible'))} if operation=='reenable-logins' else {})} for u in usernames]
        if operation=='reenable-logins':
            service=remote(config,'GET','/api/admin/checkouts/status')
            capabilities=service.get('capabilities')
            modern_setup=isinstance(capabilities,dict) and capabilities.get('account_setup') is True
            # Password updates happen in VM Manager; refresh AccessForge's copy
            # before enabling. AccessForge also enables checkout for marked accounts
            # only after their Proxmox login update succeeds.
            selected,store,config=publish_accounts(pid,{'usernames':usernames})
        result=(enable_existing_api(pid,usernames,known,store,config,payload) if operation=='reenable-logins' and not modern_setup
                else remote(config,'POST','/api/admin/checkouts/pools/'+store.pool_id(pid),payload))
        store.cache(_owner(),pid,result['checkout'])
        results=result.get('results',[])
        if operation=='relinquish-accounts':
            results=[{**row,'success':row.get('released') is True} for row in results]
        return jsonify(checkout=checkout_summary(selected),results=results)

    @bp.patch('/api/projects/<pid>/accessforge/settings')
    @_secure_route(required_roles=['admin'])
    def checkout_settings(pid):
        selected=project(pid)
        store,row,config=connection(pid)
        submitted=body();payload={}
        if 'policy' in submitted:
            normalized=validate_checkout_policy(submitted['policy'])
            payload['policy']={key:normalized[key] for key in submitted['policy']}
        for field in ('enabled','verify_email'):
            if field in submitted:
                if type(submitted[field]) is not bool:
                    raise AccessForgeError(f'{field} must be a boolean.')
                payload[field]=submitted[field]
        if 'secret' in submitted:
            secret=submitted['secret']
            if not isinstance(secret,str) or (secret and not 8<=len(secret)<=256):
                raise AccessForgeError('Use a lab secret between 8 and 256 characters, or leave it blank to keep the current secret.')
            if secret:
                payload['secret']=secret
        if not payload:
            raise AccessForgeError('Provide checkout settings to save.')
        try:
            result=remote(config,'PATCH','/api/admin/checkouts/pools/'+store.pool_id(pid),payload)
        except AccessForgeError as exc:
            if exc.status==404 and exc.message=='Checkout pool not found.':
                raise AccessForgeError('Use Accounts → Enable to publish at least one account before configuring checkout settings.',409) from None
            raise
        store.cache(_owner(),pid,result)
        return jsonify(checkout=checkout_summary(selected))

    @bp.get('/api/projects/<pid>/accessforge/status')
    @_secure_route(required_roles=['admin'])
    def status(pid):
        selected=project(pid)
        store,row,config=connection(pid)
        try:
            result=remote(config,'GET','/api/admin/checkouts/pools/'+store.pool_id(pid))
        except AccessForgeError as exc:
            if exc.status!=404 or exc.message!='Checkout pool not found.':
                raise
            result={'accounts':{},'published':False}
        store.cache(_owner(),pid,result)
        return jsonify(checkout=checkout_summary(selected),admin_url=config['url']+'/admin/checkouts',student_url=config['url']+'/checkout')

    app.register_blueprint(bp)
