#!/usr/bin/env node
// Artificial fixture only. Real Chrome/Lighthouse; mocked Shopify pull transport.
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import {parseArgs} from 'node:util';
import {mkdtemp,mkdir,writeFile,readFile,cp} from 'node:fs/promises';
import {profileDomain} from '../lib/domain-profile.mjs';
import {verifyDeployment} from '../lib/deployment.mjs';
import {diagnoseUnified} from '../lib/decision-engine.mjs';
import {createDomainPlan} from '../lib/domain-plan.mjs';
import {applySitePlan,rollbackSitePlan} from '../lib/site-changes.mjs';
import {runPatchExperiment} from '../lib/patch-experiment.mjs';
import {fixturePNG} from '../tests/helpers/fixture-image.mjs';

const {values}=parseArgs({options:{kinds:{type:'string'}}});
const kinds=(values.kinds??'image-lcp,image-cls,app-loader').split(',');
if(!kinds.length||kinds.some(k=>!['image-lcp','image-cls','app-loader'].includes(k))||new Set(kinds).size!==kinds.length)throw new Error('Choose distinct --kinds image-lcp,image-cls,app-loader');
const root=await mkdtemp('/private/tmp/perfkit-domains-live-'),projects={},png=fixturePNG();
const server=http.createServer(async(req,res)=>{
  const u=new URL(req.url,'http://127.0.0.1'),id=u.searchParams.get('preview_theme_id')??'1';
  try {
    res.setHeader('Cache-Control','no-store');
    if(u.pathname==='/hero.png'){await new Promise(r=>setTimeout(r,1200));res.setHeader('Content-Type','image/png');res.end(png);return;}
    if(u.pathname==='/app.js'){await new Promise(r=>setTimeout(r,1600));res.setHeader('Content-Type','text/javascript');res.end('document.addEventListener("DOMContentLoaded",()=>{document.querySelector("#open").addEventListener("click",()=>document.querySelector("#reviews").textContent="Ready");});');return;}
    if(!projects[id]){res.writeHead(404);res.end();return;}
    res.setHeader('Content-Type','text/html');res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Domain optimization fixture</title><meta name="viewport" content="width=device-width,initial-scale=1"><script>window.Shopify={theme:{id:${id}},shop:'fixture.myshopify.com'};</script><style>body{margin:0;font-family:sans-serif}img{width:100%;height:auto;display:block}button{padding:12px}</style></head><body>${await readFile(path.join(projects[id],'sections/main.liquid'),'utf8')}</body></html>`);
  }catch{res.writeHead(500);res.end('Fixture error');}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin=`http://127.0.0.1:${server.address().port}`;
const deployment=args=>verifyDeployment({...args,dependencies:{runProcess:async(_command,argv)=>{await cp(args.config.project,argv[argv.indexOf('--path')+1],{recursive:true});return{code:0};}}});
const result={kind:'domain-pipeline-validation',scope:'artificial-local-fixture-only',root,results:[],formalAcceptance:'not-evaluated',realTheme:'pending user project and unpublished previews'};
console.log(JSON.stringify({root,scope:result.scope}));
try {
  for(const kind of kinds) {
    const dir=path.join(root,kind);projects['1']=path.join(dir,'baseline');projects['2']=path.join(dir,'candidate');
    const button=kind==='app-loader'?'<button id="open">Open reviews</button><output id="reviews">Closed</output>':'<button id="open" onclick="document.querySelector(\'#reviews\').textContent=\'Ready\'">Open reviews</button><output id="reviews">Closed</output>';
    const text=(kind==='app-loader'?`<script src="${origin}/app.js"></script>`:'')+'<h1>Unchanged heading</h1>'
      +`<img id="hero" src="/hero.png" alt="Fixture hero"${kind==='image-lcp'?' loading="lazy" width="800" height="400"':kind==='app-loader'?' width="800" height="400"':''}><p>Unchanged content below the image.</p>`+button;
    await mkdir(path.join(projects['1'],'sections'),{recursive:true});await mkdir(path.join(projects['1'],'assets'));
    await writeFile(path.join(projects['1'],'sections/main.liquid'),text);await cp(projects['1'],projects['2'],{recursive:true});
    const decl=id=>({project:projects[id],store:'fixture.myshopify.com',themeId:id});
    const profile=await profileDomain({config:{schemaVersion:1,mode:'runtime',deployment:decl('1'),url:origin,profile:{device:'mobile',settleMs:1500}},output:path.join(dir,'profile'),dependencies:{verifyDeployment:deployment}});
    const owners=[{id:'reviews',name:'Fixture reviews',host:'127.0.0.1',pathPrefix:'/app.js',purpose:'Reviews interaction',evidence:'Local fixture script source reviewed'}];
    const diagnosis=await diagnoseUnified({project:projects['2'],profiles:[profile],owners}),candidate=diagnosis.candidates.find(c=>c.kind===kind);assert.ok(candidate,`Missing ${kind} candidate`);
    const measurement=id=>({schemaVersion:1,engine:'lighthouse',purpose:'exploration',runs:3,devices:['mobile'],pages:[{id:'home',url:`${origin}/?preview_theme_id=${id}`}],deployment:decl(id)});
    const regression=id=>({schemaVersion:1,url:`${origin}/?preview_theme_id=${id}`,viewports:[{name:'mobile',width:390,height:844}],scenarios:[{name:'reviews',steps:[{action:'assert-image-loaded',selector:'#hero'},{action:'click',selector:'#open'},{action:'assert-text',selector:'#reviews',text:'Ready'},{action:'checkpoint',selector:'body',key:'ready'}]}]});
    for(const method of kind==='image-lcp'?candidate.methods:kind==='image-cls'?['image-dimensions']:['app-defer']) {
      const review={summary:'Review of the isolated fixture source and single shared instance; no merchant theme claim',sharedInstancesReviewed:true,responsiveRatioReviewed:true,
        dependenciesReviewed:true,nonCritical:true,documentWriteAbsent:true,businessEventsReviewed:true,businessAssertions:['#reviews']};
      const plan=await createDomainPlan({project:projects['2'],diagnosis,config:{schemaVersion:1,candidateId:candidate.candidateId,method,review}});
      await applySitePlan(plan,projects['2']);
      const experiment=await runPatchExperiment({config:{schemaVersion:1,plan,diagnosis,candidateId:candidate.candidateId,goal:{kind:'score'},runs:3,
        before:measurement('1'),after:measurement('2'),regressionBefore:regression('1'),regressionAfter:regression('2'),budget:{maxWallTimeMs:600000,maxAttempts:6,maxFailures:2}},output:path.join(dir,method),dependencies:{verifyDeployment:deployment}});
      await rollbackSitePlan(plan,projects['2']);assert.equal(await readFile(path.join(projects['2'],'sections/main.liquid'),'utf8'),text);
      result.results.push({kind,method,outcome:experiment.status,error:experiment.error??experiment.verification?.error,gain:experiment.verification?.gain,rolledBack:true,output:experiment.output});
      await writeFile(path.join(root,'result.json'),JSON.stringify(result,null,2)+'\n');
      console.log(JSON.stringify({kind,method,outcome:experiment.status,error:experiment.error??experiment.verification?.error,output:experiment.output}));
      assert.notEqual(experiment.status,'invalid-evidence','Fixture must provide complete evidence, including negative results');
      assert.notEqual(experiment.status,'functional-regressed','Generated fixture patch must preserve content and interaction');
      if(experiment.status==='promising')break;
    }
  }
  result.status='completed';await writeFile(path.join(root,'result.json'),JSON.stringify(result,null,2)+'\n');
}finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
