import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {readFile,writeFile,mkdir,cp,rm} from 'node:fs/promises';
import {collectOptimizationEvidence,verifyOptimization} from '../lib/optimize.mjs';
import {hypothesisKey} from '../lib/recovery.mjs';
import {runRecoveryCycle,reviewedPlanContent,selectRecoveryOption} from '../lib/recovery-cycle.mjs';
import {runImprovement,readImprovementSession} from '../lib/improvement-session.mjs';
import {createSitePlan} from '../lib/site-changes.mjs';
import {sourceSnapshot,sha256} from '../lib/runtime-profile.mjs';
import {hashSession} from '../lib/improvement-state.mjs';
import {verifyPatchExperiment} from '../lib/patch-experiment.mjs';
import {siteRun,regressionForRun} from './helpers/site-run.mjs';
import {setup,proof,regression,read,experimentConfig,freshRuntime} from './helpers/improvement-fixture.mjs';

// Synthetic measurement contracts; source generation/application/rollback and verification are real.
async function fixture(t,{budget={},resourceBudget,firstPromising=false,formalScores=[90],resourceCounts}={}) {
  const f=await setup(t,{maxCandidateRounds:4,maxAttempts:40,...budget});
  const original='function heavy(){let n=0;for(let i=0;i<1000000;i++)n+=i;return 1;}';
  await writeFile(path.join(f.project,'assets/main.js'),original);
  await proof(f.baseline,await sourceSnapshot(f.project),f.project);
  const start=await f.step({action:'start',...(resourceBudget?{resourceBudget}:{})});
  const c=(await read(start.recovery)).candidates[0],snapshot=await sourceSnapshot(f.project);
  const options=[];
  for(const [i,text] of [original+' // negative control','function heavy(){return 1;}'].entries()) {
    const recipe={schemaVersion:1,changes:[{kind:'reviewed-replacement',target:'assets/main.js',replacementText:text,
      reason:i?'Eliminate unused loop; retain output.':'Negative control: unchanged work.',evidence:{summary:'Synthetic CPU fixture',candidateId:c.candidateId,diagnosisSourceHash:start.baselineHash}}]};
    const reviewed=await createSitePlan({project:f.project,recipe}),reviewFile=path.join(f.root,`review-${i}.json`);
    await writeFile(reviewFile,JSON.stringify(reviewed));
    const files=snapshot.files.map(x=>x.file==='assets/main.js'?{...x,sourceHash:reviewed.changes[0].afterHash}:x);
    const afterHash=sha256(JSON.stringify(files));
    options.push({id:'option-'+i,prepare:{candidateId:c.candidateId,method:i?'remove-unused-work':'noop-control',
      rationale:i?'Measured CPU survives the first patch; remove the unused loop.':'Negative control preserves CPU work.',recipe},reviewedPlan:reviewFile,
      experiment:experimentConfig(f.project),formal:{measurement:{schemaVersion:1,engine:'lighthouse',purpose:'acceptance',runs:5,
        pages:experimentConfig(f.project).after.pages,devices:['mobile'],deployment:experimentConfig(f.project).after.deployment},
        scenarios:{},review:{sourceHash:afterHash,contentPreserved:true,visualsPreserved:true,summary:'Synthetic fixture contract; not a merchant visual review.'}}});
  }
  const observed={experiments:0,formal:0,sync:0,formalConfigs:[],profiles:0,verifications:0};let serial=0;
  const deps={verifyOptimization:async input=>{observed.verifications++;return verifyOptimization(input);},profileDomain:async({config})=>{observed.profiles++;return freshRuntime(config);},verifyDeployment:async ({config,pages})=>{observed.sync++;return {status:'verified',sourceHash:(await sourceSnapshot(config.project)).hash};},
    runPatchExperiment:async ({config,output})=>{
      observed.experiments++;await mkdir(output,{recursive:true});
      const plan=await read(config.plan),diagnosis=await read(config.diagnosis),good=firstPromising||!plan.changes[0].after.includes('for(');
      const after=await siteRun(t,{devices:['mobile'],offset:100+serial++*20,scores:{mobile:[good?90:50]},augment:r=>r.audits['total-blocking-time'].numericValue=good?100:700});
      const snap=await sourceSnapshot(f.project);await proof(after,snap,f.project);
      const input={plan,diagnosis,candidateId:config.candidateId,before:f.baseline.root,after:after.root,goal:config.goal,
        regressionBefore:regression(diagnosis.sourceHash),regressionAfter:regression(snap.hash)};
      const verification=await verifyPatchExperiment(input);await writeFile(path.join(output,'patch-evidence.json'),JSON.stringify(input));
      return {output,status:verification.outcome,verification,counts:{attempted:6,failed:0}};
    },
    collectOptimizationEvidence:async ({config,output})=>{
      observed.formal++;observed.formalConfigs.push(config);await mkdir(output,{recursive:true});
      const after=await siteRun(t,{devices:['mobile'],offset:300+serial++*20,scores:{mobile:[formalScores[observed.formal-1]??90]},augment:r=>{r.audits['total-blocking-time'].numericValue=(formalScores[observed.formal-1]??90)===50?700:100;if(resourceCounts)r.audits['resource-summary']={details:{items:[{resourceType:'total',requestCount:resourceCounts[observed.formal-1],transferSize:1000}]}};}});
      await proof(after,await sourceSnapshot(f.project),f.project);
      await cp(after.root,path.join(output,'acceptance'),{recursive:true});
      await writeFile(path.join(output,'regression-evidence.json'),JSON.stringify(regressionForRun(after)));
      return {budget:{counts:{attempted:5}},artifacts:{'regression-evidence.json':'regression-evidence.json'}};
    }};
  return {...f,start,options,original,observed,deps,config:{schemaVersion:1,previous:path.join(start.output,'session.json'),options},
    run:(config,dependencies=deps)=>runRecoveryCycle({config,output:path.join(f.root,'cycle-'+serial++),dependencies})};
}

test('one cycle really rolls back no-gain, rediagnoses, generates a different patch and collects formal verification',async t=>{
  const f=await fixture(t),r=await f.run(f.config),s=await readImprovementSession(r.session);
  assert.equal(r.status,'optimization-accepted',JSON.stringify(r));
  assert.deepEqual(s.history.map(h=>h.outcome),['no-measurable-gain','promising']);
  assert.equal(s.counts.rounds,2);assert.equal(s.counts.attempted,18);assert.equal(f.observed.formal,1);assert.equal(f.observed.verifications,1);
  assert.equal(await readFile(path.join(f.project,'assets/main.js'),'utf8'),'function heavy(){return 1;}');
  const selections=r.events.filter(e=>e.action==='select');assert.equal(selections.length,2);
  assert.equal(selections[1].priorFailures[0].method,'noop-control');assert.notEqual(selections[0].recoveryHash,selections[1].recoveryHash);
  assert.ok(r.events.some(e=>e.action==='collect'));assert.equal(f.observed.sync,3);
});
test('missing or changed plan review stops before writing or sampling; exact saved review resumes',async t=>{
  const f=await fixture(t);delete f.options[0].reviewedPlan;
  let r=await f.run(f.config);assert.equal(r.status,'review-required');assert.equal(f.observed.experiments,0);
  assert.equal(await readFile(path.join(f.project,'assets/main.js'),'utf8'),f.original);
  f.options[0].reviewedPlan=path.join(f.root,'review-1.json');
  r=await f.run({...f.config,previous:r.session});assert.equal(r.status,'review-required');assert.match(r.reviewReason,/reviewed plan/);
  f.options[0].reviewedPlan=path.join(f.root,'review-0.json');
  r=await f.run({...f.config,previous:r.session});assert.equal(r.status,'optimization-accepted');
});
test('failed sync or stale deployment never starts measurement',async t=>{
  for(const invalid of [false,true]) {
    const f=await fixture(t),config=structuredClone(f.config);
    config.sync={command:process.execPath,args:[],timeoutMs:1000};
    const r=await f.run(config,{...f.deps,runProcess:async()=>({code:invalid?0:1}),verifyDeployment:async()=>({status:'mismatch'})});
    assert.equal(r.status,'awaiting-preview-sync');assert.equal(f.observed.experiments,0);
    const s=await readImprovementSession(r.session);assert.equal(s.counts.rounds,1);assert.equal(s.previewSyncRequired,true);
  }
});
test('invalid experiment evidence stops instead of consuming the next mechanism',async t=>{
  const f=await fixture(t),r=await f.run(f.config,{...f.deps,runPatchExperiment:async()=>({status:'invalid-evidence',counts:{attempted:6,failed:1}})});
  assert.equal(r.status,'invalid-evidence');assert.equal((await readImprovementSession(r.session)).counts.rounds,1);
  assert.equal(await readFile(path.join(f.project,'assets/main.js'),'utf8'),f.original);
});
test('session round and attempt budgets survive the cycle and prevent extra work',async t=>{
  const f=await fixture(t,{budget:{maxCandidateRounds:1}}),r=await f.run(f.config);
  const s=await readImprovementSession(r.session);assert.equal(s.counts.rounds,1);assert.equal(f.observed.experiments,1);assert.equal(s.status,'stopped');assert.equal(f.observed.profiles,0);
});
test('formal collection failure retains samples and cannot remeasure on resume',async t=>{
  const f=await fixture(t);f.config.options=[f.options[1]];
  const fail={...f.deps,collectOptimizationEvidence:async args=>{const r=await f.deps.collectOptimizationEvidence(args);return {...r,error:{message:'missing behavior'}};}};
  let r=await f.run(f.config,fail),s=await readImprovementSession(r.session);
  assert.equal(r.status,'formal-evidence-repair-required');assert.ok(s.active.formalAfter);assert.equal(s.counts.attempted,11);
  r=await f.run({...f.config,previous:r.session});assert.equal(r.status,'formal-evidence-repair-required');assert.equal(f.observed.formal,1);
});
for(const mode of ['complete','missing-report','changed-report'])test(`collector throw with ${mode} keeps the original directory, sample bytes and budget`,async t=>{
  const f=await fixture(t);f.config.options=[f.options[1]];
  let missing,bytes;
  const deps={...f.deps,collectOptimizationEvidence:async args=>{
    await f.deps.collectOptimizationEvidence(args);
    if(mode!=='complete') {
      const manifest=await read(path.join(args.output,'acceptance/run.json'));missing=manifest.groups[0].reports[0];
      bytes=await readFile(path.join(args.output,'acceptance',missing));await rm(path.join(args.output,'acceptance',missing));
    }
    throw new Error('Collector receipt write interrupted');
  }};
  let r=await f.run(f.config,deps),s=await readImprovementSession(r.session);
  const original=path.join(s.active.formalCollection,'acceptance'),regression=path.join(s.active.formalCollection,'regression-evidence.json');
  assert.equal(s.error.message,'Collector receipt write interrupted');assert.equal(s.counts.attempted,11);assert.equal(s.counts.failed,1);
  assert.equal(Boolean(s.active.formalAfter),mode==='complete');assert.ok(Object.keys(s.formalEvidenceFiles).length>=5);
  const replacement=path.join(f.root,'replacement-samples');await cp(original,replacement,{recursive:true});
  if(missing)await writeFile(path.join(replacement,missing),bytes);
  f.options[1].verification={after:replacement,regression,review:f.options[1].formal.review};
  r=await f.run({...f.config,previous:r.session});s=await readImprovementSession(r.session);
  assert.match(s.error.message,/original formal collection directory/);assert.equal(s.counts.attempted,11);
  if(missing)await writeFile(path.join(original,missing),bytes); // Restore the same original bytes; no measurement.
  if(mode==='changed-report') {
    const manifest=await read(path.join(original,'run.json')),file=path.join(original,manifest.groups[0].reports[1]),report=await read(file);
    report.categories.performance.score=1;await writeFile(file,JSON.stringify(report));
  }
  f.options[1].verification.after=original;
  r=await f.run({...f.config,previous:r.session});s=await readImprovementSession(r.session);
  if(mode==='changed-report') {assert.match(s.error.message,/formal sample file changed/);assert.equal(s.retained.length,0);}
  else assert.equal(r.status,'optimization-accepted',JSON.stringify(r));
  assert.equal(f.observed.formal,1);assert.equal(f.observed.experiments,1);assert.equal(s.counts.attempted,11);assert.equal(s.counts.failed,1);
});
for(const partial of [false,true])test(`collector claiming zero attempts cannot refund ${partial?'partially readable':'complete'} saved samples`,async t=>{
  const f=await fixture(t);f.config.options=[f.options[1]];let missing,bytes;
  let r=await f.run(f.config,{...f.deps,collectOptimizationEvidence:async args=>{
    const result=await f.deps.collectOptimizationEvidence(args);
    if(partial) {
      const run=await read(path.join(args.output,'acceptance/run.json'));missing=path.join(args.output,'acceptance',run.groups[0].reports[0]);
      bytes=await readFile(missing);await rm(missing);
    }
    return {...result,measurementStarted:false,budget:{counts:{attempted:0}},error:{message:'misreported preflight'}};
  }}),s=await readImprovementSession(r.session);
  assert.match(s.error.message,/attempt count contradicts saved samples/);assert.equal(s.counts.attempted,11);
  assert.equal(s.active.formalObservedAttempts,5);assert.ok(s.active.formalCollection);
  f.options[1].verification={after:path.join(s.active.formalCollection,'acceptance'),review:path.join(f.root,'missing-review.json')};
  r=await f.run({...f.config,previous:r.session});s=await readImprovementSession(r.session);assert.ok(s.error);
  const session=structuredClone(s);
  for(const mutate of [s=>{delete s.active.formalCollection;},s=>{s.active.formalMeasurement.runs=1;},s=>{s.formalEvidenceFiles={};},s=>{s.active.formalObservedAttempts=0;}]) {
    const changed=structuredClone(session);mutate(changed);changed.sessionHash=hashSession(changed);await writeFile(r.session,JSON.stringify(changed));
    await assert.rejects(readImprovementSession(r.session),/Broken formal|Broken session/);
  }
  await writeFile(r.session,JSON.stringify(session));
  if(missing)await writeFile(missing,bytes);
  f.options[1].verification={after:path.join(s.active.formalCollection,'acceptance'),regression:path.join(s.active.formalCollection,'regression-evidence.json'),review:f.options[1].formal.review};
  r=await f.run({...f.config,previous:r.session});assert.equal(r.status,'optimization-accepted',JSON.stringify(r));
  assert.equal(f.observed.formal,1);assert.equal(r.counts.attempted,11);assert.equal(r.counts.failed,1);
});
test('stale formal review stops before collection and only a current-source review can resume',async t=>{
  const f=await fixture(t);f.config.options=[f.options[1]];
  const review=f.options[1].formal.review;
  f.options[1].formal.review=f.options[0].formal.review;
  let r=await f.run(f.config),s=await readImprovementSession(r.session);
  assert.equal(r.status,'formal-review-required');assert.equal(r.reviewSourceHash,review.sourceHash);
  assert.equal(s.error.code,'STALE_FORMAL_REVIEW');assert.equal(s.active.formalCollection,undefined);
  assert.equal(s.counts.attempted,6);assert.equal(f.observed.formal,0);
  // The lower-level collect action enforces the same binding, not just the cycle UI.
  s=await runImprovement({config:{schemaVersion:1,previous:r.session,action:'collect',formal:f.options[1].formal},output:path.join(f.root,'direct-stale-collect'),dependencies:f.deps});
  assert.equal(s.error.code,'STALE_FORMAL_REVIEW');assert.equal(f.observed.formal,0);
  f.options[1].formal.review=review;
  r=await f.run({...f.config,previous:path.join(s.output,'session.json')});
  assert.equal(r.status,'optimization-accepted');assert.equal(r.counts.attempted,11);assert.equal(f.observed.formal,1);
});
test('cycle repairs formal evidence from files using the pinned batch without collecting or experimenting again',async t=>{
  const f=await fixture(t);f.config.options=[f.options[1]];
  const fail={...f.deps,collectOptimizationEvidence:async args=>({...await f.deps.collectOptimizationEvidence(args),error:{message:'behavior evidence delivery interrupted'}})};
  let r=await f.run(f.config,fail),s=await readImprovementSession(r.session);
  const after=s.active.formalAfter,counts={...s.counts},regression=path.join(s.active.formalCollection,'regression-evidence.json');
  // Even on repair, a prior patch's review must not pass the final acceptance gate.
  f.options[1].verification={regression,review:f.options[0].formal.review};
  r=await f.run({...f.config,previous:r.session});s=await readImprovementSession(r.session);
  assert.equal(r.status,'formal-evidence-repair-required');assert.equal(s.active.formalAfter,after);
  assert.equal((await read(s.verification)).checks.find(c=>c.id==='content-and-visual-review').pass,false);
  // An explicitly supplied replacement batch is not silently overwritten with the saved batch.
  f.options[1].verification.after=f.baseline.root;
  r=await f.run({...f.config,previous:r.session});s=await readImprovementSession(r.session);
  assert.match(s.error.message,/first valid formal candidate samples/);assert.equal(s.active.formalAfter,after);
  const review=path.join(f.root,'repaired-review.json'),verification=path.join(f.root,'repaired-verification.json');
  await writeFile(review,JSON.stringify(f.options[1].formal.review));
  await writeFile(verification,JSON.stringify({regression,review}));f.options[1].verification=verification;
  delete f.options[1].formal; // verify is independently usable; no collection config required.
  r=await f.run({...f.config,previous:r.session});s=await readImprovementSession(r.session);
  assert.equal(r.status,'optimization-accepted',JSON.stringify(r));
  assert.equal(s.retained[0].after,after);assert.equal(s.counts.attempted,counts.attempted);
  assert.equal(s.counts.rounds,counts.rounds);assert.equal(f.observed.formal,1);assert.equal(f.observed.experiments,1);
  assert.deepEqual(r.events.map(e=>e.action),['verify']);
});
test('repaired formal rejection rolls back, recollects evidence, pauses for new review and fully resumes another mechanism',async t=>{
  const f=await fixture(t,{firstPromising:true,formalScores:[50,90]});delete f.options[1].reviewedPlan;
  const fail={...f.deps,collectOptimizationEvidence:async args=>({...await f.deps.collectOptimizationEvidence(args),error:{message:'missing behavior'}})};
  let r=await f.run(f.config,fail),s=await readImprovementSession(r.session);
  const firstAfter=s.active.formalAfter;
  assert.equal(s.counts.attempted,11);
  f.options[0].verification={regression:path.join(s.active.formalCollection,'regression-evidence.json'),review:f.options[0].formal.review};
  r=await f.run({...f.config,previous:r.session});s=await readImprovementSession(r.session);
  assert.equal(r.status,'review-required',JSON.stringify(r));assert.equal(f.observed.formal,1);
  assert.equal(s.counts.attempted,12);assert.equal(f.observed.profiles,1);
  assert.equal(s.history.at(-1).outcome,'formal-rejected');assert.equal(s.history.at(-1).formalEvidence.after,firstAfter);
  assert.equal(await readFile(path.join(f.project,'assets/main.js'),'utf8'),f.original);
  assert.equal((await read(r.plan)).changes[0].after,'function heavy(){return 1;}');
  f.options[1].reviewedPlan=r.plan;
  r=await f.run({...f.config,previous:r.session});s=await readImprovementSession(r.session);
  assert.equal(r.status,'optimization-accepted',JSON.stringify(r));assert.equal(s.counts.attempted,23);
  assert.deepEqual(s.history.map(h=>h.outcome),['promising','formal-rejected','promising']);
  assert.equal(f.observed.profiles,1);assert.equal(f.observed.formal,2);assert.equal(f.observed.experiments,2);
  assert.notEqual(s.retained[0].after,firstAfter);
});

test('a resource constraint introduced on repair survives mechanism changes and reaches the next collector',async t=>{
  const f=await fixture(t,{firstPromising:true,formalScores:[50,90],resourceCounts:[10,100]});
  const fail={...f.deps,collectOptimizationEvidence:async args=>({...await f.deps.collectOptimizationEvidence(args),error:{message:'missing behavior'}})};
  let r=await f.run(f.config,fail),s=await readImprovementSession(r.session);
  f.options[0].verification={budget:{maxRequests:20},regression:path.join(s.active.formalCollection,'regression-evidence.json'),review:f.options[0].formal.review};
  r=await f.run({...f.config,previous:r.session});s=await readImprovementSession(r.session);
  assert.equal(r.status,'no-supported-alternative',JSON.stringify(r));
  assert.deepEqual(f.observed.formalConfigs[1].budget,{maxRequests:20});assert.deepEqual(s.verificationBudget,{maxRequests:20});
  assert.equal(s.history.at(-1).outcome,'formal-rejected');assert.equal(s.history.at(-1).verification.budget.passed,false);
  assert.equal(f.observed.formal,2);assert.equal(f.observed.experiments,2);assert.equal(s.counts.rounds,2);assert.equal(s.counts.attempted,24);
});
test('pinned resource budget reaches collection and cannot be loosened during verify',async t=>{
  const f=await fixture(t,{resourceBudget:{maxRequests:20}});f.config.options=[f.options[1]];
  const r=await f.run(f.config),s=await readImprovementSession(r.session);
  assert.deepEqual(f.observed.formalConfigs[0].budget,{maxRequests:20});
  assert.equal(s.acceptance,'not-accepted'); // Synthetic reports intentionally lack resource-summary.
  const v=await runImprovement({config:{schemaVersion:1,action:'verify',previous:r.session,
    verification:{after:s.active.formalAfter,budget:{maxRequests:200}}},output:path.join(f.root,'loosen')});
  assert.match(v.error.message,/fixed/);
});
test('review equivalence ignores only generation identifiers, never semantic changes',async t=>{
  const f=await fixture(t),plan=await read(f.options[0].reviewedPlan),fresh=await createSitePlan({project:f.project,recipe:f.options[0].prepare.recipe});
  assert.notEqual(plan.planHash,fresh.planHash);assert.equal(await reviewedPlanContent(plan),await reviewedPlanContent(fresh));
  assert.notEqual(await reviewedPlanContent(plan),await reviewedPlanContent(await read(f.options[1].reviewedPlan)));
});

test('formal no-gain also rediagnoses and executes a different mechanism without reusing exploration as acceptance',async t=>{
  const f=await fixture(t,{firstPromising:true,formalScores:[50,90]}),r=await f.run(f.config),s=await readImprovementSession(r.session);
  assert.equal(r.status,'optimization-accepted',JSON.stringify(r));
  assert.deepEqual(s.history.map(h=>h.outcome),['promising','formal-rejected','promising']);
  assert.equal(s.counts.rounds,2);assert.equal(s.counts.attempted,23);assert.equal(f.observed.formal,2);
  assert.equal(r.events.filter(e=>e.action==='select')[1].priorFailures.at(-1).outcome,'formal-rejected');
});

test('measured resource budget excess rejects and replaces a promising patch instead of waiting for review',async t=>{
  const f=await fixture(t,{firstPromising:true,resourceBudget:{maxRequests:20},resourceCounts:[100,10]});
  const r=await f.run(f.config),s=await readImprovementSession(r.session);
  assert.equal(r.status,'optimization-accepted',JSON.stringify(r));
  assert.deepEqual(s.history.map(h=>h.outcome),['promising','formal-rejected','promising']);
  assert.equal(s.history[1].verification.budget.passed,false);assert.equal(s.counts.attempted,23);
});

test('unknown formal collector progress consumes the full reservation and cannot be re-collected',async t=>{
  const f=await fixture(t);f.config.options=[f.options[1]];
  const deps={...f.deps,collectOptimizationEvidence:args=>collectOptimizationEvidence({...args,config:{...args.config,scenarios:{schemaVersion:1,
    viewports:[{name:'mobile',width:390,height:844}],scenarios:[{name:'content',url:args.config.measurement.pages[0].url,
      steps:[{action:'assert-text',selector:'main',text:'Fixture'}]}]}},dependencies:{measureSite:async()=>{throw new Error('Collector lost after starting navigation');}}})};
  const r=await f.run(f.config,deps),s=await readImprovementSession(r.session);
  assert.equal(r.status,'formal-evidence-repair-required');assert.equal(s.counts.attempted,11);assert.ok(s.active.formalCollection);
  const saved=await read(path.join(s.active.formalCollection,'optimization.json'));
  assert.equal(saved.measurementStarted,true);assert.equal(saved.budget.counts.attempted,5);
});
test('known preflight failure with zero navigation can be repaired without manufacturing a new sample batch',async t=>{
  const f=await fixture(t);f.config.options=[f.options[1]];
  let r=await f.run(f.config,{...f.deps,collectOptimizationEvidence:async()=>({measurementStarted:false,budget:{counts:{attempted:0}},error:{message:'bad config'}})});
  let s=await readImprovementSession(r.session);assert.equal(s.counts.attempted,6);assert.equal(s.active.formalCollection,undefined);
  r=await f.run({...f.config,previous:r.session});s=await readImprovementSession(r.session);
  assert.equal(r.status,'optimization-accepted');assert.equal(s.counts.attempted,11);
});
test('exhausted options do not generate parameter retries, and equivalent domain methods are excluded',async t=>{
  const f=await fixture(t);f.config.options=[f.options[0]];
  const r=await f.run(f.config);assert.equal(r.status,'no-supported-alternative');assert.equal(f.observed.experiments,1);
  const candidate={candidateId:'c',file:'sections/catalog.liquid',line:1,kind:'liquid-query',metric:'ttfb',methods:['query-limit','query-limit-render']};
  const state={baselineHash:'hash',history:[{baselineHash:'hash',hypothesisKey:hypothesisKey(candidate),method:'query-limit',outcome:'no-measurable-gain'}]};
  assert.equal(selectRecoveryOption(state,{candidates:[candidate]},[{id:'parameter-retry',prepare:{candidateId:'c',method:'query-limit-render'}}]),null);
});

test('official executor resumes its saved review using canonical identity',async t=>{
  const f=await setup(t),text='function init(){window.fixture=1;}\ninit();';
  await writeFile(path.join(f.project,'assets/main.js'),text);await proof(f.baseline,await sourceSnapshot(f.project),f.project);
  const start=await f.step({action:'start'}),c=(await read(start.recovery)).candidates[0];
  const option={id:'official',prepare:{candidateId:c.candidateId,method:'defer-non-critical-resources/site:js-idle-init',
    rationale:'Defer the reviewed noncritical fixture initialization.',official:{schemaVersion:1,candidateId:c.candidateId,
      methodId:'defer-non-critical-resources',executor:'site:js-idle-init',parameters:{statementStart:text.indexOf('\ninit();')+1,timeoutMs:200},
      review:{sourceHash:c.source.sourceHash,summary:'Synthetic noncritical initialization',nonCritical:true,noFirstInteractionDependency:true,timingChangeReviewed:true}}},experiment:experimentConfig(f.project)};
  const config={schemaVersion:1,previous:path.join(start.output,'session.json'),options:[option]};
  let r=await runRecoveryCycle({config,output:path.join(f.root,'official-review')});
  assert.equal(r.status,'review-required',JSON.stringify(r));option.reviewedPlan=r.plan;
  let sync=0;
  r=await runRecoveryCycle({config:{...config,previous:r.session},output:path.join(f.root,'official-resume'),dependencies:{verifyDeployment:async()=>{sync++;return {status:'mismatch'};}}});
  assert.equal(r.status,'awaiting-preview-sync',JSON.stringify(r));assert.equal(sync,1);
  const s=await readImprovementSession(r.session);assert.equal(s.active.method,'js-idle-init');assert.equal(s.active.requestedMethod,option.prepare.method);
  assert.match(await readFile(path.join(f.project,'assets/main.js'),'utf8'),/requestIdleCallback/);
});

test('fresh evidence drives the next diagnosis and is not recaptured after review pause',async t=>{
  const f=await fixture(t);delete f.options[1].reviewedPlan;
  let r=await f.run(f.config),s=await readImprovementSession(r.session);
  assert.equal(r.status,'review-required',JSON.stringify(r));assert.equal(f.observed.profiles,1);
  assert.ok(s.inputs.profiles[0].domainProof);assert.equal(s.history[0].outcome,'no-measurable-gain');
  assert.equal(s.counts.attempted,7);assert.equal(r.events.filter(e=>e.action==='reprofile').length,1);
  const generated=await read(r.plan);assert.equal(generated.changes[0].after,'function heavy(){return 1;}');
  f.options[1].reviewedPlan=r.plan;r=await f.run({...f.config,previous:r.session});
  assert.equal(r.status,'optimization-accepted');assert.equal(f.observed.profiles,1);assert.equal(f.observed.formal,1);
});

test('failed fresh capture stops before another patch and preserves spent attempts and failure history',async t=>{
  const f=await fixture(t);
  const r=await f.run(f.config,{...f.deps,profileDomain:async()=>{throw new Error('capture failed');}}),s=await readImprovementSession(r.session);
  assert.equal(r.status,'evidence-collection-failed');assert.equal(s.counts.attempted,7);assert.equal(s.counts.failed,2);
  assert.equal(s.counts.rounds,1);assert.equal(s.history[0].method,'noop-control');assert.equal(s.evidenceRefreshHistoryLength,undefined);
  assert.equal(await readFile(path.join(f.project,'assets/main.js'),'utf8'),f.original);
  assert.equal(s.inputs.profiles[0].domainProof,undefined);
});

test('fresh capture rejects replay, other theme and other device even with valid internal proofs',async t=>{
  for(const mutation of ['replay','theme','device','future','project']) {
    const f=await fixture(t);
    const r=await f.run(f.config,{...f.deps,profileDomain:async({config})=>{
      const p=await freshRuntime(config);
      if(mutation==='replay')for(const obj of [p,p.domainProof,p.domainProof.before,p.domainProof.after])for(const key of ['createdAt','startedAt','finishedAt'])if(key in obj)obj[key]='2020-01-01T00:00:00Z';
      if(mutation==='theme'){p.themeId='99';for(const proof of [p.domainProof.before,p.domainProof.after]){proof.themeId='99';proof.pages[0].themeId='99';}}
      if(mutation==='device')p.config.device='desktop';
      if(mutation==='future')for(const obj of [p,p.domainProof,p.domainProof.before,p.domainProof.after])for(const key of ['createdAt','startedAt','finishedAt'])if(key in obj)obj[key]=new Date(Date.now()+60000).toISOString();
      if(mutation==='project'){p.project='/other';p.snapshot.project='/other';p.domainProof.before.project='/other';p.domainProof.after.project='/other';}
      return p;
    }});
    assert.equal(r.status,'evidence-collection-failed',mutation);assert.equal(f.observed.experiments,1);
  }
});

test('invalid capture list fails before consuming or locking a session',async t=>{
  const f=await fixture(t);
  await assert.rejects(f.run({...f.config,evidence:[]}),/capture requests/);
  const r=await f.run(f.config);assert.equal(r.status,'optimization-accepted');
});

test('disappearing bottleneck in fresh evidence does not reuse the previous diagnosis to apply another patch',async t=>{
  const f=await fixture(t),r=await f.run(f.config,{...f.deps,profileDomain:async({config})=>({...await freshRuntime(config),cpu:[]})});
  const s=await readImprovementSession(r.session);
  assert.equal(r.status,'no-supported-alternative');assert.equal(s.counts.rounds,1);assert.equal(f.observed.experiments,1);
  assert.deepEqual(s.inputs.profiles[0].cpu,[]);assert.equal((await read(s.recovery)).candidates.length,0);
});

test('partial fresh capture is atomic and the complete capture reservation respects the persistent budget',async t=>{
  for(const limited of [false,true]) {
    const f=await fixture(t,{budget:limited?{maxAttempts:7}:{}}),request={schemaVersion:1,mode:'runtime',deployment:experimentConfig(f.project).after.deployment,
      url:experimentConfig(f.project).after.pages[0].url,profile:{device:'mobile'}};
    let captures=0;
    const r=await f.run({...f.config,evidence:[request,request]},{...f.deps,profileDomain:async({config})=>{if(++captures===2)throw new Error('second profile failed');return freshRuntime(config);}});
    const s=await readImprovementSession(r.session);
    assert.equal(r.status,limited?'stopped':'evidence-collection-failed');assert.equal(s.counts.rounds,1);
    assert.equal(captures,limited?0:2);assert.equal(s.counts.attempted,limited?6:8);
    assert.equal(s.inputs.profiles[0].domainProof,undefined);assert.equal(s.evidenceRefreshHistoryLength,undefined);
    if(limited)assert.equal(s.status,'stopped');
  }
});


test('source-bound candidates survive CDN version changes but retain their measured page scope',async t=>{
  const f=await fixture(t),r=await f.run(f.config,{...f.deps,profileDomain:async({config})=>{
    const p=await freshRuntime(config);p.cpu[0].url+='?v=after-preview-sync';return p;
  }});
  assert.equal(r.status,'optimization-accepted',JSON.stringify(r));assert.equal(f.observed.experiments,2);
});
