(function(){
  const el=id=>document.getElementById(id);
  const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const columnIds=['username','status','name','email','checked_out_at','checkout_ip','relinquished_at'];
  const rowTags=window.RowTags.create('accessforge');
  const tagKey=username=>JSON.stringify([pid,username]);
  const intervals=[0,15,30,60,300];
  let pid='',owner='__anonymous__',version=0,accounts=[],snapshot={},busy=false,loading=false,connected=false,dialogOpen=false,timer=null,columns={},selected=new Set();
  const current=(project,revision)=>project===pid&&revision===version;
  const adminUsername=value=>{const name=String(value??'').trim();return name&&!name.includes('@')?name+'@pam':name;};
  const connectionKey=project=>`toolhub.accessforge.session.${encodeURIComponent(owner)}.${encodeURIComponent(project)}`;
  function sessionConnection(project){
    try{
      const value=JSON.parse(sessionStorage.getItem(connectionKey(project))||'null');
      return value&&typeof value.url==='string'&&typeof value.username==='string'&&typeof value.password==='string'&&value.password?{...value,username:adminUsername(value.username)}:null;
    }catch{return null;}
  }
  function saveSessionConnection(project,value){
    try{value?sessionStorage.setItem(connectionKey(project),JSON.stringify(value)):sessionStorage.removeItem(connectionKey(project));}
    catch{throw new Error('Could not update browser-session credentials. Enable session storage or choose Save credentials.');}
  }
  async function api(project,path,method='GET',data){
    const headers={'Content-Type':'application/json'},temporary=sessionConnection(project);
    if(temporary)headers['X-AccessForge-Connection']=encodeURIComponent(JSON.stringify(temporary));
    const transport=path==='settings'&&window.ServerQueue?.nativeFetch?window.ServerQueue.nativeFetch:fetch;
    const response=await transport(`/api/projects/${encodeURIComponent(project)}/accessforge/${path}`,{method,credentials:'same-origin',cache:'no-store',headers,body:data===undefined?undefined:JSON.stringify(data)});
    let result={};try{result=await response.json();}catch{}
    if(!response.ok)throw new Error(result.error||`Request failed (HTTP ${response.status}).`);return result;
  }
  function message(text,error=false){el('af-status').textContent=text;el('af-status').className=`small mb-2 ${error?'text-danger':'text-success'}`;}
  function connectionMessage(text,error=false){el('af-connection-feedback').textContent=text;el('af-connection-feedback').className=`me-auto small ${error?'text-danger':'text-success'}`;}
  function checkoutMessage(text,error=false){el('af-checkout-feedback').textContent=text;el('af-checkout-feedback').className=`me-auto small ${error?'text-danger':'text-success'}`;}
  function links(url){
    for(const [id,path] of [['af-admin-link','/admin/checkouts'],['af-student-link','/checkout']]){
      const link=el(id);link.href=url?url.replace(/\/$/,'')+path:'#';link.classList.toggle('d-none',!url);
    }
  }
  function prefsKey(){return `toolhub.accessforge.table.${pid}`;}
  function restorePrefs(){
    let prefs={};try{prefs=JSON.parse(sessionStorage.getItem(prefsKey())||'{}')||{};}catch{}
    columns=Object.fromEntries(columnIds.map(id=>[id,prefs.columns?.[id]!==false]));
    document.querySelectorAll('.af-column').forEach(box=>box.checked=columns[box.value]);
    el('af-auto-interval').value=String(intervals.includes(prefs.auto)?prefs.auto:0);
    el('af-filter').value=typeof prefs.filter==='string'?prefs.filter:'';
    el('af-filter-regex').checked=!!prefs.regex;el('af-filter-selected').checked=false;
  }
  function savePrefs(){
    if(!pid)return;
    try{sessionStorage.setItem(prefsKey(),JSON.stringify({columns,auto:Number(el('af-auto-interval').value),filter:el('af-filter').value,regex:el('af-filter-regex').checked}));}catch{}
  }
  function updateControls(){
    const unavailable=!pid||busy||loading;
    for(const id of ['af-refresh','af-accounts-button','af-disable-logins','af-reenable-logins','af-relinquish','af-checkout-settings'])el(id).disabled=unavailable||!connected;
    for(const id of ['af-connection-button','af-save-connection','af-disconnect'])el(id).disabled=unavailable;
    for(const id of ['af-checkout-save','af-checkout-secret','af-checkout-enabled','af-checkout-verify'])el(id).disabled=unavailable||!connected;
    el('af-auto-interval').disabled=!pid||loading;
    el('af-refresh-wrapper').title=connected?'Refresh account status from AccessForge.':'Please authenticate to AccessForge first.';
    const seconds=Number(el('af-auto-interval').value);
    const state=!seconds||!pid?'Off':!connected?'Auth':dialogOpen||document.hidden?'Pause':busy||loading?'Busy':'On';
    el('af-auto-badge').textContent=state;
    el('af-auto-badge').className=`badge ${state==='On'?'bg-success':state==='Auth'?'bg-warning text-dark':state==='Busy'?'bg-info text-dark':state==='Pause'?'bg-dark':'bg-secondary'} align-self-center ms-1`;
  }
  function applyAuto(){
    if(timer!==null)clearInterval(timer);timer=null;
    const seconds=Number(el('af-auto-interval').value),project=pid,revision=version;
    if(seconds&&pid)timer=setInterval(()=>{
      if(!current(project,revision)||!connected||busy||loading||dialogOpen||document.hidden)return;
      run(refresh);
    },seconds*1000);
    updateControls();
  }
  function status(state){return !state?'Not published':state.releasing?'Disable pending':state.login_disabled?'Disabled':state.email?'Checked out':state.eligible?'Available':'Checkout off';}
  function stamp(value){return value?new Date(value*1000).toLocaleString():'—';}
  function render(){
    const marked=new Set(accounts.filter(account=>snapshot.accounts?.[account.username]?.eligible).map(account=>account.username));
    selected=new Set([...selected].filter(username=>marked.has(username)));
    const filter=el('af-filter').value;let match=text=>text.toLowerCase().includes(filter.toLowerCase()),invalid=false;
    if(el('af-filter-regex').checked){try{const regex=new RegExp(filter,'i');match=text=>regex.test(text);}catch{invalid=true;match=()=>true;}}
    el('af-filter-error').classList.toggle('d-none',!invalid);
    const cell=(key,value)=>`<td${columns[key]===false?' hidden':''} style="overflow-wrap:anywhere">${value}</td>`;
    el('af-accounts').innerHTML=accounts.filter(a=>{
      const state=snapshot.accounts?.[a.username];
      return marked.has(a.username)&&rowTags.matches(tagKey(a.username))&&(!el('af-filter-selected').checked||selected.has(a.username))&&match([a.username,status(state),state?.name,state?.email,state?.checkout_ip,stamp(state?.checked_out_at||state?.assigned_at),stamp(state?.relinquished_at)].join(' '));
    }).map(a=>{
      const state=snapshot.accounts?.[a.username],badges=`<span class="row-tag-badges">${rowTags.badges(tagKey(a.username))}</span>`;
      return `<tr><td><input type="checkbox" class="form-check-input af-account" data-user="${esc(a.username)}" aria-label="Select ${esc(a.username)}" ${selected.has(a.username)?'checked':''}>${columns.username===false?badges:''}</td>${cell('username',esc(a.username)+badges)}${cell('status',status(state)+(state?.password_rotated?'<div class="small text-muted">Legacy password differs; reset before re-enabling</div>':''))}${cell('name',esc(state?.name||'—'))}${cell('email',esc(state?.email||'—'))}${cell('checked_out_at',esc(stamp(state?.checked_out_at||state?.assigned_at)))}${cell('checkout_ip',esc(state?.checkout_ip||'—'))}${cell('relinquished_at',esc(stamp(state?.relinquished_at)))}</tr>`;
    }).join('')||`<tr><td colspan="${1+columnIds.filter(id=>columns[id]!==false).length}" class="text-muted">No matching checkout accounts. Select On-demand (checkout) in Configuration to add accounts.</td></tr>`;
    el('af-accounts').querySelectorAll('.af-account').forEach(box=>box.addEventListener('change',()=>{box.checked?selected.add(box.dataset.user):selected.delete(box.dataset.user);render();}));
    const boxes=[...el('af-accounts').querySelectorAll('.af-account')];
    el('af-select-all').checked=!!boxes.length&&boxes.every(box=>box.checked);
    el('af-select-all').indeterminate=boxes.some(box=>box.checked)&&!el('af-select-all').checked;
    document.querySelectorAll('#af-table thead th').forEach((cell,index)=>{if(index)cell.hidden=columns[columnIds[index-1]]===false;});
    el('af-selection-count').innerHTML=pid?`<span class="border rounded px-2 py-1">${esc(el('af-project').textContent==='Select a project.'?pid:el('af-project').textContent)}: <strong>${selected.size} selected</strong></span>`:'';
    rowTags.refreshControls();
    el('af-snapshot').textContent=snapshot.checked_at?`Last refresh: ${new Date(snapshot.checked_at*1000).toLocaleString()}. Use Refresh to update this snapshot.`:'Showing accounts marked for checkout. Refresh AccessForge to sync the authoritative checkout state across all managers.';
  }
  function setSnapshot(value){snapshot=value||{};window.CheckoutState?.publish(pid,snapshot);}
  function hideConnection(){window.bootstrap?.Modal.getInstance(el('af-connection'))?.hide();}
  function hideCheckoutSettings(){window.bootstrap?.Modal.getInstance(el('af-checkout-modal'))?.hide();}
  function clearPassword(){
    el('af-password').value='';el('af-password').type='password';el('af-show-password').setAttribute('aria-pressed','false');
    el('af-show-password').setAttribute('aria-label','Show password');el('af-show-password').title='Show password';
  }
  async function load(){
    const project=window.shell?.getCurrentProjectId()||'';pid=project;const revision=++version;
    loading=true;connected=false;selected.clear();accounts=[];snapshot={};clearPassword();hideConnection();hideCheckoutSettings();window.bootstrap?.Modal.getInstance(el('af-refresh-summary'))?.hide();el('af-refresh-results').innerHTML='';el('af-refresh-totals').textContent='';el('af-refresh-project').textContent='';el('af-checkout-secret').value='';checkoutMessage('');
    el('af-save-creds').checked=false;
    el('af-url').value='';el('af-username').value='';el('af-project').textContent='Select a project.';el('af-disconnect').classList.add('d-none');
    links('');restorePrefs();render();message('');connectionMessage('');applyAuto();
    if(!pid){loading=false;updateControls();return;}
    try{
      const [connection,data,response]=await Promise.all([api(project,'connection'),api(project,'accounts'),fetch('/api/projects',{credentials:'same-origin'})]);
      const projects=await response.json();if(!response.ok)throw new Error(projects.error||'Could not load projects.');
      if(!current(project,revision))return;
      if(connection.session_valid===false)saveSessionConnection(project,null);
      el('af-project').textContent=projects.projects?.find(p=>String(p.id)===pid)?.name||pid;
      accounts=data.accounts;snapshot=data.checkout||{};connected=!!connection.connected;
      el('af-save-creds').checked=!!connection.persist;
      el('af-url').value=connection.url;el('af-username').value=connection.username;el('af-verify').checked=connection.verify_ssl;
      el('af-password').placeholder=connected?'Saved; leave blank to keep it':'Enter administrator password';
      el('af-disconnect').classList.toggle('d-none',!connected);links(connection.url);render();
      if(data.legacy_assignments)message('Legacy SCE-web assignments are available and will be preserved when those accounts are first published.');
    }catch(error){if(current(project,revision))message(error.message,true);}finally{if(current(project,revision)){loading=false;updateControls();}}
  }
  async function run(fn,{connection=false,settings=false}={}){
    if(busy||loading||!pid)return;
    window.bootstrap?.Dropdown.getInstance(el('af-accounts-button'))?.hide();
    busy=true;const project=pid,revision=version;updateControls();
    try{await fn(project,revision);}catch(error){if(current(project,revision)){message(error.message,true);if(connection)connectionMessage(error.message,true);if(settings)checkoutMessage(error.message,true);}}finally{busy=false;updateControls();}
  }
  function showRefreshSummary(before,after){
    const old=before.accounts||{},latest=after.accounts||{};
    const names=[...new Set([...Object.keys(old),...Object.keys(latest)])].filter(username=>old[username]?.eligible||latest[username]?.eligible).sort((a,b)=>a.localeCompare(b));
    const fields=[
      ['eligible','Checkout mark',value=>value?'Marked':'Unmarked',value=>!!value],
      ['email','Assigned email',value=>value||'Unassigned'],
      ['name','Name',value=>value||'—'],
      ['login_disabled','Login',value=>value?'Disabled':'Enabled',value=>!!value],
      ['releasing','Release',value=>value?'Disable pending':'No pending release',value=>!!value],
      ['checked_out_at','Checked out',stamp,value=>Number(value)||0],
      ['checkout_ip','Checkout IP',value=>value||'—'],
      ['relinquished_at','Relinquished',stamp,value=>Number(value)||0],
      ['password_rotated','Legacy password',value=>value?'Differs from saved credentials':'Matches saved credentials',value=>!!value],
    ];
    const rows=names.map(username=>{
      const previous=old[username],account=latest[username],changes=[];
      if(!previous)changes.push('Added to checkout snapshot');
      else if(!account)changes.push('Removed from checkout snapshot');
      else for(const [key,label,format,normalize=value=>value||''] of fields){
        const prev=key==='checked_out_at'?(previous.checked_out_at||previous.assigned_at):previous[key];
        const next=key==='checked_out_at'?(account.checked_out_at||account.assigned_at):account[key];
        if(normalize(prev)!==normalize(next))changes.push(`${label}: ${format(prev)} → ${format(next)}`);
      }
      return {username,account,changes};
    });
    const changed=rows.filter(row=>row.changes.length).length;
    el('af-refresh-project').textContent=el('af-project').textContent;
    el('af-refresh-totals').textContent=`${rows.length} account(s) checked · ${changed} changed · ${rows.length-changed} unchanged`;
    el('af-refresh-results').innerHTML=rows.map(({username,account,changes})=>`<tr><td>${esc(username)}</td><td><span class="badge ${account?'bg-success':'bg-secondary'}">${account?'Synced':'Removed'}</span></td><td>${account?(account.eligible?'Marked':'Unmarked'):'—'}</td><td>${esc(account?.email?(account.name?`${account.name} (${account.email})`:account.email):'Unassigned')}</td><td>${account?(account.releasing?'Disable pending':account.login_disabled?'Disabled':'Enabled'):'—'}</td><td>${changes.length?changes.map(change=>`<div>${esc(change)}</div>`).join(''):'<span class="text-muted">No changes</span>'}</td></tr>`).join('')||'<tr><td colspan="6" class="text-muted">No accounts marked for checkout. Use Configuration → Credentials → On-demand (checkout) to add accounts for checkout.</td></tr>';
    window.bootstrap?.Modal.getOrCreateInstance(el('af-refresh-summary'))?.show();
  }
  async function refresh(project,revision,{summary=false}={}){
    message('Refreshing AccessForge status…');const data=await api(project,'status');if(!current(project,revision))return;
    const previous=snapshot;
    setSnapshot(data.checkout);render();message('Status updated.');
    if(summary)showRefreshSummary(previous,snapshot);
  }
  el('af-connection-form').addEventListener('submit',event=>{event.preventDefault();return run(async(project,revision)=>{
    const url=el('af-url').value.trim().replace(/\/+$/,''),username=adminUsername(el('af-username').value),persist=el('af-save-creds').checked;
    const previous=sessionConnection(project);
    const password=el('af-password').value||(previous?.url===url&&previous?.username===username?previous.password:'');
    if(!persist&&!password)throw new Error('Enter the administrator password to keep this connection in the browser session.');
    const config={url,username,password,verify_ssl:el('af-verify').checked};
    if(!persist)saveSessionConnection(project,config);
    connectionMessage('Checking administrator connection…');
    let result;
    try{result=await api(project,'connection','POST',{...config,persist});}
    catch(error){if(!persist)saveSessionConnection(project,previous);throw error;}
    if(persist&&previous)saveSessionConnection(project,null);
    if(!current(project,revision))return;
    connected=true;clearPassword();el('af-username').value=username;el('af-password').placeholder='Saved; leave blank to keep it';el('af-disconnect').classList.remove('d-none');links(url);
    connectionMessage(persist?'Credentials saved.':'Connected for this browser session.');message(`Connected as ${result.administrator}. Use Refresh to request status.`);hideConnection();
  },{connection:true});});
  el('af-disconnect').addEventListener('click',()=>run(async(project,revision)=>{
    if(!confirm('Remove this saved connection? Published accounts and assignments remain in AccessForge.'))return;
    await api(project,'connection','DELETE');saveSessionConnection(project,null);if(!current(project,revision))return;
    hideConnection();await load();message('Disconnected. Published accounts remain in AccessForge.');
  },{connection:true}));
  el('af-refresh').addEventListener('click',()=>run((project,revision)=>refresh(project,revision,{summary:true})));
  el('af-checkout-settings').addEventListener('click',()=>run(async(project,revision)=>{
    message('Loading checkout settings…');const data=await api(project,'status');if(!current(project,revision))return;
    setSnapshot(data.checkout);render();
    if(snapshot.published===false||(!snapshot.id&&!Object.keys(snapshot.accounts||{}).length))throw new Error('Use Configuration → Credentials → On-demand (checkout) before configuring checkout settings.');
    el('af-checkout-enabled').checked=!!snapshot.enabled;el('af-checkout-verify').checked=snapshot.verify_email!==false;el('af-checkout-secret').value='';
    el('af-checkout-secret-state').textContent=snapshot.secret_set?'A lab secret is set. Leave this field blank to keep it.':'Set a lab secret of 8–256 characters before enabling student checkout.';
    el('af-checkout-secret').placeholder=snapshot.secret_set?'Leave blank to keep the current secret':'Set a lab secret (8+ characters)';
    el('af-checkout-policy-note').textContent=snapshot.smtp_configured?'Email verification uses AccessForge’s configured mail server.':'Email verification requires SMTP configuration on AccessForge. Turn verification off if it is not needed.';
    checkoutMessage('');message('');window.bootstrap?.Modal.getOrCreateInstance(el('af-checkout-modal'))?.show();
  }));
  el('af-checkout-form').addEventListener('submit',event=>{event.preventDefault();return run(async(project,revision)=>{
    checkoutMessage('Saving checkout settings…');
    const data=await api(project,'settings','PATCH',{enabled:el('af-checkout-enabled').checked,verify_email:el('af-checkout-verify').checked,secret:el('af-checkout-secret').value});
    if(!current(project,revision))return;
    el('af-checkout-secret').value='';setSnapshot(data.checkout);render();hideCheckoutSettings();message('Checkout settings saved.');
  },{settings:true});});
  for(const [id,operation,confirmation,progress,success] of [
    ['af-reenable-logins','reenable-logins','Enable the selected accounts? Apply any password changes through VM Manager first. Existing checkout eligibility and lab policy still apply.','Enabling selected accounts…','Selected accounts enabled.'],
    ['af-relinquish','relinquish-accounts','Relinquish the selected accounts? Students will lose access and their Proxmox logins will be disabled until enabled again.','Relinquishing selected accounts…','Selected accounts relinquished. Their logins remain disabled.'],
    ['af-disable-logins','disable-logins','Disable the selected unassigned accounts?','Disabling selected accounts…','Selected accounts disabled.']
  ])el(id).addEventListener('click',()=>run(async(project,revision)=>{
    if(!selected.size)throw new Error('Select at least one saved account.');
    if(!confirm(confirmation))return;
    message(progress);
    const payload={usernames:[...selected]};if(operation==='relinquish-accounts')payload.confirmed=true;
    const data=await api(project,operation,'POST',payload);if(!current(project,revision))return;
    setSnapshot(data.checkout);selected.clear();render();
    const failures=(data.results||[]).filter(row=>!row.success);
    message(failures.length?failures.map(row=>`${row.username}: ${row.error}`).join(' '):success,!!failures.length);
  }));
  for(const id of ['af-filter','af-filter-regex','af-filter-selected'])el(id).addEventListener(id==='af-filter'?'input':'change',()=>{savePrefs();render();});
  el('af-clear-filter').addEventListener('click',()=>{el('af-filter').value='';el('af-filter-regex').checked=false;el('af-filter-selected').checked=false;rowTags.clearFilter();savePrefs();render();});
  function selectVisible(checked){el('af-accounts').querySelectorAll('.af-account').forEach(box=>{checked?selected.add(box.dataset.user):selected.delete(box.dataset.user);});render();}
  el('af-select-all').addEventListener('change',event=>selectVisible(event.target.checked));
  document.querySelectorAll('.af-column').forEach(box=>box.addEventListener('change',()=>{columns[box.value]=box.checked;savePrefs();render();}));
  el('af-auto-interval').addEventListener('change',()=>{savePrefs();applyAuto();});
  el('af-connection').addEventListener('show.bs.modal',()=>{dialogOpen=true;connectionMessage('');updateControls();});
  el('af-connection').addEventListener('hidden.bs.modal',()=>{dialogOpen=false;clearPassword();updateControls();});
  el('af-refresh-summary').addEventListener('show.bs.modal',()=>{dialogOpen=true;updateControls();});
  el('af-refresh-summary').addEventListener('hidden.bs.modal',()=>{dialogOpen=false;updateControls();});
  el('af-checkout-modal').addEventListener('show.bs.modal',()=>{dialogOpen=true;checkoutMessage('');updateControls();});
  el('af-checkout-modal').addEventListener('hidden.bs.modal',()=>{dialogOpen=false;el('af-checkout-secret').value='';updateControls();});
  el('af-show-password').addEventListener('click',()=>{
    const show=el('af-password').type==='password';el('af-password').type=show?'text':'password';
    el('af-show-password').setAttribute('aria-pressed',String(show));el('af-show-password').setAttribute('aria-label',show?'Hide password':'Show password');el('af-show-password').title=show?'Hide password':'Show password';
  });
  document.addEventListener('visibilitychange',updateControls);
  window.addEventListener('pagehide',()=>{if(timer!==null)clearInterval(timer);timer=null;});
  window.addEventListener('pageshow',applyAuto);
  document.addEventListener('DOMContentLoaded',async()=>{
    try{const data=await AUTH.me();owner=data?.user?.username||'__anonymous__';el('banner-username').textContent=owner;}catch{}
    window.CheckoutState?.subscribe((project,value)=>{if(project===pid){snapshot=value;render();}},()=>pid?[pid]:[]);
    rowTags.mount({
      filterHost:el('af-tag-filters'),assignmentHost:el('af-tag-assignment'),notice:el('af-tag-notice'),
      getProjectIds:()=>pid?[pid]:[],getSelectedKeys:()=>[...selected].map(tagKey),onChange:render,
    });
    await shell.initShell('accessforge');
    document.addEventListener('project-selected',load);
    await load();
    el('banner-logout').addEventListener('click',async()=>{await AUTH.logout();location.href='/';});
  });
})();
