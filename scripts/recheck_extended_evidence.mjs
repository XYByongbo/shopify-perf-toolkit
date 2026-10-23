#!/usr/bin/env node
// Recheck saved Lighthouse evidence with new behavior captures. Never resamples or edits scores.
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import {readFile,writeFile,mkdir,cp} from 'node:fs/promises';
import {Liquid} from 'liquidjs';
import {applySitePlan,rollbackSitePlan} from '../lib/site-changes.mjs';
import {verifyDeployment} from '../lib/deployment.mjs';
import {runScenarios} from '../lib/scenarios.mjs';
import {verifyPatchExperiment} from '../lib/patch-experiment.mjs';
import {diagnoseRecovery} from '../lib/recovery.mjs';
import {readExperimentCost} from '../lib/recovery-cost.mjs';
const root=process.argv[2];assert.ok(path.isAbsolute(root??''),'Provide the prior validate_extended_recovery output root');
const read=async file=>JSON.parse(await readFile(file,'utf8'));
const prior=await read(path.join(root,'result.json')),state=await read(prior.recovery.session),out=process.argv[3]??path.join(root,'current-contract-recheck');assert.ok(path.isAbsolute(out));await mkdir(out);
const baseline=await read(path.join(root,'baseline-run/run.json')),originalUrl=new URL(baseline.config.pages[0].url),projects={1:path.join(root,'baseline'),2:path.join(root,'candidate')};
const engine=new Liquid();engine.registerFilter('asset_url',s=>'/assets/'+s);
const server=http.createServer(async(req,res)=>{
  try{
    const u=new URL(req.url,originalUrl),id=u.searchParams.get('preview_theme_id')??new URL(req.headers.referer??u.href).searchParams.get('preview_theme_id')??'1';res.setHeader('Cache-Control','no-store');
    if(u.pathname==='/favicon.ico'){res.writeHead(204);res.end();return;}
    if(u.pathname.startsWith('/assets/')){res.setHeader('Content-Type','text/javascript');res.end(await readFile(path.join(projects[id],u.pathname.slice(1)),'utf8'));return;}
    const section='<div id="shopify-section-template--123__main"><div id="hero"><h1>Complete unchanged section content</h1><button id="open">Open details</button><p id="more" hidden>Full product detail</p></div></div>';
    if(u.searchParams.has('data')){
      const scoped=u.searchParams.has('section_id')||u.searchParams.has('sections');await new Promise(r=>setTimeout(r,scoped?60:900));res.setHeader('Content-Type',u.searchParams.has('sections')?'application/json':'text/html');
      res.end(u.searchParams.has('sections')?JSON.stringify({'template--123__main':section}):scoped?section:'<!doctype html><html><body>'+section+'<!--'+'unused page '.repeat(15000)+'--></body></html>');return;
    }
    res.setHeader('Content-Type','text/html');res.end('<!doctype html><html lang="en"><head><title>Bounded recovery fixture</title><meta name="viewport" content="width=device-width,initial-scale=1"><script>window.Shopify={theme:{id:'+id+'},shop:"fixture.myshopify.com"};</script><style>body{font-family:sans-serif}h1{font-size:54px}button{padding:12px}</style></head><body>'+await engine.parseAndRender(await readFile(path.join(projects[id],'sections/main.liquid'),'utf8'))+'</body></html>');
  }catch(error){res.writeHead(500);res.end(error.message);}
});
await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(Number(originalUrl.port),'127.0.0.1',resolve);});
const deployment=args=>verifyDeployment({...args,dependencies:{runProcess:async(_cmd,argv)=>{await cp(args.config.project,argv[argv.indexOf('--path')+1],{recursive:true});return{code:0};}}});
const hiddenSteps=[{action:'click',selector:'#filters > summary'},{action:'assert-visible',selector:'#filter-body',visible:true},{action:'assert-count',selector:'#filter-body > p',count:320},{action:'checkpoint',selector:'#filter-body',key:'first-open'},
 {action:'click',selector:'#filters > summary'},{action:'assert-visible',selector:'#filter-body',visible:false},{action:'press',selector:'#filters > summary',key:'Enter'},{action:'assert-visible',selector:'#filter-body',visible:true},{action:'assert-count',selector:'#filter-body > p',count:320},{action:'checkpoint',selector:'#filter-body',key:'reopened'}];
const sectionSteps=[{action:'assert-text',selector:'#hero h1',text:'Complete unchanged section content'},{action:'click',selector:'#open'},{action:'assert-visible',selector:'#more',visible:true},{action:'checkpoint',selector:'#hero',key:'ready'}];
const result={scope:'artificial-local-fixture-only',newLighthouseSamples:0,retainedRawMeasurements:true,results:[]};
const verifiedHistory=[];
try{
 for(const h of state.history){
  const plan=await read(path.join(h.experiment,'plan.json')),diagnosis=await read(path.join(h.experiment,'diagnosis.json')),dir=path.join(out,h.method);await mkdir(dir);
  await applySitePlan(plan,projects[2]);
  try{
   const captures={};
   for(const [side,id] of [['before',1],['after',2]]){
    const u=new URL(originalUrl);u.searchParams.set('preview_theme_id',String(id));const url=u.href,config={project:projects[id],store:'fixture.myshopify.com',themeId:String(id)},pages=[{id:'regression',url}];
    const before=await deployment({config,pages});
    const scenarios=await runScenarios({config:{schemaVersion:1,project:projects[id],url,expectedThemeId:String(id),settleMs:1100,viewports:[{name:'mobile',width:390,height:844}],scenarios:[{name:'content',steps:h.method==='hidden-detach'?hiddenSteps:sectionSteps}]},output:path.join(dir,side)});
    const after=await deployment({config,pages});scenarios.domainProof={before,after};captures[side]=scenarios;await writeFile(path.join(dir,side+'.json'),JSON.stringify(scenarios,null,2));assert.equal(scenarios.outcome,'passed');
   }
   const v=await verifyPatchExperiment({plan,diagnosis,candidateId:h.candidateId,before:path.join(h.experiment,'before'),after:path.join(h.experiment,'after'),regressionBefore:captures.before,regressionAfter:captures.after,goal:state.goal});
   await writeFile(path.join(dir,'verification.json'),JSON.stringify(v,null,2));assert.notEqual(v.outcome,'invalid-evidence',v.error);assert.equal(v.outcome,h.outcome);
   verifiedHistory.push({...h,verification:v});
   result.results.push({method:h.method,outcome:v.outcome,preservation:v.preservation.outcome,checks:v.checks,gain:v.gain,evidence:dir});
  }finally{await rollbackSitePlan(plan,projects[2]);}
 }
 const recovery=await diagnoseRecovery({project:state.project,run:state.baselineRun,...state.inputs,goal:state.goal,history:verifiedHistory,preparationFailures:state.preparationFailures??[]});
 await writeFile(path.join(out,'recovery.json'),JSON.stringify(recovery,null,2));result.nextDomainStep=recovery.nextDomainStep;
 assert.equal(result.nextDomainStep,null,'Current recovery must not retry old templates or the alternate section format.');
 for(const c of recovery.candidates.filter(c=>c.tested.length)){
  assert.equal(c.reassessment.costEvidence.status,'verified');
  const h=structuredClone(verifiedHistory.find(h=>h.candidateId===c.candidateId));h.verification.gain.evidence.afterReportsHash='0'.repeat(64);
  assert.equal((await readExperimentCost(h,c)).status,'unavailable');
 }
 result.rawHashTamperRejected=true;
 result.status='verified-negative-results';await writeFile(path.join(out,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({out,status:result.status,results:result.results.map(r=>({method:r.method,outcome:r.outcome,preservation:r.preservation})),next:result.nextDomainStep}));
}finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
