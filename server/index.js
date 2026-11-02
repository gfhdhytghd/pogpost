import { parseEnv } from 'node:util';
import { readFile, mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHTTP } from './http.js';
import { NotesEngine } from './domain.js';
import { JsonStore, MemoryStore } from './store.js';
import { Judgements, DemoJudgements } from './judgements.js';
import { createTwitchAdapter } from './twitch-adapter.js';
import { ExtensionPublisher } from './extension/publisher.js';
import { decodeSecret } from './extension/auth.js';
import { demoScript } from './demo.js';
import { SpeechWatcher } from './perception.js';
import { EventWatcher } from './event-watcher.js';
import { EventSystem } from './events.js';
import { eventProfileContext } from './event-profiles.js';
import { loadEventPreset } from './event-definitions.js';
import { createOBSSource } from './obs-source.js';
import { visualConfig } from './visual-config.js';
import { createSpeechSource } from './speech-source.js';
import { ConditionCompiler } from './condition-compiler.js';
import { CredentialSetup } from './credential-setup.js';
import { TwitchDeviceFlow } from './twitch-device-flow.js';
import { DebugRecorder } from './debug-recorder.js';
import { debugCall } from './debug-hooks.js';

export const ROOT=path.resolve(import.meta.dirname,'..');
export async function createApplication({demo=false,scripted=false,env={},store,root=ROOT,decisions,debugRecorder:providedDebugRecorder,obsSourceFactory=createOBSSource,compiler:providedCompiler,now=Date.now,...httpOptions}={}){
  if(env.PAYMENTS_LIVE==='true')throw Error('Live payments must remain disabled for this channel.');
  let debugRecorder=providedDebugRecorder??null;
  // Injected stores are used by offline tests; they never read workstation debug history.
  if(providedDebugRecorder===undefined&&!demo&&!store){
    try{debugRecorder=await DebugRecorder.open({directory:path.join(root,'data/debug'),now});}catch{/* Normal operation does not depend on debug storage. */}
  }
  const judge=decisions||(demo?new DemoJudgements():new Judgements({enabled:env.DECISIONS_LIVE==='true',keyReader:()=>env.OPENAI_API_KEY,debugRecorder}));
  if(!store){
    if(demo)store=new MemoryStore();
    else {await mkdir(path.join(root,'data'),{recursive:true,mode:0o700});store=new JsonStore({file:path.join(root,'data/notes.json')});}
  }
  const engine=new NotesEngine({store,decisions:judge,now});
  const eventSystem=new EventSystem({engine,now});
  if(demo){
    const demoIds=new Set(['margit','key','finish']);
    const moments=engine.config.moments.map(moment=>demoIds.has(moment.id)?{...moment,kind:'ai'}:moment);
    await engine.updateConfig({moments,events:moments.filter(moment=>demoIds.has(moment.id)).map(moment=>({id:moment.id,label:moment.label,description:'A clearly visible demo event: '+moment.label+'.',mode:'instant',min_confidence:0.85,cooldown_s:30,auto_confirm:false}))});
  }
  if(!demo&&env.EVENTS_PRESET_FILE){
    const preset=await loadEventPreset(path.resolve(root,env.EVENTS_PRESET_FILE));
    await engine.importEventDefinitions(preset.events);
  }
  const script=demo?demoScript(engine):null;
  const compiler=providedCompiler||new ConditionCompiler({enabled:!demo&&env.ASTRA_CONDITIONS==='true'});
  let source=null,speechSource=null;
  const watchers=[];
  let pictureWatcher=null;
  async function startPicture(){
    if(pictureWatcher)return {enabled:true};
    if(engine.state.session.wrapped_at!==null)throw Object.assign(Error('Start a new stream session before enabling detection.'),{status:409,code:'session_wrapped'});
    if(demo||env.DECISIONS_LIVE!=='true'||!env.OBS_SOURCE_NAME)throw Object.assign(Error('Picture detection requires live Decisions and a configured OBS source.'),{status:503,code:'perception_unavailable'});
    const profile=env.OBS_GAME_PROFILE||'generic';
    if(!['generic','ksp'].includes(profile))throw Error('Unknown OBS game profile. Use generic or ksp.');
    if(!engine.config.events.length&&!engine.state.event_profile_active_ref&&!env.EVENTS_PRESET_FILE)await engine.importEventDefinitions((await loadEventPreset(path.join(ROOT,'presets',profile==='ksp'?'ksp.json':'generic.json'))).events);
    const visual=visualConfig(env);
    source=obsSourceFactory({url:env.OBS_WS_URL||'ws://127.0.0.1:4455',password:env.OBS_PASSWORD||'',sourceName:env.OBS_SOURCE_NAME,width:visual.width,height:visual.height,intervalMs:visual.intervalMs,scheduleToleranceMs:20});
    const frameWatcher=new EventWatcher({judgements:judge,definitions:engine.config.events,
      debugRecorder,
      adaptive:visual.adaptive,reviewConfidence:visual.reviewConfidence,reviewMode:visual.reviewMode,
      readObservation:async()=>{pictureWatcher?.setDefinitions(engine.config.events);const observation=await source.readObservation();
        if(observation)debugCall(debugRecorder,'recordFrame',observation);
        else debugCall(debugRecorder,'recordDecision',{kind:'capture',reason:'capture_unavailable'});
        return observation;},
      onCandidate:(eventId,metadata)=>eventSystem.propose(eventId,metadata),
      getSessionId:()=>`${engine.state.session.id}:${engine.state.session.wrapped_at??''}:${eventProfileContext(engine.state.event_profile_active_ref,engine.state.event_profile_context_epoch)}`,isActive:()=>!engine.state.session.wrapped_at,now});
    pictureWatcher=frameWatcher;
    watchers.push(frameWatcher);frameWatcher.start();
    return {enabled:true};
  }
  async function stopPicture(){
    if(!pictureWatcher)return {enabled:false};
    const old=pictureWatcher;
    pictureWatcher=null;
    old.close();
    const index=watchers.indexOf(old);if(index>=0)watchers.splice(index,1);
    source?.close();source=null;
    judge.cancelPictureRequests?.();
    await eventSystem.reset();
    return {enabled:false};
  }
  let perceptionTail=Promise.resolve();
  function setPerceptionEnabled(enabled){
    if(typeof enabled!=='boolean')return Promise.reject(Object.assign(Error('Choose true or false for detection.'),{status:400,code:'invalid_perception_enabled'}));
    const operation=perceptionTail.then(()=>enabled?startPicture():stopPicture());
    perceptionTail=operation.catch(()=>{});
    return operation;
  }
  if(!demo&&env.OBS_FRAME_WATCHER==='true'){
    if(env.DECISIONS_LIVE!=='true'||!env.OBS_SOURCE_NAME)throw Error('The optional frame watcher requires an explicit source and live Decisions.');
    await startPicture();
  }
  if(!demo&&env.SPEECH_WATCHER==='true'){
    if(env.DECISIONS_LIVE!=='true'||!env.SPEECH_TRANSCRIPT_FILE)throw Error('Speech suggestions require an explicit private transcript and live Decisions.');
    const transcriptRoot=path.join(root,'data/transcripts');
    await mkdir(transcriptRoot,{recursive:true,mode:0o700});
    const moments=engine.config.moments;
    for(const [id,label] of [['ai-blames-game','Streamer blames the game'],['ai-boast','Streamer boasts'],['ai-laughing','Streamer laughs']])
      if(!moments.some(m=>m.id===id))moments.push({id,label,kind:'ai',long_lived:false});
    await engine.updateConfig({moments});
    speechSource=createSpeechSource({file:path.resolve(root,env.SPEECH_TRANSCRIPT_FILE),root:transcriptRoot,now});
    const speechWatcher=new SpeechWatcher({judgements:judge,readTranscript:()=>speechSource.readTranscript(),now});
    watchers.push(speechWatcher);speechWatcher.start();
  }
  const watcher={setPerceptionEnabled,syncDefinitions(){pictureWatcher?.setDefinitions(engine.config.events);},
    prompts(){this.syncDefinitions();return [...eventSystem.prompts(),...watchers.flatMap(w=>w.prompts())];},
    async reset(){for(const w of watchers)w.reset?.();await eventSystem.reset();},
    async confirm(id){const event=await eventSystem.confirm(id);if(event)return event;for(const w of watchers){const p=w.confirm(id);if(p)return p;}return null;},
    close(){for(const w of watchers)w.close();}};
  let publisher=null,twitch=null;
  if(!demo&&env.TWITCH_CONNECT==='true'){
    if(env.TWITCH_EXT_SECRET&&env.TWITCH_EXT_CLIENT_ID&&env.TWITCH_EXT_OWNER_ID&&env.TWITCH_BROADCASTER_ID)
      publisher=new ExtensionPublisher({secret:decodeSecret(env.TWITCH_EXT_SECRET),clientId:env.TWITCH_EXT_CLIENT_ID,ownerId:env.TWITCH_EXT_OWNER_ID,channelId:env.TWITCH_BROADCASTER_ID});
    twitch=createTwitchAdapter(engine,env);
  }
  const authFlow=demo?null:new TwitchDeviceFlow({root,env,now});
  const debugStatus=()=>{
    try {
      if(!debugRecorder||debugRecorder.closed===true||debugRecorder.storageBlocked===true)return {available:false,enabled:false};
      return {available:true,enabled:debugRecorder.state().enabled===true};
    } catch {return {available:false,enabled:false};}
  };
  const integrations=()=>({debug:debugStatus(),twitch:{status:demo?'simulated':twitch?.state().connection||'disabled'},authorization:{status:authFlow?.status().stage||'disabled'},judgements:demo?{status:'simulated',simulated:true}:env.DECISIONS_LIVE==='true'?judge.state():{status:'disabled',enabled:false},perception:{status:pictureWatcher?'watching':'disabled',profile:pictureWatcher?(env.OBS_GAME_PROFILE||'generic'):null,enabled:!!pictureWatcher,controllable:!demo&&env.DECISIONS_LIVE==='true'&&!!env.OBS_SOURCE_NAME,unavailable_reason:demo?'Picture detection is unavailable in the simulated demo.':env.DECISIONS_LIVE!=='true'?'Enable live Decisions before starting picture detection.':!env.OBS_SOURCE_NAME?'Configure an OBS source before starting picture detection.':null,pending:watcher.prompts().length,...(source?.state?{capture:source.state()}:{}),...(pictureWatcher?{watcher:pictureWatcher.state()}:{} )},compiler:compiler.state?.()||{status:compiler.enabled?'ready':'disabled'}});
  const credentials=demo?null:new CredentialSetup({root});
  const server=await createHTTP({engine,env,demo,publisher,watcher,eventSystem,compiler,credentials,authFlow,debugRecorder,integrations,root,now,...httpOptions,runDemo:script?()=>script.start():null,resolveName:async(id)=>{
    if(!twitch?.api)return null;
    const result=await twitch.api.request('/users?id='+encodeURIComponent(id));
    return result.data?.[0]?.display_name;
  }});
  // Clock-driven windows and one-at-a-time reveal advancement continue without an open console.
  let ticking=false;
  const tick=setInterval(async()=>{
    if(ticking)return;
    ticking=true;
    try{await engine.tick?.();server.publish();}catch{/* No private engine errors enter logs. */}
    finally{ticking=false;}
  },250);
  tick.unref();
  if(demo&&scripted)await script.start();
  if(!demo&&env.DECISIONS_LIVE==='true')void judge.warmup();
  return {server,engine,decisions:judge,debugRecorder,async close(){clearInterval(tick);script?.close();authFlow?.close();watcher.close();source?.close();speechSource?.close();compiler.close?.();twitch?.close();publisher?.close();judge.close?.();server.closeAllConnections();if(server.listening)await new Promise(resolve=>server.close(resolve));try{await debugRecorder?.close?.();}catch{/* Debug I/O never prevents shutdown. */}}};
}

if(process.argv[1]&&fileURLToPath(import.meta.url)===path.resolve(process.argv[1])){
  const demo=process.argv.includes('--demo');
  const decisionsLive=process.argv.includes('--decisions-live');
  if(demo&&decisionsLive)throw Error('Live Decisions cannot be enabled in the offline demo.');
  let env={};
  // Demo deliberately never reads project credentials or connects to providers.
  if(!demo){
    try{
      const file=path.join(ROOT,'.env');
      if(((await stat(file)).mode&0o777)!==0o600)throw Error('The .env file must have mode 0600.');
      env=parseEnv(await readFile(file,'utf8'));
    }catch(e){if(e.code!=='ENOENT')throw e;}
  }
  // An explicit process flag can enable the existing adapter without editing credentials.
  if(decisionsLive)env.DECISIONS_LIVE='true';
  const args=process.argv.find(s=>s.startsWith('--port='));
  const port=Number(args?.slice(7)||env.PORT||8788);
  if(!Number.isInteger(port)||port<1||port>65535)throw Error('Invalid port');
  const app=await createApplication({demo,scripted:demo,env});
  app.server.listen(port,'127.0.0.1',()=>console.log(`Sealed Notes ${demo?'offline demo':'server'}: http://127.0.0.1:${port}`));
  for(const signal of ['SIGINT','SIGTERM'])process.once(signal,async()=>{await app.close();process.exit(0);});
}
