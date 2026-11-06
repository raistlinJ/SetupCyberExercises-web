(function(){
  const el=id=>document.getElementById(id);
  const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const columnIds=['username','status','email','checked_out_at','checkout_ip','relinquished_at','relinquished_ip'];
  const intervals=[0,15,30,60,300];
  let pid='',version=0,accounts=[],snapshot={},busy=false,loading=false,connected=false,dialogOpen=false,timer=null,columns={},selected=new Set();
  const current=(project,revision)=>project===pid&&revision===version;
  async function api(project,path,method='GET',data){
    const response=await fetch(`/api/projects/${encodeURIComponent(project)}/accessforge/${path}`,{method,credentials:'same-origin',cache:'no-store',headers:{'Content-Type':'application/json'},body:data===undefined?undefined:JSON.stringify(data)});
    let result={};try{result=await response.json();}catch{}
    if(!response.ok)throw new Error(result.error||`Request failed (HTTP ${response.status}).`);return result;
  }
  function message(text,error=false){el('af-status').textContent=text;el('af-status').className=`small mb-2 ${error?'text-danger':'text-success'}`;}
  function connectionMessage(text,error=false){el('af-connection-feedback').textContent=text;el('af-connection-feedback').className=`me-auto small ${error?'text-danger':'text-success'}`;}
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
    for(const id of ['af-publish','af-refresh','af-accounts-button','af-disable-logins','af-reset-passwords','af-reenable-logins'])el(id).disabled=unavailable||!connected;
    for(const id of ['af-connection-button','af-save-connection','af-disconnect'])el(id).disabled=unavailable;
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
    const filter=el('af-filter').value;let match=text=>text.toLowerCase().includes(filter.toLowerCase()),invalid=false;
    if(el('af-filter-regex').checked){try{const regex=new RegExp(filter,'i');match=text=>regex.test(text);}catch{invalid=true;match=()=>true;}}
    el('af-filter-error').classList.toggle('d-none',!invalid);
    const cell=(key,value)=>`<td${columns[key]===false?' hidden':''} style="overflow-wrap:anywhere">${value}</td>`;
    el('af-accounts').innerHTML=accounts.filter(a=>{
      const state=snapshot.accounts?.[a.username];
      return (!el('af-filter-selected').checked||selected.has(a.username))&&match([a.username,status(state),state?.email,state?.checkout_ip,state?.relinquished_ip,stamp(state?.checked_out_at||state?.assigned_at),stamp(state?.relinquished_at)].join(' '));
    }).map(a=>{
      const state=snapshot.accounts?.[a.username];
      return `<tr><td><input type="checkbox" class="form-check-input af-account" data-user="${esc(a.username)}" aria-label="Select ${esc(a.username)}" ${selected.has(a.username)?'checked':''}></td>${cell('username',esc(a.username))}${cell('status',status(state)+(state?.password_rotated?'<div class="small text-muted">Legacy password differs; reset before re-enabling</div>':''))}${cell('email',esc(state?.email||'—'))}${cell('checked_out_at',esc(stamp(state?.checked_out_at||state?.assigned_at)))}${cell('checkout_ip',esc(state?.checkout_ip||'—'))}${cell('relinquished_at',esc(stamp(state?.relinquished_at)))}${cell('relinquished_ip',esc(state?.relinquished_ip||'—'))}</tr>`;
    }).join('')||`<tr><td colspan="${1+columnIds.filter(id=>columns[id]!==false).length}" class="text-muted">No matching saved accounts.</td></tr>`;
    el('af-accounts').querySelectorAll('.af-account').forEach(box=>box.addEventListener('change',()=>{box.checked?selected.add(box.dataset.user):selected.delete(box.dataset.user);render();}));
    const boxes=[...el('af-accounts').querySelectorAll('.af-account')];
    el('af-select-all').checked=!!boxes.length&&boxes.every(box=>box.checked);
    el('af-select-all').indeterminate=boxes.some(box=>box.checked)&&!el('af-select-all').checked;
    document.querySelectorAll('#af-table thead th').forEach((cell,index)=>{if(index)cell.hidden=columns[columnIds[index-1]]===false;});
    el('af-snapshot').textContent=snapshot.checked_at?`Last refresh: ${new Date(snapshot.checked_at*1000).toLocaleString()}. Use Refresh to update this snapshot.`:'Showing saved project accounts. Use Connection, then Refresh to load AccessForge status.';
  }
  function hideConnection(){window.bootstrap?.Modal.getInstance(el('af-connection'))?.hide();}
  function clearPassword(){
    el('af-password').value='';el('af-password').type='password';el('af-show-password').setAttribute('aria-pressed','false');
    el('af-show-password').setAttribute('aria-label','Show password');el('af-show-password').title='Show password';
  }
  async function load(){
    const project=window.shell?.getCurrentProjectId()||'';pid=project;const revision=++version;
    loading=true;connected=false;selected.clear();accounts=[];snapshot={};clearPassword();hideConnection();
    el('af-url').value='';el('af-username').value='';el('af-project').textContent='Select a project.';el('af-disconnect').classList.add('d-none');
    links('');restorePrefs();render();message('');connectionMessage('');applyAuto();
    if(!pid){loading=false;updateControls();return;}
    try{
      const [connection,data,response]=await Promise.all([api(project,'connection'),api(project,'accounts'),fetch('/api/projects',{credentials:'same-origin'})]);
      const projects=await response.json();if(!response.ok)throw new Error(projects.error||'Could not load projects.');
      if(!current(project,revision))return;
      el('af-project').textContent=projects.projects?.find(p=>String(p.id)===pid)?.name||pid;
      accounts=data.accounts;snapshot=data.checkout||{};connected=!!connection.connected;
      el('af-url').value=connection.url;el('af-username').value=connection.username;el('af-verify').checked=connection.verify_ssl;
      el('af-password').placeholder=connected?'Saved; leave blank to keep it':'Enter administrator password';
      el('af-disconnect').classList.toggle('d-none',!connected);links(connection.url);render();
      if(data.legacy_assignments)message('Legacy SCE-web assignments are available and will be preserved when those accounts are first published.');
    }catch(error){if(current(project,revision))message(error.message,true);}finally{if(current(project,revision)){loading=false;updateControls();}}
  }
  async function run(fn,{connection=false}={}){
    if(busy||loading||!pid)return;
    window.bootstrap?.Dropdown.getInstance(el('af-accounts-button'))?.hide();
    busy=true;const project=pid,revision=version;updateControls();
    try{await fn(project,revision);}catch(error){if(current(project,revision)){message(error.message,true);if(connection)connectionMessage(error.message,true);}}finally{busy=false;updateControls();}
  }
  async function refresh(project,revision){
    message('Refreshing AccessForge status…');const data=await api(project,'status');if(!current(project,revision))return;
    snapshot=data.checkout||{};render();message('Status updated.');
  }
  el('af-connection-form').addEventListener('submit',event=>{event.preventDefault();run(async(project,revision)=>{
    connectionMessage('Checking administrator connection…');
    const url=el('af-url').value;
    const result=await api(project,'connection','POST',{url,username:el('af-username').value,password:el('af-password').value,verify_ssl:el('af-verify').checked});
    if(!current(project,revision))return;
    connected=true;clearPassword();el('af-password').placeholder='Saved; leave blank to keep it';el('af-disconnect').classList.remove('d-none');links(url);
    connectionMessage('Connection saved.');message(`Connected as ${result.administrator}. Use Refresh to request status.`);hideConnection();
  },{connection:true});});
  el('af-disconnect').addEventListener('click',()=>run(async(project,revision)=>{
    if(!confirm('Remove this saved connection? Published accounts and assignments remain in AccessForge.'))return;
    await api(project,'connection','DELETE');if(!current(project,revision))return;
    hideConnection();await load();message('Disconnected. Published accounts remain in AccessForge.');
  },{connection:true}));
  el('af-refresh').addEventListener('click',()=>run(refresh));
  el('af-publish').addEventListener('click',()=>run(async(project,revision)=>{
    if(!selected.size)throw new Error('Select at least one saved account to publish.');
    message('Publishing selected accounts…');const data=await api(project,'publish','POST',{usernames:[...selected]});if(!current(project,revision))return;
    snapshot=data.checkout||{};selected.clear();render();message('Accounts published. Configure availability and checkout policy in AccessForge.');
  }));
  for(const [id,operation,confirmation] of [
    ['af-disable-logins','disable-logins','Disable the selected unassigned Proxmox logins?'],
    ['af-reset-passwords','reset-passwords','Set the selected passwords to the saved Configuration credentials? These logins will stay disabled.'],
    ['af-reenable-logins','reenable-logins','Re-enable the selected prepared logins and make them available according to AccessForge checkout policy?']
  ])el(id).addEventListener('click',()=>run(async(project,revision)=>{
    if(!selected.size)throw new Error('Select at least one saved account.');
    if(!confirm(confirmation))return;
    message('Updating selected logins…');const data=await api(project,operation,'POST',{usernames:[...selected]});if(!current(project,revision))return;
    snapshot=data.checkout||{};selected.clear();render();
    const failures=(data.results||[]).filter(row=>!row.success);
    message(failures.length?failures.map(row=>`${row.username}: ${row.error}`).join(' '):'Selected logins updated.',!!failures.length);
  }));
  for(const id of ['af-filter','af-filter-regex','af-filter-selected'])el(id).addEventListener(id==='af-filter'?'input':'change',()=>{savePrefs();render();});
  el('af-clear-filter').addEventListener('click',()=>{el('af-filter').value='';el('af-filter-regex').checked=false;el('af-filter-selected').checked=false;savePrefs();render();});
  function selectVisible(checked){el('af-accounts').querySelectorAll('.af-account').forEach(box=>{checked?selected.add(box.dataset.user):selected.delete(box.dataset.user);});render();}
  el('af-select-all').addEventListener('change',event=>selectVisible(event.target.checked));
  el('af-select-visible').addEventListener('click',()=>selectVisible(true));
  el('af-clear-selection').addEventListener('click',()=>{selected.clear();render();});
  document.querySelectorAll('.af-column').forEach(box=>box.addEventListener('change',()=>{columns[box.value]=box.checked;savePrefs();render();}));
  el('af-auto-interval').addEventListener('change',()=>{savePrefs();applyAuto();});
  el('af-connection').addEventListener('show.bs.modal',()=>{dialogOpen=true;connectionMessage('');updateControls();});
  el('af-connection').addEventListener('hidden.bs.modal',()=>{dialogOpen=false;clearPassword();updateControls();});
  el('af-show-password').addEventListener('click',()=>{
    const show=el('af-password').type==='password';el('af-password').type=show?'text':'password';
    el('af-show-password').setAttribute('aria-pressed',String(show));el('af-show-password').setAttribute('aria-label',show?'Hide password':'Show password');el('af-show-password').title=show?'Hide password':'Show password';
  });
  document.addEventListener('visibilitychange',updateControls);
  window.addEventListener('pagehide',()=>{if(timer!==null)clearInterval(timer);timer=null;});
  window.addEventListener('pageshow',applyAuto);
  document.addEventListener('DOMContentLoaded',async()=>{
    await shell.initShell('accessforge');
    document.addEventListener('project-selected',load);
    await load();
    try{const data=await AUTH.me();el('banner-username').textContent=data?.user?.username||'anonymous';}catch{}
    el('banner-logout').addEventListener('click',async()=>{await AUTH.logout();location.href='/';});
  });
})();
