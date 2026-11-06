const assert=require('node:assert/strict');
const fs=require('node:fs');
const test=require('node:test');
const vm=require('node:vm');
const source=fs.readFileSync('app/static/js/checkout_state.js','utf8');
const manager=fs.readFileSync('app/static/js/vm_manager.js','utf8');
const settle=()=>new Promise(resolve=>setImmediate(resolve));
function harness({bus=[],checkout={accounts:{}},storageBlocked=false,channel=true}={}){
  const calls=[],updates=[],stored=new Map(),events={},documentEvents={};let handler;
  const context={document:{hidden:false,documentElement:{dataset:{accessforgePlugin:'on'}},addEventListener:(name,fn)=>documentEvents[name]=fn},
    localStorage:{setItem:(key,value)=>{if(storageBlocked)throw Error('blocked');stored.set(key,value);}},
    window:{addEventListener:(name,fn)=>events[name]=fn},
    BroadcastChannel:channel?class {constructor(){bus.push(this);}postMessage(data){for(const peer of bus)if(peer!==this)peer.onmessage?.({data});}}:undefined,
  };
  context.window.fetch=async(url,options)=>{calls.push({url,options});return handler?handler(url):{ok:true,json:async()=>({checkout})};};
  vm.runInNewContext(source,context);
  const api=context.window.CheckoutState;
  api.subscribe((pid,state)=>updates.push({pid,state}),()=>['lab']);
  return {api,calls,updates,stored,events,documentEvents,context,setHandler:fn=>handler=fn};
}
test('snapshots sync across browser tabs through local SCE reads without broadcasting credentials or student details',async()=>{
  const bus=[],remote={accounts:{alice:{email:'student@example.edu',eligible:true}}};
  const a=harness({bus}),b=harness({bus,checkout:remote});
  a.api.publish('lab',remote);await settle();
  assert.equal(a.updates.length,1);assert.equal(b.updates.length,1);
  assert.equal(b.updates[0].state.accounts.alice.email,'student@example.edu');
  assert.equal(a.calls.length,0);assert.equal(b.calls[0].url,'/api/projects/lab/accessforge/accounts');
  assert.equal(b.calls[0].options.cache,'no-store');
  const notice=JSON.parse(a.stored.values().next().value);assert.deepEqual(Object.keys(notice).sort(),['id','pid']);
  assert.ok(!JSON.stringify(notice).includes('student@example.edu'));
  a.api.publish('other-project',remote);await settle();assert.equal(b.calls.length,1);
});
test('storage events are a fallback, duplicate signals are ignored, and blocked storage still permits broadcasts',async()=>{
  const b=harness({channel:false});const event={key:'toolhub.checkout.changed',newValue:JSON.stringify({pid:'lab',id:'1'})};
  b.events.storage(event);b.events.storage(event);await settle();assert.equal(b.calls.length,1);
  const bus=[],a=harness({bus,storageBlocked:true}),c=harness({bus});
  a.api.publish('lab',{accounts:{}});await settle();assert.equal(c.calls.length,1);
});
test('a cached read cannot overwrite a newer locally published snapshot and pages catch up when visible',async()=>{
  const h=harness();let finish;
  h.setHandler(()=>new Promise(resolve=>finish=resolve));
  const reading=h.api.refresh('lab');h.api.publish('lab',{accounts:{alice:{eligible:true}}});
  finish({ok:true,json:async()=>({checkout:{accounts:{}}})});await reading;
  assert.equal(h.updates.length,1);assert.equal(h.updates[0].state.accounts.alice.eligible,true);
  h.setHandler(()=>({ok:true,json:async()=>({checkout:{accounts:{alice:{login_disabled:true}}}})}));
  h.context.document.hidden=true;h.documentEvents.visibilitychange();await settle();assert.equal(h.calls.length,1);
  h.context.document.hidden=false;h.documentEvents.visibilitychange();await settle();assert.equal(h.calls.length,2);
  assert.equal(h.updates[1].state.accounts.alice.login_disabled,true);
});
test('a newer remote signal during a cached read is fetched again while failures retain existing state',async()=>{
  const h=harness();let finish;
  h.setHandler(()=>new Promise(resolve=>finish=resolve));
  const reading=h.api.refresh('lab');h.events.storage({key:'toolhub.checkout.changed',newValue:JSON.stringify({pid:'lab',id:'newer'})});
  h.setHandler(()=>({ok:true,json:async()=>({checkout:{accounts:{alice:{eligible:true}}}})}));
  finish({ok:true,json:async()=>({checkout:{accounts:{}}})});await reading;await settle();
  assert.equal(h.calls.length,2);assert.equal(h.updates.length,1);assert.equal(h.updates[0].state.accounts.alice.eligible,true);
  h.setHandler(()=>{throw Error('offline');});await h.api.refresh('lab');assert.equal(h.updates.length,1);
});
test('icons distinguish eligibility while showing escaped student identity and disabled status on hover',()=>{
  const {api}=harness();
  const states={accounts:{alice:{eligible:true,name:'A <script>',email:'a@example.edu'},bob:{eligible:false,login_disabled:true}}};
  assert.match(api.icon(states,'alice'),/data-checkout-marked="true"/);
  assert.match(api.icon(states,'alice'),/A &lt;script&gt;/);assert.doesNotMatch(api.icon(states,'alice'),/<script>/);
  assert.match(api.icon(states,'bob'),/Not marked for checkout · Login disabled/);
  assert.match(api.icon(states,'missing'),/data-checkout-marked="false"/);
});
test('VM Mark Permanent/On-Demand deduplicates accounts across selected VMs, ignores inactive projects, and reports partial failures',async()=>{
  const calls=[],host={},projects={one:{id:'one',name:'First',credentials:[{username:'alice'}]},two:{id:'two',name:'Second',credentials:[{username:'bob'}]}};
  const context={window:{ConfigIntegrations:{setMarked:async(pid,names,marked)=>{calls.push({pid,names:[...names],marked});if(pid==='two')throw Error('Connection required');}}},
    document:{documentElement:{dataset:{accessforgePlugin:'on'}},getElementById:()=>host},
    getActivePids:()=>['one','two'],canonicalPid:String,getActionableSelections:()=>[
      {pid:'one',pidCanonical:'one',index:1},{pid:'one',pidCanonical:'one',index:1},{pid:'two',pidCanonical:'two',index:1},{pid:'hidden',pidCanonical:'hidden',index:1}],
    getProjectSnapshot:pid=>projects[pid],updateRefreshState(){}};
  vm.createContext(context);vm.runInContext(manager.slice(manager.indexOf('let VM_CHECKOUT_BUSY'),manager.indexOf('function vmBuildFilterParts')),context);
  await context.vmMarkCheckout(true);
  assert.deepEqual(calls,[{pid:'one',names:['alice'],marked:true},{pid:'two',names:['bob'],marked:true}]);
  assert.match(host.textContent,/Marked 1 account.*On-Demand.*Second: Connection required/);
  calls.length=0;await context.vmMarkCheckout(false);assert.equal(calls[0].marked,false);
  context.document.documentElement.dataset.accessforgePlugin='off';calls.length=0;await context.vmMarkCheckout(true);assert.equal(calls.length,0);
});

test('manager icons appear only for marked accounts, including disabled and checked-out accounts',()=>{
  const h=harness();const snapshot={accounts:{on:{eligible:true},off:{eligible:false,email:'old@example.edu'},disabled:{eligible:true,login_disabled:true},assigned:{eligible:true,email:'student@example.edu'}}};
  assert.match(h.api.markedIcon(snapshot,'on'),/data-checkout-marked="true"/);
  assert.match(h.api.markedIcon(snapshot,'disabled'),/Login disabled/);
  assert.match(h.api.markedIcon(snapshot,'assigned'),/student@example.edu/);
  assert.equal(h.api.markedIcon(snapshot,'off'),'');assert.equal(h.api.markedIcon(snapshot,'unknown'),'');
  h.context.document.documentElement.dataset.accessforgePlugin='off';assert.equal(h.api.markedIcon(snapshot,'on'),'');
});
