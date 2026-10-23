import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, cp } from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'acorn';
import { Liquid } from 'liquidjs';
import { indexThemeSources, associateScript, associateStylesheet, pathsToSource } from '../lib/source-attribution.mjs';
import { sourceSnapshot, sha256 } from '../lib/runtime-profile.mjs';
import { diagnoseBottlenecks } from '../lib/bottlenecks.mjs';
import {createOfficialPlan} from '../lib/official-plan.mjs';
import { createDemandPlan, freeReferences } from '../lib/demand-plan.mjs';
import { applySitePlan, rollbackSitePlan, createSitePlan } from '../lib/site-changes.mjs';
import { compareCheckpoints, verifyPreservation, preservationStyles } from '../lib/preservation.mjs';
import { verifyPatchExperiment, experimentHistoryGate, patchFingerprint, runPatchExperiment } from '../lib/patch-experiment.mjs';
import { siteRun, saveManifest, changeReport } from './helpers/site-run.mjs';
import { runBatch } from '../lib/batch.mjs';
import { verifyOptimization } from '../lib/optimize.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

export const widget = `function increment(n) { return n + 1; }
class ShopWidget extends HTMLElement {
  connectedCallback() {
    this.handler ??= () => { const output = this.querySelector('output'); output.textContent = String(increment(Number(output.textContent))); };
    this.querySelector('button').addEventListener('click', this.handler);
  }
  disconnectedCallback() { this.querySelector('button').removeEventListener('click', this.handler); }
}
customElements.define('shop-widget', ShopWidget);
window.sharedFeature = true;`;
const markup = '<shop-widget><button type="button">Open</button><output>0</output></shop-widget>';

async function theme(t, files = {}) {
  const project = await mkdtemp('/private/tmp/perfkit-demand-'); t.after(() => rm(project,{ recursive: true, force: true }));
  for (const [file,text] of Object.entries({ 'assets/main.js': widget, 'sections/widget.liquid': markup, 'templates/index.json': '{"sections":{"main":{"type":"widget"}}}',
    'layout/theme.liquid': '<head>\n{{ content_for_header }}\n<script src="{{ \'main.js\' | asset_url }}" defer></script></head><body>{{ content_for_layout }}</body>', ...files })) {
    await mkdir(path.dirname(path.join(project,file)),{ recursive: true }); await writeFile(path.join(project,file),text);
  }
  return project;
}
async function profile(project,{ css = false, device = 'mobile', actions = [], ranges = [] } = {}) {
  const snapshot = await sourceSnapshot(project), file = css ? 'assets/main.css' : 'assets/main.js', source = { status: 'verified-bytes', ...snapshot.files.find(f => f.file === file), line: 4 };
  return { kind: 'runtime-profile', status: 'complete', sourceStable: true, snapshot, config: { url: 'https://shop.example.test/',device,state: actions.length ? 'open' : 'initial',actions },
    cpu: css ? [] : [{ selfMs: 120, inclusiveMs: 200, functionName: 'connectedCallback', source, url: 'https://cdn.example.test/main.js' }],
    resources: [{ type: css ? 'Stylesheet' : 'Script', source, url: css ? 'https://cdn.example.test/main.css' : 'https://cdn.example.test/main.js', timestamp: 1, finishedTimestamp: 1.4 }],
    renderResources: css ? [{ tag: 'link', url: 'https://cdn.example.test/main.css', media: '' }] : [],
    coverage: { css: css ? [{ status: 'observed', sourceHash: source.sourceHash, url: 'https://cdn.example.test/main.css', ranges, totalBytes: 10000, usedBytes: 100 }] : [], js: [] }, lcp: { renderDelayMs: 500 } };
}
async function setupPlan(t) {
  const project = await theme(t), runtime = await profile(project), diagnosis = await diagnoseBottlenecks({ project,profiles: [runtime] });
  const config = { schemaVersion: 1, mode: 'component', source: 'assets/main.js', newAsset: 'assets/widget.js', component: 'shop-widget', candidateId: diagnosis.candidates[0].candidateId };
  const plan = await createDemandPlan({ project,config,diagnosis });
  return { project, runtime, diagnosis, config, plan };
}

test('source graph follows template, section, snippet and assets; dynamic edges stay unresolved', async t => {
  const project = await theme(t,{ 'sections/widget.liquid': "{% render 'card' %}{% render variable_name %}"+markup, 'snippets/card.liquid': '<script src="{{ \'main.js\' | asset_url }}" defer></script>' });
  const index = await indexThemeSources(project);
  assert.ok(pathsToSource(index,'assets/main.js').some(p => p.join(' > ') === 'templates/index.json > sections/widget.liquid > snippets/card.liquid > assets/main.js'));
  assert.ok(index.unresolved.some(u => u.reason === 'dynamic-liquid-reference'));
});

test('Shopify literal import maps resolve bare module aliases without guessing dynamic mappings',async t=>{
  const project=await theme(t,{'assets/main.js':'import { ready } from "vendor"; ready();','assets/vendor.js':'export function ready() {}','layout/theme.liquid':'<script type="importmap">{"imports":{"vendor":"{{ \'vendor.js\' | asset_url }}"}}</script>'});
  const index=await indexThemeSources(project); assert.ok(index.edges.some(e=>e.from==='assets/main.js'&&e.to==='assets/vendor.js'&&e.kind==='js-import-map'));
});

test('source mapping handles formatting and inline CPU locations; mangling, ASI and ambiguity cannot masquerade as exact source', async t => {
  const js = 'function burn() {\n return 42;\n}\nburn();';
  const inline = 'function inlined() { return 7; } inlined();';
  const project = await theme(t,{ 'assets/main.js': js, 'snippets/inline.liquid': '<div>Heading</div>\n<script>'+inline+'</script>' });
  const index = await indexThemeSources(project);
  assert.equal(associateScript(js,index,{ url: 'https://cdn/main.js',line: 2 }).line,2);
  const formatted = 'function burn(){return 42}burn();';
  const mapped = associateScript(formatted,index,{ url: 'https://cdn/main.js',column: formatted.indexOf('return')+1 });
  assert.equal(mapped.status,'verified-ast'); assert.equal(mapped.line,2);
  assert.equal(associateScript('function b(){return 42}b();',index,{ url: 'https://cdn/main.js' }).status,'unmapped');
  assert.equal(associateScript('function burn(){return\n42}burn();',index).status,'unmapped');
  const inlined = associateScript(inline,index,{ inline: true,line: 1 });
  assert.equal(inlined.file,'snippets/inline.liquid'); assert.equal(inlined.line,2);
  await writeFile(path.join(project,'snippets/duplicate.liquid'),'<script>'+inline+'</script>');
  assert.equal(associateScript(inline,await indexThemeSources(project),{ inline: true }).status,'ambiguous');
});

test('diagnosis ranks measured self cost without adding overlapping inclusive frames; unmapped and stale evidence remain visible', async t => {
  const project = await theme(t), p = await profile(project);
  p.cpu.push({ selfMs: 1200, inclusiveMs: 1600, url: 'https://third-party.test/app.js', source: { status: 'unmapped' } });
  const d = await diagnoseBottlenecks({ project,profiles: [p,p] });
  assert.equal(d.candidates.length,1); assert.equal(d.candidates[0].costMs,120);
  assert.ok(d.observations.some(o => o.controllability === 'requires-source-review'));
  p.snapshot.hash = '0'.repeat(64);
  const stale = await diagnoseBottlenecks({ project,profiles: [p] });
  assert.equal(stale.candidates.length,0); assert.equal(stale.status,'review-required');
});

test('component extraction moves a complete private dependency closure and renders a script only with the component', async t => {
  const { project,plan } = await setupPlan(t), before = await sourceSnapshot(project);
  await applySitePlan(plan,project);
  const main = await readFile(path.join(project,'assets/main.js'),'utf8'), extracted = await readFile(path.join(project,'assets/widget.js'),'utf8');
  assert.ok(!main.includes('function increment')); assert.ok(main.includes('window.sharedFeature'));
  assert.ok(extracted.includes('function increment')); assert.ok(extracted.includes("customElements.define('shop-widget'"));
  const liquid = new Liquid(); liquid.registerFilter('asset_url',v => '/assets/'+v);
  const section = await liquid.parseAndRender(await readFile(path.join(project,'sections/widget.liquid'),'utf8'));
  assert.equal(section.replace(/<script[\s\S]*?<\/script>/g,''),markup);
  await rollbackSitePlan(plan,project); assert.equal((await sourceSnapshot(project)).hash,before.hash);
});

test('dependency analysis preserves lexical scopes, parameter defaults and private state boundaries', async t => {
  const refs = freeReferences(parse('function f({x = helper()} = {}) { const local=1; return x+local+external; }',{ ecmaVersion:'latest' }).body[0]);
  assert.deepEqual([...refs].sort(),['external','helper']);
  for (const suffix of ['\nwindow.consumer = ShopWidget;', '\nfunction other(){ return increment(1); }']) {
    const project = await theme(t,{ 'assets/main.js': widget+suffix }), p = await profile(project), diagnosis = await diagnoseBottlenecks({ project,profiles:[p] });
    await assert.rejects(createDemandPlan({ project,diagnosis,config:{schemaVersion:1,mode:'component',source:'assets/main.js',newAsset:'assets/widget.js',component:'shop-widget',candidateId:diagnosis.candidates[0].candidateId} }),/another consumer/);
  }
  const f = await setupPlan(t); await writeFile(path.join(f.project,'assets/main.js'),widget+'\n// concurrent edit');
  await assert.rejects(createDemandPlan(f),/different source/);
});

test('a CPU hotspot on a different symbol on the same minified line cannot authorize component extraction',async t=>{
  const text=widget.replaceAll('\n',' ')+' function unrelatedWork(){ return 7; }', project=await theme(t,{'assets/main.js':text});
  const p=await profile(project); Object.assign(p.cpu[0].source,{line:1,column:text.indexOf('function unrelatedWork')+1});
  const diagnosis=await diagnoseBottlenecks({project,profiles:[p]});
  await assert.rejects(createDemandPlan({project,diagnosis,config:{schemaVersion:1,mode:'component',source:'assets/main.js',newAsset:'assets/widget.js',component:'shop-widget',candidateId:diagnosis.candidates[0].candidateId}}),/outside the measured CPU location/);
});

test('component extraction refuses global lookups, inline consumers and Liquid JavaScript dependencies',async t=>{
  for (const files of [
    {'assets/main.js':widget+'\nwindow.consumer = window.increment(1);'},
    {'assets/main.js':widget+'\nwindow.consumer = globalThis["increment"](1);'},
    {'snippets/consumer.liquid':'<script>window.consumer = new ShopWidget();</script>'},
    {'sections/widget.liquid':markup+'<button onclick="increment(1)">Other action</button>'},
    {'assets/consumer.js.liquid':'window.consumer = increment({{ settings.count | default: 1 }});'},
    {'snippets/factory.liquid':'<script>document.createElement("shop-widget");</script>'},
  ]) {
    const project=await theme(t,files), diagnosis=await diagnoseBottlenecks({project,profiles:[await profile(project)]});
    await assert.rejects(createDemandPlan({project,diagnosis,config:{schemaVersion:1,mode:'component',source:'assets/main.js',newAsset:'assets/widget.js',component:'shop-widget',candidateId:diagnosis.candidates[0].candidateId}}),/consumer.*review|consumer; review/,JSON.stringify(files));
  }
});

test('critical CSS uses coverage union, preserves the full original cascade and refuses single-state evidence', async t => {
  const css = '.hero { color: blue; }\n.menu { display: block; }\n'+Array.from({length:30},(_,i)=>`.unused-${i} { color: red; padding: 20px; }`).join('\n');
  const loader = '<link rel="stylesheet" href="{{ \'main.css\' | asset_url }}">';
  const project = await theme(t,{ 'assets/main.css':css,'snippets/css.liquid':loader });
  const profiles = [await profile(project,{css:true,ranges:[{start:0,end:21}]}),await profile(project,{css:true,device:'desktop',actions:[{type:'click',selector:'button'}],ranges:[{start:22,end:47}]})];
  const diagnosis = await diagnoseBottlenecks({project,profiles}), config = {schemaVersion:1,mode:'critical-css',source:'assets/main.css',newAsset:'assets/critical.css',loaderTarget:'snippets/css.liquid',tagStart:0,inlineLoadHandlerAllowed:true,candidateId:diagnosis.candidates.find(c=>c.kind==='render-resource').candidateId};
  await assert.rejects(createDemandPlan({project,diagnosis,config,profiles:profiles.slice(0,1)}),/single initial/);
  const plan = await createDemandPlan({project,diagnosis,config,profiles}); await applySitePlan(plan,project);
  assert.equal(await readFile(path.join(project,'assets/main.css'),'utf8'),css);
  const critical = await readFile(path.join(project,'assets/critical.css'),'utf8'); assert.ok(critical.includes('.hero')); assert.ok(critical.includes('.menu')); assert.ok(!critical.includes('.unused-29'));
  const loaded = await readFile(path.join(project,'snippets/css.liquid'),'utf8'); assert.ok(loaded.includes('<noscript>')); assert.ok(loaded.includes('media="print"'));
});

test('formatted CSS maps observed rule ranges to local positions; value changes remain unmapped', async t => {
  const css='.hero {\n color: blue;\n}\n.menu { display: none; }', project=await theme(t,{'assets/main.css':css}), index=await indexThemeSources(project);
  const remote='.hero{color:blue}.menu{display:none}';
  const result=associateStylesheet(remote,index,{url:'https://cdn/main.css',ranges:[{start:0,end:17}]});
  assert.equal(result.source.status,'verified-ast'); assert.equal(result.source.file,'assets/main.css');
  assert.equal(result.ranges.length,1); assert.ok(css.slice(result.ranges[0].start,result.ranges[0].end).includes('color: blue'));
  assert.equal(associateStylesheet(remote.replace('blue','red'),index).source.status,'unmapped');
});

test('Shopify stylesheet_tag preload is retained only on the generated critical stylesheet', async t => {
  const css='.hero { color: blue; }\n'+Array.from({length:20},(_,i)=>`.unused-${i} { padding: 20px; }`).join('\n');
  const source="<head>\n{{ content_for_header }}\n{{- 'main.css' | asset_url | stylesheet_tag: preload: true -}}\n</head>";
  const project=await theme(t,{'assets/main.css':css,'layout/theme.liquid':source});
  const profiles=[await profile(project,{css:true,ranges:[{start:0,end:21}]}),await profile(project,{css:true,device:'desktop',actions:[{type:'click',selector:'button'}],ranges:[{start:0,end:21}]})];
  const diagnosis=await diagnoseBottlenecks({project,profiles}), config={schemaVersion:1,mode:'critical-css',source:'assets/main.css',newAsset:'assets/critical.css',loaderTarget:'layout/theme.liquid',tagStart:source.indexOf("{{- 'main.css'"),inlineLoadHandlerAllowed:true,candidateId:diagnosis.candidates[0].candidateId};
  const plan=await createDemandPlan({project,profiles,diagnosis,config}); await applySitePlan(plan,project);
  const after=await readFile(path.join(project,'layout/theme.liquid'),'utf8');
  assert.ok(after.includes("'critical.css' | asset_url | stylesheet_tag: preload: true")); assert.equal((after.match(/stylesheet_tag/g)||[]).length,1);
  assert.ok(after.includes('{{ content_for_header }}')); await rollbackSitePlan(plan,project);
});

const checkpoint = () => ({version:1,content:[{tag:'BUTTON',text:['Buy'],attrs:[['type','button']]}],layout:[{rect:[0,0,100,30],styles:Object.fromEntries(preservationStyles.map(k=>[k,'fixture']))}]});
function regression(hash,themeId='1',url='https://shop.example.test/?preview_theme_id=1') {
  return {kind:'scenarios',sourceHash:hash,sourceStable:true,outcome:'passed',environment:{browserVersion:'fixture'},runs:[{name:'first-action',url,viewport:{name:'mobile',width:390,height:844,dpr:1},themeId,outcome:'passed',constrained:false,blockedRequests:[],pageErrors:[],steps:[
    {index:0,action:'click',selector:'button',times:1,outcome:'passed',elapsedMs:20},
    {index:1,action:'assert-text',selector:'output',text:'1',outcome:'passed',elapsedMs:10},
    {index:2,action:'checkpoint',key:'opened',selector:'body',outcome:'passed',observation:checkpoint()}
  ]}]};
}
test('preservation detects changed content, geometry, styles, missing interactions and blocked business writes', () => {
  assert.equal(compareCheckpoints(checkpoint(),checkpoint()).outcome,'preserved');
  const a=regression('a'.repeat(64)), b=regression('b'.repeat(64));
  const check = () => verifyPreservation({before:a,after:b,beforeSourceHash:a.sourceHash,afterSourceHash:b.sourceHash});
  assert.equal(check().outcome,'preserved');
  b.runs[0].steps[2].observation.layout[0].rect[2]+=2; assert.equal(check().outcome,'regressed');
  b.runs[0].steps[2].observation=checkpoint(); b.runs[0].steps[2].observation.content[0].text=['Changed']; assert.equal(check().outcome,'regressed');
  b.runs[0].steps[2].observation=checkpoint(); b.runs[0].blockedRequests.push({method:'POST'}); assert.equal(check().outcome,'invalid-evidence');
  b.runs[0].blockedRequests=[]; b.runs[0].steps[0].selector='different'; assert.equal(check().outcome,'invalid-evidence');
  b.runs[0].steps[0].selector='button'; b.runs[0].steps[1].elapsedMs=400; assert.equal(check().outcome,'invalid-evidence');
});
test('keyboard preservation compares press-to-assert timing and the actual declared key',()=>{
  const before=regression('a'.repeat(64)),after=regression('b'.repeat(64));
  for(const run of [before,after]){const step=run.runs[0].steps[0];step.action='press';step.key='Enter';delete step.times;}
  const check=()=>verifyPreservation({before,after,beforeSourceHash:before.sourceHash,afterSourceHash:after.sourceHash});
  assert.equal(check().outcome,'preserved');assert.ok(check().checks.some(c=>c.kind==='interaction-response'));
  after.runs[0].steps[0].key='Escape';assert.equal(check().outcome,'invalid-evidence');
  after.runs[0].steps[0].key='Enter';after.runs[0].steps[1].elapsedMs=500;assert.equal(check().outcome,'invalid-evidence');
});
test('readiness timing includes complete content assertions after a visible shell',()=>{
  const before=regression('a'.repeat(64)),after=regression('b'.repeat(64));
  for(const capture of [before,after]){
    capture.runs[0].steps.splice(2,0,{action:'assert-count',selector:'output > p',count:320,outcome:'passed',elapsedMs:5});
    capture.runs[0].steps.forEach((s,i)=>s.index=i);
  }
  const check=()=>verifyPreservation({before,after,beforeSourceHash:before.sourceHash,afterSourceHash:after.sourceHash});
  assert.equal(check().outcome,'preserved');after.runs[0].steps[2].elapsedMs=500;
  assert.equal(check().outcome,'invalid-evidence');assert.equal(check().checks.find(c=>c.kind==='interaction-response').afterMs,530);
});

async function proof(fixture,snapshot,project,themeId='1') {
  const declaration={project,store:'fixture.myshopify.com',themeId};
  const p={kind:'deployment-proof',status:'verified',scope:'theme-text-source',method:'shopify-cli-source-pull-and-browser-theme-id',...declaration,sourceHash:snapshot.hash,remoteSourceHash:snapshot.hash,sourceManifest:snapshot.files,
    pages:fixture.manifest.config.pages.map(page=>({...page,status:'verified',store:declaration.store,themeId}))};
  Object.assign(fixture.manifest,{startedAt:'2026-10-15T23:57:00Z',finishedAt:'2026-10-17T00:02:00Z',deployment:{before:{...p,startedAt:'2026-10-15T23:58:00Z',finishedAt:'2026-10-15T23:59:00Z'},after:{...p,startedAt:'2026-10-17T00:00:00Z',finishedAt:'2026-10-17T00:01:00Z'}}});
  fixture.manifest.config.deployment=declaration; await saveManifest(fixture);
}
test('single patch verifier requires exact source delta, target metric improvement and preserved states; warnings invalidate evidence', async t => {
  const f=await setupPlan(t), base=await sourceSnapshot(f.project); await applySitePlan(f.plan,f.project); const candidate=await sourceSnapshot(f.project);
  const before=await siteRun(t,{devices:['mobile'],scores:{mobile:[80]},augment:r=>{r.audits['total-blocking-time'].numericValue=300;}}),after=await siteRun(t,{devices:['mobile'],offset:20,scores:{mobile:[90]}});
  await proof(before,base,f.project); await proof(after,candidate,f.project);
  const args={plan:f.plan,diagnosis:f.diagnosis,candidateId:f.config.candidateId,before:before.root,after:after.root,regressionBefore:regression(base.hash),regressionAfter:regression(candidate.hash)};
  assert.equal((await verifyPatchExperiment(args)).outcome,'promising');
  for (const mismatch of [{page:'https://shop.example.test/products/other'},{device:'desktop'}]) {
    const wrongScope=structuredClone(f.diagnosis);Object.assign(wrongScope.candidates[0],mismatch);
    const rejected=await verifyPatchExperiment({...args,diagnosis:wrongScope});
    assert.equal(rejected.outcome,'invalid-evidence');assert.match(rejected.error,/page\/device/);
  }
  const interactionDiagnosis=structuredClone(f.diagnosis);
  Object.assign(interactionDiagnosis.candidates[0],{metric:'interaction',target:'#another',event:'click'});
  const wrongTarget=await verifyPatchExperiment({...args,diagnosis:interactionDiagnosis,goal:{kind:'interaction',target:'#buy',event:'click'}});
  assert.equal(wrongTarget.outcome,'invalid-evidence');assert.match(wrongTarget.error,/target\/event/);
  assert.match((await verifyOptimization({before:before.root,after:after.root,plan:f.plan})).error,/experiment evidence/);
  for(let i=0;i<5;i++) await changeReport(after,r=>{r.audits['total-blocking-time'].numericValue=300;},0,i);
  assert.equal((await verifyPatchExperiment(args)).outcome,'hypothesis-not-confirmed');
  for(let i=0;i<5;i++) await changeReport(after,r=>{r.audits['total-blocking-time'].numericValue=100;},0,i);
  args.regressionAfter.runs[0].steps[2].observation.layout[0].rect[0]=30;
  assert.equal((await verifyPatchExperiment(args)).outcome,'functional-regressed');
  args.regressionAfter=regression(candidate.hash);
  await changeReport(after,r=>{r.runWarnings=['Incomplete load'];}); assert.equal((await verifyPatchExperiment(args)).outcome,'invalid-evidence');
  await changeReport(after,r=>{r.runWarnings=[];});
  await writeFile(path.join(f.project,'assets/unrelated.js'),'window.unrelated=true;'); await proof(after,await sourceSnapshot(f.project),f.project);
  assert.match((await verifyPatchExperiment(args)).error,/unrelated/);
});

test('history stops repeat patches and consecutive inconclusive trials', async t => {
  const {plan}=await setupPlan(t), entry={kind:'patch-experiment-verification',fingerprint:patchFingerprint(plan),outcome:'no-measurable-gain'};
  assert.equal(experimentHistoryGate([entry],plan).reason,'candidate-already-tested');
  assert.equal(experimentHistoryGate([{...entry,fingerprint:'a'},{...entry,fingerprint:'b',outcome:'invalid-evidence'}],plan).reason,'consecutive-unproductive-experiments');
});

test('batch reuses saved runtime profiles and generates a source-bound demand plan without recapturing', async t => {
  const f=await setupPlan(t), run=await siteRun(t,{devices:['mobile']}), saved=path.join(run.root,'profile.json'); await writeFile(saved,JSON.stringify(f.runtime));
  const result=await runBatch({config:{schemaVersion:1,project:f.project,run:run.root,resources:false,bottlenecks:{profiles:[saved]},demand:f.config},output:path.join(f.project,'batch'),dependencies:{auditSite:async()=>({schemaVersion:1,kind:'site-audit',complete:true,supplemental:[]})}});
  assert.equal(result.status,'complete',JSON.stringify(result.error)); assert.ok(result.planHash); assert.ok(result.artifacts['bottlenecks.json']);
});

test('experiment runner alternates pair order, retains raw evidence and verifies one complete patch', async t => {
  const f=await setupPlan(t), base=await sourceSnapshot(f.project), candidateProject=await theme(t);
  await cp(f.project,candidateProject,{recursive:true});
  // Plan application itself is root-bound. Create an identical reviewable plan for the candidate checkout.
  const candidatePlan=await createSitePlan({project:candidateProject,recipe:{schemaVersion:1,changes:f.plan.changes.map(c=>({target:c.target,kind:c.recipeKind,replacementText:c.after,reason:c.reason,evidence:c.evidence}))}});
  await applySitePlan(candidatePlan,candidateProject); const candidate=await sourceSnapshot(candidateProject);
  const measurement=project=>({schemaVersion:1,engine:'lighthouse',pages:[{id:'home',url:'https://shop.example.test/?preview_theme_id=1'}],devices:['mobile'],deployment:{project,store:'fixture.myshopify.com',themeId:'1'}});
  const scenarios={schemaVersion:1,url:'https://shop.example.test/?preview_theme_id=1',viewports:[{name:'mobile',width:390,height:844}],scenarios:[{name:'first-action',steps:[{action:'click',selector:'button'},{action:'assert-text',selector:'output',text:'1'},{action:'checkpoint',selector:'body',key:'opened'}]}]};
  let samples=0, proofCalls=0;
  const result=await runPatchExperiment({config:{schemaVersion:1,plan:candidatePlan,diagnosis:f.diagnosis,candidateId:f.config.candidateId,before:measurement(f.project),after:measurement(candidateProject),regressionBefore:scenarios,regressionAfter:scenarios},output:path.join(f.project,'experiment'),dependencies:{
    runScenarios:async({config})=>regression(config.project===f.project?base.hash:candidate.hash),
    verifyDeployment:async({config,pages})=>{
      const snapshot=config.project===f.project?base:candidate, initial=proofCalls++<2;
      return {kind:'deployment-proof',status:'verified',scope:'theme-text-source',method:'shopify-cli-source-pull-and-browser-theme-id',...config,sourceHash:snapshot.hash,remoteSourceHash:snapshot.hash,sourceManifest:snapshot.files,
        pages:pages.map(p=>({...p,status:'verified',store:config.store,themeId:config.themeId})),startedAt:initial?'2026-10-15T23:58:00Z':'2026-10-17T00:00:00Z',finishedAt:initial?'2026-10-15T23:59:00Z':'2026-10-17T00:01:00Z'};
    },
    measureSite:async({config,output})=>{
      assert.equal(config.deployment,undefined);
      const isBefore=output.endsWith('-before');
      const sample=await siteRun(t,{devices:['mobile'],reports:1,scores:{mobile:[isBefore?80:90]},offset:++samples*5,augment:r=>{r.audits['total-blocking-time'].numericValue=isBefore?300:100;}});
      sample.manifest.config.purpose='exploration'; sample.manifest.config.runs=1;
      await saveManifest(sample); await cp(sample.root,output,{recursive:true});
      return {status:'complete',counts:{attempted:1,failed:0}};
    }
  }});
  assert.equal(result.status,'promising',JSON.stringify(result));
  assert.deepEqual(result.schedule.map(s=>s.side),['before','after','after','before','before','after']);
  assert.equal(result.formalAcceptance,'not-evaluated');
  assert.equal(proofCalls,4);
});

test('CLI source graph, diagnosis and generated plan are connected and use the current version',async t=>{
  const f=await setupPlan(t), cli=fileURLToPath(new URL('../scripts/perfkit.mjs',import.meta.url)), run=promisify(execFile);
  const file=name=>path.join(f.project,name);
  await writeFile(file('runtime.json'),JSON.stringify(f.runtime)); await writeFile(file('profiles.json'),JSON.stringify([file('runtime.json')])); await writeFile(file('demand.json'),JSON.stringify(f.config));
  await run(process.execPath,[cli,'source-graph','--project',f.project,'--out',file('graph.json')]);
  await assert.rejects(run(process.execPath,[cli,'diagnose-performance','--project',f.project,'--profiles',file('profiles.json'),'--out',file('diagnosis.json')]),{code:3});
  const diagnosis=JSON.parse(await readFile(file('diagnosis.json'),'utf8'));
  assert.ok(diagnosis.performance.issues.some(i=>i.reason==='lcp-presentation-unavailable-recapture'));
  assert.ok(diagnosis.candidates.length>0); // Existing source-bound candidates remain usable.
  await run(process.execPath,[cli,'plan-demand','--project',f.project,'--config',file('demand.json'),'--diagnosis',file('diagnosis.json'),'--out',file('plan.json')]);
  const plan=JSON.parse(await readFile(file('plan.json'),'utf8')); assert.equal(plan.changes.length,3);
  const doctor=JSON.parse((await run(process.execPath,[cli,'doctor'])).stdout); assert.equal(doctor.version,JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8')).version);
});

test('candidate identity preserves page/device scope and unified ranking uses highest repeated cost',async t=>{
  const {diagnoseUnified}=await import('../lib/decision-engine.mjs');
  const project=await theme(t),mobile=await profile(project),desktop=await profile(project,{device:'desktop'});
  const product=structuredClone(mobile);product.config.url='https://shop.example.test/products/widget';
  const repeated=structuredClone(mobile);repeated.cpu[0].selfMs=900;
  const diagnosis=await diagnoseUnified({project,profiles:[mobile,desktop,product,repeated],limit:20});
  assert.equal(diagnosis.candidates.length,3);assert.equal(new Set(diagnosis.candidates.map(c=>c.candidateId)).size,3);
  assert.equal(diagnosis.candidates.find(c=>c.device==='mobile'&&c.page===mobile.config.url).costMs,900);
});

test('CSS analysis counts states rather than URLs and uses exclusive coverage end offsets',async t=>{
  const css='.hero { color: blue; }\n.menu { display: block; }\n'+Array.from({length:30},(_,i)=>`.unused-${i} { color: red; padding: 20px; }`).join('\n');
  const project=await theme(t,{'assets/main.css':css,'snippets/css.liquid':'<link rel="stylesheet" href="{{ \'main.css\' | asset_url }}">'});
  const profiles=[await profile(project,{css:true,ranges:[{start:0,end:21}]}),await profile(project,{css:true,device:'desktop',actions:[{type:'click',selector:'button'}],ranges:[{start:0,end:21},{start:22,end:46}]})];
  const diagnosis=await diagnoseBottlenecks({project,profiles});
  const plan=await createDemandPlan({project,diagnosis,profiles,config:{schemaVersion:1,mode:'critical-css',source:'assets/main.css',newAsset:'assets/critical.css',loaderTarget:'snippets/css.liquid',tagStart:0,inlineLoadHandlerAllowed:true,candidateId:diagnosis.candidates[0].candidateId}});
  const analysis=plan.metadata.cssAnalysis;
  assert.equal(analysis.sharedRules.find(r=>r.selector==='.hero').usedInProfiles,2);
  assert.equal(analysis.pageSpecificRules.length,0);assert.ok(analysis.partialStateRules.some(r=>r.selector==='.menu'));
  assert.ok(!analysis.unusedRules.some(r=>r.selector==='.hero'));
});

test('FCP and Speed Index goals produce executable CSS plans and require their own measured gain',async t=>{
  const {diagnoseUnified}=await import('../lib/decision-engine.mjs');
  for (const metric of ['fcp','speedIndex']) {
    const css='.hero { color: blue; }\n'+Array.from({length:30},(_,i)=>`.unused-${i} { padding: 20px; }`).join('\n');
    const project=await theme(t,{'assets/main.css':css,'snippets/css.liquid':'<link rel="stylesheet" href="{{ \'main.css\' | asset_url }}">'});
    const profiles=[await profile(project,{css:true,ranges:[{start:0,end:21}]}),await profile(project,{css:true,device:'desktop',actions:[{type:'click',selector:'button'}],ranges:[{start:0,end:21}]})];
    const goal={kind:'loading',metric},diagnosis=await diagnoseUnified({project,profiles,goal});
    const c=diagnosis.candidates.find(c=>c.device==='mobile');assert.equal(c.metric,metric);
    const plan=await createDemandPlan({project,diagnosis,profiles,config:{schemaVersion:1,mode:'critical-css',source:'assets/main.css',newAsset:'assets/critical.css',loaderTarget:'snippets/css.liquid',tagStart:0,inlineLoadHandlerAllowed:true,candidateId:c.candidateId}});
    const base=await sourceSnapshot(project);await applySitePlan(plan,project);const candidate=await sourceSnapshot(project);
    const before=await siteRun(t,{devices:['mobile'],scores:{mobile:[85]}});
    const after=await siteRun(t,{devices:['mobile'],scores:{mobile:[85]},offset:20,augment:r=>{r.audits[metric==='fcp'?'first-contentful-paint':'speed-index'].numericValue-=500;}});
    await proof(before,base,project);await proof(after,candidate,project);
    const result=await verifyPatchExperiment({plan,diagnosis,candidateId:c.candidateId,before:before.root,after:after.root,goal,regressionBefore:regression(base.hash),regressionAfter:regression(candidate.hash)});
    assert.equal(result.outcome,'promising',JSON.stringify(result));assert.equal(result.gain.groups[0].metrics.score.gain,0);
    await rollbackSitePlan(plan,project);
    assert.equal((await diagnoseUnified({project,profiles,goal:{kind:'loading',metric:'cls'}})).candidates.length,0);
  }
});
