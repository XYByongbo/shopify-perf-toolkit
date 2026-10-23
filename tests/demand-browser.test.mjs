import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import { Liquid } from 'liquidjs';
import { profileRuntime, sourceSnapshot, browserExecutable } from '../lib/runtime-profile.mjs';
import { diagnoseBottlenecks } from '../lib/bottlenecks.mjs';
import { createDemandPlan } from '../lib/demand-plan.mjs';
import { applySitePlan, rollbackSitePlan } from '../lib/site-changes.mjs';
import { runScenarios } from '../lib/scenarios.mjs';
import { verifyPreservation } from '../lib/preservation.mjs';

const enabled = process.env.PERF_KIT_BROWSER_TESTS === '1';
async function fixture(t) {
  const root=await mkdtemp('/private/tmp/perfkit-demand-browser-');
  const files={
    'assets/main.js':`function increment(n) { return n+1; }
class ShopWidget extends HTMLElement {
  connectedCallback() {
    this.handler ??= () => { const o=this.querySelector('output'); o.textContent=String(increment(Number(o.textContent))); };
    this.querySelector('button').addEventListener('click',this.handler);
  }
  disconnectedCallback() { this.querySelector('button').removeEventListener('click',this.handler); }
}
customElements.define('shop-widget',ShopWidget);
window.sharedFeature=true;`,
    'assets/cpu.js':`function startupWork() {\n const start = performance.now();\n while (performance.now() - start < 140) { Math.sqrt(Math.random()); }\n}\nstartupWork();`,
    'assets/main.css':`.hero { color: rgb(0, 0, 128); }\n.menu { padding: 8px; }\nshop-widget { display:block; margin:8px; }\n`+Array.from({length:50},(_,i)=>`.unused-${i} { background:red; padding:32px; color:green; }`).join('\n'),
    'sections/widget.liquid':'<shop-widget><button type="button">Open</button><output>0</output></shop-widget>',
    'snippets/styles.liquid':'<link rel="stylesheet" href="{{ \'main.css\' | asset_url }}">',
    'snippets/inline.liquid':`<script>function inlineWork() { const start=performance.now(); while(performance.now()-start<130){ Math.sqrt(Math.random()); } } inlineWork();</script>`,
    'layout/theme.liquid':'<script src="{{ \'main.js\' | asset_url }}" defer></script>',
    'templates/index.json':'{"sections":{"widget":{"type":"widget"}}}',
  };
  for(const [file,text] of Object.entries(files)) { await mkdir(path.dirname(path.join(root,file)),{recursive:true}); await writeFile(path.join(root,file),text); }
  const liquid=new Liquid(); liquid.registerFilter('asset_url',name=>'/assets/'+name);
  const render=async file=>liquid.parseAndRender(await readFile(path.join(root,file),'utf8'));
  const requests=[];
  const server=http.createServer(async(req,res)=>{
    requests.push(req.url); const url=new URL(req.url,'http://localhost');
    try {
      if(url.pathname.startsWith('/assets/')) {
        res.setHeader('content-type',url.pathname.endsWith('.css')?'text/css':'text/javascript');
        let text=await readFile(path.join(root,url.pathname.slice(1)),'utf8');
        if(url.pathname.endsWith('cpu.js')) text=text.replaceAll('\n',' ').replace(/\s+/g,' ');
        if(url.pathname.endsWith('main.css')) text=text.replace(/\s*([{};])\s*/g,'$1');
        if(url.pathname.endsWith('widget.js') || url.pathname.endsWith('main.css')) await new Promise(resolve=>setTimeout(resolve,150));
        res.end(text); return;
      }
      if(url.pathname==='/section') { res.setHeader('content-type','text/html'); res.end(await render('sections/widget.liquid')); return; }
      const widgets=url.pathname==='/empty'?'':`<section id="first">${await render('sections/widget.liquid')}</section><section id="second">${await render('sections/widget.liquid')}</section>`;
      res.setHeader('content-type','text/html');
      res.end(`<!doctype html><html><head><title>Demand regression fixture</title><script>window.Shopify={theme:{id:123},shop:'fixture.myshopify.com'};</script>${await render('snippets/styles.liquid')}${await render('layout/theme.liquid')}${url.pathname==='/profile'?'<script src="/assets/cpu.js"></script>'+await render('snippets/inline.liquid'):''}</head><body><h1 class="hero">Same heading</h1><main>${widgets}</main><div id="injected"></div></body></html>`);
    }catch { res.writeHead(404); res.end('Not found'); }
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(root,{recursive:true,force:true});});
  return {root,url:`http://127.0.0.1:${server.address().port}`,requests,render};
}

test('real Chrome maps compressed script and inline CPU frames back to local source before interactions', {skip:!enabled,timeout:60000},async t=>{
  const f=await fixture(t);
  const p=await profileRuntime({config:{schemaVersion:1,url:f.url+'/profile',project:f.root,settleMs:100,actions:[{type:'click',selector:'#first button'}]},output:path.join(f.root,'profile')});
  assert.equal(p.status,'complete',JSON.stringify(p.errors));
  assert.equal(p.cpuWindow,'navigation-through-initial-settle');
  assert.ok(p.cpu.some(row=>row.source.file==='assets/cpu.js' && row.source.status==='verified-ast' && row.source.line>=1),JSON.stringify(p.cpu));
  assert.ok(p.cpu.some(row=>row.source.file==='snippets/inline.liquid' && row.source.scriptKind==='inline'),JSON.stringify(p.cpu));
  const diagnosis=await diagnoseBottlenecks({project:f.root,profiles:[p]});
  assert.ok(diagnosis.candidates.some(c=>['assets/cpu.js','snippets/inline.liquid'].includes(c.file)),JSON.stringify(diagnosis.candidates));
});

test('real Chrome generated component split preserves first click, two instances, detach/reconnect and dynamic sections; empty page skips the component asset', {skip:!enabled,timeout:120000},async t=>{
  const f=await fixture(t), snapshot=await sourceSnapshot(f.root), source={status:'verified-bytes',...snapshot.files.find(x=>x.file==='assets/main.js'),line:3};
  const diagnosticFixture={kind:'runtime-profile',status:'complete',sourceStable:true,snapshot,config:{url:f.url+'/',device:'mobile',state:'initial',actions:[]},cpu:[{source,url:f.url+'/assets/main.js',selfMs:120,inclusiveMs:120,functionName:'connectedCallback'}],resources:[],coverage:{css:[],js:[]}};
  const diagnosis=await diagnoseBottlenecks({project:f.root,profiles:[diagnosticFixture]});
  const plan=await createDemandPlan({project:f.root,diagnosis,config:{schemaVersion:1,mode:'component',source:'assets/main.js',newAsset:'assets/widget.js',component:'shop-widget',candidateId:diagnosis.candidates[0].candidateId}});
  const scenario={schemaVersion:1,project:f.root,url:f.url+'/',expectedThemeId:'123',viewports:[{name:'mobile',width:390,height:844},{name:'desktop',width:1440,height:900}],scenarios:[{name:'first-action-and-lifecycle',steps:[
    {action:'click',selector:'#first button'},{action:'assert-text',selector:'#first output',text:'1'},
    {action:'click',selector:'#second button'},{action:'assert-text',selector:'#second output',text:'1'},
    {action:'detach',selector:'#first shop-widget',key:'widget'},{action:'reconnect',key:'widget'},
    {action:'dispatch',selector:'#first',event:'shopify:section:load'},{action:'dispatch',selector:'#first',event:'shopify:section:load'},
    {action:'click',selector:'#first button'},{action:'assert-text',selector:'#first output',text:'2'},
    {action:'checkpoint',selector:'body',key:'after-actions'}]}]};
  const before=await runScenarios({config:scenario,output:path.join(f.root,'before')}); assert.equal(before.outcome,'passed',JSON.stringify(before));
  await applySitePlan(plan,f.root);
  const after=await runScenarios({config:scenario,output:path.join(f.root,'after')}); assert.equal(after.outcome,'passed',JSON.stringify(after));
  assert.equal(verifyPreservation({before,after,beforeSourceHash:before.sourceHash,afterSourceHash:after.sourceHash}).outcome,'preserved');
  const browser=await chromium.launch({executablePath:await browserExecutable(),headless:true}); t.after(()=>browser.close());
  const page=await browser.newPage(); const started=f.requests.length;
  await page.goto(f.url+'/empty'); assert.ok(!f.requests.slice(started).some(p=>p.endsWith('widget.js')));
  await page.evaluate(async()=>{document.querySelector('#injected').innerHTML=await (await fetch('/section')).text();await customElements.whenDefined('shop-widget');});
  await page.click('#injected button'); assert.equal(await page.textContent('#injected output'),'1');
  await page.evaluate(()=>{const root=document.querySelector('#injected');document.dispatchEvent(new CustomEvent('shopify:section:load',{detail:{sectionId:'injected'}})); root.dispatchEvent(new CustomEvent('shopify:section:load',{bubbles:true}));});
  await page.click('#injected button'); assert.equal(await page.textContent('#injected output'),'2');
  await rollbackSitePlan(plan,f.root); assert.equal((await sourceSnapshot(f.root)).hash,snapshot.hash);
});

test('real Chrome multi-state CSS coverage creates a smaller blocking sheet and preserves computed presentation', {skip:!enabled,timeout:120000},async t=>{
  const f=await fixture(t), profiles=[];
  for(const device of ['mobile','desktop']) profiles.push(await profileRuntime({config:{schemaVersion:1,url:f.url+'/',project:f.root,device,settleMs:100,actions:[{type:'click',selector:'#first button'}]},output:path.join(f.root,`css-${device}`)}));
  for(const p of profiles) assert.equal(p.status,'complete',JSON.stringify(p.errors));
  assert.ok(profiles[0].coverage.css.some(c=>c.source?.status==='verified-ast'&&c.source.file==='assets/main.css'));
  const diagnosis=await diagnoseBottlenecks({project:f.root,profiles}), candidate=diagnosis.candidates.find(c=>c.file==='assets/main.css'&&c.kind==='render-resource');
  assert.ok(candidate,JSON.stringify(diagnosis));
  const plan=await createDemandPlan({project:f.root,diagnosis,profiles,config:{schemaVersion:1,mode:'critical-css',source:'assets/main.css',newAsset:'assets/critical.css',loaderTarget:'snippets/styles.liquid',tagStart:0,inlineLoadHandlerAllowed:true,candidateId:candidate.candidateId}});
  const scenario={schemaVersion:1,project:f.root,url:f.url+'/',viewports:[{name:'mobile',width:390,height:844},{name:'desktop',width:1440,height:900}],scenarios:[{name:'styles',steps:[{action:'click',selector:'#first button'},{action:'assert-text',selector:'#first output',text:'1'},{action:'checkpoint',selector:'body',key:'styles'}]}]};
  const before=await runScenarios({config:scenario,output:path.join(f.root,'before')}); await applySitePlan(plan,f.root);
  const after=await runScenarios({config:scenario,output:path.join(f.root,'after')});
  assert.equal(verifyPreservation({before,after,beforeSourceHash:before.sourceHash,afterSourceHash:after.sourceHash}).outcome,'preserved');
  assert.ok((await readFile(path.join(f.root,'assets/critical.css'),'utf8')).length < (await readFile(path.join(f.root,'assets/main.css'),'utf8')).length*0.5);
});
