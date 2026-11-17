#!/usr/bin/env node
import {readdir} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {run} from 'node:test';
import {inspect} from 'node:util';
import {browserExecutable} from '../lib/theme-source.mjs';
import {runProcess} from '../lib/bounded-process.mjs';
import {themeCheckEnvironment} from '../lib/theme-check-transport.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const groups = ['offline', 'browser', 'official', 'boundaries'];
const boundarySuite = 'architecture-boundaries.test.mjs';
const testFilter = /(?:^|[\s"])(--test[-_](?:name[-_]pattern|skip[-_]pattern|only))(?=$|[=\s"])/;

export async function discoverTests(group, directory = path.join(root, 'tests')) {
  if (!groups.includes(group)) throw new Error(`Use one of: ${groups.join(', ')}.`);
  const files = (await readdir(directory)).filter(file => file.endsWith('.test.mjs')).sort();
  if (group === 'boundaries') {
    if (!files.includes(boundarySuite)) throw new Error(`Required architecture suite is missing: ${path.join(directory, boundarySuite)}`);
    return [path.join(directory, boundarySuite)];
  }
  return files.filter(file => {
    const category = file.endsWith('-browser.test.mjs') ? 'browser'
      : file.endsWith('-official.test.mjs') ? 'official' : 'offline';
    return category === group;
  }).map(file => path.join(directory, file));
}

export async function preflightTests(group) {
  if (group === 'browser') {
    const {loadPlaywright} = await import('../lib/capture.mjs');
    const {chromium} = await loadPlaywright();
    const browser = await chromium.launch({executablePath: await browserExecutable(), headless: true});
    try { return {browser: browser.version()}; } finally { await browser.close(); }
  }
  if (group === 'official') {
    const executable = process.env.PERF_KIT_SHOPIFY_CLI || 'shopify';
    const options = {timeoutMs: 15000, maxBytes: 65536, env:themeCheckEnvironment()};
    const result = await runProcess(executable, ['version'], options);
    if (result.code !== 0) throw new Error('Installed Shopify CLI version check failed: ' + result.stderr);
    const help = await runProcess(executable, ['theme','check','--help'], options);
    const missing = ['--no-input','--list','--print'].filter(flag => !help.stdout.includes(flag));
    if (help.code !== 0 || missing.length) throw Object.assign(new Error(
      `Selected Shopify CLI ${result.stdout.trim()} lacks required Theme Check capabilities: ${missing.join(', ') || help.stderr}. npm may prefer an ancestor node_modules/.bin; set PERF_KIT_SHOPIFY_CLI to the absolute supported executable.`), {code:'UNSUPPORTED_THEME_CHECK_CLI'});
    return {shopify: result.stdout.trim(), executable};
  }
  return {};
}

export async function executeTests(files, group, write = text => process.stdout.write(text)) {
  if (!groups.includes(group) || !files.length) throw new Error('Test group must contain at least one test file.');
  const keys = ['PERF_KIT_BROWSER_TESTS','PERF_KIT_THEME_CHECK_TESTS'];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  process.env.PERF_KIT_BROWSER_TESTS = group === 'browser' ? '1' : '0';
  process.env.PERF_KIT_THEME_CHECK_TESTS = group === 'official' ? '1' : '0';
  const pending = new Set(files.map(file => path.resolve(file)));
  let summary, failures = 0;
  try {
    const stream = run({files, concurrency: group === 'offline' ? true : 1, execArgv: []});
    for await (const event of stream) {
      const data = event.data;
      if (event.type === 'test:fail') {
        failures++;
        write(`FAIL ${data.file ?? ''}: ${data.name}\n${inspect(data.details?.error, {depth: 5})}\n`);
      } else if (event.type === 'test:pass' && (data.skip || data.todo)) {
        write(`${data.skip ? 'SKIP' : 'TODO'} ${data.name}: ${data.skip || data.todo}\n`);
      } else if (event.type === 'test:pass' && group !== 'offline' && data.nesting === 0) {
        write(`PASS ${data.name}\n`);
      } else if (event.type === 'test:summary') {
        if (!data.file) summary = data;
        else if (data.counts.tests > 0) pending.delete(path.resolve(data.file));
      } else if (event.type === 'test:stderr') write(data.message);
    }
  } finally {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
    }
  }
  // Node can report a green file-level wrapper for a file that declares no tests.
  if (pending.size) write(`No test results from:\n${[...pending].join('\n')}\n`);
  const incomplete = pending.size > 0 || !summary || summary.counts.tests === 0
    || summary.counts.cancelled > 0 || summary.counts.todo > 0
    || (group !== 'offline' && summary.counts.skipped > 0);
  const result = {group, files: files.length, counts: summary?.counts ?? null,
    durationMs: summary?.duration_ms ?? null,
    status: !incomplete && !failures && summary?.success ? 'passed' : 'failed'};
  write(JSON.stringify(result) + '\n');
  return result;
}

export async function main(args = process.argv.slice(2)) {
  const [group = 'offline', option] = args;
  if (args.length > 2 || option !== undefined && option !== '--list') throw new Error(`Usage: run_tests.mjs ${groups.join('|')} [--list]`);
  const files = await discoverTests(group);
  if (option === '--list') { console.log(JSON.stringify({group, files}, null, 2)); return 0; }
  const filter = [process.env.NODE_OPTIONS, ...process.execArgv].map(value => value?.match(testFilter)?.[1]).find(Boolean);
  if (filter) {
    console.error(JSON.stringify({group, status:'blocked', reason:'test-filter-enabled',
      message:`Remove ${filter} to run the complete ${group} test group.`}));
    return 2;
  }
  let environment;
  try { environment = await preflightTests(group); }
  catch (error) {
    console.error(JSON.stringify({group, status: 'blocked', reason: error.code === 'UNSUPPORTED_THEME_CHECK_CLI' ? 'unsupported-theme-check-cli' : 'required-dependency-unavailable', message: error.message}));
    return 2;
  }
  console.log(JSON.stringify({group, files: files.length, environment, status: 'running'}));
  return (await executeTests(files, group)).status === 'passed' ? 0 : 1;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try { process.exitCode = await main(); }
  catch (error) { console.error(error.message); process.exitCode = 2; }
}
