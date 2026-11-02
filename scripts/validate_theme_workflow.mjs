#!/usr/bin/env node
// Fixed-sample real Chrome/Lighthouse validation. Local LiquidJS fixtures and source-pull transport;
// never evidence of Shopify server timing, merchant scores or formal full-matrix acceptance.
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp,mkdir,writeFile,readFile,cp} from 'node:fs/promises';
import path from 'node:path';
import {Liquid} from 'liquidjs';
import {profileDomain} from '../lib/domain-profile.mjs';
import {verifyDeployment} from '../lib/deployment.mjs';
import {diagnoseUnified} from '../lib/decision-engine.mjs';
import {createDomainPlan} from '../lib/domain-plan.mjs';
import {themeContracts} from '../lib/theme-methods.mjs';
import {applySitePlan,rollbackSitePlan} from '../lib/site-changes.mjs';
import {runPatchExperiment} from '../lib/patch-experiment.mjs';
import {diagnoseRecovery,hypothesisKey} from '../lib/recovery.mjs';
async function fixture() {
  const root=await mkdtemp('/private/tmp/perfkit-theme-workflow-live-'),project=path.join(root,'baseline'),projects={'1':project,'2':path.join(root,'candidate')};
  for(const dir of ['assets','sections','snippets','config'])await mkdir(path.join(project,dir),{recursive:true});
  const section='<main id="cards">{% for product in products %}{% if product.available %}{% render "card", product: product %}{% endif %}{% endfor %}</main>';
  await writeFile(path.join(project,'sections/main.liquid'),section);
  await writeFile(path.join(project,'snippets/card.liquid'),`{{ 'card.css' | asset_url | stylesheet_tag }}<article class="card"><h2 class="variant-1">{{ product.title }}</h2><button type="button">Compare</button><span class="detail">Detail</span><span class="detail">Detail</span><span class="detail">Detail</span><span class="detail">Detail</span><span class="detail">Detail</span><span class="detail">Detail</span><span class="detail">Detail</span><span class="detail">Detail</span><span class="detail">Detail</span><span class="detail">Detail</span><span class="detail">Detail</span><span class="detail">Detail</span><span class="detail">Detail</span><span class="detail">Detail</span><span class="detail">Detail</span><span class="detail">Detail</span><span class="detail">Detail</span><span class="detail">Detail</span><span class="detail">Detail</span><span class="detail">Detail</span></article>`);
  const css='.card{display:block;border:1px solid #ddd;padding:8px;color:rgb(20,60,100)}.card.active{color:rgb(0,100,0)}'+Array.from({length:800},(_,i)=>`.card span:nth-child(${i%4+1}n){padding-left:${i%3}px;color:rgb(${i%255},50,70)}`).join('');
  await writeFile(path.join(project,'assets/card.css'),css);
  await writeFile(path.join(project,'assets/identity.js'),'window.Shopify={theme:{id:1},shop:"fixture.myshopify.com"};document.addEventListener("click",e=>{const c=e.target.closest(".card");if(c)c.classList.toggle("active")});');
  await writeFile(path.join(project,'assets/theme.js.liquid'),'window.currency={{ settings.currency_label | json }};\nfunction ready(){window.fixtureReady=true;}\nready();');
  await writeFile(path.join(project,'config/settings_schema.json'),JSON.stringify([{name:'General',settings:[{id:'currency_label',type:'text',default:'USD'}]}]));
  await writeFile(path.join(project,'config/settings_data.json'),JSON.stringify({current:{currency_label:'USD'}}));
  await cp(project,projects['2'],{recursive:true});
  const engine=new Liquid({root:path.join(project,'snippets'),extname:'.liquid'});engine.registerFilter('asset_url',name=>'/assets/'+name);engine.registerFilter('stylesheet_tag',href=>`<link rel="stylesheet" href="${href}">`);
  const engines={};for(const [id,dir]of Object.entries(projects)){const e=new Liquid({root:path.join(dir,'snippets'),extname:'.liquid'});e.registerFilter('asset_url',name=>'/assets/'+name);e.registerFilter('stylesheet_tag',href=>`<link rel="stylesheet" href="${href}">`);engines[id]=e;}
  const server=http.createServer(async(req,res)=>{
    try {
      const url=new URL(req.url,'http://fixture'),ref=new URL(req.headers.referer??url.href),id=url.searchParams.get('preview_theme_id')??ref.searchParams.get('preview_theme_id')??'1',active=projects[id];res.setHeader('Cache-Control','no-store');
      if(url.pathname==='/favicon.ico'){res.writeHead(204);res.end();return;}
      if(url.pathname.startsWith('/assets/')) {
        res.setHeader('Cache-Control','public,max-age=3600');
        const name=url.pathname.slice(1),liquid=name.endsWith('theme.js');res.setHeader('Content-Type',name.endsWith('.css')?'text/css':'text/javascript');
        const text=await readFile(path.join(active,name+(liquid?'.liquid':'')),'utf8');res.end(name.endsWith('identity.js')?text.replace('theme:{id:1}','theme:{id:'+id+'}'):liquid?await engine.parseAndRender(text,{settings:{currency_label:'USD'}}):text);return;
      }
      res.setHeader('Content-Type','text/html');res.end('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><script src="/assets/identity.js"></script><script src="/assets/theme.js" defer></script></head><body>'+await engines[id].parseAndRender(await readFile(path.join(active,'sections/main.liquid'),'utf8'),{products:Array.from({length:160},(_,i)=>({title:'Product '+i,available:i!==0}))})+'</body></html>');
    }catch(e){res.writeHead(500);res.end(e.message);}
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));

  const origin=`http://127.0.0.1:${server.address().port}`,url=origin+'/collections/all?preview_theme_id=1';let n=0;
  const capture=hashResourceUrls=>profileDomain({config:{schemaVersion:1,mode:'runtime',deployment:{project,store:'fixture.myshopify.com',themeId:'1'},url,
    profile:{device:'mobile',settleMs:100,timeoutMs:90000,...(hashResourceUrls?{hashResourceUrls}:{})}},output:path.join(root,'profile-'+n++),dependencies:{verifyDeployment:args=>verifyDeployment({...args,dependencies:{runProcess:async(_cmd,argv)=>{await cp(project,argv[argv.indexOf('--path')+1],{recursive:true});return {code:0};}}})}});

  return {root,project,url,origin,capture,projects,close:async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));}};
}

const f=await fixture(),result={kind:'theme-workflow-live-validation',scope:'local-artificial-LiquidJS-fixture',root:f.root,formalAcceptance:'not-evaluated',merchantPerformance:'not-measured',runsPerSide:3};
console.log(JSON.stringify({root:f.root}));
try {
  const profile=await f.capture(),goal={kind:'loading',metric:'fcp'},diagnosis=await diagnoseUnified({project:f.projects['2'],profiles:[profile],goal,limit:20}),c=diagnosis.candidates.find(c=>c.kind==='stylesheet');
  assert.ok(c,'A measured style-cost hypothesis is required, never fabricate it');
  const plan=await createDomainPlan({project:f.projects['2'],diagnosis,config:{schemaVersion:1,candidateId:c.candidateId,method:'stylesheet-once',review:{summary:'Reviewed isolated card CSS cascade, CSSOM, shared caller and interaction fixture',...Object.fromEntries(themeContracts['stylesheet-once'].review.map(k=>[k,true]))}}});
  await applySitePlan(plan,f.projects['2']);
  const url=id=>f.url.replace('preview_theme_id=1','preview_theme_id='+id),deployment=id=>({project:f.projects[id],store:'fixture.myshopify.com',themeId:id});
  const measure=id=>({schemaVersion:1,engine:'lighthouse',devices:['mobile'],pages:[{id:'collection',url:url(id)}],deployment:deployment(id)});
  const regress=id=>({schemaVersion:1,url:url(id),settleMs:100,viewports:[{name:'mobile',width:390,height:844}],scenarios:[{name:'cards',steps:[{action:'click',selector:'.card:first-of-type button'},{action:'assert-attribute',selector:'.card:first-of-type',name:'class',value:'card active'},{action:'checkpoint',selector:'#cards',key:'cards'}]}]});
  const proof=args=>verifyDeployment({...args,dependencies:{runProcess:async(_cmd,argv)=>{await cp(args.config.project,argv[argv.indexOf('--path')+1],{recursive:true});return {code:0};}}});
  const experiment=await runPatchExperiment({config:{schemaVersion:1,plan,diagnosis,candidateId:c.candidateId,goal,runs:3,before:measure('1'),after:measure('2'),regressionBefore:regress('1'),regressionAfter:regress('2'),budget:{maxWallTimeMs:600000,maxAttempts:6,maxFailures:1}},output:path.join(f.root,'experiment'),dependencies:{verifyDeployment:proof}});
  result.experiment={outcome:experiment.status,error:experiment.error??null,gain:experiment.verification?.gain,output:experiment.output,counts:experiment.counts};
  await rollbackSitePlan(plan,f.projects['2']);result.rolledBack=true;
  assert.notEqual(experiment.status,'invalid-evidence',JSON.stringify(result.experiment));
  if(experiment.status!=='promising') {
    const recovery=await diagnoseRecovery({project:f.projects['1'],run:path.join(experiment.output,'before'),profiles:[profile],goal,history:[{baselineHash:diagnosis.sourceHash,hypothesisKey:hypothesisKey(c),recoveryContext:c.recoveryContext,method:'stylesheet-once',outcome:experiment.status,sourceHash:experiment.verification.sourceHashes.after,experiment:experiment.output,verification:experiment.verification}]});
    assert.equal(recovery.candidates.find(x=>x.kind==='stylesheet')?.remainingMethods.length,0);
    result.recovery={costEvidence:recovery.candidates.find(x=>x.kind==='stylesheet')?.reassessment.costEvidence,next:recovery.workflow.next,failedMechanisms:recovery.workflow.failedMechanisms,reason:'The only measured generator is exhausted; fresh critical-path evidence or a reviewed different implementation is required. No parameter retry or resampling.'};
  }
  result.status='completed';
} finally {await writeFile(path.join(f.root,'result.json'),JSON.stringify(result,null,2)+'\n');await f.close();}
console.log(JSON.stringify(result));
