import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { inspectSource, inspectImages } from '../lib/inspect.mjs';

async function fixture(t, source, target = 'sections/example.liquid') {
  const project = await mkdtemp(path.join(tmpdir(), 'shopify-perf-inspect-'));
  t.after(() => rm(project, { recursive: true, force: true }));
  await mkdir(path.dirname(path.join(project, target)), { recursive: true });
  await writeFile(path.join(project, target), source);
  return { project, target };
}

test('Liquid-aware attributes preserve mixed quotes, > signs and exact source offsets', async (t) => {
  const source = `<!-- heading -->\n<img\n class="hero" src="{{ section.settings.image | image_url: width: 2400 }}" alt="{{ section.settings.alt | default: 'a > b and "+"' | escape }}" loading="lazy">\n`;
  const location = await fixture(t, source);
  const report = await inspectSource(location);
  assert.equal(report.images.length, 1);
  const img = report.images[0];
  assert.equal(img.index, 0);
  assert.equal(img.line, 2);
  assert.equal(img.imageObject, 'section.settings.image');
  assert.equal(img.maxWidth, 2400);
  assert.equal(img.tag, source.slice(img.start, img.end));
  assert.equal(img.attributes.alt, `{{ section.settings.alt | default: 'a > b and "+"' | escape }}`);
  assert.equal(img.eligibleForPatch, true);
  assert.equal(report.sourceHash, createHash('sha256').update(source).digest('hex'));
  assert.equal(await readFile(path.join(location.project, location.target), 'utf8'), source);
});

test('pure image parser independently preserves Unicode source offsets without reading a filesystem', () => {
  const source = `中文说明 🌅\n<img alt="{{ section.settings.alt | default: 'a > "+" b' }}" src="{{ section.settings.image | image_url: width: 900 }}">`;
  const [image] = inspectImages(source);
  assert.equal(image.index, 0);
  assert.equal(image.line, 2);
  assert.equal(source.slice(image.start, image.end), image.tag);
  assert.equal(image.attributes.alt, `{{ section.settings.alt | default: 'a > "+" b' }}`);
  assert.equal(image.eligibleForPatch, true);
  assert.throws(() => inspectImages(null), /must be a string/);
});

test('boolean attribute offsets exclude inter-attribute whitespace for independent patch validation', () => {
  const source = '<img hidden  src="{{ section.settings.image | image_url: width: 900 }}"  draggable>';
  const [image] = inspectImages(source);
  assert.equal(image.eligibleForPatch, true);
  assert.equal(image.attributes.hidden, null);
  assert.equal(image.attributes.draggable, null);
  assert.equal(source.slice(image.attributeList[0].start, image.attributeList[0].end), 'hidden');
  assert.equal(source.slice(image.attributeList[0].end, image.attributeList[1].start), '  ');
});

test('HTML comments, Liquid comments/schema/raw, and script/style text cannot invent images', async (t) => {
  const fake = `<img src="{{ section.settings.fake | image_url: width: 800 }}">`;
  const source = `<!-- ${fake} -->\n{%- comment -%}${fake}{%- endcomment -%}\n{% schema %}{"info":"${fake}"}{% endschema %}\n{% raw %}${fake}{% endraw %}\n<script>const template = '${fake}';</script>\n<style>.x:after{content:'${fake}'}</style>\n{% assign markup = '${fake}' %}\n<img src="{{ block.settings.real | image_url: width: 900 }}">`;
  const report = await inspectSource(await fixture(t, source));
  assert.equal(report.images.length, 1);
  assert.equal(report.images[0].imageObject, 'block.settings.real');
  assert.equal(report.images[0].index, 0);
  assert.ok(report.limitations.some((text) => text.includes('raw')));
});

test('comment-shaped text in attributes and script strings does not hide later real images', async (t) => {
  const source = `<div title="<!--">Content</div><script>const marker = '<!--';</script>\n<img alt="<!-- illustration -->" src="{{ section.settings.image | image_url: width: 800 }}">`;
  const report = await inspectSource(await fixture(t, source));
  assert.equal(report.images.length, 1);
  assert.equal(report.images[0].attributes.alt, '<!-- illustration -->');
  assert.equal(report.images[0].eligibleForPatch, true);
});

test('raw text and scripting-dependent fallback content are excluded conservatively', () => {
  const fake = '<img src="{{ section.settings.fake | image_url: width: 900 }}">';
  const input = ['textarea', 'title', 'xmp', 'iframe', 'noembed', 'noframes', 'noscript'].map((name) => `<${name}>${fake}</${name}>`).join('\n');
  assert.equal(inspectImages(input).length, 0);
  assert.equal(inspectImages(`<plaintext>${fake}</plaintext>${fake}`).length, 0);
});

test('crop, height transforms, dynamic widths, extra filters, and literal CDN URLs are never patch-eligible', async (t) => {
  const expressions = [
    `{{ section.settings.image | image_url: width: 800, height: 400, crop: 'center' }}`,
    `{{ product.featured_image | image_url: width: 800, crop: 'left' }}`,
    '{{ section.settings.image | image_url: width: section.settings.max_width }}',
    '{{ section.settings.image | image_url: width: 800 | escape }}',
    'https://cdn.example.com/image.jpg?width=800',
  ];
  const report = await inspectSource(await fixture(t, expressions.map((src) => `<img src="${src}">`).join('\n')));
  assert.equal(report.images.length, expressions.length);
  assert.ok(report.images.every((img) => img.eligibleForPatch === false));
  assert.ok(report.images.every((img) => img.imageObject === null));
});

test('duplicate and conditional attributes, injected attributes, picture art direction are unsafe', async (t) => {
  const src = 'src="{{ section.settings.image | image_url: width: 800 }}"';
  const source = [
    `<img ${src} SRC="duplicate.jpg">`,
    `<img ${src} {% if section.settings.lazy %}loading="lazy"{% endif %}>`,
    `<img ${src} {{ additional_attributes }}>`,
    `<picture><source media="(max-width: 600px)" srcset="mobile.jpg"><img ${src}></picture>`,
    `<img ${src} class=unquoted>`,
    `<img ${src}alt="no-space">`,
  ].join('\n');
  const report = await inspectSource(await fixture(t, source));
  assert.equal(report.images.length, 6);
  assert.ok(report.images.every((img) => !img.eligibleForPatch));
});

test('responsive literal image and Liquid image_tag produce no false missing-attribute finding', async (t) => {
  const source = `<img src="{{ product.featured_image | image_url: width: 1280 }}" srcset="{{ product.featured_image | image_url: width: 640 }} 640w, {{ product.featured_image | image_url: width: 1280 }} 1280w" sizes="(max-width: 749px) 100vw, 50vw" width="1280" height="720" loading="lazy">\n{{- media | image_url: width: media.preview_image.width | image_tag: loading: 'lazy', sizes: '(max-width: 699px) 56px, 64px', widths: '56,64,112,128,168,192' -}}`;
  const report = await inspectSource(await fixture(t, source));
  assert.equal(report.images.length, 1);
  assert.equal(report.images[0].eligibleForPatch, false);
  assert.equal(report.findings.length, 0);
  assert.ok(report.limitations.some((text) => text.includes('image_tag')));
});

test('unsafe traversal, absolute outside path and symlink escape are rejected', async (t) => {
  const location = await fixture(t, '<div>Safe</div>');
  await assert.rejects(inspectSource({ ...location, target: '../outside.liquid' }), /inside/);
  await assert.rejects(inspectSource({ ...location, target: '/etc/passwd' }), /inside/);
  const external = await mkdtemp(path.join(tmpdir(), 'shopify-perf-outside-'));
  t.after(() => rm(external, { recursive: true, force: true }));
  await writeFile(path.join(external, 'external.liquid'), '<div>Outside</div>');
  await symlink(path.join(external, 'external.liquid'), path.join(location.project, 'sections', 'link.liquid'));
  await assert.rejects(inspectSource({ ...location, target: 'sections/link.liquid' }), /symlink escapes/);
  await assert.rejects(inspectSource({ ...location, target: 'config/settings_data.json' }), /theme directory/);
});

test('all twelve rules have honest coverage; source-only checks never claim measured success', async (t) => {
  const report = await inspectSource(await fixture(t, '<div>No image or script</div>'));
  assert.deepEqual(report.coverage.map((item) => item.ruleId), ['IMG01', 'IMG02', 'IMG04', 'IMG05', 'IMG06', 'IMG07', 'CMP01', 'CMP03', 'CMP04', 'CMP07', 'JS02', 'FNT01']);
  for (const id of ['IMG06', 'IMG07', 'CMP07', 'JS02', 'FNT01']) assert.equal(report.coverage.find((item) => item.ruleId === id).status, 'not-assessed');
  assert.equal(report.findings.length, 0);
  assert.ok(report.coverage.every((item) => item.status !== 'pass'));
});

test('runtime evidence requires explicit sourceIndex and stale captures cannot upgrade findings', async (t) => {
  const location = await fixture(t, '<img src="{{ section.settings.image | image_url: width: 1200 }}" loading="lazy">');
  const base = await inspectSource(location);
  const unlinked = await inspectSource({ ...location, capture: { images: [{ index: 0, isLCP: true, loading: 'lazy' }] } });
  assert.ok(!unlinked.findings.some((item) => item.ruleId === 'IMG04'));
  const linked = await inspectSource({ ...location, capture: { sourceHash: base.sourceHash, target: location.target, images: [{ sourceIndex: 0, isLCP: true, loading: 'lazy', currentSrc: 'https://cdn.example.com/a.jpg', renderedWidth: 390, dpr: 2, naturalWidth: 9999 }] } });
  assert.equal(linked.findings.find((item) => item.ruleId === 'IMG04')?.status, 'observed');
  assert.ok(!linked.findings.some((item) => /oversized/i.test(item.summary)));
  const stale = await inspectSource({ ...location, capture: { sourceHash: 'stale', images: [{ sourceIndex: 0, isLCP: true, loading: 'lazy' }] } });
  assert.ok(!stale.findings.some((item) => item.ruleId === 'IMG04'));
  assert.ok(stale.limitations.some((text) => text.includes('was ignored')));
});

test('repeated source expressions are inventory, never proof of duplicate transfers', async (t) => {
  const img = '<img src="{{ section.settings.image | image_url: width: 800 }}">';
  const report = await inspectSource(await fixture(t, `${img}\n${img}`));
  assert.equal(report.coverage.find((item) => item.ruleId === 'IMG07').status, '未验证');
  assert.ok(!report.findings.some((item) => item.ruleId === 'IMG07'));
});

test('countdown-like lifecycle patterns are candidates, and JS comments/strings are ignored', async (t) => {
  const source = `class Countdown extends HTMLElement {\nconstructor() { super(); window.initScriptOnDemand(this, this.init.bind(this)); if (this.dataset.loading === 'eager') this.init(); }\ninit() { this.timer = setInterval(this.tick.bind(this), 1000); }\n}`;
  const report = await inspectSource(await fixture(t, source, 'assets/countdown.js'));
  assert.deepEqual(report.findings.map((item) => item.ruleId).sort(), ['CMP03', 'CMP04']);
  assert.ok(report.findings.every((item) => item.status === 'candidate'));
  const text = `// setInterval(x, 1000);\nconst description = 'class Fake extends HTMLElement { addEventListener(x) }';`;
  const ignored = await inspectSource(await fixture(t, text, 'assets/comments.js'));
  assert.equal(ignored.findings.length, 0);
});

test('fetch, timeout and font-face existence do not prove races, readiness defects or duplicates', async (t) => {
  const source = '<style>@font-face{font-family:"Demo";src:url(font.woff2)}</style><script>fetch("/cart.js"); setTimeout(() => console.log("done"), 400);</script>';
  const report = await inspectSource(await fixture(t, source));
  assert.equal(report.findings.length, 0);
  for (const id of ['CMP07', 'JS02', 'FNT01']) assert.equal(report.coverage.find((item) => item.ruleId === id).status, '未验证');
});

test('render and asset dependencies are inventoried without recursive source claims', async (t) => {
  const source = `{% render 'media', media: product.featured_media %}\n{{ 'component.css' | asset_url | stylesheet_tag }}\n{% render 'media' %}`;
  const report = await inspectSource(await fixture(t, source));
  assert.deepEqual(report.component.dependencies.map((item) => item.file), ['snippets/media.liquid', 'assets/component.css']);
  assert.equal(report.coverage.find((item) => item.ruleId === 'CMP01').status, '未验证');
});
