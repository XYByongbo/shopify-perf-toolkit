import {fields, validateAt} from './evidence-contract.mjs';
import { access, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { spawn } from 'node:child_process';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { publicAddress } from './public-address.mjs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { createRunDirectory } from './run-directory.mjs';
import path from 'node:path';
import { normalizeLhrUrl as normalizeUrl, validateLhrReport } from './lhr-contract.mjs';
import { validateBudget, createBudget } from './execution-policy.mjs';
import { summarizeRun } from './summary.mjs';
import { validateDeployment } from './deployment.mjs';
import {captureFcpDiagnostics} from './fcp-diagnostics.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const PSI_ENDPOINT = 'https://www.googleapis.com/pagespeedonline/v5/runPagespeed';
const MAX_RESPONSE = 32 * 1024 * 1024;
const MAX_LOG = 256 * 1024;
const fail = (code, message) => Object.assign(new Error(message), { code });
const object = value => value && typeof value === 'object' && !Array.isArray(value);

function publicHostname(url) {
  const hostname = new URL(url).hostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '');
  if (isIP(hostname)) {
    if (!publicAddress(hostname)) throw fail('PSI_PRIVATE_URL', 'PSI requires a publicly routable page URL.');
  } else if (!hostname.includes('.') || /(?:^|\.)(?:localhost|local|internal|lan|home|test|invalid)$/.test(hostname)) {
    throw fail('PSI_PRIVATE_URL', 'PSI cannot measure localhost or private hostnames.');
  }
  return hostname;
}

export function validateMeasureConfig(config) {
  if (!object(config) || config.schemaVersion !== 1) throw fail('INVALID_CONFIG', 'config.schemaVersion must be 1.');
  const allowed = ['schemaVersion', 'engine', 'pages', 'devices', 'runs', 'timeoutMs', 'purpose', 'budget', 'deployment'];
  try { fields(config, allowed, 'measurement config'); }
  catch (error) { throw fail('INVALID_CONFIG', error.message + ' Credentials and headers cannot be supplied in config.'); }
  if (!['lighthouse', 'psi'].includes(config.engine)) throw fail('INVALID_ENGINE', 'engine must be lighthouse or psi.');
  if (!Array.isArray(config.pages) || !config.pages.length) throw fail('INVALID_PAGES', 'pages must be a nonempty array.');
  const ids = new Set();
  const urls = new Set();
  const pages = config.pages.map((page, index) => {
    const at = 'pages[' + index + ']';
    try { fields(page, ['id', 'url'], at); }
    catch (error) { throw fail('INVALID_PAGE_ID', error.message); }
    if (typeof page.id !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(page.id) || ids.has(page.id)) {
      throw fail('INVALID_PAGE_ID', at + '.id must be unique, 1–64 lowercase letters, digits, hyphens or underscores, starting with a letter or digit.');
    }
    const url = validateAt(at+'.url', () => normalizeUrl(page.url));
    if (urls.has(url)) throw fail('DUPLICATE_PAGE', at + '.url must be unique.');
    if (config.engine === 'psi') validateAt(at+'.url', () => publicHostname(url));
    ids.add(page.id); urls.add(url);
    return { id: page.id, url };
  });
  const devices = config.devices ?? ['mobile', 'desktop'];
  if (!Array.isArray(devices) || !devices.length || devices.length > 2 || new Set(devices).size !== devices.length
    || devices.some(device => !['mobile', 'desktop'].includes(device))) throw fail('INVALID_DEVICES', 'devices must contain mobile and/or desktop without duplicates.');
  const purpose = config.purpose ?? 'acceptance';
  if (!['acceptance','exploration'].includes(purpose)) throw fail('INVALID_PURPOSE', 'purpose must be acceptance or exploration.');
  const runs = config.runs ?? (purpose === 'exploration' ? 3 : 5);
  if (!Number.isInteger(runs) || runs < (purpose === 'exploration' ? 1 : 5) || runs > (purpose === 'exploration' ? 4 : 10)) throw fail('INVALID_RUNS', 'runs must be 5–10 for acceptance or 1–4 for exploration.');
  const budget = validateBudget(config.budget);
  const timeoutMs = config.timeoutMs ?? 120000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 180000) throw fail('INVALID_TIMEOUT', 'timeoutMs must be an integer from 1 through 180000.');
  return { schemaVersion: 1, engine: config.engine, pages, devices: [...devices], runs, timeoutMs, purpose, budget,
    ...(config.deployment ? { deployment: validateDeployment(config.deployment) } : {}) };
}

function redactor(secret) {
  const values = secret ? [...new Set([secret, encodeURIComponent(secret)])] : [];
  return text => {
    let safe = String(text);
    for (const value of values) safe = safe.split(value).join('[REDACTED]');
    return safe;
  };
}

async function executableFile(value, label, execute = false) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || /[\x00-\x1f\x7f]/.test(value)) {
    throw fail('ENGINE_UNAVAILABLE', `${label} must be an absolute path to an existing file.`);
  }
  try {
    if (!(await stat(value)).isFile()) throw new Error('not a file');
    await access(value, execute ? constants.X_OK : constants.R_OK);
  } catch { throw fail('ENGINE_UNAVAILABLE', `${label} is unavailable; no engine was installed or substituted.`); }
  return value;
}

async function prepareLighthouse(env) {
  if (process.platform === 'win32') throw fail('ENGINE_UNAVAILABLE', 'Local Lighthouse process-tree cleanup currently requires macOS or Linux; PSI remains a separately selected engine.');
  const cli = await executableFile(env.PERF_KIT_LIGHTHOUSE_CLI ?? path.join(ROOT, 'node_modules/lighthouse/cli/index.js'), 'Lighthouse CLI');
  const { browserExecutable } = await import('./theme-source.mjs');
  const browser = await executableFile(env.PERF_KIT_BROWSER_EXECUTABLE ?? env.CHROME_PATH ?? await browserExecutable(env), 'PERF_KIT_BROWSER_EXECUTABLE or CHROME_PATH', true);
  let version = null;
  try {
    const packageJson = JSON.parse(await readFile(path.resolve(path.dirname(cli), '../package.json'), 'utf8'));
    if (packageJson.name === 'lighthouse' && typeof packageJson.version === 'string') version = packageJson.version;
  } catch { /* An explicit CLI entry can still establish its version in the LHR. */ }
  return { cli, browser, version };
}

function childEnvironment(env, browser, temporary) {
  const result = {};
  for (const key of ['PATH', 'HOME', 'LANG', 'LC_ALL', 'SYSTEMROOT']) if (typeof env[key] === 'string') result[key] = env[key];
  return { ...result, CHROME_PATH: browser, TMPDIR: temporary, TMP: temporary, TEMP: temporary, CI: '1' };
}

async function chromePids(temporary) {
  const pids = [];
  for (const item of await readdir(temporary, { withFileTypes: true }).catch(() => [])) {
    if (!item.isDirectory() || item.isSymbolicLink()) continue;
    const filename = path.join(temporary, item.name, 'chrome.pid');
    try {
      if (!(await lstat(filename)).isFile()) continue;
      const value = Number((await readFile(filename, 'utf8')).trim());
      if (Number.isSafeInteger(value) && value > 1 && value !== process.pid) pids.push(value);
    } catch { /* Launcher may have already removed its temporary profile. */ }
  }
  return pids;
}

async function lighthouseAttempt({ page, device, config, reportPath, engine, env, dependencies, redact }) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'perfkit-lighthouse-'));
  const args = [engine.cli, page.url, '--output=json', `--output-path=${reportPath}`, '--only-categories=performance',
    '--quiet', '--no-enable-error-reporting', '--throttling-method=simulate', '--locale=en-US', '--save-assets',
    `--max-wait-for-load=${Math.min(config.timeoutMs, 45000)}`, '--chrome-flags=--headless --no-first-run --no-default-browser-check',
    ...(device === 'desktop' ? ['--preset=desktop'] : ['--form-factor=mobile'])];
  const invoke = dependencies.spawn ?? spawn;
  const signal = dependencies.kill ?? process.kill.bind(process);
  const grace = dependencies.cleanupGraceMs ?? 1000;
  let stdout = '', stderr = '', timedOut = false, processError = null, child, exitCode = null, exitSignal = null;
  const captured = new Set();
  const cleanupErrors = [];
  const send = (pid, name) => {
    if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid) return;
    try { signal(-pid, name); } catch (error) { if (error.code !== 'ESRCH') cleanupErrors.push(redact(error.message)); }
  };
  const collect = async () => { for (const pid of await chromePids(temporary)) captured.add(pid); };
  try {
    await new Promise(resolve => {
      let settled = false, timer, hardTimer, lastTimer;
      const finish = () => {
        if (settled) return;
        settled = true; clearTimeout(timer); clearTimeout(hardTimer); clearTimeout(lastTimer); resolve();
      };
      try {
        child = invoke(process.execPath, args, { shell: false, detached: true, windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'], cwd: ROOT, env: childEnvironment(env, engine.browser, temporary) });
      } catch (error) { processError = error; finish(); return; }
      child.stdout?.on('data', chunk => { stdout = (stdout + chunk.toString()).slice(0, MAX_LOG); });
      child.stderr?.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(0, MAX_LOG); });
      child.once('error', error => { processError = error; finish(); });
      child.once('close', (code, killedBy) => { exitCode = code; exitSignal = killedBy; finish(); });
      timer = setTimeout(async () => {
        if (settled) return;
        timedOut = true;
        await collect();
        if (settled) return;
        send(child.pid, 'SIGTERM');
        for (const pid of captured) send(pid, 'SIGTERM');
        if (settled) return;
        hardTimer = setTimeout(async () => {
          await collect();
          if (settled) return;
          send(child.pid, 'SIGKILL');
          for (const pid of captured) send(pid, 'SIGKILL');
          if (settled) return;
          lastTimer = setTimeout(finish, grace);
        }, grace);
      }, config.timeoutMs);
    });
  } finally {
    await collect();
    for (const pid of captured) send(pid, 'SIGKILL');
    await rm(temporary, { recursive: true, force: true });
  }
  return { transport: { exitCode, exitSignal, timedOut, stdout: redact(stdout), stderr: redact(stderr), cleanupErrors },
    error: timedOut ? fail('MEASUREMENT_TIMEOUT', 'Lighthouse exceeded timeoutMs; its process and owned Chrome process groups were terminated.')
      : processError ? fail('LIGHTHOUSE_PROCESS_ERROR', redact(processError.message))
        : exitCode !== 0 ? fail('LIGHTHOUSE_EXIT', `Lighthouse exited unsuccessfully (${exitCode ?? exitSignal ?? 'unknown'}).`)
          : cleanupErrors.length ? fail('PROCESS_CLEANUP_FAILED', 'The owned browser process groups could not be fully cleaned up.') : null };
}

async function publicDns(url, lookupImpl) {
  const hostname = publicHostname(url);
  const addresses = isIP(hostname) ? [{ address: hostname }] : await lookupImpl(hostname, { all: true, verbatim: true });
  if (!Array.isArray(addresses) || !addresses.length || addresses.some(item => !publicAddress(item.address))) {
    throw fail('PSI_PRIVATE_URL', 'All addresses of a PSI page hostname must be publicly routable.');
  }
}

async function responseBody(response) {
  if (Number(response.headers?.get?.('content-length')) > MAX_RESPONSE) throw fail('PSI_RESPONSE_TOO_LARGE', 'PSI response exceeded the 32 MiB limit.');
  if (!response.body?.getReader) {
    const text = await response.text();
    if (Buffer.byteLength(text) > MAX_RESPONSE) throw fail('PSI_RESPONSE_TOO_LARGE', 'PSI response exceeded the 32 MiB limit.');
    return text;
  }
  const reader = response.body.getReader();
  const chunks = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE) { await reader.cancel(); throw fail('PSI_RESPONSE_TOO_LARGE', 'PSI response exceeded the 32 MiB limit.'); }
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks).toString('utf8');
}

async function psiAttempt({ page, device, config, env, dependencies, redact }) {
  const controller = new AbortController();
  let timer;
  const result = { transport: { endpoint: PSI_ENDPOINT, status: null }, responseText: null, report: null, error: null };
  const action = async () => {
    await publicDns(page.url, dependencies.lookup ?? lookup);
    if (controller.signal.aborted) throw fail('MEASUREMENT_TIMEOUT', 'PSI exceeded timeoutMs.');
    const request = new URL(PSI_ENDPOINT);
    request.searchParams.set('url', page.url);
    request.searchParams.set('strategy', device);
    request.searchParams.set('category', 'performance');
    if (env.PERF_KIT_PSI_API_KEY) request.searchParams.set('key', env.PERF_KIT_PSI_API_KEY);
    const response = await (dependencies.fetch ?? globalThis.fetch)(request.href,
      { method: 'GET', redirect: 'error', credentials: 'omit', headers: { Accept: 'application/json' }, signal: controller.signal });
    result.transport.status = response.status;
    result.responseText = redact(await responseBody(response));
    if (!response.ok) throw fail('PSI_HTTP_ERROR', `PSI returned HTTP ${response.status}; the sanitized response was retained.`);
    let payload;
    try { payload = JSON.parse(result.responseText); } catch { throw fail('PSI_INVALID_JSON', 'PSI returned invalid JSON; the sanitized response was retained.'); }
    if (!object(payload.lighthouseResult)) throw fail('PSI_MISSING_LHR', 'PSI did not return a Lighthouse result.');
    result.report = payload.lighthouseResult;
  };
  try {
    await Promise.race([action(), new Promise((resolve, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(fail('MEASUREMENT_TIMEOUT', 'PSI exceeded timeoutMs; its request was aborted.')); }, config.timeoutMs);
    })]);
  } catch (error) { result.error = error; } finally { clearTimeout(timer); }
  return result;
}

function validateReport(report, page, device, locks) {
  const evidence = validateLhrReport(report, { url: page.url, device });
  if (locks.version && locks.version !== report.lighthouseVersion) throw fail('VERSION_DRIFT', 'Lighthouse version changed within the measurement run.');
  if (locks.fetchTimes.has(evidence.timestampKey)) throw fail('DUPLICATE_FETCH_TIME', 'Duplicate fetchTime: a previous report cannot count as another independent run.');
  if (locks.devices.has(device) && locks.devices.get(device).sha256 !== evidence.profileSha256) throw fail('PROFILE_DRIFT', 'Browser or Lighthouse settings changed for the selected device.');
  locks.version = report.lighthouseVersion;
  locks.fetchTimes.add(evidence.timestampKey);
  locks.devices.set(device, { sha256: evidence.profileSha256, ...evidence.profile, reviewReasons: evidence.reviewReasons });
  const { timestampKey, profile, ...publicEvidence } = evidence;
  return publicEvidence;
}

/** Dependencies inject only transport/process primitives for isolated contract tests. */
export async function measureSite({ config: input, output: requestedOutput, onProgress = () => {}, dependencies = {} } = {}) {
  const config = validateMeasureConfig(input);
  if (typeof onProgress !== 'function') throw fail('INVALID_PROGRESS', 'onProgress must be a function.');
  const budget = createBudget(config.budget, { now: dependencies.now });
  const env = dependencies.env ?? process.env;
  const redact = redactor(env.PERF_KIT_PSI_API_KEY);
  const output = await createRunDirectory(requestedOutput);
  const manifest = { schemaVersion: 1, kind: 'site-measurement', engine: config.engine, status: 'running',
    startedAt: new Date().toISOString(), finishedAt: null, config,
    environment: { nodeVersion: process.version, platform: process.platform, architecture: process.arch,
      lighthouseVersion: null, profiles: {}, apiKeyConfigured: config.engine === 'psi' && Boolean(env.PERF_KIT_PSI_API_KEY) },
    counts: { planned: config.pages.length * config.devices.length * config.runs, attempted: 0, succeeded: 0, failed: 0 },
    groups: config.pages.flatMap(page => config.devices.map(device => ({ pageId: page.id, url: page.url, device,
      status: 'pending', reportsDirectory: `groups/${page.id}/${device}/lhr`, reports: [], validReports: [], attempts: [] }))),
    limitations: ['Navigation laboratory measurements, not real-user INP or field CWV.',
      'Lighthouse executes the requested page and its own network activity in a fresh browser profile; no login, form actions or supplied credentials are added.',
      'PSI runs remotely and may use infrastructure that differs from local Lighthouse; engines are never substituted.',
      'Original report warnings are retained. A complete run means valid samples were collected, not that performance passed a release gate.'],
    budget: { limits: budget.limits, modelMeter: budget.modelMeter }, errors: [], progressWarnings: [] };
  const save = async () => {
    const temporary = path.join(output, '.run.json.tmp');
    await writeFile(temporary, redact(JSON.stringify(manifest, null, 2)) + '\n', { flag: 'wx', mode: 0o600 });
    await rename(temporary, path.join(output, 'run.json'));
  };
  const emit = async event => {
    try { await onProgress(JSON.parse(redact(JSON.stringify({ engine: config.engine, ...event })))); }
    catch (error) { manifest.progressWarnings.push({ code: 'PROGRESS_CALLBACK', message: redact(error.message) }); }
  };
  const errorRecord = error => ({ code: error.code ?? 'MEASUREMENT_ERROR', message: redact(error.message ?? String(error)) });
  await save();
  let engine = null;
  const locks = { version: null, devices: new Map(), fetchTimes: new Set() };
  try {
    if (config.deployment) {
      const { verifyDeployment } = await import('./deployment.mjs');
      if (budget.remainingMs() < config.deployment.timeoutMs) throw fail('WALL_TIME_BUDGET', 'Insufficient time for candidate identity check.');
      manifest.deployment = { before: await (dependencies.verifyDeployment ?? verifyDeployment)({ config: config.deployment, pages: config.pages }) };
      await save();
      if (manifest.deployment.before.status !== 'verified') throw fail('DEPLOYMENT_UNVERIFIED', 'Candidate identity was not verified; no Lighthouse samples were collected.');
    }
    if (config.engine === 'lighthouse') {
      engine = await prepareLighthouse(env);
      locks.version = engine.version;
      Object.assign(manifest.environment, { lighthouseCli: engine.cli, browserExecutable: engine.browser, expectedLighthouseVersion: engine.version });
    }
    measurement: for (const group of manifest.groups) {
      const page = config.pages.find(item => item.id === group.pageId);
      const base = `groups/${page.id}/${group.device}`;
      await mkdir(path.join(output, group.reportsDirectory), { recursive: true, mode: 0o700 });
      await mkdir(path.join(output, base, 'attempts'), { mode: 0o700 });
      group.status = 'running';
      await save();
      for (let index = 1; index <= config.runs; index += 1) {
        const reason = await budget.check({ attempts: manifest.counts.attempted, failures: manifest.counts.failed, reserveMs: config.timeoutMs + 3000 });
        if (reason) {
          manifest.stopped = { reason, elapsedMs: Math.round(budget.elapsedMs()), unattempted: manifest.counts.planned - manifest.counts.attempted };
          break measurement;
        }
        const tag = `run-${String(index).padStart(2, '0')}`;
        const reportFile = `${group.reportsDirectory}/${tag}.json`;
        const reportPath = path.join(output, reportFile);
        const attemptFile = `${base}/attempts/${tag}.json`;
        const attempt = { index, pageId: page.id, device: group.device, engine: config.engine, status: 'running',
          startedAt: new Date().toISOString(), finishedAt: null, durationMs: null, report: null, error: null };
        const started = performance.now();
        manifest.counts.attempted += 1;
        await emit({ event: 'attempt-start', pageId: page.id, device: group.device, index, runs: config.runs, completed: manifest.counts.succeeded + manifest.counts.failed, total: manifest.counts.planned });
        try {
          const result = config.engine === 'lighthouse'
            ? await lighthouseAttempt({ page, device: group.device, config, reportPath, engine, env, dependencies, redact })
            : await psiAttempt({ page, device: group.device, config, env, dependencies, redact });
          attempt.transport = result.transport;
          if(config.engine==='lighthouse')attempt.diagnostics=await captureFcpDiagnostics({root:output,reportRelative:reportFile,diagnosticsRelative:`${base}/diagnostics/${tag}`});
          let report;
          if (config.engine === 'psi') {
            if (result.responseText !== null) {
              attempt.response = `${base}/attempts/${tag}.response.txt`;
              await writeFile(path.join(output, attempt.response), result.responseText, { flag: 'wx', mode: 0o600 });
            }
            if (result.report) await writeFile(reportPath, redact(JSON.stringify(result.report, null, 2)) + '\n', { flag: 'wx', mode: 0o600 });
          }
          try {
            const info = await lstat(reportPath);
            if (!info.isFile() || info.isSymbolicLink()) throw fail('UNSAFE_REPORT', 'The engine output must be a regular report file.');
            if (info.size > MAX_RESPONSE) throw fail('REPORT_TOO_LARGE', 'The Lighthouse report exceeded the 32 MiB limit.');
            const raw = await readFile(reportPath, 'utf8');
            const safe = redact(raw);
            if (raw !== safe) { await writeFile(reportPath, safe, { mode: 0o600 }); attempt.secretsRedacted = true; }
            group.reports.push(reportFile); attempt.report = reportFile;
            attempt.sha256 = createHash('sha256').update(safe).digest('hex');
            try { report = JSON.parse(safe); } catch { throw fail('INVALID_LHR_JSON', 'The raw Lighthouse output is not valid JSON.'); }
          } catch (error) {
            if (error.code !== 'ENOENT') throw error;
            if (!result.error) throw fail('MISSING_LHR', 'The selected engine did not produce a report.');
          }
          if (result.error) throw result.error;
          Object.assign(attempt, validateReport(report, page, group.device, locks));
          group.validReports.push(reportFile);
          manifest.counts.succeeded += 1;
          attempt.status = 'complete';
        } catch (error) {
          attempt.status = 'failed'; attempt.error = errorRecord(error); manifest.counts.failed += 1;
        }
        attempt.finishedAt = new Date().toISOString(); attempt.durationMs = Math.round(performance.now() - started);
        await writeFile(path.join(output, attemptFile), redact(JSON.stringify(attempt, null, 2)) + '\n', { flag: 'wx', mode: 0o600 });
        group.attempts.push({ index, status: attempt.status, file: attemptFile, report: attempt.report, error: attempt.error,
          ...(attempt.diagnostics?{diagnostics:attempt.diagnostics}:{}) });
        manifest.environment.lighthouseVersion = locks.version;
        manifest.environment.profiles = Object.fromEntries(locks.devices);
        await save();
        await emit({ event: 'attempt-end', pageId: page.id, device: group.device, index, runs: config.runs, status: attempt.status,
          error: attempt.error, completed: manifest.counts.succeeded + manifest.counts.failed, total: manifest.counts.planned });
      }
      group.status = group.validReports.length === config.runs && group.attempts.every(attempt => attempt.status === 'complete') ? 'complete' : 'failed';
      await save();
    }
    if (manifest.stopped) {
      manifest.status = 'stopped';
      for (const group of manifest.groups) if (['pending','running'].includes(group.status)) group.status = 'stopped';
    } else manifest.status = manifest.counts.succeeded === manifest.counts.planned && manifest.counts.failed === 0 ? 'complete' : 'failed';
    if (config.deployment && manifest.status === 'complete') {
      const { verifyDeployment } = await import('./deployment.mjs');
      if (budget.remainingMs() < config.deployment.timeoutMs) throw fail('WALL_TIME_BUDGET', 'Insufficient time for final candidate identity check.');
      manifest.deployment.after = await (dependencies.verifyDeployment ?? verifyDeployment)({ config: config.deployment, pages: config.pages });
      if (manifest.deployment.after.status !== 'verified' || manifest.deployment.before.sourceHash !== manifest.deployment.after.sourceHash) throw fail('DEPLOYMENT_UNVERIFIED', 'Candidate identity changed or was not verified after measurement.');
    }
  } catch (error) {
    manifest.errors.push(errorRecord(error)); manifest.status = 'failed';
    for (const group of manifest.groups) if (['pending', 'running'].includes(group.status)) group.status = 'failed';
  }
  manifest.finishedAt = new Date().toISOString();
  await emit({ event: 'run-end', status: manifest.status, counts: { ...manifest.counts } });
  manifest.budget.elapsedMs = Math.round(budget.elapsedMs());
  await save();
  try {
    await writeFile(path.join(output, 'summary.json'), JSON.stringify(await summarizeRun(output), null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  } catch (error) {
    await writeFile(path.join(output, 'summary.json'), JSON.stringify({ kind: 'measurement-summary', status: manifest.status, counts: manifest.counts, stopped: manifest.stopped ?? null, summaryError: errorRecord(error), acceptance: 'not-evaluated', rawManifest: 'run.json' }) + '\n', { flag: 'wx', mode: 0o600 });
  }
  return JSON.parse(redact(JSON.stringify(manifest)));
}

export { createRunDirectory, publicAddress };
