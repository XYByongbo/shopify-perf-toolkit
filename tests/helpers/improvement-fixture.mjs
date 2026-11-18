// Synthetic measurement fixtures shared by session and cycle regression tests.
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { runImprovement } from '../../lib/improvement-session.mjs';
import { sourceSnapshot } from '../../lib/runtime-profile.mjs';
import { verifyPatchExperiment } from '../../lib/patch-experiment.mjs';
import { preservationStyles } from '../../lib/preservation.mjs';
import { siteRun, saveManifest } from './site-run.mjs';

export const url = 'https://shop.example.test/?preview_theme_id=1';
export const read = async file => JSON.parse(await readFile(file,'utf8'));
export const experimentConfig = project => ({schemaVersion:1,
  before:{schemaVersion:1,engine:'lighthouse',devices:['mobile'],pages:[{id:'home',url}],deployment:{project:project+'-baseline',store:'fixture.myshopify.com',themeId:'1'}},
  after:{schemaVersion:1,engine:'lighthouse',devices:['mobile'],pages:[{id:'home',url}],deployment:{project,store:'fixture.myshopify.com',themeId:'2'}}});
export async function proof(fixture,snapshot,project) {
  const declaration={project,store:'fixture.myshopify.com',themeId:'1'};
  const p={kind:'deployment-proof',status:'verified',scope:'theme-text-source',method:'shopify-cli-source-pull-and-browser-theme-id',...declaration,
    sourceHash:snapshot.hash,remoteSourceHash:snapshot.hash,sourceManifest:snapshot.files,
    pages:fixture.manifest.config.pages.map(page=>({...page,status:'verified',store:declaration.store,themeId:'1'}))};
  Object.assign(fixture.manifest,{startedAt:'2026-10-15T23:57:00Z',finishedAt:'2026-10-18T00:02:00Z',deployment:{
    before:{...p,startedAt:'2026-10-15T23:58:00Z',finishedAt:'2026-10-15T23:59:00Z'},
    after:{...p,startedAt:'2026-10-18T00:00:00Z',finishedAt:'2026-10-18T00:01:00Z'}}});
  fixture.manifest.config.deployment=declaration;await saveManifest(fixture);
}
export function regression(hash) {
  return {kind:'scenarios',sourceHash:hash,sourceStable:true,outcome:'passed',environment:{browserVersion:'synthetic'},
    runs:[{name:'action',url,viewport:{name:'mobile',width:390,height:844,dpr:1},themeId:'1',outcome:'passed',constrained:false,blockedRequests:[],pageErrors:[],steps:[
      {index:0,action:'click',selector:'button',times:1,outcome:'passed',elapsedMs:20},
      {index:1,action:'assert-text',selector:'output',text:'1',outcome:'passed',elapsedMs:10},
      {index:2,action:'checkpoint',key:'open',selector:'main',outcome:'passed',observation:{version:1,
        content:[{tag:'MAIN',text:['Fixture']}],layout:[{rect:[0,0,100,30],styles:Object.fromEntries(preservationStyles.map(k=>[k,'fixture']))}]}}
    ]}]};
}
export async function runtime(project) {
  const snapshot=await sourceSnapshot(project),source={status:'verified-bytes',...snapshot.files.find(f=>f.file==='assets/main.js'),line:1};
  return {kind:'runtime-profile',status:'complete',sourceStable:true,snapshot,config:{url,device:'mobile',state:'initial',actions:[]},
    cpu:[{selfMs:400,inclusiveMs:400,functionName:'heavy',source,url:'https://cdn.example.test/main.js'}],resources:[],renderResources:[],coverage:{js:[],css:[]},lcp:{renderDelayMs:200}};
}
export async function setup(t, budget={maxCandidateRounds:4}, exploration=false) {
  const root=await mkdtemp('/private/tmp/perfkit-improve-');t.after(()=>rm(root,{recursive:true,force:true}));
  const project=path.join(root,'theme');await mkdir(path.join(project,'assets'),{recursive:true});
  await writeFile(path.join(project,'assets/main.js'),'function heavy(){ return 1; }');
  const baseline=await siteRun(t,{devices:['mobile'],reports:exploration?3:5,scores:{mobile:[50]},augment:r=>{
    r.audits['total-blocking-time'].numericValue=700;
    r.audits['total-blocking-time'].score=0.1;
    r.categories.performance.auditRefs=[{id:'total-blocking-time',weight:30},{id:'largest-contentful-paint',weight:25},{id:'cumulative-layout-shift',weight:25},{id:'first-contentful-paint',weight:10},{id:'speed-index',weight:10}];
  }});
  if(exploration){baseline.manifest.config.purpose='exploration';baseline.manifest.config.runs=3;}
  await proof(baseline,await sourceSnapshot(project),project);
  let state,index=0;
  const step=async (input,deps={})=>{
    state=await runImprovement({config:{schemaVersion:1,...(state?{previous:path.join(state.output,'session.json')}:{project,run:baseline.root,profiles:[await runtime(project)],budget}),...input},
      output:path.join(root,`step-${index++}`),dependencies:deps});return state;
  };
  const prepare=async (text,method='replace-work')=>{
    const recovery=await read(state.recovery),c=recovery.candidates[0];
    return step({action:'prepare',candidateId:c.candidateId,method,rationale:'Measured CPU frame; remove repeated work and preserve output.',recipe:{schemaVersion:1,changes:[{
      kind:'reviewed-replacement',target:'assets/main.js',replacementText:text,reason:'Synthetic fixture implementation',
      evidence:{summary:'Synthetic source-bound hypothesis, no real-store claim',candidateId:c.candidateId,diagnosisSourceHash:state.baselineHash}
    }]}});
  };
  const experiment=async ({score=50,tbt=700,external=false}={})=>{
    const baselineSnapshot=await read(state.active.diagnosis),before=state.baselineRun;
    return step({action:'experiment',experiment:experimentConfig(project)}, {runPatchExperiment:async ({config,output})=>{
      await mkdir(output,{recursive:true});
      const plan=await read(config.plan),diagnosis=await read(config.diagnosis),snapshot=await sourceSnapshot(project);
      const after=await siteRun(t,{devices:['mobile'],offset:100+index*20,scores:{mobile:[score]},augment:r=>{r.audits['total-blocking-time'].numericValue=tbt;}});
      await proof(after,snapshot,project);
      const input={plan,diagnosis,candidateId:config.candidateId,before,after:after.root,goal:config.goal,acceptancePolicy:config.acceptancePolicy,
        regressionBefore:regression(baselineSnapshot.sourceHash),regressionAfter:regression(snapshot.hash)};
      const verification=await verifyPatchExperiment(input);
      if(external)for(const key of ['diagnosis','regressionBefore','regressionAfter']){const file=path.join(root,`${key}.json`);await writeFile(file,JSON.stringify(input[key]));input[key]=file;}
      await writeFile(path.join(output,'patch-evidence.json'),JSON.stringify(input));
      return {output,status:verification.outcome,verification,counts:{attempted:6,failed:0}};
    }});
  };
  return {root,project,baseline,step,prepare,experiment,get state(){return state;}};
}


// Synthetic bracketed capture for orchestration tests; never a real performance claim.
export async function freshRuntime(config) {
  const p=await runtime(config.deployment.project),now=new Date().toISOString();
  const u=new URL(config.url);u.searchParams.set('preview_theme_id',String(config.deployment.themeId));
  const proof={kind:'deployment-proof',status:'verified',scope:'theme-text-source',method:'shopify-cli-source-pull-and-browser-theme-id',
    ...config.deployment,themeId:String(config.deployment.themeId),startedAt:now,finishedAt:now,
    sourceHash:p.snapshot.hash,remoteSourceHash:p.snapshot.hash,sourceManifest:p.snapshot.files,
    pages:[{url:u.href,status:'verified',store:config.deployment.store,themeId:String(config.deployment.themeId)}]};
  return {...p,project:config.deployment.project,config:{...p.config,...config.profile,url:u.href},themeId:proof.themeId,finalUrl:u.href,
    createdAt:now,finishedAt:now,domainProof:{version:1,url:u.href,startedAt:now,finishedAt:now,before:proof,after:proof}};
}
