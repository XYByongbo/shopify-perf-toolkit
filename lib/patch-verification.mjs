import { readFile } from 'node:fs/promises';
import { goalContract } from './evidence-contract.mjs';
import {acceptanceContract, navigationGainOptions} from './standards-policy.mjs';
import { sha256 } from './source-utils.mjs';
import { validateSitePlan } from './site-changes.mjs';
import { requireHypothesis } from './bottlenecks.mjs';
import { readRunEvidence, normalizeEvidenceUrl, requiredGoalGroups } from './run-evidence.mjs';
import { checkRunDeployment } from './deployment.mjs';
import { evaluateGain } from './performance-gain.mjs';
import { verifyPreservation } from './preservation.mjs';
import { verifyInteractions, interactionMatchesNavigation, interactionBehaviorCovered } from './interaction-evidence.mjs';
import { verifyLiquidGain } from './liquid-experiment.mjs';
import { checkAppBehavior, checkAppDeployment, checkAppPlan, checkScenarioDeployment, checkExtendedBehavior, checkExtendedPlan, checkThemeBehavior } from './optimization-regression.mjs';

export const patchFingerprint = plan => sha256(JSON.stringify(plan.changes.map(c => [c.target,c.beforeHash,c.afterHash]).sort((a,b) => a[0].localeCompare(b[0]))));
export function assertHypothesisScope(hypothesis, groups) {
  if (!hypothesis.page || !hypothesis.device || groups.length !== 1 || groups.some(g =>
    g.device !== hypothesis.device || normalizeEvidenceUrl(g.url) !== normalizeEvidenceUrl(hypothesis.page))) {
    throw new Error('Experiment page/device differs from the selected diagnosis hypothesis.');
  }
}
export function experimentHistoryGate(history, plan, maxRounds = 3) {
  if (!Array.isArray(history) || history.some(r => r?.kind !== 'patch-experiment-verification' || !r.fingerprint || !['promising','invalid-evidence','no-measurable-gain','performance-regressed','functional-regressed','hypothesis-not-confirmed'].includes(r.outcome))) throw new Error('History must contain complete prior patch experiment decisions.');
  if (!Number.isInteger(maxRounds) || maxRounds < 1 || maxRounds > 10) throw new Error('maxRounds must be 1..10.');
  const fingerprint = patchFingerprint(plan);
  if (history.length >= maxRounds) return { stop: true, reason: 'candidate-round-budget' };
  if (history.some(r => r.fingerprint === fingerprint && r.outcome !== 'invalid-evidence')) return { stop: true, reason: 'candidate-already-tested' };
  if (history.length >= 2 && history.slice(-2).every(r => r.outcome !== 'promising')) return { stop: true, reason: 'consecutive-unproductive-experiments' };
  return { stop: false };
}

export function verifyOnlyPatch(plan, beforeFiles, afterFiles) {
  const before = new Map(beforeFiles.map(f => [f.file,f.sourceHash])), after = new Map(afterFiles.map(f => [f.file,f.sourceHash]));
  if (before.size !== beforeFiles.length || after.size !== afterFiles.length) throw new Error('Duplicate source inventory paths.');
  const changed = [...new Set([...before.keys(),...after.keys()])].filter(f => before.get(f) !== after.get(f)).sort();
  const targets = plan.changes.map(c => c.target).sort();
  if (JSON.stringify(changed) !== JSON.stringify(targets)) throw new Error('Candidate contains unrelated changes or omits planned changes.');
  for (const c of plan.changes) if ((before.get(c.target) ?? null) !== c.beforeHash || after.get(c.target) !== c.afterHash) throw new Error(`Source does not match patch: ${c.target}`);
  for(const d of plan.metadata?.readOnlyDependencies??[])if(before.get(d.file)!==d.sourceHash||after.get(d.file)!==d.sourceHash)throw new Error('Read-only optimization dependency differs from the measured source.');
  return changed;
}

export async function verifyPatchExperiment({ plan, diagnosis, candidateId, before, after, regressionBefore, regressionAfter, goal, acceptancePolicy, interactionEvidence, liquidEvidence, minLiquidSamples=3 } = {}) {
  const result = { schemaVersion: 1, kind: 'patch-experiment-verification', outcome: 'invalid-evidence', formalAcceptance: 'not-evaluated', checks: [],
    limitations: ['One declared hypothesis on one representative page/device. A promising result still requires the original full acceptance matrix.', 'MAD thresholds are decision heuristics, not causal confidence intervals.', 'All normal resources remain enabled. External app/network changes can still confound measurements.'] };
  try {
    const policy = acceptanceContract(acceptancePolicy,goal);
    const declaredGoal = policy.goal;
    result.goal = declaredGoal;
    result.acceptancePolicy = policy.id;
    await validateSitePlan(plan); result.planHash = plan.planHash; result.fingerprint = patchFingerprint(plan);
    if(plan.metadata?.intent==='content-repair'||plan.changes.some(c=>c.evidence?.resourceRepair))throw new Error('Content repairs use verify-resource-repair and a corrected baseline; they are not performance gain experiments.');
    const a = await readRunEvidence(before,{ allowExploration: true }), b = await readRunEvidence(after,{ allowExploration: true });
    if (a.groups.length !== 1 || b.groups.length !== 1) throw new Error('A patch experiment must use exactly one representative page/device.');
    requiredGoalGroups(declaredGoal,a.groups,{representative:true});
    requiredGoalGroups(declaredGoal,b.groups,{representative:true});
    const left = checkRunDeployment(a), right = checkRunDeployment(b);
    if (left.status !== 'verified' || right.status !== 'verified' || left.store !== right.store) throw new Error('Both measured sources require verified deployment identity in the same store.');
    const beforeFiles = a.manifest.deployment.before.sourceManifest, afterFiles = b.manifest.deployment.after.sourceManifest;
    result.changedFiles = verifyOnlyPatch(plan,beforeFiles,afterFiles);
    const hypothesis = requireHypothesis(diagnosis,candidateId,{ hash: left.sourceHash, files: beforeFiles });
    assertHypothesisScope(hypothesis,a.groups); assertHypothesisScope(hypothesis,b.groups);
    if(declaredGoal.kind!=='score' && hypothesis.metric!==declaredGoal.metric)throw new Error('Declared goal does not match the selected diagnosis hypothesis.');
    if(declaredGoal.kind==='interaction'&&(hypothesis.target!==declaredGoal.target||hypothesis.event!==declaredGoal.event))throw new Error('Interaction target/event differs from the selected diagnosis hypothesis.');
    if (plan.changes.some(c => c.evidence.candidateId !== candidateId || c.evidence.diagnosisSourceHash !== left.sourceHash)) throw new Error('Every file in this patch must bind the same current-source hypothesis.');
    result.hypothesis = { candidateId, file: hypothesis.file, line: hypothesis.line, metric: hypothesis.metric };
    result.sourceHashes = { before: left.sourceHash, after: right.sourceHash };
    result.identity = { before:left, after:right };
    if(hypothesis.source.status==='verified-domain-source'&&(!checkScenarioDeployment(regressionBefore,left,regressionBefore?.domainProof??a.manifest.deployment)
      ||!checkScenarioDeployment(regressionAfter,right,regressionAfter?.domainProof??b.manifest.deployment)))throw new Error('Domain regression must be bracketed by the measured source deployment proofs.');
    if(['hidden-dom','liquid-query','section-fetch'].includes(hypothesis.kind)&&(!checkExtendedPlan(plan,hypothesis)||!checkExtendedBehavior(plan,regressionBefore)||!checkExtendedBehavior(plan,regressionAfter,{candidate:true})))throw new Error('Extended method needs its own complete behavior, page or section request evidence.');
    if(hypothesis.kind==='app-loader'&&!checkAppPlan(plan,hypothesis))throw new Error('App plan must retain the diagnosed script identity and business contract.');
    if(hypothesis.kind==='app-loader'&&!checkAppDeployment(plan,[a.manifest.deployment.before,a.manifest.deployment.after,b.manifest.deployment.before,b.manifest.deployment.after]))throw new Error('App script bytes changed or are missing in deployment captures bracketing measurements.');
    if(!checkThemeBehavior(plan,regressionBefore)||!checkThemeBehavior(plan,regressionAfter,{candidate:true}))throw new Error('Missing theme method mechanism or checkpoint evidence.');
    if(['liquid-hotspot','liquid-query','liquid-render'].includes(hypothesis.kind)) {
      const evidence=typeof liquidEvidence==='string'?JSON.parse(await readFile(liquidEvidence,'utf8')):liquidEvidence;
      result.liquid=verifyLiquidGain({evidence,hypothesis,beforeIdentity:left,afterIdentity:right,minSamples:minLiquidSamples});
      if(result.liquid.outcome==='invalid-evidence')throw new Error(result.liquid.error);
    }
    result.gain = await evaluateGain({ before, after, allowExploration:true,representative:true,...navigationGainOptions(declaredGoal,acceptancePolicy) });
    if (result.gain.outcome === 'invalid-evidence') throw new Error(result.gain.error ?? 'Invalid score samples.');
    result.preservation = verifyPreservation({ before: regressionBefore, after: regressionAfter, beforeSourceHash: left.sourceHash, afterSourceHash: right.sourceHash,plan });
    if (result.preservation.outcome === 'invalid-evidence') throw new Error(result.preservation.reason ?? 'Missing comparable checkpoints.');
    if (plan.changes.some(c=>/\.m?js$/.test(c.target)||c.evidence?.domainKind==='hidden-dom') && !result.preservation.checks.some(c=>c.kind==='interaction-response')) throw new Error('JS patches, including inline hidden DOM code, require a click/press immediately followed by an explicit UI assertion, including response timing.');
    if(hypothesis.kind==='app-loader')for(const scenarios of [regressionBefore,regressionAfter]) {
      const selectors=plan.changes.flatMap(c=>c.evidence.businessAssertions??[]);
      if(!checkAppBehavior(plan,scenarios)||!selectors.length||!result.preservation.checks.some(c=>c.kind==='interaction-response'))throw new Error('App loader verification requires the original script to finish loading and explicit business UI assertions on both sides.');
    }
    for (const [run,identity,group] of [[regressionBefore,left,a.groups[0]],[regressionAfter,right,b.groups[0]]]) {
      if (!run.runs.some(r => normalizeEvidenceUrl(r.url) === normalizeEvidenceUrl(group.url) && r.viewport.name === group.device)
        || run.runs.some(r => r.themeId !== identity.themeId)) throw new Error('Regression evidence does not cover the measured page/device/theme.');
    }
    const interaction=declaredGoal.kind==='interaction'?await verifyInteractions({...interactionEvidence,goal:declaredGoal,allowExploration:true}):null;
    if(interaction){result.interactions=interaction;if(interaction.outcome==='invalid-evidence'||!interactionMatchesNavigation(interaction,left,right,a.groups,b.groups))throw new Error('Interaction evidence does not match the selected patch, store, theme, page or device.');}
    if(interaction&&(!interactionBehaviorCovered(interaction,regressionBefore,left)||!interactionBehaviorCovered(interaction,regressionAfter,right)))throw new Error('Both patch scenarios must exercise the declared interaction target and immediately assert its UI result.');
    const target = interaction?{improved:interaction.outcome==='interaction-improved'}:result.gain.groups[0].metrics[hypothesis.metric];
    if (!target) throw new Error('This hypothesis has no independently measured metric in the scoring evidence.');
    result.outcome = result.preservation.outcome === 'regressed' ? 'functional-regressed'
      : result.gain.outcome === 'performance-regressed'||interaction?.outcome==='interaction-regressed'||result.liquid?.outcome==='performance-regressed' ? 'performance-regressed'
      : result.liquid && result.liquid.outcome!=='measurable-gain' ? 'hypothesis-not-confirmed'
      : !interaction&&result.gain.outcome !== 'measurable-gain' ? 'no-measurable-gain'
      : !target.improved ? 'hypothesis-not-confirmed' : 'promising';
    result.checks = [{ id: 'only-selected-patch', pass: true }, { id: 'source-identity', pass: true },
      { id: 'content-layout-behavior', pass: result.preservation.outcome === 'preserved' },
      { id: 'target-metric-improved', pass: target.improved }, { id: declaredGoal.kind==='score'?'score-gain-no-metric-regression':'goal-gain-no-metric-regression', pass: interaction?target.improved&&result.gain.outcome!=='performance-regressed':result.gain.outcome === 'measurable-gain' }];
  } catch (error) { result.error = error.message; }
  return result;
}

export async function patchGate(plan, patchEvidence, goal, liquidEvidence, acceptancePolicy) {
  if (!patchEvidence) throw new Error('A diagnosis-bound plan requires its independently verifiable single-patch experiment evidence.');
  const input = typeof patchEvidence === 'string' ? JSON.parse(await readFile(patchEvidence,'utf8')) : { ...patchEvidence };
  for (const key of ['diagnosis','regressionBefore','regressionAfter']) if (typeof input[key] === 'string') input[key] = JSON.parse(await readFile(input[key],'utf8'));
  if (JSON.stringify(goalContract(input.goal)) !== JSON.stringify(goalContract(goal))) throw new Error('Patch experiment goal differs from formal goal.');
  if (input.acceptancePolicy !== undefined && input.acceptancePolicy !== acceptancePolicy) {
    throw new Error('Patch experiment acceptance policy differs from formal acceptance policy.');
  }
  const replay = { ...input,plan,minLiquidSamples:5,...(liquidEvidence?{liquidEvidence}:{}) };
  if (input.acceptancePolicy === undefined && acceptancePolicy !== undefined) {
    // Older patch artifacts omit the policy. Preserve their original decision
    // before allowing a previously promising experiment to carry forward.
    const legacy = await verifyPatchExperiment(replay);
    if (legacy.outcome !== 'promising') return legacy;
  }
  return verifyPatchExperiment({ ...replay,acceptancePolicy });
}
