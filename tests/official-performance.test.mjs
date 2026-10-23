import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { checkOfficialPerformance, performanceChecks, validateOfficialPerformance } from '../lib/official-performance.mjs';
import { dimensionFor } from '../lib/quality-catalog.mjs';
import { runBatch } from '../lib/batch.mjs';
import { siteRun } from './helpers/site-run.mjs';

async function theme(t) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'perf-official-test-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = path.join(root, 'theme');
  for (const [file, text] of Object.entries({ 'layout/theme.liquid': '{{ content_for_header }}{{ content_for_layout }}',
    'assets/app.js': 'console.log("hello")', 'assets/base.css': 'body{color:black}' })) {
    await mkdir(path.dirname(path.join(project, file)), { recursive: true }); await writeFile(path.join(project, file), text);
  }
  return { root, project };
}
function runner({ missing, onCheck, code, raw = [] } = {}) {
  return async (_, args) => {
    assert.ok(!args.includes('--auto-correct')); assert.ok(!args.includes('--init'));
    if (args[0] === 'version' || args.includes('--version')) return { code: 0, stdout: '4.9.4', stderr: '' };
    if (args.includes('--print')) return { code: 0, stdout: performanceChecks.filter(r => r !== missing).map(r => `${r}:\n  enabled: true\n`).join(''), stderr: '' };
    await onCheck?.(args);
    return { code: code ?? (raw.length ? 1 : 0), stdout: JSON.stringify(raw), stderr: '' };
  };
}
test('performance subset copies JS/CSS, preserves source, records actual versions/config and binds findings', async t => {
  const f = await theme(t);
  const raw = [{ path: 'assets/app.js', offenses: [{ check: 'AssetSizeJavaScript', severity: 'error', start_row: 0, start_column: 0, message: 'fixture budget' }] }];
  const result = await checkOfficialPerformance({ project: f.project, dependencies: { runProcess: runner({ raw, onCheck: async args => {
    const snapshot = args[args.indexOf('--path') + 1];
    assert.equal(await readFile(path.join(snapshot, 'assets/app.js'), 'utf8'), 'console.log("hello")');
    assert.equal(await readFile(path.join(snapshot, 'assets/base.css'), 'utf8'), 'body{color:black}');
  } }) } });
  assert.equal(result.kind, 'check-import'); assert.equal(result.complete, true); assert.equal(result.reviewRequired, true);
  assert.equal(result.findings[0].sourceBinding, 'hash-matched');
  assert.equal(result.findings[0].category, 'performance-candidate');
  assert.equal(result.execution.commands.length, 4);
  assert.match(result.metadata.rulesConfig.requestedConfiguration, /extends: theme-check:nothing/);
  assert.ok(result.enabledChecks.includes('ContentForHeaderModification'));
  assert.equal(await readFile(path.join(f.project, 'assets/app.js'), 'utf8'), 'console.log("hello")');
});
test('empty official result is complete only when every requested rule is enabled', async t => {
  const f = await theme(t);
  const result = await checkOfficialPerformance({ project: f.project, dependencies: { runProcess: runner() } });
  assert.equal(result.reviewRequired, false);
  await assert.rejects(checkOfficialPerformance({ project: f.project, dependencies: { runProcess: runner({ missing: 'AssetSizeCSS' }) } }), /does not enable AssetSizeCSS/);
});
test('checker failure, unexpected rules, snapshot changes and local drift reject success', async t => {
  const f = await theme(t);
  for (const options of [
    { code: 2 }, { code: 1 }, { raw: [{ path: 'assets/app.js', offenses: [{ check: 'UnknownFilter' }] }] },
    { onCheck: async args => writeFile(path.join(args[args.indexOf('--path') + 1], 'assets/app.js'), 'mutated') },
    { onCheck: async () => writeFile(path.join(f.project, 'assets/app.js'), 'drift') },
  ]) {
    await assert.rejects(checkOfficialPerformance({ project: f.project, dependencies: { runProcess: runner(options) } }),
      e => Boolean(e.officialChecks?.commands.length));
  }
});
test('classification includes performance size/deprecation rules without changing maintainability', () => {
  for (const ruleId of ['AssetSizeJavaScript', 'AssetSizeCSS', 'DeprecateLazysizes', 'DeprecateBgsizes', 'PERF_HEAD_RESOURCE_ORDER'])
    assert.equal(dimensionFor({ ruleId }), 'performance', ruleId);
  assert.equal(dimensionFor({ ruleId: 'LiquidComplexity' }), 'architecture');
  for (const c of [null, [], { rules: [] }, { timeoutMs: 0 }]) assert.throws(() => validateOfficialPerformance(c));
});
test('batch retains failed official checker evidence and stops before measurement', async t => {
  const f = await theme(t), run = await siteRun(t, { devices: ['mobile'] });
  const result = await runBatch({ config: { schemaVersion: 1, project: f.project, run: run.root, officialChecks: true, resources: false },
    output: path.join(f.root, 'batch'), dependencies: { checkOfficialPerformance: async () => {
      throw Object.assign(new Error('checker unavailable'), { officialChecks: { commands: [{ exitCode: 2 }] } });
    } } });
  assert.equal(result.status, 'failed');
  assert.equal(result.diagnostics.officialChecks.status, 'failed');
  assert.ok(result.artifacts['official-checks-failure.json']);
});
test('batch passes official evidence to audit and retains its review requirement', async t => {
  const f = await theme(t), run = await siteRun(t, { devices: ['mobile'] });
  const official = await checkOfficialPerformance({ project: f.project, dependencies: { runProcess: runner() } });
  official.reviewRequired = true;
  let passed;
  const result = await runBatch({ config: { schemaVersion: 1, project: f.project, run: run.root, officialChecks: true, resources: false },
    output: path.join(f.root, 'batch'), dependencies: { checkOfficialPerformance: async () => official,
      auditSite: async args => { passed = args.officialChecks; return { schemaVersion: 1, kind: 'site-audit', complete: true, findings: [], supplemental: [] }; } } });
  assert.equal(passed, official); assert.equal(result.reviewRequired, true);
  assert.ok(result.artifacts['official-checks.json']);
});
