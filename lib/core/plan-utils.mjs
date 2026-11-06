import {sha256} from './source-utils.mjs';
const fail=(code,message)=>{throw Object.assign(new Error(message),{code});};
export function canonical(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  fail('INVALID_PLAN', 'Plans and evidence must contain only finite JSON data.');
}

export function unifiedDiff(target, before, after) {
  const a = before.split('\n');
  const b = after.split('\n');
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  while (suffix < a.length - prefix && suffix < b.length - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix++;
  const start = Math.max(0, prefix - 3);
  const contextAfter = Math.min(3, suffix);
  const removedEnd = a.length - suffix;
  const addedEnd = b.length - suffix;
  return [
    `--- a/${target}`, `+++ b/${target}`,
    `@@ -${start + 1},${removedEnd - start + contextAfter} +${start + 1},${addedEnd - start + contextAfter} @@`,
    ...a.slice(start, prefix).map((line) => ` ${line}`),
    ...a.slice(prefix, removedEnd).map((line) => `-${line}`),
    ...b.slice(prefix, addedEnd).map((line) => `+${line}`),
    ...a.slice(removedEnd, removedEnd + contextAfter).map((line) => ` ${line}`),
  ].join('\n') + '\n';
}

export function planHash(plan){const {planHash:ignored,...body}=plan;return sha256(canonical(body));}
