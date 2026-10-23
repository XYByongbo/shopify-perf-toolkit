import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {mkdtemp,cp,readFile,rm} from 'node:fs/promises';
import {chromium} from 'playwright-core';
import {browserExecutable} from '../lib/runtime-profile.mjs';
import {profileDomain} from '../lib/domain-profile.mjs';
import {diagnoseUnified} from '../lib/decision-engine.mjs';
import {createDomainPlan} from '../lib/domain-plan.mjs';
import {createOfficialPlan} from '../lib/official-plan.mjs';
import {applySitePlan} from '../lib/site-changes.mjs';
import {extendedContracts} from '../lib/extended-methods.mjs';
import {runScenarios} from '../lib/scenarios.mjs';
import {checkExtendedBehavior} from '../lib/optimization-regression.mjs';
import {verifyPreservation} from '../lib/preservation.mjs';
import {writeTheme,serveTheme,deployment,steps,renderTag} from './fixtures/section-liquid/theme.mjs';

for(const method of ['section-liquid-initial','section-liquid-inline'])test(`real Chrome: ${method}, dynamic updates, no-JS, empty/settings and failed API fallback`, {skip:process.env.PERF_KIT_BROWSER_TESTS!=='1',timeout:180000},async t=>{
  const root=await mkdtemp('/private/tmp/perfkit-liquid-browser-'),projects={1:path.join(root,'before'),2:path.join(root,'after')};
  await writeTheme(projects[1]);await cp(projects[1],projects[2],{recursive:true});
  const server=await serveTheme(projects);t.after(async()=>{await server.close();await rm(root,{recursive:true,force:true});});
  const url=id=>`${server.origin}/fr/collections/all?preview_theme_id=${id}&sort_by=title-ascending`;
  const profile=await profileDomain({config:{schemaVersion:1,mode:'runtime',deployment:{project:projects[1],store:'fixture.myshopify.com',themeId:'1'},url:url('1'),profile:{device:'mobile',settleMs:1100}},output:path.join(root,'profile'),dependencies:{verifyDeployment:deployment}});
  const diagnosis=await diagnoseUnified({project:projects[2],profiles:[profile],goal:{kind:'loading',metric:'lcp'}}),c=diagnosis.candidates.find(c=>c.kind==='section-fetch');assert.ok(c);
  const donor=await readFile(path.join(projects[1],'sections/ajax-main.liquid'),'utf8'),dynamic=new URL(url('1'));
  dynamic.searchParams.set('sort_by','title-descending');dynamic.searchParams.set('view','ajax');
  const plan=await createDomainPlan({project:projects[2],diagnosis,config:{schemaVersion:1,candidateId:c.candidateId,method,sectionSelector:'#hero',initialLiquid:{targetFile:'sections/main.liquid',sourceFile:'sections/ajax-main.liquid',renderOffset:donor.indexOf(renderTag),startupFunction:'load',legacyView:'ajax',update:{triggerSelector:'#refresh',assertionSelector:'#first-title',requestUrl:dynamic.href}},review:{summary:'Fixture shares the exact collection and section inputs; loader has no other startup effects; delegated handlers survive content replacement.',...Object.fromEntries(extendedContracts[method].review.map(k=>[k,true]))}}});
  const official=await createOfficialPlan({project:projects[2],diagnosis,config:{schemaVersion:1,candidateId:c.candidateId,methodId:'render-essential-content-server-side',executor:'domain:'+method,parameters:{sectionSelector:'#hero',initialLiquid:{targetFile:'sections/main.liquid',sourceFile:'sections/ajax-main.liquid',renderOffset:donor.indexOf(renderTag),startupFunction:'load',legacyView:'ajax',update:{triggerSelector:'#refresh',assertionSelector:'#first-title',requestUrl:dynamic.href}}},review:{sourceHash:c.source.sourceHash,summary:'Same reviewed render and dynamic behavior as the domain plan.',...Object.fromEntries(extendedContracts[method].review.map(k=>[k,true]))}}});
  assert.deepEqual(official.changes.map(c=>[c.target,c.after]),plan.changes.map(c=>[c.target,c.after]));
  await applySitePlan(plan,projects[2]);
  const scenarios=id=>runScenarios({config:{schemaVersion:1,project:projects[id],expectedThemeId:id,url:url(id),settleMs:1100,serverRenderedSelectors:['#hero'],viewports:[{name:'mobile',width:390,height:844},{name:'desktop',width:1440,height:900}],scenarios:[{name:'catalog',steps}]},output:path.join(root,'scenarios-'+id)});
  const before=await scenarios('1'),after=await scenarios('2');assert.equal(before.outcome,'passed');assert.equal(after.outcome,'passed');
  assert.equal(checkExtendedBehavior(plan,before),true);assert.equal(checkExtendedBehavior(plan,after,{candidate:true}),true);
  assert.equal(verifyPreservation({before,after,beforeSourceHash:before.sourceHash,afterSourceHash:after.sourceHash}).outcome,'preserved');
  for(const corrupt of [
    r=>delete r.serverRendered,
    r=>{r.resourceCaptureComplete=false;},
    r=>{r.fetchResources[0].startedStepIndex=-1;},
    r=>{r.fetchResources[0].finished=false;},
    r=>{r.fetchResources[0].sectionResponse.valid=false;},
    r=>{r.steps[5].assertionBefore.actual='Beta product';},
    r=>{r.serverRendered.checkpoints[0].observation.content[1].text=['Wrong server content'];},
    r=>{r.fetchResources.push({url:plan.changes[0].evidence.initialLiquidContract.initialRequestUrl,startedStepIndex:-1});},
  ]) {const invalid=structuredClone(after);corrupt(invalid.runs[0]);assert.equal(checkExtendedBehavior(plan,invalid,{candidate:true}),false);}
  const browser=await chromium.launch({headless:true,executablePath:await browserExecutable()});t.after(()=>browser.close());
  const page=await browser.newPage();
  for(const query of ['','&empty=1','&alternate=1']) {
    const context=await browser.newContext({javaScriptEnabled:false}),plain=await context.newPage();
    await plain.goto(url('2')+query);await page.goto(url('1')+query);await page.waitForFunction(()=>document.querySelector('#hero h1'));
    assert.equal(await plain.locator('#hero').innerHTML(),await page.locator('#hero').innerHTML());await context.close();
  }
  await page.goto(url('2'));assert.equal(await page.locator('#first-title').textContent(),'Alpha product');
  for(let i=0;i<2;i++) {
    const response=page.waitForResponse(r=>new URL(r.url()).searchParams.has('section_id'));
    await page.locator('#refresh').click();await response;await page.waitForFunction(()=>document.querySelector('#first-title').textContent==='Beta product');
    await page.locator('#open').click();assert.equal(await page.locator('#more').isVisible(),true);
  }
  // Theme editor replacement retains delegated controls and does not replay the startup fetch.
  await page.goto(url('2'));
  await page.evaluate(()=>{const n=document.querySelector('.shopify-section');n.replaceWith(n.cloneNode(true));document.dispatchEvent(new CustomEvent('shopify:section:load'));});
  if(method==='section-liquid-inline') {
    const content=await page.locator('.shopify-section > script').textContent();
    await page.addScriptTag({content});await page.addScriptTag({content});
  }
  const requestStart=server.requests.length;
  await page.locator('#refresh').click();await page.waitForFunction(()=>document.querySelector('#first-title').textContent==='Beta product');
  assert.equal(server.requests.slice(requestStart).filter(r=>new URL(r.url).searchParams.has('section_id')).length,1);
  // A response from an unloaded section must not overwrite the replacement or navigate.
  await page.goto(url('2'));
  const inFlight=page.waitForRequest(r=>new URL(r.url()).searchParams.has('section_id'));
  await page.locator('#refresh').click();await inFlight;
  await page.evaluate(()=>{
    const old=document.querySelector('.shopify-section'),next=old.cloneNode(true);
    old.dispatchEvent(new CustomEvent('shopify:section:unload',{bubbles:true}));old.replaceWith(next);
    next.dispatchEvent(new CustomEvent('shopify:section:load',{bubbles:true}));
  });
  await page.waitForTimeout(250);
  assert.equal(await page.locator('#first-title').textContent(),'Alpha product');assert.equal(page.url(),url('2'));
  await page.locator('#refresh').click();await page.waitForFunction(()=>document.querySelector('#first-title').textContent==='Beta product');
  await page.evaluate(()=>{
    const root=document.querySelector('.shopify-section');window.removedSection=root.cloneNode(true);
    root.dispatchEvent(new CustomEvent('shopify:section:unload',{bubbles:true}));root.remove();
    document.body.insertAdjacentHTML('beforeend','<button id="open">Unrelated control</button><p id="more" hidden>Unrelated detail</p>');
  });
  await page.locator('#open').click();assert.equal(await page.locator('#more').isVisible(),false);
  await page.evaluate(()=>{
    document.querySelector('#open').remove();document.querySelector('#more').remove();document.body.append(window.removedSection);
    window.removedSection.dispatchEvent(new CustomEvent('shopify:section:load',{bubbles:true}));
  });
  await page.locator('#open').click();assert.equal(await page.locator('#more').isVisible(),true);
  for(const failure of ['500','invalid','timeout']) {
    server.setFailure(failure);await page.goto(url('2'));
    const fallback=page.waitForResponse(r=>new URL(r.url()).searchParams.get('view')==='ajax',{timeout:10000});
    await page.locator('#refresh').click();await fallback;await page.waitForFunction(()=>document.querySelector('#first-title').textContent==='Beta product');
    await page.locator('#open').click();assert.equal(await page.locator('#more').isVisible(),true);
  }
  server.setFailure(null);
  if(method==='section-liquid-initial') {
    server.setPolicy({headers:["script-src 'self' 'nonce-fixture'; style-src 'unsafe-inline'"],meta:[]});
    const external=await runScenarios({config:{schemaVersion:1,project:projects[2],expectedThemeId:'2',url:url('2'),settleMs:100,serverRenderedSelectors:['#hero'],viewports:[{name:'mobile',width:390,height:844}],scenarios:[{name:'external-under-strict-csp',steps}]},output:path.join(root,'strict-external')});
    assert.equal(external.outcome,'passed');assert.equal(checkExtendedBehavior(plan,external,{candidate:true}),true);
  }
  if(method==='section-liquid-inline')for(const policy of [
    {headers:["script-src 'self' 'nonce-fixture'; style-src 'unsafe-inline'"],meta:[]},
    {headers:["script-src 'self' 'unsafe-inline'","script-src-elem 'self' 'nonce-fixture'"],meta:[]},
    {headers:[],meta:["script-src 'self' 'nonce-fixture'"]},
  ]) {
    server.setPolicy(policy);
    const blocked=await runScenarios({config:{schemaVersion:1,project:projects[2],expectedThemeId:'2',url:url('2'),settleMs:100,timeoutMs:700,serverRenderedSelectors:['#hero'],viewports:[{name:'mobile',width:390,height:844}],scenarios:[{name:'blocked-inline',steps}]},output:path.join(root,'csp-'+Math.random().toString(16).slice(2))});
    assert.equal(blocked.outcome,'failed');assert.equal(checkExtendedBehavior(plan,blocked,{candidate:true}),false);
    assert.ok(blocked.runs[0].cspViolations.some(v=>v.disposition==='enforce'&&v.blockedURI==='inline'));
    assert.equal(blocked.runs[0].initialControllers.length,0);
  }
});
