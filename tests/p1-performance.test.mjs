import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { inspectPerformanceSource, inspectPerformanceRuntime, performanceRules } from '../lib/performance-rules.mjs';
import { p1PerformanceStrategies } from '../lib/p1-performance-strategies.mjs';
import { transformCode, analyzeCode } from '../lib/code-strategies.mjs';
import { createSitePlan, applySitePlan, rollbackSitePlan } from '../lib/site-changes.mjs';
import { scanTheme } from '../lib/scan.mjs';
import { auditPerformance } from '../lib/performance-audit.mjs';
import { auditSite } from '../lib/site-audit.mjs';
import { sourceSnapshot } from '../lib/runtime-profile.mjs';
import { renderReport } from '../lib/report.mjs';
import { siteRun } from './helpers/site-run.mjs';

const hash = source => createHash('sha256').update(source).digest('hex');
const inspect = (source, file = 'layout/theme.liquid') => inspectPerformanceSource({ source, file, sourceHash: hash(source) });
const ids = result => new Set(result.findings.map(f => f.ruleId));
const proof = (source, kind) => ({ ...Object.fromEntries(p1PerformanceStrategies.find(s => s.kind === kind).evidenceRequired.map(k => [k, true])),
  sourceHash: hash(source), summary: 'Isolated synthetic review evidence; not a store measurement.' });
const change = (source, kind, parameters, target = kind.startsWith('css-') ? 'assets/main.css' : kind.startsWith('js-') ? 'assets/main.js' : 'layout/theme.liquid') =>
  transformCode({ source, target, kind, parameters, evidence: proof(source, kind) });
async function theme(t, files) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'perf-p1-test-'))), project = path.join(root, 'theme');
  t.after(() => rm(root, { recursive: true, force: true })); await mkdir(project);
  for (const [file, text] of Object.entries(files)) { await mkdir(path.dirname(path.join(project, file)), { recursive: true }); await writeFile(path.join(project, file), text); }
  return { root, project };
}
const hint = '<link rel="preload" href="/a.js" as="script">';
const duplicate = `<head>\n${hint}\n${hint}\n{{ content_for_header }}\n</head>`;
const duplicateParams = { firstStart: duplicate.indexOf(hint), duplicateStart: duplicate.lastIndexOf(hint) };
const asyncCSS = '<link rel="stylesheet" href="/critical.css" media="print" onload="this.onload=null;this.media=\'all\'">';
const passiveJS = "let count=0;\nfunction handle(){count+=1;}\nwindow.addEventListener('wheel',handle,false);";
const passiveParams = { registrationStart: passiveJS.indexOf('window.addEventListener') };
const transitions = '.panel { transition-property: all; transition-duration: 120ms; opacity: .4; transform: translateX(0); color: red; }';

test('P1 catalog has 16 independently identified official-guidance checks', () => {
  assert.equal(performanceRules.filter(r => r.phase === 'P1').length, 16);
  assert.equal(new Set(performanceRules.map(r => r.id)).size, performanceRules.length);
  assert.ok(performanceRules.filter(r => r.phase !== 'integrity').every(r => r.source.startsWith('https://shopify.dev/')));
});
test('hint analysis counts Liquid preloads and keeps branch, credentials and media distinctions', () => {
  const found = inspect(duplicate).findings.find(f => f.suggestedStrategy === 'liquid-dedupe-resource-hint');
  assert.deepEqual([found.evidence[0].firstStart, found.evidence[0].duplicateStart], Object.values(duplicateParams));
  for (const second of [hint.replace('as="script"', 'as="script" crossorigin'), hint.replace('/a.js', '/b.js'), hint.replace('as="script"', 'as="script" media="print"')])
    assert.ok(!inspect(`<head>${hint}${second}</head>`).findings.some(f => f.suggestedStrategy));
  assert.ok(!inspect(`<head>${hint}{% if x %}${hint}{% endif %}</head>`).findings.some(f => f.suggestedStrategy));
  const preloads = inspect("{{ 'a.css' | asset_url | stylesheet_tag: preload: true }}{{ 'font.woff2' | asset_url | preload_tag: as: 'font' }}{{ product.featured_image | image_tag: preload: true }}");
  assert.equal(preloads.resourceHints.length, 3); assert.ok(ids(preloads).has('PERF_PRELOAD_BUDGET'));
  assert.equal(inspect("{{ x | image_tag: preload: false }}").resourceHints.length, 0);
  assert.ok(inspect("{{ x | image_tag: preload: settings.preload }}").issues.some(i => i.reason === 'dynamic-liquid-preload-requires-render'));
});
test('font hint credentials, platform connection hints and async CSS are candidates', () => {
  const result = inspect('<head><link rel="preconnect" href="https://cdn.shopify.com"><link rel="preload" as="font" href="/font.woff2">' + asyncCSS + '</head>');
  for (const id of ['PERF_PRECONNECT', 'PERF_PRELOAD_BUDGET', 'PERF_ASYNC_CSS']) assert.ok(ids(result).has(id));
  assert.ok(!ids(inspect('<link rel="preload" as="font" href="/font.woff2" crossorigin>')).has('PERF_PRELOAD_BUDGET'));
  assert.ok(!ids(inspect('<link rel="preconnect" href="https://cdn.shopify.com.example.test">')).has('PERF_PRECONNECT'));
});
test('P1 ignores inert markup, comments, JSON data and JS strings; dynamic sources are explicit', () => {
  for (const source of [`{% comment %}${duplicate}${asyncCSS}{% endcomment %}`, `{% raw %}${duplicate}{% endraw %}`,
    `<!-- ${duplicate} -->`, `<template>${asyncCSS}</template>`, `<noscript>${asyncCSS}</noscript>`,
    `<script type="application/json">${JSON.stringify({ html: duplicate })}</script>`,
    `<script>const s=${JSON.stringify("document.startViewTransition(()=>{});")};</script>`]) {
    assert.equal(inspect(source).findings.filter(f => f.ruleId.startsWith('PERF_') && performanceRules.find(r => r.id === f.ruleId)?.phase === 'P1').length, 0, source);
  }
  assert.ok(inspect('<link rel="preload" href="{{ x }}">').issues.some(i => i.reason === 'dynamic-resource-hint-requires-render'));
  assert.ok(inspect('const x = ;', 'assets/main.js').issues.some(i => i.reason === 'p1-js-parse-error'));
});
test('CSS checks cover external fonts, font display, fallback metrics and layout transitions', () => {
  const source = '@font-face{font-family:"Brand";src:url(https://fonts.example.test/a.woff2);font-display:block}.box{transition:all .2s}@keyframes move{to{left:50px}}';
  const result = inspect(source, 'assets/main.css');
  for (const id of ['PERF_FONT_DELIVERY', 'PERF_FONT_DISPLAY', 'PERF_LAYOUT_ANIMATION']) assert.ok(ids(result).has(id));
  assert.ok(ids(inspect(source.replace('block', 'swap'), 'assets/main.css')).has('PERF_FONT_FALLBACK'));
  assert.ok(!ids(inspect('.box{transition:opacity .2s,transform .2s}', 'assets/main.css')).has('PERF_LAYOUT_ANIMATION'));
  assert.ok(ids(inspect(`{% stylesheet %}${source}{% endstylesheet %}`)).has('PERF_FONT_DISPLAY'));
  assert.ok(ids(inspect('<style>{{ settings.body_font | font_face }}</style>')).has('PERF_FONT_DISPLAY'));
  assert.ok(!ids(inspect('<style>{{ settings.body_font | font_face: font_display: "swap" }}</style>')).has('PERF_FONT_DISPLAY'));
  assert.ok(inspect('.a{color:{{ color }}}', 'assets/main.css').issues.some(i => i.reason === 'p1-dynamic-css-requires-render'));
});
test('JS candidates locate direct ready-gated fetch, wheel listeners, view transitions and explicit shims', () => {
  const source = "import 'es-module-shims';\ndocument.addEventListener('DOMContentLoaded',()=>{fetch('/critical.json')});\n" + passiveJS + "\ndocument.startViewTransition(()=>{});";
  const result = inspect(source, 'assets/main.mjs');
  for (const id of ['PERF_JS_DOM_READY_FETCH', 'PERF_JS_PASSIVE_LISTENER', 'PERF_JS_VIEW_TRANSITION', 'PERF_JS_MODULE_SHIMS']) assert.ok(ids(result).has(id), id);
  assert.ok(!ids(inspect("document.addEventListener('DOMContentLoaded',()=>{ const unused=()=>fetch('/x'); });", 'assets/main.js')).has('PERF_JS_DOM_READY_FETCH'));
  assert.ok(!ids(inspect("window.addEventListener('wheel',handle,{passive:true});", 'assets/main.js')).has('PERF_JS_PASSIVE_LISTENER'));
  assert.ok(ids(inspect("<script src=\"https://example.test/es-module-shims@2/dist/shim.js\"></script>")).has('PERF_JS_MODULE_SHIMS'));
});
test('hidden Liquid work and limited arrays do not pretend rendered bounds are database bounds', () => {
  const result = inspect('<dialog>{% for p in search.results limit: 4 %}{% render "card", product:p %}{% endfor %}</dialog>');
  assert.ok(ids(result).has('PERF_HIDDEN_DOM')); assert.ok(ids(result).has('PERF_LIQUID_FETCH_LIMIT'));
  assert.ok(!ids(inspect('{% for p in collection.products limit:4 %}{{ p.title }}{% endfor %}')).has('PERF_LIQUID_FETCH_LIMIT'));
  assert.ok(!ids(inspect('{% paginate search.results by 4 %}{% for p in search.results limit:4 %}{{ p.title }}{% endfor %}{% endpaginate %}')).has('PERF_LIQUID_FETCH_LIMIT'));
});
test('duplicate hint strategy preserves first, rejects dynamic/conditional/hooked/different-credential cases', () => {
  const after = change(duplicate, 'liquid-dedupe-resource-hint', duplicateParams).after;
  assert.equal(after.split(hint).length - 1, 1); assert.ok(after.includes('{{ content_for_header }}'));
  for (const s of [
    `<head>${hint}${hint.replace('as="script"', 'as="script" crossorigin')}</head>`,
    `<head>${hint}{% if x %}${hint}{% endif %}</head>`,
    `<head>${hint.replace('href="/a.js"', 'href="{{ a }}"')}${hint.replace('href="/a.js"', 'href="{{ a }}"')}</head>`,
    `<head>${hint.replace('as="script"', 'as="script" id="hint"')}${hint.replace('as="script"', 'as="script" id="hint"')}</head>`,
  ]) assert.throws(() => change(s, 'liquid-dedupe-resource-hint', { firstStart: s.indexOf('<link'), duplicateStart: s.lastIndexOf('<link') }));
});
test('critical CSS conversion preserves resource, integrity, noscript and source format outside removed attributes', () => {
  const source = '<head>' + asyncCSS.replace('media="print"', 'integrity="sha256-abcd" crossorigin media="print"') + '</head><noscript><link rel="stylesheet" href="/critical.css"></noscript>';
  const after = change(source, 'liquid-critical-css-sync', { tagStart: source.indexOf('<link') }).after;
  assert.ok(!after.includes('onload')); assert.ok(!after.includes('media="print"'));
  assert.ok(after.includes('integrity="sha256-abcd"')); assert.ok(after.includes('<noscript>'));
  const liquid = asyncCSS.replace('/critical.css', "{{ 'main.css' | asset_url }}");
  assert.ok(change(liquid, 'liquid-critical-css-sync', { tagStart: 0 }).after.includes("{{ 'main.css' | asset_url }}"));
  for (const bad of [asyncCSS.replace("this.onload=null;", 'alert(1);'), asyncCSS.replace("='all'", "='screen'"), asyncCSS.replace('<link ', '<link disabled '),
    asyncCSS.replace('/critical.css', '{{ settings.css }}'), asyncCSS.replace('media="print"', 'href="/other.css" media="print"'),
    `<template>${asyncCSS}</template>`]) assert.throws(() => change(bad, 'liquid-critical-css-sync', { tagStart: bad.indexOf('<link') }));
});
test('passive patch keeps callback identity, count, capture and remove/re-register behavior', () => {
  const original = passiveJS + "\nwindow.removeEventListener('wheel',handle,false);";
  const after = change(original, 'js-passive-listener', passiveParams).after, records = [];
  const context = vm.createContext({ window: { addEventListener: (...a) => records.push(['add', ...a]), removeEventListener: (...a) => records.push(['remove', ...a]) } });
  vm.runInContext(after, context);
  assert.equal(records[0][2], records[1][2]); assert.equal(records[0][3].capture, false); assert.equal(records[0][3].passive, true);
  records[0][2](); records[0][2](); assert.equal(vm.runInContext('count', context), 2);
  vm.runInContext("window.addEventListener('wheel',handle,false)", context);
  assert.equal(records[2][2], records[0][2]);
});
test('passive patch refuses cancellation, aliases, event input, opaque calls, options and shadowing', () => {
  for (const source of [
    passiveJS.replace('count+=1;', 'event.preventDefault();'), passiveJS.replace('handle()', 'handle(event)'),
    passiveJS.replace('count+=1;', 'sideEffect();'), passiveJS.replace('false)', '{passive:false})'),
    passiveJS + '\nconst alias=handle;', 'const window={};' + passiveJS,
    passiveJS + "\nwindow.addEventListener('touchmove',handle);", passiveJS.replace('count+=1;', 'this.count++;'),
  ]) assert.throws(() => change(source, 'js-passive-listener', { registrationStart: source.indexOf('window.addEventListener') }), source);
});
test('transition strategy changes only reviewed property scope and rejects shorthand/ambiguous rules', () => {
  const after = change(transitions, 'css-transition-properties', { selector: '.panel', properties: ['opacity', 'transform'] }).after;
  assert.ok(after.includes('transition-property: opacity, transform')); assert.ok(after.includes('transition-duration: 120ms')); assert.ok(after.includes('color: red'));
  for (const source of [transitions + '.panel{color:blue}', '@media(min-width:1px){' + transitions + '}', transitions.replace(': all;', ': all !important;'),
    transitions.replace('transition-property: all;', 'transition:all .2s;')])
    assert.throws(() => change(source, 'css-transition-properties', { selector: '.panel', properties: ['opacity'] }));
  assert.throws(() => change(transitions, 'css-transition-properties', { selector: '.panel', properties: ['width'] }));
});
test('all four P1 strategies require evidence, replay in plan/apply, rollback exactly, and reject tampering/drift', async t => {
  const cases = [
    ['liquid-dedupe-resource-hint', duplicate, duplicateParams, 'layout/theme.liquid'],
    ['liquid-critical-css-sync', '<head>' + asyncCSS + '</head>', { tagStart: 6 }, 'layout/theme.liquid'],
    ['js-passive-listener', passiveJS, passiveParams, 'assets/main.js'],
    ['css-transition-properties', transitions, { selector: '.panel', properties: ['opacity', 'transform'] }, 'assets/main.css'],
  ];
  for (const [kind, source, parameters, target] of cases) {
    assert.throws(() => transformCode({ source, target, kind, parameters, evidence: { sourceHash: hash(source), summary: 'Missing review' } }), /evidence/);
    const f = await theme(t, { [target]: source });
    const plan = await createSitePlan({ project: f.project, recipe: { schemaVersion: 1, changes: [{ target, kind, parameters, evidence: proof(source, kind), reason: 'P1 isolated test' }] } });
    await applySitePlan(plan, f.project); assert.notEqual(await readFile(path.join(f.project, target), 'utf8'), source);
    await rollbackSitePlan(plan, f.project); assert.equal(await readFile(path.join(f.project, target), 'utf8'), source);
    const tampered = structuredClone(plan); tampered.changes[0].after += 'tamper'; await assert.rejects(applySitePlan(tampered, f.project));
    await writeFile(path.join(f.project, target), source + '\n/* drift */'); await assert.rejects(applySitePlan(plan, f.project));
  }
});
test('P1 runtime inspection works without LCP, rejects stale source, and retains missing/truncated evidence', async t => {
  const f = await theme(t, { 'sections/main.liquid': '<section>Fixture</section>' }), snapshot = await sourceSnapshot(f.project);
  const profile = { kind: 'runtime-profile', status: 'complete', sourceStable: true, snapshot, config: { url: 'https://shop.test/', device: 'mobile' },
    initial: { delivery: { version: 1, links: [1, 2, 3].map(i => ({ rel: 'preload', href: `/font${i}.woff2`, mediaMatches: true })), hiddenComponents: [] } },
    resources: [{ type: 'Document', linkHeader: '</a.css>; rel=preload; as=style' }] };
  const audit = await auditPerformance({ project: f.project, profiles: [profile] });
  const finding = audit.findings.find(f => f.ruleId === 'PERF_PRELOAD_BUDGET');
  assert.equal(finding.sourceAssociation, 'requires-rendered-source-review'); assert.equal(finding.evidence[0].earlyHints103, 'not-captured');
  assert.ok(audit.issues.some(i => i.reason === 'lcp-presentation-unavailable-recapture'));
  delete profile.initial.delivery;
  assert.ok(inspectPerformanceRuntime({ profiles: [profile], snapshot }).issues.some(i => i.reason === 'p1-delivery-evidence-unavailable-recapture'));
  profile.snapshot = { hash: 'stale' }; assert.equal(inspectPerformanceRuntime({ profiles: [profile], snapshot }).findings.length, 0);
  assert.equal(inspectPerformanceRuntime({ profiles: [null], snapshot }).findings.length, 0);
  profile.snapshot = snapshot; profile.initial.delivery = { version: 1, links: [null], hiddenComponents: [] };
  assert.ok(inspectPerformanceRuntime({ profiles: [profile], snapshot }).issues.some(i => i.reason === 'p1-delivery-evidence-unavailable-recapture'));
});
test('runtime dialog and connection evidence stays advisory and separates CORS connections', async t => {
  const f = await theme(t, { 'sections/main.liquid': '<section>Fixture</section>' }), snapshot = await sourceSnapshot(f.project);
  const profile = { kind: 'runtime-profile', status: 'complete', sourceStable: true, snapshot, config: { url: 'https://shop.test/', device: 'mobile' },
    initial: { delivery: { version: 1, truncated: true, links: [{ rel: 'preconnect', href: 'https://fonts.test', crossOrigin: null }, { rel: 'preconnect', href: 'https://fonts.test', crossOrigin: '' }],
      hiddenComponents: [{ selector: 'dialog', descendants: 250 }] }, lcp: { presentation: { tag: 'H1', selector: 'dialog h1', ancestors: [{ tag: 'DIALOG', role: null }] } } },
    resources: [{ type: 'Document', linkHeaderTruncated: true }] };
  const result = inspectPerformanceRuntime({ profiles: [profile], snapshot });
  assert.ok(ids(result).has('PERF_DIALOG_LCP')); assert.ok(ids(result).has('PERF_HIDDEN_DOM')); assert.ok(!ids(result).has('PERF_PRECONNECT'));
  assert.ok(result.issues.some(i => i.reason === 'p1-delivery-evidence-truncated'));
  assert.ok(result.issues.some(i => i.reason === 'document-link-header-truncated'));
});
test('scan/analysis/CLI/site report integrate P1 and reuse native stylesheet dependency analysis', async t => {
  const f = await theme(t, { 'layout/theme.liquid': duplicate, 'assets/main.js': passiveJS,
    'sections/a.liquid': '{% stylesheet %}.owned{color:red}{% endstylesheet %}<div class="owned"></div>',
    'sections/b.liquid': '<div class="owned"></div>' });
  const scan = await scanTheme({ project: f.project }); assert.ok(ids(scan).has('PERF_PRELOAD_BUDGET'));
  const analysis = await analyzeCode({ project: f.project, target: 'assets/main.js' });
  const review = analysis.reviewTasks.find(f => f.suggestedStrategy === 'js-passive-listener');
  assert.equal(review.recipe.parameters.registrationStart, passiveParams.registrationStart);
  assert.equal(review.recipe.evidence.cancellationNotRequired, undefined);
  const audit = await auditPerformance({ project: f.project });
  assert.ok(ids(audit).has('PERF_STYLESHEET_SCOPE')); assert.equal(audit.nativeStylesheets.kind, 'stylesheet-audit');
  assert.equal(audit.coverage.length, 39); assert.match(renderReport(audit), /PERF_PRELOAD_BUDGET/);
  assert.equal(audit.coverage.find(r => r.id === 'PERF_DIALOG_LCP').static, 'not-applicable-runtime-only');
  assert.equal(audit.coverage.find(r => r.id === 'PERF_JS_DOM_READY_FETCH').runtime, 'not-assessed');
  const out = path.join(f.root, 'p1.json');
  const cli = spawnSync(process.execPath, ['scripts/perfkit.mjs', 'audit-performance', '--project', f.project, '--out', out], { encoding: 'utf8' });
  assert.equal(cli.status, 3, cli.stderr); assert.equal(JSON.parse(await readFile(out, 'utf8')).coverage.length, 39);
  const run = await siteRun(t, { devices: ['mobile'] }), site = await auditSite({ project: f.project, run: run.root });
  assert.ok(ids(site).has('PERF_PRELOAD_BUDGET')); assert.ok(ids(site).has('PERF_STYLESHEET_SCOPE'));
});
