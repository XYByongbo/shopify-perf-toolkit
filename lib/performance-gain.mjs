import { readRunEvidence, normalizeEvidenceUrl } from './run-evidence.mjs';
import { validateLhrReport, canonicalFetchTime } from './lhr-contract.mjs';
import { median } from './summary.mjs';
import { goalContract,digest } from './evidence-contract.mjs';

const metrics = {
  score: { id: null, floor: 3, direction: 1 },
  lcp: { id: 'largest-contentful-paint', floor: 200, direction: -1 },
  tbt: { id: 'total-blocking-time', floor: 50, direction: -1 },
  cls: { id: 'cumulative-layout-shift', floor: 0.02, direction: -1 },
  fcp: { id: 'first-contentful-paint', floor: 100, direction: -1 },
  speedIndex: { id: 'speed-index', floor: 200, direction: -1 },
};
export const gainFloors = Object.freeze(Object.fromEntries(Object.entries(metrics).map(([key,spec])=>[key,spec.floor])));
export const reportSetHash = evidence => digest(evidence.groups.map(g=>[g.key,g.records.map(r=>[r.relative,r.sha256])]));
const rounded = n => Math.round(n * 1e6) / 1e6;
const values = (group, id) => group.records.map(({ report }) => id ? report.audits[id].numericValue : report.categories.performance.score * 100);
function distribution(samples) {
  const center = median(samples);
  return { n: samples.length, median: center, min: Math.min(...samples), max: Math.max(...samples),
    mad: median(samples.map(x => Math.abs(x - center))) };
}

/** Independent gain evidence. Threshold acceptance, deployment identity and behavior are separate gates. */
export async function evaluateGain({ before, after, allowExploration = false, policy = {}, goal, scoreDiagnosticOnly = false } = {}) {
  const target = goalContract(goal);
  if(typeof scoreDiagnosticOnly!=='boolean'||scoreDiagnosticOnly&&target.kind==='score')throw new Error('Metric acceptance requires an explicit loading goal.');
  if (target.kind === 'interaction') throw new Error('Interaction gain requires independent interaction evidence; use verify-interactions.');
  const defaults = gainFloors;
  if (!policy || typeof policy !== 'object' || Array.isArray(policy) || Object.keys(policy).some(k => !Object.hasOwn(defaults, k))
      || Object.values(policy).some(v => typeof v !== 'number' || !Number.isFinite(v) || v < 0)) throw new Error('Gain policy accepts only nonnegative score/lcp/tbt/cls/fcp/speedIndex floors.');
  const floors = { ...defaults, ...policy };
  const result = { schemaVersion: 1, kind: 'performance-gain', outcome: 'invalid-evidence', groups: [], policy: floors, goal: target, scoreDiagnosticOnly,
    limitations: ['MAD noise bands are conservative decision rules, not statistical confidence intervals or proof of causality.',
      'Real-user INP and functional/visual equivalence require separate evidence.'] };
  try {
    const a = await readRunEvidence(before, { allowExploration }), b = await readRunEvidence(after, { allowExploration });
    result.evidence = { beforeManifestHash: a.manifestHash, afterManifestHash: b.manifestHash,
      beforeReportsHash:reportSetHash(a),afterReportsHash:reportSetHash(b) };
    if (a.manifest.engine !== b.manifest.engine || a.groups.length !== b.groups.length) throw new Error('Gain comparison requires identical engines and page/device matrices.');
    const lookup = new Map(b.groups.map(g => [g.key, g]));
    const times = new Set(a.groups.flatMap(g => g.records.map(x => canonicalFetchTime(x.report.fetchTime))));
    for (const left of a.groups) {
      const right = lookup.get(left.key);
      if (!right || normalizeEvidenceUrl(left.url) !== normalizeEvidenceUrl(right.url)) throw new Error('Gain page/device/URL mismatch.');
      if (left.records.length < 3 || right.records.length < 3) throw new Error('Gain decisions require at least three independent samples per side.');
      const lhr = left.records[0].report, rhr = right.records[0].report;
      if (lhr.lighthouseVersion !== rhr.lighthouseVersion || validateLhrReport(lhr, { url: left.url, device: left.device }).profileSha256
          !== validateLhrReport(rhr, { url: right.url, device: right.device }).profileSha256) throw new Error('Gain environments differ.');
      if ([...left.records, ...right.records].some(x => x.report.runWarnings?.length || x.report.configSettings.throttlingMethod === 'provided')) throw new Error('Warnings or uncontrolled throttling require review.');
      for (const x of right.records) {
        const time = canonicalFetchTime(x.report.fetchTime);
        if (times.has(time)) throw new Error('Gain samples reuse a timestamp.');
        times.add(time);
      }
      const comparison = {};
      for (const [key, spec] of Object.entries(metrics)) {
        const base = distribution(values(left, spec.id)), candidate = distribution(values(right, spec.id));
        const gain = rounded((candidate.median - base.median) * spec.direction);
        // Check both distributions: noisy candidate runs must not manufacture a positive verdict.
        const noise = 3 * Math.max(base.mad, candidate.mad), floor = Math.max(floors[key], noise);
        comparison[key] = { before: base, after: candidate, gain, noiseBand: noise, floor,
          improved: gain > 0 && gain >= floor, regressed: gain < 0 && -gain >= floor };
      }
      result.groups.push({ pageId: left.pageId, device: left.device, metrics: comparison,
        improved: comparison[target.metric].improved, regressed: Object.entries(comparison).some(([key,x]) => (!scoreDiagnosticOnly||key!=='score')&&x.regressed) });
    }
    result.outcome = result.groups.some(g => g.regressed) ? 'performance-regressed'
      : result.groups.some(g => g.improved) ? 'measurable-gain' : 'no-measurable-gain';
  } catch (error) { result.error = error.message; }
  return result;
}
