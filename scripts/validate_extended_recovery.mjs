#!/usr/bin/env node
// Bounded causal ablations + actual recovery session. Local artificial theme, never merchant evidence.
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import {mkdtemp,mkdir,readFile,writeFile,cp} from 'node:fs/promises';
import {parseArgs} from 'node:util';
import {Liquid} from 'liquidjs';
import {hiddenRuntime,hiddenDetachRuntime} from '../lib/extended-runtime.mjs';
import {measureSite} from '../lib/measure.mjs';
import {readRunEvidence} from '../lib/run-evidence.mjs';
import {median} from '../lib/summary.mjs';
import {profileDomain} from '../lib/domain-profile.mjs';
import {verifyDeployment} from '../lib/deployment.mjs';
import {runPatchExperiment} from '../lib/patch-experiment.mjs';
import {runImprovement} from '../lib/improvement-session.mjs';
import {extendedContracts} from '../lib/extended-methods.mjs';
const {values}=parseArgs({options:{mode:{type:'string',default:'all'}}});
assert.ok(['all','ablation','recovery'].includes(values.mode));
const root=await mkdtemp('/private/tmp/perfkit-extended-review-'),projects={1:path.join(root,'baseline'),2:path.join(root,'candidate')};
const inner=Array.from({length:320},(_,i)=>`<p>Option ${i}</p>`).join('');
const detail=content=>`<details id="filters"><summary>Filters</summary><div id="filter-body">${content}</div></details>`;
const hidden=detail(inner),legacyJs=`(${hiddenRuntime.toString()})("filters","filter-body",false,"fixture-hidden");`;
const parked=`${hidden}<script>(${hiddenDetachRuntime.toString()})("filters","filter-body","fixture-detach");</script>`;
const variants={baseline:hidden,'duplicate-only':detail(`<template data-perfkit-content>${inner}</template><noscript>${inner}</noscript>`),
  'runtime-only':hidden+'<script src="/legacy.js" defer></script>',legacy:detail(`<template data-perfkit-content>${inner}</template><noscript>${inner}</noscript>`)+ '<script src="/legacy.js" defer></script>',detach:parked};
const source=hidden+'<div id="shopify-section-template--123__main"><div id="hero"></div></div><script src="/assets/main.js" defer></script>';
const loader='async function load(){const html=await (await fetch(location.pathname+location.search+"&data=1")).text();document.querySelector("#hero").innerHTML=new DOMParser().parseFromString(html,"text/html").querySelector("#hero").innerHTML;}document.addEventListener("click",event=>{if(event.target.id==="open")document.querySelector("#more").hidden=false;});load();';
await mkdir(path.join(projects[1],'sections'),{recursive:true});await mkdir(path.join(projects[1],'assets'));
await writeFile(path.join(projects[1],'sections/main.liquid'),source);await writeFile(path.join(projects[1],'assets/main.js'),loader);await cp(projects[1],projects[2],{recursive:true});
const engine=new Liquid();engine.registerFilter('asset_url',s=>'/assets/'+s);
const server=http.createServer(async(req,res)=>{
  try{
    const u=new URL(req.url,'http://fixture.test'),id=u.searchParams.get('preview_theme_id')??new URL(req.headers.referer??u.href).searchParams.get('preview_theme_id')??'1';
    res.setHeader('Cache-Control','no-store');
    if(u.pathname==='/favicon.ico'){res.writeHead(204);res.end();return;}
    if(u.pathname==='/legacy.js'){res.setHeader('Content-Type','text/javascript');res.end(legacyJs);return;}
    if(u.pathname.startsWith('/assets/')){res.setHeader('Content-Type','text/javascript');res.end(await readFile(path.join(projects[id],u.pathname.slice(1)),'utf8'));return;}
    const section='<div id="shopify-section-template--123__main"><div id="hero"><h1>Complete unchanged section content</h1><button id="open">Open details</button><p id="more" hidden>Full product detail</p></div></div>';
    if(u.searchParams.has('data')){
      const scoped=u.searchParams.has('section_id')||u.searchParams.has('sections');await new Promise(r=>setTimeout(r,scoped?60:900));
      res.setHeader('Content-Type',u.searchParams.has('sections')?'application/json':'text/html');res.end(u.searchParams.has('sections')?JSON.stringify({'template--123__main':section}):scoped?section:'<!doctype html><html><body>'+section+'<!--'+'unused page '.repeat(15000)+'--></body></html>');return;
    }
    const content=u.pathname==='/ablation'?variants[u.searchParams.get('variant')]:await engine.parseAndRender(await readFile(path.join(projects[id],'sections/main.liquid'),'utf8'));
    res.setHeader('Content-Type','text/html');res.end('<!doctype html><html lang="en"><head><title>Bounded recovery fixture</title><meta name="viewport" content="width=device-width,initial-scale=1"><script>window.Shopify={theme:{id:'+id+'},shop:"fixture.myshopify.com"};</script><style>body{font-family:sans-serif}h1{font-size:54px}button{padding:12px}</style></head><body>'+content+'</body></html>');
  }catch(error){res.writeHead(500);res.end(error.message);}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${server.address().port}`;
const result={scope:'artificial-local-fixture-only',root,declaredBudget:{maxLighthouseSamples:30,maxRecoveryRounds:2},formalAcceptance:'not-evaluated',realShopifyServer:'not-measured'};
const save=()=>writeFile(path.join(root,'result.json'),JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify({root,mode:values.mode,budget:result.declaredBudget}));
const deployment=args=>verifyDeployment({...args,dependencies:{runProcess:async(_cmd,argv)=>{await cp(args.config.project,argv[argv.indexOf('--path')+1],{recursive:true});return{code:0};}}});
try{
  if(values.mode!=='recovery'){
    const output=path.join(root,'ablation'),measurement=await measureSite({config:{schemaVersion:1,engine:'lighthouse',purpose:'exploration',runs:3,devices:['mobile'],pages:Object.keys(variants).map(id=>({id,url:origin+'/ablation?variant='+id})),budget:{maxAttempts:15,maxFailures:2,maxWallTimeMs:600000}},output});
    assert.equal(measurement.status,'complete');const evidence=await readRunEvidence(output,{allowExploration:true});
    result.ablation=evidence.groups.map(g=>({variant:g.pageId,samples:g.records.length,metrics:Object.fromEntries(['first-contentful-paint','largest-contentful-paint','total-blocking-time','total-byte-weight'].map(key=>[key,median(g.records.map(r=>r.report.audits[key].numericValue))])),requests:g.records[0].report.audits['network-requests'].details.items.map(r=>({type:r.resourceType,resourceBytes:r.resourceSize,url:r.url})),evidence:output}));
    await save();console.log(JSON.stringify({ablation:result.ablation.map(({variant,metrics})=>({variant,metrics}))}));
  }
  if(values.mode!=='ablation'){
    const url=id=>origin+'/fr/collections/all?preview_theme_id='+id+'&sort_by=title-ascending';
    const decl=id=>({project:projects[id],store:'fixture.myshopify.com',themeId:String(id)});
    const measurement=id=>({schemaVersion:1,engine:'lighthouse',purpose:'exploration',runs:3,devices:['mobile'],pages:[{id:'home',url:url(id)}],deployment:decl(id)});
    const profile=await profileDomain({config:{schemaVersion:1,mode:'runtime',deployment:decl(1),url:url(1),profile:{device:'mobile',settleMs:1100}},output:path.join(root,'profile'),dependencies:{verifyDeployment:deployment}});
    const baseline=path.join(root,'baseline-run'),measured=await measureSite({config:measurement(1),output:baseline,dependencies:{verifyDeployment:deployment}});assert.equal(measured.status,'complete');
    let state,index=0;
    const step=async config=>{
      state=await runImprovement({config:{schemaVersion:1,...(state?{previous:path.join(state.output,'session.json')}:{}),...config},output:path.join(root,'step-'+index++),dependencies:{runPatchExperiment:args=>runPatchExperiment({...args,dependencies:{verifyDeployment:deployment}})}});
      console.log(JSON.stringify({action:config.action,status:state.status,next:state.nextDomainStep,error:state.error}));assert.equal(state.error,undefined,JSON.stringify(state.error));return state;
    };
    await step({action:'start',project:projects[2],run:baseline,profiles:[profile],goal:{kind:'loading',metric:'lcp'},budget:{maxCandidateRounds:2,maxAttempts:12,maxFailures:3,maxWallTimeMs:600000}});
    let recovery=JSON.parse(await readFile(state.recovery,'utf8'));
    const c=recovery.candidates.find(c=>c.kind==='hidden-dom');assert.ok(c);
    const review=method=>({summary:'Reviewed artificial fixture only; static disclosure and text-only section consumer',...Object.fromEntries(extendedContracts[method].review.map(k=>[k,true]))});
    const hiddenSteps=[{action:'click',selector:'#filters > summary'},{action:'assert-visible',selector:'#filter-body',visible:true},{action:'assert-count',selector:'#filter-body > p',count:320},{action:'checkpoint',selector:'#filter-body',key:'first-open'},{action:'click',selector:'#filters > summary'},{action:'assert-visible',selector:'#filter-body',visible:false},{action:'press',selector:'#filters > summary',key:'Enter'},{action:'assert-visible',selector:'#filter-body',visible:true},{action:'assert-count',selector:'#filter-body > p',count:320},{action:'checkpoint',selector:'#filter-body',key:'opened'}];
    const sectionSteps=[{action:'assert-text',selector:'#hero h1',text:'Complete unchanged section content'},{action:'click',selector:'#open'},{action:'assert-visible',selector:'#more',visible:true},{action:'checkpoint',selector:'#hero',key:'ready'}];
    const experiment=steps=>({schemaVersion:1,before:measurement(1),after:measurement(2),regressionBefore:{schemaVersion:1,url:url(1),settleMs:1100,viewports:[{name:'mobile',width:390,height:844}],scenarios:[{name:'content',steps}]},regressionAfter:{schemaVersion:1,url:url(2),settleMs:1100,viewports:[{name:'mobile',width:390,height:844}],scenarios:[{name:'content',steps}]}});
    await step({action:'prepare',candidateId:c.candidateId,method:'hidden-detach',rationale:'Negative control: removing hidden active DOM cannot remove the measured full-page request delay.',domain:{schemaVersion:1,review:review('hidden-detach')}});
    await step({action:'apply',reviewedPlanHash:state.active.planHash});await step({action:'experiment',experiment:experiment(hiddenSteps)});
    assert.equal(state.active,null);assert.notEqual(state.history[0].outcome,'invalid-evidence');assert.equal(await readFile(path.join(projects[2],'sections/main.liquid'),'utf8'),source);
    recovery=JSON.parse(await readFile(state.recovery,'utf8'));assert.equal(recovery.nextDomainStep.kind,'section-fetch');
    result.reassessment=recovery.candidates.find(x=>x.candidateId===c.candidateId).reassessment;await save();
    await step({action:'prepare',candidateId:'next',method:'next',rationale:'The DOM control did not remove the initial fetch delay. Request only the measured LCP section, retaining locale and sort parameters.',domain:{schemaVersion:1,sectionSelector:'#hero',review:review('section-fetch-single')}});
    assert.equal(state.active.method,'section-fetch-single');
    await step({action:'apply',reviewedPlanHash:state.active.planHash});await step({action:'experiment',experiment:experiment(sectionSteps)});
    result.recovery={status:state.status,history:state.history.map(h=>({method:h.method,outcome:h.outcome,experiment:h.experiment,gain:h.verification?.gain})),session:path.join(state.output,'session.json')};await save();
    assert.ok(['promising','no-measurable-gain','hypothesis-not-confirmed','performance-regressed'].includes(state.history.at(-1).outcome));
    result.acceptedExploration=state.status==='formal-validation-required';
    // A changed mechanism is not success by itself. Preserve negative results and the original gates.
  }
  result.status=result.acceptedExploration===false?'completed-no-accepted-patch':'completed';await save();console.log(JSON.stringify({status:result.status,root}));
}finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
