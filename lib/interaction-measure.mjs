import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { profileRuntime, validateProfileConfig } from './runtime-profile.mjs';
import { createRunDirectory } from './measure.mjs';
import { validateDeployment, verifyDeployment, checkRunDeployment } from './deployment.mjs';
import { createBudget } from './execution-policy.mjs';
import { fields, digest, readEvidenceJSON, goalContract } from './evidence-contract.mjs';
import { normalizeEvidenceUrl } from './run-evidence.mjs';
import { median } from './summary.mjs';

export function validateInteractionConfig(config) {
  fields(config,['schemaVersion','profile','runs','purpose','budget','deployment'],'interaction measurement');
  const profile=validateProfileConfig(config.profile),purpose=config.purpose??'acceptance',runs=config.runs??5;
  if(config.schemaVersion!==1||!['acceptance','exploration'].includes(purpose)||!Number.isSafeInteger(runs)||runs<(purpose==='acceptance'?5:3)||runs>10
    ||!profile.project||!profile.actions.some(a=>['click','press'].includes(a.type)))throw new Error('Interaction measurement needs a project, click/press actions and 5..10 formal or 3..10 exploratory independent captures.');
  const deployment=validateDeployment(config.deployment);
  if(deployment.project!==profile.project)throw new Error('Interaction deployment project differs.');
  if(profile.expectedThemeId!==undefined&&String(profile.expectedThemeId)!==deployment.themeId)throw new Error('Interaction profile and deployment theme IDs differ.');
  return {schemaVersion:1,profile,purpose,runs,deployment,pages:[{id:'interaction',url:profile.url}],budget:createBudget(config.budget).limits};
}

export async function measureInteractions({config,output,dependencies={}}={}) {
  config=validateInteractionConfig(config);const out=await createRunDirectory(output),budget=createBudget(config.budget);
  const result={schemaVersion:1,kind:'interaction-measurement',status:'running',startedAt:new Date().toISOString(),config,profiles:[],deployment:{},counts:{attempted:0,failed:0}};
  const proof=()=> (dependencies.verifyDeployment??verifyDeployment)({config:config.deployment,pages:config.pages});
  try {
    if(budget.remainingMs()<config.deployment.timeoutMs)throw new Error('Insufficient budget for deployment proof.');
    result.deployment.before=await proof();
    if(result.deployment.before.status!=='verified')throw new Error('Initial interaction source identity is unverified.');
    for(let i=0;i<config.runs;i++){
      const stop=await budget.check({attempts:result.counts.attempted,failures:result.counts.failed,reserveMs:config.profile.timeoutMs+config.deployment.timeoutMs});
      if(stop)throw new Error(`Interaction budget stopped: ${stop}`);
      result.counts.attempted++;
      try {
        const dir=`sample-${i+1}`,p=await (dependencies.profileRuntime??profileRuntime)({config:{...config.profile,expectedThemeId:config.deployment.themeId},output:path.join(out,dir)});
        const file=`${dir}/profile.json`,hash=digest(await readFile(path.join(out,file)));
        result.profiles.push({file,hash});
        if(p.status!=='complete'||!p.sourceStable||p.snapshot?.hash!==result.deployment.before.sourceHash||p.blockedRequests?.length)throw new Error('Incomplete, constrained or drifted interaction sample.');
      }catch(error){result.counts.failed++;(result.failures??=[]).push({attempt:i+1,error:error.message});throw error;}
    }
    if(budget.remainingMs()<config.deployment.timeoutMs)throw new Error('Insufficient budget for final deployment proof.');
    result.deployment.after=await proof();
    if(result.deployment.after.status!=='verified'||result.deployment.after.sourceHash!==result.deployment.before.sourceHash)throw new Error('Interaction source changed.');
    if(budget.remainingMs()<=0)throw new Error('Interaction wall-time budget expired.');
    result.status='complete';
  }catch(error){result.status='stopped';result.error=error.message;}
  result.finishedAt=new Date().toISOString();result.budget={elapsedMs:budget.elapsedMs(),limits:budget.limits};
  await writeFile(path.join(out,'interactions.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx'});return result;
}

export async function readInteractionRun(root,{allowExploration=false}={}) {
  const m=await readEvidenceJSON(path.join(root,'interactions.json'));
  const config=validateInteractionConfig(Object.fromEntries(['schemaVersion','profile','runs','purpose','budget','deployment'].filter(k=>m.config?.[k]!==undefined).map(k=>[k,m.config[k]])));
  if(m.schemaVersion!==1||m.kind!=='interaction-measurement'||m.status!=='complete'||!Array.isArray(m.profiles)||m.profiles.length!==config.runs
    ||m.counts?.attempted!==config.runs||m.counts?.failed!==0||m.failures?.length||!allowExploration&&config.purpose!=='acceptance')throw new Error('Incomplete, failed or exploratory interaction matrix.');
  const profiles=[],seen=new Set();
  for(const entry of m.profiles){
    if(!/^sample-[1-9]\d*\/profile\.json$/.test(entry.file)||!/^[a-f0-9]{64}$/.test(entry.hash)||seen.has(entry.file))throw new Error('Invalid/duplicate interaction evidence path.');seen.add(entry.file);
    const p=await readEvidenceJSON(path.join(root,entry.file),{root,hash:entry.hash});
    if(p.kind!=='runtime-profile'||p.status!=='complete'||p.sourceStable!==true||p.snapshot?.complete!==true
      ||!Array.isArray(p.errors)||p.errors.length||!Array.isArray(p.blockedRequests)||p.blockedRequests.length||p.trace?.truncated!==false
      ||!Array.isArray(p.afterActions?.supported)||!p.afterActions.supported.includes('event')
      ||!Number.isFinite(Date.parse(p.createdAt))||!Number.isFinite(Date.parse(p.finishedAt))||Date.parse(p.finishedAt)<=Date.parse(p.createdAt)
      ||Date.parse(p.finishedAt)>Date.parse(m.deployment?.after?.startedAt)||p.themeId!==config.deployment.themeId||digest(p.snapshot?.files)!==p.snapshot?.hash
      ||normalizeEvidenceUrl(p.finalUrl)!==normalizeEvidenceUrl(config.profile.url)||normalizeEvidenceUrl(p.afterActionsUrl)!==normalizeEvidenceUrl(config.profile.url)
      ||!Number.isFinite(p.interactionWindowStartMs)||p.interactionWindowStartMs<0||!Number.isFinite(p.interactionWindowEndMs)||p.interactionWindowEndMs<=p.interactionWindowStartMs)throw new Error('Invalid interaction capture identity, Event Timing support or execution.');
    const expected={...config.profile,expectedThemeId:config.deployment.themeId};
    if(JSON.stringify(p.config)!==JSON.stringify(expected))throw new Error('Interaction capture config mismatch.');
    if(!Array.isArray(p.actions)||p.actions.length!==config.profile.actions.length)throw new Error('Interaction actions were not completely executed.');
    let previous=p.interactionWindowStartMs;
    for(const [i,action]of p.actions.entries()){
      const {status,target,startedAtMs,finishedAtMs,...executed}=action;
      if(status!=='completed'||JSON.stringify(executed)!==JSON.stringify(config.profile.actions[i])
        ||!Number.isFinite(startedAtMs)||!Number.isFinite(finishedAtMs)||startedAtMs<previous||finishedAtMs<startedAtMs||finishedAtMs>p.interactionWindowEndMs
        ||['click','press'].includes(action.type)&&(typeof target!=='string'||!target))throw new Error('Invalid interaction action execution/timing.');
      previous=finishedAtMs;
    }
    if(profiles.length&&Date.parse(p.createdAt)<Date.parse(profiles.at(-1).finishedAt))throw new Error('Interaction capture intervals overlap; samples must be serial and independent.');
    profiles.push(p);
  }
  const identity=checkRunDeployment({manifest:{...m,config:{...config,pages:config.pages}},groups:[{records:profiles.map(p=>({report:{fetchTime:p.createdAt}}))}]});
  if(identity.status!=='verified'||profiles.some(p=>p.snapshot.hash!==identity.sourceHash))throw new Error('Interaction deployment does not bracket current-source samples.');
  return {manifest:m,profiles,identity};
}
const stats=values=>{const center=median(values);return {n:values.length,median:center,min:Math.min(...values),max:Math.max(...values),mad:median(values.map(v=>Math.abs(v-center)))};};
export async function verifyInteractions({before,after,goal,allowExploration=false}={}) {
  const result={schemaVersion:1,kind:'interaction-verification',outcome:'invalid-evidence',scope:'declared-lab-interaction-only',fieldINP:'not-established'};
  try{
    const target=goalContract(goal);if(target.kind!=='interaction')throw new Error('Expected an interaction goal.');
    const a=await readInteractionRun(before,{allowExploration}),b=await readInteractionRun(after,{allowExploration});
    const comparable=p=>{const {project,expectedThemeId,url,...config}=p.config;return {browser:p.browserVersion,environment:p.environment,url:normalizeEvidenceUrl(url),config};};
    const signature=JSON.stringify(comparable(a.profiles[0]));const timestamps=new Set();
    for(const p of [...a.profiles,...b.profiles]){
      const time=Date.parse(p.createdAt);
      if(!p.browserVersion||!p.environment?.cpuModel||!Number.isSafeInteger(p.environment?.cpuCount)||p.environment.cpuCount<1||!p.environment?.platform||!p.environment?.arch
        ||p.environment.cache!=='disabled'||p.environment.serviceWorkers!=='blocked'||JSON.stringify(comparable(p))!==signature||timestamps.has(time))throw new Error('Interaction environments differ or timestamps were reused.');timestamps.add(time);
    }
    const intervals=[...a.profiles,...b.profiles].sort((x,y)=>Date.parse(x.createdAt)-Date.parse(y.createdAt));
    if(intervals.some((p,i)=>i>0&&Date.parse(p.createdAt)<Date.parse(intervals[i-1].finishedAt)))throw new Error('Baseline and candidate interaction intervals overlap.');
    if(a.identity.store!==b.identity.store||a.identity.sourceHash===b.identity.sourceHash)throw new Error('Interaction runs need different source snapshots in the same store.');
    const collect=run=>run.profiles.map(p=>{
      const matches=p.afterActions.interactions.filter(e=>e.name===target.event&&e.target===target.target);
      if(!matches.length||matches.some(e=>![e.duration,e.inputDelay,e.processing,e.startTime].every(x=>Number.isFinite(x)&&x>=0)||e.duration<16
        ||e.inputDelay+e.processing>e.duration+8||!Number.isSafeInteger(e.interactionId)||e.interactionId<1
        ||e.startTime<p.interactionWindowStartMs||e.startTime>p.interactionWindowEndMs
        ||!p.actions.some(a=>a.target===target.target&&(a.type==='press'||a.type==='click'&&target.event!=='keydown')&&e.startTime>=a.startedAtMs&&e.startTime<=a.finishedAtMs)))throw new Error('Missing valid independently observed target interaction in an executed action. Fast unreported events remain unavailable.');
      return Math.max(...matches.map(e=>e.duration));
    });
    const left=stats(collect(a)),right=stats(collect(b)),floor=Math.max(16,3*Math.max(left.mad,right.mad)),gain=left.median-right.median;
    const targetActions=a.profiles[0].actions.filter(action=>action.target===target.target&&['click','press'].includes(action.type)
      &&(target.event!=='keydown'||action.type==='press')).map(({type,key})=>({type,...(key?{key}:{})}));
    Object.assign(result,{goal:target,targetActions,before:left,after:right,gain,floor,sourceHashes:{before:a.identity.sourceHash,after:b.identity.sourceHash},
      identity:{before:a.identity,after:b.identity},environment:comparable(a.profiles[0]),outcome:gain<=-floor?'interaction-regressed':gain>=floor?'interaction-improved':'no-measurable-gain'});
  }catch(error){result.error=error.message;}
  return result;
}

/** Match the whole deployment identity, not just equal source bytes in unrelated stores/themes. */
export function interactionMatchesNavigation(interaction,beforeIdentity,afterIdentity,beforeGroups,afterGroups) {
  if(!interaction?.identity||!interaction.environment)return false;
  return [[beforeIdentity,interaction.identity.before,beforeGroups],[afterIdentity,interaction.identity.after,afterGroups]].every(([nav,lab,groups])=>
    nav?.status==='verified'&&lab?.status==='verified'&&['sourceHash','store','themeId'].every(k=>nav[k]===lab[k])
    &&groups.some(g=>normalizeEvidenceUrl(g.url)===interaction.environment.url&&g.device===interaction.environment.config.device));
}

export function interactionBehaviorCovered(interaction,scenarios,identity) {
  if(!interaction?.goal||scenarios?.outcome!=='passed'||scenarios.sourceHash!==identity?.sourceHash||scenarios.sourceStable!==true)return false;
  const goal=interaction.goal;
  return Boolean(interaction.targetActions?.length)&& (scenarios.runs?.some(r=>normalizeEvidenceUrl(r.url)===interaction.environment.url&&r.viewport?.name===interaction.environment.config.device
    &&r.themeId===identity.themeId&&r.outcome==='passed'&&!r.constrained&&!r.blockedRequests?.length&&!r.pageErrors?.length
    &&r.steps?.every(s=>s.outcome==='passed')&&interaction.targetActions.every(a=>r.steps.some((s,i)=>s.selector===goal.target&&s.action===a.type
      &&(a.type!=='press'||s.key===a.key)&&r.steps[i+1]?.action?.startsWith('assert-')
      &&[s.elapsedMs,r.steps[i+1].elapsedMs].every(n=>Number.isFinite(n)&&n>=0))))??false);
}
