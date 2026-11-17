import { readRunEvidence, normalizeEvidenceUrl } from './run-evidence.mjs';
import { validateLhrReport, canonicalFetchTime } from './lhr-contract.mjs';
import path from 'node:path';
import { median } from './summary.mjs';

const defaults = { patience: 2, minimumScoreGain: 3, minimumLcpGainMs: 200, noiseMultiplier: 1 };
export function validateEarlyStop(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => !Object.hasOwn(defaults,k))) throw new Error('Invalid earlyStop policy.');
  const p = { ...defaults, ...input };
  if (!Number.isSafeInteger(p.patience) || p.patience < 1) throw new Error('patience must be a positive integer.');
  for (const k of ['minimumScoreGain','minimumLcpGainMs','noiseMultiplier']) if (typeof p[k] !== 'number' || !Number.isFinite(p[k]) || p[k] < 0) throw new Error(`${k} must be finite and nonnegative.`);
  return p;
}
const range = v => Math.max(...v)-Math.min(...v);
export function validateIterationConfig(input = {}) {
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!['rounds','earlyStop','maxCandidateRounds'].includes(k)))throw new Error('Unknown iteration config fields.');
  const { rounds = [], earlyStop, maxCandidateRounds = 2 } = input;
  const policy = validateEarlyStop(earlyStop);
  if (!Array.isArray(rounds) || !Number.isSafeInteger(maxCandidateRounds) || maxCandidateRounds < 1) throw new Error('Invalid candidate history.');
  return {rounds, maxCandidateRounds, policy};
}

export async function evaluateIterations(input = {}) {
  const {rounds, maxCandidateRounds, policy} = validateIterationConfig(input);
  const result = { schemaVersion: 1, kind: 'iteration-decision', policy, rounds: [], stop: false, decision: 'continue',
    acceptance: 'not-evaluated', limitations: ['Exploratory gain is not acceptance or proof of causality.', 'History must contain every candidate in order; do not omit low/negative results.'] };
  let low = 0;
  for (const pair of rounds) {
    if (!pair || Object.keys(pair).some(k => !['before','after'].includes(k)) || typeof pair.before !== 'string' || typeof pair.after !== 'string' || !path.isAbsolute(pair.before) || !path.isAbsolute(pair.after)) throw new Error('Each round needs only before and after run paths.');
    const entry = { ...pair, groups: [] }; result.rounds.push(entry);
    if (result.rounds.length > maxCandidateRounds) { entry.outcome = 'not-assessed-round-budget'; result.stop = true; if(result.decision==='continue')result.decision='stop-candidate-budget'; continue; }
    try {
      const left = await readRunEvidence(pair.before, { allowExploration: true });
      const right = await readRunEvidence(pair.after, { allowExploration: true });
      if (left.manifest.engine !== right.manifest.engine || right.groups.length > left.groups.length) throw new Error('Candidate engines or matrices differ.');
      const lookup = new Map(left.groups.map(g => [g.key,g]));
      entry.scope = { assessedGroups: right.groups.length, baselineGroups: left.groups.length, acceptance: 'not-evaluated' };
      const times = new Set(left.groups.flatMap(g => g.records.map(x => canonicalFetchTime(x.report.fetchTime))));
      let improved = false, regression = false;
      for (const h of right.groups) {
        const g = lookup.get(h.key);
        if (!g || normalizeEvidenceUrl(g.url) !== normalizeEvidenceUrl(h.url)) throw new Error('Candidate page/device matrices differ.');
        for (const x of [...g.records,...h.records]) if (x.report.runWarnings?.length) throw new Error('Warnings require review, not a gain decision.');
        if (g.records.length < 3 || h.records.length < 3) throw new Error('Gain assessment needs at least three independent samples on each side per assessed group.');
        const l = g.records.map(x => validateLhrReport(x.report,{ url:g.url,device:g.device }));
        const r = h.records.map(x => validateLhrReport(x.report,{ url:h.url,device:h.device }));
        if (g.records[0].report.lighthouseVersion !== h.records[0].report.lighthouseVersion || l[0].profileSha256 !== r[0].profileSha256) throw new Error('Candidate environments differ.');
        for (const x of r) {
          if (times.has(x.timestampKey)) throw new Error('Candidate reuses a report timestamp.');
          times.add(x.timestampKey);
        }
        const scores = group => group.records.map(x => x.report.categories.performance.score*100);
        const lcps = group => group.records.map(x => x.report.audits['largest-contentful-paint'].numericValue);
        const scoreGain = Math.round((median(scores(h))-median(scores(g)))*1000000)/1000000, lcpGainMs = median(lcps(g))-median(lcps(h));
        const scoreFloor = Math.max(policy.minimumScoreGain, range(scores(g))*policy.noiseMultiplier);
        const lcpFloorMs = Math.max(policy.minimumLcpGainMs, range(lcps(g))*policy.noiseMultiplier);
        const gain = (scoreGain >= scoreFloor && scoreGain > 0) || (lcpGainMs >= lcpFloorMs && lcpGainMs > 0);
        const metricRegression = {};
        for (const [id, minimum] of [['total-blocking-time',50],['cumulative-layout-shift',0.02],['first-contentful-paint',100],['speed-index',200]]) {
          const left = g.records.map(x=>x.report.audits[id].numericValue), right = h.records.map(x=>x.report.audits[id].numericValue);
          const increase = median(right)-median(left), floor = Math.max(minimum,range(left)*policy.noiseMultiplier);
          metricRegression[id] = { increase, floor, regressed: increase > 0 && increase >= floor };
        }
        const worse = scoreGain < -scoreFloor || lcpGainMs < -lcpFloorMs || Object.values(metricRegression).some(x=>x.regressed);
        entry.groups.push({ pageId:g.pageId,device:g.device,scoreGain,lcpGainMs,scoreFloor,lcpFloorMs,metricRegression,meaningfulGain:gain,regression:worse });
        improved ||= gain; regression ||= worse;
      }
      entry.outcome = regression ? 'regression-review' : improved ? 'meaningful-gain' : 'low-gain';
      low = entry.outcome === 'low-gain' ? low+1 : 0;
      if (regression) { result.stop = true; result.decision = 'stop-regression-review'; }
    } catch (error) { entry.outcome = 'review-required'; entry.error = error.message; result.stop = true; result.decision = 'stop-evidence-review'; }
    if (!result.stop && low >= policy.patience) { result.stop = true; result.decision = 'stop-low-gain'; }
    if (!result.stop && result.rounds.length >= maxCandidateRounds) { result.stop = true; result.decision = 'stop-candidate-budget'; }
    // Retain all supplied rounds; no cherry-picking, even after a stop decision.
  }
  return result;
}
