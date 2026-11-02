import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFile,readFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {Liquid} from 'liquidjs';
import {themeStepFixture} from './helpers/theme-step-fixture.mjs';
import {parseLiquidAsset,effectiveAssetSettings} from '../lib/liquid-assets.mjs';
import {indexThemeSources,associateScript} from '../lib/source-attribution.mjs';
import {createSitePlan,applySitePlan,rollbackSitePlan} from '../lib/site-changes.mjs';
import {transformCode,analyzeCode} from '../lib/code-strategies.mjs';
import {sha256} from '../lib/runtime-profile.mjs';
import {diagnoseBottlenecks,requireHypothesis} from '../lib/bottlenecks.mjs';
const source='const label = {{\n settings.currency_label | json\n }};\nfunction init(){window.fixture=label;}\ninit();';
const themeFiles={
 'layout/theme.liquid':`<script src="{{ 'theme.js' | asset_url }}" defer></script>`,
 'assets/theme.js.liquid':source,
 'config/settings_schema.json':JSON.stringify([{name:'General',settings:[{id:'currency_label',type:'text',default:'USD'}]}]),
 'config/settings_data.json':JSON.stringify({current:{currency_label:'USD'}}),
};
test('Liquid asset graph resolves aliases, verifies settings and maps compiled line two back to template line four',async t=>{
  const f=await themeStepFixture(t,themeFiles),index=await indexThemeSources(f.root),body='const label = "USD";\nfunction init(){window.fixture=label;}\ninit();';
  assert.ok(index.edges.some(e=>e.to==='assets/theme.js.liquid'));assert.ok(!index.unresolved.some(e=>e.reason==='missing-source'));
  const mapped=associateScript(body,index,{url:'https://fixture.test/theme.js',line:2,column:1});
  assert.equal(mapped.status,'verified-ast');assert.equal(mapped.scriptKind,'liquid-asset');assert.equal(mapped.line,4);assert.equal(mapped.offset,source.indexOf('function'));
  assert.equal(associateScript(body.replace('USD','EUR'),index).status,'unmapped');
  assert.equal(associateScript(body.replace('window.fixture=label','window.fixture=999'),index).status,'unmapped');
  await writeFile(path.join(f.root,'assets/second.js.liquid'),source.replace('currency_label','alternative_label'));
  await writeFile(path.join(f.root,'config/settings_data.json'),JSON.stringify({current:{currency_label:'USD',alternative_label:'USD'}}));
  assert.equal(associateScript(body,await indexThemeSources(f.root)).status,'ambiguous');
});
test('unsafe Liquid JS patterns are rejected, including quoted slots, control flow, filters and computed properties',()=>{
  for(const s of ['const v="{{ settings.x | json }}";','// {{ settings.x | json }}\nconst v=1;','{% if settings.x %}run();{% endif %}','const v={{ settings.x | escape }};','window[{{ settings.x | json }}]=1;','const v={{- settings.x | json -}};'])assert.throws(()=>parseLiquidAsset(s));
  const defaults=effectiveAssetSettings([{file:'config/settings_schema.json',text:themeFiles['config/settings_schema.json']}]);assert.equal(defaults.values.currency_label,'USD');
  assert.equal(effectiveAssetSettings([{file:'config/settings_data.json',text:'bad'}]).available,false);
});
test('existing JS strategy changes static logic in a Liquid asset, preserving serialization, review gates and rollback',async t=>{
  const f=await themeStepFixture(t,themeFiles),evidence={sourceHash:sha256(source),summary:'Synthetic idle candidate with reviewed noncritical initialization',nonCritical:true,noFirstInteractionDependency:true,timingChangeReviewed:true},parameters={statementStart:source.lastIndexOf('init();'),timeoutMs:200};
  const generated=transformCode({source,target:'assets/theme.js.liquid',kind:'js-idle-init',parameters,evidence});
  assert.match(generated.after,/requestIdleCallback/);assert.ok(generated.after.includes('{{\n settings.currency_label | json\n }}'));
  const plan=await createSitePlan({project:f.root,recipe:{schemaVersion:1,changes:[{target:'assets/theme.js.liquid',kind:'js-idle-init',parameters,evidence,reason:'Defer one reviewed noncritical init.'}]}});
  await applySitePlan(plan,f.root);await rollbackSitePlan(plan,f.root);assert.equal(await readFile(path.join(f.root,'assets/theme.js.liquid'),'utf8'),source);
  assert.ok((await analyzeCode({project:f.root,target:'assets/theme.js.liquid'})).candidates.some(c=>c.kind==='js-idle-init'));
  await assert.rejects(createSitePlan({project:f.root,recipe:{schemaVersion:1,changes:[{target:'assets/theme.js.liquid',kind:'reviewed-replacement',replacementText:source.replace('currency_label','other'),reason:'Invalid setting migration',evidence:{sourceHash:sha256(source),summary:'Counterexample'}}]}}),{code:'PROTECTED_LIQUID_VALUES'});
  const engine=new Liquid();assert.match(await engine.parseAndRender(generated.after,{settings:{currency_label:'USD'}}),/const label = "USD"/);
});
test('compiled source proof is replayed before a CPU hypothesis can authorize a dynamic-asset plan',async t=>{
  const f=await themeStepFixture(t,themeFiles),index=await indexThemeSources(f.root),body='const label="USD";\nfunction init(){window.fixture=label;}\ninit();';
  const mapped=associateScript(body,index,{line:2,column:1});f.runtime.cpu=[{selfMs:80,url:'https://fixture.test/theme.js',functionName:'init',source:mapped}];
  f.runtime.compiledAssets=[{bodyHash:sha256(body),text:body}];
  const d=await diagnoseBottlenecks({project:f.root,profiles:[f.runtime]});assert.equal(d.candidates.length,1);assert.equal(requireHypothesis(d,d.candidates[0].candidateId,index.snapshot).file,'assets/theme.js.liquid');
  const modified=structuredClone(d);modified.candidates[0].liquidAssetEvidence.response=body.replace('USD','EUR');assert.throws(()=>requireHypothesis(modified,modified.candidates[0].candidateId,index.snapshot),/proof/);
  f.runtime.compiledAssets=[];assert.equal((await diagnoseBottlenecks({project:f.root,profiles:[f.runtime]})).candidates.length,0);
});
