import {upgradeStrategies,upgradeTransform} from './upgrade-strategies.mjs';
import { sha256 as sha } from './source-utils.mjs';
import { parse } from 'acorn';
import postcss from 'postcss';
import { readTarget } from './changes.mjs';
import { codeStrategies } from './code-strategy-catalog.mjs';
import { advancedStrategies, advancedTransform, liquidAST, visitAST } from './advanced-strategies.mjs';
import { performanceStrategies, performanceTransform } from './performance-strategies.mjs';
import { p1PerformanceStrategies, p1PerformanceTransform } from './p1-performance-strategies.mjs';
import { officialMethodsForExecutor } from './official-methods.mjs';
import { inspectPerformanceSource } from './performance-rules.mjs';
import {parseLiquidAsset,restoreLiquidEdits} from './liquid-assets.mjs';

const fail = (message, code = 'UNSUPPORTED_CODE_PATTERN') => { throw Object.assign(new Error(message), { code }); };
const isId = (node, name) => node?.type === 'Identifier' && (name === undefined || node.name === name);
function walk(node, fn, parent = null) {
  if (!node || typeof node !== 'object') return;
  if (typeof node.type === 'string') fn(node, parent);
  for (const [key, value] of Object.entries(node)) {
    if (key === 'parent') continue;
    if (Array.isArray(value)) {
      for (const child of value) if (child?.type) walk(child, fn, node);
    } else if (value?.type) walk(value, fn, node);
  }
}
function editsResult(source, edits, verification) {
  const sorted = [...edits].sort((a, b) => a.start - b.start);
  let end = 0;
  for (const edit of sorted) {
    if (edit.start < end || source.slice(edit.start, edit.end) !== edit.before) fail('Overlapping or stale strategy edits.');
    end = edit.end;
  }
  let after = source;
  for (const edit of [...sorted].reverse()) after = after.slice(0, edit.start) + edit.after + after.slice(edit.end);
  if (after === source) fail('No eligible change.', 'NO_CHANGE');
  return { after, edits: sorted, verification };
}
function jsTree(source) {
  try { return parse(source, { ecmaVersion: 2022, sourceType: 'module', allowHashBang: true }); }
  catch (error) { fail(`JavaScript parse failed: ${error.message}`, 'CODE_PARSE_ERROR'); }
}
function member(node, object, property) {
  return node?.type === 'MemberExpression' && !node.computed && !node.optional && isId(node.object, object) && isId(node.property, property);
}
function bindingNames(node, into) {
  if (!node) return;
  if (isId(node)) into.push(node);
  else if (node.type === 'RestElement') bindingNames(node.argument, into);
  else if (node.type === 'AssignmentPattern') bindingNames(node.left, into);
  else if (node.type === 'ArrayPattern') node.elements.forEach(n => bindingNames(n, into));
  else if (node.type === 'ObjectPattern') node.properties.forEach(n => bindingNames(n.type === 'RestElement' ? n.argument : n.value, into));
}
function jsTransform(source, parameters) {
  const tree = jsTree(source), records = [], bindings = [], identifiers = new Set();
  walk(tree, (n, p) => {
    records.push([n, p]);
    if (isId(n)) identifiers.add(n.name);
    if (n.type === 'VariableDeclarator') bindingNames(n.id, bindings);
    if (/Function/.test(n.type) || n.type === 'ArrowFunctionExpression') { if (n.id) bindings.push(n.id); n.params.forEach(x => bindingNames(x, bindings)); }
    if (/^Class/.test(n.type) && n.id) bindings.push(n.id);
    if (/^Import.*Specifier$/.test(n.type)) bindings.push(n.local);
    if (n.type === 'CatchClause') bindingNames(n.param, bindings);
    if ((n.type === 'CallExpression' && isId(n.callee, 'eval')) || n.type === 'WithStatement') fail('Dynamic scope cannot be transformed.');
  });
  if (!Number.isSafeInteger(parameters.registrationStart)) fail('registrationStart must be an exact source offset.');
  const statement = tree.body.find(n => n.start === parameters.registrationStart && n.type === 'ExpressionStatement');
  const call = statement?.expression;
  if (call?.type !== 'CallExpression' || call.optional || !member(call.callee, 'window', 'addEventListener')) fail('Select a top-level window.addEventListener statement.');
  const [event, callback, options] = call.arguments;
  if (event?.type !== 'Literal' || !['scroll', 'resize'].includes(event.value) || !isId(callback) || call.arguments.length > 3) fail('Only scroll/resize and a named callback are supported.');
  const handler = tree.body.find(n => n.type === 'FunctionDeclaration' && n.id.name === callback.name);
  if (!handler || handler.async || handler.generator || handler.params.length) fail('Handler must be a top-level synchronous zero-argument function declaration.');
  const reserved = new Set(['window', 'requestAnimationFrame', 'cancelAnimationFrame', 'undefined']);
  if (bindings.some(n => reserved.has(n.name)) || bindings.filter(n => n.name === callback.name).length !== 1) fail('Runtime APIs or handler name are shadowed.');
  const validOptions = n => !n || (n.type === 'Literal' && n.value === false) || (n.type === 'ObjectExpression' && n.properties.length === 1
    && n.properties[0].type === 'Property' && !n.properties[0].computed && !n.properties[0].method && n.properties[0].kind === 'init'
    && ((isId(n.properties[0].key, 'passive')) || n.properties[0].key.value === 'passive') && n.properties[0].value.type === 'Literal' && n.properties[0].value.value === true);
  if (!validOptions(options)) fail('Only default capture=false or {passive:true} are supported; once/signal are refused.');
  walk(handler.body, n => {
    if (n.type === 'ThisExpression' || n.type === 'Super' || (isId(n) && ['arguments', 'event'].includes(n.name))
      || member(n, 'window', 'event') || member(n, 'globalThis', 'event')) fail('Event/receiver-sensitive handlers cannot be deferred.');
  });
  const uses = new Set([handler.id, callback]), removals = [];
  for (const [n, p] of records) {
    if (n.type !== 'CallExpression' || !member(n.callee, 'window', 'removeEventListener') || !isId(n.arguments[1], callback.name)) continue;
    if (p.type !== 'ExpressionStatement' || n.optional || n.arguments.length > 3 || n.arguments[0]?.value !== event.value
      || (n.arguments[2] && !(n.arguments[2].type === 'Literal' && n.arguments[2].value === false)) || p.start <= statement.end) fail('Unsupported callback removal or capture mode.');
    uses.add(n.arguments[1]); removals.push([n, p]);
  }
  if (records.some(([n]) => isId(n, callback.name) && !uses.has(n))) fail('Callback aliases, other registrations, mutations or direct calls require manual review.');
  let suffix = 0, stem;
  do { stem = `__perfRaf${suffix++}`; } while ([...identifiers].some(n => n.startsWith(stem)));
  const id = `${stem}Id`, listener = `${stem}Listener`;
  const generated = `let ${id} = null;\nfunction ${listener}() {\n  if (${id} === null) {\n    ${id} = requestAnimationFrame(() => {\n      ${id} = null;\n      ${callback.name}();\n    });\n  }\n}\n`;
  const add = source.slice(statement.start, callback.start) + listener + source.slice(callback.end, statement.end);
  const edits = [{ start: statement.start, end: statement.end, before: source.slice(statement.start, statement.end), after: generated + add }];
  for (const [remove, parent] of removals) {
    const arg = remove.arguments[1];
    const changed = source.slice(parent.start, arg.start) + listener + source.slice(arg.end, parent.end);
    edits.push({ start: parent.start, end: parent.end, before: source.slice(parent.start, parent.end),
      after: `{ ${changed}\nif (${id} !== null) { cancelAnimationFrame(${id}); ${id} = null; } }` });
  }
  const result = editsResult(source, edits); jsTree(result.after); return result;
}
function cssTree(source) {
  if (/\{[{%]/.test(source)) fail('Templated CSS requires a reviewed replacement.');
  try { return postcss.parse(source); } catch (e) { fail(`CSS parse failed: ${e.reason}`, 'CODE_PARSE_ERROR'); }
}
function duplicateDeclarations(root) {
  const found = [];
  root.walkRules(rule => {
    for (let i = 1; i < rule.nodes.length; i++) {
      const a = rule.nodes[i - 1], b = rule.nodes[i];
      if (a.type === 'decl' && b.type === 'decl' && !a.prop.startsWith('--') && a.toString() === b.toString()) found.push(a);
    }
  });
  return found;
}
function cssTransform(source, kind, p) {
  const root = cssTree(source);
  if (kind === 'css-dedupe-declarations') duplicateDeclarations(root).forEach(n => n.remove());
  else {
    if (typeof p.selector !== 'string' || !/^\.[A-Za-z_][\w-]*$/.test(p.selector) || !Number.isSafeInteger(p.intrinsicBlockSize)
      || p.intrinsicBlockSize < 1 || p.intrinsicBlockSize > 100000) fail('Select one simple class and an intrinsicBlockSize integer in 1..100000 px.');
    const rules = []; root.walkRules(p.selector, n => rules.push(n));
    if (rules.length !== 1 || rules[0].parent.type !== 'root' || rules[0].nodes.some(n => !['decl', 'comment'].includes(n.type))) fail('Selector must identify one top-level flat rule.');
    const rule = rules[0];
    if (rule.nodes.some(n => n.type === 'decl' && /^(contain(?:-|$)|content-visibility$|position$)/i.test(n.prop))) fail('Existing containment or position requires manual review.');
    const display = rule.nodes.filter(n => n.type === 'decl' && n.prop.toLowerCase() === 'display');
    if (display.length !== 1 || display[0].value !== 'flow-root') fail('An existing display:flow-root layout boundary is required; verify effective styles and margins in a browser.');
    rule.append({ prop: 'content-visibility', value: 'auto' }, { prop: 'contain-intrinsic-block-size', value: `auto ${p.intrinsicBlockSize}px` });
  }
  const after = root.toString();
  return editsResult(source, [{ start: 0, end: source.length, before: source, after }]);
}

// A deliberately small Liquid lexer. Quotes and opaque raw/comment/schema blocks
// are consumed before looking for a candidate, so inert text never becomes code.
function liquidTokens(source) {
  const tokens = []; let offset = 0;
  while (offset < source.length) {
    const match = /\{[{%]/g; match.lastIndex = offset; const opening = match.exec(source); if (!opening) break;
    const start = opening.index, output = opening[0] === '{{', close = output ? '}}' : '%}';
    let quote = null, end = start + 2;
    for (; end < source.length; end++) {
      if (quote) { if (source[end] === quote) quote = null; }
      else if (source[end] === '"' || source[end] === "'") quote = source[end];
      else if (source.startsWith(close, end)) break;
    }
    if (end >= source.length) fail('Unterminated Liquid token.', 'CODE_PARSE_ERROR');
    end += 2; const raw = source.slice(start, end), content = raw.slice(2, -2).replace(/^-|-$|^\s+|\s+$/g, '').trim();
    const name = output ? 'output' : content.split(/\s/)[0];
    if (['raw', 'comment', 'schema', 'javascript', 'stylesheet', 'doc'].includes(name)) {
      const terminator = new RegExp('\\{%-?\\s*end' + name + '\\s*-?%\\}', 'g'); terminator.lastIndex = end;
      const last = terminator.exec(source); if (!last) fail(`Unterminated ${name} block.`, 'CODE_PARSE_ERROR');
      if (name === 'comment' && /\{%-?\s*comment\s*-?%\}/.test(source.slice(end, last.index))) fail('Nested comment blocks require manual review.', 'CODE_PARSE_ERROR');
      tokens.push({ start, end: last.index + last[0].length, name: 'opaque', content: '' }); offset = last.index + last[0].length; continue;
    }
    tokens.push({ start, end, name, content, raw }); offset = end;
  }
  return tokens;
}
function liquidCandidate(source, tokens, index) {
  const start = tokens[index];
  const forMatch = start.content.match(/^for\s+([A-Za-z_]\w*)\s+in\s+([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)$/);
  const guard = tokens[index + 1];
  const limit = guard?.content.match(/^if\s+forloop\.index\s*<=\s*([1-9]\d*)$/);
  if (!forMatch || !limit || Number(limit[1]) > 50 || !/^\s*$/.test(source.slice(start.end, guard.start))) fail('Expected a simple for followed directly by if forloop.index <= N (1..50).');
  if (['forloop', 'tablerowloop'].includes(forMatch[1])) fail('Reserved loop variable.');
  let cursor = index + 2;
  while (tokens[cursor]?.name === 'output') cursor++;
  const endif = tokens[cursor], endfor = tokens[cursor + 1];
  if (endif?.content !== 'endif' || endfor?.content !== 'endfor' || !/^\s*$/.test(source.slice(endif.end, endfor.start))) fail('Only output expressions are supported inside the sole guard; no tags, else, side effects or nested loops.');
  if (![start, guard, endif, endfor].every(t => t.raw.startsWith('{%-') && t.raw.endsWith('-%}'))) fail('All four boundary tags must trim both sides to preserve whitespace.');
  const body = source.slice(guard.end, endif.start);
  // Drop quoted literals before checking references, but refuse whole-drop,
  // bracket access and metadata whose meaning changes after limiting the loop.
  for (const token of tokens.slice(index + 2, cursor)) {
    const expression = token.content.replace(/'[^']*'|"[^"]*"/g, '');
    if (/\bforloop\b/.test(expression.replace(/\bforloop\.(?:index0|index|first)\b/g, ''))) fail('Loop metadata outside index/index0/first depends on full collection length.');
  }
  return { start: start.start, end: endfor.end, before: source.slice(start.start, endfor.end),
    after: `{%- for ${forMatch[1]} in ${forMatch[2]} limit: ${Number(limit[1])} -%}${body}{%- endfor -%}`, limit: Number(limit[1]) };
}

export function transformCode({ source, target, kind, parameters = {}, evidence }) {
  const strategy = codeStrategies.find(s => s.kind === kind); if (!strategy) fail('Unknown code strategy.');
  if (!evidence || evidence.sourceHash !== sha(source) || typeof evidence.summary !== 'string' || !evidence.summary.trim()) fail('Evidence must bind the current sourceHash and explain the proposed change.', 'MISSING_CODE_EVIDENCE');
  for (const key of strategy.evidenceRequired.filter(k => !['sourceHash', 'summary'].includes(k))) if (evidence[key] !== true) fail(`Explicit ${key}=true evidence is required.`, 'MISSING_CODE_EVIDENCE');
  if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters) || Object.keys(parameters).some(k => !strategy.parameters.includes(k))) fail('Unknown strategy parameters.', 'INVALID_CODE_PARAMETERS');
  if(/^assets\/.+\.m?js\.liquid$/.test(target)) {
    if(!['js-idle-init','js-raf-listener','js-passive-listener'].includes(kind))fail('This JS strategy does not support Liquid template assets.');
    const model=parseLiquidAsset(source),translated={...parameters};
    for(const key of ['statementStart','registrationStart'])if(key in translated){translated[key]=model.javascriptOffset(translated[key]);if(translated[key]===null)fail('Strategy targets a Liquid value slot.');}
    const generated=transformCode({source:model.javascript,target:target.slice(0,-7),kind,parameters:translated,evidence:{...evidence,sourceHash:sha(model.javascript)}});
    return {...restoreLiquidEdits(model,generated.edits),verification:generated.verification};
  }
  let result;
  if (upgradeStrategies.some(s => s.kind === kind)) result = upgradeTransform(source,target,kind,parameters);
  else if (performanceStrategies.some(s => s.kind === kind)) result = performanceTransform(source, target, kind, parameters, evidence);
  else if (p1PerformanceStrategies.some(s => s.kind === kind)) result = p1PerformanceTransform(source, target, kind, parameters);
  else if (advancedStrategies.some(s => s.kind === kind)) result = advancedTransform(source, target, kind, parameters);
  else if (kind.startsWith('js-')) { if (!/^assets\/.+\.m?js$/.test(target)) fail('JS strategy requires an assets JS/MJS file.'); result = jsTransform(source, parameters); }
  else if (kind.startsWith('css-')) { if (!/^assets\/.+\.css$/.test(target)) fail('CSS strategy requires an assets CSS file.'); result = cssTransform(source, kind, parameters); }
  else {
    if (!/^(?:sections|snippets|layout|templates|blocks)\/.+\.liquid$/.test(target) || !Number.isSafeInteger(parameters.loopStart)) fail('Liquid strategy requires a Liquid file and loopStart offset.');
    const tokens = liquidTokens(source), index = tokens.findIndex(t => t.start === parameters.loopStart && t.name === 'for');
    if (index < 0) fail('Selected loop is missing or inside opaque text.');
    const { limit, ...edit } = liquidCandidate(source, tokens, index); result = editsResult(source, [edit]);
  }
  return { ...result, verification: strategy.verification };
}

export async function analyzeCode({ project, target }) {
  const { source, root } = await readTarget(project, target), sourceHash = sha(source), candidates = [], rejected = [];
  const candidate = (kind, parameters) => {
    const strategy = codeStrategies.find(s => s.kind === kind);
    // Exercise structural validation without presenting review flags as evidence.
    const structuralEvidence = Object.fromEntries(strategy.evidenceRequired.map(k => [k, true]));
    try {
      const result = transformCode({ source, target, kind, parameters, evidence: { ...structuralEvidence, sourceHash, summary: 'Structural eligibility only; not a reviewed optimization.' } });
      candidates.push({ kind, parameters, status: 'candidate-needs-evidence', sourceHash,
        byteDelta: Buffer.byteLength(result.after) - Buffer.byteLength(source), evidenceRequired: strategy.evidenceRequired,
        recipe: { target, kind, parameters, reason: '', evidence: { sourceHash, summary: '' } }, verification: strategy.verification });
    } catch (e) { rejected.push({ kind, parameters, code: e.code, reason: e.message }); }
  };
  if (/^assets\/.+\.m?js(?:\.liquid)?$/.test(target)) {
    const model=target.endsWith('.liquid')?parseLiquidAsset(source):null,tree = jsTree(model?.javascript??source),offset=n=>model?model.sourceOffset(n):n;
    for (const n of tree.body) if (member(n.expression?.callee, 'window', 'addEventListener')) candidate('js-raf-listener', { registrationStart: offset(n.start) });
    for (const n of tree.body) if (n.expression?.type === 'CallExpression' && n.expression.callee.type === 'Identifier') candidate('js-idle-init', { statementStart: offset(n.start), timeoutMs: 2000 });
  } else if (/^assets\/.+\.css$/.test(target)) {
    if (duplicateDeclarations(cssTree(source)).length) candidate('css-dedupe-declarations', {});
    // Offscreen state and size cannot be inferred from CSS; never auto-suggest.
  } else if (/^(?:sections|snippets|layout|templates|blocks)\/.+\.liquid$/.test(target)) {
    for (const token of liquidTokens(source)) if (token.name === 'for') candidate('liquid-limit-guarded-loop', { loopStart: token.start });
    try { visitAST(liquidAST(source), (n, ancestors) => {
      if (n.type === 'HtmlRawNode' && n.name === 'script') candidate('liquid-defer-script', { tagStart: n.position.start });
      if (n.type === 'LiquidTag' && n.name === 'assign' && ancestors.at(-2)?.name === 'for') candidate('liquid-cache-loop-filter', { assignStart: n.position.start });
    }); } catch (e) { rejected.push({ kind: 'liquid-parser', code: e.code, reason: e.message }); }
  } else fail('Unsupported code target.');
  const performance = inspectPerformanceSource({source,file:target,sourceHash});
  const reviewTasks = performance.findings.map(f => {
    const detail=f.evidence[0]??{};
    const parameters={
      'liquid-image-tag-loading':{outputStart:f.offset,loading:null},
      'liquid-hoist-head-resource':{resourceStart:f.offset},
      'liquid-cache-metafield':{assignStart:f.offset},
      'css-lcp-reveal':{selector:detail.selector},
      'liquid-picture-pair':{desktopStart:detail.desktopOffset,mobileStart:detail.mobileOffset,breakpoint:null,desktopWidths:[],mobileWidths:[],sizes:null,className:null},
      'liquid-dedupe-resource-hint':{firstStart:detail.firstStart,duplicateStart:detail.duplicateStart},
      'liquid-critical-css-sync':{tagStart:f.offset},
      'js-passive-listener':{registrationStart:detail.registrationStart},
      'css-transition-properties':{selector:detail.selector,properties:[]},
      'css-font-display':{family:detail.family,display:null},
      'css-font-fallback':{selector:null,family:null,local:null,sizeAdjust:null,ascentOverride:null,descentOverride:null,lineGapOverride:null},
    }[f.suggestedStrategy]??{};
    return {...f,evidenceRequired:codeStrategies.find(s=>s.kind===f.suggestedStrategy)?.evidenceRequired??[],
      recipe:f.suggestedStrategy?{target,kind:f.suggestedStrategy,parameters,reason:'',evidence:{sourceHash,summary:''}}:null};
  });
  if(/\.liquid$/.test(target))try{visitAST(liquidAST(source),n=>{
    if(n.type==='LiquidVariableOutput'&&n.markup?.filters?.some(f=>f.name==='font_face')){
      const strategy=codeStrategies.find(s=>s.kind==='liquid-font-display');
      reviewTasks.push({file:target,offset:n.position.start,suggestedStrategy:strategy.kind,status:'review-required',evidenceRequired:strategy.evidenceRequired,
        recipe:{target,kind:strategy.kind,parameters:{outputStart:n.position.start,display:null},reason:'',evidence:{sourceHash,summary:''}},verification:strategy.verification});
    }
  });}catch{}
  for(const item of candidates)item.officialMethods=officialMethodsForExecutor('site:'+item.kind);
  for(const item of reviewTasks)item.officialMethods=officialMethodsForExecutor('site:'+item.suggestedStrategy);
  return { schemaVersion: 1, kind: 'code-analysis', project: root, target, sourceHash, candidates, rejected, reviewTasks, performanceIssues:performance.issues,
    summary: { candidates: candidates.length, rejected: rejected.length, reviewTasks:reviewTasks.length, performanceIssues:performance.issues.length },
    limitations: ['Structural candidates are not confirmed bottlenecks, safe behavior or measured score gains.', 'No browser, network, source writes or media downloads occurred. Offscreen CSS requires an explicit reviewed recipe.'] };
}
