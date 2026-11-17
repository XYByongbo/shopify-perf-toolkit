import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { scanTheme } from '../lib/scan.mjs';
import { inspectSource } from '../lib/inspect.mjs';
import { createSourceSyntaxCache } from '../lib/source-syntax-cache.mjs';

async function theme(t, content) {
  const project = await mkdtemp(path.join(tmpdir(), 'perfkit-scan-'));
  t.after(() => rm(project, { recursive: true, force: true }));
  for (const [file, data] of Object.entries(content)) { await mkdir(path.dirname(path.join(project, file)), { recursive: true }); await writeFile(path.join(project, file), data); }
  return project;
}
const edge = (scan, from, to) => scan.dependencies.find((item) => item.from === from && item.to === to);

test('whole-theme scan inventories hashes, resolves dependency graph, aggregates findings without mutation', async (t) => {
  const content = {
    'layout/theme.liquid': `{% sections 'header-group' %}\n{{ 'theme.css' | asset_url | stylesheet_tag }}\n{% render 'shared' %}`,
    'sections/header-group.json': `/* Shopify generated header\n */\n{"type":"header","sections":{"header":{"type":"header"}},"order":["header"]}`,
    'sections/header.liquid': `{% render 'shared' %}<img src="{{ section.settings.image | image_url: width: 2000 }}">`,
    'snippets/shared.liquid': `<span>Shared</span>`,
    'templates/index.json': '{"sections":{"main":{"type":"hero"}},"order":["main"]}',
    'sections/hero.liquid': `{% render 'shared' %}\n{{ 'main.js' | asset_url | script_tag }}`,
    'assets/main.js': `import helper from './helper.js'; import './theme.css';`,
    'assets/helper.js': 'export default function helper() {}',
    'assets/theme.css': `@import './other.css'; .font { background: url(./icon.svg?v=2); }`,
    'assets/other.css': '.a{color:red}',
    'assets/icon.svg': '<svg/>',
    'README.md': 'not a theme file',
  };
  const project = await theme(t, content);
  const scan = await scanTheme({ project });
  assert.equal(scan.kind, 'site-scan'); assert.equal(scan.schemaVersion, 1); assert.equal(scan.complete, true);
  assert.equal(scan.summary.files, 11); assert.equal(scan.summary.assets, 5);
  assert.equal(scan.summary.missingDependencies, 0); assert.equal(scan.summary.unresolvedDependencies, 0, JSON.stringify(scan.unresolved));
  assert.equal(edge(scan, 'layout/theme.liquid', 'sections/header-group.json').status, 'resolved');
  assert.equal(edge(scan, 'sections/header-group.json', 'sections/header.liquid').references[0].pointer, '/sections/header/type');
  assert.equal(edge(scan, 'assets/main.js', 'assets/helper.js').status, 'resolved');
  assert.equal(edge(scan, 'assets/theme.css', 'assets/icon.svg').status, 'resolved');
  const header = scan.inventory.files.find((file) => file.path === 'sections/header.liquid');
  assert.equal(header.sha256, createHash('sha256').update(content[header.path]).digest('hex'));
  assert.equal(header.staticReachability, 'reachable-from-entrypoint');
  assert.equal(scan.findings.length, 2); assert.equal(new Set(scan.findings.map((item) => item.id)).size, 2);
  assert.equal(scan.coverage.length, 12); assert.ok(scan.coverage.every((item) => !('pass' in item.statuses)));
  for (const [file, data] of Object.entries(content)) assert.equal(await readFile(path.join(project, file), 'utf8'), data);
  assert.equal(scan.pages[0].route, '/'); assert.equal(scan.pages[0].url, null);
});

test('comments/raw/schema are excluded; repeated literal edges retain occurrence evidence once per location', async (t) => {
  const source = `{% comment %}{% render 'no' %}{% endcomment %}\n{% raw %}{% section 'no' %}{% endraw %}\n{% schema %}{"asset":"{{ 'no.js' | asset_url }}"}{% endschema %}\n{% render 'shared' %}\n{% render 'shared' %}\n{% liquid\n  render 'shared'\n  assign script = 'live.js' | asset_url\n%}`;
  const project = await theme(t, { 'sections/main.liquid': source, 'snippets/shared.liquid': '', 'assets/live.js': '' });
  const scan = await scanTheme({ project });
  assert.equal(scan.dependencies.length, 2);
  assert.equal(edge(scan, 'sections/main.liquid', 'snippets/shared.liquid').references.length, 3);
  assert.equal(edge(scan, 'sections/main.liquid', 'assets/live.js').status, 'resolved');
});

test('dynamic references, cycles, missing files and unreferenced assets never become unused verdicts', async (t) => {
  const project = await theme(t, {
    'templates/index.liquid': `{% render 'a' %}{% render dynamic_name %}{% section section_name %}{{ settings.script | asset_url }}`,
    'snippets/a.liquid': `{% render 'b' %}{% render 'gone' %}`,
    'snippets/b.liquid': `{% render 'a' %}`,
    'assets/unlinked.js': `import 'bare-package'; import('./' + component);`,
  });
  const scan = await scanTheme({ project });
  assert.equal(scan.complete, true);
  assert.equal(scan.summary.unresolvedDependencies, 5);
  assert.equal(scan.summary.missingDependencies, 1);
  assert.equal(edge(scan, 'snippets/a.liquid', 'snippets/gone.liquid').status, 'missing');
  assert.deepEqual(scan.dependencyCycles, [['snippets/a.liquid', 'snippets/b.liquid', 'snippets/a.liquid']]);
  assert.equal(scan.inventory.files.find((item) => item.path === 'assets/unlinked.js').staticReachability, 'no-static-path');
  assert.equal(scan.candidates.length, 0);
  assert.ok(scan.limitations.some((item) => item.includes('does not mean unused')));
});

test('symlink files/directories and outside paths are never traversed', async (t) => {
  const project = await theme(t, { 'sections/main.liquid': '<div>safe</div>' });
  const outside = await theme(t, { 'secrets/secret.liquid': '<img src="secret">' });
  await mkdir(path.join(project, 'assets'));
  await symlink(path.join(outside, 'secrets'), path.join(project, 'assets/outside'));
  await symlink(path.join(outside, 'secrets/secret.liquid'), path.join(project, 'sections/outside.liquid'));
  await symlink(path.join(project, 'sections/main.liquid'), path.join(project, 'sections/alias.liquid'));
  await symlink(path.join(outside, 'secrets'), path.join(project, 'snippets'));
  const scan = await scanTheme({ project });
  assert.equal(scan.complete, false); assert.equal(scan.skipped.length, 4); assert.equal(scan.inventory.files.length, 1);
  assert.equal(scan.findings.length, 0); assert.ok(!JSON.stringify(scan).includes('<img src="secret">'));
});

test('JSON comments preserve quoted URLs; malformed JSON reports incomplete without echoing config values', async (t) => {
  const project = await theme(t, {
    'config/settings_data.json': `/* generated */ {"current":{"api_token":"do-not-print-secret","blocks":{"x":{"type":"shopify://apps/example/blocks/app/123", "settings":{"secret":"do-not-print-secret"}}}}}`,
    'templates/product.json': '{"sections": {"main":{"type":"product", "settings":{"url":"https://example.com/a//b/*c*/"}}}}',
    'sections/product.liquid': '',
    'templates/broken.json': '{"secret": "never-echo-invalid-content",',
    'sections/broken-group.json': '/* unterminated',
  });
  const scan = await scanTheme({ project });
  assert.equal(scan.complete, false); assert.equal(scan.errors.length, 2);
  assert.ok(scan.errors.every((error) => error.code === 'INVALID_JSON'));
  assert.equal(scan.inventory.appIndicators.length, 1);
  assert.ok(!JSON.stringify(scan).includes('do-not-print-secret'));
  assert.ok(!JSON.stringify(scan).includes('never-echo-invalid-content'));
  assert.equal(edge(scan, 'templates/product.json', 'sections/product.liquid').status, 'resolved');
});

test('source caps and binary disguised as source produce explicit incomplete coverage', async (t) => {
  const large = Buffer.alloc(5 * 1024 * 1024 + 1, 32);
  const project = await theme(t, { 'assets/large.js': large, 'assets/binary.js': Buffer.from([1, 0, 2]), 'assets/video.mp4': Buffer.alloc(16, 0) });
  const scan = await scanTheme({ project });
  assert.equal(scan.complete, false); assert.equal(scan.skipped.length, 2); assert.equal(scan.inventory.files.length, 3);
  assert.equal(scan.summary.inspectedFiles, 0); assert.ok(scan.inventory.files.every((file) => /^[a-f0-9]{64}$/.test(file.sha256)));
  assert.equal(scan.candidates.length, 1); assert.equal(scan.candidates[0].ruleId, 'RAW_BYTES');
  assert.ok(scan.candidates[0].basis.includes('not network transfer bytes'));
});

test('whole-theme inspection uses inventoried bytes once and keeps the standalone candidates', async t => {
  const file = 'sections/hero.liquid';
  const source = '<img src="{{ section.settings.hero | image_url: width: 1000 }}">';
  const project = await theme(t, {[file]: source});
  const expected = await inspectSource({project, target: file});
  let opens = 0, standaloneReads = 0;
  const {open, readFile} = fs;
  const opened = t.mock.method(fs, 'open', (...args) => {
    if (String(args[0]).endsWith(file)) opens++;
    return open(...args);
  });
  const read = t.mock.method(fs, 'readFile', (...args) => {
    if (String(args[0]).endsWith(file)) standaloneReads++;
    return readFile(...args);
  });
  syncBuiltinESMExports();
  let scan;
  try { scan = await scanTheme({project}); }
  finally {
    opened.mock.restore();
    read.mock.restore();
    syncBuiltinESMExports();
  }
  assert.equal(opens, 1);
  assert.equal(standaloneReads, 0);
  const actual = scan.findings.filter(finding => finding.file === file && /^IMG/.test(finding.ruleId));
  assert.deepEqual(actual, expected.findings.map(finding => ({
    ...finding, id: file + ':' + finding.id, file, sourceHash: expected.sourceHash,
  })));
});

test('invalid UTF-8 can be inventoried but cannot produce source-bound inspection findings', async t => {
  const file = 'sections/hero.liquid';
  const bytes = Buffer.concat([Buffer.from('<img src="'), Buffer.from([0xff]), Buffer.from('">')]);
  const project = await theme(t, {[file]: bytes});
  const scan = await scanTheme({project});
  assert.equal(scan.complete, false);
  assert.equal(scan.inventory.files[0].sha256, createHash('sha256').update(bytes).digest('hex'));
  assert.equal(scan.inventory.files[0].inspected, false);
  assert.deepEqual(scan.errors.map(error => [error.file, error.code]), [[file, 'FILE_CHANGED']]);
  assert.equal(scan.findings.length, 0);
  assert.equal(scan.performance.length, 0);
});

test('parser results are reused for exact text while distinct Acorn grammar and failed parses stay distinct', () => {
  const syntax = createSourceSyntaxCache();
  const liquid = '<p>{{ product.title }}</p>';
  const css = 'p { opacity: 0; transition: opacity 1s; }';
  assert.equal(syntax.liquid(liquid), syntax.liquid(liquid));
  assert.equal(syntax.css(css), syntax.css(css));
  assert.notEqual(syntax.css(css), syntax.css(css + '\n'));
  const source = 'return 1;';
  assert.throws(() => syntax.javascript(source), /return.*outside/i);
  const permissive = syntax.javascript(source, {allowReturnOutsideFunction: true});
  assert.equal(permissive, syntax.javascript(source, {allowReturnOutsideFunction: true}));
  assert.throws(() => syntax.javascript(source), /return.*outside/i);
});

test('representative pages use real supplied URLs and do not invent resource handles', async (t) => {
  const project = await theme(t, {
    'templates/index.json': '{}', 'templates/product.json': '{}', 'templates/product.special.json': '{}',
    'templates/collection.json': '{}', 'templates/cart.json': '{}', 'templates/customers/account.json': '{}',
  });
  const supplied = 'https://preview.example.com/products/real-handle?preview_theme_id=123';
  const scan = await scanTheme({ project, pages: [supplied, supplied] });
  assert.equal(scan.pages.filter((page) => page.type === 'provided').length, 1);
  assert.equal(scan.pages.find((page) => page.type === 'provided').url, supplied);
  assert.ok(scan.pages.filter((page) => page.type === 'product').every((page) => page.route === null && page.url === null));
  assert.equal(scan.pages.find((page) => page.type === 'cart').route, '/cart');
  await assert.rejects(scanTheme({ project, pages: ['ftp://example.com'] }), /HTTP/);
  await assert.rejects(scanTheme({ project, pages: ['https://user:pass@example.com'] }), /credentials/);
  await assert.rejects(scanTheme({ project, pages: {} }), /array/);
});

test('static JS imports include exports and dynamic literal modules but exclude ordinary strings/comments', async (t) => {
  const project = await theme(t, {
    'assets/main.js': `// import './no.js';\nconst example = "import './no.js'";\nimport { x } from './one.js'; export { x } from './two.js';\nimport('./three.js'); import(specifier); import.meta.url; obj.import('./no.js');`,
    'assets/one.js': '', 'assets/two.js': '', 'assets/three.js': '',
  });
  const scan = await scanTheme({ project });
  assert.equal(scan.summary.resolvedDependencies, 3); assert.equal(scan.summary.unresolvedDependencies, 1);
  assert.ok(!scan.dependencies.some((item) => item.to?.includes('no.js')));
});

test('theme blocks inventory differentiates explicit content_for reference from section-local JSON block types', async (t) => {
  const project = await theme(t, {
    'sections/main.liquid': `{% content_for 'block', type: 'card', id: 'x' %}{% content_for 'blocks' %}`,
    'blocks/card.liquid': '<div>Card</div>',
    'templates/index.json': '{"sections":{"main":{"type":"main","blocks":{"text":{"type":"text"},"app":{"type":"shopify://apps/demo/blocks/example/abc"}}}}}',
  });
  const scan = await scanTheme({ project });
  assert.equal(edge(scan, 'sections/main.liquid', 'blocks/card.liquid').status, 'resolved');
  assert.equal(scan.summary.missingDependencies, 0);
  assert.equal(scan.summary.unresolvedDependencies, 2); assert.equal(scan.summary.appIndicators, 1);
});

test('empty/non-theme project reports incomplete and invalid project input rejects', async (t) => {
  const project = await theme(t, { 'README.md': 'hello' });
  const scan = await scanTheme({ project });
  assert.equal(scan.complete, false); assert.equal(scan.errors[0].code, 'NO_THEME_FILES');
  await assert.rejects(scanTheme(), /project/);
});

test('Shopify asset_url resolves compiled Liquid asset names without hiding genuinely missing files',async t=>{
 const project=await theme(t,{'layout/theme.liquid':`{{ 'flags.css' | asset_url }} {{ 'code.js' | asset_url }} {{ 'missing.svg' | asset_url }}`,'assets/flags.css.liquid':'.x{color:{{ settings.color }}}','assets/code.js.liquid':'const x={{ settings.x | json }};'});
 const s=await scanTheme({project});assert.equal(s.summary.missingDependencies,1);
 const css=edge(s,'layout/theme.liquid','assets/flags.css.liquid');assert.equal(css.status,'resolved');assert.equal(css.requestedTo,'assets/flags.css');assert.equal(css.resolution,'shopify-liquid-asset');
 assert.equal(edge(s,'layout/theme.liquid','assets/code.js.liquid').status,'resolved');assert.equal(edge(s,'layout/theme.liquid','assets/missing.svg').status,'missing');
});
