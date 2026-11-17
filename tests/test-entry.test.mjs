import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, rm, readdir, chmod} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {discoverTests} from '../scripts/run_tests.mjs';

const exec = promisify(execFile);
const runner = new URL('../scripts/run_tests.mjs', import.meta.url).href;
async function directory(t) {
  const root = await mkdtemp(path.join(tmpdir(),'perfkit-test-entry-'));
  t.after(() => rm(root,{recursive:true,force:true}));
  return root;
}

test('test groups partition every suite, including newly added browser files and former mixed suites', async t => {
  const groups = await Promise.all(['offline','browser','official'].map(group=>discoverTests(group)));
  const names = groups.flat().map(file=>path.basename(file));
  const all = (await readdir(new URL('./',import.meta.url))).filter(file=>file.endsWith('.test.mjs'));
  assert.deepEqual(names.sort(),all.sort());
  assert.equal(new Set(names).size,names.length);
  for (const name of ['delivery','capture','mapping','scenarios']) assert.ok(groups[1].some(file=>file.endsWith(`/${name}-browser.test.mjs`)));
  assert.ok(groups[2].some(file=>file.endsWith('/standards-official.test.mjs')));
  const boundaries = await discoverTests('boundaries');
  assert.deepEqual(boundaries.map(file=>path.basename(file)),['architecture-boundaries.test.mjs']);
  assert.ok(groups[0].includes(boundaries[0]));
  const root = await directory(t);
  for (const file of ['new-browser.test.mjs','new-official.test.mjs','new.test.mjs']) await writeFile(path.join(root,file),'');
  assert.deepEqual((await discoverTests('browser',root)).map(file=>path.basename(file)),['new-browser.test.mjs']);
  await assert.rejects(discoverTests('boundaries',root),/Required architecture suite is missing/);
  await assert.rejects(discoverTests('typo',root),/offline, browser, official, boundaries/);
});

test('runner counts results, rejects mandatory skips and failures, and isolates inherited enable flags', {timeout:30000}, async t => {
  const root = await directory(t);
  const file = path.join(root,'fixture.test.mjs'), bootstrap = path.join(root,'bootstrap.mjs');
  const env = {...process.env,PERF_KIT_BROWSER_TESTS:'1',PERF_KIT_THEME_CHECK_TESTS:'1'};
  // The outer Node test harness marker must not turn this separate runner into a nested test.
  delete env.NODE_TEST_CONTEXT;
  await writeFile(bootstrap,`import {executeTests} from ${JSON.stringify(runner)};
    const result=await executeTests([${JSON.stringify(file)}],process.argv[2]);
    process.exitCode=result.status==='passed'?0:1;`);
  const run = async group => {
    try { const result = await exec(process.execPath,[bootstrap,group],{env}); return {code:0,...result}; }
    catch (error) { return {code:error.code,stdout:error.stdout,stderr:error.stderr}; }
  };
  await writeFile(file,"import test from 'node:test'; import assert from 'node:assert/strict'; test('offline flags',()=>{assert.equal(process.env.PERF_KIT_BROWSER_TESTS,'0');assert.equal(process.env.PERF_KIT_THEME_CHECK_TESTS,'0');});");
  const offline = await run('offline'); assert.equal(offline.code,0,offline.stdout+offline.stderr);
  assert.equal(JSON.parse(offline.stdout.trim().split('\n').at(-1)).counts.passed,1);
  await writeFile(file,"import test from 'node:test'; test('required integration',{skip:true},()=>{});");
  for (const group of ['browser','official','boundaries']) {
    const result = await run(group); assert.equal(result.code,1,result.stdout+result.stderr);
    assert.equal(JSON.parse(result.stdout.trim().split('\n').at(-1)).counts.skipped,1);
  }
  const skippedOffline = await run('offline');
  assert.equal(skippedOffline.code,0,skippedOffline.stdout+skippedOffline.stderr);
  await writeFile(file,"import test from 'node:test'; test('broken assertion',()=>{throw new Error('expected fixture failure');});");
  const failed = await run('offline'); assert.equal(failed.code,1); assert.match(failed.stdout,/expected fixture failure/);
  await writeFile(file,"import test from 'node:test'; test('unfinished gate',{todo:true},()=>{});");
  const unfinished = await run('offline'); assert.equal(unfinished.code,1);
  assert.equal(JSON.parse(unfinished.stdout.trim().split('\n').at(-1)).counts.todo,1);
  await writeFile(file,"import test from 'node:test'; test('cancelled',()=>new Promise(()=>{}));");
  const cancelled = await run('offline'); assert.equal(cancelled.code,1);
  assert.equal(JSON.parse(cancelled.stdout.trim().split('\n').at(-1)).counts.cancelled,1);
  await writeFile(file,'export const noTests = true;');
  const empty = await run('boundaries'); assert.equal(empty.code,1);
  assert.match(empty.stdout,/No test results from:[\s\S]+fixture\.test\.mjs/);
});

test('browser entry reports a missing explicit executable as blocked, never a green skipped run', {timeout:30000}, async t => {
  const root = await directory(t);
  const env = {...process.env,PERF_KIT_BROWSER_EXECUTABLE:path.join(root,'missing-chrome')};
  delete env.NODE_TEST_CONTEXT;
  await assert.rejects(exec(process.execPath,[new URL('../scripts/run_tests.mjs',import.meta.url).pathname,'browser'],{env}), error => {
    assert.equal(error.code,2);
    assert.match(error.stderr,/"status":"blocked"/);
    assert.match(error.stderr,/required-dependency-unavailable/);
    return true;
  });
});

test('gate rejects an inherited filter that would silently omit the repository architecture test', {timeout:30000}, async () => {
  const env = {...process.env, NODE_OPTIONS:'--test-skip-pattern="library architecture"'};
  delete env.NODE_TEST_CONTEXT;
  await assert.rejects(exec(process.execPath,[new URL('../scripts/run_tests.mjs',import.meta.url).pathname,'boundaries'],{env}), error => {
    assert.equal(error.code,2);
    assert.equal(JSON.parse(error.stderr).reason,'test-filter-enabled');
    assert.doesNotMatch(error.stdout,/"status":"passed"/);
    return true;
  });
});

test('official entry rejects a CLI with a version but without required Theme Check capabilities', {timeout:30000,skip:process.platform==='win32'}, async t => {
  const root = await directory(t), cli = path.join(root,'old-shopify.mjs');
  await writeFile(cli,`#!${process.execPath}\nconsole.log(process.argv[2]==='version'?'4.5.2':'theme check --list --print');\n`);
  await chmod(cli,0o755);
  const env = {...process.env,PERF_KIT_SHOPIFY_CLI:cli}; delete env.NODE_TEST_CONTEXT;
  await assert.rejects(exec(process.execPath,[new URL('../scripts/run_tests.mjs',import.meta.url).pathname,'official'],{env}), error => {
    assert.equal(error.code,2);
    assert.match(error.stderr,/unsupported-theme-check-cli/);
    assert.match(error.stderr,/--no-input/);
    assert.doesNotMatch(error.stdout,/"status":"running"/);
    return true;
  });
});
