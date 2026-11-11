// Synthetic evidence only; no storefront execution or field benefit is claimed.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {normalizeFieldData,fieldSegments} from '../lib/field-data.mjs';
import {compareFieldSnapshots,monitorField} from '../lib/field-monitor.mjs';
import {checkResult} from '../lib/check-results.mjs';
import {gateStates} from '../lib/delivery-policy.mjs';
import {standardsCatalog,standardsReference,withStandardRules} from '../lib/standards-registry.mjs';
import {performanceRules,inspectPerformanceSource} from '../lib/performance-rules.mjs';
import {auditPerformance} from '../lib/performance-audit.mjs';
import {sourceSnapshot} from '../lib/theme-source.mjs';
import {verifyOptimization} from '../lib/optimization-verification.mjs';
import {renderReport} from '../lib/report.mjs';
import {siteRun,regressionForRun} from './helpers/site-run.mjs';
import {proof} from './helpers/improvement-fixture.mjs';
import {toolkitManifest} from '../lib/toolkit-manifest.mjs';

const now=Date.parse('2026-11-11T08:00:00Z');
const crux=()=>({record:{key:{url:'https://example.com/products/test',formFactor:'PHONE'},
  collectionPeriod:{firstDate:{year:2026,month:10,day:14},lastDate:{year:2026,month:11,day:10}},
  metrics:{largest_contentful_paint:{percentiles:{p75:5000}},interaction_to_next_paint:{percentiles:{p75:400}},cumulative_layout_shift:{percentiles:{p75:'0.2'}}}}});
const snapshot=field=>({sourceId:'crux-fixture',release:{version:'fixture',sourceHash:'a'.repeat(64),deployedAt:'2026-10-01'},field});
async function temporary(t){const root=await mkdtemp('/private/tmp/perfkit-standards-');t.after(()=>rm(root,{recursive:true,force:true}));return root;}

test('fresh CrUX alerts on all observed CWV breaches without inventing counts or trend eligibility',()=>{
  const field=normalizeFieldData(crux(),{now});
  assert.equal(field.status,'limited');assert.equal(field.groups[0].samples,null);
  assert.deepEqual(field.groups[0].assessment,{thresholdEligible:true,sampleCountKnown:false,trendEligible:false,
    releaseAttribution:'not-established',basis:'published-crux-p75'});
  const trend=compareFieldSnapshots(snapshot(field),null,{now});
  assert.deepEqual(trend.alerts.map(a=>a.metric),['lcp','inp','cls']);
  assert.equal(trend.status,'review-required');assert.equal(trend.groups[0].status,'limited');
  assert.deepEqual(trend.groups[0].deltas,{});
  for(const alert of trend.alerts){assert.equal(alert.type,'experience-threshold');assert.equal(alert.evidence.samples,null);
    assert.equal(alert.evidence.releaseAttribution,'not-established');assert.equal(alert.evidence.scope,'url');assert.equal(alert.evidence.device,'mobile');}
  assert.deepEqual(normalizeFieldData(field,{now}).groups[0].assessment,field.groups[0].assessment);
});

test('CrUX scope, missing metrics and stale/mixed windows remain explicit; ordinary RUM is not promoted',()=>{
  const origin=crux();origin.record.key={origin:'https://example.com',formFactor:'DESKTOP'};
  delete origin.record.metrics.interaction_to_next_paint;
  const field=normalizeFieldData(origin,{now});
  assert.equal(field.groups[0].scope,'origin');assert.equal(field.groups[0].device,'desktop');
  assert.equal(field.groups[0].metrics.inp,undefined);
  assert.equal(compareFieldSnapshots(snapshot(field),null,{now}).alerts.length,2);
  const staleNow=now+50*86400000;
  assert.equal(compareFieldSnapshots(snapshot(field),null,{now:staleNow}).alerts.length,0);
  const mixed=snapshot(field);mixed.release.deployedAt='2026-10-20';
  assert.equal(compareFieldSnapshots(mixed,null,{now}).alerts.length,0);
  for(const source of ['shopify-rum','rum-export']){
    const rum={schemaVersion:1,source,window:field.window,groups:[{url:'https://example.com/',pageType:'home',device:'mobile',samples:null,metrics:{lcp:5000}}]};
    assert.equal(compareFieldSnapshots(snapshot(rum),null,{now}).alerts.length,0);
    rum.groups[0].samples=2;assert.equal(compareFieldSnapshots(snapshot(rum),null,{now}).alerts.length,0);
    rum.groups[0].samples=500;assert.equal(compareFieldSnapshots(snapshot(rum),null,{now}).alerts.length,1);
  }
  const forged=normalizeFieldData(crux(),{now});forged.window={start:'2020-01-01',end:'2020-01-28'};
  forged.groups[0].status='usable';forged.groups[0].assessment.thresholdEligible=true;
  assert.equal(fieldSegments(forged,'https://example.com/products/test','mobile')[0].assessment.thresholdEligible,false);
});

test('CrUX repeated and independent windows cannot acquire a trend verdict from unknown counts',()=>{
  const current=snapshot(normalizeFieldData(crux(),{now}));
  const repeated=compareFieldSnapshots(current,current,{now});
  assert.ok(repeated.groups[0].reasons.includes('overlapping-or-repeated-windows'));
  assert.ok(repeated.alerts.every(a=>a.type==='experience-threshold'));
  const old=structuredClone(current);old.field.window={start:'2026-09-16',end:'2026-10-13'};old.release.deployedAt='2026-09-01';
  old.field.groups[0].metrics.lcp=2000;
  const independent=compareFieldSnapshots(current,old,{now});
  assert.deepEqual(independent.groups[0].deltas,{});
  assert.ok(independent.groups[0].reasons.includes('sample-count-unavailable'));
});

test('monitor persists CrUX alerts through its existing local export workflow',async t=>{
  const root=await temporary(t),input=root+'/crux.json';await writeFile(input,JSON.stringify(crux()));
  const result=await monitorField({config:{schemaVersion:1,sources:[{id:'crux',input,approvalRef:'synthetic',release:snapshot(null).release}]},output:root+'/run'},{now:()=>now});
  assert.equal(result.status,'review-required');assert.equal(result.cycles[0].records[0].alerts.length,3);
});

test('four-state reporting preserves legacy booleans and keeps unexecuted checks distinct from failure',()=>{
  const inputs=[{id:'pass',pass:true},{id:'fail',pass:false},{id:'missing'},
    {id:'not-run',pass:false,executed:false,reason:'Missing browser evidence.'},
    {id:'disabled',pass:true,enabled:false},{id:'not-applicable',applicable:false,reason:'No video in scope.'}];
  assert.deepEqual(inputs.map(c=>checkResult(c).status),['PASS','FAIL','NOT RUN','NOT RUN','NOT RUN','N/A']);
  const gates=gateStates(inputs);
  assert.deepEqual(gates.map(g=>g.status),['passed','failed','not-assessed','not-assessed','not-assessed','not-applicable']);
  assert.equal(gates[3].executed,false);assert.equal(gates[3].reason,'Missing browser evidence.');
  assert.equal(checkResult({id:'unsupported-na',applicable:false}).status,'NOT RUN');
  assert.equal(checkResult({id:'unsupported-na',checkStatus:'N/A',reason:'Convenient'}).status,'NOT RUN');
  assert.equal(checkResult({id:'contradiction',pass:false,checkStatus:'PASS'}).status,'FAIL');
  assert.equal(checkResult({id:'unknown-pass',checkStatus:'PASS'}).status,'NOT RUN');
  assert.throws(()=>checkResult({id:'invalid',checkStatus:'GREEN'}),/Unknown check status/);
});

test('formal verification reports missing checks as NOT RUN while retaining original acceptance behavior',async t=>{
  const root=await temporary(t);await mkdir(root+'/assets');await writeFile(root+'/assets/main.js','window.fixture = 1;');
  const baseline=await sourceSnapshot(root);await writeFile(root+'/assets/main.js','window.fixture = 2;');const candidate=await sourceSnapshot(root);
  const before=await siteRun(t,{devices:['mobile'],scores:{mobile:[80]}}),after=await siteRun(t,{devices:['mobile'],scores:{mobile:[90]},offset:1000});
  await proof(before,baseline,root);await proof(after,candidate,root);
  const args={before:before.root,after:after.root,expectedSourceHash:candidate.hash};
  const missing=await verifyOptimization(args);
  assert.equal(missing.outcome,'not-accepted');
  for(const id of ['functional-regression','content-and-visual-review','runtime-metric-and-loading-integrity']){
    assert.equal(missing.checkResults.find(c=>c.id===id).status,'NOT RUN');assert.equal(missing.gates.find(c=>c.id===id).executed,false);
  }
  assert.equal(missing.checks.find(c=>c.id==='functional-regression').pass,false);
  const passed=await verifyOptimization({...args,regression:regressionForRun(after),review:{sourceHash:candidate.hash,contentPreserved:true,visualsPreserved:true,summary:'Synthetic contract only.'}});
  assert.equal(passed.outcome,'optimization-accepted');
  assert.equal(passed.checkResults.find(c=>c.id==='functional-regression').status,'PASS');
  assert.equal(passed.checkResults.find(c=>c.id==='runtime-metric-and-loading-integrity').status,'NOT RUN');
  assert.match(renderReport(missing),/NOT RUN/);assert.match(renderReport(missing),/Missing|No functional/);
});

test('pinned registry covers 130 distinct rule references without claiming implemented or passing checks',()=>{
  const catalog=standardsCatalog();assert.equal(catalog.rules.length,130);assert.equal(new Set(catalog.rules.map(r=>r.id)).size,130);
  assert.equal(catalog.enforcement,'reference-only');assert.equal(catalog.status,'draft-pending-review');
  assert.equal(catalog.rules.filter(r=>r.adoptionTier==='卡点').length,48);
  assert.ok(catalog.rules.every(r=>r.assessment==='not-assessed'&&r.source.line>0&&r.level&&r.basis&&r.evidenceRequirement));
  const ids=new Set(catalog.rules.map(r=>r.id));
  for(const rule of performanceRules){assert.ok(rule.standardRuleIds.length);assert.ok(rule.standardRuleIds.every(id=>ids.has(id)));}
  assert.equal(catalog.rules.find(r=>r.id==='PERF-IMG-05').relatedInternalRules.length,0);
  assert.deepEqual(withStandardRules({ruleId:'UNKNOWN'}).standardRuleIds,[]);
  catalog.rules[0].title='mutated';catalog.rules[0].source.line=0;
  assert.notEqual(standardsCatalog().rules[0].title,'mutated');assert.ok(standardsCatalog().rules[0].source.line>0);
  assert.match(standardsReference.sha256,/^[a-f0-9]{64}$/);
});

test('audit JSON and HTML carry mappings while candidates and legacy findings remain unchanged',async t=>{
  const root=await temporary(t);await mkdir(root+'/assets');
  const css='@font-face { font-family: Fixture; src: url(/cdn/font.woff2); font-display: block; }';
  await writeFile(root+'/assets/main.css',css);
  const source=inspectPerformanceSource({source:css,file:'assets/main.css',sourceHash:'a'.repeat(64)});
  const finding=source.findings.find(f=>f.ruleId==='PERF_FONT_DISPLAY');
  assert.deepEqual(finding.standardRuleIds,['PERF-CSS-07']);assert.equal(finding.status,'candidate');
  const result=await auditPerformance({project:root});
  assert.equal(result.standards.sha256,standardsReference.sha256);
  assert.ok(result.findings.every(f=>Array.isArray(f.standardRuleIds)));
  assert.match(renderReport(result),/PERF-CSS-07/);assert.match(renderReport(result),/reference-only/);
  const legacy=structuredClone(result);delete legacy.standards;legacy.findings.forEach(f=>delete f.standardRuleIds);
  assert.match(renderReport(legacy),/PERF_FONT_DISPLAY/);
  const manifest=await toolkitManifest();
  assert.ok(manifest.files.some(f=>f.file==='assets/standards/registry-v1.json'&&f.sha256===standardsReference.sha256));
});
