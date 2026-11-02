#!/usr/bin/env node
import {parseArgs} from 'node:util';
// Isolated artificial fixture: real Chrome, real Lighthouse, actual patches and rollback.
// Shopify remote source transport is replaced with fixture copying. No store or publication.
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { mkdtemp, mkdir, readFile, writeFile, cp } from 'node:fs/promises';
import { Liquid } from 'liquidjs';
import {profileDomain} from '../lib/domain-profile.mjs';
import { profileRuntime } from '../lib/runtime-profile.mjs';
import { verifyDeployment } from '../lib/deployment.mjs';
import { measureSite } from '../lib/measure.mjs';
import { runPatchExperiment } from '../lib/patch-experiment.mjs';
import { runImprovement } from '../lib/improvement-session.mjs';
import {runRecoveryCycle} from '../lib/recovery-cycle.mjs';
import {createSitePlan} from '../lib/site-changes.mjs';
import {createDemandPlan} from '../lib/demand-plan.mjs';
import {sourceSnapshot,sha256} from '../lib/runtime-profile.mjs';
import {collectOptimizationEvidence} from '../lib/optimize.mjs';

const {values:options}=parseArgs({options:{resume:{type:'string'}}});
const resumed=options.resume?JSON.parse(await readFile(options.resume,'utf8')):null,goal={kind:'loading',metric:'fcp'};
const root=resumed?path.dirname(resumed.originalRun):await mkdtemp('/private/tmp/perfkit-recovery-cycle-live-'),baseline=path.join(root,'baseline'),candidate=path.join(root,'candidate');
const css='body { margin: 20px; font-family: sans-serif; }\nh1 { color: navy; }\nbutton { padding: 8px; }\n'
  +Array.from({length:3000},(_,i)=>`.unused-${i} { color: red; margin: 20px; padding: 32px; border-radius: 8px; }`).join('\n');
const files={'assets/main.css':css,'layout/theme.liquid':"<link rel=\"stylesheet\" href=\"{{ 'main.css' | asset_url }}\">",'templates/index.json':'{"sections":{}}'};
if(!resumed){
  for(const [file,text] of Object.entries(files)){await mkdir(path.dirname(path.join(baseline,file)),{recursive:true});await writeFile(path.join(baseline,file),text);}
  await cp(baseline,candidate,{recursive:true});
}
const projects={'1':baseline,'2':candidate};
const server=http.createServer(async(req,res)=>{
  const url=new URL(req.url,'http://127.0.0.1'),id=url.searchParams.get('preview_theme_id')??'1',project=projects[id];
  try {
    if(!project){res.writeHead(404);res.end();return;}
    res.setHeader('Cache-Control','no-store');
    if(url.pathname.startsWith('/assets/')){
      const text=await readFile(path.join(project,'assets',path.posix.basename(url.pathname)),'utf8');res.setHeader('Content-Type','text/css');
      if(url.pathname.endsWith('/main.css'))await new Promise(resolve=>setTimeout(resolve,2500));
      res.end(text);return;
    }
    const liquid=new Liquid();liquid.registerFilter('asset_url',name=>`/assets/${name}?preview_theme_id=${id}`);
    liquid.registerFilter('stylesheet_tag',url=>`<link rel="stylesheet" href="${url}">`);
    const styles=await liquid.parseAndRender(await readFile(path.join(project,'layout/theme.liquid'),'utf8'));
    res.setHeader('Content-Type','text/html');
    res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Isolated recovery benchmark</title>${styles}<script>window.Shopify={theme:{id:${id}},shop:'fixture.myshopify.com'};</script></head><body><h1>Unchanged fixture heading</h1><p>Identical content and layout.</p><button type="button" onclick="document.querySelector('output').textContent=String(Number(document.querySelector('output').textContent)+1)">Open</button><output>0</output></body></html>`);
  }catch(error){res.writeHead(500);res.end('Fixture error');}
});
const priorRun=resumed?JSON.parse(await readFile(path.join(resumed.baselineRun,'run.json'),'utf8')):null;
await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(priorRun?Number(new URL(priorRun.config.pages[0].url).port):0,'127.0.0.1',resolve);});
const origin=`http://127.0.0.1:${server.address().port}`,read=async file=>JSON.parse(await readFile(file,'utf8'));
const deployment=({config,pages})=>verifyDeployment({config,pages,dependencies:{runProcess:async(_command,args)=>{await cp(config.project,args[args.indexOf('--path')+1],{recursive:true});return {code:0};}}});
const measurement=id=>({schemaVersion:1,engine:'lighthouse',purpose:'acceptance',runs:5,pages:[{id:'fixture',url:`${origin}/?preview_theme_id=${id}`}],devices:['mobile'],timeoutMs:90000,
  deployment:{project:projects[id],store:'fixture.myshopify.com',themeId:id,timeoutMs:30000}});
const regression=id=>({schemaVersion:1,url:`${origin}/?preview_theme_id=${id}`,viewports:[{name:'mobile',width:390,height:844}],scenarios:[{name:'first-action',steps:[
  {action:'click',selector:'button'},{action:'assert-text',selector:'output',text:'1'},{action:'checkpoint',selector:'body',key:'opened'}]}]});
console.log(JSON.stringify({output:root,scope:'artificial-local-fixture; real browser and Lighthouse; no merchant claim'}));
try {
  let config;
  if(!resumed) {
  const profiles=[];
  for(const device of ['mobile','desktop'])profiles.push(await profileRuntime({config:{schemaVersion:1,project:baseline,
    url:`${origin}/?preview_theme_id=1`,device,settleMs:100,actions:[{type:'click',selector:'button'}],expectedThemeId:'1'},
    output:path.join(root,'profile-'+device)}));
  const run=path.join(root,'baseline-run');
  assert.equal((await measureSite({config:measurement('1'),output:run,dependencies:{verifyDeployment:deployment}})).status,'complete');
  const state=await runImprovement({config:{schemaVersion:1,action:'start',project:candidate,run,profiles,goal,
    budget:{maxCandidateRounds:3,maxAttempts:25,maxFailures:3,maxWallTimeMs:1800000},resourceBudget:{maxRequests:20,maxTotalTransferBytes:1000000}},output:path.join(root,'start')});
  assert.equal(state.error,undefined);
  const recovery=await read(state.recovery),hotspot=recovery.candidates.find(c=>c.file==='assets/main.css'&&c.kind==='render-resource');assert.ok(hotspot);
  const recipe={schemaVersion:1,changes:[{kind:'reviewed-replacement',target:'assets/main.css',replacementText:css+'\n/* negative control */',
    reason:'Known artificial fixture: comment preserves all CSS work.',evidence:{summary:'Fixture negative control, not an optimization claim',candidateId:hotspot.candidateId,diagnosisSourceHash:state.baselineHash}}]};
  const demand={schemaVersion:1,mode:'critical-css',source:'assets/main.css',newAsset:'assets/critical.css',loaderTarget:'layout/theme.liquid',tagStart:0,
    inlineLoadHandlerAllowed:true,candidateId:hotspot.candidateId};
  const plans=[await createSitePlan({project:candidate,recipe}),await createDemandPlan({project:candidate,config:demand,diagnosis:recovery.diagnosis,profiles})];
  const snapshot=await sourceSnapshot(candidate);
  const experiment={schemaVersion:1,before:measurement('1'),after:measurement('2'),regressionBefore:regression('1'),regressionAfter:regression('2')};
  const options=[];
  for(const [i,plan] of plans.entries()) {
    const reviewed=path.join(root,`reviewed-plan-${i}.json`);await writeFile(reviewed,JSON.stringify(plan,null,2));
    const files=new Map(snapshot.files.map(f=>[f.file,f]));for(const c of plan.changes)files.set(c.target,{file:c.target,sourceHash:c.afterHash});
    const sourceHash=sha256(JSON.stringify([...files.values()].sort((a,b)=>a.file.localeCompare(b.file))));
    options.push({id:i?'critical-css':'negative-control',prepare:{candidateId:hotspot.candidateId,method:i?'critical-css':'css-comment-only',
      rationale:i?'The comment did not remove blocking CSS. Deliver measured critical styles and retain the complete stylesheet fallback.':'Negative control leaves the blocking stylesheet mechanism unchanged.',
      ...(i?{demand}:{recipe})},reviewedPlan:reviewed,experiment,formal:{measurement:measurement('2'),scenarios:regression('2'),
        review:{sourceHash,contentPreserved:true,visualsPreserved:true,summary:'Known local fixture source contract: unchanged content and retained full CSS. Independent experiment checks DOM, layout and first-click state. Not a merchant visual review.'}}});
  }
  config={schemaVersion:1,previous:path.join(state.output,'session.json'),options};
  await writeFile(path.join(root,'cycle-config.json'),JSON.stringify(config,null,2));
  } else {config=await read(path.join(root,'cycle-config.json'));config.previous=options.resume;}
  const result=await runRecoveryCycle({config,output:path.join(root,resumed?'resumed-cycle-'+resumed.step:'cycle'),dependencies:{verifyDeployment:deployment,
    profileDomain:args=>profileDomain({...args,dependencies:{verifyDeployment:deployment}}),
    runPatchExperiment:args=>runPatchExperiment({...args,dependencies:{verifyDeployment:deployment}}),
    collectOptimizationEvidence:args=>collectOptimizationEvidence({...args,dependencies:{verifyDeployment:deployment,measureSite:args=>measureSite({...args,dependencies:{verifyDeployment:deployment}})}})}});
  const final=await read(result.session);
  let evidenceState=final;while(evidenceState.action!=='reprofile'&&evidenceState.previous)evidenceState=await read(evidenceState.previous);
  assert.equal(evidenceState.action,'reprofile');assert.equal(evidenceState.inputs.profiles.length,2);
  assert.ok(evidenceState.inputs.profiles.every(p=>p.domainProof?.before.status==='verified'&&p.domainProof?.after.status==='verified'));
  assert.equal(final.evidenceRefreshHistoryLength,1,'Reprofile must precede the alternative patch without replacing failure history.');
  const summary={scope:'local artificial slow-CSS fixture, real Chrome/Lighthouse; Shopify source pull is a copy adapter',root,status:result.status,
    counts:final.counts,freshProfiles:evidenceState.inputs.profiles.map(p=>({device:p.config.device,createdAt:p.createdAt,sourceHash:p.snapshot.hash,proof:p.domainProof})),history:final.history.map(h=>({method:h.method,outcome:h.outcome,gain:h.verification?.gain})),verification:final.verification??null,
    formalAcceptance:final.acceptance,merchantPerformance:'not-measured',error:result.error??final.error??null};
  await writeFile(path.join(root,resumed?'resumed-result-'+resumed.step+'.json':'result.json'),JSON.stringify(summary,null,2));
  console.log(JSON.stringify({root,status:summary.status,counts:summary.counts,history:summary.history.map(({method,outcome})=>({method,outcome})),error:summary.error}));
  assert.equal(final.history[0]?.outcome,'no-measurable-gain','Negative control must not claim gains. All samples remain saved on failure.');
  assert.equal(final.counts.rounds,2,'Cycle must generate/apply a different mechanism after the control.');
  assert.equal(result.status,'optimization-accepted','Fixed samples did not complete acceptance; do not retry to seek a pass.');
}finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
