// Local synthetic behavior validation; no storefront navigation, images or score claim.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { transformCode } from '../lib/code-strategies.mjs';
import { codeStrategies } from '../lib/code-strategy-catalog.mjs';

const args=process.argv.slice(2);
assert(args.length===2&&args[0]==='--out'&&path.isAbsolute(args[1]),'Provide --out NEW_ABSOLUTE_DIRECTORY');
const out=args[1];await fs.mkdir(out,{recursive:false});
const selected=process.env.PERF_KIT_PLAYWRIGHT_MODULE;
if(selected)assert(path.isAbsolute(selected));
const {chromium}=await import(selected?pathToFileURL(selected).href:'playwright');
const browser=await chromium.launch({headless:true,...(process.env.PERF_KIT_BROWSER_EXECUTABLE?{executablePath:process.env.PERF_KIT_BROWSER_EXECUTABLE}:{})});
const result={kind:'local-code-strategy-browser-validation',browser:browser.version(),scope:'Synthetic local HTML and real Chromium; no theme or Lighthouse acceptance',cases:[],requests:[]};
const generate=(source,kind,parameters,target)=>transformCode({source,kind,parameters,target,evidence:{
  ...Object.fromEntries(codeStrategies.find(s=>s.kind===kind).evidenceRequired.map(k=>[k,true])),
  sourceHash:createHash('sha256').update(source).digest('hex'),summary:'Explicit synthetic fixture geometry and isolated behavior contract.'}}).after;
try{
  for(const width of [390,1440]){
    const css='.details { display: flow-root; color: rgb(20, 40, 60); color: rgb(20, 40, 60); }';
    const deduped=generate(css,'css-dedupe-declarations',{},'assets/test.css');
    const after=generate(deduped,'css-offscreen-rendering',{selector:'.details',intrinsicBlockSize:600},'assets/test.css');
    const observations=[];
    for(const [phase,style] of [['before',css],['after',after]]){
      const page=await browser.newPage({viewport:{width,height:800}});
      page.on('request',r=>result.requests.push(r.url()));await page.route('**/*',r=>r.abort());
      await page.setContent(`<style>body{margin:0}.spacer{height:3000px}.child{height:600px;display:flow-root} ${style}</style><div class="spacer">Initial content</div><section class="details"><div class="child"><h2>Details</h2><p>Original content &amp; labels</p><button>Focusable action</button></div></section><footer>Footer</footer>`);
      const beforeScroll=await page.evaluate(()=>{const e=document.querySelector('.details');return {top:e.offsetTop,height:e.offsetHeight,footer:document.querySelector('footer').offsetTop,visibility:getComputedStyle(e).contentVisibility,color:getComputedStyle(e).color};});
      await page.locator('.details button').focus();
      await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
      const visible=await page.evaluate(()=>{const e=document.querySelector('.details'),b=e.getBoundingClientRect();return {height:b.height,top:e.offsetTop,footer:document.querySelector('footer').offsetTop,color:getComputedStyle(e).color,text:e.textContent,focused:document.activeElement.tagName,inViewport:b.bottom>0&&b.top<innerHeight};});
      assert.equal(visible.focused,'BUTTON');assert.equal(visible.inViewport,true);
      await page.screenshot({path:path.join(out,`${width}-${phase}.png`)});observations.push({phase,beforeScroll,visible});await page.close();
    }
    assert.equal(observations[1].beforeScroll.visibility,'auto');
    assert.equal(observations[0].beforeScroll.height,observations[1].beforeScroll.height);
    assert.equal(observations[0].beforeScroll.footer,observations[1].beforeScroll.footer);
    assert.deepEqual(observations[0].visible,observations[1].visible);
    result.cases.push({width,status:'passed',observations});
  }
  const source=`window.updates = 0; function update() { window.updates++; }\nwindow.addEventListener('scroll', update, {passive:true});\nwindow.destroy = function() { window.removeEventListener('scroll', update); };`;
  const transformed=generate(source,'js-raf-listener',{registrationStart:source.indexOf('window.addEventListener')},'assets/test.js');
  const page=await browser.newPage();await page.setContent('<p>Local event test</p>');await page.addScriptTag({content:transformed});
  const eventState=await page.evaluate(async()=>{for(let i=0;i<50;i++)window.dispatchEvent(new Event('scroll'));const immediate=window.updates;await new Promise(r=>requestAnimationFrame(r));const flushed=window.updates;window.dispatchEvent(new Event('scroll'));window.destroy();await new Promise(r=>requestAnimationFrame(r));return {immediate,flushed,afterDestroy:window.updates};});
  assert.deepEqual(eventState,{immediate:0,flushed:1,afterDestroy:1});result.cases.push({kind:'js-raf-listener',status:'passed',eventState});await page.close();
  assert.deepEqual(result.requests,[]);result.status='passed';
}catch(error){result.status='failed';result.error=error.stack;throw error;}
finally{await browser.close();await fs.writeFile(path.join(out,'result.json'),JSON.stringify(result,null,2));}
console.log(JSON.stringify({status:result.status,cases:result.cases.length,networkRequests:result.requests.length}));
