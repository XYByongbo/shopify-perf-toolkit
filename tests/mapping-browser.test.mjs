import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
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
test('real browser capture writes descriptors and automatic mapping without source annotation', { skip: process.env.PERF_KIT_BROWSER_TESTS !== '1' }, async t => {
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
