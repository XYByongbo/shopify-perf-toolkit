import path from 'node:path';
import {readRunEvidence,normalizeEvidenceUrl} from './run-evidence.mjs';
import {checkRunDeployment} from './deployment.mjs';
import {median} from './summary.mjs';
import {reportSetHash} from './performance-gain.mjs';
import {readFcpDiagnostics} from './fcp-diagnostics.mjs';
import {gainGroupForCandidate} from './gain-scope.mjs';

export async function diagnoseFcpGroup(root,group) {
  const samples=[];
  for(const record of group.records) {
    const descriptor=group.attempts?.find(a=>a.report===record.relative)?.diagnostics;
    const diagnosis=await readFcpDiagnostics(root,record,descriptor);
    samples.push({report:record.relative,...diagnosis});
  }
  const signatures=samples.filter(s=>s.status==='replayed').map(s=>[...new Set(
    [...s.optimistic.nodes,...s.pessimistic.nodes].filter(n=>n.type==='network').map(n=>normalizeEvidenceUrl(n.url)))].sort().join('\n'));
  const coupled=samples.filter(s=>s.status==='replayed'&&s.taskPaintCouplings?.length);
  const uncoupled=samples.filter(s=>s.status==='replayed'&&s.taskPaintCouplings?.length===0);
  return {status:samples.length&&samples.every(s=>s.status==='replayed')?'replayed':'incomplete',samples,
    distinctNetworkGraphs:new Set(signatures).size,
    finding:new Set(signatures).size>1&&coupled.length&&uncoupled.length?'task-coalescing-sensitive-fcp-model'
      :new Set(signatures).size>1?'fcp-network-dependencies-vary-between-samples':'no-network-graph-variation-established',
    acceptanceEffect:'none; retain original rejection and thresholds'};
}

export function fcpRecoveryDecision(diagnostics) {
  const sides=[diagnostics?.before,diagnostics?.after];
  const complete=sides.every(s=>s?.status==='replayed');
  const shared=complete&&sides.every(s=>s.finding==='task-coalescing-sensitive-fcp-model');
  return {cause:shared?'shared-task-coalescing-sensitivity':complete?'inspect-changed-fcp-dependencies':'missing-original-navigation-artifacts',
    attribution:shared?'Both original and candidate change FCP dependency graphs across samples; do not attribute the entire FCP delta to the patch.'
      :complete?'Read the CPU tasks and network dependencies before assigning a code cause.':'The old LHR alone cannot establish the exact task graph.',
    patchDisposition:'retain-original-rejection',allowUnchangedRetry:false,overrideScoreGate:false};
}

/** Supplementary diagnosis only: observed timings never override the simulated score gates. */
export function summarizeCost(records) {
  const stat=read=>{
    const values=records.map(({report})=>read(report));
    return values.length&&values.every(Number.isFinite)?{samples:values,median:median(values),range:Math.max(...values)-Math.min(...values)}:null;
  };
  const network=report=>report.audits['network-requests']?.details?.items;
  return {
    fcp:stat(r=>r.audits['first-contentful-paint']?.numericValue),
    observedFcp:stat(r=>r.audits.metrics?.details?.items?.[0]?.observedFirstContentfulPaint),
    transferBytes:stat(r=>r.audits['total-byte-weight']?.numericValue),
    documentBytes:stat(r=>{const rows=network(r)?.filter(x=>x.resourceType==='Document');return rows?.length?rows.reduce((n,r)=>n+r.resourceSize,0):undefined;}),
    scriptRequests:stat(r=>network(r)?.filter(x=>x.resourceType==='Script').length),
  };
}
export async function readExperimentCost(attempt,candidate) {
  const expected=attempt?.verification?.gain?.evidence;
  if((!attempt?.experiment&&!attempt?.formalEvidence)||!expected)return {status:'unavailable'};
  try{
    const [before,after]=await Promise.all(['before','after'].map(side=>readRunEvidence(attempt.formalEvidence?.[side]??path.join(attempt.experiment,side),{allowExploration:true})));
    const left=checkRunDeployment(before),right=checkRunDeployment(after);
    if(before.manifestHash!==expected.beforeManifestHash||after.manifestHash!==expected.afterManifestHash
      ||reportSetHash(before)!==expected.beforeReportsHash||reportSetHash(after)!==expected.afterReportsHash
      ||left.status!=='verified'||right.status!=='verified'||left.sourceHash!==attempt.baselineHash||right.sourceHash!==attempt.sourceHash)
      throw new Error('Experiment raw report hashes, manifest or source identity are missing or differ from recorded verification.');
    const group=e=>e.groups.find(g=>g.device===candidate.device&&normalizeEvidenceUrl(g.url)===normalizeEvidenceUrl(candidate.page));
    const a=group(before),b=group(after);if(!a||!b)throw new Error('Wrong page/device in failed experiment.');
    const base=summarizeCost(a.records),changed=summarizeCost(b.records);
    const gainGroup=gainGroupForCandidate(attempt.verification.gain.groups,candidate,a);
    if(!gainGroup)throw new Error('Missing or ambiguous page/device gain group for this candidate.');
    const regression=gainGroup.metrics?.fcp?.regressed;
    const disagreement=regression===true&&base.observedFcp&&changed.observedFcp&&changed.observedFcp.median<=base.observedFcp.median;
    const fcpDiagnostics=disagreement?{before:await diagnoseFcpGroup(before.root,a),after:await diagnoseFcpGroup(after.root,b)}:null;
    return {status:'verified',before:base,after:changed,
      finding:disagreement?'simulated-fcp-regression-not-reproduced-in-observed-fcp':'compare-payload-request-and-paint-costs',
      next:disagreement?'inspect-saved-trace-and-simulation-critical-path; keep-regression-rejected; do-not-resample-for-a-pass':null,
      ...(fcpDiagnostics?{fcpDiagnostics,fcpDecision:fcpRecoveryDecision(fcpDiagnostics)}:{}),
      ...(candidate.kind==='stylesheet'&&!gainGroup.improved?{mechanismDecision:{
        cause:'no-independent-navigation-gain-established',
        attribution:'Repeated links and initial style work justified a candidate; independent navigation samples did not establish useful savings. Link count is not a gain metric.',
        next:'Exclude stylesheet-once for this causal context and select a different measured navigation bottleneck. If slow clicks are reported, capture a single declared interaction with EventTiming and style trace as a separate explicit goal.',
        allowUnchangedRetry:false,overrideScoreGate:false,
      }}:{}),
      limitations:['Observed FCP is collected without the simulated throttling model; it cannot replace the original acceptance metric.', 'Request counts and bytes identify added cost, not causal savings.'],
      evidence:{beforeManifestHash:before.manifestHash,afterManifestHash:after.manifestHash}};
  }catch(error){return {status:'unavailable',reason:error.message};}
}
