import {fingerprintThemeFile} from './source-reader.mjs';
import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {sha256 as hash} from './source-utils.mjs';
import {readTarget,projectRoot} from './source-target.mjs';
const fail=(code,message)=>{throw Object.assign(new Error(message),{code});};
const note = 'Per-file atomic replacement with drift checks and best-effort reverse recovery; this is not a cross-file atomic transaction. Concurrent edits are never intentionally overwritten.';
export async function optionalAsset(root, target) {
  // Only new direct assets are optional. All ancestors must already exist and remain real directories.
  const directory = path.join(root, 'assets'), info = await fs.lstat(directory);
  if (info.isSymbolicLink() || !info.isDirectory() || await fs.realpath(directory) !== directory) fail('SYMLINK_TARGET', 'New asset parent must be a real assets directory.');
  try { return await readTarget(root, target); }
  catch (error) { if (error.code !== 'ENOENT') throw error; return { root, absolute: path.join(root, target), source: null, stat: null, parent: { dev: info.dev, ino: info.ino } }; }
}

function sameSnapshot(current, expected) {
  if (!current.stat || !expected.stat) return current.stat === expected.stat && current.absolute === expected.absolute
    && current.parent.dev === expected.parent.dev && current.parent.ino === expected.parent.ino;
  return current.absolute === expected.absolute && current.source === expected.source
    && ['dev', 'ino', 'mode', 'uid', 'gid'].every((key) => current.stat[key] === expected.stat[key]);
}

async function changeAsset(root, target, expected, desired, metadata) {
  if (expected.stat && desired !== null) return replaceFile(root, target, expected, desired, metadata);
  const current = await optionalAsset(root, target);
  if (!sameSnapshot(current, expected)) fail('SOURCE_DRIFT', `${target}: source or parent changed.`);
  if (desired === null) {
    const directory = await fs.stat(path.dirname(current.absolute));
    await fs.unlink(current.absolute);
    return { root, absolute: current.absolute, source: null, stat: null, parent: { dev: directory.dev, ino: directory.ino } };
  }
  const temporary = path.join(root, 'assets', `.perf-new-${randomUUID()}.tmp`);
  let linked = false;
  try {
    const handle = await fs.open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, metadata?.mode & 0o777 || 0o644);
    let stat;
    try { await handle.writeFile(desired, 'utf8'); await handle.sync(); stat = await handle.stat(); } finally { await handle.close(); }
    if (!sameSnapshot(await optionalAsset(root, target), expected)) fail('SOURCE_DRIFT', `${target}: source appeared during creation.`);
    // link is exclusive: unlike rename it cannot replace a concurrently created destination.
    await fs.link(temporary, current.absolute); linked = true;
    return { root, absolute: current.absolute, source: desired, stat };
  } finally { await fs.unlink(temporary).catch(error => { if (!linked && error.code !== 'ENOENT') throw error; }); }
}

async function replaceFile(root, target, expected, desired, metadata = expected.stat) {
  const current = await readTarget(root, target);
  if (!sameSnapshot(current, expected)) fail('SOURCE_DRIFT', `${target}: source, path or file metadata changed after preflight.`);
  const temporary = path.join(path.dirname(current.absolute), `.${path.basename(current.absolute)}.perf-site-${randomUUID()}.tmp`);
  let handle, renamed = false;
  try {
    handle = await fs.open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), metadata.mode & 0o777);
    await handle.writeFile(desired, 'utf8');
    const firstStat = await handle.stat();
    if (firstStat.uid !== metadata.uid || firstStat.gid !== metadata.gid) await handle.chown(metadata.uid, metadata.gid);
    await handle.chmod(metadata.mode & 0o777);
    await handle.sync();
    const writtenStat = await handle.stat();
    await handle.close(); handle = null;
    const latest = await readTarget(root, target);
    if (!sameSnapshot(latest, expected)) fail('SOURCE_DRIFT', `${target}: source changed while preparing replacement.`);
    await fs.rename(temporary, current.absolute);
    renamed = true;
    return { root, absolute: current.absolute, source: desired, stat: writtenStat };
  } finally {
    if (handle) await handle.close();
    // rename consumes this temporary name. A cleanup failure after committing
    // must never hide the returned snapshot and leave the write out of recovery.
    // Also do not remove a different file recreated at the consumed name.
    if (!renamed) await fs.unlink(temporary).catch((error) => { if (error.code !== 'ENOENT') throw error; });
  }
}

export async function executeChanges(plan, project, direction, {validatePlan,receiptKind="site-change-receipt"}={}) {
  if(!["apply","rollback"].includes(direction)||typeof validatePlan!=="function")throw new Error("Invalid write operation");
  await validatePlan(plan);
  const root = await projectRoot(project);
  const receipt = { schemaVersion: 1, kind: receiptKind, planId: plan.id, planHash: plan.planHash,
    project: root, direction, startedAt: new Date().toISOString(), completed: false, partial: false,
    atomicAcrossFiles: false, execution: note, files: [], recovery: [] };
  const pending = [], written = [], identities = new Set();
  const checkDependencies=async()=>{if(direction==='apply')for(const d of plan.metadata?.readOnlyDependencies??[])
    if(await fingerprintThemeFile(root,d.file)!==d.sourceHash)fail('SOURCE_DRIFT',`${d.file}: read-only optimization dependency changed.`);};
  try {
    await checkDependencies();
    for (const entry of plan.changes) {
      const snapshot = entry.recipeKind === 'create-asset' ? await optionalAsset(root, entry.target) : await readTarget(root, entry.target);
      if (entry.recipeKind === 'create-asset' && direction === 'apply' && snapshot.stat) fail('TARGET_EXISTS', `${entry.target}: new asset already exists; no files were written.`);
      const identity = snapshot.stat ? `${snapshot.stat.dev}:${snapshot.stat.ino}` : `missing:${entry.target}`;
      if (identities.has(identity)) fail('DUPLICATE_TARGET', 'Multiple target paths refer to the same file; no files were written.');
      identities.add(identity);
      const expectedHash = direction === 'apply' ? entry.beforeHash : entry.afterHash;
      const desiredHash = direction === 'apply' ? entry.afterHash : entry.beforeHash;
      const currentHash = snapshot.source === null ? null : hash(snapshot.source);
      if (currentHash !== expectedHash && currentHash !== desiredHash) fail('SOURCE_DRIFT', `${entry.target}: current source matches neither permitted snapshot; no files were written.`);
      pending.push({ entry, snapshot, skip: currentHash === desiredHash,
        desired: direction === 'apply' ? entry.after : entry.recipeKind === 'create-asset' ? null : entry.before });
    }
  } catch (error) {
    receipt.status = 'preflight-failed'; receipt.finishedAt = new Date().toISOString();
    receipt.error = { code: error.code ?? 'ERROR', message: error.message };
    error.receipt = receipt;
    throw error;
  }
  try {
    for (const item of pending) {
      const { entry, snapshot, skip, desired } = item;
      if (skip) {
        item.finalSnapshot = snapshot;
        receipt.files.push({ target: entry.target, status: direction === 'apply' ? 'already-applied' : 'already-rolled-back' });
        continue;
      }
      item.finalSnapshot = await changeAsset(root, entry.target, snapshot, desired);
      written.push(item);
      receipt.files.push({ target: entry.target, status: direction === 'apply' ? 'applied' : 'rolled-back', beforeHash: entry.beforeHash, afterHash: entry.afterHash });
    }
    await checkDependencies();
    for (const item of pending) {
      if (!sameSnapshot(item.entry.recipeKind === 'create-asset' ? await optionalAsset(root, item.entry.target) : await readTarget(root, item.entry.target), item.finalSnapshot)) fail('SOURCE_DRIFT', `${item.entry.target}: source changed before the batch completed.`);
    }
    receipt.completed = true;
    receipt.status = written.length ? (direction === 'apply' ? 'applied' : 'rolled-back') : (direction === 'apply' ? 'already-applied' : 'already-rolled-back');
    receipt.finishedAt = new Date().toISOString();
    return receipt;
  } catch (error) {
    for (const item of [...written].reverse()) {
      try {
        await changeAsset(root, item.entry.target, item.finalSnapshot, item.snapshot.source, item.snapshot.stat);
        receipt.recovery.push({ target: item.entry.target, status: 'restored' });
      } catch (recoveryError) {
        receipt.recovery.push({ target: item.entry.target, status: recoveryError.code === 'SOURCE_DRIFT' || recoveryError.code === 'SYMLINK_TARGET' ? 'conflict' : 'restore-failed', code: recoveryError.code ?? 'ERROR', message: recoveryError.message });
      }
    }
    receipt.partial = receipt.recovery.some((item) => item.status !== 'restored');
    receipt.status = receipt.partial ? 'partial-failure' : 'failed-restored';
    receipt.writesOccurred = written.length > 0;
    receipt.finishedAt = new Date().toISOString();
    receipt.error = { code: error.code ?? 'ERROR', message: error.message };
    throw Object.assign(new Error(`Site ${direction} failed: ${error.message}. ${receipt.partial ? 'Recovery is incomplete; inspect receipt conflicts.' : 'All files written by this attempt were restored.'}`, { cause: error }),
      { code: direction === 'apply' ? 'SITE_APPLY_FAILED' : 'SITE_ROLLBACK_FAILED', receipt });
  }
}
