import { sha256 } from './source-utils.mjs';
import { open, lstat, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';

export const digest = value => sha256(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value));
export const isObject = value => Boolean(value && typeof value === 'object' && !Array.isArray(value));
export function fields(value, allowed, label) {
  const choices = allowed.join(', ') || '(none)';
  if (!isObject(value)) throw new Error(label + ' must be an object. Allowed fields: ' + choices + '.');
  const unknown = Object.keys(value).filter(key => !allowed.includes(key));
  if (unknown.length) throw new Error('Invalid ' + label + ' fields. Unknown: ' + unknown.map(key => JSON.stringify(key)).join(', ') + '. Allowed fields: ' + choices + '.');
}

export function configValue(field, expected, code = 'INVALID_CONFIG') {
  return Object.assign(new Error(field + ' must be ' + expected + '.'), {code});
}

export function validateAt(field, validate) {
  try { return validate(); }
  catch (error) { throw Object.assign(new Error(field + ': ' + error.message, {cause:error}), {code:error.code}); }
}

export function goalContract(input = { kind: 'score' }) {
  fields(input, ['kind','metric','target','event'], 'goal');
  const {kind, metric, target, event} = input;
  const invalid = (field, expected) => configValue('Goal field '+field, expected);
  if (!['score','loading','interaction'].includes(kind)) throw invalid('goal.kind', 'score, loading or interaction');
  if (kind === 'interaction') {
    if (metric !== undefined && metric !== 'interaction') throw invalid('goal.metric', 'interaction or omitted');
    if (typeof target !== 'string' || !target.trim() || target.length > 512) throw invalid('goal.target', 'a nonempty selector up to 512 characters');
    if (!['click','keydown','pointerup'].includes(event)) throw invalid('goal.event', 'click, keydown or pointerup');
    return {kind, metric: 'interaction', target, event};
  }
  if (target !== undefined || event !== undefined) throw invalid(target !== undefined ? 'goal.target' : 'goal.event', 'omitted for goal.kind=' + kind);
  if (kind === 'score' && metric !== undefined && metric !== 'score') throw invalid('goal.metric', 'score or omitted');
  if (kind === 'loading' && !['lcp','fcp','tbt','cls','speedIndex'].includes(metric)) throw invalid('goal.metric', 'lcp, fcp, tbt, cls or speedIndex');
  return {kind, metric: metric ?? 'score'};
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
