import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { DEFAULT_CONFIG, validateConfig, validateRopeLayout } from '../server/config.js';
import { NotesEngine } from '../server/domain.js';
import { JsonStore, MemoryStore } from '../server/store.js';
import { createHTTP } from '../server/http.js';
import { signExtensionJWT } from '../server/extension/auth.js';
const layout={left:{x:0.12,y:0.2},right:{x:0.86,y:0.34}};

test('stage endpoint coordinates are normalized, bounded and strictly shaped',()=>{
 assert.deepEqual(validateRopeLayout(layout),layout);
 assert.notEqual(validateRopeLayout(layout),layout);
 for(const value of [null,[],{}, {...layout,extra:1}, {...layout,left:{x:0.1,y:0.2,z:1}}, {...layout,left:{x:'0.1',y:0.2}}, {...layout,left:{x:-0.1,y:0.2}}, {...layout,right:{x:1.1,y:0.2}}, {...layout,left:{x:0,y:NaN}}, {...layout,left:{x:0,y:Infinity}}, {left:{x:0.6,y:0.2},right:{x:0.5,y:0.2}}, {left:{x:0.4,y:0.2},right:{x:0.45,y:0.2}}]) assert.throws(()=>validateRopeLayout(value),{code:'invalid_stage_layout'});
 const old=structuredClone(DEFAULT_CONFIG);delete old.reveal.rope;
 assert.deepEqual(validateConfig({},old).reveal.rope,DEFAULT_CONFIG.reveal.rope);
});

test('layout saves atomically, survives a new engine, and resets without changing the session',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'sealed-layout-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const file=path.join(dir,'notes.json'),store=new JsonStore({file}),engine=new NotesEngine({store});
 const session=engine.state.session.id;await engine.setStageLayout(layout);
 assert.equal((await stat(file)).mode & 0o777,0o600);
 const restored=new NotesEngine({store:new JsonStore({file})});
 assert.deepEqual(restored.config.reveal.rope,layout);assert.equal(restored.state.session.id,session);
 const before=JSON.stringify(restored.state);await assert.rejects(restored.setStageLayout({}),{code:'invalid_stage_layout'});assert.equal(JSON.stringify(restored.state),before);
 await restored.setStageLayout(null);assert.deepEqual(restored.config.reveal.rope,DEFAULT_CONFIG.reveal.rope);assert.equal(restored.state.session.id,session);
});

test('only operator actions save endpoints and viewers receive the same published layout',async t=>{
 const engine=new NotesEngine({store:new MemoryStore()}),secret=Buffer.alloc(32,19),snapshots=[];
 const env={TWITCH_EXT_SECRET:secret.toString('base64'),TWITCH_EXT_CLIENT_ID:'layouttest',TWITCH_BROADCASTER_ID:'456'};
 const server=await createHTTP({root:process.cwd(),engine,env,publisher:{snapshot:value=>snapshots.push(value),whisper(){}}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>{server.closeAllConnections();return new Promise(resolve=>server.close(resolve));});
 const base=`http://127.0.0.1:${server.address().port}`,body=JSON.stringify({action:'stage_layout_set',layout});
 const viewer={Origin:'https://layouttest.ext-twitch.tv',Authorization:'Bearer '+signExtensionJWT({exp:Math.floor(Date.now()/1000)+60,channel_id:'456',role:'viewer',opaque_user_id:'U-layoutviewer'},secret)};
 assert.equal((await fetch(base+'/api/operator/action',{method:'POST',headers:{...viewer,'Content-Type':'application/json','X-Sealed-Action':'1'},body})).status,401);
 const boot=await fetch(base+'/api/operator/bootstrap'),cookie=boot.headers.getSetCookie()[0].split(';')[0];
 const headers={Cookie:cookie,Origin:base,'Content-Type':'application/json','X-Sealed-Action':'1'};
 assert.equal((await fetch(base+'/api/operator/action',{method:'POST',headers:{...headers,'X-Forwarded-For':'198.51.100.1'},body})).status,403);
 server.publish();const initial=snapshots.at(-1).presentation_version;
 assert.equal((await fetch(base+'/api/operator/action',{method:'POST',headers,body})).status,200);
 assert.notEqual(snapshots.at(-1).presentation_version,initial);
 const visible=await (await fetch(base+'/ebs/state',{headers:viewer})).json();assert.deepEqual(visible.presentation.config.reveal.rope,layout);
 assert.deepEqual(engine.overlayState().config.reveal.rope,layout);
 assert.equal((await fetch(base+'/api/operator/action',{method:'POST',headers,body:JSON.stringify({action:'stage_layout_set',layout:{}})})).status,400);
 assert.deepEqual(engine.config.reveal.rope,layout);
 assert.equal((await fetch(base+'/api/operator/action',{method:'POST',headers,body:JSON.stringify({action:'stage_layout_set',layout:null})})).status,200);
 assert.deepEqual(engine.config.reveal.rope,DEFAULT_CONFIG.reveal.rope);
});
