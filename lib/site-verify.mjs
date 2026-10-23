import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readRunEvidence, normalizeEvidenceUrl } from './run-evidence.mjs';
import { evaluateGain } from './performance-gain.mjs';

const scorer = fileURLToPath(new URL('../scripts/check_score_target.py', import.meta.url));
const limitations = [
  'A passing result means only that every declared page/device group met the supplied laboratory score targets in these runs.',
  'Functional behavior, visual quality, transactions, field Core Web Vitals, causality and future performance are not established by score targets.',
  'Only preview_theme_id is ignored in URL comparisons; verify actual theme identity, content, consent, App state, region, cache and machine load separately.',
];

function thresholdOptions(thresholds) {
  if (thresholds === undefined) return {};
  if (!thresholds || typeof thresholds !== 'object' || Array.isArray(thresholds)) throw new Error('thresholds must be an object.');
  const keys = Object.keys(thresholds);
  if (keys.some(key => !['minimum', 'target', 'mobile', 'desktop'].includes(key))) throw new Error('Unknown threshold field.');
  const perDevice = keys.some(key => ['mobile', 'desktop'].includes(key));
  if (perDevice && keys.some(key => ['minimum', 'target'].includes(key))) throw new Error('Do not mix global and device-specific thresholds.');
  const validate = value => {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['minimum', 'target'].includes(key))) throw new Error('Each device threshold must contain only minimum and/or target.');
    for (const score of Object.values(value)) if (typeof score !== 'number' || !Number.isFinite(score) || score < 0 || score > 100) throw new Error('Thresholds must be finite scores from 0 to 100.');
  };
  if (perDevice) for (const value of Object.values(thresholds)) validate(value);
  else validate(thresholds);
  return perDevice ? thresholds : { mobile: thresholds, desktop: thresholds };
}

/** Compare complete run matrices by delegating every score decision to the existing scorer. */
export async function verifySite({ before, after, thresholds } = {}) {
  const result = { schemaVersion: 1, kind: 'site-verification', createdAt: new Date().toISOString(),
    before: before ?? null, after: after ?? null, outcome: 'invalid-evidence', checks: [], groups: [], limitations: [...limitations] };
  try {
    const options = thresholdOptions(thresholds);
    const left = await readRunEvidence(before);
    const right = await readRunEvidence(after);
    result.before = left.root; result.after = right.root;
    result.evidence = { beforeManifestHash: left.manifestHash, afterManifestHash: right.manifestHash };
    if (left.manifest.engine !== right.manifest.engine) throw new Error('Measurement engines differ; Lighthouse and PSI runs cannot be mixed.');
    const rightGroups = new Map(right.groups.map(group => [group.key, group]));
    if (left.groups.length !== right.groups.length || left.groups.some(group => !rightGroups.has(group.key))) throw new Error('Page/device matrices differ between runs. Every group must be present in both.');
    for (const group of left.groups) if (normalizeEvidenceUrl(group.url) !== normalizeEvidenceUrl(rightGroups.get(group.key).url)) throw new Error(`Page URL differs for ${group.pageId}/${group.device}.`);
    result.engine = left.manifest.engine;
    for (const group of left.groups) {
      const candidate = rightGroups.get(group.key);
      const args = ['-B', scorer, '--before', group.directory, '--after', candidate.directory];
      for (const [name, score] of Object.entries(options[group.device] ?? {})) args.push(`--${name}`, String(score));
      const execution = spawnSync(process.env.PERF_KIT_PYTHON || 'python3', args,
        { encoding: 'utf8', timeout: 30000, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
      let decision;
      try { decision = JSON.parse(execution.stdout); } catch { /* Preserve failure diagnostics below. */ }
      const valid = !execution.error && [0, 3].includes(execution.status) && decision?.schema_version === 1
        && decision.scope === 'navigation_lab_score_target_only' && decision.device === group.device
        && ['passed', 'failed', 'review-required'].includes(decision.status)
        && (execution.status === 0 ? decision.status === 'passed' && decision.score_target_met === true : decision.score_target_met === false && decision.status !== 'passed');
      const status = !valid ? 'invalid' : decision.status === 'passed' ? 'pass' : decision.status === 'failed' ? 'fail' : 'review';
      const entry = { id: `score:${group.key}`, pageId: group.pageId, device: group.device, url: group.url, status,
        message: valid ? `${group.pageId}/${group.device}: ${decision.status}` : (execution.error?.message || execution.stderr?.trim() || 'Score evaluator returned an invalid result.'),
        details: valid ? decision : { exitCode: execution.status, code: execution.error?.code ?? null } };
      result.checks.push(entry);
      result.groups.push({ pageId: group.pageId, device: group.device, status, beforeReports: group.reports, afterReports: candidate.reports });
    }
    result.outcome = result.checks.some(check => check.status === 'invalid') ? 'invalid-evidence'
      : result.checks.some(check => check.status === 'fail') ? 'targets-not-met'
      : result.checks.some(check => check.status === 'review') ? 'review-required' : 'score-targets-met';
    result.scoreTargetOutcome = result.outcome;
    if (['score-targets-met', 'targets-not-met'].includes(result.outcome)) {
      result.performanceChange = await evaluateGain({ before, after });
      if (result.performanceChange.outcome === 'performance-regressed') result.outcome = 'performance-regressed';
      else if (result.performanceChange.outcome === 'invalid-evidence') result.outcome = 'invalid-evidence';
    }
    result.optimization = 'not-established-without-deployment-and-regression-evidence';
  } catch (error) {
    result.checks.push({ id: 'run-evidence', status: 'invalid', message: error.message, details: { code: error.code ?? 'INVALID_RUN_EVIDENCE' } });
  }
  result.summary = { groups: result.groups.length, passed: result.checks.filter(check => check.status === 'pass').length,
    failed: result.checks.filter(check => check.status === 'fail').length, reviewRequired: result.checks.filter(check => check.status === 'review').length,
    invalid: result.checks.filter(check => check.status === 'invalid').length };
  return result;
}
