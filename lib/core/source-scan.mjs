import { lineAt } from './source-utils.mjs';
import { beginSourceAnalysis } from './source-analysis.mjs';
import { readdir, lstat, realpath, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isUtf8 } from 'node:buffer';
import path from 'node:path';
import { createHash } from 'node:crypto';

const THEME_DIRS = new Set(['assets', 'blocks', 'config', 'layout', 'locales', 'sections', 'snippets', 'templates']);
const SOURCE_DIRS = new Set(['assets', 'blocks', 'layout', 'sections', 'snippets', 'templates']);
const MAX_SOURCE_BYTES = 5 * 1024 * 1024;
const MAX_FILES = 10000;
const inside = (root, value) => { const rel = path.relative(root, value); return rel && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel); };
const blank = (value) => value.replace(/[^\r\n]/g, ' ');

const kindOf = (file) => /\.liquid$/i.test(file) ? 'liquid' : /\.(m?js|cjs)$/i.test(file) ? 'javascript' : /\.css$/i.test(file) ? 'css' : /\.json$/i.test(file) ? 'json' : /\.(png|jpe?g|gif|webp|avif|svg|ico)$/i.test(file) ? 'image' : /\.(woff2?|ttf|otf|eot)$/i.test(file) ? 'font' : /\.(mp4|webm|mov|mp3|ogg|wav)$/i.test(file) ? 'media' : 'other';
const safeMessage = (error) => error?.code ? `Filesystem error: ${error.code}.` : 'Unable to read or analyze this file.';

// JSON comments are replaced with whitespace, not removed: quoted URLs and offsets survive.
function stripJsonComments(source) {
  let out = '', i = 0, quoted = false;
  while (i < source.length) {
    if (quoted) {
      if (source[i] === '\\') { out += source.slice(i, i + 2); i += 2; }
      else { if (source[i] === '"') quoted = false; out += source[i++]; }
    } else if (source[i] === '"') { quoted = true; out += source[i++]; }
    else if (source.startsWith('//', i)) { const end = source.indexOf('\n', i + 2); const stop = end < 0 ? source.length : end; out += blank(source.slice(i, stop)); i = stop; }
    else if (source.startsWith('/*', i)) { const end = source.indexOf('*/', i + 2); if (end < 0) throw new Error('Unterminated JSON comment.'); out += blank(source.slice(i, end + 2)); i = end + 2; }
    else out += source[i++];
  }
  return out.replace(/^\uFEFF/, ' ');
}

function liquidTokens(source) {
  const tokens = [];
  let i = 0;
  while (i < source.length) {
    if (!source.startsWith('{%', i) && !source.startsWith('{{', i)) { i++; continue; }
    const start = i, output = source[i + 1] === '{', close = output ? '}}' : '%}';
    let quote = null;
    i += 2;
    while (i < source.length) {
      if (quote) { if (source[i] === quote) quote = null; i++; }
      else if (source.startsWith(close, i)) { i += 2; break; }
      else { if (source[i] === '"' || source[i] === "'") quote = source[i]; i++; }
    }
    const content = source.slice(start + 2, i - 2).replace(/^-/, '').replace(/-$/, '').trim();
    const excluded = !output && content.match(/^(comment|schema|raw)\b/);
    if (excluded) {
      const end = new RegExp(`\\{%-?\\s*end${excluded[1]}\\s*-?%\\}`, 'g'); end.lastIndex = i;
      const match = end.exec(source); i = match ? match.index + match[0].length : source.length;
    } else if (!content.startsWith('#')) tokens.push({ content, start, output });
  }
  return tokens;
}

function maskQuoted(source) {
  let out = '', quote = null;
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (quote) { out += /[\r\n]/.test(char) ? char : ' '; if (char === quote) quote = null; }
    else if (char === '"' || char === "'") { quote = char; out += ' '; }
    else out += char;
  }
  return out;
}

// Tokenize the limited import grammar without interpreting strings/comments as code.
function codeTokens(source) {
  const tokens = []; let i = 0;
  while (i < source.length) {
    if (/\s/.test(source[i])) { i++; continue; }
    if (source.startsWith('//', i)) { const end = source.indexOf('\n', i + 2); i = end < 0 ? source.length : end; continue; }
    if (source.startsWith('/*', i)) { const end = source.indexOf('*/', i + 2); i = end < 0 ? source.length : end + 2; continue; }
    const start = i;
    if ('"\'`'.includes(source[i])) {
      const quote = source[i++]; let value = '', escaped = false;
      while (i < source.length && source[i] !== quote) { if (source[i] === '\\') { escaped = true; value += source.slice(i, i + 2); i += 2; } else value += source[i++]; }
      const closed = source[i] === quote; if (closed) i++;
      tokens.push({ type: quote === '`' ? 'template' : 'string', value, start, literal: closed && !escaped });
    } else if (/[A-Za-z_$]/.test(source[i])) {
      i++; while (i < source.length && /[\w$]/.test(source[i])) i++;
      tokens.push({ type: 'id', value: source.slice(start, i), start });
    } else tokens.push({ type: 'punct', value: source[i++], start });
  }
  return tokens;
}

/** Whole-theme read-only inventory and conservative static dependency scan. */
export async function scanInventory(options) {
  return inventory(options);
}

/** Re-read bytes across the full inventory scope without running any source analysis. */
export async function fingerprintThemeInventory(project) {
  return (await inventory({project}, true)).files;
}

async function inventory({ project, pages = [], onSource = null, analysis } = {}, fingerprintsOnly = false) {
  if (typeof project !== 'string' || !project || project.includes('\0')) throw new Error('project must be a non-empty filesystem path.');
  if (!Array.isArray(pages) || pages.some((page) => typeof page !== 'string' || !/^https?:\/\//i.test(page))) throw new Error('pages must be an array of explicit HTTP(S) page URLs.');
  const suppliedPages = [...new Set(pages)].map((url) => { const parsed = new URL(url); if (parsed.username || parsed.password) throw new Error('Page URLs must not contain credentials.'); return parsed.href; });
  const root = await realpath(project);
  if (!(await lstat(root)).isDirectory()) throw new Error('project must be a directory.');
  const retain = analysis === undefined ? null : beginSourceAnalysis(analysis, root);
  const files = [], errors = [], skipped = [], dependencyMap = new Map(), appIndicators = [];
  let capped = false;
  const addError = (file, code, message) => errors.push({ file, code, message });
  const addDependency = (from, type, name, reference, options = {}) => {
    let to = null, reason = options.reason ?? null, status = 'unresolved';
    if (typeof name === 'string' && name) {
      const clean = name.split(/[?#]/)[0];
      if (/^(?:https?:)?\/\//i.test(clean) || /^(?:data|blob|shopify):/i.test(clean)) reason = 'External or platform resource; not resolved to a local theme file.';
      else if (options.relative && !clean.startsWith('.') && !clean.startsWith('/') && type === 'javascript-import') reason = 'Bare module specifier requires bundler/import-map resolution.';
      else {
        const resolved = options.relative ? path.posix.normalize(clean.startsWith('/') ? clean.slice(1) : path.posix.join(path.posix.dirname(from), clean)) : path.posix.normalize(clean);
        if (resolved.includes('\\') || resolved === '..' || resolved.startsWith('../') || !THEME_DIRS.has(resolved.split('/')[0])) reason = 'Reference cannot be resolved safely inside a theme directory.';
        else to = resolved;
      }
    }
    const key = JSON.stringify([from, type, to, reason]);
    let edge = dependencyMap.get(key);
    if (!edge) { edge = { from, to, type, status, references: [], ...(reason ? { reason } : {}) }; dependencyMap.set(key, edge); }
    if (!edge.references.some((entry) => JSON.stringify(entry) === JSON.stringify(reference))) edge.references.push(reference);
  };
  const liquidDependencies = (file, source) => {
    for (const token of liquidTokens(source)) {
      const lines = /^liquid\b/.test(token.content) ? token.content.replace(/^liquid\b/, '').split('\n') : [token.content];
      let relativeLine = 0;
      for (const expression of lines) {
        const text = expression.trim(), line = lineAt(source, token.start) + relativeLine++;
        if (text.startsWith('#')) continue;
        const call = !token.output && text.match(/^(render|include|section|sections)\s+(.*)$/s);
        if (call) {
          const literal = call[2].match(/^(['"])([^'"\r\n]+)\1(?=\s*(?:,|$|with\b|for\b))/);
          const directory = call[1] === 'render' || call[1] === 'include' ? 'snippets' : 'sections';
          const extension = call[1] === 'sections' ? '.json' : '.liquid';
          addDependency(file, `liquid-${call[1]}`, literal ? `${directory}/${literal[2]}${extension}` : null, { line }, { reason: literal ? null : 'Dynamic Liquid reference requires runtime settings or rendering.' });
        }
        if (!token.output && /^content_for\b/.test(text)) {
          const block = text.match(/^content_for\s+(['"])block\1\s*,[\s\S]*?\btype\s*:\s*(['"])([^'"]+)\2(?=\s*(?:,|$))/);
          addDependency(file, 'theme-block', block ? `blocks/${block[3]}.liquid` : null, { line }, { reason: block ? null : 'Dynamic block rendering requires runtime block configuration.' });
        }
        for (const match of maskQuoted(text).matchAll(/\|\s*asset_url\b/g)) {
          const preceding = text.slice(0, match.index).trim();
          const literal = preceding.match(/^(?:(?:assign\s+\w+\s*=|echo)\s*)?(['"])([^'"]+)\1$/);
          addDependency(file, 'asset-url', literal ? `assets/${literal[2]}` : null, { line }, { reason: literal ? null : 'Computed asset_url expression cannot be statically resolved.' });
        }
      }
    }
  };
  const jsonDependencies = (file, data) => {
    const pointerEscape = (key) => key.replace(/~/g, '~0').replace(/\//g, '~1');
    const blocks = (value, pointer) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return;
      for (const [key, block] of Object.entries(value)) {
        if (!block || typeof block !== 'object') continue;
        const here = `${pointer}/${pointerEscape(key)}`;
        if (typeof block.type === 'string' && (block.type === '@app' || block.type.startsWith('shopify://apps/'))) appIndicators.push({ file, pointer: `${here}/type`, kind: 'app-block-or-embed' });
        // Legacy section-local block types cannot be distinguished from theme blocks by name alone.
        else if (typeof block.type === 'string') addDependency(file, 'json-block', null, { pointer: `${here}/type` }, { reason: 'Block type may be section-local or a theme block; resolve against section schema and runtime configuration.' });
        blocks(block.blocks, `${here}/blocks`);
      }
    };
    const sections = (value, pointer) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return;
      for (const [key, section] of Object.entries(value)) {
        if (!section || typeof section !== 'object') continue;
        const here = `${pointer}/${pointerEscape(key)}`;
        if (typeof section.type === 'string' && section.type.startsWith('shopify://apps/')) appIndicators.push({ file, pointer: `${here}/type`, kind: 'app-section' });
        else addDependency(file, 'json-section', typeof section.type === 'string' && section.type ? `sections/${section.type}.liquid` : null, { pointer: `${here}/type`, ...(section.disabled === true ? { disabled: true } : {}) }, { reason: typeof section.type === 'string' && section.type ? null : 'Section type is missing or not a literal string.' });
        blocks(section.blocks, `${here}/blocks`);
      }
    };
    if ((file.startsWith('templates/') || file.startsWith('sections/')) && data && typeof data === 'object' && !Array.isArray(data)) sections(data.sections, '/sections');
    if (file === 'config/settings_data.json' && data && typeof data === 'object') {
      sections(data.current?.sections, '/current/sections'); blocks(data.current?.blocks, '/current/blocks');
    }
  };
  const javascriptDependencies = (file, source) => {
    const tokens = codeTokens(source);
    const add = (token, type) => addDependency(file, type, token?.type === 'string' && token.literal ? token.value : null, { line: lineAt(source, token?.start ?? 0) }, { relative: true, reason: token?.type === 'string' && token.literal ? null : 'Computed or escaped module specifier requires runtime/bundler resolution.' });
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i]; if (token.type !== 'id' || !['import', 'export'].includes(token.value) || tokens[i - 1]?.value === '.') continue;
      const next = tokens[i + 1];
      if (token.value === 'import' && next?.value === '(') {
        if (tokens[i + 3]?.value === ')' || tokens[i + 3]?.value === ',') add(tokens[i + 2], 'javascript-import');
        else addDependency(file, 'javascript-import', null, { line: lineAt(source, token.start) }, { reason: 'Computed dynamic import requires runtime/bundler resolution.' });
      } else if (token.value === 'import' && next?.type === 'string') add(next, 'javascript-import');
      else if (next?.value !== '.') {
        for (let j = i + 1; j < tokens.length && j < i + 100; j++) {
          if (tokens[j].value === ';' || tokens[j].value === '=' || tokens[j].value === 'import') break;
          if (tokens[j].type === 'id' && tokens[j].value === 'from') { add(tokens[j + 1], 'javascript-import'); break; }
        }
      }
    }
  };
  const cssDependencies = (file, source) => {
    const clean = source.replace(/\/\*[\s\S]*?\*\//g, blank);
    const re = /@import\s+(?:url\(\s*)?(['"])([^'"\r\n]+)\1|url\(\s*(?:(['"])([^'"\r\n]+)\3|([^\s)'";]+))\s*\)/gi;
    for (const match of clean.matchAll(re)) {
      const value = match[2] ?? match[4] ?? match[5];
      if (!value || value.startsWith('#') || value.startsWith('data:')) continue;
      if (value.includes('{{') || value.includes('{%')) { addDependency(file, 'css-resource', null, { line: lineAt(source, match.index) }, { reason: 'Liquid CSS resource requires rendering.' }); continue; }
      addDependency(file, match[0].toLowerCase().startsWith('@import') ? 'css-import' : 'css-resource', value, { line: lineAt(source, match.index) }, { relative: true });
    }
  };
  const analyze = async (relative, absolute, info) => {
    const kind = kindOf(relative), entry = { path: relative, kind, rawBytes: info.size, sha256: null, inspected: false };
    files.push(entry);
    let handle;
    try {
      const actual = await realpath(absolute);
      if (!inside(root, actual) || actual !== absolute) throw Object.assign(new Error('Symlink ancestor'), { code: 'UNSAFE_PATH' });
      handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
      if (await realpath(absolute) !== absolute) throw Object.assign(new Error('Changed ancestor'), { code: 'UNSAFE_PATH' });
      const before = await handle.stat();
      if (!before.isFile() || before.ino !== info.ino || before.dev !== info.dev) throw Object.assign(new Error('Changed file'), { code: 'FILE_CHANGED' });
      const hash = createHash('sha256'), chunks = [], textKind = ['liquid', 'javascript', 'css', 'json'].includes(kind);
      const keep = !fingerprintsOnly && textKind && before.size <= MAX_SOURCE_BYTES;
      const buffer = Buffer.alloc(64 * 1024); let bytes = 0;
      while (true) { const { bytesRead } = await handle.read(buffer, 0, buffer.length, null); if (!bytesRead) break; hash.update(buffer.subarray(0, bytesRead)); if (keep) chunks.push(Buffer.from(buffer.subarray(0, bytesRead))); bytes += bytesRead; }
      const after = await handle.stat(), named = await lstat(absolute);
      if (bytes !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs
        || named.ino !== before.ino || named.dev !== before.dev || await realpath(absolute) !== absolute)
        throw Object.assign(new Error('Changed file'), { code: 'FILE_CHANGED' });
      entry.rawBytes = bytes; entry.sha256 = hash.digest('hex');
      if (fingerprintsOnly || !textKind) return;
      if (!keep) { skipped.push({ file: relative, reason: 'Source exceeds the 5 MiB analysis limit; only bytes/hash were inventoried.' }); return; }
      const raw = Buffer.concat(chunks);
      const validUtf8 = (retain || onSource) ? isUtf8(raw) : null;
      const source = raw.toString('utf8');
      // Retain NUL-containing text as the old quality/analysis reader did, but skip its inventory rules.
      if (retain && validUtf8) retain({file: relative, source, sourceHash: entry.sha256, bytes});
      if (raw.includes(0)) { skipped.push({ file: relative, reason: 'NUL bytes indicate non-text data; source analysis was skipped.' }); return; }
      if (kind === 'json') {
        let data;
        try { data = JSON.parse(stripJsonComments(source)); }
        catch { addError(relative, 'INVALID_JSON', 'JSON could not be parsed after removing comments; dependency coverage for this file is incomplete.'); return; }
        if (/^(templates|sections)\//.test(relative) && (!data || typeof data !== 'object' || Array.isArray(data))) { addError(relative, 'INVALID_TEMPLATE_JSON', 'Template/section-group JSON must contain an object; dependency coverage is incomplete.'); return; }
        jsonDependencies(relative, data);
      }
      if (kind === 'liquid') liquidDependencies(relative, source);
      if (kind === 'javascript') javascriptDependencies(relative, source);
      if (kind === 'css') cssDependencies(relative, source);
      if (onSource && SOURCE_DIRS.has(relative.split('/')[0]) && /\.(liquid|js|mjs|css)$/i.test(relative)) {
        await onSource({project:root,target:relative,source,sourceHash:entry.sha256,validUtf8});
        entry.inspected = true;
      }
    } catch (error) { addError(relative, error?.code ?? 'ANALYSIS_FAILED', safeMessage(error)); }
    finally { await handle?.close(); }
  };
  const queue = [];
  for (const name of [...THEME_DIRS].sort()) {
    try { const absolute = path.join(root, name), info = await lstat(absolute); if (info.isSymbolicLink()) skipped.push({ file: name, reason: 'Symlink directory is not followed.' }); else if (info.isDirectory()) queue.push({ absolute, relative: name }); else addError(name, 'NOT_DIRECTORY', 'Expected theme directory is not a directory.'); }
    catch (error) { if (error?.code !== 'ENOENT') addError(name, error?.code ?? 'READ_FAILED', safeMessage(error)); }
  }
  while (queue.length && !capped) {
    const dir = queue.shift();
    try {
      const resolved = await realpath(dir.absolute);
      if (!inside(root, resolved) || resolved !== dir.absolute || (await lstat(dir.absolute)).isSymbolicLink()) { skipped.push({ file: dir.relative, reason: 'Changed or symlink directory is not followed.' }); continue; }
      const children = (await readdir(dir.absolute)).sort();
      for (const name of children) {
        if (files.length >= MAX_FILES) { capped = true; addError(dir.relative, 'FILE_LIMIT', 'Scan stopped at the 10000-file inventory limit.'); break; }
        const absolute = path.join(dir.absolute, name), relative = `${dir.relative}/${name}`;
        try {
          const info = await lstat(absolute);
          if (info.isSymbolicLink()) { skipped.push({ file: relative, reason: 'Symlinks are not followed, including internal aliases.' }); continue; }
          if (info.isDirectory()) queue.push({ absolute, relative });
          else if (info.isFile()) await analyze(relative, absolute, info);
          else skipped.push({ file: relative, reason: 'Non-regular filesystem entry was skipped.' });
        } catch (error) { addError(relative, error?.code ?? 'READ_FAILED', safeMessage(error)); }
      }
    } catch (error) { addError(dir.relative, error?.code ?? 'READ_FAILED', safeMessage(error)); }
  }
  if (!files.length) addError(null, 'NO_THEME_FILES', 'No regular files were found in the recognized Shopify theme directories.');
  files.sort((a, b) => a.path.localeCompare(b.path));
  if (fingerprintsOnly) {
    if (errors.some(error => error.code !== 'NO_THEME_FILES')) throw new Error('Unable to verify theme inventory fingerprints.');
    return {files: files.map(file => [file.path, file.sha256])};
  }
  const fileMap = new Map(files.map((file) => [file.path, file]));
  const dependencies = [...dependencyMap.values()].sort((a, b) => a.from.localeCompare(b.from) || (a.to ?? '').localeCompare(b.to ?? '') || a.type.localeCompare(b.type));
  for (const edge of dependencies) if (edge.to) {
    if (edge.type === 'asset-url' && !fileMap.has(edge.to) && fileMap.has(edge.to + '.liquid')) {
      edge.requestedTo = edge.to; edge.to += '.liquid'; edge.resolution = 'shopify-liquid-asset';
    }
    edge.status = fileMap.has(edge.to) ? 'resolved' : 'missing';
    if (edge.status === 'missing') edge.reason = 'No inventoried regular file matches this literal reference; skipped entries or platform resolution may require review.';
  }
  const graph = new Map();
  for (const edge of dependencies.filter((entry) => entry.status === 'resolved')) { if (!graph.has(edge.from)) graph.set(edge.from, new Set()); graph.get(edge.from).add(edge.to); }
  const entrypoints = files.filter((file) => /^(templates|layout)\//.test(file.path) && /\.(json|liquid)$/.test(file.path)).map((file) => file.path);
  const reachable = new Set(entrypoints), pending = [...entrypoints];
  while (pending.length) for (const target of graph.get(pending.pop()) ?? []) if (!reachable.has(target)) { reachable.add(target); pending.push(target); }
  for (const file of files) file.staticReachability = entrypoints.includes(file.path) ? 'entrypoint' : reachable.has(file.path) ? 'reachable-from-entrypoint' : 'no-static-path';
  // Iterative DFS bounds stack usage even for generated themes with long dependency chains.
  const color = new Map(), cycles = [], cycleKeys = new Set();
  for (const file of files) {
    if (color.has(file.path)) continue;
    const stack = [{ node: file.path, next: [...(graph.get(file.path) ?? [])][Symbol.iterator]() }]; color.set(file.path, 1);
    while (stack.length) {
      const frame = stack.at(-1), next = frame.next.next();
      if (next.done) { color.set(frame.node, 2); stack.pop(); continue; }
      if (!color.has(next.value)) { color.set(next.value, 1); stack.push({ node: next.value, next: [...(graph.get(next.value) ?? [])][Symbol.iterator]() }); }
      else if (color.get(next.value) === 1 && cycles.length < 100) {
        const nodes = stack.slice(stack.findIndex((entry) => entry.node === next.value)).map((entry) => entry.node); const key = [...nodes].sort().join('\0');
        if (!cycleKeys.has(key)) { cycleKeys.add(key); cycles.push([...nodes, next.value]); }
      }
    }
  }
  const representativePages = files.filter((file) => file.path.startsWith('templates/') && /\.(json|liquid)$/.test(file.path)).map((file) => {
    const basename = path.posix.basename(file.path).replace(/\.(json|liquid)$/, ''), type = basename.split('.')[0], alternate = basename.includes('.');
    const fixed = !alternate && !file.path.includes('/customers/') ? ({ index: '/', cart: '/cart', search: '/search', 'list-collections': '/collections' })[type] ?? null : null;
    return { template: file.path, type, route: fixed, url: null, states: type === 'cart' ? ['empty', 'non-empty (requires isolated functional test)'] : type === 'product' ? ['initial', 'variant-change', 'first-add-to-cart (requires isolated functional test)'] : type === 'collection' ? ['initial', 'filter-or-sort'] : ['initial', 'first-interaction'], note: fixed ? 'Route suggestion only; supply the actual preview/store URL and verify template assignment.' : 'A real assigned page URL is required; product, collection, page handles and alternate-template assignments are not inferred.' };
  });
  for (const url of suppliedPages) representativePages.push({ template: null, type: 'provided', route: null, url, states: ['initial'], note: 'User-supplied URL; template assignment and accessibility have not been checked.' });
  const assets = files.filter((file) => file.path.startsWith('assets/'));
  const rawBytes = files.reduce((total, file) => total + file.rawBytes, 0);
  const unresolved = dependencies.filter((edge) => edge.status !== 'resolved');
  return {
    schemaVersion: 1, kind: 'theme-inventory', project: root, complete: errors.length === 0 && skipped.length === 0,
    inventory: { files, assets, rawBytes, appIndicators }, dependencies, unresolved, dependencyCycles: cycles,
    pages: representativePages, errors, skipped,
    limitations: [
      'Static candidates are review leads, not confirmed defects, measured savings or an automatic permission to modify resources.',
      'A resolved edge proves a literal file reference only. Liquid branches, loops, app injection, section/block settings, JavaScript execution and template assignment are not evaluated.',
      'No static path does not mean unused. Dynamic references, platform assets and external resources remain unresolved; no deletion recommendations are generated.',
      'Import scanning is deliberately lexical and limited; bundler resolution, import maps, JavaScript regular-expression literals, embedded JS/CSS and general Liquid semantics need independent verification.',
      'Config JSON is parsed for structural references and app indicators only; settings values are not included in this report.',
      'No URL was fetched and no Theme Check, browser interaction, Lighthouse or real-user performance measurement was run.',
      'Symlinks are never followed. Source analysis is limited to 5 MiB per file and inventory to 10000 files; skipped sources and errors make complete=false.',
      'Reported cycles are static graph cycles (up to 100), not proof of runtime infinite recursion.',
    ],
    summary: { files: files.length, assets: assets.length, rawBytes, inspectedFiles: files.filter((file) => file.inspected).length, dependencies: dependencies.length, resolvedDependencies: dependencies.length - unresolved.length, unresolvedDependencies: unresolved.filter((edge) => edge.status === 'unresolved').length, missingDependencies: unresolved.filter((edge) => edge.status === 'missing').length, templates: representativePages.filter((page) => page.template).length, appIndicators: appIndicators.length, errors: errors.length, skipped: skipped.length },
  };
}
