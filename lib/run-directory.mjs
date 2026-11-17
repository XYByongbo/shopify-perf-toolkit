import { lstat, mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';

const fail = (code, message) => Object.assign(new Error(message), { code });

export async function createRunDirectory(value) {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim() || /[\x00-\x1f\x7f]/.test(value)
    || value.split(/[\\/]/).includes('..')) throw fail('INVALID_OUTPUT', 'A new output directory without traversal or control characters is required.');
  const output = path.resolve(value);
  const parts = output.slice(path.parse(output).root.length).split(path.sep).filter(Boolean);
  let current = path.parse(output).root;
  for (let index = 0; index < parts.length; index += 1) {
    current = path.join(current, parts[index]);
    let existing;
    try { existing = await lstat(current); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (existing) {
      if (existing.isSymbolicLink()) {
        const resolved = await realpath(current).catch(() => null);
        const hint = resolved ? ` Retry explicitly with the canonical path: ${path.join(resolved, ...parts.slice(index + 1))}`
          : ' Resolve the dangling link and choose a canonical path explicitly.';
        throw fail('UNSAFE_OUTPUT', `Output paths must not traverse symbolic links.${hint}`);
      }
      if (index === parts.length - 1) throw fail('OUTPUT_EXISTS', 'Output already exists; choose a new directory.');
      if (!existing.isDirectory()) throw fail('INVALID_OUTPUT', 'Output parent is not a directory.');
    } else {
      try { await mkdir(current, { mode: 0o700 }); } catch (error) {
        if (error.code === 'EEXIST') throw fail('OUTPUT_EXISTS', 'Output changed while creating the new directory.');
        throw error;
      }
    }
  }
  if (!parts.length) throw fail('OUTPUT_EXISTS', 'The filesystem root is not a new output directory.');
  return output;
}
