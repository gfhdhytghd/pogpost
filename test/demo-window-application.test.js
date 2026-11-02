import test from 'node:test';
import assert from 'node:assert/strict';
import { createApplication } from '../server/index.js';
import { MemoryStore } from '../server/store.js';
import { DemoJudgements } from '../server/judgements.js';
import ksp from '../presets/ksp.json' with {type:'json'};

// Complete private HTTP confirmation path, with synthetic capture and model only.
test('default demo window capture -> candidate -> operator confirmation -> sealed note reveal', async t => {
  const timers=[];
  t.mock.method(globalThis,'setInterval',(callback,interval)=>{timers.push({callback,interval});return {unref(){}};});
  let now=100000,sequence=0,calls=0;
  const app=await createApplication({store:new MemoryStore(),now:()=>now,
    env:{OBS_FRAME_WATCHER:'true',DECISIONS_LIVE:'true',OBS_SOURCE_NAME:'Synthetic game'},
    decisions:{warmup(){},close(){},state:()=>({status:'mock'}),
      evaluate:(...args)=>new DemoJudgements().evaluate(...args),
      eventScreen(){throw Error('Default must bypass single-frame triage');},
      async eventFrames(frames){calls++;assert.equal(frames.length,5);
        return {scene:'gameplay',continuity:'same',events:Object.fromEntries(ksp.events.map(event=>[event.id,event.id==='ksp-launch'?'yes':'no']))};}},
    obsSourceFactory:()=>({close(){},readObservation:async()=>({id:String(++sequence),at:now,dataUrl:'data:image/png;base64,R0FNRQ=='})})});
  try {
    await app.engine.importEventDefinitions(ksp.events);
    await app.engine.submit({opaqueId:'Udemowindow'},{body:'Demo launch envelope',category_id:'advice',moment_id:'ksp-launch',payment_mode:'sim_points',request_id:'mock-demo-note'});
    await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
    const base=`http://127.0.0.1:${app.server.address().port}`;
    const cookie=(await fetch(base+'/api/operator/bootstrap')).headers.get('set-cookie').split(';')[0];
    const capture=timers.find(timer=>timer.interval===200).callback;
    for(let i=0;i<6;i++){now+=200;capture();await new Promise(resolve=>setImmediate(resolve));}
    const state=await(await fetch(base+'/api/operator/state',{headers:{Cookie:cookie}})).json();
    assert.equal(state.integrations.perception.watcher.strategy,'direct_window');
    assert.equal(calls,1);
    assert.equal(app.engine.state.occurrences.length,0,'model cannot declare the event');
    const candidate=app.engine.state.event_runtime.candidates[0];
    assert.equal(candidate.event_id,'ksp-launch');
    assert.equal(app.engine.archive().length,0);
    const confirmed=await fetch(base+'/api/operator/action',{method:'POST',headers:{Cookie:cookie,Origin:base,'Content-Type':'application/json','X-Sealed-Action':'1'},body:JSON.stringify({action:'confirm_ai',id:candidate.id,approve:true})});
    assert.equal(confirmed.status,200);
    assert.equal(app.engine.state.occurrences.length,1);
    assert.equal(app.engine.archive().length,1);
    assert.equal(app.engine.state.occurrences[0].confirmed_by,'ai-confirmed');
  } finally {await app.close();}
});
