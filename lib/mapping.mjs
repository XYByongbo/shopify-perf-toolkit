import { isInside as inside } from './source-utils.mjs';
import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { inspectSource } from './inspect.mjs';

const fail = (message, code = 'INVALID_MAPPING_INPUT') => Object.assign(new Error(message), { code });
const hashPattern = /^[a-f0-9]{64}$/;

const cleanAttributes = attributes => Object.fromEntries(Object.entries(attributes ?? {}).filter(([name, value]) =>
  typeof value === 'string' && !/[{][{%]/.test(value) && !name.startsWith('data-perf-kit-')
  && (['id', 'class', 'alt', 'role', 'aria-label'].includes(name) || name.startsWith('data-'))));
const decode = value => value.replace(/&(?:#(x[0-9a-f]+|[0-9]+)|(amp|lt|gt|quot|apos));/gi, (raw, code, name) => {
  if (!code) return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[name.toLowerCase()];
  const point = /^x/i.test(code) ? parseInt(code.slice(1), 16) : Number(code);
  return point > 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff) ? String.fromCodePoint(point) : raw;
});
const normalized = (name, value) => name === 'class' ? value.trim().split(/\s+/).sort().join(' ') : value;
const same = (name, source, rendered) => typeof rendered === 'string'
  && normalized(name, decode(source)) === normalized(name, rendered);
const compatible = (image, dom) => image.mappingSafe !== false && Object.entries(cleanAttributes(image.attributes))
  .every(([name, value]) => same(name, value, dom.attributes?.[name]));
const pathOf = report => ({ sourcePath: report.target, sourceHash: report.sourceHash });

// Shopify wrapper IDs identify section instances, not source files. A local JSON
// section declaration is only a candidate relationship until deployment is verified.
async function sectionConfigurations(project) {
  const found = new Map(), limitations = [];
  let count = 0;
  async function walk(directory) {
    let entries;
    try {
      const actualDirectory = await realpath(path.join(project, directory));
      if (!inside(project, actualDirectory)) throw fail('Configuration directory escapes project.', 'UNSAFE_SOURCE_PATH');
      entries = await readdir(actualDirectory, { withFileTypes: true });
    }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (++count > 10000) throw fail('Too many configuration entries to map safely.', 'MAPPING_LIMIT');
      const relative = path.posix.join(directory, entry.name);
      if (entry.isSymbolicLink()) { limitations.push(`Skipped symlink configuration: ${relative}`); continue; }
      if (entry.isDirectory()) { await walk(relative); continue; }
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const absolute = await realpath(path.join(project, relative));
      if (!inside(project, absolute)) throw fail('Configuration escapes project.', 'UNSAFE_SOURCE_PATH');
      if ((await stat(absolute)).size > 5 * 1024 * 1024) { limitations.push(`Skipped oversized configuration: ${relative}`); continue; }
      let config;
      try { config = JSON.parse((await readFile(absolute, 'utf8')).replace(/^\s*\/\*[\s\S]*?\*\//, '')); }
      catch { limitations.push(`Unparsed JSON configuration: ${relative}`); continue; }
      if (!config?.sections || typeof config.sections !== 'object' || Array.isArray(config.sections)) continue;
      for (const [key, section] of Object.entries(config.sections)) {
        if (typeof section?.type !== 'string' || !/^[A-Za-z0-9_-]+$/.test(section.type)) continue;
        const existing = found.get(key) ?? [];
        existing.push({ target: `sections/${section.type}.liquid`, configuration: relative, sectionKey: key });
        found.set(key, existing);
      }
    }
  }
  for (const directory of ['templates', 'sections']) await walk(directory);
  return { found, limitations };
}

function contextFor(image) {
  const context = image.sectionContext;
  if (!context || typeof context.id !== 'string' || !context.id.startsWith('shopify-section-')) return null;
  const instanceId = context.id.slice('shopify-section-'.length);
  if (!instanceId) return null;
  return { id: context.id, instanceId, sectionKey: instanceId.includes('__') ? instanceId.slice(instanceId.lastIndexOf('__') + 2) : instanceId };
}

function descriptor(image) {
  const dom = image.dom;
  if (!dom || dom.tagName !== 'img' || typeof dom.attributes !== 'object' || dom.attributes === null || Array.isArray(dom.attributes)) return null;
  return dom;
}

/** Associate observed literal images conservatively without modifying a theme.
 * A matching local SHA-256 binds indexes to local bytes; it does NOT attest that
 * the remote storefront was deployed from those bytes. Never use DOM order/URLs.
 */
export async function mapCapture({ project, capture, target } = {}) {
  if (typeof project !== 'string' || !project || !capture || typeof capture !== 'object' || Array.isArray(capture)
    || !Array.isArray(capture.images)) throw fail('project and a capture object with an images array are required.');
  if (capture.kind !== 'capture' || capture.schemaVersion !== 1) throw fail('Mapping requires schemaVersion 1, kind capture. Use raw capture or linkedCapture, not a mapping report.');
  if (capture.images.length > 5000) throw fail('At most 5000 captured images can be mapped.', 'MAPPING_LIMIT');
  const projectRoot = await realpath(project);
  if (!(await stat(projectRoot)).isDirectory()) throw fail('project must be a directory.');
  const reports = new Map();
  const read = async file => {
    if (!reports.has(file)) reports.set(file, await inspectSource({ project: projectRoot, target: file }));
    return reports.get(file);
  };
  const requested = target === undefined ? null : await read(target);
  if (capture.sourceHash !== undefined && capture.sourceHash !== null) {
    if (!hashPattern.test(capture.sourceHash) || typeof capture.target !== 'string') throw fail('Existing linked capture has an invalid source hash or target.', 'STALE_SOURCE');
    const previous = await read(capture.target);
    if (previous.sourceHash !== capture.sourceHash || (requested && previous.target !== requested.target)) {
      throw fail('Existing linked capture no longer matches the current source/target; capture again.', 'STALE_SOURCE');
    }
  }
  const configurations = await sectionConfigurations(projectRoot);
  const mappings = [], unmapped = [], ambiguous = [], components = [];
  const linkedImages = capture.images.map(image => {
    const { sourceIndex, sourcePath, sourceHash, mapping, ...raw } = image;
    return { ...raw };
  });
  const contexts = new Map();
  const resolveContext = image => {
    const context = contextFor(image);
    if (!context) return null;
    if (!contexts.has(context.id)) {
      const declarations = configurations.found.get(context.sectionKey) ?? [];
      const targets = [...new Set(declarations.map(item => item.target))];
      contexts.set(context.id, { ...context, status: targets.length === 1 ? 'inferred' : targets.length ? 'ambiguous' : 'unmapped',
        target: targets.length === 1 ? targets[0] : null, candidates: targets, declarations,
        deploymentVerification: 'unknown' });
    }
    return contexts.get(context.id);
  };
  const inventory = capture.mappingInventory;
  const inventoryImages = inventory?.complete === true && Array.isArray(inventory.images) ? inventory.images : null;
  if (capture.component) resolveContext(capture.component);
  const seenInstances = new Set();
  for (let captureIndex = 0; captureIndex < capture.images.length; captureIndex++) {
    const image = capture.images[captureIndex], dom = descriptor(image), context = resolveContext(image);
    const instance = { captureIndex, selector: image.selector ?? null, documentSelector: dom?.documentSelector ?? null, sectionId: context?.id ?? null };
    const unresolved = (reason, candidates = [], isAmbiguous = false) => (isAmbiguous ? ambiguous : unmapped)
      .push({ ...instance, reason, candidates });
    const identity = dom?.documentSelector ?? image.selector;
    if (typeof identity !== 'string' || !identity || seenInstances.has(identity)) {
      unresolved('Missing or duplicated DOM instance selector; no association was made.'); continue;
    }
    seenInstances.add(identity);
    const previous = image.mapping;
    const hasPreviousLink = image.sourceIndex !== undefined || image.sourcePath !== undefined || image.sourceHash !== undefined;
    if (hasPreviousLink) {
      if (!hashPattern.test(image.sourceHash ?? '') || typeof image.sourcePath !== 'string'
        || !Number.isInteger(image.sourceIndex) || image.sourceIndex < 0) {
        unresolved('Existing source link lacks a valid hash, path or index; no fallback inference was attempted.'); continue;
      }
      const earlier = await read(image.sourcePath);
      if (earlier.sourceHash !== image.sourceHash || !earlier.images.some(item => item.index === image.sourceIndex)
        || (requested && requested.target !== earlier.target)) {
        unresolved('Existing source link is stale or invalid; no fallback inference was attempted.'); continue;
      }
    }
    if (previous && (!hashPattern.test(previous.sourceHash ?? '') || typeof previous.sourcePath !== 'string')) {
      unresolved('Existing mapping is missing its source hash/path; no fallback inference was attempted.'); continue;
    }
    if (previous) {
      const report = await read(previous.sourcePath);
      if (report.sourceHash !== previous.sourceHash || !hasPreviousLink || previous.sourceIndex !== image.sourceIndex
        || previous.sourcePath !== image.sourcePath || previous.sourceHash !== image.sourceHash) {
        unresolved('Existing mapping is stale or inconsistent with its linked image; capture again.'); continue;
      }
    }
    let report = requested, sourceImage, method, confidence, evidence = [];
    const annotation = image.sourceIdentity;
    if (annotation !== null && annotation !== undefined) {
      if (typeof annotation !== 'object' || !hashPattern.test(annotation.sourceHash ?? '') || !Number.isInteger(annotation.sourceIndex)
        || annotation.sourceIndex < 0 || typeof annotation.sourcePath !== 'string') {
        unresolved('Explicit source annotation is incomplete or invalid; no fallback inference was attempted.'); continue;
      }
      // Resolve paths even for mismatched annotations so traversal/symlinks cannot be hidden.
      const annotated = await read(annotation.sourcePath);
      if (annotated.sourceHash !== annotation.sourceHash || (requested && requested.target !== annotated.target)) {
        unresolved('Explicit source annotation has a stale hash or mismatched target; no fallback inference was attempted.'); continue;
      }
      sourceImage = annotated.images.find(item => item.index === annotation.sourceIndex);
      if (!sourceImage || !dom || !compatible(sourceImage, dom)) {
        unresolved('Explicit annotation index or static DOM attributes do not match the current source.'); continue;
      }
      report = annotated; method = 'validated-explicit-annotation'; confidence = 'annotated';
      evidence = ['DOM annotation path, literal image index and SHA-256 match current local source.', 'All statically known identifying attributes match the DOM.'];
    } else {
      if (!report && context?.target) {
        try { report = await read(context.target); }
        catch (error) { if (error.code === 'ENOENT') { unresolved('Section configuration points to a missing source file.', [context.target]); continue; } throw error; }
      }
      if (!report) { unresolved(context?.status === 'ambiguous' ? 'Section instance key appears with different types in local configurations.' : 'No explicit target or unambiguous section configuration identifies a source file.', context?.candidates ?? [], context?.status === 'ambiguous'); continue; }
      if (!dom) { unresolved('Capture lacks DOM descriptors; capture again with v0.3 or provide validated annotations.'); continue; }
      const safeImages = report.images.filter(item => item.mappingSafe !== false);
      const id = dom.attributes.id;
      if (typeof id === 'string' && id && dom.idCount === 1) {
        const matches = report.images.filter(item => typeof item.attributes.id === 'string' && same('id', item.attributes.id, id));
        if (matches.length > 1) { unresolved('Static ID occurs in multiple source tags, including possible branches.', matches.map(item => ({ ...pathOf(report), sourceIndex: item.index })), true); continue; }
        if (matches.length === 1 && compatible(matches[0], dom)) {
          sourceImage = matches[0]; method = 'unique-static-id'; confidence = 'inferred';
          evidence = ['ID is unique in the whole captured document and in the selected local source.', 'All statically known identifying attributes match the DOM.'];
        }
      }
      if (!sourceImage && typeof id === 'string' && id && dom.idCount !== 1) {
        unresolved('DOM ID is duplicated or its document-wide uniqueness was not captured.', [], dom.idCount > 1); continue;
      }
      if (!sourceImage && context?.target === report.target && inventoryImages) {
        const candidates = safeImages.filter(item => {
          const attrs = cleanAttributes(item.attributes);
          return Object.keys(attrs).filter(key => attrs[key].trim()).length >= 2 && compatible(item, dom);
        });
        if (candidates.length === 1) {
          const attrs = cleanAttributes(candidates[0].attributes);
          const occurrences = inventoryImages.filter(item => contextFor(item)?.id === context.id && descriptor(item)
            && Object.entries(attrs).every(([name, value]) => same(name, value, item.dom.attributes[name])));
          if (occurrences.length === 1 && occurrences[0].dom.documentSelector === dom.documentSelector) {
            sourceImage = candidates[0]; method = 'section-config-static-attributes'; confidence = 'inferred';
            evidence = ['Section wrapper key resolves to one local section type across available JSON configurations.', 'At least two static identifying attributes uniquely match one source image and one image in this section instance.'];
          } else if (occurrences.length > 1) { unresolved('Static attributes match multiple DOM images in the same section instance; loops/order are not guessed.', candidates.map(item => ({ ...pathOf(report), sourceIndex: item.index })), true); continue; }
        } else if (candidates.length > 1) { unresolved('Static attributes match multiple source images.', candidates.map(item => ({ ...pathOf(report), sourceIndex: item.index })), true); continue; }
      }
      if (!sourceImage) { unresolved('No unique static ID or unique static attributes within a resolved section context; DOM order and image URLs are not evidence.'); continue; }
    }
    const mapping = { ...instance, ...pathOf(report), sourceIndex: sourceImage.index, sourceLine: sourceImage.line,
      method, confidence, localSourceVerification: 'sha256-current', deploymentVerification: 'unknown', evidence };
    mappings.push(mapping);
    Object.assign(linkedImages[captureIndex], { sourcePath: report.target, sourceHash: report.sourceHash, sourceIndex: sourceImage.index, mapping });
  }
  for (const context of contexts.values()) {
    if (context.target) {
      try { const report = await read(context.target); components.push({ ...context, ...pathOf(report), localSourceVerification: 'sha256-current' }); }
      catch (error) { if (error.code === 'ENOENT') components.push({ ...context, status: 'unmapped', reason: 'Configured section source is missing.' }); else throw error; }
    } else components.push(context);
  }
  const mappedTargets = [...new Set(mappings.map(item => item.sourcePath))];
  const single = requested ?? (mappedTargets.length === 1 ? await read(mappedTargets[0]) : null);
  const { sourceHash: _oldHash, target: _oldTarget, mapping: _oldMapping, ...captureData } = capture;
  const limitations = [
    'Local SHA-256 validation binds source indexes to current local bytes; it does not verify the deployed remote theme, commit, settings or template.',
    'Unannotated associations are inferred from static identifiers and local section configuration, never DOM order or URLs alone.',
    'Only literal img elements are mapped. Dynamic image_tag output, injected attributes, CSS background images and shadow DOM require separate evidence.',
    'Repeated DOM instances may map to one source tag only when each instance is independently identifiable; ambiguous loops remain unresolved.',
    ...configurations.limitations,
  ];
  if (requested && !requested.target.endsWith('.liquid')) limitations.push('The requested JavaScript/CSS target contains no literal image tags; choose the owning Liquid source to associate its rendered images.');
  const summary = { mapped: mappings.length, inferred: mappings.filter(item => item.confidence === 'inferred').length,
    annotated: mappings.filter(item => item.confidence === 'annotated').length, ambiguous: ambiguous.length, unmapped: unmapped.length };
  const linkedCapture = { ...captureData, kind: 'capture', project: projectRoot, target: single?.target ?? null,
    ...(single ? { sourceHash: single.sourceHash } : {}), images: linkedImages,
    mapping: { schemaVersion: 1, summary, deploymentVerification: 'unknown', limitations },
    limitations: [...(capture.limitations ?? []), ...limitations] };
  return { schemaVersion: 1, kind: 'mapping', createdAt: new Date().toISOString(), project: projectRoot,
    target: single?.target ?? null, summary, mappings, ambiguous, unmapped, components, limitations, linkedCapture };
}
