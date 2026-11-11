import {indexThemeSources,publicSourceIndex} from './source-attribution.mjs';
import {fields,digest} from './evidence-contract.mjs';
import {canonical} from './core/plan-utils.mjs';
import {deliveryPolicy} from './delivery-policy.mjs';

const defaults={liquidLines:300,snippetLines:150,componentLines:200,componentJsBytes:10240,componentCssBytes:5120};
const lines=s=>s.split(/\r?\n/).filter(l=>l.trim()).length;
function metrics(file){
  const regions=[],pattern=/{%-?\s*(schema|javascript|stylesheet)\s*-?%}[\s\S]*?{%-?\s*end\1\s*-?%}|<(script|style)\b[^>]*>[\s\S]*?<\/\2\s*>/gi;
  const body=file.text.replace(pattern,(text,liquid,html)=>{regions.push({kind:liquid??html,lines:lines(text),bytes:Buffer.byteLength(text)});return '\n';});
  return {file:file.file,sourceHash:file.sourceHash,bodyLines:lines(body),totalLines:lines(file.text),bytes:Buffer.byteLength(file.text),regions,
    counting:'Nonempty physical lines including comments. Inline regions counted separately including delimiters; mixed lines require manual review.'};
}
export async function auditPolicy({project,beforeProject,components=[],limits={},exceptions=[]}={}){
  fields(limits,Object.keys(defaults),'engineering limits');
  if(Object.values(limits).some(v=>!Number.isSafeInteger(v)||v<0))throw new Error('Limits must be nonnegative integers.');
  if(!Array.isArray(components)||new Set(components).size!==components.length||components.some(f=>typeof f!=='string'||!/^assets\/.+\.(m?js|css)$/.test(f)))throw new Error('Explicit component assets required; aggregates are not presumed components.');
  if(!Array.isArray(exceptions))throw new Error('Invalid policy exceptions.');
  for(const e of exceptions){fields(e,['file','rule','reason','responsible','expiresAt'],'policy exception');if(![e.file,e.rule,e.reason,e.responsible].every(v=>typeof v==='string'&&v.trim())||!Number.isFinite(Date.parse(e.expiresAt)))throw new Error('Incomplete exception.');}
  const index=await indexThemeSources(project),baseline=beforeProject?await indexThemeSources(beforeProject):null;
  const effective={...defaults,...limits},findings=[],observations=[];
  const add=(f,rule,value,limit,previous)=>{
    const exception=exceptions.find(e=>e.file===f.file&&e.rule===rule);
    findings.push({file:f.file,sourceHash:f.sourceHash,rule,value,limit,previous:previous??null,
      introducedOrWorsened:previous===undefined||previous<=limit||value>previous,
      exception:exception?{...exception,status:Date.parse(exception.expiresAt)>Date.now()?'active-review-required':'expired'}:null});
  };
  for(const file of index.files){
    const old=baseline?.files.find(f=>f.file===file.file),m=metrics(file),a=old?metrics(old):null;
    observations.push({...m,changed:!old||old.sourceHash!==file.sourceHash});
    if(file.file.endsWith('.liquid')){const limit=file.file.startsWith('snippets/')?effective.snippetLines:effective.liquidLines;if(m.bodyLines>limit)add(file,'body-lines',m.bodyLines,limit,a?.bodyLines);}
    if(components.includes(file.file)){
      if(m.totalLines>effective.componentLines)add(file,'component-lines',m.totalLines,effective.componentLines,a?.totalLines);
      const limit=file.file.endsWith('.css')?effective.componentCssBytes:effective.componentJsBytes;
      if(m.bytes>limit)add(file,'component-source-bytes',m.bytes,limit,a?.bytes);
    }
  }
  for(const f of components)if(!index.files.some(x=>x.file===f))throw new Error('Declared component missing: '+f);
  const edgeKey=e=>canonical({from:e.from,to:e.to,kind:e.kind});
  const oldEdges=new Set(baseline?.edges.map(edgeKey)??[]);
  const addedDependencies=index.edges.filter(e=>!oldEdges.has(edgeKey(e)));
  const changed=new Set(observations.filter(o=>o.changed).map(o=>o.file));
  const sharedChanges=[...changed].map(file=>({file,callers:[...new Set(index.edges.filter(e=>e.to===file).map(e=>e.from))]})).filter(f=>f.callers.length>1);
  return {schemaVersion:1,kind:'engineering-policy-audit',status:findings.some(f=>f.introducedOrWorsened)||index.unresolved.length?'review-required':'passed',
    policy:{id:'engineering-v1',version:1,source:'project',limits:effective,components,hash:digest(canonical({effective,components,exceptions}))},
    sourceHash:index.snapshot.hash,beforeSourceHash:baseline?.snapshot.hash??null,findings,observations,addedDependencies,sharedChanges,unresolved:index.unresolved,
    registry:deliveryPolicy.rules,notAssessed:['Official complexity/nesting/settings: use actual Theme Check results.','Semantic duplication, minified lines, inline component ownership and CSS equivalence require review.'],
    graph:publicSourceIndex(index),note:'Source bytes are uncompressed engineering budgets, not transferred bytes. No thresholds relax performance or business gates.'};
}
