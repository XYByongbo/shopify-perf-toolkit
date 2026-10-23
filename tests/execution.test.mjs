// Offline synthetic contracts only. No browser, real network, theme or score measurement.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, rm, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { siteRun, saveManifest, changeReport } from './helpers/site-run.mjs';
import { measureSite, validateMeasureConfig } from '../lib/measure.mjs';
import { verifySite } from '../lib/site-verify.mjs';
import { summarizeRun, compactArtifact } from '../lib/summary.mjs';
import { evaluateIterations } from '../lib/iteration.mjs';
import { runBatch } from '../lib/batch.mjs';
import { validateBudget } from '../lib/execution-policy.mjs';

async function temporary(t) {
  const root=await realpath(await mkdtemp(path.join(os.tmpdir(),'perfkit-execution-')));
  t.after(()=>rm(root,{recursive:true,force:true}));return root;
}
async function transport(t) {
  const f=await siteRun(t,{devices:['mobile']});
  const report=JSON.parse(await readFile(path.join(f.root,f.manifest.groups[0].reports[0]),'utf8'));
  let calls=0;
  return {config:{schemaVersion:1,engine:'psi',pages:[{id:'home',url:report.requestedUrl.replace('shop.example.test','shop.example.com')}],devices:['mobile'],runs:5,timeoutMs:10},
    calls:()=>calls,dependencies:{env:{},lookup:async()=>[{address:'93.184.216.34'}],fetch:async()=>{
      calls++;const copy=structuredClone(report);copy.requestedUrl=copy.finalDisplayedUrl=report.requestedUrl.replace('shop.example.test','shop.example.com');
      copy.fetchTime=new Date(Date.UTC(2026,9,16,1,0,calls)).toISOString();
      return new Response(JSON.stringify({lighthouseResult:copy}),{status:200});
    }}};
}
test('strict budgets and formal sample requirements cannot be lowered implicitly',()=>{
  for(const budget of [{maxAttempts:0},{maxWallTimeMs:NaN},{maxModelTokens:50},{modelUsageFile:'/tmp/usage.json'},{unknown:1}])assert.throws(()=>validateBudget(budget));
  const c={schemaVersion:1,engine:'lighthouse',pages:[{id:'home',url:'https://shop.example.com/'}]};
  assert.throws(()=>validateMeasureConfig({...c,runs:3}));
  assert.equal(validateMeasureConfig({...c,purpose:'exploration'}).runs,3);
  assert.throws(()=>validateMeasureConfig({...c,purpose:'exploration',runs:5}));
});
test('attempt cap saves all reports and explicitly leaves missing samples',async t=>{
  const x=await transport(t),root=await temporary(t);
  const r=await measureSite({config:{...x.config,budget:{maxAttempts:2}},output:path.join(root,'run'),dependencies:x.dependencies});
  assert.equal(x.calls(),2);assert.equal(r.status,'stopped');assert.equal(r.stopped.reason,'attempt-budget');assert.equal(r.stopped.unattempted,3);
  assert.equal(r.groups[0].reports.length,2);assert.equal(r.counts.failed,0);
  const summary=JSON.parse(await readFile(path.join(root,'run/summary.json'),'utf8'));assert.equal(summary.groups[0].scores.length,2);
  assert.equal((await verifySite({before:path.join(root,'run'),after:path.join(root,'run')})).outcome,'invalid-evidence');
});
test('wall budget reserves engine timeout and cleanup before launching transport',async t=>{
  const x=await transport(t),root=await temporary(t);
  const r=await measureSite({config:{...x.config,budget:{maxWallTimeMs:3000}},output:path.join(root,'run'),dependencies:x.dependencies});
  assert.equal(x.calls(),0);assert.equal(r.stopped.reason,'wall-time-budget');
});
test('failure cap stops a broken transport and retains its original failed attempt',async t=>{
  const x=await transport(t),root=await temporary(t);let calls=0;
  const r=await measureSite({config:{...x.config,budget:{maxFailures:1}},output:path.join(root,'run'),dependencies:{...x.dependencies,fetch:async()=>{calls++;return new Response('synthetic failure',{status:503});}}});
  assert.equal(calls,1);assert.equal(r.counts.failed,1);assert.equal(r.stopped.reason,'failure-budget');
  assert.equal(r.groups[0].attempts.length,1);assert.ok(await readFile(path.join(root,'run',r.groups[0].attempts[0].file),'utf8'));
});
test('caller token meter stops on cap or missing data; no model or network is invoked',async t=>{
  const root=await temporary(t),meter=path.join(root,'meter.json');await writeFile(meter,JSON.stringify({usedTokens:100}));
  for(const [file,reason] of [[meter,'model-token-budget'],[path.join(root,'missing.json'),'model-usage-unavailable']]) {
    const x=await transport(t);
    const r=await measureSite({config:{...x.config,budget:{maxModelTokens:100,modelUsageFile:file}},output:path.join(root,reason),dependencies:x.dependencies});
    assert.equal(x.calls(),0);assert.equal(r.stopped.reason,reason);
  }
});
test('explicit exploration is summarized but rejected by unchanged formal evaluator',async t=>{
  const x=await transport(t),root=await temporary(t);
  const r=await measureSite({config:{...x.config,runs:3,purpose:'exploration'},output:path.join(root,'run'),dependencies:x.dependencies});
  assert.equal(r.status,'complete');assert.equal(x.calls(),3);
  assert.equal((await summarizeRun(path.join(root,'run'))).purpose,'exploration');
  const v=await verifySite({before:path.join(root,'run'),after:path.join(root,'run')});
  assert.equal(v.outcome,'invalid-evidence');assert.equal(v.checks[0].details.code,'EXPLORATION_NOT_ACCEPTANCE');
});
test('two low-gain rounds stop and warnings or regressions cannot be called gains',async t=>{
  const b=await siteRun(t,{devices:['mobile'],scores:{mobile:[60]},offset:0});
  const a=await siteRun(t,{devices:['mobile'],scores:{mobile:[61]},offset:10});
  const c=await siteRun(t,{devices:['mobile'],scores:{mobile:[62]},offset:20});
  const history=[{before:b.root,after:a.root},{before:a.root,after:c.root}];
  const r=await evaluateIterations({rounds:history});assert.equal(r.decision,'stop-low-gain');assert.equal(r.rounds.length,2);
  await changeReport(a,d=>{d.runWarnings=['synthetic incomplete load'];});
  assert.equal((await evaluateIterations({rounds:[history[0]]})).decision,'stop-evidence-review');
  const worse=await siteRun(t,{devices:['mobile'],scores:{mobile:[50]},offset:30});
  assert.equal((await evaluateIterations({rounds:[{before:b.root,after:worse.root}]})).decision,'stop-regression-review');
});
test('environment drift and reused timestamps stop candidate evaluation',async t=>{
  const b=await siteRun(t,{devices:['mobile']}),a=await siteRun(t,{devices:['mobile'],offset:10});
  await changeReport(a,d=>{d.fetchTime='2026-10-16T08:00:00+08:00';});
  assert.equal((await evaluateIterations({rounds:[{before:b.root,after:a.root}]})).decision,'stop-evidence-review');
});
test('history gate prevents more exploration without starting a measurement',async t=>{
  const root=await temporary(t),b=await siteRun(t,{devices:['mobile'],scores:{mobile:[60]}}),a=await siteRun(t,{devices:['mobile'],scores:{mobile:[61]},offset:10});
  const r=await runBatch({config:{schemaVersion:1,measurement:{schemaVersion:1,engine:'lighthouse',pages:[{id:'home',url:'https://shop.example.com/'}],purpose:'exploration'},history:[{before:b.root,after:a.root}],budget:{maxCandidateRounds:1}},output:path.join(root,'batch'),dependencies:{measureSite:async()=>assert.fail('must not measure')}});
  assert.equal(r.status,'stopped');assert.equal(r.stopped.reason,'stop-candidate-budget');assert.ok(await readFile(path.join(root,'batch/batch.json'),'utf8'));
});
test('single offline batch evaluates all formal groups and saves a bounded console summary',async t=>{
  const root=await temporary(t),b=await siteRun(t,{scores:{mobile:[85],desktop:[95]}}),a=await siteRun(t,{scores:{mobile:[85],desktop:[95]},offset:20});
  const config=path.join(root,'config.json'),out=path.join(root,'batch');
  await writeFile(config,JSON.stringify({schemaVersion:1,run:a.root,before:b.root,agents:1,budget:{maxWallTimeMs:20000}}));
  const r=spawnSync(process.execPath,['scripts/perfkit.mjs','batch','--config',config,'--out',out],{encoding:'utf8',timeout:25000});
  assert.equal(r.status,0,r.stderr);assert.ok(Buffer.byteLength(r.stdout)<=4097);assert.equal(r.stderr,'');
  const full=JSON.parse(await readFile(path.join(out,'verification.json'),'utf8'));assert.equal(full.outcome,'score-targets-met');assert.equal(full.groups.length,2);
  assert.equal(JSON.parse(await readFile(path.join(out,'batch.json'),'utf8')).agents,1);
  assert.ok(await readFile(path.join(out,'verification.html'),'utf8'));
});
test('summary truncates only console groups; saved raw reports stay byte-identical',async t=>{
  const f=await siteRun(t),file=path.join(f.root,f.manifest.groups[0].reports[0]),before=await readFile(file);
  const s=await summarizeRun(f.root);assert.deepEqual(await readFile(file),before);
  const many={...s,groups:Array.from({length:200},(_,i)=>({...s.groups[0],pageId:'p'+i}))};
  const c=compactArtifact(many);assert.ok(Buffer.byteLength(JSON.stringify(c))<=4096);assert.ok(c.omittedGroups>0);assert.equal(many.groups.length,200);
});

test('exploration can assess a declared subset against all baseline samples without weakening formal acceptance',async t=>{
  const b=await siteRun(t,{scores:{mobile:[60],desktop:[80]}});
  const a=await siteRun(t,{devices:['mobile'],reports:3,scores:{mobile:[70]},offset:20});
  a.manifest.config.runs=3;a.manifest.config.purpose='exploration';await saveManifest(a);
  const d=await evaluateIterations({rounds:[{before:b.root,after:a.root}]});
  assert.equal(d.stop,false);assert.equal(d.rounds[0].outcome,'meaningful-gain');
  assert.deepEqual(d.rounds[0].scope,{assessedGroups:1,baselineGroups:2,acceptance:'not-evaluated'});
  assert.equal((await verifySite({before:b.root,after:a.root})).outcome,'invalid-evidence');
});

test('offline step deadline terminates its owned process group and saves diagnostics',async t=>{
  const {offlineStep}=await import('../lib/batch-offline.mjs');
  const {EventEmitter}=await import('node:events');const {PassThrough}=await import('node:stream');
  const root=await temporary(t),child=new EventEmitter();child.pid=55000;child.stdout=new PassThrough();child.stderr=new PassThrough();const kills=[];
  await assert.rejects(offlineStep('verify-site',['--out',path.join(root,'unused.json')],{output:root,timeoutMs:5},{spawn:()=>child,kill:(pid,signal)=>{kills.push([pid,signal]);setImmediate(()=>child.emit('close',null));}}),{code:'WALL_TIME_BUDGET'});
  assert.deepEqual(kills,[[-55000,'SIGTERM']]);
  assert.equal(JSON.parse(await readFile(path.join(root,'verify-site.transport.json'),'utf8')).timedOut,true);
});
