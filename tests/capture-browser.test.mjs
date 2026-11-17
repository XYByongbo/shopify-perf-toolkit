import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { capturePage } from '../lib/capture.mjs';

const browserAvailable = process.env.PERF_KIT_BROWSER_TESTS === '1';
test('real browser capture is component-scoped, read-only, explicit about local preview, and refuses overwrite', { skip: browserAvailable ? false : 'Run npm run test:browser to execute real Chrome integration.' }, async () => {
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
