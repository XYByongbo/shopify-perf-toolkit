import { advancedStrategies } from './advanced-strategies.mjs';
import { performanceStrategies } from './performance-strategies.mjs';
import { p1PerformanceStrategies } from './p1-performance-strategies.mjs';
export const codeStrategies = [
  ...performanceStrategies,
  ...p1PerformanceStrategies,
  ...advancedStrategies,
  { kind: 'js-raf-listener', targets: 'assets/*.js or *.mjs', parameters: ['registrationStart'],
    evidenceRequired: ['sourceHash', 'summary', 'timingChangeReviewed', 'listenerLifecycleOwned', 'handlerReadsLatestState'],
    effect: 'Coalesce window scroll/resize callbacks into one animation-frame update; cancel pending work at matching removal.',
    boundary: 'One top-level registration of a local synchronous zero-argument handler; no callback aliases, shadowing, event/this dependence, once or signal.',
    verification: ['Confirm latest-state updates may run once per frame instead of once per event.', 'Check first event, repeated events, teardown and re-registration.'] },
  { kind: 'css-dedupe-declarations', targets: 'assets/*.css', parameters: [],
    evidenceRequired: ['sourceHash', 'summary', 'cssomIndependent'],
    effect: 'Remove only adjacent byte-identical ordinary declarations inside style rules; retain the last declaration.',
    boundary: 'No custom properties, fallback rewrites, rule merging or reordering; CSSOM enumeration must not be relied on.',
    verification: ['Compare computed styles and affected layouts; byte reduction does not imply a score gain.'] },
  { kind: 'css-offscreen-rendering', targets: 'assets/*.css', parameters: ['selector', 'intrinsicBlockSize'],
    evidenceRequired: ['sourceHash', 'summary', 'offscreen', 'nonLcp', 'containmentReviewed'],
    effect: 'Add content-visibility:auto and an explicit intrinsic block size to one selected top-level class rule.',
    boundary: 'Opt-in runtime evidence and an existing display:flow-root boundary required; no existing containment declarations, positioned rule, nested rule or global selector.',
    verification: ['Check all relevant breakpoints, margin collapsing, scrolling, focus, find-in-page, sticky/positioned descendants and CLS.', 'Record measured intrinsic size and confirm the target is not initial LCP. Source checks do not prove effective computed styles.'] },
  { kind: 'liquid-limit-guarded-loop', targets: 'Liquid theme files', parameters: ['loopStart'],
    evidenceRequired: ['sourceHash', 'summary', 'loopScopeReviewed'],
    effect: 'Replace a fully whitespace-trimmed for/if forloop.index <= N guard with limit:N; preserve emitted items.',
    boundary: 'Simple collection path, literal N=1..50, only output expressions inside the guard, no loop metadata except index/index0/first.',
    verification: ['Compare empty, short and long collections, rendered markup and surrounding variable scope.', 'Local rendering tests cover the supported subset, not every Shopify extension.'] },
];
export const codeStrategyKinds = new Set(codeStrategies.map(item => item.kind));
