import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createSitePlan, applySitePlan, rollbackSitePlan } from '../lib/site-changes.mjs';
import { unifiedDiff } from '../lib/changes.mjs';

// Local synthetic Shopify theme sources; these are not production performance measurements.
const hero = `<section class="hero">\n<img src="{{ section.settings.image | image_url: width: 1200 }}" alt="Original product" loading="lazy">\n</section>\n{% schema %}\n{"name":"Hero","settings":[{"type":"image_picker","id":"image","label":"Image"}]}\n{% endschema %}\n`;
const header = `<html>\n<head>\n{{ content_for_header }}\n<script src="/assets/theme.js"></script>\n</head>\n<body>{{ content_for_layout }}</body>\n</html>\n`;
const originals = {
  'sections/hero.liquid': hero,
  'layout/theme.liquid': header,
  'assets/theme.js': 'const ready = () => window.dispatchEvent(new Event("theme-ready"));\nready();\n',
  'assets/theme.css': '.hero { width: 100%; }\n',
  'snippets/card.liquid': '<article class="card">{{ product.title }}</article>\n',
  'blocks/title.liquid': '<h2>{{ block.settings.title }}</h2>\n',
  'templates/page.liquid': '<main>{{ page.content }}</main>\n',
  'config/settings_data.json': '{"current":{"unchanged":true}}\n',
};
const sha = (value) => createHash('sha256').update(value).digest('hex');
const canonical = (value) => value && typeof value === 'object'
  ? Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  : JSON.stringify(value);
function rehash(plan) { const { planHash, ...rest } = plan; plan.planHash = sha(canonical(rest)); return plan; }

async function fixture(t) {
  const project = await fs.mkdtemp(path.join(os.tmpdir(), 'perfkit-site-test-'));
  t.after(() => fs.rm(project, { recursive: true, force: true }));
  for (const [target, source] of Object.entries(originals)) {
    await fs.mkdir(path.dirname(path.join(project, target)), { recursive: true });
    await fs.writeFile(path.join(project, target), source);
  }
  return fs.realpath(project);
}
const review = { reason: 'Reviewed local candidate retaining content and behavior.', evidence: { summary: 'Synthetic source review fixture; browser acceptance remains required.' } };
const replacement = (target, replacementText) => ({ target, kind: 'reviewed-replacement', replacementText, ...review });
const recipe = (...changes) => ({ schemaVersion: 1, changes });
const load = (project, target) => fs.readFile(path.join(project, target), 'utf8');
function batch() {
  return recipe(
    replacement('assets/theme.js', originals['assets/theme.js'].replace('ready();', 'queueMicrotask(ready);')),
    replacement('assets/theme.css', '.hero { width: 100%; contain: layout; }\n'),
    replacement('snippets/card.liquid', '<article class="card" data-reviewed="true">{{ product.title }}</article>\n'),
  );
}

test('multi-file plans preserve source and combine responsive images with reviewed JS/CSS/Liquid changes', async (t) => {
  const project = await fixture(t);
  const plan = await createSitePlan({ project, recipe: recipe(
    { target: 'sections/hero.liquid', kind: 'image-responsive', sourceIndex: 0,
      sizes: '100vw', widths: [320, 640, 1200], ...review },
    ...batch().changes,
    replacement('blocks/title.liquid', '<h2 class="title">{{ block.settings.title }}</h2>\n'),
    replacement('templates/page.liquid', '<main class="page">{{ page.content }}</main>\n'),
    replacement('layout/theme.liquid', header.replace('<script src=', '<script defer src=')),
  ) });
  assert.equal(plan.kind, 'site-change-plan');
  assert.equal(plan.changes.length, 7);
  assert.equal(plan.reviewRequired, true);
  assert.match(plan.createdAt, /^\d{4}-/);
  assert.equal(plan.updatedAt, plan.createdAt);
  assert.equal(plan.planHash.length, 64);
  for (const entry of plan.changes) {
    assert.equal(await load(project, entry.target), entry.before);
    assert.equal(entry.beforeHash, sha(entry.before));
    assert.equal(entry.afterHash, sha(entry.after));
    assert.match(entry.diff, /^--- a\//);
    assert.equal(entry.evidence.summary, review.evidence.summary);
  }
  const applied = await applySitePlan(JSON.parse(JSON.stringify(plan)), project);
  assert.equal(applied.status, 'applied');
  assert.equal(applied.atomicAcrossFiles, false);
  for (const entry of plan.changes) assert.equal(await load(project, entry.target), entry.after);
  assert.equal(await load(project, 'config/settings_data.json'), originals['config/settings_data.json']);
  assert.equal((await rollbackSitePlan(plan, project)).status, 'rolled-back');
  for (const [target, source] of Object.entries(originals)) assert.equal(await load(project, target), source);
});

test('apply and rollback are idempotent, preserve file permissions and uncommitted contents', async (t) => {
  const project = await fixture(t);
  await fs.appendFile(path.join(project, 'assets/theme.js'), '// existing uncommitted source\n');
  const source = await load(project, 'assets/theme.js');
  const changes = batch();
  changes.changes[0].replacementText = source.replace('ready();', 'queueMicrotask(ready);');
  for (const [target, mode] of [['assets/theme.js', 0o750], ['assets/theme.css', 0o640]]) await fs.chmod(path.join(project, target), mode);
  const plan = await createSitePlan({ project, recipe: changes });
  assert.equal((await applySitePlan(plan, project)).status, 'applied');
  assert.equal((await applySitePlan(plan, project)).status, 'already-applied');
  assert.equal((await fs.stat(path.join(project, 'assets/theme.js'))).mode & 0o777, 0o750);
  assert.equal((await fs.stat(path.join(project, 'assets/theme.css'))).mode & 0o777, 0o640);
  assert.equal((await rollbackSitePlan(plan, project)).status, 'rolled-back');
  assert.equal((await rollbackSitePlan(plan, project)).status, 'already-rolled-back');
  assert.equal(await load(project, 'assets/theme.js'), source);
  assert.equal((await fs.stat(path.join(project, 'assets/theme.js'))).mode & 0o777, 0o750);
});

test('preflight drift in any target prevents writes to all other targets', async (t) => {
  const project = await fixture(t);
  const plan = await createSitePlan({ project, recipe: batch() });
  await fs.appendFile(path.join(project, 'snippets/card.liquid'), '<!-- concurrent edit -->');
  await assert.rejects(applySitePlan(plan, project), (error) => {
    assert.equal(error.code, 'SOURCE_DRIFT');
    assert.equal(error.receipt.status, 'preflight-failed');
    assert.deepEqual(error.receipt.files, []);
    return true;
  });
  assert.equal(await load(project, 'assets/theme.js'), originals['assets/theme.js']);
  assert.equal(await load(project, 'assets/theme.css'), originals['assets/theme.css']);
});

test('middle write failure restores completed writes in reverse order', async (t) => {
  const project = await fixture(t);
  const plan = await createSitePlan({ project, recipe: batch() });
  const rename = fs.rename;
  t.mock.method(fs, 'rename', async (from, to) => {
    if (to === path.join(project, 'snippets/card.liquid')) throw Object.assign(new Error('simulated write failure'), { code: 'EIO' });
    return rename(from, to);
  });
  await assert.rejects(applySitePlan(plan, project), (error) => {
    assert.equal(error.code, 'SITE_APPLY_FAILED');
    assert.equal(error.receipt.status, 'failed-restored');
    assert.equal(error.receipt.partial, false);
    assert.equal(error.receipt.completed, false);
    assert.deepEqual(error.receipt.recovery.map(({ target, status }) => ({ target, status })), [
      { target: 'assets/theme.css', status: 'restored' }, { target: 'assets/theme.js', status: 'restored' },
    ]);
    return true;
  });
  for (const entry of plan.changes) assert.equal(await load(project, entry.target), entry.before);
  assert.deepEqual((await fs.readdir(path.join(project, 'assets'))).sort(), ['theme.css', 'theme.js']);
});

test('successful rename is recorded without unlinking its consumed temporary name', async (t) => {
  const project = await fixture(t);
  const plan = await createSitePlan({ project, recipe: batch() });
  const unlink = fs.unlink;
  let cleanupAttempts = 0;
  t.mock.method(fs, 'unlink', async (filename) => {
    if (filename.includes('.perf-site-')) {
      cleanupAttempts += 1;
      throw Object.assign(new Error('simulated post-rename unlink failure'), { code: 'EIO' });
    }
    return unlink(filename);
  });
  const applied = await applySitePlan(plan, project);
  assert.equal(applied.status, 'applied');
  assert.equal(applied.completed, true);
  assert.equal(applied.files.filter((file) => file.status === 'applied').length, plan.changes.length);
  for (const entry of plan.changes) assert.equal(await load(project, entry.target), entry.after);
  const rolledBack = await rollbackSitePlan(plan, project);
  assert.equal(rolledBack.status, 'rolled-back');
  assert.equal(rolledBack.completed, true);
  for (const entry of plan.changes) assert.equal(await load(project, entry.target), entry.before);
  assert.equal(cleanupAttempts, 0);
});

test('failed rename still removes its real temporary file while recovery records committed writes', async (t) => {
  const project = await fixture(t);
  const plan = await createSitePlan({ project, recipe: batch() });
  const rename = fs.rename, unlink = fs.unlink;
  const cleaned = [];
  t.mock.method(fs, 'rename', async (from, to) => {
    if (to === path.join(project, 'snippets/card.liquid')) throw Object.assign(new Error('simulated rename failure'), { code: 'EIO' });
    return rename(from, to);
  });
  t.mock.method(fs, 'unlink', async (filename) => {
    if (filename.includes('.perf-site-')) {
      assert.equal((await fs.lstat(filename)).isFile(), true);
      cleaned.push(filename);
    }
    return unlink(filename);
  });
  await assert.rejects(applySitePlan(plan, project), (error) => {
    assert.equal(error.code, 'SITE_APPLY_FAILED');
    assert.equal(error.receipt.status, 'failed-restored');
    assert.equal(error.receipt.writesOccurred, true);
    assert.equal(error.receipt.files.length, 2);
    assert.equal(error.receipt.recovery.length, 2);
    assert.ok(error.receipt.recovery.every((entry) => entry.status === 'restored'));
    return true;
  });
  assert.equal(cleaned.length, 1);
  assert.equal(path.dirname(cleaned[0]), path.join(project, 'snippets'));
  await assert.rejects(fs.lstat(cleaned[0]), { code: 'ENOENT' });
  for (const entry of plan.changes) assert.equal(await load(project, entry.target), entry.before);
});

test('recovery preserves concurrent edits and reports partial failure explicitly', async (t) => {
  const project = await fixture(t);
  const plan = await createSitePlan({ project, recipe: batch() });
  const rename = fs.rename;
  const concurrent = '// subsequent unrelated user edit\n';
  t.mock.method(fs, 'rename', async (from, to) => {
    if (to === path.join(project, 'snippets/card.liquid')) {
      await fs.writeFile(path.join(project, 'assets/theme.js'), concurrent);
      throw Object.assign(new Error('simulated write failure after concurrent edit'), { code: 'EIO' });
    }
    return rename(from, to);
  });
  await assert.rejects(applySitePlan(plan, project), (error) => {
    assert.equal(error.receipt.status, 'partial-failure');
    assert.equal(error.receipt.partial, true);
    assert.equal(error.receipt.recovery[0].status, 'restored');
    assert.equal(error.receipt.recovery[1].status, 'conflict');
    return true;
  });
  assert.equal(await load(project, 'assets/theme.js'), concurrent);
  assert.equal(await load(project, 'assets/theme.css'), originals['assets/theme.css']);
  assert.equal(await load(project, 'snippets/card.liquid'), originals['snippets/card.liquid']);
});

test('failed rollback restores its completed writes to the candidate state', async (t) => {
  const project = await fixture(t);
  const plan = await createSitePlan({ project, recipe: batch() });
  await applySitePlan(plan, project);
  const rename = fs.rename;
  t.mock.method(fs, 'rename', async (from, to) => {
    if (to === path.join(project, 'snippets/card.liquid')) throw Object.assign(new Error('simulated rollback failure'), { code: 'EIO' });
    return rename(from, to);
  });
  await assert.rejects(rollbackSitePlan(plan, project), (error) => {
    assert.equal(error.code, 'SITE_ROLLBACK_FAILED');
    assert.equal(error.receipt.status, 'failed-restored');
    return true;
  });
  for (const entry of plan.changes) assert.equal(await load(project, entry.target), entry.after);
});

test('a post-preflight change of a later target aborts and restores preceding writes', async (t) => {
  const project = await fixture(t);
  const plan = await createSitePlan({ project, recipe: batch() });
  const rename = fs.rename;
  let changed = false;
  t.mock.method(fs, 'rename', async (from, to) => {
    const result = await rename(from, to);
    if (!changed && to === path.join(project, 'assets/theme.js')) {
      changed = true;
      await fs.appendFile(path.join(project, 'assets/theme.css'), '/* concurrent CSS */');
    }
    return result;
  });
  await assert.rejects(applySitePlan(plan, project), { code: 'SITE_APPLY_FAILED' });
  assert.equal(await load(project, 'assets/theme.js'), originals['assets/theme.js']);
  assert.match(await load(project, 'assets/theme.css'), /concurrent CSS/);
});

test('configuration, schema and content_for_header cannot be changed', async (t) => {
  const project = await fixture(t);
  for (const [target, after, code] of [
    ['config/settings_data.json', '{}', 'PROTECTED_TARGET'],
    ['sections/hero.liquid', hero.replace('"name":"Hero"', '"name":"Altered"'), 'PROTECTED_SCHEMA'],
    ['sections/hero.liquid', hero.replace('{% schema %}', ''), 'PROTECTED_SCHEMA'],
    ['layout/theme.liquid', header.replace('{{ content_for_header }}', ''), 'PROTECTED_HEADER'],
    ['layout/theme.liquid', header.replace('content_for_header', 'content_for_header | replace: "x", ""'), 'PROTECTED_HEADER'],
    ['layout/theme.liquid', header.replace('{{ content_for_header }}', '{{ content_for_header }}\n{{ content_for_header }}'), 'PROTECTED_HEADER'],
    ['layout/theme.liquid', header.replace('{{ content_for_header }}', '<!--\n{{ content_for_header }}\n-->'), 'PROTECTED_HEADER'],
    ['layout/theme.liquid', header.replace('{{ content_for_header }}', '<template>\n{{ content_for_header }}\n</template>'), 'PROTECTED_HEADER'],
    ['layout/theme.liquid', header.replace('{{ content_for_header }}', '{% if false %}\n{{ content_for_header }}\n{% endif %}'), 'PROTECTED_HEADER'],
  ]) {
    await assert.rejects(createSitePlan({ project, recipe: recipe(replacement(target, after)) }), { code });
    assert.equal(await load(project, target), originals[target]);
  }
});

test('content_for_header cannot be wrapped in mixed-case HTML raw-text or RCDATA containers', async (t) => {
  const project = await fixture(t);
  for (const tag of ['SCRIPT', 'ScRiPt', 'STYLE', 'TeMpLaTe', 'TEXTAREA', 'TITLE', 'title',
    'NOSCRIPT', 'IFRAME', 'XMP', 'NOEMBED', 'noembed', 'NOFRAMES', 'noframes', 'PLAINTEXT', 'plaintext']) {
    const after = header.replace('{{ content_for_header }}', `<${tag}>\n{{ content_for_header }}\n</${tag}>`);
    await assert.rejects(createSitePlan({ project, recipe: recipe(replacement('layout/theme.liquid', after)) }), { code: 'PROTECTED_HEADER' });
  }
  const plaintext = header.replace('{{ content_for_header }}', '<plaintext>\n{{ content_for_header }}');
  await assert.rejects(createSitePlan({ project, recipe: recipe(replacement('layout/theme.liquid', plaintext)) }), { code: 'PROTECTED_HEADER' });
  assert.equal(await load(project, 'layout/theme.liquid'), header);
});

test('raw-text header protection is rechecked when a serialized plan is applied', async (t) => {
  const project = await fixture(t);
  const plan = await createSitePlan({ project, recipe: recipe(replacement('layout/theme.liquid', header.replace('<script src=', '<script defer src='))) });
  const entry = plan.changes[0];
  entry.after = entry.after.replace('{{ content_for_header }}', '<TiTlE>\n{{ content_for_header }}\n</TiTlE>');
  entry.afterHash = sha(entry.after);
  entry.diff = unifiedDiff(entry.target, entry.before, entry.after);
  rehash(plan);
  await assert.rejects(applySitePlan(plan, project), { code: 'PROTECTED_HEADER' });
  assert.equal(await load(project, 'layout/theme.liquid'), header);
});

test('changed raw-text delimiters or quotes cannot swallow an otherwise unchanged header line', async (t) => {
  const project = await fixture(t);
  const before = '<head>\n<script src="/theme.js"></script>\n{{ content_for_header }}\n</head>\n';
  await fs.writeFile(path.join(project, 'layout/theme.liquid'), before);
  for (const after of [
    before.replace('</script>', '</script'),
    before.replace('<script src="/theme.js">', '<script src="/theme.js>'),
  ]) {
    await assert.rejects(createSitePlan({ project, recipe: recipe(replacement('layout/theme.liquid', after)) }), { code: 'PROTECTED_HEADER' });
  }
  assert.equal(await load(project, 'layout/theme.liquid'), before);
});

test('plan fingerprints, per-file hashes and rebuilt operations reject tampering', async (t) => {
  const project = await fixture(t);
  const plan = await createSitePlan({ project, recipe: recipe({ target: 'sections/hero.liquid', kind: 'image-responsive', sourceIndex: 0, sizes: '100vw', widths: [320, 640], ...review }) });
  const stale = structuredClone(plan);
  stale.changes[0].after += '<p>tampered content</p>';
  await assert.rejects(applySitePlan(stale, project), { code: 'INVALID_PLAN' });
  const forged = structuredClone(stale);
  const entry = forged.changes[0];
  entry.afterHash = sha(entry.after);
  entry.diff = unifiedDiff(entry.target, entry.before, entry.after);
  rehash(forged);
  await assert.rejects(applySitePlan(forged, project), { code: 'INVALID_PLAN' });
  const schema = structuredClone(plan);
  schema.changes[0].after = schema.changes[0].after.replace('"name":"Hero"', '"name":"Altered"');
  schema.changes[0].afterHash = sha(schema.changes[0].after);
  schema.changes[0].diff = unifiedDiff(schema.changes[0].target, schema.changes[0].before, schema.changes[0].after);
  rehash(schema);
  await assert.rejects(applySitePlan(schema, project), { code: 'PROTECTED_SCHEMA' });
  assert.equal(await load(project, 'sections/hero.liquid'), hero);
});

test('duplicate targets, unsupported operations and empty review context are refused', async (t) => {
  const project = await fixture(t);
  const change = batch().changes[0];
  await assert.rejects(createSitePlan({ project, recipe: recipe(change, change) }), { code: 'DUPLICATE_TARGET' });
  await assert.rejects(createSitePlan({ project, recipe: recipe({ ...change, kind: 'script-defer' }) }), { code: 'UNSUPPORTED_OPERATION' });
  for (const altered of [{ ...change, reason: '' }, { ...change, evidence: {} }, { ...change, evidence: { summary: ' ' } }]) {
    await assert.rejects(createSitePlan({ project, recipe: recipe(altered) }), { code: 'MISSING_REVIEW_CONTEXT' });
  }
  await assert.rejects(createSitePlan({ project, recipe: recipe({ ...change, replacementText: '' }) }), { code: 'INVALID_REPLACEMENT' });
  await assert.rejects(createSitePlan({ project, recipe: recipe({ ...change, replacementText: 'invalid UTF-8 \ud800' }) }), { code: 'INVALID_REPLACEMENT' });
});

test('different target paths pointing to the same physical file cannot form a batch', async (t) => {
  const project = await fixture(t);
  await fs.link(path.join(project, 'assets/theme.js'), path.join(project, 'assets/alias.js'));
  const first = batch().changes[0];
  const second = { ...first, target: 'assets/alias.js' };
  await assert.rejects(createSitePlan({ project, recipe: recipe(first, second) }), { code: 'DUPLICATE_TARGET' });
  assert.equal(await load(project, 'assets/theme.js'), originals['assets/theme.js']);
});

test('a change to an earlier file before batch completion is preserved and reported', async (t) => {
  const project = await fixture(t);
  const plan = await createSitePlan({ project, recipe: batch() });
  const rename = fs.rename;
  let changed = false;
  t.mock.method(fs, 'rename', async (from, to) => {
    const result = await rename(from, to);
    if (!changed && to === path.join(project, 'snippets/card.liquid')) {
      changed = true;
      await fs.chmod(path.join(project, 'assets/theme.js'), 0o600);
    }
    return result;
  });
  await assert.rejects(applySitePlan(plan, project), (error) => {
    assert.equal(error.receipt.status, 'partial-failure');
    assert.equal(error.receipt.recovery.at(-1).status, 'conflict');
    return true;
  });
  assert.equal((await fs.stat(path.join(project, 'assets/theme.js'))).mode & 0o777, 0o600);
  assert.equal(await load(project, 'assets/theme.js'), plan.changes[0].after);
  assert.equal(await load(project, 'assets/theme.css'), plan.changes[1].before);
  assert.equal(await load(project, 'snippets/card.liquid'), plan.changes[2].before);
});

test('reviewed replacement files are resolved inside recipeDir without symlinks or traversal', async (t) => {
  const project = await fixture(t);
  const recipeDir = path.join(project, 'recipe-input');
  await fs.mkdir(recipeDir);
  const content = '.hero { width: 100%; contain: layout; }\n';
  await fs.writeFile(path.join(recipeDir, 'candidate.css'), content);
  const change = { target: 'assets/theme.css', kind: 'reviewed-replacement', replacementFile: 'candidate.css', ...review };
  const plan = await createSitePlan({ project, recipeDir, recipe: recipe(change) });
  assert.equal(plan.changes[0].after, content);
  await fs.symlink(path.join(recipeDir, 'candidate.css'), path.join(recipeDir, 'linked.css'));
  await assert.rejects(createSitePlan({ project, recipeDir, recipe: recipe({ ...change, replacementFile: 'linked.css' }) }), { code: 'SYMLINK_TARGET' });
  await assert.rejects(createSitePlan({ project, recipeDir, recipe: recipe({ ...change, replacementFile: '../assets/theme.css' }) }), { code: 'UNSAFE_PATH' });
  await assert.rejects(createSitePlan({ project, recipeDir, recipe: recipe({ ...change, replacementText: content }) }), { code: 'INVALID_REPLACEMENT' });
});

test('target symlinks, symlink directories and escaped paths are refused', async (t) => {
  const project = await fixture(t);
  const plan = await createSitePlan({ project, recipe: batch() });
  await fs.rename(path.join(project, 'assets/theme.js'), path.join(project, 'saved.js'));
  await fs.symlink(path.join(project, 'saved.js'), path.join(project, 'assets/theme.js'));
  await assert.rejects(applySitePlan(plan, project), { code: 'SYMLINK_TARGET' });
  await assert.rejects(createSitePlan({ project, recipe: batch() }), { code: 'SYMLINK_TARGET' });
  await fs.symlink(path.join(project, 'snippets'), path.join(project, 'sections/link'));
  await assert.rejects(createSitePlan({ project, recipe: recipe(replacement('sections/link/card.liquid', '<p>replacement</p>')) }), { code: 'SYMLINK_TARGET' });
  for (const target of ['../escape.js', '/tmp/escape.js', 'assets/../escape.js', '.git/config']) {
    await assert.rejects(createSitePlan({ project, recipe: recipe(replacement(target, 'source')) }));
  }
  assert.equal(await load(project, 'saved.js'), originals['assets/theme.js']);
});

function loadingRecipe(source, sourceIndex = 0, loading = 'eager', extraEvidence = {}) {
  return recipe({ target: 'sections/hero.liquid', kind: 'image-loading', sourceIndex, loading,
    reason: 'Change only the explicitly mapped image loading behavior.',
    evidence: { summary: 'Synthetic mapped initial viewport capture fixture.', sourceHash: sha(source), sourceIndex,
      initialViewport: true, inViewport: loading === 'eager', isLCP: loading === 'eager', ...extraEvidence } });
}

test('image-loading changes one mapped LCP tag and supports existing responsive attributes', async (t) => {
  const project = await fixture(t);
  const responsive = hero.replace(' loading="lazy"', ' srcset="hero.jpg 600w, hero-large.jpg 1200w" sizes="100vw" loading="lazy"');
  const two = `${responsive}\n${hero.split('\n')[1]}`;
  await fs.writeFile(path.join(project, 'sections/hero.liquid'), two);
  const plan = await createSitePlan({ project, recipe: loadingRecipe(two) });
  assert.match(plan.changes[0].after, /loading="eager" fetchpriority="high"/);
  assert.equal(plan.changes[0].after.match(/loading="lazy"/g).length, 1);
  assert.match(plan.changes[0].after, /srcset="hero.jpg 600w, hero-large.jpg 1200w" sizes="100vw"/);
  await applySitePlan(plan, project);
  await rollbackSitePlan(plan, project);
  assert.equal(await load(project, 'sections/hero.liquid'), two);
});

test('image-loading requires source-bound initial LCP/offscreen evidence and preserves high priority', async (t) => {
  const project = await fixture(t);
  for (const evidence of [{ sourceHash: 'stale' }, { sourceIndex: 1 }, { initialViewport: false }, { inViewport: false }, { isLCP: false }]) {
    await assert.rejects(createSitePlan({ project, recipe: loadingRecipe(hero, 0, 'eager', evidence) }), { code: 'MISSING_IMAGE_EVIDENCE' });
  }
  const eager = hero.replace('loading="lazy"', 'loading="eager"');
  await fs.writeFile(path.join(project, 'sections/hero.liquid'), eager);
  const lazy = await createSitePlan({ project, recipe: loadingRecipe(eager, 0, 'lazy') });
  assert.match(lazy.changes[0].after, /loading="lazy"/);
  assert.ok(!lazy.changes[0].after.includes('fetchpriority'));
  const high = eager.replace('loading="eager"', 'loading="eager" fetchpriority="high"');
  await fs.writeFile(path.join(project, 'sections/hero.liquid'), high);
  await assert.rejects(createSitePlan({ project, recipe: loadingRecipe(high, 0, 'lazy') }), { code: 'UNSAFE_IMAGE' });
});

test('image-loading rejects forged wider edits even when snapshot and plan hashes are recomputed', async (t) => {
  const project = await fixture(t);
  const plan = await createSitePlan({ project, recipe: loadingRecipe(hero) });
  const entry = plan.changes[0];
  entry.after += '<p>unrelated extra content</p>';
  entry.afterHash = sha(entry.after);
  entry.diff = unifiedDiff(entry.target, entry.before, entry.after);
  rehash(plan);
  await assert.rejects(applySitePlan(plan, project), { code: 'INVALID_PLAN' });
  assert.equal(await load(project, entry.target), hero);
});
