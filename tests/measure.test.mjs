import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { measureSite, validateMeasureConfig } from '../lib/measure.mjs';
import { canonicalFetchTime } from '../lib/lhr-contract.mjs';

const base = { schemaVersion: 1, engine: 'lighthouse', pages: [{ id: 'home', url: 'https://example.com/' }], devices: ['mobile'], runs: 5, timeoutMs: 5000 };
const auditIds = ['first-contentful-paint', 'largest-contentful-paint', 'speed-index', 'total-blocking-time', 'cumulative-layout-shift'];
function lhr(url, device, index) {
  return { requestedUrl: url, finalDisplayedUrl: url, finalUrl: url, lighthouseVersion: '13.5.0',
    fetchTime: new Date(Date.UTC(2026, 9, 16, 0, 0, index)).toISOString(), gatherMode: 'navigation',
    configSettings: { formFactor: device, throttlingMethod: 'simulate', onlyCategories: ['performance'],
      throttling: { rttMs: 150, throughputKbps: 1638.4, cpuSlowdownMultiplier: 4 } },
    environment: { hostUserAgent: 'Chrome/134.0 Synthetic contract fixture' }, userAgent: 'Chrome/134.0 Synthetic contract fixture',
    categories: { performance: { score: 0.95 } }, runWarnings: ['Synthetic report: not a store measurement.'],
    audits: Object.fromEntries(auditIds.map(id => [id, { numericValue: id === 'cumulative-layout-shift' ? 0 : 100, score: 0.95, scoreDisplayMode: 'numeric' }])) };
}
async function fixture(t) {
  const temp = await realpath(await mkdtemp(path.join(os.tmpdir(), 'perfkit-measure-test-')));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const cli = path.join(temp, 'lighthouse/cli/index.js');
  await mkdir(path.dirname(cli), { recursive: true });
  await writeFile(cli, '// This file is never executed by the transport mock.');
  await writeFile(path.join(temp, 'lighthouse/package.json'), JSON.stringify({ name: 'lighthouse', version: '13.5.0' }));
  const env = { PATH: process.env.PATH, PERF_KIT_LIGHTHOUSE_CLI: cli, CHROME_PATH: process.execPath,
    PERF_KIT_PSI_API_KEY: 'synthetic-secret-should-not-be-written', AWS_SECRET_ACCESS_KEY: 'must-not-be-forwarded', NODE_OPTIONS: '--inspect' };
  return { temp, env, output: path.join(temp, 'run') };
}
function mockLighthouse(transform = report => report) {
  const calls = []; let active = 0, peak = 0;
  const spawn = (command, args, options) => {
    active += 1; peak = Math.max(peak, active);
    const index = calls.length + 1;
    calls.push({ command, args, options });
    const child = new EventEmitter();
    child.pid = 50000 + index;
    child.stdout = new PassThrough(); child.stderr = new PassThrough();
    setImmediate(async () => {
      try {
        const file = args.find(value => value.startsWith('--output-path=')).slice('--output-path='.length);
        const report = await transform(lhr(args[1], args.includes('--preset=desktop') ? 'desktop' : 'mobile', index), index, { child, file, options });
        if (report !== null) await writeFile(file, typeof report === 'string' ? report : JSON.stringify(report));
        active -= 1; child.emit('close', 0, null);
      } catch (error) { active -= 1; child.emit('error', error); }
    });
    return child;
  };
  return { spawn, calls, peak: () => peak };
}
const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }];
const response = (body, status = 200) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

test('fetchTime requires a real calendar and explicit timezone while preserving microsecond identity', () => {
  for (const value of ['not-a-date', '2026-02-30T00:00:00Z', '2025-02-29T00:00:00Z', '0000-01-01T00:00:00Z',
    '2026-10-16T24:00:00Z', '2026-10-16T00:60:00Z', '2026-10-16T00:00:60Z', '2026-10-16T00:00:00',
    '2026-10-16 00:00:00Z', '2026-10-16T00:00:00+24:00', '2026-10-16T00:00:00+08:60',
    '2026-10-16T00:00:00.1234567Z', '2026-10-16T00:00:00z']) {
    assert.throws(() => canonicalFetchTime(value), { code: 'MISSING_FETCH_TIME' });
  }
  assert.equal(canonicalFetchTime('2024-02-29T00:00:00Z'), '2024-02-29T00:00:00.000000Z');
  assert.equal(canonicalFetchTime('2026-10-16T08:00:00.1+08:00'), canonicalFetchTime('2026-10-16T00:00:00.100000Z'));
  assert.equal(canonicalFetchTime('2026-10-15T19:00:00-05:00'), canonicalFetchTime('2026-10-16T00:00:00Z'));
  assert.notEqual(canonicalFetchTime('2026-10-16T00:00:00.000001Z'), canonicalFetchTime('2026-10-16T00:00:00.000002Z'));
});

test('measurement rejects normalized impossible dates and offset-disguised duplicate samples', async t => {
  for (const duplicate of [false, true]) await t.test(duplicate ? 'equivalent instants' : 'impossible calendar date', async nested => {
    const setup = await fixture(nested);
    const transport = mockLighthouse((report, index) => ({ ...report, fetchTime: duplicate
      ? (index === 1 ? '2026-10-16T00:00:00.1Z' : '2026-10-16T08:00:00.100000+08:00')
      : '2026-02-30T00:00:00Z' }));
    const result = await measureSite({ config: base, output: setup.output, dependencies: { env: setup.env, spawn: transport.spawn } });
    assert.equal(result.status, 'failed');
    assert.equal(result.counts.succeeded, duplicate ? 1 : 0);
    assert.equal(result.groups[0].reports.length, 5);
    assert.ok(result.groups[0].attempts.filter(attempt => attempt.error).every(attempt => attempt.error.code === (duplicate ? 'DUPLICATE_FETCH_TIME' : 'MISSING_FETCH_TIME')));
  });
});

test('config rejects unsafe IDs, URLs, credentials, duplicate matrices, and invalid run limits', () => {
  assert.equal(validateMeasureConfig({ ...base, runs: undefined }).runs, 5);
  assert.deepEqual(validateMeasureConfig({ ...base, devices: undefined }).devices, ['mobile', 'desktop']);
  for (const config of [
    { ...base, schemaVersion: 2 }, { ...base, engine: 'auto' }, { ...base, apiKey: 'secret' }, { ...base, pages: [] },
    ...['../home', '/home', 'Home', '.hidden', 'home/child', 'x'.repeat(65)].map(id => ({ ...base, pages: [{ id, url: base.pages[0].url }] })),
    ...['file:///tmp/a', 'https://u:p@example.com/', 'https://example.com/#login', ' https://example.com/', 'https://example.com/\n', 'https:\\example.com/'].map(url => ({ ...base, pages: [{ id: 'home', url }] })),
    { ...base, pages: [base.pages[0], base.pages[0]] }, { ...base, pages: [base.pages[0], { id: 'another', url: base.pages[0].url }] },
    { ...base, pages: [{ ...base.pages[0], headers: { Authorization: 'secret' } }] },
    ...[0, 4, 11, 5.5, '5'].map(runs => ({ ...base, runs })), ...[0, 180001, NaN].map(timeoutMs => ({ ...base, timeoutMs })),
    ...[[], ['mobile', 'mobile'], ['tablet']].map(devices => ({ ...base, devices })),
  ]) assert.throws(() => validateMeasureConfig(config));
});

test('PSI blocks literal loopback, private, reserved and local hostnames before any request', () => {
  for (const host of ['localhost', 'a.localhost', 'device.local', 'intranet', '127.0.0.1', '2130706433', '10.0.0.1', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '[::1]', '[::ffff:127.0.0.1]', '[fc00::1]', '[fe80::1]', '[2001:db8::1]']) {
    assert.throws(() => validateMeasureConfig({ ...base, engine: 'psi', pages: [{ id: 'home', url: `http://${host}/` }] }), { code: 'PSI_PRIVATE_URL' });
  }
});

test('Lighthouse matrix is serial, fixed engine, records every original report and locks environment', async t => {
  const setup = await fixture(t);
  const transport = mockLighthouse();
  const events = [];
  const config = { ...base, pages: [...base.pages, { id: 'product', url: 'https://example.com/products/a?preview_theme_id=123' }], devices: ['mobile', 'desktop'] };
  const result = await measureSite({ config, output: setup.output, onProgress: event => events.push(event), dependencies: { env: setup.env, spawn: transport.spawn } });
  assert.equal(result.kind, 'site-measurement');
  assert.equal(result.status, 'complete');
  assert.deepEqual(result.counts, { planned: 20, attempted: 20, succeeded: 20, failed: 0 });
  assert.equal(transport.peak(), 1);
  assert.equal(transport.calls.length, 20);
  assert.equal(events.filter(event => event.event === 'attempt-start').length, 20);
  assert.equal(events.at(-1).event, 'run-end');
  assert.equal(result.environment.lighthouseVersion, '13.5.0');
  assert.deepEqual(Object.keys(result.environment.profiles).sort(), ['desktop', 'mobile']);
  for (const call of transport.calls) {
    assert.equal(call.command, process.execPath);
    assert.equal(call.options.shell, false);
    assert.equal(call.options.detached, true);
    assert.equal(call.options.env.CHROME_PATH, process.execPath);
    assert.equal(call.options.env.PERF_KIT_PSI_API_KEY, undefined);
    assert.equal(call.options.env.AWS_SECRET_ACCESS_KEY, undefined);
    assert.equal(call.options.env.NODE_OPTIONS, undefined);
    assert.ok(call.args.includes('--no-enable-error-reporting'));
    assert.ok(call.args.includes('--throttling-method=simulate'));
    assert.ok(call.args.includes('--save-assets'));
  }
  for (const group of result.groups) {
    assert.equal(group.status, 'complete'); assert.equal(group.reports.length, 5); assert.equal(group.validReports.length, 5);
    assert.equal(group.reportsDirectory, `groups/${group.pageId}/${group.device}/lhr`);
    const report = JSON.parse(await readFile(path.join(setup.output, group.reports[0]), 'utf8'));
    assert.deepEqual(report.runWarnings, ['Synthetic report: not a store measurement.']);
  }
  assert.deepEqual(JSON.parse(await readFile(path.join(setup.output, 'run.json'), 'utf8')), result);
});

test('explicit DevTools throttling is passed through and checked against the saved sample', async t => {
  const setup = await fixture(t);
  const config = {...base,throttlingMethod:'devtools',purpose:'exploration',runs:1};
  assert.throws(()=>validateMeasureConfig({...config,engine:'psi'}),/local Lighthouse only/);
  const dependencies = {env:setup.env};
  const transport = mockLighthouse(report => {
    Object.assign(report.configSettings,{throttlingMethod:'devtools',throttling:{
      requestLatencyMs:150,downloadThroughputKbps:1600,uploadThroughputKbps:750,cpuSlowdownMultiplier:4,
    }});
    return report;
  });
  const result = await measureSite({config,output:setup.output,dependencies:{...dependencies,spawn:transport.spawn}});
  assert.equal(result.status,'complete');
  assert.equal(result.config.throttlingMethod,'devtools');
  assert.ok(transport.calls[0].args.includes('--throttling-method=devtools'));
  const different = await measureSite({config,output:setup.output+'-mismatch',dependencies:{...dependencies,spawn:mockLighthouse().spawn}});
  assert.equal(different.groups[0].attempts[0].error.code,'PROFILE_DRIFT');
  assert.equal(different.counts.succeeded,0);
});

test('every invalid report remains evidence and prevents complete status', async t => {
  const cases = [
    ['DUPLICATE_FETCH_TIME', report => ({ ...report, fetchTime: lhr(report.requestedUrl, 'mobile', 1).fetchTime })],
    ['WRONG_URL', report => ({ ...report, requestedUrl: 'https://example.com/other' })],
    ['WRONG_URL', report => ({ ...report, finalDisplayedUrl: 'https://example.com/password' })],
    ['WRONG_DEVICE', report => ({ ...report, configSettings: { ...report.configSettings, formFactor: 'desktop' } })],
    ['LHR_RUNTIME_ERROR', report => ({ ...report, runtimeError: { code: 'NO_FCP' } })],
    ['MISSING_SCORE', report => ({ ...report, categories: { performance: { score: null } } })],
    ['MISSING_METRIC', report => ({ ...report, audits: { ...report.audits, 'speed-index': { numericValue: 200 } } })],
    ['VERSION_DRIFT', report => ({ ...report, lighthouseVersion: '13.6.0' })],
    ['PROFILE_DRIFT', report => ({ ...report, configSettings: { ...report.configSettings, locale: 'changed' } })],
    ['MISSING_FETCH_TIME', report => ({ ...report, fetchTime: '' })],
    ['INVALID_LHR_JSON', () => '{invalid raw report'],
  ];
  for (const [code, change] of cases) await t.test(code, async nested => {
    const setup = await fixture(nested);
    const transport = mockLighthouse((report, index) => index === 2 ? change(report) : report);
    const result = await measureSite({ config: base, output: setup.output, dependencies: { env: setup.env, spawn: transport.spawn } });
    assert.equal(result.status, 'failed');
    assert.equal(result.groups[0].status, 'failed');
    assert.equal(result.counts.failed, 1);
    assert.equal(result.counts.attempted, 5);
    assert.equal(result.groups[0].reports.length, 5);
    assert.equal(result.groups[0].attempts[1].error.code, code);
    assert.ok((await readFile(path.join(setup.output, result.groups[0].reports[1]), 'utf8')).length);
  });
});

test('consistent but incomplete browser or throttling evidence never completes a sample group', async t => {
  const cases = [
    ['MISSING_BROWSER', 'missing UA', report => { delete report.environment.hostUserAgent; delete report.userAgent; }],
    ['MISSING_BROWSER', 'generic UA', report => { report.environment.hostUserAgent = 'Synthetic browser without version'; }],
    ['MISSING_BROWSER', 'invalid Chrome version', report => { report.environment.hostUserAgent = 'Chrome/no-version Synthetic fixture'; }],
    ['MISSING_BROWSER', 'major-only Chrome version', report => { report.environment.hostUserAgent = 'Chrome/134 Synthetic fixture'; }],
    ['MISSING_THROTTLING', 'missing method', report => { delete report.configSettings.throttlingMethod; }],
    ['MISSING_THROTTLING', 'unsupported method', report => { report.configSettings.throttlingMethod = 'automatic'; }],
    ['INVALID_THROTTLING', 'missing simulated parameters', report => { delete report.configSettings.throttling; }],
    ['INVALID_THROTTLING', 'zero simulated throughput', report => { report.configSettings.throttling.throughputKbps = 0; }],
    ['INVALID_THROTTLING', 'negative simulated RTT', report => { report.configSettings.throttling.rttMs = -1; }],
    ['INVALID_THROTTLING', 'invalid simulated CPU', report => { report.configSettings.throttling.cpuSlowdownMultiplier = 0.5; }],
    ['INVALID_THROTTLING', 'boolean simulated RTT', report => { report.configSettings.throttling.rttMs = true; }],
    ['INVALID_THROTTLING', 'string simulated throughput', report => { report.configSettings.throttling.throughputKbps = '1638.4'; }],
    ['INVALID_THROTTLING', 'null simulated CPU', report => { report.configSettings.throttling.cpuSlowdownMultiplier = null; }],
  ];
  for (const field of ['rttMs', 'throughputKbps', 'cpuSlowdownMultiplier']) {
    cases.push(['INVALID_THROTTLING', `missing simulated ${field}`, report => { delete report.configSettings.throttling[field]; }]);
  }
  for (const field of ['requestLatencyMs', 'downloadThroughputKbps', 'uploadThroughputKbps', 'cpuSlowdownMultiplier']) {
    for (const invalid of [undefined, -1, true, '1']) {
      cases.push(['INVALID_THROTTLING', `devtools ${field}=${String(invalid)}`, report => {
        report.configSettings.throttlingMethod = 'devtools';
        report.configSettings.throttling = { requestLatencyMs: 150, downloadThroughputKbps: 1638.4, uploadThroughputKbps: 750, cpuSlowdownMultiplier: 4, [field]: invalid };
      }]);
    }
  }
  for (const [code, name, change] of cases) await t.test(name, async nested => {
    const setup = await fixture(nested);
    const transport = mockLighthouse(report => { change(report); return report; });
    const result = await measureSite({ config: base, output: setup.output, dependencies: { env: setup.env, spawn: transport.spawn } });
    assert.equal(result.status, 'failed');
    assert.deepEqual(result.counts, { planned: 5, attempted: 5, succeeded: 0, failed: 5 });
    assert.equal(result.groups[0].reports.length, 5);
    assert.equal(result.groups[0].validReports.length, 0);
    assert.ok(result.groups[0].attempts.every(attempt => attempt.error.code === code));
  });
});

test('explicit supported profiles follow score-target bounds, and provided conditions retain review reasons', async t => {
  const profiles = [
    { method: 'simulate', throttling: { rttMs: 0, throughputKbps: 1, cpuSlowdownMultiplier: 1 }, browser: 'Chrome/134.0.0.0' },
    { method: 'devtools', throttling: { requestLatencyMs: 0, downloadThroughputKbps: 0, uploadThroughputKbps: 0, cpuSlowdownMultiplier: 1 }, browser: 'HeadlessChrome/134.0.0.0' },
    { method: 'provided', browser: 'Chromium/134.0.0.0' },
  ];
  for (const profile of profiles) await t.test(profile.method, async nested => {
    const setup = await fixture(nested);
    const transport = mockLighthouse(report => {
      report.environment.hostUserAgent = '';
      report.userAgent = `${profile.browser} Synthetic contract fixture; not a store measurement`;
      report.configSettings.throttlingMethod = profile.method;
      report.configSettings.throttling = profile.throttling;
      return report;
    });
    const result = await measureSite({ config: base, output: setup.output, dependencies: { env: setup.env, spawn: transport.spawn } });
    assert.equal(result.status, 'complete');
    assert.equal(result.counts.succeeded, 5);
    const attempt = JSON.parse(await readFile(path.join(setup.output, result.groups[0].attempts[0].file), 'utf8'));
    assert.equal(attempt.reviewReasons.length > 0, profile.method === 'provided');
    assert.equal(result.environment.profiles.mobile.reviewReasons.length > 0, profile.method === 'provided');
    if (profile.method === 'provided') assert.equal(attempt.reviewRequired, true);
  });
});

test('synthetic PSI reports with missing throttle evidence remain failed raw evidence', async t => {
  const setup = await fixture(t); let index = 0;
  const result = await measureSite({ config: { ...base, engine: 'psi' }, output: setup.output, dependencies: {
    env: {}, lookup: publicLookup, fetch: async () => {
      const report = lhr(base.pages[0].url, 'mobile', ++index);
      delete report.configSettings.throttling;
      return response({ lighthouseResult: report });
    },
  } });
  assert.equal(result.status, 'failed');
  assert.equal(result.counts.failed, 5);
  assert.ok(result.groups[0].attempts.every(attempt => attempt.error.code === 'INVALID_THROTTLING'));
  const report = JSON.parse(await readFile(path.join(setup.output, result.groups[0].reports[0]), 'utf8'));
  assert.match(report.environment.hostUserAgent, /Synthetic/);
  assert.deepEqual(report.runWarnings, ['Synthetic report: not a store measurement.']);
});

test('missing local engine produces diagnostic run.json and never falls back to PSI', async t => {
  const setup = await fixture(t); let fetched = false;
  const result = await measureSite({ config: base, output: setup.output,
    dependencies: { env: { ...setup.env, PERF_KIT_LIGHTHOUSE_CLI: path.join(setup.temp, 'missing.js') }, fetch: async () => { fetched = true; } } });
  assert.equal(result.status, 'failed'); assert.equal(result.errors[0].code, 'ENGINE_UNAVAILABLE');
  assert.equal(result.counts.attempted, 0); assert.equal(fetched, false);
  assert.equal(JSON.parse(await readFile(path.join(setup.output, 'run.json'), 'utf8')).status, 'failed');
});

test('outputs cannot overwrite existing files/directories or follow symbolic links', async t => {
  const setup = await fixture(t);
  await mkdir(setup.output);
  await assert.rejects(measureSite({ config: base, output: setup.output }), { code: 'OUTPUT_EXISTS' });
  const link = path.join(setup.temp, 'redirect'); await symlink(setup.output, link);
  await assert.rejects(measureSite({ config: base, output: path.join(link, 'new') }), error => {
    assert.equal(error.code, 'UNSAFE_OUTPUT');
    assert.ok(error.message.includes(`canonical path: ${path.join(setup.output, 'new')}`));
    return true;
  });
  await assert.rejects(measureSite({ config: base, output: path.join(setup.temp, 'x') + '/../new' }), { code: 'INVALID_OUTPUT' });
});

test('PSI uses only the official GET endpoint and redacts keys from retained reports, responses and progress', async t => {
  const setup = await fixture(t); const requests = []; const events = [];
  const fetch = async (url, options) => {
    requests.push({ url, options });
    const request = new URL(url);
    const report = lhr(request.searchParams.get('url'), request.searchParams.get('strategy'), requests.length);
    report.runWarnings.push(`secret=${setup.env.PERF_KIT_PSI_API_KEY}`);
    return response({ lighthouseResult: report });
  };
  const result = await measureSite({ config: { ...base, engine: 'psi' }, output: setup.output, onProgress: event => events.push(event),
    dependencies: { env: setup.env, fetch, lookup: publicLookup, spawn: () => { throw new Error('Unexpected engine switch'); } } });
  assert.equal(result.status, 'complete'); assert.equal(requests.length, 5);
  for (const { url, options } of requests) {
    const request = new URL(url);
    assert.equal(request.origin + request.pathname, 'https://www.googleapis.com/pagespeedonline/v5/runPagespeed');
    assert.equal(request.searchParams.get('key'), setup.env.PERF_KIT_PSI_API_KEY);
    assert.equal(options.method, 'GET'); assert.equal(options.redirect, 'error'); assert.equal(options.credentials, 'omit');
    assert.equal(options.headers.Authorization, undefined);
  }
  const allFiles = async directory => (await Promise.all((await readdir(directory, { withFileTypes: true })).map(async entry => entry.isDirectory()
    ? allFiles(path.join(directory, entry.name)) : [await readFile(path.join(directory, entry.name), 'utf8')]))).flat();
  const saved = (await allFiles(setup.output)).join('\n') + JSON.stringify(events);
  assert.equal(saved.includes(setup.env.PERF_KIT_PSI_API_KEY), false);
  assert.ok(saved.includes('[REDACTED]'));
});

test('PSI rechecks public DNS for every attempt and refuses any private address', async t => {
  const setup = await fixture(t); let fetched = 0, lookedUp = 0;
  const result = await measureSite({ config: { ...base, engine: 'psi' }, output: setup.output, dependencies: {
    env: {}, lookup: async () => { lookedUp += 1; return [{ address: '93.184.216.34' }, { address: '10.0.0.1' }]; },
    fetch: async () => { fetched += 1; throw new Error('must not fetch'); },
  } });
  assert.equal(result.status, 'failed'); assert.equal(fetched, 0); assert.equal(lookedUp, 5);
  assert.equal(result.groups[0].attempts[0].error.code, 'PSI_PRIVATE_URL');
});

test('PSI HTTP, invalid JSON and transport errors remain diagnostic without leaking the API key', async t => {
  const setup = await fixture(t); let index = 0;
  const result = await measureSite({ config: { ...base, engine: 'psi' }, output: setup.output, dependencies: {
    env: setup.env, lookup: publicLookup, fetch: async () => {
      index += 1;
      if (index === 1) return response({ error: { message: setup.env.PERF_KIT_PSI_API_KEY } }, 429);
      if (index === 2) return response('not JSON');
      if (index === 3) throw new Error(`Request failed ?key=${setup.env.PERF_KIT_PSI_API_KEY}`);
      return response({ lighthouseResult: lhr(base.pages[0].url, 'mobile', index) });
    },
  } });
  assert.equal(result.status, 'failed'); assert.equal(result.counts.failed, 3);
  assert.deepEqual(result.groups[0].attempts.slice(0, 2).map(attempt => attempt.error.code), ['PSI_HTTP_ERROR', 'PSI_INVALID_JSON']);
  assert.equal(JSON.stringify(result).includes(setup.env.PERF_KIT_PSI_API_KEY), false);
  const raw = await readFile(path.join(setup.output, 'groups/home/mobile/attempts/run-01.response.txt'), 'utf8');
  assert.ok(raw.includes('[REDACTED]'));
});

test('PSI deadline aborts transport even if a mocked fetch never settles', async t => {
  const setup = await fixture(t); const signals = [];
  const result = await measureSite({ config: { ...base, engine: 'psi', timeoutMs: 10 }, output: setup.output, dependencies: {
    env: {}, lookup: publicLookup, fetch: async (url, options) => { signals.push(options.signal); return new Promise(() => {}); },
  } });
  assert.equal(result.status, 'failed'); assert.equal(result.counts.failed, 5);
  assert.ok(signals.every(signal => signal.aborted));
  assert.ok(result.groups[0].attempts.every(attempt => attempt.error.code === 'MEASUREMENT_TIMEOUT'));
});

test('Lighthouse deadlines terminate both CLI and its detached Chrome groups with TERM then KILL', async t => {
  const setup = await fixture(t); const children = new Map(); const signals = []; let index = 0;
  const spawn = (command, args, options) => {
    const child = new EventEmitter(); child.pid = 60000 + (++index); children.set(child.pid, child);
    child.stdout = new PassThrough(); child.stderr = new PassThrough();
    const profile = path.join(options.env.TMPDIR, 'lighthouse.owned');
    // Synchronous transport fixture setup finishes before the deadline.
    child.ready = mkdir(profile).then(() => writeFile(path.join(profile, 'chrome.pid'), String(61000 + index)));
    return child;
  };
  const kill = (pid, signal) => {
    signals.push({ pid, signal });
    if (signal === 'SIGKILL' && children.has(-pid)) children.get(-pid).emit('close', null, 'SIGKILL');
  };
  const result = await measureSite({ config: { ...base, timeoutMs: 30 }, output: setup.output,
    dependencies: { env: setup.env, spawn, kill, cleanupGraceMs: 2 } });
  assert.equal(result.status, 'failed'); assert.equal(result.counts.failed, 5);
  assert.ok(result.groups[0].attempts.every(attempt => attempt.error.code === 'MEASUREMENT_TIMEOUT'));
  for (let run = 1; run <= 5; run += 1) for (const pid of [60000 + run, 61000 + run]) {
    const sent = signals.filter(item => item.pid === -pid).map(item => item.signal);
    assert.equal(sent[0], 'SIGTERM'); assert.ok(sent.includes('SIGKILL'));
  }
});
