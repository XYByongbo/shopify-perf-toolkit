import { toLiquidHtmlAST } from '@shopify/liquid-html-parser';
import { parse } from 'acorn';
import postcss from 'postcss';
import { createHash } from 'node:crypto';

const fail = message => { throw Object.assign(new Error(message), { code: 'UNSUPPORTED_CODE_PATTERN' }); };
export function visitAST(node, fn, parents = []) {
  if (!node || typeof node !== 'object') return;
  if (node.type) fn(node, parents);
  for (const [key, value] of Object.entries(node)) {
    if (['source','_source','parent','position'].includes(key)) continue;
    if (Array.isArray(value)) value.forEach(child => visitAST(child, fn, [...parents, node]));
    else if (value?.type) visitAST(value, fn, [...parents, node]);
  }
}
export function liquidAST(source) {
  try { return toLiquidHtmlAST(source, { mode: 'strict' }); } catch (e) { fail(`Shopify Liquid HTML parse failed: ${e.message}`); }
}
const nameOf = n => typeof n.name === 'string' ? n.name : n.name?.map(x => x.value ?? '?').join('');
const attrs = n => new Map((n.attributes ?? []).map(a => [nameOf(a).toLowerCase(), a]));
const literal = attr => attr?.value?.every(n => n.type === 'TextNode') ? attr.value.map(n => n.value).join('') : null;
const edit = (source, start, end, after) => ({ start, end, before: source.slice(start, end), after });
export const advancedStrategies = [
  { kind: 'js-idle-init', targets: 'assets/*.js or *.mjs', parameters: ['statementStart','timeoutMs'],
    evidenceRequired: ['sourceHash','summary','nonCritical','noFirstInteractionDependency','timingChangeReviewed'],
    effect: 'Schedule one selected noncritical initialization call with requestIdleCallback and a bounded fallback.',
    boundary: 'Top-level zero-argument call to a local synchronous function. Never defer LCP, consent or first-interaction dependencies.', verification: ['Exercise page load, first interaction and teardown with and without requestIdleCallback.'] },
  { kind: 'liquid-defer-script', targets: 'Liquid theme files', parameters: ['tagStart'],
    evidenceRequired: ['sourceHash','summary','dependenciesReviewed','nonCritical','documentWriteAbsent'], effect: 'Add defer to one external classic script using Shopify parser offsets.',
    boundary: 'No inline body, async, module, dynamic attributes or existing defer.', verification: ['Verify dependency order, inline consumers, load errors and first interaction on every affected template.'] },
  { kind: 'liquid-scope-resource', targets: 'Liquid theme files', parameters: ['tagStart','pageTypes'],
    evidenceRequired: ['sourceHash','summary','dependenciesReviewed','pageCoverageReviewed'], effect: 'Load a selected script/stylesheet only on explicitly reviewed request.page_type values.',
    boundary: 'Static script/link attribute names; content_for_header contexts stay protected.', verification: ['Check included and excluded templates, app embeds, editor events and first interaction.'] },
  { kind: 'css-font-display', targets: 'assets/*.css', parameters: ['family','display'],
    evidenceRequired: ['sourceHash','summary','fontUsageReviewed','fallbackMetricsReviewed'], effect: 'Set swap or optional on one selected @font-face.',
    boundary: 'Exact unique font-family; inspect font swap and fallback layout before accepting.', verification: ['Compare cold/warm font loading, text LCP, fallback typography and CLS across breakpoints.'] },
  { kind: 'css-font-fallback', targets: 'assets/*.css', parameters: ['selector','family','local','sizeAdjust','ascentOverride','descentOverride','lineGapOverride'],
    evidenceRequired: ['sourceHash','summary','fontMetricsMeasured'], effect: 'Create a measured local fallback face and insert it after the primary family in one selected font stack.',
    boundary: 'Measured metrics and one unique top-level class/id rule with a literal font-family stack; no shorthand, dynamic value or important override.', verification: ['Verify the actual fallback is used and text wrapping and CLS match in supported browsers.'] },
  { kind: 'liquid-cache-loop-filter', targets: 'Liquid theme files', parameters: ['assignStart'],
    evidenceRequired: ['sourceHash','summary','profileHotspotConfirmed','loopScopeReviewed'], effect: 'Compute a pure loop-invariant assignment once on forloop.first and reuse it inside the same loop.',
    boundary: 'A direct loop-body assignment, immutable literal/global inputs and allowlisted pure filters; retain empty-loop behavior.', verification: ['Compare empty/short/long collections and variable scope; repeat Shopify Liquid profiling.'] },
];
const pages = new Set(['index','product','collection','list-collections','page','blog','article','cart','search','404','password','gift_card','policy']);

export function advancedTransform(source, target, kind, p) {
  let edits;
  if (kind === 'js-idle-init') {
    if (!/^assets\/.+\.m?js$/.test(target)) fail('Expected a JS asset.');
    const tree = parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
    const statement = tree.body.find(n => n.start === p.statementStart && n.type === 'ExpressionStatement');
    const call = statement?.expression;
    const fn = tree.body.find(n => n.type === 'FunctionDeclaration' && n.id?.name === call?.callee?.name);
    if (call?.type !== 'CallExpression' || call.optional || call.callee.type !== 'Identifier' || call.arguments.length || !fn || fn.async || fn.generator || fn.params.length) fail('Select a top-level zero-argument call to a local synchronous function.');
    if (!Number.isSafeInteger(p.timeoutMs) || p.timeoutMs < 1 || p.timeoutMs > 5000) fail('timeoutMs must be 1..5000.');
    visitAST(tree, n => { if ((n.type === 'Identifier' && ['globalThis','eval'].includes(n.name)) || (n.type === 'Identifier' && n.name === call.callee.name && n !== fn.id && n !== call.callee)) fail('Shadowed runtime, dynamic scope or another handler reference requires manual review.'); });
    const invocation = source.slice(statement.start, statement.end);
    edits = [edit(source, statement.start, statement.end, `if (typeof globalThis.requestIdleCallback === 'function') {\n  globalThis.requestIdleCallback(() => { ${invocation} }, { timeout: ${p.timeoutMs} });\n} else {\n  globalThis.setTimeout(() => { ${invocation} }, 1);\n}`)];
  } else if (kind.startsWith('css-')) {
    if (!/^assets\/.+\.css$/.test(target) || /\{[{%]/.test(source)) fail('Expected a non-templated CSS asset.');
    if (typeof p.family !== 'string' || !/^[\w -]{1,80}$/.test(p.family)) fail('Invalid literal font family.');
    const root = postcss.parse(source);
    if (kind === 'css-font-display') {
      if (!['swap','optional'].includes(p.display)) fail('display must be swap or optional.');
      const faces = []; root.walkAtRules('font-face', n => { if (n.nodes?.some(d => d.prop === 'font-family' && d.value.replace(/^["']|["']$/g, '') === p.family)) faces.push(n); });
      if (faces.length !== 1) fail('Font family must identify exactly one @font-face; split weight/variation faces require separate reviewed changes.');
      const existing = faces[0].nodes.filter(n => n.prop === 'font-display');
      if (existing.length > 1 || existing[0]?.important) fail('Ambiguous font-display declaration.');
      if (existing.length) existing[0].value = p.display; else faces[0].append({ prop: 'font-display', value: p.display });
    } else {
      if (typeof p.local !== 'string' || !/^[\w -]{1,80}$/.test(p.local)) fail('Invalid local fallback face.');
      for (const key of ['sizeAdjust','ascentOverride','descentOverride','lineGapOverride']) if (typeof p[key] !== 'number' || !Number.isFinite(p[key]) || p[key] < 0 || p[key] > 300) fail('Font metrics must be measured percentages in 0..300.');
      if (p.sizeAdjust <= 0 || source.replace(/\s+/g,' ').toLowerCase().includes(p.family.replace(/\s+/g,' ').toLowerCase())) fail('Fallback family must be new and sizeAdjust positive.');
      if(typeof p.selector!=='string'||!/^[.#][A-Za-z_][\w-]*$/.test(p.selector))fail('Select one explicit class/id font stack.');
      root.walkDecls(d=>{if(d.prop.toLowerCase()==='font-family'&&(/[\\]/.test(d.value)||d.value.includes('/*')))fail('Escaped or commented font names require explicit collision review.');});
      const rules=[];root.walkRules(r=>{if(r.selector.split(',').some(s=>s.trim()===p.selector))rules.push(r);});
      const rule=rules[0],families=rule?.nodes.filter(n=>n.type==='decl'&&n.prop.toLowerCase()==='font-family');
      if(rules.length!==1||rule.parent.type!=='root'||rule.selector!==p.selector||families.length!==1
        ||rule.nodes.some(n=>n.type!=='decl'&&n.type!=='comment'||n.prop?.toLowerCase()==='font')||families[0].important)
        fail('Fallback needs one unconditional literal font-family declaration without shorthand.');
      const stack=families[0].value.split(',').map(s=>s.trim());
      if(stack.some(s=>! /^(?:"[\w -]+"|'[\w -]+'|[A-Za-z][\w -]*)$/.test(s))
        || /^(inherit|initial|unset|revert|revert-layer|serif|sans-serif|monospace|system-ui|cursive|fantasy|ui-serif|ui-sans-serif|ui-monospace|ui-rounded|emoji|math|fangsong)$/i.test(stack[0].replace(/^["']|["']$/g,'')))
        fail('Fallback requires an explicit named primary font and a static font-family list.');
      stack.splice(1,0,`"${p.family}"`);families[0].value=stack.join(', ');
      root.append(postcss.parse(`@font-face { font-family: "${p.family}"; src: local("${p.local}"); size-adjust: ${p.sizeAdjust}%; ascent-override: ${p.ascentOverride}%; descent-override: ${p.descentOverride}%; line-gap-override: ${p.lineGapOverride}%; }`).nodes);
    }
    edits = [edit(source, 0, source.length, root.toString())];
  } else {
    if (!/^(sections|snippets|layout|templates|blocks)\/.+\.liquid$/.test(target)) fail('Expected a Liquid theme file.');
    const tree = liquidAST(source); let selected, parents;
    visitAST(tree, (n, ancestors) => { if (n.position?.start === (p.tagStart ?? p.assignStart)
      && (kind === 'liquid-cache-loop-filter' ? n.type === 'LiquidTag' && n.name === 'assign' : ['HtmlRawNode','HtmlVoidElement'].includes(n.type))) { selected = n; parents = ancestors; } });
    if (!selected) fail('Selected parser node not found.');
    if (kind === 'liquid-cache-loop-filter') {
      const branch = parents.at(-1), loop = parents.at(-2), assignment = selected.markup;
      if (branch?.type !== 'LiquidBranch' || branch.name !== null || loop?.name !== 'for' || loop.type !== 'LiquidTag') fail('Assignment must be directly inside a for body.');
      const rhs = assignment.value, refs = new Set(), writes = new Set();
      const pure = new Set(['downcase','upcase','escape','escape_once','strip','strip_newlines','handleize','default','append','prepend','replace','split','join','sort','where','map','compact','uniq','size','plus','minus','times','divided_by','round','ceil','floor']);
      if (!rhs?.filters?.length || rhs.filters.some(f => !pure.has(f.name))) fail('Only explicitly pure filter chains can be cached.');
      visitAST(rhs, n => { if (n.type === 'VariableLookup') { if (!['settings','shop','collection','product','section'].includes(n.name) || n.lookups?.some(x => !['String','Number'].includes(x.type))) fail('Filter inputs must be stable literal/global paths.'); refs.add(n.name); } });
      visitAST(loop, n => { if (n.type === 'LiquidTag' && ['assign','capture','increment','decrement','for'].includes(n.name)) writes.add(n.markup?.name ?? n.markup?.variableName ?? n.markup); if (n.type === 'LiquidTag' && ['include','liquid','break','continue'].includes(n.name)) fail('Opaque, shared-scope or early-exit tags inside the loop are refused.'); });
      if ([...refs].some(r => writes.has(r))) fail('Filter input is reassigned within the loop.');
      if(writes.has('forloop'))fail('The loop metadata is reassigned; a first-iteration cache guard is unsafe.');
      let cache = `perfkit_cache_${createHash('sha256').update(source + p.assignStart).digest('hex').slice(0, 12)}`;
      if (source.includes(cache)) fail('Cache name already present.');
      const a = selected.position.start, b = selected.position.end, original = source.slice(a, b), expression = source.slice(rhs.position.start, rhs.position.end).trim();
      const replacement = original.slice(0, rhs.position.start - a) + cache + original.slice(rhs.position.end - a);
      const prefix = `${original.startsWith('{%-') ? '{%-' : '{%'} if forloop.first %}{% assign ${cache} = ${expression} %}{% endif %}`;
      edits = [edit(source, a, b, prefix + replacement)];
    } else {
      const name = nameOf(selected), attributes = attrs(selected);
      if ((selected.attributes ?? []).some(a => !/^Attr/.test(a.type) || nameOf(a).includes('?')) || new Set([...attributes.keys()]).size !== selected.attributes.length) fail('Dynamic or duplicate attribute names require manual review.');
      if (kind === 'liquid-defer-script') {
        if (name !== 'script' || !attributes.has('src') || attributes.has('async') || attributes.has('defer') || (attributes.has('type') && !['text/javascript','application/javascript'].includes(literal(attributes.get('type')))) || selected.body?.value.trim()) fail('Only an external blocking classic script without inline body is supported.');
        const at = selected.blockStartPosition.end - 1;
        edits = [edit(source, at, at, ' defer')];
      } else {
        if (!Array.isArray(p.pageTypes) || !p.pageTypes.length || new Set(p.pageTypes).size !== p.pageTypes.length || p.pageTypes.some(t => !pages.has(t))) fail('Select known unique request.page_type values.');
        if (!(name === 'script' && attributes.has('src') && !selected.body?.value.trim()) && !(name === 'link' && literal(attributes.get('rel')) === 'stylesheet' && attributes.has('href'))) fail('Select one external script or stylesheet link.');
        const original = source.slice(selected.position.start, selected.position.end);
        const condition = p.pageTypes.map(t => `request.page_type == '${t}'`).join(' or ');
        edits = [edit(source, selected.position.start, selected.position.end, `{% if ${condition} %}${original}{% endif %}`)];
      }
    }
  }
  let after = source;
  for (const e of [...edits].sort((a, b) => b.start - a.start)) after = after.slice(0, e.start) + e.after + after.slice(e.end);
  if (after === source) fail('No source change.');
  if (kind.startsWith('liquid-')) liquidAST(after);
  if (kind.startsWith('js-')) parse(after, { ecmaVersion: 'latest', sourceType: 'module' });
  return { after, edits };
}
