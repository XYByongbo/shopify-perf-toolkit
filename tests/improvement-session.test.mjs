import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
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

const url = 'https://shop.example.test/?preview_theme_id=1';
const read = async file => JSON.parse(await readFile(file,'utf8'));
const experimentConfig = project => ({schemaVersion:1,
  before:{schemaVersion:1,engine:'lighthouse',devices:['mobile'],pages:[{id:'home',url}],deployment:{project:project+'-baseline',store:'fixture.myshopify.com',themeId:'1'}},
  after:{schemaVersion:1,engine:'lighthouse',devices:['mobile'],pages:[{id:'home',url}],deployment:{project,store:'fixture.myshopify.com',themeId:'2'}}});
async function proof(fixture,snapshot,project) {
  const declaration={project,store:'fixture.myshopify.com',themeId:'1'};
  const p={kind:'deployment-proof',status:'verified',scope:'theme-text-source',method:'shopify-cli-source-pull-and-browser-theme-id',...declaration,
    sourceHash:snapshot.hash,remoteSourceHash:snapshot.hash,sourceManifest:snapshot.files,
    pages:fixture.manifest.config.pages.map(page=>({...page,status:'verified',store:declaration.store,themeId:'1'}))};
  Object.assign(fixture.manifest,{startedAt:'2026-10-15T23:57:00Z',finishedAt:'2026-10-18T00:02:00Z',deployment:{
    before:{...p,startedAt:'2026-10-15T23:58:00Z',finishedAt:'2026-10-15T23:59:00Z'},
    after:{...p,startedAt:'2026-10-18T00:00:00Z',finishedAt:'2026-10-18T00:01:00Z'}}});
  fixture.manifest.config.deployment=declaration;await saveManifest(fixture);
}
function regression(hash) {
  return {kind:'scenarios',sourceHash:hash,sourceStable:true,outcome:'passed',environment:{browserVersion:'synthetic'},
    runs:[{name:'action',url,viewport:{name:'mobile',width:390,height:844,dpr:1},themeId:'1',outcome:'passed',constrained:false,blockedRequests:[],pageErrors:[],steps:[
      {index:0,action:'click',selector:'button',times:1,outcome:'passed',elapsedMs:20},
      {index:1,action:'assert-text',selector:'output',text:'1',outcome:'passed',elapsedMs:10},
      {index:2,action:'checkpoint',key:'open',selector:'main',outcome:'passed',observation:{version:1,
        content:[{tag:'MAIN',text:['Fixture']}],layout:[{rect:[0,0,100,30],styles:Object.fromEntries(preservationStyles.map(k=>[k,'fixture']))}]}}
    ]}]};
}
async function runtime(project) {
  const snapshot=await sourceSnapshot(project),source={status:'verified-bytes',...snapshot.files.find(f=>f.file==='assets/main.js'),line:1};
  return {kind:'runtime-profile',status:'complete',sourceStable:true,snapshot,config:{url,device:'mobile',state:'initial',actions:[]},
    cpu:[{selfMs:400,inclusiveMs:400,functionName:'heavy',source,url:'https://cdn.example.test/main.js'}],resources:[],renderResources:[],coverage:{js:[],css:[]},lcp:{renderDelayMs:200}};
}
async function setup(t, budget={maxCandidateRounds:4}, exploration=false) {
  const root=await mkdtemp('/private/tmp/perfkit-improve-');t.after(()=>rm(root,{recursive:true,force:true}));
  const project=path.join(root,'theme');await mkdir(path.join(project,'assets'),{recursive:true});
  await writeFile(path.join(project,'assets/main.js'),'function heavy(){ return 1; }');
  const baseline=await siteRun(t,{devices:['mobile'],reports:exploration?3:5,scores:{mobile:[50]},augment:r=>{
    r.audits['total-blocking-time'].numericValue=700;
    r.audits['total-blocking-time'].score=0.1;
    r.categories.performance.auditRefs=[{id:'total-blocking-time',weight:30},{id:'largest-contentful-paint',weight:25},{id:'cumulative-layout-shift',weight:25},{id:'first-contentful-paint',weight:10},{id:'speed-index',weight:10}];
  }});
  if(exploration){baseline.manifest.config.purpose='exploration';baseline.manifest.config.runs=3;}
  await proof(baseline,await sourceSnapshot(project),project);
  let state,index=0;
  const step=async (input,deps={})=>{
    state=await runImprovement({config:{schemaVersion:1,...(state?{previous:path.join(state.output,'session.json')}:{project,run:baseline.root,profiles:[await runtime(project)],budget}),...input},
      output:path.join(root,`step-${index++}`),dependencies:deps});return state;
  };
  const prepare=async (text,method='replace-work')=>{
    const recovery=await read(state.recovery),c=recovery.candidates[0];
    return step({action:'prepare',candidateId:c.candidateId,method,rationale:'Measured CPU frame; remove repeated work and preserve output.',recipe:{schemaVersion:1,changes:[{
      kind:'reviewed-replacement',target:'assets/main.js',replacementText:text,reason:'Synthetic fixture implementation',
      evidence:{summary:'Synthetic source-bound hypothesis, no real-store claim',candidateId:c.candidateId,diagnosisSourceHash:state.baselineHash}
    }]}});
  };
  const experiment=async ({score=50,tbt=700,external=false}={})=>{
    const baselineSnapshot=await read(state.active.diagnosis),before=state.baselineRun;
    return step({action:'experiment',experiment:experimentConfig(project)}, {runPatchExperiment:async ({config,output})=>{
      await mkdir(output,{recursive:true});
      const plan=await read(config.plan),diagnosis=await read(config.diagnosis),snapshot=await sourceSnapshot(project);
      const after=await siteRun(t,{devices:['mobile'],offset:100+index*20,scores:{mobile:[score]},augment:r=>{r.audits['total-blocking-time'].numericValue=tbt;}});
      await proof(after,snapshot,project);
      const input={plan,diagnosis,candidateId:config.candidateId,before,after:after.root,goal:config.goal,
        regressionBefore:regression(baselineSnapshot.sourceHash),regressionAfter:regression(snapshot.hash)};
      const verification=await verifyPatchExperiment(input);
      if(external)for(const key of ['diagnosis','regressionBefore','regressionAfter']){const file=path.join(root,`${key}.json`);await writeFile(file,JSON.stringify(input[key]));input[key]=file;}
      await writeFile(path.join(output,'patch-evidence.json'),JSON.stringify(input));
      return {output,status:verification.outcome,verification,counts:{attempted:6,failed:0}};
    }});
  };
  return {root,project,baseline,step,prepare,experiment,get state(){return state;}};
}

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
  assert.equal(s.active,null);assert.equal(s.counts.attempted,1);assert.equal(s.counts.failed,1);
  s=await f.prepare('function heavy(){ return 2; }');assert.equal(s.error,undefined);assert.equal(s.status,'review-required');
  assert.equal(s.history.length,1);
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

test('runner exception consumes its reservation, records failure and restores actual source',async t=>{
  const f=await setup(t);await f.step({action:'start'});await f.prepare('function heavy(){ return 2; }');
  await f.step({action:'apply',reviewedPlanHash:f.state.active.planHash});
  const s=await f.step({action:'experiment',experiment:experimentConfig(f.project)},
    {runPatchExperiment:async()=>{throw new Error('Runner failed after unknown progress');}});
  assert.equal(s.active,null);assert.equal(s.counts.attempted,6);assert.equal(s.counts.failed,1);
  assert.equal(s.history[0].outcome,'invalid-evidence');assert.match(s.history[0].error,/unknown progress/);
  assert.equal(await readFile(path.join(f.project,'assets/main.js'),'utf8'),'function heavy(){ return 1; }');
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
  verification.regression.scenarios.runs[0].steps[0].outcome='failed';
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
