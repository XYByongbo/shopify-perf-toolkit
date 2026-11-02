import {planOwnership} from './theme-ownership.mjs';
import { sha256 as hash } from './source-utils.mjs';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createImagePlan, readTarget, unifiedDiff, validTarget, validatePlan } from './changes.mjs';
import { inspectImages } from './inspect.mjs';
import { codeStrategyKinds } from './code-strategy-catalog.mjs';
import { parse as parseJS } from 'acorn';
import postcss from 'postcss';
import { liquidAST, visitAST } from './advanced-strategies.mjs';
import {themePlanDeltas} from './theme-methods.mjs';
import {parseLiquidAsset} from './liquid-assets.mjs';

const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const supported = /^(?:assets\/.+\.(?:m?js(?:\.liquid)?|css)|(?:sections|snippets|layout|templates|blocks)\/.+\.liquid)$/;
const liquid = /^(?:sections|snippets|layout|templates|blocks)\/.+\.liquid$/;
const kinds = new Set(['image-responsive', 'image-loading', 'reviewed-replacement', 'create-asset', ...codeStrategyKinds]);
const note = 'Per-file atomic replacement with drift checks and best-effort reverse recovery; this is not a cross-file atomic transaction. Concurrent edits are never intentionally overwritten.';

function canonical(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  fail('INVALID_PLAN', 'Plans and evidence must contain only finite JSON data.');
}

function planDigest(plan) {
  const { planHash: ignored, ...body } = plan;
  return hash(canonical(body));
}

function targetAllowed(target) {
  validTarget(target);
  if (target.startsWith('config/')) fail('PROTECTED_TARGET', 'No theme configuration file may be changed.');
  if (!supported.test(target)) fail('UNSUPPORTED_TARGET', 'Only existing assets JS/CSS and sections/snippets/layout/templates/blocks Liquid sources are supported.');
}

function context(reason, evidence) {
  if (typeof reason !== 'string' || !reason.trim() || !evidence || typeof evidence !== 'object'
      || Array.isArray(evidence) || typeof evidence.summary !== 'string' || !evidence.summary.trim()) {
    fail('MISSING_REVIEW_CONTEXT', 'Each change requires a concrete reason and an evidence object with a non-empty summary.');
  }
  canonical(evidence);
}

function schemaBlocks(source) {
  const blocks = source.match(/\{%-?\s*schema\s*-?%\}[\s\S]*?\{%-?\s*endschema\s*-?%\}/gi) ?? [];
  const remaining = source.replace(/\{%-?\s*schema\s*-?%\}[\s\S]*?\{%-?\s*endschema\s*-?%\}/gi, '');
  if (/\{%-?\s*(?:end)?schema\b/i.test(remaining)) fail('PROTECTED_SCHEMA', 'Malformed or unmatched schema boundaries cannot be patched.');
  return blocks;
}

function htmlBoundaryEnd(source, start) {
  let quote = null;
  for (let index = start; index < source.length; index += 1) {
    if (source.startsWith('{{', index) || source.startsWith('{%', index)) {
      const close = source[index + 1] === '{' ? '}}' : '%}';
      let liquidQuote = null, ended = false;
      for (index += 2; index < source.length; index += 1) {
        if (liquidQuote) { if (source[index] === liquidQuote) liquidQuote = null; }
        else if (source.startsWith(close, index)) { index += 1; ended = true; break; }
        else if (source[index] === '"' || source[index] === "'") liquidQuote = source[index];
      }
      if (!ended) return null;
    } else if (quote) { if (source[index] === quote) quote = null; }
    else if (source[index] === '"' || source[index] === "'") quote = source[index];
    else if (source[index] === '>') return index + 1;
  }
  return null;
}

function headerBoundaries(source) {
  const pattern = /\{%-?[\s\S]*?-?%\}|<!--|-->|(<\s*\/?\s*(?:script|style|template|textarea|title|noscript|iframe|xmp|noembed|noframes|plaintext)\b)|\bcontent_for_header\b/gi;
  return [...source.matchAll(pattern)].map((match) => {
    if (!match[1]) return match[0];
    const end = htmlBoundaryEnd(source, match.index + match[0].length);
    if (end === null) fail('PROTECTED_HEADER', 'Unterminated HTML text-container boundaries cannot be patched around content_for_header.');
    // Attribute-only edits such as adding defer remain possible, but removing
    // a delimiter or changing its quote cannot swallow the protected output.
    return { html: match[0].toLowerCase(), containsHeader: /\bcontent_for_header\b/.test(source.slice(match.index, end)) };
  });
}

function protectSource(before, after) {
  if (JSON.stringify(schemaBlocks(before)) !== JSON.stringify(schemaBlocks(after))) fail('PROTECTED_SCHEMA', 'Liquid schema blocks must remain byte-for-byte unchanged.');
  // Protect the complete lines, including filters, assignment syntax and adjacent code.
  const headerLines = (source) => source.split('\n').filter((line) => /\bcontent_for_header\b/.test(line));
  if (JSON.stringify(headerLines(before)) !== JSON.stringify(headerLines(after))) fail('PROTECTED_HEADER', 'content_for_header lines cannot be added, removed or modified.');
  if (/\bcontent_for_header\b/.test(before)) {
    // HTML names are case-insensitive. Include RCDATA, raw-text, script,
    // plaintext and inert template contexts: any can suppress header markup.
    if (JSON.stringify(headerBoundaries(before)) !== JSON.stringify(headerBoundaries(after))) {
      const rawContexts = source => [...source.matchAll(/\bcontent_for_header\b/g)].map(header => {
        const stack = [];
        for (const tag of source.slice(0, header.index).matchAll(/<\s*(\/?)\s*(script|style|template|textarea|title|noscript|iframe|xmp|noembed|noframes|plaintext)\b/gi)) {
          const name = tag[2].toLowerCase();
          if (!tag[1]) stack.push(name);
          else if (stack.at(-1) === name) stack.pop();
          else stack.push(`unbalanced-close:${name}`);
        }
        return stack;
      });
      if (canonical(rawContexts(before)) !== canonical(rawContexts(after))) fail('PROTECTED_HEADER', 'HTML raw-text context around content_for_header changed.');
      // Permit independent resource tags while proving the protected output's exact enclosing context is unchanged.
      const contexts = source => {
        const found = [];
        visitAST(liquidAST(source), (node, parents) => {
          if (node.type !== 'LiquidVariableOutput' || !/\bcontent_for_header\b/.test(source.slice(node.position.start, node.position.end))) return;
          found.push({ output: source.slice(node.position.start, node.position.end), parents: parents.filter(p => p.children && p.type !== 'Document').map(p => ({ type: p.type,
            opening: p.blockStartPosition ? source.slice(p.blockStartPosition.start, p.blockStartPosition.end) : null })) });
        }); return found;
      };
      let a, b; try { a = contexts(before); b = contexts(after); } catch { fail('PROTECTED_HEADER', 'Cannot prove unchanged content_for_header context with the Shopify parser.'); }
      if (!a.length || canonical(a) !== canonical(b)) fail('PROTECTED_HEADER', 'Liquid control/comment and HTML text-container context around content_for_header must remain unchanged.');
    }
  }
}

function protectLiquidAsset(target,before,after) {
  if(!/^assets\/.+\.m?js\.liquid$/.test(target))return;
  const a=parseLiquidAsset(before),b=parseLiquidAsset(after);
  const slots=m=>m.slots.map(s=>m.source.slice(s.start,s.end));
  if(JSON.stringify(slots(a))!==JSON.stringify(slots(b)))fail('PROTECTED_LIQUID_VALUES','Dynamic asset value expressions and serialization must remain unchanged.');
}

function imageLoading(before, parameters, evidence) {
  const { sourceIndex, loading } = parameters ?? {};
  if (!Number.isSafeInteger(sourceIndex) || sourceIndex < 0 || !['eager', 'lazy'].includes(loading)) fail('INVALID_IMAGE_LOADING', 'image-loading requires an explicit non-negative sourceIndex and loading eager or lazy.');
  if (evidence.sourceHash !== hash(before) || evidence.sourceIndex !== sourceIndex || evidence.initialViewport !== true) fail('MISSING_IMAGE_EVIDENCE', 'Image evidence must bind the current sourceHash/sourceIndex and confirm initialViewport.');
  if (loading === 'eager' && (evidence.inViewport !== true || evidence.isLCP !== true)) fail('MISSING_IMAGE_EVIDENCE', 'Eager/high priority requires explicit initial in-viewport and LCP evidence.');
  if (loading === 'lazy' && (evidence.inViewport !== false || evidence.isLCP !== false)) fail('MISSING_IMAGE_EVIDENCE', 'Lazy loading requires explicit initial offscreen and non-LCP evidence.');
  const image = inspectImages(before)[sourceIndex];
  if (!image) fail('IMAGE_NOT_FOUND', `No direct img exists at sourceIndex ${sourceIndex}.`);
  if (!image.eligibleForPatch && image.reason !== 'Existing responsive source configuration must be preserved and evaluated in a browser.') fail('UNSAFE_IMAGE', image.reason);
  if (image.attributeList.some((attribute) => /^on/i.test(attribute.name))) fail('UNSAFE_IMAGE', 'Image event handlers require a reviewed replacement.');
  for (const [name, allowed] of [['loading', ['lazy', 'eager', 'auto']], ['fetchpriority', ['auto', 'low', 'high']]]) {
    if (Object.hasOwn(image.attributes, name) && !allowed.includes(image.attributes[name])) fail('UNSAFE_IMAGE', `Dynamic or unsupported ${name} requires manual review.`);
  }
  if (loading === 'lazy' && image.attributes.fetchpriority === 'high') fail('UNSAFE_IMAGE', 'An existing high-priority image cannot be made lazy automatically.');
  const updates = { loading, ...(loading === 'eager' ? { fetchpriority: 'high' } : {}) };
  let tag = image.tag;
  for (const attribute of [...image.attributeList].reverse()) {
    if (Object.hasOwn(updates, attribute.name)) {
      const replacement = `${attribute.name}="${updates[attribute.name]}"`;
      tag = tag.slice(0, attribute.start - image.start) + replacement + tag.slice(attribute.end - image.start);
      delete updates[attribute.name];
    }
  }
  const addition = Object.entries(updates).map(([name, value]) => ` ${name}="${value}"`).join('');
  const close = /\/\s*>$/.exec(tag)?.index ?? tag.lastIndexOf('>');
  tag = tag.slice(0, close) + addition + tag.slice(close);
  return { after: before.slice(0, image.start) + tag + before.slice(image.end),
    edits: [{ start: image.start, end: image.end, before: image.tag, after: tag }] };
}

async function projectRoot(project) {
  if (typeof project !== 'string' || !project) fail('INVALID_PROJECT', 'project is required.');
  const stat = await fs.lstat(project);
  if (stat.isSymbolicLink()) fail('SYMLINK_TARGET', 'A symlink project root is refused.');
  if (!stat.isDirectory()) fail('INVALID_PROJECT', 'project must be a directory.');
  return fs.realpath(project);
}

function filePlan({ target, before, after, recipeKind, reason, evidence, parameters, edits }) {
  if (before === after) fail('NO_CHANGE', `${target}: no source change.`);
  protectSource(before, after);
  return { schemaVersion: 1, kind: 'change-plan', id: randomUUID(), target, recipeKind,
    operation: recipeKind === 'image-loading' ? 'image-loading-attributes' : codeStrategyKinds.has(recipeKind) ? 'generated-code-strategy' : 'reviewed-site-replacement',
    beforeHash: hash(before), afterHash: hash(after), before, after, reason, evidence,
    parameters, edits, diff: unifiedDiff(target, before, after), reviewRequired: true,
    semanticSafety: 'manual-review-required', description: reason };
}

function validateNewAsset(target, source) {
  if (!/^assets\/[A-Za-z0-9_-][A-Za-z0-9_.-]*\.(?:m?js|css)$/.test(target) || typeof source !== 'string' || !source.trim()
      || Buffer.from(source).toString('utf8') !== source) fail('INVALID_NEW_ASSET', 'New files must be nonempty UTF-8 assets/*.js, *.mjs or *.css without subdirectories.');
  try { if (target.endsWith('.css')) postcss.parse(source); else parseJS(source, { ecmaVersion: 'latest', sourceType: 'module' }); }
  catch (error) { fail('CODE_PARSE_ERROR', `New asset cannot be parsed: ${error.message}`); }
}

async function optionalAsset(root, target) {
  // Only new direct assets are optional. All ancestors must already exist and remain real directories.
  const directory = path.join(root, 'assets'), info = await fs.lstat(directory);
  if (info.isSymbolicLink() || !info.isDirectory() || await fs.realpath(directory) !== directory) fail('SYMLINK_TARGET', 'New asset parent must be a real assets directory.');
  try { return await readTarget(root, target); }
  catch (error) { if (error.code !== 'ENOENT') throw error; return { root, absolute: path.join(root, target), source: null, stat: null, parent: { dev: info.dev, ino: info.ino } }; }
}

/** Build a reviewable, hash-bound multi-file plan without writing theme source. */
export async function createSitePlan({ project, recipe, recipeDir, metadata } = {}) {
  if (!recipe || recipe.schemaVersion !== 1 || !Array.isArray(recipe.changes) || !recipe.changes.length) fail('INVALID_RECIPE', 'Expected schemaVersion 1 and a non-empty changes array.');
  const root = await projectRoot(project);
  const seen = new Set(), seenFiles = new Set(), changes = [];
  for (const item of recipe.changes) {
    if (!item || !kinds.has(item.kind)) fail('UNSUPPORTED_OPERATION', `Supported recipe kinds: ${[...kinds].join(', ')}.`);
    targetAllowed(item.target);
    if (seen.has(item.target)) fail('DUPLICATE_TARGET', `Multiple changes for ${item.target} are refused; combine them into one reviewed replacement.`);
    seen.add(item.target);
    context(item.reason, item.evidence);
    const evidence = JSON.parse(canonical(item.evidence));
    if (item.kind === 'create-asset') {
      validateNewAsset(item.target, item.replacementText);
      if (Object.keys(item).some(k => !['kind','target','replacementText','reason','evidence'].includes(k))) fail('INVALID_NEW_ASSET', 'create-asset accepts only inline reviewed source.');
      if ((await optionalAsset(root, item.target)).stat) fail('TARGET_EXISTS', 'create-asset refuses an existing file, including byte-identical files.');
      const entry = filePlan({ ...item, recipeKind: item.kind, before: '', after: item.replacementText, evidence,
        parameters: {}, edits: [{ start: 0, end: 0, before: '', after: item.replacementText }] });
      changes.push({ ...entry, operation: 'create-asset', beforeExists: false, beforeHash: null });
      continue;
    }
    const original = await readTarget(root, item.target);
    const identity = `${original.stat.dev}:${original.stat.ino}`;
    if (seenFiles.has(identity)) fail('DUPLICATE_TARGET', 'Multiple target paths refer to the same file; combine their changes.');
    seenFiles.add(identity);
    const before = original.source;
    if(/^assets\/.+\.m?js\.liquid$/.test(item.target))parseLiquidAsset(before);
    if (item.kind === 'image-responsive') {
      if (!Number.isSafeInteger(item.sourceIndex) || item.sourceIndex < 0) fail('INVALID_IMAGE_INDEX', 'sourceIndex must be explicit.');
      const entry = await createImagePlan({ project: root, target: item.target, imageIndex: item.sourceIndex, sizes: item.sizes, widths: item.widths });
      if (entry.before !== before) fail('SOURCE_DRIFT', 'Source changed while generating the plan.');
      protectSource(entry.before, entry.after);
      changes.push({ ...entry, recipeKind: item.kind, reason: item.reason, evidence });
    } else if (item.kind === 'image-loading') {
      if (!liquid.test(item.target)) fail('UNSUPPORTED_TARGET', 'image-loading requires a Liquid source.');
      const parameters = { sourceIndex: item.sourceIndex, loading: item.loading };
      const change = imageLoading(before, parameters, evidence);
      changes.push(filePlan({ ...item, recipeKind: item.kind, before, evidence, parameters, ...change }));
    } else if (codeStrategyKinds.has(item.kind)) {
      if (Object.keys(item).some(key => !['target', 'kind', 'parameters', 'reason', 'evidence'].includes(key))) fail('INVALID_RECIPE', 'Code strategies accept only target, kind, parameters, reason and evidence.');
      const { transformCode } = await import('./code-strategies.mjs');
      const parameters = JSON.parse(canonical(item.parameters ?? {}));
      const generated = transformCode({ source: before, target: item.target, kind: item.kind, parameters, evidence });
      changes.push({ ...filePlan({ ...item, recipeKind: item.kind, before, evidence, parameters, ...generated }), verificationRequired: generated.verification });
    } else {
      const hasText = Object.hasOwn(item, 'replacementText'), hasFile = Object.hasOwn(item, 'replacementFile');
      if (hasText === hasFile) fail('INVALID_REPLACEMENT', 'Provide exactly one of replacementText or replacementFile.');
      let after;
      if (hasText) after = item.replacementText;
      else {
        const replacementRoot = await projectRoot(recipeDir ?? root);
        after = (await readTarget(replacementRoot, item.replacementFile)).source;
      }
      if (typeof after !== 'string' || !after.trim() || Buffer.from(after, 'utf8').toString('utf8') !== after) fail('INVALID_REPLACEMENT', 'The complete replacement must be non-empty valid UTF-8 source; deleting a file or emptying an App source is not supported.');
      protectLiquidAsset(item.target,before,after);
      changes.push(filePlan({ ...item, recipeKind: item.kind, before, after, evidence,
        parameters: { replacementSource: hasFile ? item.replacementFile : 'inline-reviewed-text' },
        edits: [{ start: 0, end: before.length, before, after }] }));
    }
  }
  const ownership=await planOwnership(root,changes,recipe.ownership??[]);
  const now = new Date().toISOString();
  const plan = { schemaVersion: 1, kind: 'site-change-plan', id: randomUUID(), project: root,
    createdAt: now, updatedAt: now, reviewRequired: true, changes,
    ownership,
    verificationRequired: ['Review every complete diff and its evidence before application.', 'Verify theme content, visuals, App integrations and interactions on mobile and desktop.', 'Collect independent comparable Lighthouse runs; this plan does not establish performance gains.'],
    execution: note, integrity: 'SHA-256 binds this serialized plan; it is an integrity check, not a signature or proof of approval.' };
  if (metadata) plan.metadata = metadata;
  plan.planHash = planDigest(plan);
  return plan;
}

export async function validateSitePlan(plan) {
  if (!plan || plan.schemaVersion !== 1 || plan.kind !== 'site-change-plan' || typeof plan.id !== 'string'
      || !plan.id || plan.reviewRequired !== true || !Array.isArray(plan.changes) || !plan.changes.length) fail('INVALID_PLAN', 'Unsupported or incomplete site-change-plan.');
  if (plan.planHash !== planDigest(plan)) fail('INVALID_PLAN', 'The site plan fingerprint does not match its contents.');
  const seen = new Set();
  themePlanDeltas(plan);
  const dependencies=plan.metadata?.readOnlyDependencies??[];
  if(!Array.isArray(dependencies)||dependencies.length>100||new Set(dependencies.map(d=>d.file)).size!==dependencies.length)fail('INVALID_PLAN','Invalid dependency manifest.');
  for(const d of dependencies){targetAllowed(d.file);if(!/^[a-f0-9]{64}$/.test(d.sourceHash??''))fail('INVALID_PLAN','Invalid dependency hash.');}
  for(const c of plan.changes)for(const f of c.evidence?.themeOptimization?.inputs??[])
    if(!plan.changes.some(x=>x.target===f.file&&x.beforeHash===f.sourceHash)&&!dependencies.some(d=>d.file===f.file&&d.sourceHash===f.sourceHash))fail('INVALID_PLAN','Optimization dependency was omitted from the plan.');
  for(const c of plan.changes)for(const f of c.evidence?.queryContract?.dependencies??[])
    if(!dependencies.some(d=>d.file===f.file&&d.sourceHash===f.sourceHash))fail('INVALID_PLAN','Query dependency was omitted from the plan.');
  for (const entry of plan.changes) {
    targetAllowed(entry.target);
    if (seen.has(entry.target)) fail('DUPLICATE_TARGET', 'Site plans cannot contain duplicate targets.');
    seen.add(entry.target);
    context(entry.reason, entry.evidence);
    if (entry.reviewRequired !== true || typeof entry.before !== 'string' || typeof entry.after !== 'string'
        || !entry.after.trim() || Buffer.from(entry.after, 'utf8').toString('utf8') !== entry.after
        || Buffer.from(entry.before, 'utf8').toString('utf8') !== entry.before || entry.before === entry.after
        || (entry.recipeKind === 'create-asset' ? entry.before !== '' || entry.beforeHash !== null || entry.beforeExists !== false : hash(entry.before) !== entry.beforeHash)
        || hash(entry.after) !== entry.afterHash || entry.diff !== unifiedDiff(entry.target, entry.before, entry.after)) fail('INVALID_PLAN', 'Invalid snapshots, source fingerprints or diff.');
    protectSource(entry.before, entry.after);
    protectLiquidAsset(entry.target,entry.before,entry.after);
    if (entry.recipeKind === 'create-asset') {
      validateNewAsset(entry.target, entry.after);
      if (entry.operation !== 'create-asset' || entry.semanticSafety !== 'manual-review-required') fail('INVALID_PLAN', 'Invalid asset creation.');
    } else if (entry.recipeKind === 'image-responsive') {
      if (entry.operation !== 'image-responsive-attributes') fail('INVALID_PLAN', 'Image-responsive operation mismatch.');
      validatePlan(entry);
    } else if (entry.recipeKind === 'image-loading') {
      if (entry.operation !== 'image-loading-attributes' || !liquid.test(entry.target)) fail('INVALID_PLAN', 'Invalid image-loading target or operation.');
      const rebuilt = imageLoading(entry.before, entry.parameters, entry.evidence);
      if (rebuilt.after !== entry.after || canonical(rebuilt.edits) !== canonical(entry.edits)) fail('INVALID_PLAN', 'Image-loading plan changes more than the permitted attributes.');
    } else if (codeStrategyKinds.has(entry.recipeKind)) {
      if (entry.operation !== 'generated-code-strategy' || entry.semanticSafety !== 'manual-review-required') fail('INVALID_PLAN', 'Invalid generated strategy operation.');
      const { transformCode } = await import('./code-strategies.mjs');
      const rebuilt = transformCode({ source: entry.before, target: entry.target, kind: entry.recipeKind, parameters: entry.parameters, evidence: entry.evidence });
      if (rebuilt.after !== entry.after || canonical(rebuilt.edits) !== canonical(entry.edits)
        || canonical(rebuilt.verification) !== canonical(entry.verificationRequired)) fail('INVALID_PLAN', 'Code-strategy plan does not match its deterministic transformation.');
    } else if (entry.recipeKind !== 'reviewed-replacement' || entry.operation !== 'reviewed-site-replacement'
               || entry.semanticSafety !== 'manual-review-required') fail('INVALID_PLAN', 'Unknown or insufficiently reviewed site change.');
  }
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

async function execute(plan, project, direction) {
  await validateSitePlan(plan);
  const root = await projectRoot(project);
  const receipt = { schemaVersion: 1, kind: 'site-change-receipt', planId: plan.id, planHash: plan.planHash,
    project: root, direction, startedAt: new Date().toISOString(), completed: false, partial: false,
    atomicAcrossFiles: false, execution: note, files: [], recovery: [] };
  const pending = [], written = [], identities = new Set();
  const checkDependencies=async()=>{if(direction==='apply')for(const d of plan.metadata?.readOnlyDependencies??[])
    if(hash((await readTarget(root,d.file)).source)!==d.sourceHash)fail('SOURCE_DRIFT',`${d.file}: read-only optimization dependency changed.`);};
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

export async function applySitePlan(plan, project) { return execute(plan, project, 'apply'); }
export async function rollbackSitePlan(plan, project) { return execute(plan, project, 'rollback'); }
