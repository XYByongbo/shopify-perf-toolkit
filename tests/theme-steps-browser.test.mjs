import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp,mkdir,writeFile,readFile,cp,rm} from 'node:fs/promises';
import path from 'node:path';
import {Liquid} from 'liquidjs';
import {profileDomain} from '../lib/domain-profile.mjs';
import {verifyDeployment} from '../lib/deployment.mjs';
import {diagnoseUnified} from '../lib/decision-engine.mjs';
import {createDomainPlan} from '../lib/domain-plan.mjs';
import {themeContracts} from '../lib/theme-methods.mjs';
import {applySitePlan,rollbackSitePlan} from '../lib/site-changes.mjs';
import {runScenarios} from '../lib/scenarios.mjs';
import {verifyPreservation} from '../lib/preservation.mjs';
import {checkThemeBehavior} from '../lib/optimization-regression.mjs';
import {createResourceRepair,verifyResourceRepair} from '../lib/resource-repair.mjs';
import {sha256} from '../lib/runtime-profile.mjs';
const enabled=process.env.PERF_KIT_BROWSER_TESTS==='1';
const svg='<svg xmlns="http://www.w3.org/2000/svg" width="400" height="200"><rect width="400" height="200" fill="blue"/></svg>';
async function fixture(t,{image=false}={}) {
  const root=await mkdtemp('/private/tmp/perfkit-theme-browser-'),project=path.join(root,'theme');
  for(const dir of ['assets','sections','snippets','config'])await mkdir(path.join(project,dir),{recursive:true});
  const section=image?'<main><img id="broken" src="/missing.svg" width="400" height="200" alt="Installation"></main>'
    :'<button id="menu">Expand spacing</button><main id="cards">{% for product in products %}{% if product.available %}{% render "card", product: product %}{% endif %}{% endfor %}</main>';
  await writeFile(path.join(project,'sections/main.liquid'),section);
  await writeFile(path.join(project,'snippets/card.liquid'),`{{ 'card.css' | asset_url | stylesheet_tag }}<article class="card"><h2 class="variant-1">{{ product.title }}</h2><button type="button">Compare</button><span class="detail">Detail</span><span class="detail">Detail</span><span class="detail">Detail</span><span class="detail">Detail</span><span class="detail">Detail</span><span class="detail">Detail</span><span class="detail">Detail</span><span class="detail">Detail</span><span class="detail">Detail</span><span class="detail">Detail</span><span class="detail">Detail</span><span class="detail">Detail</span><span class="detail">Detail</span><span class="detail">Detail</span><span class="detail">Detail</span><span class="detail">Detail</span><span class="detail">Detail</span><span class="detail">Detail</span><span class="detail">Detail</span><span class="detail">Detail</span></article>`);
  const css='.card{display:block;border:1px solid #ddd;padding:8px;color:rgb(20,60,100)}.card.active{color:rgb(0,100,0)}'+Array.from({length:800},(_,i)=>`.card span:nth-child(${i%4+1}n){padding-left:${i%3}px;color:rgb(${i%255},50,70)}`).join('');
  await writeFile(path.join(project,'assets/card.css'),css+'body.expanded .card span{padding:12px}');
  await writeFile(path.join(project,'assets/identity.js'),'window.Shopify={theme:{id:1},shop:"fixture.myshopify.com"};document.addEventListener("click",e=>{if(e.target.id==="menu")document.body.classList.toggle("expanded");const c=e.target.closest(".card");if(c)c.classList.toggle("active")});');
  await writeFile(path.join(project,'assets/theme.js.liquid'),'window.currency={{ settings.currency_label | json }};\nfunction ready(){window.fixtureReady=true;}\nready();');
  await writeFile(path.join(project,'config/settings_schema.json'),JSON.stringify([{name:'General',settings:[{id:'currency_label',type:'text',default:'USD'}]}]));
  await writeFile(path.join(project,'config/settings_data.json'),JSON.stringify({current:{currency_label:'USD'}}));
  const engine=new Liquid({root:path.join(project,'snippets'),extname:'.liquid'});engine.registerFilter('asset_url',name=>'/assets/'+name);engine.registerFilter('stylesheet_tag',href=>`<link rel="stylesheet" href="${href}">`);
  const server=http.createServer(async(req,res)=>{
    try {
      const url=new URL(req.url,'http://fixture');res.setHeader('Cache-Control','no-store');
      if(url.pathname==='/favicon.ico'){res.writeHead(204);res.end();return;}
      if(url.pathname==='/missing.svg'){res.writeHead(404);res.end('Missing');return;}
      if(url.pathname==='/good.svg'){res.setHeader('Content-Type','image/svg+xml');res.end(svg);return;}
      if(url.pathname.startsWith('/assets/')) {
        res.setHeader('Cache-Control','public,max-age=3600');
        const name=url.pathname.slice(1),liquid=name.endsWith('theme.js');res.setHeader('Content-Type',name.endsWith('.css')?'text/css':'text/javascript');
        const text=await readFile(path.join(project,name+(liquid?'.liquid':'')),'utf8');res.end(liquid?await engine.parseAndRender(text,{settings:{currency_label:'USD'}}):text);return;
      }
      res.setHeader('Content-Type','text/html');res.end('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><script src="/assets/identity.js"></script><script src="/assets/theme.js" defer></script></head><body>'+await engine.parseAndRender(await readFile(path.join(project,'sections/main.liquid'),'utf8'),{products:Array.from({length:160},(_,i)=>({title:'Product '+i,available:i!==0}))})+'</body></html>');
    }catch(e){res.writeHead(500);res.end(e.message);}
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));if(process.env.PERF_KIT_KEEP_TEST_ARTIFACTS==='1')t.diagnostic('Artifacts: '+root);else await rm(root,{recursive:true,force:true});});
  const origin=`http://127.0.0.1:${server.address().port}`,url=origin+'/collections/all?preview_theme_id=1';let n=0;
  const capture=(hashResourceUrls,actions=[])=>profileDomain({config:{schemaVersion:1,mode:'runtime',deployment:{project,store:'fixture.myshopify.com',themeId:'1'},url,
    profile:{device:'mobile',settleMs:100,timeoutMs:90000,actions,...(hashResourceUrls?{hashResourceUrls}:{})}},output:path.join(root,'profile-'+n++),dependencies:{verifyDeployment:args=>verifyDeployment({...args,dependencies:{runProcess:async(_cmd,argv)=>{await cp(project,argv[argv.indexOf('--path')+1],{recursive:true});return {code:0};}}})}});

  return {root,project,url,origin,capture};
}

test('real Chrome pairs card stylesheet edits, preserves actual first click/layout, maps Liquid assets and restores sources', {skip:!enabled,timeout:180000},async t=>{
  const f=await fixture(t),before=await f.capture();
  assert.ok(before.styleCosts.complete);assert.ok(before.styleCosts.styleRecalcMs>=10,JSON.stringify(before.styleCosts));
  assert.ok(before.resources.some(r=>r.source?.scriptKind==='liquid-asset'));assert.equal(before.compiledAssets.length,1);
  const d=await diagnoseUnified({project:f.project,profiles:[before],limit:20}),c=d.candidates.find(c=>c.kind==='stylesheet');assert.ok(c,JSON.stringify({cost:before.styleCosts,candidates:d.candidates.map(c=>c.kind)}));
  const plan=await createDomainPlan({project:f.project,diagnosis:d,config:{schemaVersion:1,candidateId:c.candidateId,method:'stylesheet-once',review:{summary:'Local complete repeated-card CSS and first-click fixture',...Object.fromEntries(themeContracts['stylesheet-once'].review.map(k=>[k,true]))}}});
  // Select one actual button while keeping the whole component checkpoint.
  const scenario=async()=>runScenarios({config:{schemaVersion:1,project:f.project,url:f.url,expectedThemeId:'1',viewports:[{name:'mobile',width:390,height:844}],timeoutMs:15000,settleMs:50,
    scenarios:[{name:'cards',steps:[{action:'click',selector:'.card:first-of-type button'},{action:'assert-attribute',selector:'.card:first-of-type',name:'class',value:'card active'},{action:'checkpoint',selector:'#cards',key:'cards'}]}]},output:path.join(f.root,'scenario-'+Date.now())});
  const original=await scenario();assert.equal(original.outcome,'passed');
  await applySitePlan(plan,f.project);const after=await f.capture(),candidate=await scenario();
  assert.equal(candidate.outcome,'passed');assert.equal(checkThemeBehavior(plan,original),true);assert.equal(checkThemeBehavior(plan,candidate,{candidate:true}),true);
  assert.equal(verifyPreservation({before:original,after:candidate,beforeSourceHash:original.sourceHash,afterSourceHash:candidate.sourceHash,plan}).outcome,'preserved');
  assert.equal(after.initial.delivery.stylesheets.filter(s=>s.assetName==='card.css').length,1);
  await rollbackSitePlan(plan,f.project);
  t.diagnostic('Actual Chrome functional and source-mapping evidence. Shopify source transport is a local copy stub; no merchant or scoring gain is claimed.');
});

test('real Chrome records style work and EventTiming in the declared interaction window',{skip:!enabled,timeout:120000},async t=>{
  const f=await fixture(t),p=await f.capture(undefined,[{type:'click',selector:'#menu'}]);
  assert.equal(p.interactionStyleCosts.complete,true);assert.ok(p.interactionStyleCosts.events>0);
  const event=p.afterActions.interactions.find(e=>e.target==='#menu'&&e.name==='click');assert.ok(event);
  const d=await diagnoseUnified({project:f.project,profiles:[p],goal:{kind:'interaction',target:'#menu',event:'click'},limit:20});
  const c=d.candidates.find(c=>c.kind==='stylesheet');
  assert.equal(Boolean(c),p.interactionStyleCosts.styleRecalcMs>=10);
  if(c){assert.equal(c.target,'#menu');assert.equal(c.data.measured.costWindow,'single-interaction');}
});

test('real Chrome repairs a broken image and proves actual decoded approved bytes without calling it a score gain',{skip:!enabled,timeout:120000},async t=>{
  const f=await fixture(t,{image:true}),before=await f.capture();assert.equal(before.resourceHealth.images[0].decoded,false);
  const plan=await createResourceRepair({project:f.project,profile:before,config:{schemaVersion:1,target:'sections/main.liquid',offset:'<main>'.length,replacementUrl:f.origin+'/good.svg',approvedAssetHash:sha256(svg),review:{summary:'Exact intended local SVG fixture',originalAssetConfirmed:true}}});
  await applySitePlan(plan,f.project);const after=await f.capture([f.origin+'/good.svg']),result=await verifyResourceRepair({plan,before,after});
  assert.equal(result.outcome,'correctness-restored',result.error);assert.equal(result.performanceGain,'not-evaluated');await rollbackSitePlan(plan,f.project);
});
