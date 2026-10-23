import test from 'node:test';
import assert from 'node:assert/strict';
import { verifySite } from '../lib/site-verify.mjs';
import { siteRun, saveManifest, changeReport } from './helpers/site-run.mjs';

async function pair(t, afterOptions = {}) {
  return { before: await siteRun(t, { scores: { mobile: [50], desktop: [50] } }),
    after: await siteRun(t, { offset: 10, scores: { mobile: [75, 78, 80, 85, 85], desktop: [85, 88, 90, 95, 98] }, ...afterOptions }) };
}

test('site verification uses real Python scorer for each device and only passes the full matrix', async t => {
  const { before, after } = await pair(t);
  const result = await verifySite({ before: before.root, after: after.root });
  assert.equal(result.kind, 'site-verification');
  assert.equal(result.outcome, 'score-targets-met');
  assert.equal(result.checks.length, 2);
  assert.deepEqual(result.checks.map(check => check.details.thresholds), [
    { minimum_each_after_run: 75, target_after_median: 80 }, { minimum_each_after_run: 85, target_after_median: 90 },
  ]);
  assert.ok(result.limitations.some(item => item.includes('Functional behavior')));
});

test('a single failed device prevents whole-site score acceptance and records actual deltas', async t => {
  const { before, after } = await pair(t, { scores: { mobile: [80], desktop: [80] } });
  const result = await verifySite({ before: before.root, after: after.root });
  assert.equal(result.outcome, 'targets-not-met');
  assert.deepEqual(result.checks.map(check => check.status), ['pass', 'fail']);
  assert.equal(result.checks[1].details.changes.performance_score.delta_after_minus_before, 30);
});

test('warnings or provided environment require review while invalid source reports never pass', async t => {
  const fixtures = await pair(t);
  await changeReport(fixtures.after, report => { report.runWarnings = ['Synthetic warning']; });
  assert.equal((await verifySite({ before: fixtures.before.root, after: fixtures.after.root })).outcome, 'review-required');
  const before = await siteRun(t, { augment: report => { report.configSettings.throttlingMethod = 'provided'; } });
  const after = await siteRun(t, { offset: 10, scores: { mobile: [99], desktop: [99] }, augment: report => { report.configSettings.throttlingMethod = 'provided'; } });
  assert.equal((await verifySite({ before: before.root, after: after.root })).outcome, 'review-required');
  await changeReport(after, report => { delete report.userAgent; });
  assert.equal((await verifySite({ before: before.root, after: after.root })).outcome, 'invalid-evidence');
});

test('engine, declared page, URL and device matrix changes cannot be compared', async t => {
  for (const options of [
    { engine: 'psi' }, { devices: ['mobile'] },
    { pages: [{ id: 'other', url: 'https://shop.example.test/' }] },
    { pages: [{ id: 'home', url: 'https://shop.example.test/other' }] },
  ]) {
    const { before, after } = await pair(t, options);
    const result = await verifySite({ before: before.root, after: after.root });
    assert.equal(result.outcome, 'invalid-evidence');
  }
});

test('preview theme ID is permitted but same runs and incomplete manifests are rejected', async t => {
  const { before, after } = await pair(t, { pages: [{ id: 'home', url: 'https://shop.example.test/?preview_theme_id=2' }] });
  assert.equal((await verifySite({ before: before.root, after: after.root })).outcome, 'score-targets-met');
  assert.equal((await verifySite({ before: before.root, after: before.root })).outcome, 'invalid-evidence');
  after.manifest.status = 'failed'; await saveManifest(after);
  assert.equal((await verifySite({ before: before.root, after: after.root })).outcome, 'invalid-evidence');
});

test('explicit thresholds override device defaults and unknown/mixed options are rejected', async t => {
  const { before, after } = await pair(t, { scores: { mobile: [80], desktop: [80] } });
  const args = { before: before.root, after: after.root };
  assert.equal((await verifySite({ ...args, thresholds: { desktop: { minimum: 75, target: 80 } } })).outcome, 'score-targets-met');
  assert.equal((await verifySite({ ...args, thresholds: { minimum: 75, target: 80 } })).outcome, 'score-targets-met');
  for (const thresholds of [{ minimum: 75, desktop: { target: 80 } }, { mobile: { minimum: 90, target: 80 } }, { target: NaN }, { typo: 80 }]) {
    assert.equal((await verifySite({ ...args, thresholds })).outcome, 'invalid-evidence');
  }
});

test('preview theme exception cannot conceal mismatched raw evidence or a changed declared matrix', async t => {
  for (const mismatch of ['raw', 'group']) await t.test(mismatch, async nested => {
    const { before, after } = await pair(nested, { pages: [{ id: 'home', url: 'https://shop.example.test/?preview_theme_id=2' }] });
    if (mismatch === 'raw') await changeReport(after, report => {
      report.requestedUrl = report.finalDisplayedUrl = 'https://shop.example.test/?preview_theme_id=1';
    });
    else { after.manifest.groups[0].url = 'https://shop.example.test/?preview_theme_id=1'; await saveManifest(after); }
    assert.equal((await verifySite({ before: before.root, after: after.root })).outcome, 'invalid-evidence');
  });
});

test('invalid timestamps, missing sample evidence, and environment drift cannot pass site verification', async t => {
  const cases = [
    ['impossible calendar date', report => { report.fetchTime = '2026-02-30T00:00:00Z'; }],
    ['timezone missing', report => { report.fetchTime = '2026-10-16T00:10:00'; }],
    ['missing browser', report => { delete report.userAgent; }],
    ['missing throttling', report => { delete report.configSettings.throttling; }],
    ['missing metric score', report => { delete report.audits['speed-index'].score; }],
    ['missing metric value', report => { delete report.audits['speed-index'].numericValue; }],
    ['version drift', report => { report.lighthouseVersion = 'different-synthetic-version'; }],
    ['browser drift', report => { report.userAgent = 'HeadlessChrome/131.0.0.0 Synthetic contract fixture'; }],
  ];
  for (const [name, mutate] of cases) await t.test(name, async nested => {
    const { before, after } = await pair(nested);
    await changeReport(after, mutate);
    assert.equal((await verifySite({ before: before.root, after: after.root })).outcome, 'invalid-evidence');
  });
});

test('equivalent fetchTime offsets cannot count as separate site samples', async t => {
  const { before, after } = await pair(t);
  await changeReport(after, report => { report.fetchTime = '2026-10-16T00:10:00.1Z'; });
  await changeReport(after, report => { report.fetchTime = '2026-10-16T08:10:00.100000+08:00'; }, 0, 1);
  assert.equal((await verifySite({ before: before.root, after: after.root })).outcome, 'invalid-evidence');
});
