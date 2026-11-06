import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright-core';
import {browserExecutable} from '../lib/runtime-profile.mjs';
import {checkpointDOM,preservationStyles,compareCheckpoints} from '../lib/preservation.mjs';

test('Chrome checkpoints observe state that attributes and first select.value cannot represent',
  {skip:process.env.PERF_KIT_BROWSER_TESTS!=='1',timeout:30000},async()=>{
    const browser=await chromium.launch({executablePath:await browserExecutable(),headless:true});
    try {
      const page=await browser.newPage({viewport:{width:390,height:844}});
      await page.setContent('<fieldset id="outer"><section id="component"><input id="check" type="checkbox"><input id="text"><select id="many" multiple><option value="a" selected>A</option><option value="b">B</option></select><details id="details"><summary>More</summary><p>Content</p></details><button id="button">Buy</button><div id="scroll" style="overflow:auto;height:20px"><div style="height:100px">Scroll</div></div></section></fieldset>');
      const capture=()=>page.locator('#component').evaluate(checkpointDOM,preservationStyles);
      const before=await capture();assert.equal(before.version,2);
      const node=(p,id)=>p.content.find(n=>n.attrs.some(([k,v])=>k==='id'&&v===id));
      await page.evaluate(()=>document.querySelector('#check').indeterminate=true);
      const mixed=await capture();assert.equal(node(mixed,'check').properties.indeterminate,true);
      assert.deepEqual(node(before,'check').attrs,node(mixed,'check').attrs);
      assert.equal(compareCheckpoints(before,mixed).outcome,'regressed');
      await page.evaluate(()=>{document.querySelector('#check').indeterminate=false;document.querySelector('#many').options[1].selected=true;});
      const multiple=await capture();assert.equal(node(before,'many').value,node(multiple,'many').value);
      assert.equal(node(multiple,'many').properties.selectedOptions.length,2);
      assert.equal(compareCheckpoints(before,multiple).outcome,'regressed');
      await page.evaluate(()=>{document.querySelector('#many').options[1].selected=false;document.querySelector('#outer').disabled=true;});
      const disabled=await capture();assert.equal(node(disabled,'text').properties.disabled,false);
      assert.equal(node(disabled,'text').properties.effectivelyDisabled,true);
      assert.equal(compareCheckpoints(before,disabled).outcome,'regressed');
      await page.evaluate(()=>{document.querySelector('#outer').disabled=false;document.querySelector('#button').focus();});
      assert.ok(compareCheckpoints(before,await capture()).changes.includes('focus'));
      await page.evaluate(()=>{document.querySelector('#button').blur();document.querySelector('#scroll').scrollTop=10;});
      assert.equal(node(await capture(),'scroll').properties.scroll[1],10);
      assert.equal(compareCheckpoints(before,await capture()).outcome,'regressed');
      await page.evaluate(()=>{document.querySelector('#scroll').scrollTop=0;document.querySelector('#text').readOnly=true;document.querySelector('#text').required=true;document.querySelector('#details').open=true;});
      const form=await capture();assert.equal(node(form,'text').properties.readOnly,true);
      assert.equal(node(form,'text').properties.required,true);assert.equal(node(form,'details').properties.open,true);
      assert.equal(compareCheckpoints(before,form).outcome,'regressed');
      const detached=await page.locator('#component').elementHandle();
      await detached.evaluate(el=>el.remove());
      await assert.rejects(detached.evaluate(checkpointDOM,preservationStyles),/connected/);
    } finally {await browser.close();}
  });
