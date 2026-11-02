import {liquidAST,visitAST} from './advanced-strategies.mjs';
import {parseSchema} from './schema-json.mjs';
import {sha256} from './source-utils.mjs';
export function sourceOwnership(files=[],edges=[]) {
  const direct=new Map(files.map(f=>[f.file,/pagefly|(?:^|\/)pf-/i.test(f.file)||/pagefly|auto.?generated|automatically generated|do not (?:edit|modify)/i.test(f.text.slice(0,2500))]));
  return files.map(f=>{
    const visited=new Set([f.file]),pending=[f.file];
    for(let i=0;i<pending.length&&i<1000;i++)for(const e of edges)if(e.to===pending[i]&&!visited.has(e.from)){visited.add(e.from);pending.push(e.from);}
    const generators=pending.filter(p=>direct.get(p));
    return {file:f.file,sourceHash:f.sourceHash??sha256(f.text),status:direct.get(f.file)?'generator-managed-candidate':generators.length?'generator-referenced-candidate':'ownership-unreviewed',generators,
      action:generators.length?'confirm-generator-edit-location-before-patch':'review-theme-ownership',automaticPermission:false};
  });
}
export function compareOwnership(before=[],after=[]) {
  const current=new Map(after.map(f=>[f.file,f]));
  return before.map(f=>({file:f.file,status:!current.has(f.file)?'missing':current.get(f.file).sourceHash!==f.sourceHash?'source-changed-revalidate':'unchanged',cause:'not-inferred'}));
}
/** Conservative dependency inventory, never an unused-setting deletion authorization. */
export function structureDependencies(files=[],edges=[]) {
  return files.filter(f=>/\.liquid$/.test(f.file)).map(f=>{
    let settings=[],parseStatus='no-schema',dynamic=false;const references=[],aliases=[];
    try{visitAST(liquidAST(f.text),(n,parents)=>{
      if(parents.some(p=>p.type==='LiquidRawTag'))return;
      if(n.type==='LiquidRawTag'&&n.name==='schema'){
        try{const schema=parseSchema(n.body.value);settings=[...(schema.settings??[]).filter(s=>s.id).map(s=>({...s,scope:'section'})),
          ...(schema.blocks??[]).flatMap(b=>(b.settings??[]).filter(s=>s.id).map(s=>({...s,scope:`block:${b.type}`})))];parseStatus='parsed';}catch{parseStatus='schema-review-required';}
      }
      if(n.type==='VariableLookup'&&['section','block'].includes(n.name)&&n.lookups?.[0]?.value==='settings'){
        const id=n.lookups[1];if(id?.type==='String')references.push({scope:n.name,id:id.value});else if(id)dynamic=true;
      }
      if(n.type==='LiquidTag'&&n.name==='assign'){
        const e=n.markup?.value?.expression;if(e?.type==='VariableLookup'&&['section','block'].includes(e.name)&&e.lookups?.length===1&&e.lookups[0].value==='settings')aliases.push(n.markup.name);
      }
    });}catch{parseStatus='liquid-review-required';}
    const visibleRefs=value=>{const refs=[];if(typeof value==='string')try{visitAST(liquidAST(value),n=>{
      if(n.type==='VariableLookup'&&['section','block'].includes(n.name)&&n.lookups?.[0]?.value==='settings'&&n.lookups[1]?.type==='String')refs.push({scope:n.name,id:n.lookups[1].value});
    });}catch{}return refs;};
    return {file:f.file,sourceHash:f.sourceHash??sha256(f.text),parseStatus,topLevelSettings:settings.filter(s=>s.scope==='section').length,
      settings:settings.map(s=>({id:s.id,scope:s.scope,type:s.type,
        directReferences:references.filter(r=>r.id===s.id&&r.scope===(s.scope==='section'?'section':'block')).length,
        visibleIfDependencies:settings.filter(x=>x.scope===s.scope&&visibleRefs(x.visible_if).some(r=>r.id===s.id&&r.scope===(s.scope==='section'?'section':'block'))).map(x=>x.id),
        status:dynamic||aliases.length?'indirect-or-dynamic-review':s.scope==='section'?'reference-review':'block-scope-review',deletionAuthorized:false})),aliases,dynamic,
      callers:edges.filter(e=>e.to===f.file).map(e=>e.from),callees:edges.filter(e=>e.from===f.file).map(e=>e.to),
      performanceClaim:false,action:'Bind structure to raw Liquid costs or actual DOM/resource work before optimization.'};
  });
}

export function waiverCoverage(checks) {
  const config=checks?.metadata?.rulesConfig;
  const effective=config?.effectiveConfiguration;
  const disabled=[];
  if(typeof effective==='string')for(const block of effective.matchAll(/^([A-Za-z]\w*):[ \t]*(?:#[^\n]*)?\r?\n((?:(?:[ \t]+[^\n]*|[ \t]*)\r?\n|[ \t]+[^\n]+$)*)/gm)){
    const flags=[...block[2].matchAll(/^[ \t]+enabled:[ \t]*(true|false)[ \t]*(?:#[^\n]*)?$/gm)];
    if(flags.length===1&&flags[0][1]==='false')disabled.push(block[1]);
  }

  return {sourceStatus:checks?.complete?'checker-report-complete':'checker-report-unverified',status:typeof effective==='string'?'effective-config-observed':'configuration-unverified',disabledRules:disabled,
    configHash:config?sha256(JSON.stringify(config)):null,observationScan:'toolkit-performance-rules-independent-of-theme-disables',
    note:'Disabled rules are coverage gaps, not fixed findings. File/inline suppressions require original checker configuration and source review.'};
}
export function observationChanges(current,baseline) {
  if(!baseline)return {status:'no-baseline',added:[],absent:[]};
  if(!baseline.observationContract||!current.observationContract||baseline.kind!=='performance-audit'||baseline.project!==current.project||!baseline.complete||!current.complete||baseline.observationComplete!==true||current.observationComplete!==true
    ||JSON.stringify(baseline.observationContract)!==JSON.stringify(current.observationContract))
    return {status:'not-comparable',reason:'Complete matching project and observation contract required.'};
  const key=f=>JSON.stringify([f.file,f.ruleId,f.summary]);
  const counts=rows=>{const out=new Map();for(const f of rows)out.set(key(f),(out.get(key(f))??0)+1);return out;};
  const old=counts(baseline.findings),now=counts(current.findings);
  return {status:'same-observation-contract',added:[...now].filter(([k,n])=>n>(old.get(k)??0)).map(([key,n])=>({key,count:n-(old.get(key)??0)})),
    absent:[...old].filter(([k,n])=>n>(now.get(k)??0)).map(([key,n])=>({key,count:n-(now.get(key)??0)})),
    ownership:compareOwnership(baseline.intelligence?.ownership,current.intelligence?.ownership),
    note:'Absence is not proof of repair. Generator overwrite cause is never inferred from a hash change.'};
}
export function applyOwnershipMappings(rows,mappings=[]) {
  if(!Array.isArray(mappings)||mappings.length>1000)throw new Error('ownership must be a bounded array.');
  const names=new Map(rows.map(r=>[r.file,r.sourceHash])),seen=new Set();
  for(const m of mappings)if(!names.has(m.file)||m.sourceHash!==names.get(m.file)||seen.has(m.file)||!['theme','generator','app'].includes(m.owner)||typeof m.evidence!=='string'||!m.evidence.trim())throw new Error('Ownership needs unique current files with matching sourceHash, owner theme/generator/app and review evidence.');else seen.add(m.file);
  return rows.map(r=>{const m=mappings.find(m=>m.file===r.file);return m?{...r,status:'reviewed-ownership',owner:m.owner,evidence:m.evidence}:r;});
}
