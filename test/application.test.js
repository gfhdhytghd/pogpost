import {test} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {createApplication} from '../server/index.js';

async function fixture(options={}){
  const app=await createApplication({demo:true,...options});
  app.server.listen(0,'127.0.0.1');await once(app.server,'listening');
  const base=`http://127.0.0.1:${app.server.address().port}`;
  const auth=await (await fetch(base+'/demo/auth?viewer=one')).json();
  const headers={Origin:base,Authorization:'Bearer '+auth.token,'Content-Type':'application/json'};
  const post=(route,body,extra={})=>fetch(base+route,{method:'POST',headers:{...headers,...extra},body:JSON.stringify(body)});
  const bootstrap=await fetch(base+'/api/operator/bootstrap');
  const cookie=bootstrap.headers.get('set-cookie').split(';')[0];
  const operator=body=>post('/api/operator/action',body,{Cookie:cookie,'X-Sealed-Action':'1'});
  return {...app,base,headers,post,cookie,operator};
}

test('anonymous extension identity completes real quote, seal, declaration and public archive flow',async()=>{
  const f=await fixture();try{
    const canary='Keep this private until the boss falls.';
    const body={body:canary,category_id:'advice',moment_id:'margit',payment_mode:'sim_points',show_name:false,request_id:'application-note'};
    let response=await f.post('/ebs/quote',body);assert.equal(response.status,200);assert.equal((await response.json()).amount,200);
    response=await f.post('/ebs/notes',body);assert.equal(response.status,200);
    const receipt=await response.json();assert.equal(receipt.status,'sealed');assert.ok(!JSON.stringify(receipt).includes(canary));
    for(const [route,headers] of [['/ebs/state',f.headers],['/api/operator/state',{Cookie:f.cookie}],['/api/overlay',{}],['/api/archive',{}]]){
      const r=await fetch(f.base+route,{headers});assert.equal(r.status,200,route);assert.ok(!(await r.text()).includes(canary),route);
    }
    response=await f.operator({action:'moment',moment_id:'margit',context:'The boss fell.'});assert.equal(response.status,200);
    const overlay=await (await fetch(f.base+'/api/overlay')).json();assert.equal(overlay.current.body,canary);assert.equal(overlay.current.display_name,null);
    const archive=await (await fetch(f.base+'/api/archive',{headers:{'X-Forwarded-For':'192.0.2.1',Host:'notes.example.test'}})).json();assert.equal(archive.notes[0].body,canary);
    assert.ok(!JSON.stringify(archive).includes('author_opaque_id'));assert.ok(!JSON.stringify(archive).includes('author_user_id'));
    const events=await (await fetch(f.base+'/ebs/events',{headers:f.headers})).json();assert.deepEqual(events.events.map(e=>e.type),['sealed','opened']);
  }finally{await f.close();}
});

test('held body is restricted to the authenticated reviewer until human approval and reveal',async()=>{
  const f=await fixture();try{
    const body='[demo:hold] A surprise for a later moment.';
    const response=await f.post('/ebs/notes',{body,category_id:'joke',moment_id:'key',payment_mode:'free',show_name:false,request_id:'held-application'});
    assert.equal(response.status,200);const note=await response.json();assert.equal(note.status,'held');
    const state=await (await fetch(f.base+'/api/operator/state',{headers:{Cookie:f.cookie}})).json();
    assert.equal(state.held[0].body,body);assert.ok(!JSON.stringify(state.notes).includes(body));
    const viewer=await (await fetch(f.base+'/ebs/state',{headers:f.headers})).json();assert.ok(!JSON.stringify(viewer).includes(body));
    assert.equal((await f.operator({action:'review',id:note.id,approve:true})).status,200);
    const sealed=await (await fetch(f.base+'/api/operator/state',{headers:{Cookie:f.cookie}})).json();assert.ok(!JSON.stringify(sealed).includes(body));
    assert.equal((await f.operator({action:'moment',moment_id:'key'})).status,200);
    assert.equal((await (await fetch(f.base+'/api/archive')).json()).notes[0].body,body);
  }finally{await f.close();}
});

test('demo ignores live provider flags and refuses live payments at application boundary',async()=>{
  await assert.rejects(createApplication({demo:true,env:{PAYMENTS_LIVE:'true'}}),/Live payments/);
  const f=await fixture({env:{DECISIONS_LIVE:'true',TWITCH_CONNECT:'true',OBS_FRAME_WATCHER:'true'}});try{
    assert.equal(f.decisions.state().simulated,true);
    assert.equal((await f.operator({action:'demo'})).status,200);
    const state=f.engine.operatorState();assert.equal(state.notes.length,8);assert.equal(state.held.length,1);
    assert.equal(state.notes.filter(n=>n.status==='sealed').length,7);
  }finally{await f.close();}
});

test('optional condition matching validates output and never submits or charges a note',async()=>{
  let output={ok:true,moment_id:'margit',condition:{type:'count',count:3}};
  const compiler={enabled:true,async compile(){return output;},state:()=>({enabled:true,status:'ready'})};
  const f=await fixture({compiler});try{
    const before=f.engine.viewerState({opaqueId:'Uone',role:'viewer'});
    const state=await (await fetch(f.base+'/ebs/state',{headers:f.headers})).json();assert.equal(state.features.conditionCompiler,true);
    let response=await f.post('/ebs/compile',{text:'The third Margit moment'});assert.equal(response.status,200);
    let result=await response.json();assert.deepEqual(result.condition,{type:'count',count:3});assert.equal(result.requires_viewer_confirmation,true);
    assert.deepEqual(f.engine.viewerState({opaqueId:'Uone',role:'viewer'}).wallet,before.wallet);assert.equal(f.engine.operatorState().notes.length,0);
    output={ok:true,moment_id:'margit',condition:{type:'count',count:3,execute:'unsafe'}};
    response=await f.post('/ebs/compile',{text:'Unexpected compiler output'});assert.equal(response.status,400);assert.ok(!(await response.text()).includes('unsafe'));
    output={ok:true,moment_id:'not-listed',condition:{type:'moment'}};
    response=await f.post('/ebs/compile',{text:'An invented moment'});assert.equal(response.status,400);
    assert.equal(f.engine.operatorState().notes.length,0);
  }finally{await f.close();}
});

test('disabled condition matching falls back to the listed moments without spawning a provider',async()=>{
  const f=await fixture();try{
    const response=await f.post('/ebs/compile',{text:'Some later moment'});assert.equal(response.status,200);
    assert.deepEqual(await response.json(),{ok:false,fallback:'Choose a listed moment and condition.'});
    const state=await (await fetch(f.base+'/api/operator/state',{headers:{Cookie:f.cookie}})).json();
    assert.equal(state.integrations.compiler.status,'disabled');assert.equal(state.integrations.twitch.status,'simulated');
  }finally{await f.close();}
});
