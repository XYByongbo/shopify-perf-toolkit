import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {mkdir,writeFile,readFile,cp} from 'node:fs/promises';
import {setup,proof,read,regression,experimentConfig,freshRuntime} from './helpers/improvement-fixture.mjs';
import {sourceSnapshot,sha256} from '../lib/runtime-profile.mjs';
import {createSitePlan} from '../lib/site-changes.mjs';
import {createDemandPlan} from '../lib/demand-plan.mjs';
import {runRecoveryCycle} from '../lib/recovery-cycle.mjs';
import {readImprovementSession} from '../lib/improvement-session.mjs';
import {verifyPatchExperiment} from '../lib/patch-experiment.mjs';
import {siteRun,regressionForRun} from './helpers/site-run.mjs';

const css='.always { color: red; }\n.new-state { display: block; }\n'+Array.from({length:40},(_,i)=>`.unused-${i} { color: blue; padding: 20px; }`).join('\n');
async function cssProfile(project,device,mode='original',config) {
  const request=config??{deployment:experimentConfig(project).after.deployment,url:experimentConfig(project).after.pages[0].url,profile:{device,state:'opened',actions:[{type:'click',selector:'button'}]}};
  const p=await freshRuntime(request),source={status:'verified-bytes',...p.snapshot.files.find(f=>f.file==='assets/main.css')};
  const ranges=mode==='all'?[{start:0,end:css.length}]:[{start:0,end:css.indexOf('\n')},...(mode==='new'&&device==='desktop'?[{start:css.indexOf('.new-state'),end:css.indexOf('\n',css.indexOf('.new-state'))}]:[])];
  return {...p,cpu:[],actions:request.profile.actions.map((a,i)=>({...a,status:'completed',startedAtMs:i*10,finishedAtMs:i*10+5})),
    resources:[{source,url:'https://cdn.example.test/main.css',type:'Stylesheet',timestamp:1,finishedTimestamp:2}],renderResources:[{tag:'link',url:'https://cdn.example.test/main.css',media:''}],
    coverage:{js:[],css:[{status:'observed',sourceHash:source.sourceHash,url:'https://cdn.example.test/main.css',ranges,totalBytes:css.length,usedBytes:ranges.reduce((n,r)=>n+r.end-r.start,0)}]}};
}

// Only browser acquisition is synthetic. Diagnosis, generation, review, apply and experiment verification are real.
for(const mode of ['new','all'])test(`fresh CSS coverage ${mode==='new'?'changes the emitted patch and invalidates stale review':'removes a formerly feasible optimization instead of replaying it'}`,async t=>{
  const f=await setup(t,{maxCandidateRounds:4,maxAttempts:40,maxFailures:5});
  await mkdir(path.join(f.project,'layout'));
  await writeFile(path.join(f.project,'assets/main.css'),css);
  await writeFile(path.join(f.project,'layout/theme.liquid'),'<link rel="stylesheet" href="{{ \'main.css\' | asset_url }}">');
  await proof(f.baseline,await sourceSnapshot(f.project),f.project);
  const profiles=await Promise.all(['mobile','desktop'].map(d=>cssProfile(f.project,d)));
  const start=await f.step({action:'start',profiles,goal:{kind:'loading',metric:'fcp'}}),recovery=await read(start.recovery);
  const c=recovery.candidates.find(c=>c.kind==='render-resource'),demand={schemaVersion:1,mode:'critical-css',source:'assets/main.css',newAsset:'assets/critical.css',loaderTarget:'layout/theme.liquid',tagStart:0,inlineLoadHandlerAllowed:true,candidateId:c.candidateId};
  const recipe={schemaVersion:1,changes:[{target:'assets/main.css',kind:'reviewed-replacement',replacementText:css+'\n/* control */',reason:'Control',evidence:{summary:'Synthetic source-bound control',candidateId:c.candidateId,diagnosisSourceHash:start.baselineHash}}]};
  const old=await createDemandPlan({project:f.project,config:demand,diagnosis:recovery.diagnosis,profiles});
  const options=[{id:'control',prepare:{candidateId:c.candidateId,method:'control',rationale:'Negative control',recipe},reviewedPlan:await createSitePlan({project:f.project,recipe})},
    {id:'critical',prepare:{candidateId:c.candidateId,method:'critical-css',rationale:'Use newly captured state coverage',demand},reviewedPlan:old}].map(o=>({...o,experiment:experimentConfig(f.project)}));
  const oldFiles=new Map((await sourceSnapshot(f.project)).files.map(f=>[f.file,f]));
  for(const change of old.changes)oldFiles.set(change.target,{file:change.target,sourceHash:change.afterHash});
  const oldSourceHash=sha256(JSON.stringify([...oldFiles.values()].sort((a,b)=>a.file.localeCompare(b.file))));
  options[1].formal={measurement:{...experimentConfig(f.project).after,purpose:'acceptance',runs:5},scenarios:{},
    review:{sourceHash:oldSourceHash,contentPreserved:true,visualsPreserved:true,summary:'Synthetic content review for the old generated CSS.'}};
  let experiments=0,captures=0,collections=0;
  const deps={verifyDeployment:async()=>({status:'verified',sourceHash:(await sourceSnapshot(f.project)).hash}),
    profileDomain:async({config})=>{captures++;return cssProfile(f.project,config.profile.device,mode,config);},
    collectOptimizationEvidence:async({output})=>{
      collections++;await mkdir(output,{recursive:true});
      const after=await siteRun(t,{devices:['mobile'],offset:300,scores:{mobile:[90]},augment:r=>{r.audits['first-contentful-paint'].numericValue=300;}});
      await proof(after,await sourceSnapshot(f.project),f.project);await cp(after.root,path.join(output,'acceptance'),{recursive:true});
      await writeFile(path.join(output,'regression-evidence.json'),JSON.stringify(regressionForRun(after)));
      return {budget:{counts:{attempted:5}},artifacts:{'regression-evidence.json':'regression-evidence.json'}};
    },runPatchExperiment:async({config,output})=>{
      experiments++;await mkdir(output,{recursive:true});const diagnosis=await read(config.diagnosis),plan=await read(config.plan),snapshot=await sourceSnapshot(f.project);
      const after=await siteRun(t,{devices:['mobile'],offset:100+experiments*20,scores:{mobile:[experiments===1?50:90]},augment:r=>{
        r.audits['total-blocking-time'].numericValue=experiments===1?700:100;r.audits['first-contentful-paint'].numericValue=experiments===1?1000:300;
      }});await proof(after,snapshot,f.project);
      const input={plan,diagnosis,candidateId:config.candidateId,before:f.baseline.root,after:after.root,goal:config.goal,regressionBefore:regression(diagnosis.sourceHash),regressionAfter:regression(snapshot.hash)};
      const verification=await verifyPatchExperiment(input);await writeFile(path.join(output,'patch-evidence.json'),JSON.stringify(input));
      return {output,status:verification.outcome,verification,counts:{attempted:6,failed:0}};
    }};
  const config={schemaVersion:1,previous:path.join(start.output,'session.json'),options};
  let result=await runRecoveryCycle({config,output:path.join(f.root,'adaptive'),dependencies:deps});
  assert.equal(captures,2);assert.equal(experiments,1);
  if(mode==='all') {assert.equal(result.status,'no-supported-alternative',JSON.stringify(result));assert.equal(await readFile(path.join(f.project,'assets/main.css'),'utf8'),css);return;}
  assert.equal(result.status,'review-required',JSON.stringify(result));assert.match(result.reviewReason,/differs/);
  const generated=await read(result.plan),critical=p=>p.changes.find(c=>c.target==='assets/critical.css').after;
  assert.doesNotMatch(critical(old),/new-state/);assert.match(critical(generated),/new-state/);
  options[1].reviewedPlan=result.plan;
  result=await runRecoveryCycle({config:{...config,previous:result.session},output:path.join(f.root,'adaptive-resume'),dependencies:deps});
  assert.equal(result.status,'formal-review-required',JSON.stringify(result));assert.equal(experiments,2);assert.equal(captures,2);assert.equal(collections,0);
  assert.match(await readFile(path.join(f.project,'assets/critical.css'),'utf8'),/new-state/);
  const current=await readImprovementSession(result.session);
  assert.notEqual(current.active.sourceHash,oldSourceHash);assert.equal(current.counts.attempted,14);
  options[1].formal.review={...options[1].formal.review,sourceHash:current.active.sourceHash,summary:'Synthetic updated content review including the newly observed CSS state.'};
  result=await runRecoveryCycle({config:{...config,previous:result.session},output:path.join(f.root,'adaptive-formal'),dependencies:deps});
  assert.equal(result.status,'optimization-accepted',JSON.stringify(result));assert.equal(collections,1);
  assert.equal(experiments,2);assert.equal(captures,2);assert.equal(result.counts.attempted,19);
});

test('fresh cost ranking chooses the newly dominant source rather than the first configured option',async t=>{
  const f=await setup(t);await writeFile(path.join(f.project,'assets/second.js'),'function second(){let n=0;for(let i=0;i<100;i++)n+=i;return 2;}');
  await proof(f.baseline,await sourceSnapshot(f.project),f.project);
  const request={schemaVersion:1,mode:'runtime',deployment:experimentConfig(f.project).after.deployment,url:experimentConfig(f.project).after.pages[0].url,profile:{device:'mobile'}};
  const profile=async changed=>{
    const p=await freshRuntime(request);p.cpu[0].selfMs=changed?100:800;
    p.cpu.push({selfMs:changed?900:100,inclusiveMs:900,functionName:'second',url:'https://cdn.example.test/second.js',source:{status:'verified-bytes',...p.snapshot.files.find(f=>f.file==='assets/second.js'),line:1}});return p;
  };
  const start=await f.step({action:'start',profiles:[await profile(false)]}),old=await read(start.recovery);
  assert.equal(old.candidates[0].file,'assets/main.js');
  const options=old.candidates.map(c=>({id:c.file,prepare:{candidateId:c.candidateId,method:'remove-work',rationale:'Choose current measured hotspot',recipe:{schemaVersion:1,changes:[{target:c.file,kind:'reviewed-replacement',replacementText:c.file==='assets/main.js'?'function heavy(){return 1;}':'function second(){return 2;}',reason:'Remove synthetic unnecessary work',evidence:{summary:'Source-bound test candidate',candidateId:c.candidateId,diagnosisSourceHash:start.baselineHash}}]}},experiment:experimentConfig(f.project)}));
  const fresh=await f.step({action:'reprofile',evidence:[request]},{profileDomain:()=>profile(true)});
  assert.equal(fresh.error,undefined);assert.equal((await read(fresh.recovery)).candidates[0].file,'assets/second.js');
  const r=await runRecoveryCycle({config:{schemaVersion:1,previous:path.join(fresh.output,'session.json'),options},output:path.join(f.root,'ranked-cycle')});
  assert.equal(r.status,'review-required');assert.equal((await read(r.plan)).changes[0].target,'assets/second.js');
});
