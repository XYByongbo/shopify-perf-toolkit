// Explicit synthetic deployment/profile contracts for generator tests, never store measurements.
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {sourceSnapshot,sha256} from '../../lib/runtime-profile.mjs';
import {domainCandidates} from '../../lib/domain-candidates.mjs';
export async function themeStepFixture(t,files) {
  const root=await mkdtemp('/private/tmp/perfkit-theme-steps-');t.after(()=>rm(root,{recursive:true,force:true}));
  for(const [name,text] of Object.entries(files)){await mkdir(path.dirname(path.join(root,name)),{recursive:true});await writeFile(path.join(root,name),text);}
  const snapshot=await sourceSnapshot(root),url='https://fixture.myshopify.com/collections/all?preview_theme_id=1',time=n=>new Date(Date.UTC(2026,9,26,0,0,n)).toISOString();
  const proof={kind:'deployment-proof',status:'verified',scope:'theme-text-source',method:'shopify-cli-source-pull-and-browser-theme-id',project:root,
    sourceHash:snapshot.hash,remoteSourceHash:snapshot.hash,sourceManifest:snapshot.files,store:'fixture.myshopify.com',themeId:'1',pages:[{id:'target',url,status:'verified',store:'fixture.myshopify.com',themeId:'1'}]};
  const bind=p=>({...p,project:root,createdAt:time(2),finishedAt:time(3),domainProof:{version:1,url,startedAt:time(2),finishedAt:time(3),before:{...proof,startedAt:time(0),finishedAt:time(1)},after:{...proof,startedAt:time(4),finishedAt:time(5)}}});
  const runtime=bind({kind:'runtime-profile',status:'complete',sourceStable:true,snapshot,themeId:'1',finalUrl:url,config:{url,device:'mobile',state:'initial',actions:[]},domainTargets:[],resources:[],initial:{delivery:{securityPolicy:{complete:true,headers:[],meta:[]}}}});
  const liquid=(frames,samples,weights)=>{const rawProfile={shared:{frames:frames.map(name=>({name}))},profiles:[{name:'Liquid',type:'sampled',unit:'milliseconds',startValue:0,endValue:weights.reduce((a,b)=>a+b,0),samples,weights}]};
    return bind({kind:'liquid-profile',status:'complete',sourceSnapshot:snapshot,rawProfile,evidence:{origin:'shopify-cli',rawProfileHash:sha256(JSON.stringify(rawProfile)),collector:{kind:'shopify-cli',version:'4.9.4'},store:'fixture.myshopify.com',themeId:'1',urlPath:new URL(url).pathname+new URL(url).search}});};
  const diagnose=lp=>({kind:'bottleneck-diagnosis',sourceHash:snapshot.hash,candidates:domainCandidates({files:Object.entries(files).map(([file,text])=>({file,text})),snapshot,profiles:[runtime],liquidProfile:lp})});
  return {root,snapshot,url,runtime,liquid,diagnose,files};
}
