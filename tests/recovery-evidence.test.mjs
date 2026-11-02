import test from 'node:test';
import assert from 'node:assert/strict';
import {assertRecoveryCaptureCoverage,matchesRecoveryCapture,captureSelectors} from '../lib/recovery-evidence.mjs';
const url='https://shop.test/?preview_theme_id=1';
const request={mode:'runtime',url,profile:{device:'mobile',state:'open',actions:[{type:'click',selector:'#open'}],settleMs:300,targetSelectors:['#custom'],hashResourceUrls:['https://app.test/a.js']},bindings:[{selector:'#bound',file:'sections/a.liquid',offset:2,sourceHash:'a'.repeat(64),review:'Known fixture binding'}]};
const captured=()=>({config:{...structuredClone(request.profile),url,targetSelectors:captureSelectors(request)},domainBindings:structuredClone(request.bindings),actions:[{...request.profile.actions[0],status:'completed',startedAtMs:1,finishedAtMs:10}]});
test('recapture preserves states, actions, explicit target selectors, script hashing and Liquid context',()=>{
  const inputs={profiles:[captured()],liquidProfile:{domainProof:{url},domainBindings:[]}};
  const requests=[structuredClone(request),{mode:'liquid',url}];
  assert.doesNotThrow(()=>assertRecoveryCaptureCoverage(inputs,requests));
  for(const key of ['state','actions','targetSelectors','hashResourceUrls']){
    const copy=structuredClone(requests);delete copy[0].profile[key];assert.throws(()=>assertRecoveryCaptureCoverage(inputs,copy),/retain/);
  }
  assert.throws(()=>assertRecoveryCaptureCoverage(inputs,[request]),/Liquid/);
  assert.throws(()=>assertRecoveryCaptureCoverage(inputs,[{...request,bindings:[]},requests[1]]),/retain/);
});
test('recapture rejects declared but unexecuted interactions and truncated state coverage',()=>{
  assert.equal(matchesRecoveryCapture(captured(),request),true);
  for(const change of [p=>p.actions=[],p=>p.actions[0].status='failed',p=>p.config.state='initial',p=>p.config.actions=[],p=>p.config.targetSelectors=['#bound'],p=>p.config.hashResourceUrls=[],p=>p.domainBindings=[],p=>p.errors=['capture failed'],p=>p.blockedRequests=[{url:'https://app.test/p'}],p=>p.trace={truncated:true}]){
    const p=captured();change(p);assert.equal(matchesRecoveryCapture(p,request),false);
  }
});
