import postcss from 'postcss';
import { parse } from 'acorn';
import { liquidAST, visitAST } from './advanced-strategies.mjs';
import { htmlName, literalAttribute, literalAttributes, hasAttribute, hintKey, opaqueParents, lookupPath } from './performance-syntax.mjs';

const base = 'https://shopify.dev/docs/storefronts/themes/best-practices/performance/';
export const p1PerformanceRules = [
  ['PERF_PRELOAD_BUDGET', 'Preload discovery and duplication', 'use-preload-resource-hints-sparingly'],
  ['PERF_PRECONNECT', 'Connection hint scope and credentials', 'use-preconnect'],
  ['PERF_STYLESHEET_COUNT', 'Stylesheet delivery fan-out', '#css-and-fonts'],
  ['PERF_ASYNC_CSS', 'Critical styles loaded asynchronously', 'load-critical-css-synchronously'],
  ['PERF_STYLESHEET_SCOPE', 'Native stylesheet subsetting compatibility', '#css-and-fonts'],
  ['PERF_FONT_DELIVERY', 'External font delivery', '#css-and-fonts'],
  ['PERF_FONT_DISPLAY', 'Font display policy', '#css-and-fonts'],
  ['PERF_FONT_FALLBACK', 'Measured fallback font metrics', '#css-and-fonts'],
  ['PERF_LAYOUT_ANIMATION', 'Layout-property animations and broad transitions', '#css-and-fonts'],
  ['PERF_JS_DOM_READY_FETCH', 'Data discovery gated by DOM readiness', '#javascript'],
  ['PERF_JS_PASSIVE_LISTENER', 'Potentially blocking input listeners', 'debounce-throttle-event-handlers'],
  ['PERF_JS_VIEW_TRANSITION', 'View transition interaction cancellation', 'cancel-view-transitions-on-interaction'],
  ['PERF_JS_MODULE_SHIMS', 'Platform module shim duplication', '#javascript'],
  ['PERF_HIDDEN_DOM', 'Eager hidden component work', '#javascript'],
  ['PERF_DIALOG_LCP', 'Dialog takes the initial LCP', '#images'],
  ['PERF_LIQUID_FETCH_LIMIT', 'Rendered loop limit versus fetched array size', 'limit-product-queries-with-pagination'],
].map(([id, title, slug]) => ({ id, title, phase: 'P1', source: base + slug,
  staticScope: id === 'PERF_DIALOG_LCP' ? 'not-applicable-runtime-only' : id === 'PERF_STYLESHEET_SCOPE' ? 'repository-dependency-analysis' : 'candidate-analysis',
  runtimeSupported: ['PERF_PRELOAD_BUDGET', 'PERF_PRECONNECT', 'PERF_STYLESHEET_COUNT', 'PERF_HIDDEN_DOM', 'PERF_DIALOG_LCP',
    'PERF_ASYNC_CSS', 'PERF_FONT_DELIVERY', 'PERF_LAYOUT_ANIMATION', 'PERF_JS_DOM_READY_FETCH'].includes(id) }));
// These are toolkit review triggers, not Shopify platform limits.
export const p1ReviewBudgets = { stylesheets: 4, hiddenDescendants: 200 };
const sourceFor = id => p1PerformanceRules.find(r => r.id === id)?.source;
const lineAt = (source, offset) => source.slice(0, offset).split('\n').length;
const layoutProperty = prop => /^(?:top|left|right|bottom|width|height|min-width|max-width|min-height|max-height|margin(?:-.+)?|padding(?:-.+)?|font-size|line-height|grid-template-.+|flex-basis)$/.test(prop);
const member = (node, object, property) => node?.type === 'MemberExpression' && !node.computed
  && node.object?.name === object && node.property?.name === property;
const cdnHost = host => ['cdn.shopify.com', 'monorail-edge.shopifysvc.com'].includes(host);
const originOf = value => { try { return new URL(value.startsWith('//') ? 'https:' + value : value); } catch { return null; } };
const hintTypes = new Set(['preload', 'preconnect', 'dns-prefetch']);

export function inspectP1Source({ source, file, sourceHash }) {
  const findings = [], issues = [], resourceHints = [], stylesheets = [], fonts = [], hiddenComponents = [];
  let nativeStylesheetCount = 0;
  const add = (ruleId, offset, summary, detail = {}, suggestedStrategy = null) => {
    if (findings.some(f => f.ruleId === ruleId && f.offset === offset)) return;
    findings.push({ id: `${file}:${ruleId}:${offset}`, ruleId, file, offset, line: lineAt(source, offset), sourceHash,
      dimension: 'performance', status: 'candidate', priority: 'P1', summary, suggestedStrategy,
      evidence: [{ ...detail, source: sourceFor(ruleId) }],
      verification: ['Verify rendered instances, all applicable states and actual request/CPU/layout cost.',
        'Static matches do not authorize removal or prove savings; use current source-bound evidence and independent before/after measurements.'] });
  };
  function fontFilter(node, offset) {
    const filter = node.type === 'LiquidVariableOutput' && node.markup?.filters?.find(f => f.name === 'font_face');
    if (!filter) return;
    const display = filter.args.find(a => a.name === 'font_display');
    const value = display?.value.type === 'String' ? display.value.value : null;
    fonts.push({ file, sourceHash, offset, syntax: 'font_face', expression: node.markup.rawSource, display: value ?? 'unknown/default' });
    if (!display || ['auto', 'block'].includes(value)) add('PERF_FONT_DISPLAY', offset,
      'Shopify font_face has a blocking/default display policy; review font_display and fallback behavior.', { syntax: 'font_face', expression: node.markup.rawSource });
    else if (!value) issues.push({ file, offset, reason: 'dynamic-font-display-requires-render' });
  }
  function css(text, offset = 0) {
    if (/\{[{%]/.test(text)) {
      issues.push({ file, offset, reason: 'p1-dynamic-css-requires-render' });
      try { visitAST(liquidAST(text), (node, parents) => { if (!opaqueParents(parents)) fontFilter(node, offset + node.position.start); }); } catch {}
      return;
    }
    try {
      const root = postcss.parse(text), localMetricFaces = [];
      root.walkAtRules('font-face', face => {
        const declarations = Object.fromEntries(face.nodes.filter(n => n.type === 'decl').map(n => [n.prop.toLowerCase(), n.value]));
        if (/\blocal\(/i.test(declarations.src ?? '') && ['size-adjust', 'ascent-override', 'descent-override', 'line-gap-override'].every(k => k in declarations)) localMetricFaces.push(declarations['font-family']);
      });
      root.walkAtRules('font-face', face => {
        const d = Object.fromEntries(face.nodes.filter(n => n.type === 'decl').map(n => [n.prop.toLowerCase(), n.value]));
        const at = offset + face.source.start.offset, family = d['font-family']?.replace(/^(['"])(.*)\1$/, '$2');
        fonts.push({ file, sourceHash, offset: at, family, display: d['font-display'] ?? 'auto', src: d.src ?? null });
        if (!/\burl\(/i.test(d.src ?? '')) return;
        const urls = [...d.src.matchAll(/url\(\s*['"]?([^'")\s]+)['"]?\s*\)/gi)].map(m => m[1]);
        if (urls.some(u => { const url = originOf(u); return url && !cdnHost(url.hostname); }))
          add('PERF_FONT_DELIVERY', at, 'Absolute font URL is outside known Shopify hosts; confirm same-origin versus external delivery before changing hosting.', { family, urls });
        if (!d['font-display'] || ['auto', 'block'].includes(d['font-display']))
          add('PERF_FONT_DISPLAY', at, 'Font display can block visible text; review swap/optional and fallback layout.', { family },
            /\.css$/i.test(file) ? 'css-font-display' : null);
        if (d['font-display'] === 'swap' && !localMetricFaces.length)
          add('PERF_FONT_FALLBACK', at, 'Swapping web font has no measured local fallback face in this source; verify the actual font stack and cross-file definitions.',
            { family, scope: 'same-source-only', metricsMustBeMeasured: true }, /\.css$/i.test(file) ? 'css-font-fallback' : null);
      });
      root.walkRules(rule => {
        const at = offset + rule.source.start.offset, keyframe = rule.parent?.type === 'atrule' && /keyframes$/i.test(rule.parent.name);
        const properties = rule.nodes.filter(n => n.type === 'decl' && (keyframe && layoutProperty(n.prop.toLowerCase())
          || /^(transition|transition-property)$/.test(n.prop) && (/(^|[\s,])all(?=$|[\s,])/.test(n.value)
            || n.value.split(/[\s,]+/).some(layoutProperty)))).map(n => n.prop);
        if (properties.length) add('PERF_LAYOUT_ANIMATION', at, 'Animation/transition can trigger layout or animate every changed property.',
          { selector: rule.selector, properties, keyframe }, /\.css$/i.test(file) && !keyframe ? 'css-transition-properties' : null);
      });
    } catch (error) { issues.push({ file, offset, reason: 'p1-css-parse-error', detail: error.reason }); }
  }
  function js(text, offset = 0) {
    if (/\{[{%]/.test(text)) { issues.push({ file, offset, reason: 'p1-dynamic-js-requires-render' }); return; }
    try {
      const tree = parse(text, { ecmaVersion: 'latest', sourceType: 'module' });
      visitAST(tree, (n, parents) => {
        if (n.type === 'ImportDeclaration' && /(?:^|[/@])es-module-shims(?:[/@.]|$)/.test(n.source.value))
          add('PERF_JS_MODULE_SHIMS', offset + n.start, 'Explicit module shim may duplicate the Shopify-provided shim; check platform and browser support.', { specifier: n.source.value });
        if (n.type !== 'CallExpression') return;
        if (member(n.callee, 'document', 'startViewTransition'))
          add('PERF_JS_VIEW_TRANSITION', offset + n.start, 'Review cancellation of this view transition on pointer and keyboard interaction.', { method: 'startViewTransition', requiresLifecycleReview: true });
        if (!['window', 'document'].some(o => member(n.callee, o, 'addEventListener'))) return;
        const event = n.arguments[0]?.value, handler = n.arguments[1], options = n.arguments[2];
        const passive = options?.type === 'ObjectExpression' && options.properties.some(p => !p.computed && (p.key.name ?? p.key.value) === 'passive' && p.value.value === true);
        if (['touchstart', 'touchmove', 'wheel'].includes(event) && !passive) {
          const statement = parents.at(-1);
          add('PERF_JS_PASSIVE_LISTENER', offset + n.start, 'Input listener is not explicitly passive; verify cancellation needs and browser defaults before changing it.',
            { event, registrationStart: offset + (statement?.start ?? n.start) },
            /\.m?js$/i.test(file) && tree.body.includes(statement) ? 'js-passive-listener' : null);
        }
        if (!['DOMContentLoaded', 'load'].includes(event) || !['ArrowFunctionExpression', 'FunctionExpression'].includes(handler?.type)) return;
        const requests = [];
        visitAST(handler.body, (child, ancestors) => {
          if (ancestors.some(a => /Function/.test(a.type))) return;
          if (child.type === 'CallExpression' && (child.callee.name === 'fetch' || member(child.callee, 'window', 'fetch')))
            requests.push({ offset: offset + child.start, url: child.arguments[0]?.type === 'Literal' ? child.arguments[0].value : null });
        });
        if (requests.length) add('PERF_JS_DOM_READY_FETCH', offset + n.start, 'Data requests wait for DOM readiness; confirm criticality, consent and DOM-independent request inputs before moving them.', { event, requests });
      });
    } catch (error) { issues.push({ file, offset, reason: 'p1-js-parse-error', detail: error.message }); }
  }
  if (/\.css$/i.test(file)) css(source);
  if (/\.m?js$/i.test(file)) js(source);
  if (/\.liquid$/i.test(file)) {
    try {
      const tree = liquidAST(source), nodes = [];
      visitAST(tree, (node, parents) => { if (!opaqueParents(parents)) nodes.push({ node, parents }); });
      for (const { node, parents } of nodes) {
        const offset = node.position?.start;
        if (!Number.isInteger(offset)) continue;
        const tag = htmlName(node), inBranch = parents.some(p => p.type === 'LiquidBranch');
        if (node.type === 'LiquidRawTag' && ['stylesheet', 'style'].includes(node.name)) {
          if (node.name === 'stylesheet') nativeStylesheetCount++;
          css(node.body.value, node.blockStartPosition.end);
        }
        if (node.type === 'HtmlRawNode' && tag === 'style') css(node.body.value, node.blockStartPosition.end);
        if (node.type === 'LiquidRawTag' && node.name === 'javascript') js(node.body.value, node.blockStartPosition.end);
        if (node.type === 'HtmlRawNode' && tag === 'script') {
          const type = literalAttribute(node, 'type'), src = literalAttribute(node, 'src');
          if (src && /(?:^|[/@])es-module-shims(?:[/@.]|$)/.test(src))
            add('PERF_JS_MODULE_SHIMS', offset, 'Explicit module shim may duplicate Shopify platform delivery.', { src });
          if (!hasAttribute(node, 'src') && (!hasAttribute(node, 'type') || ['module', 'text/javascript', 'application/javascript'].includes(type)))
            js(node.body.value, node.blockStartPosition.end);
        }
        if (node.type === 'HtmlVoidElement' && tag === 'link') {
          const attrs = literalAttributes(node), rel = literalAttribute(node, 'rel'), href = literalAttribute(node, 'href');
          if (hintTypes.has(rel)) {
            resourceHints.push({ file, sourceHash, offset, rel, href, attributes: attrs, key: hintKey(attrs), inBranch,
              parentOffset: parents.at(-1)?.position?.start, directHead: htmlName(parents.at(-1)) === 'head', syntax: 'link' });
            if (!attrs) issues.push({ file, offset, reason: 'dynamic-resource-hint-requires-render' });
            if (rel === 'preconnect' && cdnHost(originOf(href ?? '')?.hostname))
              add('PERF_PRECONNECT', offset, 'Shopify manages this connection; inspect document Link headers before retaining an extra hint.', { href });
            if (rel === 'preload' && literalAttribute(node, 'as') === 'font' && !hasAttribute(node, 'crossorigin'))
              add('PERF_PRELOAD_BUDGET', offset, 'Font preload lacks crossorigin; check request credentials to avoid a second download.', { href, reason: 'font-credentials' });
          }
          if (rel === 'stylesheet') {
            stylesheets.push({ file, sourceHash, offset, href, inBranch });
            if (literalAttribute(node, 'media') === 'print' && hasAttribute(node, 'onload'))
              add('PERF_ASYNC_CSS', offset, 'Print/onload stylesheet is asynchronous; verify it does not contain initial viewport styles.', { href }, 'liquid-critical-css-sync');
            if (originOf(href ?? '')?.hostname === 'fonts.googleapis.com')
              add('PERF_FONT_DELIVERY', offset, 'External font stylesheet adds a separate discovery chain.', { href });
          }
        }
        if (node.type === 'LiquidVariableOutput') {
          fontFilter(node, offset);
          for (const filter of node.markup?.filters ?? []) {
            if (filter.name === 'stylesheet_tag') stylesheets.push({ file, sourceHash, offset, syntax: 'stylesheet_tag', inBranch });
            const preload = filter.args?.find(a => a.name === 'preload');
            if (filter.name === 'preload_tag' || ['stylesheet_tag', 'image_tag'].includes(filter.name) && preload?.value?.type === 'LiquidLiteral' && preload.value.value === true)
              resourceHints.push({ file, sourceHash, offset, rel: 'preload', syntax: filter.name, inBranch, expression: node.markup.rawSource });
            else if (['stylesheet_tag', 'image_tag'].includes(filter.name) && preload && !(preload.value.type === 'LiquidLiteral' && preload.value.value === false))
              issues.push({ file, offset, reason: 'dynamic-liquid-preload-requires-render' });
          }
        }
        if (node.type === 'LiquidTag' && node.name === 'for' && node.markup.args?.some(a => a.name === 'limit')) {
          const array = lookupPath(node.markup.collection);
          if (array && !['collection.products', 'collections'].includes(array) && !parents.some(p => p.name === 'paginate'))
            add('PERF_LIQUID_FETCH_LIMIT', offset, 'for limit bounds rendered iterations but does not establish a fetch limit for this array.', { array, requiresPaginationSemanticsReview: true });
        }
        if (node.type === 'HtmlElement' && (tag === 'dialog' || tag === 'details' && !hasAttribute(node, 'open') || hasAttribute(node, 'hidden'))) {
          let descendants = 0, liquidWork = 0;
          visitAST(node, child => {
            if (child !== node && ['HtmlElement', 'HtmlVoidElement', 'HtmlRawNode'].includes(child.type)) descendants++;
            if (child.type === 'LiquidTag' && ['for', 'render', 'include'].includes(child.name)) liquidWork++;
          });
          hiddenComponents.push({ file, sourceHash, offset, tag, descendants, liquidWork });
          if (liquidWork || descendants > p1ReviewBudgets.hiddenDescendants)
            add('PERF_HIDDEN_DOM', offset, 'Hidden/dialog content contains eager Liquid work or a large static subtree; review first-open and editor behavior.', { tag, descendants, liquidWork, reviewBudget: p1ReviewBudgets.hiddenDescendants });
        }
      }
      const seen = new Map();
      for (const hint of resourceHints.filter(h => h.key && h.directHead && !h.inBranch)) {
        const key = `${hint.parentOffset}:${hint.key}`, first = seen.get(key);
        if (first) add(hint.rel === 'preload' ? 'PERF_PRELOAD_BUDGET' : 'PERF_PRECONNECT', hint.offset,
          'Literal resource hint repeats within the same head; retain credentials/media distinctions when reviewing duplicates.',
          { firstStart: first.offset, duplicateStart: hint.offset, attributes: hint.attributes }, 'liquid-dedupe-resource-hint');
        else seen.set(key, hint);
      }
      const preloads = resourceHints.filter(h => h.rel === 'preload');
      if (preloads.length > 2) add('PERF_PRELOAD_BUDGET', preloads[0].offset, 'More than two author preload declarations in this source; verify which branches and instances render together.', { declarations: preloads.length, scope: 'same-source-not-rendered-total' });
      if (stylesheets.length > p1ReviewBudgets.stylesheets) add('PERF_STYLESHEET_COUNT', stylesheets[0].offset,
        'Multiple stylesheet declarations warrant delivery/subsetting review; count actual rendered links before merging.',
        { declarations: stylesheets.length, reviewBudget: p1ReviewBudgets.stylesheets, budgetSource: 'toolkit-review-trigger-not-platform-limit' });
    } catch (error) { issues.push({ file, reason: 'p1-liquid-parse-error', detail: error.message }); }
  }
  return { findings, issues, resourceHints, stylesheets, fonts, hiddenComponents, nativeStylesheetCount };
}

// Called only after the shared runtime source identity gate passes.
export function inspectP1Runtime({ profile, profileIndex }) {
  const findings = [], issues = [], delivery = profile.initial?.delivery;
  const add = (ruleId, summary, detail) => findings.push({ id: `runtime:${profileIndex}:${ruleId}`, ruleId,
    file: null, line: null, dimension: 'performance', priority: 'P1', status: 'candidate',
    sourceAssociation: 'requires-rendered-source-review', summary,
    evidence: [{ profileIndex, page: profile.config?.url, device: profile.config?.device, ...detail, source: sourceFor(ruleId) }],
    verification: ['Map the captured page/state to current source before changing it.', 'Review request mode, response hints, first interaction, font/layout behavior and independent measurements.'] });
  if (!delivery || delivery.version !== 1 || !Array.isArray(delivery.links) || !Array.isArray(delivery.hiddenComponents)
    || delivery.links.some(l => !l || typeof l.rel !== 'string' || typeof l.href !== 'string')
    || delivery.hiddenComponents.some(c => !c || !Number.isSafeInteger(c.descendants) || c.descendants < 0)) {
    issues.push({ profileIndex, reason: 'p1-delivery-evidence-unavailable-recapture' });
  } else {
    if (delivery.truncated || delivery.links.length > 500 || delivery.hiddenComponents.length > 100) issues.push({ profileIndex, reason: 'p1-delivery-evidence-truncated' });
    const hints = delivery.links.filter(l => l.rel === 'preload' && l.mediaMatches !== false);
    const resources = Array.isArray(profile.resources) ? profile.resources : [];
    const links = resources.filter(r => r?.type === 'Document').map(r => r.linkHeader).filter(Boolean);
    if (resources.some(r => r?.type === 'Document' && r.linkHeaderTruncated)) issues.push({ profileIndex, reason: 'document-link-header-truncated' });
    if (hints.length > 2) add('PERF_PRELOAD_BUDGET', 'Rendered page contains more than two matching-media preload links; compare author and platform hints.', { hints, documentLinkHeaders: links, earlyHints103: 'not-captured' });
    const preconnects = delivery.links.filter(l => l.rel === 'preconnect');
    const redundant = preconnects.filter((l, i) => cdnHost(originOf(l.href ?? '')?.hostname) || originOf(l.href ?? '')?.origin === originOf(profile.config?.url ?? '')?.origin
      || preconnects.slice(0, i).some(p => p.href === l.href && p.crossOrigin === l.crossOrigin));
    if (redundant.length || preconnects.length > 2) add('PERF_PRECONNECT', 'Review duplicate/same-origin/platform connection hints and the number of late critical origins.', { hints: preconnects, redundant, documentLinkHeaders: links });
    const styles = delivery.links.filter(l => l.rel === 'stylesheet' && !l.disabled && l.mediaMatches !== false);
    if (styles.length > p1ReviewBudgets.stylesheets) add('PERF_STYLESHEET_COUNT', 'Rendered page has multiple active stylesheet links; inspect style recalculation and native subsetting.', { styles, reviewBudget: p1ReviewBudgets.stylesheets, budgetSource: 'toolkit-review-trigger-not-platform-limit' });
    const hidden = delivery.hiddenComponents.filter(c => c.descendants > p1ReviewBudgets.hiddenDescendants);
    if (hidden.length) add('PERF_HIDDEN_DOM', 'Closed/hidden components contain substantial live DOM at initial capture.', { components: hidden, reviewBudget: p1ReviewBudgets.hiddenDescendants });
  }
  const presentation = profile.initial?.lcp?.presentation;
  if (presentation?.ancestors?.some(a => a.tag === 'DIALOG' || ['dialog', 'alertdialog'].includes(a.role)))
    add('PERF_DIALOG_LCP', 'Initial LCP belongs to a dialog; review timing, consent/accessibility obligations and main-content visibility.', { selector: presentation.selector, ancestors: presentation.ancestors });

  // PERF_ASYNC_CSS runtime: detect print/onload stylesheets that may block first paint
  if (delivery && Array.isArray(delivery.links)) {
    const asyncStyles = delivery.links.filter(l => l && l.rel === 'stylesheet' && l.media === 'print' && l.disabled !== true);
    if (asyncStyles.length) {
      const blockingResources = (profile.resources ?? []).filter(r => r.type === 'Stylesheet' && r.url && asyncStyles.some(s => s.href === r.url));
      const renderBlocking = blockingResources.filter(r => {
        const timing = r.timing;
        return timing && Number.isFinite(timing.requestStart) && Number.isFinite(timing.responseEnd) && (timing.responseEnd - timing.requestStart) > 100;
      });
      if (renderBlocking.length) add('PERF_ASYNC_CSS', 'Asynchronous stylesheet shows significant load time; verify it does not contain initial viewport styles.',
        { asyncStyles, renderBlocking: renderBlocking.map(r => ({ url: r.url, durationMs: (r.timing.responseEnd - r.timing.requestStart) * 1000 })) });
    }
  }

  // PERF_FONT_DELIVERY runtime: detect external font requests with high latency
  const fontResources = (profile.resources ?? []).filter(r => r.type === 'Font' && r.url);
  const externalFonts = fontResources.filter(r => {
    const url = originOf(r.url);
    return url && !cdnHost(url.hostname) && url.hostname !== originOf(profile.config?.url ?? '')?.hostname;
  });
  if (externalFonts.length) {
    const slowFonts = externalFonts.filter(r => {
      const timing = r.timing;
      return timing && Number.isFinite(timing.requestStart) && Number.isFinite(timing.responseEnd) && (timing.responseEnd - timing.requestStart) > 200;
    });
    if (slowFonts.length) add('PERF_FONT_DELIVERY', 'External font requests show high latency; consider same-origin delivery or preconnect.',
      { externalFonts: slowFonts.map(r => ({ url: r.url, host: originOf(r.url)?.hostname, durationMs: (r.timing.responseEnd - r.timing.requestStart) * 1000 })) });
  }

  // PERF_LAYOUT_ANIMATION runtime: detect layout thrashing from long tasks during interaction
  const longTasks = profile.initial?.longTasks ?? [];
  const interactionLongTasks = profile.afterActions?.longTasks ?? [];
  const layoutThrashTasks = [...longTasks, ...interactionLongTasks].filter(t => t.duration > 100);
  if (layoutThrashTasks.length > 3) add('PERF_LAYOUT_ANIMATION', 'Multiple long tasks detected; review layout-triggering animations and transitions.',
    { longTaskCount: layoutThrashTasks.length, totalDurationMs: layoutThrashTasks.reduce((n, t) => n + t.duration, 0) });

  // PERF_JS_DOM_READY_FETCH runtime: detect fetch requests initiated after DOMContentLoaded
  const domReadyFetches = (profile.resources ?? []).filter(r => {
    if (r.type !== 'Fetch' && r.type !== 'XHR') return false;
    const timing = r.timing;
    if (!timing || !Number.isFinite(timing.requestStart)) return false;
    const nav = profile.initial?.navigation;
    if (!nav || !Number.isFinite(nav.domContentLoadedEventEnd)) return false;
    return timing.requestStart > nav.domContentLoadedEventEnd;
  });
  if (domReadyFetches.length) add('PERF_JS_DOM_READY_FETCH', 'Data requests initiated after DOMContentLoaded; verify criticality and DOM-independent inputs.',
    { requests: domReadyFetches.map(r => ({ url: r.url, requestStartMs: r.timing.requestStart, domReadyMs: profile.initial.navigation.domContentLoadedEventEnd })) });

  return { findings, issues };
}
