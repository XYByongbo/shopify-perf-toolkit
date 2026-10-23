import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,cp} from 'node:fs/promises';
import path from 'node:path';
import {Liquid} from 'liquidjs';
import {sourceSnapshot,sha256} from '../lib/runtime-profile.mjs';
import {domainCandidates} from '../lib/domain-candidates.mjs';
import {createDomainPlan} from '../lib/domain-plan.mjs';
import {createOfficialPlan} from '../lib/official-plan.mjs';
import {queryPatch,queryTargets,hiddenTargets,fetchTargets,extendedContracts,sectionResponseEvidence} from '../lib/extended-methods.mjs';
import {applySitePlan,rollbackSitePlan} from '../lib/site-changes.mjs';
import {checkExtendedBehavior,checkExtendedPlan} from '../lib/optimization-regression.mjs';
import {remainingDomainMethods,hypothesisKey,reassessCandidate,methodMechanism,diagnoseRecovery} from '../lib/recovery.mjs';
import {verifyLiquidGain} from '../lib/liquid-experiment.mjs';
import {controller as liquidController,renderTag} from './fixtures/section-liquid/theme.mjs';
import {evaluateGain} from '../lib/performance-gain.mjs';
const url='https://fixture.myshopify.com/collections/all?preview_theme_id=1';
async function fixture(t,text,file='sections/main.liquid',extraFiles={}){
  const root=await mkdtemp('/private/tmp/perfkit-extended-');t.after(()=>rm(root,{recursive:true,force:true}));await mkdir(path.join(root,'assets'),{recursive:true});await mkdir(path.dirname(path.join(root,file)),{recursive:true});await writeFile(path.join(root,file),text);
  for(const [name,body] of Object.entries(extraFiles)){await mkdir(path.dirname(path.join(root,name)),{recursive:true});await writeFile(path.join(root,name),body);}
  const snapshot=await sourceSnapshot(root),time=n=>new Date(Date.UTC(2026,9,23,0,0,n)).toISOString();
  const proof={kind:'deployment-proof',status:'verified',scope:'theme-text-source',method:'shopify-cli-source-pull-and-browser-theme-id',project:root,sourceHash:snapshot.hash,remoteSourceHash:snapshot.hash,sourceManifest:snapshot.files,store:'fixture.myshopify.com',themeId:'1',pages:[{id:'target',url,status:'verified',store:'fixture.myshopify.com',themeId:'1'}]};
  const bind=p=>({...p,project:root,createdAt:time(2),finishedAt:time(3),domainProof:{version:1,url,startedAt:time(2),finishedAt:time(3),before:{...proof,startedAt:time(0),finishedAt:time(1)},after:{...proof,startedAt:time(4),finishedAt:time(5)}}});
  const runtime=bind({kind:'runtime-profile',status:'complete',sourceStable:true,snapshot,themeId:'1',finalUrl:url,config:{url,device:'mobile',state:'initial',actions:[]},domainTargets:[],resources:[],initial:{}});
  const liquid=line=>{const rawProfile={shared:{frames:[{name:file+':'+line}]},profiles:[{name:'Liquid',type:'sampled',unit:'milliseconds',startValue:0,endValue:30,samples:[[0]],weights:[30]}]};return bind({kind:'liquid-profile',status:'complete',sourceSnapshot:snapshot,rawProfile,evidence:{origin:'shopify-cli',rawProfileHash:sha256(JSON.stringify(rawProfile)),collector:{kind:'shopify-cli',version:'4.9.4'},store:'fixture.myshopify.com',themeId:'1',urlPath:new URL(url).pathname+new URL(url).search}});};
  const diagnose=lp=>({kind:'bottleneck-diagnosis',sourceHash:snapshot.hash,candidates:domainCandidates({files:[{file,text}],snapshot,profiles:[runtime],liquidProfile:lp})});
  return {root,snapshot,runtime,liquid,diagnose,file,text};
}
const review=method=>({summary:'Synthetic reviewed fixture; no store performance claim',...Object.fromEntries(extendedContracts[method].review.map(k=>[k,true]))});
const make=(f,d,c,method,extra={})=>createDomainPlan({project:f.root,diagnosis:d,config:{schemaVersion:1,candidateId:c.candidateId,method,review:review(method),...extra}});

test('formal Liquid no-gain restores both files, diagnoses actual formal reports, and prepares a different controller mechanism',async t=>{
  // Synthetic measurement decisions, real generators, source checks, rollback and recovery.
  const section='<div id="hero"></div><script src="{{ \'main.js\' | asset_url }}" defer></script>';
  const f=await fixture(t,liquidController,'assets/main.js',{'sections/main.liquid':section,'sections/ajax-main.liquid':renderTag,'snippets/catalog-content.liquid':'<h1>{{ section.settings.heading | escape }}</h1>'});
  const requestUrl=url+'&view=ajax';
  f.runtime.resources=[{type:'Fetch',method:'GET',phase:'initial',status:200,mimeType:'text/html',url:requestUrl,timestamp:1,finishedTimestamp:1.9,initiatorSources:[{status:'verified-bytes',file:f.file,sourceHash:sha256(f.text),offset:f.text.indexOf('fetch(')}]}];
  f.runtime.sections=[{id:'shopify-section-main',idCount:1,containsLCP:true,selectors:['#hero']}];
  f.runtime.initial.delivery={securityPolicy:{complete:true,headers:[],meta:[]}};
  const baseline=await siteRun(t,{devices:['mobile'],pages:[{id:'home',url}],scores:{mobile:[60]},augment:r=>{r.audits['largest-contentful-paint'].numericValue=2500;}});
  const bind=async(run,snapshot)=>{
    const p={...f.runtime.domainProof.before,sourceHash:snapshot.hash,remoteSourceHash:snapshot.hash,sourceManifest:snapshot.files,pages:[{id:'home',url,status:'verified',store:'fixture.myshopify.com',themeId:'1'}]};
    Object.assign(run.manifest,{startedAt:'2026-10-15T00:00:00Z',finishedAt:'2026-10-24T00:00:00Z',deployment:{before:{...p,startedAt:'2026-10-15T00:00:01Z',finishedAt:'2026-10-15T00:00:02Z'},after:{...p,startedAt:'2026-10-24T00:00:00Z',finishedAt:'2026-10-24T00:00:00Z'}}});
    run.manifest.config.deployment={project:f.root,store:p.store,themeId:'1'};await saveManifest(run);
  };
  await bind(baseline,f.snapshot);
  const out=await mkdtemp('/private/tmp/perfkit-liquid-formal-recovery-');t.after(()=>rm(out,{recursive:true,force:true}));let state,index=0,after;
  const step=async config=>state=await runImprovement({config:{schemaVersion:1,...(state?{previous:path.join(state.output,'session.json')}:{project:f.root,run:baseline.root,profiles:[f.runtime],goal:{kind:'loading',metric:'lcp'},budget:{maxCandidateRounds:3,maxFailures:5,maxAttempts:20}}),...config},output:path.join(out,String(index++)),dependencies:{
    runPatchExperiment:async({config,output})=>{
      await mkdir(output);after=await siteRun(t,{offset:400,devices:['mobile'],pages:[{id:'home',url}],scores:{mobile:[60]},augment:r=>{r.audits['largest-contentful-paint'].numericValue=2450;}});await bind(after,await sourceSnapshot(f.root));
      await writeFile(path.join(output,'patch-evidence.json'),JSON.stringify({before:baseline.root,after:after.root,goal:config.goal}));
      return {output,status:'promising',verification:{outcome:'promising'},counts:{attempted:6,failed:0}};
    },
    verifyOptimization:async input=>({outcome:'not-accepted',scoreTargets:{outcome:'targets-not-met',checks:[]},gain:await evaluateGain({before:input.before,after:input.after,goal:input.goal}),checks:[{id:'declared-goal-gain-no-metric-regression',pass:false}]}),
  }});
  await step({action:'start'});assert.equal(state.error,undefined);
  const recovery=JSON.parse(await readFile(state.recovery)),c=recovery.candidates.find(c=>c.kind==='section-fetch');assert.ok(c);
  const initialLiquid={targetFile:'sections/main.liquid',sourceFile:'sections/ajax-main.liquid',renderOffset:0,startupFunction:'load',legacyView:'ajax',update:{triggerSelector:'#refresh',assertionSelector:'#first-title',requestUrl}};
  await step({action:'prepare',candidateId:c.candidateId,method:'section-liquid-initial',rationale:'Remove initial content waterfall',domain:{schemaVersion:1,sectionSelector:'#hero',initialLiquid,review:review('section-liquid-initial')}});assert.equal(state.error,undefined,JSON.stringify(state.error));
  const first=JSON.parse(await readFile(state.active.plan));
  await step({action:'apply',reviewedPlanHash:state.active.planHash});await step({action:'experiment',experiment:{schemaVersion:1,before:{schemaVersion:1,engine:'lighthouse',devices:['mobile'],pages:[{id:'home',url}],deployment:{project:f.root,store:'fixture.myshopify.com',themeId:'1'}},after:{schemaVersion:1,engine:'lighthouse',devices:['mobile'],pages:[{id:'home',url}],deployment:{project:f.root,store:'fixture.myshopify.com',themeId:'2'}}}});
  assert.equal(state.status,'formal-validation-required');
  await step({action:'verify',verification:{after:after.root}});assert.equal(state.error,undefined,JSON.stringify(state.error));
  assert.equal(state.active,null);assert.equal(state.history.at(-1).outcome,'formal-rejected');assert.equal(state.history.at(-1).verification.gain.outcome,'no-measurable-gain');
  assert.equal(await readFile(path.join(f.root,'assets/main.js'),'utf8'),liquidController);assert.equal(await readFile(path.join(f.root,'sections/main.liquid'),'utf8'),section);
  const rediagnosis=JSON.parse(await readFile(state.recovery));assert.equal(rediagnosis.nextDomainStep.method,'section-liquid-inline');
  assert.equal(rediagnosis.candidates.find(x=>x.kind==='section-fetch').reassessment.costEvidence.status,'verified');
  const oldHistory=structuredClone(state.history),old=oldHistory.at(-1);old.verification=old.verificationFile;delete old.formalEvidence;delete old.experiment;
  const resumed=await diagnoseRecovery({project:f.root,run:baseline.root,profiles:[f.runtime],goal:{kind:'loading',metric:'lcp'},history:oldHistory});
  assert.equal(resumed.candidates.find(x=>x.kind==='section-fetch').reassessment.costEvidence.status,'verified',JSON.stringify(resumed.candidates.find(x=>x.kind==='section-fetch').reassessment.costEvidence));
  assert.equal(state.counts.failed,1);assert.equal(state.counts.rounds,1);assert.equal(state.counts.attempted,6);
  await step({action:'prepare',candidateId:c.candidateId,method:'section-liquid-initial',rationale:'Unchanged retry',domain:{schemaVersion:1,sectionSelector:'#hero',initialLiquid,review:review('section-liquid-initial')}});assert.equal(state.error.code,'NO_UNTESTED_DOMAIN_METHOD');
  await step({action:'prepare',candidateId:'next',method:'next',rationale:'Remove the remaining isolated external controller request',domain:{schemaVersion:1,sectionSelector:'#hero',initialLiquid,review:review('section-liquid-inline')}});assert.equal(state.error,undefined,JSON.stringify(state.error));
  const second=JSON.parse(await readFile(state.active.plan));assert.equal(state.active.method,'section-liquid-inline');assert.notEqual(first.planHash,second.planHash);assert.match(second.changes.find(c=>c.target==='sections/main.liquid').after,/sectionControllerRuntime/);assert.equal(state.history.at(-1).outcome,'formal-rejected');
});

test('query limit locates measured loop and preserves output for empty/short/long product collections',async t=>{
  const text='{%- for p in collection.products -%}{%- if forloop.index <= 4 -%}<b>{{ p.title }}</b>{%- endif -%}{%- endfor -%}',f=await fixture(t,text),d=f.diagnose(f.liquid(1)),c=d.candidates.find(c=>c.kind==='liquid-query');assert.ok(c);
  const p=await make(f,d,c,'query-limit'),engine=new Liquid();assert.match(p.changes[0].after,/limit: 4/);
  for(const count of [0,2,4,60]){const data={collection:{products:Array.from({length:count},(_,i)=>({title:String(i)}))}};assert.equal(await engine.parseAndRender(text,data),await engine.parseAndRender(p.changes[0].after,data));}
  await applySitePlan(p,f.root);await rollbackSitePlan(p,f.root);assert.equal(await readFile(path.join(f.root,f.file),'utf8'),text);
  assert.equal(verifyLiquidGain({hypothesis:c}).outcome,'invalid-evidence');
  const bad=structuredClone(d);bad.candidates[0].binding.offset++;await assert.rejects(make(f,bad,bad.candidates[0],'query-limit'));
});

test('paginate converts an existing manual offset algorithm without changing its visible pages',async t=>{
  const text='{% assign skip = current_page | minus: 1 | times: 4 %}\n{% for a in blog.articles limit: 4 offset: skip %}<p>{{ a.title }}</p>{% endfor %}',f=await fixture(t,text),d=f.diagnose(f.liquid(2)),c=d.candidates.find(c=>c.kind==='liquid-query');assert.ok(c);
  const config={schemaVersion:1,candidateId:c.candidateId,methodId:'limit-product-queries-with-pagination',executor:'domain:query-paginate',review:{...review('query-paginate'),sourceHash:c.source.sourceHash}};
  const p=await createOfficialPlan({project:f.root,diagnosis:d,config});assert.match(p.changes[0].after,/paginate blog.articles by 4/);assert.doesNotMatch(p.changes[0].after,/offset: skip/);
  assert.deepEqual(p.changes[0].evidence.paginationPagesRequired,[1,2]);assert.equal(checkExtendedPlan(p,c),true);const downgraded=structuredClone(p);downgraded.changes[0].evidence.paginationPagesRequired=[];assert.equal(checkExtendedPlan(downgraded,c),false);
  // Model documented paginate slicing locally; this tests emitted HTML, not Shopify database timing.
  const engine=new Liquid(),all=Array.from({length:11},(_,i)=>({title:String(i)}));
  for(const page of [1,2,3,4]){
    const before=await engine.parseAndRender(text,{current_page:page,blog:{articles:all}});
    const after=await engine.parseAndRender(p.changes[0].after.replace(/\{%-?\s*(?:paginate\b[^%]*|endpaginate\s*)-?%\}/g,''),{current_page:page,blog:{articles:all.slice((page-1)*4,page*4)}});
    assert.equal(after,before);
  }
  const pages={runs:[1,2].map(page=>({url:url+'&page='+page,steps:[{action:'checkpoint',selector:'body',outcome:'passed',observation:{content:[{},{}]}}]}))};
  // Include the exact hypothesis page and an independent page-2 checkpoint.
  pages.runs[0].url=url;assert.equal(checkExtendedBehavior(p,pages),true);
  pages.runs[1].steps[0].selector='header';assert.equal(checkExtendedBehavior(p,pages),false);pages.runs[1].steps[0].selector='body';
  pages.runs[0].viewport={name:'mobile'};pages.runs[1].viewport={name:'desktop'};assert.equal(checkExtendedBehavior(p,pages),false);
  pages.runs[1].viewport={name:'mobile'};assert.equal(checkExtendedBehavior(p,pages),true);
  pages.runs.pop();assert.equal(checkExtendedBehavior(p,pages),false);
});

test('queries reject fixed carousels, existing paginate, dynamic caps and metadata-dependent rewrites',()=>{
  for(const source of [
    '{% for a in blog.articles limit: 4 %}{{ a.title }}{% endfor %}',
    '{%- for p in collection.products -%}{%- if forloop.index <= 4 -%}{{ forloop.length }}{%- endif -%}{%- endfor -%}',
    '{% paginate collection.products by 50 %}{%- for p in collection.products -%}{%- if forloop.index <= 4 -%}{{ p.title }}{%- endif -%}{%- endfor -%}{% endpaginate %}',
    '{% assign skip = current_page | minus: 1 | times: 4 %}{% for a in blog.articles limit: 4 offset: skip %}{{ forloop.length }}{% endfor %}',
  ])assert.deepEqual(queryTargets(source),[]);
});

const detail='<details id="filters"><summary>Filters</summary><div id="filter-body">'+Array.from({length:250},(_,i)=>`<p>Option ${i}</p>`).join('')+'</div></details>';
test('reassessment uses measured regressions, excludes equivalent mechanisms and stops impossible targets',()=>{
  const c={file:'sections/main.liquid',line:1,kind:'hidden-dom',metric:'tbt',page:url,device:'mobile',methods:['hidden-template','hidden-template-chunked','hidden-detach']};
  const history=[{baselineHash:'base',hypothesisKey:hypothesisKey(c),method:'hidden-template',outcome:'performance-regressed',experiment:'/evidence/experiment',verification:{gain:{groups:[{device:'mobile',metrics:{tbt:{before:{median:100}},fcp:{before:{median:620},after:{median:763},gain:-143,floor:100,regressed:true}}}]}}}];
  let r=reassessCandidate(c,'base',history);assert.deepEqual(r.remainingMethods,['hidden-detach']);assert.equal(r.reassessment.regressions[0].metric,'fcp');assert.match(r.reassessment.changedAssumption,/extra script request/);
  history[0].verification.gain.groups[0].metrics.tbt.before.median=0;
  r=reassessCandidate(c,'base',history);assert.deepEqual(r.remainingMethods,[]);assert.equal(r.gainCeiling.blocked,true);
  assert.deepEqual(remainingDomainMethods(c,'base',[{...history[0],outcome:'invalid-evidence'}]),['hidden-detach']);
  const section={...c,kind:'section-fetch',methods:['section-fetch-single','section-fetch-json']};
  assert.deepEqual(remainingDomainMethods(section,'base',[{...history[0],hypothesisKey:hypothesisKey(section),method:'section-fetch-single'}]),[]);
});
test('hidden DOM generates single-copy parking and legacy templates with reversible patches',async t=>{
  const f=await fixture(t,detail);f.runtime.domainTargets=[{id:'filters',idCount:1,tag:'DETAILS',open:false,bodyId:'filter-body',descendants:252,unsafeContent:false}];const d=f.diagnose(),c=d.candidates.find(c=>c.kind==='hidden-dom');assert.ok(c);
  const plans=[];for(const method of c.methods){const p=await make(f,d,c,method,{newAsset:'assets/hidden.js'});plans.push(p);if(method==='hidden-detach'){assert.equal(p.changes.length,1);assert.doesNotMatch(p.changes[0].after,/<template|<noscript|asset_url/);assert.equal(p.changes[0].after.split('Option 249').length,2);}else{assert.equal(p.changes.length,2);assert.match(p.changes[0].after,/<template data-perfkit-content>/);assert.match(p.changes[0].after,/<noscript>/);}await applySitePlan(p,f.root);await rollbackSitePlan(p,f.root);await assert.rejects(readFile(path.join(f.root,'assets/hidden.js')),{code:'ENOENT'});}
  assert.notEqual(plans[0].planHash,plans[1].planHash);
  const history=[{baselineHash:f.snapshot.hash,hypothesisKey:hypothesisKey(c),method:'hidden-template',outcome:'no-measurable-gain'}];assert.deepEqual(remainingDomainMethods(c,f.snapshot.hash,history),['hidden-detach']);
  await assert.rejects(make(f,d,c,'hidden-template',{newAsset:'assets/hidden.js',review:{summary:'Missing lifecycle'}}),{code:'REVIEW_REQUIRED'});
  assert.equal(checkExtendedBehavior(plans[0],{runs:[{url,steps:[{action:'click',selector:'#unrelated',outcome:'passed'}]}]}),false);
});
test('hidden DOM refuses scripts, custom elements, existing templates and default-open details',()=>{
  for(const body of ['<script>run()</script>','<x-widget></x-widget>','<template>content</template>','{% render "widget" %}','{% raw %}<script>unsafe()</script>{% endraw %}','{{ product.description }}','{% echo product.description %}',"<p title='</noscript>'>Text</p>"])assert.deepEqual(hiddenTargets('<details id="a"><summary>Open</summary><div id="b">'+body+'</div></details>'),[]);
  assert.deepEqual(hiddenTargets(detail.replace('<details','<details open')),[]);
  assert.equal(hiddenTargets('<details id="a"><summary>Open</summary><div id="b">{% for p in collection.products %}<p>{{ p.title | escape }}</p>{% endfor %}</div></details>').length,1);
});

test('section API binds a measured native fetch call and real section selectors, not a filename',async t=>{
  const text='async function load(){const html=await (await fetch(location.href)).text();document.querySelector("#hero").innerHTML=new DOMParser().parseFromString(html,"text/html").querySelector("#hero").innerHTML;}\nload();',f=await fixture(t,text,'assets/main.js'),offset=text.indexOf('fetch(');
  f.runtime.resources=[{type:'Fetch',method:'GET',phase:'initial',status:200,mimeType:'text/html',url,timestamp:1,finishedTimestamp:1.5,initiatorSources:[{status:'verified-bytes',file:f.file,sourceHash:sha256(text),offset}]}];
  f.runtime.sections=[{id:'shopify-section-template--123__hero',idCount:1,containsLCP:true,selectors:['#hero']}];
  const d=f.diagnose(),c=d.candidates.find(c=>c.kind==='section-fetch');assert.ok(c);
  for(const method of c.methods){const p=await make(f,d,c,method,{sectionSelector:'#hero'});assert.match(p.changes[0].after,/section_id/);assert.match(p.changes[0].after,/return original\(\)/);await applySitePlan(p,f.root);await rollbackSitePlan(p,f.root);}
  await assert.rejects(make(f,d,c,'section-fetch-single',{sectionSelector:'#shopify-section-main'}),{code:'UNSUPPORTED_CODE_PATTERN'});
  f.runtime.resources[0].initiatorSources[0].offset=text.indexOf('load();');assert.equal(f.diagnose().candidates.length,0);
  for(const source of ['function f(fetch){return fetch(url)}','const {fetch}=thing;fetch(url);','fetch(url,{method:"POST"})','fetch(url).json(); const alias=fetch;'])assert.deepEqual(fetchTargets(source),[]);
});

test('method-specific gates reject unchanged disclosure state and Section API fallback masquerading as gain',()=>{
  const h={changes:[{evidence:{domainKind:'hidden-dom',domainPage:url,hiddenContract:{summarySelector:'#a > summary',bodySelector:'#b'}}}]};
  const steps=[true,false,true].flatMap((visible,i)=>[{action:i===2?'press':'click',key:'Enter',selector:'#a > summary',outcome:'passed',assertionBefore:{action:'assert-visible',selector:'#b',actual:!visible,expected:visible}},{action:'assert-visible',selector:'#b',visible,outcome:'passed',observation:{actual:visible}}]);
  steps.splice(2,0,{action:'checkpoint',selector:'#b',outcome:'passed',observation:{content:[{},{}]}});steps.push({action:'checkpoint',selector:'#b',outcome:'passed',observation:{content:[{},{}]}});const s={runs:[{url,steps}]};assert.equal(checkExtendedBehavior(h,s),true);steps[0].assertionBefore.actual=true;assert.equal(checkExtendedBehavior(h,s),false);
  const p={changes:[{evidence:{domainKind:'section-fetch',domainPage:url,sectionFetchContract:{sectionSelector:'#hero',requestUrl:url}}}]};
  const r={url,steps:[{action:'checkpoint',selector:'#hero',outcome:'passed'}],sectionScopes:[{id:'shopify-section-template--456__main',selectors:['#hero']}],fetchResources:[{url:url+'&sections=template--456__main',sectionResponse:{id:'template--456__main',valid:true},status:200,finished:true,bodyHash:'a'.repeat(64)}]};
  assert.equal(checkExtendedBehavior(p,{runs:[r]},{candidate:true}),true);r.fetchResources.push({...r.fetchResources[0],url});assert.equal(checkExtendedBehavior(p,{runs:[r]},{candidate:true}),false);
  r.fetchResources.shift();assert.equal(checkExtendedBehavior(p,{runs:[r]}),true);
});

import {runImprovement} from '../lib/improvement-session.mjs';
import {siteRun,saveManifest} from './helpers/site-run.mjs';
for(const kind of ['hidden-dom','section-fetch','liquid-query'])test(`session ${kind}: no gain rolls back, changes actual generated method and exhausts without repetition`,async t=>{
  const js='async function load(){const html=await (await fetch(location.href)).text();document.querySelector("#hero").innerHTML=new DOMParser().parseFromString(html,"text/html").querySelector("#hero").innerHTML;}load();';
  const text=kind==='hidden-dom'?detail:kind==='section-fetch'?js:'{%- for p in collection.products -%}{%- if forloop.index <= 4 -%}<b>{{ p.title }}</b>{%- endif -%}{%- endfor -%}';
  const f=await fixture(t,text,kind==='section-fetch'?'assets/main.js':'sections/main.liquid');
  if(kind==='hidden-dom')f.runtime.domainTargets=[{id:'filters',idCount:1,tag:'DETAILS',open:false,bodyId:'filter-body',descendants:252,unsafeContent:false}];
  if(kind==='section-fetch'){
    f.runtime.resources=[{type:'Fetch',method:'GET',phase:'initial',status:200,mimeType:'text/html',url,timestamp:1,finishedTimestamp:1.5,initiatorSources:[{status:'verified-bytes',file:f.file,sourceHash:sha256(text),offset:text.indexOf('fetch(')}]}];f.runtime.sections=[{id:'shopify-section-main',idCount:1,containsLCP:true,selectors:['#hero']}];
  }
  const lp=kind==='liquid-query'?f.liquid(1):undefined;
  const baseline=await siteRun(t,{devices:['mobile'],pages:[{id:'home',url}],scores:{mobile:[60]}}),proof=f.runtime.domainProof.before;
  Object.assign(baseline.manifest,{startedAt:'2026-10-15T00:00:00Z',finishedAt:'2026-10-24T00:00:00Z',deployment:{before:{...proof,startedAt:'2026-10-15T00:00:01Z',finishedAt:'2026-10-15T00:00:02Z',pages:proof.pages.map(x=>({...x,id:'home'}))},after:{...proof,startedAt:'2026-10-24T00:00:00Z',finishedAt:'2026-10-24T00:00:00Z',pages:proof.pages.map(x=>({...x,id:'home'}))}}});
  baseline.manifest.config.deployment={project:f.root,store:proof.store,themeId:'1'};await saveManifest(baseline);
  const out=await mkdtemp('/private/tmp/perfkit-extended-session-');t.after(()=>rm(out,{recursive:true,force:true}));let state,i=0;
  const step=async config=>state=await runImprovement({config:{schemaVersion:1,...(state?{previous:path.join(state.output,'session.json')}:{project:f.root,run:baseline.root,profiles:[f.runtime],...(lp?{liquidProfile:lp}:{}),budget:{maxCandidateRounds:4,maxFailures:8,maxAttempts:60}}),...config},output:path.join(out,String(i++)),dependencies:{runPatchExperiment:async({output})=>({output,status:'no-measurable-gain',verification:{outcome:'no-measurable-gain'},counts:{attempted:6,failed:0}})}});
  await step({action:'start'});assert.equal(state.error,undefined,JSON.stringify(state.error));
  const recovery=JSON.parse(await readFile(state.recovery,'utf8')),c=recovery.candidates.find(c=>c.kind===kind);assert.ok(c);
  const patches=[];
  const methods=remainingDomainMethods(c,f.snapshot.hash).filter((m,i,all)=>all.findIndex(x=>methodMechanism(x)===methodMechanism(m))===i);
  for(const method of methods){
    await step({action:'prepare',candidateId:c.candidateId,method:'next',rationale:'Try the next untested implementation after observed no gain',domain:{schemaVersion:1,review:review(method),...(kind==='hidden-dom'?{newAsset:'assets/hidden.js'}:kind==='section-fetch'?{sectionSelector:'#hero'}:{})}});
    assert.equal(state.error,undefined,JSON.stringify(state.error));assert.equal(state.active.method,method);patches.push((await readFile(state.active.plan,'utf8')));
    await step({action:'apply',reviewedPlanHash:state.active.planHash});assert.notEqual(await readFile(path.join(f.root,f.file),'utf8'),text);
    const side=id=>({schemaVersion:1,engine:'lighthouse',devices:['mobile'],pages:[{id:'home',url}],deployment:{project:f.root,store:proof.store,themeId:id}});
    await step({action:'experiment',experiment:{schemaVersion:1,before:side('1'),after:side('2')}});
    assert.equal(state.error,undefined,JSON.stringify(state.error));assert.equal(state.active,null);assert.equal(state.history.at(-1).outcome,'no-measurable-gain');assert.equal(await readFile(path.join(f.root,f.file),'utf8'),text);
    if(kind==='hidden-dom')await assert.rejects(readFile(path.join(f.root,'assets/hidden.js')),{code:'ENOENT'});
  }
  assert.equal(new Set(patches.map(p=>JSON.stringify(JSON.parse(p).changes.map(c=>c.after)))).size,methods.length);
  assert.equal(state.status,'investigation-required');assert.equal(state.nextDomainStep,null);
  if(kind==='section-fetch'){
    await step({action:'prepare',candidateId:c.candidateId,method:'section-fetch-json',rationale:'Attempt an equivalent protocol variant',domain:{schemaVersion:1,sectionSelector:'#hero',review:review('section-fetch-json')}});
    assert.equal(state.error.code,'NO_UNTESTED_DOMAIN_METHOD');assert.equal(state.active,null);
    await step({action:'prepare',candidateId:c.candidateId,method:'section-rendering/domain:section-fetch-json',rationale:'Attempt via official route',official:{schemaVersion:1,candidateId:c.candidateId,methodId:'section-rendering',executor:'domain:section-fetch-json',parameters:{sectionSelector:'#hero'},review:{...review('section-fetch-json'),sourceHash:c.source.sourceHash}}});
    assert.equal(state.error.code,'NO_UNTESTED_DOMAIN_METHOD');assert.equal(state.active,null);
  }
});


test('captured Section API body must contain the actual section, not a null, nested template or script string',()=>{
  const u=url+'&sections=main';
  for(const html of [null,'<div>Wrong id</div>','<script>"<div id=\"shopify-section-main\"></div>"</script>','<template><div id="shopify-section-main"></div></template>'])assert.equal(sectionResponseEvidence(u,JSON.stringify({main:html})).valid,false);
  assert.equal(sectionResponseEvidence(u,JSON.stringify({main:'<div id="shopify-section-main"><h1>Ready</h1></div>'})).valid,true);
});


import {runPatchExperiment} from '../lib/patch-experiment.mjs';
test('query experiment refuses missing server evidence before browser or scoring work',async t=>{
  const text='{%- for p in collection.products -%}{%- if forloop.index <= 4 -%}{{ p.title }}{%- endif -%}{%- endfor -%}',f=await fixture(t,text),d=f.diagnose(f.liquid(1)),c=d.candidates.find(c=>c.kind==='liquid-query');
  const p=await make(f,d,c,'query-limit'),root=await mkdtemp('/private/tmp/perfkit-query-gate-');t.after(()=>rm(root,{recursive:true,force:true}));const before=path.join(root,'before');await cp(f.root,before,{recursive:true});await applySitePlan(p,f.root);
  const side=(project,id)=>({schemaVersion:1,engine:'lighthouse',devices:['mobile'],pages:[{id:'home',url}],deployment:{project,store:'fixture.myshopify.com',themeId:id}});
  const regression={schemaVersion:1,url,viewports:[{name:'mobile',width:390,height:844}],scenarios:[{name:'query',steps:[{action:'assert-count',selector:'b',count:4},{action:'checkpoint',selector:'main',key:'query'}]}]};let calls=0;
  const forbidden=async()=>{calls++;throw new Error('Must not collect browser evidence before raw Liquid evidence');};
  const result=await runPatchExperiment({config:{schemaVersion:1,plan:p,diagnosis:d,candidateId:c.candidateId,before:side(before,'1'),after:side(f.root,'2'),regressionBefore:regression,regressionAfter:regression},output:path.join(root,'result'),dependencies:{verifyDeployment:forbidden,runScenarios:forbidden,measureSite:forbidden}});
  assert.equal(calls,0);assert.equal(result.status,'invalid-evidence');assert.match(result.error,/Liquid profiling evidence is invalid/);assert.equal(result.counts.attempted,0);
});
