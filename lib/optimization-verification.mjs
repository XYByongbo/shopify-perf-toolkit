import {acceptanceContract} from './standards-policy.mjs';
import {verifyStandardsEvidence} from './standards-acceptance.mjs';
import {strategyCoverage} from './strategy-contract.mjs';
import {checkAdapterPlanBinding} from './theme-capabilities.mjs';
import {validateDeliveryPolicy,integrityRequired,deliveryProvenance,gateStates} from './delivery-policy.mjs';
import {verifyBusinessEvidence} from './business-evidence.mjs';
import {checkFormalRuntimeIntegrity} from './formal-runtime-integrity.mjs';
import {checkResourceEquivalence} from './resource-equivalence.mjs';
import {checkPerformanceBudget,validateResourceBudget} from './resource-budget.mjs';
import {validateSitePlan} from './site-changes.mjs';
import {checkOptimizationRegression,checkAppBehavior,checkAppDeployment,checkScenarioDeployment,checkExtendedBehavior,checkThemeBehavior} from './optimization-regression.mjs';
import {readRunEvidence} from './run-evidence.mjs';
import {evaluateGain} from './performance-gain.mjs';
import {checkRunDeployment} from './deployment.mjs';
import {verifySite} from './site-verify.mjs';
import {goalContract} from './evidence-contract.mjs';
import {checkResult} from './check-results.mjs';
import {verifyInteractions,interactionMatchesNavigation,interactionBehaviorCovered} from './interaction-evidence.mjs';

import {patchGate} from './patch-verification.mjs';

export {patchGate};

export async function verifyOptimization({ before, after, regression, expectedSourceHash, review, plan, patchEvidence, goal, interactionEvidence, liquidEvidence, budget: budgetConfig, policy, acceptancePolicy, standardsEvidence } = {}) {
  const result = { schemaVersion: 1, kind: 'optimization-verification', outcome: 'not-accepted', checks: [],
    scope: 'Measured navigation score improvement on the declared matrix with source identity and supplied behavior/visual review; not field CWV or a guarantee.' };
  try {
    validateDeliveryPolicy(policy);
    result.acceptancePolicy=acceptanceContract(acceptancePolicy,goal);
    result.provenance=await deliveryProvenance({policy:policy??null,before,after,expectedSourceHash,goal:goal??null,acceptancePolicy:acceptancePolicy??null,standardsEvidence:standardsEvidence??null,planHash:plan?.planHash??null,budget:budgetConfig??null});
    const target=goalContract(goal);result.goal=target;
    if (budgetConfig !== undefined) validateResourceBudget(budgetConfig);
    if (plan) await validateSitePlan(plan);
    if(plan?.metadata?.intent==='content-repair'||plan?.changes.some(c=>c.evidence?.resourceRepair))throw new Error('Content restoration requires its own acceptance and a corrected performance baseline.');
    const baseline = await readRunEvidence(before), candidate = await readRunEvidence(after);
    result.scoreTargets = await verifySite({ before, after });
    result.gain = await evaluateGain({ before, after, goal: target.kind==='interaction'?(acceptancePolicy?{kind:'loading',metric:'lcp'}:undefined):target, scoreDiagnosticOnly:Boolean(acceptancePolicy) });
    const a = checkRunDeployment(baseline), b = checkRunDeployment(candidate);
    if (plan?.changes.some(c => c.evidence?.candidateId)) {
      result.patchExperiment = await patchGate(plan,patchEvidence,target,liquidEvidence);
      result.checks.push({ id: 'single-patch-experiment', pass: result.patchExperiment.outcome === 'promising'
        && result.patchExperiment.sourceHashes.before === a.sourceHash && result.patchExperiment.sourceHashes.after === b.sourceHash && result.patchExperiment.identity?.before?.store===a.store && result.patchExperiment.identity?.after?.store===b.store });
    }
    result.identity = { before: a, after: b };
    result.runtimeIntegrity=checkFormalRuntimeIntegrity(regression?.integrityProfiles,a,b,candidate.groups);
    if(regression?.integrityProfiles!==undefined||acceptancePolicy||integrityRequired(plan,policy))result.checks.push({id:'runtime-metric-and-loading-integrity',pass:result.runtimeIntegrity.pass===true,
      ...(result.runtimeIntegrity.status==='not-assessed'?{executed:false,reason:result.runtimeIntegrity.reason}:{})});
    if(policy||plan?.adapter)result.checks.push({id:'theme-adapter-bound',pass:checkAdapterPlanBinding(plan,a,b,baseline.manifest.deployment?.before?.sourceManifest??[])});
    if(regression?.businessEvidence){
      result.business=await verifyBusinessEvidence({...regression.businessEvidence,identity:b});
      result.checks.push({id:'external-business-observations',pass:result.business.outcome==='passed'});
    }
    if(plan?.changes.some(c=>c.recipeKind==='liquid-rehost-resource'))result.checks.push({id:'equivalent-resource-browser-responses',pass:checkResourceEquivalence(plan,regression?.resourceProfiles,a,b,candidate.groups)});
    if(!acceptancePolicy)result.checks.push({ id: 'original-score-targets', pass: result.scoreTargets.outcome === 'score-targets-met' });
    result.checks.push(
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
    result.checks.push({ id: 'functional-regression', pass: checkOptimizationRegression(regression,candidate,b,expectedSourceHash),
      ...(!regression?.scenarios?{executed:false,reason:'No functional scenario evidence supplied.'}:{}) });
    if(plan?.changes.some(c=>c.evidence?.domainKind))result.checks.push({id:'domain-regression-deployment',pass:checkScenarioDeployment(regression?.scenarios,b,
      {before:regression?.remoteBefore??candidate.manifest.deployment?.after,after:regression?.remote})});
    if(plan?.changes.some(c=>c.evidence?.domainKind==='app-loader'))result.checks.push({id:'app-business-behavior',pass:checkAppBehavior(plan,regression?.scenarios)&&checkAppDeployment(plan,[candidate.manifest.deployment.before,candidate.manifest.deployment.after,regression?.remoteBefore??candidate.manifest.deployment.after,regression?.remote])});
    if(plan?.changes.some(c=>['hidden-dom','liquid-query','section-fetch'].includes(c.evidence?.domainKind)))result.checks.push({id:'extended-method-behavior',pass:checkExtendedBehavior(plan,regression?.scenarios,{candidate:true})});
    if(plan?.changes.some(c=>['stylesheet','liquid-render'].includes(c.evidence?.domainKind)))result.checks.push({id:'theme-method-behavior',pass:checkThemeBehavior(plan,regression?.scenarios,{candidate:true})});
    result.checks.push({ id: 'content-and-visual-review', pass: Boolean(review && /^[a-f0-9]{64}$/.test(expectedSourceHash ?? '') && review.sourceHash === expectedSourceHash && review.contentPreserved === true && review.visualsPreserved === true && typeof review.summary === 'string' && review.summary.trim()),
      ...(!review?{executed:false,reason:'No content and visual review supplied.'}:{}) });
    // Performance budget check: validate resource budgets against candidate measurements
    if (budgetConfig !== undefined) {
      const budgetCheck = checkPerformanceBudget(candidate, budgetConfig);
      result.budget = budgetCheck;
      result.checks.push({ id: 'performance-budget', pass: budgetCheck.passed, details: budgetCheck.details });
    }
    if(plan?.metadata?.strategyContract){result.strategyCoverage=strategyCoverage(plan,regression?.scenarios,result.business);result.checks.push({id:'strategy-contract-coverage',pass:result.strategyCoverage.pass});}
    if(acceptancePolicy){
      result.standards=await verifyStandardsEvidence({input:standardsEvidence,
        beforeManifest:baseline.manifest.deployment.before.sourceManifest,afterManifest:candidate.manifest.deployment.after.sourceManifest,
        sourceHash:b.sourceHash,pages:candidate.groups.map(g=>g.url)});
      result.checks.push(...result.standards.checks.filter(c=>c.blocking!==false));
    }
    result.scope=target.kind==='score'?result.scope:`Declared ${target.kind} laboratory improvement with original navigation score thresholds, identity and behavior gates; field CWV not established.`;
    if(acceptancePolicy)result.scope='Declared metric laboratory improvement with source-bound Theme Check and scoped review evidence; score is diagnostic, field CWV is not established.';
    result.outcome = result.checks.every(c => c.pass) ? 'optimization-accepted' : 'not-accepted';
  } catch (error) { result.outcome = 'invalid-evidence'; result.error = error.message; }
  result.gates=gateStates(result.checks);
  result.checkResults=[...result.checks,...(result.standards?.checks.filter(c=>c.blocking===false)??[])].map(checkResult);
  if(result.runtimeIntegrity?.status==='not-assessed'&&!result.gates.some(g=>g.id==='runtime-metric-and-loading-integrity')){
    const missing={id:'runtime-metric-and-loading-integrity',enabled:false,executed:false,reason:result.runtimeIntegrity.reason};
    result.gates.push(...gateStates([missing]));result.checkResults.push(checkResult(missing));
  }
  return result;
}
