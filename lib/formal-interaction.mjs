import {verifyInteractions,interactionMatchesNavigation} from './interaction-evidence.mjs';
import {requiredGoalGroups} from './run-evidence.mjs';
import {checkRunDeployment} from './deployment.mjs';

export async function formalInteractionGate({evidence,goal,baseline,measurement,sourceHash}) {
  const gate=await verifyInteractions({...evidence,goal,allowExploration:false});
  const groups=measurement.pages.flatMap(p=>measurement.devices.map(device=>({pageId:p.id,url:p.url,device})));
  if(!['interaction-improved','no-measurable-gain','interaction-regressed'].includes(gate.outcome)
    ||!interactionMatchesNavigation(gate,checkRunDeployment(baseline),{status:'verified',sourceHash,...measurement.deployment},requiredGoalGroups(goal,baseline.groups),requiredGoalGroups(goal,groups)))
    throw new Error('Formal interaction evidence is incomplete or bound to another source/store/theme/page/device; navigation samples were not started.');
  return gate;
}
