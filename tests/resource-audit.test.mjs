import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { analyzeResourceSource, auditResources } from '../lib/resource-audit.mjs';
import { probeLink, resolvePublicTarget } from '../lib/resource-probe.mjs';
import { renderReport } from '../lib/report.mjs';
const analyze=s=>analyzeResourceSource(s,'sections/a.liquid');
const resolver=async()=>[{address:'93.184.216.34',family:4}];
test('resource lexer skips nonrendering blocks, script strings and inert markup; preserves real attributes',()=>{
  const r=analyze(`<!-- <img src="https://bad.example/a"> -->{% comment %}<script src="https://bad.example/b"></script>{% endcomment %}
{% schema %}{"x":"https://bad.example/c"}{% endschema %}<script>const s='<img src="https://bad.example/d">';</script>
<textarea><img src="https://bad.example/e"></textarea><img src="https://drive.google.com/a?raw=1&amp;token=secret" srcset="https://cdn.example/a 1x, https://cdn.example/b 2x">`);
  assert.equal(r.resources.length,3);assert.ok(r.resources.every(r=>!r.value.includes('bad.example')));assert.ok(r.resources[0].value.includes('&token=secret'));
});
test('script modes distinguish async/defer/module/data and dynamic attributes',()=>{
  const r=analyze(`<script src="a.js"></script><script defer src="b.js"></script><script async defer src="c.js"></script><script type="module" src="d.js"></script><script type="module" async src="e.js"></script><script type="application/ld+json">{}</script><script type="{{ kind }}" src="f.js"></script><script {% if x %}defer{% endif %} src="g.js"></script><template><script src="h.js"></script></template>`);
  assert.deepEqual(r.scripts.map(s=>s.mode),['classic-blocking','deferred','async','module-deferred','module-async','data-block','dynamic','dynamic','inert-context']);
});
test('simple script_tag and Liquid asset src are recognized without rewriting them',()=>{
  const r=analyze(`{{ 'a.js' | asset_url | script_tag }}{{ custom_script | script_tag }}<script src="{{ 'b.js' | asset_url }}" defer></script>{{ 'https://cdn.example/c.js' | script_tag }}`);
  assert.deepEqual(r.scripts.map(s=>s.asset),['assets/a.js','assets/b.js',null]);assert.equal(r.unresolved.length,1);assert.equal(r.resources.length,1);
});
test('CSS resources and protocol-relative srcset are collected; anchors and data images are excluded',()=>{
  const r=analyze(`<a href="https://site.example/page">x</a><img src="data:image/png;base64,aaa"><style>/*url(https://bad.example/x)*/ .a{background:url(//cdn.example/bg)} @import 'https://fonts.example/a.css';</style>`);
  assert.equal(r.resources.length,2);assert.equal(r.resources[0].protocolRelative,true);
});
test('whole audit groups resources, preserves source, exposes script order candidates and redacts secrets',async t=>{
  const project=await mkdtemp(path.join(tmpdir(),'perfkit-resources-'));t.after(()=>rm(project,{recursive:true,force:true}));
  const sources={'sections/a.liquid':`<script src="{{ 'sdk.js' | asset_url }}" defer></script><script>SDK.init()</script><img src="http://drive.google.com/p?token=secret"><img src="http://drive.google.com/p?token=secret">`,'sections/b.liquid':'<script>Other.init()</script>','assets/sdk.js':"import './helper.js';",'assets/helper.js':'export const ok=true;'};
  for(const [file,source] of Object.entries(sources)){await mkdir(path.dirname(path.join(project,file)),{recursive:true});await writeFile(path.join(project,file),source);}
  const r=await auditResources({project});assert.equal(r.complete,true);assert.equal(r.resources.length,1);assert.equal(r.resources[0].references.length,2);assert.equal(r.resources[0].classification,'file-sharing');assert.equal(r.resources[0].network.status,'not-probed');
  assert.equal(r.relationships.length,1);assert.equal(r.scripts[0].assetStatus,'resolved');assert.equal(r.moduleDependencies.length,1);assert.ok(!JSON.stringify(r).includes('token=secret'));
  const html=renderReport(r);assert.ok(html.includes('脚本加载与依赖候选'));assert.ok(!html.includes('SDK.init()'));
  for(const [file,source] of Object.entries(sources))assert.equal(await readFile(path.join(project,file),'utf8'),source);
});
test('probe validates every redirect and pins public address; private DNS is blocked before transport',async()=>{
  let calls=0;
  const result=await probeLink('https://cdn.example/file',{resolver,request:async target=>{calls++;assert.equal(target.address.address,'93.184.216.34');return {statusCode:302,location:'http://127.0.0.1/private'};}});
  assert.equal(calls,1);assert.equal(result.status,'unverified');assert.equal(result.chain.length,1);
  await assert.rejects(resolvePublicTarget('https://mixed.example/a',async()=>[{address:'93.184.216.34',family:4},{address:'10.0.0.1',family:4}]));
  await assert.rejects(resolvePublicTarget('https://user:password@cdn.example/a',resolver));
  await assert.rejects(resolvePublicTarget('file:///etc/passwd',resolver));
});
test('HEAD unsupported/rate-limited remains review, never a confirmed broken link',async()=>{
  for(const statusCode of [403,405,429]) {const r=await probeLink('https://cdn.example/a',{resolver,request:async()=>({statusCode})});assert.equal(r.status,'review-required');assert.match(r.reason,/does not prove/);}
});
test('probe follows bounded redirects, records content type and redacts signed query values',async()=>{
  let calls=0;const r=await probeLink('https://cdn.example/a?sig=secret',{resolver,request:async()=>++calls===1?{statusCode:302,location:'/b?sig=other'}:{statusCode:200,contentType:'text/html',cacheControl:'no-store'}});
  assert.equal(r.status,'reachable-headers');assert.equal(r.contentType,'text/html');assert.equal(r.chain.length,2);assert.ok(!JSON.stringify(r).includes('secret'));assert.ok(!JSON.stringify(r).includes('sig=other'));
  const loop=await probeLink('https://cdn.example/a',{resolver,maxRedirects:1,request:async()=>({statusCode:302,location:'/a'})});assert.equal(loop.status,'review-required');assert.equal(loop.chain.length,2);
});
test('DNS timeout is bounded and no transport runs after the deadline',async()=>{
  let calls=0;const r=await probeLink('https://cdn.example/a',{timeoutMs:5,resolver:async()=>{await new Promise(r=>setTimeout(r,20));return resolver();},request:async()=>{calls++;return {statusCode:200};}});
  assert.equal(r.status,'unverified');await new Promise(r=>setTimeout(r,25));assert.equal(calls,0);
});

test('explicit global provider can be linked past an intervening script without claiming execution proof',async t=>{
  const project=await mkdtemp(path.join(tmpdir(),'perfkit-global-'));t.after(()=>rm(project,{recursive:true,force:true}));
  await mkdir(path.join(project,'sections'));await mkdir(path.join(project,'assets'));
  await writeFile(path.join(project,'assets/sdk.js'),`/* window.Fake = 1 */ const text='window.String = 2'; window.SDK = {};`);
  await writeFile(path.join(project,'sections/a.liquid'),`<script src="{{ 'sdk.js' | asset_url }}" defer></script><script src="other.js"></script><script>SDK.init()</script>`);
  const r=await auditResources({project}),symbol=r.relationships.find(r=>r.status==='symbol-candidate');
  assert.deepEqual(symbol.globals,['SDK']);assert.deepEqual(r.scripts[0].providedGlobals,['SDK']);
});

test('CSS content strings do not manufacture resource requests',()=>{
  const r=analyzeResourceSource(`.a::before {content:"url(https://fake.example/a)"} .b{background:url(https://cdn.example/real)}`,'assets/a.css');
  assert.deepEqual(r.resources.map(r=>r.value),['https://cdn.example/real']);
});
test('real HTTP transport uses HEAD without cookies, records headers and bounds slow responses',async t=>{
  const {createServer}=await import('node:http');const {requestHead}=await import('../lib/resource-probe.mjs');
  const received=[];
  const server=createServer((req,res)=>{received.push({method:req.method,cookie:req.headers.cookie});if(req.url==='/slow')return;res.writeHead(200,{'content-type':'image/png','cache-control':'public,max-age=60'});res.end();});
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});t.after(()=>{server.closeAllConnections();server.close();});
  const target={url:new URL(`http://127.0.0.1:${server.address().port}/image`),address:{address:'127.0.0.1',family:4}};
  const r=await requestHead(target,1000);assert.equal(r.statusCode,200);assert.equal(r.contentType,'image/png');assert.deepEqual(received[0],{method:'HEAD',cookie:undefined});
  target.url.pathname='/slow';await assert.rejects(requestHead(target,20));
});
