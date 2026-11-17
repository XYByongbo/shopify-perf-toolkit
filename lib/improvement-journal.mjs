import {transition} from './improvement-transitions.mjs';
import {open, link, rename, unlink, lstat, realpath} from 'node:fs/promises';
import path from 'node:path';
import {hostname} from 'node:os';
import {randomUUID} from 'node:crypto';
import {digest, readEvidenceJSON} from './evidence-contract.mjs';
import {hashSession, readImprovementSession, validateImprovementHistory} from './improvement-state.mjs';
import {sourceSnapshot} from './theme-source.mjs';

const fail = (code, message) => { throw Object.assign(new Error(message), {code}); };

// Publish complete bytes only. Exclusive publication also arbitrates concurrent recoveries.
export async function publishSessionJSON(file, value, {replace = false} = {}) {
  const temporary = path.join(path.dirname(file), `.session-${randomUUID()}.tmp`);
  const handle = await open(temporary, 'wx', 0o600);
  try {
    try {
      await handle.writeFile(JSON.stringify(value, null, 2) + '\n');
      await handle.sync();
    } finally { await handle.close(); }
    if (replace) await rename(temporary, file);
    else await link(temporary, file);
    const directory = await open(path.dirname(file), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}

const continuationFile = previous => path.join(path.dirname(previous), 'next-step.json');
const continuationExists = file => fail('EEXIST', `Session already has a continuation: ${file}. Use its completed session.json, or action=recover with the recorded output after its process exits.`);

export async function reserveImprovementContinuation(previous, requested, value) {
  const canonical = continuationFile(previous), legacy = continuationFile(requested);
  if (legacy !== canonical) {
    const existing = await lstat(legacy).catch(error => { if (error.code !== 'ENOENT') throw error; });
    if (existing) continuationExists(legacy);
  }
  try { await publishSessionJSON(canonical, value); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    continuationExists(canonical);
  }
}

export function createImprovementJournal(output, state, usage) {
  const owner = {host: hostname(), pid: process.pid};
  let phase = 'read-only';
  return async (nextPhase = phase) => {
    phase = nextPhase;
    const saved = structuredClone(state);
    Object.assign(saved, usage());
    saved.sessionHash = hashSession(saved);
    const body = {version: 1, kind: 'improvement-checkpoint', owner, phase,
      recordedAt: new Date().toISOString(), state: saved};
    await publishSessionJSON(path.join(output, 'checkpoint.json'), {...body, hash: digest(body)}, {replace: true});
  };
}

function requireExitedOwner(owner) {
  if (owner?.host !== hostname() || !Number.isSafeInteger(owner.pid) || owner.pid <= 0)
    fail('RECOVERY_OWNER_UNKNOWN', 'Recovery requires the original host and a recorded process owner.');
  try { process.kill(owner.pid, 0); }
  catch (error) {
    if (error.code === 'ESRCH') return;
    fail('RECOVERY_OWNER_UNKNOWN', 'Cannot establish that the original process exited.');
  }
  fail('SESSION_STILL_RUNNING', 'The original process is still alive; do not recover or remove its continuation lock.');
}

/** Seal an interrupted step in its original directory, without executing any theme operation. */
export async function recoverImprovement({config, output: requestedOutput}) {
  const parent = await readImprovementSession(config.previous);
  let previous = path.join(parent.output, 'session.json');
  const continuation = await readEvidenceJSON(continuationFile(previous)).catch(error => {
    if (error.code !== 'ENOENT' || continuationFile(config.previous) === continuationFile(previous)) throw error;
    previous = path.resolve(config.previous);
    return readEvidenceJSON(continuationFile(previous));
  });
  if (typeof requestedOutput !== 'string' || !requestedOutput || path.resolve(requestedOutput) !== continuation.output)
    fail('RECOVERY_OUTPUT_MISMATCH', 'Use the interrupted output directory recorded in next-step.json.');
  const output = continuation.output;
  if (!(await lstat(output)).isDirectory() || await realpath(requestedOutput) !== output)
    fail('RECOVERY_OUTPUT_MISMATCH', 'Recovery requires the original real output directory.');
  const finalFile = path.join(output, 'session.json');
  try {
    await lstat(finalFile);
    const completed = await readImprovementSession(finalFile);
    if (completed.previous !== previous || completed.action !== continuation.action) fail('RECOVERY_PARENT_MISMATCH', 'Completed step does not match the recorded continuation.');
    return completed;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  let checkpoint;
  try { checkpoint = await readEvidenceJSON(path.join(output, 'checkpoint.json')); }
  catch (error) {
    if (error.code === 'ENOENT') fail('RECOVERY_CHECKPOINT_MISSING', 'This step has no durable checkpoint (possibly an older toolkit). Inspect its intent/receipts and restore source manually; do not delete next-step.json.');
    throw error;
  }
  const {hash, ...body} = checkpoint;
  const state = checkpoint.state;
  if (hash !== digest(body) || checkpoint.version !== 1 || checkpoint.kind !== 'improvement-checkpoint'
      || !state || state.sessionHash !== hashSession(state) || state.previous !== previous
      || state.parentHash !== parent.sessionHash || state.id !== parent.id || state.step !== parent.step + 1
      || state.output !== output || state.action !== continuation.action || state.project !== parent.project
      || !Number.isFinite(Date.parse(checkpoint.recordedAt)))
    fail('INVALID_RECOVERY_CHECKPOINT', 'Interrupted checkpoint does not match its parent and continuation.');
  requireExitedOwner(checkpoint.owner);
  const phase = checkpoint.phase;
  if (!['read-only','apply','rollback','sync','experiment','collect','verify','reprofile'].includes(phase))
    fail('INVALID_RECOVERY_CHECKPOINT', 'Unknown interrupted operation.');
  const requiresRollback = Boolean(state.interruption?.requiresRollback)
    || Boolean(state.active) && ['apply','rollback','sync','experiment','collect','verify'].includes(phase);
  // The exact crash time is unknown. Charge elapsed wall time conservatively, including downtime.
  state.elapsedMs = Math.max(state.elapsedMs, Math.min(state.budget.maxWallTimeMs,
    state.elapsedMs + Math.max(0, Date.now() - Date.parse(checkpoint.recordedAt))));
  if (['experiment','collect','verify','reprofile'].includes(phase)) state.counts.failed++;
  if (requiresRollback && ['experiment','collect','verify'].includes(phase)
      && !state.history.some(h => h.interruptedOutput === output)) {
    state.history.push({...state.active, baselineHash: state.baselineHash, outcome: 'interrupted',
      interruptedOutput: output, phase});
  }
  let source;
  try {
    const current = await sourceSnapshot(state.project);
    source = {hash: current.hash, complete: current.complete,
      matchesExpected: current.complete && current.hash === (state.active?.sourceHash ?? state.baselineHash)};
  } catch (error) { source = {complete: false, error: error.message}; }
  transition(state, 'interrupted', {phase, requiresRollback, recoveredAt: new Date().toISOString(), source,
    checkpointHash: hash, budgetAccounting: 'reserved attempts retained; elapsed wall time includes unknown downtime'});
  state.updatedAt = new Date().toISOString();
  state.sessionHash = hashSession(state);
  await validateImprovementHistory(state);
  try { await publishSessionJSON(finalFile, state); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  return readImprovementSession(finalFile);
}
