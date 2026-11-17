import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { runScenarios } from '../lib/scenarios.mjs';

const minimal = () => ({ schemaVersion: 1, url: 'https://preview.example.test/', scenarios: [{ name: 'component', steps: [{ action: 'assert-count', selector: '.component', count: 3 }] }] });

function fixture(mode) {
  return `<!doctype html><html><body data-timers="0" data-loads="0"><h1>Component test</h1>
  <section id="section"><test-counter id="one"><button>Increment</button></test-counter><test-counter id="two"><button>Increment</button></test-counter><test-counter id="three"><button>Increment</button></test-counter></section>
  <p id="text">Exact   text\n content</p><div id="hidden" hidden>Hidden</div><button id="post">Send write</button><button id="websocket">Open socket</button><div style="height:1600px"></div><button id="bottom">Bottom action</button>
  <script>
  window.__LOCAL_PREVIEW__ = true;
  const mode = ${JSON.stringify(mode)};
  let active = 0;
  function record(delta) { active += delta; document.body.dataset.timers = String(active); }
  class Counter extends HTMLElement {
    connectedCallback() { this.dataset.connects = String(Number(this.dataset.connects || 0) + 1); this.dataset.clicks ||= '0'; this.handlers ||= []; this.timers ||= []; this.initialize(); }
    initialize() {
      if (this.active && mode !== 'duplicate') return;
      this.active = true;
      const handler = () => { this.dataset.clicks = String(Number(this.dataset.clicks) + 1); };
      this.querySelector('button').addEventListener('click', handler); this.handlers.push(handler);
      this.timers.push(setInterval(() => {}, 10000)); record(1);
    }
    disconnectedCallback() {
      if (mode === 'cleanup') return;
      for (const id of this.timers) { clearInterval(id); record(-1); }
      for (const handler of this.handlers) this.querySelector('button').removeEventListener('click', handler);
      this.timers = []; this.handlers = []; this.active = false;
    }
  }
  customElements.define('test-counter', Counter);
  document.querySelector('#section').addEventListener('shopify:section:load', event => {
    document.body.dataset.loads = String(Number(document.body.dataset.loads) + 1);
    document.body.dataset.sectionId = event.detail?.sectionId || '';
    for (const element of document.querySelectorAll('test-counter')) element.initialize();
  });
  document.querySelector('#section').addEventListener('shopify:section:unload', () => { document.body.dataset.unloaded = 'true'; });
  document.querySelector('#post').addEventListener('click', () => { fetch('/write', { method: 'POST', body: 'should-not-arrive' }).catch(() => { document.body.dataset.postBlocked = 'true'; }); });
  document.querySelector('#websocket').addEventListener('click', () => { const socket = new WebSocket(location.origin.replace('http:', 'ws:') + '/socket'); socket.onclose = () => { document.body.dataset.socketBlocked = 'true'; }; });
  document.querySelector('#bottom').addEventListener('click', () => { document.body.dataset.bottomClicked = 'true'; });
  </script></body></html>`;
}

const browserAvailable = process.env.PERF_KIT_BROWSER_TESTS === '1';
test('real Chromium matrix catches duplicate init and cleanup regressions, preserves original nodes, and blocks POST/WebSocket', { skip: browserAvailable ? false : 'Run npm run test:browser to execute real Chrome integration.' }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'perf-kit-scenarios-'));
  let writes = 0;
  let socketUpgrades = 0;
  const server = createServer((request, response) => {
    if (request.method === 'POST') writes++;
    response.writeHead(200, { 'Content-Type': 'text/html' });
    response.end(fixture(request.url.includes('duplicate') ? 'duplicate' : request.url.includes('cleanup') ? 'cleanup' : 'good'));
  });
  server.on('upgrade', (_request, socket) => { socketUpgrades++; socket.destroy(); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const url = `http://127.0.0.1:${server.address().port}/`;
  const attr = (selector, name, value) => ({ action: 'assert-attribute', selector, name, value });
  try {
    const output = path.join(directory, 'matrix');
    const result = await runScenarios({ output, config: {
      schemaVersion: 1, url, timeoutMs: 1000, scenarios: [
        { name: 'first and repeated click', steps: [
          { action: 'click', selector: '#one button' }, attr('#one', 'data-clicks', '1'),
          { action: 'click', selector: '#one button', times: 2 }, attr('#one', 'data-clicks', '3'),
          attr('#two', 'data-clicks', '0'), { action: 'assert-count', selector: 'test-counter', count: 3 },
          { action: 'assert-visible', selector: '#hidden', visible: false },
          { action: 'assert-text', selector: '#text', text: 'Exact text content' },
          attr('#one', 'nonexistent', null), { action: 'scroll', selector: '#bottom' },
          { action: 'click', selector: '#bottom' }, attr('body', 'data-bottom-clicked', 'true'),
        ] },
        { name: 'repeated init and reconnect', steps: [
          { action: 'assert-count', selector: 'test-counter', count: 3 },
          { action: 'dispatch', selector: '#section', event: 'shopify:section:load', detail: { sectionId: 'fixture' } },
          attr('body', 'data-section-id', 'fixture'),
          { action: 'dispatch', selector: '#section', event: 'shopify:section:load' },
          attr('body', 'data-loads', '2'), attr('body', 'data-timers', '3'),
          { action: 'click', selector: '#one button' }, attr('#one', 'data-clicks', '1'),
          { action: 'dispatch', selector: '#section', event: 'shopify:section:unload' }, attr('body', 'data-unloaded', 'true'),
          { action: 'detach', selector: '#one', key: 'one' },
          { action: 'assert-count', selector: 'test-counter', count: 2 }, attr('body', 'data-timers', '2'),
          { action: 'reconnect', key: 'one' }, { action: 'assert-count', selector: 'test-counter', count: 3 },
          attr('#one', 'data-connects', '2'), attr('body', 'data-timers', '3'),
          { action: 'click', selector: '#one button' }, attr('#one', 'data-clicks', '2'),
        ] },
        { name: 'duplicate initialization defect', url: '/duplicate', steps: [
          { action: 'dispatch', selector: '#section', event: 'shopify:section:load' },
          { action: 'click', selector: '#one button' }, attr('#one', 'data-clicks', '1'),
          { action: 'click', selector: '#two button' },
        ] },
        { name: 'cleanup defect', url: '/cleanup', steps: [
          { action: 'detach', selector: '#one', key: 'one' }, attr('body', 'data-timers', '2'),
          { action: 'reconnect', key: 'one' },
        ] },
        { name: 'write request constrained', steps: [
          { action: 'click', selector: '#post' }, attr('body', 'data-post-blocked', 'true'),
        ] },
        { name: 'websocket constrained', steps: [
          { action: 'click', selector: '#websocket' }, attr('body', 'data-socket-blocked', 'true'),
        ] },
        { name: 'ambiguous click target', steps: [
          { action: 'click', selector: 'test-counter button' }, attr('#one', 'data-clicks', '1'),
        ] },
      ],
    } });
    assert.equal(result.kind, 'scenarios');
    assert.equal(result.outcome, 'failed');
    assert.equal(result.runs.length, 14);
    assert.deepEqual(result.summary, { runs: 14, passed: 4, failed: 6, blocked: 4, assertionsPassed: 44, blockedRequests: 4 });
    for (const run of result.runs.filter(run => run.name === 'first and repeated click')) {
      assert.equal(run.outcome, 'passed');
      assert.equal(run.beforeScreenshot, 'omitted-click-first');
      assert.equal(run.localPreview, true);
      assert.equal(run.artifacts.before, undefined);
      assert.ok(run.artifacts.after.sha256);
    }
    for (const run of result.runs.filter(run => run.name === 'repeated init and reconnect')) {
      assert.equal(run.outcome, 'passed');
      assert.equal(run.steps.find(step => step.action === 'reconnect').observation.sameNode, true);
      assert.ok(run.artifacts.before.sha256);
    }
    for (const run of result.runs.filter(run => run.name === 'duplicate initialization defect')) {
      assert.equal(run.steps[2].error.actual, '2');
      assert.equal(run.steps[2].error.code, 'ASSERTION_FAILED');
      assert.equal(run.steps[2].error.expected, '1');
      assert.equal(run.steps[3].outcome, 'skipped');
      const persisted = JSON.parse(await readFile(path.join(output, run.directory, 'run.json'), 'utf8'));
      assert.deepEqual(persisted.steps[2].error, run.steps[2].error);
      assert.equal(persisted.steps[2].error.actual, '2');
    }
    for (const run of result.runs.filter(run => run.name === 'cleanup defect')) assert.equal(run.steps[1].error.actual, '3');
    for (const run of result.runs.filter(run => run.name === 'ambiguous click target')) assert.equal(run.steps[0].error.code, 'SELECTOR_NOT_UNIQUE');
    for (const run of result.runs.filter(run => run.name === 'write request constrained')) {
      assert.equal(run.assertionOutcome, 'passed');
      assert.equal(run.outcome, 'blocked');
      assert.equal(run.blockedRequests[0].method, 'POST');
    }
    for (const run of result.runs.filter(run => run.name === 'websocket constrained')) {
      assert.equal(run.assertionOutcome, 'passed');
      assert.equal(run.outcome, 'blocked');
      assert.equal(run.blockedRequests[0].method, 'WEBSOCKET');
    }
    assert.equal(writes, 0);
    assert.equal(socketUpgrades, 0);
    for (const run of result.runs) assert.ok((await stat(path.join(output, run.artifacts.after.file))).size > 0);
    assert.equal(JSON.parse(await readFile(path.join(output, 'scenario-results.json'), 'utf8')).outcome, 'failed');
    await assert.rejects(runScenarios({ config: minimal(), output }), { code: 'OUTPUT_EXISTS' });
  } finally {
    await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
