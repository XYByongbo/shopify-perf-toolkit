import { sourceSnapshot } from './runtime-profile.mjs';
import { requireHypothesis } from './bottlenecks.mjs';
import { targetNodes } from './domain-candidates.mjs';
import { readTarget } from './changes.mjs';
import { createSitePlan } from './site-changes.mjs';
import { transformCode } from './code-strategies.mjs';
import { filterArgument, lookupPath } from './performance-syntax.mjs';
import { fields } from './evidence-contract.mjs';
import { validDomainProfile } from './domain-profile.mjs';
import { normalizeEvidenceUrl } from './run-evidence.mjs';
import {createExtendedPlan} from './extended-plan.mjs';
import {extendedContracts} from './extended-methods.mjs';
import {themeContracts} from './theme-methods.mjs';
import {createThemePlan} from './theme-plan.mjs';

const fail=(message,code='UNSUPPORTED_CODE_PATTERN')=>{throw Object.assign(new Error(message),{code});};
function updateImage(source,n,updates) {
  const edits=[];
  if(n.filter) {
    for(const [name,value] of Object.entries(updates)) {
      const arg=filterArgument(n.filter,name);
      if(arg&&arg.value.type!=='String')fail('Dynamic image attribute requires a custom reviewed replacement.');
      if(arg)edits.push({start:arg.value.position.start,end:arg.value.position.end,text:JSON.stringify(value)});
    }
    const missing=Object.entries(updates).filter(([k])=>!filterArgument(n.filter,k));
    if(missing.length)edits.push({start:n.filter.position.end,end:n.filter.position.end,text:(n.filter.args.length?', ':': ')+missing.map(([k,v])=>`${k}: ${JSON.stringify(v)}`).join(', ')});
  }else{
    const missing=[];
    for(const [name,value] of Object.entries(updates)) {
      const attr=n.attrs.get(name);
      if(attr && !attr.value?.every(p=>p.type==='TextNode'))fail('Dynamic image attributes must remain explicit.');
      if(attr)edits.push({start:attr.position.start,end:attr.position.end,text:`${name}="${value}"`});else missing.push(` ${name}="${value}"`);
    }
    const end=n.node.position.end,tail=source.slice(n.offset,end),at=end-(tail.endsWith('/>')?2:1);
    if(missing.length)edits.push({start:at,end:at,text:missing.join('')});
  }
  for(const e of edits.sort((a,b)=>b.start-a.start))source=source.slice(0,e.start)+e.text+source.slice(e.end);
  return source;
}
function imageRatio(n,t) {
  const src=n.attrs.get('src');
  if(src?.value?.length===1&&src.value[0].type==='LiquidVariableOutput') {
    const m=src.value[0].markup,p=lookupPath(m.expression);
    if(!p||m.filters?.length!==1||m.filters[0].name!=='image_url'||m.filters[0].args.some(a=>a.type!=='NamedArgument'||a.name!=='width'))fail('Dynamic crop/ratio needs explicit responsive review, not a sampled constant.');
    return {width:`{{ ${p}.width }}`,height:`{{ ${p}.height }}`,ratio:`{{ ${p}.aspect_ratio }}`};
  }
  if(!src?.value?.every(x=>x.type==='TextNode'))fail('Cannot derive a stable intrinsic ratio from this source.');
  return {width:String(t.naturalWidth),height:String(t.naturalHeight),ratio:`${t.naturalWidth} / ${t.naturalHeight}`};
}

/** Generate actual code; review flags are supplied, never inferred from a score. */
export function validateDomainPlanConfig(config) {
  fields(config,['schemaVersion','candidateId','method','review','breakpoint','newAsset','sectionSelector','initialLiquid'],'domain plan');
  if(config.schemaVersion!==1)fail('Unsupported domain plan schema.');
}

export async function createDomainPlan({project,diagnosis,config,profiles=[]}) {
  validateDomainPlanConfig(config);
  if(themeContracts[config.method])return createThemePlan({project,diagnosis,config});
  if(extendedContracts[config.method])return createExtendedPlan({project,diagnosis,config});
  const snapshot=await sourceSnapshot(project),c=requireHypothesis(diagnosis,config.candidateId,snapshot);
  if(!c.methods?.includes(config.method))fail('Select a method offered by this measured domain hypothesis.');
  const review=config.review;
  if(!review?.summary?.trim())fail('A concrete source/behavior review summary is required.','REVIEW_REQUIRED');
  const need=(...keys)=>{for(const k of keys)if(review[k]!==true)fail(`Domain plan requires reviewed ${k}.`,'REVIEW_REQUIRED');};
  const {source}=await readTarget(project,c.file),n=targetNodes([{file:c.file,text:source}]).find(n=>n.offset===c.binding.offset);
  const evidence={...review,sourceHash:c.source.sourceHash,candidateId:c.candidateId,diagnosisSourceHash:snapshot.hash,
    domainKind:c.kind,domainMethod:config.method,domainPage:c.page,domainTarget:c.data.target?.id??null};
  let after;
  if(c.kind==='image-lcp') {
    need('sharedInstancesReviewed');if(!n)fail('Image parser binding changed.');
    after=updateImage(source,n,config.method==='image-eager'?{loading:'eager'}:{loading:'eager',fetchpriority:'high'});
  }else if(c.kind==='image-cls') {
    need('sharedInstancesReviewed','responsiveRatioReviewed');if(!n||n.filter)fail('Select a direct img with derivable dimensions.');
    const ratio=imageRatio(n,c.data.target);
    if(config.method==='image-dimensions')after=updateImage(source,n,{width:ratio.width,height:ratio.height});
    else {
      const style=n.attrs.get('style');if(style && !style.value?.every(x=>x.type==='TextNode'))fail('Dynamic inline style cannot be rewritten.');
      const original=style?.value.map(x=>x.value).join('')??'';
      if(/aspect-ratio/i.test(original))fail('Existing aspect ratio needs custom review.');
      after=updateImage(source,n,{style:original+`; aspect-ratio: auto ${ratio.ratio};`});
    }
  }else if(c.kind==='app-loader') {
    need('dependenciesReviewed','nonCritical','documentWriteAbsent','businessEventsReviewed');
    if(!Array.isArray(review.businessAssertions)||!review.businessAssertions.length||review.businessAssertions.some(s=>typeof s!=='string'||!s.trim()))fail('List actual app business UI selectors that both regression scenarios must assert.','REVIEW_REQUIRED');
    if(config.method==='app-defer')after=transformCode({source,target:c.file,kind:'liquid-defer-script',parameters:{tagStart:c.binding.offset},evidence}).after;
    else {
      need('independentExecutionReviewed');
      if(!n)fail('Script parser binding changed.');
      const at=n.node.blockStartPosition.end-1;after=source.slice(0,at)+' async'+source.slice(at);
    }
    evidence.resourceUrl=c.data.resourceUrl;
    evidence.resourceHash=c.data.resourceHash;
  }else if(c.kind==='app-space') {
    need('allStatesReviewed','contentSizeStable','responsiveGeometryReviewed');
    if(!n||!/^[A-Za-z_][\w-]*$/.test(n.id))fail('Space reservation needs a unique safe literal id.');
    if(!Number.isInteger(config.breakpoint)||config.breakpoint<320||config.breakpoint>1600)fail('Provide the existing theme breakpoint.','CONFIG_REQUIRED');
    const targets=profiles.filter(p=>validDomainProfile(p,snapshot)&&p.kind==='runtime-profile'&&normalizeEvidenceUrl(p.config.url)===normalizeEvidenceUrl(c.page))
      .flatMap(p=>(p.domainTargets??[]).filter(t=>t.id===n.id&&t.idCount===1).map(t=>({p,t})));
    const heights={};
    for(const device of ['mobile','desktop']) {
      const found=targets.filter(x=>x.p.config.device===device);if(!found.length)fail('Space reservation needs current mobile and desktop geometry.','EVIDENCE_REQUIRED');
      if(found.some(x=>(x.t.viewport.width<config.breakpoint)!==(device==='mobile')))fail('Captured viewports do not straddle the theme breakpoint.','EVIDENCE_REQUIRED');
      if(found.some(({t})=>t.tag?.toLowerCase()!==n.tag||['inline','none'].includes(t.display)||['fixed','absolute'].includes(t.position)))fail('App container must remain in normal flow at every captured viewport.');
      const values=found.map(x=>x.t.rect.height);if(values.some(v=>!Number.isFinite(v)||v<=0)||Math.max(...values)-Math.min(...values)>1)fail('App content height varies across states; fixed reservation is unsupported.');
      heights[device]=Math.max(...values);
    }
    const css=`<style>\n#${n.id} { min-height: ${heights.desktop}px; }\n@media (max-width: ${config.breakpoint-1}px) { #${n.id} { min-height: ${heights.mobile}px; } }\n</style>\n`;
    after=source.slice(0,n.offset)+css+source.slice(n.offset);
  }else if(c.kind==='liquid-hotspot') {
    need('profileHotspotConfirmed','loopScopeReviewed');
    if(config.method==='liquid-cache-metafield')need('metafieldImmutable');
    after=transformCode({source,target:c.file,kind:config.method,parameters:{assignStart:c.binding.offset},evidence}).after;
  }else fail('Unsupported domain candidate.');
  return createSitePlan({project,recipe:{schemaVersion:1,changes:[{kind:'reviewed-replacement',target:c.file,replacementText:after,
    reason:`${config.method}: ${c.evidence}`,evidence}]},metadata:{domainKind:c.kind,method:config.method,
    verificationRequired:['independent navigation experiment','same content/layout/behavior',...(c.kind==='liquid-hotspot'?['independent deployment-bound Liquid profiles']:[]),...(c.kind==='app-loader'?['script still loads and business behavior assertions']:[])]}});
}
