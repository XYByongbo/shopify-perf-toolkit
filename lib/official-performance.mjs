import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { scanTheme } from './scan.mjs';
import { readThemeSource, importCheck } from './check-import.mjs';
import { runProcess } from './bounded-process.mjs';
import { assertPrecheckOutput } from './precheck.mjs';

// Separate from the two-rule maintainability precheck. Defaults come from the
// installed checker and are captured in its effective configuration.
export const performanceChecks = [
  'AssetSizeJavaScript', 'AssetSizeCSS', 'ParserBlockingScript',
  'ImgWidthAndHeight', 'RemoteAsset', 'AssetPreload', 'CdnPreconnect',
  'PaginationSize', 'DeprecateLazysizes', 'DeprecateBgsizes',
  'ContentForHeaderModification',
];
export function validateOfficialPerformance(config = {}) {
  if (!config || Array.isArray(config) || typeof config !== 'object'
    || Object.keys(config).some(k => !['timeoutMs'].includes(k))) throw new Error('officialChecks accepts timeoutMs only.');
  const timeoutMs = config.timeoutMs ?? 120000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 600000) throw new Error('Invalid officialChecks timeoutMs.');
  return { timeoutMs };
}

export async function checkOfficialPerformance({ project, config = {}, dependencies = {} } = {}) {
  const { timeoutMs } = validateOfficialPerformance(config), started = Date.now();
  const scan = await scanTheme({ project });
  const selected = scan.inventory.files.filter(f => /\.(liquid|json|css|m?js)$/i.test(f.path));
  if (!selected.length) throw new Error('No supported theme source files.');
  await assertPrecheckOutput(scan.project, path.join(tmpdir(), 'perfkit-official-probe'));
  const staging = await mkdtemp(path.join(tmpdir(), 'perfkit-official-'));
  const snapshot = path.join(staging, 'theme'), configPath = path.join(staging, 'checks.yml');
  const requested = 'extends: theme-check:nothing\n' + performanceChecks.map(rule => `${rule}:\n  enabled: true\n`).join('');
  const commands = [], cli = process.env.PERF_KIT_SHOPIFY_CLI || 'shopify';
  const manifest = scan.inventory.files.map(f => ({ file: f.path, sourceHash: f.sha256 }));
  let effective, cliVersion, checkerVersion, raw;
  const execute = async args => {
    const remaining = timeoutMs - (Date.now() - started);
    if (remaining < 1) throw Object.assign(new Error('Official checks deadline reached.'), { code: 'WALL_TIME_BUDGET' });
    const result = await (dependencies.runProcess ?? runProcess)(cli, args, {
      cwd: staging, timeoutMs: remaining,
      env: { CI: '1', SHOPIFY_CLI_NO_ANALYTICS: '1', SHOPIFY_FLAG_AUTO_CORRECT: 'false', SHOPIFY_FLAG_INIT: 'false', SHOPIFY_FLAG_ENVIRONMENT: '' },
    });
    commands.push({ args, exitCode: result.code, stdout: result.stdout, stderr: result.stderr });
    return result;
  };
  try {
    await mkdir(snapshot);
    for (const file of selected) {
      const { source } = await readThemeSource(scan.project, file.path, file.sha256);
      await mkdir(path.dirname(path.join(snapshot, file.path)), { recursive: true });
      await writeFile(path.join(snapshot, file.path), source, { flag: 'wx' });
    }
    await writeFile(configPath, requested, { flag: 'wx' });
    const base = ['theme', 'check', '--path', snapshot, '--config', configPath, '--no-color', '--no-input'];
    const cliResult = await execute(['version']), checker = await execute([...base, '--version']);
    if (cliResult.code || checker.code || !/\d+\.\d+\.\d+/.test(cliResult.stdout) || !/\d+\.\d+\.\d+/.test(checker.stdout)) throw new Error('Shopify CLI / Theme Check version unavailable.');
    cliVersion = cliResult.stdout.trim(); checkerVersion = checker.stdout.trim();
    const printed = await execute([...base, '--print']);
    if (printed.code) throw new Error('Cannot read effective official performance configuration.');
    effective = printed.stdout;
    for (const rule of performanceChecks) {
      const block = effective.match(new RegExp(`^${rule}:\\n((?:[ \\t]+[^\\n]*\\n?)+)`, 'm'))?.[1] ?? '';
      if (!/enabled: true(?:\s|$)/.test(block)) throw new Error(`Installed Theme Check does not enable ${rule}.`);
    }
    const checked = await execute([...base, '--output', 'json', '--fail-level', 'warning']);
    if (![0, 1].includes(checked.code)) throw new Error('Official performance checker failed.');
    raw = JSON.parse(checked.stdout);
    if (!Array.isArray(raw) || raw.some(g => !Array.isArray(g.offenses) || g.offenses.some(o => !performanceChecks.includes(o.check)))) throw new Error('Unexpected official performance scope or output.');
    if (checked.code === 1 && !raw.some(g => g.offenses.length)) throw new Error('Checker failed without diagnostics.');
    for (const file of selected) {
      const sha = createHash('sha256').update(await readFile(path.join(snapshot, file.path))).digest('hex');
      if (sha !== file.sha256) throw new Error('Checker changed the temporary snapshot.');
    }
    const end = await scanTheme({ project: scan.project });
    if (JSON.stringify(manifest) !== JSON.stringify(end.inventory.files.map(f => ({ file: f.path, sourceHash: f.sha256 })))) throw new Error('Theme source changed during official checks.');
    const report = await importCheck({ project: scan.project, input: raw, metadata: {
      tool: 'Shopify Theme Check', toolVersion: checkerVersion, cliVersion, sourceRoot: snapshot,
      positionBase: 0, severityMap: { 0: 'error', 1: 'warning', 2: 'info' },
      scope: 'official-performance-frozen-text-snapshot-v1', scannedFiles: selected.map(f => f.path),
      sourceHashes: Object.fromEntries(selected.map(f => [f.path, f.sha256])),
      rulesConfig: { requestedConfiguration: requested, effectiveConfiguration: effective.replace(/^rootUri:.*$/m, 'rootUri: <snapshot>') },
      complete: scan.complete,
    } });
    return { ...report, enabledChecks: performanceChecks, reviewRequired: !report.complete || report.findings.length > 0,
      execution: { cliVersion, checkerVersion, commands },
      limitations: [...(report.limitations ?? []), 'Official performance subset only, not all Theme Check rules. Project ignores/config are not inherited. Inline suppressions retain official semantics; absence of offenses is not runtime performance proof.'] };
  } catch (error) {
    error.officialChecks = { kind: 'official-performance-failure', commands, requestedConfiguration: requested, cliVersion, checkerVersion };
    throw error;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
