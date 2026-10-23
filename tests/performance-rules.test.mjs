import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Liquid } from 'liquidjs';
import { inspectPerformanceSource, inspectPerformanceRuntime } from '../lib/performance-rules.mjs';
import { performanceStrategies } from '../lib/performance-strategies.mjs';
import { transformCode, analyzeCode } from '../lib/code-strategies.mjs';
import { createSitePlan, applySitePlan, rollbackSitePlan } from '../lib/site-changes.mjs';
import { auditPerformance } from '../lib/performance-audit.mjs';
import { auditSite } from '../lib/site-audit.mjs';
import { sourceSnapshot } from '../lib/runtime-profile.mjs';
import { scanTheme } from '../lib/scan.mjs';
import { siteRun } from './helpers/site-run.mjs';
import { renderReport } from '../lib/report.mjs';
import { spawnSync } from 'node:child_process';

const hash = s => createHash('sha256').update(s).digest('hex');
const inspect = (source, file = 'sections/main.liquid') => inspectPerformanceSource({ source, file, sourceHash: hash(source) });
const proof = (source, kind, extra = {}) => ({ ...Object.fromEntries(performanceStrategies.find(s => s.kind === kind).evidenceRequired.map(k => [k, true])),
  sourceHash: hash(source), summary: 'Synthetic reviewed fixture; not a production measurement.', ...extra });
const change = (source, kind, parameters, target = kind.startsWith('css-') ? 'assets/main.css' : 'sections/main.liquid', extra = {}) =>
  transformCode({ source, target, kind, parameters, evidence: proof(source, kind, extra) });
async function theme(t, files) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'perf-rules-test-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = path.join(root, 'theme'); await mkdir(project);
  for (const [file, text] of Object.entries(files)) { await mkdir(path.dirname(path.join(project, file)), { recursive: true }); await writeFile(path.join(project, file), text); }
  return { root, project };
}
const desktop = "{{ section.settings.desktop | image_url: width: 1600 | image_tag: alt: 'Hero', class: 'hero--desktop', loading: 'lazy', fetchpriority: 'high' }}";
const mobile = "{{ section.settings.mobile | image_url: width: 800 | image_tag: alt: 'Hero', class: 'hero--mobile' }}";
const pair = desktop + '\n' + mobile;
const head = "<html><head>\n{{ content_for_header }}\n{{ 'base.css' | asset_url | stylesheet_tag }}\n</head><body>{{ content_for_layout }}</body></html>";
const metafield = "before \n{%- for p in collection.products -%}\n{%- assign message = shop.metafields.banner.text.value -%}\n{{ message }}:{{ p.title }}\n{%- endfor -%}\nafter";
const css = '.hero { opacity: 0; visibility: hidden; animation: reveal 1s ease; color: red; }';
const pairParams = { desktopStart: 0, mobileStart: pair.indexOf(mobile), breakpoint: 749, desktopWidths: [800, 1600], mobileWidths: [400, 800], sizes: '100vw', className: 'hero' };

test('image_tag candidates retain filter parameters, offsets and distinguish picture from dual outputs', () => {
  const result = inspect(pair);
  assert.equal(result.images.length, 2);
  assert.ok(result.findings.some(f => f.ruleId === 'PERF_DUAL_HERO'));
  assert.ok(result.findings.some(f => f.ruleId === 'PERF_IMAGE_TAG_LOADING'));
  assert.ok(result.findings.every(f => f.status === 'candidate' && f.sourceHash === hash(pair)));
  assert.ok(!inspect(`<picture>${pair}</picture>`).findings.some(f => f.ruleId === 'PERF_DUAL_HERO'));
  assert.ok(inspect(desktop + '{% if show_mobile %}' + mobile + '{% endif %}').findings.some(f=>f.ruleId==='PERF_DUAL_HERO'&&f.evidence[0].branchDependent));
  assert.ok(inspect('<img class="hero--desktop" src="a"><img class="hero--mobile" src="b">').findings.some(f=>f.ruleId==='PERF_DUAL_HERO'&&f.suggestedStrategy===null));
});
test('comments, raw, schema and script strings cannot become Liquid performance findings', () => {
  for (const source of [`{% comment %}${pair}{% endcomment %}`, `{% raw %}${pair}{% endraw %}`,
    `{% schema %}{"label":"image_tag"}{% endschema %}`, `<script>const demo = ${JSON.stringify(pair)};</script>`, `<!-- ${pair} -->`]) {
    assert.equal(inspect(source).findings.length, 0, source);
  }
});
test('nested data access and JSON over-fetch are separate from syntax complexity', () => {
  const result = inspect("{% for p in collection.products %}{% for v in p.variants %}{{ v.metafields.x.y.value }}{% render 'card', v:v %}{% endfor %}{{ p.variants | json }}{% endfor %}");
  for (const id of ['PERF_LIQUID_NESTED_LOOP', 'PERF_LIQUID_METAFIELD', 'PERF_LIQUID_OVERFETCH', 'PERF_LIQUID_RENDER_LOOP'])
    assert.ok(result.findings.some(f => f.ruleId === id), id);
  assert.ok(!inspect('{% paginate collection.products by 20 %}{% for p in collection.products %}{{ p.title }}{% endfor %}{% endpaginate %}').findings.some(f => f.ruleId === 'PERF_LIQUID_OVERFETCH'));
});
test('head rules respect header boundary and retain live streaming verification requirement', () => {
  assert.ok(inspect(head, 'layout/theme.liquid').findings.some(f => f.ruleId === 'PERF_HEAD_RESOURCE_ORDER'));
  assert.ok(!inspect(head.replace("{{ content_for_header }}", ''), 'layout/theme.liquid').findings.some(f => f.ruleId === 'PERF_HEAD_RESOURCE_ORDER'));
  assert.ok(inspect('<head>{% for p in collection.products %}{{ p.title }}{% endfor %}{{ content_for_header }}</head>').findings.some(f => f.ruleId === 'PERF_HEAD_LIQUID_COST'));
});
test('CSS inventory does not call every hidden component an LCP defect; dynamic parsing remains explicit', () => {
  assert.equal(inspect('.drawer{opacity:0}', 'assets/main.css').findings.length, 0);
  assert.ok(inspect(css, 'assets/main.css').findings.some(f => f.ruleId === 'PERF_LCP_REVEAL'));
  assert.equal(inspect('.hero{color:{{ settings.color }}}', 'assets/main.css').issues[0].reason, 'dynamic-css-requires-render');
  assert.ok(inspect('{% stylesheet %}'+css+'{% endstylesheet %}').findings.some(f=>f.ruleId==='PERF_LCP_REVEAL'));
});
test('image loading changes preserve source/crop/alt/sizes and require actual initial placement', () => {
  const kind = 'liquid-image-tag-loading';
  const result = change(desktop, kind, { outputStart: 0, loading: 'eager' }, undefined, { isLCP: true, inViewport: true });
  assert.match(result.after, /loading: 'eager'/); assert.match(result.after, /fetchpriority: 'high'/);
  assert.match(result.after, /alt: 'Hero'/); assert.match(result.after, /image_url: width: 1600/);
  assert.throws(() => change(desktop, kind, { outputStart: 0, loading: 'eager' }), /explicit initial/);
  assert.throws(() => change(desktop.replace("'lazy'", 'section.settings.loading'), kind, { outputStart: 0, loading: 'eager' }, undefined, { isLCP: true, inViewport: true }), /Dynamic/);
  assert.throws(() => change(desktop, kind, { outputStart: 0, loading: 'lazy' }, undefined, { isLCP: false, inViewport: false }), /downgraded/);
});
test('picture plan retains original image objects, builds both responsive sources, and uses one high priority img', () => {
  const result = change(pair, 'liquid-picture-pair', pairParams);
  assert.equal((result.after.match(/\| image_tag/g) ?? []).length, 1);
  assert.match(result.after, /max-width: 749px/); assert.match(result.after, /min-width: 750px/);
  assert.match(result.after, /section.settings.mobile \| image_url: width: 400/);
  assert.match(result.after, /width="{{ section.settings.mobile.width }}"/);
  assert.match(result.after, /class: 'hero'/);
  assert.ok(!result.after.includes('hero--mobile'));
});
test('picture conversion refuses distinct alt, conditional pairs, unknown attributes and unsafe widths', () => {
  for (const source of [pair.replace("alt: 'Hero', class: 'hero--mobile'", "alt: 'Other', class: 'hero--mobile'"),
    pair.replace("class: 'hero--desktop'", "class: 'hero--desktop', style: 'display:none'"),
    pair.replace('\n', '\n<span>content</span>\n')]) {
    assert.throws(() => change(source, 'liquid-picture-pair', { ...pairParams, mobileStart: source.indexOf(mobile) }));
  }
  assert.throws(() => change(pair, 'liquid-picture-pair', { ...pairParams, mobileWidths: [400, 1600] }), /widths/);
  const wrapped = `{% if show %}${pair}{% endif %}`;
  assert.throws(() => change(wrapped, 'liquid-picture-pair', { ...pairParams, desktopStart: wrapped.indexOf(desktop), mobileStart: wrapped.indexOf(mobile) }), /unconditional/);
});
test('head patch preserves content_for_header and refuses intervening assignments/scripts or dynamic resources', () => {
  const kind = 'liquid-hoist-head-resource', start = head.indexOf("{{ 'base.css'");
  const result = change(head, kind, { resourceStart: start }, 'layout/theme.liquid');
  assert.ok(result.after.indexOf('base.css') < result.after.indexOf('content_for_header'));
  assert.equal((result.after.match(/content_for_header/g) ?? []).length, 1);
  for (const middle of ["{% assign style = 'other' %}", '<script>window.x=Shopify.shop;</script>']) {
    const s = head.slice(0, start) + middle + head.slice(start);
    assert.throws(() => change(s, kind, { resourceStart: s.indexOf("{{ 'base.css'") }, 'layout/theme.liquid'), /Intervening/);
  }
  const dynamic = head.replace("'base.css'", 'settings.css');
  assert.throws(() => change(dynamic, kind, { resourceStart: dynamic.indexOf('{{ settings.css') }, 'layout/theme.liquid'), /literal/);
});
test('metafield cache preserves whitespace/output and performs one lookup per nonempty loop', async () => {
  const result = change(metafield, 'liquid-cache-metafield', { assignStart: metafield.indexOf('{%- assign') });
  const engine = new Liquid();
  for (const count of [0, 1, 5]) {
    let reads = 0;
    const shop = { get metafields() { reads++; return { banner: { text: { value: 'banner' } } }; } };
    const data = { shop, collection: { products: Array.from({ length: count }, (_, i) => ({ title: 'p' + i })) } };
    const before = await engine.parseAndRender(metafield, data); reads = 0;
    const after = await engine.parseAndRender(result.after, data);
    assert.equal(after, before); assert.equal(reads, count ? 1 : 0);
  }
});
test('metafield caching refuses item-dependent values, writes, render/include, early exits and multiline liquid', () => {
  for (const s of [metafield.replace('shop.metafields', 'p.metafields'),
    metafield.replace('{{ message }}', "{% assign shop = p %}{{ message }}"),
    metafield.replace('{{ message }}', "{% render 'x' %}{{ message }}"),
    metafield.replace('{{ message }}', '{% break %}{{ message }}'),
    metafield.replace('for p', 'for shop')])
    assert.throws(() => change(s, 'liquid-cache-metafield', { assignStart: s.indexOf('{%- assign') }));
});
test('reveal optimization changes only supported visibility/motion properties and rejects ambiguous selectors', () => {
  const result = change(css, 'css-lcp-reveal', { selector: '.hero' });
  assert.match(result.after, /opacity: 1/); assert.match(result.after, /visibility: visible/);
  assert.match(result.after, /animation: none/); assert.match(result.after, /color: red/);
  for (const s of [css + '\n.hero{opacity:0}', '@media(min-width:1px){' + css + '}', css.replace('color: red', 'transform: translateY(10px)'), css.replace('opacity: 0', 'opacity: 0!important')])
    assert.throws(() => change(s, 'css-lcp-reveal', { selector: '.hero' }));
});
test('all five generated plans apply and roll back with fingerprint verification', async t => {
  const cases = [
    ['liquid-image-tag-loading', 'sections/a.liquid', desktop, { outputStart: 0, loading: 'eager' }, { isLCP: true, inViewport: true }],
    ['liquid-picture-pair', 'sections/a.liquid', pair, pairParams],
    ['liquid-hoist-head-resource', 'layout/theme.liquid', head, { resourceStart: head.indexOf("{{ 'base.css'") }],
    ['liquid-cache-metafield', 'sections/a.liquid', metafield, { assignStart: metafield.indexOf('{%- assign') }],
    ['css-lcp-reveal', 'assets/a.css', css, { selector: '.hero' }],
  ];
  for (const [kind, target, source, parameters, extra] of cases) {
    const f = await theme(t, { [target]: source });
    const plan = await createSitePlan({ project: f.project, recipe: { schemaVersion: 1, changes: [{ target, kind, parameters, reason: 'Fixture optimization', evidence: proof(source, kind, extra) }] } });
    await applySitePlan(plan, f.project);
    assert.notEqual(await readFile(path.join(f.project, target), 'utf8'), source);
    await rollbackSitePlan(plan, f.project);
    assert.equal(await readFile(path.join(f.project, target), 'utf8'), source);
    plan.changes[0].after += 'tamper';
    await assert.rejects(applySitePlan(plan, f.project));
  }
});
test('runtime requires current source and distinguishes animation correlation from proof', async t => {
  const f = await theme(t, { 'sections/main.liquid': desktop }), snapshot = await sourceSnapshot(f.project);
  const profile = { kind: 'runtime-profile', status: 'complete', sourceStable: true, snapshot, config: { url: 'https://shop.test/', device: 'mobile' },
    initial: { lcp: { presentation: { selector: '.hero', tag: 'IMG', classes: ['hero--desktop'], loading: 'lazy', fetchPriority: 'auto',
      ancestors: [{ selector: '.hero', opacity: '1', visibility: 'visible', animations: [{ state: 'finished' }] }] } } }, lcp: { renderDelayMs: 300 } };
  const result = await auditPerformance({ project: f.project, profiles: [profile] });
  assert.ok(result.findings.some(f => f.id.startsWith('runtime:') && f.ruleId === 'PERF_LCP_REVEAL'));
  assert.ok(result.findings.filter(f => f.id.startsWith('runtime:')).every(f => f.sourceAssociation === 'requires-rendered-source-review'));
  profile.snapshot = { hash: 'stale' };
  const stale = inspectPerformanceRuntime({ profiles: [profile], snapshot });
  assert.equal(stale.findings.length, 0); assert.equal(stale.issues[0].reason, 'incomplete-or-stale-runtime-profile');
});
test('scan, audit, CLI and analysis expose P0 candidates without setting review booleans', async t => {
  const f = await theme(t, { 'sections/main.liquid': pair });
  const scan = await scanTheme({ project: f.project });
  assert.ok(scan.candidates.some(c => c.ruleId === 'PERF_DUAL_HERO'));
  const analysis = await analyzeCode({ project: f.project, target: 'sections/main.liquid' });
  assert.ok(analysis.reviewTasks.some(c => c.suggestedStrategy === 'liquid-picture-pair'));
  assert.ok(analysis.reviewTasks.filter(c => c.recipe).every(c => !c.recipe.evidence.initialLcpConfirmed));
  const audit = await auditPerformance({ project: f.project });
  assert.equal(audit.coverage[0].runtime, 'not-assessed');
  assert.match(renderReport(audit), /PERF_DUAL_HERO/);
  const out = path.join(f.root, 'performance.json');
  const cli = spawnSync(process.execPath, ['scripts/perfkit.mjs', 'audit-performance', '--project', f.project, '--out', out], { encoding: 'utf8' });
  assert.equal(cli.status, 3, cli.stderr);
  assert.equal(JSON.parse(await readFile(out, 'utf8')).kind, 'performance-audit');
});
test('large resource candidates reach site findings with no fabricated savings; indirect head calls are visible', async t => {
  const f = await theme(t, { 'assets/big.js': '// large\n' + ' '.repeat(101 * 1024),
    'layout/theme.liquid': "<head>{% render 'meta' %}{{ content_for_header }}</head>",
    'snippets/meta.liquid': '{% for p in collection.products %}{{ p.variants | json }}{% endfor %}' });
  const run = await siteRun(t, { devices: ['mobile'] });
  const audit = await auditSite({ project: f.project, run: run.root });
  assert.equal(audit.findings.find(f => f.ruleId === 'RAW_BYTES').estimate, null);
  assert.ok(audit.findings.some(f => f.ruleId === 'PERF_HEAD_LIQUID_COST'));
  assert.ok(audit.supplemental.some(s => s.kind === 'performance-audit'));
});
