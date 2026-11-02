import test from 'node:test';
import assert from 'node:assert/strict';
import {checkPerformanceBudget,validateResourceBudget} from '../lib/resource-budget.mjs';
import {verifyOptimization} from '../lib/optimize.mjs';
import {siteRun} from './helpers/site-run.mjs';
const items=()=>[{resourceType:'total',transferSize:1000,requestCount:100},
  {resourceType:'image',transferSize:800,requestCount:90},{resourceType:'script',transferSize:200,requestCount:10},
  {resourceType:'third-party',transferSize:600,requestCount:70},{resourceType:'font',transferSize:0,requestCount:0}];
const candidate=(groups=1,samples=5)=>({groups:Array.from({length:groups},(_,i)=>({pageId:'page-'+i,device:i%2?'desktop':'mobile',
  records:Array.from({length:samples},(_,j)=>({relative:`report-${j}.json`,report:{audits:{'resource-summary':{details:{items:items()}}}}}))}))});

test('resource budgets use total row once per sample, ignore overlapping third-party row, and never sum pages',()=>{
  const result=checkPerformanceBudget(candidate(6),{maxTotalTransferBytes:1000,maxByType:{image:800,'third-party':600,font:0},maxRequests:100});
  assert.equal(result.passed,true);assert.equal(result.details.length,150);
  assert.ok(result.details.filter(d=>d.metric==='totalTransferBytes').every(d=>d.value===1000));
});
test('actual request counts, zero limits and a single worst sample cannot pass',()=>{
  assert.equal(checkPerformanceBudget(candidate(),{maxRequests:20}).passed,false);
  assert.equal(checkPerformanceBudget(candidate(),{maxTotalTransferBytes:0}).passed,false);
  assert.equal(checkPerformanceBudget(candidate(),{maxByType:{font:0}}).passed,true);
  const c=candidate(2);c.groups[1].records[4].report.audits['resource-summary'].details.items[0].transferSize=1001;
  const r=checkPerformanceBudget(c,{maxTotalTransferBytes:1000});assert.equal(r.passed,false);
  assert.deepEqual(r.details.filter(d=>!d.passed).map(d=>[d.pageId,d.device,d.sample]),[['page-1','desktop','report-4.json']]);
});
test('missing, duplicate, malformed and incomplete resource evidence fails closed',()=>{
  for(const mutate of [r=>delete r.audits['resource-summary'],r=>r.audits['resource-summary'].details.items=[],
    r=>r.audits['resource-summary'].details.items.shift(),r=>r.audits['resource-summary'].details.items.push(items()[0]),
    r=>r.audits['resource-summary'].details.items[0].requestCount='100',r=>r.audits['resource-summary'].details.items[0].transferSize=-1,
    r=>r.audits['resource-summary'].details.items[1].transferSize=1001,r=>r.audits['resource-summary'].scoreDisplayMode='error']){
    const c=candidate();mutate(c.groups[0].records[4].report);assert.throws(()=>checkPerformanceBudget(c,{maxRequests:100}));
  }
  assert.throws(()=>checkPerformanceBudget(candidate(),{maxByType:{stylesheet:0}}),/Missing/);
  assert.throws(()=>checkPerformanceBudget({groups:[]},{maxRequests:0}));
  assert.throws(()=>checkPerformanceBudget({groups:[{records:[]}]},{maxRequests:0}));
});
test('resource budget config rejects typos, execution budgets, invalid limits and empty gates',()=>{
  for(const b of [null,[],{},false,{maxRequests:-1},{maxRequests:1.5},{maxRequests:'5'},{maxRequests:Infinity},
    {maxRequests:NaN},{maxRequests:undefined},{maxByType:undefined},{maxAttempts:5},{maxByType:{}},{maxByType:{images:4}},{maxByType:{image:-1}},{maxByType:null}])
    assert.throws(()=>validateResourceBudget(b));
});
test('public acceptance verifier rejects missing budget evidence and reports genuine per-sample failures',async t=>{
  const before=await siteRun(t,{devices:['mobile'],scores:{mobile:[70]}});
  const missing=await siteRun(t,{devices:['mobile'],scores:{mobile:[85]},offset:20});
  assert.equal((await verifyOptimization({before:before.root,after:missing.root,budget:{maxRequests:100}})).outcome,'invalid-evidence');
  const after=await siteRun(t,{devices:['mobile'],scores:{mobile:[85]},offset:40,augment:r=>r.audits['resource-summary']={details:{items:items()}}});
  const result=await verifyOptimization({before:before.root,after:after.root,budget:{maxTotalTransferBytes:1500,maxRequests:20}});
  assert.equal(result.budget.passed,false);assert.equal(result.outcome,'not-accepted');
  assert.ok(result.budget.details.filter(d=>d.metric==='totalTransferBytes').every(d=>d.value===1000&&d.passed));
  assert.ok(result.budget.details.filter(d=>d.metric==='requestCount').every(d=>d.value===100&&!d.passed));
});
