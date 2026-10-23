import { createHash } from 'node:crypto';
import postcss from 'postcss';
import { liquidAST, visitAST } from './advanced-strategies.mjs';
import { imageFilter, filterArgument, lookupPath, htmlName, literalAttribute } from './performance-rules.mjs';

const fail = message => { throw Object.assign(new Error(message), { code: 'UNSUPPORTED_CODE_PATTERN' }); };
const evidence = ['sourceHash', 'summary'];
export const performanceStrategies = [
  { kind: 'liquid-image-tag-loading', targets: 'Liquid image_tag outputs', parameters: ['outputStart', 'loading'],
    evidenceRequired: [...evidence, 'initialPlacementConfirmed', 'sharedInstancesReviewed'],
    conditionalEvidence: { eager: { isLCP: true, inViewport: true }, lazy: { isLCP: false, inViewport: false } },
    effect: 'Set image_tag loading and, for confirmed LCP, high priority without changing its image pipeline.',
    boundary: 'Final image_tag filter with named arguments; dynamic loading/priority and opaque contexts refused. Eager requires isLCP/inViewport; lazy requires offscreen/non-LCP.',
    verification: ['Verify actual LCP, initial viewport, all shared instances and responsive image requests.'] },
  { kind: 'liquid-picture-pair', targets: 'Adjacent Liquid image_tag outputs',
    parameters: ['desktopStart', 'mobileStart', 'breakpoint', 'desktopWidths', 'mobileWidths', 'sizes', 'className'],
    evidenceRequired: [...evidence, 'initialLcpConfirmed', 'artDirectionReviewed', 'cssVisibilityReviewed', 'responsiveSizesReviewed', 'bothImagesPresent'],
    effect: 'Replace an explicitly reviewed adjacent desktop/mobile image pair with one responsive picture.',
    boundary: 'Simple image object -> image_url -> image_tag pipelines; same explicit alt and only supported attributes; no conditional pair or event handlers.',
    verification: ['Verify only the selected hero downloads at both breakpoints and DPRs.', 'Check crop, alt, geometry, CSS visibility, theme settings and empty-image handling.'] },
  { kind: 'liquid-hoist-head-resource', targets: 'layout/*.liquid', parameters: ['resourceStart'],
    evidenceRequired: [...evidence, 'firstPaintRequired', 'cascadeReviewed', 'dependenciesReviewed', 'liveStreamingValidationPlanned'],
    effect: 'Move one direct head stylesheet/font preload before the unchanged content_for_header output.',
    boundary: 'Direct siblings in head; only literal assets/font resources, no scripts, conditional tags or intervening executable content.',
    verification: ['Verify request start on a live streamed storefront; preview/editor alone cannot prove benefit.', 'Check Shopify stylesheet cascade, checkout buttons, font layout and console errors.'] },
  { kind: 'liquid-cache-metafield', targets: 'Liquid direct loop-body assignments', parameters: ['assignStart'],
    evidenceRequired: [...evidence, 'profileHotspotConfirmed', 'loopScopeReviewed', 'metafieldImmutable'],
    effect: 'Cache one invariant metafield lookup on the first iteration, preserving zero-iteration behavior.',
    boundary: 'Literal global metafield path, no per-item input, filters, shared-scope include/render, writes to inputs or early exits.',
    verification: ['Compare empty/short/long collections and all outputs, assignments and surrounding scope.', 'Repeat Liquid profiling; static access counts do not prove server savings.'] },
  { kind: 'css-lcp-reveal', targets: 'assets/*.css', parameters: ['selector'],
    evidenceRequired: [...evidence, 'initialLcpConfirmed', 'revealOnlyReviewed', 'allStatesReviewed'],
    effect: 'Expose one reviewed LCP element and remove its CSS reveal animation/transition gate.',
    boundary: 'One top-level class/id selector; literal opacity/visibility gates with animation, no important, layout, transform or custom-property gates.',
    verification: ['Verify initial visibility, layout, all interactive states and responsive variants.', 'Confirm LCP render-delay improvement independently of resource download timing.'] },
];

function outputAt(tree, start) {
  let selected;
  visitAST(tree, (node, parents) => {
    if (node.position?.start === start && imageFilter(node)) {
      if (parents.some(p => ['HtmlComment', 'HtmlRawNode', 'LiquidRawTag', 'AttrDoubleQuoted', 'AttrSingleQuoted', 'AttrUnquoted'].includes(p.type)
        || p.type === 'LiquidTag' && p.name === 'capture' || p.type === 'HtmlElement' && htmlName(p) === 'template')) fail('Opaque or attribute image output.');
      selected = { node, parents };
    }
  });
  if (!selected) fail('Select an image_tag output by current source offset.');
  const filters = selected.node.markup.filters, filter = imageFilter(selected.node);
  if (filters.at(-1) !== filter || filters.filter(f => f.name === 'image_tag').length !== 1
    || filter.args.some(a => a.type !== 'NamedArgument') || new Set(filter.args.map(a => a.name)).size !== filter.args.length)
    fail('Ambiguous image_tag pipeline or arguments.');
  return { ...selected, filter };
}
function replaceArguments(source, filter, updates) {
  const edits = [], remaining = { ...updates };
  for (const arg of filter.args) if (Object.hasOwn(remaining, arg.name)) {
    if (arg.value.type !== 'String' || !['auto', 'lazy', 'eager', 'low', 'high'].includes(arg.value.value)) fail('Dynamic image loading/priority requires review.');
    edits.push({ start: arg.value.position.start, end: arg.value.position.end, after: `'${remaining[arg.name]}'` });
    delete remaining[arg.name];
  }
  const additions = Object.entries(remaining).map(([k, v]) => `${k}: '${v}'`).join(', ');
  if (additions) edits.push({ start: filter.position.end, end: filter.position.end, after: `${filter.args.length ? ', ' : ': '}${additions}` });
  return edits;
}
function finish(source, edits, liquid = true) {
  const sorted = [...edits].sort((a, b) => a.start - b.start);
  for (let i = 1; i < sorted.length; i++) if (sorted[i].start < sorted[i - 1].end) fail('Overlapping performance edits.');
  let after = source;
  for (const edit of [...sorted].reverse()) after = after.slice(0, edit.start) + edit.after + after.slice(edit.end);
  if (after === source) fail('No source change.');
  if (liquid) liquidAST(after); else postcss.parse(after);
  return { after, edits: sorted.map(e => ({ ...e, before: source.slice(e.start, e.end) })) };
}
const htmlEscape = s => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function performanceTransform(source, target, kind, p, proof) {
  if (kind === 'css-lcp-reveal') {
    if (!/^assets\/.+\.css$/.test(target) || /\{[{%]/.test(source) || typeof p.selector !== 'string' || !/^[.#][A-Za-z_][\w-]*$/.test(p.selector)) fail('Select one literal class/id in a CSS asset.');
    const root = postcss.parse(source), matches = [];
    root.walkRules(rule => { if (rule.selector.split(',').some(s => s.trim() === p.selector)) matches.push(rule); });
    if (matches.length !== 1 || matches[0].parent.type !== 'root' || matches[0].selector !== p.selector) fail('Ambiguous or conditional LCP selector.');
    const rule = matches[0], gates = rule.nodes.filter(d => d.type === 'decl' && ['opacity', 'visibility'].includes(d.prop));
    const motion = rule.nodes.filter(d => d.type === 'decl' && /^(animation|transition)(?:-|$)/.test(d.prop));
    if (!gates.length || !motion.length || gates.some(d => d.important || !(d.prop === 'opacity' && d.value === '0' || d.prop === 'visibility' && d.value === 'hidden'))
      || motion.some(d => d.important || /var\(/.test(d.value))
      || rule.nodes.some(d => d.type === 'decl' && (['transform', 'display', 'content-visibility', 'clip-path', 'filter'].includes(d.prop))))
      fail('Only literal reveal-only opacity/visibility with animation/transition is supported.');
    for (const gate of gates) gate.value = gate.prop === 'opacity' ? '1' : 'visible';
    for (const declaration of motion) declaration.remove();
    rule.append({ prop: 'animation', value: 'none' }); rule.append({ prop: 'transition', value: 'none' });
    return finish(source, [{ start: 0, end: source.length, after: root.toString() }], false);
  }
  if (!/^(sections|snippets|layout|templates|blocks)\/.+\.liquid$/.test(target)) fail('Expected a Liquid theme file.');
  const tree = liquidAST(source);
  if (kind === 'liquid-image-tag-loading') {
    if (!['eager', 'lazy'].includes(p.loading)) fail('loading must be eager or lazy.');
    if (p.loading === 'eager' && (proof.isLCP !== true || proof.inViewport !== true)
      || p.loading === 'lazy' && (proof.isLCP !== false || proof.inViewport !== false)) fail('Loading change needs explicit initial LCP/viewport evidence.');
    const { filter } = outputAt(tree, p.outputStart);
    if (p.loading === 'lazy' && filterArgument(filter, 'fetchpriority') && filterArgument(filter, 'fetchpriority').value.value !== 'auto') fail('Existing priority cannot be downgraded to lazy.');
    return finish(source, replaceArguments(source, filter, { loading: p.loading, ...(p.loading === 'eager' ? { fetchpriority: 'high' } : {}) }));
  }
  if (kind === 'liquid-picture-pair') {
    const desktop = outputAt(tree, p.desktopStart), mobile = outputAt(tree, p.mobileStart);
    if ([desktop.node,mobile.node].some(n=>n.whitespaceStart||n.whitespaceEnd)) fail('Whitespace-trimmed image pairs require a reviewed conversion.');
    if (desktop.node === mobile.node || desktop.parents.at(-1) !== mobile.parents.at(-1)
      || desktop.parents.some(n => htmlName(n) === 'picture' || n.type === 'LiquidBranch')) fail('Picture requires adjacent outputs in one unconditional parent.');
    const [first, second] = [desktop.node, mobile.node].sort((a, b) => a.position.start - b.position.start);
    if (source.slice(first.position.end, second.position.start).trim()) fail('Image pair must be adjacent.');
    if (!Number.isInteger(p.breakpoint) || p.breakpoint < 320 || p.breakpoint > 2000
      || typeof p.sizes !== 'string' || !p.sizes.trim() || /[<>{}'"\r\n]/.test(p.sizes)
      || typeof p.className !== 'string' || !/^[A-Za-z_][\w -]*$/.test(p.className)) fail('Explicit breakpoint, safe sizes and common class required.');
    const alt = filterArgument(desktop.filter, 'alt'), mobileAlt = filterArgument(mobile.filter, 'alt');
    if (!alt || !mobileAlt || alt.value.type !== 'String' || mobileAlt.value.type !== 'String' || alt.value.value !== mobileAlt.value.value) fail('Both images need identical explicit literal alt.');
    const sourceTag = (image, widths, media) => {
      const filters = image.node.markup.filters, url = filters[0], object = lookupPath(image.node.markup.expression);
      if (!object || filters.length !== 2 || url.name !== 'image_url' || !url.args.length
        || url.args.some(a => a.type !== 'NamedArgument' || !['width', 'crop', 'height'].includes(a.name) || !['String', 'Number'].includes(a.value.type))
        || new Set(url.args.map(a => a.name)).size !== url.args.length
        || image.filter.args.some(a => !['alt', 'class', 'sizes', 'widths', 'loading', 'fetchpriority'].includes(a.name)))
        fail('Picture supports simple image_url pipelines and standard image attributes only.');
      const width = filterArgument(url, 'width');
      if (width?.value.type !== 'Number' || !Array.isArray(widths) || !widths.length || widths.length > 12
        || widths.some((w, i) => !Number.isInteger(w) || w < 1 || w > Number(width.value.value) || i > 0 && w <= widths[i - 1]))
        fail('Use increasing responsive widths no larger than the original image_url width.');
      // Cropping to a fixed height changes aspect ratio at different widths.
      if (filterArgument(url, 'height')) fail('Fixed-height crop needs a reviewed art-direction conversion.');
      const expressionStart = image.node.markup.expression.position.start;
      const original = source.slice(expressionStart, url.position.end);
      const srcset = widths.map(w => {
        const expression = original.slice(0, width.value.position.start - expressionStart) + w + original.slice(width.value.position.end - expressionStart);
        return `{{ ${expression} }} ${w}w`;
      }).join(', ');
      return `<source media="${media}" srcset="${srcset}" sizes="${htmlEscape(p.sizes)}" width="{{ ${object}.width }}" height="{{ ${object}.height }}">`;
    };
    const mobileSource = sourceTag(mobile, p.mobileWidths, `(max-width: ${p.breakpoint}px)`);
    const desktopSource = sourceTag(desktop, p.desktopWidths, `(min-width: ${p.breakpoint + 1}px)`);
    const imageExpression = source.slice(desktop.node.markup.expression.position.start, desktop.node.markup.filters[0].position.end);
    const fallback = `{{ ${imageExpression} | image_tag: alt: '${alt.value.value.replace(/'/g, '&#39;')}', class: '${p.className}', sizes: '${p.sizes}', widths: '${p.desktopWidths.join(', ')}', loading: 'eager', fetchpriority: 'high' }}`;
    // Literal apostrophes cannot be escaped in Liquid strings without changing alt.
    if (alt.value.value.includes("'")) fail('Alt with apostrophe requires a reviewed literal conversion.');
    return finish(source, [{ start: first.position.start, end: second.position.end,
      after: `<picture>\n${mobileSource}\n${desktopSource}\n${fallback}\n</picture>` }]);
  }
  if (kind === 'liquid-hoist-head-resource') {
    if (!target.startsWith('layout/')) fail('Head resource movement requires a layout.');
    let resource, header, head;
    visitAST(tree, (node, parents) => {
      if (node.position?.start === p.resourceStart && parents.at(-1)?.type === 'HtmlElement' && htmlName(parents.at(-1)) === 'head') { resource = node; head = parents.at(-1); }
    });
    if (!resource) fail('Resource must be a direct head child.');
    const headers = head.children.filter(n => n.type === 'LiquidVariableOutput' && lookupPath(n.markup?.expression) === 'content_for_header');
    if (headers.length !== 1 || headers[0].markup.filters.length) fail('Expected one unmodified content_for_header in this head.');
    header = headers[0];
    const lineStart=source.lastIndexOf('\n',header.position.start-1)+1;
    const nextLine=source.indexOf('\n',header.position.end), lineEnd=nextLine<0?source.length:nextLine;
    if(source.slice(lineStart,lineEnd).trim()!==source.slice(header.position.start,header.position.end)) fail('Protected content_for_header must be on its own line.');
    if (resource.position.start <= header.position.end) fail('Resource is already before the header boundary.');
    // Do not cross assignments, scripts or other resource declarations: moving
    // across them could change input values, execution order or the cascade.
    if (head.children.some(n => n.position.start >= header.position.end && n.position.end <= resource.position.start
      && !(n.type === 'TextNode' && !n.value.trim()) && n.type !== 'HtmlComment')) fail('Intervening head content requires a reviewed replacement.');
    let safe = false;
    if (resource.type === 'HtmlVoidElement' && htmlName(resource) === 'link') {
      const rel = literalAttribute(resource, 'rel'), href = literalAttribute(resource, 'href');
      safe = Boolean(href && !/[<>{}]/.test(href) && (rel === 'stylesheet' || rel === 'preload' && literalAttribute(resource, 'as') === 'font')
        && resource.attributes.every(a => /^Attr/.test(a.type) && !/^on/i.test(htmlName(a))));
    }
    if (resource.type === 'LiquidVariableOutput') {
      const filters = resource.markup.filters;
      safe = resource.markup.expression.type === 'String' && filters.length === 2 && filters[0].name === 'asset_url'
        && filters[1].name === 'stylesheet_tag' && filters.every(f => f.args.length === 0);
    }
    if (!safe) fail('Only a literal stylesheet or font preload is supported; scripts/dynamic dependencies require review.');
    const text = source.slice(resource.position.start, resource.position.end);
    return finish(source, [
      { start: resource.position.start, end: resource.position.end, after: '' },
      { start: header.position.start, end: header.position.start, after: text + '\n' },
    ]);
  }
  if (kind === 'liquid-cache-metafield') {
    let selected, parents;
    visitAST(tree, (n, ps) => { if (n.type === 'LiquidTag' && n.name === 'assign' && n.position.start === p.assignStart) { selected = n; parents = ps; } });
    const loop = parents?.at(-2), branch = parents?.at(-1), rhs = selected?.markup?.value;
    const input = lookupPath(rhs?.expression);
    if (!selected || branch?.type !== 'LiquidBranch' || branch.name !== null || loop?.name !== 'for'
      || !/^(shop|settings|section|product|collection)\.metafields\.[\w-]+\.[\w-]+(?:\.value)?$/.test(input ?? '') || rhs.filters.length
      || loop.markup.variableName === rhs.expression.name) fail('Select a direct invariant global metafield assignment in a for loop.');
    let unsafe = false;
    visitAST(loop, n => {
      if (n !== loop && n.type === 'LiquidTag' && ['for', 'tablerow', 'render', 'include', 'liquid', 'break', 'continue', 'capture', 'increment', 'decrement'].includes(n.name)) unsafe = true;
      if (n.type === 'LiquidTag' && n.name === 'assign' && [rhs.expression.name, 'forloop'].includes(n.markup.name)) unsafe = true;
    });
    if (unsafe) fail('Shared scope, writes, nested loops or early exit make caching ambiguous.');
    // Outer loop variables can shadow Shopify objects as well.
    if (parents.some(n => n.type === 'LiquidTag' && ['for', 'tablerow'].includes(n.name) && n.markup.variableName === rhs.expression.name)) fail('Metafield root is shadowed.');
    const cache = 'perfkit_meta_' + createHash('sha256').update(source + p.assignStart).digest('hex').slice(0, 12);
    if (source.includes(cache)) fail('Cache variable collision.');
    const text = source.slice(rhs.position.start, rhs.position.end).trim();
    const original = source.slice(selected.position.start, selected.position.end);
    if (!original.startsWith('{%')) fail('Multiline liquid assignments require review.');
    const replacement = original.slice(0, rhs.position.start - selected.position.start) + cache + original.slice(rhs.position.end - selected.position.start);
    return finish(source, [{ start: selected.position.start, end: selected.position.end,
      after: `${original.startsWith('{%-') ? '{%-' : '{%'} if forloop.first %}{% assign ${cache} = ${text} %}{% endif %}${replacement}` }]);
  }
  fail('Unknown performance strategy.');
}
