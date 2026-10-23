import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import {mkdtemp,mkdir,writeFile,readFile,rm,cp} from 'node:fs/promises';
import {Liquid} from 'liquidjs';
import {chromium} from 'playwright-core';
import {browserExecutable} from '../lib/runtime-profile.mjs';
import {profileDomain} from '../lib/domain-profile.mjs';
import {verifyDeployment} from '../lib/deployment.mjs';
import {diagnoseUnified} from '../lib/decision-engine.mjs';
import {createDomainPlan} from '../lib/domain-plan.mjs';
import {applySitePlan,rollbackSitePlan} from '../lib/site-changes.mjs';
import {extendedContracts} from '../lib/extended-methods.mjs';
import {runScenarios} from '../lib/scenarios.mjs';
import {checkExtendedBehavior} from '../lib/optimization-regression.mjs';
import {verifyPreservation} from '../lib/preservation.mjs';
const enabled=process.env.PERF_KIT_BROWSER_TESTS==='1';
const review=method=>({summary:'Isolated local fixture with reviewed equivalent content and consumer',...Object.fromEntries(extendedContracts[method].review.map(k=>[k,true]))});
const body=Array.from({length:320},(_,i)=>`<p>Filter choice ${i}</p>`).join('');
const hidden=`<details id="filters"><summary>Filters</summary><div id="filter-body">${body}</div></details>`;
const loader='async function load(){const html=await (await fetch(location.pathname+location.search+"&data=1")).text();document.querySelector("#hero").innerHTML=new DOMParser().parseFromString(html,"text/html").querySelector("#hero").innerHTML;}\nload();';
async function fixture(t,kind){
  const root=await mkdtemp('/private/tmp/perfkit-extended-browser-'),project=path.join(root,'theme'),engine=new Liquid();
  await mkdir(path.join(project,'assets'),{recursive:true});await mkdir(path.join(project,'sections'));
  engine.registerFilter('asset_url',name=>'/assets/'+name);
  await writeFile(path.join(project,'sections/main.liquid'),kind==='hidden'?hidden:'<div id="shopify-section-template--123__main"><div id="hero"></div></div><script src="/assets/main.js" defer></script>');
  if(kind==='section')await writeFile(path.join(project,'assets/main.js'),loader);
  let failure=null;const requests=[];
  const server=http.createServer(async(req,res)=>{
    try{
      const u=new URL(req.url,'http://fixture.test');requests.push(req.url);res.setHeader('cache-control','no-store');
      if(u.pathname.startsWith('/assets/')){res.setHeader('content-type','text/javascript');res.end(await readFile(path.join(project,u.pathname.slice(1)),'utf8'));return;}
      const id='template--123__main',section=`<div id="shopify-section-${id}"><div id="hero"><h1 style="font-size:54px">The complete section content is ready</h1></div></div>`;
      if(u.searchParams.has('data')){
        const scoped=u.searchParams.has('section_id')||u.searchParams.has('sections');
        await new Promise(r=>setTimeout(r,scoped?60:550));
        if(scoped&&failure==='500'){res.writeHead(500);res.end('Unavailable');return;}
        if(scoped&&failure==='timeout')await new Promise(r=>setTimeout(r,5100));
        const html=failure==='invalid'&&scoped?'<div>Wrong section</div>':section;
        if(u.searchParams.has('sections')){res.setHeader('content-type','application/json');res.end(JSON.stringify({[id]:failure==='null'?null:html}));}
        else{res.setHeader('content-type','text/html');res.end(scoped?html:'<!doctype html><html><body>'+html+'<!--'+'unused full page '.repeat(10000)+'--></body></html>');}return;
      }
      res.setHeader('content-type','text/html');res.end('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><script>window.Shopify={theme:{id:1},shop:"fixture.myshopify.com"};new PerformanceObserver(l=>{for(const e of l.getEntries())window.fixtureLCP=e.startTime}).observe({type:"largest-contentful-paint",buffered:true});</script></head><body>'+await engine.parseAndRender(await readFile(path.join(project,'sections/main.liquid'),'utf8'))+'</body></html>');
    }catch(error){res.writeHead(500);res.end(error.message);}
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const url=`http://127.0.0.1:${server.address().port}/fr/collections/all?preview_theme_id=1&sort_by=title-ascending`;
  t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));await rm(root,{recursive:true,force:true});});let index=0;
  const capture=()=>profileDomain({config:{schemaVersion:1,mode:'runtime',deployment:{project,store:'fixture.myshopify.com',themeId:'1'},url,profile:{device:'mobile',settleMs:850}},output:path.join(root,'profile-'+index++),dependencies:{verifyDeployment:args=>verifyDeployment({...args,dependencies:{runProcess:async(_cmd,argv)=>{await cp(project,argv[argv.indexOf('--path')+1],{recursive:true});return{code:0};}}})}});
  const scenarios=steps=>runScenarios({config:{schemaVersion:1,project,url,expectedThemeId:'1',timeoutMs:7000,runTimeoutMs:20000,settleMs:800,viewports:[{name:'mobile',width:390,height:844}],scenarios:[{name:kind,steps}]},output:path.join(root,'scenarios-'+index++)});
  return{root,project,url,capture,scenarios,requests,setFailure:value=>{failure=value;}};
}
const hiddenSteps=[
  {action:'click',selector:'#filters > summary'},{action:'assert-visible',selector:'#filter-body',visible:true},{action:'assert-count',selector:'#filter-body > p',count:320},{action:'checkpoint',selector:'#filter-body',key:'first-open'},
  {action:'click',selector:'#filters > summary'},{action:'assert-visible',selector:'#filter-body',visible:false},
  {action:'press',selector:'#filters > summary',key:'Enter'},{action:'assert-visible',selector:'#filter-body',visible:true},
  {action:'assert-count',selector:'#filter-body > p',count:320},{action:'checkpoint',selector:'#filter-body',key:'opened'},
];

test('real Chrome: hidden DOM generator maps actual disclosure and preserves first open, keyboard, editor reload and no-JS', {skip:!enabled,timeout:120000},async t=>{
  const f=await fixture(t,'hidden'),profile=await f.capture(),d=await diagnoseUnified({project:f.project,profiles:[profile]}),c=d.candidates.find(c=>c.kind==='hidden-dom');
  assert.ok(c,JSON.stringify({targets:profile.domainTargets,errors:profile.errors}));
  const baseline=await f.scenarios(hiddenSteps);assert.equal(baseline.outcome,'passed');
  const browser=await chromium.launch({executablePath:await browserExecutable(),headless:true});t.after(()=>browser.close());
  for(const method of c.methods){
    const plan=await createDomainPlan({project:f.project,diagnosis:d,config:{schemaVersion:1,candidateId:c.candidateId,method,newAsset:'assets/hidden.js',review:review(method)}});
    await applySitePlan(plan,f.project);
    const page=await browser.newPage();await page.goto(f.url);assert.equal(await page.locator('#filter-body > p').count(),0);assert.equal(await page.locator('template').count(),method==='hidden-detach'?0:1);
    const after=await f.scenarios(hiddenSteps);assert.equal(after.outcome,'passed',JSON.stringify(after.runs));assert.equal(checkExtendedBehavior(plan,baseline),true);assert.equal(checkExtendedBehavior(plan,after,{candidate:true}),true);
    const preserved=verifyPreservation({before:baseline,after,beforeSourceHash:baseline.sourceHash,afterSourceHash:after.sourceHash});assert.equal(preserved.outcome,'preserved',JSON.stringify(preserved));
    const markup=method==='hidden-detach'?hidden:await page.locator('#filters').evaluate(el=>el.outerHTML);
    await page.evaluate(markup=>{document.querySelector('#filters').outerHTML=markup;document.dispatchEvent(new CustomEvent('shopify:section:load'));},markup);
    await page.locator('summary').press('Space');await page.waitForFunction(()=>document.querySelectorAll('#filter-body > p').length===320);assert.equal(await page.locator('template').count(),0);
    if(method==='hidden-detach'){
      await page.evaluate(()=>{window.savedNode=document.querySelector('#filter-body > p');window.savedNode.textContent='Retained state';document.querySelector('#filters').open=false;document.dispatchEvent(new CustomEvent('shopify:section:load'));});
      await page.locator('summary').press('Enter');
      assert.equal(await page.evaluate(()=>document.querySelector('#filter-body > p')===window.savedNode&&window.savedNode.textContent==='Retained state'),true);
      // Reload the actual server markup as the theme editor does; duplicate bootstrap is idempotent.
      await page.evaluate(markup=>{document.querySelector('#filters').outerHTML=markup;document.dispatchEvent(new CustomEvent('shopify:section:load'));document.dispatchEvent(new CustomEvent('shopify:section:load'));},hidden);
      assert.equal(await page.locator('#filter-body > p').count(),0);await page.locator('summary').click();assert.equal(await page.locator('#filter-body > p').count(),320);
    }
    if(method==='hidden-template-chunked'){
      await page.addInitScript(()=>{
        const yieldOnce=()=>{
          if(!window.fixtureInterrupted){
            window.fixtureInterrupted=true;const details=document.getElementById('filters');details.remove();
            setTimeout(()=>{document.body.append(details);document.dispatchEvent(new CustomEvent('shopify:section:load'));},80);
          }
          return Promise.resolve();
        };
        Object.defineProperty(globalThis,'scheduler',{value:{yield:yieldOnce},configurable:true});
      });
      await page.goto(f.url);await page.locator('summary').click();await page.waitForFunction(()=>document.querySelectorAll('#filter-body > p').length===320);
      assert.equal(await page.locator('template').count(),0);assert.equal(await page.locator('#filter-body > p').count(),320);
    }
    await page.close();
    const context=await browser.newContext({javaScriptEnabled:false}),nojs=await context.newPage();await nojs.goto(f.url);await nojs.locator('summary').click();assert.equal(await nojs.locator(method==='hidden-detach'?'#filter-body > p':'#filter-body p').count(),320);assert.equal(await nojs.locator('#filter-body').isVisible(),true);await context.close();
    await rollbackSitePlan(plan,f.project);
  }
  t.diagnostic('Local fixture: 320 content nodes moved out of initial active DOM; complete opened content/layout preserved for all methods. This is not a measured score gain.');
});

test('real Chrome: actual fetch initiator binds generated Section API code, reduces response bytes and LCP with preserved content', {skip:!enabled,timeout:120000},async t=>{
  const f=await fixture(t,'section'),profile=await f.capture(),d=await diagnoseUnified({project:f.project,profiles:[profile]}),c=d.candidates.find(c=>c.kind==='section-fetch');
  assert.ok(c,JSON.stringify({sections:profile.sections,resources:profile.resources,errors:profile.errors}));
  const steps=[{action:'assert-text',selector:'#hero',text:'The complete section content is ready'},{action:'checkpoint',selector:'#hero',key:'hero'}],before=await f.scenarios(steps);
  const browser=await chromium.launch({executablePath:await browserExecutable(),headless:true});t.after(()=>browser.close());
  const sample=async()=>{const context=await browser.newContext({viewport:{width:390,height:844}}),page=await context.newPage();await page.goto(f.url);await page.waitForFunction(()=>document.querySelector('#hero h1'));await page.waitForTimeout(120);const metrics=await page.evaluate(()=>({lcp:window.fixtureLCP,bytes:performance.getEntriesByType('resource').filter(e=>e.initiatorType==='fetch').reduce((n,e)=>n+e.encodedBodySize,0)}));await context.close();return metrics;};
  for(const method of c.methods){
    const plan=await createDomainPlan({project:f.project,diagnosis:d,config:{schemaVersion:1,candidateId:c.candidateId,method,sectionSelector:'#hero',review:review(method)}}),pairs=[];
    for(let i=0;i<3;i++){
      if(i%2===0){const left=await sample();await applySitePlan(plan,f.project);pairs.push({before:left,after:await sample()});await rollbackSitePlan(plan,f.project);}
      else{await applySitePlan(plan,f.project);const right=await sample();await rollbackSitePlan(plan,f.project);pairs.push({before:await sample(),after:right});}
    }
    const median=ns=>ns.sort((a,b)=>a-b)[1];assert.ok(median(pairs.map(p=>p.before.lcp))-median(pairs.map(p=>p.after.lcp))>250,JSON.stringify(pairs));assert.ok(pairs.every(p=>p.after.bytes<p.before.bytes/10));
    await applySitePlan(plan,f.project);const after=await f.scenarios(steps);assert.equal(after.outcome,'passed');assert.equal(checkExtendedBehavior(plan,before),true);assert.equal(checkExtendedBehavior(plan,after,{candidate:true}),true,JSON.stringify(after.runs));assert.equal(verifyPreservation({before,after,beforeSourceHash:before.sourceHash,afterSourceHash:after.sourceHash}).outcome,'preserved');
    assert.ok(after.runs[0].fetchResources.every(r=>new URL(r.url).pathname==='/fr/collections/all'&&new URL(r.url).searchParams.get('sort_by')==='title-ascending'));
    await rollbackSitePlan(plan,f.project);t.diagnostic(method+' local delayed-response fixture pairs: '+JSON.stringify(pairs));
  }
});

test('real Chrome: Section API null, HTTP error, wrong section and timeout fall back, but do not count as optimization evidence', {skip:!enabled,timeout:120000},async t=>{
  const f=await fixture(t,'section'),profile=await f.capture(),d=await diagnoseUnified({project:f.project,profiles:[profile]}),c=d.candidates.find(c=>c.kind==='section-fetch');assert.ok(c);
  const plan=await createDomainPlan({project:f.project,diagnosis:d,config:{schemaVersion:1,candidateId:c.candidateId,method:'section-fetch-json',sectionSelector:'#hero',review:review('section-fetch-json')}});await applySitePlan(plan,f.project);
  for(const mode of ['null','500','invalid','timeout']){
    f.setFailure(mode);const result=await f.scenarios([{action:'assert-text',selector:'#hero',text:'The complete section content is ready'},{action:'checkpoint',selector:'#hero',key:'hero'}]);
    assert.equal(result.outcome,'passed',JSON.stringify(result.runs));assert.equal(checkExtendedBehavior(plan,result,{candidate:true}),false,mode);
    assert.ok(result.runs[0].fetchResources.some(r=>!new URL(r.url).searchParams.has('sections')));
  }
});
