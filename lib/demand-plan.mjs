import path from 'node:path';
import { parse } from 'acorn';
import postcss from 'postcss';
import { liquidAST, visitAST } from './advanced-strategies.mjs';
import { indexThemeSources } from './source-attribution.mjs';
import { requireHypothesis } from './bottlenecks.mjs';
import { createSitePlan } from './site-changes.mjs';
import { normalizeEvidenceUrl } from './run-evidence.mjs';

const fail = message => { throw Object.assign(new Error(message),{ code: 'DEMAND_PLAN_UNSUPPORTED' }); };
const nameOf = node => typeof node.name === 'string' ? node.name : node.name?.map(n => n.value ?? '?').join('');
const globals = new Set('HTMLElement customElements window document globalThis console Math JSON Object Array Set Map WeakSet WeakMap String Number Boolean Date RegExp Error TypeError Promise Symbol URL URLSearchParams Event CustomEvent EventTarget AbortController IntersectionObserver ResizeObserver MutationObserver requestAnimationFrame cancelAnimationFrame setTimeout clearTimeout setInterval clearInterval queueMicrotask requestIdleCallback cancelIdleCallback getComputedStyle fetch performance navigator location CSS Node Element HTMLButtonElement HTMLInputElement Intl undefined NaN Infinity parseInt parseFloat isNaN'.split(' '));
// A moved classic declaration also stops being a global binding. Include member
// and string lookups, which lexical free-reference analysis cannot resolve.
function mentionsSymbol(text, names) {
  return names.some(name => new RegExp(`(^|[^\\p{ID_Continue}$])${name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}(?![\\p{ID_Continue}$])`,'u').test(text));
}
function bindings(pattern, set) {
  if (!pattern) return;
  if (pattern.type === 'Identifier') set.add(pattern.name);
  else if (pattern.type === 'RestElement') bindings(pattern.argument,set);
  else if (pattern.type === 'AssignmentPattern') bindings(pattern.left,set);
  else if (pattern.type === 'ArrayPattern') pattern.elements.forEach(n => bindings(n,set));
  else if (pattern.type === 'ObjectPattern') pattern.properties.forEach(n => bindings(n.value ?? n.argument,set));
}
function directBindings(nodes, scope) {
  for (const n of nodes) {
    if (n.type === 'VariableDeclaration') n.declarations.forEach(d => bindings(d.id,scope));
    if (['FunctionDeclaration','ClassDeclaration'].includes(n.type) && n.id) scope.add(n.id.name);
  }
}
/** Lexical free-reference analysis, including defaults, destructuring and nested scopes. */
export function freeReferences(root) {
  const refs = new Set();
  const walk = (node, scopes, parent, key) => {
    if (!node?.type) return;
    let own;
    if (/Function/.test(node.type) || node.type === 'ArrowFunctionExpression') {
      own = new Set(node.type === 'ArrowFunctionExpression' ? [] : ['arguments']); if (node.id) own.add(node.id.name); node.params.forEach(n => bindings(n,own));
      const hoist = n => { if (n !== node && (/Function/.test(n.type) || n.type === 'ArrowFunctionExpression')) return;
        if (n.type === 'VariableDeclaration' && n.kind === 'var') n.declarations.forEach(d => bindings(d.id,own));
        for (const [k,v] of Object.entries(n)) if (!['start','end','loc'].includes(k)) { if (Array.isArray(v)) v.forEach(x => { if (x?.type) hoist(x); }); else if (v?.type) hoist(v); }
      }; hoist(node.body);
    } else if (['BlockStatement','Program'].includes(node.type)) { own = new Set(); directBindings(node.body,own); }
    else if (['ClassDeclaration','ClassExpression'].includes(node.type)) { own = new Set(node.id ? [node.id.name] : []); }
    else if (node.type === 'CatchClause') { own = new Set(); bindings(node.param,own); }
    else if (['ForStatement','ForOfStatement','ForInStatement'].includes(node.type)) { own = new Set(); directBindings([node.init ?? node.left].filter(Boolean),own); }
    if (own) scopes = [...scopes,own];
    if (node.type === 'Identifier') {
      const nonReference = (['MemberExpression','PropertyDefinition','MethodDefinition'].includes(parent?.type) && key === (parent.type === 'MemberExpression' ? 'property' : 'key') && !parent.computed)
        || (parent?.type === 'Property' && key === 'key' && !parent.computed)
        || ['BreakStatement','ContinueStatement','LabeledStatement'].includes(parent?.type)
        || key === 'id' || (key === 'param' && parent?.type === 'CatchClause');
      if (!nonReference && !scopes.some(s => s.has(node.name))) refs.add(node.name);
      return;
    }
    for (const [k,v] of Object.entries(node)) {
      if (['start','end','loc'].includes(k)) continue;
      if (Array.isArray(v)) v.forEach(n => walk(n,scopes,node,k)); else if (v?.type) walk(v,scopes,node,k);
    }
  };
  walk(root,[]); return refs;
}

function componentExtraction(text, tag) {
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)+$/.test(tag)) fail('Select a literal custom-element tag.');
  const tree = parse(text,{ ecmaVersion: 'latest', sourceType: 'module', locations: true });
  if (tree.body.some(n => /^(Import|Export)/.test(n.type))) fail('Module imports/exports require a reviewed dependency migration.');
  visitAST(tree,n => { if (n.type === 'Identifier' && ['eval','Function'].includes(n.name)) fail('Dynamic scope may reference moved symbols.'); });
  const registrations = tree.body.filter(n => n.type === 'ExpressionStatement' && n.expression.type === 'CallExpression'
    && n.expression.callee.type === 'MemberExpression' && !n.expression.callee.computed && n.expression.callee.object.name === 'customElements'
    && n.expression.callee.property.name === 'define' && n.expression.arguments[0]?.value === tag);
  if (registrations.length !== 1 || registrations[0].expression.arguments.length !== 2) fail('Requires one top-level customElements.define(tag, LocalClass) registration.');
  const registration = registrations[0], name = registration.expression.arguments[1]?.name;
  const component = tree.body.find(n => n.type === 'ClassDeclaration' && n.id.name === name && n.superClass?.name === 'HTMLElement');
  if (!component) fail('Requires a local class extending HTMLElement; imported/inherited/exported components need a reviewed refactor.');
  if (component.body.body.some(n => n.static || n.computed || n.type === 'StaticBlock')) fail('Static/computed class initialization cannot be relocated automatically.');
  const definitions = new Map();
  for (const n of tree.body) {
    if (['ClassDeclaration','FunctionDeclaration'].includes(n.type)) definitions.set(n.id.name,n);
    if (n.type === 'VariableDeclaration') for (const d of n.declarations) if (d.id.type === 'Identifier') definitions.set(d.id.name,n);
  }
  for (const runtime of ['customElements','HTMLElement','document','globalThis','MutationObserver','CustomEvent','Symbol']) if (definitions.has(runtime)) fail(`Shadowed browser runtime ${runtime} needs a reviewed refactor.`);
  const selected = new Set([component,registration]), names = new Set([name]), pending = [component];
  while (pending.length) for (const ref of freeReferences(pending.pop())) {
    if (names.has(ref)) continue;
    const dependency = definitions.get(ref);
    if (!dependency) { if (!globals.has(ref)) fail(`Unresolved component dependency: ${ref}`); continue; }
    const primitive = dependency.type === 'VariableDeclaration' && dependency.kind === 'const' && dependency.declarations.length === 1
      && dependency.declarations[0].id.type === 'Identifier' && dependency.declarations[0].init?.type === 'Literal'
      && ['string','number','boolean'].includes(typeof dependency.declarations[0].init.value);
    if (dependency.type !== 'FunctionDeclaration' && !primitive) fail(`Shared state or side-effectful dependency ${ref} requires a reviewed refactor.`);
    names.add(ref); selected.add(dependency); pending.push(dependency);
  }
  for (const node of tree.body) if (!selected.has(node)) for (const ref of freeReferences(node)) if (names.has(ref)) fail(`Component symbol ${ref} has another consumer; automatic movement would break its dependency.`);
  // Dynamic scope and document-relative/current-script assumptions cannot be preserved by relocation.
  for (const node of selected) visitAST(node,n => {
    if (n.type === 'Identifier' && ['eval','Function'].includes(n.name) || n.type === 'MetaProperty'
      || n.type === 'MemberExpression' && (['currentScript','write','writeln'].includes(n.property.name ?? n.property.value))) fail('Dynamic scope/currentScript/document.write requires a custom refactor.');
  });
  const nodes = [...selected].sort((a,b) => a.start-b.start);
  const moved = nodes.map(n => text.slice(n.start,n.end)).join('\n');
  let remaining = text; for (const node of [...nodes].reverse()) remaining = remaining.slice(0,node.start)+remaining.slice(node.end);
  if (mentionsSymbol(remaining,[...names])) fail('Remaining script contains an indirect/global component consumer; review its API before extraction.');
  return { component, nodes, names: [...names], moved, remaining, strict: tree.body.some(n => n.directive === 'use strict') };
}

// Existing initial HTML scripts stay parser-discovered and defer-ordered. This small bridge
// handles later Section Rendering API insertions whose innerHTML scripts are inert.
function sectionBridge(tag) {
  return `\n;(() => {\n  const key = Symbol.for(${JSON.stringify(`perfkit:section:${tag}`)});\n  if (globalThis[key]) return;\n  const selector = 'script[data-perf-component="${tag}"]';\n  let loading = false;\n  const load = scope => {\n    if (customElements.get('${tag}') || loading) return;\n    const source = scope.matches?.(selector) ? scope : scope.querySelector?.(selector);\n    if (!source?.src) return;\n    loading = true;\n    const script = document.createElement('script');\n    script.src = source.src;\n    if (source.nonce) script.nonce = source.nonce;\n    script.onload = () => { loading = false; script.remove(); };\n    script.onerror = () => { loading = false; script.remove(); document.dispatchEvent(new CustomEvent('perfkit:component-error', { detail: { tag: '${tag}' } })); };\n    document.head.append(script);\n  };\n  const observer = new MutationObserver(records => { for (const record of records) for (const node of record.addedNodes) if (node.nodeType === 1) load(node); });\n  observer.observe(document.documentElement, { childList: true, subtree: true });\n  document.addEventListener('shopify:section:load', event => load(event.target));\n  globalThis[key] = true;\n})();\n`;
}

export async function createDemandPlan({ project, config, diagnosis, profiles = [] } = {}) {
  if (!config || config.schemaVersion !== 1 || !['component','critical-css'].includes(config.mode)
    || Object.keys(config).some(k => !['schemaVersion','mode','source','newAsset','component','candidateId','loaderTarget','tagStart','inlineLoadHandlerAllowed'].includes(k))) fail('Invalid demand plan config.');
  if (!/^assets\/[\w.-]+\.(m?js|css)$/.test(config.source ?? '') || !/^assets\/[A-Za-z0-9_-][\w.-]*\.(m?js|css)$/.test(config.newAsset ?? '') || config.newAsset === config.source) fail('Select distinct direct JS/CSS asset paths.');
  const index = await indexThemeSources(project), hypothesis = requireHypothesis(diagnosis,config.candidateId,index.snapshot,config.source);
  const source = index.files.find(f => f.file === config.source)?.text; if (source === undefined) fail('Source not found.');
  const evidence = { summary: hypothesis.evidence, diagnosisSourceHash: diagnosis.sourceHash, candidateId: config.candidateId, hypothesis: { metric: hypothesis.metric, file: hypothesis.file, line: hypothesis.line, kind: hypothesis.kind } };
  const change = (target, replacementText, kind = 'reviewed-replacement') => ({ target, replacementText, kind, reason: `Demand loading for measured ${hypothesis.kind}: ${config.source}`, evidence });
  const changes = [];
  if (config.mode === 'component') {
    if (!config.source.endsWith('.js') || !config.newAsset.endsWith('.js') || hypothesis.kind !== 'cpu') fail('Component extraction needs a measured JS CPU candidate and classic .js assets.');
    const extraction = componentExtraction(source,config.component);
    if (index.edges.some(e => e.to === config.source && ['js-import','js-import-map'].includes(e.kind))) fail('An imported script cannot be migrated as a classic component asset.');
    const measuredOffset=hypothesis.source.offset ?? (source.split('\n').slice(0,Math.max(0,hypothesis.line-1)).reduce((n,line)=>n+line.length+1,0)+Math.max(0,(hypothesis.source.column??1)-1));
    if (!Number.isInteger(hypothesis.line) || !extraction.nodes.some(n => measuredOffset >= n.start && measuredOffset < n.end)) fail('Selected component is outside the measured CPU location.');
    const sites = [];
    for (const file of index.files.filter(f => f.file.endsWith('.liquid'))) {
      const offsets = [];
      let tree; try { tree = liquidAST(file.text); } catch { fail(`Unparsed Liquid file may contain a component consumer: ${file.file}`); }
      visitAST(tree,(n,parents) => {
        if (n.type === 'HtmlRawNode' && nameOf(n) === 'script') {
          if (mentionsSymbol(n.body?.value ?? '',extraction.names) || (n.body?.value ?? '').includes(config.component)) fail(`Inline/dynamic component consumer in ${file.file} needs review before extraction.`);
          const attrs = new Map(n.attributes?.map(a => [nameOf(a),a]));
          if (attrs.get('type')?.value?.[0]?.value === 'module' && attrs.get('src')?.value?.some(v => v.markup?.expression?.value === path.posix.basename(config.source))) fail('Module loader requires a reviewed migration, even when the source has no imports.');
        }
        if (/^(?:Html)?Attr/.test(n.type) && /^on/i.test(nameOf(n)) && mentionsSymbol(file.text.slice(n.position.start,n.position.end),extraction.names)) fail(`Inline event consumer in ${file.file} needs review before extraction.`);
        if (n.type === 'HtmlElement' && nameOf(n) === config.component) {
          if (parents.some(p => nameOf(p) === 'template')) fail('Inert template content requires an explicit activation refactor.');
          offsets.push(n.position.start);
        }
      });
      if (offsets.length) sites.push({ file, offsets });
    }
    if (!sites.length) fail('No static Liquid component render sites found.');
    for (const file of index.files.filter(f => /\.m?js(?:\.liquid)?$/.test(f.file) && f.file !== config.source)) {
      if (mentionsSymbol(file.text,extraction.names) || file.text.includes(config.component)) fail(`External/dynamic consumer in ${file.file} needs review before extraction.`);
    }
    // Same-file JS markup factories are equally opaque.
    if (extraction.remaining.includes(config.component)) fail('Remaining script contains dynamic component consumers.');
    const newName = path.posix.basename(config.newAsset);
    changes.push(change(config.source,extraction.remaining+sectionBridge(config.component)));
    changes.push(change(config.newAsset,`(() => {\n${extraction.strict ? "'use strict';\n" : ''}if (customElements.get('${config.component}')) return;\n${extraction.moved}\n})();\n`,'create-asset'));
    for (const { file,offsets } of sites) {
      let after = file.text;
      const script = `<script src="{{ '${newName}' | asset_url }}" defer data-perf-component="${config.component}"></script>`;
      for (const offset of offsets.sort((a,b) => b-a)) after = after.slice(0,offset)+script+after.slice(offset);
      changes.push(change(file.file,after));
    }
  } else {
    if (!config.source.endsWith('.css') || !config.newAsset.endsWith('.css') || hypothesis.kind !== 'render-resource' || config.inlineLoadHandlerAllowed !== true) fail('Critical CSS requires measured render blocking and a CSP-reviewed inline load handler.');
    const valid = profiles.filter(p => p.kind === 'runtime-profile' && p.status === 'complete' && p.sourceStable && p.snapshot?.hash === index.snapshot.hash);
    if (valid.length !== profiles.length || new Set(valid.map(p => p.config.device)).size < 2 || !valid.some(p => p.config.actions?.length)) fail('Provide current-source mobile, desktop and interactive-state coverage; a single initial viewport is insufficient.');
    const ranges = [];
    for (const p of valid) {
      const entries = p.coverage?.css?.filter(c => c.sourceHash === index.snapshot.files.find(f => f.file === config.source).sourceHash && c.status === 'observed');
      if (!entries?.length) fail('Every declared coverage state must include the exact CSS source.');
      for (const c of entries) for (const r of c.ranges) { if (!Number.isInteger(r.start) || !Number.isInteger(r.end) || r.start < 0 || r.end > source.length || r.end < r.start) fail('Invalid CSS coverage range.'); ranges.push(r); }
    }
    const root = postcss.parse(source);
    if (root.nodes.some(n => n.type === 'atrule' && ['import','charset','namespace','layer'].includes(n.name))) fail('CSS imports/layers/namespace ordering needs a reviewed migration.');
    // Analyze CSS rule usage across profiles to identify shared vs page-specific rules
    const ruleUsage = new Map(); // ruleStartOffset -> { profiles: Set, totalStates: number }
    for (const [profileIndex,p] of valid.entries()) {
      const entries = p.coverage?.css?.filter(c => c.sourceHash === index.snapshot.files.find(f => f.file === config.source).sourceHash && c.status === 'observed');
      for (const c of entries ?? []) {
        for (const r of c.ranges) {
          // Find which top-level rule this range belongs to
          for (const rule of root.nodes.filter(n => r.start < n.source.end.offset+1 && r.end > n.source.start.offset)) {
            const key = rule.source.start.offset;
            if (!ruleUsage.has(key)) ruleUsage.set(key, { profiles: new Set(), pages: new Set(), rule });
            ruleUsage.get(key).profiles.add(profileIndex);
            ruleUsage.get(key).pages.add(normalizeEvidenceUrl(p.config.url));
          }
        }
      }
    }
    const totalProfiles = valid.length;
    const totalPages = new Set(valid.map(p=>normalizeEvidenceUrl(p.config.url))).size;
    const critical = root.nodes.filter(n => {
      let global = n.type === 'atrule' && ['font-face','keyframes','-webkit-keyframes','property'].includes(n.name);
      n.walkDecls?.(d => { if (d.prop.startsWith('--')) global = true; });
      if (global) return true;
      // Include rules used in any profile
      return ranges.some(r => r.start < n.source.end.offset+1 && r.end > n.source.start.offset);
    }).map(n => n.toString()).join('\n');
    // Generate CSS analysis report for shared vs page-specific rules
    const cssAnalysis = {
      totalRules: root.nodes.length,
      sharedRules: [], // Used across every captured profile
      pageSpecificRules: [], // Observed on only one of multiple captured pages
      partialStateRules: [], // Used in some, but not every captured state/device
      unusedRules: [] // Not used in any profile
    };
    for (const [offset, usage] of ruleUsage) {
      const ruleInfo = {
        selector: usage.rule.toString().split('{')[0].trim(),
        startOffset: offset,
        usedInProfiles: usage.profiles.size,
        totalProfiles,
        usedInPages: usage.pages.size, totalPages,
        usageRatio: usage.profiles.size / totalProfiles
      };
      if (usage.profiles.size === totalProfiles) cssAnalysis.sharedRules.push(ruleInfo);
      else cssAnalysis.partialStateRules.push(ruleInfo);
      if (totalPages > 1 && usage.pages.size === 1) cssAnalysis.pageSpecificRules.push(ruleInfo);
    }
    // Find completely unused rules
    for (const node of root.nodes) {
      if (node.type === 'atrule') continue;
      if (!ruleUsage.has(node.source.start.offset)) {
        cssAnalysis.unusedRules.push({
          selector: node.toString().split('{')[0].trim(),
          startOffset: node.source.start.offset
        });
      }
    }
    if (!critical.trim() || Buffer.byteLength(critical) >= Buffer.byteLength(source)*0.8) fail('Coverage leaves less than 20% removable blocking CSS; no supported split candidate.');
    const loader = index.files.find(f => f.file === config.loaderTarget);
    if (!loader?.file.endsWith('.liquid')) fail('Select a Liquid stylesheet loader.');
    let tag; visitAST(liquidAST(loader.text),n => { if (['HtmlVoidElement','LiquidVariableOutput'].includes(n.type) && n.position.start === config.tagStart) tag = n; });
    const attrs = new Map(tag?.attributes?.map(a => [nameOf(a),a]));
    const value = attrs.get('href')?.value, rel = attrs.get('rel')?.value;
    const isFilter=tag?.type==='LiquidVariableOutput';
    if (isFilter) {
      const raw=loader.text.slice(tag.position.start,tag.position.end), literal=path.posix.basename(config.source).replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
      const allowed=new RegExp(`^\\{\\{-?\\s*(['"])${literal}\\1\\s*\\|\\s*asset_url\\s*\\|\\s*stylesheet_tag(?:\\s*:\\s*preload\\s*:\\s*(?:true|false))?\\s*-?\\}\\}$`);
      if (!allowed.test(raw)) fail('stylesheet_tag supports only a literal asset_url and optional preload boolean.');
    } else if (tag?.name !== 'link' || tag.attributes.length !== 2 || rel?.length !== 1 || rel[0].value !== 'stylesheet'
      || value?.length !== 1 || value[0].markup?.expression?.value !== path.posix.basename(config.source) || value[0].markup.filters?.length !== 1 || value[0].markup.filters[0].name !== 'asset_url') fail('Select a plain stylesheet link or Shopify stylesheet_tag with the exact asset_url source.');
    const original=loader.text.slice(tag.position.start,tag.position.end);
    const head = original.replace(path.posix.basename(config.source),path.posix.basename(config.newAsset));
    // Keep preload on the critical asset only. A noscript Liquid stylesheet_tag
    // could still emit a server-side preload hint for the complete stylesheet.
    const full=isFilter?`<link rel="stylesheet" href="{{ '${path.posix.basename(config.source)}' | asset_url }}">`:original;
    const tail = full.replace(/>$/,` media="print" onload="this.media='all'">`);
    const after = loader.text.slice(0,tag.position.start)+head+'\n'+tail+'\n<noscript>'+full+'</noscript>'+loader.text.slice(tag.position.end);
    changes.push(change(config.newAsset,critical+'\n','create-asset'),change(loader.file,after));
    // Pass CSS analysis as plan metadata (included in planHash for integrity)
    return createSitePlan({ project, recipe: { schemaVersion: 1, changes }, metadata: { cssAnalysis, cssAnalysisNote: 'Shared means every captured state/device; page-specific means one of multiple captured pages. Absence in captured coverage never proves global non-use.' } });
  }
  return createSitePlan({ project, recipe: { schemaVersion: 1, changes } });
}
