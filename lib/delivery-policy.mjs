import {fields,digest} from './evidence-contract.mjs';
import {toolkitManifest} from './toolkit-manifest.mjs';
import {checkResult} from './check-results.mjs';

export const deliveryPolicy={id:'delivery-v1',version:1,
  rules:[
    {id:'runtime-integrity',source:'project',execution:'conditional',description:'Deployment-bound integrity evidence for media, loaders, critical styles and custom replacements.'},
    {id:'theme-adapter',source:'project',execution:'explicit',description:'Source-bound capability and strategy contract; unknown is not compatible.'},
    {id:'external-business',source:'project',execution:'explicit',description:'Independent raw business observations; never inferred from read-only scenarios.'},
    {id:'navigation-budget',source:'project',execution:'configured',description:'Existing Lighthouse per-sample budget.'},
    {id:'structure-budget',source:'project',execution:'audit-policy',description:'Incremental maintainability review, not runtime speed.'},
    {id:'visual-review',source:'manual',execution:'required',description:'Existing source-bound visual/content review remains required.'},
    {id:'theme-check',source:'official',execution:'external-import',description:'Use the actual official checker and preserve version/configuration.'}
  ]};
export function validateDeliveryPolicy(policy){
  if(policy===undefined)return null;
  if(policy!=='delivery-v1')throw new Error('Unknown delivery policy; use delivery-v1 or omit for legacy evidence.');
  return deliveryPolicy;
}
export function integrityRequired(plan,policy){
  validateDeliveryPolicy(policy);
  if(!policy)return false;
  return !plan||plan.changes?.some(c=>/image|stylesheet|script|component|critical|resource|replacement|asset/.test(c.recipeKind??'')
    ||['image-lcp','image-cls','app-loader','stylesheet'].includes(c.evidence?.domainKind));
}
export async function deliveryProvenance(config){
  return {toolkit:await toolkitManifest(),policy:config.policy?deliveryPolicy:null,configHash:digest(config),
    status:config.policy?'enabled-not-yet-assessed':'legacy-policy-not-enabled'};
}
export function gateStates(checks){return checks.map(c=>{
  const result=checkResult(c);
  return {id:c.id,implemented:c.implemented!==false,enabled:c.enabled!==false,executed:result.executed,
    status:result.status==='PASS'?'passed':result.status==='FAIL'?'failed':result.status==='N/A'?'not-applicable':'not-assessed',
    checkStatus:result.status,reason:result.reason};
});}
