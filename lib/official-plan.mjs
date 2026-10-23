import {officialMethodCatalog,officialOptions} from './official-methods.mjs';
import {sourceSnapshot} from './runtime-profile.mjs';
import {requireHypothesis} from './bottlenecks.mjs';
import {fields} from './evidence-contract.mjs';
import {createSitePlan,validateSitePlan} from './site-changes.mjs';
import {createDomainPlan} from './domain-plan.mjs';
import {createDemandPlan} from './demand-plan.mjs';
import {createSplitPlan} from './split-plan.mjs';
import {inspectImages} from './inspect.mjs';
import {readTarget} from './changes.mjs';
import {liquidAST,visitAST} from './advanced-strategies.mjs';
import {literalAttribute} from './performance-rules.mjs';

const fail=(message,code='OFFICIAL_METHOD_UNSUPPORTED')=>{throw Object.assign(new Error(message),{code});};
/** Docs choose a local generator; they never supply executable code or review approvals. */
export async function createOfficialPlan({project,diagnosis,config,profiles=[],sources}={}) {
  fields(config,['schemaVersion','candidateId','methodId','executor','parameters','review','replacementText'],'official plan');
  if(config.schemaVersion!==1)fail('Unsupported official plan schema.');
  const catalog=officialMethodCatalog({sources}),method=catalog.methods.find(m=>m.id===config.methodId);
  if(!method)fail('Unknown official method.');
  if(method.source.status!=='reviewed')fail('Official source changed or is missing; review the method card before generating code.','OFFICIAL_SOURCE_REVIEW_REQUIRED');
  if(['measurement','platform','external'].includes(method.topic))fail('This method belongs to measurement, platform or another project; no theme patch executor is available.');
  const snapshot=await sourceSnapshot(project),candidate=requireHypothesis(diagnosis,config.candidateId,snapshot);
  const review=config.review;
  if(!review||typeof review.summary!=='string'||!review.summary.trim()||review.sourceHash!==candidate.source.sourceHash)fail('Supply a concrete review summary and the exact current target sourceHash.','MISSING_CODE_EVIDENCE');
  const custom=config.executor==='reviewed-replacement';
  const executor=method.executors.find(e=>e.id===config.executor);
  if(!custom&&(!executor||!officialOptions(candidate).some(o=>o.methodId===method.id&&o.executor===executor.id)))fail('Executor does not match this official method and measured source candidate.');
  if(custom&&(method.executors.length||['app-loader','app-space'].includes(candidate.kind)))fail('Use the supported executor and its mandatory evidence gates; custom replacement is not an escape route.');
  if(custom&&(review.allStatesReviewed!==true||typeof config.replacementText!=='string'))fail('Custom method requires the complete replacement source and actual allStatesReviewed evidence.','MISSING_CODE_EVIDENCE');
  if(method.evidenceDomain==='liquid-server'&&!['liquid-hotspot','liquid-query'].includes(candidate.kind))fail('Server execution methods require a deployment-bound Liquid hotspot; browser CPU/TTFB does not establish server cost.');
  const parameters=config.parameters??{};fields(parameters,custom?[]:executor.parameters,'official executor parameters');
  if(!custom&&config.replacementText!==undefined)fail('Generated methods do not accept replacementText.');
  if(executor?.method==='liquid-dedupe-resource-hint') {
    const {source}=await readTarget(project,candidate.file);let rel;
    visitAST(liquidAST(source),n=>{if(n.position?.start===parameters.firstStart)rel=literalAttribute(n,'rel');});
    const expected=method.id==='use-preconnect'?'preconnect':'preload';
    if(rel!==expected)fail(`This method only handles ${expected} hints.`,'OFFICIAL_TARGET_MISMATCH');
  }
  const domain=candidate.source.status==='verified-domain-source'?{domainKind:candidate.kind,domainPage:candidate.page,domainTarget:candidate.data.target?.id??null}:{};
  if(executor?.generator==='site'&&candidate.binding) {
    const offset=candidate.binding.offset;
    const bound=executor.method.startsWith('liquid-cache-')?parameters.assignStart===offset
      :executor.method==='liquid-image-tag-loading'?parameters.outputStart===offset&&parameters.loading==='eager'
      :executor.method==='liquid-picture-pair'?[parameters.desktopStart,parameters.mobileStart].includes(offset)
      :executor.method==='image-responsive'?inspectImages(candidate.binding.text)[parameters.sourceIndex]?.start===offset:false;
    if(!bound)fail('Official parameters do not target the measured parser node.','OFFICIAL_TARGET_MISMATCH');
  }
  const officialMethod={id:method.id,executor:config.executor,url:method.source.url,contentHash:method.source.contentHash,checkedAt:method.source.checkedAt};
  const evidence={...review,...domain,sourceHash:candidate.source.sourceHash,candidateId:candidate.candidateId,diagnosisSourceHash:snapshot.hash,officialMethod};
  const metadata={officialMethod,verificationRequired:[method.validate,'Independent performance gain and preservation; rollback and choose another mechanism after no gain.']};
  let plan;
  if(custom||executor.generator==='site') {
    if(executor?.method==='image-responsive'&&review.responsiveSizesReviewed!==true)fail('Responsive sizes require explicit cross-layout review.','MISSING_CODE_EVIDENCE');
    const change={target:candidate.file,kind:custom?'reviewed-replacement':executor.method,reason:method.action,evidence,
      ...(custom?{replacementText:config.replacementText}:executor.method==='image-responsive'?parameters:{parameters})};
    plan=await createSitePlan({project,recipe:{schemaVersion:1,changes:[change]},metadata});
  }else{
    let generated;
    if(executor.generator==='domain')generated=await createDomainPlan({project,diagnosis,profiles,config:{schemaVersion:1,candidateId:candidate.candidateId,method:executor.method,...parameters,review}});
    if(executor.generator==='demand')generated=await createDemandPlan({project,diagnosis,profiles,config:{schemaVersion:1,mode:executor.method,candidateId:candidate.candidateId,...parameters}});
    if(executor.generator==='split'){
      if(parameters.source!==candidate.file)fail('Split source differs from the measured file.');
      generated=await createSplitPlan({project,config:{schemaVersion:1,mode:executor.method,...parameters,reason:method.action,evidence}});
    }
    // These generators already emit complete reviewed replacements/new assets.
    // Rebuild through the same validator so provenance participates in the plan hash.
    plan=await createSitePlan({project,recipe:{schemaVersion:1,changes:generated.changes.map(c=>({target:c.target,kind:c.recipeKind==='create-asset'?'create-asset':'reviewed-replacement',replacementText:c.after,
      reason:c.reason,evidence:{...c.evidence,...domain,officialMethod,candidateId:candidate.candidateId,diagnosisSourceHash:snapshot.hash}}))},metadata:{...generated.metadata,...metadata,generatorPlanHash:generated.planHash}});
  }
  await validateSitePlan(plan);
  const current=await sourceSnapshot(project);
  if(current.hash!==snapshot.hash)fail('Theme changed during official plan preparation.','SOURCE_DRIFT');
  if(plan.changes.some(c=>c.evidence.candidateId!==candidate.candidateId||c.evidence.diagnosisSourceHash!==snapshot.hash))fail('Generated plan lost its measured hypothesis.');
  return plan;
}
