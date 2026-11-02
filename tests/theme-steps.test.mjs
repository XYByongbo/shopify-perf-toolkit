import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFile,readFile} from 'node:fs/promises';
import path from 'node:path';
import {Liquid} from 'liquidjs';
import {themeStepFixture} from './helpers/theme-step-fixture.mjs';
import {themeContracts,stylesheetOncePatch,stylesheetOnceTargets,forwarderTargets,collapseForwarder,themePlanDeltas} from '../lib/theme-methods.mjs';
import {createDomainPlan} from '../lib/domain-plan.mjs';
import {applySitePlan,rollbackSitePlan,validateSitePlan} from '../lib/site-changes.mjs';
import {queryTargets,queryPatch,extendedContracts} from '../lib/extended-methods.mjs';
import {checkExtendedBehavior} from '../lib/optimization-regression.mjs';
import {gainGroupForCandidate} from '../lib/gain-scope.mjs';
import {reassessCandidate,hypothesisKey,remainingDomainMethods} from '../lib/recovery.mjs';
import {verifyPreservation,preservationStyles} from '../lib/preservation.mjs';
import {recoveryContext} from '../lib/recovery-context.mjs';
import {domainCandidates,validateDomainCandidate} from '../lib/domain-candidates.mjs';
const review=method=>({summary:'Synthetic reviewed regression fixture; no merchant performance claim',...Object.fromEntries((themeContracts[method]??extendedContracts[method]).review.map(k=>[k,true]))});
const caller='<div id="cards">{% for product in products %}{% if product.available %}{% render "card", product: product %}{% endif %}{% endfor %}</div>';
const card=`{{ 'card.css' | asset_url | stylesheet_tag }}<article>{{ product.title | escape }}</article>`;
const files={'sections/main.liquid':caller,'snippets/card.liquid':card,'assets/card.css':'.card{color:blue}'};
function styleEvidence(f,count=2) {
  f.runtime.initial.delivery.stylesheets=Array.from({length:count},()=>({tag:'LINK',href:'https://fixture.myshopify.com/assets/card.css',assetName:'card.css',rootSelectors:['#cards'],media:'all',mediaMatches:true,disabled:false,onLoad:false,crossOrigin:null,integrity:null}));
  f.runtime.styleCosts={complete:true,styleRecalcMs:40};
}

test('failed mechanisms remain excluded after unrelated source shifts; changed causal input permits a new diagnosis',async t=>{
  const f=await themeStepFixture(t,files);styleEvidence(f);const c=f.diagnose().candidates.find(c=>c.kind==='stylesheet');
  const inputs=Object.entries(files).map(([file,text])=>({file,text}));c.recoveryContext=recoveryContext(c,inputs);assert.ok(c.recoveryContext);
  const history=[{baselineHash:'old',hypothesisKey:hypothesisKey(c),recoveryContext:c.recoveryContext,method:'stylesheet-once',outcome:'no-measurable-gain'}];
  const prefix='<!-- unrelated section note -->\n',shifted={...c,line:c.line+1,source:{...c.source,offset:c.source.offset+prefix.length},data:{...c.data,target:{...c.data.target,loopOffset:c.data.target.loopOffset+prefix.length}}};
  shifted.recoveryContext=recoveryContext(shifted,inputs.map(f=>f.file===c.file?{...f,text:prefix+f.text}:f));
  assert.equal(shifted.recoveryContext.key,c.recoveryContext.key);assert.deepEqual(remainingDomainMethods(shifted,'new',history),[]);
  const different={...c,recoveryContext:{...c.recoveryContext,key:'different-parser-target'}};
  assert.deepEqual(remainingDomainMethods(different,'old',history),['stylesheet-once'],'two different parser targets on one line must not share a rejection');
  shifted.domainEvidence={...shifted.domainEvidence,dependencyFiles:shifted.domainEvidence.dependencyFiles.map(d=>d.file.endsWith('.css')?{...d,sourceHash:'changed'}:d)};
  shifted.recoveryContext=recoveryContext(shifted,inputs.map(f=>f.file===c.file?{...f,text:prefix+f.text}:f));
  assert.deepEqual(remainingDomainMethods(shifted,'new',history),['stylesheet-once']);
  const query={...c,kind:'liquid-query',methods:['query-limit-render'],recoveryContext:null};
  assert.deepEqual(remainingDomainMethods(query,'base',[{baselineHash:'base',hypothesisKey:hypothesisKey(query),method:'query-limit',outcome:'no-measurable-gain'}]),[]);
});

test('paired stylesheet generation emits at first actual card; preserves empty/filter/default callers and exact content',async t=>{
  const f=await themeStepFixture(t,files),patch=stylesheetOncePatch('sections/main.liquid',caller,caller.indexOf('{% render'),Object.entries(files).map(([file,text])=>({file,text})));
  const engine=new Liquid({root:path.join(f.root,'snippets'),extname:'.liquid'});engine.registerFilter('asset_url',x=>'/assets/'+x);engine.registerFilter('stylesheet_tag',x=>`<link rel="stylesheet" href="${x}">`);
  for(const products of [[],[{title:'Skip',available:false}],[{title:'Skip',available:false},{title:'A',available:true},{title:'B',available:true}]]) {
    await writeFile(path.join(f.root,'snippets/card.liquid'),card);const before=await engine.parseAndRender(caller,{products});
    await writeFile(path.join(f.root,'snippets/card.liquid'),patch.snippet);const after=await engine.parseAndRender(patch.caller,{products});
    assert.equal(after.replace(/<link[^>]*>/g,''),before.replace(/<link[^>]*>/g,''));
    assert.equal((after.match(/<link/g)??[]).length,products.some(p=>p.available)?1:0);
  }
  assert.match(await engine.parseAndRender('{% render "card", product: product %}',{product:{title:'Direct'}}),/<link/);
});

test('measured style candidate creates two replayable source edits and checks unchanged CSS dependency before apply',async t=>{
  const f=await themeStepFixture(t,files);styleEvidence(f);const d=f.diagnose(),c=d.candidates.find(c=>c.kind==='stylesheet');assert.ok(c);
  const plan=await createDomainPlan({project:f.root,diagnosis:d,config:{schemaVersion:1,candidateId:c.candidateId,method:'stylesheet-once',review:review('stylesheet-once')}});
  await validateSitePlan(plan);assert.equal(plan.changes.length,2);assert.equal(themePlanDeltas(plan)[0].selector,'#cards');
  await applySitePlan(plan,f.root);assert.match(await readFile(path.join(f.root,'snippets/card.liquid'),'utf8'),/unless skip_perfkit/);
  await rollbackSitePlan(plan,f.root);
  await writeFile(path.join(f.root,'assets/card.css'),'.card{color:red}');
  await assert.rejects(applySitePlan(plan,f.root),{code:'SOURCE_DRIFT'});assert.equal(await readFile(path.join(f.root,'sections/main.liquid'),'utf8'),caller);
});

test('stylesheet pairing preserves whitespace-trim behavior at loop/render and output boundaries',async t=>{
  const f=await themeStepFixture(t,files),engine=new Liquid({root:path.join(f.root,'snippets'),extname:'.liquid'});
  engine.registerFilter('asset_url',x=>x);engine.registerFilter('stylesheet_tag',x=>`<link rel="stylesheet" href="${x}">`);
  for(const template of [caller.replace('{% for','\n   {%- for').replace('product %}','product -%}\n   '),caller])for(const snippet of [card,' \n'+card.replace("{{ '","{{- '").replace('stylesheet_tag }}','stylesheet_tag -}}')+' \n']){
    await writeFile(path.join(f.root,'snippets/card.liquid'),snippet);const before=await engine.parseAndRender(template,{products:[{title:'A',available:true},{title:'B',available:true}]});
    const patch=stylesheetOncePatch('sections/main.liquid',template,template.indexOf('{% render'),[{file:'snippets/card.liquid',text:snippet},{file:'assets/card.css',text:'.a{}'}]);
    await writeFile(path.join(f.root,'snippets/card.liquid'),patch.snippet);const after=await engine.parseAndRender(patch.caller,{products:[{title:'A',available:true},{title:'B',available:true}]});
    assert.equal(after.replace(/<link[^>]*>/g,''),before.replace(/<link[^>]*>/g,''));
  }
});

test('interleaved stylesheet cascade, load handlers, unmeasured work and already optimized snippets produce no candidate',async t=>{
  const f=await themeStepFixture(t,files);styleEvidence(f);
  const good=structuredClone(f.runtime.initial.delivery.stylesheets);
  f.runtime.initial.delivery.stylesheets.splice(1,0,{tag:'STYLE'});assert.equal(f.diagnose().candidates.some(c=>c.kind==='stylesheet'),false);
  f.runtime.initial.delivery.stylesheets=good;good[1].onLoad=true;assert.equal(f.diagnose().candidates.some(c=>c.kind==='stylesheet'),false);
  good[1].onLoad=false;f.runtime.styleCosts.complete=false;assert.equal(f.diagnose().candidates.some(c=>c.kind==='stylesheet'),false);
  assert.deepEqual(stylesheetOnceTargets({file:'sections/main.liquid',text:caller},[{file:'snippets/card.liquid',text:'{% unless skip_styles %}'+card+'{% endunless %}'}]),[]);
});

test('stylesheet interaction candidates require actual target EventTiming and complete single-action style work',async t=>{
  const f=await themeStepFixture(t,files);styleEvidence(f);const p=f.runtime;
  p.interactionWindowStartMs=100;p.actions=[{type:'click',target:'#menu'}];
  p.afterActions={interactions:[{target:'#menu',name:'click',startTime:120,duration:150}]};
  p.interactionStyleCosts={complete:true,styleRecalcMs:60};
  const args={files:Object.entries(files).map(([file,text])=>({file,text})),snapshot:f.snapshot,profiles:[p],goal:{kind:'interaction',metric:'interaction',target:'#menu',event:'click'}};
  const c=domainCandidates(args)[0];assert.equal(c.metric,'interaction');assert.equal(c.target,'#menu');assert.equal(validateDomainCandidate(c,f.snapshot),true);
  p.interactionStyleCosts.complete=false;assert.deepEqual(domainCandidates(args),[]);
  p.interactionStyleCosts.complete=true;p.afterActions.interactions[0].target='#other';assert.deepEqual(domainCandidates(args),[]);
  p.afterActions.interactions[0].target='#menu';p.actions.push({type:'click',target:'#other'});assert.deepEqual(domainCandidates(args),[]);
});

test('pure forwarding render retains scope, parameter values and source-bound multi-file Liquid cost',async t=>{
  const main='{% assign marker = "caller" %}{% render "forward", product: item %}|{{ marker }}';
  const src={'sections/main.liquid':main,'snippets/forward.liquid':'{% render "leaf", product: product %}','snippets/leaf.liquid':'{% assign marker = "leaf" %}<b>{{ product.title | escape }}</b>'};
  const f=await themeStepFixture(t,src),all=Object.entries(src).map(([file,text])=>({file,text})),targets=forwarderTargets(all[0],all);assert.equal(targets.length,1);
  const after=collapseForwarder(main,targets[0].offset,all),engine=new Liquid({root:path.join(f.root,'snippets'),extname:'.liquid'});
  assert.equal(await engine.parseAndRender(after,{item:{title:'A'}}),await engine.parseAndRender(main,{item:{title:'A'}}));
  const lp=f.liquid(['sections/main.liquid:1','snippets/forward.liquid:1','snippets/leaf.liquid:1'],[[0],[0,1],[0,1,2]],[5,15,10]);
  const d=f.diagnose(lp),c=d.candidates.find(c=>c.kind==='liquid-render');assert.ok(c);assert.deepEqual(c.data.costFiles,['sections/main.liquid','snippets/forward.liquid','snippets/leaf.liquid']);
  const plan=await createDomainPlan({project:f.root,diagnosis:d,config:{schemaVersion:1,candidateId:c.candidateId,method:'liquid-collapse-forwarder',review:review('liquid-collapse-forwarder')}});
  await applySitePlan(plan,f.root);assert.equal(await readFile(path.join(f.root,'sections/main.liquid'),'utf8'),after);await rollbackSitePlan(plan,f.root);
  for(const wrapper of ['{% assign product = other %}{% render "leaf", product: product %}',' {% render "leaf", product: product %}','{% render "leaf", product: other %}'])assert.deepEqual(forwarderTargets(all[0],[all[0],{file:'snippets/forward.liquid',text:wrapper},all[2]]),[]);
});

test('render-containing query cap preserves items and isolates nested snippet metadata dependencies',async t=>{
  const source='{%- for p in collection.products -%}{%- if forloop.index <= 4 -%}{% render "item", product: p %}{%- endif -%}{%- endfor -%}';
  const src={'sections/main.liquid':source,'snippets/item.liquid':'<b>{{ product.title }}</b>'},f=await themeStepFixture(t,src),all=Object.entries(src).map(([file,text])=>({file,text}));
  const n=queryTargets(source,{files:all})[0];assert.deepEqual(n.methods,['query-limit-render']);const after=queryPatch(source,n.offset,'query-limit-render',{files:all});
  const engine=new Liquid({root:path.join(f.root,'snippets'),extname:'.liquid'});
  for(const length of [0,1,4,20]){const data={collection:{products:Array.from({length},(_,i)=>({title:String(i)}))}};assert.equal(await engine.parseAndRender(after,data),await engine.parseAndRender(source,data));}
  assert.deepEqual(queryTargets(source),[]);
  assert.deepEqual(queryTargets(source,{files:[{file:'snippets/item.liquid',text:'{{ forloop.length }}'}]}),[]);
  const lp=f.liquid(['sections/main.liquid:1'],[[0]],[30]),d=f.diagnose(lp),c=d.candidates.find(c=>c.kind==='liquid-query');assert.ok(c);
  const plan=await createDomainPlan({project:f.root,diagnosis:d,config:{schemaVersion:1,candidateId:c.candidateId,method:'query-limit-render',review:review('query-limit-render')}});await applySitePlan(plan,f.root);await rollbackSitePlan(plan,f.root);
});

test('gain attribution is invariant to same-device page order; missing and duplicate matches are not guessed',()=>{
  const c={file:'assets/main.js',line:1,kind:'section-fetch',metric:'lcp',page:'https://fixture.test/products/a',device:'mobile',methods:['section-liquid-initial']};
  const home={pageId:'home',device:'mobile',metrics:{fcp:{regressed:true,before:{median:1000},after:{median:1500}}}},product={pageId:'product',device:'mobile',metrics:{fcp:{regressed:false}}};
  const g={pageId:'product',device:'mobile',url:c.page,metrics:[{metric:'lcp',median:2500}]};
  for(const groups of [[home,product],[product,home]]){const h=[{baselineHash:'base',hypothesisKey:hypothesisKey(c),outcome:'formal-rejected',method:'section-liquid-initial',verification:{gain:{groups}}}];assert.deepEqual(reassessCandidate(c,'base',h,[],g).reassessment.regressions,[]);}
  assert.equal(gainGroupForCandidate([home,product],c),null);assert.equal(gainGroupForCandidate([product,product],c,g),null);
});

test('inline hidden generation requires captured CSP; a working disclosure with blocked/no-op controller fails mechanism gate',async t=>{
  const source='<details id="filters"><summary>Open</summary><div id="body">'+Array.from({length:250},()=>'<p>Item</p>').join('')+'</div></details>';
  const f=await themeStepFixture(t,{'sections/main.liquid':source});f.runtime.domainTargets=[{id:'filters',idCount:1,tag:'DETAILS',open:false,bodyId:'body',descendants:252,unsafeContent:false}];
  for(const policy of [undefined,{complete:true,headers:["script-src 'self'"],meta:[]}]) {
    f.runtime.initial.delivery.securityPolicy=policy;const d=f.diagnose(),c=d.candidates[0];assert.ok(c);
    await assert.rejects(createDomainPlan({project:f.root,diagnosis:d,config:{schemaVersion:1,candidateId:c.candidateId,method:'hidden-detach',review:review('hidden-detach')}}),{code:policy?'CSP_INLINE_BLOCKED':'CSP_EVIDENCE_REQUIRED'});
    if(policy)assert.deepEqual(remainingDomainMethods(c,f.snapshot.hash),[]);
  }
  const plan={changes:[{evidence:{domainKind:'hidden-dom',domainMethod:'hidden-detach',domainPage:f.url,hiddenContract:{summarySelector:'#filters > summary',bodySelector:'#body',mechanism:{kind:'dom-parking',key:'k'}}}}]};
  assert.equal(checkExtendedBehavior(plan,{runs:[{url:f.url,initialDisclosures:[{id:'filters',bodyId:'body',descendants:250,controllers:[]}],steps:[]}]},{candidate:true}),false);
});

test('stylesheet preservation allows exactly the generated redundant links; content and other resources remain strict',async t=>{
  const f=await themeStepFixture(t,files);styleEvidence(f);const d=f.diagnose(),c=d.candidates.find(c=>c.kind==='stylesheet');const plan=await createDomainPlan({project:f.root,diagnosis:d,config:{schemaVersion:1,candidateId:c.candidateId,method:'stylesheet-once',review:review('stylesheet-once')}});
  const link={tag:'LINK',attrs:[['href','https://fixture.myshopify.com/assets/card.css'],['rel','stylesheet']],text:[],value:null,checked:null},article={tag:'ARTICLE',attrs:[],text:['A'],value:null,checked:null};
  const geometry={rect:[0,0,0,0],styles:Object.fromEntries(preservationStyles.map(k=>[k,'same']))};
  const checkpoint=content=>({version:1,content,layout:content.map(()=>geometry)}),hash='a'.repeat(64);
  const scenarios=observation=>({kind:'scenarios',sourceHash:hash,sourceStable:true,outcome:'passed',environment:{},runs:[{name:'cards',url:f.url,viewport:{name:'mobile'},outcome:'passed',constrained:false,steps:[{index:0,action:'assert-count',selector:'article',count:2,outcome:'passed',elapsedMs:1},{index:1,action:'checkpoint',selector:'#cards',key:'cards',outcome:'passed',elapsedMs:1,observation}]}]});
  const before=scenarios(checkpoint([link,article,link,article])),after=scenarios(checkpoint([link,article,article]));
  assert.equal(verifyPreservation({before,after,beforeSourceHash:hash,afterSourceHash:hash}).outcome,'regressed');
  assert.equal(verifyPreservation({before,after,beforeSourceHash:hash,afterSourceHash:hash,plan}).outcome,'preserved');
  after.runs[0].steps[1].observation.content[2]={...article,text:['changed']};assert.equal(verifyPreservation({before,after,beforeSourceHash:hash,afterSourceHash:hash,plan}).outcome,'regressed');
});
