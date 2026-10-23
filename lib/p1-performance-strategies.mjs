import { parse } from 'acorn';
import postcss from 'postcss';
import { liquidAST, visitAST } from './advanced-strategies.mjs';
import { htmlName, literalAttributes, hintKey, opaqueParents } from './performance-syntax.mjs';

const fail = message => { throw Object.assign(new Error(message), { code: 'UNSUPPORTED_CODE_PATTERN' }); };
const base = ['sourceHash', 'summary'];
export const p1PerformanceStrategies = [
  { kind: 'liquid-dedupe-resource-hint', targets: 'Liquid direct head links', parameters: ['firstStart', 'duplicateStart'],
    evidenceRequired: [...base, 'renderedTogether', 'responseHeadersReviewed', 'resourceTimingReviewed', 'domReferencesReviewed'],
    effect: 'Remove one exact duplicate literal preload/preconnect/dns-prefetch link while retaining the first.',
    boundary: 'Unconditional direct siblings in the same head, identical allowlisted attributes; no ID, event hooks, dynamic values or combined rel.',
    verification: ['Verify document Link headers, media and CORS mode, requests and consumers of the link nodes.', 'Compare live storefront request discovery; do not infer savings from removal alone.'] },
  { kind: 'liquid-critical-css-sync', targets: 'Liquid stylesheet links', parameters: ['tagStart'],
    evidenceRequired: [...base, 'initialViewportStylesConfirmed', 'cascadeReviewed', 'mediaAllIntended', 'domReferencesReviewed'],
    effect: 'Restore synchronous loading for a reviewed critical stylesheet using the exact print/onload pattern.',
    boundary: 'Literal or single literal asset_url href; media=print and an onload handler that only clears itself and sets media=all; no other events/disabled/alternate behavior.',
    verification: ['Verify initial paint, text/image layout, cascade, cold-cache requests and behavior with JavaScript disabled.', 'Keep any noscript fallback and compare all affected templates and viewports.'] },
  { kind: 'js-passive-listener', targets: 'assets/*.js or *.mjs', parameters: ['registrationStart'],
    evidenceRequired: [...base, 'cancellationNotRequired', 'listenerLifecycleOwned', 'capturedStateReviewed'],
    effect: 'Mark one reviewed wheel/touch input listener passive, preserving callback identity and capture=false removal.',
    boundary: 'One top-level window/document registration of a unique local zero-argument synchronous function; no calls, event access, dynamic scope, options object or aliases.',
    verification: ['Verify scrolling/gestures and first/repeated input, cleanup and re-registration.', 'Passive listeners are not a substitute for reducing expensive handler work.'] },
  { kind: 'css-transition-properties', targets: 'assets/*.css', parameters: ['selector', 'properties'],
    evidenceRequired: [...base, 'animatedPropertiesReviewed', 'allStatesReviewed', 'visualBehaviorReviewed'],
    effect: 'Replace transition-property:all with an explicit reviewed transform/opacity list.',
    boundary: 'One unique top-level class/id selector, one literal property declaration; no shorthand, important, nested rules or dynamic CSS.',
    verification: ['Verify initial, hover, focus, open/closed and responsive states including reduced motion.', 'Compare layout and presentation; do not replace arbitrary keyframes or infer a compositor guarantee.'] },
];

function finish(source, edits, type) {
  const sorted = edits.sort((a, b) => a.start - b.start);
  for (let i = 1; i < sorted.length; i++) if (sorted[i].start < sorted[i - 1].end) fail('Overlapping edits.');
  let after = source;
  for (const edit of [...sorted].reverse()) after = after.slice(0, edit.start) + edit.after + after.slice(edit.end);
  if (after === source) fail('No eligible change.');
  if (type === 'liquid') liquidAST(after);
  if (type === 'css') postcss.parse(after);
  if (type === 'js') parse(after, { ecmaVersion: 'latest', sourceType: 'module' });
  return { after, edits: sorted.map(e => ({ ...e, before: source.slice(e.start, e.end) })) };
}
const member = (node, object, property) => node?.type === 'MemberExpression' && !node.computed && !node.optional
  && node.object?.type === 'Identifier' && node.object.name === object && node.property?.name === property;

export function p1PerformanceTransform(source, target, kind, p) {
  if (kind === 'css-transition-properties') {
    if (!/^assets\/.+\.css$/.test(target) || /\{[{%]/.test(source)
      || typeof p.selector !== 'string' || !/^[.#][A-Za-z_][\w-]*$/.test(p.selector)) fail('Select one class/id in a static CSS asset.');
    if (!Array.isArray(p.properties) || !p.properties.length || p.properties.length > 2
      || p.properties.some(v => !['opacity', 'transform'].includes(v)) || new Set(p.properties).size !== p.properties.length)
      fail('Provide an explicit unique transform/opacity property list.');
    const root = postcss.parse(source), matches = [];
    root.walkRules(r => { if (r.selector.split(',').some(s => s.trim() === p.selector)) matches.push(r); });
    const rule = matches[0], declarations = rule?.nodes.filter(n => n.type === 'decl' && n.prop === 'transition-property');
    if (matches.length !== 1 || rule.parent.type !== 'root' || rule.selector !== p.selector
      || rule.nodes.some(n => n.type === 'rule' || n.type === 'atrule' || n.prop === 'transition')
      || declarations.length !== 1 || declarations[0].value !== 'all' || declarations[0].important)
      fail('Only one unconditional literal transition-property:all is supported.');
    declarations[0].value = p.properties.join(', ');
    return finish(source, [{ start: 0, end: source.length, after: root.toString() }], 'css');
  }
  if (kind === 'js-passive-listener') {
    if (!/^assets\/.+\.m?js$/.test(target)) fail('Expected a JavaScript asset.');
    const tree = parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
    const statement = tree.body.find(n => n.start === p.registrationStart && n.type === 'ExpressionStatement');
    const call = statement?.expression, receiver = call?.callee?.object?.name;
    if (call?.type !== 'CallExpression' || call.optional || !['window', 'document'].includes(receiver)
      || !member(call.callee, receiver, 'addEventListener') || ![2, 3].includes(call.arguments.length)
      || call.arguments[0]?.type !== 'Literal' || !['touchstart', 'touchmove', 'wheel'].includes(call.arguments[0].value)
      || call.arguments[1]?.type !== 'Identifier' || call.arguments[2] && !(call.arguments[2].type === 'Literal' && call.arguments[2].value === false))
      fail('Select a literal top-level input listener with a local handler and omitted/false options.');
    const handlerName = call.arguments[1].name;
    const definitions = tree.body.filter(n => n.type === 'FunctionDeclaration' && n.id?.name === handlerName);
    const handler = definitions[0];
    if (definitions.length !== 1 || handler.async || handler.generator || handler.params.length) fail('Handler must be one local synchronous zero-argument function.');
    const removals = tree.body.map(n => n.type === 'ExpressionStatement' ? n.expression : null)
      .filter(n => n?.type === 'CallExpression' && !n.optional && member(n.callee, receiver, 'removeEventListener')
        && n.arguments[0]?.value === call.arguments[0].value && n.arguments[1]?.name === handlerName
        && [2, 3].includes(n.arguments.length) && (!n.arguments[2] || n.arguments[2].type === 'Literal' && n.arguments[2].value === false));
    const allowedReferences = new Set([handler.id, call.arguments[1], ...removals.map(n => n.arguments[1])]);
    // Unknown calls/event escape would defeat a static non-cancellation check.
    visitAST(handler.body, n => {
      if (['CallExpression', 'NewExpression', 'AwaitExpression', 'YieldExpression', 'ThisExpression', 'FunctionExpression', 'ArrowFunctionExpression', 'FunctionDeclaration'].includes(n.type)
        || n.type === 'Identifier' && ['event', 'arguments', 'preventDefault', 'returnValue'].includes(n.name))
        fail('Event-dependent, calling or nested handlers require a reviewed replacement.');
    });
    visitAST(tree, (n, parents) => {
      if (n.type === 'Identifier' && n.name === handlerName && !allowedReferences.has(n)) fail('Handler aliases or extra registrations require review.');
      if (n.type === 'WithStatement' || n.type === 'Identifier' && ['eval', 'globalThis'].includes(n.name)) fail('Dynamic scope requires review.');
      if (n.type === 'Identifier' && n.name === receiver) {
        const parent = parents.at(-1);
        if (parent?.type !== 'MemberExpression' || parent.object !== n || parent.computed
          || parents.at(-2)?.type === 'AssignmentExpression' && parents.at(-2).left === parent
          || parents.at(-2)?.type === 'UpdateExpression') fail('Shadowed or mutated event receiver requires review.');
      }
    });
    const options = call.arguments[2];
    const edit = options ? { start: options.start, end: options.end, after: '{ capture: false, passive: true }' }
      : { start: call.arguments[1].end, end: call.arguments[1].end, after: ', { capture: false, passive: true }' };
    return finish(source, [edit], 'js');
  }
  if (!/^(layout|sections|snippets|blocks|templates)\/.+\.liquid$/.test(target)) fail('Expected a Liquid theme file.');
  const tree = liquidAST(source);
  const linkAt = start => {
    let result;
    visitAST(tree, (n, parents) => {
      if (n.type === 'HtmlVoidElement' && htmlName(n) === 'link' && n.position.start === start && !opaqueParents(parents)) result = { node: n, parents };
    });
    if (!result) fail('Select a live link node by its current offset.');
    return result;
  };
  if (kind === 'liquid-dedupe-resource-hint') {
    const first = linkAt(p.firstStart), duplicate = linkAt(p.duplicateStart);
    const a = literalAttributes(first.node), b = literalAttributes(duplicate.node);
    const allowed = ['rel', 'href', 'as', 'type', 'crossorigin', 'media', 'imagesrcset', 'imagesizes', 'fetchpriority', 'integrity', 'referrerpolicy'];
    if (p.firstStart >= p.duplicateStart || htmlName(first.parents.at(-1)) !== 'head' || first.parents.at(-1) !== duplicate.parents.at(-1)
      || first.parents.some(n => n.type === 'LiquidBranch') || !a || !b || hintKey(a) !== hintKey(b)
      || !['preload', 'preconnect', 'dns-prefetch'].includes(a.rel) || !a.href
      || Object.keys(a).some(k => !allowed.includes(k)))
      fail('Hints must be identical literal unconditional siblings with no DOM/event hooks.');
    return finish(source, [{ start: duplicate.node.position.start, end: duplicate.node.position.end, after: '' }], 'liquid');
  }
  if (kind === 'liquid-critical-css-sync') {
    const { node } = linkAt(p.tagStart);
    const names = node.attributes.map(a => htmlName(a)?.toLowerCase());
    if (new Set(names).size !== names.length) fail('Duplicate attributes require review.');
    // Permit a single literal asset_url expression, not arbitrary rendered hrefs.
    const href = node.attributes.find(a => htmlName(a) === 'href');
    const hrefValue = href?.value;
    const output = hrefValue?.length === 1 && hrefValue[0].type === 'LiquidVariableOutput' ? hrefValue[0] : null;
    const safeAsset = output?.markup?.expression?.type === 'String' && output.markup.filters.length === 1
      && output.markup.filters[0].name === 'asset_url' && !output.markup.filters[0].args.length;
    const attrs = literalAttributes(safeAsset ? { attributes: node.attributes.filter(a => a !== href) } : node);
    const allowed = ['rel', 'href', 'media', 'onload', 'type', 'crossorigin', 'integrity', 'referrerpolicy', 'fetchpriority'];
    if (!attrs || attrs.rel !== 'stylesheet' || attrs.media !== 'print' || !safeAsset && !attrs.href
      || Object.keys(attrs).some(k => !allowed.includes(k))
      || !/^\s*(?:this\.onload\s*=\s*null\s*;\s*)?this\.media\s*=\s*(['"])all\1\s*;?\s*$/.test(attrs.onload ?? ''))
      fail('Only the exact print/onload-to-all stylesheet pattern with a literal/asset_url href is supported.');
    return finish(source, node.attributes.filter(a => ['media', 'onload'].includes(htmlName(a)))
      .map(a => ({ start: a.position.start, end: a.position.end, after: '' })), 'liquid');
  }
  fail('Unknown P1 performance strategy.');
}
