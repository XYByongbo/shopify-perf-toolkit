import { verifySite } from './site-verify.mjs';
import { evaluateGain } from './performance-gain.mjs';
import { verifyInteractions, interactionMatchesNavigation } from './interaction-evidence.mjs';
import { fields, goalContract } from './evidence-contract.mjs';
import { readRunEvidence, requiredGoalGroups } from './run-evidence.mjs';
import { checkRunDeployment } from './deployment.mjs';
import {auditPolicy} from './policy-audit.mjs';

export function validateCIConfig(config) {
  fields(config,['schemaVersion','before','after','beforeRevision','afterRevision','goal','interactionEvidence','engineeringPolicy'],'CI config');
  if(config.schemaVersion!==1||!config.before||!config.after||config.before===config.after||![config.beforeRevision,config.afterRevision].every(s=>/^[a-f0-9]{40}$/.test(s??''))||config.beforeRevision===config.afterRevision)throw new Error('CI needs distinct explicit run paths and full baseline/candidate commit IDs.');
  return goalContract(config.goal);
}

/** Explicit independent baseline only; never replace missing baseline with the candidate. */
export async function checkCI(config) {
  const goal=validateCIConfig(config),scores=await verifySite(config);
  const gain=await evaluateGain({...config,goal:goal.kind==='interaction'?undefined:goal});
  const interactions=goal.kind==='interaction'?await verifyInteractions({...config.interactionEvidence,goal,allowExploration:false}):null;
  let interactionMatches=false;
  if(interactions?.outcome==='interaction-improved'){
    const a=await readRunEvidence(config.before),b=await readRunEvidence(config.after),left=checkRunDeployment(a),right=checkRunDeployment(b);
    try {
      interactionMatches=interactionMatchesNavigation(interactions,left,right,requiredGoalGroups(goal,a.groups),requiredGoalGroups(goal,b.groups));
    } catch {
      interactionMatches=false;
    }
  }
  const checks=[{id:'original-score-targets',pass:scores.outcome==='score-targets-met'}];
  if(goal.kind==='score'&&goal.requiredGroups)checks.push({id:'declared-score-gain',pass:gain.outcome==='measurable-gain'});
  if(goal.kind==='loading')checks.push({id:'declared-loading-gain',pass:gain.outcome==='measurable-gain'});
  if(goal.kind==='interaction')checks.push({id:'declared-interaction-gain-and-navigation-identity',pass:interactionMatches});
  let engineering=null;
  if(config.engineeringPolicy){
    engineering=await auditPolicy(config.engineeringPolicy);
    const a=checkRunDeployment(await readRunEvidence(config.before)),b=checkRunDeployment(await readRunEvidence(config.after));
    checks.push({id:'incremental-engineering-policy',pass:engineering.status==='passed'&&a.status==='verified'&&b.status==='verified'
      &&engineering.sourceHash===b.sourceHash&&engineering.beforeSourceHash===a.sourceHash});
  }
  const passed=checks.every(c=>c.pass);
  return {schemaVersion:1,kind:'ci-verification',outcome:passed?'passed':'not-passed',checks,goal,scores,gain,interactions,engineering,
    revisions:{before:config.beforeRevision,after:config.afterRevision,identity:'declared-by-ci-not-source-proof'},
    evidence:scores.evidence,optimization:'not-established-use-verify-optimization',
    limitations:['This CI gate preserves every original formal score, warning, matrix and regression check.', 'Commit labels are not deployment proof. Missing or incomparable baseline fails; no automatic preview sync, publication or full optimization acceptance.']};
}
