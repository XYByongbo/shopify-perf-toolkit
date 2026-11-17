import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {commandHelp, configValidator, parseCommand} from '../scripts/perfkit-commands.mjs';

const cli = fileURLToPath(new URL('../scripts/perfkit.mjs', import.meta.url));
const call = (cwd, ...args) => spawnSync(process.execPath, [cli, ...args], {cwd, encoding:'utf8', timeout:10000});
const measurement = {schemaVersion:1, engine:'lighthouse', pages:[{id:'home', url:'https://example.test/'}]};

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'perfkit-config-'));
  t.after(() => rm(root, {recursive:true, force:true}));
  const file = path.join(root,'config.json');
  return {root, file, async check(command, input) {
    await writeFile(file, JSON.stringify(input));
    return call(root,'validate-config','--command',command,'--config',file);
  }};
}

test('global help, command help and CLI parsing agree on option names and defaults', () => {
  const globalHelp = commandHelp('test');
  const names = [...globalHelp.matchAll(/^  ([a-z-]+)(?: |$)/gm)].map(m => m[1]);
  assert.ok(names.includes('doctor') && names.includes('validate-config') && names.includes('score-target'));
  const command = call(process.cwd(), 'measure', '--help');
  assert.equal(command.status,0);
  assert.match(command.stdout,/--config <measurement.json>.*--progress <quiet\|group\|attempt>/);
  assert.match(command.stdout,/validate-config --command measure/);
  assert.equal(call(process.cwd(),'help','measure').stdout,command.stdout);
  assert.deepEqual(parseCommand(['capture','--url','https://example.test/','--selector','main','--out','result']).args,
    {url:'https://example.test/',selector:'main',out:'result'});
  assert.doesNotThrow(() => parseCommand(['scan','--project','.']));
  assert.doesNotThrow(() => parseCommand(['apply','--project','.','--plan','plan.json','--adapter-context','context.json']));
  assert.throws(() => parseCommand(['measure','--config','config.json','--out','run','--progress','verbose']), /--progress.*quiet, group, attempt/);
  assert.throws(() => parseCommand(['measure','--confg','config.json']), /--confg.*--config/);
  assert.throws(() => parseCommand(['measure','--config','config.json']), /Required: --out/);
});

test('every advertised --config command has a validation handler', async () => {
  const globalHelp = commandHelp('test');
  const help = commandHelp('test','validate-config');
  const configured = [...globalHelp.matchAll(/^  ([a-z-]+).*--config </gm)].map(m=>m[1]).filter(name=>name!=='validate-config');
  assert.ok(configured.length > 30);
  for (const name of configured) {
    assert.ok(help.includes(name), name);
    try { await configValidator(name)({unexpectedConfigKey:true}); }
    catch (error) { assert.ok(!(error instanceof TypeError), `${name}: ${error.stack}`); }
  }
});

test('config validation shares field diagnostics with execution and exposes nested paths and values', async t => {
  const f = await fixture(t);
  for (const [input, expected] of [
    [{...measurement, engien:'typo'}, /engien.*Allowed fields:.*engine/],
    [{...measurement, engine:'other'}, /engine must be lighthouse or psi/],
    [{...measurement, pages:[{id:'!',url:'https://example.test/'}]}, /pages\[0\]\.id.*lowercase/],
    [{...measurement, pages:[{id:'home',url:'file:///tmp/private'}]}, /pages\[0\]\.url.*HTTP\(S\)/],
    [{...measurement, budget:{maxAttemps:1}}, /budget.*maxAttemps.*maxAttempts/],
  ]) {
    const checked = await f.check('measure',input);
    const run = call(f.root,'measure','--config',f.file,'--out','real-run');
    assert.equal(checked.status,2,checked.stderr);
    assert.equal(run.status,2,run.stderr);
    assert.deepEqual(JSON.parse(checked.stderr),JSON.parse(run.stderr));
    assert.match(checked.stderr,expected);
  }
  const nested = await f.check('batch',{schemaVersion:1,measurement:{...measurement,runs:2}});
  assert.equal(nested.status,2);
  assert.match(nested.stderr,/measurement.*runs.*5–10.*1–4/);
  const scenarios = await f.check('scenarios',{schemaVersion:1,url:'https://example.test/',scenarios:[{name:'example',steps:[{action:'tap'}]}]});
  assert.equal(scenarios.status,2);
  assert.match(scenarios.stderr,/scenarios\[0\]\.steps\[0\]\.action.*Allowed values:.*click/);
  assert.deepEqual(await readdir(f.root),['config.json']);
});

test('preflight reports planned samples and operates without a browser, theme or output directory', async t => {
  const f = await fixture(t);
  const valid = await f.check('batch',{schemaVersion:1, project:path.join(f.root,'missing-theme'), measurement, budget:{maxAttempts:2}});
  assert.equal(valid.status,0,valid.stderr);
  const report = JSON.parse(valid.stdout);
  assert.equal(report.scope,'config-only');
  assert.equal(report.plannedSamples,10);
  assert.match(report.warnings[0], /budget.maxAttempts/);
  assert.equal((await f.check('improve',{schemaVersion:1,action:'recover',previous:path.join(f.root,'missing/session.json')})).status,0);
  assert.equal((await f.check('optimize',{schemaVersion:1,action:'apply',project:path.join(f.root,'missing-theme'),plan:'missing-plan.json',reviewedPlanHash:'a'.repeat(64)})).status,0);
  assert.deepEqual(await readdir(f.root),['config.json']);
  const unsupported = await f.check('doctor',{});
  assert.equal(unsupported.status,2);
  assert.equal(JSON.parse(unsupported.stderr).code,'INVALID_CONFIG_COMMAND');
  await writeFile(f.file,'{"private":"secret fixture",broken}');
  const malformed = call(f.root,'validate-config','--command','measure','--config',f.file);
  assert.equal(JSON.parse(malformed.stderr).code,'INVALID_JSON');
  assert.match(malformed.stderr,/config.json/);
  assert.doesNotMatch(malformed.stderr,/secret fixture/);
});

test('legacy report and config commands classify malformed JSON by code, regardless of the filename', async t => {
  const {root} = await fixture(t);
  const input = path.join(root,'playwright-evidence.json');
  const output = path.join(root,'report.html');
  await writeFile(input,'{"broken"');
  for (const args of [
    ['report','--input',input,'--out',output],
    ['validate-config','--command','measure','--config',input],
  ]) {
    const result = call(root,...args);
    assert.equal(result.status,2,result.stderr);
    assert.equal(JSON.parse(result.stderr).code,'INVALID_JSON');
  }
  assert.deepEqual(await readdir(root),['playwright-evidence.json']);
});

test('the legacy capture command preserves exit 4 for a missing explicit browser executable', async t => {
  const {root} = await fixture(t);
  const env = {...process.env, PERF_KIT_PLAYWRIGHT_MODULE:'', PERF_KIT_BROWSER_EXECUTABLE:path.join(root,'missing-chrome')};
  const result = spawnSync(process.execPath,[cli,'capture','--url','https://example.test/','--selector','main','--out',path.join(root,'capture')],
    {cwd:root, env, encoding:'utf8', timeout:10000});
  assert.equal(result.status,4,result.stderr);
  assert.equal(JSON.parse(result.stderr).code,'BROWSER_UNAVAILABLE');
});
