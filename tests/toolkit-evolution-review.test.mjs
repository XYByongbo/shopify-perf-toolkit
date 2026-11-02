import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {writeFile,readFile,cp} from 'node:fs/promises';
import {themeStepFixture} from './helpers/theme-step-fixture.mjs';
import {siteRun,regressionForRun} from './helpers/site-run.mjs';
import {proof} from './helpers/improvement-fixture.mjs';
import {sourceSnapshot} from '../lib/runtime-profile.mjs';
import {sha256} from '../lib/source-utils.mjs';
import {createSitePlan,applySitePlan} from '../lib/site-changes.mjs';
import {runOptimization,collectOptimizationEvidence,verifyOptimization} from '../lib/optimize.mjs';
import {checkResourceEquivalence} from '../lib/resource-equivalence.mjs';
import {resourceHealth,resourceIntelligence} from '../lib/resource-intelligence.mjs';
import {structureDependencies,applyOwnershipMappings,observationChanges} from '../lib/theme-governance.mjs';
import {candidatePriority} from '../lib/candidate-priority.mjs';
import {runBatch} from '../lib/batch.mjs';
import {auditPerformance} from '../lib/performance-audit.mjs';
import {buildThemeWorkflow} from '../lib/theme-workflow.mjs';
import {verifyPreservation,preservationStyles} from '../lib/preservation.mjs';

async function rehostFixture(t,replacement='https://new.test/a.js') {
  const old='https://old.test/a.js',next=replacement,hash='a'.repeat(64);
  const source=`<script id="loader" src="${old}"></script>`;
  const f=await themeStepFixture(t,{'sections/main.liquid':source});
  const plan=await createSitePlan({project:f.root,recipe:{schemaVersion:1,changes:[{target:'sections/main.liquid',kind:'liquid-rehost-resource',
    parameters:{tagStart:0,replacementUrl:next,originalBodyHash:hash,replacementBodyHash:hash},reason:'Synthetic equivalent bytes',
    evidence:{sourceHash:sha256(source),summary:'Synthetic scope',identicalResponseBytesReviewed:true,dependenciesReviewed:true,contentTypeReviewed:true,corsAndIntegrityReviewed:true}}]}});
  const a=structuredClone(f.runtime),b=structuredClone(a);
  a.resources=[{url:old,bodyHash:hash,status:200,mimeType:'application/javascript',method:'GET',timestamp:1,finishedTimestamp:2}];
  a.domainTargets=[{id:'loader',idCount:1,tag:'SCRIPT',attrs:{src:old}}];
  await applySitePlan(plan,f.root);b.snapshot=await sourceSnapshot(f.root);
  const advance=s=>new Date(Date.parse(s)+60000).toISOString();
  for(const k of ['createdAt','finishedAt'])b[k]=advance(b[k]);
  for(const k of ['startedAt','finishedAt'])b.domainProof[k]=advance(b.domainProof[k]);
  for(const side of ['before','after']){const d=b.domainProof[side];d.sourceHash=b.snapshot.hash;d.remoteSourceHash=b.snapshot.hash;d.sourceManifest=b.snapshot.files;for(const k of ['startedAt','finishedAt'])d[k]=advance(d[k]);}
  b.resources=[{...a.resources[0],url:next}];b.domainTargets=[{id:'loader',idCount:1,tag:'SCRIPT',attrs:{src:next}}];
  const identity=p=>({sourceHash:p.snapshot.hash,themeId:'1',store:p.domainProof.before.store});
  const groups=[{url:f.url,device:'mobile'}];
  return {...f,a,b,plan,identity,groups,valid:(a1=a,b1=b)=>checkResourceEquivalence(plan,{before:[a1],after:[b1]},identity(a1),identity(b1),groups)};
}

test('equivalence rejects wrong rendered target, unfinished/non-GET requests, skipped actions and unrelated patches',async t=>{
  const f=await rehostFixture(t);assert.equal(f.valid(),true);
  for(const mutate of [p=>p.domainTargets[0].id='unrelated',p=>delete p.resources[0].finishedTimestamp,p=>p.resources[0].method='POST',
    p=>p.resources[0].mimeType='image/png',p=>p.domainTargets[0].idCount=2,p=>{p.config.actions=[{type:'scroll',y:500}];},
    p=>{p.snapshot.files.push({file:'assets/unplanned.js',sourceHash:'f'.repeat(64)});p.snapshot.hash=sha256(JSON.stringify(p.snapshot.files));
      for(const side of ['before','after'])Object.assign(p.domainProof[side],{sourceHash:p.snapshot.hash,remoteSourceHash:p.snapshot.hash,sourceManifest:p.snapshot.files});}]) {
    const b=structuredClone(f.b);mutate(b);assert.equal(f.valid(f.a,b),false);
  }
});

test('optimize verify carries resource profiles and formal verification rejects dropped response evidence',async t=>{
  const f=await rehostFixture(t),pages=[{id:'home',url:f.url}];
  const before=await siteRun(t,{devices:['mobile'],pages,scores:{mobile:[50]}}),after=await siteRun(t,{devices:['mobile'],pages,scores:{mobile:[85]},offset:20});
  await proof(before,f.a.snapshot,f.root);await proof(after,f.b.snapshot,f.root);
  const planFile=path.join(f.root,'plan.json');await writeFile(planFile,JSON.stringify(f.plan));
  const behavior=regressionForRun(after),review={sourceHash:f.b.snapshot.hash,contentPreserved:true,visualsPreserved:true,summary:'Synthetic fixture review'};
  const config={schemaVersion:1,action:'verify',project:f.root,plan:planFile,reviewedPlanHash:f.plan.planHash,before:before.root,
    measurement:{...after.manifest.config,purpose:'acceptance'},scenarios:behavior.scenarios.config,review,exploreFirst:false,
    resourceProfiles:{before:[f.a],after:[f.b]}};
  let sampled=0;
  const dependencies={measureSite:async({output})=>{sampled++;await cp(after.root,output,{recursive:true});return {status:'complete',counts:{attempted:5,failed:0}};},
    runScenarios:async()=>behavior.scenarios,verifyDeployment:async()=>behavior.remote};
  const missing=await collectOptimizationEvidence({config:{...config,resourceProfiles:undefined},output:path.join(f.root,'missing'),dependencies});
  assert.equal(missing.status,'failed');assert.equal(sampled,0);assert.match(missing.error.message,/Equivalent resource/);
  const result=await runOptimization({config,output:path.join(f.root,'verified'),dependencies});
  assert.equal(result.status,'optimization-accepted',JSON.stringify(result));assert.equal(sampled,1);
  const regression=JSON.parse(await readFile(path.join(result.output,'regression-evidence.json'),'utf8'));assert.ok(regression.resourceProfiles);
  delete regression.resourceProfiles;
  const rejected=await verifyOptimization({...result.verificationInput,regression});
  assert.equal(rejected.checks.find(c=>c.id==='equivalent-resource-browser-responses').pass,false);assert.equal(rejected.outcome,'not-accepted');
});

test('CPU and static references are counted once, raw signed URLs cannot be joined by redacted value',async t=>{
  const f=await themeStepFixture(t,{'sections/main.liquid':'<p>Fixture</p>'}),url='https://assets.test/a.js?signature=first';
  f.runtime.resources=[{url},{url},{url:'https://assets.test/a.js?signature=second'}];f.runtime.cpu=[{url,selfMs:120}];
  const r=resourceIntelligence({snapshot:f.snapshot,profiles:[f.runtime],staticResources:[{url,references:[{file:'a'},{file:'b'}]}]}).captures[0];
  assert.equal(r.referenceCount,2);assert.equal(r.uniqueUrlCount,2);assert.equal(r.resourceGroups.reduce((n,g)=>n+g.cpuSelfMs,0),120);
  assert.equal(r.requests[2].references.length,0);assert.ok(r.requests.every(r=>r.cpuSelfMs===undefined));
});

test('malformed health is unknown and zero-height decoded images are not healthy',()=>{
  for(const h of [{},{version:1},{version:2,images:[]}])assert.equal(resourceHealth([{resourceHealth:h}])[0].status,'not-collected');
  assert.equal(resourceHealth([{resourceHealth:{version:1,images:[{complete:true,decoded:true,naturalWidth:10,naturalHeight:0}]}}])[0].status,'partial');
});

test('structure separates section/block IDs, ignores literal examples, and uses exact visible_if lookups',()=>{
  const source=`<script>const example="section.settings.title";</script>{{ block.settings.title }}{% schema %}{// supported schema comment
    "settings":[{"id":"title","type":"text"},{"id":"title_large","type":"text"},{"id":"show","type":"checkbox","visible_if":"{{ section.settings.title_large != blank }}"}],
    "blocks":[{"type":"row","settings":[{"id":"title","type":"text"}]}],}{% endschema %}`;
  const row=structureDependencies([{file:'sections/a.liquid',text:source}])[0];
  assert.equal(row.parseStatus,'parsed');assert.equal(row.settings[0].directReferences,0);assert.deepEqual(row.settings[0].visibleIfDependencies,[]);
  assert.equal(row.settings.at(-1).directReferences,1);assert.deepEqual(row.settings[1].visibleIfDependencies,['show']);
});

test('exhausted generators and stale ownership are not executable or reviewed',()=>{
  assert.equal(candidatePriority({eligible:true,methods:['image-priority'],remainingMethods:[],officialMethods:[{executor:'domain:image-priority'}]}).executable,false);
  assert.throws(()=>applyOwnershipMappings([{file:'x',sourceHash:'a'}],[{file:'x',sourceHash:'b',owner:'theme',evidence:'old'}]),/sourceHash/);
  assert.equal(observationChanges({kind:'performance-audit',project:'x',complete:true},{kind:'performance-audit',project:'x',complete:true}).status,'not-comparable');
});

test('batch passes ownership, checks and observation baseline into the real final audit',async t=>{
  const f=await themeStepFixture(t,{'sections/main.liquid':'<p>Fixture</p>'}),run=await siteRun(t,{devices:['mobile']});
  const baseline=await auditPerformance({project:f.root}),baseFile=path.join(f.root,'base.json');await writeFile(baseFile,JSON.stringify(baseline));
  const output=path.join(f.root,'batch'),input=path.join(f.root,'checks.json'),metadata=path.join(f.root,'metadata.json');
  await writeFile(input,JSON.stringify([{path:'sections/main.liquid',offenses:[]}]));
  await writeFile(metadata,JSON.stringify({tool:'synthetic',toolVersion:'1',scope:'whole-theme',positionBase:0,severityMap:{},rulesConfig:{effectiveConfiguration:'RemoteAsset:\n  severity: warning\n  enabled: false\n'},scannedFiles:['sections/main.liquid'],sourceHashes:{'sections/main.liquid':f.snapshot.files[0].sourceHash},complete:true}));
  const r=await runBatch({config:{schemaVersion:1,project:f.root,run:run.root,resources:false,performanceBaseline:baseFile,checks:{input,metadata},
    ownership:[{file:'sections/main.liquid',sourceHash:f.snapshot.files[0].sourceHash,owner:'theme',evidence:'Fixture review'}]},output});
  assert.equal(r.status,'complete',r.error?.message);
  const audit=JSON.parse(await readFile(path.join(output,'audit.json'),'utf8')).supplemental.find(s=>s.kind==='performance-audit').report;
  assert.equal(audit.intelligence.ownership[0].owner,'theme');assert.equal(audit.observationChanges.status,'same-observation-contract');assert.deepEqual(audit.intelligence.waivers.disabledRules,['RemoteAsset']);
});

test('font tasks enter workflow while resource failures on other pages remain visible without blocking this candidate',async t=>{
  const f=await themeStepFixture(t,{'sections/main.liquid':'<p>Fixture</p>'});
  f.runtime.resourceHealth={version:1,images:[{complete:true,decoded:false,url:'https://bad.test/a',selector:'#bad'}]};
  const flow=buildThemeWorkflow({snapshot:f.snapshot,profiles:[f.runtime],candidates:[{candidateId:'next',page:'https://fixture.myshopify.com/products/other',device:'mobile',methods:['image-priority']}],
    intelligence:{fonts:{reviewTasks:[{file:'sections/font.liquid',route:'liquid-font-display'}]}}});
  assert.equal(flow.next.action,'prepare-source-bound-patch');assert.equal(flow.unboundResourceIssues.length,1);assert.equal(flow.stages[3].reviewTasks.length,1);
});

test('plan preparation recomputes generator references and batch carries explicit ownership into plan',async t=>{
  const f=await themeStepFixture(t,{'sections/pf-page.liquid':"{% render 'card' %}",'snippets/card.liquid':'<p>Original</p>'});
  const recipe={schemaVersion:1,changes:[{target:'snippets/card.liquid',kind:'reviewed-replacement',replacementText:'<p>Changed</p>',reason:'Fixture',evidence:{summary:'Synthetic review'}}]};
  const plan=await createSitePlan({project:f.root,recipe});
  assert.equal(plan.ownership[0].status,'generator-referenced-candidate');assert.deepEqual(plan.ownership[0].generators,['sections/pf-page.liquid']);
  const run=await siteRun(t,{devices:['mobile']}),output=path.join(f.root,'with-plan');
  const r=await runBatch({config:{schemaVersion:1,project:f.root,run:run.root,resources:false,recipe,
    ownership:[{file:'snippets/card.liquid',sourceHash:sha256('<p>Original</p>'),owner:'theme',evidence:'Shared theme component review'}]},output});
  assert.equal(r.status,'complete',r.error?.message);
  const saved=JSON.parse(await readFile(path.join(output,'plan.json'),'utf8'));assert.equal(saved.ownership[0].owner,'theme');
});

test('URL preservation exception applies only to the planned node, not another identical URL',async t=>{
  const f=await rehostFixture(t),old=f.a.resources[0].url,next=f.b.resources[0].url;
  const point=changed=>({version:1,content:['loader','other'].map(id=>({tag:'SCRIPT',attrs:[['id',id],['src',id==='loader'||changed?next:old]],text:[],value:null,checked:null})),
    layout:['loader','other'].map(()=>({rect:[0,0,0,0],styles:Object.fromEntries(preservationStyles.map(k=>[k,'fixture']))}))});
  const beforePoint=point(false);beforePoint.content[0].attrs[1][1]=old;
  const scenario=(hash,observation)=>({kind:'scenarios',sourceHash:hash,sourceStable:true,outcome:'passed',environment:{browserVersion:'fixture'},runs:[{name:'same',url:f.url,viewport:{name:'mobile'},outcome:'passed',constrained:false,
    blockedRequests:[],pageErrors:[],steps:[{index:0,action:'assert-text',selector:'main',text:'Fixture',outcome:'passed'},{index:1,action:'checkpoint',selector:'main',key:'scope',observation,outcome:'passed'}]}]});
  const before=scenario(f.a.snapshot.hash,beforePoint),after=scenario(f.b.snapshot.hash,point(false));
  const config={before,after,beforeSourceHash:f.a.snapshot.hash,afterSourceHash:f.b.snapshot.hash,plan:f.plan};
  assert.equal(verifyPreservation(config).outcome,'preserved');
  after.runs[0].steps[1].observation=point(true);assert.equal(verifyPreservation(config).outcome,'regressed');
});

test('observation comparisons cannot hide lost runtime coverage and waiver YAML supports reordered properties',async()=>{
  const {waiverCoverage}=await import('../lib/theme-governance.mjs');
  assert.deepEqual(waiverCoverage({metadata:{rulesConfig:{effectiveConfiguration:'RemoteAsset:\n  severity: warning\n  enabled: false\n  ignore: []\nLiquidComplexity:\n  enabled: true\n'}}}).disabledRules,['RemoteAsset']);
  const base={kind:'performance-audit',project:'x',complete:true,observationComplete:true,observationContract:{version:2},findings:[],intelligence:{ownership:[]}};
  assert.equal(observationChanges({...base,observationComplete:false},base).status,'not-comparable');
});


test('missing rendered URL attribute cannot match the string undefined as a relative URL',async t=>{
  const f=await rehostFixture(t,'https://fixture.myshopify.com/undefined');assert.equal(f.valid(),true);
  delete f.b.domainTargets[0].attrs.src;assert.equal(f.valid(),false);
});

test('mult page equivalence permits proven unaffected pages but requires affected GET evidence somewhere',async t=>{
  const f=await rehostFixture(t),other='https://fixture.myshopify.com/pages/unaffected?preview_theme_id=1';
  const absent=p=>{const copy=structuredClone(p);copy.config.url=other;copy.finalUrl=other;copy.domainProof.url=other;
    for(const side of ['before','after'])copy.domainProof[side].pages=[{...copy.domainProof[side].pages[0],url:other}];
    copy.domainTargets=[];copy.resources=[];copy.domainTargetCoverage={version:1,selectorScope:'all-img-script-link-and-configured-targets',total:0,truncated:false};return copy;};
  const a=absent(f.a),b=absent(f.b),evidence={before:[f.a,a],after:[f.b,b]},groups=[...f.groups,{url:other,device:'mobile'}];
  assert.equal(checkResourceEquivalence(f.plan,evidence,f.identity(f.a),f.identity(f.b),groups),true);
  assert.equal(checkResourceEquivalence(f.plan,{before:[a],after:[b]},f.identity(f.a),f.identity(f.b),groups.slice(1)),false);
  b.domainTargetCoverage.truncated=true;assert.equal(checkResourceEquivalence(f.plan,evidence,f.identity(f.a),f.identity(f.b),groups),false);
});


test('resource audit resolves generated Liquid scripts and configuration references use exact paths without fake lines',async t=>{
  const {auditResources,analyzeResourceSource}=await import('../lib/resource-audit.mjs');
  const f=await themeStepFixture(t,{'sections/main.liquid':`<script src="{{ 'main.js' | asset_url }}"></script>`,'assets/main.js.liquid':'window.fixture = {{ settings.flag | json }};'});
  const result=await auditResources({project:f.root});assert.equal(result.scripts[0].assetStatus,'shopify-liquid-asset');assert.equal(result.scripts[0].assetSource,'assets/main.js.liquid');
  const refs=analyzeResourceSource('{"settings":{"image":"https://asset.test/a.png"}}','config/settings_data.json');
  assert.equal(refs.resources[0].line,null);assert.deepEqual(refs.resources[0].configurationPath,['settings','image']);
});

test('measured opaque resource costs become investigation tasks without masquerading as executable patches',async t=>{
  const f=await themeStepFixture(t,{'sections/main.liquid':'<p>Fixture</p>'}),url='https://external.test/widget.js';
  f.runtime.resources=[{url,type:'Script',timestamp:1,finishedTimestamp:1.3}];f.runtime.cpu=[{url,selfMs:80}];
  const resources=resourceIntelligence({snapshot:f.snapshot,profiles:[f.runtime]});
  const flow=buildThemeWorkflow({snapshot:f.snapshot,profiles:[f.runtime],intelligence:{resources}});
  const {renderReport}=await import('../lib/report.mjs'),{compactArtifact}=await import('../lib/summary.mjs');
  const output={schemaVersion:1,kind:'bottleneck-diagnosis',intelligence:{resources},workflow:flow,findings:[],candidates:[]};
  assert.match(renderReport(output),/工作流待补证据/);assert.equal(compactArtifact(output).workflow.next,'review-resource-cost-and-strategy');
  assert.equal(flow.next.action,'review-resource-cost-and-strategy');assert.equal(flow.next.tasks[0].action,'map-request-initiator');
  assert.equal(flow.next.tasks[0].estimatedSavings,null);assert.equal(flow.stages[4].candidates.length,0);assert.equal(flow.stages[4].reviewTasks.length,1);
});


test('precise patch check permits a declared new asset while still rejecting undeclared additions',async t=>{
  const f=await rehostFixture(t),hash=sha256('window.fixture=true;');
  f.plan.changes.push({target:'assets/approved.js',recipeKind:'create-asset',beforeHash:null,afterHash:hash});
  f.b.snapshot.files.push({file:'assets/approved.js',sourceHash:hash});f.b.snapshot.hash=sha256(JSON.stringify(f.b.snapshot.files));
  for(const side of ['before','after'])Object.assign(f.b.domainProof[side],{sourceHash:f.b.snapshot.hash,remoteSourceHash:f.b.snapshot.hash,sourceManifest:f.b.snapshot.files});
  assert.equal(f.valid(),true);
});
