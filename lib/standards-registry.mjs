import {readFileSync} from 'node:fs';
import {sha256} from './source-utils.mjs';

// Pinned reference metadata, not an enabled acceptance policy or detector coverage claim.
const bytes=readFileSync(new URL('../assets/standards/registry-v1.json',import.meta.url));
const registry=JSON.parse(bytes);
const mappings={
  PERF_IMAGE_PRIORITY_COUNT:['PERF-IMG-03'],
  PERF_IMAGE_SIZES_MISMATCH:['PERF-IMG-08'],
  PERF_HIDDEN_IMAGE_DOWNLOAD:['PERF-IMG-09','PERF-MOB-01'],
  PERF_IMAGE_DIMENSIONS:['PERF-IMG-10'],
  PERF_DUPLICATE_STYLESHEET:['PERF-CSS-04'],
  PERF_HEAD_BLOCKING_SCRIPT:['PERF-JS-01'],
  PERF_MOBILE_OVERFLOW:['PERF-MOB-03'],
  PERF_VIEWPORT_META:['PERF-MOB-06'],
  PERF_IMAGE_TAG_LOADING:['PERF-IMG-02','PERF-IMG-03'],
  PERF_IMAGE_TAG_SIZES:['PERF-IMG-08'],
  PERF_DUAL_HERO:['PERF-IMG-09','PERF-MOB-01'],
  PERF_HEAD_RESOURCE_ORDER:['PERF-CSS-02'],
  PERF_HEAD_LIQUID_COST:['PERF-CSS-02','PERF-LQD-01'],
  PERF_LIQUID_NESTED_LOOP:['PERF-LQD-07'],
  PERF_LIQUID_METAFIELD:['PERF-LQD-06'],
  PERF_LIQUID_OVERFETCH:['PERF-LQD-01','PERF-LQD-05'],
  PERF_LIQUID_RENDER_LOOP:['PERF-LQD-07'],
  PERF_LCP_REVEAL:['PERF-IMG-04'],
  PERF_LCP_BACKGROUND:['PERF-IMG-01'],
  PERF_PRELOAD_BUDGET:['PERF-IMG-11'],
  PERF_PRECONNECT:['PERF-NET-03'],
  PERF_STYLESHEET_COUNT:['PERF-CSS-04'],
  PERF_ASYNC_CSS:['PERF-CSS-01'],
  PERF_STYLESHEET_SCOPE:['PERF-CSS-03'],
  PERF_FONT_DELIVERY:['PERF-CSS-07'],
  PERF_FONT_DISPLAY:['PERF-CSS-07'],
  PERF_FONT_FALLBACK:['PERF-CSS-08'],
  PERF_LAYOUT_ANIMATION:['PERF-CLS-04'],
  PERF_JS_DOM_READY_FETCH:['PERF-JS-11'],
  PERF_JS_PASSIVE_LISTENER:['PERF-JS-05'],
  PERF_JS_VIEW_TRANSITION:['PERF-JS-12'],
  PERF_JS_MODULE_SHIMS:['PERF-JS-10','PERF-NET-04'],
  PERF_HIDDEN_DOM:['PERF-LQD-03','PERF-LQD-04'],
  PERF_DIALOG_LCP:['PERF-IMG-12'],
  PERF_LIQUID_FETCH_LIMIT:['PERF-LQD-01'],
  PERF_LCP_IDENTITY:['GOV-09','MEA-08'],
  PERF_LCP_EXPECTED_TARGET:['PERF-IMG-12','MEA-08'],
  PERF_REPEAT_RESOURCE_REQUEST:['PERF-CSS-04','PERF-3P-01'],
  PERF_REPEAT_INIT_EVENT:['PERF-JS-04','PERF-JS-13'],
};
const ids=new Set(registry.rules.map(r=>r.id));
if(registry.schemaVersion!==1||ids.size!==registry.rules.length||Object.values(mappings).flat().some(id=>!ids.has(id)))
  throw new Error('Invalid bundled standards registry or rule mapping.');

export const standardsReference=Object.freeze({id:registry.id,version:registry.version,date:registry.date,
  status:registry.status,enforcement:registry.enforcement,sha256:sha256(bytes),mappingVersion:2});

export function withStandardRules(value) {
  return {...value,standardRuleIds:[...(mappings[value.ruleId??value.id]??[])]};
}

/** Returns a fresh catalog; consumers cannot mutate the shared reference. */
export function standardsCatalog() {
  return {...structuredClone(registry),reference:{...standardsReference},rules:registry.rules.map(rule=>({
    ...structuredClone(rule),relatedInternalRules:Object.entries(mappings).filter(([,refs])=>refs.includes(rule.id)).map(([id])=>id),
    assessment:'not-assessed',mappingMeaning:'related-candidate-checks-not-complete-rule-validation',
  }))};
}
