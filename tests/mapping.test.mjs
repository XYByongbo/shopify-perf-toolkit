import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { mapCapture } from '../lib/mapping.mjs';
import { inspectSource } from '../lib/inspect.mjs';
import { capturePage } from '../lib/capture.mjs';

async function fixture(t, files = {}) {
  const project = await mkdtemp(path.join(tmpdir(), 'perfkit-map-'));
  t.after(() => rm(project, { recursive: true, force: true }));
  for (const [file, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(project, file)), { recursive: true });
    await writeFile(path.join(project, file), typeof content === 'string' ? content : JSON.stringify(content));
  }
  return project;
}
const target = 'sections/hero.liquid';
const image = (attributes = { id: 'hero', alt: 'Hero' }, extra = {}) => ({
  selector: '#component > img', currentSrc: 'https://cdn.example.test/hero.jpg', loading: 'lazy', inViewport: true,
  dom: { tagName: 'img', attributes, id: attributes.id ?? null, idCount: attributes.id ? 1 : null, documentSelector: 'html > body > img:nth-of-type(1)' }, ...extra,
});
const capture = images => ({ schemaVersion: 1, kind: 'capture', images, limitations: [], mappingInventory: { complete: true, images } });

test('unique static ID maps current source but reports inferred remote attribution', async t => {
  const project = await fixture(t, { [target]: '<img id="hero" alt="Hero" src="{{ section.settings.image | image_url: width: 1200 }}" loading="lazy">' });
  const before = await readFile(path.join(project, target), 'utf8');
  const result = await mapCapture({ project, target, capture: capture([image(undefined, { isLCP: true })]) });
  assert.equal(result.summary.mapped, 1);
  assert.equal(result.mappings[0].method, 'unique-static-id');
  assert.equal(result.mappings[0].confidence, 'inferred');
  assert.equal(result.mappings[0].deploymentVerification, 'unknown');
  assert.match(result.linkedCapture.sourceHash, /^[a-f0-9]{64}$/);
  assert.equal(result.linkedCapture.images[0].sourceIndex, 0);
  const inspection = await inspectSource({ project, target, capture: result });
  assert.equal(inspection.findings.find(item => item.ruleId === 'IMG04').status, 'candidate');
  assert.equal(await readFile(path.join(project, target), 'utf8'), before);
});

test('DOM order and shared image URLs never create an association', async t => {
  const project = await fixture(t, { [target]: '<img src="https://cdn.example.test/hero.jpg">' });
  const result = await mapCapture({ project, target, capture: capture([image({}, { index: 0, sourceIndex: 0 })]) });
  assert.equal(result.summary.mapped, 0);
  assert.equal(result.summary.unmapped, 1);
  assert.equal(result.linkedCapture.images[0].sourceIndex, undefined);
});

test('duplicate IDs in source branches or across document images remain ambiguous', async t => {
  const project = await fixture(t, { [target]: '{% if test %}<img id="hero" alt="Hero">{% else %}<img id="hero" alt="Hero">{% endif %}' });
  const branches = await mapCapture({ project, target, capture: capture([image()]) });
  assert.equal(branches.summary.ambiguous, 1);
  await writeFile(path.join(project, target), '<img id="hero" alt="Hero">');
  const dom = image(); dom.dom.idCount = 2;
  const duplicate = await mapCapture({ project, target, capture: capture([dom]) });
  assert.equal(duplicate.summary.ambiguous, 1);
  assert.equal(duplicate.summary.mapped, 0);
});

test('same static ID with conflicting attributes or conditional injection cannot map', async t => {
  const project = await fixture(t, { [target]: '<img id="hero" alt="Different">' });
  assert.equal((await mapCapture({ project, target, capture: capture([image()]) })).summary.mapped, 0);
  await writeFile(path.join(project, target), '<img id="hero" alt="Hero" {{ additional_attributes }}>');
  assert.equal((await mapCapture({ project, target, capture: capture([image()]) })).summary.mapped, 0);
});

test('valid annotations bind exact SHA-256 and allow independent repeated instances', async t => {
  const project = await fixture(t, { [target]: '{% for item in items %}<img alt="Hero">{% endfor %}' });
  const report = await inspectSource({ project, target });
  const sourceIdentity = { sourcePath: target, sourceHash: report.sourceHash, sourceIndex: 0 };
  const first = image({ alt: 'Hero' }, { sourceIdentity });
  const second = image({ alt: 'Hero' }, { sourceIdentity, selector: '#second' });
  second.dom.documentSelector = 'html > body > img:nth-of-type(2)';
  const result = await mapCapture({ project, capture: capture([first, second]) });
  assert.equal(result.summary.annotated, 2);
  assert.deepEqual(result.linkedCapture.images.map(item => item.sourceIndex), [0, 0]);
  assert.notEqual(result.mappings[0].documentSelector, result.mappings[1].documentSelector);
});

test('stale, incomplete, mismatched and invalid-index annotations refuse inference fallback', async t => {
  const project = await fixture(t, { [target]: '<img id="hero" alt="Hero">', 'sections/other.liquid': '<img id="hero" alt="Hero">' });
  const report = await inspectSource({ project, target });
  for (const annotation of [
    { sourcePath: target, sourceHash: 'f'.repeat(64), sourceIndex: 0 },
    { sourcePath: target, sourceIndex: 0 },
    { sourcePath: target, sourceHash: report.sourceHash, sourceIndex: 99 },
    { sourcePath: 'sections/other.liquid', sourceHash: report.sourceHash, sourceIndex: 0 },
  ]) {
    const result = await mapCapture({ project, target, capture: capture([image(undefined, { sourceIdentity: annotation })]) });
    assert.equal(result.summary.mapped, 0);
    assert.equal(result.summary.unmapped, 1);
  }
});

test('mapped evidence is rejected after source changes and cannot be laundered by remapping', async t => {
  const project = await fixture(t, { [target]: '<img id="hero" alt="Hero">' });
  const result = await mapCapture({ project, target, capture: capture([image(undefined, { isLCP: true })]) });
  await writeFile(path.join(project, target), '<img id="hero" alt="Hero">\n<!-- changed -->');
  const inspection = await inspectSource({ project, target, capture: result });
  assert.ok(!inspection.findings.some(item => item.ruleId === 'IMG04'));
  assert.ok(inspection.limitations.some(item => item.includes('was ignored')));
  await assert.rejects(mapCapture({ project, target, capture: result.linkedCapture }), { code: 'STALE_SOURCE' });
});

test('missing hash or target cannot upgrade raw runtime evidence', async t => {
  const project = await fixture(t, { [target]: '<img loading="lazy">' });
  const base = await inspectSource({ project, target });
  for (const linked of [
    { target, images: [{ sourceIndex: 0, isLCP: true }] },
    { sourceHash: base.sourceHash, images: [{ sourceIndex: 0, isLCP: true }] },
    { target, sourceHash: base.sourceHash, images: [{ sourceIndex: 99, isLCP: true }] },
  ]) assert.ok(!(await inspectSource({ project, target, capture: linked })).findings.some(item => item.ruleId === 'IMG04'));
});

test('section JSON context maps unique static attributes independently across repeated sections', async t => {
  const project = await fixture(t, {
    [target]: '<img class="hero-image" alt="Hero">',
    'templates/index.json': { sections: { first: { type: 'hero' }, second: { type: 'hero' } } },
  });
  const images = ['first', 'second'].map((key, index) => {
    const item = image({ class: 'hero-image', alt: 'Hero' }, { selector: `#${key} img`, sectionContext: { id: `shopify-section-template--42__${key}` } });
    item.dom.documentSelector = `html > body > div:nth-of-type(${index + 1}) > img`;
    return item;
  });
  const result = await mapCapture({ project, capture: capture(images) });
  assert.equal(result.summary.mapped, 2);
  assert.ok(result.mappings.every(item => item.method === 'section-config-static-attributes'));
  assert.equal(result.components.length, 2);
});

test('matching loop images within one section stay ambiguous', async t => {
  const project = await fixture(t, { [target]: '{% for i in items %}<img class="hero-image" alt="Hero">{% endfor %}', 'templates/index.json': { sections: { main: { type: 'hero' } } } });
  const images = [0, 1].map(index => {
    const item = image({ class: 'hero-image', alt: 'Hero' }, { selector: `#main img:nth-child(${index + 1})`, sectionContext: { id: 'shopify-section-template--1__main' } });
    item.dom.documentSelector = `html > body > img:nth-of-type(${index + 1})`; return item;
  });
  const result = await mapCapture({ project, capture: capture(images) });
  assert.equal(result.summary.mapped, 0);
  assert.equal(result.summary.ambiguous, 2);
});

test('conflicting section configurations and incomplete inventory cannot establish mapping', async t => {
  const project = await fixture(t, { [target]: '<img class="hero-image" alt="Hero">', 'templates/index.json': { sections: { main: { type: 'hero' } } }, 'templates/product.json': { sections: { main: { type: 'product' } } } });
  const raw = capture([image({ class: 'hero-image', alt: 'Hero' }, { sectionContext: { id: 'shopify-section-template--1__main' } })]);
  const result = await mapCapture({ project, capture: raw });
  assert.equal(result.summary.ambiguous, 1);
  assert.equal(result.summary.mapped, 0);
  await writeFile(path.join(project, 'templates/product.json'), '{}');
  raw.mappingInventory.complete = false;
  assert.equal((await mapCapture({ project, capture: raw })).summary.mapped, 0);
});

test('component-only section context maps without requiring image elements', async t => {
  const project = await fixture(t, { [target]: '<count-down></count-down>', 'templates/index.json': { sections: { main: { type: 'hero' } } } });
  const raw = capture([]);
  raw.component = { selector: '#shopify-section-template--1__main', sectionContext: { id: 'shopify-section-template--1__main' } };
  const result = await mapCapture({ project, capture: raw });
  assert.equal(result.components.length, 1);
  assert.equal(result.components[0].sourcePath, target);
  assert.match(result.components[0].sourceHash, /^[a-f0-9]{64}$/);
  assert.equal(result.components[0].deploymentVerification, 'unknown');
  assert.equal(result.summary.mapped, 0);
});

test('JavaScript component target preserves capture compatibility without inventing image mappings', async t => {
  const project = await fixture(t, { 'assets/countdown.js': 'class Countdown extends HTMLElement {}' });
  const result = await mapCapture({ project, target: 'assets/countdown.js', capture: capture([image()]) });
  assert.equal(result.summary.mapped, 0);
  assert.equal(result.linkedCapture.target, 'assets/countdown.js');
  assert.ok(result.limitations.some(item => item.includes('JavaScript/CSS')));
});

test('invalid capture shapes and stale per-image links cannot be laundered into fresh mapping', async t => {
  const project = await fixture(t, { [target]: '<img id="hero" alt="Hero">' });
  await assert.rejects(mapCapture({ project, target, capture: { images: [] } }), { code: 'INVALID_MAPPING_INPUT' });
  for (const previous of [{ sourceIndex: 0 }, { sourceIndex: 0, sourcePath: target, sourceHash: '0'.repeat(64) }]) {
    const result = await mapCapture({ project, target, capture: capture([image(undefined, previous)]) });
    assert.equal(result.summary.mapped, 0);
    assert.equal(result.summary.unmapped, 1);
  }
});

test('cross-file captures require matching per-image hashes and inspect only its own file', async t => {
  const other = 'sections/footer.liquid';
  const project = await fixture(t, { [target]: '<img alt="Hero" loading="lazy">', [other]: '<img alt="Footer" loading="lazy">' });
  const images = [];
  for (const [index, file] of [target, other].entries()) {
    const report = await inspectSource({ project, target: file });
    const item = image({ alt: index ? 'Footer' : 'Hero' }, { selector: `#image${index}`, isLCP: true,
      sourceIdentity: { sourcePath: file, sourceHash: report.sourceHash, sourceIndex: 0 } });
    item.dom.documentSelector = `html > body > img:nth-of-type(${index + 1})`; images.push(item);
  }
  const result = await mapCapture({ project, capture: capture(images) });
  assert.equal(result.linkedCapture.target, null);
  assert.equal(result.linkedCapture.sourceHash, undefined);
  for (const file of [target, other]) {
    const inspection = await inspectSource({ project, target: file, capture: result });
    assert.equal(inspection.findings.filter(item => item.ruleId === 'IMG04').length, 1);
  }
  result.linkedCapture.images[0].sourceHash = '0'.repeat(64);
  assert.equal((await inspectSource({ project, target, capture: result })).findings.filter(item => item.ruleId === 'IMG04').length, 0);
});

test('unsafe annotation paths and symlink escapes are rejected without reading outside source', async t => {
  const project = await fixture(t, { [target]: '<img id="hero" alt="Hero">' });
  const external = await fixture(t, { 'outside.liquid': '<img>' });
  await symlink(path.join(external, 'outside.liquid'), path.join(project, 'sections/link.liquid'));
  for (const sourcePath of ['../outside.liquid', '/etc/passwd', 'sections/link.liquid']) {
    await assert.rejects(mapCapture({ project, capture: capture([image(undefined, { sourceIdentity: { sourcePath, sourceHash: 'f'.repeat(64), sourceIndex: 0 } })]) }), /inside|escapes/);
  }
});

test('duplicate capture selectors and unknown descriptors stay unresolved', async t => {
  const project = await fixture(t, { [target]: '<img id="hero" alt="Hero">' });
  const duplicated = await mapCapture({ project, target, capture: capture([image(), image()]) });
  assert.equal(duplicated.summary.mapped, 1);
  assert.equal(duplicated.summary.unmapped, 1);
  assert.equal((await mapCapture({ project, target, capture: capture([{ selector: '#hero' }]) })).summary.mapped, 0);
});

test('real browser capture writes descriptors and automatic mapping without source annotation', { skip: !process.env.PERF_KIT_PLAYWRIGHT_MODULE && 'Set PERF_KIT_PLAYWRIGHT_MODULE for browser integration.' }, async t => {
  const project = await fixture(t, { [target]: '<img id="hero" alt="Hero" src="/hero.svg">' });
  const outputRoot = await fixture(t);
  const server = createServer((request, response) => {
    if (request.url === '/hero.svg') { response.setHeader('Content-Type', 'image/svg+xml'); response.end('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="50"></svg>'); }
    else { response.setHeader('Content-Type', 'text/html'); response.end('<main><img id="hero" alt="Hero" src="/hero.svg"></main>'); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const result = await capturePage({ project, target, url: `http://127.0.0.1:${server.address().port}`, selector: 'main', output: path.join(outputRoot, 'capture'), waitMs: 50 });
  assert.equal(result.images[0].dom.idCount, 1);
  assert.equal(result.images[0].sourceIndex, 0);
  assert.equal(result.mapping.summary.inferred, 1);
  assert.equal(JSON.parse(await readFile(path.join(outputRoot, 'capture/mapping.json'), 'utf8')).summary.mapped, 1);
});
