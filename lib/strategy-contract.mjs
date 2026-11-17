import {fields,digest} from './evidence-contract.mjs';
import {canonical} from './core/plan-utils.mjs';
import {resolveThemeAdapter} from './theme-capabilities.mjs';
import {createSitePlan} from './site-changes.mjs';

export const strategyContracts={
  'jquery-lifecycle':{requires:['resources','lifecycle'],cases:['first-use','repeat-use','two-instances','unload-reconnect','editor-reload'],conditions:['plugin-destroy-contract','namespaced-events','async-cancellation'],implementation:'Reuse assets/runtime/theme-adapter-primitives.mjs instanceLifecycle; provide actual plugin mount/destroy.'},
  'section-styles':{requires:['rendering','resources','lifecycle'],cases:['initial','dynamic-replace','repeat-replace','failure-recovery'],conditions:['unique-section-target','stylesheet-response-preserved','explicit-initializer'],implementation:'Reuse replaceSectionContents; scripts remain inert and styles are preserved.'},
  'cart-bundled':{requires:['business','lifecycle','ownership'],cases:['double-submit','section-null','same-variant-properties','empty-cart','uncertain-write'],conditions:['locale-and-section-ids','server-state-reconciliation','business-event-contract'],implementation:'Reuse cartMutationQueue; pass theme request/read/render/recovery hooks. Never automatically retry a write.',business:true},
  'font-fallback':{requires:['resources','rendering'],cases:['font-cold','font-ready','mobile','desktop','multilingual'],conditions:['font-identity-preserved','fallback-metrics-reviewed','layout-compared'],implementation:'Reuse existing liquid-font-display generator; fallback metric changes use reviewed replacements.'},
  'media-presentation':{requires:['rendering','resources','lifecycle'],cases:['initial','first-use','delayed-recovery','mobile','desktop'],conditions:['actual-lcp-confirmed','media-quality-preserved','visibility-dependency-reviewed'],implementation:'Reuse profile-domain, runtime integrity and image priority strategies; presentation changes remain reviewed replacements.'}
};
/** Extend existing plans with a versioned contract, never invent a second patch executor. */
export function validateStrategyConfig(config) {
  fields(config,['project','strategy','adapter','identity','context','recipe','review'],'strategy contract');
  if (!Object.hasOwn(strategyContracts, config.strategy)) throw new Error('strategy must be one of: '+Object.keys(strategyContracts).join(', ')+'.');
  const spec=strategyContracts[config.strategy];
  fields(config.review,['summary','conditions'],'strategy review');
  if(typeof config.review.summary!=='string'||!config.review.summary.trim()||!Array.isArray(config.review.conditions)||spec.conditions.some(c=>!config.review.conditions.includes(c)))throw new Error('Concrete review of all strategy conditions required.');
  return spec;
}

export async function prepareStrategyContract(config){
  const spec=validateStrategyConfig(config);
  const binding={adapter:config.adapter,identity:config.identity,context:config.context,strategy:config.strategy};
  const resolution=await resolveThemeAdapter({project:config.project,...binding,targets:config.recipe?.changes?.map(c=>c.target)??[]});
  if(resolution.status!=='compatible-for-declared-strategy'||spec.requires.some(k=>config.adapter.capabilities[k].status!=='verified'))throw new Error('Strategy capability requirements not met.');
  const contract={version:1,id:config.strategy,...spec,review:config.review};
  const plan=await createSitePlan({project:config.project,recipe:{...config.recipe,adapter:binding},metadata:{strategyContract:contract}});
  return {schemaVersion:1,kind:'strategy-contract',status:'review-required',contractHash:digest(canonical(contract)),contract,plan,
    next:'Review/apply the embedded standard site-change-plan; run declared cases and existing experiment/verify-optimization. No performance benefit is claimed.'};
}
export function strategyCoverage(plan,scenarios,business){
  const contract=plan?.metadata?.strategyContract;if(!contract)return {status:'not-assessed',pass:false};
  const spec=strategyContracts[contract.id];
  if(!spec||contract.version!==1||canonical(contract.cases)!==canonical(spec.cases))return {status:'invalid-contract',pass:false};
  if(spec.business)return {status:business?.outcome==='passed'?'passed':'not-assessed',pass:business?.outcome==='passed'&&spec.cases.every(id=>business.checks.some(c=>c.id===id&&c.pass))};
  const missing=spec.cases.filter(name=>!scenarios?.runs?.some(r=>r.name===name&&r.outcome==='passed'&&!r.constrained&&r.steps?.some(s=>s.action?.startsWith('assert-')&&s.outcome==='passed')));
  return {status:missing.length?'not-assessed':'passed',pass:missing.length===0,missing};
}
