import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {Liquid} from 'liquidjs';
import {sourceSnapshot,sha256} from '../lib/runtime-profile.mjs';
import {domainCandidates} from '../lib/domain-candidates.mjs';
import {validDomainProfile} from '../lib/domain-profile.mjs';
import {createDomainPlan} from '../lib/domain-plan.mjs';
import {createOfficialPlan} from '../lib/official-plan.mjs';
import {officialOptions} from '../lib/official-methods.mjs';
import {applySitePlan,rollbackSitePlan} from '../lib/site-changes.mjs';
import {requireHypothesis} from '../lib/bottlenecks.mjs';
import {analyzeLiquidProfile} from '../lib/liquid-profile.mjs';
import {verifyLiquidGain,runLiquidExperiment} from '../lib/liquid-experiment.mjs';
import {checkAppBehavior} from '../lib/optimization-regression.mjs';
import {remainingDomainMethods} from '../lib/recovery.mjs';
import {runImprovement} from '../lib/improvement-session.mjs';
import {siteRun,saveManifest} from './helpers/site-run.mjs';

const url='https://shop.example.test/?preview_theme_id=1';
export function bindDomain(p,snapshot,offset=0,themeId='1') {
  const time=n=>new Date(Date.UTC(2026,9,22,0,0,offset+n)).toISOString();
  const page=new URL(url);page.searchParams.set('preview_theme_id',themeId);
  const proof={kind:'deployment-proof',status:'verified',scope:'theme-text-source',method:'shopify-cli-source-pull-and-browser-theme-id',
    project:snapshot.project,
    sourceHash:snapshot.hash,remoteSourceHash:snapshot.hash,sourceManifest:snapshot.files,store:'fixture.myshopify.com',themeId,
    pages:[{id:'target',url:page.href,status:'verified',store:'fixture.myshopify.com',themeId}]};
  p.domainProof={version:1,url:page.href,startedAt:time(2),finishedAt:time(3),before:{...proof,startedAt:time(0),finishedAt:time(1)},after:{...proof,startedAt:time(4),finishedAt:time(5)}};
  p.project=snapshot.project;p.createdAt=time(2);p.finishedAt=time(3);
  return p;
}
async function setup(t,text) {
  const root=await mkdtemp('/private/tmp/perfkit-domain-');t.after(()=>rm(root,{recursive:true,force:true}));
  await mkdir(path.join(root,'sections'));await mkdir(path.join(root,'assets'));
  await writeFile(path.join(root,'sections/main.liquid'),text);
  const snapshot=await sourceSnapshot(root);
  const profile=bindDomain({kind:'runtime-profile',status:'complete',sourceStable:true,snapshot,themeId:'1',finalUrl:url,config:{url,device:'mobile',state:'initial',actions:[]},
    initial:{shifts:[],resizes:[]},domainTargets:[],resources:[],cpu:[]},snapshot);
  return {root,snapshot,profile,text};
}
const target=(id,attrs,extra={})=>({id,tag:'IMG',idCount:1,attrs,currentSrc:'https://shop.example.test/hero.svg',naturalWidth:800,naturalHeight:400,inPicture:false,
  rect:{top:0,left:0,width:390,height:195},viewport:{width:390,height:844},display:'block',position:'static',...extra});
function diagnosis(f,extra={}) {
  return {kind:'bottleneck-diagnosis',sourceHash:f.snapshot.hash,candidates:domainCandidates({files:[{file:'sections/main.liquid',text:f.text}],snapshot:f.snapshot,profiles:[f.profile],...extra})};
}
const plan=(f,d,c,method,review={})=>createDomainPlan({project:f.root,diagnosis:d,config:{schemaVersion:1,candidateId:c.candidateId,method,review:{summary:'Synthetic reviewed fixture',...review}},profiles:[f.profile]});

test('actual LCP id maps to one deployed img and generates distinct eager/priority patches',async t=>{
  const f=await setup(t,'<img id="hero" src="/hero.svg" loading="lazy" alt="Hero">');
  f.profile.domainTargets=[target('hero',{src:'/hero.svg',loading:'lazy'})];f.profile.initial.lcp={element:{id:'hero'},url:f.profile.domainTargets[0].currentSrc};
  const d=diagnosis(f),c=d.candidates[0];assert.equal(c.kind,'image-lcp');assert.equal(requireHypothesis(d,c.candidateId,f.snapshot),c);
  for(const mutate of [x=>x.binding.offset++,x=>x.kind='cpu',x=>x.page='https://other.test/']) {
    const altered=structuredClone(d);mutate(altered.candidates[0]);assert.throws(()=>requireHypothesis(altered,c.candidateId,f.snapshot));
  }
  const eager=await plan(f,d,c,'image-eager',{sharedInstancesReviewed:true});await applySitePlan(eager,f.root);
  assert.match(await readFile(path.join(f.root,c.file),'utf8'),/loading="eager"/);await rollbackSitePlan(eager,f.root);
  const priority=await plan(f,d,c,'image-priority',{sharedInstancesReviewed:true});assert.match(priority.changes[0].after,/fetchpriority="high"/);
  assert.notEqual(eager.planHash,priority.planHash);
  f.profile.domainProof.after.remoteSourceHash='0'.repeat(64);assert.equal(diagnosis(f).candidates.length,0);
});

test('image_tag uses parser arguments while preserving settings and responsive pipeline',async t=>{
  const text="{{ section.settings.image | image_url: width: 1600 | image_tag: id: 'hero', loading: 'lazy', widths: '400,800,1600' }}";
  const f=await setup(t,text);f.profile.domainTargets=[target('hero',{loading:'lazy'})];f.profile.initial.lcp={element:{id:'hero'},url:f.profile.domainTargets[0].currentSrc};
  const d=diagnosis(f),p=await plan(f,d,d.candidates[0],'image-priority',{sharedInstancesReviewed:true});
  assert.match(p.changes[0].after,/fetchpriority: "high"/);assert.match(p.changes[0].after,/widths: '400,800,1600'/);
});

test('ambiguous, loop-generated or unproved rendered identities never become executable',async t=>{
  for(const text of ['<img id="hero" src="/hero.svg"><img id="hero" src="/hero.svg">','{% for x in collection.products %}<img id="hero" src="/hero.svg">{% endfor %}',
    "{{ section.settings.image | image_url: width: 800 | image_tag: id: 'hero', loading: 'lazy', loading: 'lazy' }}",
    '<img id="hero" src="/hero.svg" src="/hero.svg">','<img id="hero" src="/hero.svg" {% if settings.lazy %}loading="lazy"{% endif %}>']) {
    const f=await setup(t,text);f.profile.domainTargets=[target('hero',{src:'/hero.svg'})];f.profile.initial.lcp={element:{id:'hero'},url:f.profile.domainTargets[0].currentSrc};
    assert.equal(diagnosis(f).candidates.length,0);
  }
});

test('CLS dimensions use measured intrinsic size only with a correlated image resize',async t=>{
  const f=await setup(t,'<img id="hero" src="/hero.svg" alt="Hero">');f.profile.domainTargets=[target('hero',{src:'/hero.svg'})];
  assert.equal(diagnosis(f).candidates.length,0);
  f.profile.initial.shifts=[{value:.2,startTime:510}];f.profile.initial.resizes=[{id:'hero',at:500,before:{height:0,top:0},after:{height:195}}];
  const d=diagnosis(f),c=d.candidates[0];assert.equal(c.kind,'image-cls');
  const p=await plan(f,d,c,'image-dimensions',{sharedInstancesReviewed:true,responsiveRatioReviewed:true});
  assert.match(p.changes[0].after,/width="800"/);assert.match(p.changes[0].after,/height="400"/);
  const alternative=await plan(f,d,c,'image-aspect-ratio',{sharedInstancesReviewed:true,responsiveRatioReviewed:true});assert.match(alternative.changes[0].after,/aspect-ratio: auto 800 \/ 400/);
  f.profile.domainTargets[0].inPicture=true;assert.equal(diagnosis(f).candidates.length,0);
});

test('third-party loader requires exact reviewed owner and explicit business contract',async t=>{
  const f=await setup(t,'<script src="https://widget.example.test/app.js"></script>');
  f.profile.domainTargets=[target('',{src:'https://widget.example.test/app.js'},{tag:'SCRIPT',currentSrc:'https://widget.example.test/app.js'})];
  f.profile.resources=[{url:'https://widget.example.test/app.js',type:'Script',timestamp:1,finishedTimestamp:1.4,bodyHash:sha256('app')}];
  assert.equal(diagnosis(f).candidates.length,0);
  const owners=[{id:'reviews',name:'Reviews',host:'widget.example.test',pathPrefix:'/app.js',purpose:'Reviews widget',evidence:'Fixture-owned script'}];
  const d=diagnosis(f,{owners}),c=d.candidates[0];assert.equal(c.kind,'app-loader');assert.equal(c.metric,'fcp');
  await assert.rejects(plan(f,d,c,'app-defer'),/dependenciesReviewed/);
  const review={dependenciesReviewed:true,nonCritical:true,documentWriteAbsent:true,businessEventsReviewed:true,businessAssertions:['#reviews']};
  const p=await plan(f,d,c,'app-defer',review);assert.match(p.changes[0].after,/ defer>/);assert.match(p.changes[0].after,/widget.example.test\/app.js/);
  await assert.rejects(plan(f,d,c,'app-async',review),/independentExecutionReviewed/);
});

function liquidProfile(snapshot,ms,offset=0,themeId='1') {
  const rawProfile={shared:{frames:[{name:'sections/main.liquid:2'}]},profiles:[{name:'Liquid',type:'sampled',unit:'milliseconds',startValue:0,endValue:ms,samples:[[0]],weights:[ms]}]};
  return bindDomain({kind:'liquid-profile',status:'complete',sourceSnapshot:snapshot,evidence:{origin:'shopify-cli',rawProfileHash:sha256(JSON.stringify(rawProfile)),collector:{kind:'shopify-cli',version:'4.9.4'},store:'fixture.myshopify.com',themeId,urlPath:'/?preview_theme_id='+themeId},
    rawProfile},snapshot,offset,themeId);
}
test('Liquid frame produces real cache patch with equivalent empty and populated rendering',async t=>{
  const text="{% for p in collection.products %}\n{% assign title = shop.name | upcase %}{{ title }}:{{ p.title }}\n{% endfor %}";
  const f=await setup(t,text),lp=liquidProfile(f.snapshot,30),d=diagnosis(f,{liquidProfile:lp}),c=d.candidates[0];
  assert.equal(c.kind,'liquid-hotspot');assert.equal(requireHypothesis(d,c.candidateId,f.snapshot),c);
  const p=await plan(f,d,c,'liquid-cache-loop-filter',{profileHotspotConfirmed:true,loopScopeReviewed:true});
  const liquid=new Liquid();for(const products of [[],[{title:'One'}],Array.from({length:25},(_,i)=>({title:String(i)}))]) {
    const data={shop:{name:'Example'},collection:{products}};assert.equal(await liquid.parseAndRender(text,data),await liquid.parseAndRender(p.changes[0].after,data));
  }
  await applySitePlan(p,f.root);const after=await sourceSnapshot(f.root);
  const evidence={kind:'liquid-experiment',status:'complete',before:[0,30,40].map(i=>liquidProfile(f.snapshot,30,i)),after:[10,20,50].map(i=>liquidProfile(after,10,i,'2')),
    schedule:[{round:1,side:'before'},{round:1,side:'after'},{round:2,side:'after'},{round:2,side:'before'},{round:3,side:'before'},{round:3,side:'after'}],counts:{attempted:6,failed:0}};
  const args={evidence,hypothesis:c,beforeIdentity:{sourceHash:f.snapshot.hash,store:'fixture.myshopify.com',themeId:'1'},afterIdentity:{sourceHash:after.hash,store:'fixture.myshopify.com',themeId:'2'}};
  assert.equal(verifyLiquidGain(args).outcome,'measurable-gain');
  for(const mutate of [
    p=>{p.rawProfile.profiles[0].weights=[1];},
    p=>{p.evidence.collector.version='4.9.5';},
    p=>{p.rawProfile.shared.frames[0].name='sections/other.liquid:2';p.evidence.rawProfileHash=sha256(JSON.stringify(p.rawProfile));},
    p=>{p.rawProfile.profiles[0].endValue=100;p.evidence.rawProfileHash=sha256(JSON.stringify(p.rawProfile));},
    p=>{p.kind='runtime-profile';},
    p=>{p.rawProfile.profiles.push(structuredClone(p.rawProfile.profiles[0]));p.evidence.rawProfileHash=sha256(JSON.stringify(p.rawProfile));},
    p=>{p.rawProfile.profiles[0]={name:'Liquid',type:'evented',unit:'milliseconds',startValue:0,endValue:100,events:[{type:'O',at:0,frame:0},{type:'C',at:10,frame:0}]};p.evidence.rawProfileHash=sha256(JSON.stringify(p.rawProfile));},
  ]) {
    const altered=structuredClone(evidence);mutate(altered.after[0]);
    assert.equal(verifyLiquidGain({...args,evidence:altered}).outcome,'invalid-evidence');
  }
assert.equal(verifyLiquidGain({...args,minSamples:5}).outcome,'invalid-evidence');
  evidence.after=[10,20,50].map(i=>liquidProfile(after,30,i,'2'));assert.equal(verifyLiquidGain(args).outcome,'no-measurable-gain');
  evidence.schedule.reverse();assert.equal(verifyLiquidGain(args).outcome,'invalid-evidence');evidence.schedule.reverse();
  evidence.before[1]=evidence.before[0];assert.equal(verifyLiquidGain(args).outcome,'invalid-evidence');
});

test('explicit unique selector binding enables an image without a literal id and rejects stale source',async t=>{
  const f=await setup(t,'<img class="hero" src="/hero.svg" loading="lazy">');
  const hash=f.snapshot.files.find(x=>x.file==='sections/main.liquid').sourceHash;
  f.profile.domainTargets=[target('',{src:'/hero.svg',loading:'lazy'},{isLCP:true,reviewedSelectors:['.hero']})];
  f.profile.initial.lcp={url:f.profile.domainTargets[0].currentSrc};
  assert.equal(diagnosis(f).candidates.length,0);
  f.profile.domainBindings=[{file:'sections/main.liquid',offset:0,sourceHash:hash,selector:'.hero',review:'Single hero element maps to this literal source tag'}];
  assert.equal(diagnosis(f).candidates[0].kind,'image-lcp');
  f.profile.domainBindings[0].sourceHash='0'.repeat(64);assert.equal(diagnosis(f).candidates.length,0);
});

test('app geometry reservation requires both viewport samples and stable heights',async t=>{
  const f=await setup(t,'<div id="reviews" data-app-container="reviews"></div>');
  f.profile.domainTargets=[target('reviews',{}, {tag:'DIV',rect:{top:0,left:0,width:390,height:250}})];
  f.profile.initial.shifts=[{value:.2,startTime:510}];f.profile.initial.resizes=[{id:'reviews',at:500,before:{height:0,top:0},after:{height:250}}];
  const d=diagnosis(f),c=d.candidates.find(c=>c.kind==='app-space'),config={schemaVersion:1,candidateId:c.candidateId,method:'app-reserve-space',breakpoint:750,
    review:{summary:'Fixed-height app at both existing theme breakpoints',allStatesReviewed:true,contentSizeStable:true,responsiveGeometryReviewed:true}};
  await assert.rejects(createDomainPlan({project:f.root,diagnosis:d,config,profiles:[f.profile]}),/mobile and desktop/);
  const desktop=structuredClone(f.profile);desktop.config.device='desktop';desktop.domainTargets[0].viewport.width=1440;desktop.domainTargets[0].rect.height=180;
  const p=await createDomainPlan({project:f.root,diagnosis:d,config,profiles:[f.profile,desktop]});
  assert.match(p.changes[0].after,/#reviews \{ min-height: 180px/);assert.match(p.changes[0].after,/max-width: 749px.*min-height: 250px/);
  const positioned=structuredClone(desktop);positioned.domainTargets[0].position='fixed';
  await assert.rejects(createDomainPlan({project:f.root,diagnosis:d,config,profiles:[f.profile,positioned]}),/normal flow/);
  const variable=structuredClone(f.profile);variable.domainTargets[0].rect.height=300;
  await assert.rejects(createDomainPlan({project:f.root,diagnosis:d,config,profiles:[f.profile,desktop,variable]}),/varies across states/);
});

test('app behavior gate rejects missing fetch, failed script and assertions without interaction',()=>{
  const plan={changes:[{evidence:{domainKind:'app-loader',domainPage:url,resourceUrl:'https://widget.test/app.js',resourceHash:sha256('app'),businessAssertions:['#reviews']}}]};
  const scenarios={runs:[{url,scriptResources:[{url:'https://widget.test/app.js',status:200,finished:true,bodyHash:sha256('app')}],steps:[{action:'click',outcome:'passed',assertionBefore:{action:'assert-text',selector:'#reviews',actual:'Closed',expected:'Ready'}},{action:'assert-text',selector:'#reviews',text:'Ready',outcome:'passed',observation:{actual:'Ready'}}]}]};
  assert.equal(checkAppBehavior(plan,scenarios),true);
  for(const mutate of [s=>s.scriptResources[0].bodyHash=sha256('changed'),s=>s.steps[0].assertionBefore.actual='Ready',s=>delete s.steps[1].observation]) {
    const copy=structuredClone(scenarios);mutate(copy.runs[0]);assert.equal(checkAppBehavior(plan,copy),false);
  }
  scenarios.runs[0].scriptResources[0].failed=true;assert.equal(checkAppBehavior(plan,scenarios),false);
  delete scenarios.runs[0].scriptResources[0].failed;scenarios.runs[0].steps.shift();assert.equal(checkAppBehavior(plan,scenarios),false);
});

test('nanosecond profiler units convert to milliseconds, never seconds',()=>{
  const raw={shared:{frames:[{name:'work'}]},profiles:[{type:'sampled',unit:'nanoseconds',startValue:0,endValue:5000000,samples:[[0]],weights:[5000000]}]};
  assert.equal(analyzeLiquidProfile(raw).totalSelfMs,5);
});

test('Liquid cache refuses overwritten loop metadata instead of generating a false first-iteration guard',async t=>{
  const f=await setup(t,"{% for p in collection.products %}\n{% assign title = shop.name | upcase %}{{ title }}{% assign forloop = false %}\n{% endfor %}");
  const d=diagnosis(f,{liquidProfile:liquidProfile(f.snapshot,30)}),c=d.candidates[0];assert.ok(c);
  await assert.rejects(plan(f,d,c,'liquid-cache-loop-filter',{profileHotspotConfirmed:true,loopScopeReviewed:true}),/loop metadata/);
});

test('session: missing review remains repairable; measured no gain rolls back and next changes actual image code',async t=>{
  const f=await setup(t,'<img id="hero" src="/hero.svg" loading="lazy">');
  f.profile.domainTargets=[target('hero',{src:'/hero.svg',loading:'lazy'})];f.profile.initial.lcp={element:{id:'hero'},url:f.profile.domainTargets[0].currentSrc};
  f.profile.initial.shifts=[{value:.2,startTime:510}];f.profile.initial.resizes=[{id:'hero',at:500,before:{height:0,top:0},after:{height:195}}];
  const baseline=await siteRun(t,{devices:['mobile'],scores:{mobile:[60]}}),p=f.profile.domainProof.before;
  Object.assign(baseline.manifest,{startedAt:'2026-10-15T00:00:00Z',finishedAt:'2026-10-18T00:00:00Z',deployment:{
    before:{...p,startedAt:'2026-10-15T00:00:01Z',finishedAt:'2026-10-15T00:00:02Z',pages:p.pages.map(x=>({...x,id:'home'}))},
    after:{...p,startedAt:'2026-10-17T00:00:00Z',finishedAt:'2026-10-17T00:00:01Z',pages:p.pages.map(x=>({...x,id:'home'}))}}});
  baseline.manifest.config.deployment={project:f.root,store:p.store,themeId:p.themeId};await saveManifest(baseline);
  const out=await mkdtemp('/private/tmp/perfkit-domain-session-');t.after(()=>rm(out,{recursive:true,force:true}));
  let state,i=0;
  const step=async config=>state=await runImprovement({config:{schemaVersion:1,...(state?{previous:path.join(state.output,'session.json')}:{project:f.root,run:baseline.root,profiles:[f.profile],budget:{maxCandidateRounds:6,maxFailures:8,maxAttempts:60}}),...config},output:path.join(out,String(i++)),
    dependencies:{runPatchExperiment:async({output})=>({output,status:'no-measurable-gain',verification:{outcome:'no-measurable-gain'},counts:{attempted:6,failed:0}})}});
  await step({action:'start'});assert.equal(state.error,undefined);
  const recovery=JSON.parse(await readFile(state.recovery,'utf8')),c=recovery.candidates.find(c=>c.kind==='image-lcp');assert.ok(c);
  const prepare=review=>step({action:'prepare',candidateId:c.candidateId,method:'next',rationale:'Test loading discovery before testing resource priority',domain:{schemaVersion:1,review}});
  await prepare({summary:'Missing shared instance review'});assert.match(state.error.message,/sharedInstancesReviewed/);
  await step({action:'prepare',candidateId:c.candidateId,method:'never-lazy-load-lcp-image/domain:image-eager',rationale:'Official loading mechanism on measured LCP',official:{schemaVersion:1,candidateId:c.candidateId,methodId:'never-lazy-load-lcp-image',executor:'domain:image-eager',review:{sourceHash:c.source.sourceHash,summary:'Single fixture instance',sharedInstancesReviewed:true}}});assert.equal(state.error,undefined);assert.equal(state.active.method,'image-eager');
  await step({action:'apply',reviewedPlanHash:state.active.planHash});assert.match(await readFile(path.join(f.root,'sections/main.liquid'),'utf8'),/loading="eager"/);
  const side=id=>({schemaVersion:1,engine:'lighthouse',devices:['mobile'],pages:[{id:'home',url}],deployment:{project:f.root,store:p.store,themeId:id}});
  await step({action:'experiment',experiment:{schemaVersion:1,before:side('1'),after:side('2')}});
  assert.equal(state.error,undefined);assert.equal(state.active,null);assert.equal(state.history.at(-1).outcome,'no-measurable-gain');assert.equal(await readFile(path.join(f.root,'sections/main.liquid'),'utf8'),f.text);
  await prepare({summary:'Single fixture instance; next test additionally raises fetch priority',sharedInstancesReviewed:true});
  assert.equal(state.error,undefined);assert.equal(state.active.method,'image-priority');
  assert.match(JSON.parse(await readFile(state.active.plan,'utf8')).changes[0].after,/fetchpriority="high"/);
  for(const method of ['image-priority','image-dimensions','image-aspect-ratio']) {
    assert.equal(state.active.method,method);
    await step({action:'apply',reviewedPlanHash:state.active.planHash});
    await step({action:'experiment',experiment:{schemaVersion:1,before:side('1'),after:side('2')}});
    assert.equal(state.error,undefined);assert.equal(await readFile(path.join(f.root,'sections/main.liquid'),'utf8'),f.text);
    if(method!=='image-aspect-ratio') {
      await step({action:'prepare',candidateId:'next',method:'next',rationale:'Change method or candidate after measured no gain',domain:{schemaVersion:1,review:{summary:'Reviewed fixture image ratio and single instance',sharedInstancesReviewed:true,responsiveRatioReviewed:true}}});
      assert.equal(state.error,undefined);assert.notEqual(state.active.candidateId,c.candidateId);
    }
  }
  assert.equal(state.status,'investigation-required');assert.equal(state.nextDomainStep,null);
  await step({action:'prepare',candidateId:'next',method:'next',rationale:'No supported method should remain',domain:{schemaVersion:1,review:{summary:'Exhaustion'}}});
  assert.equal(state.error.code,'NO_UNTESTED_DOMAIN_METHOD');
});


test('structurally unsupported image methods are excluded while missing review remains repairable',async t=>{
  const f=await setup(t,'<img id="hero" src="{{ section.settings.image | image_url: width: 800, height: 400, crop: \'center\' }}">');
  f.profile.domainTargets=[target('hero',{})];f.profile.initial.shifts=[{value:.2,startTime:510}];
  f.profile.initial.resizes=[{id:'hero',at:500,before:{height:0,top:0},after:{height:195}}];
  const d=diagnosis(f),c=d.candidates[0];assert.ok(c);
  const failures=[];
  for(const method of c.methods) {
    let error;try{await plan(f,d,c,method,{sharedInstancesReviewed:true,responsiveRatioReviewed:true});}catch(e){error=e;}
    assert.equal(error?.code,'UNSUPPORTED_CODE_PATTERN');
    failures.push({baselineHash:f.snapshot.hash,candidateId:c.candidateId,method,code:error.code});
  }
  assert.deepEqual(remainingDomainMethods(c,f.snapshot.hash,[],failures),[]);
  assert.deepEqual(remainingDomainMethods(c,f.snapshot.hash,[],[{...failures[0],code:'REVIEW_REQUIRED'}]),c.methods);
});


test('Liquid collection caps both deployment stages and profile capture to remaining shared budget',async t=>{
  const root=await mkdtemp('/private/tmp/perfkit-liquid-budget-');t.after(()=>rm(root,{recursive:true,force:true}));
  const captured=[],config={schemaVersion:1,before:{deployment:{timeoutMs:120000}},after:{deployment:{timeoutMs:120000}},runs:3,budget:{maxWallTimeMs:6000}};
  const result=await runLiquidExperiment({config,output:path.join(root,'run'),dependencies:{profileDomain:async({config})=>{captured.push(config);return {kind:'synthetic-only'};}}});
  assert.equal(result.status,'complete');assert.equal(captured.length,6);
  assert.ok(captured.every(c=>c.deployment.timeoutMs<=2000&&c.profile.timeoutMs<=2000));
  const stopped=await runLiquidExperiment({config:{...config,budget:{maxWallTimeMs:2000}},output:path.join(root,'short'),dependencies:{profileDomain:async()=>{throw new Error('must stop before capture');}}});
  assert.equal(stopped.status,'invalid-evidence');assert.equal(stopped.counts.attempted,0);
});

test('app experiment verifier requires comparable navigation, bracketed UI and unchanged remote script bytes',async t=>{
  // Synthetic LHR and deployment records exercise verifier contracts, not store performance.
  const f=await setup(t,'<script src="https://widget.example.test/app.js"></script>'),resourceUrl='https://widget.example.test/app.js',resourceHash=sha256('app');
  f.profile.domainTargets=[target('',{src:resourceUrl},{tag:'SCRIPT',currentSrc:resourceUrl})];
  f.profile.resources=[{url:resourceUrl,type:'Script',timestamp:1,finishedTimestamp:1.4,bodyHash:resourceHash}];
  const d=diagnosis(f,{owners:[{id:'reviews',name:'Reviews',host:'widget.example.test',pathPrefix:'/app.js',purpose:'Reviews',evidence:'Synthetic fixture'}]}),c=d.candidates[0];
  const p=await plan(f,d,c,'app-defer',{dependenciesReviewed:true,nonCritical:true,documentWriteAbsent:true,businessEventsReviewed:true,businessAssertions:['#reviews']});
  await applySitePlan(p,f.root);const afterSnapshot=await sourceSnapshot(f.root);
  const before=await siteRun(t,{devices:['mobile'],scores:{mobile:[60]}}),after=await siteRun(t,{devices:['mobile'],offset:30,scores:{mobile:[80]},augment:r=>{r.audits['first-contentful-paint'].numericValue=500;}});
  for(const [fixture,snapshot,id] of [[before,f.snapshot,'1'],[after,afterSnapshot,'2']]) {
    const proof=bindDomain({},snapshot,0,id).domainProof.before;
    proof.pages=[{id:'home',url,status:'verified',store:proof.store,themeId:id,assets:[{url:resourceUrl,bodyHash:resourceHash}]}];
    Object.assign(fixture.manifest,{startedAt:'2026-10-15T00:00:00Z',finishedAt:'2026-10-18T00:00:00Z',deployment:{
      before:{...proof,startedAt:'2026-10-15T00:00:01Z',finishedAt:'2026-10-15T00:00:02Z'},
      after:{...proof,startedAt:'2026-10-17T00:00:00Z',finishedAt:'2026-10-17T00:00:01Z'}}});
    fixture.manifest.config.deployment={project:f.root,store:proof.store,themeId:id};await saveManifest(fixture);
  }
  const {preservationStyles}=await import('../lib/preservation.mjs'),{verifyPatchExperiment}=await import('../lib/patch-experiment.mjs');
  const scenario=(snapshot,themeId)=>({kind:'scenarios',sourceHash:snapshot.hash,sourceStable:true,outcome:'passed',createdAt:'2026-10-16T00:00:00Z',finishedAt:'2026-10-16T00:00:01Z',environment:{browserVersion:'synthetic'},runs:[{
    name:'reviews',url,finalUrl:url,store:'fixture.myshopify.com',themeId,documentStable:true,viewport:{name:'mobile',width:390,height:844,dpr:1},outcome:'passed',constrained:false,blockedRequests:[],pageErrors:[],
    scriptResources:[{url:resourceUrl,bodyHash:resourceHash,status:200,finished:true}],steps:[
      {index:0,action:'click',selector:'#open',outcome:'passed',elapsedMs:10,assertionBefore:{action:'assert-text',selector:'#reviews',actual:'Closed',expected:'Ready'}},
      {index:1,action:'assert-text',selector:'#reviews',text:'Ready',outcome:'passed',elapsedMs:10,observation:{actual:'Ready',expected:'Ready'}},
      {index:2,action:'checkpoint',selector:'main',key:'reviews',outcome:'passed',observation:{version:1,content:[{tag:'MAIN',text:['Ready']}],layout:[{rect:[0,0,100,30],styles:Object.fromEntries(preservationStyles.map(k=>[k,'fixture']))}]}}
    ]}]});
  const args={plan:p,diagnosis:d,candidateId:c.candidateId,before:before.root,after:after.root,regressionBefore:scenario(f.snapshot,'1'),regressionAfter:scenario(afterSnapshot,'2')};
  let result=await verifyPatchExperiment(args);assert.equal(result.outcome,'promising',JSON.stringify(result));
  const late=structuredClone(args.regressionBefore);late.createdAt='2026-10-19T00:00:00Z';late.finishedAt='2026-10-19T00:00:01Z';
  result=await verifyPatchExperiment({...args,regressionBefore:late});assert.equal(result.outcome,'invalid-evidence');assert.match(result.error,/bracketed/);
  after.manifest.deployment.after.pages[0].assets[0].bodyHash=sha256('changed');await saveManifest(after);
  result=await verifyPatchExperiment(args);assert.equal(result.outcome,'invalid-evidence');assert.match(result.error,/script bytes/);
});


test('official image plan binds the measured node, retains domain gates and applies actual code',async t=>{
  const text="{{ section.settings.image | image_url: width: 800 | image_tag: id: 'hero', loading: 'lazy' }}\n{{ section.settings.other | image_url: width: 800 | image_tag: id: 'other' }}";
  const f=await setup(t,text);f.profile.domainTargets=[target('hero',{loading:'lazy'})];f.profile.initial.lcp={element:{id:'hero'},url:f.profile.domainTargets[0].currentSrc};
  const d=diagnosis(f),c=d.candidates[0],config={schemaVersion:1,candidateId:c.candidateId,methodId:'never-lazy-load-lcp-image',executor:'site:liquid-image-tag-loading',parameters:{outputStart:0,loading:'eager'},
    review:{sourceHash:c.source.sourceHash,summary:'Synthetic deployed LCP fixture',sharedInstancesReviewed:true,initialPlacementConfirmed:true,isLCP:true,inViewport:true,domainKind:'forged'}};
  const p=await createOfficialPlan({project:f.root,diagnosis:d,config,profiles:[f.profile]});
  assert.match(p.changes[0].after,/loading: [\'"]eager[\'"]/);assert.equal(p.changes[0].evidence.domainKind,'image-lcp');assert.equal(p.changes[0].evidence.domainPage,url);
  for(const parameters of [{outputStart:text.indexOf('\n')+1,loading:'eager'},{outputStart:0,loading:'lazy'}])await assert.rejects(createOfficialPlan({project:f.root,diagnosis:d,config:{...config,parameters}}),{code:'OFFICIAL_TARGET_MISMATCH'});
  assert.ok(!officialOptions(c).some(o=>/liquid-defer-script|liquid-cache/.test(o.executor)));
});

test('official Liquid routing cannot substitute another assign on the same source file',async t=>{
  const text="{% for p in collection.products %}\n{% assign title = shop.name | upcase %}{{ title }}\n{% assign other = shop.name | downcase %}{{ other }}\n{% endfor %}";
  const f=await setup(t,text),d=diagnosis(f,{liquidProfile:liquidProfile(f.snapshot,30)}),c=d.candidates[0];
  const config={schemaVersion:1,candidateId:c.candidateId,methodId:'move-operations-outside-loops',executor:'site:liquid-cache-loop-filter',parameters:{assignStart:c.binding.offset},
    review:{sourceHash:c.source.sourceHash,summary:'Raw Liquid fixture hotspot',loopScopeReviewed:true,profileHotspotConfirmed:true,domainKind:'forged'}};
  const p=await createOfficialPlan({project:f.root,diagnosis:d,config});assert.equal(p.changes[0].evidence.domainKind,'liquid-hotspot');assert.notEqual(p.changes[0].after,text);
  await assert.rejects(createOfficialPlan({project:f.root,diagnosis:d,config:{...config,parameters:{assignStart:text.indexOf('{% assign other')}}}),{code:'OFFICIAL_TARGET_MISMATCH'});
});

test('official App route retains script bytes and mandatory business evidence',async t=>{
  const f=await setup(t,'<script src="https://widget.example.test/app.js"></script>');
  f.profile.domainTargets=[target('',{src:'https://widget.example.test/app.js'},{tag:'SCRIPT',currentSrc:'https://widget.example.test/app.js'})];
  f.profile.resources=[{url:'https://widget.example.test/app.js',type:'Script',timestamp:1,finishedTimestamp:1.4,bodyHash:sha256('app')}];
  const d=diagnosis(f,{owners:[{id:'reviews',name:'Reviews',host:'widget.example.test',pathPrefix:'/app.js',purpose:'Reviews',evidence:'Fixture'}]}),c=d.candidates[0];
  const config={schemaVersion:1,candidateId:c.candidateId,methodId:'remove-render-blocking-apps',executor:'domain:app-defer',review:{sourceHash:c.source.sourceHash,summary:'Fixture',dependenciesReviewed:true,nonCritical:true,documentWriteAbsent:true,businessEventsReviewed:true,businessAssertions:['#reviews']}};
  const p=await createOfficialPlan({project:f.root,diagnosis:d,config});assert.equal(p.changes[0].evidence.resourceHash,sha256('app'));assert.equal(p.changes[0].evidence.domainKind,'app-loader');
  await assert.rejects(createOfficialPlan({project:f.root,diagnosis:d,config:{...config,review:{...config.review,businessAssertions:[]}}}));
  await assert.rejects(createOfficialPlan({project:f.root,diagnosis:d,config:{...config,executor:'site:liquid-defer-script'}}));
});
