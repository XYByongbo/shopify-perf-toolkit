import {observationRules,inspectStandardsDOM} from './standards-observations.mjs';
import {integrityRules,inspectRuntimeIntegrity} from './runtime-integrity.mjs';
import {withStandardRules} from './standards-registry.mjs';
import { lineAt } from './source-utils.mjs';
import { visitAST } from './advanced-strategies.mjs';
import { createSourceSyntaxCache } from './source-syntax-cache.mjs';
import { htmlName, literalAttribute, lookupPath, filterArgument, imageFilter } from './performance-syntax.mjs';
import { p1PerformanceRules, inspectP1Source, inspectP1Runtime } from './p1-performance-rules.mjs';
export { htmlName, literalAttribute, lookupPath, filterArgument, imageFilter } from './performance-syntax.mjs';

const base = 'https://shopify.dev/docs/storefronts/themes/best-practices/performance/';
export const performanceRules = [
  ['PERF_IMAGE_TAG_LOADING', 'Shopify image loading policy', '#images'],
  ['PERF_IMAGE_TAG_SIZES', 'Shopify responsive image sizing', ''],
  ['PERF_DUAL_HERO', 'Separate mobile and desktop image outputs', 'use-picture-for-art-directed-heroes'],
  ['PERF_HEAD_RESOURCE_ORDER', 'First-paint resource discovery', 'load-resources-before-content-for-header'],
  ['PERF_HEAD_LIQUID_COST', 'Catalog work before the streaming boundary', 'load-resources-before-content-for-header'],
  ['PERF_LIQUID_NESTED_LOOP', 'Multiplicative catalog loops', 'avoid-deeply-nested-liquid-loops'],
  ['PERF_LIQUID_METAFIELD', 'Metafield access inside loops', 'move-metafield-access-outside-loops'],
  ['PERF_LIQUID_OVERFETCH', 'Catalog and variant over-fetching', 'avoid-variant-overfetching'],
  ['PERF_LIQUID_RENDER_LOOP', 'Repeated snippet rendering', ''],
  ['PERF_LCP_REVEAL', 'Visibility and animation gates', 'dont-hide-lcp-image-behind-animations'],
  ['PERF_LCP_BACKGROUND', 'LCP background image discovery', ''],
].map(([id, title, slug]) => ({ id, title, phase: 'P0', source: base + slug,
  runtimeSupported: ['PERF_IMAGE_TAG_LOADING', 'PERF_LCP_REVEAL', 'PERF_LCP_BACKGROUND'].includes(id) })).concat(p1PerformanceRules,integrityRules,observationRules).map(withStandardRules);

const excluded = parents => parents.some(p => p.type === 'HtmlComment' || p.type === 'LiquidRawTag' || p.type === 'HtmlRawNode');
const loopsIn = parents => parents.filter(n => n.type === 'LiquidTag' && ['for', 'tablerow'].includes(n.name));
const catalog = path => /(?:^|\.)(?:products|variants|collections)(?:\.|$)/.test(path ?? '');

/** Static candidates only: neither literal classes nor Liquid syntax establish LCP. */
export function inspectPerformanceSource({ source, file, sourceHash, syntax = createSourceSyntaxCache() }) {
  const findings = [], images = [], issues = [], cssRules = [], headReferences = [];
  const add = (ruleId, offset, summary, detail = {}, strategy = null) => {
    if (findings.some(f => f.ruleId === ruleId && f.offset === offset)) return;
    const rule = performanceRules.find(r => r.id === ruleId);
    findings.push({ id: `${file}:${ruleId}:${offset}`, file, line: lineAt(source, offset), offset, sourceHash, ruleId,
      dimension: 'performance', status: 'candidate', priority: 'P1', summary, evidence: [{ ...detail, source: rule.source }],
      suggestedStrategy: strategy, verification: [
        'Confirm the rendered branch, source identity and actual critical-path or Liquid cost.',
        'Review all affected templates, breakpoints and interactions; compare independent before/after measurements.',
      ] });
  };
  const inspectCSS = (text, offset = 0) => {
    if (/\{[{%]/.test(text)) { issues.push({ file, reason: 'dynamic-css-requires-render', offset }); return; }
    try {
      syntax.css(text).walkRules(rule => {
        if (rule.parent?.type === 'atrule' && /keyframes$/i.test(rule.parent.name)) return;
        const declarations = rule.nodes.filter(n => n.type === 'decl');
        const position = offset + rule.source.start.offset;
        const gates = declarations.filter(d => d.prop === 'opacity' && Number(d.value) === 0 || d.prop === 'visibility' && d.value === 'hidden');
        const animations = declarations.filter(d => /^(animation(?:-name|-delay|-duration)?|transition(?:-property|-delay|-duration)?)$/.test(d.prop) && !/^(none|0s|0ms)$/.test(d.value));
        const background = declarations.some(d => /^background(?:-image)?$/.test(d.prop) && /url\(/.test(d.value));
        if (gates.length || animations.length || background) cssRules.push({
          file, sourceHash, line: lineAt(source, position), offset: position, selector: rule.selector,
          gates: gates.map(d => ({ property: d.prop, value: d.value })),
          animations: animations.map(d => ({ property: d.prop, value: d.value })), background,
        });
        // A hidden non-LCP component is often intentional: keep a style inventory,
        // only emit a static lead when hiding and animation are combined.
        if (gates.length && animations.length) add('PERF_LCP_REVEAL', position,
          'A hidden animated element may delay first-paint content; determine whether it contains the initial LCP.',
          { selector: rule.selector, properties: [...gates, ...animations].map(d => d.prop) }, 'css-lcp-reveal');
      });
    } catch (error) { issues.push({ file, reason: 'css-parse-error', detail: error.reason }); }
  };
  if (/\.css$/i.test(file)) inspectCSS(source);
  let tree, liquidError;
  if (/\.liquid$/i.test(file)) {
    try { tree = syntax.liquid(source); } catch (error) {
      liquidError = error;
      issues.push({ file, reason: 'liquid-parse-error', detail: error.message });
    }
    if (tree) {
      const nodes = [];
      visitAST(tree, (node, parents) => { if (!excluded(parents)) nodes.push({ node, parents }); });
      const headers = nodes.filter(({ node }) => node.type === 'LiquidVariableOutput' && lookupPath(node.markup?.expression) === 'content_for_header');
      for (const { node, parents } of nodes) {
        const offset = node.position?.start;
        if (!Number.isInteger(offset)) continue;
        const loops = loopsIn(parents), path = lookupPath(node);
        const head = parents.find(p => p.type === 'HtmlElement' && htmlName(p) === 'head');
        const header = head && headers.find(h => h.parents.includes(head))?.node;
        if (node.type === 'LiquidRawTag' && node.name === 'stylesheet') inspectCSS(node.body.value, node.blockStartPosition.end);
        if (node.type === 'HtmlRawNode' && htmlName(node) === 'style') inspectCSS(node.body.value, node.blockStartPosition.end);
        const filter = imageFilter(node);
        const imageParent = [...parents].reverse().find(p => p.type === 'HtmlElement' || p.type === 'Document');
        if (filter) {
          const args = Object.fromEntries((filter.args ?? []).filter(a => a.type === 'NamedArgument').map(a => [a.name, ['String', 'Number'].includes(a.value.type) ? a.value.value : null]));
          const image = { file, sourceHash, offset, line: lineAt(source, offset), expression: node.markup.rawSource, syntax: 'image_tag',
            args, className: args.class ?? null, parentOffset: imageParent?.position?.start,
            inPicture: parents.some(p => htmlName(p) === 'picture'), branchDependent: parents.some(p => p.type === 'LiquidBranch') };
          images.push(image);
          if (args.loading === 'lazy' && args.fetchpriority === 'high') add('PERF_IMAGE_TAG_LOADING', offset,
            'image_tag combines lazy loading with high priority; verify initial LCP and section placement.', { args }, 'liquid-image-tag-loading');
          if (!filterArgument(filter, 'sizes')) add('PERF_IMAGE_TAG_SIZES', offset,
            'image_tag has no explicit sizes; compare Shopify/browser defaults with the actual shared-component layout.', { args });
        }
        if (node.type === 'HtmlVoidElement' && htmlName(node) === 'img') {
          images.push({file,sourceHash,offset,line:lineAt(source,offset),syntax:'img',
            expression:source.slice(node.position.start,node.position.end),className:literalAttribute(node,'class'),
            parentOffset:imageParent?.position?.start,inPicture:parents.some(p=>htmlName(p)==='picture'),
            branchDependent:parents.some(p=>p.type==='LiquidBranch'),
            args:Object.fromEntries(['loading','fetchpriority','sizes'].map(k=>[k,literalAttribute(node,k)]))});
        }
        if (header && offset > header.position.end) {
          const filters = node.markup?.filters ?? [];
          const isResource = node.type === 'HtmlVoidElement' && htmlName(node) === 'link'
            && (literalAttribute(node, 'rel') === 'stylesheet' || literalAttribute(node, 'rel') === 'preload')
            || node.type === 'HtmlRawNode' && htmlName(node) === 'script' && ['module', 'importmap'].includes(literalAttribute(node, 'type'))
            || node.type === 'LiquidVariableOutput' && filters.some(f => ['stylesheet_tag', 'preload_tag'].includes(f.name));
          if (isResource) add('PERF_HEAD_RESOURCE_ORDER', offset,
            'A head resource is discovered after content_for_header; review whether it is needed for first paint.',
            { streamingVerification: 'live-storefront-required; preview/editor are not equivalent', headerOffset: header.position.start }, 'liquid-hoist-head-resource');
        }
        if (node.type === 'LiquidTag' && ['for', 'tablerow'].includes(node.name)) {
          const collection = lookupPath(node.markup?.collection);
          if (catalog(collection)) {
            if (loops.length) add('PERF_LIQUID_NESTED_LOOP', offset, 'Catalog iteration occurs inside another loop.', { collection, outerLoops: loops.map(n => n.position.start) });
            if (!node.markup.args?.some(a => a.name === 'limit') && !parents.some(p => p.name === 'paginate'))
              add('PERF_LIQUID_OVERFETCH', offset, 'Catalog loop has no explicit limit or enclosing paginate; compare fetched and displayed data.', { collection });
            if (header && offset < header.position.start) add('PERF_HEAD_LIQUID_COST', offset, 'Catalog work in head can delay the first streamed response.', { collection });
          }
        }
        if (path?.includes('.metafields.') && loops.length) {
          const owner = [...parents].reverse().find(p => ['LiquidVariableOutput', 'LiquidTag'].includes(p.type));
          add('PERF_LIQUID_METAFIELD', owner?.position.start ?? offset, 'Metafield access is repeated inside a loop; distinguish invariant values from per-item data.',
            { expression: path, loops: loops.map(n => n.position.start) }, owner?.name === 'assign' ? 'liquid-cache-metafield' : null);
        }
        if (node.type === 'LiquidVariableOutput' && node.markup.filters?.some(f => f.name === 'json') && catalog(lookupPath(node.markup.expression)))
          add('PERF_LIQUID_OVERFETCH', offset, 'Full catalog/variant data is serialized; verify which fields initial rendering actually needs.', { expression: node.markup.rawSource });
        if (node.type === 'LiquidTag' && ['render', 'include'].includes(node.name)) {
          if (loops.length) add('PERF_LIQUID_RENDER_LOOP', offset, 'Snippet rendering repeats inside a loop; profile the callee and its nested data access.', { loops: loops.map(n => n.position.start) });
          if (header && offset < header.position.start) headReferences.push({ file, line: lineAt(source, offset), offset, snippet: node.markup?.snippet?.value ?? null });
        }
      }
      for (const desktop of images.filter(i => !i.inPicture && /(?:--|[_-])desktop\b/.test(i.className ?? ''))) {
        const mobiles = images.filter(i => !i.inPicture && /(?:--|[_-])mobile\b/.test(i.className ?? '') && i.parentOffset === desktop.parentOffset);
        for (const mobile of mobiles) add('PERF_DUAL_HERO', desktop.offset, 'Separate desktop/mobile image_tag outputs may download together despite CSS hiding.',
          { desktopOffset: desktop.offset, mobileOffset: mobile.offset, branchDependent: desktop.branchDependent || mobile.branchDependent },
          desktop.syntax==='image_tag'&&mobile.syntax==='image_tag'?'liquid-picture-pair':null);
      }
    }
  }
  // Keep a large standalone Liquid AST available to P1 even if embedded work evicted its cache entry.
  const p1 = inspectP1Source({ source, file, sourceHash, syntax, tree, liquidError });
  return { ...p1, findings: [...findings, ...p1.findings].map(withStandardRules), images, cssRules, headReferences, issues: [...issues, ...p1.issues] };
}

/** Correlate captured LCP state with source candidates, never claim selector matching proves deployment. */
export function inspectPerformanceRuntime({ profiles = [], snapshot, inventory = [] }) {
  const findings = [], issues = [], integrity = [], checkResults=[];
  for (const [profileIndex, profile] of profiles.entries()) {
    if (!profile || profile.kind !== 'runtime-profile' || profile.status !== 'complete' || !profile.sourceStable
      || !snapshot.complete || profile.snapshot?.hash !== snapshot.hash) {
      issues.push({ profileIndex, reason: 'incomplete-or-stale-runtime-profile' });
      checkResults.push(...inspectStandardsDOM({},profileIndex).checks.map(c=>({...c,reason:'Incomplete or stale runtime profile; recapture.'})));continue;
    }
    const observations=inspectStandardsDOM(profile,profileIndex);findings.push(...observations.findings);checkResults.push(...observations.checks);
    const guard=inspectRuntimeIntegrity(profile);integrity.push({profileIndex,...guard});
    findings.push(...guard.findings.map(f=>({...f,id:`runtime:${profileIndex}:${f.id}`,evidence:f.evidence.map(e=>({profileIndex,page:profile.config?.url,device:profile.config?.device,...e}))})));
    issues.push(...guard.issues.map(i=>({profileIndex,scope:'runtime-integrity',...i})));
    const p1 = inspectP1Runtime({ profile, profileIndex });
    findings.push(...p1.findings); issues.push(...p1.issues);
    const lcp = profile.initial?.lcp, presentation = lcp?.presentation;
    if (!presentation) { issues.push({ profileIndex, reason: 'lcp-presentation-unavailable-recapture' }); continue; }
    const context = { profileIndex, page: profile.config.url, device: profile.config.device, selector: presentation.selector,
      renderDelayMs: profile.lcp?.renderDelayMs ?? null };
    const add = (ruleId, summary, evidence, strategy = null) => findings.push({
      id: `runtime:${profileIndex}:${ruleId}`, ruleId, dimension: 'performance', status: 'candidate', priority: 'P1',
      file: null, line: null, sourceAssociation: 'requires-rendered-source-review', summary,
      evidence: [{ ...context, ...evidence }], suggestedStrategy: strategy,
      verification: ['Map the rendered element and ancestors to current Liquid/CSS sources before patching.', 'Verify all affected states and compare independent navigation measurements.'],
    });
    if (presentation.loading === 'lazy' || presentation.tag === 'IMG' && presentation.fetchPriority !== 'high')
      add('PERF_IMAGE_TAG_LOADING', 'The captured image LCP uses lazy loading or lacks explicit high priority.',
        { loading: presentation.loading, fetchPriority: presentation.fetchPriority, currentSrc: presentation.currentSrc,
          sourceCandidates: inventory.flatMap(i => i.images).filter(i => i.className && i.className.split(/\s+/).some(c => presentation.classes?.includes(c))) },
        'liquid-image-tag-loading');
    const gates = (presentation.ancestors ?? []).filter(a => a.opacity === '0' || a.visibility === 'hidden' || a.animations?.length);
    if (gates.length && (profile.lcp?.renderDelayMs ?? 0) >= 100)
      add('PERF_LCP_REVEAL', 'LCP render delay coincides with animation/visibility evidence on the element or its ancestors; trace causality.', { gates }, 'css-lcp-reveal');
    if (presentation.tag !== 'IMG' && presentation.backgroundImage && presentation.backgroundImage !== 'none')
      add('PERF_LCP_BACKGROUND', 'The captured LCP uses a CSS background; investigate image discovery and an equivalent img representation.', { backgroundImage: presentation.backgroundImage });
  }
  return { findings:findings.map(withStandardRules), issues, integrity, checkResults };
}
