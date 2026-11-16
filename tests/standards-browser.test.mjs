import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp,rm,mkdir,writeFile,readFile} from 'node:fs/promises';
import {profileRuntime} from '../lib/runtime-profile.mjs';
import {inspectStandardsDOM} from '../lib/standards-observations.mjs';
import {runBatch} from '../lib/batch.mjs';
import {auditSite} from '../lib/site-audit.mjs';
import {auditQuality} from '../lib/quality-audit.mjs';
import {siteRun} from './helpers/site-run.mjs';

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

test('batch runs installed Shopify Theme Check and keeps official findings separate from formal scores',{skip:process.env.PERF_KIT_THEME_CHECK_TESTS!=='1',timeout:120000},async t=>{
  const root=await mkdtemp('/private/tmp/perfkit-standards-official-');t.after(()=>rm(root,{recursive:true,force:true}));
  const project=root+'/theme', output=root+'/batch';
  const source='<!doctype html><html><head>{{ content_for_header }}</head><body><img src="/image.png" alt="Fixture">{{ content_for_layout }}</body></html>';
  const configuration='extends: theme-check:recommended\nAssetSizeCSS:\n  enabled: true\n  thresholdInBytes: 100000\nAssetSizeJavaScript:\n  enabled: true\n  thresholdInBytes: 10000\n';
  await mkdir(project+'/layout',{recursive:true});
  await writeFile(project+'/layout/theme.liquid',source);
  await writeFile(project+'/.theme-check.yml',configuration);
  const before=await siteRun(t,{devices:['mobile'],scores:{mobile:[82]}});
  const after=await siteRun(t,{devices:['mobile'],scores:{mobile:[89]},offset:20});
  const batch=await runBatch({config:{schemaVersion:1,project,checks:{run:true},resources:false,quality:true,
    before:before.root,run:after.root},output});
  assert.equal(batch.status,'complete',JSON.stringify(batch.error));
  assert.equal(batch.acceptance,'score-targets-met');
  assert.equal(batch.diagnostics.checks.status,'review-required');
  assert.equal(batch.reviewRequired,true);
  const result=JSON.parse(await readFile(output+'/checks.json','utf8'));
  assert.equal(result.complete,true);
  assert.ok(result.requiredChecks.every(c=>c.status==='enabled'),JSON.stringify(result.requiredChecks));
  assert.equal(result.execution.commands.length,5);
  assert.match(result.metadata.rulesConfig.effectiveConfiguration,/thresholdInBytes: 100000/);
  assert.ok(result.findings.some(f=>f.ruleId==='ImgWidthAndHeight'&&f.file==='layout/theme.liquid'));
  assert.equal(await readFile(project+'/layout/theme.liquid','utf8'),source);
  assert.equal(await readFile(project+'/.theme-check.yml','utf8'),configuration);
  const audit=JSON.parse(await readFile(output+'/audit.json','utf8'));
  assert.equal(audit.supplemental.find(s=>s.kind==='check-import')?.status,'current-source');
  const html=await readFile(output+'/audit.html','utf8');
  assert.match(html,/Shopify 官方 Theme Check/);
  assert.match(html,/ImgWidthAndHeight/);
  const quality=JSON.parse(await readFile(output+'/quality.json','utf8'));
  assert.equal(quality.summary.checkerCurrent,true);
  await writeFile(project+'/.theme-check.yml',configuration.replace('100000','200000'));
  const stale=await auditSite({project,run:after.root,checks:result});
  assert.equal(stale.supplemental.find(s=>s.kind==='check-import')?.status,'stale');
  assert.equal(stale.supplemental.find(s=>s.kind==='performance-audit')?.report.intelligence.waivers.sourceStatus,'stale-or-incomplete-checker-report');
  assert.equal((await auditQuality({project,checks:result})).summary.checkerCurrent,false);
});
