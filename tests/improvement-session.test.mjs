import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from 'node:fs/promises';
import path from 'node:path';
import { runImprovement, readImprovementSession } from '../lib/improvement-session.mjs';
import { diagnoseRecovery } from '../lib/recovery.mjs';
import { sourceSnapshot } from '../lib/runtime-profile.mjs';
import { applySitePlan } from '../lib/site-changes.mjs';
import { verifyPatchExperiment } from '../lib/patch-experiment.mjs';
import { preservationStyles } from '../lib/preservation.mjs';
import { siteRun, saveManifest, regressionForRun, changeReport } from './helpers/site-run.mjs';
import { renderReport } from '../lib/report.mjs';
import { execFileSync } from 'node:child_process';
import {hashSession} from '../lib/improvement-state.mjs';

import {url,read,experimentConfig,proof,regression,runtime,setup} from './helpers/improvement-fixture.mjs';

test('recovery ranks measured loss and excludes stale/wrong-page profiles without declaring success',async t=>{
  const f=await setup(t),s=await f.step({action:'start'}),r=await read(s.recovery);
  assert.equal(r.groups[0].metrics[0].metric,'tbt');assert.equal(r.groups[0].belowTarget,true);
  assert.equal(r.candidates[0].metric,'tbt');assert.equal(r.acceptance,'not-evaluated');
  const wrong=await runtime(f.project);wrong.config.url='https://shop.example.test/products/other';
  const next=await diagnoseRecovery({project:f.project,run:f.baseline.root,profiles:[wrong]});
  assert.equal(next.candidates.length,0);assert.equal(next.rejectedProfiles,1);assert.ok(next.investigations.length);
  await changeReport(f.baseline,r=>r.runWarnings.push('warning'));
  await assert.rejects(diagnoseRecovery({project:f.project,run:f.baseline.root}),/warning-free/);
});

test('no-gain patch really rolls back, rediagnoses and rejects a repeated implementation',async t=>{
  const f=await setup(t);await f.step({action:'start'});await f.prepare('function heavy(){ return 1; } // noop');
  let s=await f.step({action:'apply',reviewedPlanHash:f.state.active.planHash});assert.equal(s.status,'awaiting-preview-sync');
  s=await f.experiment();assert.equal(s.history[0].outcome,'no-measurable-gain');assert.equal(s.active,null);
  assert.equal(await readFile(path.join(f.project,'assets/main.js'),'utf8'),'function heavy(){ return 1; }');
  assert.equal((await read(s.recovery)).candidates[0].tested.length,1);assert.equal(s.previewSyncRequired,true);
  s=await f.prepare('function heavy(){ return 1; } // noop','different-name');assert.match(s.error.message,/already tested/);
  s=await f.prepare('function heavy(){ return 2; }','different-mechanism');assert.equal(s.status,'review-required');assert.equal(s.error,undefined);
  assert.equal((await readImprovementSession(path.join(s.output,'session.json'))).history.length,1);
});

test('formal checks keep a measured below-target improvement, then a new round reaches acceptance',async t=>{
  const f=await setup(t);await f.step({action:'start'});await f.prepare('function heavy(){ return 2; }');
  await f.step({action:'apply',reviewedPlanHash:f.state.active.planHash});
  let s=await f.experiment({score:65,tbt:400});assert.equal(s.status,'formal-validation-required',JSON.stringify(s.error));
  const formal=async(score,tbt,offset)=>{
    const after=await siteRun(t,{devices:['mobile'],offset,scores:{mobile:[score]},augment:r=>{r.audits['total-blocking-time'].numericValue=tbt;}});
    await proof(after,await sourceSnapshot(f.project),f.project);
    return {after:after.root,regression:regressionForRun(after),review:{sourceHash:f.state.active.sourceHash,contentPreserved:true,visualsPreserved:true,summary:'Synthetic fixture review, not real visual evidence.'}};
  };
  s=await f.step({action:'verify',verification:await formal(65,400,400)});
  assert.equal(s.status,'improved-below-target',JSON.stringify(await read(s.verification)));
  assert.equal(s.acceptance,'not-accepted');assert.equal(s.retained.length,1);assert.equal(s.inputs.profiles.length,0);
  await f.step({action:'refresh',profiles:[await runtime(f.project)]});
  await f.prepare('function heavy(){ return 3; }','second-mechanism');await f.step({action:'apply',reviewedPlanHash:f.state.active.planHash});
  s=await f.experiment({score:90,tbt:100});assert.equal(s.status,'formal-validation-required');
  s=await f.step({action:'verify',verification:await formal(90,100,600)});
  assert.equal(s.status,'optimization-accepted',JSON.stringify(s.error));assert.equal(s.retained.length,2);
  assert.equal(s.counts.rounds,2);assert.equal(s.history.length,2);assert.equal((await read(s.cumulativeGain)).outcome,'measurable-gain');
});

test('missing visual review never promotes a low score candidate',async t=>{
  const f=await setup(t);await f.step({action:'start'});await f.prepare('function heavy(){ return 2; }');
  await f.step({action:'apply',reviewedPlanHash:f.state.active.planHash});await f.experiment({score:65,tbt:400});
  const after=await siteRun(t,{devices:['mobile'],offset:400,scores:{mobile:[65]},augment:r=>{r.audits['total-blocking-time'].numericValue=400;}});
  await proof(after,await sourceSnapshot(f.project),f.project);
  const s=await f.step({action:'verify',verification:{after:after.root,regression:regressionForRun(after)}});
  assert.equal(s.status,'formal-validation-required');assert.equal(s.retained.length,0);assert.equal(s.acceptance,'not-accepted');
});

test('budget survives resumes, rollback remains available and previous steps cannot fork',async t=>{
  const f=await setup(t,{maxCandidateRounds:1});const first=await f.step({action:'start'});
  await f.prepare('function heavy(){ return 2; }');
  await assert.rejects(runImprovement({config:{schemaVersion:1,action:'refresh',previous:path.join(first.output,'session.json')},output:path.join(f.root,'fork')}),{code:'EEXIST'});
  await f.step({action:'apply',reviewedPlanHash:f.state.active.planHash});await f.experiment();
  const s=await f.prepare('function heavy(){ return 3; }','next-method');assert.equal(s.status,'stopped');assert.equal(s.counts.rounds,1);
});

test('source drift, altered session and altered diagnosis fail closed',async t=>{
  const f=await setup(t);let s=await f.step({action:'start'});
  const session=path.join(s.output,'session.json'),tampered=await read(session);tampered.counts.rounds=99;
  await writeFile(path.join(f.root,'tampered.json'),JSON.stringify(tampered));
  await assert.rejects(readImprovementSession(path.join(f.root,'tampered.json')),/changed session/);
  await writeFile(path.join(f.project,'assets/main.js'),'external edit');
  s=await f.prepare('function heavy(){ return 2; }');assert.match(s.error.message,/source drift/);
  assert.equal(await readFile(path.join(f.project,'assets/main.js'),'utf8'),'external edit');
});

test('CLI exposes the executable session and report renders recovery',async t=>{
  assert.match(execFileSync(process.execPath,['scripts/perfkit.mjs','--help'],{encoding:'utf8'}),/improve --config/);
  const f=await setup(t),s=await f.step({action:'start'});
  assert.match(renderReport(await read(s.recovery)),/javascript-execution/);
});

test('attempt exhaustion keeps the candidate recoverable by rollback',async t=>{
  const f=await setup(t,{maxAttempts:1,maxCandidateRounds:2});await f.step({action:'start'});
  await f.prepare('function heavy(){ return 2; }');await f.step({action:'apply',reviewedPlanHash:f.state.active.planHash});
  let s=await f.step({action:'experiment',experiment:experimentConfig(f.project)});
  assert.equal(s.status,'stopped');assert.ok(s.active);
  s=await f.step({action:'rollback'});assert.equal(s.error,undefined);assert.equal(s.active,null);
  assert.equal(await readFile(path.join(f.project,'assets/main.js'),'utf8'),'function heavy(){ return 1; }');
});

test('invalid experiment evidence permits a bounded retry of the same implementation',async t=>{
  const f=await setup(t);await f.step({action:'start'});await f.prepare('function heavy(){ return 2; }');
  await f.step({action:'apply',reviewedPlanHash:f.state.active.planHash});
  let s=await f.step({action:'experiment',experiment:experimentConfig(f.project)},
    {runPatchExperiment:async({output})=>({output,status:'invalid-evidence',counts:{attempted:1,failed:1},verification:{outcome:'invalid-evidence',error:'Fixture warning'}})});
  assert.ok(s.active);assert.equal(s.counts.attempted,1);assert.equal(s.counts.failed,1);
  s=await f.experiment({score:90,tbt:400});
  assert.equal(s.error,undefined);assert.equal(s.status,'formal-validation-required');
  assert.deepEqual(s.history.map(entry=>entry.outcome),['invalid-evidence','promising']);
  assert.equal(s.counts.rounds,1);
});

test('formal regression rolls back even after a promising small experiment',async t=>{
  const f=await setup(t);await f.step({action:'start'});await f.prepare('function heavy(){ return 2; }');
  await f.step({action:'apply',reviewedPlanHash:f.state.active.planHash});await f.experiment({score:90,tbt:100});
  const after=await siteRun(t,{devices:['mobile'],offset:400,scores:{mobile:[40]},augment:r=>{r.audits['total-blocking-time'].numericValue=1000;}});
  await proof(after,await sourceSnapshot(f.project),f.project);
  const s=await f.step({action:'verify',verification:{after:after.root,regression:regressionForRun(after),review:{sourceHash:f.state.active.sourceHash,contentPreserved:true,visualsPreserved:true,summary:'Synthetic fixture'}}});
  assert.equal(s.active,null);assert.equal(s.history.at(-1).outcome,'formal-rejected');assert.equal(s.acceptance,'not-accepted');
  assert.equal(await readFile(path.join(f.project,'assets/main.js'),'utf8'),'function heavy(){ return 1; }');
});

test('formal baseline replacement checks scope and preserves history and budget',async t=>{
  const f=await setup(t,{maxCandidateRounds:4},true);await f.step({action:'start'});
  const wrong=await siteRun(t,{devices:['desktop'],offset:400});await proof(wrong,await sourceSnapshot(f.project),f.project);
  let s=await f.step({action:'refresh',run:wrong.root});assert.match(s.error.message,/same source\/store\/matrix\/environment/);
  const next=await siteRun(t,{devices:['mobile'],offset:200,scores:{mobile:[50]}});
  await proof(next,await sourceSnapshot(f.project),f.project);
  s=await f.step({action:'refresh',run:next.root});assert.equal(s.error,undefined);assert.equal(s.originalRun,f.baseline.root);
  assert.equal(s.originalFormalRun,next.root);assert.equal(s.baselineReplacements.length,1);assert.equal(s.budget.maxCandidateRounds,4);
  s=await f.step({action:'refresh',run:wrong.root});assert.match(s.error.message,/formal baseline is fixed/);
  assert.equal(s.baselineRun,next.root);
});

test('edited recovery cannot be used to prepare a patch',async t=>{
  const f=await setup(t),s=await f.step({action:'start'}),r=await read(s.recovery);
  r.candidates[0].lostPoints=99;await writeFile(s.recovery,JSON.stringify(r));
  const rejected=await f.prepare('function heavy(){ return 2; }');assert.match(rejected.error.message,/diagnosis changed/);
  assert.equal(rejected.active,undefined);
});

test('copied session cannot reopen an already consumed step',async t=>{
  const f=await setup(t),s=await f.step({action:'start'});
  await f.prepare('function heavy(){ return 2; }');
  const copied=path.join(f.root,'copied');await mkdir(copied);
  await writeFile(path.join(copied,'session.json'),await readFile(path.join(s.output,'session.json')));
  await assert.rejects(runImprovement({config:{schemaVersion:1,action:'refresh',previous:path.join(copied,'session.json')},output:path.join(f.root,'fork-copy')}),/original output directory/);
});

test('baseline raw score edits fail closed even when manifest did not change; rollback stays available',async t=>{
  const f=await setup(t);await f.step({action:'start'});await f.prepare('function heavy(){ return 2; }');
  await f.step({action:'apply',reviewedPlanHash:f.state.active.planHash});
  await changeReport(f.baseline,r=>{r.categories.performance.score=0.1;});
  let s=await f.experiment({score:90,tbt:100});assert.match(s.error.message,/measurement evidence changed/);
  assert.equal(s.counts.attempted,0);assert.equal(s.acceptance,'not-accepted');
  s=await f.step({action:'rollback'});assert.equal(s.active,null);
  assert.equal(await readFile(path.join(f.project,'assets/main.js'),'utf8'),'function heavy(){ return 1; }');
});

test('wrong store, page or device is rejected before any experiment sampling',async t=>{
  const f=await setup(t);await f.step({action:'start'});await f.prepare('function heavy(){ return 2; }');
  await f.step({action:'apply',reviewedPlanHash:f.state.active.planHash});
  for(const mutate of [c=>{c.before.deployment.store='other.myshopify.com';},c=>{c.after.pages[0].url='https://shop.example.test/products/other';},c=>{c.before.devices=['desktop'];}]){
    const config=experimentConfig(f.project);mutate(config);
    const s=await f.step({action:'experiment',experiment:config},{runPatchExperiment:()=>assert.fail('must not sample')});
    assert.match(s.error.message,/session store|page\/device/);assert.equal(s.counts.attempted,0);
  }
});

test('runner exception consumes its reservation and retains the patch for a valid retry',async t=>{
  const f=await setup(t);await f.step({action:'start'});await f.prepare('function heavy(){ return 2; }');
  await f.step({action:'apply',reviewedPlanHash:f.state.active.planHash});
  const s=await f.step({action:'experiment',experiment:experimentConfig(f.project)},
    {runPatchExperiment:async()=>{throw new Error('Runner failed after unknown progress');}});
  assert.ok(s.active);assert.equal(s.counts.attempted,6);assert.equal(s.counts.failed,1);
  assert.equal(s.history[0].outcome,'invalid-evidence');assert.match(s.history[0].error,/unknown progress/);
  assert.equal(await readFile(path.join(f.project,'assets/main.js'),'utf8'),'function heavy(){ return 2; }');
  const retried = await f.experiment({score:90,tbt:400});
  assert.equal(retried.status,'formal-validation-required');
  assert.equal(retried.counts.rounds,1);
});

async function formalCandidate(t,f) {
  await f.step({action:'start'});await f.prepare('function heavy(){ return 2; }');
  await f.step({action:'apply',reviewedPlanHash:f.state.active.planHash});await f.experiment({score:65,tbt:400});
  const after=await siteRun(t,{devices:['mobile'],offset:400,scores:{mobile:[65]},augment:r=>{r.audits['total-blocking-time'].numericValue=400;}});
  await proof(after,await sourceSnapshot(f.project),f.project);
  return {after:after.root,regression:regressionForRun(after),review:{sourceHash:f.state.active.sourceHash,contentPreserved:true,visualsPreserved:true,summary:'Synthetic fixture'}};
}

test('missing functional evidence retains promising patch for evidence completion',async t=>{
  const f=await setup(t),verification=await formalCandidate(t,f);delete verification.regression;
  const s=await f.step({action:'verify',verification});
  assert.equal(s.status,'formal-validation-required');assert.ok(s.active);assert.equal(s.retained.length,0);
  assert.equal(await readFile(path.join(f.project,'assets/main.js'),'utf8'),'function heavy(){ return 2; }');
});

test('broken score evaluator never promotes candidate as an intermediate gain',async t=>{
  const f=await setup(t),verification=await formalCandidate(t,f);
  const old=process.env.PERF_KIT_PYTHON;process.env.PERF_KIT_PYTHON='/nonexistent/perfkit-python';
  let s;
  try{s=await f.step({action:'verify',verification});}finally{if(old===undefined)delete process.env.PERF_KIT_PYTHON;else process.env.PERF_KIT_PYTHON=old;}
  assert.equal(s.status,'formal-validation-required');assert.equal(s.retained.length,0);
  assert.equal((await read(s.verification)).scoreTargets.outcome,'invalid-evidence');
});

test('actual candidate UI failure rolls back while keeping the formal rejection',async t=>{
  const f=await setup(t),verification=await formalCandidate(t,f);
  Object.assign(verification.regression.scenarios.runs[0].steps[0],{outcome:'failed',error:{code:'ASSERTION_FAILED',expected:'Fixture',actual:'Broken'}});
  const s=await f.step({action:'verify',verification});assert.equal(s.active,null);
  assert.equal(s.history.at(-1).outcome,'formal-rejected');
  assert.equal(await readFile(path.join(f.project,'assets/main.js'),'utf8'),'function heavy(){ return 1; }');
});

test('edited experimental raw samples cannot be substituted during formal verification',async t=>{
  const f=await setup(t),verification=await formalCandidate(t,f),patch=await read(f.state.active.patchEvidence);
  const manifest=await read(path.join(patch.after,'run.json')),raw=path.join(patch.after,manifest.groups[0].reports[0]);
  const report=await read(raw);report.categories.performance.score=0.99;await writeFile(raw,JSON.stringify(report));
  const s=await f.step({action:'verify',verification});assert.match(s.error.message,/measurement evidence changed/);
  assert.equal(s.retained.length,0);
});

test('failure after committed apply cannot repeat apply and remains recoverable',async t=>{
  const f=await setup(t);await f.step({action:'start'});await f.prepare('function heavy(){ return 2; }');
  let s=await f.step({action:'apply',reviewedPlanHash:f.state.active.planHash},{applySitePlan:async(plan,project)=>{
    const receipt=await applySitePlan(plan,project);throw Object.assign(new Error('Simulated failure after committed write'),{receipt});
  }});
  assert.equal(s.status,'apply-recovery-required');assert.equal(s.counts.rounds,1);assert.equal(s.previewSyncRequired,true);
  assert.equal(await readFile(path.join(f.project,'assets/main.js'),'utf8'),'function heavy(){ return 2; }');
  s=await f.step({action:'apply',reviewedPlanHash:s.active.planHash});assert.match(s.error.message,/exact reviewed active plan/);assert.equal(s.counts.rounds,1);
  s=await f.step({action:'rollback'});assert.equal(s.active,null);assert.equal(s.error,undefined);
  assert.equal(await readFile(path.join(f.project,'assets/main.js'),'utf8'),'function heavy(){ return 1; }');
});

test('interaction controller does not treat unchanged navigation score as failed interaction gain',async t=>{
  // Isolate controller policy with an injected interaction verdict. Raw navigation
  // fixtures remain source-bound; this does not claim real interaction performance.
  const f=await setup(t),p=await runtime(f.project),goal={kind:'interaction',target:'#buy',event:'click'};
  p.afterActions={interactions:[{target:'#buy',name:'click',interactionId:1,duration:400,inputDelay:10,processing:350}]};p.interactionCpu=p.cpu;
  await f.step({action:'start',goal,profiles:[p]});await f.prepare('function heavy(){ return 2; }');
  await f.step({action:'apply',reviewedPlanHash:f.state.active.planHash});
  const after=await siteRun(t,{devices:['mobile'],offset:400,scores:{mobile:[50]},augment:r=>{r.audits['total-blocking-time'].numericValue=700;}});
  await proof(after,await sourceSnapshot(f.project),f.project);
  await f.step({action:'experiment',experiment:experimentConfig(f.project)},{runPatchExperiment:async({output})=>{
    await mkdir(output,{recursive:true});await writeFile(path.join(output,'patch-evidence.json'),JSON.stringify({before:f.baseline.root,after:after.root}));
    return {output,status:'promising',counts:{attempted:6,failed:0}};
  }});
  const s=await f.step({action:'verify',verification:{after:after.root}},{verifyOptimization:async()=>({outcome:'not-accepted',gain:{outcome:'no-measurable-gain'},checks:[{id:'independent-interaction-gain',pass:true},{id:'content-and-visual-review',pass:false}]})});
  assert.equal(s.status,'formal-validation-required');assert.ok(s.active);assert.equal(s.acceptance,'not-accepted');
});

test('completing missing review cannot replace an already valid formal sample set',async t=>{
  const f=await setup(t),verification=await formalCandidate(t,f),withoutReview={...verification};delete withoutReview.review;
  let s=await f.step({action:'verify',verification:withoutReview});assert.equal(s.status,'formal-validation-required');
  const replacement=await siteRun(t,{devices:['mobile'],offset:600,scores:{mobile:[95]},augment:r=>{r.audits['total-blocking-time'].numericValue=100;}});
  await proof(replacement,await sourceSnapshot(f.project),f.project);
  s=await f.step({action:'verify',verification:{...verification,after:replacement.root}});assert.match(s.error.message,/does not authorize score resampling/);
  s=await f.step({action:'verify',verification});assert.equal(s.error,undefined);assert.equal(s.status,'improved-below-target');
});

test('caller model usage meter cannot decrease between resumed steps',async t=>{
  const f=await setup(t),meter=path.join(f.root,'meter.json');await writeFile(meter,JSON.stringify({usedTokens:500}));
  let s=await f.step({action:'start',budget:{maxModelTokens:1000,modelUsageFile:meter}});assert.equal(s.modelUsageTokens,500);
  await writeFile(meter,JSON.stringify({usedTokens:0}));
  s=await f.prepare('function heavy(){ return 2; }');assert.equal(s.error.code,'SESSION_BUDGET');assert.equal(s.status,'stopped');
  assert.match(s.error.message,/model-usage-invalid/);assert.equal(s.modelUsageTokens,500);
});


test('promising patch freezes nested diagnosis and scenario files before formal review',async t=>{
  const f=await setup(t);await f.step({action:'start'});await f.prepare('function heavy(){ return 2; }');
  await f.step({action:'apply',reviewedPlanHash:f.state.active.planHash});await f.experiment({score:65,tbt:400,external:true});
  assert.equal(f.state.status,'formal-validation-required');
  const original=await read(f.state.active.patchEvidence);
  for(const key of ['diagnosis','regressionBefore','regressionAfter']) {
    assert.equal(typeof original[key],'object');await writeFile(path.join(f.root,`${key}.json`),'{}');
  }
  assert.deepEqual(await read(f.state.active.patchEvidence),original);
});

test('formal Liquid evidence is reused when omitted and cannot be resampled to complete review',async t=>{
  // Inject only the verifier verdict to isolate persistence policy; no server-gain claim.
  const f=await setup(t),verification=await formalCandidate(t,f),liquid={kind:'liquid-experiment',marker:'first valid formal samples'},seen=[];
  const deps={verifyOptimization:async input=>{
    seen.push(input.liquidEvidence);
    return {outcome:'not-accepted',patchExperiment:{liquid:{outcome:'measurable-gain'}},gain:{outcome:'measurable-gain'},checks:[{id:'content-and-visual-review',pass:false}]};
  }};
  let s=await f.step({action:'verify',verification:{...verification,liquidEvidence:liquid}},deps);
  assert.equal(s.error,undefined);assert.ok(s.active.liquidEvidenceHash);
  s=await f.step({action:'verify',verification},deps);assert.equal(s.error,undefined);assert.deepEqual(seen,[liquid,liquid]);
  s=await f.step({action:'verify',verification:{...verification,liquidEvidence:{...liquid,marker:'better samples'}}},deps);
  assert.match(s.error.message,/does not authorize server resampling/);assert.equal(seen.length,2);
});

test('official source snapshot is pinned and changed guidance blocks session generation',async t=>{
  const {readShopifySources}=await import('../lib/shopify-docs.mjs');
  const f=await setup(t),sources=await readShopifySources();sources.documents.find(d=>d.url.endsWith('/defer-non-critical-resources')).contentHash='changed';
  await f.step({action:'start',sources});const r=await read(f.state.recovery),c=r.candidates[0];assert.equal(r.officialKnowledge.status,'review-required');
  const official={schemaVersion:1,candidateId:c.candidateId,methodId:'defer-non-critical-resources',executor:'site:js-idle-init',parameters:{statementStart:0,timeoutMs:100},review:{sourceHash:c.source.sourceHash,summary:'Fixture',nonCritical:true,noFirstInteractionDependency:true,timingChangeReviewed:true}};
  let s=await f.step({action:'prepare',candidateId:c.candidateId,method:'defer-non-critical-resources/site:js-idle-init',rationale:'Test pinned guidance',official});
  assert.equal(s.error.code,'OFFICIAL_SOURCE_REVIEW_REQUIRED');assert.equal(s.preparationFailures.at(-1).method,'js-idle-init');
  s=await f.step({action:'prepare',candidateId:c.candidateId,method:'defer-non-critical-resources/site:js-idle-init',rationale:'Do not replace pinned evidence',official,sources:await readShopifySources()});
  assert.match(s.error.message,/sources are fixed/);assert.equal(s.active,undefined);
});

test('different operator-authored official mechanisms remain available after no gain',async t=>{
  const f=await setup(t);await f.step({action:'start'});const r=await read(f.state.recovery),c=r.candidates[0];
  const prepare=(methodId,text)=>f.step({action:'prepare',candidateId:c.candidateId,method:methodId+'/reviewed-replacement',rationale:'Different authored mechanism after no gain',official:{schemaVersion:1,candidateId:c.candidateId,methodId,executor:'reviewed-replacement',replacementText:text,review:{sourceHash:c.source.sourceHash,summary:'Synthetic complete replacement fixture',allStatesReviewed:true}}});
  await prepare('cancel-view-transitions-on-interaction','function heavy(){ return 1; } // transition implementation fixture');assert.equal(f.state.error,undefined);
  await f.step({action:'apply',reviewedPlanHash:f.state.active.planHash});await f.experiment();assert.equal(f.state.history.at(-1).outcome,'no-measurable-gain');
  const s=await prepare('request-critical-data-before-dom-ready','function heavy(){ return 1; } // independent data timing fixture');
  assert.equal(s.error,undefined);assert.equal(s.active.method,'request-critical-data-before-dom-ready/reviewed-replacement');
});

test('invalid formal resource evidence with flat scores is retained for repair, not recorded as a failed mechanism',async t=>{
  const f=await setup(t),verification=await formalCandidate(t,f),after=await siteRun(t,{devices:['mobile'],offset:600,scores:{mobile:[50]},augment:r=>{r.audits['total-blocking-time'].numericValue=700;}});
  await proof(after,await sourceSnapshot(f.project),f.project);
  const s=await f.step({action:'verify',verification:{...verification,after:after.root,regression:regressionForRun(after),budget:{maxRequests:20}}});
  assert.ok(s.active);assert.equal(s.active.formalAfter,await realpath(after.root));assert.equal(s.history.at(-1).outcome,'promising');
  assert.equal((await read(s.formalRecovery)).action,'repair-evidence');assert.equal((await read(s.verification)).outcome,'invalid-evidence');
  const retry=await f.step({action:'verify',verification});assert.match(retry.error.message,/first valid formal candidate/);
});

test('wrong-store behavior failure does not blacklist a valid patch',async t=>{
  const f=await setup(t),verification=await formalCandidate(t,f),run=verification.regression.scenarios.runs[0];
  Object.assign(run.steps[0],{outcome:'failed',error:{code:'ASSERTION_FAILED',expected:'Fixture',actual:'Broken'}});run.store='other.myshopify.com';
  const s=await f.step({action:'verify',verification});assert.ok(s.active);assert.equal(s.history.at(-1).outcome,'promising');
  assert.equal((await read(s.formalRecovery)).action,'repair-evidence');
});

for(const field of ['review','regression','liquidEvidence'])test(`unreadable ${field} cannot leave the first formal batch replaceable`,async t=>{
  const f=await setup(t),verification=await formalCandidate(t,f),counts={...f.state.counts};
  let s=await f.step({action:'verify',verification:{...verification,[field]:path.join(f.root,'missing.json')}});
  assert.equal(s.error.code,'ENOENT');assert.equal(s.active.formalAfter,await realpath(verification.after));
  const replacement=await siteRun(t,{devices:['mobile'],offset:600,scores:{mobile:[90]}});
  await proof(replacement,await sourceSnapshot(f.project),f.project);
  s=await f.step({action:'verify',verification:{...verification,after:replacement.root}});
  assert.match(s.error.message,/first valid formal candidate/);assert.deepEqual(s.counts,counts);
  s=await f.step({action:'verify',verification});
  assert.equal(s.error,undefined);assert.equal(s.status,'improved-below-target');assert.deepEqual(s.counts,counts);
});

test('formal batch bytes remain fixed after a failed review read',async t=>{
  const f=await setup(t),verification=await formalCandidate(t,f);
  await f.step({action:'verify',verification:{...verification,review:path.join(f.root,'missing.json')}});
  const manifest=await read(path.join(verification.after,'run.json'));
  const reportFile=path.join(verification.after,manifest.groups[0].reports[0]),report=await read(reportFile);
  report.categories.performance.score=1;await writeFile(reportFile,JSON.stringify(report));
  const s=await f.step({action:'verify',verification});
  assert.match(s.error.message,/Previously recorded measurement evidence changed/);assert.equal(s.retained.length,0);
});

test('new mechanism rejects old candidate evidence without poisoning its formal batch or inheriting reviews',async t=>{
  const f=await setup(t),old=await formalCandidate(t,f);
  await f.step({action:'verify',verification:{after:old.after}});
  await f.step({action:'rollback'});await f.prepare('function heavy(){ return 3; }','new-mechanism');
  assert.equal(f.state.active.formalAfter,undefined);assert.equal(f.state.active.interactionEvidence,undefined);assert.equal(f.state.active.liquidEvidence,undefined);
  await f.step({action:'apply',reviewedPlanHash:f.state.active.planHash});await f.experiment({score:90,tbt:100});
  let s=await f.step({action:'verify',verification:old});
  assert.equal(s.status,'formal-validation-required');assert.equal(s.active.formalAfter,undefined);assert.equal(s.retained.length,0);
  const after=await siteRun(t,{devices:['mobile'],offset:600,scores:{mobile:[90]}});await proof(after,await sourceSnapshot(f.project),f.project);
  s=await f.step({action:'verify',verification:{after:after.root,regression:old.regression,review:old.review}});
  assert.equal(s.active.formalAfter,await realpath(after.root));assert.equal(s.retained.length,0);
  const checks=(await read(s.verification)).checks;
  assert.equal(checks.find(c=>c.id==='content-and-visual-review').pass,false);assert.equal(checks.find(c=>c.id==='functional-regression').pass,false);
  s=await f.step({action:'verify',verification:{after:after.root,regression:regressionForRun(after),review:{...old.review,sourceHash:s.active.sourceHash}}});
  assert.equal(s.status,'optimization-accepted',JSON.stringify(s.error));assert.equal(s.counts.rounds,2);assert.equal(s.counts.attempted,12);
});

test('first verify resource budget survives missing files, omission and attempts to loosen it',async t=>{
  const f=await setup(t),verification=await formalCandidate(t,f),budget={maxRequests:20};
  let s=await f.step({action:'verify',verification:{...verification,budget,review:path.join(f.root,'missing.json')}});
  assert.deepEqual(s.verificationBudget,budget);assert.equal(s.error.code,'ENOENT');
  s=await f.step({action:'verify',verification:{...verification,budget:{maxRequests:200}}});
  assert.match(s.error.message,/budget is fixed/);
  s=await f.step({action:'verify',verification});
  assert.equal(s.status,'formal-validation-required');assert.equal(s.retained.length,0);
  assert.equal((await read(s.verification)).outcome,'invalid-evidence'); // Missing resource rows are not free resources.
  assert.deepEqual((await readImprovementSession(path.join(s.output,'session.json'))).verificationBudget,budget);
});
test('a missing navigation directory cannot discard the resource budget supplied with verification',async t=>{
  const f=await setup(t),verification=await formalCandidate(t,f),budget={maxRequests:20},counts={...f.state.counts};
  let s=await f.step({action:'verify',verification:{...verification,after:path.join(f.root,'missing-navigation'),budget}});
  assert.equal(s.error.code,'ENOENT');assert.deepEqual(s.verificationBudget,budget);assert.deepEqual(s.counts,counts);
  s=await f.step({action:'verify',verification:{...verification,budget:{maxRequests:200}}});assert.match(s.error.message,/budget is fixed/);
  s=await f.step({action:'verify',verification});assert.equal(s.retained.length,0);assert.equal((await read(s.verification)).outcome,'invalid-evidence');
  assert.deepEqual(s.verificationBudget,budget);assert.deepEqual(s.counts,counts);
});

test('verification payload cannot override approval, goals or persistent execution counters',async t=>{
  const f=await setup(t),verification=await formalCandidate(t,f),counts={...f.state.counts},budget={...f.state.budget};
  for(const extra of [{reviewedPlanHash:'approved'},{counts:{attempted:0,failed:0,rounds:0}},{goal:{kind:'score'}},{budget:{maxAttempts:9999}}]) {
    const s=await f.step({action:'verify',verification:{...verification,...extra}});
    assert.ok(s.error);assert.equal(s.retained.length,0);assert.deepEqual(s.counts,counts);assert.deepEqual(s.budget,budget);
  }
  const s=await f.step({action:'verify',verification});assert.equal(s.status,'improved-below-target');
});

test('session descendants cannot drop inherited evidence locks or resource budgets even with a recalculated own hash',async t=>{
  const f=await setup(t),verification=await formalCandidate(t,f);
  await f.step({action:'verify',verification:{after:verification.after,budget:{maxRequests:20}}});
  const child=await f.step({action:'verify',verification:{after:verification.after}}),file=path.join(child.output,'session.json');
  for(const mutate of [s=>{s.evidenceRuns={};},s=>{delete s.verificationBudget;},s=>{delete s.active.formalAfter;},s=>{s.active.patchEvidenceHash='rewritten';},s=>{s.counts.attempted=0;}]) {
    const changed=structuredClone(child);mutate(changed);changed.sessionHash=hashSession(changed);
    await writeFile(file,JSON.stringify(changed));
    await assert.rejects(readImprovementSession(file),/Broken session history or reset budget/);
  }
  await writeFile(file,JSON.stringify(child));assert.equal((await readImprovementSession(file)).sessionHash,child.sessionHash);
});

test('a completed schema v1 chain without checkpoints can resume and roll back with inherited pins', async t => {
  const f = await setup(t);
  const start = await f.step({action:'start'});
  const prepared = await f.prepare('function heavy(){ return 2; }');
  const applied = await f.step({action:'apply',reviewedPlanHash:prepared.active.planHash});
  // Completed v1 steps predate checkpoints. Their session and continuation files are sufficient.
  for (const step of [start,prepared,applied]) await rm(path.join(step.output,'checkpoint.json'));
  const previous = path.join(applied.output,'session.json');
  const saved = await readFile(previous,'utf8');
  assert.equal((await readImprovementSession(previous)).schemaVersion,1);
  const rolledBack = await f.step({action:'rollback'});
  assert.equal(rolledBack.error,undefined);
  assert.equal(rolledBack.id,start.id);
  assert.equal(rolledBack.step,applied.step+1);
  assert.equal(rolledBack.parentHash,applied.sessionHash);
  assert.equal(rolledBack.active,null);
  assert.equal(rolledBack.previewSyncRequired,true);
  assert.deepEqual(rolledBack.counts,applied.counts);
  assert.deepEqual(rolledBack.evidenceRuns,applied.evidenceRuns);
  assert.equal((await sourceSnapshot(f.project)).hash,start.baselineHash);
  assert.equal(await readFile(previous,'utf8'),saved);
  assert.equal((await readImprovementSession(path.join(rolledBack.output,'session.json'))).sessionHash,rolledBack.sessionHash);
});
