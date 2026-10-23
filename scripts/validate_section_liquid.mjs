#!/usr/bin/env node
// Actual Liquid rendering and Chrome/Lighthouse; source-pull transport is a local fixture adapter.
import assert from 'node:assert/strict';
import path from 'node:path';
import {mkdtemp,cp,readFile,writeFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {profileDomain} from '../lib/domain-profile.mjs';
import {diagnoseUnified} from '../lib/decision-engine.mjs';
import {createDomainPlan} from '../lib/domain-plan.mjs';
import {applySitePlan} from '../lib/site-changes.mjs';
import {extendedContracts} from '../lib/extended-methods.mjs';
import {runPatchExperiment} from '../lib/patch-experiment.mjs';
import {measureSite} from '../lib/measure.mjs';
import {runOptimization} from '../lib/optimize.mjs';
import {sourceSnapshot} from '../lib/runtime-profile.mjs';
import {writeTheme,serveTheme,deployment,steps,renderTag} from '../tests/fixtures/section-liquid/theme.mjs';
const method=process.argv.includes('--inline')?'section-liquid-inline':'section-liquid-initial';
const previous=process.argv.find(a=>a.startsWith('--previous='))?.slice('--previous='.length);

const root=await mkdtemp('/private/tmp/perfkit-section-liquid-'),projects={1:path.join(root,'baseline'),2:path.join(root,'candidate')};
await writeTheme(projects[1]);await cp(projects[1],projects[2],{recursive:true});
const server=await serveTheme(projects),goal={kind:'loading',metric:'lcp'};
const save=async(name,value)=>writeFile(path.join(root,name),JSON.stringify(value,null,2)+'\n');
const decl=id=>({project:projects[id],store:'fixture.myshopify.com',themeId:id});
const url=id=>`${server.origin}/fr/collections/all?preview_theme_id=${id}&sort_by=title-ascending`;
const measurement=id=>({schemaVersion:1,engine:'lighthouse',pages:[{id:'home',url:url(id)}],devices:['mobile'],deployment:decl(id),timeoutMs:60000});
const regression=id=>({schemaVersion:1,url:url(id),settleMs:1100,serverRenderedSelectors:['#hero'],viewports:[{name:'mobile',width:390,height:844},{name:'desktop',width:1440,height:900}],scenarios:[{name:'initial-and-dynamic',url:url(id),steps}]});
console.log(JSON.stringify({root,method,scope:'artificial-liquid-theme-only',maximumLighthouseNavigations:26,goal}));
try {
  const history=previous?[JSON.parse(await readFile(path.join(previous,'experiment/verification.json'),'utf8'))]:[];
  if(previous) {
    const prior=JSON.parse(await readFile(path.join(previous,'formal/verification.json'),'utf8'));
    assert.equal(prior.outcome,'not-accepted');
    await save('reassessment.json',{previous,previousFormal:prior,changedMechanism:'Remove the small isolated external controller request; retain server output and immediate delegated interactions.',method,remainingCandidates:0});
  }
  const profile=await profileDomain({config:{schemaVersion:1,mode:'runtime',deployment:decl('1'),url:url('1'),profile:{device:'mobile',settleMs:1100}},output:path.join(root,'profile'),dependencies:{verifyDeployment:deployment}});
  const diagnosis=await diagnoseUnified({project:projects[2],profiles:[profile],goal,limit:20});
  await save('diagnosis.json',diagnosis);
  const candidate=diagnosis.candidates.find(c=>c.kind==='section-fetch'&&c.methods.includes('section-liquid-initial'));assert.ok(candidate,'Measured dynamic loader must be actionable');
  const donor=await readFile(path.join(projects[1],'sections/ajax-main.liquid'),'utf8'),dynamic=new URL(url('1'));
  dynamic.searchParams.set('sort_by','title-descending');dynamic.searchParams.set('view','ajax');
  const plan=await createDomainPlan({project:projects[2],diagnosis,config:{schemaVersion:1,candidateId:candidate.candidateId,method,sectionSelector:'#hero',
    initialLiquid:{targetFile:'sections/main.liquid',sourceFile:'sections/ajax-main.liquid',renderOffset:donor.indexOf(renderTag),startupFunction:'load',legacyView:'ajax',update:{triggerSelector:'#refresh',assertionSelector:'#first-title',requestUrl:dynamic.href}},
    review:{summary:'Existing render receives the same collection and section settings; loader only fetches and replaces #hero; delegated details/sort handlers remain. Current page and alternate template use matching section settings; scoped requests retain locale and sort, and original full response is fallback. This fixture allows inline scripts and its isolated controller exposes no globals to other assets.',...Object.fromEntries(extendedContracts[method].review.map(k=>[k,true]))}}});
  await save('plan.json',plan);await save('apply.json',await applySitePlan(plan,projects[2]));
  for(const id of ['1','2']) {
    const check=spawnSync(process.env.SHOPIFY_CLI??'shopify',['theme','check','--path',projects[id],'--output','json'],{encoding:'utf8',timeout:90000});
    await save(`theme-check-${id}.json`,{status:check.status,stdout:check.stdout,stderr:check.stderr,error:check.error?.message});
    assert.equal(check.status,0,`Theme Check failed: ${check.stdout} ${check.stderr}`);
  }
  const experiment=await runPatchExperiment({config:{schemaVersion:1,plan,diagnosis,candidateId:candidate.candidateId,goal,runs:3,history,before:measurement('1'),after:measurement('2'),regressionBefore:regression('1'),regressionAfter:regression('2'),budget:{maxWallTimeMs:600000,maxAttempts:6,maxFailures:2}},output:path.join(root,'experiment'),dependencies:{verifyDeployment:deployment}});
  console.log(JSON.stringify({stage:'experiment',status:experiment.status,error:experiment.error,verification:experiment.verification}));
  await save('result.json',{scope:'artificial-liquid-theme-only',experiment});
  if(experiment.status!=='promising')process.exitCode=2;
  else {
    const formal=id=>({...measurement(id),purpose:'acceptance',devices:['mobile','desktop'],runs:5,budget:{maxWallTimeMs:900000,maxAttempts:10,maxFailures:2}});
    const baseline=path.join(root,'formal-baseline');
    const measured=await measureSite({config:formal('1'),output:baseline,dependencies:{verifyDeployment:deployment}});assert.equal(measured.status,'complete');
    const source=await sourceSnapshot(projects[2]);
    const accepted=await runOptimization({config:{schemaVersion:1,action:'verify',project:projects[2],plan:path.join(root,'plan.json'),reviewedPlanHash:plan.planHash,before:baseline,measurement:formal('2'),scenarios:regression('2'),review:{sourceHash:source.hash,contentPreserved:true,visualsPreserved:true,summary:'Both viewport checkpoint trees, geometry and selected computed styles match baseline; no-JS initial HTML matches live initial content; details and changed sort content tested before and after replacement.'},patchEvidence:path.join(root,'experiment/patch-evidence.json'),goal,exploreFirst:false,rollbackOnFailure:true},output:path.join(root,'formal'),dependencies:{verifyDeployment:deployment,measureSite:args=>measureSite({...args,dependencies:{verifyDeployment:deployment}})}});
    await save('result.json',{scope:'artificial-liquid-theme-only',experiment,formal:accepted});
    console.log(JSON.stringify({stage:'formal',status:accepted.status,output:accepted.output}));
    if(accepted.status!=='optimization-accepted')process.exitCode=2;
  }
} finally {await server.close();}
