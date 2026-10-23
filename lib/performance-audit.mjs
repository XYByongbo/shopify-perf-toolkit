import { scanTheme } from './scan.mjs';
import { sourceSnapshot } from './runtime-profile.mjs';
import { inspectPerformanceRuntime, performanceRules } from './performance-rules.mjs';
import { auditStylesheets } from './stylesheet-audit.mjs';
import { p1ReviewBudgets } from './p1-performance-rules.mjs';

export async function auditPerformance({ project, scan: supplied, profiles = [] } = {}) {
  if (!Array.isArray(profiles) || profiles.length > 24) throw new Error('Provide at most 24 runtime profiles.');
  const scan = supplied ?? await scanTheme({ project });
  const snapshot = await sourceSnapshot(scan.project);
  const scanned = new Map(scan.inventory.files.map(f => [f.path, f.sha256]));
  if (snapshot.files.some(f => scanned.get(f.file) !== f.sourceHash)
    || scan.inventory.files.filter(f => /\.(?:liquid|m?js|css|json)$/.test(f.path)).length !== snapshot.files.length)
    throw new Error('Source drift between performance scan and snapshot.');
  const inventory = scan.performance ?? [], staticFindings = inventory.flatMap(i => i.findings);
  const runtime = inspectPerformanceRuntime({ profiles, snapshot, inventory });
  const issues = [...inventory.flatMap(i => i.issues), ...runtime.issues, ...snapshot.errors];
  let nativeStylesheets = null;
  if (inventory.some(i => i.nativeStylesheetCount > 0)) {
    nativeStylesheets = await auditStylesheets({ project: scan.project });
    if (nativeStylesheets.sourceHash !== snapshot.hash) throw new Error('Source drift during native stylesheet audit.');
    for (const f of nativeStylesheets.findings) staticFindings.push({
      ...f, id: `${f.file}:PERF_STYLESHEET_SCOPE:${f.line}:${f.className}`, ruleId: 'PERF_STYLESHEET_SCOPE',
      dimension: 'performance', priority: 'P1', evidence: [{ providers: f.providers, className: f.className,
        source: performanceRules.find(r => r.id === 'PERF_STYLESHEET_SCOPE').source }],
      verification: [f.recommendation, nativeStylesheets.dynamicSections.requirement],
    });
    issues.push(...nativeStylesheets.unresolved.map(i => ({ ...i, scope: 'native-stylesheet-subsetting' })));
  }
  // Follow literal head snippet references transitively; report candidates, not
  // actual template execution or an estimate of saved server time.
  for (const item of inventory) for (const ref of item.headReferences) {
    const queue = ref.snippet ? [`snippets/${ref.snippet}.liquid`] : [], visited = new Set();
    while (queue.length && visited.size < 1000) {
      const file = queue.shift(); if (visited.has(file)) continue; visited.add(file);
      if(scan.dependencies.some(e=>e.from===file&&['liquid-render','liquid-include'].includes(e.type)&&e.status!=='resolved'))
        issues.push({file,reason:'head-snippet-reachability-incomplete'});
      for (const edge of scan.dependencies.filter(e => e.from === file && e.status === 'resolved' && ['liquid-render', 'liquid-include'].includes(e.type))) queue.push(edge.to);
    }
    const costs = staticFindings.filter(f => visited.has(f.file) && /^PERF_LIQUID_/.test(f.ruleId));
    if (costs.length) staticFindings.push({
      id: `${item.file}:PERF_HEAD_LIQUID_COST:${ref.offset}`, ruleId: 'PERF_HEAD_LIQUID_COST',
      file: item.file, line: ref.line, offset: ref.offset, sourceHash: item.sourceHash,
      dimension: 'performance', status: 'candidate', priority: 'P1',
      summary: 'A snippet referenced before content_for_header contains catalog/data-access candidates.',
      evidence: [{ callees: costs.map(f => ({ file: f.file, line: f.line, ruleId: f.ruleId })) }],
      verification: ['Profile the actual head snippet path; static reachability is not proof of execution.', 'Verify streaming on a live storefront.'],
    });
    if (!ref.snippet || visited.size >= 1000) issues.push({ file: item.file, reason: 'head-snippet-reachability-incomplete' });
  }
  const findings = [...staticFindings, ...runtime.findings], complete = scan.complete && snapshot.complete && !issues.length;
  return { schemaVersion: 1, kind: 'performance-audit', project: scan.project, sourceHash: snapshot.hash,
    sourceManifest: snapshot.files, complete, reviewRequired: !complete || findings.length > 0,
    findings, issues, images: inventory.flatMap(i => i.images), styles:inventory.flatMap(i=>i.cssRules),
    resourceHints: inventory.flatMap(i => i.resourceHints ?? []), stylesheets: inventory.flatMap(i => i.stylesheets ?? []),
    fonts: inventory.flatMap(i => i.fonts ?? []), hiddenComponents: inventory.flatMap(i => i.hiddenComponents ?? []), nativeStylesheets,
    reviewBudgets: { ...p1ReviewBudgets, source: 'toolkit-review-triggers-not-Shopify-limits' },
    coverage: performanceRules.map(rule => ({ ...rule, static: rule.staticScope ?? 'candidate-analysis',
      runtime: !rule.runtimeSupported ? 'not-implemented-source-analysis-only' : !profiles.length ? 'not-assessed'
        : runtime.issues.length ? 'incomplete-see-issues' : 'supplied-profile-scope-only',
      findings: findings.filter(f => f.ruleId === rule.id).length })),
    limitations: ['Static findings and DOM class matches are candidates, not proven bottlenecks or source mappings.',
      'Runtime absence is not a pass. image_tag defaults, branches, responsive layouts and snippet parameters need rendered evidence.',
      'Head streaming changes require live-storefront validation; preview/editor measurements alone cannot establish this benefit.',
      'Automatic strategies cover explicitly documented narrow patterns; other cases require a reviewed replacement.'] };
}
