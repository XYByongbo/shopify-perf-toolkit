import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {auditSEOSource,auditSEOHTML,validateSEOAudit} from '../lib/seo/audit.mjs';
import {renderSEOReport} from '../lib/seo/report.mjs';
import {runSEOBatch} from '../lib/seo/batch.mjs';
const execute=promisify(execFile),cli=fileURLToPath(new URL('../scripts/seokit.mjs',import.meta.url));
const page='<!doctype html><html lang="en"><head><title>Example</title><meta name="description" content="Example"><link rel="canonical" href="https://example.com/"></head><body><h1>Example</h1></body></html>';
async function fixture(t,files={}){const base=await fs.mkdtemp(path.join(os.tmpdir(),'seokit-test-'));t.after(()=>fs.rm(base,{recursive:true,force:true}));const project=path.join(base,'theme');await fs.mkdir(project);for(const [name,text]of Object.entries(files)){await fs.mkdir(path.dirname(path.join(project,name)),{recursive:true});await fs.writeFile(path.join(project,name),text);}return {base,project};}

test('SEO source audit runs without measurement and ignores unrelated JS/CSS parser errors',async t=>{
  const {project}=await fixture(t,{'layout/theme.liquid':'<html lang="en"><head>{% render "meta" %}</head></html>',
    'snippets/meta.liquid':'<title>{{ page_title }}</title><meta name="description" content="{{ page_description }}"><link rel="canonical" href="{{ canonical_url }}"><meta property="og:title" content="Example"><script type="application/ld+json">{{ product | structured_data }}</script>',
    'assets/bad.js':'function {', 'assets/bad.css':'a{'});
  const report=validateSEOAudit(await auditSEOSource({project}));
  assert.equal(report.complete,true);assert.equal(report.findings.length,0);assert.equal(report.acceptance,'not-evaluated');
  assert.ok(report.observations.some(o=>o.check==='structured-data'&&o.status==='render-required'));
  assert.equal(report.sourceManifest.length,4);
});
test('source scope, skipped entries and fingerprint contracts remain explicit',async t=>{
  const {project,base}=await fixture(t,{'layout/theme.liquid':'<title></title>{% render name %}', 'layout/password.liquid':'{{ content_for_layout }}'});
  await fs.writeFile(path.join(base,'outside.liquid'),'<title>External</title>');await fs.symlink(path.join(base,'outside.liquid'),path.join(project,'layout/alias.liquid'));
  const report=validateSEOAudit(await auditSEOSource({project}));assert.equal(report.complete,false);
  assert.ok(report.findings.some(f=>f.ruleId==='Q-SEO-EMPTY-TITLE'));assert.ok(!report.findings.some(f=>f.file==='layout/password.liquid'));
  for(const mutation of [r=>r.summary.findings=0,r=>r.complete=true,r=>r.sourceHash='0'.repeat(64),r=>r.acceptance='passed',r=>r.findings[0].sourceHash='0'.repeat(64)]){
    const changed=structuredClone(report);mutation(changed);assert.throws(()=>validateSEOAudit(changed));
  }
});
test('SEO HTML filtering happens before truncation and excludes performance-only warnings',async t=>{
  const {base}=await fixture(t);const input=path.join(base,'page.html');
  await fs.writeFile(input,page.replace('</body>', '<script src="x.js"></script>'.repeat(220)+'<img src="a.jpg" alt="">'+'</body>'));
  const clean=validateSEOAudit(await auditSEOHTML({input}));assert.equal(clean.summary.findings,0);assert.equal(clean.findingsTruncated,false);
  await fs.writeFile(input,(await fs.readFile(input,'utf8')).replace('</body>','<script type="application/ld+json">{bad}</script></body>'));
  const bad=validateSEOAudit(await auditSEOHTML({input}));assert.equal(bad.summary.findings,1);assert.equal(bad.findings[0].code,'jsonld-invalid');
  assert.equal(bad.sourceAssociation,'unverified-saved-html');assert.equal(bad.acceptance,'not-evaluated');
});
test('HTML scope, honest truncation and forged clean summaries are enforced',async t=>{
  const {base}=await fixture(t);const input=path.join(base,'fragment.html');await fs.writeFile(input,'<title>Wrong owner</title>');
  const fragment=validateSEOAudit(await auditSEOHTML({input,fragment:true}));assert.deepEqual(fragment.findings.map(f=>f.code),['fragment-page-metadata']);
  await fs.writeFile(input,page.replace('</body>','<img src="x">'.repeat(220)+'</body>'));
  const report=validateSEOAudit(await auditSEOHTML({input}));assert.equal(report.summary.findings,220);assert.equal(report.findings.length,200);assert.equal(report.complete,false);
  for(const mutation of [r=>r.sourceAssociation='verified',r=>r.summary.findings=0,r=>r.findingsTruncated=false,r=>r.complete=true]){
    const changed=structuredClone(report);mutation(changed);assert.throws(()=>renderSEOReport(changed));
  }
});
test('SEO CLI handles review exits, unsafe output, duplicate args and report escaping',async t=>{
  const {base,project}=await fixture(t,{'layout/theme.liquid':'<title></title>'});const out=path.join(base,'source.json');
  await assert.rejects(execute(process.execPath,[cli,'audit-source','--project',project,'--out',out]),e=>e.code===3);
  const report=JSON.parse(await fs.readFile(out,'utf8'));report.findings[0].summary='<script>alert(1)</script>';
  const html=renderSEOReport(report);assert.ok(html.includes('&lt;script&gt;'));assert.ok(!html.includes('<script>alert'));
  await assert.rejects(execute(process.execPath,[cli,'audit-source','--project',project,'--out',out]),e=>e.code===2);
  await assert.rejects(execute(process.execPath,[cli,'audit-source','--project',project,'--out',path.join(project,'audit.json')]),e=>e.code===2);
  for(const command of ['report','report-pdf'])await assert.rejects(execute(process.execPath,[cli,command,'--input',out,'--out',path.join(project,'report.'+(command==='report'?'html':'pdf'))]),e=>e.code===2);
  const alias=path.join(base,'theme-alias');await fs.symlink(project,alias);
  await assert.rejects(execute(process.execPath,[cli,'report','--input',out,'--out',path.join(alias,'nested/report.html')]),e=>e.code===2);
  await execute(process.execPath,[cli,'report','--input',out,'--out',path.join(base,'report.html')]);
  await fs.rename(project,path.join(base,'moved-theme'));
  await execute(process.execPath,[cli,'report','--input',out,'--out',path.join(base,'archived-report.html')]);
  await assert.rejects(execute(process.execPath,[cli,'report','--input',out,'--out',path.join(project,'report.html')]),e=>e.code===2);
  await assert.rejects(execute(process.execPath,[cli,'doctor','--out','x']),e=>e.code===2);
  await assert.rejects(execute(process.execPath,[cli,'audit-source','--project',project,'--project',project,'--out',path.join(base,'x.json')]),e=>e.code===2);
});
test('SEO batch requires no measurements, preserves completed inputs on later failure',async t=>{
  const {base}=await fixture(t);const input=path.join(base,'page.html');await fs.writeFile(input,page);
  const out=path.join(base,'run');const result=await runSEOBatch({config:{schemaVersion:1,renderedHtml:[{input},{input:path.join(base,'missing.html')}]},output:out});
  assert.equal(result.status,'failed');assert.equal(result.completed,1);assert.equal(result.inputs,2);assert.equal(result.complete,false);assert.equal(result.acceptance,'not-evaluated');
  assert.ok((await fs.readFile(path.join(out,'seo-1.html'),'utf8')).includes('Shopify SEO'));
  await assert.rejects(runSEOBatch({config:{schemaVersion:1,measurement:{}},output:path.join(base,'invalid')}));
  await assert.rejects(fs.stat(path.join(base,'invalid')));
});
test('source-only and HTML-only batches finish independently and do not mutate input',async t=>{
  const {base,project}=await fixture(t,{'layout/theme.liquid':page.replace('</head>','<meta property="og:title" content="Example"></head>')});
  const before=await fs.readFile(path.join(project,'layout/theme.liquid'));
  const result=await runSEOBatch({config:{schemaVersion:1,project},output:path.join(base,'source-run')});
  assert.equal(result.status,'audit-complete');assert.equal(result.completed,1);assert.deepEqual(await fs.readFile(path.join(project,'layout/theme.liquid')),before);
});
test('empty theme cannot be reported as a complete SEO audit',async t=>{
  const {project}=await fixture(t);const report=validateSEOAudit(await auditSEOSource({project}));assert.equal(report.complete,false);assert.equal(report.reviewRequired,true);
});
test('SEO doctor keeps source audit available with a missing or incompatible Python',async t=>{
  const {base}=await fixture(t);const python=path.join(base,'python');
  for(const text of ['Python 3.8.20','v22.21.1']){
    await fs.writeFile(python,`#!${process.execPath}\nconsole.log(${JSON.stringify(text)});\n`,{mode:0o700});
    const {stdout}=await execute(process.execPath,[cli,'doctor'],{env:{...process.env,SEOKIT_PYTHON:python}});
    const doctor=JSON.parse(stdout);assert.equal(doctor.sourceAudit,true);assert.equal(doctor.htmlAudit,false);
  }
  const {stdout}=await execute(process.execPath,[cli,'doctor'],{env:{...process.env,SEOKIT_PYTHON:path.join(base,'missing')}});
  assert.equal(JSON.parse(stdout).pythonAvailable,false);
});
test('SEO batch deadline stops work, records partial progress and kills the HTML interpreter', {skip:process.platform==='win32',timeout:15000},async t=>{
  const {base,project}=await fixture(t,{'layout/theme.liquid':page});
  const python=path.join(base,'python'),pidfile=path.join(base,'pid'),config=path.join(base,'config.json'),output=path.join(base,'deadline');
  await fs.writeFile(python,`#!${process.execPath}\nimport {writeFileSync} from 'node:fs';\nwriteFileSync(${JSON.stringify(pidfile)},String(process.pid));\nsetTimeout(()=>console.log('{}'),10000);\n`,{mode:0o700});
  await fs.writeFile(config,JSON.stringify({schemaVersion:1,project,renderedHtml:[{input:path.join(base,'page.html')}],timeoutMs:2500}));
  let pid;t.after(()=>{if(pid)try{process.kill(pid,'SIGKILL');}catch{}});
  await assert.rejects(execute(process.execPath,[cli,'batch','--config',config,'--out',output],{env:{...process.env,SEOKIT_PYTHON:python}}),e=>e.code===3);
  const result=JSON.parse(await fs.readFile(path.join(output,'batch.json'),'utf8'));
  assert.equal(result.status,'stopped');assert.equal(result.failure.code,'WALL_TIME_BUDGET');assert.equal(result.completed,1);assert.equal(result.complete,false);assert.equal(result.reviewRequired,true);assert.equal(result.acceptance,'not-evaluated');
  assert.ok((await fs.readFile(path.join(output,'index.html'),'utf8')).includes('stopped'));
  pid=Number(await fs.readFile(pidfile,'utf8'));assert.ok(pid>0);
  for(let i=0;i<10;i++){try{process.kill(pid,0);await new Promise(r=>setTimeout(r,50));}catch(e){assert.equal(e.code,'ESRCH');pid=null;break;}}
  assert.equal(pid,null,'HTML interpreter must not survive the batch deadline');
});
test('inert and SVG metadata cannot hide missing document declarations or create SEO findings',async t=>{
  const {project}=await fixture(t,{'layout/theme.liquid':'<html lang="en"><head></head><body><svg><title>Icon</title></svg><template><title></title><meta name="description" content="x"><link rel="canonical" href="https://example.com"><img src="x"></template><noscript><title>Fallback</title></noscript></body></html>'});
  const report=validateSEOAudit(await auditSEOSource({project}));
  for(const id of ['Q-SEO-TITLE','Q-SEO-DESCRIPTION','Q-SEO-CANONICAL'])assert.ok(report.findings.some(f=>f.ruleId===id),id);
  assert.ok(!report.findings.some(f=>['Q-SEO-EMPTY-TITLE','Q-ALT'].includes(f.ruleId)));
});
test('report validation rejects contradictory coverage and unbound observations',async t=>{
  const {project}=await fixture(t,{'layout/theme.liquid':page});
  const report=await auditSEOSource({project});
  const reordered=structuredClone(report);reordered.summary=Object.fromEntries(Object.entries(report.summary).reverse());assert.equal(validateSEOAudit(reordered),reordered);
  for(const mutate of [r=>r.coverage.sourceScanComplete=false,r=>r.coverage.layoutFiles=[],r=>r.coverage.runtime='verified',r=>{r.observations.push({file:'missing.liquid',line:1});r.summary.observations++;}]){
    const copy=structuredClone(report);mutate(copy);assert.throws(()=>validateSEOAudit(copy));
  }
});
test('truncated HTML evidence must retain the promised 200 details',async t=>{
  const {base}=await fixture(t);const input=path.join(base,'truncated.html');await fs.writeFile(input,page.replace('</body>','<img src="x">'.repeat(220)+'</body>'));
  const report=await auditSEOHTML({input});report.findings.pop();assert.throws(()=>validateSEOAudit(report));
});
