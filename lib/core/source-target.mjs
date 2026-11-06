import * as fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
const fail=(code,message)=>{throw Object.assign(new Error(message),{code});};
export function validTarget(target) {
  if (typeof target !== 'string' || !target || target.includes('\\') || /[\x00-\x1f\x7f]/.test(target) ||
      path.isAbsolute(target) || /^[A-Za-z]:/.test(target) || target !== path.posix.normalize(target) ||
      target.split('/').some((part) => !part || part === '.' || part === '..')) {
    fail('UNSAFE_PATH', 'target must be a normalized, project-relative path without traversal.');
  }
  if (target === 'config/settings_data.json' || target.split('/').some((part) => part.startsWith('.'))) {
    fail('PROTECTED_TARGET', 'Theme configuration and hidden files cannot be patched.');
  }
  return target;
}

async function resolveTarget(project, target) {
  validTarget(target);
  if (typeof project !== 'string' || !project) fail('INVALID_PROJECT', 'project is required.');
  const root = await fs.realpath(project);
  const parts = target.split('/');
  let current = root;
  for (let i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i]);
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink()) fail('SYMLINK_TARGET', 'Symlink targets and symlink parent directories are refused.');
    if (i < parts.length - 1 && !stat.isDirectory()) fail('INVALID_TARGET', 'A target parent is not a directory.');
    if (i === parts.length - 1 && !stat.isFile()) fail('INVALID_TARGET', 'target must be a regular file.');
  }
  const real = await fs.realpath(current);
  if (!real.startsWith(root + path.sep)) fail('UNSAFE_PATH', 'target resolves outside the project.');
  return { root, absolute: current };
}

export async function readTarget(project, target) {
  const resolved = await resolveTarget(project, target);
  const handle = await fs.open(resolved.absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await handle.stat();
    const bytes = await handle.readFile();
    const source = bytes.toString('utf8');
    if (!Buffer.from(source, 'utf8').equals(bytes)) fail('NON_TEXT_TARGET', 'target must contain valid UTF-8 text.');
    return { ...resolved, source, stat };
  } finally { await handle.close(); }
}

export async function projectRoot(project) {
  if (typeof project !== 'string' || !project) fail('INVALID_PROJECT', 'project is required.');
  const stat = await fs.lstat(project);
  if (stat.isSymbolicLink()) fail('SYMLINK_TARGET', 'A symlink project root is refused.');
  if (!stat.isDirectory()) fail('INVALID_PROJECT', 'project must be a directory.');
  return fs.realpath(project);
}
