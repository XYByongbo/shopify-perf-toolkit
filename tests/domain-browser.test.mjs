import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import {mkdtemp,mkdir,writeFile,readFile,rm,cp} from 'node:fs/promises';
import {profileDomain} from '../lib/domain-profile.mjs';
import {verifyDeployment} from '../lib/deployment.mjs';
import {diagnoseUnified} from '../lib/decision-engine.mjs';
import {createDomainPlan} from '../lib/domain-plan.mjs';
import {applySitePlan,rollbackSitePlan} from '../lib/site-changes.mjs';
import {runScenarios} from '../lib/scenarios.mjs';
import {runPatchExperiment} from '../lib/patch-experiment.mjs';
import {fixturePNG} from './helpers/fixture-image.mjs';
import {checkAppBehavior,checkAppDeployment,checkScenarioDeployment} from '../lib/optimization-regression.mjs';
import {sourceSnapshot} from '../lib/runtime-profile.mjs';
const enabled=process.env.PERF_KIT_BROWSER_TESTS==='1';

async function fixture(t) {
  const root=await mkdtemp('/private/tmp/perfkit-domain-browser-'),project=path.join(root,'theme');
  await mkdir(path.join(project,'sections'),{recursive:true});await mkdir(path.join(project,'assets'));
  let appSuffix='',baselineProject=null;
  const server=http.createServer(async(req,res)=>{
    try {
      res.setHeader('Cache-Control','no-store');
      if(req.url.startsWith('/hero.png')){await new Promise(r=>setTimeout(r,850));res.setHeader('Content-Type','image/png');res.end(fixturePNG());return;}
      if(req.url.startsWith('/app.js')){await new Promise(r=>setTimeout(r,500));res.setHeader('Content-Type','text/javascript');res.end('document.addEventListener("DOMContentLoaded",()=>{document.querySelector("#open").addEventListener("click",()=>document.querySelector("#reviews").textContent="Ready");});'+appSuffix);return;}
      if(req.url.startsWith('/space.js')){res.setHeader('Content-Type','text/javascript');res.end('setTimeout(()=>{document.querySelector("#reviews").innerHTML=`<div style="height:${matchMedia("(max-width:749px)").matches?220:140}px">Reviews</div>`;},350);');return;}
      const themeId=new URL(req.url,'http://fixture.test').searchParams.get('preview_theme_id')==='2'?'2':'1';
      const rendered=themeId==='1'&&baselineProject?baselineProject:project;
      res.setHeader('Content-Type','text/html');res.end('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><script>window.Shopify={theme:{id:'+themeId+'},shop:"fixture.myshopify.com"};</script><style>body{margin:0}img{width:100%;height:auto;display:block}</style></head><body>'+await readFile(path.join(rendered,'sections/main.liquid'),'utf8')+'</body></html>');
    }catch{res.writeHead(500);res.end();}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const url=`http://127.0.0.1:${server.address().port}/?preview_theme_id=1`;
  t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));await rm(root,{recursive:true,force:true});});
  let i=0;
  const capture=async(device='mobile',bindings=[])=>profileDomain({config:{schemaVersion:1,mode:'runtime',deployment:{project,store:'fixture.myshopify.com',themeId:'1'},url,bindings,profile:{device,settleMs:1200}},output:path.join(root,`capture-${i++}`),dependencies:{verifyDeployment:args=>verifyDeployment({...args,dependencies:{runProcess:async(_cmd,args)=>{await cp(project,args[args.indexOf('--path')+1],{recursive:true});return {code:0};}}})}});
  return {root,project,url,capture,setBaseline:value=>{baselineProject=value;},changeApp:suffix=>{appSuffix=suffix;},write:text=>writeFile(path.join(project,'sections/main.liquid'),text)};
}

test('real browser: deployment-bound image LCP and CLS map to generated source patches', {skip:!enabled},async t=>{
  const f=await fixture(t);
  await f.write('<h1>Example</h1><img id="hero" src="/hero.png" loading="lazy" alt="Example"><p>Unchanged content below image</p>');
  const before=await f.capture(),d=await diagnoseUnified({project:f.project,profiles:[before]});
  const lcp=d.candidates.find(c=>c.kind==='image-lcp'),cls=d.candidates.find(c=>c.kind==='image-cls');
  assert.ok(lcp,JSON.stringify({targets:before.domainTargets,lcp:before.initial.lcp}));
  assert.ok(cls,JSON.stringify({shifts:before.initial.shifts,resizes:before.initial.resizes}));
  const loading=await createDomainPlan({project:f.project,diagnosis:d,config:{schemaVersion:1,candidateId:lcp.candidateId,method:'image-priority',review:{summary:'Fixture hero is the only image',sharedInstancesReviewed:true}}});
  await applySitePlan(loading,f.project);const eager=await f.capture();assert.equal(eager.domainTargets[0].attrs.loading,'eager');assert.equal(eager.domainTargets[0].attrs.fetchpriority,'high');await rollbackSitePlan(loading,f.project);
  const dimensions=await createDomainPlan({project:f.project,diagnosis:d,config:{schemaVersion:1,candidateId:cls.candidateId,method:'image-dimensions',review:{summary:'Single fixed-ratio fixture image',sharedInstancesReviewed:true,responsiveRatioReviewed:true}}});
  await applySitePlan(dimensions,f.project);const stable=await f.capture();
  assert.ok(before.initial.shifts.reduce((s,x)=>s+x.value,0)>0);assert.equal(stable.initial.shifts.reduce((s,x)=>s+x.value,0),0);
});

test('real browser: external loader remains loaded and its first interaction works after defer', {skip:!enabled},async t=>{
  const f=await fixture(t),script=new URL('/app.js',f.url).href;
  await f.write(`<script src="${script}"></script><button id="open">Open reviews</button><output id="reviews">Closed</output>`);
  const p=await f.capture(),owners=[{id:'reviews',name:'Fixture app',host:'127.0.0.1',pathPrefix:'/app.js',purpose:'Reviews',evidence:'Local fixture owned script'}];
  const d=await diagnoseUnified({project:f.project,profiles:[p],owners}),c=d.candidates.find(c=>c.kind==='app-loader');assert.ok(c);
  const plan=await createDomainPlan({project:f.project,diagnosis:d,config:{schemaVersion:1,candidateId:c.candidateId,method:'app-defer',review:{summary:'Fixture attaches after DOMContentLoaded and has no document.write or consent dependency',dependenciesReviewed:true,nonCritical:true,documentWriteAbsent:true,businessEventsReviewed:true,businessAssertions:['#reviews']}}});
  await applySitePlan(plan,f.project);
  const pre=await f.capture();
  const regressionConfig={schemaVersion:1,project:f.project,url:f.url,expectedThemeId:'1',viewports:[{name:'mobile',width:390,height:844}],scenarios:[{name:'reviews',steps:[{action:'click',selector:'#open'},{action:'assert-text',selector:'#reviews',text:'Ready'},{action:'checkpoint',selector:'body',key:'reviews'}]}]};
  const regression=await runScenarios({config:regressionConfig,output:path.join(f.root,'regression')});
  const post=await f.capture(),identity={project:f.project,store:'fixture.myshopify.com',themeId:'1',sourceHash:post.snapshot.hash};
  assert.equal(checkScenarioDeployment(regression,identity,{before:pre.domainProof.after,after:post.domainProof.before}),true);
  assert.equal(checkScenarioDeployment(regression,identity,{before:post.domainProof.before,after:post.domainProof.after}),false);
  assert.equal(checkAppBehavior(plan,regression),true);
  assert.equal(checkAppDeployment(plan,[pre.domainProof.after,post.domainProof.before]),true);
  const changed=structuredClone(post.domainProof.before);changed.pages[0].assets.find(a=>a.url===script).bodyHash='0'.repeat(64);
  assert.equal(checkAppDeployment(plan,[pre.domainProof.after,changed]),false);
  f.changeApp('/* remote app updated independently of theme */');
  const drift=await runScenarios({config:regressionConfig,output:path.join(f.root,'drift')});
  assert.equal(drift.outcome,'passed');assert.equal(checkAppBehavior(plan,drift),false);
  f.changeApp('');
  await f.write((await readFile(path.join(f.project,'sections/main.liquid'),'utf8')).replace('>Closed</output>','>Ready</output>'));
  const inert=await runScenarios({config:regressionConfig,output:path.join(f.root,'inert')});
  assert.equal(inert.outcome,'passed');assert.equal(checkAppBehavior(plan,inert),false);
  assert.equal(regression.outcome,'passed',JSON.stringify(regression));assert.ok(regression.runs[0].scriptResources.some(s=>s.url===script&&s.finished&&s.status===200));
});

test('real browser: image-ready assertion waits for pixels and rejects a broken image', {skip:!enabled},async t=>{
  const f=await fixture(t);
  const config={schemaVersion:1,url:f.url,timeoutMs:1500,viewports:[{name:'mobile',width:390,height:844}],scenarios:[{name:'image',steps:[{action:'assert-image-loaded',selector:'#hero'}]}]};
  await f.write('<img id="hero" src="/hero.png">');
  const ready=await runScenarios({config,output:path.join(f.root,'ready')});assert.equal(ready.outcome,'passed');assert.ok(ready.runs[0].steps[0].elapsedMs>500);
  await f.write('<img id="hero" src="/broken.png">');
  const broken=await runScenarios({config,output:path.join(f.root,'broken')});assert.notEqual(broken.outcome,'passed');assert.equal(broken.runs[0].steps[0].outcome,'failed');
});

test('real browser: reviewed unique selector binds a hero without an id', {skip:!enabled},async t=>{
  const f=await fixture(t);await f.write('<img class="hero" src="/hero.png" loading="lazy"><p>After</p>');
  const snapshot=await sourceSnapshot(f.project),file=snapshot.files.find(x=>x.file==='sections/main.liquid');
  const profile=await f.capture('mobile',[{file:file.file,sourceHash:file.sourceHash,offset:0,selector:'.hero',review:'The fixture has one hero at parser offset zero'}]);
  const d=await diagnoseUnified({project:f.project,profiles:[profile]});assert.ok(d.candidates.some(c=>c.kind==='image-lcp'));
  assert.deepEqual(profile.domainTargets.find(t=>t.tag==='IMG').reviewedSelectors,['.hero']);
});

test('real browser: app space patch uses both breakpoints and removes injection shift', {skip:!enabled},async t=>{
  const f=await fixture(t);await f.write('<div id="reviews" data-app-container="reviews"></div><p style="height:400px">Unchanged content</p><script src="/space.js" defer></script>');
  const profiles=[await f.capture('mobile'),await f.capture('desktop')];
  const diagnosis=await diagnoseUnified({project:f.project,profiles}),c=diagnosis.candidates.find(c=>c.kind==='app-space');assert.ok(c);
  const plan=await createDomainPlan({project:f.project,diagnosis,profiles,config:{schemaVersion:1,candidateId:c.candidateId,method:'app-reserve-space',breakpoint:750,
    review:{summary:'Fixture widget has fixed 220/140 pixel heights at its existing breakpoint',allStatesReviewed:true,contentSizeStable:true,responsiveGeometryReviewed:true}}});
  await applySitePlan(plan,f.project);const stable=await f.capture(c.device),before=profiles.find(p=>p.config.device===c.device);
  assert.ok(before.initial.shifts.reduce((s,x)=>s+x.value,0)>0);assert.equal(stable.initial.shifts.reduce((s,x)=>s+x.value,0),0);
});


test('real browser: a source-bound app interaction failure rejects the method before Lighthouse', {skip:!enabled},async t=>{
  const f=await fixture(t),script=new URL('/app.js',f.url).href;
  await f.write(`<script src="${script}"></script><button id="open">Open reviews</button><output id="reviews">Closed</output>`);
  const profile=await f.capture(),owners=[{id:'reviews',name:'Fixture app',host:'127.0.0.1',pathPrefix:'/app.js',purpose:'Reviews',evidence:'Local controlled script'}];
  const diagnosis=await diagnoseUnified({project:f.project,profiles:[profile],owners}),c=diagnosis.candidates.find(c=>c.kind==='app-loader');assert.ok(c);
  // Deliberately incorrect independence review is a negative control: runtime must reject it.
  const plan=await createDomainPlan({project:f.project,diagnosis,config:{schemaVersion:1,candidateId:c.candidateId,method:'app-async',review:{summary:'Intentionally invalid review for negative-control test',dependenciesReviewed:true,nonCritical:true,documentWriteAbsent:true,businessEventsReviewed:true,independentExecutionReviewed:true,businessAssertions:['#reviews']}}});
  const baseline=path.join(f.root,'baseline');await cp(f.project,baseline,{recursive:true});f.setBaseline(baseline);await applySitePlan(plan,f.project);
  const candidateUrl=new URL(f.url);candidateUrl.searchParams.set('preview_theme_id','2');
  const side=(project,themeId,url)=>({schemaVersion:1,engine:'lighthouse',pages:[{id:'home',url}],devices:['mobile'],deployment:{project,themeId,store:'fixture.myshopify.com'}});
  const regression=url=>({schemaVersion:1,url,timeoutMs:1000,viewports:[{name:'mobile',width:390,height:844}],scenarios:[{name:'reviews',steps:[{action:'click',selector:'#open'},{action:'assert-text',selector:'#reviews',text:'Ready'},{action:'checkpoint',selector:'body',key:'reviews'}]}]});
  const result=await runPatchExperiment({config:{schemaVersion:1,plan,diagnosis,candidateId:c.candidateId,
    before:side(baseline,'1',f.url),after:side(f.project,'2',candidateUrl.href),regressionBefore:regression(f.url),regressionAfter:regression(candidateUrl.href)},output:path.join(f.root,'experiment'),dependencies:{
    verifyDeployment:args=>verifyDeployment({...args,dependencies:{runProcess:async(_cmd,argv)=>{await cp(args.config.project,argv[argv.indexOf('--path')+1],{recursive:true});return{code:0};}}}),
    measureSite:async()=>{throw new Error('Lighthouse must not run for broken app behavior');},
  }});
  assert.equal(result.status,'functional-regressed',JSON.stringify(result));assert.equal(result.counts.attempted,0);
  const failed=JSON.parse(await readFile(path.join(result.output,'regression-after/scenario-results.json'),'utf8'));
  assert.equal(failed.runs[0].steps[1].error.code,'ASSERTION_FAILED');
});
