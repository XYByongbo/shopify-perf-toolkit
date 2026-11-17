import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {auditQuality} from '../lib/quality-audit.mjs';
import {scanTheme} from '../lib/scan.mjs';
import {scanInventory} from '../lib/core/source-scan.mjs';
import {auditSEOSource,auditSEOHTML} from '../lib/seo/audit.mjs';
import {auditRenderedHTML} from '../lib/rendered-html.mjs';
import {verifySite} from '../lib/site-verify.mjs';

test('shared inventory and SEO rules preserve legacy findings and performance inspection',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'toolkit-split-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  await fs.mkdir(path.join(root,'layout'));await fs.writeFile(path.join(root,'layout/theme.liquid'),'<title></title><img src="image.jpg"><script src="main.js"></script>');
  const [legacy,seo,inventory,scan]=await Promise.all([auditQuality({project:root}),auditSEOSource({project:root}),scanInventory({project:root}),scanTheme({project:root})]);
  assert.deepEqual(seo.findings.map(f=>[f.ruleId,f.file,f.line]).sort(),legacy.findings.filter(f=>f.dimension==='seo'||f.ruleId==='Q-ALT').map(f=>[f.ruleId,f.file,f.line]).sort());
  assert.deepEqual(inventory.dependencies,scan.dependencies);assert.deepEqual(inventory.inventory.files.map(f=>[f.path,f.sha256]),scan.inventory.files.map(f=>[f.path,f.sha256]));
  assert.ok(scan.findings.length>0);assert.equal(inventory.findings,undefined);assert.ok(legacy.findings.some(f=>f.dimension==='performance'));
});
test('legacy HTML profile retains performance checks; SEO results cannot become score evidence',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'toolkit-split-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const input=path.join(root,'page.html');await fs.writeFile(input,'<!doctype html><html lang="en"><head><title>Page</title><link rel="canonical" href="https://example.com"><meta name="description" content="Page"></head><body><h1>Page</h1><script src="x.js"></script></body></html>');
  const legacy=await auditRenderedHTML({input}),seo=await auditSEOHTML({input});
  assert.ok(legacy.findings.some(f=>f.code==='parser-blocking-script'));assert.equal(seo.findings.length,0);
  const filename=path.join(root,'seo.json');await fs.writeFile(filename,JSON.stringify(seo));
  assert.equal((await verifySite({before:filename,after:filename})).outcome,'invalid-evidence');
});
test('legacy module entry points preserve the shared function exports',async()=>{
  for(const [legacy,core,names]of [
    ['source-utils','source-utils',['sha256','lineAt','isInside']],
    ['bounded-process','bounded-process',['runProcess']],
    ['check-import','source-reader',['readThemeSource']],
    ['inspect','html-source',['maskNonRendering','htmlTagEnd','readAttributes','inspectImages']],
    ['rendered-html','rendered-html',['auditRenderedHTML','validateRenderedHTMLAudit']],
  ]){
    const old=await import('../lib/'+legacy+'.mjs'),shared=await import('../lib/core/'+core+'.mjs');
    for(const name of names)assert.equal(old[name],shared[name],legacy+':'+name);
  }
});
