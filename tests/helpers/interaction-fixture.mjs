import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {digest} from '../../lib/evidence-contract.mjs';
import {validateProfileConfig} from '../../lib/runtime-profile.mjs';
async function temp(t){const root=await mkdtemp('/private/tmp/perfkit-interaction-fixture-');t.after(()=>rm(root,{recursive:true,force:true}));return root;}
async function json(file,value){await mkdir(path.dirname(file),{recursive:true});await writeFile(file,JSON.stringify(value));}
// Synthetic serial Event Timing contracts, not browser performance measurements.
export async function interactionFixture(t,{after=false,duration=300,runs=5,project:boundProject,files:boundFiles,themeId:boundTheme}={}){
  const root=await temp(t),project=boundProject??(after?'/synthetic/candidate':'/synthetic/baseline'),themeId=boundTheme??(after?'2':'1'),url=`https://shop.example.test/?preview_theme_id=${themeId}`;
  const files=boundFiles??[{file:'assets/a.js',sourceHash:(after?'b':'a').repeat(64),bytes:30}],sourceHash=digest(files),base=Date.UTC(2026,9,19,0,after?20:0);
  const deployment={project,store:'fixture.myshopify.com',themeId,timeoutMs:1000};
  const profile=validateProfileConfig({schemaVersion:1,project,url,device:'mobile',state:'buy',settleMs:100,timeoutMs:1000,actions:[{type:'click',selector:'#buy'}]});
  const config={schemaVersion:1,profile,runs,purpose:'acceptance',deployment,pages:[{id:'interaction',url}]};
  const proof=(start,end)=>({kind:'deployment-proof',status:'verified',scope:'theme-text-source',method:'shopify-cli-source-pull-and-browser-theme-id',project,store:deployment.store,themeId,sourceHash,remoteSourceHash:sourceHash,sourceManifest:files,
    startedAt:new Date(base+start).toISOString(),finishedAt:new Date(base+end).toISOString(),pages:[{id:'interaction',url,status:'verified',themeId,store:deployment.store}]});
  const manifest={schemaVersion:1,kind:'interaction-measurement',status:'complete',config,counts:{attempted:runs,failed:0},startedAt:new Date(base).toISOString(),finishedAt:new Date(base+10000).toISOString(),deployment:{before:proof(100,500),after:proof(8000,9000)},profiles:[]};
  for(let i=0;i<runs;i++){
    const p={kind:'runtime-profile',status:'complete',sourceStable:true,snapshot:{complete:true,hash:sourceHash,files},config:{...profile,expectedThemeId:themeId},themeId,browserVersion:'Synthetic browser contract',environment:{platform:'synthetic',arch:'synthetic',cpuModel:'contract',cpuCount:4,cache:'disabled',serviceWorkers:'blocked'},createdAt:new Date(base+1000+i*1000).toISOString(),finishedAt:new Date(base+1500+i*1000).toISOString(),errors:[],blockedRequests:[],interactionWindowStartMs:10,interactionWindowEndMs:450,finalUrl:url,afterActionsUrl:url,trace:{truncated:false},actions:[{type:'click',selector:'#buy',status:'completed',target:'#buy',startedAtMs:12,finishedAtMs:400}],
      afterActions:{supported:['event'],interactions:[{name:'click',target:'#buy',interactionId:7,startTime:20,duration,inputDelay:50,processing:50}]}};
    const file=`sample-${i+1}/profile.json`;await json(path.join(root,file),p);manifest.profiles.push({file,hash:digest(await readFile(path.join(root,file)))});
  }
  await json(path.join(root,'interactions.json'),manifest);return {root,manifest,sourceHash};
}
