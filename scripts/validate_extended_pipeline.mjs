#!/usr/bin/env node
// Real Chrome/Lighthouse on isolated artificial fixtures. Shopify source-pull transport is mocked.
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import {mkdtemp,mkdir,writeFile,readFile,cp} from 'node:fs/promises';
import {Liquid} from 'liquidjs';
import {parseArgs} from 'node:util';
import {profileDomain} from '../lib/domain-profile.mjs';
import {verifyDeployment} from '../lib/deployment.mjs';
import {diagnoseUnified} from '../lib/decision-engine.mjs';
import {createDomainPlan} from '../lib/domain-plan.mjs';
import {applySitePlan,rollbackSitePlan} from '../lib/site-changes.mjs';
import {runPatchExperiment} from '../lib/patch-experiment.mjs';
import {extendedContracts} from '../lib/extended-methods.mjs';
const {values}=parseArgs({options:{kinds:{type:'string'}}});
const kinds=(values.kinds??'section-fetch,hidden-dom').split(',');
if(kinds.some(k=>!['section-fetch','hidden-dom'].includes(k))||new Set(kinds).size!==kinds.length)throw new Error('Choose distinct section-fetch,hidden-dom');
const root=await mkdtemp('/private/tmp/perfkit-extended-live-'),projects={},engine=new Liquid();let kind;
engine.registerFilter('asset_url',name=>'/assets/'+name);
const server=http.createServer(async(req,res)=>{
  try {
    const u=new URL(req.url,'http://fixture.test'),referer=new URL(req.headers.referer??u.href);
    const id=u.searchParams.get('preview_theme_id')??referer.searchParams.get('preview_theme_id')??'1';
    res.setHeader('Cache-Control','no-store');
    if(u.pathname.startsWith('/assets/')){res.setHeader('Content-Type','text/javascript');res.end(await readFile(path.join(projects[id],u.pathname.slice(1)),'utf8'));return;}
    if(u.pathname==='/favicon.ico'){res.writeHead(204);res.end();return;}
    if(u.searchParams.has('data')){
      const scoped=u.searchParams.has('section_id')||u.searchParams.has('sections');await new Promise(r=>setTimeout(r,scoped?60:900));
      const section='<div id="shopify-section-template--123__main"><div id="hero"><h1>Complete unchanged section content</h1><button id="open">Open details</button><p id="more" hidden>Full product detail</p></div></div>';
      if(u.searchParams.has('sections')){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({'template--123__main':section}));}
      else {res.setHeader('Content-Type','text/html');res.end(scoped?section:'<!doctype html><html><body>'+section+'<!--'+'unused page '.repeat(15000)+'--></body></html>');}return;
    }
    res.setHeader('Content-Type','text/html');res.end('<!doctype html><html lang="en"><head><title>Extended performance fixture</title><meta name="viewport" content="width=device-width,initial-scale=1"><script>window.Shopify={theme:{id:'+id+'},shop:"fixture.myshopify.com"};</script><style>body{font-family:sans-serif}h1{font-size:54px}button{padding:12px}</style></head><body>'+await engine.parseAndRender(await readFile(path.join(projects[id],'sections/main.liquid'),'utf8'))+'</body></html>');
  }catch(error){res.writeHead(500);res.end(error.message);}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${server.address().port}`;
const deployment=args=>verifyDeployment({...args,dependencies:{runProcess:async(_cmd,argv)=>{await cp(args.config.project,argv[argv.indexOf('--path')+1],{recursive:true});return{code:0};}}});
const result={kind:'extended-pipeline-validation',scope:'artificial-local-fixture-only',root,results:[],formalAcceptance:'not-evaluated',realTheme:'pending unpublished merchant preview; Liquid query server timing unmeasured'};
console.log(JSON.stringify({root,scope:result.scope}));
try {
  for(kind of kinds){
    const directory=path.join(root,kind);projects['1']=path.join(directory,'baseline');projects['2']=path.join(directory,'candidate');
    await mkdir(path.join(projects['1'],'sections'),{recursive:true});await mkdir(path.join(projects['1'],'assets'));
    const text=kind==='hidden-dom'?'<details id="filters"><summary>Filters</summary><div id="filter-body">'+Array.from({length:320},(_,i)=>`<p>Option ${i}</p>`).join('')+'</div></details>':'<div id="shopify-section-template--123__main"><div id="hero"></div></div><script src="/assets/main.js" defer></script>';
    await writeFile(path.join(projects['1'],'sections/main.liquid'),text);
    if(kind==='section-fetch')await writeFile(path.join(projects['1'],'assets/main.js'),'async function load(){const url=location.pathname+location.search+"&data=1";const html=await (await fetch(url)).text();document.querySelector("#hero").innerHTML=new DOMParser().parseFromString(html,"text/html").querySelector("#hero").innerHTML;}document.addEventListener("click",event=>{if(event.target.id==="open")document.querySelector("#more").hidden=false;});load();');
    await cp(projects['1'],projects['2'],{recursive:true});
    const decl=id=>({project:projects[id],store:'fixture.myshopify.com',themeId:id}),url=id=>`${origin}/fr/collections/all?preview_theme_id=${id}&sort_by=title-ascending`;
    const profile=await profileDomain({config:{schemaVersion:1,mode:'runtime',deployment:decl('1'),url:url('1'),profile:{device:'mobile',settleMs:1100}},output:path.join(directory,'profile'),dependencies:{verifyDeployment:deployment}});
    const goal={kind:'loading',metric:kind==='section-fetch'?'lcp':'tbt'},diagnosis=await diagnoseUnified({project:projects['2'],profiles:[profile],goal,limit:20}),c=diagnosis.candidates.find(c=>c.kind===kind);assert.ok(c);
    const steps=kind==='section-fetch'?[{action:'assert-text',selector:'#hero h1',text:'Complete unchanged section content'},{action:'click',selector:'#open'},{action:'assert-visible',selector:'#more',visible:true},{action:'checkpoint',selector:'#hero',key:'ready'}]:[
      {action:'click',selector:'#filters > summary'},{action:'assert-visible',selector:'#filter-body',visible:true},{action:'assert-count',selector:'#filter-body > p',count:320},{action:'checkpoint',selector:'#filter-body',key:'first-open'},{action:'click',selector:'#filters > summary'},{action:'assert-visible',selector:'#filter-body',visible:false},{action:'press',selector:'#filters > summary',key:'Enter'},{action:'assert-visible',selector:'#filter-body',visible:true},{action:'assert-count',selector:'#filter-body > p',count:320},{action:'checkpoint',selector:'#filter-body',key:'opened'}];
    const history=[];
    for(const method of c.methods){
      const review={summary:'Reviewed artificial fixture; no store performance claim',...Object.fromEntries(extendedContracts[method].review.map(k=>[k,true]))};
      const plan=await createDomainPlan({project:projects['2'],diagnosis,config:{schemaVersion:1,candidateId:c.candidateId,method,review,...(kind==='hidden-dom'?{newAsset:'assets/hidden.js'}:{sectionSelector:'#hero'})}});
      await applySitePlan(plan,projects['2']);
      const measurement=id=>({schemaVersion:1,engine:'lighthouse',devices:['mobile'],pages:[{id:'home',url:url(id)}],deployment:decl(id)});
      const regression=id=>({schemaVersion:1,url:url(id),settleMs:1100,viewports:[{name:'mobile',width:390,height:844}],scenarios:[{name:kind,steps}]});
      const experiment=await runPatchExperiment({config:{schemaVersion:1,plan,diagnosis,candidateId:c.candidateId,goal,runs:3,history,before:measurement('1'),after:measurement('2'),regressionBefore:regression('1'),regressionAfter:regression('2'),budget:{maxWallTimeMs:600000,maxAttempts:6,maxFailures:2}},output:path.join(directory,method),dependencies:{verifyDeployment:deployment}});
      await rollbackSitePlan(plan,projects['2']);assert.equal(await readFile(path.join(projects['2'],'sections/main.liquid'),'utf8'),text);
      const record={kind,method,outcome:experiment.status,error:experiment.error??experiment.verification?.error,gain:experiment.verification?.gain,counts:experiment.counts,rolledBack:true,output:experiment.output};result.results.push(record);
      await writeFile(path.join(root,'result.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({...record,gain:undefined}));
      assert.ok(['promising','no-measurable-gain','hypothesis-not-confirmed','performance-regressed'].includes(experiment.status),'Complete actual evidence must preserve behavior: '+JSON.stringify(record));
      if(experiment.status==='promising')break;
      history.push(experiment.verification);
    }
  }
  result.status='completed';await writeFile(path.join(root,'result.json'),JSON.stringify(result,null,2)+'\n');
}finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
