import { lineAt } from './source-utils.mjs';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { parse } from 'acorn';
import postcss from 'postcss';
import { liquidAST, visitAST } from './advanced-strategies.mjs';
import { sourceSnapshot, sha256 } from './runtime-profile.mjs';
import {parseLiquidAsset,effectiveAssetSettings,associateLiquidAsset} from './liquid-assets.mjs';

const htmlName = node => typeof node.name === 'string' ? node.name : node.name?.map(n => n.value ?? '?').join('');
function cssStructure(text) {
  const root=postcss.parse(text), rules=[];
  root.walkRules(rule=>rules.push(rule));
  const shape = node => ({ type:node.type, ...Object.fromEntries(['name','params','selector','prop','value','important'].filter(k=>node[k] !== undefined).map(k=>[k,node[k]])),
    ...(node.nodes ? {nodes:node.nodes.filter(n=>n.type!=='comment').map(shape)} : {}) });
  return { structureHash:sha256(JSON.stringify(shape(root))),rules };
}
export function jsTokens(text) {
  const tokens = [];
  // Parse as well as tokenize: ASI/newline changes must not become an identity proof.
  const ast = parse(text, { ecmaVersion: 'latest', sourceType: 'module', locations: true, onToken: tokens });
  const structural = JSON.stringify(ast, (key, value) => ['start','end','loc','raw'].includes(key) ? undefined : value);
  return { tokens: tokens.filter(t => t.type.label !== 'eof'), structureHash: sha256(structural) };
}

/** Current, read-only theme graph. Dynamic edges are retained, never guessed. */
export async function indexThemeSources(project) {
  const snapshot = await sourceSnapshot(project);
  if (!snapshot.complete) throw new Error('A complete text-source snapshot is required.');
  const files = [], edges = [], unresolved = [], units = [], cssUnits = [], importMaps = [];
  const known = new Set(snapshot.files.map(f => f.file));
  const edge = (from, to, kind, line) => {
    if(kind==='asset'&&!known.has(to)&&known.has(to+'.liquid'))to+='.liquid';
    if (known.has(to)) edges.push({ from, to, kind, line });
    else unresolved.push({ from, target: to, kind, line, reason: 'missing-source' });
  };
  for (const entry of snapshot.files) {
    const text = await readFile(path.join(snapshot.project, entry.file), 'utf8');
    if (sha256(text) !== entry.sourceHash) throw new Error('Source changed while indexing.');
    const file = { ...entry, text }; files.push(file);
    try {
      if (/\.m?js$/.test(entry.file)) {
        units.push({ file: entry.file, sourceHash: entry.sourceHash, offset: 0, line: 1, text, kind: 'asset' });
        const tree = parse(text, { ecmaVersion: 'latest', sourceType: 'module' });
        visitAST(tree, node => {
          if (['ImportDeclaration','ExportNamedDeclaration','ExportAllDeclaration','ImportExpression'].includes(node.type) && node.source) {
            const spec = node.source.value;
            if (typeof spec === 'string' && spec.startsWith('.')) edge(entry.file, path.posix.normalize(path.posix.join(path.posix.dirname(entry.file), spec)), 'js-import', lineAt(text,node.start));
            else unresolved.push({ from: entry.file, target: spec ?? null, kind: 'js-import', line: lineAt(text,node.start), reason: 'external-or-dynamic' });
          }
        });
      } else if (/\.css$/.test(entry.file)) {
        cssUnits.push({ ...entry,text,...cssStructure(text) });
      } else if (/^assets\/.+\.m?js\.liquid$/.test(entry.file)) {
        try{units.push({file:entry.file,sourceHash:entry.sourceHash,offset:0,line:1,text,kind:'liquid-asset',model:parseLiquidAsset(text)});}
        catch(error){unresolved.push({from:entry.file,kind:'liquid-asset',reason:'unsupported-liquid-asset',message:error.message});}
      } else if (/\.liquid$/.test(entry.file)) {
        const tree = liquidAST(text);
        visitAST(tree, node => {
          if (node.type === 'LiquidTag' && ['render','include','section','sections','layout'].includes(node.name)) {
            const raw = text.slice(node.position.start, node.blockStartPosition?.end ?? node.position.end);
            const match = raw.match(/(?:render|include|sections?|layout)\s+['"]([\w/-]+)['"]/);
            if (match) edge(entry.file, `${['render','include'].includes(node.name) ? 'snippets' : node.name === 'layout' ? 'layout' : 'sections'}/${match[1]}.${node.name === 'sections' ? 'json' : 'liquid'}`, node.name, lineAt(text,node.position.start));
            else if (!/layout\s+none\b/.test(raw)) unresolved.push({ from: entry.file, kind: node.name, line: lineAt(text,node.position.start), reason: 'dynamic-liquid-reference' });
          }
          if (node.type === 'LiquidVariableOutput' && node.markup?.filters?.some(f => f.name === 'asset_url')) {
            const name = node.markup.expression?.value;
            if (typeof name === 'string') edge(entry.file, `assets/${name}`, 'asset', lineAt(text,node.position.start));
            else unresolved.push({ from: entry.file, kind: 'asset', line: lineAt(text,node.position.start), reason: 'dynamic-asset' });
          }
          if (node.type === 'HtmlRawNode' && htmlName(node) === 'script' && node.body?.value?.trim()) {
            const offset = node.blockStartPosition.end;
            const type=node.attributes?.find(a=>htmlName(a)==='type')?.value?.[0]?.value;
            if (type==='importmap') {
              try {
                const map=JSON.parse(node.body.value);
                if (map.scopes) unresolved.push({from:entry.file,kind:'import-map',reason:'scoped-import-map-needs-review'});
                else for (const [specifier,url] of Object.entries(map.imports??{})) {
                  const match=typeof url==='string'&&url.match(/^\{\{-?\s*['"]([\w.-]+\.(?:m?js))['"]\s*\|\s*asset_url\s*-?\}\}$/);
                  if(match)importMaps.push({specifier,target:`assets/${match[1]}`,from:entry.file,line:lineAt(text,offset)});
                }
              } catch { unresolved.push({from:entry.file,kind:'import-map',reason:'dynamic-or-invalid-import-map'}); }
              return;
            }
            if (!/\{[{%]/.test(node.body.value)) units.push({ file: entry.file, sourceHash: entry.sourceHash, offset, line: lineAt(text,offset), text: node.body.value, kind: 'inline' });
            else unresolved.push({ from: entry.file, kind: 'inline-script', line: lineAt(text,offset), reason: 'rendered-liquid-needs-explicit-mapping' });
          }
        });
      } else if (/^(templates|sections)\/.+\.json$/.test(entry.file)) {
        const data = JSON.parse(text.replace(/^\s*\/\*[\s\S]*?\*\//, ''));
        for (const section of Object.values(data.sections ?? {})) if (typeof section.type === 'string') edge(entry.file, `sections/${section.type}.liquid`, 'section-instance', 1);
        if (entry.file.startsWith('templates/') && data.layout !== false) edge(entry.file, `layout/${data.layout ?? 'theme'}.liquid`, 'layout', 1);
      }
      if (entry.file.startsWith('templates/') && entry.file.endsWith('.liquid') && !/\{%[-\s]*layout\b/.test(text) && known.has('layout/theme.liquid')) edge(entry.file,'layout/theme.liquid','default-layout',1);
    } catch (error) { unresolved.push({ from: entry.file, reason: 'parse-error', message: error.message }); }
  }
  for (let i=unresolved.length-1;i>=0;i--) {
    const ref=unresolved[i]; if(ref.kind!=='js-import'||typeof ref.target!=='string')continue;
    const matches=importMaps.filter(m=>m.specifier===ref.target), targets=new Set(matches.map(m=>m.target));
    if(targets.size===1 && known.has(matches[0].target)) { edges.push({from:ref.from,to:matches[0].target,kind:'js-import-map',line:ref.line,via:matches.map(m=>m.from)}); unresolved.splice(i,1); }
  }
  for (const unit of units) {
    if(unit.kind!=='liquid-asset'){try { Object.assign(unit, jsTokens(unit.text)); } catch { unit.structureHash = null; }}
    unit.bodyHash = sha256(unit.text);
  }
  const final = await sourceSnapshot(project);
  if (final.hash !== snapshot.hash || !final.complete) throw new Error('Source drift during indexing.');
  return { schemaVersion: 1, kind: 'source-index', snapshot, files, edges, unresolved, units, cssUnits,assetSettings:effectiveAssetSettings(files) };
}

/** Map CSS coverage only after full parsed structure equality; retain whole matched rules. */
export function associateStylesheet(text,index,{url='',ranges=[]}={}) {
  const bodyHash=sha256(text); let parsed;
  try { parsed=cssStructure(text); } catch { return { source:{status:'unmapped',reason:'Unparsed stylesheet.'} }; }
  let matches=index.cssUnits.filter(u=>u.structureHash===parsed.structureHash);
  if(matches.length>1) { let name; try{name=decodeURIComponent(path.posix.basename(new URL(url).pathname));}catch{}
    const named=matches.filter(u=>path.posix.basename(u.file)===name);if(named.length===1)matches=named; }
  if(matches.length!==1) return { source:{status:matches.length?'ambiguous':'unmapped',reason:'CSS AST is not uniquely identical; no coverage offsets were inferred.'} };
  const unit=matches[0], exact=unit.sourceHash===bodyHash;
  if(ranges.some(r=>!Number.isInteger(r.start)||!Number.isInteger(r.end)||r.start<0||r.end<r.start||r.end>text.length)) throw new Error('CSS coverage range is outside the observed response.');
  const mapped=exact?ranges:parsed.rules.flatMap((rule,i)=>ranges.some(r=>r.start<rule.source.end.offset+1&&r.end>rule.source.start.offset)
    ?[{start:unit.rules[i].source.start.offset,end:Math.min(unit.text.length,unit.rules[i].source.end.offset+1)}]:[]);
  return { source:{status:exact?'verified-bytes':'verified-ast',file:unit.file,sourceHash:unit.sourceHash,bodyHash,reason:'Full CSS AST matches; formatting changes only. Changed values/selectors remain unmapped.'},ranges:mapped };
}

export function pathsToSource(index, target, limit = 24) {
  const output = [], incoming = new Map();
  for (const edge of index.edges) { const list = incoming.get(edge.to) ?? []; list.push(edge); incoming.set(edge.to,list); }
  const walk = (file, route) => {
    if (output.length >= limit || route.length > 20) return;
    if (file.startsWith('templates/') || !(incoming.get(file)?.length)) { output.push([file,...route]); return; }
    for (const edge of incoming.get(file)) if (!route.includes(edge.from) && edge.from !== file) walk(edge.from,[file,...route]);
  };
  walk(target,[]); return output;
}

/** No filename-only matching. AST identity permits formatting/comment changes, not minifier rewrites. */
export function associateScript(text, index, { url = '', line = 1, column = 1, inline = false } = {}) {
  const liquidMatches=inline?[]:index.units.filter(u=>u.kind==='liquid-asset').map(u=>associateLiquidAsset(text,u,index.assetSettings,{line,column})).filter(Boolean);
  const pool = index.units.filter(u => (inline ? u.kind === 'inline' : u.kind === 'asset'));
  const bodyHash = sha256(text), key = `${inline}:${bodyHash}`;
  index.mappingCache ??= new Map();
  const cached = index.mappingCache.get(key);
  let candidates = cached?.candidates ?? pool.filter(u => u.bodyHash === bodyHash), parsed = cached?.parsed, status = cached?.status ?? 'verified-bytes';
  if (!cached && !candidates.length) {
    try { parsed = jsTokens(text); } catch { return { status: 'unmapped', reason: 'Script cannot be parsed.' }; }
    candidates = pool.filter(u => u.structureHash === parsed.structureHash); status = 'verified-ast';
  }
  index.mappingCache.set(key,{ candidates,parsed,status });
  if(liquidMatches.length) {
    if(liquidMatches.length===1&&!candidates.length)return liquidMatches[0];
    return {status:'ambiguous',candidates:[...liquidMatches.map(m=>m.file),...candidates.map(m=>m.file)],reason:'Multiple source programs match this response; no filename inference for Liquid templates.'};
  }
  // Identical shared inline snippets remain ambiguous. A basename can only disambiguate byte/AST matches.
  if (!inline && candidates.length > 1) {
    let name; try { name = decodeURIComponent(path.posix.basename(new URL(url).pathname)); } catch {}
    const named = candidates.filter(u => path.posix.basename(u.file) === name); if (named.length === 1) candidates = named;
  }
  if (candidates.length !== 1) return { status: candidates.length ? 'ambiguous' : 'unmapped', candidates: candidates.map(u => u.file), reason: 'No unique matching script body or AST.' };
  const unit = candidates[0];
  const lines = text.split('\n');
  const runtimeOffset = lines.slice(0, Math.max(0,line-1)).reduce((n,s) => n+s.length+1,0)+Math.max(0,column-1);
  let offset = runtimeOffset;
  if (status === 'verified-ast') {
    parsed ??= jsTokens(text);
    const tokenIndex = parsed.tokens.findIndex(t => t.end > runtimeOffset);
    offset = unit.tokens[tokenIndex]?.start ?? 0;
  }
  const full = index.files.find(f => f.file === unit.file).text, absolute = unit.offset + offset;
  return { status, file: unit.file, sourceHash: unit.sourceHash, bodyHash: sha256(text), offset: absolute, line: lineAt(full,absolute), column: absolute-full.lastIndexOf('\n',absolute-1),
    scriptKind: unit.kind, runtimeLine: line, runtimeColumn: column, reason: status === 'verified-bytes' ? 'Unique script bytes match current source.' : 'Parsed AST matches; source token locations mapped. Mangled/transformed code remains unmapped.' };
}

export function publicSourceIndex(index) {
  return { schemaVersion: 1, kind: 'source-graph', sourceHash: index.snapshot.hash, files: index.snapshot.files, edges: index.edges, unresolved: index.unresolved };
}
