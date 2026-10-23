import { createHash } from 'node:crypto';
import { scanTheme } from './scan.mjs';
import { readThemeSource } from './check-import.mjs';
import { maskNonRendering, htmlTagEnd, readAttributes, maskJsTrivia } from './inspect.mjs';
import { probeLink } from './resource-probe.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const blank = value => value.replace(/[^\r\n]/g, ' ');
const lineAt = (source, offset) => source.slice(0, offset).split('\n').length;
const has = (value, key) => Object.hasOwn(value, key);
const globalReads = code => [...new Set([...maskJsTrivia(code).matchAll(/\b(?:window\s*\.\s*|globalThis\s*\.\s*)?([A-Za-z_$][\w$]*)\s*(?:\.\s*[A-Za-z_$][\w$]*\s*)?\(/g)].map(m => m[1]))];
const globalWrites = code => [...new Set([...maskJsTrivia(code).matchAll(/\b(?:window|globalThis)\s*\.\s*([A-Za-z_$][\w$]*)\s*=(?!=|>)/g)].map(m => m[1]))];
export function displayUrl(value) {
  try {
    const url = new URL(value); url.username = ''; url.password = ''; url.hash = '';
    for (const key of [...url.searchParams.keys()]) if (!/^(v|width|height|format|crop|quality|dl|raw)$/.test(key)) url.searchParams.set(key, '[redacted]');
    return url.href;
  } catch { return '[unresolved URL]'; }
}
function domainClass(host) {
  const under = domain => host === domain || host.endsWith(`.${domain}`);
  if (under('dropbox.com') || under('dropboxusercontent.com') || under('drive.google.com') || under('docs.google.com')) return 'file-sharing';
  if (under('cdn.shopify.com') || under('shopifycdn.com')) return 'shopify-cdn';
  return 'external';
}
// Diagnostic lexer only: Liquid-generated attributes and branch order remain unknown.
export function analyzeResourceSource(source, file) {
  const resources = [], scripts = [], unresolved = [];
  const add = (value, type, offset) => {
    if (typeof value !== 'string' || !value) return;
    if (/[{}]/.test(value) || /&(?!(?:amp|#38|#x26);)/i.test(value)) { unresolved.push({ file, line: lineAt(source, offset), type, reason: 'Dynamic or encoded resource requires rendered HTML.' }); return; }
    value = value.replace(/&(?:amp|#38|#x26);/gi, '&');
    if (!/^(https?:)?\/\//i.test(value)) return;
    try {
      const url = new URL(value.startsWith('//') ? `https:${value}` : value);
      if (url.username || url.password) { unresolved.push({ file, line: lineAt(source, offset), type, reason: 'Credential-bearing URL is not collected or probed.' }); return; }
      resources.push({ value: url.href, type, file, line: lineAt(source, offset), protocolRelative: value.startsWith('//') });
    } catch { unresolved.push({ file, line: lineAt(source, offset), type, reason: 'Invalid URL.' }); }
  };
  const css = (code, offset) => {
    const clean = code.replace(/\/\*[\s\S]*?\*\//g, blank);
    for (let i = 0; i < clean.length;) {
      const match = clean.slice(i).match(/^(?:url\(\s*(['"]?)(.*?)\1\s*\)|@import\s+(['"])(.*?)\3)/i);
      if (match) { add(match[2] ?? match[4], 'css-resource', offset + i); i += match[0].length; }
      else if (clean[i] === '"' || clean[i] === "'") { const quote = clean[i++]; while (i < clean.length) { if (clean[i] === '\\') i += 2; else if (clean[i++] === quote) break; } }
      else i++;
    }
  };
  if (/\.css$/i.test(file)) { css(source, 0); return { resources, scripts, unresolved }; }
  if (!/\.liquid$/i.test(file)) return { resources, scripts, unresolved };
  const masked = maskNonRendering(source);
  let inert = 0;
  for (let i = 0; i < masked.length;) {
    if (masked.startsWith('{{', i) || masked.startsWith('{%', i)) {
      // Quoted Liquid may contain delimiters; scan until an unquoted closing pair.
      const close = masked[i + 1] === '{' ? '}}' : '%}'; let end = i + 2, quote = null;
      for (; end < masked.length; end++) {
        if (quote) { if (masked[end] === quote) quote = null; }
        else if ('\'"'.includes(masked[end])) quote = masked[end];
        else if (masked.startsWith(close, end)) break;
      }
      const expression = masked.slice(i, end + 2);
      const scriptTag = expression.match(/^\{\{-?\s*(['"])([^'"\n]+)\1\s*\|\s*(?:asset_url\s*\|\s*)?script_tag\s*-?\}\}$/);
      if (scriptTag) {
        const value = scriptTag[2];
        scripts.push({ id: `${file}:${i}`, file, line: lineAt(source, i), offset: i, mode: inert ? 'inert-context' : 'classic-blocking', source: /^https?:|^\/\//.test(value) ? displayUrl(value.startsWith('//') ? `https:${value}` : value) : value,
          asset: /\|\s*asset_url\b/.test(expression) ? `assets/${value}` : null, inline: false, conditional: true, syntax: 'script_tag' });
        add(value, 'script', i);
      } else if (/\|\s*script_tag\b/.test(expression)) unresolved.push({ file, line: lineAt(source, i), type: 'script', reason: 'Computed script_tag expression requires rendered output.' });
      i = end + 2; continue;
    }
    const opening = masked.slice(i).match(/^<(\/?)([a-z][\w:-]*)\b/i);
    if (!opening) { i++; continue; }
    const end = htmlTagEnd(masked, i); if (end === null) break;
    const name = opening[2].toLowerCase(), closing = !!opening[1];
    if (name === 'template') inert = Math.max(0, inert + (closing ? -1 : 1));
    if (closing) { i = end; continue; }
    const parsed = readAttributes(masked.slice(i, end), i), a = parsed.attributes;
    const uncertain = parsed.dynamic || parsed.duplicate || Object.values(a).some(v => typeof v === 'string' && /\{%/.test(v));
    if (name === 'img' || name === 'source' || name === 'video' || name === 'audio') {
      add(a.src, name === 'img' || name === 'source' ? 'image-or-media' : 'media', i); add(a.poster, 'image', i);
      if (a.srcset) {
        if (/[{}]|data:/.test(a.srcset)) unresolved.push({ file, line: lineAt(source, i), type: 'srcset', reason: 'Dynamic/data srcset needs browser selection.' });
        else for (const candidate of a.srcset.split(',')) add(candidate.trim().split(/\s+/)[0], 'srcset', i);
      }
    }
    if (name === 'link' && /\b(stylesheet|preload|modulepreload|icon)\b/i.test(a.rel ?? '')) add(a.href, 'link-resource', i);
    if (a.style) css(a.style, i);
    if (['script', 'style', 'textarea', 'title', 'xmp', 'iframe', 'noembed', 'noframes', 'noscript', 'plaintext'].includes(name)) {
      const close = new RegExp(`<\\/\\s*${name}\\s*>`, 'gi'); close.lastIndex = end;
      const match = name === 'plaintext' ? null : close.exec(masked), bodyEnd = match?.index ?? masked.length;
      if (name === 'style') css(masked.slice(end, bodyEnd), end);
      if (name === 'script') {
        const type = (a.type ?? '').trim().toLowerCase(), inline = !has(a, 'src');
        const executable = !type || /^(?:text|application)\/(?:java|ecma)script$/.test(type) || type === 'module';
        let mode = !executable ? 'data-block' : inert ? 'inert-context' : uncertain || /[{}]/.test(type) ? 'dynamic' : type === 'module' ? has(a, 'async') ? 'module-async' : 'module-deferred' : inline ? 'inline-classic' : has(a, 'async') ? 'async' : has(a, 'defer') ? 'deferred' : 'classic-blocking';
        if (/[{}]/.test(type)) mode = 'dynamic';
        const value = a.src ?? null;
        const asset = value?.match(/^\{\{-?\s*(['"])([^'"]+)\1\s*\|\s*asset_url\s*-?\}\}$/)?.[2];
        scripts.push({ id: `${file}:${i}`, file, line: lineAt(source, i), offset: i, mode, inline, conditional: true,
          source: value && /^(https?:)?\/\//.test(value) ? displayUrl(value.startsWith('//') ? `https:${value}` : value) : value ? (asset ? `assets/${asset}` : '[local-or-dynamic]') : null,
          asset: asset ? `assets/${asset}` : null, syntax: 'script', nomodule: has(a, 'nomodule'),
          referencedGlobals: inline && executable ? globalReads(source.slice(end, bodyEnd)) : [],
          bodyHash: inline ? hash(source.slice(end, bodyEnd)) : null });
        if (executable && !asset) add(value, 'script', i);
      }
      i = match ? match.index + match[0].length : masked.length; continue;
    }
    i = end;
  }
  return { resources, scripts, unresolved };
}

export async function auditResources({ project, probe = false } = {}) {
  const scan = await scanTheme({ project });
  const resources = new Map(), scripts = [], unresolved = [], findings = [], errors = [...scan.errors], providers = new Map();
  for (const file of scan.inventory.files.filter(f => /\.(liquid|css|m?js)$/i.test(f.path) && !f.path.startsWith('config/'))) {
    try {
      const { source } = await readThemeSource(scan.project, file.path, file.sha256);
      if (/\.m?js$/i.test(file.path)) providers.set(file.path, globalWrites(source));
      const result = analyzeResourceSource(source, file.path);
      for (const item of result.resources) {
        let entry = resources.get(item.value);
        if (!entry) { const url = new URL(item.value); entry = { id: hash(item.value), url: displayUrl(item.value), host: url.hostname, classification: domainClass(url.hostname), mixedContentCandidate: url.protocol === 'http:', references: [], network: { status: 'not-probed' } }; resources.set(item.value, entry); }
        entry.references.push({ file: item.file, line: item.line, type: item.type, sourceHash: file.sha256, protocolRelative: item.protocolRelative });
      }
      scripts.push(...result.scripts.map(s => ({ ...s, sourceHash: file.sha256 }))); unresolved.push(...result.unresolved);
    } catch { errors.push({ file: file.path, reason: 'Source changed, unavailable or exceeds analysis bounds.' }); }
  }
  const addFinding = (ruleId, item, summary, verification, evidence) => findings.push({ id: `${ruleId}-${findings.length + 1}`, ruleId, file: item.file, line: item.line, sourceHash: item.sourceHash, status: 'candidate', priority: null, summary, verification, evidence });
  const relationships = [];
  for (const script of scripts) script.providedGlobals = providers.get(script.asset) ?? [];
  const previous = new Map();
  for (const script of scripts) {
    if (script.mode === 'classic-blocking') addFinding('JS_BLOCKING', script, 'Classic external script may block HTML parsing when this branch renders.', ['Confirm actual script type and rendered branch.', 'Check following inline consumers and first interaction before choosing defer/async.'], [{ scriptId: script.id }]);
    const prior = previous.get(script.file);
    const symbolProviders = script.mode === 'inline-classic' ? scripts.filter(p => p.file === script.file && p.offset < script.offset && !['inert-context', 'data-block'].includes(p.mode) && p.providedGlobals.some(g => script.referencedGlobals?.includes(g))) : [];
    for (const provider of symbolProviders) relationships.push({ from: provider.id, to: script.id, status: 'symbol-candidate', globals: provider.providedGlobals.filter(g => script.referencedGlobals.includes(g)), reason: 'Lexical window/globalThis assignment and later call share a name. Scope, branches, readiness and actual execution still require browser verification.' });
    if (script.mode === 'inline-classic' && prior) {
      const relation = { from: prior.id, to: script.id, status: 'order-candidate', reason: 'Nearest preceding external executable script in the same source file; symbol dependency and branch co-occurrence are not proven.' };
      if (!symbolProviders.some(p => p.id === prior.id)) relationships.push(relation);
      addFinding('JS_ORDER', script, prior.mode === 'classic-blocking' ? 'Changing the preceding script to defer may move it after this inline code.' : 'Inline code may run before the preceding async/deferred/module script.', ['Identify the actual provided globals and consumers.', 'Verify cold-cache first interaction, errors, repeated instances and section reload.', 'Use real dependency readiness; do not fix with a timer.'], [relation]);
    }
    if (!script.inline && !['inert-context', 'data-block'].includes(script.mode)) previous.set(script.file, script);
  }
  let probed = 0;
  for (const [value, resource] of resources) {
    if (resource.mixedContentCandidate || resource.classification === 'file-sharing') addFinding('EXT_RESOURCE', resource.references[0], resource.mixedContentCandidate ? 'HTTP resource may be blocked or upgraded on an HTTPS storefront.' : 'File-sharing host requires direct-resource and availability review.', ['Check actual response type, redirect chain, cache policy and failure fallback.', 'Preserve image content, crop and responsive variants when planning migration.'], [{ resourceId: resource.id, references: resource.references }]);
    if (probe && probed++ < 40) {
      resource.network = await probeLink(value);
      const htmlResponse = /text\/html/i.test(resource.network.contentType ?? '');
      if (resource.network.status !== 'reachable-headers' || htmlResponse) addFinding('EXT_RESPONSE', resource.references[0], htmlResponse ? 'Resource URL returned HTML headers; verify that this is a direct asset URL.' : 'Header check could not verify resource availability.', ['Inspect the actual browser request, response type and fallback. HEAD restrictions are not proof of a broken link.'], [{ resourceId: resource.id, network: resource.network }]);
    }
  }
  const knownFiles = new Set(scan.inventory.files.map(f => f.path));
  for (const script of scripts) if (script.asset) script.assetStatus = knownFiles.has(script.asset) ? 'resolved' : 'missing-or-uninventoried';
  return { schemaVersion: 1, kind: 'resource-audit', project: scan.project, complete: scan.complete && errors.length === 0, resources: [...resources.values()], scripts, relationships, sourceManifest: scan.inventory.files.map(f => ({ file: f.path, sourceHash: f.sha256 })),
    moduleDependencies: scan.dependencies.filter(d => d.type === 'javascript-import'), unresolved, findings, errors,
    summary: { resources: resources.size, scripts: scripts.length, orderCandidates: relationships.length, unresolved: unresolved.length, probeRequested: probe, probed: [...resources.values()].filter(r => r.network.status !== 'not-probed').length },
    limitations: ['Static references and source order do not prove runtime dependency, execution order, duplicate transfers, page reachability or performance loss.',
      'Source scanning covers literal HTML attributes, simple script_tag and CSS URLs; JS-created URLs, arbitrary Liquid helpers, configuration values, template-inserted content and cross-snippet execution order require runtime inspection.',
      'Module imports reuse the lexical scan; module graph semantics and imports inside inline modules are not evaluated.',
      'Optional probes send HEAD only, at most 40 URLs, with bounded redirects/timeouts and no cookies. Headers do not prove image decoding, browser CORS, runtime availability or a durable SLA.',
      'No migration or script rewriting is performed. External does not mean slow or removable. Query values are redacted except common resource selectors.'] };
}
