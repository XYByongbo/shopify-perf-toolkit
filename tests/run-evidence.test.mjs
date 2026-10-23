import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, unlink, symlink } from 'node:fs/promises';
import path from 'node:path';
import { readRunEvidence, normalizeEvidenceUrl } from '../lib/run-evidence.mjs';
import { siteRun, saveManifest, changeReport } from './helpers/site-run.mjs';

test('run evidence reads every declared raw report, binds hashes and accepts PSI wrappers', async t => {
  const fixture = await siteRun(t);
  const evidence = await readRunEvidence(fixture.root);
  assert.equal(evidence.complete, true);
  assert.equal(evidence.groups.length, 2);
  assert.equal(evidence.groups[0].records.length, 5);
  assert.match(evidence.manifestHash, /^[a-f0-9]{64}$/);
  assert.match(evidence.groups[0].records[0].sha256, /^[a-f0-9]{64}$/);
  const record = evidence.groups[0].records[0];
  await writeFile(record.file, JSON.stringify({ lighthouseResult: record.report }));
  assert.equal((await readRunEvidence(fixture.root)).groups[0].records[0].report.categories.performance.score, 0.8);
});

test('partial evidence keeps missing runs and invalid report reasons without inventing completion', async t => {
  const fixture = await siteRun(t, { devices: ['mobile'], reports: 2, status: 'failed' });
  await changeReport(fixture, report => { report.runtimeError = { code: 'NO_FCP' }; });
  await assert.rejects(readRunEvidence(fixture.root), /not complete/);
  const evidence = await readRunEvidence(fixture.root, { allowPartial: true });
  assert.equal(evidence.complete, false);
  assert.equal(evidence.groups[0].records.length, 1);
  assert.ok(evidence.issues.some(issue => issue.message.includes('runtimeError')));
  assert.ok(evidence.issues.some(issue => issue.message.includes('count')));
});

test('reports cannot escape their group or follow symlinks', async t => {
  for (const kind of ['traversal', 'file-link', 'directory-link', 'manifest-link']) {
    const fixture = await siteRun(t, { devices: ['mobile'] });
    const group = fixture.manifest.groups[0];
    if (kind === 'traversal') { group.reports[0] = '../outside.json'; await saveManifest(fixture); }
    if (kind === 'file-link') {
      const first = path.join(fixture.root, group.reports[0]);
      await unlink(first); await symlink(path.join(fixture.root, group.reports[1]), first);
    }
    if (kind === 'directory-link') {
      await symlink(path.join(fixture.root, group.reportsDirectory), path.join(fixture.root, 'alias'));
      group.reportsDirectory = 'alias'; group.reports = group.reports.map(file => `alias/${path.basename(file)}`); await saveManifest(fixture);
    }
    if (kind === 'manifest-link') {
      const manifest = path.join(fixture.root, 'run.json');
      await writeFile(path.join(fixture.root, 'saved.json'), JSON.stringify(fixture.manifest));
      await unlink(manifest); await symlink(path.join(fixture.root, 'saved.json'), manifest);
    }
    await assert.rejects(readRunEvidence(fixture.root, { allowPartial: true }), { code: 'UNSAFE_EVIDENCE_PATH' }, kind);
  }
});

test('unlisted extra JSON at any depth cannot silently enter scoring', async t => {
  for (const extra of ['extra.json', 'nested/extra.json', 'EXTRA.JSON']) {
    const fixture = await siteRun(t, { devices: ['mobile'] });
    const file = path.join(fixture.root, fixture.manifest.groups[0].reportsDirectory, extra);
    await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, '{}');
    await assert.rejects(readRunEvidence(fixture.root), /unlisted or missing/);
    assert.equal((await readRunEvidence(fixture.root, { allowPartial: true })).complete, false);
  }
});

test('duplicates, dropped groups and incomplete declared run counts are rejected', async t => {
  for (const mutate of [
    fixture => fixture.manifest.groups.push(fixture.manifest.groups[0]),
    fixture => fixture.manifest.groups.pop(),
    fixture => fixture.manifest.groups[0].reports.push(fixture.manifest.groups[0].reports[0]),
    fixture => { fixture.manifest.config.runs = 6; },
  ]) {
    const fixture = await siteRun(t); mutate(fixture); await saveManifest(fixture);
    await assert.rejects(readRunEvidence(fixture.root));
  }
});

test('raw device, URL and independent run identity must match declared evidence', async t => {
  for (const mutate of [
    report => { report.configSettings.formFactor = 'desktop'; },
    report => { report.finalDisplayedUrl = 'https://shop.example.test/password'; },
    report => { report.requestedUrl = 'https://shop.example.test/other'; },
    report => { report.fetchTime = '2026-10-16T00:01:00Z'; },
    report => { report.categories.performance.score = null; },
  ]) {
    const fixture = await siteRun(t, { devices: ['mobile'] }); await changeReport(fixture, mutate);
    await assert.rejects(readRunEvidence(fixture.root));
  }
  assert.equal(normalizeEvidenceUrl('https://example.test/a?preview_theme_id=1&x=2'), 'https://example.test/a?x=2');
  assert.notEqual(normalizeEvidenceUrl('https://example.test/a?x=1'), normalizeEvidenceUrl('https://example.test/a?x=2'));
});
