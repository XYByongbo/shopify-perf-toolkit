import { open, lstat, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const digest = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
export const isObject = value => Boolean(value && typeof value === 'object' && !Array.isArray(value));
export function fields(value, allowed, label) {
  if (!isObject(value) || Object.keys(value).some(k => !allowed.includes(k))) throw new Error(`Invalid ${label} fields.`);
}
export function goalContract(input = { kind: 'score' }) {
  fields(input, ['kind','metric','target','event'], 'goal');
  if (input.kind === 'score' && (input.metric===undefined||input.metric==='score') && input.target===undefined && input.event===undefined) return { kind: 'score', metric: 'score' };
  if (input.kind === 'loading' && ['lcp','fcp','tbt','cls','speedIndex'].includes(input.metric) && input.target===undefined && input.event===undefined) return { kind: input.kind, metric: input.metric };
  if (input.kind === 'interaction' && (input.metric===undefined||input.metric==='interaction') && typeof input.target === 'string' && input.target.trim() && input.target.length <= 512
      && ['click','keydown','pointerup'].includes(input.event)) return { kind: input.kind, metric: 'interaction', target: input.target, event: input.event };
  throw new Error('Goal must be score, loading with a supported metric, or interaction with target and event.');
}

/** Saved evidence only. No network, credentials, or output overwrites. */
export async function readEvidenceJSON(file, { root, hash, maxBytes = 32 * 1024 * 1024 } = {}) {
  const absolute = path.resolve(file);
  if (root && (!absolute.startsWith(path.resolve(root) + path.sep) || path.relative(root,absolute).split(path.sep).includes('..'))) throw new Error('Evidence path escapes its run.');
  for (let p = absolute; ; p = path.dirname(p)) {
    if ((await lstat(p)).isSymbolicLink()) throw new Error('Evidence symlinks are unsupported.');
    if (p === path.dirname(p)) break;
  }
  const info = await lstat(absolute);
  if (!info.isFile() || info.size > maxBytes) throw new Error('Evidence must be a bounded regular JSON file.');
  if (await realpath(absolute) !== absolute) throw new Error('Evidence path changed.');
  const handle=await open(absolute,constants.O_RDONLY|(constants.O_NOFOLLOW??0));
  try {
    const before=await handle.stat(),bytes=await handle.readFile(),after=await handle.stat();
    if(!before.isFile()||bytes.length>maxBytes||before.ino!==info.ino||before.dev!==info.dev||before.size!==after.size||before.mtimeMs!==after.mtimeMs||bytes.length!==after.size)throw new Error('Evidence changed while reading.');
    if (hash && digest(bytes) !== hash) throw new Error('Evidence content hash mismatch.');
    return JSON.parse(bytes.toString('utf8'));
  }finally{await handle.close();}
}

export function evidenceEnvelope({ type, input, scope, sourceHash = null, environment = null }) {
  return { version: 1, type, inputHash: digest(input), scope, sourceHash, environment,
    identity: sourceHash ? 'source-bound' : 'not-source-bound', acceptance: 'not-evaluated' };
}
