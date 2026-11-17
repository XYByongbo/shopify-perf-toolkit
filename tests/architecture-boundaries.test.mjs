import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findCycle, findDependency, formatPath, loadModuleGraph } from './helpers/module-graph.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const seoEntry = 'scripts/seokit.mjs';
const libraryFile = name => `lib/${name}.mjs`;

function assertNoDependency(graph, from, matches, rule, options) {
  const dependency = findDependency(graph, from, matches, options);
  assert.ok(!dependency, dependency && `${rule}: ${formatPath(dependency)}`);
}

function forbidModules(graph, from, modules) {
  const forbidden = new Set(modules.map(libraryFile));
  assertNoDependency(graph, libraryFile(from), edge => forbidden.has(edge.to), 'Forbidden layer dependency');
}

function assertCoreAndSeoBoundaries(graph) {
  for (const file of graph.keys()) {
    const core = file.startsWith('lib/core/');
    const seo = file.startsWith('lib/seo/');
    if (!core && !seo && file !== seoEntry) continue;
    assertNoDependency(graph, file, edge => {
      if (edge.specifier?.startsWith('node:')) return false;
      if (edge.to?.startsWith('lib/core/')) return false;
      if (core) return true;
      if (edge.to?.startsWith('lib/seo/') || edge.to === seoEntry) return false;
      return !(seo && edge.specifier === '@shopify/liquid-html-parser');
    }, core ? 'Shared core must remain builtin-only with no product dependencies' : 'Disallowed SEO dependency', { direct: true });
  }
}

function untraceableImports(graph) {
  return [...graph.values()].flat().filter(edge =>
    // The operator can supply an absolute path to an external Playwright installation.
    edge.specifier === null && !(edge.from === libraryFile('capture') && edge.expression === 'pathToFileURL(specified).href'));
}

test('library architecture preserves its dependency boundaries', async t => {
  const graph = await loadModuleGraph(root, { entryPoints: [seoEntry] });

  await t.test('local imports and re-exports are acyclic and dynamic imports are traceable', () => {
    const unknown = untraceableImports(graph);
    assert.ok(!unknown.length, `Cannot resolve import targets:\n${unknown.map(edge => formatPath([edge])).join('\n')}`);
    const cycle = findCycle(graph);
    assert.ok(!cycle, cycle && `Module import cycle: ${formatPath(cycle)}`);
  });

  await t.test('shared core and SEO only use their permitted modules and packages', () => {
    assertCoreAndSeoBoundaries(graph);
  });

  await t.test('collection, verification, deployment and improvement keep their existing layers', async () => {
    forbidModules(graph, 'optimization-verification', ['measure', 'scenarios', 'optimization-collection', 'improvement-session']);
    forbidModules(graph, 'optimization-collection', ['optimization-verification']);
    forbidModules(graph, 'deployment', ['runtime-profile']);
    forbidModules(graph, 'improvement-transitions', [
      'improvement-actions', 'improvement-evidence', 'improvement-formal', 'improvement-journal',
      'improvement-session', 'site-changes', 'measure', 'deployment',
    ]);
    assertNoDependency(graph, libraryFile('improvement-transitions'),
      edge => /^(?:node:)?(?:fs|child_process|https?)(?:\/|$)/.test(edge.specifier),
      'Improvement transitions must not import execution builtins', { direct: true });
    for (const file of ['improvement-evidence', 'improvement-budget', 'improvement-state']) {
      forbidModules(graph, file, ['improvement-actions', 'improvement-formal', 'improvement-session']);
    }
    const collector = await readFile(path.join(root, libraryFile('optimization-collection')), 'utf8');
    assert.doesNotMatch(collector, /\b(?:verifyOptimization|applySitePlan|rollbackSitePlan)\s*\(/);
  });
});

async function fixture(t, files) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'toolkit-architecture-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const [file, code] of Object.entries(files)) {
    const destination = path.join(directory, file);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, code);
  }
  return directory;
}

test('the graph checks unreferenced nested modules and reports mixed import cycles', async t => {
  const directory = await fixture(t, {
    'lib/entry.mjs': 'export const ok = true;',
    'lib/core/nested/a.mjs': 'import "./b.js";',
    'lib/core/nested/b.js': 'export * from "../../seo/bridge.mjs";',
    'lib/seo/bridge.mjs': 'export const load = () => import(`../core/nested/a.mjs?mode=evidence#check`);',
  });
  const graph = await loadModuleGraph(directory);
  assert.equal(formatPath(findCycle(graph)),
    'lib/core/nested/a.mjs:1 --import--> lib/core/nested/b.js:1 --re-export--> lib/seo/bridge.mjs:1 --dynamic import--> lib/core/nested/a.mjs');
  assert.throws(() => assertCoreAndSeoBoundaries(graph),
    /Shared core must remain builtin-only.*lib\/core\/nested\/b\.js:1 --re-export--> lib\/seo\/bridge\.mjs/);
});

test('an unreferenced nested SEO module can use core and its parser but fails on a performance import', async t => {
  const directory = await fixture(t, {
    'lib/core/config.mjs': 'export const config = true;',
    'lib/seo/nested/index.mjs': 'import "@shopify/liquid-html-parser"; export * from "../../core/config.mjs";',
    'lib/performance.mjs': 'export const performance = true;',
  });
  assertCoreAndSeoBoundaries(await loadModuleGraph(directory));
  await writeFile(path.join(directory, 'lib/seo/nested/extra.mjs'), 'export const load = () => import("../../performance.mjs");');
  const graph = await loadModuleGraph(directory);
  assert.throws(() => assertCoreAndSeoBoundaries(graph),
    /Disallowed SEO dependency: lib\/seo\/nested\/extra\.mjs:1 --dynamic import--> lib\/performance\.mjs/);
});

test('an indirect cross-layer import reports the full path and a direct rule checks one edge', async t => {
  const directory = await fixture(t, {
    'lib/verify.mjs': 'export const check = () => import("./evidence/index.mjs");',
    'lib/evidence/index.mjs': 'export { run } from "../collection/runner.mjs";',
    'lib/collection/runner.mjs': 'export function run() {}',
  });
  const graph = await loadModuleGraph(directory);
  const forbidden = edge => edge.to?.startsWith('lib/collection/');
  assert.equal(findCycle(graph), null);
  assert.equal(findDependency(graph, 'lib/verify.mjs', forbidden, { direct: true }), null);
  assert.throws(() => assertNoDependency(graph, 'lib/verify.mjs', forbidden, 'Forbidden layer dependency'),
    /lib\/verify\.mjs:1 --dynamic import--> lib\/evidence\/index\.mjs:1 --re-export--> lib\/collection\/runner\.mjs/);
});

test('untraceable dynamic imports are flagged while generated source text is ignored', async t => {
  const directory = await fixture(t, {
    'lib/capture.mjs': 'export const runtime = specified => import(pathToFileURL(specified).href);',
    'lib/deep/module.mjs': 'export const script = `async () => import(url)`;\nexport const load = module => import(module);',
    'lib/deep/other.mjs': 'export const load = specified => import(pathToFileURL(specified).href);',
  });
  const graph = await loadModuleGraph(directory);
  assert.deepEqual(untraceableImports(graph).map(edge => formatPath([edge])), [
    'lib/deep/module.mjs:2 --dynamic import--> module',
    'lib/deep/other.mjs:1 --dynamic import--> pathToFileURL(specified).href',
  ]);
});

test('a missing local dynamic target fails with its import location', async t => {
  const directory = await fixture(t, {
    'lib/deep/module.mjs': '\nexport const load = () => import("../missing.mjs");',
  });
  await assert.rejects(loadModuleGraph(directory),
    /Unresolved local module: lib\/deep\/module\.mjs:2 --dynamic import--> lib\/missing\.mjs/);
});

test('a symlink cannot hide the target layer of a dynamic import', async t => {
  const directory = await fixture(t, {
    'lib/core/nested/check.mjs': 'export const load = () => import("./alias.mjs");',
    'lib/performance.mjs': 'export const performance = true;',
  });
  await symlink('../../performance.mjs', path.join(directory,'lib/core/nested/alias.mjs'));
  const graph = await loadModuleGraph(directory);
  assert.throws(() => assertCoreAndSeoBoundaries(graph),
    /lib\/core\/nested\/check\.mjs:1 --dynamic import--> lib\/performance\.mjs/);
});

test('a package import alias fails closed until the checker can resolve it', async t => {
  const directory = await fixture(t, {
    'package.json': '{"imports":{"#collector":"./lib/optimization-collection.mjs"}}',
    'lib/optimization-verification.mjs': 'export const load = () => import("#collector");',
    'lib/optimization-collection.mjs': 'export function collect() {}',
  });
  await assert.rejects(loadModuleGraph(directory),
    /Unresolved package import alias: lib\/optimization-verification\.mjs:1 --dynamic import--> #collector/);
});

test('shared helpers preserve function identity at existing module entry points', async () => {
  for (const [legacy, shared, names] of [
    ['measure', 'run-directory', ['createRunDirectory']],
    ['measure', 'public-address', ['publicAddress']],
    ['scenarios', 'scenario-contract', ['validateScenarioConfig', 'assertionExpected']],
    ['interaction-measure', 'interaction-evidence', ['validateInteractionConfig', 'readInteractionRun', 'verifyInteractions', 'interactionMatchesNavigation', 'interactionBehaviorCovered']],
    ['patch-experiment', 'patch-verification', ['patchFingerprint', 'assertHypothesisScope', 'experimentHistoryGate', 'verifyOnlyPatch', 'verifyPatchExperiment']],
    ['optimization-verification', 'patch-verification', ['patchGate']],
  ]) {
    const old = await import(`../lib/${legacy}.mjs`);
    const current = await import(`../lib/${shared}.mjs`);
    for (const name of names) assert.equal(old[name], current[name], `${legacy}.${name}`);
  }
});
