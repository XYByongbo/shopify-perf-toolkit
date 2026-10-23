import { readRunEvidence, normalizeEvidenceUrl } from './run-evidence.mjs';
import { checkRunDeployment } from './deployment.mjs';
import { officialMethodCatalog } from './official-methods.mjs';
import { sourceSnapshot } from './runtime-profile.mjs';
import { diagnoseUnified } from './decision-engine.mjs';
import { scoreLosses } from './score-impact.mjs';
import { median } from './summary.mjs';
import { digest, goalContract,readEvidenceJSON } from './evidence-contract.mjs';
import { recoveryMethods, recoveryReferences } from './recovery-catalog.mjs';
import { gainFloors } from './performance-gain.mjs';
import { readExperimentCost } from './recovery-cost.mjs';
import {permitsBareInline} from './section-csp.mjs';

const metricNames = { LCP: 'lcp', FCP: 'fcp', TBT: 'tbt', CLS: 'cls', SI: 'speedIndex' };
export const hypothesisKey = c => digest([c.file, c.line, c.kind, c.metric, c.page ? normalizeEvidenceUrl(c.page) : null, c.device]);
export const methodMechanism = method => ({
  'hidden-template':'inert-duplicate-html-external-runtime',
  'hidden-template-chunked':'inert-duplicate-html-external-runtime',
  'hidden-detach':'single-copy-inline-dom-parking',
  'section-fetch-single':'scoped-section-request',
  'section-fetch-json':'scoped-section-request',
  'section-liquid-initial':'liquid-first-render-with-dynamic-section-updates',
  'section-liquid-inline':'liquid-first-render-without-external-controller-request',
}[method]??method);
export function remainingDomainMethods(candidate,baselineHash,history=[],failures=[]) {
  if(candidate.gainCeiling?.blocked)return [];
  const tried=history.filter(h=>h.baselineHash===baselineHash&&h.hypothesisKey===hypothesisKey(candidate)&&h.outcome!=='invalid-evidence').map(h=>h.method);
  const unsupported=failures.filter(h=>h.baselineHash===baselineHash&&h.candidateId===candidate.candidateId
    &&['UNSUPPORTED_CODE_PATTERN','NO_CHANGE','ALREADY_TESTED_PATCH'].includes(h.code)).map(h=>h.method);
  // Legacy hidden variants are comparison tools, not automatic recovery from parking failure:
  // they add a second HTML copy/request and only alter first-open scheduling.
  const remaining=(candidate.methods??[]).filter(m=>!(candidate.kind==='hidden-dom'&&m.startsWith('hidden-template'))
    &&!(m==='section-liquid-inline'&&candidate.data?.securityPolicy?.complete===true&&!permitsBareInline(candidate.data.securityPolicy))
    &&!tried.some(t=>methodMechanism(t)===methodMechanism(m))&&!unsupported.includes(m));
  if(tried.includes('section-liquid-initial')&&remaining.includes('section-liquid-inline'))return ['section-liquid-inline',...remaining.filter(m=>m!=='section-liquid-inline')];
  return remaining;
}

/** A valid negative experiment excludes its causal mechanism, not just its method name. */
export function reassessCandidate(candidate,baselineHash,history=[],failures=[],group) {
  const matching=history.filter(h=>h.baselineHash===baselineHash&&h.hypothesisKey===hypothesisKey(candidate)&&h.outcome!=='invalid-evidence');
  const latest=matching.at(-1), measured=latest?.verification?.gain?.groups?.find(g=>g.device===candidate.device);
  const value=group?.metrics.find(m=>m.metric===candidate.metric)?.median??measured?.metrics?.[candidate.metric]?.before?.median;
  const floor=gainFloors[candidate.metric];
  // Nonnegative loading/layout metrics cannot improve by more than their entire baseline value.
  const gainCeiling={metric:candidate.metric,baselineMedian:value??null,requiredGain:floor??null,
    blocked:Number.isFinite(value)&&Number.isFinite(floor)&&value<floor};
  const regressions=Object.entries(measured?.metrics??{}).filter(([,m])=>m.regressed).map(([metric,m])=>({metric,before:m.before.median,after:m.after.median,gain:m.gain,floor:m.floor}));
  const c={...candidate,gainCeiling};
  const remainingMethods=remainingDomainMethods(c,baselineHash,history,failures);
  return {...c,remainingMethods,reassessment:{
    evidence:latest?{experiment:latest.experiment??null,outcome:latest.outcome,method:latest.method}:null,
    rejectedMechanisms:[...new Set(matching.map(h=>methodMechanism(h.method)))],regressions,
    reason:gainCeiling.blocked?'baseline-below-minimum-possible-gain':matching.length?'measured-mechanism-failed':'untested-source-bound-hypothesis',
    next:gainCeiling.blocked?'select-another-measured-bottleneck':remainingMethods.length?'test-a-different-cost-mechanism':'refresh-evidence-or-select-another-bottleneck',
    changedAssumption:({
      'hidden-detach':'Remove duplicated HTML and the extra script request; move original nodes before later DOM scans. This does not reduce server queries or initial HTML parsing.',
      'section-liquid-initial':'Remove the startup content waterfall by rendering the existing snippet in Liquid; retain Section API for later updates and prove initial no-JS equivalence.',
      'section-liquid-inline':'Remove the remaining external controller request only for an isolated controller of at most 4 KiB with reviewed inline-script policy; retain immediate interactions and validate new raw traces.',
    })[remainingMethods[0]]??null,
  }};
}

/** Recompute from raw samples and current sources. No lint count is a gain signal. */
export async function diagnoseRecovery({ project, run, profiles = [], liquidProfile, field, owners = [], goal, history = [], preparationFailures=[], sources }) {
  history=await Promise.all(history.map(async h=>{
    if(typeof h.verification!=='string')return h;
    try {const saved=await readEvidenceJSON(h.verification);return {...h,verificationFile:h.verification,verification:saved,
      ...(h.outcome==='formal-rejected'&&h.formalAfter?{formalEvidence:{before:run,after:h.formalAfter}}:{})};}
    catch{return {...h,verification:null};}
  }));
  const knowledge=officialMethodCatalog({sources});
  const target = goalContract(goal), snapshot = await sourceSnapshot(project);
  const evidence = await readRunEvidence(run, { allowExploration: true });
  const identity = checkRunDeployment(evidence);
  if (!snapshot.complete || identity.status !== 'verified' || identity.sourceHash !== snapshot.hash) throw new Error('Recovery requires complete current-source, deployment-bound measurements.');
  const warnings = evidence.groups.some(g => g.records.length < 3 || g.records.some(r => r.report.runWarnings?.length));
  if (warnings) throw new Error('Recovery needs at least three warning-free independent samples per group.');
  const validProfiles = profiles.filter(p => p.kind === 'runtime-profile' && p.status === 'complete' && p.sourceStable
    && p.snapshot?.hash === snapshot.hash && evidence.groups.some(g => g.device === p.config?.device
      && normalizeEvidenceUrl(g.url) === normalizeEvidenceUrl(p.config.url)));
  const diagnosis = await diagnoseUnified({ project, run, profiles: validProfiles, liquidProfile, field, owners, goal: target, limit: 20 });
  const groups = evidence.groups.map(g => {
    const losses = g.records.map(r => scoreLosses(r.report));
    const metrics = Object.entries(metricNames).map(([name, metric]) => {
      const rows = losses.map(r => r.find(x => x.metric === name));
      return { metric, median: median(rows.map(r => r.value)), lostPoints: rows.every(r => Number.isFinite(r.lostPoints)) ? median(rows.map(r => r.lostPoints)) : null };
    }).sort((a,b) => (b.lostPoints ?? -1) - (a.lostPoints ?? -1));
    const scores = g.records.map(r => r.report.categories.performance.score * 100), center = median(scores);
    const thresholds = g.device === 'mobile' ? { minimum: 75, median: 80 } : { minimum: 85, median: 90 };
    return { pageId: g.pageId, url: g.url, device: g.device, samples: scores.length,
      score: { minimum: Math.min(...scores), median: center, mad: median(scores.map(s => Math.abs(s-center))) },
      belowTarget: Math.min(...scores) < thresholds.minimum || center < thresholds.median, thresholds, metrics };
  });
  const attempts = new Map();
  for (const h of history) if (h.hypothesisKey && h.baselineHash === snapshot.hash && h.outcome !== 'invalid-evidence') {
    attempts.set(h.hypothesisKey, [...(attempts.get(h.hypothesisKey) ?? []), { fingerprint: h.fingerprint, outcome: h.outcome, method: h.method }]);
  }
  const candidates = (await Promise.all(diagnosis.candidates.map(async c => {
    const key = hypothesisKey(c), group = groups.find(g => g.device === c.device && normalizeEvidenceUrl(g.url) === normalizeEvidenceUrl(c.page));
    const reassessed=reassessCandidate(c,snapshot.hash,history,preparationFailures,group);
    const latest=history.filter(h=>h.baselineHash===snapshot.hash&&h.hypothesisKey===key&&h.outcome!=='invalid-evidence').at(-1);
    reassessed.reassessment.costEvidence=await readExperimentCost(latest,c);
    const fcpDecision=reassessed.reassessment.costEvidence.fcpDecision;
    if(fcpDecision) {
      // Keep the rejected patch and mechanism exclusion. An aggregate simulated
      // delta alone must not be rewritten as a proven application-code cause.
      reassessed.reassessment.reason='fcp-regression-causality-review-required';
      reassessed.reassessment.causalAssessment=fcpDecision;
      reassessed.reassessment.next='inspect-bound-fcp-graphs-before-changing-the-code-mechanism';
    }
    return { ...reassessed, officialMethods:(c.officialMethods??[]).map(o=>({...o,sourceStatus:knowledge.methods.find(m=>m.id===o.methodId)?.source.status??'missing',tested:history.some(h=>h.baselineHash===snapshot.hash&&h.hypothesisKey===key&&methodMechanism(h.method)===methodMechanism(o.executor.split(':').at(-1))&&h.outcome!=='invalid-evidence')})), hypothesisKey: key, tested: attempts.get(key) ?? [],
      lostPoints: group?.metrics.find(m => m.metric === c.metric)?.lostPoints ?? null,
      next: attempts.has(key) ? 'change-method-or-investigate-next-hypothesis' : 'prepare-source-bound-patch' };
  }))).sort((a,b) => Number(a.tested.length > 0)-Number(b.tested.length > 0)
    || (b.priority?.goalMatch ?? 0)-(a.priority?.goalMatch ?? 0)
    || Number(b.priority?.fieldBreach ?? false)-Number(a.priority?.fieldBreach ?? false)
    || (b.lostPoints ?? -1)-(a.lostPoints ?? -1));
  const investigations = groups.flatMap(g => {
    const metrics = target.kind === 'interaction' ? ['interaction'] : target.kind === 'loading' ? [target.metric]
      : g.metrics.filter(m => m.lostPoints === null || m.lostPoints > 0).slice(0,2).map(m => m.metric);
    return recoveryMethods.filter(m => m.metrics.some(metric => metrics.includes(metric))).map(m => ({
      ...m, pageId: g.pageId, url: g.url, device: g.device, status: 'investigation-required',
      profileAvailable: validProfiles.some(p => p.config.device === g.device && normalizeEvidenceUrl(p.config.url) === normalizeEvidenceUrl(g.url)),
    }));
  });
  const actionable=candidates.filter(c=>!c.methods||c.remainingMethods.length);
  const nextDomain=candidates.find(c=>c.remainingMethods.length);
  return { schemaVersion: 1, kind: 'recovery-diagnosis', status: candidates.some(c=>!c.methods||c.remainingMethods.length) ? 'candidate-review-required' : 'investigation-required',
    nextDomainStep:nextDomain?{candidateId:nextDomain.candidateId,method:nextDomain.remainingMethods[0],file:nextDomain.file,kind:nextDomain.kind}:null,
    sourceHash: snapshot.hash, manifestHash: evidence.manifestHash, goal: target, groups, candidates, investigations, diagnosis,
    officialKnowledge:{coverage:knowledge.coverage,status:knowledge.status},
    history, rejectedProfiles: profiles.length-validProfiles.length, references: recoveryReferences,
    executionCoverage: { supportedCandidates: actionable.length, exhaustedCandidates:candidates.length-actionable.length,
      status: actionable.length ? 'source-bound-plan-available' : 'no-executable-hypothesis',
      reason: actionable.length ? 'Source-mapped CPU/resources and deployment-bracketed image, layout, Liquid and app-loader hypotheses have executable generators; independent gain and preservation gates still apply.'
        : 'No current source-bound candidate for this goal. Capture deployment-bracketed domain profiles; unsupported dynamic or platform-owned paths cannot be patched by the theme tool.' },
    acceptance: 'not-evaluated',
    limitations: ['Lost points rank measured metrics, not achievable or additive savings.', 'No supported candidate means more evidence or a reviewed custom implementation is needed, not that this theme cannot improve.', 'Old or wrong-page profiles are excluded; no universal score guarantee.'] };
}
