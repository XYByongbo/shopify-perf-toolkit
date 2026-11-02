// Synthetic contracts and isolated files, never storefront performance evidence.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,symlink} from 'node:fs/promises';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {normalizeFieldData,parseFieldCSV,adaptCrux,fieldSegments} from '../lib/field-data.mjs';
import {digest,goalContract} from '../lib/evidence-contract.mjs';
import {auditStylesheets} from '../lib/stylesheet-audit.mjs';
import {attributeApps} from '../lib/app-attribution.mjs';
import {diagnoseUnified,interactionSummary,layoutSummary} from '../lib/decision-engine.mjs';
import {sourceSnapshot} from '../lib/runtime-profile.mjs';
import {verifyInteractions,readInteractionRun,validateInteractionConfig,measureInteractions,interactionBehaviorCovered} from '../lib/interaction-measure.mjs';
import {validateProfileConfig} from '../lib/runtime-profile.mjs';
import {evaluateGain} from '../lib/performance-gain.mjs';
import {verifyOptimization} from '../lib/optimize.mjs';
import {checkCI} from '../lib/ci-check.mjs';
import {siteRun,saveManifest,regressionForRun} from './helpers/site-run.mjs';
import {runBatch} from '../lib/batch.mjs';
import {renderReport} from '../lib/report.mjs';

const wd=new URL('../',import.meta.url).pathname;
async function temp(t){const r=await mkdtemp('/private/tmp/perfkit-p0p1-');t.after(()=>rm(r,{recursive:true,force:true}));return r;}
async function json(file,value){await mkdir(path.dirname(file),{recursive:true});await writeFile(file,JSON.stringify(value));}
const windowDates=()=>({start:new Date(Date.now()-7*86400000).toISOString(),end:new Date(Date.now()-86400000).toISOString()});
const fieldInput=()=>({schemaVersion:1,source:'shopify-rum',window:windowDates(),groups:[{url:'https://shop.example.test/',pageType:'home',device:'mobile',samples:500,metrics:{lcp:4000,inp:250,cls:0.05}}]});

test('field evidence preserves p75 scope, counts, provenance and unavailable data',()=>{
  const input=fieldInput(),f=normalizeFieldData(input);
  assert.equal(f.groups[0].status,'usable');assert.equal(f.evidence.identity,'not-source-bound');
  assert.equal(f.groups[0].percentile,75);assert.equal(f.groups[0].breaches[0].metric,'lcp');
  const unknown=structuredClone(input);delete unknown.groups[0].samples;
  const limited=normalizeFieldData(unknown);assert.equal(limited.status,'limited');assert.equal(limited.groups[0].samples,null);
  limited.groups[0].status='usable';assert.equal(fieldSegments(limited,input.groups[0].url,'mobile')[0].status,'limited');
  assert.deepEqual(fieldSegments(f,'https://unrelated.test/','mobile'),[]);assert.deepEqual(fieldSegments(f,input.groups[0].url,'desktop'),[]);
  const stale=structuredClone(input);stale.window={start:'2020-01-01',end:'2020-01-28'};
  assert.ok(normalizeFieldData(stale).groups[0].issues.includes('stale-window'));
  assert.throws(()=>normalizeFieldData({...input,window:{start:'2999-01-01',end:'2999-01-28'}}),/window/);
  assert.throws(()=>normalizeFieldData({...input,groups:[...input.groups,...input.groups]}),/Duplicate/);
  assert.throws(()=>normalizeFieldData({...input,groups:[{...input.groups[0],url:'https://shop.test/?email=x'}]}),/URLs/);
});
test('field CSV handles quoted exports, rejects mixed windows and malformed rows; CrUX never invents count/template',()=>{
  const w=windowDates(),csv=`source,windowStart,windowEnd,url,pageType,device,samples,lcp\r\n"shopify-rum",${w.start},${w.end},https://shop.test/,home,mobile,123,3000\r\n`;
  assert.equal(normalizeFieldData(parseFieldCSV(csv)).groups[0].samples,123);
  const blank=parseFieldCSV(csv.replace('samples,lcp','samples,lcp,inp').replace('123,3000','123,3000,   '));
  assert.equal(blank.groups[0].metrics.inp,undefined);
  const scopedCSV=parseFieldCSV(csv.replace('samples,lcp','samples,lcp,target').replace('123,3000','123,3000,#buy'));
  assert.equal(normalizeFieldData(scopedCSV).groups[0].target,'#buy');
  assert.throws(()=>parseFieldCSV('source,url\n"oops'),/Unterminated/);
  assert.throws(()=>parseFieldCSV('source,url\nshopify-rum,x,y'),/width/);
  const crux=adaptCrux({record:{key:{origin:'https://shop.test',formFactor:'PHONE'},collectionPeriod:{firstDate:{year:2026,month:10,day:1},lastDate:{year:2026,month:10,day:10}},metrics:{largest_contentful_paint:{percentiles:{p75:3500}},cumulative_layout_shift:{percentiles:{p75:'0.12'}}}}});
  assert.equal(crux.groups[0].scope,'origin');assert.equal(crux.groups[0].pageType,'unknown');assert.equal(crux.groups[0].samples,null);
  assert.equal(normalizeFieldData(crux,{now:Date.UTC(2026,9,19)}).status,'limited');
  const missing=adaptCrux({record:{key:{origin:'https://shop.test'},collectionPeriod:{firstDate:{year:2026,month:10,day:1},lastDate:{year:2026,month:10,day:10}},metrics:{largest_contentful_paint:{percentiles:{p75:3000}},interaction_to_next_paint:{percentiles:{p75:null}}}}});
  assert.equal(missing.groups[0].metrics.inp,undefined);
  assert.throws(()=>adaptCrux({record:{key:{origin:'https://shop.test',formFactor:'UNKNOWN'},collectionPeriod:{},metrics:{}}}),/formFactor/);
});
async function theme(t,files){const root=await temp(t);for(const [file,text]of Object.entries(files)){await mkdir(path.dirname(path.join(root,file)),{recursive:true});await writeFile(path.join(root,file),text);}return root;}
test('native stylesheet audit catches sibling and alternate-caller dependencies without moving any CSS',async t=>{
  const project=await theme(t,{'sections/a.liquid':`{% stylesheet %}.scoped{color:red}{% endstylesheet %}{% render 'card' %}`,
    'sections/b.liquid':`{% render 'card' %}<div class="scoped"></div>`, 'snippets/card.liquid':'<p class="scoped">Card</p>',
    'templates/index.json':'{"sections":{"a":{"type":"a"},"b":{"type":"b"}}}'});
  const snapshot=await sourceSnapshot(project),audit=await auditStylesheets({project});
  assert.ok(audit.findings.some(f=>f.file==='sections/b.liquid'));assert.ok(audit.findings.some(f=>f.file==='snippets/card.liquid'));
  assert.equal((await sourceSnapshot(project)).hash,snapshot.hash);
  await writeFile(path.join(project,'sections/b.liquid'),'<div class="dynamic-{{ section.id }}"></div>');
  const dynamic=await auditStylesheets({project});assert.equal(dynamic.status,'partial');assert.ok(dynamic.unresolved.some(u=>u.reason==='dynamic-class'));
});
test('native stylesheet same-file and explicit parent patterns pass; asset allowlist remains advisory',async t=>{
  const project=await theme(t,{'sections/main.liquid':`{% stylesheet %}.own{color:red}{% endstylesheet %}<div class="own"></div>{% render 'card' %}`,'snippets/card.liquid':'<p class="own">Card</p>'});
  assert.equal((await auditStylesheets({project})).status,'compatible-static-patterns');
});
test('reviewed third-party ownership is path-specific, ambiguous stays unknown, CPU phases are separate',()=>{
  const owners=[{id:'reviews',name:'Reviews',host:'shared.test',pathPrefix:'/reviews/',purpose:'review widget',evidence:'checked app embed settings'}];
  const p={config:{url:'https://shop.test/',device:'mobile',state:'open'},resources:[{url:'https://shared.test/reviews/a.js'},{url:'https://shared.test/other.js'}],cpu:[{url:'https://shared.test/reviews/a.js',selfMs:80}],interactionCpu:[{url:'https://shared.test/reviews/a.js',selfMs:120}]};
  const r=attributeApps({profiles:[p],owners});assert.equal(r.unknownResources,1);assert.deepEqual(r.groups.map(g=>g.selfMs),[80,120]);
  assert.equal(attributeApps({profiles:[p],owners:[...owners,{...owners[0],id:'other'}]}).resources[0].owner.status,'ambiguous');
  assert.throws(()=>attributeApps({owners:[{...owners[0],host:'*.test'}]}),/owner/);
});
test('unified diagnosis connects interaction phases, current source and field priority without promoting stale CPU',async t=>{
  const project=await theme(t,{'assets/a.js':'function clickWork(){return 1;}','sections/main.liquid':'<button id="buy">Buy</button>'});
  const snapshot=await sourceSnapshot(project),source={status:'verified-bytes',...snapshot.files.find(f=>f.file==='assets/a.js'),line:1};
  const p={kind:'runtime-profile',status:'complete',sourceStable:true,snapshot,config:{url:'https://shop.example.test/',device:'mobile',state:'buy',actions:[{type:'click',selector:'#buy'}]},
    resources:[],cpu:[],interactionCpu:[{selfMs:90,url:'https://cdn.test/a.js',source}],afterActions:{interactions:[{interactionId:1,name:'click',target:'#buy',duration:240,inputDelay:120,processing:80},{interactionId:1,name:'pointerup',target:'#buy',duration:248,inputDelay:128,processing:80}]}};
  const d=await diagnoseUnified({project,profiles:[p],field:normalizeFieldData(fieldInput()),goal:{kind:'interaction',target:'#buy',event:'click'}});
  assert.equal(d.candidates[0].kind,'interaction-cpu');assert.equal(d.phases[0].interactions[0].dominantPhase,'input');
  const otherTarget=fieldInput();otherTarget.groups[0].target='#unrelated';
  const scoped=normalizeFieldData(otherTarget);
  assert.equal(fieldSegments(scoped,p.config.url,p.config.device,{target:'#buy'}).length,0);
  assert.equal(fieldSegments(scoped,p.config.url,p.config.device,{target:'#unrelated'}).length,1);
  const wrong=await diagnoseUnified({project,profiles:[p],field:scoped,goal:{kind:'interaction',target:'#buy',event:'click'}});
  assert.equal(wrong.candidates[0].priority.fieldBreach,false);assert.equal(wrong.candidates[0].priority.affectedSamples,null);
  const second={...p,config:{...p.config,device:'desktop'}};
  const both=await diagnoseUnified({project,profiles:[p,second],limit:20,goal:{kind:'interaction',target:'#buy',event:'click'}});
  assert.equal(new Set(both.candidates.map(c=>c.candidateId)).size,2);
  assert.equal(both.candidates[0].target,'#buy');assert.equal(both.candidates[0].event,'click');
  for(const cost of [NaN,Infinity]){
    const invalid=structuredClone(p);invalid.interactionCpu[0].selfMs=cost;
    assert.equal((await diagnoseUnified({project,profiles:[invalid],goal:{kind:'interaction',target:'#buy',event:'click'}})).candidates.length,0);
  }
  const invented=structuredClone(p);invented.interactionCpu[0].source.sourceHash='c'.repeat(64);invented.snapshot.files.find(f=>f.file==='assets/a.js').sourceHash='c'.repeat(64);
  assert.equal((await diagnoseUnified({project,profiles:[invented],goal:{kind:'interaction',target:'#buy',event:'click'}})).candidates.length,0);
  const old=normalizeFieldData({...fieldInput(),window:{start:'2020-01-01',end:'2020-01-28'}});old.status='available';
  assert.equal((await diagnoseUnified({project,profiles:[p],field:old})).fieldStatus,'limited');
  p.snapshot.hash='0'.repeat(64);assert.equal((await diagnoseUnified({project,profiles:[p],goal:{kind:'interaction',target:'#buy',event:'click'}})).candidates.length,0);
  assert.equal(interactionSummary({afterActions:{interactions:[{interactionId:1,duration:20},{interactionId:1,duration:40}]}}).length,1);
});
test('loading goals can establish metric gain without relaxing score mode or regression guards',async t=>{
  const before=await siteRun(t,{devices:['mobile'],scores:{mobile:[85]}}),after=await siteRun(t,{devices:['mobile'],scores:{mobile:[85]},offset:20,augment:r=>{r.audits['largest-contentful-paint'].numericValue=1400;}});
  assert.equal((await evaluateGain({before:before.root,after:after.root})).outcome,'no-measurable-gain');
  assert.equal((await evaluateGain({before:before.root,after:after.root,goal:{kind:'loading',metric:'lcp'}})).outcome,'measurable-gain');
  const regression=await siteRun(t,{devices:['mobile'],scores:{mobile:[80]},offset:40,augment:r=>{r.audits['largest-contentful-paint'].numericValue=1400;}});
  assert.equal((await evaluateGain({before:before.root,after:regression.root,goal:{kind:'loading',metric:'lcp'}})).outcome,'performance-regressed');
  assert.throws(()=>goalContract({kind:'score',metric:'inp'}),/Goal/);
});
test('layout diagnosis uses separated session windows instead of summing an entire browsing period',()=>{
  const p={afterActions:{shifts:[{startTime:500,value:0.1},{startTime:1000,value:0.12},{startTime:5000,value:0.15}]}};
  assert.equal(layoutSummary(p).observedSessionMax,0.22);assert.equal(layoutSummary(p).scope,'finite-lab-window-not-field-CLS');
});
test('layout sessions exclude recent input and split at exact 1s/5s boundaries',()=>{
  for(const shifts of [
    [{startTime:0,value:0.1},{startTime:1000,value:0.2}],
    Array.from({length:7},(_,i)=>({startTime:i*1000*5/6,value:0.1})),
  ]) assert.ok(layoutSummary({afterActions:{shifts}}).observedSessionMax<shifts.reduce((n,e)=>n+e.value,0));
  assert.equal(layoutSummary({afterActions:{shifts:[{startTime:1,value:0.9,hadRecentInput:true}]}}).observedSessionMax,0);
});

import {interactionFixture} from './helpers/interaction-fixture.mjs';
async function editInteraction(f,index,mutate){
  const entry=f.manifest.profiles[index],file=path.join(f.root,entry.file),p=JSON.parse(await readFile(file));
  mutate(p);await json(file,p);entry.hash=digest(await readFile(file));await json(path.join(f.root,'interactions.json'),f.manifest);
}
test('interaction acceptance rejects overlapping, incomplete and unexecuted captures',async t=>{
  const a=await interactionFixture(t),goal={kind:'interaction',target:'#buy',event:'click'};
  const cases={
    overlapping:p=>{p.finishedAt='2026-10-19T00:20:02.100Z';},
    actions:p=>{p.actions=[];},
    failedAction:p=>{p.actions=[{type:'click',selector:'#buy',status:'failed'}];},
    incompleteSource:p=>{p.snapshot.complete=false;},
    truncatedTrace:p=>{p.trace={truncated:true};},
    redirected:p=>{p.finalUrl='https://shop.example.test/account';},
    invalidEvent:p=>{p.afterActions.interactions[0].interactionId=-1;},
    impossiblePhases:p=>{p.afterActions.interactions[0].inputDelay=9999;},
    eventOutsideAction:p=>{p.afterActions.interactions[0].startTime=440;},
    cacheNotDisabled:p=>{p.environment.cache='enabled';},
    noWindow:p=>{delete p.interactionWindowStartMs;},
    textBoolean:p=>{p.sourceStable='false';},
    textApiSupport:p=>{p.afterActions.supported='event';},
  };
  for(const [label,mutate] of Object.entries(cases))await t.test(label,async()=>{
    const b=await interactionFixture(t,{after:true,duration:160});await editInteraction(b,0,mutate);
    const result=await verifyInteractions({before:a.root,after:b.root,goal});assert.equal(result.outcome,'invalid-evidence',JSON.stringify(result));
  });
  await t.test('manifest failures cannot be hidden behind complete status',async()=>{
    const b=await interactionFixture(t,{after:true,duration:160});b.manifest.counts={attempted:6,failed:1};
    await json(path.join(b.root,'interactions.json'),b.manifest);
    assert.equal((await verifyInteractions({before:a.root,after:b.root,goal})).outcome,'invalid-evidence');
  });
});
test('keyboard interaction goals use executed key actions and reject click-only evidence',async t=>{
  const a=await interactionFixture(t),b=await interactionFixture(t,{after:true,duration:160}),goal={kind:'interaction',target:'#buy',event:'keydown'};
  for(const f of [a,b]){
    f.manifest.config.profile.actions=[{type:'press',selector:'#buy',key:'Enter'}];
    for(let i=0;i<5;i++)await editInteraction(f,i,p=>{
      p.config.actions=structuredClone(f.manifest.config.profile.actions);p.actions=[{...p.config.actions[0],status:'completed',target:'#buy',startedAtMs:12,finishedAtMs:400}];p.afterActions.interactions[0].name='keydown';
    });
  }
  const result=await verifyInteractions({before:a.root,after:b.root,goal});assert.equal(result.outcome,'interaction-improved',result.error);
  await editInteraction(b,0,p=>{p.actions[0].type='click';delete p.actions[0].key;p.config.actions=[{type:'click',selector:'#buy'}];});
  assert.equal((await verifyInteractions({before:a.root,after:b.root,goal})).outcome,'invalid-evidence');
});
test('formal interaction comparison requires five independent, hashed, comparable source-bound captures',async t=>{
  const a=await interactionFixture(t),b=await interactionFixture(t,{after:true,duration:160});const goal={kind:'interaction',target:'#buy',event:'click'};
  const result=await verifyInteractions({before:a.root,after:b.root,goal});assert.equal(result.outcome,'interaction-improved',result.error);assert.equal(result.fieldINP,'not-established');
  assert.equal((await verifyInteractions({before:a.root,after:a.root,goal})).outcome,'invalid-evidence');
  const few=await interactionFixture(t,{after:true,duration:100,runs:3});assert.equal((await verifyInteractions({before:a.root,after:few.root,goal})).outcome,'invalid-evidence');
  await writeFile(path.join(b.root,b.manifest.profiles[0].file),'{}');await assert.rejects(readInteractionRun(b.root),/hash/);
  assert.throws(()=>validateInteractionConfig({schemaVersion:1,profile:a.manifest.config.profile,runs:4,deployment:a.manifest.config.deployment}),/5..10/);
  assert.throws(()=>validateInteractionConfig({schemaVersion:1,profile:{...a.manifest.config.profile,expectedThemeId:'999'},runs:5,deployment:a.manifest.config.deployment}),/theme IDs/);
});
test('interaction evidence rejects equivalent timestamps, unsupported APIs, changed hardware and escaped paths',async t=>{
  const a=await interactionFixture(t),goal={kind:'interaction',target:'#buy',event:'click'};
  async function edit(f,index,mutate){const entry=f.manifest.profiles[index],file=path.join(f.root,entry.file),p=JSON.parse(await readFile(file));mutate(p);await json(file,p);entry.hash=digest(await readFile(file));await json(path.join(f.root,'interactions.json'),f.manifest);}
  for(const mutate of [p=>{p.afterActions.supported=[];},p=>{p.environment.cpuCount=8;},p=>{p.afterActions.interactions=[];},p=>{p.finishedAt='2026-10-21T00:00:00Z';}]){
    const b=await interactionFixture(t,{after:true,duration:160});await edit(b,0,mutate);
    assert.equal((await verifyInteractions({before:a.root,after:b.root,goal})).outcome,'invalid-evidence');
  }
  const duplicate=await interactionFixture(t,{after:true,duration:160});
  await edit(duplicate,1,p=>{p.createdAt='2026-10-19T08:20:01+08:00';});
  const d=await verifyInteractions({before:a.root,after:duplicate.root,goal});assert.equal(d.outcome,'invalid-evidence');assert.match(d.error,/timestamps|overlap/);
  const escaped=await interactionFixture(t,{after:true,duration:160});escaped.manifest.profiles[0].file='../profile.json';await json(path.join(escaped.root,'interactions.json'),escaped.manifest);
  await assert.rejects(readInteractionRun(escaped.root),/path/);
  const linked=await interactionFixture(t,{after:true,duration:160}),file=path.join(linked.root,linked.manifest.profiles[0].file),copy=path.join(linked.root,'saved.json');
  await writeFile(copy,await readFile(file));await rm(file);await symlink(copy,file);await assert.rejects(readInteractionRun(linked.root),/symlink/);
});
test('interaction runner keeps partial attempts and refuses to measure an unverified preview',async t=>{
  const a=await interactionFixture(t),out=path.join(await temp(t),'run');let called=false;
  const config={schemaVersion:1,profile:a.manifest.config.profile,runs:5,deployment:a.manifest.config.deployment};
  const result=await measureInteractions({config,output:out,dependencies:{verifyDeployment:async()=>({status:'unverified'}),profileRuntime:async()=>{called=true;}}});
  assert.equal(result.status,'stopped');assert.equal(called,false);assert.equal(JSON.parse(await readFile(path.join(out,'interactions.json'))).status,'stopped');
  const failed=await measureInteractions({config,output:path.join(await temp(t),'failure'),dependencies:{verifyDeployment:async()=>a.manifest.deployment.before,profileRuntime:async()=>{throw new Error('Synthetic capture failure');}}});
  assert.equal(failed.counts.attempted,1);assert.equal(failed.counts.failed,1);assert.equal(failed.failures[0].attempt,1);
});
test('CI preserves original formal gates, rejects absent/same baselines and distinguishes loading gain',async t=>{
  const a=await siteRun(t,{devices:['mobile'],scores:{mobile:[85]}}),b=await siteRun(t,{devices:['mobile'],scores:{mobile:[85]},offset:20,augment:r=>{r.audits['largest-contentful-paint'].numericValue=1400;}});
  const config={schemaVersion:1,before:a.root,after:b.root,beforeRevision:'a'.repeat(40),afterRevision:'b'.repeat(40)};
  assert.equal((await checkCI(config)).outcome,'passed');assert.equal((await checkCI({...config,goal:{kind:'loading',metric:'lcp'}})).outcome,'passed');
  await assert.rejects(checkCI({...config,before:b.root}),/distinct/);
  const short=await siteRun(t,{devices:['mobile'],reports:3,offset:40});assert.equal((await checkCI({...config,after:short.root})).outcome,'not-passed');
  const high=await siteRun(t,{devices:['mobile'],scores:{mobile:[95]},offset:60});
  const lower=await siteRun(t,{devices:['mobile'],scores:{mobile:[80]},offset:80,augment:r=>{r.audits['largest-contentful-paint'].numericValue=1000;}});
  for(const goal of [{kind:'score'},{kind:'loading',metric:'lcp'}]){
    const checked=await checkCI({...config,before:high.root,after:lower.root,goal});
    assert.equal(checked.outcome,'not-passed');assert.equal(checked.scores.outcome,'performance-regressed');
  }
});
test('formal loading and interaction goals retain score, source, regression and visual requirements',async t=>{
  const ia=await interactionFixture(t),ib=await interactionFixture(t,{after:true,duration:160});
  const a=await siteRun(t,{devices:['mobile'],scores:{mobile:[85]},pages:[{id:'home',url:ia.manifest.config.profile.url}]}),
    b=await siteRun(t,{devices:['mobile'],scores:{mobile:[85]},offset:20,pages:[{id:'home',url:ib.manifest.config.profile.url}],augment:r=>{r.audits['largest-contentful-paint'].numericValue=1400;}});
  async function bind(nav,interaction){
    const original=interaction.manifest.deployment.before,pages=nav.manifest.config.pages.map(p=>({...p,status:'verified',themeId:original.themeId,store:original.store}));
    nav.manifest.startedAt='2026-10-15T00:00:00Z';nav.manifest.finishedAt='2026-10-20T00:00:00Z';
    nav.manifest.config.deployment=interaction.manifest.config.deployment;
    nav.manifest.deployment={before:{...original,pages,startedAt:'2026-10-15T00:01:00Z',finishedAt:'2026-10-15T00:02:00Z'},after:{...original,pages,startedAt:'2026-10-19T23:00:00Z',finishedAt:'2026-10-19T23:01:00Z'}};
    await saveManifest(nav);
  }
  await bind(a,ia);await bind(b,ib);
  const args={before:a.root,after:b.root,expectedSourceHash:ib.sourceHash,
    regression:regressionForRun(b,{steps:[{action:'click',selector:'#buy'},{action:'assert-text',selector:'#result',text:'Ready'}]}),
    review:{sourceHash:ib.sourceHash,contentPreserved:true,visualsPreserved:true,summary:'Synthetic protocol only'}};
  assert.equal((await verifyOptimization(args)).outcome,'not-accepted');
  const loading={...args,goal:{kind:'loading',metric:'lcp'}};
  assert.equal((await verifyOptimization(loading)).outcome,'optimization-accepted');
  assert.equal((await verifyOptimization({...loading,review:undefined})).outcome,'not-accepted');
  const interaction={...args,goal:{kind:'interaction',target:'#buy',event:'click'},interactionEvidence:{before:ia.root,after:ib.root}};
  const verified=await verifyOptimization(interaction);assert.equal(verified.outcome,'optimization-accepted',JSON.stringify(verified));
  assert.equal((await verifyOptimization({...interaction,regression:undefined})).outcome,'not-accepted');
  assert.equal((await verifyOptimization({...interaction,interactionEvidence:{before:ia.root,after:ia.root}})).outcome,'not-accepted');
  for(const mutate of [
    r=>{r.scenarios.runs[0].steps[0].selector='#other';},
    r=>{r.scenarios.runs[0].constrained=true;},
    r=>{r.scenarios.runs[0].steps[0].elapsedMs=null;},
    r=>{r.scenarios.sourceStable=false;},
  ]){
    const regression=structuredClone(interaction.regression);mutate(regression);
    assert.equal((await verifyOptimization({...interaction,regression})).outcome,'not-accepted');
  }
  const keyResult={...verified.interactions,goal:{kind:'interaction',target:'#buy',event:'keydown'},targetActions:[{type:'press',key:'Enter'}]};
  const keyScenario=structuredClone(interaction.regression.scenarios);
  assert.equal(interactionBehaviorCovered(keyResult,keyScenario,{sourceHash:ib.sourceHash,themeId:'2'}),false);
  Object.assign(keyScenario.runs[0].steps[0],{action:'press',key:'Enter'});
  assert.equal(interactionBehaviorCovered(keyResult,keyScenario,{sourceHash:ib.sourceHash,themeId:'2'}),true);
  keyScenario.runs[0].steps[0].key='Escape';assert.equal(interactionBehaviorCovered(keyResult,keyScenario,{sourceHash:ib.sourceHash,themeId:'2'}),false);
  const ci=await checkCI({schemaVersion:1,before:a.root,after:b.root,beforeRevision:'a'.repeat(40),afterRevision:'b'.repeat(40),goal:interaction.goal,interactionEvidence:interaction.interactionEvidence});
  assert.equal(ci.outcome,'passed');assert.ok(ci.checks.every(c=>c.pass));assert.match(renderReport(ci),/declared-interaction-gain-and-navigation-identity/);
  for(const nav of [a,b]){
    nav.manifest.config.deployment.store='another.myshopify.com';
    for(const proof of Object.values(nav.manifest.deployment)){proof.store='another.myshopify.com';proof.pages.forEach(p=>{p.store=proof.store;});}
    await saveManifest(nav);
  }
  assert.equal((await verifyOptimization(interaction)).outcome,'not-accepted');
  const wrongCI=await checkCI({schemaVersion:1,before:a.root,after:b.root,beforeRevision:'a'.repeat(40),afterRevision:'b'.repeat(40),goal:interaction.goal,interactionEvidence:interaction.interactionEvidence});
  assert.equal(wrongCI.outcome,'not-passed');assert.equal(wrongCI.checks.find(c=>c.id==='declared-interaction-gain-and-navigation-identity').pass,false);
});
test('CLI import/diagnosis/style/report and batch expose new evidence without source writes',async t=>{
  const project=await theme(t,{'sections/main.liquid':'{% stylesheet %}.own{color:red}{% endstylesheet %}<div class="own">Hi</div>'});
  const root=await temp(t),input=path.join(root,'field-input.json'),output=path.join(root,'field.json');await json(input,fieldInput());
  const run=(...args)=>spawnSync(process.execPath,['scripts/perfkit.mjs',...args],{cwd:wd,encoding:'utf8'});
  assert.equal(run('import-field','--input',input,'--out',output).status,0);
  assert.equal(run('import-field','--input',input,'--out',output).status,2);
  const css=run('audit-stylesheets','--project',project);assert.equal(css.status,0,css.stderr);
  const f=JSON.parse(await readFile(output));assert.match(renderReport(f),/真实用户数据/);
  const measurement=await siteRun(t,{devices:['mobile']});
  const b=await runBatch({config:{schemaVersion:1,project,run:measurement.root,resources:false,field:input,stylesheets:true,bottlenecks:{}},output:path.join(root,'batch')});
  assert.equal(b.status,'complete',JSON.stringify(b.error));assert.ok(b.steps.some(s=>s.command==='import-field'));assert.ok(b.steps.some(s=>s.command==='audit-stylesheets'));
  assert.equal(JSON.parse(await readFile(path.join(root,'batch/bottlenecks.json'))).decisionVersion,1);
});
test('shipped CI template consumes explicit artifacts, keeps inputs out of shell code and never syncs a theme',async()=>{
  const yaml=await readFile(new URL('../assets/examples/perfkit-ci.yml',import.meta.url),'utf8');
  assert.match(yaml,/workflow_call:/);assert.match(yaml,/contents: read/);assert.match(yaml,/download-artifact@v4/);
  assert.match(yaml,/BEFORE_REVISION: \$\{\{ inputs.before_revision \}\}/);
  assert.doesNotMatch(yaml,/pull_request_target|shopify theme (?:push|publish)/);
  const script=yaml.slice(yaml.indexOf('run: |',yaml.indexOf('Verify complete')));
  assert.doesNotMatch(script,/\$\{\{ inputs\.before_revision/);
  const goal=JSON.parse(await readFile(new URL('../assets/examples/loading-goal.json',import.meta.url)));
  assert.equal(goalContract(goal).metric,'lcp');
  const cfg=JSON.parse(await readFile(new URL('../assets/examples/interaction-measurement.json',import.meta.url)));
  assert.equal(validateInteractionConfig(cfg).runs,5);
});
