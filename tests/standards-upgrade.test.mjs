import {integrityForRun} from './helpers/standards-integrity.mjs';
// All evidence below is synthetic contract data. No merchant/storefront claim.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {acceptanceContract,verificationPlan} from '../lib/standards-policy.mjs';
import {checkThemeProject,requiredThemeChecks} from '../lib/theme-check-project.mjs';
import {verifyThemeCheckDelta,verifyStandardsEvidence} from '../lib/standards-acceptance.mjs';
import {sourceSnapshot} from '../lib/theme-source.mjs';
import {digest} from '../lib/evidence-contract.mjs';
import {verifyOptimization} from '../lib/optimization-verification.mjs';
import {evaluateGain} from '../lib/performance-gain.mjs';
import {inspectStandardsDOM} from '../lib/standards-observations.mjs';
import {importPageOtter} from '../lib/pageotter-import.mjs';
import {createSourceIndexSession,indexThemeSources} from '../lib/source-attribution.mjs';
import {renderReport} from '../lib/report.mjs';
import {reportActions} from '../lib/report-actions.mjs';
import {siteRun,regressionForRun} from './helpers/site-run.mjs';
import {proof} from './helpers/improvement-fixture.mjs';

async function temp(t){const root=await mkdtemp('/private/tmp/perfkit-standards-upgrade-');t.after(()=>rm(root,{recursive:true,force:true}));return root;}
async function file(root,name,value){await mkdir(path.dirname(root+'/'+name),{recursive:true});await writeFile(root+'/'+name,typeof value==='string'?value:JSON.stringify(value));return root+'/'+name;}
async function ref(root,name,value){const artifact=await file(root,name,value);return {artifact,sha256:digest(await readFile(artifact))};}
const effective=requiredThemeChecks.map(id=>`${id}:\n  enabled: true\n`).join('');
function runner({raw=[],configuration=effective,fail=false,onCheck}={}){return async(_,args)=>{
  assert.ok(!args.includes('--auto-correct'));
  if(args[0]==='version'||args.includes('--version'))return {code:0,stdout:'synthetic 5.0.1',stderr:''};
  if(args.includes('--list'))return {code:0,stdout:requiredThemeChecks.join('\n'),stderr:''};
  if(args.includes('--print'))return {code:0,stdout:configuration,stderr:''};
  await onCheck?.();return {code:fail?2:raw.length?1:0,stdout:JSON.stringify(raw),stderr:''};
};}
async function pair(t,{rawBefore=[],rawAfter=[],configuration=effective,afterText='window.value=2;'}={}){
  const root=await temp(t),before=root+'/before',after=root+'/after';
  await file(before,'assets/main.js','window.value=1;');await file(after,'assets/main.js',afterText);
  const a=await checkThemeProject({project:before,dependencies:{runProcess:runner({raw:rawBefore,configuration})}});
  const b=await checkThemeProject({project:after,dependencies:{runProcess:runner({raw:rawAfter,configuration})}});
  return {root,before,after,a,b,input:{before:await ref(root,'a.json',a),after:await ref(root,'b.json',b)}};
}
const offense=(severity='warning')=>[{path:'assets/main.js',offenses:[{check:'AssetSizeJavaScript',severity,start_row:0,start_column:0,message:'Synthetic observation'}]}];

test('explicit metric policy and conservative scope never lower the legacy defaults or infer PASS',()=>{
  assert.equal(acceptanceContract().scoreGate,true);assert.throws(()=>acceptanceContract('standards-v1'),/explicit/);
  assert.equal(acceptanceContract('standards-v1',{kind:'loading',metric:'lcp'}).scoreGate,false);
  assert.throws(()=>acceptanceContract('typo',{kind:'loading',metric:'lcp'}));
  const plan=verificationPlan({beforeFiles:[],afterFiles:[{file:'sections/banner.liquid',sourceHash:'a'}]});
  assert.equal(plan.level,3);assert.deepEqual(plan.widths,[375,768,1024,1280,1920]);assert.ok(plan.checks.every(c=>c.status==='NOT RUN'));
  assert.throws(()=>verificationPlan({afterFiles:[{file:'assets/main.js',sourceHash:'a'}],scope:{level:2}}),/cannot reduce/);
  assert.equal(verificationPlan({afterFiles:[{file:'config/settings_data.json',sourceHash:'a'}]}).level,1);
});

test('Theme Check executes actual project config, retains raw output and rejects source mutation/errors',async t=>{
  const root=await temp(t);await file(root,'layout/theme.liquid','{{ content_for_header }}{{ content_for_layout }}');
  await file(root,'.theme-check.yml','extends: theme-check:recommended\n');
  const r=await checkThemeProject({project:root,dependencies:{runProcess:runner()}});
  assert.equal(r.complete,true);assert.equal(r.execution.commands.length,5);assert.equal(r.metadata.rulesConfig.projectConfiguration,'extends: theme-check:recommended\n');
  assert.deepEqual(r.rawReport,[]);
  await assert.rejects(checkThemeProject({project:root,dependencies:{runProcess:runner({fail:true})}}),/execution failed/);
  await assert.rejects(checkThemeProject({project:root,dependencies:{runProcess:runner({onCheck:()=>file(root,'layout/theme.liquid','drift')})}}),/changed/);
});

test('official delta requires complete bound raw evidence, new warning review, and no new error',async t=>{
  const p=await pair(t,{rawAfter:offense()});
  let result=await verifyThemeCheckDelta(p.input,p.a.sourceManifest,p.b.sourceManifest);
  assert.equal(result.checkStatus,'FAIL');assert.equal(result.unreviewedWarnings.length,1);
  p.input.warningReviews=[{fingerprint:p.b.findings[0].fingerprint,reason:'Reviewed synthetic budget',reviewer:'fixture'}];
  assert.equal((await verifyThemeCheckDelta(p.input,p.a.sourceManifest,p.b.sourceManifest)).checkStatus,'PASS');
  const e=await pair(t,{rawAfter:offense('error')});
  assert.equal((await verifyThemeCheckDelta(e.input,e.a.sourceManifest,e.b.sourceManifest)).newErrors.length,1);
  assert.equal((await verifyThemeCheckDelta(undefined,[],[])).checkStatus,'NOT RUN');
  await file(p.after,'assets/main.js','changed since scan');
  assert.match((await verifyThemeCheckDelta(p.input,p.a.sourceManifest,p.b.sourceManifest)).reason,/differs/);
});

test('disabled, unavailable, ignored, tampered and changed checker contracts cannot pass',async t=>{
  for(const [configuration,status] of [
    [effective.replace('AssetSizeCSS:\n  enabled: true','AssetSizeCSS:\n  enabled: false'),'FAIL'],
    [effective.replace('AssetSizeCSS:\n  enabled: true\n',''),'NOT RUN'],
    ['ignore:\n  - assets/**\n'+effective,'NOT RUN'],
  ]){const p=await pair(t,{configuration});assert.equal((await verifyThemeCheckDelta(p.input,p.a.sourceManifest,p.b.sourceManifest)).checkStatus,status);}
  const p=await pair(t);const changed=structuredClone(p.b);changed.metadata.toolVersion='another';
  p.input.after=await ref(p.root,'changed.json',changed);assert.equal((await verifyThemeCheckDelta(p.input,p.a.sourceManifest,p.b.sourceManifest)).checkStatus,'FAIL');
  p.input.after.sha256='0'.repeat(64);assert.match((await verifyThemeCheckDelta(p.input,p.a.sourceManifest,p.b.sourceManifest)).reason,/hash mismatch/);
});

async function observations(p,pages){
  const plan=verificationPlan({beforeFiles:p.a.sourceManifest,afterFiles:p.b.sourceManifest});
  const checks=[];
  for(const c of plan.checks.filter(c=>c.blocking)){
    const value={schemaVersion:1,kind:'standards-check-observation',checkId:c.id,sourceHash:p.b.sourceHash,evidenceLevel:c.evidenceLevel,
      status:'PASS',reviewer:'synthetic fixture',observedAt:'2026-11-11T08:00:00Z',observation:'Synthetic contract observation only.',conditions:{pages,widths:plan.widths}};
    checks.push({id:c.id,...await ref(p.root,c.id+'.json',value)});
  }
  return {themeCheck:p.input,scope:{pages},checks};
}

test('scoped evidence requires hashes, current identity and all widths; post-release field remains NOT RUN',async t=>{
  const p=await pair(t),pages=['https://example.com/'];const input=await observations(p,pages);
  const args={input,beforeManifest:p.a.sourceManifest,afterManifest:p.b.sourceManifest,sourceHash:p.b.sourceHash,pages};
  const complete=await verifyStandardsEvidence(args);assert.equal(complete.pass,true);
  assert.equal(complete.checks.find(c=>c.id==='field-follow-up').checkStatus,'NOT RUN');
  const responsive=input.checks.find(c=>c.id==='responsive-layout'),raw=JSON.parse(await readFile(responsive.artifact,'utf8'));
  raw.conditions.widths=[375];Object.assign(responsive,await ref(p.root,'missing-width.json',raw));
  const incomplete=await verifyStandardsEvidence(args);assert.equal(incomplete.pass,false);assert.match(incomplete.checks.find(c=>c.id==='responsive-layout').reason,/widths/);
  raw.status='N/A';raw.reason='No time';Object.assign(responsive,await ref(p.root,'unsupported-na.json',raw));
  assert.equal((await verifyStandardsEvidence(args)).pass,false);
});

test('formal metric acceptance allows diagnostic score decline but keeps metric, identity and review gates',async t=>{
  const p=await pair(t);
  const before=await siteRun(t,{devices:['mobile'],scores:{mobile:[60]},augment:r=>{r.audits['largest-contentful-paint'].numericValue=3000;}});
  const after=await siteRun(t,{devices:['mobile'],scores:{mobile:[50]},offset:1000,augment:r=>{r.audits['largest-contentful-paint'].numericValue=2400;}});
  await proof(before,await sourceSnapshot(p.before),p.before);await proof(after,await sourceSnapshot(p.after),p.after);
  const goal={kind:'loading',metric:'lcp'},standardsEvidence=await observations(p,after.manifest.config.pages.map(p=>p.url));
  const args={before:before.root,after:after.root,goal,expectedSourceHash:p.b.sourceHash,regression:regressionForRun(after),
    review:{sourceHash:p.b.sourceHash,contentPreserved:true,visualsPreserved:true,summary:'Synthetic review'},standardsEvidence};
  args.regression.integrityProfiles={before:[integrityForRun(before,await sourceSnapshot(p.before))],after:[integrityForRun(after,await sourceSnapshot(p.after),1)]};
  assert.equal((await verifyOptimization(args)).outcome,'not-accepted');
  const accepted=await verifyOptimization({...args,acceptancePolicy:'standards-v1'});
  assert.equal(accepted.outcome,'optimization-accepted',JSON.stringify(accepted));
  assert.equal(accepted.scoreTargets.outcome,'performance-regressed');assert.ok(!accepted.checks.some(c=>c.id==='original-score-targets'));
  assert.equal(accepted.checkResults.find(c=>c.id==='field-follow-up').status,'NOT RUN');
  assert.equal((await verifyOptimization({...args,acceptancePolicy:'standards-v1',standardsEvidence:undefined})).outcome,'not-accepted');
  assert.equal((await verifyOptimization({...args,acceptancePolicy:'standards-v1',review:undefined})).outcome,'not-accepted');
  assert.match(renderReport(accepted),/standards-v1/);
  const withoutIntegrity=structuredClone(args);delete withoutIntegrity.regression.integrityProfiles;
  assert.equal((await verifyOptimization({...withoutIntegrity,acceptancePolicy:'standards-v1'})).outcome,'not-accepted');
  const regressed=await siteRun(t,{devices:['mobile'],scores:{mobile:[90]},offset:2000,augment:r=>{r.audits['largest-contentful-paint'].numericValue=4000;}});
  assert.equal((await evaluateGain({before:before.root,after:regressed.root,goal,scoreDiagnosticOnly:true})).outcome,'performance-regressed');
});

const image=extra=>({selector:'#image',src:'https://example.com/img.jpg',priority:'auto',width:100,height:100,sizes:'100px',declaredSizePx:100,declaredWidth:'100',declaredHeight:'100',hidden:false,downloaded:true,carouselCandidate:false,...extra});
const dom=()=>({version:1,phase:'initial-settled-dom',width:375,documentWidth:375,truncated:false,images:[],stylesheets:[],scripts:[],viewport:['width=device-width']});
test('new runtime checks distinguish observed defects, candidates, exclusions and missing/unsupported evidence',()=>{
  const d=dom();d.images=[image({priority:'high',declaredSizePx:400}),image({priority:'high',hidden:true}),image({hidden:true,carouselCandidate:true}),image({declaredWidth:null})];
  d.stylesheets=[{href:'https://example.com/a.css',media:'',active:true},{href:'https://example.com/a.css',media:'',active:true}];
  d.scripts=[{type:'',async:false,defer:false,noModule:false}];d.documentWidth=600;d.viewport=[];
  const result=inspectStandardsDOM({initial:{standardsDOM:d}});
  assert.equal(result.findings.filter(f=>f.ruleId==='PERF_HIDDEN_IMAGE_DOWNLOAD').length,1);
  assert.equal(result.findings.find(f=>f.ruleId==='PERF_MOBILE_OVERFLOW').checkStatus,'FAIL');
  assert.equal(result.findings.find(f=>f.ruleId==='PERF_HEAD_BLOCKING_SCRIPT').status,'candidate');
  assert.ok(result.findings.every(f=>f.standardRuleIds.length));
  assert.ok(inspectStandardsDOM({}).checks.every(c=>c.status==='NOT RUN'));
  d.truncated=true;assert.ok(inspectStandardsDOM({initial:{standardsDOM:d}}).checks.every(c=>c.status==='NOT RUN'));
  const complex=dom();complex.images=[image({sizes:'(min-width: 900px) 50vw, 100vw',declaredSizePx:null})];
  assert.equal(inspectStandardsDOM({initial:{standardsDOM:complex}}).checks.find(c=>c.id==='PERF_IMAGE_SIZES_MISMATCH').status,'NOT RUN');
});

const handoff=()=>({schemaVersion:1,kind:'pageotter-handoff',producer:{name:'PageOtter',version:'proposed-v1-fixture'},capturedAt:'2026-11-11T08:00:00Z',
  identity:{url:'https://example.com/',themeId:'1',themeRole:'preview',pageType:'home',language:'en',currency:'USD',viewport:{width:375,height:800}},
  ruleScope:['PERF-IMG-02'],checks:[{ruleId:'PERF-IMG-02',subject:'#hero',status:'FAIL',summary:'LCP lazy image',evidenceLevel:'E2',evidence:[{observation:'Synthetic LCP entry'}]}]});
test('PageOtter handoff retains external provenance and only resolves an explicit same-scope later PASS',async()=>{
  const input=handoff(),baseline=await importPageOtter({input});
  assert.equal(baseline.acceptance,'not-evaluated');assert.equal(reportActions(baseline).counts.review,1);
  const later=structuredClone(input);later.capturedAt='2026-11-11T09:00:00Z';later.checks[0].status='PASS';
  assert.equal((await importPageOtter({input:later,baseline})).comparison.resolved.length,1);
  later.checks=[];assert.equal((await importPageOtter({input:later,baseline})).comparison.incomparable.length,1);
  later.checks=structuredClone(input.checks);later.checks[0].status='PASS';later.identity.viewport.width=768;
  assert.equal((await importPageOtter({input:later,baseline})).comparison.status,'not-comparable');
  assert.match(renderReport(baseline),/PageOtter/);
  for(const invalid of [{...input,schemaVersion:2},{...input,ruleScope:['made-up']},{...input,checks:[{...input.checks[0],evidence:[]}]}])await assert.rejects(importPageOtter({input:invalid}));
  input.checks[0].sourceCandidate={file:'../../secret',confidence:'inferred'};await assert.rejects(importPageOtter({input}),/Unsafe/);
});

test('request-scoped source index reuse checks current hashes and isolates mutations',async t=>{
  const root=await temp(t);await file(root,'assets/main.js','const value = 1;');await file(root,'assets/style.css','.item{color:red}');
  const session=createSourceIndexSession(),a=await indexThemeSources(root,{session});
  a.files[0].text='poison';a.edges.push({from:'invented'});
  const b=await indexThemeSources(root,{session});assert.equal(b.files[0].text,'const value = 1;');assert.equal(b.edges.length,0);assert.equal(b.cssUnits[0].rules[0].parent.type,'root');
  b.cssUnits[0].rules[0].nodes[0].value='poison';assert.equal((await indexThemeSources(root,{session})).cssUnits[0].rules[0].nodes[0].value,'red');
  await file(root,'assets/main.js','const value = 2;');
  const c=await indexThemeSources(root,{session});assert.notEqual(c.snapshot.hash,b.snapshot.hash);assert.match(c.files[0].text,/2/);
  await assert.rejects(indexThemeSources(root,{session:{}}),/must be created/);
});
