import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHTTP } from '../server/http.js';
import { signExtensionJWT } from '../server/extension/auth.js';

async function fixture({demo=false,watcher=null,credentials=null,authFlow=null,...overrides}={}){
  const root=await mkdtemp(path.join(os.tmpdir(),'sealed-http-'));
  await mkdir(path.join(root,'public'));
  for(const file of ['panel.html','console.html','overlay.html','archive.html','index.html','harness.js','common.css','setup.html'])await writeFile(path.join(root,'public',file),'fixture');
  const secret=Buffer.alloc(32,42), env={TWITCH_EXT_SECRET:secret.toString('base64'),TWITCH_EXT_CLIENT_ID:'newextension',TWITCH_BROADCASTER_ID:'123'};
  const engine={config:{categories:[]},viewerState:i=>({notes:[{id:'sealed',status:'sealed'}],viewer:i.opaqueId}),events:i=>[{id:i.opaqueId}],operatorState:()=>({queue:[{id:'held'}]}),overlayState:()=>({current:null,sealedCount:1}),archive:()=>[],submit:async(i,b)=>({note:{id:'sealed',status:'sealed',named:!!i.userId}}),quote:async()=>({amount:200}),updateConfig:c=>c,occur:()=>({ok:true}),...overrides};
  const server=await createHTTP({root,engine,env,demo,watcher,credentials,authFlow});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const base=`http://127.0.0.1:${server.address().port}`;
  const jwt=(extra={})=>signExtensionJWT({channel_id:'123',exp:Math.floor(Date.now()/1000)+300,role:'viewer',opaque_user_id:'Uone',...extra},secret);
  return {base,server,jwt,origin:'https://newextension.ext-twitch.tv',async close(){server.closeAllConnections();await new Promise(r=>server.close(r));await rm(root,{recursive:true,force:true});}};
}

test('EBS validates JWT, exact CORS origin and broadcaster role',async()=>{
  const f=await fixture();try{
    const headers={Origin:f.origin,Authorization:'Bearer '+f.jwt()};
    let r=await fetch(f.base+'/ebs/state',{headers});assert.equal(r.status,200);assert.equal(r.headers.get('access-control-allow-origin'),f.origin);assert.equal((await r.json()).viewer,'Uone');
    for(const bad of [{},{...headers,Origin:'https://evil.test'},{...headers,Authorization:'Bearer '+f.jwt({exp:1})},{...headers,Authorization:'Bearer '+f.jwt({channel_id:'999'})}]){
      r=await fetch(f.base+'/ebs/state',{headers:bad});assert.ok([401,403].includes(r.status));
    }
    r=await fetch(f.base+'/ebs/config',{headers});assert.equal(r.status,403);
    r=await fetch(f.base+'/ebs/config',{headers:{...headers,Authorization:'Bearer '+f.jwt({role:'broadcaster'})}});assert.equal(r.status,200);
    r=await fetch(f.base+'/ebs/notes',{method:'OPTIONS',headers:{Origin:f.origin}});assert.equal(r.status,204);
  }finally{await f.close();}
});

test('forwarded traffic reaches only public extension and archive routes',async()=>{
  const f=await fixture();try{
    const headers={'X-Forwarded-For':'198.51.100.1',Host:'notes.example.test'};
    for(const route of ['/console','/console.html','/overlay','/overlay.html','/setup','/setup.html','/api/operator/credentials','/api/operator/auth','/api/operator/bootstrap','/api/operator/state','/api/overlay','/demo/auth','/','/index.html','/harness.js'])assert.equal((await fetch(f.base+route,{headers})).status,403,route);
    for(const route of ['/panel.html','/common.css','/archive','/api/archive','/client-config.js'])assert.equal((await fetch(f.base+route,{headers})).status,200,route);
    for(const route of ['/.env','/server/domain.js','/data/notes.json','/../SPEC.md','/%2e%2e/.env'])assert.equal((await fetch(f.base+route,{headers})).status,404,route);
    assert.equal((await fetch(f.base+'/api/archive',{method:'POST',headers})).status,405);
    assert.equal((await fetch(f.base+'/demo/auth')).status,404);
  }finally{await f.close();}
});

test('operator requires capability cookie plus same-origin action header',async()=>{
  const f=await fixture();try{
    assert.equal((await fetch(f.base+'/api/operator/state')).status,401);
    const bootstrap=await fetch(f.base+'/api/operator/bootstrap');assert.equal(bootstrap.status,200);
    const cookie=bootstrap.headers.get('set-cookie').split(';')[0];assert.match(bootstrap.headers.get('set-cookie'),/HttpOnly; SameSite=Strict/);
    assert.equal((await fetch(f.base+'/api/operator/state',{headers:{Cookie:cookie}})).status,200);
    const init={method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json'},body:JSON.stringify({action:'moment',moment_id:'margit'})};
    assert.equal((await fetch(f.base+'/api/operator/action',init)).status,403);
    init.headers['X-Sealed-Action']='1';init.headers.Origin='https://evil.test';assert.equal((await fetch(f.base+'/api/operator/action',init)).status,403);
    init.headers.Origin=f.base;assert.equal((await fetch(f.base+'/api/operator/action',init)).status,200);
  }finally{await f.close();}
});

test('schemas, rate limits and safe errors keep bodies and provider details private',async()=>{
  const f=await fixture({submit:()=>{throw Error('SECRET CANARY BODY');}});try{
    const headers={Origin:f.origin,Authorization:'Bearer '+f.jwt(),'Content-Type':'application/json'};
    let r=await fetch(f.base+'/ebs/notes',{method:'POST',headers,body:JSON.stringify({body:'canary',admin:true})});assert.equal(r.status,400);
    r=await fetch(f.base+'/ebs/notes',{method:'POST',headers,body:JSON.stringify({body:'canary'})});assert.equal(r.status,503);assert.ok(!(await r.text()).includes('CANARY'));
    r=await fetch(f.base+'/ebs/notes',{method:'POST',headers,body:JSON.stringify({body:'x'.repeat(5000)})});assert.equal(r.status,413);
    const responses=await Promise.all(Array.from({length:16},()=>fetch(f.base+'/ebs/state',{headers})));
    assert.ok(responses.some(r=>r.status===429));
  }finally{await f.close();}
});

test('local demo authentication remains inaccessible through a relay',async()=>{
  const f=await fixture({demo:true});try{
    assert.equal((await fetch(f.base+'/demo/auth',{headers:{'X-Forwarded-Proto':'https'}})).status,403);
    const auth=await (await fetch(f.base+'/demo/auth?viewer=one')).json();
    const r=await fetch(f.base+'/ebs/state',{headers:{Authorization:'Bearer '+auth.token}});assert.equal(r.status,200);
  }finally{await f.close();}
});

test('submission admission bounds slow work without blocking read-only state or charging duplicates',async()=>{
  const releases=[];
  const f=await fixture({submit:async()=>{await new Promise(resolve=>releases.push(resolve));return {id:'accepted',status:'sealed'};}});
  try{
    const options=i=>({method:'POST',headers:{Origin:f.origin,Authorization:'Bearer '+f.jwt({opaque_user_id:'U'+i}),'Content-Type':'application/json'},body:JSON.stringify({body:'private note'})});
    const pending=Array.from({length:8},(_,i)=>fetch(f.base+'/ebs/notes',options(i)));
    const until=Date.now()+1000;
    while(releases.length<8&&Date.now()<until)await new Promise(resolve=>setImmediate(resolve));
    assert.equal(releases.length,8);
    assert.equal((await fetch(f.base+'/ebs/notes',options(8))).status,429);
    assert.equal((await fetch(f.base+'/ebs/notes',options(0))).status,429);
    assert.equal((await fetch(f.base+'/ebs/state',{headers:{Origin:f.origin,Authorization:'Bearer '+f.jwt({opaque_user_id:'Ureader'})}})).status,200);
    releases.splice(0).forEach(resolve=>resolve());
    for(const response of await Promise.all(pending))assert.equal(response.status,200);
  }finally{releases.splice(0).forEach(resolve=>resolve());await f.close();}
});

test('AI dismiss consumes a prompt without declaring a moment; confirm requires explicit approval',async()=>{
  let consumed=0,occurred=0;
  const f=await fixture({watcher:{confirm:()=>{consumed++;return {moment_id:'first-death',label:'Death screen'};}},occur:()=>{occurred++;return {ok:true};}});
  try{
    const bootstrap=await fetch(f.base+'/api/operator/bootstrap');
    const Cookie=bootstrap.headers.get('set-cookie').split(';')[0];
    const action=body=>fetch(f.base+'/api/operator/action',{method:'POST',headers:{Cookie,'X-Sealed-Action':'1','Content-Type':'application/json'},body:JSON.stringify({action:'confirm_ai',id:'prompt',...body})});
    assert.equal((await action({})).status,400);assert.equal(consumed,0);
    assert.equal((await action({approve:false})).status,200);assert.equal(consumed,1);assert.equal(occurred,0);
    assert.equal((await action({approve:true})).status,200);assert.equal(consumed,2);assert.equal(occurred,1);
  }finally{await f.close();}
});

test('credential setup requires the operator cookie and rejects cross-origin or unknown fields',async()=>{
  let writes=0;
  const f=await fixture({credentials:{status:async()=>({present:{TWITCH_EXT_SECRET:true}}),save:async()=>{writes++;return {ok:true,restart_required:true,present:{TWITCH_EXT_SECRET:true}};}}});
  try{
    assert.equal((await fetch(f.base+'/api/operator/credentials')).status,401);
    const bootstrap=await fetch(f.base+'/api/operator/bootstrap');const Cookie=bootstrap.headers.get('set-cookie').split(';')[0];
    const result=await (await fetch(f.base+'/api/operator/credentials',{headers:{Cookie}})).json();assert.deepEqual(result,{present:{TWITCH_EXT_SECRET:true}});
    const post=(body,Origin=f.base)=>fetch(f.base+'/api/operator/credentials',{method:'POST',headers:{Cookie,Origin,'X-Sealed-Action':'1','Content-Type':'application/json'},body:JSON.stringify(body)});
    assert.equal((await post({TWITCH_EXT_SECRET:'mock-only'},'https://untrusted.invalid')).status,403);assert.equal(writes,0);
    assert.equal((await post({OPENAI_API_KEY:'unsupported-field'})).status,400);assert.equal(writes,0);
    const response=await post({TWITCH_EXT_SECRET:'mock-only'});assert.equal(response.status,200);assert.equal(writes,1);assert.ok(!(await response.text()).includes('mock-only'));
  }finally{await f.close();}
});

test('device authorization is explicit, private and cannot accept caller-supplied scopes',async()=>{
  let started=0;
  const waiting={stage:'waiting',verification_uri:'https://www.twitch.tv/activate',user_code:'TEST-ONLY',expires_at:Date.now()+60000};
  const f=await fixture({authFlow:{status:()=>waiting,start:async()=>{started++;return waiting;}}});
  try{
    assert.equal((await fetch(f.base+'/api/operator/auth')).status,401);
    const bootstrap=await fetch(f.base+'/api/operator/bootstrap');const Cookie=bootstrap.headers.get('set-cookie').split(';')[0];
    let response=await fetch(f.base+'/api/operator/auth',{headers:{Cookie}});assert.equal(response.status,200);assert.equal((await response.json()).stage,'waiting');assert.equal(started,0);
    const post=(body,Origin=f.base)=>fetch(f.base+'/api/operator/auth',{method:'POST',headers:{Cookie,Origin,'X-Sealed-Action':'1','Content-Type':'application/json'},body:JSON.stringify(body)});
    assert.equal((await post({scopes:['channel:manage:broadcast']})).status,400);assert.equal(started,0);
    assert.equal((await post({},'https://untrusted.invalid')).status,403);assert.equal(started,0);
    response=await post({});assert.equal(response.status,200);assert.equal(started,1);assert.equal(response.headers.get('cache-control'),'no-store');
    for(const route of ['/api/archive','/api/overlay','/api/operator/state']){
      const result=await fetch(f.base+route,{headers:{Cookie}});assert.ok(!(await result.text()).includes('TEST-ONLY'),route);
    }
  }finally{await f.close();}
});
