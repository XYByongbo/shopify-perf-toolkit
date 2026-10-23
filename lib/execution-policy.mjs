import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

export const DEFAULT_BUDGET = Object.freeze({ maxWallTimeMs: 3600000, maxAttempts: 80, maxFailures: 10, maxCandidateRounds: 2 });
const fail = message => Object.assign(new Error(message), { code: 'INVALID_BUDGET' });
export function validateBudget(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw fail('budget must be an object.');
  const allowed = [...Object.keys(DEFAULT_BUDGET), 'maxModelTokens', 'modelUsageFile'];
  if (Object.keys(input).some(k => !allowed.includes(k))) throw fail('Unknown budget field.');
  const budget = { ...DEFAULT_BUDGET, ...input };
  for (const key of [...Object.keys(DEFAULT_BUDGET), ...(input.maxModelTokens === undefined ? [] : ['maxModelTokens'])]) {
    if (!Number.isSafeInteger(budget[key]) || budget[key] < 1) throw fail(`${key} must be a positive safe integer.`);
  }
  if ((input.maxModelTokens === undefined) !== (input.modelUsageFile === undefined)) throw fail('maxModelTokens and modelUsageFile must be supplied together.');
  if (input.modelUsageFile !== undefined && (typeof input.modelUsageFile !== 'string' || !path.isAbsolute(input.modelUsageFile)
    || /[\x00-\x1f\x7f]/.test(input.modelUsageFile))) throw fail('modelUsageFile must be an absolute path.');
  return budget;
}

/** The CLI cannot observe or bill model usage. A caller-supplied meter is fail-closed. */
export function createBudget(input, { now = () => performance.now(), initialModelTokens = 0 } = {}) {
  if (!Number.isSafeInteger(initialModelTokens) || initialModelTokens < 0) throw fail('initialModelTokens must be a nonnegative safe integer.');
  const limits = validateBudget(input), started = now(); let previousTokens = initialModelTokens;
  const remainingMs = () => Math.max(0, limits.maxWallTimeMs - (now() - started));
  async function check({ attempts = 0, failures = 0, rounds = 0, reserveMs = 0 } = {}) {
    if (remainingMs() <= reserveMs) return 'wall-time-budget';
    if (attempts >= limits.maxAttempts) return 'attempt-budget';
    if (failures >= limits.maxFailures) return 'failure-budget';
    if (rounds >= limits.maxCandidateRounds) return 'candidate-round-budget';
    if (limits.maxModelTokens !== undefined) {
      let meter;
      try {
        if((await stat(limits.modelUsageFile)).size>4096)return 'model-usage-invalid';
        meter = JSON.parse(await readFile(limits.modelUsageFile, 'utf8'));
      }
      catch { return 'model-usage-unavailable'; }
      if (!Number.isSafeInteger(meter.usedTokens) || meter.usedTokens < previousTokens) return 'model-usage-invalid';
      previousTokens = meter.usedTokens;
      if (previousTokens >= limits.maxModelTokens) return 'model-token-budget';
    }
    return null;
  }
  return { limits, remainingMs, check, elapsedMs: () => Math.max(0, now() - started),
    modelUsageTokens: () => previousTokens,
    modelMeter: limits.maxModelTokens === undefined ? 'not-configured-cli-does-not-invoke-models' : 'caller-reported-not-a-billing-measurement' };
}
