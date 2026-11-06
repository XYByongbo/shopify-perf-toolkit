import {parseCustomSource} from './custom-plan-contract.mjs';
import {readImprovementSession} from './improvement-state.mjs';
import {sourceSnapshot} from './theme-source.mjs';
import {readThemeSource} from './core/source-reader.mjs';
import {digest,fields,readEvidenceJSON} from './evidence-contract.mjs';
import {requireHypothesis} from './bottlenecks.mjs';
import {createSitePlan,validateSitePlan} from './site-changes.mjs';
import {checkExtendedPlan,checkAppPlan} from './optimization-regression.mjs';

const read=async value=>typeof value==='string'?readEvidenceJSON(value):structuredClone(value);
const hash=request=>{const {requestHash,...body}=request;return digest(body);};

/** A source-bound handoff to Codex; this never invents an implementation or a score. */
export async function requestImplementation({previous,candidateId,files=[]}) {
  const state=await readImprovementSession(previous);
  if(state.active||!['ready-for-plan','investigation-required','rolled-back'].includes(state.status))throw new Error('Request needs an idle, diagnosed session.');
  const snapshot=await sourceSnapshot(state.project),recovery=await read(state.recovery);
  if(!snapshot.complete||snapshot.hash!==state.baselineHash||digest(recovery)!==state.recoveryHash)throw new Error('Source or diagnosis drift.');
  const hypothesis=requireHypothesis(recovery.diagnosis,candidateId,snapshot);
  if(recovery.candidates.find(c=>c.candidateId===candidateId)?.gainCeiling?.blocked)throw new Error('No measurable gain headroom for this candidate.');
  if(!Array.isArray(files)||files.length>20||files.some(f=>typeof f!=='string'))throw new Error('files must list at most 20 related existing source paths.');
  const sources=[];
  for(const file of new Set([hypothesis.file,...files])) {
    const entry=snapshot.files.find(f=>f.file===file);
    if(!entry)throw new Error('Requested source is not in the measured manifest.');
    const {source}=await readThemeSource(state.project,file,entry.sourceHash);
    if(Buffer.byteLength(source)>2*1024*1024)throw new Error('Requested source exceeds 2 MiB.');
    sources.push({...entry,source});
  }
  if((await sourceSnapshot(state.project)).hash!==snapshot.hash)throw new Error('Source drift during request.');
  const request={schemaVersion:1,kind:'performance-implementation-request',previous,sessionHash:state.sessionHash,
    project:state.project,sourceHash:snapshot.hash,candidateId,hypothesis,sources,goal:state.goal,
    priorAttempts:state.history.map(({method,outcome,candidateId})=>({method,outcome,candidateId})),
    requirements:['Change the measured bottleneck; preserve content, behavior, schema and App ownership.',
      'Return full replacementText for selected files; explain the changed mechanism and regression checks.',
      'Review the generated diff, then use improve prepare/apply/sync/experiment/collect/verify; no gain means rollback.'],
    acceptance:'not-evaluated'};
  request.requestHash=hash(request);
  if(Buffer.byteLength(JSON.stringify(request))>32*1024*1024)throw new Error('Implementation request exceeds the 32 MiB saved-evidence limit; narrow related files.');
  return request;
}

export async function createCustomPlan({request,candidate}) {
  request=await read(request);candidate=await read(candidate);
  if(request?.kind!=='performance-implementation-request'||request.requestHash!==hash(request))throw new Error('Invalid implementation request.');
  const replay=await requestImplementation({previous:request.previous,candidateId:request.candidateId,files:request.sources.map(s=>s.file).filter(f=>f!==request.hypothesis.file)});
  if(replay.requestHash!==request.requestHash)throw new Error('Implementation request is stale or changed.');
  fields(candidate,['schemaVersion','requestHash','method','rationale','checks','changes'],'custom implementation');
  if(candidate.schemaVersion!==1||candidate.requestHash!==request.requestHash||!/^custom\/[a-z0-9][a-z0-9-]{2,80}$/.test(candidate.method??'')
    ||typeof candidate.rationale!=='string'||!candidate.rationale.trim()||!Array.isArray(candidate.checks)||!candidate.checks.length
    ||candidate.checks.some(c=>typeof c!=='string'||!c.trim())||!Array.isArray(candidate.changes)||!candidate.changes.length||candidate.changes.length>20)throw new Error('Candidate needs matching requestHash, custom/mechanism, rationale, checks and 1..20 changes.');
  const changes=candidate.changes.map(c=>{
    fields(c,['target','replacementText','kind','evidence'],'custom change');
    const kind=c.kind??'reviewed-replacement';
    if(!['reviewed-replacement','create-asset'].includes(kind)||kind==='reviewed-replacement'&&!request.sources.some(s=>s.file===c.target))throw new Error('Replacement must belong to the requested source scope.');
    if(typeof c.replacementText!=='string'||Buffer.byteLength(c.replacementText)>2*1024*1024)throw new Error('Invalid replacement source.');
    if(typeof c.target!=='string')throw new Error('Invalid replacement target.');
    parseCustomSource(c.target,c.replacementText);
    if(c.evidence!==undefined&&(!c.evidence||typeof c.evidence!=='object'||Array.isArray(c.evidence)))throw new Error('Invalid custom domain evidence.');
    if(c.evidence?.domainMethod&&!request.hypothesis.methods?.includes(c.evidence.domainMethod))throw new Error('Custom domainMethod is not supported by this measured hypothesis.');
    return {...c,kind,reason:candidate.rationale,evidence:{...c.evidence,
      ...(request.hypothesis.kind?{domainKind:request.hypothesis.kind}:{}),...(request.hypothesis.page?{domainPage:request.hypothesis.page}:{}),summary:candidate.rationale,candidateId:request.candidateId,
      diagnosisSourceHash:request.sourceHash,implementationRequestHash:request.requestHash,method:candidate.method,requestedChecks:candidate.checks}};
  });
  const plan=await createSitePlan({project:request.project,recipe:{schemaVersion:1,changes},metadata:{readOnlyDependencies:(request.hypothesis.domainEvidence?.dependencyFiles??[]).map(({file,sourceHash})=>({file,sourceHash}))}});
  if(!checkExtendedPlan(plan,request.hypothesis)||request.hypothesis.kind==='app-loader'&&!checkAppPlan(plan,request.hypothesis))throw new Error('Custom domain implementation needs the original method/behavior contract; use plan-domain or supply its verified evidence.');
  if((await sourceSnapshot(request.project)).hash!==request.sourceHash)throw new Error('Source drift during custom planning.');
  await validateSitePlan(plan);
  return plan;
}
