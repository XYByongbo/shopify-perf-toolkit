const types = new Set(['document','script','stylesheet','image','media','font','other','third-party']);
import {readEvidenceJSON,fields,digest} from './evidence-contract.mjs';
import {canonical} from './core/plan-utils.mjs';
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const nonnegative = v => Number.isSafeInteger(v) && v >= 0;

export function validateResourceBudget(config) {
  if (!object(config) || !Object.keys(config).length || Object.keys(config).some(k =>
    !['maxTotalTransferBytes','maxByType','maxRequests'].includes(k))) throw new Error('Invalid resource budget fields.');
  for (const key of ['maxTotalTransferBytes','maxRequests']) if (Object.hasOwn(config,key) && !nonnegative(config[key]))
    throw new Error(`${key} must be a nonnegative safe integer.`);
  if (Object.hasOwn(config,'maxByType') && (!object(config.maxByType) || !Object.keys(config.maxByType).length
    || Object.entries(config.maxByType).some(([type,limit]) => !types.has(type) || !nonnegative(limit))))
    throw new Error('maxByType requires known Lighthouse resource types and nonnegative byte limits.');
  return config;
}

/** Hard limits per navigation, never summed across pages/samples or overlapping rows. */
export function checkPerformanceBudget(candidate, config) {
  validateResourceBudget(config);
  if (!candidate.groups?.length) throw new Error('Resource budget requires measurement groups.');
  const details = [];
  for (const group of candidate.groups) {
    if (!group.records?.length) throw new Error('Resource budget requires samples for every group.');
    for (const [index,record] of group.records.entries()) {
      const where = `${group.pageId}/${group.device}/${record.relative ?? index + 1}`;
      const audit = record.report.audits?.['resource-summary'], items = audit?.details?.items;
      if (!Array.isArray(items) || !items.length || audit.errorMessage || ['error','notApplicable'].includes(audit.scoreDisplayMode))
        throw new Error(`Missing resource-summary evidence: ${where}`);
      const rows = new Map();
      for (const row of items) {
        if (!object(row) || typeof row.resourceType !== 'string' || rows.has(row.resourceType)
          || !nonnegative(row.transferSize) || !nonnegative(row.requestCount)) throw new Error(`Invalid resource-summary row: ${where}`);
        rows.set(row.resourceType,row);
      }
      const total = rows.get('total');
      if (!total || [...rows.values()].some(r => r.transferSize > total.transferSize || r.requestCount > total.requestCount))
        throw new Error(`Missing or inconsistent resource-summary total: ${where}`);
      const disjoint=[...rows.values()].filter(r=>types.has(r.resourceType)&&r.resourceType!=='third-party');
      if(disjoint.reduce((sum,r)=>sum+r.transferSize,0)>total.transferSize
        ||disjoint.reduce((sum,r)=>sum+r.requestCount,0)>total.requestCount)
        throw new Error(`Resource-summary categories exceed total: ${where}`);
      const check = (metric,value,limit) => details.push({pageId:group.pageId,device:group.device,
        sample:record.relative ?? index + 1,metric,value,limit,passed:value <= limit});
      if (config.maxTotalTransferBytes !== undefined) check('totalTransferBytes',total.transferSize,config.maxTotalTransferBytes);
      if (config.maxRequests !== undefined) check('requestCount',total.requestCount,config.maxRequests);
      for (const [type,limit] of Object.entries(config.maxByType ?? {})) {
        if (!rows.has(type)) throw new Error(`Missing resource-summary ${type} evidence: ${where}`);
        check(`transferBytes:${type}`,rows.get(type).transferSize,limit);
      }
    }
  }
  return {passed:details.every(d => d.passed),scope:'every-page-device-sample',details,
    note:'Configured resource budgets are hard per-navigation limits; score, gain and behavior gates still apply.'};
}

export function validateWindows(config){
  fields(config,['profiles','beforeProfiles','windows','owners','exceptions'],'window budget');
  if(!Array.isArray(config.profiles)||!config.profiles.length||config.profiles.length>24||!Array.isArray(config.windows)||!config.windows.length||config.windows.length>20)throw new Error('Bounded profiles and explicit windows required.');
  const ids=new Set();
  for(const w of config.windows){
    fields(w,['id','fromMs','toMs','anchor','owner','component','maxTransferBytes','maxRequests','maxDeltaBytes'],'budget window');
    if(typeof w.id!=='string'||!w.id||ids.has(w.id)||!nonnegative(w.fromMs)||!nonnegative(w.toMs)||w.toMs<=w.fromMs||w.toMs>300000||!['navigation','interaction'].includes(w.anchor??'navigation'))throw new Error('Invalid window interval/id.');
    ids.add(w.id);
    for(const k of ['maxTransferBytes','maxRequests','maxDeltaBytes'])if(w[k]!==undefined&&!nonnegative(w[k]))throw new Error('Window limits must be nonnegative integers.');
    if(!['maxTransferBytes','maxRequests','maxDeltaBytes'].some(k=>w[k]!==undefined))throw new Error('Window needs a limit.');
    if(w.owner!==undefined&&!['theme','app','platform'].includes(w.owner))throw new Error('Unknown owner category.');
    if(w.component!==undefined&&(typeof w.component!=='string'||!w.component))throw new Error('Invalid component.');
  }
  if(!Array.isArray(config.owners??[])||(config.owners?.length??0)>200)throw new Error('Invalid owners.');
  for(const o of config.owners??[]){fields(o,['origin','pathPrefix','owner','component'],'window ownership');
    if(new URL(o.origin).origin!==o.origin||!['https:','http:'].includes(new URL(o.origin).protocol)||!o.pathPrefix?.startsWith('/')||!['theme','app','platform'].includes(o.owner))throw new Error('Explicit origin/path ownership required.');}
  if(!Array.isArray(config.exceptions??[]))throw new Error('Invalid exceptions.');
  for(const e of config.exceptions??[]){fields(e,['window','url','device','reason','responsible','expiresAt'],'budget exception');
    if(!ids.has(e.window)||![e.url,e.device,e.reason,e.responsible].every(v=>typeof v==='string'&&v.trim())||!Number.isFinite(Date.parse(e.expiresAt)))throw new Error('Exception requires scope, reason, owner and expiry.');}
  return config;
}
function profileKey(p){const u=new URL(p.config.url);u.searchParams.delete('preview_theme_id');return canonical({url:u.href,device:p.config.device,state:p.config.state??null});}
function windowSample(p,w,owners){
  const capture=p.networkCapture,issues=[],rows=[];
  if(p.kind!=='runtime-profile'||p.status!=='complete'||p.sourceStable===false||capture?.complete!==true||capture.truncated||capture.redirectsTruncated)issues.push('incomplete-profile');
  const origin=w.anchor==='interaction'?capture?.interactionStart:capture?.navigationStart;
  const start=origin+w.fromMs/1000,end=origin+w.toMs/1000;
  if(!Number.isFinite(origin)||!Number.isFinite(capture?.captureEnd)||capture.captureEnd<end)issues.push('window-not-covered');
  const seen=new Set();
  for(const r of p.resources??[]){
    if(!Number.isFinite(r.timestamp)){issues.push('request-time-unavailable');continue;}
    if(r.timestamp<start||r.timestamp>=end)continue;
    const key=`${r.id}:${r.redirectHop??0}`;if(seen.has(key)){issues.push('duplicate-request-record');continue;}seen.add(key);
    let u;try{u=new URL(r.url);}catch{issues.push('invalid-resource-url');continue;}
    const matches=owners.filter(o=>u.origin===o.origin&&u.pathname.startsWith(o.pathPrefix));
    const owner=matches.length===1?matches[0]:null;
    if((w.owner||w.component)&&!owner){issues.push('ownership-unknown-or-ambiguous');continue;}
    if(w.owner&&w.owner!==owner.owner||w.component&&w.component!==owner.component)continue;
    const bytes=nonnegative(r.transferBytes)?r.transferBytes:null;
    if(bytes===null||!Number.isFinite(r.finishedTimestamp)||r.finishedTimestamp>capture?.captureEnd||r.error)issues.push('request-incomplete-or-bytes-unknown');
    rows.push({id:r.id,hop:r.redirectHop??0,url:r.url,owner:owner?.owner??'unknown',component:owner?.component??null,
      transferBytes:bytes,cached:Boolean(r.fromDiskCache||r.fromMemoryCache),failed:Boolean(r.error),startedMs:(r.timestamp-origin)*1000});
  }
  return {complete:!issues.length,issues:[...new Set(issues)],requests:rows.length,
    transferBytes:rows.some(r=>r.transferBytes===null)?null:rows.reduce((n,r)=>n+r.transferBytes,0),rows};
}
/** Reuse raw CDP requests. Windows overlap intentionally; their totals are never added together. */
export async function auditWindowBudget(input){
  const config=validateWindows(input),read=async p=>typeof p==='string'?readEvidenceJSON(p):p;
  const profiles=await Promise.all(config.profiles.map(read)),before=await Promise.all((config.beforeProfiles??[]).map(read)),details=[];
  if(new Set(profiles.map(profileKey)).size!==profiles.length||new Set(before.map(profileKey)).size!==before.length)throw new Error('One profile per page/device/state; do not merge repeated samples or windows.');
  for(const p of profiles)for(const w of config.windows){
    const sample=windowSample(p,w,config.owners??[]),checks=[];
    if(w.maxTransferBytes!==undefined)checks.push({metric:'transferBytes',value:sample.transferBytes,limit:w.maxTransferBytes,pass:sample.transferBytes!==null&&sample.transferBytes<=w.maxTransferBytes});
    if(w.maxRequests!==undefined)checks.push({metric:'requests',value:sample.requests,limit:w.maxRequests,pass:sample.requests<=w.maxRequests});
    if(w.maxDeltaBytes!==undefined){
      const baseline=before.find(q=>profileKey(q)===profileKey(p));
      const a=baseline?windowSample(baseline,w,config.owners??[]):null;
      const same=baseline&&canonical(baseline.environment??null)===canonical(p.environment??null)&&baseline.browserVersion===p.browserVersion;
      const delta=a?.complete&&sample.complete&&same?sample.transferBytes-a.transferBytes:null;
      checks.push({metric:'deltaTransferBytes',value:delta,limit:w.maxDeltaBytes,pass:delta!==null&&delta<=w.maxDeltaBytes});
    }
    const exception=(config.exceptions??[]).find(e=>e.window===w.id&&e.url===p.config.url&&e.device===p.config.device);
    details.push({window:w.id,url:p.config.url,device:p.config.device,...sample,checks,pass:sample.complete&&checks.every(c=>c.pass),
      exception:exception?{...exception,status:Date.parse(exception.expiresAt)>Date.now()?'active-review-required':'expired'}:null});
  }
  return {schemaVersion:1,kind:'window-budget',status:details.every(d=>d.pass)?'passed':'review-required',configHash:digest(canonical(config)),details,
    metric:'CDP encodedDataLength transferred bytes, distinct from decoded body size and Lighthouse resource-summary',
    scope:'Requests starting in each half-open window, counted once per request/hop; completed transferred bytes may extend past window end. Never sum overlapping windows.',
    acceptance:'diagnostic-budget-only-not-performance-acceptance'};
}
