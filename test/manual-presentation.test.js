import test from 'node:test';
import assert from 'node:assert/strict';
import { NotesEngine } from '../server/domain.js';
import { MemoryStore } from '../server/store.js';
import { validateConfig } from '../server/config.js';
import { createHTTP } from '../server/http.js';
import { signExtensionJWT } from '../server/extension/auth.js';

const decisions = { evaluate: async (_body,_config,_moment,category) => ({moderation:{verdict:'safe',source:'decisions',confidence:1},classification:{category_id:category},fit:'fits'}), choose: async rows => rows.map(row=>row.id) };
async function fixture() {
 let now=100000; const store=new MemoryStore(); const engine=new NotesEngine({store,decisions,now:()=>now});
 await engine.updateConfig({reveal:{mode:'manual',max_per_moment:10}});
 const send=async(id,moment_id='margit')=>engine.submit({opaqueId:`U-${id}`,userId:String(id),displayName:`sender_${id}`},{body:`private-manual-${id}`,category_id:'encouragement',moment_id,payment_mode:'free',show_name:true});
 return {engine,store,send,advance:ms=>{now+=ms},now:()=>now};
}

test('manual declare prepares sealed envelopes; only explicit open discloses one, close does not advance',async()=>{
 const f=await fixture(), a=await f.send(1), b=await f.send(2), future=await f.send(3,'key');
 await assert.rejects(f.engine.reveal(future.id),{code:'moment_not_ready'});
 const declared=await f.engine.occur('margit'); assert.equal(declared.selected.length,2);
 for(let n=0;n<5;n++){f.advance(10000);await f.engine.tick();}
 let view=f.engine.viewerState({opaqueId:'U-observer'}).presentation;
 assert.equal(view.presentation_mode,'manual'); assert.equal(view.current,null);
 assert.equal(view.ready_count,2);assert.equal(view.ready_envelopes.length,2);
 assert.equal(view.sealed_envelopes.length,1);assert.equal(view.sealed_envelopes[0].id,future.id);
 assert.equal(JSON.stringify(view).includes('private-manual-'),false);
 await f.engine.reveal(b.id);
 view=f.engine.overlayState();assert.equal(view.current.id,b.id);assert.equal(view.current.body,'private-manual-2');assert.equal(view.current_until,null);
 const openedAt=view.current.revealed_at;
 await f.engine.reveal(b.id);assert.equal(f.engine.overlayState().current.revealed_at,openedAt);
 await assert.rejects(f.engine.reveal(a.id),{code:'reveal_in_progress'});
 f.advance(120000);await f.engine.tick();assert.equal(f.engine.overlayState().current.id,b.id);
 await f.engine.skip(); view=f.engine.overlayState();assert.equal(view.current,null);assert.equal(view.ready_count,1);
 assert.equal(view.ready_envelopes[0].id,a.id);await f.engine.tick();assert.equal(f.engine.overlayState().current,null);
 await f.engine.skip();assert.equal(f.engine.overlayState().ready_count,1);
 await f.engine.reveal(a.id);assert.equal(f.engine.overlayState().current.id,a.id);
 const restored=new NotesEngine({store:f.store,decisions,now:f.now});
 assert.equal(restored.config.reveal.mode,'manual');assert.equal(restored.overlayState().current.id,a.id);
 await restored.tick();assert.equal(restored.overlayState().current.id,a.id);
});

test('manual mode validation keeps old stored configurations compatible',()=>{
 assert.equal(validateConfig().reveal.mode,'auto');
 const old=validateConfig();delete old.reveal.mode;
 assert.equal(validateConfig({},old).reveal.mode,'auto');
 assert.throws(()=>validateConfig({reveal:{mode:'javascript'}}));
});

test('authenticated viewers share ready/open/close state but cannot operate it; PubSub contains no body',async t=>{
 const f=await fixture(), letter=await f.send(7);const snapshots=[];
 const secret=Buffer.alloc(32,9),env={TWITCH_EXT_SECRET:secret.toString('base64'),TWITCH_EXT_CLIENT_ID:'manualtest',TWITCH_BROADCASTER_ID:'456'};
 const server=await createHTTP({root:process.cwd(),engine:f.engine,env,now:f.now,publisher:{snapshot:v=>snapshots.push(v),whisper:()=>{}}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(()=>{server.closeAllConnections();return new Promise(resolve=>server.close(resolve));});
 const base=`http://127.0.0.1:${server.address().port}`;
 const headers={Origin:'https://manualtest.ext-twitch.tv',Authorization:'Bearer '+signExtensionJWT({exp:10000,channel_id:'456',role:'viewer',opaque_user_id:'U-observer'},secret)};
 const view=async()=>{const r=await fetch(base+'/ebs/state',{headers});assert.equal(r.status,200);return (await r.json()).presentation;};
 assert.equal((await fetch(base+'/ebs/state',{headers:{Origin:headers.Origin}})).status,401);
 await f.engine.occur('margit');server.publish();let state=await view();assert.equal(state.current,null);assert.equal(state.ready_envelopes[0].id,letter.id);
 const readyVersion=snapshots.at(-1).presentation_version;
 assert.equal(JSON.stringify(state).includes('private-manual-7'),false);
 await f.engine.reveal(letter.id);server.publish();state=await view();assert.equal(state.current.body,'private-manual-7');assert.equal(state.current.revealed_at,f.now());
 assert.notEqual(snapshots.at(-1).presentation_version,readyVersion);
 assert.equal(JSON.stringify(snapshots).includes('private-manual-7'),false);
 const bootstrap=await fetch(base+'/api/operator/bootstrap');const cookie=bootstrap.headers.get('set-cookie').split(';')[0];
 const modeSet=await fetch(base+'/api/operator/action',{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json','X-Sealed-Action':'1',Origin:base},body:JSON.stringify({action:'presentation_set',mode:'manual'})});assert.equal(modeSet.status,200);
 const denied=await fetch(base+'/api/operator/action',{method:'POST',headers:{...headers,'Content-Type':'application/json','X-Sealed-Action':'1'},body:JSON.stringify({action:'skip'})});assert.notEqual(denied.status,200);
 assert.equal(f.engine.overlayState().current.id,letter.id);
 await f.engine.skip();server.publish();assert.equal((await view()).current,null);
});


test('manual events prepare every eligible envelope without autoplay selection',async()=>{
 const f=await fixture();await f.engine.updateConfig({reveal:{max_per_moment:1}});
 for(let i=1;i<=14;i++)await f.send(i);
 const result=await f.engine.occur('margit');assert.equal(result.selected.length,14);
 const view=f.engine.overlayState();assert.equal(view.current,null);assert.equal(view.ready_count,14);assert.equal(view.ready_envelopes.length,12);
 assert.equal(JSON.stringify(view).includes('private-manual-'),false);
});
