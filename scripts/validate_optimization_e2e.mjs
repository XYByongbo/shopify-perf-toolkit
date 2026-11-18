import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {mkdir,mkdtemp,readFile,realpath,writeFile,cp} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {parseArgs,promisify} from 'node:util';
import {chromium} from 'playwright-core';
import {fixturePNG} from '../tests/helpers/fixture-image.mjs';
import {verifyDeployment} from '../lib/deployment.mjs';
import {measureSite} from '../lib/measure.mjs';
import {profileDomain} from '../lib/domain-profile.mjs';
import {runPatchExperiment} from '../lib/patch-experiment.mjs';
import {runImprovement} from '../lib/improvement-session.mjs';
import {runOptimization,verifyOptimization} from '../lib/optimize.mjs';
import {collectOptimizationEvidence} from '../lib/optimization-collection.mjs';
import {checkThemeProject} from '../lib/theme-check-project.mjs';
import {verificationPlan} from '../lib/standards-policy.mjs';
import {browserExecutable,sourceSnapshot} from '../lib/theme-source.mjs';
import {createRunDirectory} from '../lib/run-directory.mjs';
import {digest} from '../lib/evidence-contract.mjs';
import {auditPerformance} from '../lib/performance-audit.mjs';
import {preflightTests} from './run_tests.mjs';

const {values} = parseArgs({options:{out:{type:'string'},help:{type:'boolean'}}});
if (values.help) {
  console.log('Usage: npm run test:optimization-e2e -- [--out <new-directory-outside-repository>]');
  process.exit(0);
}
const repo = fileURLToPath(new URL('../',import.meta.url));
const destination = values.out === undefined ? undefined : path.resolve(values.out);
if (destination) {
  const relative = path.relative(repo,destination);
  if (!relative || !relative.startsWith('..'+path.sep) && relative !== '..' && !path.isAbsolute(relative)) {
    throw new Error('Choose an output directory outside the repository.');
  }
}
const executable = await browserExecutable();
const checker = await preflightTests('official');
const root = destination ? await createRunDirectory(destination)
  : await mkdtemp(path.join(await realpath(tmpdir()),'perfkit-optimization-e2e-'));
const artifact = name => path.join(root,name);
const readJSON = async file => JSON.parse(await readFile(file,'utf8'));
const save = async (name,value) => {
  const file = artifact(name);
  await writeFile(file,JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600});
  return file;
};
const evidenceRef = async (name,value) => {
  const file = await save(name,value);
  return {artifact:file,sha256:digest(await readFile(file))};
};
let currentStage = 'setup';
const stage = (name,details={}) => {
  currentStage = name;
  console.log(JSON.stringify({stage:name,output:root,...details}));
};
const execute = promisify(execFile);
async function command(expected,...args) {
  let exitCode = 0, stdout, stderr;
  try {
    ({stdout,stderr} = await execute(process.execPath,[path.join(repo,'scripts/perfkit.mjs'),...args],{timeout:30000}));
  } catch (error) {
    ({code:exitCode,stdout,stderr} = error);
  }
  assert.equal(exitCode,expected,stderr || stdout);
  return JSON.parse(stdout);
}

stage('setup',{shopifyCli:checker.shopify});
const projects={1:artifact('baseline'),2:artifact('candidate')},deployed={1:artifact('deployed-1'),2:artifact('deployed-2')};
const mobile=fixturePNG(900,450),desktop=fixturePNG(1000,500);
const hero=`<section aria-label="Campaign">
  <img src="/mobile.png" loading="lazy" class="hero--mobile" id="hero-mobile" width="900" height="450" alt="Campaign landscape">
  <img src="/desktop.png" loading="lazy" class="hero--desktop" id="hero-desktop" width="1000" height="500" alt="Campaign landscape">
</section>
{% schema %}{"name":"Fixture campaign","settings":[]}{% endschema %}`;
for(const dir of ['sections','layout','templates'])await mkdir(path.join(projects[1],dir),{recursive:true});
await writeFile(path.join(projects[1],'sections/campaign.liquid'),hero);
await writeFile(path.join(projects[1],'layout/theme.liquid'),'<!doctype html><html lang="en"><head><meta charset="utf-8"><title>{{ page_title }}</title>{{ content_for_header }}</head><body>{{ content_for_layout }}</body></html>');
await writeFile(path.join(projects[1],'templates/index.liquid'),'<main><h1>Guard page</h1><p>Unchanged content</p></main>');
await writeFile(path.join(projects[1],'templates/page.campaign.json'),'{"sections":{"main":{"type":"campaign","settings":{}}},"order":["main"]}');
const checkConfig='extends: theme-check:recommended\nAssetSizeCSS:\n  enabled: true\nAssetSizeJavaScript:\n  enabled: true\n';
await writeFile(path.join(projects[1],'.theme-check.yml'),checkConfig);
await cp(projects[1],projects[2],{recursive:true});
await cp(projects[1],deployed[1],{recursive:true});
await cp(projects[1],deployed[2],{recursive:true});
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const server=http.createServer(async(req,res)=>{
  const u=new URL(req.url,'http://127.0.0.1'),id=u.searchParams.get('preview_theme_id')??'1';
  try {
    res.setHeader('cache-control','no-store');
    if (!['GET','HEAD'].includes(req.method)) {res.writeHead(405);res.end();return;}
    if(u.pathname==='/favicon.ico'){res.writeHead(204);res.end();return;}
    if(u.pathname.endsWith('.png')){await wait(1550);res.setHeader('content-type','image/png');res.end(u.pathname.startsWith('/mobile')?mobile:desktop);return;}
    if(u.pathname==='/fixture-block.js'){await wait(2650);res.setHeader('content-type','text/javascript');res.end('window.fixtureReady=true;');return;}
    if(!deployed[id]||!['/','/campaign'].includes(u.pathname)){res.writeHead(404);res.end();return;}
    const campaign=u.pathname==='/campaign';
    const section=campaign?(await readFile(path.join(deployed[id],'sections/campaign.liquid'),'utf8')).split('{% schema %}')[0]:'';
    const block=campaign?'<script src="/fixture-block.js"></script>':'';
    const heading=campaign?'Campaign offers':'Guard page';
    res.setHeader('content-type','text/html');
    res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${heading}</title><meta name="viewport" content="width=device-width,initial-scale=1">
    <style>body{margin:0;font:16px system-ui}main{max-width:960px;margin:auto;padding:12px}img{width:100%;height:auto;display:block}.hero--mobile{display:none}@media(max-width:749px){.hero--mobile{display:block}.hero--desktop{display:none}}</style>
    <script>window.Shopify={theme:{id:${id}},shop:'fixture.myshopify.com'};</script></head>
    <body><main><h1>${heading}</h1>${block}${section}<p>Unchanged content</p><button type="button" onclick="document.querySelector('output').textContent='Ready'">Open</button><output>Closed</output></main></body></html>`);
  } catch(e){res.writeHead(500);res.end(String(e));}
});
await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
const origin='http://127.0.0.1:'+server.address().port;
const page=(id,target)=>({id:target?'campaign':'home',url:origin+(target?'/campaign':'/')+'?preview_theme_id='+id});
const pages=id=>[page(id,true),page(id,false)];
const deployment=id=>({project:projects[id],store:'fixture.myshopify.com',themeId:String(id),timeoutMs:25000});
const verify=args=>verifyDeployment({...args,dependencies:{runProcess:async(_command,argv)=>{
  assert.deepEqual(argv.slice(0,2),['theme','pull']);
  assert.equal(argv[argv.indexOf('--store')+1],'fixture.myshopify.com');
  await cp(deployed[argv[argv.indexOf('--theme')+1]],argv[argv.indexOf('--path')+1],{recursive:true});
  return {code:0,stdout:'Isolated fixture transport',stderr:''};
}}});
const measures=id=>({schemaVersion:1,engine:'lighthouse',throttlingMethod:'devtools',purpose:'acceptance',runs:5,timeoutMs:50000,
  pages:pages(id),devices:['mobile'],deployment:deployment(id),budget:{maxAttempts:22,maxWallTimeMs:1800000}});
const measure=args=>measureSite({...args,dependencies:{verifyDeployment:verify}});
const experiment=args=>runPatchExperiment({...args,dependencies:{verifyDeployment:verify}});
const goal={kind:'loading',metric:'lcp',requiredGroups:[{pageId:'campaign',device:'mobile'}]};
const policy='standards-v1';
const scenarios=(id,onlyTarget=false)=>({schemaVersion:1,viewports:[{name:'mobile',width:390,height:844,dpr:3}],
  scenarios:pages(id).filter(p=>!onlyTarget||p.id==='campaign').map(p=>({name:p.id,url:p.url,steps:[
    {action:'assert-text',selector:'h1',text:p.id==='campaign'?'Campaign offers':'Guard page'},
    ...(p.id==='campaign'?[{action:'assert-image-loaded',selector:'#hero-mobile'}]:[]),
    {action:'click',selector:'button'},{action:'assert-text',selector:'output',text:'Ready'},
    {action:'checkpoint',selector:'main',key:'opened'},
  ]}))});
let session, stepNumber=0;
const step=async(input,deps={})=>{
  session=await runImprovement({config:{schemaVersion:1,...(session?{previous:path.join(session.output,'session.json')}:{}),...input},output:artifact('step-'+(++stepNumber)+'-'+input.action),dependencies:{verifyDeployment:verify,runPatchExperiment:experiment,...deps}});
  assert.equal(session.error,undefined,JSON.stringify(session.error));
  stage(session.status,{action:input.action,counts:session.counts});
  return session;
};
const profile=async(config,out)=>profileDomain({config,output:out,dependencies:{verifyDeployment:verify}});

try {
  stage('audit-and-plan');
  await save('configuration.json',{
    goal,acceptancePolicy:policy,beforeMeasurement:measures(1),afterMeasurement:measures(2),
    beforeScenarios:scenarios(1),afterScenarios:scenarios(2),
    fixture:{scriptResponseDelayMs:2650,imageResponseDelayMs:1550,settleMs:2800},
  });
  const beforeCheck = await checkThemeProject({project:projects[1]});
  const unavailableRules = beforeCheck.requiredChecks.filter(rule=>rule.status!=='enabled');
  assert.deepEqual(unavailableRules,[],'Theme Check must cover the fixture standards rules');
  const audit=await auditPerformance({project:projects[2]});
  const finding=audit.findings.find(f=>f.ruleId==='PERF_DUAL_HERO');assert.ok(finding);
  const sampling=await command(0,'plan-sampling','--audit',await save('audit.json',audit),'--finding',finding.id,'--url',page(2,true).url,'--device','mobile','--store','fixture.myshopify.com','--settle-ms','2800','--out',artifact('sampling'));
  assert.equal(sampling.command,'profile-domain');
  const capture=sampling.captures[0];
  await command(0,'validate-config','--command',sampling.command,'--config',capture.config);
  const config=await readJSON(capture.config);
  const sampled=await profile(config,capture.output);
  assert.equal(sampled.domainProof.after.status,'verified');
  assert.equal(sampled.initial.lcp?.element?.id,'hero-mobile',JSON.stringify(sampled.lcp));
  const initialProfiles=await readJSON(sampling.profiles);
  stage('sampling-complete',{lcp:sampled.lcp});
  const baselineMain=await profile({...config,url:page(1,true).url,deployment:deployment(1)},artifact('baseline-runtime-campaign'));
  const baselineGuard=await profile({...config,url:page(1,false).url,deployment:deployment(1)},artifact('baseline-runtime-home'));
  stage('baseline-measurement');
  const baseline=await measure({config:measures(1),output:artifact('formal-baseline')});
  assert.equal(baseline.status,'complete',JSON.stringify(baseline.stopped??baseline.groups));
  await step({action:'start',project:projects[2],run:artifact('formal-baseline'),profiles:initialProfiles,goal,acceptancePolicy:policy,
    budget:{maxAttempts:40,maxWallTimeMs:2400000,maxFailures:6,maxCandidateRounds:2}});
  const recovery=await readJSON(session.recovery);
  const candidate=recovery.candidates.find(c=>c.kind==='image-lcp'&&c.methods.includes('image-eager'));
  assert.ok(candidate,JSON.stringify(recovery.candidates));
  await step({action:'prepare',candidateId:candidate.candidateId,method:'image-eager',
    rationale:'The cold campaign mobile trace locates late request start on the first visible lazy image.',
    domain:{schemaVersion:1,review:{summary:'The campaign template contains one mobile hero and one breakpoint-hidden desktop companion.',sharedInstancesReviewed:true}}});
  const reviewedPlan=await readJSON(session.active.plan);
  assert.equal(reviewedPlan.changes.length,1);
  assert.equal(reviewedPlan.changes[0].target,'sections/campaign.liquid');
  assert.match(reviewedPlan.changes[0].diff,/eager/);
  await step({action:'apply',reviewedPlanHash:session.active.planHash});
  await cp(projects[2],deployed[2],{recursive:true});
  await step({action:'sync',preview:{deployment:deployment(2),pages:pages(2)}});
  stage('alternating-experiment');
  await step({action:'experiment',experiment:{schemaVersion:1,
    before:{...measures(1),pages:[page(1,true)]},after:{...measures(2),pages:[page(2,true)]},
    regressionBefore:scenarios(1,true),regressionAfter:scenarios(2,true)}});
  const candidateHash=session.active.sourceHash;
  const trial=session.history.at(-1);
  stage('experiment-verdict',{outcome:trial.outcome,error:trial.error,details:trial.verification?.gain?.groups});
  assert.equal(trial.outcome,'promising',JSON.stringify(trial.verification??trial.error));
  assert.equal(session.status,'formal-validation-required');
  assert.equal(trial.verification.acceptancePolicy,policy);
  assert.deepEqual(trial.verification.goal,goal);
  assert.equal(trial.verification.gain.scoreDiagnosticOnly,true);
  assert.equal(session.counts.attempted,6);
  const formal={schemaVersion:1,action:'verify',project:projects[2],plan:session.active.plan,reviewedPlanHash:session.active.planHash,
    before:artifact('formal-baseline'),measurement:{...measures(2),budget:{maxAttempts:9,maxWallTimeMs:1800000}},scenarios:scenarios(2),
    patchEvidence:session.active.patchEvidence,goal,acceptancePolicy:policy,rollbackOnFailure:true};
  const budgetProbe={...formal,patchEvidence:undefined,measurement:{...formal.measurement,budget:{maxAttempts:10,maxWallTimeMs:1800000}}};
  const preflight=await command(3,'validate-config','--command','optimize','--config',await save('low-budget-preflight.json',budgetProbe));
  const {explorationAttempts,formalAttempts,totalAttempts} = preflight.samplingBudget;
  assert.equal(preflight.status,'insufficient-budget');
  assert.deepEqual({explorationAttempts,formalAttempts,totalAttempts},{explorationAttempts:6,formalAttempts:10,totalAttempts:16});
  const low = await runOptimization({config:formal,output:artifact('low-budget-execution'),dependencies:{
    measureSite:()=>assert.fail('Budget block must happen before navigation'),
  }});
  assert.equal(low.measurementStarted,false);
  assert.equal(low.error?.code,'OPTIMIZATION_BUDGET',JSON.stringify(low.error));
  assert.equal(low.budget.counts.attempted,0);
  assert.equal(low.samplingBudget.missingAttempts,1);
  assert.equal(low.artifacts['standards-preflight.json'],undefined);
  assert.equal((await sourceSnapshot(projects[2])).hash,candidateHash);
  stage('formal-evidence');
  const next={...config,profile:{...config.profile,expectedSourceHash:candidateHash}};
  const candidateMain=await profile(next,artifact('candidate-runtime-campaign'));
  const candidateGuard=await profile({...next,url:page(2,false).url},artifact('candidate-runtime-home'));
  const afterCheck=await checkThemeProject({project:projects[2]});
  const verification=verificationPlan({beforeFiles:beforeCheck.sourceManifest,afterFiles:afterCheck.sourceManifest});
  const captures=[];
  const browser=await chromium.launch({executablePath:executable,headless:true});
  try {
    for(const width of verification.widths){
      const context=await browser.newContext({viewport:{width,height:850}});
      for(const target of pages(2)){
        const candidatePage=await context.newPage();
        await candidatePage.goto(target.url);
        await candidatePage.locator('button').focus();
        assert.equal(await candidatePage.locator('button').evaluate(el=>document.activeElement===el),true);
        await candidatePage.keyboard.press('Enter');
        assert.equal(await candidatePage.locator('output').textContent(),'Ready');
        assert.ok(await candidatePage.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
        if(target.id==='campaign'){
          const selector=width<750?'#hero-mobile':'#hero-desktop';
          assert.equal(await candidatePage.locator(selector).evaluate(async el=>{await el.decode();return el.naturalWidth>0;}),true);
          assert.equal(await candidatePage.locator(width<750?'#hero-desktop':'#hero-mobile').isVisible(),false);
        }
        const baselinePage=await context.newPage();
        await baselinePage.goto(target.url.replace('preview_theme_id=2','preview_theme_id=1'));
        await baselinePage.locator('button').focus();
        await baselinePage.keyboard.press('Enter');
        if(target.id==='campaign') {
          const selector=width<750?'#hero-mobile':'#hero-desktop';
          await baselinePage.locator(selector).evaluate(el=>el.decode());
        }
        const visible=async p=>p.locator('main').evaluate(el=>({text:el.innerText,rect:el.getBoundingClientRect().toJSON(),images:[...el.querySelectorAll('img')].filter(n=>n.getBoundingClientRect().width).map(n=>({alt:n.alt,src:n.currentSrc,rect:n.getBoundingClientRect().toJSON()}))}));
        const before=await visible(baselinePage),after=await visible(candidatePage);
        assert.deepEqual(after,before);
        captures.push({page:target.id,width,after});
      }
      await context.close();
    }
  }finally{await browser.close();}
  const observations=await save('real-dom-review.json',captures);
  const applicability={
    'component-isolation':'Fixture serves only the single campaign component and shared shell, with no neighboring theme sections or scoped CSS under test.',
    'multi-instance':'Fixture campaign has one fixed template instance; the reviewed loading attribute has no shared-instance initialization.',
    'editor-lifecycle':'Fixture HTTP server has no Shopify editor, and the changed HTML loading attribute has no editor lifecycle code.',
  };
  formal.integrityProfiles={before:[baselineMain,baselineGuard],after:[candidateMain,candidateGuard]};
  formal.standardsEvidence={themeCheck:{before:await evidenceRef('theme-check-before.json',beforeCheck),after:await evidenceRef('theme-check-after.json',afterCheck)},
    scope:{pages:pages(2).map(p=>p.url)},checks:[]};
  const mobileWarning = finding=>finding.ruleId==='RemoteAsset' && finding.evidence.sourceLine?.includes('hero-mobile');
  const changedWarning = afterCheck.findings.find(mobileWarning);
  if (changedWarning) {
    const originalWarning = beforeCheck.findings.find(mobileWarning);
    assert.ok(originalWarning,'An actual new Theme Check warning needs review');
    assert.equal(changedWarning.evidence.sourceLine,originalWarning.evidence.sourceLine.replace('loading="lazy"','loading="eager"'));
    assert.equal(changedWarning.evidence.original.start_column,originalWarning.evidence.original.start_column);
    assert.equal(changedWarning.evidence.original.end_column,originalWarning.evidence.original.end_column);
    formal.standardsEvidence.themeCheck.warningReviews=[{fingerprint:changedWarning.fingerprint,reviewer:'Isolated fixture browser reviewer',
      reason:'The pre-existing RemoteAsset warning points to the same local fixture image src. The only source-line change is loading lazy to eager.'}];
  }
  for(const finding of verification.checks.filter(c=>c.blocking)){
    const reason=applicability[finding.id];
    const observation={schemaVersion:1,kind:'standards-check-observation',checkId:finding.id,sourceHash:candidateHash,evidenceLevel:finding.evidenceLevel,
      status:reason?'N/A':'PASS',reviewer:'Isolated fixture browser reviewer',observedAt:new Date().toISOString(),
      observation:'See rendered asset, keyboard and geometry assertions in '+observations,
      ...(reason?{reason}:{conditions:{pages:pages(2).map(p=>p.url),widths:verification.widths}})};
    formal.standardsEvidence.checks.push({id:finding.id,...await evidenceRef('observation-'+finding.id+'.json',observation)});
  }
  stage('formal-collection-without-review');
  await step({action:'collect',formal:{measurement:measures(2),scenarios:formal.scenarios,integrityProfiles:formal.integrityProfiles,standardsEvidence:formal.standardsEvidence}},
    {collectOptimizationEvidence:args=>collectOptimizationEvidence({...args,dependencies:{measureSite:measure,verifyDeployment:verify}})});
  const pending=await readJSON(session.verification);
  assert.equal(session.status,'formal-validation-required');
  assert.equal(pending.outcome,'not-accepted');
  assert.deepEqual(pending.checks.filter(c=>!c.pass).map(c=>c.id),['content-and-visual-review'],JSON.stringify(pending.checks.filter(c=>!c.pass)));
  const used=session.counts.attempted,after=session.active.formalAfter;
  assert.equal((await sourceSnapshot(projects[2])).hash,candidateHash);
  const regression=path.join(session.active.formalCollection,'regression-evidence.json');
  const review={sourceHash:candidateHash,contentPreserved:true,visualsPreserved:true,summary:'Compared campaign and guard pages at all five required widths, including image source, alt, bounding boxes, keyboard activation and output. '+observations};
  const replay={before:artifact('formal-baseline'),after,regression:await readJSON(regression),review,expectedSourceHash:candidateHash,
    goal:{...goal,requiredGroups:[{pageId:'home',device:'mobile'}]},acceptancePolicy:policy,standardsEvidence:formal.standardsEvidence};
  const guardDecision=await verifyOptimization(replay);
  assert.equal(guardDecision.outcome,'not-accepted');
  assert.deepEqual(guardDecision.checks.filter(c=>!c.pass).map(c=>c.id),['declared-goal-gain-no-metric-regression']);
  assert.equal(guardDecision.gain.outcome,'no-measurable-gain',JSON.stringify(guardDecision.gain.groups));
  await save('flat-target-rejected.json',guardDecision);
  await step({action:'verify',verification:{after,regression,review,standardsEvidence:formal.standardsEvidence}});
  assert.equal(session.status,'optimization-accepted');
  assert.equal(session.counts.attempted,used);
  const verdict=await readJSON(session.verification);
  const formalRun = await readJSON(path.join(after,'run.json'));
  assert.equal(formalRun.config.throttlingMethod,'devtools');
  assert.equal(baseline.counts.succeeded,10);
  assert.equal(formalRun.counts.succeeded,10);
  assert.equal(verdict.acceptancePolicy.id,policy);
  assert.equal(verdict.patchExperiment.acceptancePolicy,policy);
  assert.deepEqual(verdict.goal,goal);
  assert.ok(verdict.checks.every(c=>c.pass));
  const summary={status:'passed',result:'optimization-accepted',scope:'isolated-loopback-fixture',root,
    formalSamplesBefore:baseline.counts.succeeded,formalSamplesAfter:formalRun.counts.succeeded,experimentSamples:used-formalRun.counts.attempted,
    preflight:preflight.samplingBudget, extraSamplesAfterReview:session.counts.attempted-used,
    budgetBlocked:low.samplingBudget,negativeControl:guardDecision.outcome,verifiedGroups:verdict.gain.groups.map(g=>({pageId:g.pageId,device:g.device,
      lcpBefore:g.metrics.lcp.before.median,lcpAfter:g.metrics.lcp.after.median,gain:g.metrics.lcp.gain,required:g.requiredImprovement})),
    reusedFormalAfter:after,session:path.join(session.output,'session.json'),themeCheckVersion:afterCheck.metadata.toolVersion};
  await save('summary.json',summary);
  stage('complete',summary);
} catch (error) {
  await save('failure.json',{status:'failed',stage:currentStage,error:error.message,session:session?.output});
  throw error;
} finally {
  server.closeAllConnections();
  await new Promise(r=>server.close(r));
}
