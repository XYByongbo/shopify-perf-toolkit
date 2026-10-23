import path from 'node:path';
import postcss from 'postcss';
import { parse } from 'acorn';
import { readTarget } from './changes.mjs';
import { createSitePlan } from './site-changes.mjs';
import { liquidAST, visitAST } from './advanced-strategies.mjs';
import { sha256 } from './runtime-profile.mjs';

/** Explicit activation contract avoids replaying synthetic clicks or losing the first real event. */
export function componentLoaderSource({ key, rootSelector, triggerSelector }) {
  return `const key = Symbol.for(${JSON.stringify(`perfkit:${key}`)});
if (!globalThis[key]) {
  const controller = new AbortController();
  const roots = new Map();
  const script = document.querySelector(${JSON.stringify(`script[data-perf-loader="${key}"]`)});
  const url = script?.dataset.perfModule;
  if (!url) throw new Error('Missing component module URL');
  const attach = (scope) => {
    const found = [...scope.querySelectorAll(${JSON.stringify(rootSelector)})];
    if (scope.matches?.(${JSON.stringify(rootSelector)})) found.unshift(scope);
    for (const root of found) {
      if (roots.has(root)) continue;
      const lifetime = new AbortController();
      const state = { lifetime, module: null, loading: null, queue: Promise.resolve() };
      roots.set(root, state);
      root.addEventListener('click', (event) => {
        const trigger = event.target.closest?.(${JSON.stringify(triggerSelector)});
        if (!trigger || !root.contains(trigger)) return;
        if (!(trigger instanceof HTMLButtonElement) || trigger.type !== 'button') return;
        event.preventDefault();
        state.loading ??= import(url).then(module => {
          if (typeof module.activate !== 'function' || typeof module.destroy !== 'function') throw new Error('Component requires activate and destroy exports');
          state.module = module; return module;
        }).catch(error => { state.loading = null; throw error; });
        const loading = state.loading;
        state.queue = state.queue.then(async () => {
          const module = await loading;
          if (!lifetime.signal.aborted && root.isConnected) await module.activate(root, { event, trigger, signal: lifetime.signal });
        }).catch(error => { if (!lifetime.signal.aborted) root.dispatchEvent(new CustomEvent('perfkit:component-error', { detail: { message: error.message }, bubbles: true })); });
      }, { signal: lifetime.signal });
    }
  };
  const detach = (scope) => {
    for (const [root, state] of roots) if (root === scope || scope.contains(root)) {
      state.lifetime.abort(); roots.delete(root);
      void state.queue.finally(() => state.module?.destroy(root)).catch(() => {});
    }
  };
  document.addEventListener('shopify:section:load', event => attach(event.target), { signal: controller.signal });
  document.addEventListener('shopify:section:unload', event => detach(event.target), { signal: controller.signal });
  globalThis[key] = { destroy() { controller.abort(); detach(document); delete globalThis[key]; } };
  attach(document);
}
`;
}

export async function createSplitPlan({ project, config }) {
  if (!config || config.schemaVersion !== 1 || !['css','interaction'].includes(config.mode) || Object.keys(config).some(k => !['schemaVersion','mode','source','newAsset','loaderTarget','tagStart','criticalRuleStarts','rootSelector','triggerSelector','reason','evidence'].includes(k))) throw new Error('Invalid split plan config.');
  const evidence = config.evidence;
  if (!/^assets\/.+\.(?:m?js|css)$/.test(config.source ?? '') || !/^(?:sections|snippets|layout|templates|blocks)\/.+\.liquid$/.test(config.loaderTarget ?? '')) throw new Error('Split source must be a theme JS/CSS asset and loaderTarget a Liquid template source.');
  for (const key of ['dependencyReview','allStatesCovered','cascadeAndOrderReviewed']) if (evidence?.[key] !== true) throw new Error(`Split requires ${key}=true with concrete runtime/coverage review.`);
  const source = await readTarget(project, config.source), loader = await readTarget(project, config.loaderTarget);
  if (evidence.sourceHash !== sha256(source.source) || evidence.loaderHash !== sha256(loader.source)) throw new Error('Split evidence must bind both current sourceHash and loaderHash.');
  if (!/^assets\/[A-Za-z0-9_-][\w.-]*\.(css|m?js)$/.test(config.newAsset) || config.newAsset === config.source) throw new Error('Choose a new direct asset path.');
  let tag; visitAST(liquidAST(loader.source), n => { if (n.position?.start === config.tagStart && ['HtmlRawNode','HtmlVoidElement'].includes(n.type)) tag = n; });
  if (!tag) throw new Error('Select an exact script/link parser offset.');
  const originalTag = loader.source.slice(tag.position.start, tag.position.end), sourceName = path.posix.basename(config.source), assetName = path.posix.basename(config.newAsset);
  const allowedAttributes = config.mode === 'css' ? ['href','rel'] : ['src','type','defer'];
  if (tag.attributes?.some(a => !a.name || !allowedAttributes.includes(a.name.map(n => n.value).join('')))) throw new Error('Loader has attributes whose semantics need a custom reviewed migration (integrity, media, nonce, handlers or data attributes).');
  const attributeName = config.mode === 'css' ? 'href' : 'src';
  const attribute = tag.attributes?.find(a => a.name?.map(n => n.value).join('') === attributeName);
  const expression = attribute?.value;
  if (expression?.length !== 1 || expression[0].type !== 'LiquidVariableOutput' || expression[0].markup?.expression?.value !== sourceName
    || expression[0].markup?.filters?.length !== 1 || expression[0].markup.filters[0].name !== 'asset_url') throw new Error('Loader must reference exactly the selected asset through asset_url.');
  const changes = [];
  const item = (target, kind, replacementText) => ({ target, kind, replacementText, reason: config.reason, evidence: { ...evidence, summary: evidence.summary } });
  let replacement;
  if (config.mode === 'css') {
    const rel = tag.attributes?.find(a => a.name?.map(n => n.value).join('') === 'rel');
    if (!config.source.endsWith('.css') || !config.newAsset.endsWith('.css') || tag.name !== 'link' || rel?.value?.length !== 1 || rel.value[0].value !== 'stylesheet' || evidence.inlineLoadHandlerAllowed !== true) throw new Error('CSS splitting requires stylesheet assets/link and reviewed CSP allowance for the load handler.');
    const root = postcss.parse(source.source);
    if (root.nodes.some(n => n.type === 'atrule' && ['import','charset','namespace','layer'].includes(n.name))) throw new Error('CSS import/charset/namespace/layer ordering requires a custom reviewed refactor.');
    const selected = config.criticalRuleStarts;
    if (!Array.isArray(selected) || !selected.length || new Set(selected).size !== selected.length || selected.some(n => !root.nodes.some(node => node.source.start.offset === n))) throw new Error('criticalRuleStarts must select exact top-level PostCSS nodes.');
    const critical = root.nodes.filter(n => selected.includes(n.source.start.offset)), deferred = root.nodes.filter(n => !selected.includes(n.source.start.offset));
    if (!deferred.length) throw new Error('No noncritical CSS remains.');
    changes.push(item(config.source, 'reviewed-replacement', critical.map(n => n.toString()).join('\n') + '\n'));
    changes.push(item(config.newAsset, 'create-asset', deferred.map(n => n.toString()).join('\n') + '\n'));
    replacement = `${originalTag}\n<link rel="stylesheet" href="{{ '${assetName}' | asset_url }}" media="print" onload="this.media='all'">\n<noscript><link rel="stylesheet" href="{{ '${assetName}' | asset_url }}"></noscript>`;
  } else {
    if (!/\.m?js$/.test(config.source) || !/\.m?js$/.test(config.newAsset) || tag.name !== 'script' || tag.body?.value.trim()) throw new Error('Interaction loading requires an external JS module with no inline body.');
    if (evidence.activationContractReviewed !== true || typeof config.rootSelector !== 'string' || typeof config.triggerSelector !== 'string' || !config.rootSelector || !config.triggerSelector) throw new Error('Review activate/destroy contract and explicit root/trigger selectors.');
    const tree = parse(source.source, { ecmaVersion: 'latest', sourceType: 'module' });
    const names = tree.body.filter(n => n.type === 'ExportNamedDeclaration' && n.declaration?.type === 'FunctionDeclaration').map(n => n.declaration.id.name);
    if (!names.includes('activate') || !names.includes('destroy')) throw new Error('Module must export named activate(root, context) and destroy(root) functions. Refactor the selected component first.');
    const key = sha256(config.newAsset).slice(0,12);
    changes.push(item(config.newAsset, 'create-asset', componentLoaderSource({ key, rootSelector: config.rootSelector, triggerSelector: config.triggerSelector })));
    replacement = `<script type="module" src="{{ '${assetName}' | asset_url }}" data-perf-loader="${key}" data-perf-module="{{ '${sourceName}' | asset_url }}"></script>`;
  }
  const after = loader.source.slice(0, tag.position.start) + replacement + loader.source.slice(tag.position.end);
  liquidAST(after);
  changes.push(item(config.loaderTarget, 'reviewed-replacement', after));
  return createSitePlan({ project, recipe: { schemaVersion: 1, changes } });
}
