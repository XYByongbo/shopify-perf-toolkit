import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright-core';
import {browserExecutable,resourceHealthSnapshot} from '../lib/runtime-profile.mjs';
import {resourceHealth} from '../lib/resource-intelligence.mjs';
import {transformCode} from '../lib/code-strategies.mjs';
import {sha256} from '../lib/source-utils.mjs';
import {Liquid} from 'liquidjs';

test('Chrome detects 200 HTML images, selected picture resources and actual generated font display',{skip:process.env.PERF_KIT_BROWSER_TESTS!=='1'},async()=>{
  const browser=await chromium.launch({executablePath:await browserExecutable(),headless:true});
  try {
    const page=await browser.newPage();
    await page.route('https://fixture.test/**',route=>route.fulfill({status:200,contentType:'text/html',body:'not an image'}));
    const source="{{ settings.body_font | font_face: font_display: 'block' }}";
    const generated=transformCode({source,target:'sections/main.liquid',kind:'liquid-font-display',parameters:{outputStart:0,display:'swap'},
      evidence:{sourceHash:sha256(source),summary:'Synthetic typography test',fontUsageReviewed:true,fallbackMetricsReviewed:true}});
    const engine=new Liquid();engine.registerFilter('font_face',(value,...args)=>`@font-face {font-family: TestFixture; src:local(Arial); font-display:${args.find(a=>Array.isArray(a)&&a[0]==='font_display')?.[1]??'auto'};}`);
    const css=await engine.parseAndRender(generated.after,{settings:{body_font:'TestFixture'}});
    await page.setContent(`<style>${css}</style><script>window.__perfkitTargetName=el=>'#'+el.id</script><p id="text">Text wrapping fixture</p><picture><source srcset="https://fixture.test/broken"><img id="broken" src="https://fixture.test/fallback"></picture>`,{waitUntil:'networkidle'});
    const health=await page.evaluate(resourceHealthSnapshot);
    assert.equal(health.images[0].decoded,false);assert.equal(health.images[0].inPicture,true);
    assert.equal(health.images[0].url,'https://fixture.test/broken');assert.equal(resourceHealth([{config:{},resourceHealth:health}])[0].status,'failures-observed');
    assert.equal(health.fonts.find(f=>f.family==='TestFixture')?.display,'swap');assert.ok(health.text.some(t=>t.selector==='#text'&&t.rect[2]>0));
    await page.evaluate(()=>{document.querySelector('#broken').decode=()=>new Promise(()=>{});});
    const bounded=await page.evaluate(resourceHealthSnapshot);assert.equal(bounded.images[0].decoded,null);
    assert.equal(resourceHealth([{resourceHealth:bounded}])[0].status,'partial');
    await page.evaluate(()=>{const image=document.querySelector('#broken');image.decode=async()=>{
      document.querySelector('source').srcset='https://fixture.test/changed';await new Promise(resolve=>setTimeout(resolve,50));
    };});
    const changed=await page.evaluate(resourceHealthSnapshot);assert.equal(changed.images[0].changedDuringCapture,true);assert.equal(changed.images[0].decoded,null);
    await page.close();
  }finally{await browser.close();}
});
