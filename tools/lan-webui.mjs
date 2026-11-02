import http from 'node:http';
import {isIP} from 'node:net';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const assets=new Set(['console.html','console-layout.css','console.js','console-events.js','moment-choices.js','common.js','styles.css','client-config.js','overlay.html','overlay.js','overlay-stage.js','rope-physics.js','overlay.css','archive.html','archive.js','instrument-sans.woff2','fraunces.woff2','fraunces-italic.woff2','caveat.woff2']);
const actions=new Set(['stage_layout_set','presentation_set','moment','review','reveal','skip','wrap','session','verdict','add_moment','perception_set','reset_perception','debug_set','events_list','events_presets','events_profiles','events_profile_save','events_profile_activate','events_upsert','events_delete','events_import','confirm_ai']);
export function lanRequestAllowed(req,host,port){
  const peer=req.socket?.remoteAddress?.replace(/^::ffff:/,'');
  if(!peer?.startsWith(host.slice(0,host.lastIndexOf('.')+1))||isIP(peer)!==4)return false;
  if(req.headers.host!==`${host}:${port}`)return false;
  if(['forwarded','x-forwarded-for','x-forwarded-host','x-forwarded-proto'].some(key=>req.headers[key]))return false;
  return !req.headers.origin||req.headers.origin===`http://${host}:${port}`;
}
/** Explicit LAN-only operator gateway. Sensitive setup/auth and the event trigger API are never forwarded. */
export function createLanWebUI({host,port=8788,upstreamPort=8788}){
  if(isIP(host)!==4||!/^172\.(1[6-9]|2\d|3[01])\./.test(host))throw Error('Use an explicit 172.16/12 LAN IPv4 address.');
  if(!Number.isInteger(port)||port<1||port>65535||!Number.isInteger(upstreamPort)||upstreamPort<1||upstreamPort>65535)throw Error('Invalid port.');
  const server=http.createServer(async(req,res)=>{
    const fail=(status,code)=>{if(!res.headersSent)res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify({error:code}));};
    if(!lanRequestAllowed(req,host,port))return fail(403,'lan_access_denied');
    let url;try{url=new URL(req.url,'http://localhost');}catch{return fail(400,'invalid_url');}
    if(url.pathname==='/'){res.writeHead(302,{Location:'/console','Cache-Control':'no-store'});res.end();return;}
    const route=url.pathname;
    const get=['/console','/overlay','/archive','/debug','/api/operator/bootstrap','/api/operator/state','/api/operator/debug','/api/overlay','/api/archive'].includes(route)||
      /^\/api\/operator\/debug\/(frame|request)\/[0-9a-f-]{36}$/.test(route)||['/debug/debug.html','/debug/debug.js','/debug/debug.css'].includes(route)||assets.has(route.slice(1));
    const post=route==='/api/operator/action'&&req.method==='POST';
    if(!post&&(!get||!['GET','HEAD'].includes(req.method)))return fail(403,'route_not_exposed');
    let body;
    if(post){
      if(req.headers['content-type']?.split(';')[0]!=='application/json')return fail(415,'json_required');
      try{const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>32768)return fail(413,'body_too_large');chunks.push(chunk);}body=Buffer.concat(chunks);if(!actions.has(JSON.parse(body).action))return fail(403,'action_not_exposed');}catch{return fail(400,'invalid_body');}
    }
    const headers={host:`127.0.0.1:${upstreamPort}`};
    for(const key of ['cookie','content-type','x-sealed-action','accept','if-none-match'])if(req.headers[key])headers[key]=req.headers[key];
    if(req.headers.origin)headers.origin=`http://127.0.0.1:${upstreamPort}`;
    if(body)headers['content-length']=body.length;
    const upstream=http.request({hostname:'127.0.0.1',port:upstreamPort,path:url.pathname+url.search,method:req.method,headers},reply=>{
      const responseHeaders={...reply.headers,'cache-control':'no-store'};
      delete responseHeaders['connection'];delete responseHeaders['transfer-encoding'];
      res.writeHead(reply.statusCode,responseHeaders);reply.pipe(res);
      reply.on('error',()=>res.destroy());
    });
    upstream.on('error',()=>fail(502,'webui_unavailable'));
    upstream.setTimeout(15000,()=>upstream.destroy());
    res.on('close',()=>{if(!res.writableEnded)upstream.destroy();});
    upstream.end(body);
  });
  server.requestTimeout=10000;server.headersTimeout=10000;
  return server;
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===path.resolve(process.argv[1])){
  const args=process.argv.slice(2);
  if(args.some(a=>!a.startsWith('--host=')&&!a.startsWith('--port=')))throw Error('Unsupported option.');
  const host=args.find(a=>a.startsWith('--host='))?.slice(7),port=Number(args.find(a=>a.startsWith('--port='))?.slice(7)||8788);
  const server=createLanWebUI({host,port});
  server.listen(port,host,()=>console.log(`LAN operator UI: http://${host}:${port}/console`));
  for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>server.close(()=>process.exit(0)));
}
