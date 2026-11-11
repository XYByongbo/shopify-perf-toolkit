import {rankCandidates} from './candidate-priority.mjs';
import {normalizeEvidenceUrl} from './run-evidence.mjs';
import { diagnoseBottlenecks,liquidCandidateEvidence,replayLiquidSource } from './bottlenecks.mjs';
import { auditStylesheets } from './stylesheet-audit.mjs';
import { attributeApps } from './app-attribution.mjs';
import { normalizeFieldData, matchingFieldSegments } from './field-data.mjs';
import { digest, goalContract } from './evidence-contract.mjs';
import { auditPerformance } from './performance-audit.mjs';
import { indexThemeSources,createSourceIndexSession } from './source-attribution.mjs';
import { officialOptions } from './official-methods.mjs';
import { domainCandidates } from './domain-candidates.mjs';
import {buildThemeWorkflow} from './theme-workflow.mjs';
import {recoveryContext} from './recovery-context.mjs';

export function layoutSummary(profile) {
  const shifts=(profile.afterActions?.shifts??profile.initial?.shifts??[]).filter(e=>!e.hadRecentInput&&Number.isFinite(e.startTime)&&e.startTime>=0&&Number.isFinite(e.value)&&e.value>=0).sort((a,b)=>a.startTime-b.startTime);
  let start=0,last=0,total=0,max=0;
  for(const e of shifts){if(!total||e.startTime-last>=1000||e.startTime-start>=5000){start=e.startTime;total=0;}total+=e.value;last=e.startTime;max=Math.max(max,total);}
  return {observedSessionMax:max,shifts,scope:'finite-lab-window-not-field-CLS',sourceAssociation:'requires-rendered-element-to-source-review'};
}

export function interactionSummary(profile) {
  const events=profile.afterActions?.interactions??[];
  const byId=new Map();
  for(const e of events){
    if(!e.interactionId||!Number.isFinite(e.duration)||e.duration<0)continue;
    const event={...e,presentation:Number.isFinite(e.inputDelay)&&Number.isFinite(e.processing)?Math.max(0,e.duration-e.inputDelay-e.processing):null};
    const old=byId.get(e.interactionId);if(!old||old.duration<e.duration)byId.set(e.interactionId,event);
  }
  return [...byId.values()].map(e=>({...e,dominantPhase:[['input',e.inputDelay],['processing',e.processing],['presentation',e.presentation]].filter(([,n])=>Number.isFinite(n)).sort((a,b)=>b[1]-a[1])[0]?.[0]??'unknown'}));
}

export async function diagnoseUnified({project,profiles=[],run,liquidProfile,limit=3,field=null,owners=[],goal,checks=null,ownership=[],performanceBaseline=null}={}) {
  if(!Number.isSafeInteger(limit)||limit<1||limit>20)throw new Error('Candidate limit must be 1..20.');
  const target=goalContract(goal);
  field=field?normalizeFieldData(field,{...field.policy,now:Date.now()}):null;
  const segmentsFor=(url,device)=>matchingFieldSegments(field,url,device,{target:target.kind==='interaction'?target.target:null});
  const sourceSession=createSourceIndexSession();
  const base=await diagnoseBottlenecks({project,profiles,run,liquidProfile,limit:20,sourceSession});
  // Rank the complete eligible pool, not the old cost-only top 20.
  const unique = new Map();
  for (const row of base.observations.filter(o=>o.eligible)) {
    if (!unique.has(row.candidateId) || unique.get(row.candidateId).costMs < row.costMs) unique.set(row.candidateId,row);
  }
  base.candidates=[...unique.values()];
  const index=await indexThemeSources(project,{session:sourceSession});
  if(index.snapshot.hash!==base.sourceHash)throw new Error('Source drift during domain diagnosis.');
  base.candidates.push(...domainCandidates({files:index.files,snapshot:index.snapshot,profiles,liquidProfile,owners,goal:target}));
  const stylesheets=await auditStylesheets({project,index});
  const performance=await auditPerformance({project,profiles,checks,ownership,baseline:performanceBaseline,sourceIndex:index});
  if(performance.sourceHash!==base.sourceHash)throw new Error('Source drift during performance rule audit.');
  if(stylesheets.sourceHash!==base.sourceHash)throw new Error('Source drift between diagnosis stages.');
  const apps=attributeApps({profiles,owners});
  const currentFiles=new Map(base.graph.files.map(f=>[f.file,f.sourceHash]));
  const phases=[];
  for(const [profileIndex,p] of profiles.entries()){
    const valid=p.kind==='runtime-profile'&&p.status==='complete'&&p.sourceStable&&p.snapshot?.hash===base.sourceHash;
    if(!valid)continue;
    const n=p.initial?.navigation,lcp=p.initial?.lcp?.startTime;
    const gaps={server:Number.isFinite(n?.responseStart)?n.responseStart:null,
      initialRender:Number.isFinite(p.initial?.fcp)&&Number.isFinite(n?.responseStart)?Math.max(0,p.initial.fcp-n.responseStart):null,
      lcpAfterFcp:Number.isFinite(lcp)&&Number.isFinite(p.initial?.fcp)?Math.max(0,lcp-p.initial.fcp):null};
    const interactions=interactionSummary(p),segments=segmentsFor(p.config.url,p.config.device),layout=layoutSummary(p);
    phases.push({profileIndex,url:p.config.url,device:p.config.device,state:p.config.state,gaps,documentCompletionMs:n?.responseEnd??null,lcp:p.lcp??null,interactions,layout,fieldSegments:segments,
      suspect:target.metric==='cls'&&layout.observedSessionMax>0.1?'layout':Object.entries(gaps).filter(([,v])=>Number.isFinite(v)).sort((a,b)=>b[1]-a[1])[0]?.[0]??'unknown',
      basis:'Screening phases, not causal savings. Streamed document duration includes transfer and server work; confirm in trace/Liquid profile.'});
    if(target.kind==='interaction'&&(p.afterActions?.interactions??[]).some(e=>e.target===target.target&&e.name===target.event))for(const row of p.interactionCpu??[]){
      if(!Number.isFinite(row.selfMs)||row.selfMs<50||!['verified-bytes','verified-ast'].includes(row.source?.status)||currentFiles.get(row.source.file)!==row.source.sourceHash)continue;
      const liquidAssetEvidence=liquidCandidateEvidence(p,row.source,index.files);
      if(row.source.scriptKind==='liquid-asset'&&!replayLiquidSource({file:row.source.file,source:row.source,liquidAssetEvidence},index.snapshot))continue;
      base.candidates.push({kind:'interaction-cpu',liquidAssetEvidence,metric:'interaction',target:target.target,event:target.event,candidateId:digest([base.sourceHash,'interaction',row.source.file,row.source.line,row.source.column,normalizeEvidenceUrl(p.config.url),p.config.device,p.config.state,target.target,target.event]).slice(0,24),
        source:row.source,file:row.source.file,line:row.source.line,page:p.config.url,device:p.config.device,state:p.config.state,costMs:row.selfMs,eligible:true,association:row.source.status,
        controllability:'theme-code',evidence:'Source-bound sampled self CPU during the declared interaction state; not event-handler causal proof.',action:'Inspect this interaction-window CPU frame with the event trace; sampled CPU alone does not establish event-handler causality.'});
    }
  }
  const seen=new Set();
  const candidates=rankCandidates(base.candidates.map(c=>{
    // A measured render blocker supports a paint hypothesis. Bind its identity
    // to the requested paint metric so the experiment can actually test it.
    if (target.kind==='loading' && ['fcp','speedIndex'].includes(target.metric) && c.kind==='render-resource') {
      c={...c,metric:target.metric,candidateId:digest([c.candidateId,target.metric]).slice(0,24),
        evidence:c.evidence+' The declared paint metric must improve in the independent experiment; request duration is not predicted savings.'};
    }
    const metric=c.metric==='interaction'?'inp':c.metric;
    const segments=segmentsFor(c.page,c.device),usable=segments.filter(g=>g.assessment.thresholdEligible&&Number.isFinite(g.metrics[metric]));
    const relevant=usable.flatMap(g=>g.breaches.filter(b=>b.metric===metric));
    const goalMatch=target.kind==='score'?1:target.kind==='interaction'?Number(c.metric==='interaction'):Number(c.metric===target.metric);
    const strategy=c.methods?.length?'plan-domain':c.kind==='render-resource'&&/\.css$/.test(c.file)?stylesheets.strategy:c.kind==='interaction-cpu'?'review-interaction-handler':'review-component-scoping';
    return {...c,structureContext:performance.intelligence.structure.find(s=>s.file===c.file)??null,ownership:performance.intelligence.ownership.find(o=>o.file===c.file)??null,recoveryContext:recoveryContext(c,index.files),officialMethods:officialOptions(c),priority:{goalMatch,fieldBreach:relevant.length>0,affectedSamples:usable.length===1?usable[0].samples:null,
      sourceConfidence:c.association,criticalPath:'requires-trace-review',changeCost:'requires-plan-review'},recommendedStrategy:strategy};
  }).filter(c=>target.kind==='score'||c.metric===target.metric)
)
    .filter(c=>{if(seen.has(c.candidateId))return false;seen.add(c.candidateId);return true;}).slice(0,limit);
  for(const row of performance.intelligence.structure)row.runtimeImpact={scope:'file-cost-not-setting-causality',candidateIds:candidates.filter(c=>c.file===row.file).map(c=>c.candidateId)};
  for(const task of performance.intelligence.fonts.reviewTasks)task.relatedCostCandidates=candidates.filter(c=>c.file===task.file).map(c=>c.candidateId);
  return {...base,candidates,status:base.issues.length?'review-required':candidates.length?'candidates-ready':'no-supported-candidate',decisionVersion:1,goal:target,
    phases,stylesheets,apps,performance,intelligence:performance.intelligence,workflow:buildThemeWorkflow({snapshot:index.snapshot,profiles,candidates,files:index.files,intelligence:performance.intelligence}),fieldStatus:field?.status??'unavailable',reviewRequired:base.issues.length>0||stylesheets.status!=='compatible-static-patterns'||performance.reviewRequired,
    verificationRequired:target.kind==='interaction'?['independent-interaction-runs','original-navigation-score-gates','source-identity','content-and-behavior']:['independent-navigation-runs','source-identity','content-and-behavior'],
    limitations:[...base.limitations,'Unlike independent populations are not pooled; sample counts and phase costs are not additive.', 'Interaction CPU covers a state window; exact handler and layout causality needs trace review.']};
}
