import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse } from 'acorn';

const isJavaScript = file => /\.(?:mjs|cjs|js)$/.test(file);

async function libraryModules(root, directory = 'lib') {
  const files = [];
  const entries = await readdir(path.join(root, directory), { withFileTypes: true });
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const file = path.posix.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await libraryModules(root, file));
    else if (entry.isFile() && isJavaScript(file)) files.push(file);
  }
  return files;
}

function importsIn(code) {
  const tree = parse(code, { ecmaVersion: 'latest', sourceType: 'module', locations: true, allowHashBang: true });
  const imports = [];
  function walk(node) {
    if (!node || typeof node.type !== 'string') return;
    if (['ImportDeclaration', 'ImportExpression', 'ExportNamedDeclaration', 'ExportAllDeclaration'].includes(node.type) && node.source) {
      const source = node.source;
      const specifier = source.type === 'Literal' && typeof source.value === 'string' ? source.value
        : source.type === 'TemplateLiteral' && source.expressions.length === 0 ? source.quasis[0].value.cooked : null;
      imports.push({
        specifier,
        kind: node.type === 'ImportExpression' ? 'dynamic import' : node.type === 'ImportDeclaration' ? 'import' : 're-export',
        line: node.loc.start.line,
        ...(specifier === null ? { expression: code.slice(source.start, source.end) } : {}),
      });
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(walk);
      else if (value && typeof value === 'object') walk(value);
    }
  }
  walk(tree);
  return imports;
}

function localTarget(root, from, specifier) {
  if (!/^\.{1,2}(?:\/|$)|^file:/i.test(specifier) && !path.isAbsolute(specifier)) return null;
  const url = new URL(specifier, pathToFileURL(path.join(root, from)));
  return relativeTarget(root, fileURLToPath(url));
}

function relativeTarget(root, absolute) {
  return path.relative(root, absolute).split(path.sep).join('/');
}

function assertInsideProject(edge) {
  if (edge.to === '..' || edge.to.startsWith('../') || path.isAbsolute(edge.to)) {
    throw new Error(`Local import escapes the project: ${formatPath([edge])}`);
  }
}

export async function loadModuleGraph(root, { entryPoints = [] } = {}) {
  root = await realpath(root);
  const graph = new Map([...await libraryModules(root), ...entryPoints].map(file => [file, []]));
  const resolved = new Map();
  for (const [from, edges] of graph) {
    const code = await readFile(path.join(root, from), 'utf8');
    for (const entry of importsIn(code)) {
      const edge = { from, ...entry, to: null };
      if (entry.specifier !== null) {
        if (entry.specifier.startsWith('#')) throw new Error(`Unresolved package import alias: ${formatPath([edge])}`);
        edge.to = localTarget(root, from, entry.specifier);
        if (edge.to !== null) {
          assertInsideProject(edge);
          const lexical = edge.to;
          if (!resolved.has(lexical)) {
            const target = await realpath(path.join(root, lexical)).catch(error => {
              if (error.code !== 'ENOENT') throw error;
            });
            if (!target) throw new Error(`Unresolved local module: ${formatPath([edge])}`);
            resolved.set(lexical, relativeTarget(root, target));
          }
          edge.to = resolved.get(lexical);
          assertInsideProject(edge);
          if (!graph.has(edge.to)) {
            const info = await stat(path.join(root, edge.to)).catch(error => {
              if (error.code !== 'ENOENT') throw error;
            });
            if (!info?.isFile()) throw new Error(`Unresolved local module: ${formatPath([edge])}`);
            if (isJavaScript(edge.to)) graph.set(edge.to, []);
          }
        }
      }
      edges.push(edge);
    }
  }
  return graph;
}

export function formatPath(edges) {
  return edges.map(({ from, line, kind }) => `${from}:${line} --${kind}--> `).join('')
    + (edges.at(-1).to ?? edges.at(-1).specifier ?? edges.at(-1).expression);
}

export function findCycle(graph) {
  const active = new Map(), done = new Set(), stack = [];
  function visit(file) {
    if (active.has(file)) return stack.slice(active.get(file));
    if (done.has(file)) return null;
    active.set(file, stack.length);
    for (const edge of graph.get(file) ?? []) {
      if (!graph.has(edge.to)) continue;
      stack.push(edge);
      const cycle = visit(edge.to);
      if (cycle) return cycle;
      stack.pop();
    }
    active.delete(file);
    done.add(file);
    return null;
  }
  for (const file of graph.keys()) {
    const cycle = visit(file);
    if (cycle) return cycle;
  }
  return null;
}

export function findDependency(graph, start, matches, { direct = false } = {}) {
  const queue = [start], parents = new Map([[start, null]]);
  for (const file of queue) {
    for (const edge of graph.get(file) ?? []) {
      if (matches(edge)) {
        const chain = [edge];
        for (let parent = parents.get(file); parent; parent = parents.get(parent.from)) chain.push(parent);
        return chain.reverse();
      }
      if (!direct && graph.has(edge.to) && !parents.has(edge.to)) {
        parents.set(edge.to, edge);
        queue.push(edge.to);
      }
    }
  }
  return null;
}
