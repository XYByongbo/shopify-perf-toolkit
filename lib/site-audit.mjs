import path from 'node:path';
import { scanTheme } from './scan.mjs';
import { readRunEvidence } from './run-evidence.mjs';
import { scoreLosses, estimateScoreImpact } from './score-impact.mjs';
import { auditPerformance } from './performance-audit.mjs';
import { validateRenderedHTMLAudit } from './rendered-html.mjs';

const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const metrics = { performance: null, fcpMs: 'first-contentful-paint', lcpMs: 'largest-contentful-paint',
  cls: 'cumulative-layout-shift', tbtMs: 'total-blocking-time', speedIndexMs: 'speed-index' };
function stats(values) {
  const samples = values.filter(finite).sort((a, b) => a - b);
  const middle = Math.floor(samples.length / 2);
  return { n: samples.length, median: samples.length ? (samples.length % 2 ? samples[middle] : (samples[middle - 1] + samples[middle]) / 2) : null,
    min: samples[0] ?? null, max: samples.at(-1) ?? null };
}

function walk(value, callback) {
  if (!value || typeof value !== 'object') return;
  const pending = [value]; let visited = 0;
  while (pending.length && visited++ < 20000) {
    const item = pending.pop();
    if (!item || typeof item !== 'object') continue;
    callback(item);
    for (const child of Object.values(item)) if (child && typeof child === 'object') pending.push(child);
  }
}

function sourceCandidate(urlValue, pageUrl, fileMap) {
  let url, page;
  try { url = new URL(urlValue, pageUrl); page = new URL(pageUrl); } catch { return { status: 'unmapped', reason: 'Resource URL could not be parsed.' }; }
  // A matching filename on a third-party origin is never evidence of local identity.
  if (url.origin !== page.origin) return { status: 'unmapped', reason: 'External origin; a matching basename cannot identify local source.' };
  let basename;
  try { basename = decodeURIComponent(path.posix.basename(url.pathname)); } catch { return { status: 'unmapped', reason: 'Resource filename is not valid URL encoding.' }; }
  if (!basename || basename.includes('/') || basename.includes('\\') || !/(?:^|\/)assets\//.test(url.pathname)) return { status: 'unmapped', reason: 'No recognizable same-origin theme asset URL.' };
  const file = fileMap.get(`assets/${basename}`);
  if (!file) return { status: 'unmapped', reason: 'No corresponding local asset file was inventoried.' };
  return { status: 'candidate', file: file.path, sourceHash: file.sha256,
    reason: 'Same-origin assets URL and local basename match only; confirm theme identity, build transforms and deployed bytes before modifying.' };
}

/** Merge local static candidates with observed Lighthouse evidence; never applies fixes. */
export async function auditSite({ project, run, checks = null, officialChecks = null, resourceAnalysis = null, runtimeProfile = null, precheck = null, ownership=[], performanceBaseline=null, renderedHtml=[] } = {}) {
  if(!Array.isArray(renderedHtml)||renderedHtml.length>12)throw new Error('Site audit accepts at most 12 saved HTML audits.');
  renderedHtml.forEach(validateRenderedHTMLAudit);
  const evidence = await readRunEvidence(run, { allowPartial: true, allowExploration: true });
  const scan = await scanTheme({ project, pages: [...new Set(evidence.groups.map(group => group.url))] });
  const fileMap = new Map(scan.inventory.files.map(file => [file.path, file]));
  const associate = (url, pageUrl) => {
    const exact = runtimeProfile?.project === scan.project ? runtimeProfile.resources?.find(r => r.url === url && r.source?.status === 'verified-bytes'
      && r.source.sourceHash === fileMap.get(r.source.file)?.sha256 && r.bodyHash === r.source.sourceHash) : null;
    return exact ? exact.source : sourceCandidate(url, pageUrl, fileMap);
  };
  const supplemental = [];
  for(const report of renderedHtml)supplemental.push({kind:'rendered-html-audit',status:'unverified-source',report,
    note:'Saved rendered HTML findings are retained separately. Input fingerprints do not prove the current theme, deployment or performance; original verification remains required.'});
  for (const [kind, report] of [['check-import', checks], ['check-import', officialChecks], ['resource-audit', resourceAnalysis], ['theme-precheck', precheck]]) {
    if (!report) continue;
    if (report.kind !== kind || report.schemaVersion !== 1 || report.project !== scan.project || !Array.isArray(report.findings)) throw new Error('Supplemental report kind, schema or project mismatch.');
    const sources = kind !== 'resource-audit' ? report.findings.filter(f => f.file) : [...(report.scripts ?? []), ...(report.resources ?? []).flatMap(r => r.references ?? [])];
    const manifest = kind !== 'check-import' ? report.sourceManifest : Object.entries(report.metadata?.sourceHashes ?? {}).map(([file, sourceHash]) => ({ file, sourceHash }));
    const stale = [...sources, ...(manifest ?? [])].some(item => !item.sourceHash || item.sourceHash !== fileMap.get(item.file)?.sha256)
      || (kind !== 'check-import' && (!manifest || manifest.length !== fileMap.size));
    supplemental.push({ kind, status: stale ? 'stale' : report.complete ? 'current-source' : 'incomplete', report,
      note: 'Separate diagnostic evidence; not included in Lighthouse savings or performance scoring. Current-source refers only to available source fingerprints.' });
  }
  const findings = scan.candidates.map(finding => ({ ...finding, origin: 'source', priority: finding.priority ?? (['CMP03', 'CMP04'].includes(finding.ruleId) ? 'P1' : 'P2'),
    estimate: null, evidence: finding.evidence, verification: finding.verification }));
  const performance = await auditPerformance({ project, scan, checks, ownership, baseline:performanceBaseline, profiles: runtimeProfile?.profiles ?? (runtimeProfile?.kind === 'runtime-profile' ? [runtimeProfile] : []) });
  supplemental.push({ kind: 'performance-audit', status: performance.complete ? 'current-source' : 'incomplete', report: performance,
    note: 'Shopify P0 source/runtime candidates, separate from score savings. Missing runtime evidence is not a pass.' });
  const knownFindings = new Set(findings.map(f => f.id));
  findings.push(...performance.findings.filter(f => !knownFindings.has(f.id)).map(f => ({ ...f, origin: f.file ? 'source' : 'runtime', estimate: null })));
  const resources = [], groups = [], runtimeCandidates = new Map();
  for (const group of evidence.groups) {
    const groupMetrics = Object.fromEntries(Object.entries(metrics).map(([name, auditId]) => [name, stats(group.records.map(({ report }) => auditId === null
      ? report.categories.performance.score * 100 : report.audits[auditId]?.numericValue))]));
    const lcpElements = [], mainThread = [], thirdParties = [], warnings = [];
    const resourceMap = new Map();
    for (const record of group.records) {
      const { report } = record;
      if (report.runWarnings?.length) warnings.push({ report: record.relative, warnings: report.runWarnings });
      const addResource = (value, auditId, details = {}) => {
        if (typeof value !== 'string' || !/^https?:\/\//i.test(value)) return;
        let entry = resourceMap.get(value);
        if (!entry) { entry = { pageId: group.pageId, device: group.device, url: value, source: associate(value, group.url), evidence: [] }; resourceMap.set(value, entry); }
        entry.evidence.push({ report: record.relative, auditId, ...details });
      };
      for (const [auditId, audit] of Object.entries(report.audits)) {
        if (!audit || typeof audit !== 'object') continue;
        const urls = new Set();
        walk(audit.details, item => {
          if (typeof item.url === 'string') { urls.add(item.url); addResource(item.url, auditId, { transferSize: finite(item.transferSize) ? item.transferSize : null, resourceType: item.resourceType ?? null }); }
          if (/largest-contentful-paint-element|lcp-.*insight/.test(auditId) && (item.type === 'node' || item.selector || item.nodeLabel)) lcpElements.push({ report: record.relative, auditId, selector: item.selector ?? null, snippet: item.snippet ?? null, nodeLabel: item.nodeLabel ?? null });
        });
        if (/mainthread|main-thread|bootup-time/.test(auditId)) mainThread.push({ report: record.relative, auditId, numericValue: audit.numericValue ?? null, unit: audit.numericUnit ?? null, details: audit.details ?? null });
        if (/third-party|third-parties|thirdparty/.test(auditId)) thirdParties.push({ report: record.relative, auditId, details: audit.details ?? null });
        // Lighthouse metricSavings values have metric-specific units. Only known time metrics rank as milliseconds.
        // https://github.com/GoogleChrome/lighthouse/blob/main/types/lhr/audit-result.d.ts
        const savings = audit.metricSavings ?? {};
        const timeEstimates = [audit.details?.overallSavingsMs, ...['FCP', 'LCP', 'TBT', 'INP', 'TTI'].map(key => savings[key])].filter(finite);
        const milliseconds = timeEstimates.length ? Math.max(...timeEstimates) : null;
        const rowBytes = (Array.isArray(audit.details?.items) ? audit.details.items : []).map(item => item?.wastedBytes).filter(finite);
        const hasOverallBytes = finite(audit.details?.overallSavingsBytes);
        const bytes = hasOverallBytes ? audit.details.overallSavingsBytes : rowBytes.length ? Math.max(...rowBytes) : null;
        const actionable = finite(audit.score) && audit.score < 1 && !['error', 'notApplicable', 'manual', 'informative'].includes(audit.scoreDisplayMode)
          && (audit.details?.type === 'opportunity' || /-insight$/.test(auditId) || audit.scoreDisplayMode === 'metricSavings');
        if (!actionable) continue;
        const key = JSON.stringify([group.key, auditId]);
        let candidate = runtimeCandidates.get(key);
        if (!candidate) {
          candidate = { id: `lhr:${group.key}:${auditId}`, ruleId: auditId, status: 'observed', origin: 'lighthouse',
            pageId: group.pageId, device: group.device, priority: 'P2', line: null, file: null, sourceHash: null,
            summary: audit.title || auditId, explanation: audit.description ?? null, evidence: [], resourceUrls: [], verification: [
              'Confirm the reported resource and actual theme source before choosing an implementation.',
              'Compare the same page/device/state before and after; verify affected functionality and visual quality.',
              'Lighthouse opportunity estimates overlap and must not be added together or treated as guaranteed savings.',
            ], estimatesMs: [], estimatesBytes: [], scoreImpacts: [] };
          runtimeCandidates.set(key, candidate);
        }
        if (milliseconds !== null) candidate.estimatesMs.push(milliseconds);
        if (bytes !== null) candidate.estimatesBytes.push(bytes);
        candidate.scoreImpacts.push(estimateScoreImpact(report, audit.metricSavings));
        candidate.resourceUrls.push(...urls);
        candidate.evidence.push({ report: record.relative, reportHash: record.sha256, auditId, score: audit.score, displayValue: audit.displayValue ?? null,
          estimatedSavingsMs: milliseconds, estimatedSavingsBytes: bytes,
          byteEstimateBasis: hasOverallBytes ? 'reported-audit-overall' : rowBytes.length ? 'largest-reported-resource-row-not-total' : 'unavailable',
          metricSavings: audit.metricSavings ?? null });
      }
    }
    resources.push(...resourceMap.values());
    groups.push({ pageId: group.pageId, device: group.device, url: group.url, status: group.status, reports: group.records.map(record => record.relative),
      metrics: groupMetrics, scoreLosses: group.records.map(r => ({ report: r.relative, metrics: scoreLosses(r.report) })), lcpElements, mainThread, thirdParties, warnings });
  }
  for (const candidate of runtimeCandidates.values()) {
    candidate.estimate = { milliseconds: stats(candidate.estimatesMs), bytes: stats(candidate.estimatesBytes), basis: 'Median estimates across available reports. Bytes use reported audit total or the largest reported resource row when no total exists; inspect each evidence basis. Not additive or guaranteed.' };
    candidate.resourceUrls = [...new Set(candidate.resourceUrls)];
    const group = evidence.groups.find(item => item.pageId === candidate.pageId && item.device === candidate.device);
    candidate.sourceCandidates = candidate.resourceUrls.map(url => ({ url, ...associate(url, group.url) }));
    const local = [...new Set(candidate.sourceCandidates.filter(item => ['candidate', 'verified-bytes'].includes(item.status)).map(item => item.file))];
    if (local.length === 1 && candidate.sourceCandidates.every(item => ['candidate', 'verified-bytes'].includes(item.status))) {
      candidate.file = local[0]; candidate.sourceHash = fileMap.get(local[0]).sha256;
      candidate.sourceAssociation = candidate.sourceCandidates.every(item => item.status === 'verified-bytes') ? 'verified-bytes' : 'candidate-only';
    } else candidate.sourceAssociation = 'unmapped-or-ambiguous';
    candidate.priority = (candidate.estimate.milliseconds.median ?? 0) >= 100 || (candidate.estimate.bytes.median ?? 0) >= 100 * 1024 ? 'P1' : 'P2';
    candidate.scoreImpact = { estimatedPoints: stats(candidate.scoreImpacts.map(x => x.estimatedPoints)), affectedLostPoints: stats(candidate.scoreImpacts.map(x => x.affectedLostPoints)), samples: candidate.scoreImpacts };
    if ((candidate.scoreImpact.estimatedPoints.median ?? candidate.scoreImpact.affectedLostPoints.median ?? 0) >= 1) candidate.priority = 'P1';
    delete candidate.scoreImpacts;
    delete candidate.estimatesMs; delete candidate.estimatesBytes;
    findings.push(candidate);
  }
  findings.sort((a, b) => (b.scoreImpact?.estimatedPoints.median ?? b.scoreImpact?.affectedLostPoints.median ?? -1) - (a.scoreImpact?.estimatedPoints.median ?? a.scoreImpact?.affectedLostPoints.median ?? -1)
    || a.priority.localeCompare(b.priority)
    || (b.estimate?.milliseconds.median ?? -1) - (a.estimate?.milliseconds.median ?? -1)
    || (b.estimate?.bytes.median ?? -1) - (a.estimate?.bytes.median ?? -1) || a.id.localeCompare(b.id));
  const complete = evidence.complete && scan.complete;
  return { schemaVersion: 1, kind: 'site-audit', createdAt: new Date().toISOString(), project: scan.project, run: evidence.root,
    engine: evidence.manifest.engine, complete, outcome: complete ? 'review-required' : 'partial', findings, groups, resources, supplemental,
    priority: findings.map(finding => ({ id: finding.id, priority: finding.priority, ruleId: finding.ruleId, file: finding.file ?? null, estimate: finding.estimate, scoreImpact: finding.scoreImpact ?? null })),
    metrics: groups.map(group => ({ pageId: group.pageId, device: group.device, metrics: group.metrics })),
    evidence: { manifestHash: evidence.manifestHash, issues: evidence.issues, scanErrors: scan.errors, scanSkipped: scan.skipped },
    scan, limitations: [
      'Runtime findings describe the supplied Lighthouse reports; source findings remain static candidates, not confirmed root causes.',
      'Opportunity and insight savings estimates overlap, are not additive and do not guarantee actual improvement.',
      'Same-origin asset filename matches are source candidates only; third-party origins are never associated by basename.',
      'This audit does not run measurements, modify a theme, verify functional/visual equivalence, or establish field performance.',
      'Partial measurements and incomplete source scans retain their evidence gaps; missing values remain null.',
    ] };
}
