import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm,readFile,realpath} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {inspectThemeCapabilities,resolveThemeAdapter,resolveAdapterRegistry,checkAdapterPlanBinding} from '../lib/theme-capabilities.mjs';
import {createSitePlan,applySitePlan,rollbackSitePlan} from '../lib/site-changes.mjs';
import {verifyBusinessEvidence} from '../lib/business-evidence.mjs';
import {digest} from '../lib/evidence-contract.mjs';
import {validateScenarioConfig} from '../lib/scenarios.mjs';
import {integrityRequired,validateDeliveryPolicy} from '../lib/delivery-policy.mjs';
import {prepareStrategyContract,strategyCoverage} from '../lib/strategy-contract.mjs';
import {siteRun,regressionForRun} from './helpers/site-run.mjs';
import {proof} from './helpers/improvement-fixture.mjs';
import {sourceSnapshot} from '../lib/theme-source.mjs';
import {verifyOptimization} from '../lib/optimization-verification.mjs';

export async function adapterFixture(t,family='native'){
  const root=await mkdtemp(path.join(os.tmpdir(),'perfkit-adapter-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const files={'layout/theme.liquid':'<main>{{ content_for_layout }}</main>','assets/main.js':'window.example = 1;'};
  if(family==='native')files['templates/index.json']='{"sections":{},"order":[]}';
  if(family==='legacy')files['assets/main.js']='jQuery(function(){ window.example = 1; });';
  if(family==='builder')files['sections/builder.liquid']='<!-- pagefly generated fixture --> <div>Example</div>';
  for(const [file,text] of Object.entries(files)){await mkdir(path.dirname(path.join(root,file)),{recursive:true});await writeFile(path.join(root,file),text);}
  const identity={store:'fixture.myshopify.com',themeId:'1',version:'fixture-1'},context={appRevision:'a1',generatorRevision:'g1',configurationRevision:'c1'};
  const inspected=await inspectThemeCapabilities({project:root,identity,context}),reference=inspected.graph.files.find(f=>f.file==='assets/main.js');
  const adapter={schemaVersion:1,id:family,version:'1',identity,context,sourceHash:inspected.sourceHash,
    capabilities:Object.fromEntries(['rendering','resources','lifecycle','business','ownership'].map(k=>[k,{status:'verified',contract:'Synthetic fixture only; '+k,evidence:[{...reference,reason:'Fixture assertion'}]}])),
    strategies:[{id:'reviewed-replacement',requires:['resources','lifecycle'],protectedFiles:['layout/theme.liquid'],reason:'Single fixture script'}],coverage:['synthetic fixture only']};
  return {root,identity,context,adapter,inspected};
}
test('three theme families share adapter protocol; changes, unknown dependencies, protected targets and ambiguity fail closed',async t=>{
  for(const family of ['native','legacy','builder']){
    const f=await adapterFixture(t,family),config={project:f.root,...f,strategy:'reviewed-replacement',targets:['assets/main.js']};
    assert.equal(f.inspected.capabilities.business.status,'unknown');
    assert.equal((await resolveThemeAdapter(config)).status,'compatible-for-declared-strategy');
    assert.equal((await resolveThemeAdapter({...config,context:{...f.context,generatorRevision:'g2'}})).status,'rejected');
    assert.equal((await resolveThemeAdapter({...config,targets:['layout/theme.liquid']})).status,'rejected');
    const unknown=structuredClone(f.adapter);unknown.capabilities.lifecycle.status='unknown';
    assert.equal((await resolveThemeAdapter({...config,adapter:unknown})).status,'rejected');
    assert.equal((await resolveAdapterRegistry({...config,adapters:[f.adapter,{...f.adapter,id:'second'}]})).status,'ambiguous');
    const plan=await createSitePlan({project:f.root,recipe:{schemaVersion:1,adapter:{adapter:f.adapter,identity:f.identity,context:f.context,strategy:config.strategy},changes:[{kind:'reviewed-replacement',target:'assets/main.js',replacementText:'window.example = 2;',reason:'Fixture',evidence:{summary:'Fixture only'}}]}});
    const identity={...f.identity,sourceHash:f.adapter.sourceHash};
    assert.equal(checkAdapterPlanBinding(plan,identity,identity,f.inspected.graph.files),true);
    const forged=structuredClone(plan);forged.adapter.adapter.capabilities.lifecycle.status='unknown';
    assert.equal(checkAdapterPlanBinding(forged,identity,identity,f.inspected.graph.files),false);
    await assert.rejects(applySitePlan(plan,f.root,{...f.context,appRevision:'changed'}),/invalidated/);
    await applySitePlan(plan,f.root,f.context);assert.match(await readFile(path.join(f.root,'assets/main.js'),'utf8'),/= 2/);
    await rollbackSitePlan(plan,f.root);
    await writeFile(path.join(f.root,'assets/new.js'),'window.newAsset = true;');
    await assert.rejects(applySitePlan(plan,f.root,f.context),/invalidated/);
  }
});
test('delivery policy is explicit; sensitive plans require integrity while legacy remains distinguishable',()=>{
  assert.equal(integrityRequired({changes:[{recipeKind:'image-loading'}]},'delivery-v1'),true);
  assert.equal(integrityRequired({changes:[{recipeKind:'reviewed-replacement'}]},undefined),false);
  assert.throws(()=>validateDeliveryPolicy('typo'));
});
test('strategy contracts reuse standard patch application and reject missing case coverage',async t=>{
  const f=await adapterFixture(t,'legacy');
  f.adapter.strategies=[{id:'jquery-lifecycle',requires:['resources','lifecycle'],protectedFiles:[],reason:'Fixture lifecycle'}];
  const config={project:f.root,strategy:'jquery-lifecycle',...f,recipe:{schemaVersion:1,changes:[{kind:'reviewed-replacement',target:'assets/main.js',replacementText:'jQuery(function(){ window.example = 2; });',reason:'Fixture',evidence:{summary:'Synthetic only'}}]},review:{summary:'Fixture callbacks owned',conditions:['plugin-destroy-contract','namespaced-events','async-cancellation']}};
  delete config.root;delete config.inspected;
  const result=await prepareStrategyContract(config);
  assert.equal(result.plan.kind,'site-change-plan');assert.equal(strategyCoverage(result.plan,{runs:[]}).pass,false);
  await assert.rejects(applySitePlan(result.plan,f.root),/current external context/);
  await applySitePlan(result.plan,f.root,f.context);await rollbackSitePlan(result.plan,f.root);
  await assert.rejects(prepareStrategyContract({...config,review:{summary:'insufficient',conditions:[]}}),/conditions/);
});
test('formal delivery policy cannot accept missing integrity or adapter proof despite score gains',async t=>{
  const f=await adapterFixture(t),before=await siteRun(t,{devices:['mobile'],scores:{mobile:[50]}});
  const a=await sourceSnapshot(f.root);await proof(before,a,f.root);
  await writeFile(path.join(f.root,'assets/main.js'),'window.example = 2;');const b=await sourceSnapshot(f.root);
  const after=await siteRun(t,{devices:['mobile'],scores:{mobile:[85]},offset:20});await proof(after,b,f.root);
  const input={before:before.root,after:after.root,expectedSourceHash:b.hash,regression:regressionForRun(after),review:{sourceHash:b.hash,contentPreserved:true,visualsPreserved:true,summary:'Synthetic fixture'}};
  assert.equal((await verifyOptimization(input)).outcome,'optimization-accepted');
  const strict=await verifyOptimization({...input,policy:'delivery-v1'});assert.equal(strict.outcome,'not-accepted');
  assert.equal(strict.checks.find(c=>c.id==='runtime-metric-and-loading-integrity').pass,false);
  assert.equal(strict.checks.find(c=>c.id==='theme-adapter-bound').pass,false);
  assert.equal(strict.provenance.toolkit.version,'0.20.0');
});
test('complex scenario schema accepts input/IME and bounded faults, never arbitrary fault writes',()=>{
  const base={schemaVersion:1,url:'http://localhost:3000',viewports:[{name:'mobile',width:390,height:844}],scenarios:[{name:'input',steps:[{action:'fill',selector:'#q',value:'hello'},{action:'select',selector:'#variant',values:['2']},{action:'ime',selector:'#q',text:'中文',commit:true},{action:'assert-text',selector:'#result',text:'中文'}]}]};
  assert.equal(validateScenarioConfig(base).scenarios[0].steps.length,4);
  assert.throws(()=>validateScenarioConfig({...base,networkFaults:[{url:'https://example.com',occurrence:1,delayMs:99999}]}));
  assert.throws(()=>validateScenarioConfig({...base,networkFaults:[{url:'https://example.com',occurrence:1,method:'POST'}]}));
});
test('external business importer recomputes observations, checks identity and refuses drift or simulated success',async t=>{
  const root=await realpath(await mkdtemp(path.join(os.tmpdir(),'perfkit-business-')));t.after(()=>rm(root,{recursive:true,force:true}));
  const identity={sourceHash:'a'.repeat(64),store:'fixture.myshopify.com',themeId:'1'};
  const raw={identity,startedAt:'2026-01-01T00:00:01Z',finishedAt:'2026-01-01T00:00:02Z',simulated:false,
    actions:[{type:'click',target:'#add',at:'2026-01-01T00:00:01Z'}],requests:[{method:'POST',url:'https://fixture.myshopify.com/cart/add.js',status:200,completed:true}],
    cart:{items:[{key:'variant:properties',quantity:1}],total_price:100},ui:{quantity:1},events:{added:1},errors:[]};
  const input=path.join(root,'manifest.json'),artifact=path.join(root,'case.json');
  const manifest={schemaVersion:1,kind:'external-business-run',mode:'authorized-preview',producer:'synthetic-contract-fixture',identity,authorization:{reference:'fixture-not-actual-authorization',store:identity.store,themeId:'1'},startedAt:'2026-01-01T00:00:00Z',finishedAt:'2026-01-01T00:00:03Z',cases:[{id:'once',artifact:'case.json',sha256:digest(JSON.stringify(raw)),expected:{cart:structuredClone(raw.cart),ui:raw.ui,events:raw.events,writes:[{url:raw.requests[0].url,status:200}]}}]};
  await writeFile(artifact,JSON.stringify(raw));await writeFile(input,JSON.stringify(manifest));
  const config={input,identity,requiredCases:['once']};
  assert.equal((await verifyBusinessEvidence(config)).outcome,'passed');
  assert.equal((await verifyBusinessEvidence({...config,requiredCases:['missing']})).outcome,'not-accepted');
  await assert.rejects(verifyBusinessEvidence({...config,identity:{...identity,themeId:'2'}}),/scope/);
  raw.cart.items[0].quantity=2;await writeFile(artifact,JSON.stringify(raw));
  await assert.rejects(verifyBusinessEvidence(config),/hash/);
  manifest.cases[0].sha256=digest(JSON.stringify(raw));await writeFile(input,JSON.stringify(manifest));
  assert.equal((await verifyBusinessEvidence(config)).outcome,'not-accepted');
});
