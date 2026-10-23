import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,realpath,mkdir,writeFile,readFile,readdir,rm,symlink} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {captureFcpDiagnostics,readFcpDiagnostics,copyFcpDiagnostics,replayFcp} from '../lib/fcp-diagnostics.mjs';
import {diagnoseFcpGroup} from '../lib/recovery-cost.mjs';
const hash=b=>createHash('sha256').update(b).digest('hex');
const recorded=async name=>JSON.parse(gunzipSync(await readFile(new URL(`./fixtures/lantern-fcp/${name}.json.gz`,import.meta.url))));
async function setup(t){const root=await realpath(await mkdtemp(path.join(os.tmpdir(),'fcp-evidence-')));t.after(()=>rm(root,{recursive:true,force:true}));return root;}
async function syntheticArchive(root,name,urls=['https://example.com/']) {
  // Integrity/aggregation fixture only; no synthetic performance success is asserted.
  await mkdir(path.join(root,name),{recursive:true});
  const report=JSON.stringify({synthetic:true}),record={relative:`${name}/report.json`,sha256:hash(report)};
  await writeFile(path.join(root,record.relative),report);
  const trace='{"syntheticTrace":true}',log='[]';
  const analysis=JSON.stringify({kind:'lantern-fcp-diagnosis',status:'replayed',purpose:'diagnosis-only',
    optimistic:{nodes:urls.map(url=>({type:'network',url}))},pessimistic:{nodes:[]},
    evidence:{reportSha256:record.sha256,traceSha256:hash(trace),devtoolsLogSha256:hash(log)}});
  const descriptor={status:'replayed',reportSha256:record.sha256,files:{}};
  for(const [key,bytes] of Object.entries({trace,devtoolsLog:log,analysis})){
    const file=`${name}/${key}.json`;await writeFile(path.join(root,file),bytes);descriptor.files[key]={file,sha256:hash(bytes)};
  }
  return {record,descriptor};
}
test('archive validates all three hashes, report identity, paths and symlinks',async t=>{
  const root=await setup(t),{record,descriptor}=await syntheticArchive(root,'one');
  assert.equal((await readFcpDiagnostics(root,record,descriptor)).status,'replayed');
  assert.equal((await readFcpDiagnostics(root,{...record,sha256:'wrong'},descriptor)).status,'unavailable');
  for(const key of ['trace','devtoolsLog','analysis']){
    const bad=structuredClone(descriptor);bad.files[key].sha256='changed';
    assert.match((await readFcpDiagnostics(root,record,bad)).reason,/hash changed/);
  }
  const bad=structuredClone(descriptor);bad.files.trace.file='../escape.json';
  assert.equal((await readFcpDiagnostics(root,record,bad)).status,'unavailable');
  await symlink(path.join(root,descriptor.files.trace.file),path.join(root,'trace-link.json'));
  bad.files.trace.file='trace-link.json';assert.match((await readFcpDiagnostics(root,record,bad)).reason,/symlink/);
  await writeFile(path.join(root,descriptor.files.trace.file),'{}');
  assert.equal((await readFcpDiagnostics(root,record,descriptor)).status,'unavailable');
});
test('experiment copies carry independent complete evidence, not dangling original references',async t=>{
  const root=await setup(t),source=path.join(root,'source'),destination=path.join(root,'combined');await mkdir(source);
  const {record,descriptor}=await syntheticArchive(source,'one');
  const copied=await copyFcpDiagnostics({source,destination,record,descriptor,relative:'diagnostics/sample-01'});
  assert.equal(copied.status,'replayed');assert.ok(Object.values(copied.files).every(f=>f.file.startsWith('diagnostics/sample-01/')));
  await rm(source,{recursive:true});assert.equal((await readFcpDiagnostics(destination,record,copied)).status,'replayed');
});
test('group distinguishes task dependency variation from incomplete/missing evidence without passing a score',async t=>{
  const root=await setup(t),a=await syntheticArchive(root,'one'),b=await syntheticArchive(root,'two',['https://example.com/','https://example.com/main.js']);
  const group={records:[a.record,b.record],attempts:[a,b].map(x=>({report:x.record.relative,diagnostics:x.descriptor}))};
  const result=await diagnoseFcpGroup(root,group);
  assert.equal(result.distinctNetworkGraphs,2);assert.equal(result.status,'replayed');assert.match(result.acceptanceEffect,/retain original rejection/);
  group.attempts.pop();const incomplete=await diagnoseFcpGroup(root,group);assert.equal(incomplete.status,'incomplete');assert.equal(incomplete.samples[1].status,'unavailable');
});
test('capture moves assets out of the LHR directory even when raw artifacts cannot be replayed',async t=>{
  const root=await setup(t);await mkdir(path.join(root,'lhr'));
  for(const [file,data] of [['run.json','{}'],['run-0.trace.json','{}'],['run-0.devtoolslog.json','[]']])await writeFile(path.join(root,'lhr',file),data);
  const result=await captureFcpDiagnostics({root,reportRelative:'lhr/run.json',diagnosticsRelative:'diagnostics/run'});
  assert.equal(result.status,'unavailable');assert.ok(result.files.trace);assert.ok(result.files.devtoolsLog);
  assert.deepEqual(await readdir(path.join(root,'lhr')),['run.json']);
  assert.equal(await readFile(path.join(root,result.files.trace.file),'utf8'),'{}');
  const destination=path.join(root,'combined');
  const copied=await copyFcpDiagnostics({source:root,destination,record:{sha256:hash('{}')},descriptor:result,relative:'diagnostics/run'});
  assert.equal(copied.status,'unavailable');assert.ok(copied.files.trace);
  assert.equal(await readFile(path.join(destination,copied.files.trace.file),'utf8'),'{}');
});
test('missing assets and mismatched Lighthouse versions cannot produce a causal claim',async t=>{
  const root=await setup(t);const result=await captureFcpDiagnostics({root,reportRelative:'missing.json',diagnosticsRelative:'diagnostics/run'});
  assert.equal(result.status,'unavailable');assert.deepEqual(result.files,{});
  await assert.rejects(replayFcp({report:{lighthouseVersion:'0.0.0'}}),/requires Lighthouse/);
});
test('frozen real browser traces exactly reproduce both FCP modes and reveal the extra script/layout dependency',async()=>{
  const low=await replayFcp(await recorded('low')),high=await replayFcp(await recorded('high'));
  assert.equal(low.replayedFcpMs,629.7316);assert.equal(high.replayedFcpMs,769.441);
  assert.equal(low.taskPaintCouplings.length,0);assert.equal(high.taskPaintCouplings.length,2);
  assert.ok(high.taskPaintCouplings.every(c=>c.scriptUrl.endsWith('/assets/main.js')&&c.paintEvent==='Layout'
    &&c.paintStartMs>=c.scriptStartMs+c.scriptDurationMs));
  assert.ok(!low.optimistic.nodes.some(n=>n.url?.endsWith('/assets/main.js')));
  assert.ok(high.optimistic.nodes.some(n=>n.url?.endsWith('/assets/main.js')));
  for(const result of [low,high])assert.ok(result.optimistic.nodes.every(n=>Number.isFinite(n.observedStartMs)&&Number.isFinite(n.simulatedEndMs)));
});
test('mixed raw browser artifacts and modified metric values fail replay instead of becoming explanations',async()=>{
  const low=await recorded('low'),high=await recorded('high');
  await assert.rejects(replayFcp({...low,trace:high.trace}),/reproduce|NO_|main|network/i);
  low.report.audits['first-contentful-paint'].numericValue+=150;
  await assert.rejects(replayFcp(low),/do not reproduce/);
});
test('captured real artifacts survive the production archive and diagnose both task modes without another browser run',async t=>{
  const root=await setup(t);await mkdir(path.join(root,'lhr'));
  const group={records:[],attempts:[]};
  for(const name of ['low','high']) {
    const fixture=await recorded(name),reportRelative=`lhr/${name}.json`,reportBytes=JSON.stringify(fixture.report);
    await writeFile(path.join(root,reportRelative),reportBytes);
    await writeFile(path.join(root,`lhr/${name}-0.trace.json`),JSON.stringify(fixture.trace));
    await writeFile(path.join(root,`lhr/${name}-0.devtoolslog.json`),JSON.stringify(fixture.devtoolsLog));
    const descriptor=await captureFcpDiagnostics({root,reportRelative,diagnosticsRelative:`diagnostics/${name}`});
    assert.equal(descriptor.status,'replayed');
    group.records.push({relative:reportRelative,sha256:hash(reportBytes)});group.attempts.push({report:reportRelative,diagnostics:descriptor});
  }
  const diagnosis=await diagnoseFcpGroup(root,group);
  assert.equal(diagnosis.status,'replayed');assert.equal(diagnosis.finding,'task-coalescing-sensitive-fcp-model');
  assert.deepEqual((await readdir(path.join(root,'lhr'))).sort(),['high.json','low.json']);
});
