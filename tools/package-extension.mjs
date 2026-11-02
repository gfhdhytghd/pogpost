import { mkdir, copyFile, readFile, readdir, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';

const root=path.resolve(import.meta.dirname,'..');
const base=new URL(process.argv[2]||'https://INVALID.example');
if(base.protocol!=='https:'||base.hostname==='invalid.example'||base.username||base.password||base.pathname!=='/'||base.search||base.hash)throw Error('Pass the new HTTPS EBS origin, for example npm run ext:zip -- https://notes.example.test');
const temp=await mkdtemp(path.join(os.tmpdir(),'sealed-extension-'));
try{
  const allowedHTML=new Set(['panel.html','video_overlay.html','config.html']);
  const allowedAssets=new Set(['styles.css','panel.css','overlay.css','overlay.js','overlay-stage.js','rope-physics.js','moment-choices.js','common.js','panel.js','config.js','video_overlay.js','fraunces.woff2','fraunces-italic.woff2','instrument-sans.woff2','caveat.woff2']);
  for(const file of await readdir(path.join(root,'public'))){
    if(allowedHTML.has(file)){
      const source=await readFile(path.join(root,'public',file),'utf8');
      if(!/<head\b[^>]*>/i.test(source))throw Error(`Missing HTML head: ${file}`);
      // Twitch's helper must register its DOMContentLoaded listener while parsing.
      const hosted=source.replace(/<head\b[^>]*>/i,'$&<script src="https://extension-files.twitch.tv/helper/v1/twitch-ext.min.js"></script>');
      await writeFile(path.join(temp,file),hosted);
    }else if(allowedAssets.has(file))await copyFile(path.join(root,'public',file),path.join(temp,file));
  }
  await writeFile(path.join(temp,'client-config.js'),`globalThis.SEALED_EBS_BASE = ${JSON.stringify(base.origin)};\n`);
  await mkdir(path.join(root,'dist'),{recursive:true});
  const out=path.join(root,'dist/extension.zip');
  await rm(out,{force:true});
  execFileSync('zip',['-q','-r',out,'.'],{cwd:temp,env:{PATH:process.env.PATH},stdio:'ignore'});
  console.log('Hosted Test archive: dist/extension.zip');
}finally{await rm(temp,{recursive:true,force:true});}
