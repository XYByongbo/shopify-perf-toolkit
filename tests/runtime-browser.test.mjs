import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { profileRuntime, browserExecutable } from '../lib/runtime-profile.mjs';
import { profileDevtools } from '../lib/devtools-profile.mjs';
import { componentLoaderSource } from '../lib/split-plan.mjs';
import { verifyDeployment } from '../lib/deployment.mjs';
import { runScenarios } from '../lib/scenarios.mjs';
const enabled = process.env.PERF_KIT_BROWSER_TESTS === '1';
async function fixture(t, { interactionWork = false } = {}) {
  const root = await mkdtemp('/private/tmp/perfkit-browser-'); await mkdir(path.join(root,'assets'));
  const js = 'function unusedFeature(){return "unused".repeat(1000)}\nfunction startupWork(){const until=performance.now()+65;while(performance.now()<until){Math.sqrt(Math.random())}}\nstartupWork();'+(interactionWork?'\nfunction clickCost(){const until=performance.now()+120;while(performance.now()<until){Math.sqrt(Math.random())}}\ndocument.addEventListener("DOMContentLoaded",()=>document.querySelector("button").addEventListener("click",clickCost));':'');
  const css = 'h1 { color: navy; } .never-opened { color: red; padding: 30px; }';
  const loader = componentLoaderSource({ key: 'fixture', rootSelector: '.component', triggerSelector: 'button' });
  const heavy = 'export async function activate(root,{event,trigger,signal}){if(!signal.aborted){root.dataset.activations=String(Number(root.dataset.activations||0)+1);root.querySelector("output").textContent=root.dataset.activations;}}\nexport function destroy(root){root.dataset.destroyed="true"}';
  const requests = [];
  for (const [name, body] of [['main.js',js],['style.css',css],['loader.js',loader],['heavy.js',heavy]]) await writeFile(path.join(root,'assets',name),body);
  const server = http.createServer((req,res) => {
    requests.push(req.url);
    const file = new URL(req.url, 'http://localhost').pathname;
    const sources = { '/assets/main.js': js, '/assets/style.css': css, '/assets/loader.js': loader, '/assets/heavy.js': heavy };
    if (sources[file]) { res.setHeader('content-type', file.endsWith('css') ? 'text/css' : 'text/javascript'); const send = () => res.end(sources[file]); if (file.endsWith('heavy.js')) setTimeout(send,100); else send(); }
    else if(file === '/') { res.setHeader('content-type','text/html'); res.end('<!doctype html><html><head><title>Local regression fixture</title><script>window.Shopify={theme:{id:123},shop:"fixture.myshopify.com"};</script><link rel="stylesheet" href="/assets/style.css"><script src="/assets/main.js"></script><script type="module" src="/assets/loader.js" data-perf-loader="fixture" data-perf-module="/assets/heavy.js"></script></head><body><h1>Fixture content</h1><section class="component"><button id="fixture-open" type="button">Open</button><output>0</output></section></body></html>'); }
    else { res.writeHead(404); res.end(); }
  });
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(root,{recursive:true,force:true}); });
  return { root, url: `http://127.0.0.1:${server.address().port}/`, requests };
}
test('real Chrome: coverage, CPU stacks, request hashes and trace are collected without media files', { skip: !enabled, timeout: 60000 }, async t => {
  const f = await fixture(t);
  const profile = await profileRuntime({ config: { schemaVersion:1,url:f.url,project:f.root,device:'mobile',state:'open-component',settleMs:100,actions:[{type:'click',selector:'button'},{type:'wait',ms:250}] }, output:path.join(f.root,'runtime') });
  assert.equal(profile.status,'complete',JSON.stringify(profile.errors));
  assert.ok(profile.coverage.js.some(c => c.url.endsWith('main.js') && c.unusedUnits > 0));
  assert.ok(profile.coverage.css.some(c => c.unusedUnits > 0));
  assert.ok(profile.cpu.some(c => c.functionName === 'startupWork' && c.selfMs > 0));
  assert.ok(profile.resources.some(r => r.url.endsWith('main.js') && r.source.status === 'verified-bytes'));
  assert.ok(profile.resources.find(r => r.url.endsWith('heavy.js')).initiator.stack);
  assert.deepEqual((await readdir(path.join(f.root,'runtime'))).sort(),['cpu.cpuprofile','interaction-cpu.cpuprofile','profile.json','trace.json']);
  assert.equal(profile.cpuWindow,'navigation-through-initial-settle');
  assert.ok(Array.isArray(JSON.parse(await readFile(path.join(f.root,'runtime/interaction-cpu.cpuprofile'),'utf8')).nodes));
});
test('real Chrome P0/P1: Event Timing target, input/processing/presentation and interaction CPU reach diagnosis', {skip:!enabled,timeout:60000},async t=>{
  const f=await fixture(t,{interactionWork:true});
  const profile=await profileRuntime({config:{schemaVersion:1,url:f.url,project:f.root,device:'mobile',state:'first-open',settleMs:250,actions:[{type:'click',selector:'#fixture-open'},{type:'wait',ms:300}]},output:path.join(f.root,'interaction')});
  assert.equal(profile.status,'complete',JSON.stringify(profile.errors));
  const event=profile.afterActions.interactions.find(e=>e.name==='click'&&e.target==='#fixture-open');
  assert.ok(event,JSON.stringify(profile.afterActions.interactions));assert.ok(event.duration>=80);assert.ok(event.processing>=80);
  assert.ok(event.startTime>=profile.interactionWindowStartMs);assert.ok(profile.initial.fcp>0);
  assert.ok(profile.interactionCpu.some(c=>c.functionName==='clickCost'&&c.selfMs>0));
  const {diagnoseUnified}=await import('../lib/decision-engine.mjs');
  const d=await diagnoseUnified({project:f.root,profiles:[profile],goal:{kind:'interaction',target:'#fixture-open',event:'click'}});
  assert.ok(d.candidates.some(c=>c.kind==='interaction-cpu'),JSON.stringify(d.observations));
  assert.ok(d.phases[0].interactions.some(e=>e.presentation>=0));
});
test('real Chrome identity with isolated CLI transport: checks remote source and actual rendered theme ID', { skip: !enabled, timeout: 60000 }, async t => {
  const f=await fixture(t); let pulledTo;
  const runProcess=async (_command,args)=>{
    assert.deepEqual(args.slice(0,2),['theme','pull']); assert.ok(!args.includes('push')); assert.ok(!args.some(a=>/png|jpe?g|webp|mp4/.test(a)));
    pulledTo=args[args.indexOf('--path')+1]; assert.notEqual(pulledTo,f.root); await mkdir(path.join(pulledTo,'assets'));
    for(const name of await readdir(path.join(f.root,'assets')))await copyFile(path.join(f.root,'assets',name),path.join(pulledTo,'assets',name));
    return {code:0,stdout:'',stderr:''};
  };
  const config={project:f.root,store:'fixture.myshopify.com',themeId:'123',timeoutMs:30000};
  const proof=await verifyDeployment({config,pages:[{id:'home',url:f.url}],dependencies:{runProcess}});
  assert.equal(proof.status,'verified',JSON.stringify(proof.error));assert.equal(proof.remoteSourceHash,proof.sourceHash);
  await assert.rejects(readdir(pulledTo),{code:'ENOENT'});
  const wrong=await verifyDeployment({config:{...config,themeId:'456'},pages:[{id:'home',url:f.url}],dependencies:{runProcess}});
  assert.equal(wrong.status,'mismatch');
});
test('real Chrome P0/P1: interaction runner saves five independent captures with bracketed deployment identity', {skip:!enabled,timeout:90000},async t=>{
  const f=await fixture(t,{interactionWork:true});
  const {measureInteractions,readInteractionRun}=await import('../lib/interaction-measure.mjs');
  const runProcess=async(_cmd,args)=>{
    const dest=args[args.indexOf('--path')+1];await mkdir(path.join(dest,'assets'));
    for(const name of await readdir(path.join(f.root,'assets')))await copyFile(path.join(f.root,'assets',name),path.join(dest,'assets',name));
    return {code:0,stdout:'',stderr:''};
  };
  const output=path.join(f.root,'interaction-measure');
  const result=await measureInteractions({output,config:{schemaVersion:1,runs:5,profile:{schemaVersion:1,url:f.url,project:f.root,device:'mobile',state:'open',settleMs:150,timeoutMs:10000,actions:[{type:'click',selector:'#fixture-open'},{type:'wait',ms:200}]},
    deployment:{project:f.root,store:'fixture.myshopify.com',themeId:'123',timeoutMs:15000},budget:{maxWallTimeMs:180000,maxAttempts:5,maxFailures:1}},
    dependencies:{verifyDeployment:args=>verifyDeployment({...args,dependencies:{runProcess}})}});
  assert.equal(result.status,'complete',result.error);assert.equal(result.profiles.length,5);
  const evidence=await readInteractionRun(output);assert.equal(evidence.identity.status,'verified');
  assert.equal(new Set(evidence.profiles.map(p=>p.createdAt)).size,5);
});
test('real Chrome keyboard goal records action timing and runs press-to-assert regression', {skip:!enabled,timeout:60000},async t=>{
  const f=await fixture(t,{interactionWork:true});
  const p=await profileRuntime({config:{schemaVersion:1,url:f.url,project:f.root,device:'mobile',state:'keyboard-open',settleMs:250,actions:[{type:'press',selector:'#fixture-open',key:'Enter'}]},output:path.join(f.root,'keyboard-profile')});
  assert.equal(p.status,'complete',JSON.stringify(p.errors));
  assert.ok(p.afterActions.interactions.some(e=>e.name==='keydown'&&e.target==='#fixture-open'),JSON.stringify(p.afterActions.interactions));
  const action=p.actions[0];assert.equal(action.target,'#fixture-open');assert.ok(action.startedAtMs>=p.interactionWindowStartMs);assert.ok(action.finishedAtMs<=p.interactionWindowEndMs);
  const previous=process.env.PERF_KIT_PLAYWRIGHT_MODULE;
  process.env.PERF_KIT_PLAYWRIGHT_MODULE=new URL('../node_modules/playwright-core/index.mjs',import.meta.url).pathname;
  try {
    const regression=await runScenarios({config:{schemaVersion:1,project:f.root,expectedThemeId:'123',url:f.url,viewports:[{name:'mobile',width:390,height:844}],scenarios:[{name:'keyboard',steps:[{action:'press',selector:'#fixture-open',key:'Enter'},{action:'assert-text',selector:'output',text:'1'},{action:'checkpoint',selector:'.component',key:'open'}]}]},output:path.join(f.root,'keyboard-scenarios')});
    assert.equal(regression.outcome,'passed',JSON.stringify(regression));assert.equal(regression.runs[0].beforeScreenshot,'omitted-press-first');
    assert.equal(regression.runs[0].steps[0].observation.key,'Enter');
  }finally{if(previous===undefined)delete process.env.PERF_KIT_PLAYWRIGHT_MODULE;else process.env.PERF_KIT_PLAYWRIGHT_MODULE=previous;}
});
test('real Chrome: lazy component keeps first/repeated clicks and editor unload/reload without duplicate initialization', { skip: !enabled, timeout: 60000 }, async t => {
  const f = await fixture(t), browser = await chromium.launch({ executablePath:await browserExecutable(),headless:true });
  t.after(() => browser.close()); const page=await browser.newPage(); await page.goto(f.url);
  assert.equal(f.requests.filter(x=>x==='/assets/heavy.js').length,0);
  await page.locator('button').click(); await page.locator('button').click(); await page.waitForFunction(()=>document.querySelector('output').textContent==='2');
  assert.equal(f.requests.filter(x=>x==='/assets/heavy.js').length,1);
  await page.evaluate(()=>{const root=document.querySelector('section');root.dispatchEvent(new CustomEvent('shopify:section:load',{bubbles:true}));root.dispatchEvent(new CustomEvent('shopify:section:load',{bubbles:true}));});
  await page.locator('button').click(); await page.waitForFunction(()=>document.querySelector('output').textContent==='3');
  await page.evaluate(()=>document.querySelector('section').dispatchEvent(new CustomEvent('shopify:section:unload',{bubbles:true})));
  await page.waitForFunction(()=>document.querySelector('section').dataset.destroyed==='true');
  await page.locator('button').click(); assert.equal(await page.locator('output').textContent(),'3');
  await page.evaluate(()=>document.querySelector('section').dispatchEvent(new CustomEvent('shopify:section:load',{bubbles:true})));
  await page.locator('button').click(); await page.waitForFunction(()=>document.querySelector('output').textContent==='4');
});
test('real Chrome DevTools MCP: isolated navigation and performance trace through the pinned MCP SDK', { skip: !enabled, timeout: 100000 }, async t => {
  const f=await fixture(t);
  const result=await profileDevtools({config:{schemaVersion:1,url:f.url,device:'mobile',timeoutMs:80000},output:path.join(f.root,'devtools')});
  assert.equal(result.status,'complete',result.error);
  assert.ok(result.trace.includes('LCP')); assert.ok(result.tools.includes('performance_analyze_insight'));
  assert.ok(result.insights.some(i => i.insightName === 'LCPBreakdown'), result.trace.slice(0,6000));
  assert.ok((await readdir(path.join(f.root,'devtools'))).includes('trace.json.gz'));
});
