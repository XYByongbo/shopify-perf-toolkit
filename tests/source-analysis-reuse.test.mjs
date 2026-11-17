import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {mkdtemp, mkdir, realpath, rm, writeFile} from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createSourceAnalysis} from '../lib/core/source-analysis.mjs';
import {auditPerformance} from '../lib/performance-audit.mjs';
import {auditQuality} from '../lib/quality-audit.mjs';
import {scanTheme} from '../lib/scan.mjs';

async function fixture(t) {
  const project = await realpath(await mkdtemp(path.join(tmpdir(), 'perfkit-source-reuse-')));
  t.after(() => rm(project, {recursive:true, force:true}));
  const files = {
    'assets/app.js': 'const privateFixtureValue = 91205;',
    'assets/site.css': '@font-face{font-family:x;src:url(x.woff2)}',
    'assets/hero.png': Buffer.from([0, 1, 2, 3]),
    'sections/hero.liquid': '<img src="hero.png" alt="Hero">',
    'templates/index.json': '{"sections":{"main":{"type":"hero"}}}',
  };
  for (const [relative, body] of Object.entries(files)) {
    const file = path.join(project, relative);
    await mkdir(path.dirname(file), {recursive:true});
    await writeFile(file, body);
  }
  return project;
}

async function countThemeOpens(project, run, beforeOpen) {
  const original = fs.promises.open;
  const counts = new Map();
  fs.promises.open = async (file, ...args) => {
    if (typeof file === 'string' && file.startsWith(project + path.sep)) {
      const relative = path.relative(project, file);
      const count = (counts.get(relative) ?? 0) + 1;
      counts.set(relative, count);
      await beforeOpen?.(relative, count);
    }
    return original(file, ...args);
  };
  syncBuiltinESMExports();
  try { return {result: await run(), counts}; }
  finally { fs.promises.open = original; syncBuiltinESMExports(); }
}

test('quality and performance audits reuse scanned text with the same findings and independent fingerprint reads', async t => {
  const project = await fixture(t);
  const scan = JSON.parse(JSON.stringify(await scanTheme({project})));
  const quality = await countThemeOpens(project, () => auditQuality({project}));
  assert.deepEqual(quality.result, await auditQuality({project, scan}));
  assert.equal(quality.counts.get('assets/app.js'), 2); // inventory and full end verification
  assert.equal(quality.counts.get('assets/hero.png'), 2);
  assert.ok(quality.result.findings.some(finding => finding.ruleId === 'Q-FONT-DISPLAY'));
  const performance = await countThemeOpens(project, () => auditPerformance({project}));
  assert.deepEqual(performance.result, await auditPerformance({project, scan}));
  assert.equal(performance.counts.get('assets/app.js'), 3); // inventory, start and end text snapshots
  assert.equal(performance.counts.get('assets/hero.png'), 1);
  for (const report of [scan, quality.result, performance.result]) {
    assert.doesNotMatch(JSON.stringify(report), /privateFixtureValue/);
  }
});

test('quality audit detects same-size binary edits, added files and removed files even with cached source', async t => {
  const project = await fixture(t);
  const binary = path.join(project, 'assets/hero.png');
  const drift = /Source changed during quality audit/;
  await assert.rejects(countThemeOpens(project, () => auditQuality({project}), async (file, count) => {
    if (file === 'assets/hero.png' && count === 2) await writeFile(binary, Buffer.from([0, 1, 2, 4]));
  }), drift);
  const analysis = createSourceAnalysis();
  const scan = await scanTheme({project, analysis});
  const extra = path.join(project, 'assets/new.woff2');
  await writeFile(extra, Buffer.from([0, 6]));
  await assert.rejects(auditQuality({project, scan, analysis}), drift);
  await rm(extra);
  await rm(binary);
  await assert.rejects(auditQuality({project, scan, analysis}), drift);
});

test('performance audit rejects source edits after its starting snapshot and a stale serialized scan', async t => {
  const project = await fixture(t);
  const scan = JSON.parse(JSON.stringify(await scanTheme({project})));
  const script = path.join(project, 'assets/app.js');
  await assert.rejects(countThemeOpens(project, () => auditPerformance({project}), async (file, count) => {
    if (file === 'assets/app.js' && count === 3) await writeFile(script, 'const privateFixtureValue = 91206;');
  }), /Source drift during intelligence audit/);
  await assert.rejects(auditPerformance({project, scan}), /Source drift between performance scan and snapshot/);
});

test('retained text preserves malformed JSON diagnostics and invalid UTF-8 rejection', async t => {
  const project = await fixture(t);
  await writeFile(path.join(project, 'templates/index.json'), '{"broken":');
  const scan = await scanTheme({project});
  assert.ok(scan.errors.some(error => error.code === 'INVALID_JSON'));
  const direct = await auditQuality({project});
  assert.equal(direct.complete, false);
  assert.deepEqual(direct, await auditQuality({project, scan}));
  await writeFile(path.join(project, 'assets/app.js'), Buffer.from([0x80]));
  await assert.rejects(auditQuality({project}), /Source fingerprint mismatch/);
  await assert.rejects(auditPerformance({project}), /Source fingerprint mismatch/);
});

test('cached text still has to pass the evidence reader’s file path checks', {skip: process.platform === 'win32'}, async t => {
  const project = await fixture(t);
  await writeFile(path.join(project, 'assets/not\\normal.js'), 'const value = 1;');
  await assert.rejects(auditQuality({project}), /Invalid report file path/);
  await assert.rejects(auditPerformance({project}), /Invalid report file path/);
});
