import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright-core';
import { browserExecutable, profileRuntime } from '../lib/runtime-profile.mjs';
import { transformCode } from '../lib/code-strategies.mjs';
import { p1PerformanceStrategies } from '../lib/p1-performance-strategies.mjs';
import { auditPerformance } from '../lib/performance-audit.mjs';

const enabled = process.env.PERF_KIT_BROWSER_TESTS === '1';
const change = (source, kind, parameters, target) => transformCode({ source, kind, parameters, target,
  evidence: { ...Object.fromEntries(p1PerformanceStrategies.find(s => s.kind === kind).evidenceRequired.map(k => [k, true])),
    sourceHash: createHash('sha256').update(source).digest('hex'), summary: 'Isolated browser fixture evidence.' } }).after;
async function fixture(t, routes, files = {}) {
  const root = await mkdtemp('/private/tmp/perfkit-p1-browser-'), project = path.join(root, 'theme');
  await mkdir(path.join(project, 'assets'), { recursive: true }); await mkdir(path.join(project, 'sections'), { recursive: true });
  await writeFile(path.join(project, 'sections/main.liquid'), '<section>Fixture</section>');
  for (const [file, content] of Object.entries(files)) await writeFile(path.join(project, file), content);
  const requests = [];
  const server = http.createServer((req, res) => {
    const name = new URL(req.url, 'http://localhost').pathname, route = routes[name];
    requests.push(name); res.setHeader('cache-control', 'no-store');
    if (!route) { res.writeHead(404); res.end(); return; }
    for (const [key, value] of Object.entries(route.headers ?? {})) res.setHeader(key, value);
    res.setHeader('content-type', route.type ?? 'text/html'); res.end(route.body);
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }); });
  return { root, project, requests, url: `http://127.0.0.1:${server.address().port}` };
}

test('real Chrome P1: critical CSS is synchronous without JavaScript; duplicate hint removal preserves requests and styling', { skip: !enabled, timeout: 60000 }, async t => {
  const link = '<link rel="stylesheet" href="/main.css" media="print" onload="this.onload=null;this.media=\'all\'">';
  const hint = '<link rel="preload" href="/main.css" as="style">';
  const original = `<!doctype html><head>${hint}${hint}${link}</head><body><h1 class="hero">Critical styled text</h1></body>`;
  const deduped = change(original, 'liquid-dedupe-resource-hint', { firstStart: original.indexOf(hint), duplicateStart: original.lastIndexOf(hint) }, 'layout/theme.liquid');
  const after = change(deduped, 'liquid-critical-css-sync', { tagStart: deduped.indexOf(link) }, 'layout/theme.liquid');
  const f = await fixture(t, { '/before': { body: original }, '/after': { body: after },
    '/main.css': { body: '.hero{color:rgb(10, 20, 30);font-size:32px}', type: 'text/css' } });
  const browser = await chromium.launch({ executablePath: await browserExecutable(), headless: true }); t.after(() => browser.close());
  for (const javaScriptEnabled of [true, false]) {
    const context = await browser.newContext({ javaScriptEnabled }), page = await context.newPage();
    for (const route of ['/before', '/after']) {
      const start = f.requests.length; await page.goto(f.url + route);
      if (javaScriptEnabled || route === '/after') {
        await page.waitForFunction(() => getComputedStyle(document.querySelector('.hero')).color === 'rgb(10, 20, 30)');
        assert.equal(await page.locator('.hero').evaluate(el => getComputedStyle(el).fontSize), '32px');
      } else assert.notEqual(await page.locator('.hero').evaluate(el => getComputedStyle(el).color), 'rgb(10, 20, 30)');
      if (route === '/after') {
        assert.equal(await page.locator('link[rel=preload]').count(), 1);
        assert.equal(await page.locator('link[rel=stylesheet]').getAttribute('onload'), null);
        assert.equal(f.requests.slice(start).filter(p => p === '/main.css').length, 1);
      }
    }
    await context.close();
  }
});
test('real Chrome P1: passive wheel keeps scroll and removal; explicit transitions preserve final layout and presentation', { skip: !enabled, timeout: 60000 }, async t => {
  const source = "let calls=0;function onWheel(){calls+=1;}window.addEventListener('wheel',onWheel,false);";
  const js = change(source, 'js-passive-listener', { registrationStart: source.indexOf('window.addEventListener') }, 'assets/main.js');
  const css = change('.box{transition-property:all;transition-duration:30ms;opacity:.5;transform:translateX(0)}', 'css-transition-properties',
    { selector: '.box', properties: ['opacity', 'transform'] }, 'assets/main.css');
  const f = await fixture(t, { '/': { body: `<!doctype html><style>body{height:3000px}.box{width:100px;height:80px}${css}.box.open{opacity:1;transform:translateX(20px);width:120px}</style><div class="box"></div><script>${js}</script>` } });
  const browser = await chromium.launch({ executablePath: await browserExecutable(), headless: true }); t.after(() => browser.close());
  const page = await browser.newPage(); await page.goto(f.url);
  const cdp = await page.context().newCDPSession(page);
  const { result } = await cdp.send('Runtime.evaluate', { expression: 'window' });
  const listeners = await cdp.send('DOMDebugger.getEventListeners', { objectId: result.objectId });
  assert.equal(listeners.listeners.find(l => l.type === 'wheel').passive, true);
  await page.mouse.move(200, 200); await page.mouse.wheel(0, 400);
  await page.waitForFunction(() => calls > 0 && window.scrollY > 0);
  await page.evaluate(() => { window.removeEventListener('wheel', onWheel, false); window.savedCalls = calls; window.dispatchEvent(new WheelEvent('wheel')); });
  assert.equal(await page.evaluate(() => calls), await page.evaluate(() => window.savedCalls));
  await page.evaluate(() => { window.addEventListener('wheel', onWheel, { passive: true, capture: false }); window.dispatchEvent(new WheelEvent('wheel')); });
  assert.equal(await page.evaluate(() => calls), await page.evaluate(() => window.savedCalls + 1));
  await page.locator('.box').evaluate(el => el.classList.add('open'));
  await page.waitForFunction(() => getComputedStyle(document.querySelector('.box')).opacity === '1');
  assert.deepEqual(await page.locator('.box').evaluate(el => {
    const s = getComputedStyle(el); return { properties: s.transitionProperty, width: s.width, transform: s.transform };
  }), { properties: 'opacity, transform', width: '120px', transform: 'matrix(1, 0, 0, 1, 20, 0)' });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.locator('.box').evaluate(el => el.classList.remove('open'));
  await page.waitForFunction(() => getComputedStyle(document.querySelector('.box')).opacity === '0.5');
  assert.equal(await page.locator('.box').evaluate(el => getComputedStyle(el).width), '100px');
});
test('real Chrome P1: capture keeps document Link evidence, hidden DOM and dialog LCP with source identity', { skip: !enabled, timeout: 60000 }, async t => {
  const links = [1, 2, 3].map(i => `<link rel="preload" href="/${i}.css" as="style">`).join('');
  const html = `<!doctype html><head>${links}</head><body><dialog open><h1>Large visible dialog headline for LCP</h1></dialog><dialog id="closed">${'<span>Hidden</span>'.repeat(210)}</dialog></body>`;
  const f = await fixture(t, { '/': { body: html, headers: { Link: '</1.css>; rel=preload; as=style', 'X-Private-Fixture': 'not-captured' } },
    ...Object.fromEntries([1, 2, 3].map(i => [`/${i}.css`, { body: 'h1{font-size:32px}', type: 'text/css' }])) });
  const profile = await profileRuntime({ config: { schemaVersion: 1, project: f.project, url: f.url + '/', device: 'mobile', state: 'initial', settleMs: 500, actions: [] }, output: path.join(f.root, 'profile') });
  assert.equal(profile.status, 'complete', JSON.stringify(profile.errors));
  assert.equal(profile.initial.delivery.version, 1);
  assert.ok(profile.initial.delivery.hiddenComponents.some(c => c.selector === '#closed' && c.descendants === 210));
  const document = profile.resources.find(r => r.type === 'Document');
  assert.equal(document.linkHeader, '</1.css>; rel=preload; as=style'); assert.ok(!JSON.stringify(document).includes('not-captured'));
  const audit = await auditPerformance({ project: f.project, profiles: [profile] });
  for (const id of ['PERF_PRELOAD_BUDGET', 'PERF_HIDDEN_DOM', 'PERF_DIALOG_LCP']) assert.ok(audit.findings.some(f => f.ruleId === id), id);
  assert.ok(audit.findings.filter(f => f.id.startsWith('runtime:')).every(f => f.sourceAssociation === 'requires-rendered-source-review'));
  assert.ok(!audit.issues.some(i => i.reason === 'p1-delivery-evidence-unavailable-recapture'));
});
