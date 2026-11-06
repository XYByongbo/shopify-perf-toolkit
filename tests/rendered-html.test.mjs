import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm,realpath,mkdir} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {auditRenderedHTML,validateRenderedHTMLAudit} from '../lib/rendered-html.mjs';
import {renderReport} from '../lib/report.mjs';
import {compactArtifact} from '../lib/summary.mjs';
import {runBatch} from '../lib/batch.mjs';
import {siteRun} from './helpers/site-run.mjs';

const cli=fileURLToPath(new URL('../scripts/perfkit.mjs',import.meta.url));
const good='<!doctype html><html lang="en"><head><title>Product</title><meta name="description" content="Details"><link rel="canonical" href="https://shop.example.test/product"></head><body><h1>Product</h1></body></html>';
async function fixture(t,contents=good) {
  const root=await realpath(await mkdtemp(path.join(os.tmpdir(),'perfkit-html-')));t.after(()=>rm(root,{recursive:true,force:true}));
  const input=path.join(root,'rendered.html');await writeFile(input,contents);return {root,input};
}

test('saved HTML has byte-bound input evidence, compact diagnostics and no performance acceptance',async t=>{
  const content='\ufeff'+good,f=await fixture(t,content),r=await auditRenderedHTML({input:f.input});
  assert.equal(r.kind,'rendered-html-audit');assert.equal(r.reviewRequired,false);assert.equal(r.acceptance,'not-evaluated');
  assert.equal(r.sourceAssociation,'unverified-saved-html');
  assert.equal(r.input.sha256,createHash('sha256').update(content).digest('hex'));
  assert.equal(await readFile(f.input,'utf8'),content);
  assert.equal(compactArtifact(r).summary.errors,0);
});

test('fragment and caller-identified LCP stay explicit; HTML findings render as escaped text',async t=>{
  const f=await fixture(t,'<div id="a"></div><div id="a"></div><img id="hero" src="a.jpg" width="100" height="50" alt="A" loading="lazy">');
  const r=await auditRenderedHTML({input:f.input,fragment:true,lcpId:'hero'});
  assert.equal(r.scope,'fragment');assert.equal(r.input.callerLcpId,'hero');assert.equal(r.reviewRequired,true);
  assert.ok(r.findings.some(f=>f.code==='duplicate-id'));assert.ok(r.findings.some(f=>f.code==='lcp-lazy'));
  assert.ok(!r.findings.some(f=>f.code==='title-count'));
  const report=renderReport({...r,input:{...r.input,file:'<script>alert(1)</script>'}});
  assert.ok(report.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));assert.ok(report.includes('渲染后 HTML 审查'));
  assert.ok(!report.includes('<script>alert(1)</script>'));
});

test('CLI retains review diagnostics, refuses overwrite and rejects invalid inputs',async t=>{
  const f=await fixture(t,'<div id="x"></div><div id="x"></div>'),out=path.join(f.root,'audit.json');
  const args=['audit-html','--input',f.input,'--fragment','true','--out',out];
  const run=(...a)=>spawnSync(process.execPath,[cli,...a],{encoding:'utf8'});
  const r=run(...args);assert.equal(r.status,3,r.stderr);assert.equal(JSON.parse(await readFile(out,'utf8')).summary.errors,1);
  assert.equal(run(...args).status,2);
  assert.equal(run('audit-html','--input',f.input,'--fragment','yes','--out',path.join(f.root,'bad.json')).status,2);
  const liquid=path.join(f.root,'source.liquid');await writeFile(liquid,'{{ product.title }}');
  await assert.rejects(auditRenderedHTML({input:liquid}),/rendered/);
  await assert.rejects(auditRenderedHTML({input:'relative.html'}),/absolute/);
  await assert.rejects(auditRenderedHTML({input:f.input,lcpId:''}),/LCP/);
});

test('batch HTML review cannot be hidden by passing scores and cannot replace failed scoring',async t=>{
  const f=await fixture(t,'<div id="x"></div><div id="x"></div>');
  const before=await siteRun(t,{devices:['mobile'],scores:{mobile:[85]}});
  const after=await siteRun(t,{devices:['mobile'],scores:{mobile:[85]},offset:20});
  const config={schemaVersion:1,run:after.root,before:before.root,renderedHtml:[{input:f.input,fragment:true}],budget:{maxWallTimeMs:20000}};
  const output=path.join(f.root,'review'),r=await runBatch({config,output});
  assert.equal(r.status,'complete');assert.equal(r.acceptance,'score-targets-met');assert.equal(r.reviewRequired,true);
  assert.equal(r.diagnostics.renderedHtml.status,'review-required');
  assert.equal(JSON.parse(await readFile(path.join(output,'rendered-html-1.json'),'utf8')).sourceAssociation,'unverified-saved-html');
  assert.ok((await readFile(path.join(output,'rendered-html-1.html'),'utf8')).includes('输入指纹'));
  const low=await siteRun(t,{devices:['mobile'],scores:{mobile:[60]},offset:40});await writeFile(f.input,good);
  const failed=await runBatch({config:{...config,run:low.root,renderedHtml:[{input:f.input}]},output:path.join(f.root,'failed-score')});
  assert.equal(failed.diagnostics.renderedHtml.status,'complete');assert.notEqual(failed.acceptance,'score-targets-met');
});

test('multiple HTML inputs retain separate transports and reach the final site report without claiming source identity',async t=>{
  const f=await fixture(t),second=path.join(f.root,'section.html');
  await writeFile(second,'<div id="repeated"></div><div id="repeated"></div>');
  const project=path.join(f.root,'theme');await mkdir(path.join(project,'sections'),{recursive:true});
  await writeFile(path.join(project,'sections/main.liquid'),'<section>Keep</section>');
  const before=await siteRun(t,{devices:['mobile'],scores:{mobile:[85]}}),after=await siteRun(t,{devices:['mobile'],scores:{mobile:[85]},offset:20});
  const output=path.join(f.root,'multi');
  const r=await runBatch({config:{schemaVersion:1,project,resources:false,run:after.root,before:before.root,
    renderedHtml:[{input:f.input},{input:second,fragment:true}],budget:{maxWallTimeMs:20000}},output});
  assert.equal(r.status,'complete',JSON.stringify(r.error));
  assert.equal(r.diagnostics.renderedHtml.completed,2);assert.equal(r.diagnostics.renderedHtml.inputs,2);
  assert.equal(r.reviewRequired,true);assert.equal(r.acceptance,'score-targets-met');
  for(const index of [1,2])assert.ok([0,3].includes(JSON.parse(await readFile(path.join(output,`rendered-html-${index}.transport.json`),'utf8')).exitCode));
  const audit=JSON.parse(await readFile(path.join(output,'audit.json'),'utf8'));
  const html=audit.supplemental.filter(r=>r.kind==='rendered-html-audit');
  assert.equal(html.length,2);assert.ok(html.every(r=>r.status==='unverified-source'));
  assert.ok(!audit.findings.some(r=>r.ruleId?.startsWith('HTML-')));
  const report=await readFile(path.join(output,'audit.html'),'utf8');
  assert.ok(report.includes('duplicate-id'));assert.ok(report.includes('repeated'));
});

test('a later HTML input failure retains completed findings and cannot report the matrix complete',async t=>{
  const f=await fixture(t),after=await siteRun(t,{devices:['mobile']});
  const r=await runBatch({config:{schemaVersion:1,run:after.root,renderedHtml:[{input:f.input},{input:path.join(f.root,'missing.html')}]},output:path.join(f.root,'partial')});
  assert.equal(r.status,'failed');assert.equal(r.acceptance,'not-evaluated');
  assert.equal(r.diagnostics.renderedHtml.status,'failed');assert.equal(r.diagnostics.renderedHtml.completed,1);
  assert.equal(r.diagnostics.renderedHtml.inputs,2);assert.equal(r.diagnostics.renderedHtml.reports.length,1);
  assert.equal(r.diagnostics.renderedHtml.failedArtifact,'rendered-html-2.json');
  assert.equal(compactArtifact(r).diagnostics.renderedHtml.completed,1);
});

test('saved HTML contracts reject fabricated clean totals and source verification claims',async t=>{
  const f=await fixture(t,'<div id="a"></div><div id="a"></div>');
  const report=await auditRenderedHTML({input:f.input,fragment:true});
  for(const mutate of [r=>r.sourceAssociation='verified-bytes',r=>r.reviewRequired=false,r=>r.summary.errors=0,
    r=>r.findings=[],r=>r.input.sha256='unknown',r=>r.acceptance='optimization-accepted']) {
    const changed=structuredClone(report);mutate(changed);assert.throws(()=>validateRenderedHTMLAudit(changed));
  }
});
