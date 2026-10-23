#!/usr/bin/env node
// Real browser/Lighthouse integration on an artificial local theme. The Shopify
// CLI source transport is replaced with fixture copying; no store is contacted.
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { mkdtemp, mkdir, readFile, writeFile, cp } from 'node:fs/promises';
import { Liquid } from 'liquidjs';
import { profileRuntime } from '../lib/runtime-profile.mjs';
import { diagnoseBottlenecks } from '../lib/bottlenecks.mjs';
import { createDemandPlan } from '../lib/demand-plan.mjs';
import { applySitePlan } from '../lib/site-changes.mjs';
import { verifyDeployment } from '../lib/deployment.mjs';
import { runPatchExperiment } from '../lib/patch-experiment.mjs';

const root=await mkdtemp('/private/tmp/perfkit-demand-live-'), baseline=path.join(root,'baseline'), candidate=path.join(root,'candidate');
const css='body { margin: 20px; font-family: sans-serif; }\nh1 { color: navy; }\nbutton { padding: 8px; }\n'+Array.from({length:3000},(_,i)=>`.unused-${i} { color: red; margin: 20px; padding: 32px; border-radius: 8px; }`).join('\n');
const files={ 'assets/main.css':css, 'layout/theme.liquid':"<link rel=\"stylesheet\" href=\"{{ 'main.css' | asset_url }}\">", 'templates/index.json':'{"sections":{}}' };
for(const [file,text] of Object.entries(files)) { await mkdir(path.dirname(path.join(baseline,file)),{recursive:true}); await writeFile(path.join(baseline,file),text); }
await cp(baseline,candidate,{recursive:true});
const projects={'1':baseline,'2':candidate};
const server=http.createServer(async(req,res)=>{
  const url=new URL(req.url,'http://127.0.0.1'), id=url.searchParams.get('preview_theme_id')??'1', project=projects[id];
  try {
    if (!project) { res.writeHead(404);res.end();return; }
    if(url.pathname.startsWith('/assets/')) {
      const text=await readFile(path.join(project,'assets',path.posix.basename(url.pathname)),'utf8');
      res.setHeader('Content-Type','text/css');res.setHeader('Cache-Control','no-store');
      if(url.pathname.endsWith('/main.css')) await new Promise(resolve=>setTimeout(resolve,2500));
      res.end(text);return;
    }
    const liquid=new Liquid();liquid.registerFilter('asset_url',name=>`/assets/${name}?preview_theme_id=${id}`);
    const styles=await liquid.parseAndRender(await readFile(path.join(project,'layout/theme.liquid'),'utf8'));
    res.setHeader('Content-Type','text/html');res.setHeader('Cache-Control','no-store');
    res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Isolated demand-loading benchmark</title>${styles}<script>window.Shopify={theme:{id:${id}},shop:'fixture.myshopify.com'};</script></head><body><h1>Unchanged fixture heading</h1><p>Identical content and layout on both sides.</p><button type="button" onclick="document.querySelector('output').textContent=String(Number(document.querySelector('output').textContent)+1)">Open</button><output>0</output></body></html>`);
  }catch(error){res.writeHead(500);res.end('Fixture error');}
});
await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
const origin=`http://127.0.0.1:${server.address().port}`;
try {
  const profiles=[];
  for(const device of ['mobile','desktop']) {
    const profile=await profileRuntime({config:{schemaVersion:1,project:baseline,url:`${origin}/?preview_theme_id=1`,device,settleMs:100,actions:[{type:'click',selector:'button'}],expectedThemeId:'1'},output:path.join(root,`profile-${device}`)});
    assert.equal(profile.status,'complete',JSON.stringify(profile.errors)); profiles.push(profile);
  }
  const diagnosis=await diagnoseBottlenecks({project:baseline,profiles});
  const hotspot=diagnosis.candidates.find(c=>c.file==='assets/main.css'&&c.kind==='render-resource');assert.ok(hotspot);
  const plan=await createDemandPlan({project:candidate,diagnosis,profiles,config:{schemaVersion:1,mode:'critical-css',source:'assets/main.css',newAsset:'assets/critical.css',loaderTarget:'layout/theme.liquid',tagStart:0,inlineLoadHandlerAllowed:true,candidateId:hotspot.candidateId}});
  await applySitePlan(plan,candidate);
  const measurement=id=>({schemaVersion:1,engine:'lighthouse',pages:[{id:'fixture',url:`${origin}/?preview_theme_id=${id}`}],devices:['mobile'],timeoutMs:90000,deployment:{project:projects[id],store:'fixture.myshopify.com',themeId:id,timeoutMs:30000}});
  const regression=id=>({schemaVersion:1,url:`${origin}/?preview_theme_id=${id}`,viewports:[{name:'mobile',width:390,height:844}],scenarios:[{name:'first-action',steps:[{action:'click',selector:'button'},{action:'assert-text',selector:'output',text:'1'},{action:'checkpoint',selector:'body',key:'opened'}]}]});
  const result=await runPatchExperiment({config:{schemaVersion:1,plan,diagnosis,candidateId:hotspot.candidateId,before:measurement('1'),after:measurement('2'),regressionBefore:regression('1'),regressionAfter:regression('2'),budget:{maxWallTimeMs:360000,maxAttempts:6,maxFailures:1,maxCandidateRounds:1}},output:path.join(root,'experiment'),dependencies:{
    verifyDeployment:({config,pages})=>verifyDeployment({config,pages,dependencies:{runProcess:async(command,args)=>{
      assert.equal(args[0],'theme');assert.equal(args[1],'pull');
      const source=projects[args[args.indexOf('--theme')+1]], target=args[args.indexOf('--path')+1];
      await cp(source,target,{recursive:true});return {code:0,stdout:'Isolated fixture source transport',stderr:''};
    }}})
  }});
  const summary={kind:'demand-pipeline-validation',scope:'Artificial local theme; real Chrome and six Lighthouse samples; Shopify CLI source transport mocked. Not store performance evidence.',output:root,status:result.status,samples:result.counts,score:result.verification?.gain?.groups?.[0]?.metrics?.score,checks:result.verification?.checks,error:result.error??result.verification?.error};
  await writeFile(path.join(root,'validation.json'),JSON.stringify(summary,null,2));console.log(JSON.stringify(summary,null,2));
  assert.equal(result.status,'promising',JSON.stringify(summary));assert.equal(result.schedule.length,6);assert.equal(result.formalAcceptance,'not-evaluated');
}finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
