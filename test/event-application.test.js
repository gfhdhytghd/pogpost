import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApplication } from '../server/index.js';
import { MemoryStore } from '../server/store.js';

async function fixture(env={}){
  let providerCalls=0;
  const app=await createApplication({env,store:new MemoryStore(),
    decisions:{state:()=>({status:'mock'}),warmup(){providerCalls++;},eventFrames(){providerCalls++;},close(){}},
    obsSourceFactory(){throw Error('No OBS source may be opened');}});
  app.server.listen(0,'127.0.0.1');await once(app.server,'listening');
  const base=`http://127.0.0.1:${app.server.address().port}`;
  const cookie=(await fetch(base+'/api/operator/bootstrap')).headers.get('set-cookie').split(';')[0];
  return{...app,base,cookie,calls:()=>providerCalls,action(body,headers={}){return fetch(base+'/api/operator/action',{method:'POST',headers:{Cookie:cookie,Origin:base,'X-Sealed-Action':'1','Content-Type':'application/json',...headers},body:JSON.stringify(body)});}};
}
const event={id:'custom-event',label:'Custom event',description:'A clearly visible example event.',mode:'instant'};

test('startup imports KSP as data with picture recognition disabled and no provider access',async t=>{
  const f=await fixture({EVENTS_PRESET_FILE:'presets/ksp.json',EVENTS_API_TOKEN:'synthetic-api-token'});t.after(()=>f.close());
  assert.equal(f.engine.config.events.length,6);assert.equal(f.calls(),0);
  const state=await(await fetch(f.base+'/api/operator/state',{headers:{Cookie:f.cookie}})).json();
  assert.equal(state.integrations.perception.enabled,false);
  const response=await fetch(f.base+'/api/events/trigger',{method:'POST',headers:{Authorization:'Bearer synthetic-api-token','Content-Type':'application/json'},body:JSON.stringify({event_id:'ksp-explosion',idempotency_key:'manual-source-test'})});
  assert.equal(response.status,200);assert.equal((await response.json()).status,'candidate');
  assert.equal(f.engine.state.occurrences.length,0);assert.equal(f.calls(),0);
});

test('operator event definition actions require capability and return canonical structured data',async t=>{
  const f=await fixture();t.after(()=>f.close());
  assert.equal((await f.action({action:'events_upsert',event},{Cookie:''})).status,401);
  assert.equal((await f.action({action:'events_upsert',event},{Origin:'https://public.example.test'})).status,403);
  let response=await f.action({action:'events_upsert',event});assert.equal(response.status,200);
  const saved=(await response.json()).result.event;assert.equal(saved.min_confidence,.85);assert.equal(saved.auto_confirm,false);
  response=await f.action({action:'events_list'});assert.deepEqual((await response.json()).result.events,[saved]);
  response=await f.action({action:'events_upsert',event:{...event,label:'Updated label'}});assert.equal((await response.json()).result.event.label,'Updated label');
  response=await f.action({action:'events_delete',event_id:event.id});assert.equal((await response.json()).result.deleted,true);
  assert.deepEqual(f.engine.config.events,[]);assert.equal(f.calls(),0);
  response=await f.action({action:'events_import',events:[event]});assert.equal((await response.json()).result.events.length,1);
  response=await f.action({action:'events_import',events:Array.from({length:13},(_,i)=>({...event,id:'event-'+i}))});
  assert.equal(response.status,400);const error=await response.json();assert.equal(error.error,'event_limit');assert.match(error.message,/12/);
  assert.equal(f.engine.config.events.length,1);
});
