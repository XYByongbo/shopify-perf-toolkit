#!/usr/bin/env node
/** Real Lighthouse against an isolated synthetic Shopify-shaped fixture, never a store score claim. */
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { measureSite } from '../lib/measure.mjs';
import { auditSite } from '../lib/site-audit.mjs';
import { verifySite } from '../lib/site-verify.mjs';
import { createSitePlan, applySitePlan, rollbackSitePlan } from '../lib/site-changes.mjs';
import { capturePage } from '../lib/capture.mjs';
import { compareCaptures } from '../lib/compare.mjs';
import { runScenarios } from '../lib/scenarios.mjs';
import { renderReport } from '../lib/report.mjs';

const argv=process.argv.slice(2);
if(argv.length && (argv.length!==2 || argv[0]!=='--out')) throw new Error('Usage: node scripts/validate_site_pipeline.mjs [--out <NEW-directory>]');
let output;
if(argv.length) {output=path.resolve(argv[1]);await fs.mkdir(output,{recursive:false});output=await fs.realpath(output);}
else output=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'perfkit-site-pipeline-')));
const theme=path.join(output,'fixture-theme');
for(const dir of ['assets','layout','templates','sections'])await fs.mkdir(path.join(theme,dir),{recursive:true});
const save=async(name,value)=>fs.writeFile(path.join(output,name),typeof value==='string'?value:JSON.stringify(value,null,2)+'\n',{flag:'wx'});
const hash=value=>createHash('sha256').update(value).digest('hex');
const jsBefore=`// Synthetic fixture: redundant layout work and repeated initialization.
function initializeCards(){
  const cards=document.querySelectorAll('.card');
  for(let pass=0;pass<120;pass++) for(const card of cards){card.style.setProperty('--card-pad',pass%2?'16px':'17px');void card.offsetHeight;}
  document.querySelector('#details').addEventListener('click',()=>{document.querySelector('#panel').hidden=!document.querySelector('#panel').hidden;});
}
document.addEventListener('DOMContentLoaded',()=>{initializeCards();initializeCards();initializeCards();});
`;
const jsAfter=`// Reviewed fixture candidate: one initialization, one batched style update.
function initializeCards(){
  const button=document.querySelector('#details');if(button.dataset.initialized)return;button.dataset.initialized='true';
  for(const card of document.querySelectorAll('.card'))card.style.setProperty('--card-pad','16px');
  button.addEventListener('click',()=>{document.querySelector('#panel').hidden=!document.querySelector('#panel').hidden;});
}
document.addEventListener('DOMContentLoaded',initializeCards);
`;
const baseCss='body{margin:0;font:16px system-ui;color:#18262f;background:#f6f7f9}main{max-width:960px;margin:auto;padding:24px}h1{font-size:32px}.grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px}.card{padding:var(--card-pad,16px);background:white;border:1px solid #dde3e8;border-radius:8px}button{padding:12px 20px} @media(max-width:600px){.grid{grid-template-columns:repeat(2,minmax(0,1fr))}}\n';
const duplicateRule='.card{padding:var(--card-pad,16px);background:white;border:1px solid #dde3e8;border-radius:8px}\n';
const cssBefore=baseCss+duplicateRule.repeat(3000),cssAfter=baseCss+duplicateRule;
const layout='<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Performance fixture</title>\n{{ content_for_header }}\n<link rel="stylesheet" href="/assets/theme.css"><script src="/assets/theme.js"></script></head><body><main id="fixture"><h1>__TITLE__</h1><p>Isolated toolkit validation. These are synthetic products.</p><button id="details">View details</button><p id="panel" hidden>Fixture details</p><div class="grid">'+Array.from({length:24},(_,i)=>`<article class="card"><h2>Product ${i+1}</h2><p>Same content before and after.</p></article>`).join('')+'</div></main></body></html>';
await fs.writeFile(path.join(theme,'assets/theme.js'),jsBefore);
await fs.writeFile(path.join(theme,'assets/theme.css'),cssBefore);
await fs.writeFile(path.join(theme,'layout/theme.liquid'),layout);
await fs.writeFile(path.join(theme,'templates/index.json'),JSON.stringify({sections:{main:{type:'main'}},order:['main']}));
await fs.writeFile(path.join(theme,'sections/main.liquid'),'<section><h1>{{ page_title }}</h1></section>\n{% schema %}{"name":"Fixture"}{% endschema %}\n');
const server=createServer(async(req,res)=>{
  try {
    if(req.method!=='GET'&&req.method!=='HEAD'){res.writeHead(405);res.end();return;}
    const url=new URL(req.url,'http://127.0.0.1');
    if(['/assets/theme.js','/assets/theme.css'].includes(url.pathname)){
      res.writeHead(200,{'Content-Type':url.pathname.endsWith('.js')?'text/javascript':'text/css','Cache-Control':'no-store'});
      res.end(await fs.readFile(path.join(theme,url.pathname.slice(1))));
    }else if(url.pathname==='/'||url.pathname==='/products/fixture'){
      res.writeHead(200,{'Content-Type':'text/html','Cache-Control':'no-store'});
      res.end(layout.replace('{{ content_for_header }}','').replace('__TITLE__',url.pathname==='/'?'Fixture collection':'Fixture product'));
    }else {res.writeHead(url.pathname==='/favicon.ico'?204:404);res.end();}
  }catch(error){res.writeHead(500);res.end('Fixture server error');}
});
await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
const origin=`http://127.0.0.1:${server.address().port}`;
const config={schemaVersion:1,engine:'lighthouse',pages:[{id:'home',url:origin+'/'},{id:'product',url:origin+'/products/fixture'}],devices:['mobile','desktop'],runs:5,timeoutMs:120000};
await save('measurement-config.json',config);
let plan,applied=false;
try {
  console.log(JSON.stringify({stage:'baseline',output}));
  const before=await measureSite({config,output:path.join(output,'before'),onProgress:p=>console.log(JSON.stringify(p))});
  assert.equal(before.status,'complete','Baseline measurement failed; inspect its run.json');
  const audit=await auditSite({project:theme,run:path.join(output,'before')});
  await save('audit.json',audit);await save('audit.html',renderReport(audit));
  const baselineCapture=await capturePage({url:origin+'/',selector:'#fixture',output:path.join(output,'capture-before'),waitMs:100,viewport:{width:390,height:844}});
  const recipe={schemaVersion:1,changes:[
    {target:'assets/theme.js',kind:'reviewed-replacement',replacementText:jsAfter,reason:'Remove repeated initialization and redundant synchronous layout work in the isolated fixture.',evidence:{summary:'Fixture source repeats the same setup three times and alternates padding solely to force redundant layout. See before/ and audit.json; no store claim.',sourceHash:hash(jsBefore),report:'audit.json'}},
    {target:'assets/theme.css',kind:'reviewed-replacement',replacementText:cssAfter,reason:'Keep one copy of an identical duplicated CSS rule in the isolated fixture.',evidence:{summary:'3000 byte-identical rules have the same selector, declarations and cascade order; the retained last rule preserves computed styling.',sourceHash:hash(cssBefore),report:'audit.json'}}
  ]};
  await save('recipe.json',recipe);
  plan=await createSitePlan({project:theme,recipe,recipeDir:output});await save('plan.json',plan);
  await save('apply-receipt.json',await applySitePlan(plan,theme));applied=true;
  console.log(JSON.stringify({stage:'candidate'}));
  const after=await measureSite({config,output:path.join(output,'after'),onProgress:p=>console.log(JSON.stringify(p))});
  assert.equal(after.status,'complete','Candidate measurement failed; inspect its run.json');
  const candidateCapture=await capturePage({url:origin+'/',selector:'#fixture',output:path.join(output,'capture-after'),waitMs:100,viewport:{width:390,height:844}});
  const comparison=compareCaptures(baselineCapture,candidateCapture);await save('capture-comparison.json',comparison);
  assert.equal(comparison.comparable,true);
  assert.equal(comparison.checks.some(c=>c.status==='fail'),false,'Content/geometry regression in the fixture');
  const scenarios=await runScenarios({config:{schemaVersion:1,url:origin+'/',scenarios:[{name:'details-toggle',steps:[{action:'click',selector:'#details'},{action:'assert-visible',selector:'#panel',visible:true},{action:'click',selector:'#details'},{action:'assert-visible',selector:'#panel',visible:false}]}]},output:path.join(output,'scenarios')});
  assert.equal(scenarios.outcome,'passed');
  const verification=await verifySite({before:path.join(output,'before'),after:path.join(output,'after')});
  await save('verification.json',verification);await save('verification.html',renderReport(verification));
  await save('rollback-receipt.json',await rollbackSitePlan(plan,theme));applied=false;
  assert.equal(await fs.readFile(path.join(theme,'assets/theme.js'),'utf8'),jsBefore);
  assert.equal(await fs.readFile(path.join(theme,'assets/theme.css'),'utf8'),cssBefore);
  const summary={schemaVersion:1,kind:'site-pipeline-validation',scope:'synthetic-local-fixture-only',realLighthouseReports:40,scoreOutcome:verification.outcome,functionalAssertions:scenarios.outcome,contentGeometryNoRegression:true,screenshotBytesEqual:baselineCapture.screenshots.component.sha256===candidateCapture.screenshots.component.sha256,rollbackSourceBytesRestored:true,themeScoreClaim:false,output};
  await save('summary.json',summary);console.log(JSON.stringify(summary));
  if(verification.outcome!=='score-targets-met')process.exitCode=3;
}catch(error){await save('failure.json',{error:error.message,code:error.code??null});throw error;}
finally {
  if(applied&&plan){try{await save('emergency-rollback.json',await rollbackSitePlan(plan,theme));}catch(error){console.error('Fixture rollback requires review:',error.message);}}
  server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
}
