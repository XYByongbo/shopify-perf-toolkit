import {maskNonRendering,htmlTagEnd,readAttributes,inspectImages,collectImages,liquidEnd,RAW_HTML_ELEMENTS} from './core/html-source.mjs';
export {maskNonRendering,htmlTagEnd,readAttributes,inspectImages} from './core/html-source.mjs';
import { lineAt, isInside } from './source-utils.mjs';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

const THEME_DIRS = new Set(['sections', 'snippets', 'blocks', 'assets', 'layout', 'templates']);
const RULES = ['IMG01', 'IMG02', 'IMG04', 'IMG05', 'IMG06', 'IMG07', 'CMP01', 'CMP03', 'CMP04', 'CMP07', 'JS02', 'FNT01'];
const blank = text => text.replace(/[^\r\n]/g, ' ');
// A conservative lexical mask prevents strings and comments from becoming JS evidence.
export function maskJsTrivia(source) {
  let out = '', i = 0;
  while (i < source.length) {
    const start = i;
    if (source.startsWith('//', i)) { i = source.indexOf('\n', i); if (i < 0) i = source.length; }
    else if (source.startsWith('/*', i)) { const end = source.indexOf('*/', i + 2); i = end < 0 ? source.length : end + 2; }
    else if ('"\'`'.includes(source[i])) {
      const quote = source[i++];
      while (i < source.length) { if (source[i] === '\\') i += 2; else if (source[i++] === quote) break; }
    } else { out += source[i++]; continue; }
    out += blank(source.slice(start, i));
  }
  return out;
}

function dependenciesOf(masked) {
  const dependencies = [], seen = new Set();
  const patterns = [
    { type: 'snippet', re: /\{%-?\s*(?:render|include)\s+(['"])([^'"\r\n]+)\1/g, file: (name) => `snippets/${name}.liquid` },
    { type: 'asset', re: /(['"])([^'"\r\n]+)\1\s*\|\s*asset_url\b/g, file: (name) => `assets/${name}` },
  ];
  for (const pattern of patterns) for (const match of masked.matchAll(pattern.re)) {
    const file = pattern.file(match[2]);
    if (!seen.has(file)) { dependencies.push({ type: pattern.type, name: match[2], file, line: lineAt(masked, match.index) }); seen.add(file); }
  }
  return dependencies;
}

/** Read-only, deliberately conservative source inspection. No finding claims a measured speedup. */
export async function inspectSource({ project, target, capture = null } = {}) {
  if (typeof project !== 'string' || typeof target !== 'string' || !target || target.includes('\0')) throw new Error('project and target must be non-empty filesystem paths.');
  const projectRoot = await realpath(project);
  if (!(await stat(projectRoot)).isDirectory()) throw new Error('project must be a directory.');
  const absoluteTarget = path.resolve(projectRoot, target);
  if (!isInside(projectRoot, absoluteTarget)) throw new Error('Target must stay inside the theme project.');
  const relativeTarget = path.relative(projectRoot, absoluteTarget).split(path.sep).join('/');
  if (!THEME_DIRS.has(relativeTarget.split('/')[0]) || !/\.(liquid|js|mjs|css)$/i.test(relativeTarget)) throw new Error('Target must be a Liquid, CSS, or JavaScript file in a Shopify theme directory.');
  const actualTarget = await realpath(absoluteTarget);
  if (!isInside(projectRoot, actualTarget)) throw new Error('Target symlink escapes the theme project.');
  const actualInfo = await stat(actualTarget);
  if (!actualInfo.isFile() || actualInfo.size > 5 * 1024 * 1024) throw new Error('Target must be a regular source file no larger than 5 MiB.');
  const source = await readFile(actualTarget, 'utf8');
  const sourceHash = createHash('sha256').update(source).digest('hex');
  const masked = maskNonRendering(source);
  const isLiquid = /\.liquid$/i.test(relativeTarget);
  const { images, rawRegions } = isLiquid ? collectImages(source, masked) : { images: [], rawRegions: [] };
  const findings = [], coverage = RULES.map((ruleId) => ({ ruleId, status: 'not-assessed', evidence: [], reason: 'This rule requires runtime evidence or semantic analysis not provided by this source inspection.' }));
  const limitations = [
    'Static candidates are review leads, not confirmed performance defects or measured improvements.',
    'Liquid branches, loops, settings, image_tag output, snippet rendering and computed CSS are not evaluated. Dependencies are inventoried, not recursively audited.',
    'Image indexes identify literal source tags, not browser DOM indexes; runtime records require an explicit sourceIndex mapping.',
    'No content, source image, crop, dimensions, loading priority, CSS, JavaScript or theme setting is changed by inspection.',
  ];
  if (/\{%-?\s*raw\b/.test(source)) limitations.push('Liquid raw blocks are excluded from literal-image analysis; inspect their rendered output manually.');
  let linkedCapture = capture?.kind === 'mapping' ? capture.linkedCapture : capture;
  const supplied = linkedCapture;
  if (supplied) {
    const topLinked = supplied.target === relativeTarget && supplied.sourceHash === sourceHash;
    const topMismatch = supplied.sourceHash != null && !topLinked;
    const records = !topMismatch && Array.isArray(supplied.images) ? supplied.images.filter(record => {
      if (!Number.isInteger(record.sourceIndex) || record.sourceIndex < 0 || record.sourceIndex >= images.length) return false;
      if (record.sourceHash !== undefined || record.sourcePath !== undefined || record.mapping) {
        if (record.sourceHash !== sourceHash || record.sourcePath !== relativeTarget) return false;
        if (record.mapping && (record.mapping.sourceHash !== sourceHash || record.mapping.sourcePath !== relativeTarget
          || record.mapping.sourceIndex !== record.sourceIndex || record.mapping.localSourceVerification !== 'sha256-current')) return false;
        return true;
      }
      return topLinked;
    }) : [];
    if (!records.length) {
      limitations.push('Capture has no matching current source hash, target and valid source indexes; runtime evidence was ignored.');
      linkedCapture = null;
    } else {
      linkedCapture = { ...supplied, images: records };
      if (records.some(record => record.mapping?.confidence === 'inferred')) limitations.push('Unannotated source/DOM associations are inferred; runtime observations do not prove the remote deployment matches local source.');
    }
  }
  const mark = (ruleId, status, reason, evidence = []) => {
    const entry = coverage.find((item) => item.ruleId === ruleId);
    if (!['candidate', 'observed'].includes(entry.status)) Object.assign(entry, { status, reason });
    entry.evidence.push(...evidence);
  };
  const add = (ruleId, line, summary, evidence, verification, status = 'candidate', severity = 'info') => {
    findings.push({ id: `${ruleId}-${findings.filter((finding) => finding.ruleId === ruleId).length + 1}`, ruleId, status, severity, line, summary, evidence, verification });
    const entry = coverage.find((item) => item.ruleId === ruleId);
    if (entry.status !== 'observed') entry.status = status;
    entry.reason = status === 'observed' ? 'Correlated browser evidence records this behavior; improvement still requires a controlled comparison.' : 'Static source pattern requires browser and functional verification.';
    entry.evidence.push(...evidence);
  };
  for (const ruleId of ['IMG01', 'IMG02', 'IMG04', 'IMG05']) {
    if (isLiquid) mark(ruleId, '未验证', 'Literal image attributes were inspected; computed layout, visibility and network requests need runtime verification.');
  }
  for (const img of images) {
    const attrs = img.attributes;
    const runtimeRecords = linkedCapture?.images?.filter((record) => record.sourceIndex === img.index) ?? [];
    const evidence = [{ file: relativeTarget, line: img.line, sourceIndex: img.index, tag: img.tag }];
    if (!Object.hasOwn(attrs, 'width') || !Object.hasOwn(attrs, 'height')) {
      add('IMG01', img.line, 'Image has no explicit width/height pair; verify whether CSS already reserves the correct aspect ratio.', evidence,
        ['Inspect computed aspect-ratio and reserved box before image load at all supported breakpoints.', 'Only add intrinsic dimensions after confirming the original image ratio, cropping and existing CSS behavior.']);
    }
    if (!Object.hasOwn(attrs, 'srcset')) {
      add('IMG02', img.line, 'Literal image has one source URL and no srcset; inspect displayed size and actual requested candidate.', evidence,
        ['Record rendered width, DPR, currentSrc and network request at mobile and desktop widths.', 'Preserve original image object, crop and any zoom or high-density requirement.']);
    } else if (/\b\d+w(?:\s*,|\s*$)/.test(attrs.srcset ?? '') && !Object.hasOwn(attrs, 'sizes')) {
      add('IMG02', img.line, 'Width-descriptor srcset has no explicit sizes; verify whether the default 100vw matches layout.', evidence,
        ['Compare actual element width with the sizes selection under the same viewport and DPR.']);
    }
    for (const runtime of runtimeRecords) {
      const inferred = runtime.mapping?.confidence === 'inferred';
      const runtimeEvidence = [...evidence, { source: 'capture', sourceIndex: img.index, selector: runtime.selector ?? null,
        associationConfidence: runtime.mapping?.confidence ?? 'explicit-hash-bound', deploymentVerification: runtime.mapping?.deploymentVerification ?? 'not-provided',
        currentSrc: runtime.currentSrc ?? null, renderedWidth: runtime.renderedWidth ?? runtime.rect?.width ?? runtime.box?.width ?? null,
        dpr: runtime.dpr ?? linkedCapture.dpr ?? linkedCapture.environment?.dpr ?? null, inViewport: runtime.inViewport ?? null, isLCP: runtime.isLCP ?? null }];
      if (runtime.isLCP === true && (runtime.loading ?? attrs.loading) === 'lazy') {
        add('IMG04', img.line, inferred ? 'The captured LCP image is lazy-loaded; its association to this local source is inferred.' : 'The explicitly mapped LCP image is lazy-loaded in this capture.', runtimeEvidence,
          ['Repeat navigation under fixed viewport, cache and network conditions.', 'Confirm deployed source, LCP identity and resource-discovery delay before changing loading priority.'], inferred ? 'candidate' : 'observed', 'warning');
      } else if ((runtime.inViewport === true || runtime.visibleInViewport === true) && (runtime.loading ?? attrs.loading) === 'lazy') {
        add('IMG04', img.line, 'Mapped image is visible in the initial viewport and marked lazy; inspect critical-path impact.', runtimeEvidence,
          ['Confirm this is initial navigation state, not after scrolling.', 'Measure LCP and resource timing before changing priority.']);
      }
      if (runtime.inViewport === false && (runtime.loading ?? attrs.loading) !== 'lazy') {
        add('IMG05', img.line, 'Mapped image is outside the captured viewport without lazy loading; near-future interaction needs review.', runtimeEvidence,
          ['Verify initial visibility and distance from viewport.', 'Exercise fast scrolling, anchors and carousel navigation before considering lazy loading.']);
      }
      mark('IMG02', '未验证', 'Mapped runtime source recorded; intrinsic naturalWidth alone cannot prove encoded pixels or oversizing.', runtimeEvidence);
    }
  }
  const high = images.filter((img) => img.attributes.fetchpriority === 'high');
  if (high.length > 1) add('IMG04', high[0].line, 'Multiple literal images request high fetch priority; confirm which branches render and which image is critical.', high.map((img) => ({ line: img.line, sourceIndex: img.index })), ['Identify actual rendered images and LCP; do not assume every source tag renders together.']);

  const preloads = [...masked.matchAll(/<link\b[^>]*\brel\s*=\s*(['"])preload\1[^>]*>/gi)];
  if (preloads.length) mark('IMG06', '未验证', 'Preload tags exist, but media/source matching, discovery delay and request reuse require runtime tracing.', preloads.map((match) => ({ line: lineAt(source, match.index), tag: match[0] })));
  const repeatedSources = new Map();
  for (const img of images) if (img.sourceExpression) {
    const indexes = repeatedSources.get(img.sourceExpression) ?? [];
    indexes.push(img.index); repeatedSources.set(img.sourceExpression, indexes);
  }
  for (const [src, indexes] of repeatedSources) if (indexes.length > 1) mark('IMG07', '未验证', 'Repeated source expressions are inventory only; they do not prove duplicate transfers.', [{ src, sourceIndexes: indexes }]);

  const dependencies = dependenciesOf(masked);
  if (dependencies.length) mark('CMP01', '未验证', 'Component dependencies were inventoried; multiple instances and request/execution duplication require a rendered page.', dependencies);
  const jsSource = /\.(?:m?js)$/i.test(relativeTarget) ? maskJsTrivia(source) : (() => {
    let code = blank(source);
    for (const region of rawRegions.filter((item) => item.name === 'script')) code = code.slice(0, region.start) + maskJsTrivia(source.slice(region.start, region.end)) + code.slice(region.end);
    return code;
  })();
  const timerMatch = jsSource.match(/\bsetInterval\s*\(/);
  const listenerMatch = jsSource.match(/\baddEventListener\s*\(/);
  const observerMatch = jsSource.match(/\bnew\s+(?:Intersection|Mutation|Resize)Observer\s*\(/);
  const resourceMatch = timerMatch ?? listenerMatch ?? observerMatch;
  const customElement = /\bextends\s+HTMLElement\b/.test(jsSource) || /\bcustomElements\s*\.\s*define\s*\(/.test(jsSource);
  if (resourceMatch) {
    mark('CMP03', '未验证', 'Initialization allocates callbacks or observers; source matching cannot establish instance-level idempotency.');
    if (customElement && !/\bdisconnectedCallback\s*\(/.test(jsSource)) {
      add('CMP04', lineAt(source, resourceMatch.index), 'Custom element allocates an interval, listener or observer without a local disconnectedCallback; inspect ownership and unload behavior.', [{ file: relativeTarget, line: lineAt(source, resourceMatch.index), pattern: resourceMatch[0] }],
        ['Repeat mount/unmount and Shopify section load/unload while tracking active callbacks.', 'Inspect inherited teardown and shared resource ownership before changing lifecycle code.']);
    } else mark('CMP04', '未验证', 'Allocated resources were identified; ownership and complete teardown need lifecycle verification.');
  }
  // Only flag the narrow dual-init shape found in controlled custom elements; no broad init-name heuristic.
  const onDemand = jsSource.match(/\binitScriptOnDemand\s*\(\s*this\s*,\s*this\.(\w+)\.bind\s*\(\s*this\s*\)/);
  if (onDemand) {
    const direct = new RegExp(`\\bthis\\.${onDemand[1]}\\s*\\(\\s*\\)`).exec(jsSource);
    if (direct) add('CMP03', lineAt(source, onDemand.index), 'The same initializer is registered for on-demand loading and called directly; verify the callback cannot allocate resources twice.', [{ file: relativeTarget, line: lineAt(source, onDemand.index), initializer: onDemand[1], directCallLine: lineAt(source, direct.index) }], ['Exercise eager, on-demand and repeated section initialization.', 'Confirm an instance-level guard and a retry-safe teardown before proposing a patch.']);
  }
  const fetchMatch = jsSource.match(/\bfetch\s*\(/);
  if (fetchMatch) mark('CMP07', '未验证', 'Fetch usage is present; whether old responses can overwrite newer state requires request-to-DOM control-flow and interaction evidence.', [{ file: relativeTarget, line: lineAt(source, fetchMatch.index) }]);
  const timeoutMatch = jsSource.match(/\bsetTimeout\s*\(/);
  if (timeoutMatch) mark('JS02', '未验证', 'A timeout exists; source matching does not establish that it is being used as a dependency-readiness delay.', [{ file: relativeTarget, line: lineAt(source, timeoutMatch.index) }]);
  const cssSource = /\.css$/i.test(relativeTarget) ? source : rawRegions.filter((item) => item.name === 'style').map((region) => source.slice(region.start, region.end)).join('\n');
  if (/@font-face\b/.test(cssSource.replace(/\/\*[\s\S]*?\*\//g, ''))) mark('FNT01', '未验证', 'Font-face declarations exist; descriptor, scope, media, layer and loading-order equivalence are not proven by text duplication.');
  return { schemaVersion: 1, kind: 'inspection', project: projectRoot, target: relativeTarget, sourceHash, component: { name: path.basename(relativeTarget, path.extname(relativeTarget)), file: relativeTarget, dependencies }, images, findings, coverage, limitations };
}
