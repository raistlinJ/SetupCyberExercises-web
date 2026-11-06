"""Optional one-way AccessForge connector: publish credentials and request status."""
import hashlib
import json
import os
import sqlite3
import time
import uuid
from contextlib import contextmanager
from urllib.parse import quote, urlsplit

import requests
from flask import Blueprint, current_app, jsonify, request

from .storage.secrets import encrypt_str, decrypt_str


class AccessForgeError(Exception):
    def __init__(self,message,status=400):
        self.message,self.status=message,status


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
            ''')
            db.execute('INSERT OR IGNORE INTO metadata VALUES(?,?)',('source',uuid.uuid4().hex))

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

    def save(self,owner,pid,url,username,password,verify):
        previous=self.get(owner,pid)
        same_target=previous and previous['url']==url
        with self.connect() as db:
            db.execute('INSERT OR REPLACE INTO connections VALUES(?,?,?,?,?,?,?,?,?)',
                       (owner,pid,url,username,encrypt_str(current_app.secret_key,password),int(verify),
                        previous['summary'] if same_target else None,previous['checked_at'] if same_target else None,previous['migrated'] if same_target else '[]'))

    def cache(self,owner,pid,summary,*,migrated_names=()):
        summary = safe_summary(summary)
        with self.connect() as db:
            row=db.execute('SELECT migrated FROM connections WHERE owner=? AND pid=?',(owner,pid)).fetchone()
            saved=json.loads(str(row['migrated'])) if row else []
            names=set(saved if isinstance(saved,list) else []) | set(migrated_names)
            db.execute('UPDATE connections SET summary=?,checked_at=?,migrated=? WHERE owner=? AND pid=?',
                       (json.dumps(summary),time.time(),json.dumps(sorted(names)),owner,pid))


def safe_summary(data):
    accounts=data.get('accounts')
    if not isinstance(accounts,dict) or len(accounts)>5000:
        raise AccessForgeError('Invalid AccessForge status response.',502)
    fields=('eligible','email','assigned_at','releasing','password_rotated','checked_out_at','checkout_ip','relinquished_at','relinquished_ip','login_disabled')
    clean={key:data[key] for key in ('id','name','enabled','verify_email','secret_set','smtp_configured','published','login_management_ready') if key in data}
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
    row=ConnectionStore().get(_owner(),project.id)
    result=json.loads(row['summary']) if row and row['summary'] else {'accounts':{}}
    # Map canonical Proxmox IDs back to the project's original credential spelling.
    remote=result.get('accounts',{})
    result['accounts']={c['username']:remote.get(c['username'] if '@' in c['username'] else c['username']+'@pve',{}) for c in project.credentials or [] if c.get('username') and (c['username'] if '@' in c['username'] else c['username']+'@pve') in remote}
    result['checked_at']=row['checked_at'] if row else None
    result['connected']=bool(row)
    return result


def validate_connection(data,previous=None):
    url=data.get('url')
    username=data.get('username')
    if not isinstance(url,str) or len(url)>2048 or not isinstance(username,str) or not 1<=len(username.strip())<=128:
        raise AccessForgeError('Provide an AccessForge URL and administrator username.')
    url=url.strip().rstrip('/')
    try:
        parsed=urlsplit(url)
        port=parsed.port
    except ValueError:
        raise AccessForgeError('Invalid AccessForge URL.') from None
    if parsed.scheme not in ('http','https') or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise AccessForgeError('Use an HTTP/HTTPS base URL without credentials, query, or fragment.')
    if parsed.scheme!='https' and parsed.hostname not in ('localhost','127.0.0.1','::1'):
        raise AccessForgeError('Use HTTPS for an AccessForge administrator connection.')
    password=data.get('password')
    if not password and previous and previous['url']==url and previous['username']==username.strip():
        password=decrypt_str(current_app.secret_key,previous['password_enc'])
    if not isinstance(password,str) or not 1<=len(password)<=1024:
        raise AccessForgeError('Enter the administrator password when configuring a new connection.')
    verify=data.get('verify_ssl',True)
    if type(verify) is not bool:
        raise AccessForgeError('verify_ssl must be a boolean.')
    return {'url':url,'username':username.strip(),'password':password,'verify_ssl':verify}


def remote(connection,method,path,data=None):
    try:
        response=requests.request(method,connection['url']+path,auth=(connection['username'],connection['password']),
                                  json=data,verify=connection['verify_ssl'],timeout=(5,45),allow_redirects=False)
        result=response.json()
    except (requests.RequestException,ValueError):
        raise AccessForgeError('Could not reach AccessForge. Check its URL and TLS configuration.',502) from None
    if response.status_code in (401,403):
        raise AccessForgeError('AccessForge requires a valid administrator account on its configured Proxmox cluster. Update the connection.',502)
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
        return store,row,{'url':row['url'],'username':row['username'],'password':decrypt_str(app.secret_key,row['password_enc']),'verify_ssl':bool(row['verify_ssl'])}

    @bp.route('/api/projects/<pid>/accessforge/connection',methods=['GET','POST','DELETE'])
    @_secure_route(required_roles=['admin'])
    def configure_connection(pid):
        project(pid)
        store=ConnectionStore()
        previous=store.get(_owner(),pid)
        if request.method=='DELETE':
            with store.connect() as db:
                db.execute('DELETE FROM connections WHERE owner=? AND pid=?',(_owner(),pid))
            return jsonify(connected=False)
        if request.method=='GET':
            return jsonify(connected=bool(previous),url=previous['url'] if previous else '',username=previous['username'] if previous else '',
                           verify_ssl=bool(previous['verify_ssl']) if previous else True,pool_id=store.pool_id(pid),
                           checked_at=previous['checked_at'] if previous else None)
        data=validate_connection(body(),previous)
        status=remote(data,'GET','/api/admin/checkouts/status')
        if status.get('service')!='AccessForge' or status.get('checkout_api')!=1:
            raise AccessForgeError('That server does not support the AccessForge checkout administration API.',502)
        store.save(_owner(),pid,data['url'],data['username'],data['password'],data['verify_ssl'])
        return jsonify(connected=True,administrator=status.get('administrator'),cluster=status.get('cluster'),pool_id=store.pool_id(pid))

    @bp.get('/api/projects/<pid>/accessforge/accounts')
    @_secure_route(required_roles=['admin'])
    def accounts(pid):
        selected=project(pid)
        return jsonify(accounts=[{'username':c['username'],'index':i+1} for i,c in enumerate(selected.credentials or []) if c.get('username')],
                       checkout=checkout_summary(selected),legacy_assignments=len(legacy_assignments(pid)))

    @bp.post('/api/projects/<pid>/accessforge/publish')
    @_secure_route(required_roles=['admin'])
    def publish(pid):
        selected=project(pid)
        store,row,config=connection(pid)
        usernames=body().get('usernames')
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
        return jsonify(checkout=checkout_summary(selected),pool_id=store.pool_id(pid),admin_url=config['url']+'/admin/checkouts',student_url=config['url']+'/checkout')

    @bp.post('/api/projects/<pid>/accessforge/<operation>')
    @_secure_route(required_roles=['admin'])
    def manage_login(pid,operation):
        actions={'disable-logins':'disable_logins','reset-passwords':'reset_passwords','reenable-logins':'reenable_logins'}
        if operation not in actions:
            raise AccessForgeError('Unknown account operation.',404)
        selected=project(pid)
        store,row,config=connection(pid)
        usernames=body().get('usernames')
        if not isinstance(usernames,list) or not 1<=len(usernames)<=2000 or any(not isinstance(u,str) for u in usernames):
            raise AccessForgeError('Select at least one saved account.')
        known={c.get('username'):c for c in selected.credentials or []}
        if len(known)!=len(selected.credentials or []) or any(u not in known for u in usernames):
            raise AccessForgeError('Select unique usernames from the current saved credentials.')
        usernames=list(dict.fromkeys(usernames))
        payload={'action':actions[operation]}
        if operation=='disable-logins':
            payload['usernames']=usernames
        else:
            payload['accounts']=[known[u] for u in usernames]
        result=remote(config,'POST','/api/admin/checkouts/pools/'+store.pool_id(pid),payload)
        store.cache(_owner(),pid,result['checkout'])
        return jsonify(checkout=checkout_summary(selected),results=result.get('results',[]))

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
