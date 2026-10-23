import test from 'node:test';
import assert from 'node:assert/strict';
import { compareCaptures, imageMaterialIdentity } from '../lib/compare.mjs';

const baseline = () => ({
  schemaVersion: 1, kind: 'capture', project: '/project', target: 'product-image',
  environment: { url: 'https://shop.test/products/a', finalUrl: 'https://shop.test/products/a', viewport: { width: 390, height: 844 }, dpr: 1,
    browser: 'chromium', browserVersion: '130', userAgent: 'test-UA', locale: 'en-US', timezoneId: 'UTC', colorScheme: 'light', reducedMotion: 'no-preference',
    cache: 'disabled-by-routing', storage: 'fresh-context', serviceWorkers: 'blocked', requestPolicy: 'GET-HEAD-OPTIONS-only', localPreview: false, requestedWaitMs: 1500 },
  component: { selector: '#product', text: 'Product details', links: [{ href: 'https://shop.test/product', text: 'View' }], controls: [], visible: true, geometry: { x: 0, y: 20, width: 300, height: 200 } },
  images: [{ selector: '#product > img:nth-of-type(1)', src: 'https://cdn.shop.test/product.jpg?v=1&width=1000', currentSrc: 'https://cdn.shop.test/product.jpg?v=1&width=1000', srcset: null,
    alt: 'A product', box: { x: 0, y: 20, width: 300, height: 200 }, visible: true, complete: true, naturalWidth: 1000, naturalHeight: 800,
    resource: { transferSize: 10300, encodedBodySize: 10000, decodedBodySize: 10000 } }],
  media: [], consoleErrors: [], screenshots: { component: { sha256: 'same-pixels' } },
});
const check = (result, id) => result.checks.find(item => item.id === id);

test('identical captures preserve observed invariants but cannot establish interaction equivalence', () => {
  const result = compareCaptures(baseline(), baseline());
  assert.equal(result.comparable, true);
  assert.equal(result.outcome, 'review-required');
  assert.equal(check(result, 'component-pixels').status, 'pass');
  assert.equal(check(result, 'functional-interactions').status, 'review');
  assert.equal(result.checks.some(item => item.status === 'fail'), false);
});

test('different URL, DPR, viewport, browser, selector, or missing environment makes captures incomparable', () => {
  for (const mutate of [
    data => { data.environment.url = 'https://shop.test/products/b'; },
    data => { data.environment.finalUrl = 'https://shop.test/password'; },
    data => { data.environment.dpr = 2; },
    data => { data.environment.viewport.width = 1280; },
    data => { data.environment.browserVersion = '131'; },
    data => { data.component.selector = '#another'; },
    data => { delete data.environment.requestedWaitMs; },
  ]) {
    const after = baseline(); mutate(after);
    assert.equal(compareCaptures(baseline(), after).outcome, 'not-comparable');
  }
});

test('malformed or mismatched schemas cannot pass', () => {
  assert.equal(compareCaptures(null, {}).outcome, 'not-comparable');
  assert.equal(compareCaptures({ ...baseline(), kind: 'inspection' }, baseline()).comparable, false);
});

test('content, links, alt, geometry, controls, and image asset changes detect regressions', () => {
  for (const [id, mutate] of [
    ['component-text', data => { data.component.text = 'New text'; }],
    ['component-links', data => { data.component.links[0].href = 'https://shop.test/wrong'; }],
    ['component-controls', data => { data.component.controls = [{ type: 'button', disabled: true }]; }],
    ['image-1-alt', data => { data.images[0].alt = ''; }],
    ['image-1-geometry', data => { data.images[0].box.height = 201; }],
    ['image-1-material', data => { data.images[0].currentSrc = 'https://cdn.shop.test/different.jpg'; }],
    ['image-1-loaded', data => { data.images[0].naturalWidth = 0; }],
  ]) {
    const after = baseline(); mutate(after);
    const result = compareCaptures(baseline(), after);
    assert.equal(result.outcome, 'regression-detected', id);
    assert.equal(check(result, id).status, 'fail', id);
  }
});

test('a width candidate change keeps material identity and records separate response-size deltas', () => {
  const after = baseline();
  after.images[0].src = after.images[0].currentSrc = 'https://cdn.shop.test/product.jpg?v=1&width=480';
  after.images[0].resource = { transferSize: 4300, encodedBodySize: 4000, decodedBodySize: 9000 };
  const result = compareCaptures(baseline(), after);
  assert.equal(check(result, 'image-1-material').status, 'pass');
  assert.deepEqual(check(result, 'image-1-bytes').details, {
    encodedBodyBytes: { before: 10000, after: 4000, delta: -6000 },
    transferredBytes: { before: 10300, after: 4300, delta: -6000 },
    decodedBodyBytes: { before: 10000, after: 9000, delta: -1000 },
  });
  assert.equal(result.outcome, 'review-required');
});

test('unknown byte sizes stay unknown, including nulls, absent resources, and NaN', () => {
  for (const resource of [null, {}, { transferSize: null, encodedBodySize: null }, { encodedBodySize: NaN }]) {
    const after = baseline(); after.images[0].resource = resource;
    const bytes = check(compareCaptures(baseline(), after), 'image-1-bytes');
    assert.equal(bytes.status, 'unknown');
    assert.equal(bytes.details.encodedBodyBytes, null);
  }
});

test('changed crop transforms and changed srcset assets cannot hide behind width changes', () => {
  const crop = baseline(); crop.images[0].currentSrc += '&crop=left';
  assert.equal(check(compareCaptures(baseline(), crop), 'image-1-material').status, 'fail');
  const srcset = baseline(); srcset.images[0].srcset = 'https://cdn.shop.test/product.jpg?v=1&width=480 480w, https://cdn.shop.test/different.jpg?v=1&width=1000 1000w';
  assert.equal(check(compareCaptures(baseline(), srcset), 'image-1-material').status, 'fail');
});

test('alt absence differs from empty alt, while absent evidence requires review', () => {
  const absent = baseline(); absent.images[0].alt = null;
  const decorative = baseline(); decorative.images[0].alt = '';
  assert.equal(check(compareCaptures(absent, decorative), 'image-1-alt').status, 'fail');
  delete decorative.images[0].alt;
  assert.equal(check(compareCaptures(absent, decorative), 'image-1-alt').status, 'unknown');
});

test('new duplicate console errors are a regression and changed pixels require review', () => {
  const before = baseline(); before.consoleErrors = [{ type: 'pageerror', message: 'existing error' }];
  const after = structuredClone(before); after.consoleErrors.push({ type: 'pageerror', message: 'existing error' });
  assert.equal(check(compareCaptures(before, after), 'console-errors').status, 'fail');
  const changedPixels = baseline(); changedPixels.screenshots.component.sha256 = 'different';
  assert.equal(check(compareCaptures(baseline(), changedPixels), 'component-pixels').status, 'review');
});

test('material identity resolves relative URLs and retains image version and visual crop', () => {
  assert.equal(imageMaterialIdentity('/assets/a.jpg?v=1&width=300&crop=center', 'https://shop.test/products/a'), 'https://shop.test/assets/a.jpg?crop=center&v=1');
  assert.notEqual(imageMaterialIdentity('data:image/png;base64,AAAA'), imageMaterialIdentity('data:image/png;base64,BBBB'));
  assert.equal(imageMaterialIdentity('blob:https://shop.test/abc', 'https://shop.test/'), null);
});
