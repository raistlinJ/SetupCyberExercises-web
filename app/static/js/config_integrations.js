(() => {
  const el=id=>document.getElementById(id);
  const enabled=()=>document.documentElement.dataset.accessforgePlugin==='on';
  const selections=new Map(),timers=new Map(),saves=new Map(),revisions=new Map(),busy=new Set();
  const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  function parts(value){
    if(!value)return {url:'',port:443};
    try{const url=new URL(value);const port=Number(url.port||(url.protocol==='http:'?80:443));url.port='';return {url:url.href.replace(/\/$/,''),port};}
    catch{return {url:String(value),port:443};}
  }
  function join(value,port){
    if(!String(value||'').trim())return '';
    if(!/^\d+$/.test(String(port))||Number(port)<1||Number(port)>65535)throw new Error('API port must be between 1 and 65535.');
    const url=new URL(String(value).trim());
    if(!['http:','https:'].includes(url.protocol))throw new Error('Use an HTTP or HTTPS URL.');
    url.port=String(port);return url.href.replace(/\/$/,'');
  }
  async function api(pid,path,method,data){
    const me=await AUTH.me(),owner=me?.user?.username||'__anonymous__';
    const headers={'Content-Type':'application/json'};
    try{
      const temporary=JSON.parse(sessionStorage.getItem(`toolhub.accessforge.session.${encodeURIComponent(owner)}.${encodeURIComponent(pid)}`)||'null');
      if(temporary)headers['X-AccessForge-Connection']=encodeURIComponent(JSON.stringify(temporary));
    }catch{}
    const response=await fetch(`/api/projects/${encodeURIComponent(pid)}/accessforge/${path}`,{method,credentials:'same-origin',cache:'no-store',headers,body:JSON.stringify(data)});
    let result={};try{result=await response.json();}catch{}
    if(!response.ok)throw new Error(result.error||`Request failed (HTTP ${response.status}).`);
    return result;
  }
  function readFields(urlInput,portInput){
    const value=String(urlInput.value||'').trim();
    if(/:\d+$/.test(value.split('/')[2]||'')){
      const parsed=parts(value);urlInput.value=parsed.url;portInput.value=String(parsed.port);
    }
    return join(urlInput.value,portInput.value);
  }
  function feedback(pid,text,error=false){
    const host=el(`cred-checkout-status-${pid}`);if(host){host.textContent=text;host.className=`small mt-1 ${error?'text-danger':'text-success'}`;}
  }
  function urlFeedback(pid,text,error=false){
    const host=el(`cfg-${pid}-accessforge_status`);if(host){host.textContent=text;host.className=`small ${error?'text-danger':'text-success'}`;}
  }
  function update(pid,checkout,{broadcast=true}={}){
    const project=window.PROJ_CACHE?.[pid];if(project)project.checkout=checkout;
    el(`cred-${pid}-list`)?.querySelectorAll('[data-index]').forEach(row=>{
      const username=row.querySelector('input:not([type="checkbox"])')?.value?.trim();
      const badge=row.querySelector('.credential-checkout-state');
      if(badge){window.bootstrap?.Tooltip.getInstance(badge)?.dispose();badge.outerHTML=icon(pid,username);}
    });
    if(typeof initBootstrapTooltips==='function')initBootstrapTooltips(el(`cred-${pid}-list`));
    syncSelection(pid);
    if(broadcast)window.CheckoutState?.publish(pid,checkout);
  }
  function scheduleUrl(pid){
    if(timers.has(pid))clearTimeout(timers.get(pid));
    timers.set(pid,setTimeout(()=>{timers.delete(pid);saveUrl(pid).catch(()=>{});},600));
  }
  function saveUrl(pid){
    if(timers.has(pid)){clearTimeout(timers.get(pid));timers.delete(pid);}
    const urlInput=el(`cfg-${pid}-accessforge_url`),portInput=el(`cfg-${pid}-accessforge_api_port`);
    if(!urlInput||!portInput)return Promise.resolve();
    let url;
    try{url=readFields(urlInput,portInput);}catch(error){urlFeedback(pid,error.message,true);return Promise.reject(error);}
    const revision=(revisions.get(pid)||0)+1;revisions.set(pid,revision);
    const previous=saves.get(pid)||Promise.resolve();
    const task=previous.catch(()=>{}).then(async()=>{
      const data=await api(pid,'connection','PATCH',{url});
      if(revisions.get(pid)===revision){update(pid,data.checkout);urlFeedback(pid,'AccessForge URL saved.');}
    }).catch(error=>{if(revisions.get(pid)===revision)urlFeedback(pid,error.message,true);throw error;});
    saves.set(pid,task);return task;
  }
  function selection(pid){if(!selections.has(pid))selections.set(pid,new Set());return selections.get(pid);}
  function state(pid,username){return window.CheckoutState.label(window.PROJ_CACHE?.[pid]?.checkout,username);}
  function icon(pid,username){return window.CheckoutState.icon(window.PROJ_CACHE?.[pid]?.checkout,username);}
  async function setMarked(pid,usernames,marked){
    const data=await api(pid,'checkout-accounts','POST',{usernames,enabled:marked});
    update(pid,data.checkout);return data.checkout;
  }
  function checkbox(pid,username){
    return `<div class="col-auto d-flex align-items-center" data-plugin="accessforge"><input type="checkbox" class="form-check-input m-0 credential-select" aria-label="Select ${esc(username||'credential')} for checkout" ${selection(pid).has(username)?'checked':''} onchange="ConfigIntegrations.select('${esc(pid)}',this)"></div>`;
  }
  function select(pid,box){
    const username=box.closest('[data-index]')?.querySelector('input:not([type="checkbox"])')?.value?.trim();
    if(username)box.checked?selection(pid).add(username):selection(pid).delete(username);
    syncSelection(pid);
  }
  function syncSelection(pid){
    const boxes=[...(el(`cred-${pid}-list`)?.querySelectorAll('.credential-select')||[])];
    const all=el(`cred-checkout-all-${pid}`);
    if(all){all.checked=!!boxes.length&&boxes.every(box=>box.checked);all.indeterminate=boxes.some(box=>box.checked)&&!all.checked;}
    const names=boxes.filter(box=>box.checked).map(box=>box.closest('[data-index]')?.querySelector('input:not([type="checkbox"])')?.value?.trim()).filter(Boolean);
    if(el(`cred-${pid}-list`))selections.set(pid,new Set(names));
    const control=el(`cred-checkout-mode-${pid}`);
    if(control){
      const modes=new Set(names.map(name=>window.PROJ_CACHE?.[pid]?.checkout?.accounts?.[name]?.eligible?'on-demand':'permanent'));
      if(!busy.has(pid))control.value=names.length&&modes.size===1?[...modes][0]:'';
      control.disabled=!enabled()||busy.has(pid)||!names.length;
      const placeholder=control.querySelector?.('option[value=""]');
      if(placeholder)placeholder.textContent=names.length?'Mixed':'Mark Credential Type';
    }
  }
  function selectAll(pid,checked){
    selection(pid).clear();
    el(`cred-${pid}-list`)?.querySelectorAll('.credential-select').forEach(box=>{box.checked=checked;if(checked){const username=box.closest('[data-index]').querySelector('input:not([type="checkbox"])').value.trim();if(username)selection(pid).add(username);}});
    syncSelection(pid);
  }
  async function mark(pid,checkoutEnabled){
    if(!enabled()||busy.has(pid))return;
    const names=[...(el(`cred-${pid}-list`)?.querySelectorAll('.credential-select:checked')||[])].map(box=>box.closest('[data-index]').querySelector('input:not([type="checkbox"])').value.trim()).filter(Boolean);
    if(!names.length){feedback(pid,'Select at least one credential.',true);return;}
    busy.add(pid);syncSelection(pid);document.querySelectorAll(`[data-checkout-action="${CSS.escape(pid)}"]`).forEach(button=>button.disabled=true);
    try{
      feedback(pid,'Saving credentials and updating checkout availability…');
      if(!await _saveCredentialsNow(pid))throw new Error('Save the credential list successfully before changing checkout availability.');
      await saveUrl(pid);
      await setMarked(pid,names,checkoutEnabled);feedback(pid,`Checkout mode set to ${checkoutEnabled?'On-demand (checkout)':'Permanent'} for ${names.length} selected account(s).`);
    }catch(error){feedback(pid,error.message,true);}finally{busy.delete(pid);document.querySelectorAll(`[data-checkout-action="${CSS.escape(pid)}"]`).forEach(button=>button.disabled=false);syncSelection(pid);}
  }
  async function setMode(pid,mode){
    if(!['on-demand','permanent'].includes(mode)){syncSelection(pid);return;}
    await mark(pid,mode==='on-demand');
  }
  window.CheckoutState?.subscribe((pid,checkout)=>update(pid,checkout,{broadcast:false}),()=>Object.keys(window.PROJ_CACHE||{}));
  window.ConfigIntegrations={enabled,parts,join,readFields,scheduleUrl,saveUrl,state,icon,checkbox,select,selectAll,syncSelection,mark,setMarked,setMode};
})();
