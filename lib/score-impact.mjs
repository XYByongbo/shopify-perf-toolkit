import { Audit } from 'lighthouse/core/audits/audit.js';
import LCP from 'lighthouse/core/audits/metrics/largest-contentful-paint.js';
import FCP from 'lighthouse/core/audits/metrics/first-contentful-paint.js';
import TBT from 'lighthouse/core/audits/metrics/total-blocking-time.js';
import CLS from 'lighthouse/core/audits/metrics/cumulative-layout-shift.js';
import SI from 'lighthouse/core/audits/metrics/speed-index.js';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const pinnedVersion = require('lighthouse/package.json').version;
const definitions = [ ['FCP', 'first-contentful-paint', 10, FCP], ['LCP', 'largest-contentful-paint', 25, LCP],
  ['TBT', 'total-blocking-time', 30, TBT], ['CLS', 'cumulative-layout-shift', 25, CLS], ['SI', 'speed-index', 10, SI] ];
const round = n => Math.round(n * 1000) / 1000;
export function scoreLosses(report) {
  const refs = report.categories?.performance?.auditRefs;
  const weights = refs?.filter(r => r.weight > 0), total = weights?.reduce((s, r) => s + r.weight, 0);
  return definitions.map(([metric, id, weight]) => {
    const audit = report.audits?.[id];
    const share = total ? (weights.find(r => r.id === id)?.weight ?? 0) / total
      : report.lighthouseVersion === pinnedVersion ? weight / 100 : null;
    return { metric, id, value: audit?.numericValue ?? null, weight: share, score: audit?.score ?? null,
      lostPoints: share !== null && typeof audit?.score === 'number' ? round(100 * share * (1 - audit.score)) : null };
  }).sort((a, b) => (b.lostPoints ?? -1) - (a.lostPoints ?? -1));
}
export function estimateScoreImpact(report, savings = {}) {
  const losses = scoreLosses(report);
  const parts = losses.filter(loss => typeof savings[loss.metric] === 'number' && savings[loss.metric] > 0).map(loss => {
    const [, , , metricClass] = definitions.find(d => d[0] === loss.metric);
    const scoring = report.audits[loss.id]?.scoringOptions ?? (report.lighthouseVersion === pinnedVersion
      ? metricClass.defaultOptions?.[report.configSettings.formFactor]?.scoring : null);
    const next = Math.max(0, loss.value - savings[loss.metric]);
    // Never borrow scoring curves from a different Lighthouse release without reported scoringOptions.
    const estimatedPoints = scoring && loss.weight !== null && Number.isFinite(loss.value)
      ? round(Math.max(0, Audit.computeLogNormalScore(scoring, next) - loss.score) * 100 * loss.weight) : null;
    return { ...loss, estimatedPoints, estimatedMetricAfter: next };
  });
  return { estimatedPoints: parts.length && parts.every(p => p.estimatedPoints !== null)
    ? round(parts.reduce((sum, p) => sum + p.estimatedPoints, 0)) : null,
    affectedLostPoints: parts.length && parts.every(p => p.lostPoints !== null) ? round(parts.reduce((s, p) => s + p.lostPoints, 0)) : null,
    metrics: parts, basis: 'Reported metric savings through version-matched nonlinear score curves; hypotheses overlap and must not be summed across findings.' };
}
