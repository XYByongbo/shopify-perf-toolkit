import {readFile} from 'node:fs/promises';
import {codeStrategies} from './code-strategy-catalog.mjs';
import {performanceRoot,readShopifySources} from './shopify-docs.mjs';
import {extendedContracts} from './extended-methods.mjs';

const cards=JSON.parse(await readFile(new URL('../assets/shopify-performance/methods.json',import.meta.url),'utf8'));
const bundled=await readShopifySources();
const domain={
  'image-eager':['sharedInstancesReviewed'],'image-priority':['sharedInstancesReviewed'],
  'image-dimensions':['sharedInstancesReviewed','responsiveRatioReviewed'],'image-aspect-ratio':['sharedInstancesReviewed','responsiveRatioReviewed'],
  'app-defer':['dependenciesReviewed','nonCritical','documentWriteAbsent','businessEventsReviewed','businessAssertions'],
  'app-async':['dependenciesReviewed','nonCritical','documentWriteAbsent','businessEventsReviewed','businessAssertions','independentExecutionReviewed'],
  'app-reserve-space':['allStatesReviewed','contentSizeStable','responsiveGeometryReviewed'],
  'liquid-cache-loop-filter':['profileHotspotConfirmed','loopScopeReviewed'],'liquid-cache-metafield':['profileHotspotConfirmed','loopScopeReviewed','metafieldImmutable'],
};
export function executorContract(id) {
  const [generator,method]=id.split(':');
  if(generator==='domain'&&extendedContracts[method])return {id,generator,method,recovery:extendedContracts[method].recovery??'candidate',parameters:extendedContracts[method].parameters,evidenceRequired:['sourceHash','summary',...extendedContracts[method].review],boundary:'Current deployment-bound query, hidden native disclosure, or exact native fetch call; generate only the parser-supported pattern and verify independent real gain.'};
  if(generator==='site') {
    const strategy=codeStrategies.find(s=>s.kind===method);
    if(strategy)return {id,generator,method,...strategy};
    if(method==='image-responsive')return {id,generator,method,parameters:['sourceIndex','sizes','widths'],evidenceRequired:['sourceHash','summary','responsiveSizesReviewed'],boundary:'Only existing supported Shopify image pipeline; select a source image index, never a DOM index.'};
  }
  if(generator==='domain'&&domain[method])return {id,generator,method,parameters:method==='app-reserve-space'?['breakpoint']:[],evidenceRequired:['sourceHash','summary',...domain[method]],boundary:'Current deployment-bracketed runtime/Liquid evidence must reconstruct this exact domain candidate.'};
  if(generator==='demand'&&['component','critical-css'].includes(method))return {id,generator,method,parameters:['source','newAsset',...(method==='component'?['component']:['loaderTarget','tagStart','inlineLoadHandlerAllowed'])],evidenceRequired:['sourceHash','summary'],boundary:method==='component'?'Measured function must belong to the private component dependency closure.':'Current mobile, desktop and interaction coverage; retain complete CSS fallback.'};
  if(generator==='split'&&['css','interaction'].includes(method))return {id,generator,method,parameters:['source','newAsset','loaderTarget','tagStart',...(method==='css'?['criticalRuleStarts']:['rootSelector','triggerSelector'])],evidenceRequired:['sourceHash','loaderHash','summary','dependencyReview','allStatesCovered','cascadeAndOrderReviewed',...(method==='interaction'?['activationContractReviewed']:['inlineLoadHandlerAllowed'])],boundary:'Explicit reviewed dependency/lifecycle or cascade contract; no arbitrary automatic module conversion.'};
  throw new Error(`Unknown official-method executor: ${id}`);
}
export function officialMethodCatalog({sources=bundled}={}) {
  if(sources?.kind!=='shopify-docs-index'||!Array.isArray(sources.documents))throw new Error('Invalid official sources index.');
  const documents=new Map(sources.documents.map(d=>[d.url,d]));
  const methods=cards.map(card=>{
    const url=performanceRoot+'/'+card.id,source=documents.get(url),matches=source?.contentHash===card.reviewedSourceHash;
    const route=card.executors.length?'generator-available':['measurement','platform','external'].includes(card.topic)?`${card.topic}-workflow`:'reviewed-replacement-required';
    return {...card,title:source?.title??card.id,source:{url,checkedAt:source?.checkedAt??null,contentHash:source?.contentHash??null,status:!source?'missing':matches?'reviewed':'changed-needs-review'},
      status:matches?route:'source-review-required',executors:card.executors.map(executorContract),
      requiredEvidence:['current-source-hash','source-bound-measured-hypothesis','affected-page-device-scope'],
      workflow:{prepare:'plan-official or improve prepare official',apply:'apply with reviewed plan hash',experiment:'prepared previews, alternating independent samples, same content and behavior',verify:'formal full matrix and original thresholds',noGain:'rollback; record fingerprint and failed mechanism; select another supported method or recapture evidence within the original budget'},
      noGainAlternatives:cards.filter(x=>x.id!==card.id&&x.topic===card.topic&&x.executors.length).map(x=>x.id)};
  });
  const performanceDocuments=sources.documents.filter(d=>d.url.startsWith(performanceRoot+'/'));
  const uncovered=performanceDocuments.filter(d=>!cards.some(c=>performanceRoot+'/'+c.id===d.url)).map(d=>d.url);
  return {schemaVersion:1,kind:'official-method-catalog',status:sources.status==='complete'&&!uncovered.length&&methods.every(m=>m.source.status==='reviewed')?'current':'review-required',
    scope:sources.scope,checkedAt:sources.finishedAt,coverage:{...sources.coverage,performanceArticles:performanceDocuments.length,methodCards:methods.length,
      generatorBackedArticles:methods.filter(m=>m.executors.length).length,uniqueExecutors:new Set(cards.flatMap(c=>c.executors)).size,sourceReviewRequired:methods.filter(m=>m.source.status!=='reviewed').length,uncovered},methods,
    projectPolicy:{navigationExplorationSamples:3,navigationFormalSamples:5,liquidFormalSamples:5,approval:'explicit source/behavior review; never fill review booleans automatically',acceptance:'existing independent gain, no-regression, deployment and behavior gates; no universal score guarantee'},
    limitations:['Official coverage and transformation coverage are separate. Generator availability still depends on parser structure, source attribution and review.', 'Headless, checkout, DNS and platform-owned behavior require their own projects/owners.', 'Bundled source hashes are a dated offline snapshot; sync-shopify-docs detects new or changed guidance without auto-authorizing code.']};
}
export function officialOptions(candidate) {
  const ext=candidate.file?.split('.').at(-1);
  const accepts=id=>{
    const e=executorContract(id);
    if(e.generator==='domain')return candidate.methods?.includes(e.method);
    if(candidate.source?.status==='verified-domain-source') {
      if(candidate.kind==='liquid-hotspot')return e.generator==='site'&&candidate.methods?.includes(e.method);
      return candidate.kind==='image-lcp'&&e.generator==='site'&&['image-responsive','liquid-picture-pair','liquid-image-tag-loading'].includes(e.method);
    }
    if(['image-responsive','liquid-picture-pair','liquid-image-tag-loading'].includes(e.method))return false;
    if(e.generator==='demand')return e.method==='component'?candidate.kind==='cpu'&&ext==='js':candidate.kind==='render-resource'&&ext==='css';
    if(e.generator==='split')return e.method==='css'?ext==='css':['js','mjs'].includes(ext);
    if(e.method.startsWith('liquid-cache-')||e.method==='liquid-limit-guarded-loop')return candidate.kind==='liquid-hotspot';
    return e.method.startsWith('css-')?ext==='css':e.method.startsWith('js-')?['js','mjs'].includes(ext):ext==='liquid';
  };
  return cards.flatMap(c=>c.executors.filter(accepts).map(executor=>({methodId:c.id,executor,source:performanceRoot+'/'+c.id,status:'requires-pattern-and-behavior-review'})));
}

export function officialMethodsForExecutor(executor){return cards.filter(c=>c.executors.includes(executor)).map(c=>({methodId:c.id,executor,source:performanceRoot+'/'+c.id}));}
