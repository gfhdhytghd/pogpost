import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {createLanWebUI,lanRequestAllowed} from '../tools/lan-webui.mjs';
const host='172.16.105.62',port=8788;
const req=(headers={},peer='172.16.105.20')=>({socket:{remoteAddress:peer},headers:{host:`${host}:${port}`,...headers}});
test('LAN webui requires exact host, same subnet, direct connection and same origin',()=>{
 assert.equal(lanRequestAllowed(req(),host,port),true);
 for(const r of [req({},'198.51.100.1'),req({},'172.16.104.1'),req({host:'public.example'}),req({origin:'https://public.example'}),req({'x-forwarded-for':'172.16.105.20'})])assert.equal(lanRequestAllowed(r,host,port),false);
 assert.throws(()=>createLanWebUI({host:'0.0.0.0'}));
});
test('LAN gateway forwards only operator UI with origin translation, excluding trigger and setup',async t=>{
 const seen=[];
 const upstream=http.createServer((r,s)=>{seen.push({path:r.url,origin:r.headers.origin,host:r.headers.host,action:r.headers['x-sealed-action']});r.resume();s.setHeader('Set-Cookie','sealed_operator=synthetic; Path=/api/operator; HttpOnly');s.end('{}');});
 await new Promise(r=>upstream.listen(0,'127.0.0.1',r));
 const gateway=createLanWebUI({host,port,upstreamPort:upstream.address().port});
 // Only this isolated fixture's local socket simulates a same-subnet LAN peer.
 gateway.on('connection',socket=>Object.defineProperty(socket,'remoteAddress',{value:'172.16.105.20'}));
 await new Promise(r=>gateway.listen(0,'127.0.0.1',r));
 t.after(async()=>{gateway.closeAllConnections();upstream.closeAllConnections();await Promise.all([new Promise(r=>gateway.close(r)),new Promise(r=>upstream.close(r))]);});
 const base=`http://127.0.0.1:${gateway.address().port}`;
 const call=(path,body)=>new Promise((resolve,reject)=>{
  const r=http.request(base+path,{method:body?'POST':'GET',headers:{Host:`${host}:${port}`,Origin:`http://${host}:${port}`,'Content-Type':'application/json','X-Sealed-Action':'1'}},s=>{s.resume();s.on('end',()=>resolve({status:s.statusCode}));});
  r.on('error',reject);r.end(body?JSON.stringify(body):undefined);
 });
 assert.equal((await call('/console')).status,200);
 assert.equal((await call('/console-layout.css')).status,200,'the operator-only layout stylesheet is available over LAN');
 assert.equal((await call('/moment-choices.js')).status,200,'the console shared moment policy is available over LAN');
 assert.equal((await call('/overlay.css')).status,200,'the rope overlay stylesheet is available over LAN');
 assert.equal((await call('/rope-physics.js')).status,200,'the shared physics module is available over LAN');
 assert.equal((await call('/api/operator/action',{action:'stage_layout_set',layout:{left:{x:0,y:0.1},right:{x:1,y:0.2}}})).status,200);
 assert.equal((await call('/api/operator/action',{action:'perception_set',enabled:false})).status,200);
 assert.equal(seen.at(-1).origin,`http://127.0.0.1:${upstream.address().port}`);
 for(const path of ['/api/events/trigger','/setup','/api/operator/credentials','/ebs/state'])assert.equal((await call(path)).status,403);
 assert.equal((await call('/api/operator/action',{action:'save_credentials'})).status,403);
 assert.equal(seen.length,7);
});
