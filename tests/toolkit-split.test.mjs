import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {parse} from 'acorn';
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
test('SEO permits its pinned Liquid parser; shared core remains builtin-only with no reverse dependencies',async()=>{
  const root=new URL('../',import.meta.url),visited=new Set();
  function walk(n,visit){if(!n||typeof n!=='object')return;visit(n);for(const v of Object.values(n)){if(Array.isArray(v))v.forEach(x=>walk(x,visit));else if(v&&typeof v==='object')walk(v,visit);}}
  async function visit(file){if(visited.has(file))return;visited.add(file);const code=await fs.readFile(new URL(file,root),'utf8'),deps=[];
    walk(parse(code,{ecmaVersion:'latest',sourceType:'module'}),n=>{if(['ImportDeclaration','ImportExpression','ExportNamedDeclaration','ExportAllDeclaration'].includes(n.type)&&n.source){assert.equal(typeof n.source.value,'string','All SEO module imports are statically traceable');deps.push(n.source.value);}});
    for(const dep of deps){if(dep.startsWith('node:'))continue;if(file.startsWith('lib/seo/')&&dep==='@shopify/liquid-html-parser')continue;assert.ok(dep.startsWith('.'),'No external runtime dependency: '+dep);const resolved=path.posix.normalize(path.posix.join(path.posix.dirname(file),dep));assert.match(resolved,/^(lib\/(core|seo)\/|scripts\/seokit\.mjs$)/);if(file.startsWith('lib/core/'))assert.match(resolved,/^lib\/core\//,'Shared core must not import either product');await visit(resolved);}
  }
  for(const file of await fs.readdir(new URL('lib/core/',root)))if(file.endsWith('.mjs'))await visit('lib/core/'+file);
  await visit('scripts/seokit.mjs');assert.ok(visited.has('lib/core/source-scan.mjs'));
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
