import { createHash } from 'node:crypto';
import path from 'node:path';

// Hash raw text/bytes. Object serialization belongs to the evidence contract.
export const sha256 = data => createHash('sha256').update(data).digest('hex');

// Parser offsets are UTF-16 offsets into the original source; lines are 1-based.
export const lineAt = (source, offset) => source.slice(0, offset).split('\n').length;

// Lexical containment only. Callers still resolve symlinks before checking.
export const isInside = (root, file) => file !== root && !path.relative(root, file).startsWith(`..${path.sep}`)
  && path.relative(root, file) !== '..' && !path.isAbsolute(path.relative(root, file));
