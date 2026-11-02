import {checkResourceEquivalence} from './resource-equivalence.mjs';
import {checkPerformanceBudget,validateResourceBudget} from './resource-budget.mjs';
import {readFile} from 'node:fs/promises';
import {validateSitePlan} from './site-changes.mjs';
import {checkOptimizationRegression,checkAppBehavior,checkAppDeployment,checkScenarioDeployment,checkExtendedBehavior,checkThemeBehavior} from './optimization-regression.mjs';
import {readRunEvidence} from './run-evidence.mjs';
import {evaluateGain} from './performance-gain.mjs';
import {checkRunDeployment} from './deployment.mjs';
import {verifySite} from './site-verify.mjs';
import {goalContract} from './evidence-contract.mjs';
import {verifyInteractions,interactionMatchesNavigation,interactionBehaviorCovered} from './interaction-measure.mjs';

export async function patchGate(plan, patchEvidence, goal, liquidEvidence) {
  if (!patchEvidence) throw new Error('A diagnosis-bound plan requires its independently verifiable single-patch experiment evidence.');
  const input = typeof patchEvidence === 'string' ? JSON.parse(await readFile(patchEvidence,'utf8')) : { ...patchEvidence };
  for (const key of ['diagnosis','regressionBefore','regressionAfter']) if (typeof input[key] === 'string') input[key] = JSON.parse(await readFile(input[key],'utf8'));
  const { verifyPatchExperiment } = await import('./patch-experiment.mjs');
  if (JSON.stringify(goalContract(input.goal)) !== JSON.stringify(goalContract(goal))) throw new Error('Patch experiment goal differs from formal goal.');
  return verifyPatchExperiment({ ...input,plan,minLiquidSamples:5,...(liquidEvidence?{liquidEvidence}:{}) });
}

export async function verifyOptimization({ before, after, regression, expectedSourceHash, review, plan, patchEvidence, goal, interactionEvidence, liquidEvidence, budget: budgetConfig } = {}) {
  const result = { schemaVersion: 1, kind: 'optimization-verification', outcome: 'not-accepted', checks: [],
    scope: 'Measured navigation score improvement on the declared matrix with source identity and supplied behavior/visual review; not field CWV or a guarantee.' };
  try {
    const target=goalContract(goal);result.goal=target;
    if (budgetConfig !== undefined) validateResourceBudget(budgetConfig);
    if (plan) await validateSitePlan(plan);
    if(plan?.metadata?.intent==='content-repair'||plan?.changes.some(c=>c.evidence?.resourceRepair))throw new Error('Content restoration requires its own acceptance and a corrected performance baseline.');
    const baseline = await readRunEvidence(before), candidate = await readRunEvidence(after);
    result.scoreTargets = await verifySite({ before, after });
    result.gain = await evaluateGain({ before, after, goal: target.kind==='interaction'?undefined:target });
    const a = checkRunDeployment(baseline), b = checkRunDeployment(candidate);
    if (plan?.changes.some(c => c.evidence?.candidateId)) {
      result.patchExperiment = await patchGate(plan,patchEvidence,target,liquidEvidence);
      result.checks.push({ id: 'single-patch-experiment', pass: result.patchExperiment.outcome === 'promising'
        && result.patchExperiment.sourceHashes.before === a.sourceHash && result.patchExperiment.sourceHashes.after === b.sourceHash && result.patchExperiment.identity?.before?.store===a.store && result.patchExperiment.identity?.after?.store===b.store });
    }
    result.identity = { before: a, after: b };
    if(plan?.changes.some(c=>c.recipeKind==='liquid-rehost-resource'))result.checks.push({id:'equivalent-resource-browser-responses',pass:checkResourceEquivalence(plan,regression?.resourceProfiles,a,b,candidate.groups)});
    result.checks.push({ id: 'original-score-targets', pass: result.scoreTargets.outcome === 'score-targets-met' },
      { id: target.kind==='score'?'measured-score-gain-no-metric-regression':'declared-goal-gain-no-metric-regression', pass: target.kind==='interaction'
        ? !['invalid-evidence','performance-regressed'].includes(result.gain.outcome) : result.gain.outcome === 'measurable-gain' },
      { id: 'candidate-identity', pass: a.status === 'verified' && b.status === 'verified' && a.store === b.store
        && b.sourceHash === expectedSourceHash && a.sourceHash !== b.sourceHash });
    if(target.kind==='interaction') {
      result.interactions=await verifyInteractions({...interactionEvidence,goal:target,allowExploration:false});
      result.checks.push({id:'interaction-evidence-identity',pass:result.interactions.outcome!=='invalid-evidence'&&interactionMatchesNavigation(result.interactions,a,b,baseline.groups,candidate.groups)});
      result.checks.push({id:'independent-interaction-gain',pass:result.interactions.outcome==='interaction-improved'
        &&interactionMatchesNavigation(result.interactions,a,b,baseline.groups,candidate.groups)});
      result.checks.push({id:'declared-interaction-behavior',pass:interactionBehaviorCovered(result.interactions,regression?.scenarios,b)});
    }
    if (plan) result.checks.push({ id: 'plan-matches-measured-source', pass: plan.changes.every(change =>
      (baseline.manifest.deployment?.before?.sourceManifest?.find(f => f.file === change.target)?.sourceHash ?? null) === change.beforeHash
      && candidate.manifest.deployment?.after?.sourceManifest?.some(f => f.file === change.target && f.sourceHash === change.afterHash)) });
    result.checks.push({ id: 'functional-regression', pass: checkOptimizationRegression(regression,candidate,b,expectedSourceHash) });
    if(plan?.changes.some(c=>c.evidence?.domainKind))result.checks.push({id:'domain-regression-deployment',pass:checkScenarioDeployment(regression?.scenarios,b,
      {before:regression?.remoteBefore??candidate.manifest.deployment?.after,after:regression?.remote})});
    if(plan?.changes.some(c=>c.evidence?.domainKind==='app-loader'))result.checks.push({id:'app-business-behavior',pass:checkAppBehavior(plan,regression?.scenarios)&&checkAppDeployment(plan,[candidate.manifest.deployment.before,candidate.manifest.deployment.after,regression?.remoteBefore??candidate.manifest.deployment.after,regression?.remote])});
    if(plan?.changes.some(c=>['hidden-dom','liquid-query','section-fetch'].includes(c.evidence?.domainKind)))result.checks.push({id:'extended-method-behavior',pass:checkExtendedBehavior(plan,regression?.scenarios,{candidate:true})});
    if(plan?.changes.some(c=>['stylesheet','liquid-render'].includes(c.evidence?.domainKind)))result.checks.push({id:'theme-method-behavior',pass:checkThemeBehavior(plan,regression?.scenarios,{candidate:true})});
    result.checks.push({ id: 'content-and-visual-review', pass: Boolean(review && /^[a-f0-9]{64}$/.test(expectedSourceHash ?? '') && review.sourceHash === expectedSourceHash && review.contentPreserved === true && review.visualsPreserved === true && typeof review.summary === 'string' && review.summary.trim()) });
    // Performance budget check: validate resource budgets against candidate measurements
    if (budgetConfig !== undefined) {
      const budgetCheck = checkPerformanceBudget(candidate, budgetConfig);
      result.budget = budgetCheck;
      result.checks.push({ id: 'performance-budget', pass: budgetCheck.passed, details: budgetCheck.details });
    }
    result.scope=target.kind==='score'?result.scope:`Declared ${target.kind} laboratory improvement with original navigation score thresholds, identity and behavior gates; field CWV not established.`;
    result.outcome = result.checks.every(c => c.pass) ? 'optimization-accepted' : 'not-accepted';
  } catch (error) { result.outcome = 'invalid-evidence'; result.error = error.message; }
  return result;
}
