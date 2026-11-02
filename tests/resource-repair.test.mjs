import test from 'node:test';
import assert from 'node:assert/strict';
import {themeStepFixture} from './helpers/theme-step-fixture.mjs';
import {sourceSnapshot} from '../lib/runtime-profile.mjs';
import {createResourceRepair,verifyResourceRepair} from '../lib/resource-repair.mjs';
import {applySitePlan,rollbackSitePlan} from '../lib/site-changes.mjs';
import {verifyOptimization} from '../lib/optimize.mjs';
import {buildThemeWorkflow} from '../lib/theme-workflow.mjs';
import {attributeApps} from '../lib/app-attribution.mjs';
import {reassessCandidate} from '../lib/recovery.mjs';

test('approved broken-image repair is source-bound, reversible, and cannot claim a performance gain',async t=>{
  const old='https://assets.fixture.test/missing.png',next='https://assets.fixture.test/original.svg',hash='f'.repeat(64);
  const f=await themeStepFixture(t,{'sections/main.liquid':`<img id="broken" src="${old}" width="400" height="200" alt="Installation">`});
  f.runtime.resourceHealth={version:1,images:[{selector:'#broken',url:old,complete:true,decoded:false,naturalWidth:0,naturalHeight:0}]};
  f.runtime.domainTargets=[{tag:'IMG',id:'broken',idCount:1,inPicture:false,currentSrc:old}];
  const config={schemaVersion:1,target:'sections/main.liquid',offset:0,replacementUrl:next,approvedAssetHash:hash,review:{summary:'Synthetic authorized original image',originalAssetConfirmed:true}};
  const plan=await createResourceRepair({project:f.root,profile:f.runtime,config});assert.equal(plan.metadata.intent,'content-repair');
  const workflow=buildThemeWorkflow({snapshot:f.snapshot,profiles:[f.runtime],files:Object.entries(f.files).map(([file,text])=>({file,text}))});assert.equal(workflow.stages.length,8);assert.equal(workflow.next.action,'restore-approved-content');
  await applySitePlan(plan,f.root);const snapshot=await sourceSnapshot(f.root),after=structuredClone(f.runtime);
  after.snapshot=snapshot;after.resourceHealth={version:1,images:[{selector:'#broken',url:next,complete:true,decoded:true,naturalWidth:400,naturalHeight:200}]};
  after.resources=[{url:next,type:'Image',status:200,bodyHash:hash}];
  const move=s=>new Date(Date.parse(s)+60000).toISOString();
  for(const k of ['createdAt','finishedAt'])after[k]=move(after[k]);
  for(const k of ['startedAt','finishedAt'])after.domainProof[k]=move(after.domainProof[k]);
  for(const side of ['before','after']){const p=after.domainProof[side];p.sourceHash=snapshot.hash;p.remoteSourceHash=snapshot.hash;p.sourceManifest=snapshot.files;for(const k of ['startedAt','finishedAt'])p[k]=move(p[k]);}
  const accepted=await verifyResourceRepair({plan,before:f.runtime,after});assert.equal(accepted.outcome,'correctness-restored',accepted.error);assert.equal(accepted.performanceGain,'not-evaluated');
  after.resources[0].bodyHash='a'.repeat(64);assert.equal((await verifyResourceRepair({plan,before:f.runtime,after})).outcome,'invalid-evidence');
  assert.match((await verifyOptimization({plan})).error,/restoration/);
  await rollbackSitePlan(plan,f.root);
  delete f.runtime.resourceHealth;await assert.rejects(createResourceRepair({project:f.root,profile:f.runtime,config}),/browser decoding/);
});

test('same-origin theme scripts do not become high-confidence apps; exact App proxy ownership still works',()=>{
  const url='https://store.fixture.test/products/a',resources=Array.from({length:5},(_,i)=>({url:`https://store.fixture.test/assets/theme-${i}.js`,timestamp:i,finishedTimestamp:i+.02}));
  let result=attributeApps({profiles:[{config:{url},resources}]});assert.deepEqual(result.inferredBoundaries,[]);assert.equal(result.sameOriginUnreviewed,5);
  resources.forEach((r,i)=>r.source={status:'verified-bytes',file:`assets/theme-${i}.js`});result=attributeApps({profiles:[{config:{url},resources}]});assert.equal(result.themeResources,5);
  result=attributeApps({profiles:[{config:{url},resources:[{url:'https://store.fixture.test/apps/form/loader.js'}]}],owners:[{id:'form',name:'Form proxy',host:'store.fixture.test',pathPrefix:'/apps/form/',purpose:'Form',evidence:'Synthetic explicit mapping'}]});
  assert.equal(result.resources[0].owner.status,'reviewed-mapping');assert.equal(result.resources[0].role,'reviewed-app');
});

test('a score goal respects score headroom even when its candidate loading metric has large values',()=>{
  const c={file:'assets/main.js',line:1,kind:'cpu',metric:'tbt',page:'https://fixture.test/',device:'mobile'};
  const group={url:c.page,device:'mobile',pageId:'home',metrics:[{metric:'tbt',median:500}],score:{median:100,mad:0}};
  assert.equal(reassessCandidate(c,'base',[],[],group,{kind:'score'}).gainCeiling.blocked,true);
  assert.equal(reassessCandidate(c,'base',[],[],group,{kind:'loading',metric:'tbt'}).gainCeiling.blocked,false);
});
