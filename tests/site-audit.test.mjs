import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { auditSite } from '../lib/site-audit.mjs';
import { siteRun, changeReport } from './helpers/site-run.mjs';

async function theme(fixture) {
  const project = path.join(fixture.root, 'theme');
  await mkdir(path.join(project, 'assets'), { recursive: true });
  await mkdir(path.join(project, 'sections'), { recursive: true });
  await writeFile(path.join(project, 'assets/main.js'), 'const existing = true;');
  await writeFile(path.join(project, 'sections/hero.liquid'), '<img src="{{ section.settings.image | image_url: width: 2000 }}">');
  return project;
}

function runtime(report) {
  report.audits['render-blocking-resources'] = { title: 'Render blockers', score: 0, details: { type: 'opportunity', overallSavingsMs: 200,
    overallSavingsBytes: 4000, items: [{ url: 'https://shop.example.test/cdn/shop/t/1/assets/main.js?v=1' }] } };
  report.audits['third-party-insight'] = { title: 'Third parties', score: 0, scoreDisplayMode: 'metricSavings', metricSavings: { LCP: 400, FCP: 300, CLS: 0.1 },
    details: { items: [{ url: 'https://thirdparty.example.test/assets/main.js', mainThreadTime: 80 }] } };
  report.audits['largest-contentful-paint-element'] = { score: null, details: { items: [{ node: { type: 'node', selector: '#hero img', snippet: '<img id="hero">' } }] } };
  report.audits['mainthread-work-breakdown'] = { score: null, numericValue: 500, numericUnit: 'millisecond', details: { items: [{ group: 'scriptEvaluation', duration: 400 }] } };
  report.audits['network-requests'] = { score: null, details: { items: [{ url: 'https://shop.example.test/cdn/shop/t/1/assets/main.js?v=1', transferSize: 3000, resourceType: 'Script' }] } };
  report.audits['passed-insight'] = { score: 1, metricSavings: { LCP: 1000 }, details: { items: [] } };
}

test('site audit combines real report fields with static findings and ranks overlapping estimates without summing', async t => {
  const fixture = await siteRun(t, { devices: ['mobile'], augment: runtime });
  const project = await theme(fixture);
  const original = await readFile(path.join(project, 'assets/main.js'), 'utf8');
  const result = await auditSite({ project, run: fixture.root });
  assert.equal(result.kind, 'site-audit'); assert.equal(result.complete, true);
  assert.equal(result.outcome, 'review-required');
  const runtimeFindings = result.findings.filter(item => item.origin === 'lighthouse');
  assert.deepEqual(runtimeFindings.map(item => item.ruleId), ['third-party-insight', 'render-blocking-resources']);
  assert.equal(runtimeFindings[0].estimate.milliseconds.median, 400);
  assert.equal(runtimeFindings[0].file, null);
  assert.equal(runtimeFindings[0].sourceCandidates[0].status, 'unmapped');
  assert.equal(runtimeFindings[1].file, 'assets/main.js');
  assert.equal(runtimeFindings[1].sourceAssociation, 'candidate-only');
  assert.match(runtimeFindings[1].sourceHash, /^[a-f0-9]{64}$/);
  assert.ok(result.findings.some(item => item.origin === 'source' && item.ruleId === 'IMG02'));
  assert.equal(result.groups[0].metrics.lcpMs.median, 2000);
  assert.equal(result.groups[0].lcpElements[0].selector, '#hero img');
  assert.equal(result.groups[0].mainThread.length, 5);
  assert.equal(result.groups[0].thirdParties.length, 5);
  assert.equal(result.resources.length, 2);
  assert.ok(result.limitations.some(item => item.includes('not additive')));
  assert.equal(await readFile(path.join(project, 'assets/main.js'), 'utf8'), original);
});

test('partial runs remain partial, preserve missing metrics and never present empty scans as success', async t => {
  const fixture = await siteRun(t, { devices: ['mobile'], status: 'failed', reports: 1, augment: report => {
    delete report.audits['largest-contentful-paint'];
    report.runWarnings = ['Synthetic warning'];
  } });
  const project = await theme(fixture);
  const result = await auditSite({ project, run: fixture.root });
  assert.equal(result.complete, false); assert.equal(result.outcome, 'partial');
  assert.equal(result.groups[0].metrics.lcpMs.median, null);
  const raw = JSON.parse(await readFile(path.join(fixture.root, fixture.manifest.groups[0].reports[0]), 'utf8'));
  assert.deepEqual(raw.runWarnings, ['Synthetic warning']);
  assert.ok(result.evidence.issues.some(issue => issue.code === 'MISSING_METRIC')); 
  assert.ok(result.evidence.issues.length > 0);
});

test('unrelated same-origin paths and ambiguous resource lists do not become definite local identity', async t => {
  const fixture = await siteRun(t, { devices: ['mobile'], augment: report => {
    report.audits['mixed-insight'] = { score: 0, title: 'Mixed assets', metricSavings: { LCP: 100 }, details: { items: [
      { url: 'https://shop.example.test/cdn/shop/t/1/assets/main.js' }, { url: 'https://other.example.test/assets/main.js' },
      { url: 'https://shop.example.test/unrelated/main.js' },
    ] } };
  } });
  const result = await auditSite({ project: await theme(fixture), run: fixture.root });
  const finding = result.findings.find(item => item.ruleId === 'mixed-insight');
  assert.equal(finding.file, null);
  assert.equal(finding.sourceAssociation, 'unmapped-or-ambiguous');
  assert.equal(finding.sourceCandidates.filter(item => item.status === 'candidate').length, 1);
});

test('insights without overall byte savings rank a reported resource estimate without inventing an additive total', async t => {
  const fixture = await siteRun(t, { devices: ['mobile'], augment: report => {
    report.audits['image-delivery-insight'] = { score: 0, title: 'Image delivery', metricSavings: { LCP: 0 }, details: { items: [
      { url: 'https://shop.example.test/cdn/shop/files/one.jpg', wastedBytes: 50000 },
      { url: 'https://shop.example.test/cdn/shop/files/two.jpg', wastedBytes: 30000 },
    ] } };
  } });
  const result = await auditSite({ project: await theme(fixture), run: fixture.root });
  const finding = result.findings.find(item => item.ruleId === 'image-delivery-insight');
  assert.equal(finding.estimate.bytes.median, 50000);
  assert.equal(finding.evidence[0].byteEstimateBasis, 'largest-reported-resource-row-not-total');
});

test('complete manifests with incomplete samples yield partial audits and preserve original bytes', async t => {
  for (const [code, mutate] of [
    ['MISSING_BROWSER', report => { delete report.userAgent; }],
    ['INVALID_THROTTLING', report => { delete report.configSettings.throttling.cpuSlowdownMultiplier; }],
    ['MISSING_METRIC', report => { delete report.audits['speed-index'].score; }],
    ['MISSING_FETCH_TIME', report => { report.fetchTime = '2026-02-30T00:00:00Z'; }],
  ]) await t.test(code, async nested => {
    const fixture = await siteRun(nested, { devices: ['mobile'] });
    await changeReport(fixture, mutate);
    const file = path.join(fixture.root, fixture.manifest.groups[0].reports[0]);
    const original = await readFile(file);
    const result = await auditSite({ project: await theme(fixture), run: fixture.root });
    assert.equal(result.complete, false);
    assert.equal(result.outcome, 'partial');
    assert.ok(result.evidence.issues.some(issue => issue.code === code));
    assert.deepEqual(await readFile(file), original);
  });
});

test('supplemental quality/resources remain outside performance estimates and stale evidence is explicit', async t => {
  const fixture = await siteRun(t, { devices: ['mobile'] });
  const project = await theme(fixture);
  const { auditResources } = await import('../lib/resource-audit.mjs');
  await writeFile(path.join(project, 'sections/hero.liquid'), '<script src="https://cdn.example/a.js"></script>');
  const resourceAnalysis = await auditResources({ project });
  let result = await auditSite({ project, run: fixture.root, resourceAnalysis });
  assert.equal(result.supplemental[0].status, 'current-source');
  assert.ok(!result.findings.some(f => f.ruleId === 'JS_BLOCKING'));
  await writeFile(path.join(project, 'sections/hero.liquid'), '<div>changed</div>');
  result = await auditSite({ project, run: fixture.root, resourceAnalysis });
  assert.equal(result.supplemental[0].status, 'stale');
  await assert.rejects(auditSite({ project, run: fixture.root, resourceAnalysis: { ...resourceAnalysis, project: '/other' } }));
});
