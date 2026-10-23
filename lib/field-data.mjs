import { readFile, stat } from 'node:fs/promises';
import { fields, isObject, evidenceEnvelope } from './evidence-contract.mjs';

const metrics = ['lcp','inp','cls','ttfb','fcp'];
const limits = { lcp: 2500, inp: 200, cls: 0.1, ttfb: 800, fcp: 1800 };
function pageURL(value) {
  const u = new URL(value);
  if (!['http:','https:'].includes(u.protocol) || u.username || u.password || u.hash || u.search) throw new Error('Field URLs must be HTTP(S), without credentials, query or fragment.');
  return u.href;
}
function date(value) {
  const match=typeof value==='string'&&value.match(/^(\d{4})-(\d{2})-(\d{2})(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))?$/);
  const n=Date.parse(value);
  if(!match||!Number.isFinite(n)||new Date(Date.UTC(Number(match[1]),Number(match[2])-1,Number(match[3]))).toISOString().slice(0,10)!==value.slice(0,10))throw new Error('Invalid field window date.');
  return n;
}

/** RFC4180-style exported summary CSV; not individual shopper events. */
export function parseFieldCSV(text) {
  const rows = []; let row = [], cell = '', quoted = false, closed = false;
  text = text.replace(/^\uFEFF/,'');
  for (let i=0;i<text.length;i++) {
    const c=text[i];
    if (quoted) { if(c==='"' && text[i+1]==='"'){cell+='"';i++;} else if(c==='"'){quoted=false;closed=true;} else cell+=c; }
    else if(c==='"') { if(cell || closed) throw new Error('Invalid CSV quote.'); quoted=true; }
    else if(c===',' || c==='\n' || c==='\r') {
      row.push(cell); cell='';closed=false;
      if(c!==','){if(c==='\r'&&text[i+1]==='\n')i++;if(row.some(Boolean))rows.push(row);row=[];}
    } else { if(closed)throw new Error('Unexpected content after CSV quote.');cell+=c; }
  }
  if(quoted)throw new Error('Unterminated CSV quote.');
  row.push(cell);if(row.some(Boolean))rows.push(row);
  const header=rows.shift();
  const allowed=['source','windowStart','windowEnd','url','pageType','device','country','target','samples',...metrics];
  if(!header || new Set(header).size!==header.length || header.some(k=>!allowed.includes(k)))throw new Error('Invalid field CSV header.');
  const values=rows.map(r=>{if(r.length!==header.length)throw new Error('Field CSV row width differs.');return Object.fromEntries(header.map((k,i)=>[k,r[i]]));});
  if(!values.length)throw new Error('Field CSV has no groups.');
  const first=values[0];
  if(values.some(r=>['source','windowStart','windowEnd'].some(k=>r[k]!==first[k])))throw new Error('CSV groups must share source and window.');
  return {schemaVersion:1,source:first.source,window:{start:first.windowStart,end:first.windowEnd},groups:values.map(r=>({url:r.url,pageType:r.pageType,device:r.device,country:r.country||null,...(r.target?.trim()?{target:r.target}:{}),
    samples:r.samples?.trim()?Number(r.samples):null,metrics:Object.fromEntries(metrics.filter(k=>r[k]?.trim()).map(k=>[k,Number(r[k])]))}))};
}

/** CrUX API response adapter. Never invent a sample count or template identity. */
export function adaptCrux(input) {
  const record=input.record ?? input.loadingExperience;
  if(!record?.metrics)throw new Error('Expected a CrUX record.');
  const key=record.key;
  if(!key || !record.collectionPeriod)throw new Error('CrUX import needs key and collectionPeriod; PSI alone may not supply them.');
  if(key.formFactor!==undefined&&!['PHONE','DESKTOP','TABLET'].includes(key.formFactor))throw new Error('Unknown CrUX formFactor; cannot broaden it to all devices.');
  const iso=d=>`${d.year}-${String(d.month).padStart(2,'0')}-${String(d.day).padStart(2,'0')}`;
  const names={largest_contentful_paint:'lcp',interaction_to_next_paint:'inp',cumulative_layout_shift:'cls',experimental_time_to_first_byte:'ttfb',first_contentful_paint:'fcp'};
  return {schemaVersion:1,source:'crux',window:{start:iso(record.collectionPeriod.firstDate),end:iso(record.collectionPeriod.lastDate)},groups:[{
    url:key.url??key.origin,pageType:'unknown',device:{PHONE:'mobile',DESKTOP:'desktop',TABLET:'tablet'}[key.formFactor]??'all',scope:key.url?'url':'origin',samples:null,
    metrics:Object.fromEntries(Object.entries(names).filter(([k])=>{
      const value=record.metrics[k]?.percentiles?.p75;
      return (typeof value==='number'||typeof value==='string'&&value.trim()!=='')&&Number.isFinite(Number(value));
    }).map(([k,v])=>[v,Number(record.metrics[k].percentiles.p75)]))}]};
}

export function normalizeFieldData(input, { now = Date.now(), maxAgeDays = 35, minSamples = 100 } = {}) {
  if(input?.kind==='field-evidence')input={schemaVersion:1,source:input.source,window:input.window,groups:input.groups.map(({url,scope,pageType,device,country,samples,metrics,target})=>({url,scope,pageType,device,country,samples,metrics,...(target?{target}:{})}))};
  if(input?.record)input=adaptCrux(input);
  fields(input,['schemaVersion','source','window','groups'],'field data');
  if(input.schemaVersion!==1 || !['shopify-rum','crux','rum-export'].includes(input.source))throw new Error('Unsupported field data source/schema.');
  fields(input.window,['start','end'],'field window');
  const start=date(input.window.start),end=date(input.window.end);
  if(!Number.isFinite(now)||start>end||end>now||!Number.isFinite(maxAgeDays)||maxAgeDays<1||!Number.isSafeInteger(minSamples)||minSamples<1)throw new Error('Invalid field window or import policy.');
  if(!Array.isArray(input.groups)||!input.groups.length||input.groups.length>10000)throw new Error('Field import requires 1..10000 groups.');
  const seen=new Set();
  const groups=input.groups.map(g=>{
    fields(g,['url','scope','pageType','device','country','samples','metrics','target'],'field group');
    const url=pageURL(g.url),scope=g.scope??'url';
    if(!['url','origin'].includes(scope)||scope==='origin'&&new URL(url).pathname!=='/' || !['home','product','collection','other','unknown'].includes(g.pageType)
       || !['mobile','desktop','tablet','all'].includes(g.device) || (g.country!=null&&!/^[A-Z]{2}$/.test(g.country))
       || (g.samples!=null&&(!Number.isSafeInteger(g.samples)||g.samples<1)) || (g.target!=null&&(typeof g.target!=='string'||!g.target.trim()||g.target.length>512)))throw new Error('Invalid field group scope, device, country, target or count.');
    if(!isObject(g.metrics)||!Object.keys(g.metrics).length||Object.entries(g.metrics).some(([k,v])=>!metrics.includes(k)||!Number.isFinite(v)||v<0))throw new Error('Field metrics must contain numeric p75 values in ms (CLS unitless).');
    const key=JSON.stringify([url,scope,g.pageType,g.device,g.country??null,g.target??null]);
    if(seen.has(key))throw new Error('Duplicate field group.');seen.add(key);
    const issues=[];
    if(now-end>maxAgeDays*86400000)issues.push('stale-window');
    if(g.samples==null)issues.push('sample-count-unavailable');else if(g.samples<minSamples)issues.push('insufficient-samples');
    const breaches=Object.entries(g.metrics).filter(([k,v])=>v>limits[k]).map(([metric,value])=>({metric,value,threshold:limits[metric],ratio:value/limits[metric]}));
    return {...g,url,scope,country:g.country??null,samples:g.samples??null,percentile:75,status:issues.length?'limited':'usable',issues,breaches};
  });
  return {schemaVersion:1,kind:'field-evidence',source:input.source,window:input.window,importedAt:new Date(now).toISOString(),policy:{maxAgeDays,minSamples},groups,
    status:groups.some(g=>g.status==='usable')?'available':'limited',evidence:evidenceEnvelope({type:'field',input,scope:{window:input.window,percentile:75}}),
    limitations:['Aggregated field p75 values are not source/deployment identity, a lab sample, or causal patch acceptance.', 'Unknown count, country or template stays unknown. Percentile differences only screen suspect phases; traces must verify them.']};
}

export async function importFieldData({ input, policy }={}) {
  if(typeof input!=='string')return normalizeFieldData(input,policy);
  if((await stat(input)).size>16*1024*1024)throw new Error('Field export exceeds 16 MiB.');
  const text=await readFile(input,'utf8');
  return normalizeFieldData(input.toLowerCase().endsWith('.csv')?parseFieldCSV(text):JSON.parse(text),policy);
}

export function matchingFieldSegments(field, url, device, {target=null}={}) {
  if(!field)return [];
  const u=new URL(url);
  return field.groups.filter(g=>(g.target==null||g.target===target)&&(g.device===device||g.device==='all')&&(g.scope==='origin'?new URL(g.url).origin===u.origin:new URL(g.url).origin+new URL(g.url).pathname===u.origin+u.pathname));
}

export function fieldSegments(field, url, device, scope) {
  if(!field)return [];
  // Recompute freshness/count eligibility; never trust edited status flags in a saved envelope.
  const original={schemaVersion:1,source:field.source,window:field.window,groups:field.groups.map(({url,scope,pageType,device,country,samples,metrics,target})=>({url,scope,pageType,device,country,samples,metrics,...(target?{target}:{})}))};
  const normalized=normalizeFieldData(original,{...field.policy,now:Date.now()});
  return matchingFieldSegments(normalized,url,device,scope);
}
