import {checkScenarioDeployment} from './optimization-regression.mjs';
import {validateScenarioConfig,assertionExpected} from './scenarios.mjs';
import {digest} from './evidence-contract.mjs';

/** Only observed assertion mismatches in the declared, identity-bound run prove broken behavior. */
export function observedFormalFailure(regression,candidate,identity) {
  try {
    const scenarios=regression?.scenarios;
    if(!checkScenarioDeployment(scenarios,identity,{before:regression.remoteBefore??candidate.manifest.deployment.after,after:regression.remote}))return false;
    const config=validateScenarioConfig(scenarios.config);
    if(config.project!==identity.project||config.expectedThemeId!==identity.themeId)return false;
    return scenarios.runs.some(r=>{
      const scenario=config.scenarios.find(s=>s.name===r.name&&s.url===r.url),viewport=config.viewports.find(v=>v.name===r.viewport?.name);
      if(!scenario||!viewport||['width','height','dpr'].some(k=>viewport[k]!==r.viewport[k])
        ||!candidate.groups.some(g=>g.url===r.url&&g.device===r.viewport.name)
        ||['errors','artifactErrors','pageErrors','blockedRequests'].some(k=>!Array.isArray(r[k])||r[k].length))return false;
      return r.steps.some((s,i)=>{
        const expected=scenario.steps[i];
        return expected?.action.startsWith('assert-')&&s.outcome==='failed'&&s.error?.code==='ASSERTION_FAILED'
          &&Object.entries(expected).every(([k,v])=>Object.hasOwn(s,k)&&digest(s[k])===digest(v))
          &&digest(s.error.expected)===digest(assertionExpected(expected))&&Object.hasOwn(s.error,'actual')
          &&digest(s.error.actual)!==digest(s.error.expected)&&r.steps.slice(0,i).every(step=>step.outcome==='passed');
      });
    });
  }catch{return false;}
}

/** Invalid or missing evidence cannot be recorded as a failed implementation. */
export function formalRecoveryDecision({verification,cumulative,goal,review,regression,candidate,sourceHash}) {
  const repair=reason=>({action:'repair-evidence',reasons:[reason]});
  const passes=id=>verification.checks?.some(c=>c.id===id&&c.pass===true);
  if(verification.outcome==='invalid-evidence'||!['score-targets-met','targets-not-met','performance-regressed'].includes(verification.scoreTargets?.outcome)
    ||!['measurable-gain','no-measurable-gain','performance-regressed'].includes(verification.gain?.outcome)
    ||!['measurable-gain','no-measurable-gain','performance-regressed'].includes(cumulative?.outcome))return repair('incomplete-formal-measurement');
  if(!passes('candidate-identity')||!passes('plan-matches-measured-source'))return repair('unverified-candidate-or-plan');
  const reasons=[];
  if([verification.gain.outcome,cumulative.outcome].includes('performance-regressed'))reasons.push('navigation-regression');
  if(goal.kind!=='interaction'&&[verification.gain.outcome,cumulative.outcome].includes('no-measurable-gain'))reasons.push('no-measurable-gain');
  if(verification.budget?.passed===false)reasons.push('resource-budget-exceeded');
  if(['no-measurable-gain','performance-regressed'].includes(verification.patchExperiment?.liquid?.outcome))reasons.push('liquid-no-gain-or-regression');
  if(goal.kind==='interaction'&&passes('interaction-evidence-identity')
    &&['no-measurable-gain','interaction-regressed'].includes(verification.interactions?.outcome))reasons.push('interaction-no-gain-or-regression');
  if(observedFormalFailure(regression,candidate,verification.identity?.after))reasons.push('observed-behavior-failure');
  if(review?.sourceHash===sourceHash&&(review.contentPreserved===false||review.visualsPreserved===false))reasons.push('review-rejected');
  return reasons.length?{action:'reject-patch',reasons}:repair('repair-failed-gates-using-existing-samples');
}


export function formalLiquidRejected(gate,beforeIdentity,sourceHash) {
  return ['hypothesis-not-confirmed','performance-regressed','functional-regressed'].includes(gate.outcome)
    &&['no-measurable-gain','performance-regressed'].includes(gate.liquid?.outcome)
    &&gate.sourceHashes?.before===beforeIdentity.sourceHash&&gate.sourceHashes?.after===sourceHash
    &&gate.identity?.before?.store===beforeIdentity.store&&gate.identity?.after?.store===beforeIdentity.store;
}
