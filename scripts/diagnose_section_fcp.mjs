#!/usr/bin/env node
// One fixed alternating 3+3 batch to diagnose task-boundary variation, never acceptance sampling.
import http from 'node:http';
import path from 'node:path';
import {mkdtemp,readFile,writeFile,cp} from 'node:fs/promises';
import {measureSite} from '../lib/measure.mjs';
const old=process.argv[2];
if(!old)throw new Error('Pass the retained extended recovery fixture directory (baseline and step-6/experiment/plan.json).');
const root=await mkdtemp('/private/tmp/perfkit-section-fcp-'),projects={1:path.join(root,'baseline'),2:path.join(root,'legacy')};
await cp(path.join(old,'baseline'),projects[1],{recursive:true});await cp(projects[1],projects[2],{recursive:true});
const plan=JSON.parse(await readFile(path.join(old,'step-6/experiment/plan.json'),'utf8'));
for(const c of plan.changes)await writeFile(path.join(projects[2],c.target),c.after);
const server=http.createServer(async(req,res)=>{
 try{
  const u=new URL(req.url,'http://fixture.test'),id=u.searchParams.get('preview_theme_id')??new URL(req.headers.referer??u.href).searchParams.get('preview_theme_id')??'1';res.setHeader('Cache-Control','no-store');
  if(u.pathname==='/favicon.ico'){res.writeHead(204);res.end();return;}
  if(u.pathname.startsWith('/assets/')){res.setHeader('Content-Type','text/javascript');res.end(await readFile(path.join(projects[id],u.pathname.slice(1))));return;}
  const section='<div id="shopify-section-template--123__main"><div id="hero"><h1>Complete unchanged section content</h1><button id="open">Open details</button><p id="more" hidden>Full product detail</p></div></div>';
  if(u.searchParams.has('data')){const scoped=u.searchParams.has('section_id')||u.searchParams.has('sections');await new Promise(r=>setTimeout(r,scoped?60:900));res.setHeader('Content-Type',u.searchParams.has('sections')?'application/json':'text/html');res.end(u.searchParams.has('sections')?JSON.stringify({'template--123__main':section}):scoped?section:'<!doctype html><html><body>'+section+'<!--'+'unused page '.repeat(15000)+'--></body></html>');return;}
  res.setHeader('Content-Type','text/html');res.end('<!doctype html><html lang="en"><head><title>Bounded recovery fixture</title><meta name="viewport" content="width=device-width,initial-scale=1"><script>window.Shopify={theme:{id:'+id+'},shop:"fixture.myshopify.com"};</script><style>body{font-family:sans-serif}h1{font-size:54px}button{padding:12px}</style></head><body>'+await readFile(path.join(projects[id],'sections/main.liquid'),'utf8')+'</body></html>');
 }catch(error){res.writeHead(500);res.end(error.message);}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
console.log(JSON.stringify({root,maximumNavigations:6,purpose:'diagnosis-only-no-acceptance',schedule:[1,2,2,1,1,2]}));
try{
 for(const [index,id] of [1,2,2,1,1,2].entries()){
  const dir=path.join(root,`sample-${index+1}-${id===1?'before':'after'}`);
  const url=`http://127.0.0.1:${server.address().port}/fr/collections/all?preview_theme_id=${id}&sort_by=title-ascending`;
  const result=await measureSite({output:dir,config:{schemaVersion:1,engine:'lighthouse',purpose:'exploration',pages:[{id:'home',url}],devices:['mobile'],runs:1,timeoutMs:60000}});
  if(result.status!=='complete')throw new Error(JSON.stringify(result));
  const r=JSON.parse(await readFile(path.join(dir,result.groups[0].reports[0]),'utf8'));
  console.log(JSON.stringify({side:id,fcp:r.audits['first-contentful-paint'].numericValue,lcp:r.audits['largest-contentful-paint'].numericValue,observed:r.audits.metrics.details.items[0].observedFirstContentfulPaint,diagnostics:result.groups[0].attempts[0].diagnostics}));
 }
}finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
