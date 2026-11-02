import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import {mkdtemp,mkdir,readFile,writeFile,cp,rm} from 'node:fs/promises';
import {Liquid} from 'liquidjs';
import {profileDomain} from '../lib/domain-profile.mjs';
import {verifyDeployment} from '../lib/deployment.mjs';
import {diagnoseBottlenecks} from '../lib/bottlenecks.mjs';
import {createDemandPlan} from '../lib/demand-plan.mjs';
import {applySitePlan} from '../lib/site-changes.mjs';
import {sourceSnapshot} from '../lib/theme-source.mjs';
import {matchesRecoveryCapture,assertRecoveryCaptureCoverage} from '../lib/recovery-evidence.mjs';
import {runScenarios} from '../lib/scenarios.mjs';
import {verifyPreservation} from '../lib/preservation.mjs';
import {reviewedPlanContent} from '../lib/recovery-cycle.mjs';

test('real Chrome changed state coverage regenerates critical CSS and preserves the observed UI after apply',{skip:process.env.PERF_KIT_BROWSER_TESTS!=='1',timeout:180000},async t=>{
  const root=await mkdtemp('/private/tmp/perfkit-adaptive-browser-'),project=path.join(root,'theme');
  t.after(()=>rm(root,{recursive:true,force:true}));
  await mkdir(path.join(project,'assets'),{recursive:true});await mkdir(path.join(project,'layout'));
  const css='.base { color: rgb(0,0,128); }\n.new-state { color: rgb(0,128,0); padding: 12px; }\n'+Array.from({length:60},(_,i)=>`.unused-${i} { padding: 40px; color: red; }`).join('\n');
  await writeFile(path.join(project,'assets/main.css'),css);await writeFile(path.join(project,'layout/theme.liquid'),'<link rel="stylesheet" href="{{ \'main.css\' | asset_url }}">');
  let stateClass='base'; // Simulated store content changes; theme code and requested state/action stay identical.
  const server=http.createServer(async(req,res)=>{
    try {
      const u=new URL(req.url,'http://localhost');res.setHeader('cache-control','no-store');
      if(u.pathname.startsWith('/assets/')){res.setHeader('content-type','text/css');if(u.pathname==='/assets/main.css')await new Promise(r=>setTimeout(r,200));res.end(await readFile(path.join(project,'assets',path.basename(u.pathname))));return;}
      const liquid=new Liquid();liquid.registerFilter('asset_url',s=>'/assets/'+s);
      res.setHeader('content-type','text/html');res.end(`<!doctype html><html><head><title>Adaptive coverage test</title><script>window.Shopify={theme:{id:1},shop:'fixture.myshopify.com'};</script>${await liquid.parseAndRender(await readFile(path.join(project,'layout/theme.liquid'),'utf8'))}</head><body data-state="${stateClass}"><button id="open" onclick="document.getElementById('panel').classList.add(document.body.dataset.state)">Open</button><div id="panel" class="base">Same content</div></body></html>`);
    }catch {res.writeHead(500);res.end('Fixture error');}
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));});
  const url=`http://127.0.0.1:${server.address().port}/?preview_theme_id=1`,deployment={project,store:'fixture.myshopify.com',themeId:'1',timeoutMs:30000};
  const verify=({config,pages})=>verifyDeployment({config,pages,dependencies:{runProcess:async(_command,args)=>{await cp(config.project,args[args.indexOf('--path')+1],{recursive:true});return {code:0};}}});
  const requests=['mobile','desktop'].map(device=>({schemaVersion:1,mode:'runtime',deployment,url,profile:{device,state:'open',settleMs:100,targetSelectors:['#panel'],actions:[{type:'click',selector:'#open'}]}}));
  const capture=async label=>{const profiles=[];for(const [i,config]of requests.entries()){const p=await profileDomain({config,output:path.join(root,`${label}-${i}`),dependencies:{verifyDeployment:verify}});assert.equal(matchesRecoveryCapture(p,config),true);profiles.push(p);}return profiles;};
  const before=await capture('before'),diagnosis=await diagnoseBottlenecks({project,profiles:before}),c=diagnosis.candidates.find(c=>c.kind==='render-resource');assert.ok(c);
  const config={schemaVersion:1,mode:'critical-css',source:'assets/main.css',newAsset:'assets/critical.css',loaderTarget:'layout/theme.liquid',tagStart:0,inlineLoadHandlerAllowed:true,candidateId:c.candidateId};
  const old=await createDemandPlan({project,config,diagnosis,profiles:before});assert.doesNotMatch(old.changes.find(c=>c.target==='assets/critical.css').after,/new-state/);
  stateClass='new-state';assertRecoveryCaptureCoverage({profiles:before},requests);
  const fresh=await capture('fresh'),freshDiagnosis=await diagnoseBottlenecks({project,profiles:fresh});
  const plan=await createDemandPlan({project,config,diagnosis:freshDiagnosis,profiles:fresh});assert.match(plan.changes.find(c=>c.target==='assets/critical.css').after,/new-state/);
  assert.notEqual(await reviewedPlanContent(old),await reviewedPlanContent(plan),'Fresh browser coverage must invalidate the old plan review.');
  const scenarios={schemaVersion:1,project,expectedThemeId:'1',url,viewports:[{name:'mobile',width:390,height:844}],scenarios:[{name:'open',steps:[{action:'click',selector:'#open'},{action:'assert-count',selector:'#panel.new-state',count:1},{action:'checkpoint',selector:'#panel',key:'opened'}]}]};
  const original=await sourceSnapshot(project),behaviorBefore=await runScenarios({config:scenarios,output:path.join(root,'behavior-before')});
  await applySitePlan(plan,project);const changed=await sourceSnapshot(project),behaviorAfter=await runScenarios({config:scenarios,output:path.join(root,'behavior-after')});
  assert.equal(behaviorBefore.outcome,'passed');assert.equal(behaviorAfter.outcome,'passed');
  const preservation=verifyPreservation({before:behaviorBefore,after:behaviorAfter,beforeSourceHash:original.hash,afterSourceHash:changed.hash,plan});
  assert.equal(preservation.outcome,'preserved',JSON.stringify(preservation));
});
