import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {runScenarios} from '../lib/scenarios.mjs';
import {chromium} from 'playwright-core';
import {browserExecutable} from '../lib/theme-source.mjs';
import {profileRuntime} from '../lib/runtime-profile.mjs';
import {auditWindowBudget} from '../lib/resource-budget.mjs';
const enabled=process.env.PERF_KIT_BROWSER_TESTS==='1';
test('real network capture supports an observed budget window and refuses an unobserved tail',{skip:!enabled,timeout:30000},async t=>{
  const root=await mkdtemp('/private/tmp/perfkit-window-browser-');
  const server=createServer((_req,res)=>{res.setHeader('Content-Type','text/html');res.end('<!doctype html><link rel="icon" href="data:,"><h1>Window fixture</h1>');});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));await rm(root,{recursive:true,force:true});});
  const profile=await profileRuntime({config:{schemaVersion:1,url:`http://127.0.0.1:${server.address().port}/`,device:'mobile',settleMs:200,actions:[]},output:root+'/profile'});
  assert.equal(profile.status,'complete',JSON.stringify(profile.errors));
  const result=await auditWindowBudget({profiles:[profile],windows:[{id:'observed',fromMs:0,toMs:100,maxTransferBytes:1000000},{id:'unobserved',fromMs:0,toMs:60000,maxTransferBytes:1000000}]});
  assert.equal(result.details[0].pass,true,JSON.stringify(result.details[0]));
  assert.ok(result.details[0].requests>0);assert.ok(result.details[0].transferBytes>0);
  assert.equal(result.details[1].pass,false);assert.ok(result.details[1].issues.includes('window-not-covered'));
});
test('real Chromium exercises fill/select/IME, stale response recovery and blocks injected evidence from normal acceptance',{skip:!enabled,timeout:60000},async t=>{
  const root=await mkdtemp('/private/tmp/perfkit-delivery-browser-');
  const html=`<input id="q"><select id="v"><option value="a">A</option><option value="b">B</option></select><p id="result"></p><p id="ime"></p><button id="search">Search</button><button id="post">Write</button><script>
    q.addEventListener('input',e=>{ime.textContent=q.value});v.addEventListener('change',()=>result.textContent=v.value);
    let generation=0;search.addEventListener('click',()=>{const n=++generation;fetch('/data?n='+n).then(r=>r.text()).then(text=>{if(n===generation)result.textContent=text}).catch(()=>result.textContent='recovered')});
    post.addEventListener('click',()=>fetch('/write',{method:'POST'}).catch(()=>{}));</script>`;
  let writes=0;
  const server=createServer((req,res)=>{if(req.method==='POST')writes++;res.setHeader('Content-Type',req.url.startsWith('/data')?'text/plain':'text/html');res.end(req.url.startsWith('/data')?new URL(req.url,'http://local').searchParams.get('n'):html);});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));await rm(root,{recursive:true,force:true});});
  const url=`http://127.0.0.1:${server.address().port}/`,base={schemaVersion:1,url,viewports:[{name:'mobile',width:390,height:844}]};
  const run=await runScenarios({config:{...base,scenarios:[{name:'input',steps:[{action:'fill',selector:'#q',value:'hello'},{action:'assert-text',selector:'#ime',text:'hello'},{action:'fill',selector:'#q',value:''},{action:'ime',selector:'#q',text:'中文',commit:true},{action:'assert-text',selector:'#ime',text:'中文'},{action:'select',selector:'#v',values:['b']},{action:'assert-text',selector:'#result',text:'b'}]}]},output:root+'/input'});
  assert.equal(run.outcome,'passed',JSON.stringify(run));
  const faults=await runScenarios({config:{...base,networkFaults:[{url:url+'data?n=1',occurrence:1,delayMs:500}],scenarios:[{name:'reorder',steps:[{action:'click',selector:'#search',times:2},{action:'assert-text',selector:'#result',text:'2'},{action:'wait',ms:700},{action:'assert-text',selector:'#result',text:'2'}]}]},output:root+'/faults'});
  assert.equal(faults.runs[0].assertionOutcome,'passed',JSON.stringify(faults));assert.equal(faults.runs[0].constrained,true);assert.equal(faults.outcome,'blocked');
  const blocked=await runScenarios({config:{...base,scenarios:[{name:'write',steps:[{action:'click',selector:'#post'},{action:'wait',ms:100},{action:'assert-count',selector:'#post',count:1}]}]},output:root+'/blocked'});
  assert.equal(blocked.outcome,'blocked');assert.equal(writes,0);
});
test('section adapter retains returned scoped CSS, restores focus and rolls back in real Chromium',{skip:!enabled,timeout:30000},async()=>{
  const browser=await chromium.launch({headless:true,executablePath:await browserExecutable()});
  try{
    const page=await browser.newPage();await page.setContent('<div id="target"><input id="focus"><p>Old</p></div>');
    const code=await readFile(new URL('../assets/runtime/theme-adapter-primitives.mjs',import.meta.url),'utf8');
    await page.addScriptTag({content:code.replaceAll('export function','function')});
    const observed=await page.evaluate(()=>{
      document.querySelector('#focus').focus();let init=0,destroy=0;
      const undo=replaceSectionContents(document.querySelector('#target'),'<style data-section-stylesheet>.new{color:rgb(1, 2, 3)}</style><div id="target"><input id="focus"><p class="new">New</p></div>',{selector:'#target',initialize:()=>init++,destroy:()=>destroy++});
      const updated={text:document.querySelector('p').textContent,color:getComputedStyle(document.querySelector('p')).color,focus:document.activeElement.id,styles:document.querySelectorAll('style[data-section-stylesheet]').length};
      undo();return {updated,text:document.querySelector('p').textContent,init,destroy,styles:document.querySelectorAll('style').length};
    });
    assert.deepEqual(observed,{updated:{text:'New',color:'rgb(1, 2, 3)',focus:'focus',styles:1},text:'Old',init:2,destroy:2,styles:0});
    await assert.rejects(page.evaluate(()=>replaceSectionContents(document.querySelector('#target'),'<div>Wrong</div>',{selector:'#target'})),/one matching/);
  }finally{await browser.close();}
});
