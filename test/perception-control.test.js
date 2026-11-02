import test from 'node:test';
import assert from 'node:assert/strict';
import { createApplication } from '../server/index.js';
import { MemoryStore } from '../server/store.js';

// Local HTTP, synthetic images and injected provider/source only. No .env or live sockets.
const image = 'data:image/png;base64,R0FNRQ==';
const definition = { id: 'demo-signal', label: 'Demo signal', description: 'A clear visible signal.', mode: 'instant', min_confidence: .85, cooldown_s: 30, auto_confirm: false };
const positive = () => ({ scene: 'gameplay', continuity: 'same', events: { [definition.id]: 'yes' } });
const settle = async () => { for (let i=0;i<8;i++) await new Promise(resolve=>setImmediate(resolve)); };
const deferred = () => { let resolve; const promise=new Promise(done=>{resolve=done;}); return {promise,resolve}; };

async function fixture(t, { env={}, eventFrames=async()=>positive() }={}) {
  const timers=[], sources=[];
  t.mock.method(globalThis,'setInterval',(callback,interval)=>{const timer={callback,interval,active:true,unref(){}};timers.push(timer);return timer;});
  t.mock.method(globalThis,'clearInterval',timer=>{if(timer)timer.active=false;});
  let clock=100000, sequence=0, cancellations=0;
  const app=await createApplication({store:new MemoryStore(),now:()=>clock,
    env:{DECISIONS_LIVE:'true',OBS_FRAME_WATCHER:'false',OBS_SOURCE_NAME:'Synthetic source',...env},
    decisions:{warmup(){},state:()=>({status:'mock'}),close(){},cancelPictureRequests(){cancellations++;},eventFrames,
      eventScreen(){throw Error('Default controller must use direct-window reviews');}},
    obsSourceFactory(options){
      const source={options,reads:0,closed:false,close(){this.closed=true;},state(){return {status:this.closed?'closed':'mock'};},
        async readObservation(){this.reads++;assert.equal(this.closed,false);return {id:String(++sequence),at:clock,dataUrl:image};}};
      sources.push(source);return source;
    }});
  t.after(()=>app.close());
  await app.engine.importEventDefinitions([definition]);
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${app.server.address().port}`;
  const cookie=(await fetch(base+'/api/operator/bootstrap')).headers.get('set-cookie').split(';')[0];
  return {app,sources,timers,cancellations:()=>cancellations,
    state:async()=>await(await fetch(base+'/api/operator/state',{headers:{Cookie:cookie}})).json(),
    action(body,headers={}){return fetch(base+'/api/operator/action',{method:'POST',headers:{Cookie:cookie,Origin:base,'Content-Type':'application/json','X-Sealed-Action':'1',...headers},body:JSON.stringify(body)});},
    set(enabled,headers){return this.action({action:'perception_set',enabled},headers);},
    async frames(count=5){for(let i=0;i<count;i++){clock+=200;for(const timer of timers.filter(timer=>timer.active&&timer.interval===200))timer.callback();await settle();}}
  };
}

test('private perception control requires operator authority, loopback origin and boolean intent before opening sources',async t=>{
  const f=await fixture(t);
  const initial=(await f.state()).integrations.perception;
  assert.equal(initial.enabled,false);
  assert.equal(initial.controllable,true);
  assert.equal(initial.unavailable_reason,null);
  assert.equal(f.sources.length,0,'standby configuration never opens an OBS source');
  assert.equal((await f.set(true,{Cookie:''})).status,401);
  assert.equal((await f.set(true,{Origin:'https://public.example.test'})).status,403);
  assert.equal((await f.set(true,{'X-Forwarded-For':'198.51.100.2'})).status,403);
  for(const enabled of ['true',1,null])assert.equal((await f.set(enabled)).status,400);
  assert.equal((await f.action({action:'perception_set'})).status,400);
  assert.equal(f.sources.length,0);
});

test('start and stop are idempotent, refresh state, and restart with a fresh source without restarting the app',async t=>{
  const f=await fixture(t);
  for(const response of await Promise.all([f.set(true),f.set(true)])){
    assert.equal(response.status,200);assert.equal((await response.json()).result.enabled,true);
  }
  assert.equal(f.sources.length,1);
  assert.equal((await f.state()).integrations.perception.enabled,true);
  await f.frames(4);assert.equal(f.sources[0].reads,4);
  assert.equal((await f.set(false)).status,200);
  assert.equal(f.sources[0].closed,true);
  assert.equal((await f.state()).integrations.perception.enabled,false);
  assert.equal((await f.set(false)).status,200);
  await f.frames(10);assert.equal(f.sources[0].reads,4,'stopped capture timer performs no more reads');
  assert.equal((await f.set(true)).status,200);
  assert.equal(f.sources.length,2);
  await f.frames(1);assert.equal(f.sources[1].reads,1);
});

test('stopping clears pending suggestions while preserving event cooldown and durable history',async t=>{
  const f=await fixture(t);
  assert.equal((await f.set(true)).status,200);
  await f.frames(5);
  assert.equal(f.app.engine.state.event_runtime.candidates.length,1);
  const history=structuredClone({notes:f.app.engine.state.notes,occurrences:f.app.engine.state.occurrences,
    cooldowns:f.app.engine.state.event_runtime.cooldowns,receipts:f.app.engine.state.event_runtime.receipts});
  assert.equal((await f.set(false)).status,200);
  assert.equal(f.app.engine.state.event_runtime.candidates.length,0);
  assert.deepEqual({notes:f.app.engine.state.notes,occurrences:f.app.engine.state.occurrences,
    cooldowns:f.app.engine.state.event_runtime.cooldowns,receipts:f.app.engine.state.event_runtime.receipts},history);
  assert.ok(f.cancellations()>=1);
  assert.equal((await f.set(true)).status,200);
  await f.frames(5);
  assert.equal(f.app.engine.state.event_runtime.candidates.length,0,'restarting recognition does not bypass the shared cooldown');
});

test('a model result arriving after stop cannot recreate a candidate or occurrence',async t=>{
  const pending=deferred(),entered=deferred();
  const f=await fixture(t,{eventFrames:async()=>{entered.resolve();return pending.promise;}});
  t.after(()=>pending.resolve(positive()));
  await f.set(true);
  await f.frames(5);await entered.promise;
  assert.equal((await f.set(false)).status,200,'stop does not wait for a hung provider');
  assert.equal(f.sources[0].closed,true);
  pending.resolve(positive());await settle();
  assert.equal(f.app.engine.state.event_runtime?.candidates?.length??0,0);
  assert.equal(f.app.engine.state.occurrences.length,0);
  assert.equal((await f.state()).integrations.perception.enabled,false);
});

test('missing live configuration and a wrapped session reject start without opening capture',async t=>{
  for(const env of [{DECISIONS_LIVE:'false'},{OBS_SOURCE_NAME:''}])await t.test(JSON.stringify(env),async t=>{
    const f=await fixture(t,{env});
    const state=(await f.state()).integrations.perception;
    assert.equal(state.controllable,false);
    assert.equal(typeof state.unavailable_reason,'string');
    assert.equal((await f.set(true)).status,503);
    assert.equal((await f.set(false)).status,200,'stopping is harmless even when unavailable');
    assert.equal(f.sources.length,0);
  });
  await t.test('wrapped session',async t=>{
    const f=await fixture(t);await f.app.engine.wrap();
    assert.equal((await f.set(true)).status,409);
    assert.equal(f.sources.length,0);
  });
});
