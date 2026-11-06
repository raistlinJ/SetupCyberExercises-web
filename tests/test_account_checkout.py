import json
import sqlite3
from unittest.mock import patch

import pytest
import requests

from app import create_app
from app.account_checkout import ConnectionStore
from app.storage.projects import Project,ProjectStore


@pytest.fixture
def checkout(tmp_path,monkeypatch):
    monkeypatch.setenv('DATA_DIR',str(tmp_path))
    monkeypatch.setenv('USERS_FILE',str(tmp_path/'users.json'))
    monkeypatch.setenv('AUTH_ENABLE','1')
    monkeypatch.setenv('SEED_ADMIN_USER','instructor')
    monkeypatch.setenv('SEED_ADMIN_PASS','instructor-password')
    monkeypatch.setenv('API_KEY','')
    monkeypatch.setenv('ACCESSFORGE_PLUGIN_ENABLE','1')
    app=create_app();app.config['TESTING']=True
    project=Project(id='lab',name='Networking',instances=2)
    project.credentials=[{'username':'student01','password':'password-one'},{'username':'student02','password':'password-two'}]
    ProjectStore(str(tmp_path)).upsert(project)
    admin=app.test_client();assert admin.post('/auth/login',json={'username':'instructor','password':'instructor-password'}).status_code==200
    return app,admin,project


def reply(data,status=200):
    result=requests.Response();result.status_code=status;result._content=json.dumps(data).encode();return result


def connect(admin,url='https://accessforge.example'):
    with patch('app.account_checkout.requests.request',return_value=reply({'service':'AccessForge','checkout_api':1,'administrator':'root@pam','cluster':{'host':'pve.example','port':8006}})):
        response=admin.post('/api/projects/lab/accessforge/connection',json={'url':url,'username':'root@pam','password':'admin-password','verify_ssl':True})
    assert response.status_code==200,response.json
    return response


def snapshot(email='one@example.edu'):
    return {'id':'remote-pool','name':'Networking','enabled':True,'verify_email':False,'secret_set':True,'accounts':{'student01@pve':{'email':email,'eligible':True,'assigned_at':12345,'releasing':False,'password_rotated':False}}}


def test_discovery_and_disabled_plugin_blocks_page_routes(checkout,monkeypatch):
    _,admin,_=checkout
    assert 'accessforge' in [p['name'] for p in admin.get('/api/plugins').get_json()['plugins']]
    monkeypatch.setenv('ACCESSFORGE_PLUGIN_ENABLE','0')
    app=create_app();client=app.test_client()
    assert 'accessforge' not in [p['name'] for p in client.get('/api/plugins').get_json()['plugins']]
    assert client.get('/static/accessforge_manager.html').status_code==404
    assert client.get('/static/js/accessforge_manager.js').status_code==404
    assert client.get('/api/projects/lab/accessforge/status').status_code==404
    assert client.get('/api/checkout-service/start').status_code==404
    assert client.get('/api/projects/lab/checkout').status_code==404


def test_only_sce_admin_can_configure_or_publish(checkout):
    app,admin,_=checkout
    anonymous=app.test_client()
    assert anonymous.get('/api/projects/lab/accessforge/connection').status_code==401
    assert anonymous.post('/api/projects/lab/accessforge/publish',json={'usernames':['student01']}).status_code==401
    assert admin.post('/auth/users',json={'username':'viewer','password':'Student-password42!','roles':[]}).status_code==200
    viewer=app.test_client();viewer.post('/auth/login',json={'username':'viewer','password':'Student-password42!'})
    assert viewer.get('/api/projects/lab/accessforge/connection').status_code==403


def test_connection_validates_admin_and_encrypts_password(checkout):
    app,admin,_=checkout
    result=connect(admin)
    assert 'admin-password' not in result.get_data(as_text=True)
    response=admin.get('/api/projects/lab/accessforge/connection')
    assert response.get_json()['connected'] and 'password' not in response.get_json()
    with app.app_context():
        row=ConnectionStore().get('instructor','lab')
        assert row['password_enc']!='admin-password'
    with patch('app.account_checkout.requests.request',return_value=reply({'service':'AccessForge','checkout_api':1})) as remote:
        assert admin.post('/api/projects/lab/accessforge/connection',json={'url':'https://accessforge.example','username':'root@pam','password':''}).status_code==200
    assert remote.call_args.kwargs['auth']==('root@pam','admin-password')
    assert remote.call_args.kwargs['verify'] is True and not remote.call_args.kwargs['allow_redirects']


def test_connection_url_rejects_credentials_redirects_and_insecure_hosts(checkout):
    _,admin,_=checkout
    for url in ['http://accessforge.example','https://u:p@accessforge.example','https://accessforge.example/?token=bad','file:///tmp/a','https://accessforge.example:bad']:
        with patch('app.account_checkout.requests.request') as remote:
            response=admin.post('/api/projects/lab/accessforge/connection',json={'url':url,'username':'root@pam','password':'admin-password'})
        assert response.status_code==400
        remote.assert_not_called()
    with patch('app.account_checkout.requests.request',return_value=reply({'error':'Not an administrator'},403)):
        response=admin.post('/api/projects/lab/accessforge/connection',json={'url':'https://accessforge.example','username':'student','password':'secret'})
    assert response.status_code==502
    assert not admin.get('/api/projects/lab/accessforge/connection').get_json()['connected']


def test_publish_sends_selected_saved_credentials_and_no_policy(checkout):
    _,admin,_=checkout;connect(admin)
    with patch('app.account_checkout.requests.request',return_value=reply(snapshot())) as remote:
        response=admin.post('/api/projects/lab/accessforge/publish',json={'usernames':['student01'],'secret':'must-not-forward','enabled':True})
    assert response.status_code==200
    assert remote.call_args.args[0]=='PUT'
    assert '/api/admin/checkouts/pools/' in remote.call_args.args[1]
    assert remote.call_args.kwargs['json']=={'name':'Networking','accounts':[{'username':'student01','password':'password-one'}]}
    assert response.get_json()['checkout']['accounts']['student01']['email']=='one@example.edu'
    assert 'student02' not in response.get_json()['checkout']['accounts']
    assert 'password-one' not in response.get_data(as_text=True)


def test_status_is_explicit_and_cached_project_reads_do_not_connect(checkout):
    app,admin,_=checkout;connect(admin)
    with patch('app.account_checkout.requests.request',return_value=reply(snapshot())) as remote:
        response=admin.get('/api/projects/lab/accessforge/status')
    assert response.status_code==200 and remote.call_args.args[0]=='GET'
    with patch('app.account_checkout.requests.request',side_effect=AssertionError('No implicit network')):
        data=admin.get('/api/projects').get_json()['projects'][0]
        assert data['checkout']['accounts']['student01']['email']=='one@example.edu'
        assert data['checkout']['checked_at']
        assert admin.get('/api/projects/lab/accessforge/accounts').status_code==200
    assert 'checkout' not in app.test_client().get('/api/projects').get_json()['projects'][0]


def test_status_failure_preserves_last_snapshot(checkout):
    _,admin,_=checkout;connect(admin)
    with patch('app.account_checkout.requests.request',return_value=reply(snapshot())):
        admin.get('/api/projects/lab/accessforge/status')
    with patch('app.account_checkout.requests.request',side_effect=requests.Timeout('private-password')):
        response=admin.get('/api/projects/lab/accessforge/status')
    assert response.status_code==502 and 'private-password' not in response.get_data(as_text=True)
    assert admin.get('/api/projects').get_json()['projects'][0]['checkout']['accounts']['student01']['email']=='one@example.edu'


def test_never_published_pool_has_empty_status(checkout):
    _,admin,_=checkout;connect(admin)
    with patch('app.account_checkout.requests.request',return_value=reply({'error':'Checkout pool not found.'},404)):
        response=admin.get('/api/projects/lab/accessforge/status')
    assert response.status_code==200 and response.get_json()['checkout']['accounts']=={}


def test_publish_cannot_proxy_settings_or_admin_actions(checkout):
    _,admin,_=checkout;connect(admin)
    assert admin.patch('/api/projects/lab/accessforge/configure',json={'enabled':True}).status_code in (404,405)
    assert admin.post('/api/projects/lab/accessforge/release',json={'usernames':['student01']}).status_code==404
    with patch('app.account_checkout.requests.request') as remote:
        assert admin.post('/api/projects/lab/accessforge/publish',json={'usernames':['unknown']}).status_code==400
    remote.assert_not_called()


def test_legacy_assignments_migrate_once_per_published_account(checkout):
    app,admin,_=checkout;connect(admin)
    with sqlite3.connect(app.config['DATA_DIR']+'/account_checkout.sqlite3') as db:
        db.execute('CREATE TABLE accounts(pid TEXT,username TEXT,email TEXT,assigned_at REAL)')
        db.executemany('INSERT INTO accounts VALUES(?,?,?,?)',[('lab','student01','legacy1@example.edu',123),('lab','student02','legacy2@example.edu',456)])
    with patch('app.account_checkout.requests.request',return_value=reply(snapshot())) as remote:
        assert admin.post('/api/projects/lab/accessforge/publish',json={'usernames':['student01']}).status_code==200
        assert remote.call_args.kwargs['json']['accounts'][0]['email']=='legacy1@example.edu'
        assert admin.post('/api/projects/lab/accessforge/publish',json={'usernames':['student01']}).status_code==200
        assert 'email' not in remote.call_args.kwargs['json']['accounts'][0]
        assert admin.post('/api/projects/lab/accessforge/publish',json={'usernames':['student02']}).status_code==200
        assert remote.call_args.kwargs['json']['accounts'][0]['email']=='legacy2@example.edu'


def test_connection_is_per_admin_and_never_in_project_export(checkout):
    app,admin,_=checkout;connect(admin)
    from app.routes.api import _project_to_json_filtered
    with app.test_request_context():
        result=_project_to_json_filtered(ProjectStore(app.config['DATA_DIR']).get('lab'))
    assert 'checkout' not in result and 'accessforge' not in result
    raw=admin.get('/api/projects').get_data(as_text=True)
    assert 'admin-password' not in raw and 'password_enc' not in raw
    assert admin.delete('/api/projects/lab/accessforge/connection').status_code==200
    assert not admin.get('/api/projects/lab/accessforge/connection').get_json()['connected']


def test_pending_legacy_release_is_transferred_without_exposing_password(checkout):
    app,admin,_=checkout;connect(admin)
    from app.storage.secrets import encrypt_str
    with sqlite3.connect(app.config['DATA_DIR']+'/account_checkout.sqlite3') as db:
        db.execute('CREATE TABLE accounts(pid TEXT,username TEXT,email TEXT,assigned_at REAL,pending_password TEXT)')
        db.execute('INSERT INTO accounts VALUES(?,?,?,?,?)',('lab','student01','legacy@example.edu',123,encrypt_str(app.secret_key,'pending-release-password')))
    with patch('app.account_checkout.requests.request',return_value=reply(snapshot())) as remote:
        response=admin.post('/api/projects/lab/accessforge/publish',json={'usernames':['student01']})
    assert response.status_code==200
    assert remote.call_args.kwargs['json']['accounts'][0]['pending_release_password']=='pending-release-password'
    assert 'pending-release-password' not in response.get_data(as_text=True)


def test_deleting_project_removes_local_connection_without_remote_side_effects(checkout):
    app,admin,_=checkout;connect(admin)
    with patch('app.account_checkout.requests.request') as remote:
        assert admin.delete('/api/projects/lab').status_code==204
    remote.assert_not_called()
    with app.app_context():
        assert ConnectionStore().get('instructor','lab') is None


def test_checkout_audit_columns_survive_status_cache_and_project_mapping(checkout):
    _,admin,_=checkout;connect(admin)
    data=snapshot();data['accounts']['student01@pve'].update(checked_out_at=12345,checkout_ip='203.0.113.10',relinquished_at=23456,relinquished_ip='2001:db8::1')
    with patch('app.account_checkout.requests.request',return_value=reply(data)):
        response=admin.get('/api/projects/lab/accessforge/status')
    state=response.get_json()['checkout']['accounts']['student01']
    assert state['checkout_ip']=='203.0.113.10' and state['checked_out_at']==12345
    assert state['relinquished_ip']=='2001:db8::1' and state['relinquished_at']==23456
    cached=admin.get('/api/projects').get_json()['projects'][0]['checkout']['accounts']['student01']
    assert cached==state
    page=admin.get('/static/accessforge_manager.html').get_data(as_text=True)
    assert '<th>Checkout IP</th>' in page and '<th>Relinquished</th>' in page and '<th>Relinquish IP</th>' in page


def test_selected_login_operations_use_saved_credentials_and_refresh_disabled_status(checkout):
    _,admin,_=checkout;connect(admin)
    for operation,action in [('disable-logins','disable_logins'),('reset-passwords','reset_passwords'),('reenable-logins','reenable_logins')]:
        data=snapshot();data['accounts']['student01@pve']['login_disabled']=operation!='reenable-logins'
        with patch('app.account_checkout.requests.request',return_value=reply({'checkout':data,'results':[{'username':'student01@pve','success':True}]})) as remote:
            response=admin.post('/api/projects/lab/accessforge/'+operation,json={'usernames':['student01'],'password':'do-not-use-browser-password'})
        assert response.status_code==200 and response.get_json()['results'][0]['success']
        payload=remote.call_args.kwargs['json']
        assert payload['action']==action
        if operation=='disable-logins':
            assert payload['usernames']==['student01'] and 'accounts' not in payload
        else:
            assert payload['accounts']==[{'username':'student01','password':'password-one'}]
        assert response.get_json()['checkout']['accounts']['student01']['login_disabled']==(operation!='reenable-logins')
        assert 'password-one' not in response.get_data(as_text=True)


def test_login_operations_reject_unsaved_unknown_accounts(checkout):
    _,admin,_=checkout;connect(admin)
    with patch('app.account_checkout.requests.request') as remote:
        for operation in ['disable-logins','reset-passwords','reenable-logins']:
            assert admin.post('/api/projects/lab/accessforge/'+operation,json={'usernames':['unknown']}).status_code==400
    remote.assert_not_called()
