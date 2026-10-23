#!/usr/bin/env node
// Isolated artificial fixture: real Chrome, real Lighthouse, actual patches and rollback.
// Shopify remote source transport is replaced with fixture copying. No store or publication.
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { mkdtemp, mkdir, readFile, writeFile, cp } from 'node:fs/promises';
import { Liquid } from 'liquidjs';
import { profileRuntime } from '../lib/runtime-profile.mjs';
import { verifyDeployment } from '../lib/deployment.mjs';
import { measureSite } from '../lib/measure.mjs';
import { runPatchExperiment } from '../lib/patch-experiment.mjs';
import { runImprovement } from '../lib/improvement-session.mjs';
import { renderReport } from '../lib/report.mjs';

const {values:options}=parseArgs({options:{resume:{type:'string'},goal:{type:'string'}}});
if(options.resume && !path.isAbsolute(options.resume) || options.goal && !['score','fcp','speedIndex'].includes(options.goal)) throw new Error('Usage: [--resume /absolute/step-N/session.json] [--goal score|fcp|speedIndex]');
const resumed=options.resume?JSON.parse(await readFile(options.resume,'utf8')):null;
if (resumed && options.goal && options.goal!==resumed.goal.metric) throw new Error('Resume cannot change the declared goal.');
const goal=resumed?.goal ?? (options.goal && options.goal!=='score'?{kind:'loading',metric:options.goal}:{kind:'score'});
const root=resumed?path.dirname(path.dirname(options.resume)):await mkdtemp('/private/tmp/perfkit-improvement-live-'),baseline=path.join(root,'baseline'),candidate=path.join(root,'candidate');
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
const measurement=id=>({schemaVersion:1,engine:'lighthouse',purpose:'exploration',runs:3,pages:[{id:'fixture',url:`${origin}/?preview_theme_id=${id}`}],devices:['mobile'],timeoutMs:90000,
  deployment:{project:projects[id],store:'fixture.myshopify.com',themeId:id,timeoutMs:30000}});
const regression=id=>({schemaVersion:1,url:`${origin}/?preview_theme_id=${id}`,viewports:[{name:'mobile',width:390,height:844}],scenarios:[{name:'first-action',steps:[
  {action:'click',selector:'button'},{action:'assert-text',selector:'output',text:'1'},{action:'checkpoint',selector:'body',key:'opened'}]}]});
let state=resumed,index=resumed?resumed.step+1:0;
const step=async config=>{
  state=await runImprovement({config:{schemaVersion:1,...(state?{previous:path.join(state.output,'session.json')}:{}),...config},output:path.join(root,`step-${index++}`),
    dependencies:{runPatchExperiment:args=>runPatchExperiment({...args,dependencies:{verifyDeployment:deployment}})}});
  console.log(JSON.stringify({step:config.action,status:state.status,error:state.error,output:state.output}));
  assert.equal(state.error,undefined);return state;
};
const experiment={schemaVersion:1,before:measurement('1'),after:measurement('2'),regressionBefore:regression('1'),regressionAfter:regression('2')};
console.log(JSON.stringify({output:root,scope:'artificial-local-fixture-only'}));
try {
  const profiles=[];
  for(const device of ['mobile','desktop'])profiles.push(await profileRuntime({config:{schemaVersion:1,project:baseline,url:`${origin}/?preview_theme_id=1`,device,settleMs:100,actions:[{type:'click',selector:'button'}],expectedThemeId:'1'},output:path.join(root,`profile-${index}-${device}`)}));
  if(resumed){assert.equal(state.active,null);await step({action:'refresh',profiles});}
  else {
  const run=path.join(root,'baseline-run');
  const measured=await measureSite({config:measurement('1'),output:run,dependencies:{verifyDeployment:deployment}});assert.equal(measured.status,'complete');
  await step({action:'start',project:candidate,run,profiles,goal,budget:{maxCandidateRounds:3,maxAttempts:20,maxFailures:3,maxWallTimeMs:600000}});
  let recovery=await read(state.recovery),hotspot=recovery.candidates.find(c=>c.file==='assets/main.css'&&c.kind==='render-resource');assert.ok(hotspot);
  await step({action:'prepare',candidateId:hotspot.candidateId,method:'css-comment-only',rationale:'Negative control: a comment cannot remove the delayed blocking stylesheet.',recipe:{schemaVersion:1,changes:[{
    kind:'reviewed-replacement',target:'assets/main.css',replacementText:css+'\n/* negative control */',reason:'Isolated negative control',
    evidence:{summary:'Artificial fixture with unchanged visible CSS',candidateId:hotspot.candidateId,diagnosisSourceHash:state.baselineHash}}]}});
  await step({action:'apply',reviewedPlanHash:state.active.planHash});await step({action:'experiment',experiment});
  assert.equal(state.active,null,'Unproductive control must be rolled back');
  assert.equal(await readFile(path.join(candidate,'assets/main.css'),'utf8'),css);
  }
  const recovery=await read(state.recovery),hotspot=recovery.candidates.find(c=>c.file==='assets/main.css'&&c.kind==='render-resource');
  await step({action:'prepare',candidateId:hotspot.candidateId,method:'critical-css',rationale:'Change the loading mechanism: deliver observed critical styles first and retain the full stylesheet fallback.',demand:{
    schemaVersion:1,mode:'critical-css',source:'assets/main.css',newAsset:'assets/critical.css',loaderTarget:'layout/theme.liquid',tagStart:0,inlineLoadHandlerAllowed:true,candidateId:hotspot.candidateId}});
  await step({action:'apply',reviewedPlanHash:state.active.planHash});await step({action:'experiment',experiment});
  assert.equal(state.status,'formal-validation-required',JSON.stringify(state.history.at(-1).verification));
  await writeFile(path.join(root,'session.html'),renderReport(state));
  const result={kind:'improvement-pipeline-validation',status:'passed',scope:'isolated-artificial-fixture-only',root,goal,history:state.history.map(h=>({method:h.method,outcome:h.outcome,gain:h.verification?.gain})),
    formalAcceptance:'not-evaluated',next:'A real theme still needs full matrix, explicit synchronization, regression and independent content/visual review.'};
  await writeFile(path.join(root,'result.json'),JSON.stringify(result,null,2));
  console.log(JSON.stringify({status:result.status,output:root,history:result.history.map(h=>({method:h.method,outcome:h.outcome}))}));
}finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
