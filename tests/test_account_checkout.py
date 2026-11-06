import json
import sqlite3
from urllib.parse import quote
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
    assert client.patch('/api/projects/lab/accessforge/connection',json={'url':'https://example.edu','api_port':8443}).status_code==404
    assert client.post('/api/projects/lab/accessforge/checkout-accounts',json={'usernames':['student01'],'enabled':True}).status_code==404
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
    assert '<th>Checkout IP</th>' in page and '<th>Relinquished</th>' in page
    assert 'Relinquish IP' not in page and 'value="relinquished_ip"' not in page


def test_selected_login_operations_use_saved_credentials_and_refresh_disabled_status(checkout):
    _,admin,_=checkout;connect(admin)
    for operation,action in [('disable-logins','disable_logins'),('reset-passwords','reset_passwords'),('reenable-logins','reenable_logins')]:
        data=snapshot();data['accounts']['student01@pve']['login_disabled']=operation!='reenable-logins'
        replies=[reply({'checkout':data,'results':[{'username':'student01@pve','success':True}]})]
        if operation=='reenable-logins':
            replies.insert(0,reply(snapshot(None)))
        with patch('app.account_checkout.requests.request',side_effect=replies) as remote:
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


@pytest.mark.parametrize('exception,expected',[
    (requests.exceptions.SSLError('private-password'),'uncheck Verify SSL certificates'),
    (requests.Timeout('private-password'),'timed out'),
    (requests.ConnectionError('private-password'),'hostname, port, and network'),
])
def test_connection_errors_explain_tls_or_network_failure_without_leaking_details(checkout,exception,expected):
    _,admin,_=checkout
    with patch('app.account_checkout.requests.request',side_effect=exception):
        response=admin.post('/api/projects/lab/accessforge/connection',json={'url':'https://accessforge.example','username':'root@pam','password':'admin-password'})
    assert response.status_code==502 and expected in response.get_json()['error']
    assert 'private-password' not in response.get_data(as_text=True)


def test_self_signed_connection_uses_explicit_verification_choice(checkout):
    _,admin,_=checkout
    with patch('app.account_checkout.requests.request',return_value=reply({'service':'AccessForge','checkout_api':1,'administrator':'root@pam'})) as remote:
        response=admin.post('/api/projects/lab/accessforge/connection',json={'url':'https://accessforge.example','username':'root@pam','password':'admin-password','verify_ssl':False})
    assert response.status_code==200 and remote.call_args.kwargs['verify'] is False
    with patch('app.account_checkout.requests.request',side_effect=requests.exceptions.SSLError('private-password')):
        response=admin.post('/api/projects/lab/accessforge/connection',json={'url':'https://accessforge.example','username':'root@pam','password':'admin-password','verify_ssl':False})
    assert 'Could not establish TLS' in response.get_json()['error']
    assert 'uncheck' not in response.get_json()['error']


@pytest.mark.parametrize('status,expected',[(302,'redirected'),(500,'returned HTTP 500'),(502,'returned HTTP 502'),(200,'did not return its checkout API')])
def test_html_errors_are_not_misreported_as_unreachable_host(checkout,status,expected):
    _,admin,_=checkout
    html=requests.Response();html.status_code=status;html._content=b'<html>private internal details</html>'
    with patch('app.account_checkout.requests.request',return_value=html):
        response=admin.post('/api/projects/lab/accessforge/connection',json={'url':'https://accessforge.example','username':'root@pam','password':'admin-password'})
    assert response.status_code==502 and expected in response.get_json()['error']
    assert 'private internal details' not in response.get_data(as_text=True)


def temporary_headers(password='temporary-admin-password'):
    config={'url':'https://accessforge.example','username':'root@pam','password':password,'verify_ssl':False}
    return {'X-AccessForge-Connection':quote(json.dumps(config),safe='')}


def test_persistent_checkbox_survives_a_new_login_without_returning_password(checkout):
    app,admin,_=checkout;connect(admin)
    other=app.test_client();other.post('/auth/login',json={'username':'instructor','password':'instructor-password'})
    result=other.get('/api/projects/lab/accessforge/connection').get_json()
    assert result['persist'] is True and result['connected'] is True
    assert 'password' not in result
    with patch('app.account_checkout.requests.request',return_value=reply(snapshot())) as remote:
        assert other.get('/api/projects/lab/accessforge/status').status_code==200
    assert remote.call_args.kwargs['auth']==('root@pam','admin-password')


def test_session_only_connection_clears_persisted_password_and_uses_request_credentials(checkout):
    app,admin,_=checkout;connect(admin)
    with patch('app.account_checkout.requests.request',return_value=reply({'service':'AccessForge','checkout_api':1})):
        response=admin.post('/api/projects/lab/accessforge/connection',json={'url':'https://accessforge.example','username':'root@pam','password':'temporary-admin-password','verify_ssl':False,'persist':False})
    assert response.status_code==200 and response.get_json()['persist'] is False
    with app.app_context():
        assert ConnectionStore().get('instructor','lab')['password_enc']==''
    assert not admin.get('/api/projects/lab/accessforge/connection').get_json()['connected']
    assert admin.get('/api/projects/lab/accessforge/status').status_code==409
    restored=admin.get('/api/projects/lab/accessforge/connection',headers=temporary_headers())
    assert restored.get_json()['connected'] and not restored.get_json()['persist']
    assert 'temporary-admin-password' not in restored.get_data(as_text=True)
    with patch('app.account_checkout.requests.request',return_value=reply(snapshot())) as remote:
        response=admin.get('/api/projects/lab/accessforge/status',headers=temporary_headers())
    assert response.status_code==200
    assert remote.call_args.kwargs['auth']==('root@pam','temporary-admin-password')
    assert remote.call_args.kwargs['verify'] is False
    assert 'temporary-admin-password' not in response.get_data(as_text=True)
    assert admin.get('/api/projects/lab/accessforge/accounts').get_json()['checkout']['accounts']['student01']['email']=='one@example.edu'
    with app.app_context():
        assert ConnectionStore().get('instructor','lab')['password_enc']==''


def test_switching_to_session_only_requires_password_and_failed_auth_preserves_saved_connection(checkout):
    app,admin,_=checkout;connect(admin)
    data={'url':'https://accessforge.example','username':'root@pam','password':'','persist':False}
    with patch('app.account_checkout.requests.request') as remote:
        assert admin.post('/api/projects/lab/accessforge/connection',json=data).status_code==400
        remote.assert_not_called()
    with patch('app.account_checkout.requests.request',return_value=reply({},401)):
        assert admin.post('/api/projects/lab/accessforge/connection',json={**data,'password':'wrong-password'}).status_code==502
    assert admin.get('/api/projects/lab/accessforge/connection').get_json()['persist'] is True
    with app.app_context():
        from app.storage.secrets import decrypt_str
        assert decrypt_str(app.secret_key,ConnectionStore().get('instructor','lab')['password_enc'])=='admin-password'


@pytest.mark.parametrize('header',['broken','[]',quote(json.dumps({'url':'http://outside.example','username':'root','password':'password'}))])
def test_temporary_credentials_cannot_bypass_validation_or_admin_authorization(checkout,header):
    app,admin,_=checkout;connect(admin)
    headers={'X-AccessForge-Connection':header}
    with patch('app.account_checkout.requests.request') as remote:
        assert admin.get('/api/projects/lab/accessforge/status',headers=headers).status_code==400
        assert app.test_client().get('/api/projects/lab/accessforge/status',headers=headers).status_code==401
        remote.assert_not_called()


@pytest.mark.parametrize('status,reason,expected',[
    (401,'Administrator authentication failed.','Proxmox rejected the administrator login'),
    (401,'Use an administrator account supported by the password login integration.','requires two-factor authentication'),
    (403,'Checkout administration requires Sys.Modify on / in the configured Proxmox cluster.','login succeeded, but the account lacks Sys.Modify'),
    (401,'Administrator session expired. Sign in again.','rejected the administrator ticket'),
    (401,'Sign in with an administrator account.','forwards the Authorization header'),
    (401,'private-password','rejected administrator authentication'),
    (403,'private-password','denied checkout administration'),
    (403,{'details':'private-password'},'denied checkout administration'),
])
def test_admin_errors_explain_the_specific_rejection_without_exposing_unknown_bodies(checkout,status,reason,expected):
    _,admin,_=checkout
    with patch('app.account_checkout.requests.request',return_value=reply({'error':reason},status)):
        response=admin.post('/api/projects/lab/accessforge/connection',json={'url':'https://accessforge.example','username':'root@pam','password':'private-password'})
    assert response.status_code==502 and expected in response.get_json()['error']
    assert 'private-password' not in response.get_data(as_text=True)


@pytest.mark.parametrize('entered,expected',[
    ('jcacosta','jcacosta@pam'),(' jcacosta ','jcacosta@pam'),
    ('jcacosta@pve','jcacosta@pve'),('jcacosta@ldap','jcacosta@ldap'),
])
def test_admin_username_defaults_to_pam_and_preserves_explicit_realms(checkout,entered,expected):
    app,admin,_=checkout
    with patch('app.account_checkout.requests.request',return_value=reply({'service':'AccessForge','checkout_api':1})) as remote:
        result=admin.post('/api/projects/lab/accessforge/connection',json={'url':'https://accessforge.example','username':entered,'password':'admin-password','persist':True})
    assert result.status_code==200
    assert remote.call_args.kwargs['auth']==(expected,'admin-password')
    assert admin.get('/api/projects/lab/accessforge/connection').get_json()['username']==expected
    with app.app_context():
        assert ConnectionStore().get('instructor','lab')['username']==expected


def test_legacy_bare_username_keeps_saved_password_when_normalized(checkout):
    app,admin,_=checkout
    with app.app_context():
        ConnectionStore().save('instructor','lab','https://accessforge.example','jcacosta','admin-password',False)
    assert admin.get('/api/projects/lab/accessforge/connection').get_json()['username']=='jcacosta@pam'
    with patch('app.account_checkout.requests.request',return_value=reply(snapshot())) as remote:
        assert admin.get('/api/projects/lab/accessforge/status').status_code==200
    assert remote.call_args.kwargs['auth']==('jcacosta@pam','admin-password')
    with patch('app.account_checkout.requests.request',return_value=reply({'service':'AccessForge','checkout_api':1})) as remote:
        result=admin.post('/api/projects/lab/accessforge/connection',json={'url':'https://accessforge.example','username':'jcacosta@pam','password':''})
    assert result.status_code==200 and remote.call_args.kwargs['auth']==('jcacosta@pam','admin-password')


def test_configuration_url_and_port_save_without_credentials_or_remote_requests(checkout):
    _,admin,_=checkout
    with patch('app.account_checkout.requests.request') as remote:
        response=admin.patch('/api/projects/lab/accessforge/connection',json={'url':'https://accessforge.example','api_port':8443})
        remote.assert_not_called()
    assert response.status_code==200
    assert response.get_json()['checkout']['connection_url']=='https://accessforge.example:8443'
    connection=admin.get('/api/projects/lab/accessforge/connection').get_json()
    assert connection['url']=='https://accessforge.example:8443' and not connection['connected']
    project=admin.get('/api/projects').get_json()['projects'][0]
    assert project['checkout']['connection_url']==connection['url']


def test_changing_destination_invalidates_saved_and_session_credentials(checkout):
    _,admin,_=checkout;connect(admin)
    assert admin.patch('/api/projects/lab/accessforge/connection',json={'url':'https://accessforge.example','api_port':443}).status_code==200
    assert admin.get('/api/projects/lab/accessforge/connection').get_json()['persist']
    response=admin.patch('/api/projects/lab/accessforge/connection',json={'url':'https://other.example','api_port':8443})
    assert response.status_code==200
    stored=admin.get('/api/projects/lab/accessforge/connection',headers=temporary_headers()).get_json()
    assert not stored['connected'] and not stored['persist'] and not stored['session_valid']
    assert stored['url']=='https://other.example:8443'
    with patch('app.account_checkout.requests.request') as remote:
        assert admin.get('/api/projects/lab/accessforge/status',headers=temporary_headers()).status_code==409
        remote.assert_not_called()


@pytest.mark.parametrize('port',[0,65536,'bad',True])
def test_configuration_api_port_validation(checkout,port):
    _,admin,_=checkout
    assert admin.patch('/api/projects/lab/accessforge/connection',json={'url':'https://accessforge.example','api_port':port}).status_code==400


def test_enable_selected_checkout_accounts_publishes_saved_credentials_then_marks_eligibility(checkout):
    _,admin,_=checkout;connect(admin)
    published=snapshot(None);published['accounts']['student01@pve'].update(eligible=False,login_disabled=True)
    enabled=snapshot(None);enabled['accounts']['student01@pve'].update(eligible=True,login_disabled=True)
    with patch('app.account_checkout.requests.request',side_effect=[reply(published),reply({'checkout':enabled})]) as remote:
        response=admin.post('/api/projects/lab/accessforge/checkout-accounts',json={'usernames':['student01'],'enabled':True,'password':'ignore-browser-password','secret':'do-not-change-policy'})
    assert response.status_code==200
    assert [call.args[0] for call in remote.call_args_list]==['PUT','POST']
    assert remote.call_args_list[0].kwargs['json']=={'name':'Networking','accounts':[{'username':'student01','password':'password-one'}]}
    assert remote.call_args_list[1].kwargs['json']=={'action':'enable','usernames':['student01']}
    account=response.get_json()['checkout']['accounts']['student01']
    assert account['eligible'] and account['login_disabled']
    assert 'password-one' not in response.get_data(as_text=True)


def test_disable_checkout_ignores_unpublished_accounts_without_releasing_assignments(checkout):
    _,admin,_=checkout;connect(admin)
    disabled=snapshot();disabled['accounts']['student01@pve']['eligible']=False
    with patch('app.account_checkout.requests.request',side_effect=[reply(snapshot()),reply({'checkout':disabled})]) as remote:
        response=admin.post('/api/projects/lab/accessforge/checkout-accounts',json={'usernames':['student01','student02'],'enabled':False})
    assert response.status_code==200
    assert remote.call_args.kwargs['json']=={'action':'disable','usernames':['student01']}
    assert response.get_json()['checkout']['accounts']['student01']['email']=='one@example.edu'


def test_checkout_selection_rejects_unknown_names_and_requires_admin(checkout):
    app,admin,_=checkout;connect(admin)
    with patch('app.account_checkout.requests.request') as remote:
        assert admin.post('/api/projects/lab/accessforge/checkout-accounts',json={'usernames':['unknown'],'enabled':True}).status_code==400
        assert app.test_client().post('/api/projects/lab/accessforge/checkout-accounts',json={'usernames':['student01'],'enabled':True}).status_code==401
        remote.assert_not_called()


def test_checkout_name_survives_status_cache_and_project_mapping(checkout):
    _,admin,_=checkout;connect(admin)
    data=snapshot();data['accounts']['student01@pve']['name']='Zoë García'
    with patch('app.account_checkout.requests.request',return_value=reply(data)):
        response=admin.get('/api/projects/lab/accessforge/status')
    assert response.status_code==200
    assert response.get_json()['checkout']['accounts']['student01']['name']=='Zoë García'
    assert admin.get('/api/projects').get_json()['projects'][0]['checkout']['accounts']['student01']['name']=='Zoë García'
    page=admin.get('/static/accessforge_manager.html').get_data(as_text=True)
    assert '<th>Name</th>' in page


def test_checkout_settings_forward_only_policy_fields_and_never_cache_secret(checkout):
    app,admin,_=checkout;connect(admin)
    data=snapshot();data.update(enabled=True,verify_email=False,secret_set=True,secret='must-not-return')
    with patch('app.account_checkout.requests.request',return_value=reply(data)) as remote:
        result=admin.patch('/api/projects/lab/accessforge/settings',json={'secret':'new-lab-secret','enabled':True,'verify_email':False,'pool_id':'other','accounts':[{'username':'unselected'}]})
    assert result.status_code==200
    assert remote.call_args.args[0]=='PATCH'
    assert remote.call_args.kwargs['json']=={'secret':'new-lab-secret','enabled':True,'verify_email':False}
    assert result.get_json()['checkout']['secret_set'] is True
    assert 'new-lab-secret' not in result.get_data(as_text=True) and 'must-not-return' not in result.get_data(as_text=True)
    with app.app_context():
        cached=ConnectionStore().get('instructor','lab')['summary']
        assert 'new-lab-secret' not in cached and 'must-not-return' not in cached
    assert app.test_client().patch('/api/projects/lab/accessforge/settings',json={'secret':'unauthorized'}).status_code==401


def test_blank_secret_preserves_existing_secret_and_missing_pool_requires_publish(checkout):
    _,admin,_=checkout;connect(admin)
    with patch('app.account_checkout.requests.request',return_value=reply(snapshot())) as remote:
        assert admin.patch('/api/projects/lab/accessforge/settings',json={'secret':'','enabled':False,'verify_email':True}).status_code==200
    assert remote.call_args.kwargs['json']=={'enabled':False,'verify_email':True}
    with patch('app.account_checkout.requests.request',return_value=reply({'error':'Checkout pool not found.'},404)):
        result=admin.patch('/api/projects/lab/accessforge/settings',json={'secret':'new-secret'})
    assert result.status_code==409 and 'On-demand (checkout)' in result.get_json()['error']


@pytest.mark.parametrize('data',[{'secret':'short'},{'secret':'x'*257},{'secret':None},{'enabled':'true'},{'verify_email':1}])
def test_invalid_checkout_settings_cannot_reach_accessforge(checkout,data):
    _,admin,_=checkout;connect(admin)
    with patch('app.account_checkout.requests.request') as remote:
        assert admin.patch('/api/projects/lab/accessforge/settings',json=data).status_code==400
        remote.assert_not_called()


def test_admin_can_relinquish_selected_accounts_and_partial_failures_remain_visible(checkout):
    _,admin,_=checkout;connect(admin)
    state=snapshot(None);state['accounts']['student01@pve'].update(login_disabled=True,relinquished_at=34567)
    state['accounts']['student02@pve']={'email':'two@example.edu','releasing':True,'eligible':True}
    results=[{'username':'student01@pve','released':True},{'username':'student02@pve','released':False,'error':'Could not disable login.'}]
    with patch('app.account_checkout.requests.request',return_value=reply({'checkout':state,'results':results})) as remote:
        result=admin.post('/api/projects/lab/accessforge/relinquish-accounts',json={'confirmed':True,'usernames':['student01','student02']})
    assert result.status_code==200
    assert remote.call_args.kwargs['json']=={'action':'release','usernames':['student01','student02']}
    assert result.get_json()['results'][0]['success'] is True and result.get_json()['results'][1]['success'] is False
    accounts=result.get_json()['checkout']['accounts']
    assert accounts['student01']['login_disabled'] and accounts['student01']['email'] is None
    assert accounts['student02']['email']=='two@example.edu' and accounts['student02']['releasing']


def test_admin_relinquish_requires_confirmation_saved_names_and_authentication(checkout):
    app,admin,_=checkout;connect(admin)
    with patch('app.account_checkout.requests.request') as remote:
        assert admin.post('/api/projects/lab/accessforge/relinquish-accounts',json={'usernames':['student01']}).status_code==400
        assert admin.post('/api/projects/lab/accessforge/relinquish-accounts',json={'confirmed':True,'usernames':['unknown']}).status_code==400
        assert app.test_client().post('/api/projects/lab/accessforge/relinquish-accounts',json={'confirmed':True,'usernames':['student01']}).status_code==401
        remote.assert_not_called()


def test_enabling_refreshes_only_selected_saved_credentials_before_enabling_without_password_reset(checkout):
    app,admin,project=checkout;connect(admin)
    project.credentials[0]['password']='updated-password'
    ProjectStore(app.config['DATA_DIR']).upsert(project)
    copied=snapshot(None)
    copied['accounts']['student01@pve'].update(login_disabled=True,eligible=False)
    enabled=snapshot(None)
    enabled['accounts']['student01@pve'].update(login_disabled=False,eligible=False)
    with patch('app.account_checkout.requests.request',side_effect=[reply(copied),reply({'checkout':enabled,'results':[{'username':'student01@pve','success':True}]})]) as remote:
        response=admin.post('/api/projects/lab/accessforge/reenable-logins',json={'usernames':['student01'],'password':'browser-password-must-not-be-used','enabled':True})
    assert response.status_code==200
    assert [call.args[0] for call in remote.call_args_list]==['PUT','POST']
    publish,enable=remote.call_args_list
    assert publish.kwargs['json']=={'name':'Networking','accounts':[{'username':'student01','password':'updated-password'}]}
    assert enable.kwargs['json']=={'action':'reenable_logins','accounts':[{'username':'student01','password':'updated-password'}]}
    assert publish.args[1]==enable.args[1]
    state=response.json['checkout']['accounts']['student01']
    assert state['eligible'] is False and state['login_disabled'] is False
    assert 'updated-password' not in response.get_data(as_text=True)


def test_enabling_stops_if_refreshing_saved_credentials_fails(checkout):
    _,admin,_=checkout;connect(admin)
    with patch('app.account_checkout.requests.request',return_value=reply({'error':'Release student01@pve in AccessForge before replacing its published credentials.'},409)) as remote:
        response=admin.post('/api/projects/lab/accessforge/reenable-logins',json={'usernames':['student01']})
    assert response.status_code==409
    assert remote.call_count==1 and remote.call_args.args[0]=='PUT'


def test_refresh_replaces_checkout_ground_truth_instead_of_merging_stale_marks_and_assignments(checkout):
    _,admin,_=checkout;connect(admin)
    previous=snapshot('old@example.edu')
    previous['accounts']['student02@pve']={'eligible':True,'email':None}
    current=snapshot(None);current['accounts']['student01@pve']['eligible']=False
    with patch('app.account_checkout.requests.request',side_effect=[reply(previous),reply(current)]) as remote:
        assert admin.get('/api/projects/lab/accessforge/status').status_code==200
        result=admin.get('/api/projects/lab/accessforge/status')
        assert result.status_code==200
        state=result.json['checkout']
        assert state['accounts']['student01']['eligible'] is False
        assert state['accounts']['student01']['email'] is None
        assert 'student02' not in state['accounts']
        assert admin.get('/api/projects/lab/accessforge/accounts').json['checkout']==state
        assert admin.get('/api/projects').json['projects'][0]['checkout']==state
        assert remote.call_count==2
