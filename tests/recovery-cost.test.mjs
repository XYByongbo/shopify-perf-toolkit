import test from 'node:test';
import assert from 'node:assert/strict';
import {summarizeCost,readExperimentCost,fcpRecoveryDecision} from '../lib/recovery-cost.mjs';
import {reportSetHash} from '../lib/performance-gain.mjs';
test('cost diagnosis preserves observed/model sample distributions and missing evidence',()=>{
  const records=[20,40,30].map((n,i)=>({report:{audits:{'first-contentful-paint':{numericValue:i===0?620:770},metrics:{details:{items:[{observedFirstContentfulPaint:n}]}},'total-byte-weight':{numericValue:6000+i},'network-requests':{details:{items:[{resourceType:'Document',resourceSize:5000},{resourceType:'Script',resourceSize:500}]}}}}}));
  const c=summarizeCost(records);assert.deepEqual(c.fcp.samples,[620,770,770]);assert.equal(c.fcp.range,150);assert.equal(c.observedFcp.median,30);assert.equal(c.scriptRequests.median,1);assert.equal(c.documentBytes.median,5000);
  delete records[0].report.audits.metrics;delete records[1].report.audits['network-requests'];const missing=summarizeCost(records);assert.equal(missing.observedFcp,null);assert.equal(missing.scriptRequests,null);assert.equal(missing.documentBytes,null);
});
test('raw report binding includes every record and page/device key',()=>{
  const e={groups:[{key:'home/mobile',records:[{relative:'one.json',sha256:'a'},{relative:'two.json',sha256:'b'}]}]},old=reportSetHash(e);
  e.groups[0].records[1].sha256='changed';assert.notEqual(reportSetHash(e),old);e.groups[0].records[1].sha256='b';e.groups[0].key='home/desktop';assert.notEqual(reportSetHash(e),old);
});
test('missing cost evidence cannot fabricate zero cost',async()=>{
  assert.deepEqual(await readExperimentCost({},{}),{status:'unavailable'});
});
test('shared model sensitivity changes causal attribution, never retries or overrides the rejected result',()=>{
  const side={status:'replayed',finding:'task-coalescing-sensitive-fcp-model'};
  const result=fcpRecoveryDecision({before:side,after:side});
  assert.equal(result.cause,'shared-task-coalescing-sensitivity');assert.equal(result.overrideScoreGate,false);
  assert.equal(result.allowUnchangedRetry,false);assert.equal(result.patchDisposition,'retain-original-rejection');
  assert.equal(fcpRecoveryDecision({before:side,after:{status:'incomplete'}}).cause,'missing-original-navigation-artifacts');
});
