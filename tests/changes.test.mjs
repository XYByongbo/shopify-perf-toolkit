import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createImagePlan, createPatchPlan, applyPlan, rollbackPlan } from '../lib/changes.mjs';

const image = '<img src="{{ section.settings.image | image_url: width: 1200 }}" alt="A &amp; B" class="hero native" style="width:100%;height:auto" loading="lazy">';
const source = `<!-- existing uncommitted local change: 中文 -->\n<section>\n  ${image}\n</section>\n{% schema %}\n{"name":"Existing","settings":[]}\n{% endschema %}\n`;
const sha = (value) => createHash('sha256').update(value).digest('hex');

async function fixture(t, contents = source, target = 'sections/hero.liquid') {
  const project = await fs.mkdtemp(path.join(os.tmpdir(), 'shopify-perf-patch-test-'));
  t.after(() => fs.rm(project, { recursive: true, force: true }));
  await fs.mkdir(path.dirname(path.join(project, target)), { recursive: true });
  await fs.writeFile(path.join(project, target), contents);
  return { project, target, file: path.join(project, target) };
}
const options = (f, extra = {}) => ({ ...f, sizes: '(max-width: 749px) 100vw, 50vw', widths: [320, 640, 960, 1200], ...extra });

test('image planning changes one tag, preserves existing attributes and does not write', async (t) => {
  const f = await fixture(t);
  const plan = await createImagePlan(options(f));
  assert.equal(plan.schemaVersion, 1);
  assert.equal(plan.kind, 'change-plan');
  assert.equal(plan.beforeHash, sha(source));
  assert.equal(plan.afterHash, sha(plan.after));
  assert.equal(plan.before, source);
  assert.equal(await fs.readFile(f.file, 'utf8'), source);
  for (const attribute of ['src="{{ section.settings.image | image_url: width: 1200 }}"', 'alt="A &amp; B"', 'class="hero native"', 'style="width:100%;height:auto"', 'loading="lazy"']) assert.ok(plan.after.includes(attribute));
  assert.ok(plan.after.includes('width="{{ section.settings.image.width }}" height="{{ section.settings.image.height }}"'));
  assert.equal(plan.edits.length, 1);
  assert.equal(plan.edits[0].before, image);
  assert.ok(plan.diff.includes('--- a/sections/hero.liquid'));
  assert.equal(JSON.parse(JSON.stringify(plan)).after, plan.after);
});

test('apply and rollback are idempotent and preserve original uncommitted source and mode', async (t) => {
  const f = await fixture(t);
  await fs.chmod(f.file, 0o640);
  const plan = await createImagePlan(options(f));
  assert.equal((await applyPlan(plan, f.project)).status, 'applied');
  assert.equal(await fs.readFile(f.file, 'utf8'), plan.after);
  assert.equal((await fs.stat(f.file)).mode & 0o777, 0o640);
  assert.equal((await applyPlan(plan, f.project)).status, 'already-applied');
  assert.equal((await rollbackPlan(plan, f.project)).status, 'rolled-back');
  assert.equal(await fs.readFile(f.file, 'utf8'), source);
  assert.equal((await rollbackPlan(plan, f.project)).status, 'already-rolled-back');
});

test('source drift blocks apply and rollback without overwriting subsequent work', async (t) => {
  const f = await fixture(t);
  const plan = await createImagePlan(options(f));
  await fs.appendFile(f.file, '\n<!-- later work -->');
  const drift = await fs.readFile(f.file, 'utf8');
  await assert.rejects(applyPlan(plan, f.project), { code: 'SOURCE_DRIFT' });
  assert.equal(await fs.readFile(f.file, 'utf8'), drift);
  await fs.writeFile(f.file, source);
  await applyPlan(plan, f.project);
  await fs.appendFile(f.file, '\n<!-- work after apply -->');
  const later = await fs.readFile(f.file, 'utf8');
  await assert.rejects(rollbackPlan(plan, f.project), { code: 'SOURCE_DRIFT' });
  assert.equal(await fs.readFile(f.file, 'utf8'), later);
});

test('width candidates are bounded, deduplicated, sorted, and preserve original maximum', async (t) => {
  const f = await fixture(t);
  const plan = await createImagePlan(options(f, { widths: [640, 320, 640] }));
  assert.deepEqual(plan.parameters.widths, [320, 640, 1200]);
  for (const widths of [[], [0], [-1], [320.5], [1600], ['320'], [Infinity]]) {
    await assert.rejects(createImagePlan(options(f, { widths })), { code: 'INVALID_WIDTHS' });
  }
  await assert.rejects(createImagePlan(options(f, { sizes: '' })), { code: 'INVALID_SIZES' });
  await assert.rejects(createImagePlan(options(f, { sizes: '100vw" onerror="alert(1)' })), { code: 'INVALID_SIZES' });
});

test('existing dimensions are preserved and a partial pair requires review', async (t) => {
  const f = await fixture(t, image.replace(' loading=', ' width="1200" height="800" loading='));
  const plan = await createImagePlan(options(f));
  assert.ok(plan.after.includes('width="1200" height="800"'));
  assert.ok(!plan.after.includes('section.settings.image.height'));
  await fs.writeFile(f.file, image.replace(' loading=', ' width="1200" loading='));
  await assert.rejects(createImagePlan(options(f)), { code: 'UNSAFE_IMAGE' });
});

test('self-closing images and boolean attributes retain their original syntax', async (t) => {
  const f = await fixture(t);
  for (const ending of ['/>', '/ >', '/  >']) {
    const input = image.replace('<img ', '<img hidden  ').replace(/>$/, ` ${ending}`);
    await fs.writeFile(f.file, input);
    const plan = await createImagePlan(options(f));
    assert.ok(plan.after.endsWith(ending));
    assert.ok(plan.after.indexOf('srcset=') < plan.after.lastIndexOf('/'));
    assert.ok(plan.after.startsWith('<img hidden  '));
    await applyPlan(plan, f.project);
    await rollbackPlan(plan, f.project);
    assert.equal(await fs.readFile(f.file, 'utf8'), input);
  }
});

test('unsafe image forms are refused instead of silently rewritten', async (t) => {
  const f = await fixture(t);
  const cases = [
    image.replace('width: 1200', "width: 1200, crop: 'center'"),
    image.replace('width: 1200', 'width: 1200, height: 500'),
    image.replace('width: 1200', 'width: 1200 | escape'),
    image.replace('width: 1200', 'width: section.settings.width'),
    image.replace(' loading=', ' SRC="fake" loading='),
    image.replace(' loading=', ' SRCSET="already.jpg 400w" loading='),
    image.replace(' loading=', ' sizes="100vw" loading='),
    image.replace(' loading=', ' {{ extra_attributes }} loading='),
    image.replace(' loading=', ' {% if lazy %}loading="lazy"{% endif %} loading='),
    image.replace(' alt=', 'alt='),
    `<picture><source srcset="a.webp">${image}</picture>`,
    image.replace('section.settings.image', "section.settings['image']"),
  ];
  for (const input of cases) {
    await fs.writeFile(f.file, input);
    await assert.rejects(createImagePlan(options(f)), { code: 'UNSAFE_IMAGE' });
    assert.equal(await fs.readFile(f.file, 'utf8'), input);
  }
});

test('ignored tags do not influence index and the second real image alone can change', async (t) => {
  const input = `<!-- ${image} -->\n{% comment %}${image}{% endcomment %}\n{% raw %}${image}{% endraw %}\n<script>const s='${image}';</script>\n<style>/* ${image} */</style>\n${image}\n${image}`;
  const f = await fixture(t, input);
  const plan = await createImagePlan(options(f, { imageIndex: 1 }));
  const start = input.lastIndexOf(image);
  assert.equal(plan.edits[0].start, start);
  assert.equal(plan.after.slice(0, start), input.slice(0, start));
});

test('attribute comments and nested Liquid quotes cannot hide images or redirect the patch', async (t) => {
  const tricky = `<img class="hero" src="{{ section.settings.image | image_url: width: 1200 }}" alt="{{ section.settings.alt | default: 'a > b and \"+\"' | escape }}">`;
  const input = `<div title="<!--">Content</div><script>const marker = '<!--';</script>\n<textarea>${image}</textarea>\n${tricky}\n${image.replace('A &amp; B', '<!-- illustration -->')}`;
  const f = await fixture(t, input);
  const first = await createImagePlan(options(f));
  assert.equal(first.edits[0].before, tricky);
  assert.equal(first.edits[0].start, input.indexOf(tricky));
  const second = await createImagePlan(options(f, { imageIndex: 1 }));
  assert.ok(second.edits[0].before.includes('alt="<!-- illustration -->"'));
  assert.ok(second.edits[0].after.includes('alt="<!-- illustration -->"'));
  await applyPlan(second, f.project);
  await rollbackPlan(second, f.project);
  assert.equal(await fs.readFile(f.file, 'utf8'), input);
});

test('inspection is independently verified and stale/forged data cannot select different source', async (t) => {
  const f = await fixture(t);
  const start = source.indexOf(image);
  const inspection = { sourceHash: sha(source), images: [{ index: 0, start, end: start + image.length, tag: image, imageObject: 'section.settings.image', maxWidth: 1200, eligibleForPatch: true }] };
  const plan = await createImagePlan(options(f, { inspection }));
  assert.equal(plan.edits[0].start, start);
  await assert.rejects(createImagePlan(options(f, { inspection: { ...inspection, sourceHash: sha('stale') } })), { code: 'STALE_INSPECTION' });
  await assert.rejects(createImagePlan(options(f, { inspection: { images: inspection.images } })), { code: 'STALE_INSPECTION' });
  for (const forged of [{ start: 0 }, { tag: '<img src="evil">' }, { imageObject: 'other.image' }, { maxWidth: 9999 }, { eligibleForPatch: false }]) {
    await assert.rejects(createImagePlan(options(f, { inspection: { ...inspection, images: [{ ...inspection.images[0], ...forged }] } })), { code: 'INVALID_INSPECTION' });
  }
});

test('hash-valid forged image plans still cannot alter unrelated content', async (t) => {
  const f = await fixture(t);
  const plan = await createImagePlan(options(f));
  plan.after += '\n<div>unexpected new content</div>';
  plan.afterHash = sha(plan.after);
  await assert.rejects(applyPlan(plan, f.project), { code: 'INVALID_PLAN' });
  assert.equal(await fs.readFile(f.file, 'utf8'), source);
});

test('tampered snapshots and schema changes are rejected', async (t) => {
  const f = await fixture(t);
  const plan = await createImagePlan(options(f));
  await assert.rejects(applyPlan({ ...plan, afterHash: 'f'.repeat(64) }, f.project), { code: 'INVALID_PLAN' });
  const after = plan.after.replace('"Existing"', '"Changed"');
  await assert.rejects(applyPlan({ ...plan, after, afterHash: sha(after) }, f.project), { code: 'PROTECTED_SCHEMA' });
});

test('absolute, traversal, hidden, and configuration targets are refused', async (t) => {
  const f = await fixture(t);
  for (const target of ['/tmp/escape.liquid', '../escape.liquid', 'sections/../escape.liquid', 'sections//hero.liquid', './sections/hero.liquid', 'C:\\escape.liquid', 'sections\\hero.liquid', 'sections/line\nbreak.liquid', 'sections/tab\there.liquid']) {
    await assert.rejects(createImagePlan(options(f, { target })), { code: 'UNSAFE_PATH' });
  }
  for (const target of ['config/settings_data.json', '.git/config']) {
    await assert.rejects(createImagePlan(options(f, { target })), { code: 'PROTECTED_TARGET' });
  }
});

test('symlink targets and parents are refused at creation and apply', async (t) => {
  const f = await fixture(t);
  await fs.symlink(f.file, path.join(f.project, 'sections/link.liquid'));
  await assert.rejects(createImagePlan(options(f, { target: 'sections/link.liquid' })), { code: 'SYMLINK_TARGET' });
  await fs.symlink(path.join(f.project, 'sections'), path.join(f.project, 'snippets'));
  await assert.rejects(createImagePlan(options(f, { target: 'snippets/hero.liquid' })), { code: 'SYMLINK_TARGET' });
  const plan = await createImagePlan(options(f));
  const outside = path.join(f.project, 'copy.liquid');
  await fs.rename(f.file, outside);
  await fs.symlink(outside, f.file);
  await assert.rejects(applyPlan(plan, f.project), { code: 'SYMLINK_TARGET' });
  assert.equal(await fs.readFile(outside, 'utf8'), source);
});

test('component replacements require explicit review context and remain hash-bound', async (t) => {
  const before = "// existing local change\nconst run = () => console.log('ready');\n";
  const replacement = "// existing local change\nconst run = () => requestAnimationFrame(() => console.log('ready'));\n";
  const f = await fixture(t, before, 'assets/component.js');
  const plan = await createPatchPlan({ ...f, replacement, ruleId: 'component.render-review', reason: 'Batch a reviewed rendering path.', validators: ['node --check assets/component.js', 'Compare component interactions.'] });
  assert.equal(plan.reviewRequired, true);
  assert.equal(plan.semanticSafety, 'manual-review-required');
  assert.ok(plan.description.includes('Manual diff and behavior review required'));
  assert.equal((await applyPlan(plan, f.project)).status, 'applied');
  assert.equal(await fs.readFile(f.file, 'utf8'), replacement);
  await rollbackPlan(plan, f.project);
  assert.equal(await fs.readFile(f.file, 'utf8'), before);
  await assert.rejects(createPatchPlan({ ...f, replacement }), { code: 'MISSING_REVIEW_CONTEXT' });
  await assert.rejects(createPatchPlan({ ...f, target: 'sections/hero.liquid', replacement, ruleId: 'x', reason: 'x' }), { code: 'UNSUPPORTED_TARGET' });
});
