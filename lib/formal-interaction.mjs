import {verifyInteractions,interactionMatchesNavigation} from './interaction-measure.mjs';
import {checkRunDeployment} from './deployment.mjs';

export async function formalInteractionGate({evidence,goal,baseline,measurement,sourceHash}) {
  const gate=await verifyInteractions({...evidence,goal,allowExploration:false});
  const groups=measurement.pages.flatMap(p=>measurement.devices.map(device=>({...p,device})));
  if(!['interaction-improved','no-measurable-gain','interaction-regressed'].includes(gate.outcome)
    ||!interactionMatchesNavigation(gate,checkRunDeployment(baseline),{status:'verified',sourceHash,...measurement.deployment},baseline.groups,groups))
    throw new Error('Formal interaction evidence is incomplete or bound to another source/store/theme/page/device; navigation samples were not started.');
  return gate;
}
