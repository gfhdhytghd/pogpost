import { $, api, post, status } from './common.js';
const local=['localhost','127.0.0.1','[::1]'].includes(location.hostname);
if(!local){$('#play-demo').hidden=true;for(const link of document.querySelectorAll('a[href*="demo=1"]'))link.href=link.href.replace(/\?demo=1(?:&role=broadcaster)?/,'');}
$('#play-demo').onclick=async()=>{const button=$('#play-demo');button.disabled=true;try{await api('/api/operator/bootstrap');await post('/api/operator/action',{action:'demo'},{'X-Sealed-Action':'1'});status('The letters are sealed. Open the on-stream reveal to watch the demo.');}catch(error){status(error.message,true);}finally{button.disabled=false;}};
