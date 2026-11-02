import { randomUUID } from 'node:crypto';

/** An explicit offline fixture, not a production moderation fallback. */
export function demoScript(engine) {
  const timers=new Set(); let running=false,closed=false;
  const later=(ms,fn)=>{const timer=setTimeout(async()=>{timers.delete(timer);try{await fn();}catch{/* Synthetic failures contain no useful public diagnostics. */}},ms);timer.unref();timers.add(timer);};
  async function start(){
    if(running||closed)return {started:false,running};
    running=true;
    try{
    await engine.newSession();
    const author={opaqueId:'Uone',userId:'101',role:'viewer',displayName:'moonlit'};
    const seal=(body,category_id,moment_id='margit',payment_mode='sim_points',extra={})=>engine.submit(author,{body,category_id,moment_id,payment_mode,show_name:true,request_id:randomUUID(),...extra});
    await seal('One last dodge. Then take the opening.','advice');
    await seal('Calling it now: this is the winning attempt.','prediction');
    await seal('The boss has requested a difficulty slider for you.','joke');
    await seal('Every attempt got you here. You have got this.','encouragement','margit','sim_bits');
    await seal('I packed snacks for the secret door we never found.','joke','never');
    await seal('Thanks for making tonight a little brighter.','encouragement','end');
    await seal('See you at the very last screen.','encouragement','finish','sim_bits');
    await engine.submit({opaqueId:'Uthree',role:'viewer'},{body:'[demo:hold] A note waiting for a moderator.','category_id':'advice',moment_id:'key',payment_mode:'free',show_name:false,request_id:randomUUID()});
    later(6000,()=>engine.occur('margit','A clean victory. The prediction came true.','streamer'));
    later(42000,()=>engine.wrap());
    later(70000,async()=>{running=false;});
    return {started:true,simulated:true};
    }catch(error){running=false;throw error;}
  }
  return {start,state:()=>({running,simulated:true}),close(){closed=true;for(const timer of timers)clearTimeout(timer);timers.clear();}};
}
