import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { inspectImages } from './inspect.mjs';

const VERSION = 1;
const hash = (value) => createHash('sha256').update(value).digest('hex');
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const SIMPLE_IMAGE = /^\s*{{-?\s*([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)\s*\|\s*image_url\s*:\s*width\s*:\s*([1-9]\d*)\s*-?}}\s*$/;

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

function normalizedWidths(widths, maxWidth) {
  if (!Array.isArray(widths) || widths.length === 0 || widths.some((width) => !Number.isSafeInteger(width) || width <= 0 || width > maxWidth)) {
    fail('INVALID_WIDTHS', 'widths must be positive integer candidates no larger than the original image_url width.');
  }
  // Retain the original maximum candidate so high-density/large screens can keep original detail.
  return [...new Set([...widths, maxWidth])].sort((a, b) => a - b);
}

function buildImageChange(before, { imageIndex = 0, sizes, widths }) {
  if (!Number.isInteger(imageIndex) || imageIndex < 0) fail('INVALID_IMAGE_INDEX', 'imageIndex must be a non-negative integer.');
  if (typeof sizes !== 'string' || !sizes.trim() || /["'<>;&{}\\\x00-\x1f]/.test(sizes)) {
    fail('INVALID_SIZES', 'Explicit sizes is required; use a plain CSS source-size list without markup or Liquid.');
  }
  // Parse the actual snapshot again. An external inspection JSON is never used as source authority.
  const image = inspectImages(before)[imageIndex];
  if (!image) fail('IMAGE_NOT_FOUND', `No direct img exists at index ${imageIndex}.`);
  if (!image.eligibleForPatch) fail('UNSAFE_IMAGE', image.reason);
  for (let i = 1; i < image.attributeList.length; i++) {
    if (!/^\s+$/.test(before.slice(image.attributeList[i - 1].end, image.attributeList[i].start))) {
      fail('UNSAFE_IMAGE', 'Image attributes must be separated by whitespace.');
    }
  }
  const attributes = new Map(Object.entries(image.attributes));
  if (attributes.has('srcset') || attributes.has('sizes')) fail('UNSAFE_IMAGE', 'Existing srcset or sizes must be reviewed manually.');
  const expression = SIMPLE_IMAGE.exec(attributes.get('src') ?? '');
  if (!expression) fail('UNSAFE_IMAGE', 'src must be a simple image object passed only to image_url with one literal width.');
  const imageObject = expression[1];
  const maxWidth = Number(expression[2]);
  if (!Number.isSafeInteger(maxWidth)) fail('UNSAFE_IMAGE', 'The original image width is not a safe integer.');
  if (attributes.has('width') !== attributes.has('height')) fail('UNSAFE_IMAGE', 'A partial intrinsic dimension requires manual aspect-ratio review.');
  const candidates = normalizedWidths(widths, maxWidth);
  const srcset = candidates.map((width) => `{{ ${imageObject} | image_url: width: ${width} }} ${width}w`).join(', ');
  let addition = ` srcset="${srcset}" sizes="${sizes.trim()}"`;
  const dimensionsAdded = !attributes.has('width') && !attributes.has('height');
  if (dimensionsAdded) addition += ` width="{{ ${imageObject}.width }}" height="{{ ${imageObject}.height }}"`;
  const selfClosing = /\/\s*>$/.exec(image.tag);
  const close = selfClosing ? selfClosing.index : image.tag.lastIndexOf('>');
  const afterTag = image.tag.slice(0, close) + addition + image.tag.slice(close);
  const after = before.slice(0, image.start) + afterTag + before.slice(image.end);
  return {
    after, image: { ...image, imageObject, maxWidth }, dimensionsAdded,
    parameters: { imageIndex, sizes: sizes.trim(), widths: candidates },
    edits: [{ start: image.start, end: image.end, before: image.tag, after: afterTag }],
  };
}

function schemas(source) {
  return source.match(/{%-?\s*schema\s*-?%}[\s\S]*?{%-?\s*endschema\s*-?%}/gi) ?? [];
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

function makePlan({ target, before, after, operation, description, edits, parameters, validators = [] }) {
  if (before === after) fail('NO_CHANGE', 'The requested change does not modify the target.');
  if (JSON.stringify(schemas(before)) !== JSON.stringify(schemas(after))) fail('PROTECTED_SCHEMA', 'Liquid schema blocks cannot be changed.');
  return {
    schemaVersion: VERSION, kind: 'change-plan', id: randomUUID(), target,
    operation, beforeHash: hash(before), afterHash: hash(after), before, after,
    parameters, edits, description,
    reviewRequired: true,
    semanticSafety: operation === 'image-responsive-attributes' ? 'browser-verification-required' : 'manual-review-required',
    verificationRequired: ['Review the exact diff before applying.', 'Compare desktop and mobile content, appearance, image quality, layout, and interactions.', 'Measure the same rendered target before/after; no automatic performance or visual guarantee.'],
    validators, diff: unifiedDiff(target, before, after),
  };
}

/** Create a hash-bound plan for one directly written Shopify img. Never writes the theme. */
export async function createImagePlan({ project, target, imageIndex = 0, sizes, widths, inspection } = {}) {
  validTarget(target);
  if (!/^(sections|snippets|templates|layout)\/.+\.liquid$/.test(target)) fail('UNSUPPORTED_TARGET', 'Image plans require a Shopify Liquid theme source.');
  const { source: before } = await readTarget(project, target);
  const change = buildImageChange(before, { imageIndex, sizes, widths });
  if (inspection) {
    if (inspection.sourceHash !== hash(before)) fail('STALE_INSPECTION', 'Inspection sourceHash is required and must match the current source.');
    const expected = inspection.images?.find((entry) => entry.index === imageIndex);
    if (!expected || expected.eligibleForPatch !== true || ['start', 'end', 'tag', 'imageObject', 'maxWidth'].some((key) => expected[key] !== change.image[key])) {
      fail('INVALID_INSPECTION', 'Inspection image data does not match independently parsed source.');
    }
  }
  return makePlan({
    target, before, after: change.after, operation: 'image-responsive-attributes',
    description: `Add explicit responsive image candidates and sizes to img ${imageIndex}; preserve the original src and all existing attributes.${change.dimensionsAdded ? ' Add intrinsic dimensions from the same image object.' : ''} Browser review is required.`,
    parameters: change.parameters, edits: change.edits,
  });
}

/** Package a reviewer-authored full JS/CSS replacement; this is not semantic safety analysis. */
export async function createPatchPlan({ project, target, replacement, ruleId, reason, validators = [] } = {}) {
  validTarget(target);
  if (!/^assets\/.+\.(?:m?js|css)$/.test(target)) fail('UNSUPPORTED_TARGET', 'Reviewed component patches are limited to assets/*.js, *.mjs, and *.css sources.');
  if (typeof replacement !== 'string') fail('INVALID_REPLACEMENT', 'replacement must be the reviewed complete replacement source.');
  if (typeof ruleId !== 'string' || !ruleId.trim() || typeof reason !== 'string' || !reason.trim()) fail('MISSING_REVIEW_CONTEXT', 'A ruleId and concrete reason are required.');
  if (!Array.isArray(validators) || validators.some((item) => typeof item !== 'string')) fail('INVALID_VALIDATORS', 'validators must be descriptive strings; they are not executed.');
  const { source: before } = await readTarget(project, target);
  return makePlan({ target, before, after: replacement, operation: 'reviewed-component-replacement',
    parameters: { ruleId, reason }, description: `${ruleId}: ${reason} Manual diff and behavior review required; semantic equivalence is not automatically proven.`,
    edits: [{ start: 0, end: before.length, before, after: replacement }], validators });
}

export function validatePlan(plan) {
  if (!plan || plan.schemaVersion !== VERSION || plan.kind !== 'change-plan' || typeof plan.id !== 'string') fail('INVALID_PLAN', 'Unsupported change-plan schema.');
  validTarget(plan.target);
  if (typeof plan.before !== 'string' || typeof plan.after !== 'string' || hash(plan.before) !== plan.beforeHash || hash(plan.after) !== plan.afterHash || plan.before === plan.after) fail('INVALID_PLAN', 'Plan snapshots or hashes are invalid.');
  if (JSON.stringify(schemas(plan.before)) !== JSON.stringify(schemas(plan.after))) fail('PROTECTED_SCHEMA', 'Liquid schema blocks cannot be changed.');
  if (plan.operation === 'image-responsive-attributes') {
    if (!/^(sections|snippets|templates|layout)\/.+\.liquid$/.test(plan.target)) fail('UNSUPPORTED_TARGET', 'Image plans require Shopify Liquid sources.');
    const rebuilt = buildImageChange(plan.before, plan.parameters ?? {});
    if (rebuilt.after !== plan.after) fail('INVALID_PLAN', 'Image plan is not the permitted isolated tag change.');
  } else if (plan.operation === 'reviewed-component-replacement') {
    if (!/^assets\/.+\.(?:m?js|css)$/.test(plan.target)) fail('UNSUPPORTED_TARGET', 'Component plans require assets JS/CSS sources.');
    if (!plan.parameters?.ruleId || !plan.parameters?.reason || plan.reviewRequired !== true || plan.semanticSafety !== 'manual-review-required') fail('INVALID_PLAN', 'Component review context is missing.');
  } else fail('INVALID_PLAN', 'Unknown change operation.');
}

async function replaceAtomically(plan, project, direction) {
  validatePlan(plan);
  const expectedHash = direction === 'apply' ? plan.beforeHash : plan.afterHash;
  const desiredHash = direction === 'apply' ? plan.afterHash : plan.beforeHash;
  const desired = direction === 'apply' ? plan.after : plan.before;
  const original = await readTarget(project, plan.target);
  const currentHash = hash(original.source);
  const response = { target: plan.target, beforeHash: plan.beforeHash, afterHash: plan.afterHash, planId: plan.id };
  if (currentHash === desiredHash) return { ...response, status: direction === 'apply' ? 'already-applied' : 'already-rolled-back' };
  if (currentHash !== expectedHash) fail('SOURCE_DRIFT', `${plan.target} changed after the plan was created; refusing to overwrite current edits.`);
  const temporary = path.join(path.dirname(original.absolute), `.${path.basename(original.absolute)}.perf-${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await fs.open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), original.stat.mode & 0o777);
    await handle.writeFile(desired, 'utf8');
    const temporaryStat = await handle.stat();
    if (temporaryStat.uid !== original.stat.uid || temporaryStat.gid !== original.stat.gid) {
      await handle.chown(original.stat.uid, original.stat.gid);
    }
    await handle.chmod(original.stat.mode & 0o777);
    await handle.sync();
    await handle.close();
    handle = null;
    // Recheck path, inode, permissions, and text immediately before replacement.
    const latest = await readTarget(project, plan.target);
    if (latest.absolute !== original.absolute || latest.stat.ino !== original.stat.ino || latest.stat.dev !== original.stat.dev || latest.stat.mode !== original.stat.mode || hash(latest.source) !== expectedHash) {
      fail('SOURCE_DRIFT', 'The target changed while preparing an atomic replacement.');
    }
    await fs.rename(temporary, original.absolute);
    return { ...response, status: direction === 'apply' ? 'applied' : 'rolled-back' };
  } finally {
    if (handle) await handle.close();
    await fs.unlink(temporary).catch((error) => { if (error.code !== 'ENOENT') throw error; });
  }
}

export async function applyPlan(plan, project) { return replaceAtomically(plan, project, 'apply'); }
export async function rollbackPlan(plan, project) { return replaceAtomically(plan, project, 'rollback'); }
