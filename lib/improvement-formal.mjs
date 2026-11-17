import {formalRetentionDecision, transition} from './improvement-transitions.mjs';
import {formalInteractionGate} from './formal-interaction.mjs';
import {formalRecoveryDecision, formalLiquidRejected} from './formal-recovery.mjs';
import path from 'node:path';
import {digest} from './evidence-contract.mjs';
import {verifyOptimization, patchGate} from './optimization-verification.mjs';
import {collectOptimizationEvidence} from './optimization-collection.mjs';
import {evaluateGain} from './performance-gain.mjs';
import {readRunEvidence} from './run-evidence.mjs';
import {checkRunDeployment} from './deployment.mjs';
import {json} from './improvement-evidence.mjs';

/** Advance formal evidence through collection and verification without replaying an incomplete matrix. */
export async function runImprovementFormal(config, step, actions) {
  await step.checkpoint(config.action);
  await step.evidence.snapshot(step.state.active.sourceHash);
  const supplied = config.action === 'collect'
    ? await collect(config.formal, step, actions)
    : await json(config.verification);
  if (config.action === 'collect' && supplied === undefined) return;
  await verify(supplied, step, actions);
}

async function collect(value, step, actions) {
  const {state, out, save, checkpoint, budget, evidence, dependencies} = step;
  const {pinRun, activePlan, pinFormalRun, prepareFormalCollection} = evidence;
  const {diagnose, restoreSource:rollback} = actions;
  const {formal, measurement} = await prepareFormalCollection(value);
  const attempts = measurement.pages.length * measurement.devices.length * measurement.runs;
  budget.requireAttempts(attempts);
  const destination = path.join(out,'formal');
  state.active.formalCollection = destination;
  state.active.formalMeasurement=measurement;
  await save('formal-collection-intent.json',{destination,attempts,sourceHash:state.active.sourceHash});
  budget.reserveAttempts(attempts); // Unknown progress remains charged on interruption.
  await checkpoint('collect');
  let collected;
  try {collected = await (dependencies.collectOptimizationEvidence ?? collectOptimizationEvidence)({config:{schemaVersion:1,action:'verify',
    project:state.project,plan:state.active.plan,reviewedPlanHash:state.active.planHash,before:state.baselineRun,
    ...formal,measurement:{...measurement,budget:{...measurement.budget,maxAttempts:attempts,
      maxFailures:Math.min(measurement.budget.maxFailures,state.budget.maxFailures-state.counts.failed),
      maxWallTimeMs:Math.max(1,Math.min(measurement.budget.maxWallTimeMs,Math.floor(budget.remainingMs()))) }},
    goal:state.goal,patchEvidence:state.active.patchEvidence,resourceProfiles:formal.resourceProfiles,integrityProfiles:formal.integrityProfiles,policy:formal.policy,businessEvidence:formal.businessEvidence,budget:state.resourceBudget??state.verificationBudget,exploreFirst:false,rollbackOnFailure:false},
    output:destination});
  } catch(error) {
    state.counts.failed++;throw error;
  } finally {
    // A collector may throw after writing the samples (including while saving
    // its final receipt). Bind those bytes even without a normal return value.
    try {await pinFormalRun(path.join(destination,'acceptance'));}catch {}
    budget.recordObservedAttempts(attempts, state.active.formalObservedAttempts ?? 0);
  }
  const used=collected.budget?.counts?.attempted;
  if(Number.isSafeInteger(used)&&used>=0&&used<(state.active.formalObservedAttempts??0)) {
    state.counts.failed++;throw new Error('Formal collector attempt count contradicts saved samples; reservation and original collection are retained.');
  }
  budget.settleAttempts(attempts, used);
  if(['formal-interaction','formal-liquid'].includes(collected.preflightRejection?.kind)&&collected.measurementStarted===false&&used===0&&!state.active.formalAfter) {
    const baseline=await pinRun(state.baselineRun),isInteraction=collected.preflightRejection.kind==='formal-interaction';
    let gate,evidenceInput;
    if(isInteraction) {
      if(state.goal.kind!=='interaction')throw new Error('Unexpected formal interaction rejection.');
      gate=await formalInteractionGate({evidence:formal.interactionEvidence,goal:state.goal,baseline,measurement,sourceHash:state.active.sourceHash});
      if(!['no-measurable-gain','interaction-regressed'].includes(gate.outcome))throw new Error('Formal interaction rejection cannot be independently reproduced.');
      evidenceInput=formal.interactionEvidence;
    } else {
      gate=await patchGate(await activePlan(),state.active.patchEvidence,state.goal,formal.liquidEvidence);
      if(!formalLiquidRejected(gate,checkRunDeployment(baseline),state.active.sourceHash))throw new Error('Formal Liquid rejection cannot be independently reproduced.');
      evidenceInput=await json(formal.liquidEvidence);
    }
    const evidence=await save('formal-preflight-evidence.json',evidenceInput),verificationFile=await save('formal-preflight-rejection.json',gate);
    state.counts.failed++;transition(state, 'not-accepted');
    state.formalRecovery=await save('formal-recovery.json',{action:'reject-patch',stage:'before-navigation',reasons:[isInteraction?'interaction-no-gain-or-regression':'liquid-no-gain-or-regression']});
    state.history.push({...state.active,baselineHash:state.baselineHash,outcome:'formal-rejected',
      rejectionReasons:[isInteraction?'interaction-no-gain-or-regression':'liquid-no-gain-or-regression'],verification:isInteraction?{interactions:gate}:{patchExperiment:gate},verificationFile,
      formalEvidence:{before:state.baselineRun,...(isInteraction?{interactionEvidence:evidence}:{liquidEvidence:evidence}),stage:'before-navigation'}});
    await rollback(); await diagnose();
    transition(state, 'formal-preflight-rejected');
    return;
  }
  if(collected.error || !collected.artifacts?.['regression-evidence.json']) {
    const beforeNavigation=collected.measurementStarted===false&&used===0&&!state.active.formalAfter;
    if(beforeNavigation)delete state.active.formalCollection;
    state.counts.failed++;throw new Error(beforeNavigation?'Formal preflight failed before navigation; fix configuration and collect.':
      'Formal collection incomplete; inspect saved samples and repair evidence with verify.');
  }
  return {after:path.join(destination,'acceptance'),regression:path.join(destination,'regression-evidence.json'),
    review:formal.review,interactionEvidence:formal.interactionEvidence,liquidEvidence:formal.liquidEvidence,policy:formal.policy,acceptancePolicy:formal.acceptancePolicy,standardsEvidence:formal.standardsEvidence};
}

async function verify(supplied, step, actions) {
  const {state, save, evidence, dependencies} = step;
  const {snapshot, pinRun, prepareFormalVerification} = evidence;
  const {diagnose, restoreSource:rollback} = actions;
  const {input, afterEvidence, savedLiquid} = await prepareFormalVerification(supplied);
  const verification = await (dependencies.verifyOptimization ?? verifyOptimization)(input);
  if(supplied.liquidEvidence&&verification.patchExperiment?.liquid?.outcome&&verification.patchExperiment.liquid.outcome!=='invalid-evidence') {
    state.active.liquidEvidenceHash=digest(supplied.liquidEvidence);state.active.liquidEvidence=savedLiquid;
  }
  await snapshot(state.active.sourceHash);
  state.verification = await save('verification.json',verification);
  // Compare the final candidate to the original baseline as well as the last retained step.
  const cumulative = await (dependencies.evaluateGain ?? evaluateGain)({before:state.originalFormalRun??state.originalRun,after:supplied.after,
    goal:state.goal.kind==='interaction'?(supplied.acceptancePolicy?{kind:'loading',metric:'lcp'}:undefined):state.goal,scoreDiagnosticOnly:Boolean(supplied.acceptancePolicy)});
  state.cumulativeGain = await save('cumulative-gain.json',cumulative);
  const {retain, intermediate} = formalRetentionDecision(state.goal, verification, cumulative);
  if (retain) {
    const evidence = await readRunEvidence(supplied.after), identity = checkRunDeployment(evidence);
    if (identity.status!=='verified' || identity.sourceHash!==state.active.sourceHash) throw new Error('Formal candidate identity differs from the session.');
    await pinRun(supplied.after);
    transition(state, 'retained', {after:supplied.after, intermediate});
  } else {
    transition(state, 'not-accepted');
    const decision=formalRecoveryDecision({verification,cumulative,goal:state.goal,review:supplied.review,
      regression:supplied.regression,candidate:afterEvidence,sourceHash:state.active.sourceHash});
    state.formalRecovery=await save('formal-recovery.json',decision);
    if (decision.action==='reject-patch') {
      state.counts.failed++;
      state.history.push({...state.active,baselineHash:state.baselineHash,outcome:'formal-rejected',verification,rejectionReasons:decision.reasons,
        verificationFile:state.verification,formalEvidence:{before:state.baselineRun,after:afterEvidence.root}});
      await rollback(); await diagnose();
      transition(state, 'formal-rejected');
    } else transition(state, 'awaiting-formal-evidence');
  }
}
