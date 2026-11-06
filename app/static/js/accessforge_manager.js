(function(){
  const el=id=>document.getElementById(id);
  const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  let pid='',version=0,accounts=[],snapshot={},busy=false,selected=new Set();
  async function api(project,path,method='GET',data){
    const response=await fetch(`/api/projects/${encodeURIComponent(project)}/accessforge/${path}`,{method,credentials:'same-origin',cache:'no-store',headers:{'Content-Type':'application/json'},body:data===undefined?undefined:JSON.stringify(data)});
    const result=await response.json();if(!response.ok)throw new Error(result.error||'Request failed.');return result;
  }
  function message(text,error=false){el('af-status').textContent=text;el('af-status').className=`small mb-2 ${error?'text-danger':'text-success'}`;}
  function links(url){
    for(const [id,path] of [['af-admin-link','/admin/checkouts'],['af-student-link','/checkout']]){
      const link=el(id);link.href=url?url.replace(/\/$/,'')+path:'#';link.classList.toggle('d-none',!url);
    }
  }
  function render(){
    const filter=el('af-filter').value.toLowerCase();
    el('af-accounts').innerHTML=accounts.filter(a=>(a.username+' '+(snapshot.accounts?.[a.username]?.email||'')+' '+(snapshot.accounts?.[a.username]?.checkout_ip||'')+' '+(snapshot.accounts?.[a.username]?.relinquished_ip||'')).toLowerCase().includes(filter)).map(a=>{
      const state=snapshot.accounts?.[a.username];
      const status=!state?'Not published':state.releasing?'Disable pending':state.login_disabled?'Disabled':state.email?'Checked out':state.eligible?'Available':'Checkout off';
      return `<tr><td><input type="checkbox" class="form-check-input af-account" data-user="${esc(a.username)}" aria-label="Select ${esc(a.username)}" ${selected.has(a.username)?'checked':''}></td><td>${esc(a.username)}</td><td>${status}${state?.password_rotated?'<div class="small text-muted">Legacy password differs; reset before re-enabling</div>':''}</td><td style="overflow-wrap:anywhere">${esc(state?.email||'—')}</td><td>${(state?.checked_out_at||state?.assigned_at)?esc(new Date((state.checked_out_at||state.assigned_at)*1000).toLocaleString()):'—'}</td><td>${esc(state?.checkout_ip||'—')}</td><td>${state?.relinquished_at?esc(new Date(state.relinquished_at*1000).toLocaleString()):'—'}</td><td>${esc(state?.relinquished_ip||'—')}</td></tr>`;
    }).join('')||'<tr><td colspan="8" class="text-muted">No matching saved accounts.</td></tr>';
    el('af-accounts').querySelectorAll('.af-account').forEach(box=>box.addEventListener('change',()=>{box.checked?selected.add(box.dataset.user):selected.delete(box.dataset.user);}));
    el('af-select-all').checked=false;
    el('af-snapshot').textContent=snapshot.checked_at?`Last status: ${new Date(snapshot.checked_at*1000).toLocaleString()}. Request status to update this snapshot.`:'No status requested yet. Request status after connecting.';
  }
  async function load(){
    const current=window.shell?.getCurrentProjectId()||'';pid=current;const run=++version;
    selected.clear();accounts=[];snapshot={};el('af-password').value='';el('af-url').value='';el('af-username').value='';links('');render();message('');
    if(!pid){el('af-project').textContent='Select a project.';return;}
    try{
      const [connection,data]=await Promise.all([api(current,'connection'),api(current,'accounts')]);
      if(run!==version||current!==pid)return;
      const response=await fetch('/api/projects',{credentials:'same-origin'});const projects=await response.json();
      if(run!==version||current!==pid)return;
      el('af-project').textContent=projects.projects?.find(p=>String(p.id)===pid)?.name||pid;
      accounts=data.accounts;snapshot=data.checkout||{};el('af-url').value=connection.url;el('af-username').value=connection.username;el('af-verify').checked=connection.verify_ssl;
      el('af-password').placeholder=connection.connected?'Saved; leave blank to keep it':'Enter administrator password';
      el('af-connection').open=!connection.connected;el('af-disconnect').classList.toggle('d-none',!connection.connected);links(connection.url);render();
      if(data.legacy_assignments)message('Legacy SCE-web assignments are available and will be preserved when those accounts are first published.');
    }catch(error){if(run===version)message(error.message,true);}
  }
  async function run(fn){
    if(busy||!pid)return;busy=true;const current=pid;document.querySelectorAll('#af-connection-form button,#af-publish,#af-refresh,#af-disable-logins,#af-reset-passwords,#af-reenable-logins').forEach(b=>b.disabled=true);
    try{await fn(current);}catch(error){if(pid===current)message(error.message,true);}finally{busy=false;document.querySelectorAll('#af-connection-form button,#af-publish,#af-refresh,#af-disable-logins,#af-reset-passwords,#af-reenable-logins').forEach(b=>b.disabled=false);}
  }
  el('af-connection-form').addEventListener('submit',event=>{event.preventDefault();run(async current=>{
    message('Checking administrator connection…');
    const result=await api(current,'connection','POST',{url:el('af-url').value,username:el('af-username').value,password:el('af-password').value,verify_ssl:el('af-verify').checked});
    if(current!==pid)return;el('af-password').value='';el('af-password').placeholder='Saved; leave blank to keep it';el('af-disconnect').classList.remove('d-none');el('af-connection').open=false;links(el('af-url').value);message(`Connected as ${result.administrator}. Publish accounts or request status.`);
  });});
  el('af-disconnect').addEventListener('click',()=>run(async current=>{if(!confirm('Remove this saved connection? Published accounts and assignments remain in AccessForge.'))return;await api(current,'connection','DELETE');if(pid!==current)return;await load();message('Disconnected. Published accounts remain in AccessForge.');}));
  el('af-refresh').addEventListener('click',()=>run(async current=>{message('Requesting status from AccessForge…');const data=await api(current,'status');if(pid!==current)return;snapshot=data.checkout||{};render();message('Status updated.');}));
  el('af-publish').addEventListener('click',()=>run(async current=>{
    if(!selected.size)throw new Error('Select at least one saved account to publish.');
    message('Publishing selected accounts…');const data=await api(current,'publish','POST',{usernames:[...selected]});if(pid!==current)return;snapshot=data.checkout||{};selected.clear();render();message('Accounts published. Configure availability and checkout policy in AccessForge.');
  }));
  for(const [id,operation,confirmation] of [
    ['af-disable-logins','disable-logins','Disable the selected unassigned Proxmox logins?'],
    ['af-reset-passwords','reset-passwords','Set the selected passwords to the saved Configuration credentials? These logins will stay disabled.'],
    ['af-reenable-logins','reenable-logins','Re-enable the selected prepared logins and make them available according to AccessForge checkout policy?']
  ])el(id).addEventListener('click',()=>run(async current=>{
    if(!selected.size)throw new Error('Select at least one saved account.');
    if(!confirm(confirmation))return;
    message('Updating selected logins…');
    const data=await api(current,operation,'POST',{usernames:[...selected]});if(pid!==current)return;
    snapshot=data.checkout||{};selected.clear();render();
    const failures=(data.results||[]).filter(row=>!row.success);
    message(failures.length?failures.map(row=>`${row.username}: ${row.error}`).join(' '):'Selected logins updated.',!!failures.length);
  }));
  el('af-filter').addEventListener('input',render);
  el('af-select-all').addEventListener('change',event=>{el('af-accounts').querySelectorAll('.af-account').forEach(box=>{box.checked=event.target.checked;box.checked?selected.add(box.dataset.user):selected.delete(box.dataset.user);});});
  document.addEventListener('DOMContentLoaded',async()=>{
    document.addEventListener('project-selected',load);
    await shell.initShell('accessforge');await load();
    try{const data=await AUTH.me();el('banner-username').textContent=data?.user?.username||'anonymous';}catch{}
    el('banner-logout').addEventListener('click',async()=>{await AUTH.logout();location.href='/';});
  });
})();
