import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {importFieldData,normalizeFieldData} from './field-data.mjs';
import {fields,digest,readEvidenceJSON} from './evidence-contract.mjs';
import {canonical} from './core/plan-utils.mjs';
import {createRunDirectory} from './measure.mjs';

const key=g=>canonical([g.url,g.scope,g.pageType,g.device,g.country??null,g.target??null]);
function validateRelease(r){fields(r,['version','sourceHash','deployedAt'],'field release');if(!r.version||!/^[a-f0-9]{64}$/.test(r.sourceHash??'')||!Number.isFinite(Date.parse(r.deployedAt)))throw new Error('Release needs version, sourceHash and deployment time.');}
export function compareFieldSnapshots(current,previous,{now=Date.now(),maxRelativeIncrease=0.1}={}){
  if(!Number.isFinite(maxRelativeIncrease)||maxRelativeIncrease<0)throw new Error('Invalid relative increase.');
  validateRelease(current.release);if(previous)validateRelease(previous.release);
  const c=normalizeFieldData(current.field,{now}),p=previous?normalizeFieldData(previous.field,{now}):null;
  const mixed=Date.parse(current.release.deployedAt)>Date.parse(c.window.start),alerts=[],groups=[];
  for(const g of c.groups){
    const old=p?.groups.find(x=>key(x)===key(g));
    const reasons=[...g.issues];
    if(mixed)reasons.push('release-mixed-window');
    if(!old)reasons.push('no-matching-baseline');
    if(old?.status!=='usable'&&old)reasons.push('baseline-limited');
    if(previous&&current.sourceId!==previous.sourceId||p&&c.source!==p.source)reasons.push('source-changed');
    if(p&&Date.parse(p.window.end)>=Date.parse(c.window.start))reasons.push('overlapping-or-repeated-windows');
    if(p&&Date.parse(previous.release.deployedAt)>Date.parse(p.window.start))reasons.push('baseline-release-mixed');
    if(p&&Date.parse(p.window.end)-Date.parse(p.window.start)!==Date.parse(c.window.end)-Date.parse(c.window.start))reasons.push('different-window-length');
    const deltas={};
    if(!reasons.length)for(const [metric,value] of Object.entries(g.metrics))if(old.metrics[metric]!==undefined){
      deltas[metric]=value-old.metrics[metric];
      if(value>old.metrics[metric]*(1+maxRelativeIncrease))alerts.push({type:'trend-regression',group:key(g),metric,before:old.metrics[metric],after:value,sourceVersion:current.release.version});
    }
    if(g.assessment.thresholdEligible&&!mixed)for(const breach of g.breaches)alerts.push({type:'experience-threshold',group:key(g),...breach,sourceVersion:current.release.version,
      evidence:{source:c.source,url:g.url,scope:g.scope,device:g.device,window:c.window,percentile:75,
        samples:g.samples,sampleCountKnown:g.assessment.sampleCountKnown,releaseAttribution:'not-established'}});
    groups.push({key:key(g),status:reasons.length?'limited':'comparable',reasons,deltas,samples:g.samples,assessment:g.assessment});
  }
  return {schemaVersion:1,kind:'field-trend',status:alerts.length?'review-required':groups.some(g=>g.status==='limited')?'limited':'passed',alerts,groups,
    note:'Descriptive segment comparisons only. Never average p75 or sum sample counts; overlapping windows cannot establish a before/after effect.'};
}
export function validateMonitorConfig(config) {
  fields(config,['schemaVersion','sources','previous','schedule','maxRelativeIncrease'],'field monitor');
  if(config.schemaVersion!==1||!Array.isArray(config.sources)||!config.sources.length||config.sources.length>20||new Set(config.sources.map(s=>s.id)).size!==config.sources.length)throw new Error('Monitor requires 1–20 unique approved sources.');
  for(const s of config.sources){fields(s,['id','input','approvalRef','release'],'field source');validateRelease(s.release);if(!s.id||!s.approvalRef||!path.isAbsolute(s.input??''))throw new Error('Explicit approved local export source required.');}
  const schedule=config.schedule??{cycles:1,intervalMs:60000};fields(schedule,['cycles','intervalMs'],'field schedule');
  if(!Number.isInteger(schedule.cycles)||schedule.cycles<1||schedule.cycles>100||!Number.isInteger(schedule.intervalMs)||schedule.intervalMs<1000||schedule.intervalMs>86400000)throw new Error('Bounded cycles and interval required.');
  if(!Array.isArray(config.previous??[]))throw new Error('previous must reference saved snapshots.');
  return schedule;
}

/** Bounded scheduler for approved export sources; no shoppers, credentials or outbound alerts. */
export async function monitorField({config,output},{sleep=ms=>new Promise(r=>setTimeout(r,ms)),now=()=>Date.now()}={}){
  const schedule=validateMonitorConfig(config);
  const history=await Promise.all((config.previous??[]).map(f=>readEvidenceJSON(f))),out=await createRunDirectory(output),result={schemaVersion:1,kind:'field-monitor',status:'complete',output:out,cycles:[],configHash:digest(canonical(config))};
  for(let cycle=0;cycle<schedule.cycles;cycle++){
    if(cycle)await sleep(schedule.intervalMs);
    const directory=path.join(out,`cycle-${cycle+1}`);await mkdir(directory);const records=[];
    for(const source of config.sources){
      try{
        const field=await importFieldData({input:source.input,policy:{now:now()}});
        const snapshot={schemaVersion:1,kind:'field-snapshot',sourceId:source.id,approvalRef:source.approvalRef,release:source.release,field,collectedAt:new Date(now()).toISOString()};
        const previous=history.filter(s=>s.sourceId===source.id).sort((a,b)=>Date.parse(b.field.window.end)-Date.parse(a.field.window.end))[0];
        const trend=compareFieldSnapshots(snapshot,previous,{now:now(),maxRelativeIncrease:config.maxRelativeIncrease??0.1});
        const index=config.sources.indexOf(source)+1;
        await writeFile(path.join(directory,`source-${index}.json`),JSON.stringify(snapshot,null,2),{flag:'wx',mode:0o600});
        await writeFile(path.join(directory,`trend-${index}.json`),JSON.stringify(trend,null,2),{flag:'wx',mode:0o600});
        records.push({sourceId:source.id,status:trend.status,snapshot:`cycle-${cycle+1}/source-${index}.json`,trend:`cycle-${cycle+1}/trend-${index}.json`,alerts:trend.alerts});history.push(snapshot);
      }catch(error){records.push({sourceId:source.id,status:'failed',error:error.message});}
    }
    result.cycles.push({cycle:cycle+1,records});
  }
  if(result.cycles.some(c=>c.records.some(r=>r.status!=='passed')))result.status='review-required';
  result.scope='Approved aggregate exports only; no automatic storefront instrumentation, remote publication, email or webhook.';
  await writeFile(path.join(out,'monitor.json'),JSON.stringify(result,null,2),{flag:'wx',mode:0o600});return result;
}
