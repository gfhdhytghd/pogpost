import test from 'node:test';
import assert from 'node:assert/strict';
import {groupMomentChoices} from '../public/moment-choices.js';
import {NotesEngine} from '../server/domain.js';
import {MemoryStore} from '../server/store.js';
import {DemoJudgements} from '../server/judgements.js';
import ksp from '../presets/ksp.json' with {type:'json'};
import generic from '../presets/generic.json' with {type:'json'};

const ids=rows=>rows.map(row=>row.id);
test('moment choices separate active game events from stream lifecycle and Twitch events',()=>{
 const moments=[{id:'old-game',kind:'ai'},{id:'end',kind:'builtin'},{id:'start',kind:'builtin'},{id:'first-death',kind:'builtin'},{id:'never',kind:'builtin'},{id:'raid',kind:'twitch'},{id:'manual',kind:'declared'},{id:'new-game',kind:'ai'}];
 let groups=groupMomentChoices(moments,[{id:'new-game'},{id:'first-death'}]);
 assert.deepEqual(ids(groups.current_profile),['new-game','first-death']);
 assert.deepEqual(ids(groups.stream_general),['end','start','raid']);
 groups=groupMomentChoices(moments,[]);
 assert.deepEqual(groups.current_profile,[]);
 assert.deepEqual(ids(groups.stream_general),['end','start','raid']);
});

test('viewer and operator choices follow KSP/generic/empty profiles without altering historical notes or definitions',async()=>{
 const store=new MemoryStore(),engine=new NotesEngine({store,decisions:new DemoJudgements()});
 const identity={opaqueId:'Uhistoricalmoments'};
 await engine.submit(identity,{body:'A private note from the earlier game',moment_id:'margit',category_id:'advice',payment_mode:'sim_points',request_id:'historical-note'});
 await engine.occur('key','Historical event','streamer');
 const history={notes:structuredClone(engine.state.notes),occurrences:structuredClone(engine.state.occurrences)};
 for(const preset of [ksp,generic,{events:[]}]){
  await engine.importEventDefinitions(preset.events);
  const persistedBefore=store.read();
  const viewer=engine.viewerState(identity),operator=engine.operatorState();
  assert.deepEqual(ids(viewer.moment_groups.current_profile),ids(preset.events));
  assert.deepEqual(ids(operator.moment_groups.current_profile),ids(preset.events));
  assert.deepEqual(ids(viewer.moments),ids(operator.moments));
  assert.deepEqual(ids(viewer.config.moments),ids(viewer.moments));
  const expectedGeneral=engine.config.moments.filter(moment=>moment.id==='end'||moment.kind==='twitch');
  assert.deepEqual(ids(viewer.moment_groups.stream_general),ids(expectedGeneral));
  for(const id of ['margit','key','finish','never'])assert.equal(viewer.moments.some(moment=>moment.id===id),false,id);
  assert.equal(viewer.notes[0].moment_label,'Beat Margit');
  assert.equal(Object.hasOwn(viewer.notes[0],'body'),false);
  assert.equal(operator.config.moments.some(moment=>moment.id==='margit'),true,'canonical history stays available for administration');
  assert.deepEqual(store.read(),persistedBefore,'projecting UI choices does not write durable state');
  assert.deepEqual(engine.state.notes,history.notes);
  assert.deepEqual(engine.state.occurrences,history.occurrences);
 }
});

test('condition matching receives only current profile and stream choices and rejects a hidden result',async t=>{
 const {createApplication}=await import('../server/index.js');
 let offered=[],resultId='ksp-launch';
 const app=await createApplication({demo:true,env:{},compiler:{enabled:true,state:()=>({status:'mock'}),close(){},async compile(_text,moments){offered=ids(moments);return {ok:true,moment_id:resultId,condition:{type:'moment'}};}}});
 await app.engine.importEventDefinitions(ksp.events);
 await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
 t.after(()=>app.close());
 const base=`http://127.0.0.1:${app.server.address().port}`;
 const {token}=await(await fetch(base+'/demo/auth?viewer=one')).json();
 const compile=()=>fetch(base+'/ebs/compile',{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({text:'A synthetic condition'})});
 assert.equal((await compile()).status,200);
 assert.ok(offered.includes('ksp-launch')&&offered.includes('end'));
 for(const hidden of ['margit','key','finish','first-death','never'])assert.equal(offered.includes(hidden),false);
 resultId='margit';
 assert.equal((await compile()).status,400,'a compiler cannot restore a hidden moment to the selector');
});
