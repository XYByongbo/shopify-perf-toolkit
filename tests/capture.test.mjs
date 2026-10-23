import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { capturePage, resourceTimingRecord, validateCaptureOptions, isLocalPreviewUrl } from '../lib/capture.mjs';

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

const browserAvailable = Boolean(process.env.PERF_KIT_PLAYWRIGHT_MODULE);
test('real browser capture is component-scoped, read-only, explicit about local preview, and refuses overwrite', { skip: browserAvailable ? false : 'Set PERF_KIT_PLAYWRIGHT_MODULE to an existing Playwright module to run real browser integration.' }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'perf-kit-capture-test-'));
  let writeRequests = 0;
  const server = createServer((request, response) => {
    if (request.method === 'POST') writeRequests += 1;
    if (request.url === '/image.svg') {
      response.writeHead(200, { 'Content-Type': 'image/svg+xml' });
      response.end('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="60"><rect width="100" height="60" fill="red"/></svg>');
    } else {
      response.writeHead(200, { 'Content-Type': 'text/html' });
      response.end('<!doctype html><html><body><script>window.__LOCAL_PREVIEW__=true;fetch("/write",{method:"POST"}).catch(()=>{});</script><main id="product"><h1>Same product</h1><a href="/products/example">Details</a><img src="/image.svg" width="100" height="60" alt="Red product"><button>Details</button></main><aside><img src="/image.svg" alt="Excluded image"></aside><div class="duplicate"></div><div class="duplicate"></div></body></html>');
    }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const url = `http://127.0.0.1:${server.address().port}/`;
  try {
    const output = path.join(directory, 'nested', 'baseline');
    const result = await capturePage({ url, selector: '#product', output, waitMs: 100, viewport: { width: 390, height: 844 } });
    assert.equal(result.images.length, 1);
    assert.equal(result.images[0].alt, 'Red product');
    assert.equal(result.images[0].naturalWidth, 100);
    assert.equal(result.images[0].sourceIdentity, null);
    assert.equal(result.images[0].materialIdentity, `${url}image.svg`);
    assert.equal(result.environment.localPreview, true);
    assert.equal(result.metrics.scope, 'page');
    assert.equal(result.metrics.inp, null);
    assert.equal(result.blockedRequests.some(request => request.method === 'POST'), true);
    assert.equal(writeRequests, 0);
    assert.ok(result.screenshots.component.sha256);
    assert.equal(JSON.parse(await readFile(path.join(output, 'capture.json'), 'utf8')).kind, 'capture');
    await assert.rejects(capturePage({ url, selector: '#product', output }), { code: 'OUTPUT_EXISTS' });
    await assert.rejects(capturePage({ url, selector: '.duplicate', output: path.join(directory, 'duplicate'), waitMs: 0 }), { code: 'SELECTOR_NOT_UNIQUE' });
    await assert.rejects(capturePage({ url, selector: '#missing', output: path.join(directory, 'missing'), waitMs: 0 }), { code: 'SELECTOR_NOT_UNIQUE' });
    await assert.rejects(capturePage({ url, selector: 'div>>', output: path.join(directory, 'invalid'), waitMs: 0 }), { code: 'INVALID_SELECTOR' });
  } finally {
    await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
