// Synthetic measurement contracts; no live scoring, external requests, models or theme writes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath, access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { siteRun, saveManifest } from './helpers/site-run.mjs';
import { runBatch } from '../lib/batch.mjs';
import { offlineStep } from '../lib/batch-offline.mjs';
import { compactArtifact } from '../lib/summary.mjs';

const json = async file => JSON.parse(await readFile(file,'utf8'));
async function fixture(t,{clean=false,reports=5,afterScore=85,exploration=false}={}) {
  const root=await realpath(await mkdtemp(path.join(os.tmpdir(),'perfkit-unified-')));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const project=path.join(root,'theme');await mkdir(path.join(project,'sections'),{recursive:true});
  const source=clean?'<div>safe</div>':`{{ product | structured_data }}\n<script src="https://cdn.example.invalid/sdk.js" defer></script><script>SDK.init()</script>\n<img src="https://drive.google.com/example">`;
  await writeFile(path.join(project,'sections/main.liquid'),source);
  const input=path.join(root,'checks-input.json'),metadata=path.join(root,'metadata.json');
  await writeFile(input,JSON.stringify([{path:'sections/main.liquid',offenses:clean?[]:[{check:'UnknownFilter',severity:'error',start_row:0,message:"Unknown filter 'structured_data'"}]}]));
  await writeFile(metadata,JSON.stringify({tool:'synthetic-fixture',toolVersion:'1',scope:'whole-theme',positionBase:0,severityMap:{},rulesConfig:{UnknownFilter:{enabled:true}},scannedFiles:['sections/main.liquid'],complete:true,sourceHashes:{'sections/main.liquid':createHash('sha256').update(source).digest('hex')}}));
  const before=await siteRun(t,{devices:['mobile'],scores:{mobile:[85]}});
  const after=await siteRun(t,{devices:['mobile'],scores:{mobile:[afterScore]},offset:20,reports});
  if(exploration){after.manifest.config.purpose='exploration';after.manifest.config.runs=reports;await saveManifest(after);}
  return {root,project,source,input,metadata,before,after,config:{schemaVersion:1,agents:1,project,run:after.root,before:before.root,checks:{input,metadata},budget:{maxWallTimeMs:20000}}};
}

test('one batch imports checks, audits resources, attaches both reports and preserves independent score acceptance',async t=>{
  const f=await fixture(t),output=path.join(f.root,'batch');
  const r=await runBatch({config:f.config,output});
  assert.equal(r.status,'complete');assert.equal(r.acceptance,'score-targets-met');assert.equal(r.reviewRequired,true);
  assert.deepEqual(r.steps.map(s=>s.command),['import-check','audit-resources','audit-site','verify-site']);
  const checks=await json(path.join(output,'checks.json')),resources=await json(path.join(output,'resources.json')),audit=await json(path.join(output,'audit.json'));
  assert.equal(checks.findings[0].correction.status,'false-positive-candidate');assert.equal(checks.findings[0].severity,'error');
  assert.equal(resources.relationships.length,1);assert.ok(resources.resources.every(r=>r.network.status==='not-probed'));
  assert.deepEqual(audit.supplemental.map(s=>s.kind),['check-import','resource-audit','performance-audit']);assert.ok(audit.supplemental.every(s=>s.status==='current-source'));
  assert.ok(!audit.findings.some(f=>f.ruleId==='UnknownFilter'||f.ruleId==='JS_ORDER'));
  const html=await readFile(path.join(output,'audit.html'),'utf8');assert.ok(html.includes('报告导入与校正'));assert.ok(html.includes('外链资源'));
  for(const name of ['checks.html','resources.html','verification.json','verification.html','summary.json','import-check.transport.json','audit-resources.transport.json'])await access(path.join(output,name));
  assert.equal(await readFile(path.join(f.project,'sections/main.liquid'),'utf8'),f.source);
  const compact=compactArtifact(r);assert.equal(compact.reviewRequired,true);assert.equal(compact.diagnostics.checks.status,'review-required');assert.ok(Buffer.byteLength(JSON.stringify(compact))<=4096);
});

test('CLI returns review exit for diagnostics even when unchanged formal scoring passes',async t=>{
  const f=await fixture(t),config=path.join(f.root,'batch.json'),out=path.join(f.root,'cli-batch');await writeFile(config,JSON.stringify(f.config));
  const r=spawnSync(process.execPath,['scripts/perfkit.mjs','batch','--config',config,'--out',out],{encoding:'utf8',timeout:25000});
  assert.equal(r.status,3,r.stderr);const summary=JSON.parse(r.stdout);assert.equal(summary.acceptance,'score-targets-met');assert.equal(summary.reviewRequired,true);assert.equal(r.stderr,'');assert.ok(Buffer.byteLength(r.stdout)<=4097);
});

test('clean diagnostics and same-contract baseline do not invent a review failure',async t=>{
  const f=await fixture(t,{clean:true}),first=path.join(f.root,'baseline');
  const r1=await runBatch({config:f.config,output:first});assert.equal(r1.reviewRequired,false);
  const r2=await runBatch({config:{...f.config,checks:{...f.config.checks,baseline:path.join(first,'checks.json')}},output:path.join(f.root,'candidate')});
  assert.equal(r2.diagnostics.checks.comparisonGate,'no-new-errors');assert.equal(r2.acceptance,'score-targets-met');assert.equal(r2.reviewRequired,false);
});

test('default project analysis runs without checks; resources false keeps existing batch behavior',async t=>{
  const f=await fixture(t,{clean:true}),{checks,...config}=f.config;
  const enabled=await runBatch({config,output:path.join(f.root,'default')});assert.equal(enabled.diagnostics.checks.status,'not-requested');assert.ok(enabled.artifacts['resources.json']);
  const disabled=await runBatch({config:{...config,resources:false},output:path.join(f.root,'disabled')});assert.equal(disabled.diagnostics.resources.status,'not-requested');assert.ok(!disabled.artifacts['resources.json']);assert.equal(disabled.acceptance,'score-targets-met');
});

test('aggregate PDF claims stay incomplete through batch and cannot be hidden behind passing scores',async t=>{
  const f=await fixture(t,{clean:true});await writeFile(f.input,JSON.stringify({schemaVersion:1,kind:'check-observations',findings:[{ruleId:'ImgWidthAndHeight',severity:'error',count:217,message:'Reported only'}]}));
  const r=await runBatch({config:f.config,output:path.join(f.root,'aggregate')});
  assert.equal(r.status,'complete');assert.equal(r.diagnostics.checks.complete,false);assert.equal(r.diagnostics.checks.reportedOccurrences,217);assert.equal(r.reviewRequired,true);assert.equal(r.acceptance,'score-targets-met');
  assert.equal(r.diagnostics.audit.supplemental.find(s=>s.kind==='check-import').status,'incomplete');
});

test('unsupported config and missing project fail before creating batch output',async t=>{
  const f=await fixture(t);
  for(const [i,config] of [
    {...f.config,project:undefined}, {...f.config,checks:{input:'relative.json'}}, {...f.config,checks:{input:f.input,metdata:f.metadata}},
    {...f.config,resources:{probe:'true'}}, {...f.config,resources:{unknown:true}}, {...f.config,resources:true}, {...f.config,checks:null},
    {...f.config,checks:{run:true,input:f.input}}, {...f.config,checks:{run:false}},
  ].entries()) {const output=path.join(f.root,'bad-'+i);await assert.rejects(runBatch({config,output}));await assert.rejects(access(output));}
});

test('explicit Theme Check failure keeps diagnostics and never reports formal acceptance',async t=>{
  const f=await fixture(t);
  const output=path.join(f.root,'official-failure');
  const {run,...config}=f.config;
  const r=await runBatch({config:{...config,checks:{run:true},
    measurement:{schemaVersion:1,engine:'lighthouse',pages:[{id:'home',url:'https://shop.example.com/'}]}},output,
  dependencies:{
    checkThemeProject:async({timeoutMs})=>{
      assert.ok(timeoutMs>=1000 && timeoutMs<=20000);
      throw Object.assign(new Error('Shopify CLI unavailable'),{code:'ENOENT'});
    },
    measureSite:async()=>assert.fail('must not measure after a failed requested check'),
  }});
  assert.equal(r.status,'failed');
  assert.equal(r.acceptance,'not-evaluated');
  assert.equal(r.diagnostics.checks.status,'failed');
  assert.equal(r.reviewRequired,true);
  assert.equal((await json(path.join(output,'checks-failure.json'))).code,'ENOENT');
  assert.ok(!r.artifacts['checks.json']);
});

test('malformed report stops the batch, saves failure evidence and never starts measurement',async t=>{
  const f=await fixture(t);await writeFile(f.input,'not JSON');const output=path.join(f.root,'bad-input');
  const {run,...config}=f.config;config.measurement={schemaVersion:1,engine:'lighthouse',pages:[{id:'home',url:'https://shop.example.com/'}]};
  const r=await runBatch({config,output,dependencies:{measureSite:async()=>assert.fail('must not measure')}});
  assert.equal(r.status,'failed');assert.equal(r.acceptance,'not-evaluated');assert.equal(r.diagnostics.checks.status,'failed');assert.equal(r.diagnostics.resources.status,'not-run');
  assert.equal((await json(path.join(output,'import-check.transport.json'))).exitCode,2);
});

test('remaining shared budget stops after import and preserves its complete artifact',async t=>{
  const f=await fixture(t);let now=0;const commands=[];
  const r=await runBatch({config:{...f.config,budget:{maxWallTimeMs:20000}},output:path.join(f.root,'budget'),dependencies:{now:()=>now,offlineStep:async(...args)=>{commands.push(args[0]);const report=await offlineStep(...args);now=20001;return report;}}});
  assert.equal(r.status,'stopped');assert.equal(r.stopped.reason,'wall-time-budget');assert.deepEqual(commands,['import-check']);assert.equal(r.diagnostics.resources.status,'not-run');assert.ok(r.artifacts['checks.json']);assert.equal(r.acceptance,'not-evaluated');
});

test('resource deadline is a stopped diagnostic, not a completed scan or score pass',async t=>{
  const f=await fixture(t),{checks,...config}=f.config;
  const r=await runBatch({config,output:path.join(f.root,'timeout'),dependencies:{offlineStep:async command=>{assert.equal(command,'audit-resources');throw Object.assign(new Error('timeout'),{code:'WALL_TIME_BUDGET'});}}});
  assert.equal(r.status,'stopped');assert.equal(r.diagnostics.resources.status,'stopped');assert.equal(r.acceptance,'not-evaluated');
});

test('probe is opt-in and forwarded explicitly to a budget-bound child without live network in this test',async t=>{
  const f=await fixture(t,{clean:true}),commands=[];
  const r=await runBatch({config:{...f.config,resources:{probe:true}},output:path.join(f.root,'probe'),dependencies:{offlineStep:async(command,args,options)=>{
    if(command==='audit-resources'){assert.equal(args[args.indexOf('--probe')+1],'true');assert.ok(options.timeoutMs>0&&options.timeoutMs<=20000);commands.push(command);const offline=[...args];offline[offline.indexOf('--probe')+1]='false';return offlineStep(command,offline,options);}
    return offlineStep(command,args,options);
  }}});
  assert.deepEqual(commands,['audit-resources']);assert.equal(r.diagnostics.resources.probeRequested,true);
});

test('partial measurement retains diagnostics and cannot reach formal verification',async t=>{
  const f=await fixture(t,{reports:3}),r=await runBatch({config:f.config,output:path.join(f.root,'partial')});
  assert.equal(r.status,'stopped');assert.equal(r.acceptance,'not-evaluated');assert.ok(r.artifacts['checks.json']);assert.ok(r.artifacts['resources.json']);assert.ok(!r.artifacts['verification.json']);
});

test('exploration keeps diagnostic artifacts separate and never runs formal score acceptance',async t=>{
  const f=await fixture(t,{reports:3,exploration:true,afterScore:90}),r=await runBatch({config:f.config,output:path.join(f.root,'exploration')});
  assert.ok(r.artifacts['checks.json']);assert.ok(r.artifacts['resources.json']);assert.ok(r.artifacts['iteration.json']);assert.equal(r.acceptance,'not-evaluated');assert.ok(!r.artifacts['verification.json']);assert.ok(r.artifacts['audit.json']);
});

test('clean diagnostics do not raise a below-target score to acceptance',async t=>{
  const f=await fixture(t,{clean:true,afterScore:60}),r=await runBatch({config:f.config,output:path.join(f.root,'low-score')});
  assert.equal(r.reviewRequired,false);assert.notEqual(r.acceptance,'score-targets-met');assert.notEqual(r.acceptance,'not-evaluated');
});

test('source drift after diagnostics remains visible in the combined audit and requires review',async t=>{
  const f=await fixture(t,{clean:true});
  const r=await runBatch({config:f.config,output:path.join(f.root,'drift'),dependencies:{offlineStep:async(...args)=>{
    const report=await offlineStep(...args);
    if(args[0]==='audit-resources')await writeFile(path.join(f.project,'sections/main.liquid'),f.source+'\nchanged');
    return report;
  }}});
  assert.equal(r.status,'complete');assert.equal(r.acceptance,'score-targets-met');assert.equal(r.reviewRequired,true);
  assert.ok(r.diagnostics.audit.supplemental.filter(item=>item.kind!=='performance-audit').every(item=>item.status==='stale'));
  assert.equal(r.diagnostics.audit.supplemental.find(item=>item.kind==='performance-audit').status,'current-source');
});

test('explicit probe with skipped URLs requires review even without static findings',async t=>{
  const f=await fixture(t,{clean:true});
  const r=await runBatch({config:{...f.config,resources:{probe:true}},output:path.join(f.root,'probe-skipped'),dependencies:{offlineStep:async(command,args,options)=>{
    const offline=[...args];if(command==='audit-resources')offline[offline.indexOf('--probe')+1]='false';
    const report=await offlineStep(command,offline,options);
    if(command==='audit-resources'){
      report.resources.push({network:{status:'not-probed'}});report.summary.resources++;
      await writeFile(args[args.indexOf('--out')+1],JSON.stringify(report));
    }
    return report;
  }}});
  assert.equal(r.diagnostics.resources.probeIncomplete,true);assert.equal(r.diagnostics.resources.status,'review-required');assert.equal(r.reviewRequired,true);
});

test('opt-in quality audit joins batch without weakening score gates or editing theme',async t=>{
  const f=await fixture(t),out=path.join(f.root,'quality-batch');
  const r=await runBatch({config:{...f.config,quality:true},output:out});
  assert.equal(r.status,'complete');assert.equal(r.acceptance,'score-targets-met');
  assert.ok(r.steps.some(s=>s.command==='audit-quality'));assert.ok(r.artifacts['quality.json']);
  const q=await json(path.join(out,'quality.json'));assert.equal(q.kind,'quality-audit');assert.equal(q.coverage.length,28);assert.ok(q.findings.some(x=>x.ruleId==='Q-ALT'));assert.equal(r.reviewRequired,true);
  assert.equal(await readFile(path.join(f.project,'sections/main.liquid'),'utf8'),f.source);
});
