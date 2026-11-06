import test from 'node:test';
import assert from 'node:assert/strict';
import {compareCheckpoints,preservationStyles,verifyPreservation} from '../lib/preservation.mjs';

function checkpoint() {
  const properties=Object.fromEntries(['indeterminate','disabled','readOnly','required','multiple','selected','open','hidden','inert','effectivelyDisabled','min','max','step','pattern'].map(k=>[k,null]));
  return {version:2,focusIndex:-1,environment:{viewport:[390,844,1],scroll:[0,0]},
    content:[{tag:'SELECT',attrs:[['multiple','']],text:[],value:'a',checked:null,properties:{...properties,multiple:true,required:false,disabled:false,effectivelyDisabled:false,selectedOptions:[{index:0,value:'a'}],scroll:[0,0]}}],
    layout:[{rect:[0,0,100,30],styles:Object.fromEntries(preservationStyles.map(k=>[k,'fixture']))}]};
}

test('runtime form, multi-select, disclosure, focus and internal scroll changes fail preservation',()=>{
  const original=checkpoint();
  for(const [key,value] of Object.entries({indeterminate:true,effectivelyDisabled:true,readOnly:true,required:true,open:true,inert:true,min:'2',max:'4',step:'2',selectedOptions:[{index:0,value:'a'},{index:1,value:'b'}],scroll:[0,10]})) {
    const after=checkpoint();after.content[0].properties[key]=value;
    assert.equal(compareCheckpoints(original,after).outcome,'regressed',key);
  }
  const after=checkpoint();after.focusIndex=0;
  assert.ok(compareCheckpoints(original,after).changes.includes('focus'));
  assert.equal(compareCheckpoints(original,checkpoint()).coverage,'dom-form-focus-layout');
});

test('mixed versions, incomplete runtime state and different capture conditions cannot pass',()=>{
  for(const mutate of [p=>delete p.content[0].properties.readOnly,p=>delete p.focusIndex,p=>p.focusIndex=2,
    p=>p.content[0].properties.selectedOptions=[{index:0,value:'a'},{index:0,value:'b'}],
    p=>p.content[0].properties.selectedOptions=[null],p=>delete p.content[0].value,
    p=>p.environment.viewport[0]=400,p=>p.environment.scroll[1]=10,p=>p.layout[0].rect[0]=NaN]) {
    const p=checkpoint();mutate(p);assert.equal(compareCheckpoints(checkpoint(),p).outcome,'invalid-evidence');
  }
  const legacy=checkpoint();legacy.version=1;
  assert.equal(compareCheckpoints(checkpoint(),legacy).outcome,'invalid-evidence');
  const historical=compareCheckpoints(legacy,structuredClone(legacy));
  assert.equal(historical.outcome,'preserved');assert.equal(historical.coverage,'legacy-dom-layout');
  assert.ok(historical.limitations.some(x=>x.includes('recollect')));
});

test('null placeholders cannot erase applicable select state from version 2 evidence',()=>{
  for(const key of ['selectedOptions','required','disabled','effectivelyDisabled','multiple']) {
    const before=checkpoint(),after=checkpoint();before.content[0].properties[key]=null;after.content[0].properties[key]=null;
    assert.equal(compareCheckpoints(before,after).outcome,'invalid-evidence',key);
  }
});

test('version 2 remains subordinate to source identity, interaction and write-request gates',()=>{
  const make=hash=>({kind:'scenarios',sourceHash:hash,sourceStable:true,outcome:'passed',environment:{},runs:[{
    name:'form',url:'https://shop.example.test/',viewport:{name:'mobile'},outcome:'passed',constrained:false,blockedRequests:[],
    steps:[{index:0,action:'assert-count',selector:'select',count:1,outcome:'passed'},
      {index:1,action:'checkpoint',selector:'main',key:'ready',outcome:'passed',observation:checkpoint()}]}]});
  const before=make('a'.repeat(64)),after=make('b'.repeat(64));
  const check=()=>verifyPreservation({before,after,beforeSourceHash:before.sourceHash,afterSourceHash:after.sourceHash});
  assert.equal(check().outcome,'preserved');
  after.runs[0].steps[1].observation.content[0].properties.required=true;
  assert.equal(check().outcome,'regressed');
  after.runs[0].steps[1].observation=checkpoint();after.runs[0].blockedRequests.push({method:'POST'});
  assert.equal(check().outcome,'invalid-evidence');
  after.runs[0].blockedRequests=[];after.sourceStable=false;
  assert.equal(check().outcome,'invalid-evidence');
});
