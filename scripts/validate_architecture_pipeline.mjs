#!/usr/bin/env node
// Real Chrome/Lighthouse and official Theme Check on an isolated local fixture.
// Only Shopify remote source transport is replaced by copying a separate deployed snapshot.
// Final review is supplied separately by an operator; this script never invents approval.
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import {mkdtemp,mkdir,readFile,writeFile,cp,rm} from 'node:fs/promises';
import {Liquid} from 'liquidjs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {runBatch} from '../lib/batch.mjs';
import {runOptimization,verifyOptimization} from '../lib/optimize.mjs';
import {rollbackSitePlan} from '../lib/site-changes.mjs';
import {sourceSnapshot} from '../lib/runtime-profile.mjs';
import {measureSite} from '../lib/measure.mjs';
import {verifyDeployment} from '../lib/deployment.mjs';
import {runPatchExperiment} from '../lib/patch-experiment.mjs';
import {checkCI} from '../lib/ci-check.mjs';
import {renderReport} from '../lib/report.mjs';

const args=process.argv.slice(2), read=async file=>JSON.parse(await readFile(file,'utf8'));
const save=async(file,value)=>writeFile(file,typeof value==='string'?value:JSON.stringify(value,null,2)+'\n',{flag:'wx'});
if(args[0]==='--resume') {
  assert.equal(args.length,4,'Usage: [--resume <run-directory> --review <review.json>]');
  assert.equal(args[0],'--resume');assert.equal(args[2],'--review');
  const root=path.resolve(args[1]),context=await read(path.join(root,'verification-input.json'));
  const review=await read(path.resolve(args[3])),plan=await read(path.join(root,'batch/plan.json'));
  const cli=(command,...a)=>spawnSync(process.execPath,[fileURLToPath(new URL('./perfkit.mjs',import.meta.url)),command,...a],{encoding:'utf8',timeout:60000});
  await save(path.join(root,'cli-without-review.json'),{...context,plan});
  const denied=cli('verify-optimization','--config',path.join(root,'cli-without-review.json'),'--out',path.join(root,'cli-review-denied.json'));
  assert.equal(denied.status,3,denied.stderr);
  await save(path.join(root,'cli-reviewed-input.json'),{...context,plan,review});
  const accepted=cli('verify-optimization','--config',path.join(root,'cli-reviewed-input.json'),'--out',path.join(root,'reviewed-verification.json'));
  assert.equal(accepted.status,0,accepted.stderr||accepted.stdout);
  const verification=await read(path.join(root,'reviewed-verification.json'));
  await save(path.join(root,'reviewed-verification.html'),renderReport(verification));
  assert.equal(verification.outcome,'optimization-accepted',JSON.stringify(verification));
  const rejected=[];
  for(const [name,mutate] of [
    ['missing-review',a=>{delete a.review;}],
    ['wrong-review-source',a=>{a.review.sourceHash='0'.repeat(64);}],
    ['missing-experiment',a=>{delete a.patchEvidence;}],
    ['tampered-plan',a=>{a.plan.changes[0].reason+=' tampered';}],
    ['wrong-regression-theme',a=>{a.regression.scenarios.runs[0].themeId='999';}],
    ['stale-final-deployment',a=>{a.regression.remote.startedAt=a.regression.scenarios.createdAt;}],
    ['missing-matrix-run',a=>{a.regression.scenarios.runs.pop();}],
    ['constrained-regression',a=>{a.regression.scenarios.runs[0].constrained=true;}],
  ]) {
    const input=structuredClone({...context,plan,review});mutate(input);
    const r=await verifyOptimization(input);assert.notEqual(r.outcome,'optimization-accepted',name);
    rejected.push({name,outcome:r.outcome,checks:r.checks,error:r.error});
  }
  await save(path.join(root,'negative-gates.json'),rejected);
  const ci=await checkCI({schemaVersion:1,before:context.before,after:context.after,beforeRevision:'a'.repeat(40),afterRevision:'b'.repeat(40)});
  await save(path.join(root,'ci.json'),ci);await save(path.join(root,'ci.html'),renderReport(ci));
  assert.equal(ci.outcome,'passed');assert.equal(ci.optimization,'not-established-use-verify-optimization');
  const candidate=path.join(root,'candidate'),deployed=path.join(root,'deployed-2');
  await save(path.join(root,'rollback-receipt.json'),await rollbackSitePlan(plan,candidate));
  const original=(await sourceSnapshot(path.join(root,'baseline'))).hash;
  assert.equal((await sourceSnapshot(candidate)).hash,original);
  assert.equal((await sourceSnapshot(deployed)).hash,context.expectedSourceHash,'Local rollback must not silently sync the preview');
  await rm(deployed,{recursive:true});await cp(candidate,deployed,{recursive:true});
  assert.equal((await sourceSnapshot(deployed)).hash,original);
  const summary={kind:'architecture-pipeline-validation',status:'passed',scope:'isolated-fixture-only',output:root,
    realLighthouseReports:26,formalReports:20,exploratoryReports:6,goal:'score',
    manualReview:'external-file-required-and-validated',optimization:verification.outcome,ci:ci.outcome,
    rejectedPaths:rejected.map(r=>r.name),rollback:'source-bytes-restored-explicit-fixture-sync',
    mocked:['Shopify source pull transport only'],notEstablished:['real-store-performance','real-Shopify-sync','GitHub-workflow-execution','field-CWV']};
  await save(path.join(root,'summary.json'),summary);console.log(JSON.stringify(summary,null,2));
} else {
  const continuing=args[0]==='--continue-after-batch';
  assert.ok(args.length===0||continuing&&args.length===2,'Usage: [--continue-after-batch <run-directory>] or [--resume <run-directory> --review <review.json>]');
  const root=continuing?path.resolve(args[1]):await mkdtemp('/private/tmp/perfkit-architecture-live-'),baseline=path.join(root,'baseline'),candidate=path.join(root,'candidate');
  const previous=continuing?await read(path.join(root,'batch/measurement/run.json')):null;
  const stage=name=>console.log(JSON.stringify({stage:name,output:root}));
  const css='body { margin: 20px; font-family: sans-serif; }\nh1 { color: navy; }\nbutton { padding: 8px; }\n'
    +Array.from({length:3000},(_,i)=>`.unused-${i} { color: red; margin: 20px; padding: 32px; border-radius: 8px; }`).join('\n');
  const files={'assets/main.css':css,'layout/theme.liquid':'<link rel="stylesheet" href="{{ \'main.css\' | asset_url }}">','templates/index.json':'{"sections":{}}'};
  if(!continuing){
    for(const [file,body] of Object.entries(files)){await mkdir(path.dirname(path.join(baseline,file)),{recursive:true});await writeFile(path.join(baseline,file),body);}
    await cp(baseline,candidate,{recursive:true});
  }
  const projects={'1':baseline,'2':candidate},deployed=Object.fromEntries(['1','2'].map(id=>[id,path.join(root,`deployed-${id}`)]));
  if(!continuing)for(const id of ['1','2'])await cp(projects[id],deployed[id],{recursive:true});
  const initial=(await sourceSnapshot(baseline)).hash;
  if(continuing){
    assert.equal(previous.status,'complete');assert.equal(previous.deployment.after.sourceHash,initial);
    for(const dir of [candidate,...Object.values(deployed)])assert.equal((await sourceSnapshot(dir)).hash,initial,'Continue only before any candidate apply or sync');
  }
  const server=http.createServer(async(req,res)=>{
    const url=new URL(req.url,'http://127.0.0.1'),id=url.searchParams.get('preview_theme_id')??'1',project=deployed[id];
    try {
      if(!project||!['GET','HEAD'].includes(req.method)){res.writeHead(404);res.end();return;}
      res.setHeader('Cache-Control','no-store');
      if(url.pathname==='/favicon.ico'){res.writeHead(204);res.end();return;}
      if(url.pathname.startsWith('/assets/')){
        const text=await readFile(path.join(project,'assets',path.posix.basename(url.pathname)),'utf8');res.setHeader('Content-Type','text/css');
        if(url.pathname.endsWith('/main.css'))await new Promise(resolve=>setTimeout(resolve,2500));res.end(text);return;
      }
      const liquid=new Liquid();liquid.registerFilter('asset_url',name=>`/assets/${name}?preview_theme_id=${id}`);
      const styles=await liquid.parseAndRender(await readFile(path.join(project,'layout/theme.liquid'),'utf8'));
      res.setHeader('Content-Type','text/html');res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Architecture acceptance fixture</title>${styles}<script>window.Shopify={theme:{id:${id}},shop:'fixture.myshopify.com'};</script></head><body><h1>Unchanged fixture heading</h1><p>Identical content and layout on both sides.</p><button type="button" onclick="document.querySelector('output').textContent=String(Number(document.querySelector('output').textContent)+1)">Open</button><output>0</output></body></html>`);
    }catch{res.writeHead(500);res.end('Fixture error');}
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(previous?Number(new URL(previous.config.pages[0].url).port):0,'127.0.0.1',resolve);});
  const origin=`http://127.0.0.1:${server.address().port}`;
  const verify=({config,pages})=>verifyDeployment({config,pages,dependencies:{runProcess:async(_command,a)=>{
    assert.deepEqual(a.slice(0,2),['theme','pull']);const id=a[a.indexOf('--theme')+1];
    await cp(deployed[id],a[a.indexOf('--path')+1],{recursive:true});return {code:0,stdout:'Isolated fixture source transport',stderr:''};
  }}});
  const measurement=id=>({schemaVersion:1,engine:'lighthouse',pages:[{id:'fixture',url:`${origin}/?preview_theme_id=${id}`}],devices:['mobile','desktop'],runs:5,timeoutMs:90000,
    deployment:{project:projects[id],store:'fixture.myshopify.com',themeId:id,timeoutMs:30000}});
  const regression=id=>({schemaVersion:1,url:measurement(id).pages[0].url,viewports:[{name:'mobile',width:390,height:844},{name:'desktop',width:1440,height:900}],
    scenarios:[{name:'first-action',steps:[{action:'click',selector:'button'},{action:'assert-text',selector:'output',text:'1'},{action:'checkpoint',selector:'body',key:'opened'}]}]});
  try {
    stage('batch-precheck-profile-baseline-diagnosis-plan');
    const batch=continuing?await read(path.join(root,'batch/batch.json')):await runBatch({config:{schemaVersion:1,project:baseline,precheck:true,measurement:measurement('1'),stylesheets:true,
      runtimeProfiles:['mobile','desktop'].map(device=>({schemaVersion:1,url:measurement('1').pages[0].url,device,settleMs:100,actions:[{type:'click',selector:'button'}],expectedThemeId:'1'})),
      bottlenecks:{limit:10},demand:{schemaVersion:1,mode:'critical-css',source:'assets/main.css',newAsset:'assets/critical.css',loaderTarget:'layout/theme.liquid',tagStart:0,inlineLoadHandlerAllowed:true}},
      output:path.join(root,'batch'),dependencies:{measurement:{verifyDeployment:verify}}});
    assert.equal(batch.status,'complete',JSON.stringify(batch));assert.equal(batch.reviewRequired,true);
    const commands=batch.steps.map(s=>s.command);
    assert.ok(commands.indexOf('precheck')<commands.indexOf('profile-runtime')&&commands.indexOf('profile-runtime')<commands.indexOf('measure')
      &&commands.indexOf('measure')<commands.indexOf('diagnose-performance'));
    assert.equal((await sourceSnapshot(baseline)).hash,initial,'batch must not apply the plan');
    const planFile=path.join(root,'batch/plan.json'),plan=await read(planFile),diagnosis=await read(path.join(root,'batch/bottlenecks.json'));
    // Fixture transformation is reviewed by the operator when maintaining this script.
    // Final content/visual approval remains a separate, supplied review file.
    assert.deepEqual(plan.changes.map(c=>c.target).sort(),['assets/critical.css','layout/theme.liquid']);
    assert.ok(plan.verificationRequired.length);for(const c of plan.changes)assert.ok(c.diff);
    const apply={schemaVersion:1,action:'apply',project:candidate,plan:planFile,reviewedPlanHash:'unreviewed'};
    assert.equal((await runOptimization({config:apply,output:path.join(root,'unreviewed-apply')})).status,'failed');
    assert.equal((await sourceSnapshot(candidate)).hash,initial);
    stage('reviewed-apply-and-stale-preview-refusal');
    const applied=await runOptimization({config:{...apply,reviewedPlanHash:plan.planHash},output:path.join(root,'apply')});
    assert.equal(applied.status,'awaiting-preview-sync');
    const stale=await verify({config:measurement('2').deployment,pages:measurement('2').pages});
    await save(path.join(root,'stale-preview.json'),stale);assert.notEqual(stale.status,'verified');
    assert.equal((await sourceSnapshot(deployed['2'])).hash,initial);
    await rm(deployed['2'],{recursive:true});await cp(candidate,deployed['2'],{recursive:true});
    stage('single-patch-alternating-experiment');
    const experiment=await runPatchExperiment({config:{schemaVersion:1,plan,diagnosis,candidateId:plan.changes[0].evidence.candidateId,
      before:{...measurement('1'),devices:['mobile']},after:{...measurement('2'),devices:['mobile']},
      regressionBefore:regression('1'),regressionAfter:regression('2'),budget:{maxWallTimeMs:600000,maxAttempts:6,maxFailures:1,maxCandidateRounds:1}},output:path.join(root,'experiment'),dependencies:{verifyDeployment:verify}});
    assert.equal(experiment.status,'promising',JSON.stringify(experiment.verification));
    assert.equal(experiment.formalAcceptance,'not-evaluated');
    stage('formal-optimize-without-visual-review');
    const config={schemaVersion:1,action:'verify',project:candidate,plan:planFile,reviewedPlanHash:plan.planHash,
      before:path.join(root,'batch/measurement'),measurement:measurement('2'),scenarios:regression('2'),
      patchEvidence:path.join(root,'experiment/patch-evidence.json'),exploreFirst:false};
    const result=await runOptimization({config,output:path.join(root,'formal'),dependencies:{
      measureSite:args=>measureSite({...args,dependencies:{verifyDeployment:verify}}),verifyDeployment:verify}});
    assert.equal(result.status,'not-accepted',JSON.stringify(result));
    const gates=await read(path.join(root,'formal/verification.json'));
    assert.deepEqual(gates.checks.filter(c=>!c.pass).map(c=>c.id),['content-and-visual-review'],JSON.stringify(gates));
    await save(path.join(root,'verification-input.json'),{before:config.before,after:path.join(root,'formal/acceptance'),
      expectedSourceHash:applied.sourceHash,patchEvidence:config.patchEvidence,regression:await read(path.join(root,'formal/regression-evidence.json'))});
    await save(path.join(root,'review-request.json'),{status:'awaiting-operator-review',sourceHash:applied.sourceHash,
      inspect:['batch/plan.json','experiment/preservation.json','experiment/regression-before','experiment/regression-after','formal/regression'],
      instruction:'Inspect the diff, checkpoints and screenshots. Supply a separate review.json with this sourceHash, contentPreserved, visualsPreserved and a specific review summary. Resume with --resume RUN --review FILE; do not repeat measurement.'});
    stage('awaiting-operator-review');
  }catch(error){await save(path.join(root,`failure-${Date.now()}.json`),{error:error.message,stack:error.stack});throw error;}
  finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
}
