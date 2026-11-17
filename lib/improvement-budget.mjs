import {createBudget} from './execution-policy.mjs';

const budgetError = reason => Object.assign(new Error(reason), {code:'SESSION_BUDGET'});

/** Tracks one step's time and attempts using the inherited session counters. */
export function createImprovementBudget(state) {
  const started = performance.now();
  const budget = createBudget({
    ...state.budget,
    maxWallTimeMs: Math.max(1, Math.floor(state.budget.maxWallTimeMs - state.elapsedMs)),
  }, {initialModelTokens: state.modelUsageTokens ?? 0});

  const elapsedMs = () => state.elapsedMs + Math.ceil(performance.now() - started);
  const usage = () => ({
    elapsedMs: elapsedMs(),
    ...(state.budget.maxModelTokens === undefined ? {} : {modelUsageTokens:budget.modelUsageTokens()}),
  });

  async function guard(checkpoint, countRounds = false) {
    const reason = state.elapsedMs >= state.budget.maxWallTimeMs ? 'wall-time-budget'
      : await budget.check({
        attempts: state.counts.attempted,
        failures: state.counts.failed,
        rounds: countRounds ? state.counts.rounds : 0,
      });
    await checkpoint();
    if (reason) throw budgetError(reason);
  }

  function requireAttempts(attempts) {
    const remaining = state.budget.maxAttempts - state.counts.attempted;
    if (attempts > remaining) throw budgetError('attempt-budget');
    return remaining;
  }

  function settleAttempts(reserved, used) {
    if (Number.isSafeInteger(used) && used >= 0 && used <= reserved) {
      state.counts.attempted -= reserved - used;
    }
  }

  function reserveAttempts(attempts) {
    state.counts.attempted += attempts;
  }

  function recordObservedAttempts(reserved, observed) {
    state.counts.attempted += Math.max(0, observed - reserved);
  }

  return {usage, elapsedMs, modelUsageTokens:budget.modelUsageTokens, remainingMs:budget.remainingMs,
    guard, requireAttempts, reserveAttempts, recordObservedAttempts, settleAttempts};
}
