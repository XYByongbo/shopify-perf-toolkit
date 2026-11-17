import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createRunDirectory } from './run-directory.mjs';
import { profileDomain, validDomainProfile } from './domain-profile.mjs';
import { analyzeLiquidProfile } from './liquid-profile.mjs';
import { median } from './summary.mjs';
import { normalizeEvidenceUrl } from './run-evidence.mjs';
import { fields } from './evidence-contract.mjs';
import { createBudget, validateBudget } from './execution-policy.mjs';

export function validateLiquidExperimentConfig(config) {
  fields(config,['schemaVersion','before','after','runs','budget'],'Liquid experiment');
  if(config.schemaVersion!==1||![3,5].includes(config.runs??3))throw new Error('Liquid experiments require 3 exploratory or 5 formal samples per side.');
  validateBudget(config.budget);
}

export async function runLiquidExperiment({config,output,dependencies={}}) {
  validateLiquidExperimentConfig(config);
  const out=await createRunDirectory(output),budget=createBudget(config.budget),result={schemaVersion:1,kind:'liquid-experiment',status:'running',before:[],after:[],schedule:[],counts:{attempted:0,failed:0}};
  try{
    for(let i=0;i<(config.runs??3);i++)for(const side of i%2?['after','before']:['before','after']) {
      const reason=await budget.check({attempts:result.counts.attempted,failures:result.counts.failed});if(reason)throw new Error(reason);
      const perStage=Math.min(120000,Math.floor(budget.remainingMs()/3));
      if(perStage<1000)throw new Error('Insufficient Liquid budget for both identity checks and capture.');
      result.counts.attempted++;
      const sideConfig=config[side];
      const profile=await (dependencies.profileDomain??profileDomain)({config:{...sideConfig,mode:'liquid',
        deployment:{...sideConfig?.deployment,timeoutMs:Math.min(sideConfig?.deployment?.timeoutMs??perStage,perStage)},
        profile:{timeoutMs:Math.min(sideConfig?.profile?.timeoutMs??60000,perStage)}},output:path.join(out,`${i+1}-${side}`)});
      result[side].push(profile);result.schedule.push({round:i+1,side});
    }
    result.status='complete';
  }catch(error){result.counts.failed++;result.status='invalid-evidence';result.error=error.message;}
  await writeFile(path.join(out,'liquid-evidence.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx'});return result;
}
export function verifyLiquidGain({evidence,hypothesis,beforeIdentity,afterIdentity,minSamples=3}) {
  const result={kind:'liquid-gain',outcome:'invalid-evidence',scope:'Shopify server Liquid self-time, separate from navigation scores'};
  try{
    if(evidence?.kind!=='liquid-experiment'||evidence.status!=='complete'||evidence.before?.length!==evidence.after?.length
      ||evidence.before.length<minSamples||![3,5].includes(evidence.before.length))throw new Error('Missing complete independent Liquid profile pairs.');
    const schedule=Array.from({length:evidence.before.length},(_,i)=>(i%2?['after','before']:['before','after']).map(side=>({round:i+1,side}))).flat();
    if(JSON.stringify(schedule)!==JSON.stringify(evidence.schedule)||evidence.counts?.attempted!==schedule.length||evidence.counts?.failed!==0)throw new Error('Liquid samples must preserve the complete alternating collection schedule and attempt counts.');
    let previousEnd=-Infinity;
    for(const entry of schedule) {
      const p=evidence[entry.side][entry.round-1],start=Date.parse(p.domainProof?.before?.startedAt),end=Date.parse(p.domainProof?.after?.finishedAt);
      if(!Number.isFinite(start)||!Number.isFinite(end)||start<previousEnd)throw new Error('Liquid profiles overlap or differ from the recorded collection order.');
      previousEnd=end;
    }
    const profileShape=p=>JSON.stringify(p.rawProfile.profiles.map(({name,type,unit})=>({name,type,unit})));
    const shape=profileShape(evidence.before[0]);
    const distributions={},times=new Set(),collector=evidence.before[0]?.evidence?.collector;
    for(const side of ['before','after']) {
      const expected=side==='before'?beforeIdentity:afterIdentity;
      const rows=evidence[side].map(p=>{
        if(p.kind!=='liquid-profile'||profileShape(p)!==shape||!validDomainProfile(p,p.sourceSnapshot)||p.sourceSnapshot.hash!==expected.sourceHash
          ||JSON.stringify(p.evidence.collector)!==JSON.stringify(collector)
          ||p.domainProof.before.store!==expected.store||p.domainProof.before.themeId!==expected.themeId
          ||normalizeEvidenceUrl(p.domainProof.url)!==normalizeEvidenceUrl(hypothesis.page)
          ||times.has(p.domainProof.startedAt))throw new Error('Liquid profile identity, page or independence mismatch.');
        times.add(p.domainProof.startedAt);
        const a=analyzeLiquidProfile(p.rawProfile,p.sourceSnapshot);
        const costFiles=hypothesis.kind==='liquid-render'?hypothesis.data.costFiles:[hypothesis.file];
        if(!Array.isArray(costFiles)||!costFiles.includes(hypothesis.file)||costFiles.some(f=>!p.sourceSnapshot.files.some(s=>s.file===f)))throw new Error('Missing bound Liquid cost file set.');
        const affected=a.hotspots.filter(h=>costFiles.includes(h.file));
        const duration=a.profiles.reduce((sum,p)=>sum+p.durationMs,0);
        if(!affected.length||duration<=0||a.totalSelfMs<duration*.99)throw new Error('Missing affected-file frames or incomplete accounted Liquid time; absence is not a zero-cost optimization.');
        // Added cache lines move frames: compare the affected file's self cost,
        // plus total render cost, rather than assuming unchanged line numbers.
        return {file:affected.reduce((s,h)=>s+h.selfMs,0),total:duration};
      });
      distributions[side]=Object.fromEntries(['file','total'].map(k=>{const values=rows.map(r=>r[k]),center=median(values);return[k,{median:center,mad:median(values.map(v=>Math.abs(v-center)))}];}));
    }
    result.distributions=distributions;
    const a=distributions.before,b=distributions.after;
    if(a.file.median<=0||b.total.median<=0)throw new Error('Missing measured Liquid work.');
    const gain=a.file.median-b.file.median,floor=Math.max(1,a.file.median*.05,3*Math.max(a.file.mad,b.file.mad));
    const regression=b.total.median-a.total.median>=Math.max(1,a.total.median*.05,3*Math.max(a.total.mad,b.total.mad));
    result.gainMs=gain;result.floorMs=floor;result.outcome=regression?'performance-regressed':gain>=floor?'measurable-gain':'no-measurable-gain';
  }catch(error){result.error=error.message;}
  return result;
}
