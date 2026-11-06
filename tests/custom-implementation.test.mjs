import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {requestImplementation,createCustomPlan} from '../lib/custom-implementation.mjs';
import {setup,read} from './helpers/improvement-fixture.mjs';
const candidate=request=>({schemaVersion:1,requestHash:request.requestHash,method:'custom/cache-repeated-work',rationale:'Reuse the computed result while retaining the same interface.',checks:['Same return value and interaction behavior'],changes:[{target:'assets/main.js',replacementText:'const cached=1; function heavy(){ return cached; }'}]});
async function fixture(t){const f=await setup(t),s=await f.step({action:'start'}),recovery=await read(s.recovery);const request=await requestImplementation({previous:s.output+'/session.json',candidateId:recovery.candidates[0].candidateId});return {f,request,c: candidate(request)};}
test('custom implementation returns a real reviewed plan and no-gain session rolls it back',async t=>{
 const {f,request,c}=await fixture(t),plan=await createCustomPlan({request,candidate:c});assert.equal(plan.changes[0].after,c.changes[0].replacementText);
 let s=await f.step({action:'prepare',candidateId:request.candidateId,method:c.method,rationale:c.rationale,implementation:{request,candidate:c}});assert.equal(s.status,'review-required',JSON.stringify(s.error));
 s=await f.step({action:'apply',reviewedPlanHash:s.active.planHash});assert.equal(s.status,'awaiting-preview-sync');assert.equal(await fs.readFile(f.project+'/assets/main.js','utf8'),c.changes[0].replacementText);
 s=await f.experiment();assert.equal(s.history[0].outcome,'no-measurable-gain');assert.equal(await fs.readFile(f.project+'/assets/main.js','utf8'),'function heavy(){ return 1; }');
});
test('measured gain from a custom patch still needs formal validation',async t=>{
 const {f,request,c}=await fixture(t);const s=await f.step({action:'prepare',candidateId:request.candidateId,method:c.method,rationale:c.rationale,implementation:{request,candidate:c}});
 await f.step({action:'apply',reviewedPlanHash:s.active.planHash});const result=await f.experiment({score:90,tbt:100});assert.equal(result.status,'formal-validation-required');assert.notEqual(result.acceptance,'accepted');
});
test('stale source, wrong request, syntax errors and changes outside requested files fail closed',async t=>{
 const {f,request,c}=await fixture(t);
 await assert.rejects(createCustomPlan({request,candidate:{...c,requestHash:'wrong'}}),/matching/);
 await assert.rejects(createCustomPlan({request,candidate:{...c,changes:c.changes.map(change=>({...change,evidence:{domainMethod:'invented-domain-method'}}))}}),/measured hypothesis/);
 await assert.rejects(createCustomPlan({request,candidate:{...c,changes:[{target:'assets/main.js',replacementText:'function {'}]}}));
 await assert.rejects(createCustomPlan({request,candidate:{...c,changes:[{target:'assets/other.js',replacementText:'let a=1;'}]}}),/scope/);
 await fs.appendFile(f.project+'/assets/main.js',' // external');await assert.rejects(createCustomPlan({request,candidate:c}),/drift/);
});
test('custom candidates support new assets and reject a mismatched prepare method',async t=>{
 const {f,request,c}=await fixture(t);const expanded={...c,changes:[...c.changes,{kind:'create-asset',target:'assets/helper.js',replacementText:'export const result=1;'}]};
 const plan=await createCustomPlan({request,candidate:expanded});assert.equal(plan.changes.length,2);assert.equal(plan.changes[1].recipeKind,'create-asset');
 const s=await f.step({action:'prepare',candidateId:request.candidateId,method:'custom/different-mechanism',rationale:c.rationale,implementation:{request,candidate:c}});assert.match(s.error.message,/bind this session/);assert.equal(await fs.readFile(f.project+'/assets/main.js','utf8'),'function heavy(){ return 1; }');
});
test('CLI request and custom plan are usable as standalone saved artifacts',async t=>{
 const {execFileSync}=await import('node:child_process');const {f,request,c}=await fixture(t),cli=new URL('../scripts/perfkit.mjs',import.meta.url).pathname;
 const requestFile=f.root+'/request.json',candidateFile=f.root+'/candidate.json',planFile=f.root+'/plan.json';
 execFileSync(process.execPath,[cli,'request-implementation','--previous',request.previous,'--candidate',request.candidateId,'--out',requestFile]);await fs.writeFile(candidateFile,JSON.stringify(c));
 execFileSync(process.execPath,[cli,'plan-custom','--request',requestFile,'--candidate',candidateFile,'--out',planFile]);assert.equal((await read(planFile)).changes[0].after,c.changes[0].replacementText);
});
test('legacy plan preparation cannot relabel a custom implementation',async t=>{
 const {f,request,c}=await fixture(t),plan=await createCustomPlan({request,candidate:c});
 const s=await f.step({action:'prepare',candidateId:request.candidateId,method:'custom/renamed-mechanism',rationale:c.rationale,plan});assert.match(s.error.message,/renaming/);assert.equal(s.active,undefined);
});
test('twenty related source files and protected read-only settings round-trip through requests',async t=>{
 const f=await setup(t);await fs.mkdir(f.project+'/config');await fs.writeFile(f.project+'/config/settings_data.json','{"current":{}}');const files=['config/settings_data.json'];
 for(let i=0;i<19;i++){const file=`assets/context-${i}.js`;await fs.writeFile(f.project+'/'+file,'const value=1;');files.push(file);}
 // The synthetic measured baseline must bind the complete fixture before start.
 const {proof}=await import('./helpers/improvement-fixture.mjs');const {sourceSnapshot}=await import('../lib/theme-source.mjs');await proof(f.baseline,await sourceSnapshot(f.project),f.project);
 const s=await f.step({action:'start'}),r=await read(s.recovery);const request=await requestImplementation({previous:s.output+'/session.json',candidateId:r.candidates[0].candidateId,files});
 assert.equal(request.sources.length,21);assert.equal((await createCustomPlan({request,candidate:candidate(request)})).changes.length,1);
});
test('saved custom plans revalidate syntax and preserve layout output',async t=>{
 const {f,request,c}=await fixture(t),plan=await createCustomPlan({request,candidate:c});
 const {planHash,unifiedDiff}=await import('../lib/core/plan-utils.mjs');const {sha256}=await import('../lib/core/source-utils.mjs');const {validateSitePlan,createSitePlan}=await import('../lib/site-changes.mjs');
 plan.changes[0].after='function {';plan.changes[0].afterHash=sha256(plan.changes[0].after);plan.changes[0].diff=unifiedDiff(plan.changes[0].target,plan.changes[0].before,plan.changes[0].after);plan.planHash=planHash(plan);
 await assert.rejects(validateSitePlan(plan));await fs.mkdir(f.project+'/layout');const text='<html><body>\n{{ content_for_layout }}\n</body></html>';await fs.writeFile(f.project+'/layout/theme.liquid',text);
 await assert.rejects(createSitePlan({project:f.project,recipe:{schemaVersion:1,changes:[{kind:'reviewed-replacement',target:'layout/theme.liquid',replacementText:text.replace('{{ content_for_layout }}',''),reason:'Invalid deletion',evidence:{summary:'Test protected output'}}]}}),/content_for_header/);
});
test('a custom wrapper cannot make a failed domain mechanism available again',async()=>{
 const {remainingDomainMethods,hypothesisKey}=await import('../lib/recovery.mjs');
 const hypothesis={candidateId:'c',file:'sections/catalog.liquid',line:1,kind:'liquid-query',metric:'ttfb',methods:['query-limit','query-limit-render']};
 const history=[{baselineHash:'hash',hypothesisKey:hypothesisKey(hypothesis),method:'custom/reviewed-query',domainMethods:['query-limit'],outcome:'no-measurable-gain'}];
 assert.deepEqual(remainingDomainMethods(hypothesis,'hash',history),[]);
});
test('custom optimization reaches formal acceptance only with complete fixed evidence, and formal regressions roll back',async t=>{
 for(const score of [90,50]){
  const {f,request,c}=await fixture(t);let s=await f.step({action:'prepare',candidateId:request.candidateId,method:c.method,rationale:c.rationale,implementation:{request,candidate:c}});
  s=await f.step({action:'apply',reviewedPlanHash:s.active.planHash});s=await f.experiment({score:90,tbt:100});assert.equal(s.status,'formal-validation-required');
  const {siteRun,regressionForRun}=await import('./helpers/site-run.mjs');const {proof}=await import('./helpers/improvement-fixture.mjs');const {sourceSnapshot}=await import('../lib/theme-source.mjs');
  const after=await siteRun(t,{devices:['mobile'],offset:500,scores:{mobile:[score]},augment:r=>{r.audits['total-blocking-time'].numericValue=score===90?100:700;}});await proof(after,await sourceSnapshot(f.project),f.project);
  const verification={after:after.root,regression:regressionForRun(after)};
  if(score===90){s=await f.step({action:'verify',verification});assert.notEqual(s.status,'optimization-accepted');assert.equal(s.retained.length,0);}
  // Complete the missing review using the same formal reports, never resample.
  s=await f.step({action:'verify',verification:{...verification,review:{sourceHash:f.state.active.sourceHash,contentPreserved:true,visualsPreserved:true,summary:'Synthetic fixture review, no store claim'}}});
  if(score===90){assert.equal(s.status,'optimization-accepted',JSON.stringify(s.error));assert.equal(s.retained.length,1);assert.equal(await fs.readFile(f.project+'/assets/main.js','utf8'),c.changes[0].replacementText);}
  else {assert.equal(s.history.at(-1).outcome,'formal-rejected');assert.equal(s.active,null);assert.equal(await fs.readFile(f.project+'/assets/main.js','utf8'),'function heavy(){ return 1; }');}
 }
});
