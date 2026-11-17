import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { resourceTimingRecord, validateCaptureOptions, isLocalPreviewUrl } from '../lib/capture.mjs';

const options = { url: 'http://127.0.0.1:9292/preview', selector: '#product', output: '/tmp/new-capture' };

test('local preview provenance recognizes loopback without a page marker and never treats remote URLs as verified Shopify', () => {
  for (const url of ['http://localhost:9292/', 'http://theme.localhost/', 'http://127.0.0.1/', 'http://127.10.2.3/', 'http://[::1]:9292/', 'http://0.0.0.0:9292/']) assert.equal(isLocalPreviewUrl(url), true);
  for (const url of ['https://localhost.example.com/', 'https://127.0.0.1.example.com/', 'https://myshopify.com/', 'bad']) assert.equal(isLocalPreviewUrl(url), false);
});

test('capture rejects unsafe URLs, embedded credentials, empty selectors, and invalid rendering parameters', () => {
  for (const url of ['file:///tmp/a.html', 'javascript:alert(1)', 'ftp://example.test/a', 'https://user:secret@example.test/', 'not a URL']) {
    assert.throws(() => validateCaptureOptions({ ...options, url }), { code: 'INVALID_URL' });
  }
  for (const selector of ['', ' ', undefined]) assert.throws(() => validateCaptureOptions({ ...options, selector }), { code: 'INVALID_SELECTOR' });
  for (const viewport of [{ width: 0, height: 800 }, { width: 390.1, height: 800 }, { width: 390, height: Infinity }, null]) {
    assert.throws(() => validateCaptureOptions({ ...options, viewport }), { code: 'INVALID_VIEWPORT' });
  }
  for (const dpr of [0, Infinity, NaN, 6]) assert.throws(() => validateCaptureOptions({ ...options, dpr }), { code: 'INVALID_DPR' });
  for (const waitMs of [-1, 1.5, Infinity, 60001]) assert.throws(() => validateCaptureOptions({ ...options, waitMs }), { code: 'INVALID_WAIT' });
  assert.throws(() => validateCaptureOptions({ ...options, timeoutMs: 0 }), { code: 'INVALID_TIMEOUT' });
});

test('capture defaults explicitly fix viewport, DPR, finite wait, and absolute output', () => {
  const result = validateCaptureOptions({ ...options, output: 'tmp-capture' });
  assert.deepEqual(result.viewport, { width: 390, height: 844 });
  assert.equal(result.dpr, 1);
  assert.equal(result.waitMs, 1500);
  assert.equal(result.timeoutMs, 30000);
  assert.equal(path.isAbsolute(result.output), true);
});

test('unexposed cross-origin resource timing has unknown bytes, never zero savings', () => {
  const record = resourceTimingRecord({ name: 'https://cdn.example.test/a.jpg', transferSize: 0, encodedBodySize: 0, decodedBodySize: 0, requestStart: 0, responseStart: 0 }, 'https://shop.example.test/');
  assert.equal(record.transferSize, null);
  assert.equal(record.encodedBodySize, null);
  assert.equal(record.decodedBodySize, null);
  assert.equal(record.sizeAvailability, 'unavailable-cross-origin-or-no-timing');
});

test('Resource Timing keeps transfer, encoded body, and decoded body independent', () => {
  const record = resourceTimingRecord({ name: 'https://cdn.example.test/a.svg', transferSize: 800, encodedBodySize: 500, decodedBodySize: 1000 }, 'https://shop.example.test/');
  assert.equal(record.transferSize, 800);
  assert.equal(record.encodedBodySize, 500);
  assert.equal(record.decodedBodySize, 1000);
});

test('cached body can legitimately have zero transfer while its body remains nonzero', () => {
  const record = resourceTimingRecord({ name: 'https://cdn.example.test/a.jpg', transferSize: 0, encodedBodySize: 500, decodedBodySize: 500 }, 'https://shop.example.test/');
  assert.equal(record.transferSize, 0);
  assert.equal(record.encodedBodySize, 500);
});

test('missing same-origin fields are not fabricated as zero', () => {
  const record = resourceTimingRecord({ name: 'https://shop.example.test/a.jpg' }, 'https://shop.example.test/');
  assert.equal(record.transferSize, null);
  assert.equal(record.encodedBodySize, null);
});
