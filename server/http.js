import http from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { isLocalRequest } from './local-request.js';
import { decodeSecret, signExtensionJWT, verifyExtensionJWT } from './extension/auth.js';
import { ExtensionNames } from './extension/identity.js';
import { IngressLimiter } from '../engine/ingress.js';
import { validateCompiledCondition } from './conditions.js';
import { listEventPresets } from './event-presets.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const mime = { '.html':'text/html; charset=utf-8', '.css':'text/css; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.svg':'image/svg+xml', '.png':'image/png', '.woff2':'font/woff2' };
const error = (status, code) => Object.assign(new Error(code), { status, code });
const messages={invalid_stage_layout:'Keep both rope ends inside the stage and leave at least 10% width between them.',perception_unavailable:'Configure live Decisions and a local OBS source before starting detection.',invalid_perception_enabled:'Detection enabled must be true or false.',session_wrapped:'Start a new session before enabling detection.',stale_profile_context:'The active event profile changed. Refresh suggestions before confirming.',profile_moment_limit:'Applying this profile would exceed 40 retained moments. Remove unused moments in broadcaster configuration first.',profile_limit:'Save at most 20 event profiles.',profile_name_in_use:'A saved profile already uses this name.',profile_revision_required:'A saved profile revision is required.',profile_revision_conflict:'This profile changed. Refresh before saving or applying.',profile_read_only:'Built-in profiles cannot be overwritten.',profile_not_found:'Event profile not found.',invalid_profile:'Invalid event profile.',event_presets_unavailable:'The built-in event presets are unavailable. Check the installed preset files.',event_limit:'Configure at most 12 events.',event_cooldown:'This event is cooling down or already awaiting confirmation.',events_history_full:'The event receipt limit for this session is reached. Start a new session after wrap-up.',moment_mismatch:'This note fits a different moment. Choose another moment and seal again.',free_allowance_used:'Your free notes are used. Choose test points or test Bits.',viewer_limit:'Your note limit for this stream is reached.',insufficient_balance:'Your simulated balance is too low.',extension_not_configured:'The new Hosted Test extension is not configured yet.',submission_in_progress:'A note is still being checked. Wait a moment and try again.',engine_busy:'The notes queue is full. Try again shortly.',rate_limited:'Too many requests. Wait a moment and try again.',moderation_floor:'The fixed moderation rules cannot be overridden.'};
const same = (a,b) => typeof a === 'string' && a.length === b.length && timingSafeEqual(Buffer.from(a),Buffer.from(b));
async function jsonBody(req, allowed, limit=32768) {
  if (req.headers['content-type']?.split(';')[0] !== 'application/json') throw error(415,'json_required');
  let size=0; const chunks=[];
  for await (const chunk of req) { size+=chunk.length; if(size>limit) throw error(413,'body_too_large'); chunks.push(chunk); }
  let body; try { body=JSON.parse(Buffer.concat(chunks)); } catch { throw error(400,'invalid_json'); }
  if (!body || typeof body!=='object' || Array.isArray(body) || Object.keys(body).some(k=>!allowed.includes(k))) throw error(400,'invalid_body');
  return body;
}

/** Only explicit projections leave the engine. No generic filesystem or store route exists. */
export async function createHTTP({ engine, env={}, demo=false, publisher=null, watcher=null, eventSystem=null, compiler=null, credentials=null, authFlow=null, debugRecorder=null, integrations=()=>({}), runDemo=null, root=ROOT, resolveName, now=Date.now }={}) {
  const capability=randomBytes(32).toString('base64url');
  const secret=demo?randomBytes(32):env.TWITCH_EXT_SECRET?decodeSecret(env.TWITCH_EXT_SECRET):null;
  const channelId=demo?'123456':env.TWITCH_BROADCASTER_ID;
  const extOrigin=env.TWITCH_EXT_CLIENT_ID?`https://${env.TWITCH_EXT_CLIENT_ID}.ext-twitch.tv`:null;
  const names=new ExtensionNames(resolveName,now);
  const ingress=new IngressLimiter({perIdentity:12,global:200,windowMs:1000});
  const beforeAuth=new IngressLimiter({perIdentity:400,global:400,capacity:1});
  const eventsBeforeAuth=new IngressLimiter({perIdentity:40,global:40,capacity:1});
  const eventsIngress=new IngressLimiter({perIdentity:10,global:10,capacity:1});
  const eventToken=typeof env.EVENTS_API_TOKEN==='string'&&env.EVENTS_API_TOKEN.length<=512?env.EVENTS_API_TOKEN:'';
  const eventTokenDigest=createHash('sha256').update(eventToken).digest();
  const pendingViewers=new Set();
  const admit=async(identity,operation)=>{
    if(pendingViewers.size>=8||pendingViewers.has(identity.opaqueId))throw error(429,'submission_in_progress');
    pendingViewers.add(identity.opaqueId);
    try{return await operation();}finally{pendingViewers.delete(identity.opaqueId);}
  };
  const files=new Set((await readdir(path.join(root,'public'))).filter(f=>/^[a-zA-Z0-9_.-]+\.(html|js|css|svg|png|woff2)$/.test(f)));
  const server=http.createServer(async(req,res)=>{
    let allowedOrigin=null;
    const send=(status,data,type='application/json; charset=utf-8')=>{
      if(res.writableEnded) return;
      const buffer=Buffer.isBuffer(data)?data:Buffer.from(type.startsWith('application/json')?JSON.stringify(data):String(data));
      res.writeHead(status,{
        'Content-Type':type,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer',
        'Content-Length':status===204?0:buffer.length,
        ...(allowedOrigin?{'Access-Control-Allow-Origin':allowedOrigin,'Access-Control-Allow-Headers':'Authorization, Content-Type','Access-Control-Allow-Methods':'GET, POST, OPTIONS','Vary':'Origin'}:{}),
        ...(status===429?{'Retry-After':'1'}:{}),
        ...(type.startsWith('text/html')?{'Content-Security-Policy':"default-src 'self'; script-src 'self' https://extension-files.twitch.tv; style-src 'self'; img-src 'self' data:; connect-src 'self' https://*.ext-twitch.tv https://"+(env.PUBLIC_HOST||'localhost')+"; frame-ancestors https://*.twitch.tv https://*.ext-twitch.tv 'self'; base-uri 'none'; form-action 'self'"}:{})
      });
      res.end(req.method==='HEAD'||status===204?'':buffer);
    };
    try {
      const url=new URL(req.url,'http://localhost'); const route=url.pathname;
      const local=isLocalRequest(req);
      const sameOrigin=()=>{
        if(!req.headers.origin) return true;
        try { const o=new URL(req.headers.origin); return o.host===req.headers.host && ['http:','https:'].includes(o.protocol); } catch { return false; }
      };
      const requireLocal=()=>{if(!local) throw error(403,'loopback_required');};
      const requireOperator=()=>{
        requireLocal();
        const value=(req.headers.cookie||'').split(';').map(s=>s.trim()).find(s=>s.startsWith('sealed_operator='))?.slice(16);
        if(!same(value,capability)) throw error(401,'operator_cookie_required');
        if(req.method!=='GET'&&(!sameOrigin()||req.headers['x-sealed-action']!=='1')) throw error(403,'action_origin_denied');
      };
      const requireDebugPage=(allowRedirect=false)=>{
        requireLocal();
        if(!sameOrigin())throw error(403,'origin_denied');
        const value=(req.headers.cookie||'').split(';').map(s=>s.trim()).find(s=>s.startsWith('sealed_debug='))?.slice(13);
        if(!same(value,capability)){
          if(allowRedirect){res.setHeader('Location','/api/operator/bootstrap?next=debug');send(302,'','text/plain; charset=utf-8');return false;}
          throw error(401,'operator_cookie_required');
        }
        return true;
      };
      if(route==='/debug'||route.startsWith('/debug/')||['/debug.html','/debug.js','/debug.css'].includes(route)){
        if(!requireDebugPage(req.method==='GET'&&(route==='/debug'||route==='/debug/')&&!url.search))return;
        if(!['GET','HEAD'].includes(req.method))throw error(405,'method_not_allowed');
        if(url.search)throw error(400,'invalid_query');
        const file=route==='/debug'||route==='/debug/'?'debug.html':route.startsWith('/debug/')?route.slice(7):route.slice(1);
        if(!['debug.html','debug.js','debug.css'].includes(file)||!files.has(file))throw error(404,'not_found');
        return send(200,await readFile(path.join(root,'public',file)),mime[path.extname(file)]);
      }
      if(route==='/api/events/trigger'){
        requireLocal();
        if(!sameOrigin())throw error(403,'origin_denied');
        if(req.method!=='POST')throw error(405,'method_not_allowed');
        if(url.search)throw error(400,'invalid_query');
        if(!eventsBeforeAuth.accept('events',now()))throw error(429,'rate_limited');
        if(!eventToken||!eventSystem)throw error(503,'events_api_disabled');
        const authorization=req.headers.authorization||'';
        const supplied=authorization.startsWith('Bearer ')?authorization.slice(7):'';
        const suppliedDigest=createHash('sha256').update(supplied.length<=512?supplied:'').digest();
        if(!timingSafeEqual(suppliedDigest,eventTokenDigest))throw error(401,'invalid_authorization');
        if(!eventsIngress.accept('events',now()))throw error(429,'rate_limited');
        const body=await jsonBody(req,['event_id','context','idempotency_key'],8192);
        return send(200,{ok:true,...await eventSystem.trigger(body)});
      }
      if(route.startsWith('/ebs/')){
        if(!secret || !channelId) throw error(503,'extension_not_configured');
        const origin=req.headers.origin||(demo&&local?`http://${req.headers.host}`:null);
        if(demo?!(local && sameOrigin()):origin!==extOrigin) throw error(403,'origin_denied');
        allowedOrigin=origin;
        if(!beforeAuth.accept('all',now())) throw error(429,'rate_limited');
        if(!['/ebs/state','/ebs/quote','/ebs/notes','/ebs/config','/ebs/events','/ebs/compile'].includes(route)) throw error(404,'not_found');
        if(req.method==='OPTIONS') return send(204,{});
        if(url.search) throw error(400,'invalid_query');
        const token=req.headers.authorization?.startsWith('Bearer ')?req.headers.authorization.slice(7):null;
        const identity=verifyExtensionJWT(token,secret,channelId,now());
        if(!ingress.accept(identity.opaqueId,now())) throw error(429,'rate_limited');
        if(route==='/ebs/state'&&req.method==='GET') return send(200,{...engine.viewerState(identity),features:{conditionCompiler:compiler?.enabled===true},serverNow:now()});
        if(route==='/ebs/events'&&req.method==='GET') return send(200,{events:engine.events(identity),serverNow:now()});
        if(route==='/ebs/compile'){
          if(req.method!=='POST')throw error(405,'method_not_allowed');
          const body=await jsonBody(req,['text'],2048);
          if(typeof body.text!=='string'||!body.text.trim()||body.text.length>400)throw error(400,'invalid_condition');
          if(!compiler?.enabled)return send(200,{ok:false,fallback:'Choose a listed moment and condition.'});
          const result=await admit(identity,()=>compiler.compile(body.text,engine.momentChoices()));
          if(!result?.ok)return send(200,{ok:false,fallback:'Choose a listed moment and condition.'});
          const moments=engine.momentChoices();
          if(!moments.some(m=>m.id===result.moment_id))throw error(400,'invalid_condition');
          const condition=result.condition?.type==='moment'&&Object.keys(result.condition).length===1?{type:'moment'}:validateCompiledCondition(result.condition,moments);
          if(condition.type==='after'&&condition.after_moment_id===result.moment_id)throw error(400,'invalid_condition');
          return send(200,{ok:true,moment_id:result.moment_id,condition,requires_viewer_confirmation:true});
        }
        if(route==='/ebs/config'){
          if(identity.role!=='broadcaster') throw error(403,'broadcaster_required');
          if(req.method==='GET') return send(200,{config:engine.config});
          if(req.method!=='POST') throw error(405,'method_not_allowed');
          const body=await jsonBody(req,['config']);
          const config=await admit(identity,()=>engine.updateConfig(body.config));watcher?.syncDefinitions?.();return send(200,{config});
        }
        if(req.method!=='POST') throw error(405,'method_not_allowed');
        const body=await jsonBody(req,['body','category_id','moment_id','payment_mode','show_name','condition','request_id'],4096);
        const result=await admit(identity,async()=>{
          if(body.show_name){identity.displayName=demo&&identity.userId?({one:'moonlit',two:'softreset',three:'postscript'}[identity.opaqueId.slice(1)]||'a viewer'):await names.get(identity.userId);}
          return route==='/ebs/quote'?await engine.quote(identity,body):await engine.submit(identity,body);
        });
        publish(); return send(200,result);
      }
      if(route==='/demo/auth'){
        requireLocal(); if(!demo) throw error(404,'not_found');
        if(req.method!=='GET'||!sameOrigin()) throw error(403,'origin_denied');
        const viewer=url.searchParams.get('viewer')||'one';
        if(!['one','two','three'].includes(viewer)) throw error(400,'invalid_viewer');
        const role=url.searchParams.get('role')==='broadcaster'?'broadcaster':'viewer';
        const token=signExtensionJWT({exp:Math.floor(now()/1000)+3600,channel_id:channelId,opaque_user_id:'U'+viewer,role,...(url.searchParams.get('shared')==='1'?{user_id:{one:'101',two:'102',three:'103'}[viewer]}:{})},secret);
        return send(200,{token,channelId,origin:`http://${req.headers.host}`,demo:true});
      }
      if(route==='/api/operator/bootstrap'){
        requireLocal(); if(req.method!=='GET'||!sameOrigin()) throw error(403,'origin_denied');
        const debugEntry=url.searchParams.get('next')==='debug'&&url.searchParams.getAll('next').length===1&&[...url.searchParams.keys()].every(key=>key==='next');
        if(url.search&&!debugEntry)throw error(400,'invalid_query');
        res.setHeader('Set-Cookie',[`sealed_operator=${capability}; HttpOnly; SameSite=Strict; Path=/api/operator`,`sealed_debug=${capability}; HttpOnly; SameSite=Strict; Path=/debug`]);
        if(debugEntry){res.setHeader('Location','/debug');return send(302,'','text/plain; charset=utf-8');}
        return send(200,{ok:true,demo});
      }
      if(route==='/api/operator/debug'||route.startsWith('/api/operator/debug/')){
        requireOperator();if(!sameOrigin())throw error(403,'origin_denied');
        if(req.method!=='GET')throw error(405,'method_not_allowed');
        if(!debugRecorder)throw error(503,'debug_unavailable');
        if(route==='/api/operator/debug'){
          if([...url.searchParams.keys()].some(key=>!['before','limit','frame_id','request_id'].includes(key))||[...url.searchParams.keys()].some(key=>url.searchParams.getAll(key).length!==1))throw error(400,'invalid_query');
          const options={};
          for(const key of ['before','limit'])if(url.searchParams.has(key)){
            const value=url.searchParams.get(key);if(!/^\d+$/.test(value)||!Number.isSafeInteger(Number(value))||Number(value)<1||(key==='limit'&&Number(value)>250))throw error(400,'invalid_query');
            options[key]=Number(value);
          }
          for(const key of ['frame_id','request_id'])if(url.searchParams.has(key)){
            const value=url.searchParams.get(key);if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value))throw error(400,'invalid_query');
            options[key]=value;
          }
          if(options.frame_id&&options.request_id)throw error(400,'invalid_query');
          return send(200,debugRecorder.query(options));
        }
        if(url.search)throw error(400,'invalid_query');
        const match=/^\/api\/operator\/debug\/(frame|request)\/([0-9a-f-]{36})$/i.exec(route);
        if(!match)throw error(404,'not_found');
        if(match[1]==='request'){
          const request=debugRecorder.request(match[2]);if(!request)throw error(404,'debug_request_not_found');
          return send(200,{request});
        }
        const image=await debugRecorder.image(match[2]);if(!image)throw error(404,'debug_frame_not_found');
        return send(200,image.data,image.type);
      }
      if(route==='/api/operator/state'){
        requireOperator(); if(req.method!=='GET') throw error(405,'method_not_allowed');
        return send(200,{...engine.operatorState(),aiPrompts:watcher?.prompts?.()||[],integrations:integrations(),demo});
      }
      if(route==='/api/operator/credentials'){
        requireOperator();
        if(!credentials)throw error(503,'credentials_unavailable');
        if(req.method==='GET')return send(200,await credentials.status());
        if(req.method!=='POST')throw error(405,'method_not_allowed');
        const body=await jsonBody(req,['TWITCH_EXT_CLIENT_ID','TWITCH_EXT_SECRET','TWITCH_EXT_OWNER_ID','TWITCH_BROADCASTER_ID'],8192);
        return send(200,await credentials.save(body));
      }
      if(route==='/api/operator/auth'){
        requireOperator();
        if(!authFlow)throw error(503,'authorization_unavailable');
        if(req.method==='GET')return send(200,authFlow.status());
        if(req.method!=='POST')throw error(405,'method_not_allowed');
        await jsonBody(req,[],1024);
        return send(200,await authFlow.start());
      }
      if(route==='/api/operator/action'){
        requireOperator(); if(req.method!=='POST') throw error(405,'method_not_allowed');
        const body=await jsonBody(req,['action','id','moment_id','approve','context','label','long_lived','verdict','event','event_id','events','profile','profile_kind','profile_id','expected_revision','enabled','mode','layout']);
        let result;
        switch(body.action){
          case 'stage_layout_set': result=await engine.setStageLayout(body.layout);break;
          case 'presentation_set': if(!['manual','auto'].includes(body.mode))throw error(400,'invalid_presentation_mode');result=await engine.updateConfig({reveal:{mode:body.mode}});break;
          case 'debug_set': if(!debugRecorder)throw error(503,'debug_unavailable');result=await debugRecorder.setEnabled(body.enabled);break;
          case 'demo': if(!demo||!runDemo)throw error(403,'demo_disabled'); result=await runDemo();break;
          case 'moment': result=await engine.occur(body.moment_id,body.context||'Streamer declared this moment.','streamer');break;
          case 'review': result=await engine.review(body.id,body.approve);break;
          case 'reveal': result=await engine.reveal(body.id);break;
          case 'skip': result=await engine.skip();break;
          case 'wrap': result=await engine.wrap();break;
          case 'session': result=await engine.newSession();break;
          case 'verdict': result=await engine.overrideVerdict(body.id,body.verdict);break;
          case 'add_moment': result=await engine.addMoment({label:body.label,long_lived:body.long_lived});break;
          case 'perception_set': if(typeof body.enabled!=='boolean')throw error(400,'invalid_perception_enabled');if(!watcher?.setPerceptionEnabled)throw error(503,'perception_unavailable');result=await watcher.setPerceptionEnabled(body.enabled);break;
          case 'reset_perception': await watcher?.reset?.();result={reset:true};break;
          case 'events_list': result={events:await engine.listEventDefinitions()};break;
          case 'events_presets': result={presets:await listEventPresets()};break;
          case 'events_profiles': result=await engine.listEventProfiles();break;
          case 'events_profile_save': result={profile:await engine.saveEventProfile(body.profile)};break;
          case 'events_profile_activate': result=await engine.activateEventProfile({kind:body.profile_kind,id:body.profile_id,...(Object.hasOwn(body,'expected_revision')?{expected_revision:body.expected_revision}:{})});watcher?.syncDefinitions?.();break;
          case 'events_upsert': result={event:await engine.upsertEventDefinition(body.event)};watcher?.syncDefinitions?.();break;
          case 'events_delete': result=await engine.deleteEventDefinition(body.event_id);watcher?.syncDefinitions?.();break;
          case 'events_import': result={events:await engine.importEventDefinitions(body.events)};watcher?.syncDefinitions?.();break;
          case 'confirm_ai': {
            if(typeof body.approve!=='boolean')throw error(400,'confirmation_required');
            const expectedSessionId=engine.operatorState().session?.id;
            const prompt=await watcher?.confirm?.(body.id); if(!prompt) throw error(404,'prompt_not_found');
            if(body.approve===false){result={dismissed:true};break;}
            result=await engine.occur(prompt.moment_id,body.context||prompt.context||prompt.label,prompt.source==='api'?'api-confirmed':'ai-confirmed',{expectedSessionId:prompt.expectedSessionId??expectedSessionId,expiresAt:prompt.expires_at,expectedEventDefinition:prompt.definitionFingerprint,expectedProfileContext:prompt.expectedProfileContext});break;
          }
          default:throw error(400,'invalid_action');
        }
        publish(); return send(200,{ok:true,result});
      }
      if(route==='/api/overlay'){
        requireLocal();if(req.method!=='GET')throw error(405,'method_not_allowed');
        return send(200,engine.overlayState());
      }
      if(route==='/api/archive'){
        if(!['GET','HEAD'].includes(req.method))throw error(405,'method_not_allowed');
        return send(200,{notes:engine.archive()});
      }
      if(route==='/client-config.js'){
        if(!['GET','HEAD'].includes(req.method))throw error(405,'method_not_allowed');
        const base=env.EBS_PUBLIC_URL||'';
        return send(200,`globalThis.SEALED_EBS_BASE = ${JSON.stringify(base).replace(/</g,'\\u003c')};\n`,'text/javascript; charset=utf-8');
      }
      let file=({'/':'index.html','/console':'console.html','/overlay':'overlay.html','/archive':'archive.html','/setup':'setup.html'})[route]||route.slice(1);
      if(['index.html','console.html','overlay.html','harness.js','setup.html'].includes(file)) requireLocal();
      if(!['GET','HEAD'].includes(req.method)||!files.has(file)||file.includes('/')) throw error(404,'not_found');
      return send(200,await readFile(path.join(root,'public',file)),mime[path.extname(file)]);
    } catch(e){
      const status=Number.isInteger(e.status)&&e.status>=400&&e.status<600?e.status:503;
      const code=typeof e.code==='string'&&/^[a-z][a-z0-9_]{0,63}$/.test(e.code)?e.code:status===503?'service_unavailable':'request_failed';
      send(status,{ok:false,error:code,...(messages[code]?{message:messages[code]}:{})});
    }
  });
  server.requestTimeout=5000; server.headersTimeout=10000;
  const published=new Set();
  function publish(){
    if(!publisher)return;
    const snapshot=engine.overlayState();
    publisher.snapshot({type:'sealed_count',sealedCount:snapshot.sealedCount,presentation_version:createHash('sha256').update(JSON.stringify([snapshot.presentation_mode,snapshot.config?.reveal?.rope,snapshot.current?.id,snapshot.current?.prediction_verdict,snapshot.ready_envelopes,snapshot.sealed_envelopes,snapshot.session?.id])).digest('hex').slice(0,16)});
    for(const note of engine.archive()){
      if(published.has(note.id))continue;
      published.add(note.id);
      // Recipient identity is obtained privately from the engine, never from archive JSON.
      const recipient=engine.recipient?.(note.id);
      if(recipient)publisher.whisper(recipient,{type:'opened',id:note.id,revealed_at:note.revealed_at});
    }
  }
  server.publish=publish;
  return server;
}
