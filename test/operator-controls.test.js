import test from 'node:test';
import assert from 'node:assert/strict';
import {createApplication} from '../server/index.js';
import {MemoryStore} from '../server/store.js';
import {DemoJudgements} from '../server/judgements.js';

async function fixture(t,debugRecorder){
  const app=await createApplication({store:new MemoryStore(),decisions:new DemoJudgements(),debugRecorder});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  t.after(()=>app.close());
  const base=`http://127.0.0.1:${app.server.address().port}`;
  const cookie=(await fetch(base+'/api/operator/bootstrap')).headers.get('set-cookie').split(';')[0];
  return {state:async()=>await(await fetch(base+'/api/operator/state',{headers:{Cookie:cookie}})).json(),
    toggle:(enabled,headers={})=>fetch(base+'/api/operator/action',{method:'POST',headers:{Cookie:cookie,Origin:base,'Content-Type':'application/json','X-Sealed-Action':'1',...headers},body:JSON.stringify({action:'debug_set',enabled})})};
}

test('operator debug quick control state tracks recording independently of picture recognition',async t=>{
  let enabled=false,changes=0;
  const f=await fixture(t,{state:()=>({enabled,private_field:'not projected'}),async setEnabled(value){enabled=value;changes++;return {enabled};},async close(){}});
  assert.deepEqual((await f.state()).integrations.debug,{available:true,enabled:false});
  assert.equal((await f.toggle(true)).status,200);
  let state=await f.state();
  assert.deepEqual(state.integrations.debug,{available:true,enabled:true});
  assert.equal(state.integrations.perception.enabled,false,'debug recording does not start capture');
  assert.equal((await f.toggle(false,{Origin:'https://public.example'})).status,403);
  assert.equal((await f.toggle(false,{Cookie:''})).status,401);
  assert.equal(changes,1);
  assert.equal((await f.toggle(false)).status,200);
  assert.deepEqual((await f.state()).integrations.debug,{available:true,enabled:false});
});

test('missing or broken diagnostic state leaves the operator state usable and debug control unavailable',async t=>{
  for(const recorder of [null,{state(){throw Error('private diagnostic error');},close(){}}]){
    const f=await fixture(t,recorder);
    const state=await f.state();
    assert.deepEqual(state.integrations.debug,{available:false,enabled:false});
    assert.equal(JSON.stringify(state).includes('private diagnostic error'),false);
    assert.equal(state.integrations.perception.enabled,false);
  }
});
