import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import {profileRuntime} from '../lib/runtime-profile.mjs';
import {inspectStandardsDOM} from '../lib/standards-observations.mjs';

test('real browser captures bounded settled-DOM defects and carousel exclusion',{skip:process.env.PERF_KIT_BROWSER_TESTS!=='1',timeout:60000},async t=>{
  const root=await mkdtemp('/private/tmp/perfkit-standards-browser-');
  const server=http.createServer((req,res)=>{
    if(req.url==='/style.css'){res.setHeader('content-type','text/css');res.end('body{margin:0}');return;}
    if(req.url?.endsWith('.svg')){res.setHeader('content-type','image/svg+xml');res.end('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="red"/></svg>');return;}
    res.setHeader('content-type','text/html');res.end(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"><link rel="stylesheet" href="/style.css"></head><body><main style="width:1200px"><h1>Browser fixture</h1><img id="hero" src="/a.svg" fetchpriority="high" width="100" height="100" sizes="400px"><img src="/b.svg" fetchpriority="high" width="100" height="100"><div hidden><img id="hidden" src="/c.svg"></div><div aria-roledescription="carousel" hidden><img id="slide" src="/d.svg"></div></main></body></html>`);
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(root,{recursive:true,force:true});});
  const p=await profileRuntime({config:{schemaVersion:1,url:`http://127.0.0.1:${server.address().port}/`,device:'mobile',settleMs:700,timeoutMs:45000,actions:[]},output:root+'/profile'});
  assert.equal(p.status,'complete',JSON.stringify(p.errors));assert.equal(p.initial.standardsDOM.truncated,false);
  const result=inspectStandardsDOM(p);
  for(const rule of ['PERF_IMAGE_PRIORITY_COUNT','PERF_DUPLICATE_STYLESHEET','PERF_MOBILE_OVERFLOW','PERF_IMAGE_SIZES_MISMATCH'])assert.ok(result.findings.some(f=>f.ruleId===rule),rule);
  assert.ok(!result.findings.some(f=>f.ruleId==='PERF_HIDDEN_IMAGE_DOWNLOAD'&&f.evidence[0].selector==='#slide'));
  assert.equal(result.checks.find(c=>c.id==='PERF_VIEWPORT_META').status,'PASS');
});
