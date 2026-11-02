import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { NotesEngine } from '../server/domain.js';
import { JsonStore } from '../server/store.js';
import { DemoJudgements } from '../server/judgements.js';
import { EventSystem } from '../server/events.js';

test('private JSON restart retains candidate, cooldown and idempotent acceptance without a second occurrence',async t=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'sealed-event-ledger-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const file=path.join(dir,'notes.json');let clock=100000;
  const start=()=>{const engine=new NotesEngine({store:new JsonStore({file}),now:()=>clock,decisions:new DemoJudgements()});return{engine,events:new EventSystem({engine,now:()=>clock})};};
  let app=start();const definition={id:'local-event',label:'Local event',description:'A visible local event.',mode:'instant'};
  await app.engine.upsertEventDefinition(definition);
  const body={event_id:definition.id,idempotency_key:'durable-request'};
  const accepted=await app.events.trigger(body);
  assert.equal((await stat(file)).mode&0o777,0o600);
  app=start();const duplicate=await app.events.trigger(body);
  assert.equal(duplicate.duplicate,true);assert.equal(duplicate.candidate_id,accepted.candidate_id);
  assert.equal(app.events.prompts().length,1);assert.equal(app.engine.state.occurrences.length,0);
  await app.events.confirm(accepted.candidate_id);
  await app.engine.upsertEventDefinition({...definition,cooldown_s:1});clock+=2000;
  await assert.rejects(app.events.trigger({...body,idempotency_key:'another-request'}),{code:'event_cooldown'});
  clock+=30000;
  assert.equal((await app.events.trigger({...body,idempotency_key:'after-original-cooldown'})).status,'candidate');
});

test('an uncertain automatic reservation is never automatically replayed after restart',async()=>{
  let clock=100000;
  const engine=new NotesEngine({now:()=>clock,decisions:new DemoJudgements()});
  await engine.upsertEventDefinition({id:'auto-event',label:'Auto',description:'An external event.',mode:'instant',auto_confirm:true});
  const realOccur=engine.occur.bind(engine);let calls=0;
  engine.occur=async()=>{calls++;throw Error('synthetic interruption');};
  const events=new EventSystem({engine,now:()=>clock});
  await assert.rejects(events.trigger({event_id:'auto-event',idempotency_key:'uncertain'}),{code:'event_trigger_failed'});
  engine.occur=realOccur;
  // Simulate a crash after durable reservation but before completion state was saved.
  await engine._mutate(()=>{engine.state.event_runtime.receipts[0].result.status='pending_auto';delete engine.state.event_runtime.receipts[0].result.error;});
  const restarted=new EventSystem({engine,now:()=>clock});
  const replay=await restarted.trigger({event_id:'auto-event',idempotency_key:'uncertain'});
  assert.equal(replay.status,'pending_auto');assert.equal(replay.duplicate,true);
  assert.equal(calls,1);assert.equal(engine.state.occurrences.length,0);
});
