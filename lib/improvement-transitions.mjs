import path from 'node:path';
import {acceptanceContract} from './standards-policy.mjs';
import {validateBudget} from './execution-policy.mjs';

export function initializeImprovementState(config, previous, initial) {
  let state;
  if (previous) {
    state = structuredClone(previous);
    state.previous = path.join(previous.output, 'session.json'); state.parentHash = previous.sessionHash; state.step++;
    delete state.error; delete state.operationReceipt;
  } else {
    const policy = acceptanceContract(config.acceptancePolicy,config.goal);
    state = { schemaVersion: 1, kind: 'improvement-session', id: initial.id, step: 0,
      project: initial.project, originalRun: config.run, baselineRun: config.run,
      goal: policy.goal, acceptancePolicy: policy.id, budget: validateBudget(config.budget), counts: { rounds: 0, attempted: 0, failed: 0 },
      elapsedMs: 0, history: [], retained: [], baselineReplacements: [], status: 'diagnosis-required', acceptance: 'not-evaluated',
      ...(config.resourceBudget === undefined ? {} : {resourceBudget:config.resourceBudget}),
      inputs: { profiles: [], owners: [] }, limitations: ['No automatic preview synchronization or publishing.',
        'A promising patch and an improved intermediate baseline are not formal acceptance.',
        'CLI does not invoke a model or invent review evidence; complex patches are supplied by the operator.',
        'Session hashes detect accidental drift, not malicious rewriting or authorization.'] };
  }
  return state;
}

export function assertResumeAllowed(previous, action) {
  if (previous?.interruption?.requiresRollback && action !== 'rollback') {
    throw Object.assign(new Error('Interrupted side effects require rollback before another action; use the recovered session.'), {code:'INTERRUPTED_ROLLBACK_REQUIRED'});
  }
}

/** Check only session state here. Source, evidence and budget checks belong to their own gates. */
export function assertStepAllowed(state, config) {
  switch (config.action) {
    case 'start':
    case 'refresh':
      if (state.active) throw new Error('Finish or roll back the active patch before refreshing.');
      break;
    case 'reprofile':
      if (state.active) throw new Error('Fresh diagnosis evidence requires the restored baseline.');
      break;
    case 'prepare':
      if (state.active || !['ready-for-plan','investigation-required','rolled-back'].includes(state.status)) {
        throw new Error('A fresh diagnosis is required before prepare.');
      }
      break;
    case 'apply':
      if (state.status !== 'review-required' || config.reviewedPlanHash !== state.active?.planHash) {
        throw new Error('apply requires the exact reviewed active plan.');
      }
      break;
    case 'sync':
      if (state.active && state.status !== 'awaiting-preview-sync') throw new Error('Preview sync requires an applied candidate or restored baseline.');
      break;
    case 'experiment':
      if (state.status !== 'awaiting-preview-sync') throw new Error('Experiment requires an applied candidate.');
      break;
    case 'verify':
    case 'collect':
      if (state.status !== 'formal-validation-required') throw new Error('Formal verification requires a promising experiment.');
      break;
    case 'rollback':
      if (!state.active) throw new Error('No active patch to roll back. Retained patches have independent saved plans.');
      break;
    default:
      throw new Error('Unknown improvement action.');
  }
}

const transitions = {
  'refreshing'(state) {
    state.acceptance = 'not-evaluated';
  },
  'diagnosed'(state, recovery) {
    state.nextDomainStep = recovery.nextDomainStep ?? null;
    const needsInvestigation = recovery.status === 'investigation-required';
    state.status = needsInvestigation ? 'investigation-required' : 'ready-for-plan';
    state.next = needsInvestigation
      ? 'supported methods exhausted or evidence missing; refresh with new measurements or prepare a reviewed custom implementation'
      : 'prepare a source-bound method; domain candidateId=next and method=next select an available hypothesis and implementation, then apply and experiment';
  },
  'prepared'(state) {
    state.acceptance = 'not-evaluated';
    state.status = 'review-required';
    state.next = 'review the full plan, then apply with its exact reviewedPlanHash';
  },
  'applying'(state) {
    state.status = 'apply-recovery-required';
    state.previewSyncRequired = true;
    state.next = 'if application fails, inspect the receipt and rollback before preparing another patch';
  },
  'applied'(state) {
    state.status = 'awaiting-preview-sync';
    state.previewSyncRequired = true;
    state.next = 'explicitly sync the candidate preview, then experiment with both prepared previews';
  },
  'preview-verified'(state) {
    state.previewSyncRequired = false;
    state.next = state.active
      ? 'preview identity verified; run the independent patch experiment'
      : 'restored baseline identity verified; collect fresh diagnosis evidence';
  },
  'rolled-back'(state) {
    state.active = null;
    state.previewSyncRequired = true;
    if (state.interruption) state.interruption.requiresRollback = false;
    state.status = 'rolled-back';
    state.next = 'sync the restored preview explicitly before another experiment';
  },
  'rollback-conflict'(state) {
    state.status = 'rollback-conflict';
  },
  'promising'(state) {
    state.previewSyncRequired = false;
    state.status = 'formal-validation-required';
    state.next = 'collect the full formal matrix and regression/review evidence, then verify';
  },
  'experiment-evidence-required'(state) {
    state.next = 'repair the experiment evidence and retry within the remaining budget; the applied patch is available for verification or rollback';
  },
  'experiment-rejected'(state) {
    state.next = 'inspect recovery.json, change the failed assumption or select another hypothesis; restored preview requires sync';
  },
  'retained'(state, {after, intermediate}) {
    state.retained.push({...state.active, verification:state.verification, after});
    state.baselineRun = after;
    state.baselineHash = state.active.sourceHash;
    state.active = null;
    state.inputs.profiles = [];
    delete state.inputs.liquidProfile;
    state.status = intermediate ? 'improved-below-target' : 'optimization-accepted';
    state.acceptance = intermediate ? 'not-accepted' : 'optimization-accepted';
    state.next = intermediate
      ? 'refresh with current-source runtime profiles to target the remaining loss; budgets and history are retained'
      : 'report accepted scope and arrange separate field verification';
  },
  'not-accepted'(state) {
    state.acceptance = 'not-accepted';
  },
  'awaiting-formal-evidence'(state) {
    state.next = 'inspect failed formal gates; supply missing evidence and verify again, or rollback before changing the implementation';
  },
  'formal-preflight-rejected'(state) {
    state.next = 'formal target failed; collect fresh evidence and change the mechanism';
  },
  'formal-rejected'(state) {
    state.next = 'formal regression or no gain: patch rolled back; inspect recovery.json and change the mechanism';
  },
  'budget-stopped'(state) {
    state.status = 'stopped';
    state.next = state.active ? 'budget exhausted; rollback remains available' : 'deliver measured gains and unresolved investigations';
  },
  'interrupted'(state, interruption) {
    state.interruption = interruption;
    state.acceptance = 'not-accepted';
    delete state.error;
    if (interruption.requiresRollback) {
      state.status = 'interrupted-recovery-required';
      state.previewSyncRequired = true;
      state.next = 'inspect source and saved artifacts, then rollback using this session; interrupted samples cannot authorize resampling';
    } else {
      state.next = 'resume from this session with an explicit next action; normal source and budget guards still apply';
    }
  },
};

export function transition(state, event, payload) {
  transitions[event](state, payload);
}

export function formalRetentionDecision(goal, verification, cumulative) {
  const cumulativePass = goal.kind==='interaction'
    ? !['invalid-evidence','performance-regressed'].includes(cumulative.outcome) : cumulative.outcome === 'measurable-gain';
  const failures = verification.checks.filter(c=>!c.pass).map(c=>c.id);
  const intermediate = goal.kind!=='interaction' && verification.outcome==='not-accepted'
    && verification.scoreTargets?.outcome==='targets-not-met'
    && verification.scoreTargets.checks.every(c=>['pass','fail'].includes(c.status))
    && failures.length===1 && failures[0]==='original-score-targets';
  const retain = cumulativePass && (verification.outcome==='optimization-accepted' || intermediate);
  return {retain, intermediate};
}
