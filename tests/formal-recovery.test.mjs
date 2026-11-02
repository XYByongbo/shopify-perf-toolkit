import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {mkdir,writeFile} from 'node:fs/promises';
import {setup,runtime,proof,read,experimentConfig,freshRuntime} from './helpers/improvement-fixture.mjs';
import {interactionFixture} from './helpers/interaction-fixture.mjs';
import {siteRun} from './helpers/site-run.mjs';
import {sourceSnapshot} from '../lib/runtime-profile.mjs';
import {collectOptimizationEvidence} from '../lib/optimization-collection.mjs';
import {runRecoveryCycle} from '../lib/recovery-cycle.mjs';
import {formalRecoveryDecision} from '../lib/formal-recovery.mjs';

for(const [duration,repair] of [[160,false],[300,false],[400,false],[160,'verify'],[160,'collect'],[160,'missing-navigation']])test(`formal interaction ${repair?repair+' pins samples despite another read failure':duration===160?'positive samples remain pinned through evidence repair':duration===300?'no gain returns to recovery':'regression returns to recovery'}`,async t=>{
  const f=await setup(t,{maxAttempts:40,maxCandidateRounds:4}),p=await runtime(f.project),beforeSnapshot=await sourceSnapshot(f.project),goal={kind:'interaction',target:'#buy',event:'click'};
  const interaction=p=>{p.afterActions={interactions:[{target:'#buy',name:'click',interactionId:1,duration:400,inputDelay:10,processing:350}]};p.interactionCpu=p.cpu;return p;};
  await f.step({action:'start',goal,profiles:[interaction(p)]});await f.prepare('function heavy(){ return 2; }');await f.step({action:'apply',reviewedPlanHash:f.state.active.planHash});
  const after=await siteRun(t,{devices:['mobile'],offset:400,scores:{mobile:[50]},augment:r=>{r.audits['total-blocking-time'].numericValue=700;}});await proof(after,await sourceSnapshot(f.project),f.project);
  // Isolate the formal gate: exploration runner is stubbed; formal Event Timing parsing and source identity are real.
  await f.step({action:'experiment',experiment:experimentConfig(f.project)},{runPatchExperiment:async({output})=>{
    await mkdir(output,{recursive:true});await writeFile(path.join(output,'patch-evidence.json'),JSON.stringify({before:f.baseline.root,after:after.root}));return {output,status:'promising',counts:{attempted:6,failed:0}};
  }});
  const a=await interactionFixture(t,{project:f.project,files:beforeSnapshot.files,themeId:'1'}),b=await interactionFixture(t,{after:true,duration,project:f.project,files:(await sourceSnapshot(f.project)).files,themeId:'1'});
  const measurement={...experimentConfig(f.project).after,purpose:'acceptance',runs:5,deployment:{...experimentConfig(f.project).after.deployment,themeId:'1'}};
  if(repair) {
    const data={interactionEvidence:{before:a.root,after:b.root},review:path.join(f.root,'missing.json')};
    const first=await f.step(repair!=='collect'?{action:'verify',verification:{after:repair==='missing-navigation'?path.join(f.root,'missing-navigation'):after.root,...data}}:{action:'collect',formal:{measurement,scenarios:{},...data}},
      {collectOptimizationEvidence:()=>assert.fail('Missing review must not start collection')});
    assert.equal(first.error.code,'ENOENT');assert.ok(first.active.interactionEvidenceHash);
    const replacement=await interactionFixture(t,{after:true,duration:120,project:f.project,files:(await sourceSnapshot(f.project)).files,themeId:'1'});
    const retry=await f.step({action:'verify',verification:{after:after.root,interactionEvidence:{before:a.root,after:replacement.root}}});
    assert.match(retry.error.message,/first valid formal interaction samples/);assert.equal(retry.counts.attempted,6);
    assert.equal(retry.active.interactionEvidenceHash,first.active.interactionEvidenceHash);return;
  }
  let navigation=0;
  const rejected=await f.step({action:'collect',formal:{measurement,scenarios:{},interactionEvidence:{before:a.root,after:b.root}}},{collectOptimizationEvidence:args=>collectOptimizationEvidence({...args,dependencies:{measureSite:()=>{navigation++;assert.fail('Do not collect navigation to reconfirm negative formal interaction evidence');}}})});
  if(duration===160) {
    assert.ok(rejected.active.interactionEvidenceHash);assert.equal(navigation,0);assert.ok(rejected.error);
    const replacement=await interactionFixture(t,{after:true,duration:120,project:f.project,files:(await sourceSnapshot(f.project)).files,themeId:'1'});
    const again=await f.step({action:'collect',formal:{measurement,scenarios:{},interactionEvidence:{before:a.root,after:replacement.root}}});
    assert.match(again.error.message,/first valid formal interaction samples/);assert.equal(again.counts.attempted,6);return;
  }
  assert.equal(rejected.error,undefined,JSON.stringify(rejected));assert.equal(rejected.active,null);assert.equal(navigation,0);
  assert.equal(rejected.history.at(-1).outcome,'formal-rejected');assert.equal(rejected.history.at(-1).formalEvidence.stage,'before-navigation');assert.equal(rejected.counts.attempted,6);
  const c=(await read(rejected.recovery)).candidates[0],recipe={schemaVersion:1,changes:[{target:'assets/main.js',kind:'reviewed-replacement',replacementText:'function heavy(){ return 3; }',reason:'Synthetic alternate mechanism',evidence:{summary:'Controller transition fixture',candidateId:c.candidateId,diagnosisSourceHash:rejected.baselineHash}}]};
  const result=await runRecoveryCycle({config:{schemaVersion:1,previous:path.join(rejected.output,'session.json'),options:[{id:'different',prepare:{candidateId:c.candidateId,method:'different-mechanism',rationale:'Formal target failed; use new evidence',recipe},experiment:experimentConfig(f.project)}]},output:path.join(f.root,'next-cycle'),dependencies:{verifyDeployment:async()=>({status:'verified',sourceHash:(await sourceSnapshot(f.project)).hash}),profileDomain:async({config})=>interaction(await freshRuntime(config))}});
  assert.equal(result.status,'review-required',JSON.stringify(result));assert.ok(result.events.some(e=>e.action==='reprofile'));
  assert.equal((await read(result.plan)).changes[0].after,'function heavy(){ return 3; }');
});

test('formal recovery distinguishes valid interaction rejection from missing or mismatched evidence',()=>{
  const input={goal:{kind:'interaction'},sourceHash:'hash',verification:{outcome:'not-accepted',scoreTargets:{outcome:'score-targets-met'},gain:{outcome:'no-measurable-gain'},
    checks:['candidate-identity','plan-matches-measured-source','interaction-evidence-identity'].map(id=>({id,pass:true})),interactions:{outcome:'interaction-regressed'}},cumulative:{outcome:'no-measurable-gain'}};
  assert.equal(formalRecoveryDecision(input).action,'reject-patch');
  for(const change of [v=>v.outcome='invalid-evidence',v=>v.checks[0].pass=false,v=>v.checks[2].pass=false,v=>v.interactions.outcome='invalid-evidence']){
    const copy=structuredClone(input);change(copy.verification);assert.equal(formalRecoveryDecision(copy).action,'repair-evidence');
  }
});
