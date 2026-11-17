import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runScenarios, validateScenarioConfig } from '../lib/scenarios.mjs';

const minimal = () => ({ schemaVersion: 1, url: 'https://preview.example.test/', scenarios: [{ name: 'component', steps: [{ action: 'assert-count', selector: '.component', count: 3 }] }] });

test('scenario defaults provide two fresh device states and bounded no-delay observation', () => {
  const config = validateScenarioConfig(minimal());
  assert.deepEqual(config.viewports, [{ name: 'mobile', width: 390, height: 844, dpr: 1 }, { name: 'desktop', width: 1440, height: 900, dpr: 1 }]);
  assert.equal(config.settleMs, 0);
  assert.equal(config.timeoutMs, 10000);
  assert.equal(config.runTimeoutMs, 120000);
  assert.equal(config.scenarios[0].url, 'https://preview.example.test/');
});

test('scenario config catches typo fields and unknown actions instead of silently reducing coverage', () => {
  for (const config of [
    { ...minimal(), timeotMs: 10 },
    { ...minimal(), viewports: [{ name: 'mobile', width: 390, height: 844, dp: 2 }] },
    { ...minimal(), scenarios: [{ ...minimal().scenarios[0], stpes: [] }] },
    { ...minimal(), scenarios: [{ name: 'bad', steps: [{ action: 'assert-cont', selector: 'body', count: 1 }] }] },
    { ...minimal(), scenarios: [{ name: 'bad', steps: [{ action: 'assert-count', selector: 'body', count: 1, counts: 1 }] }] },
  ]) assert.throws(() => validateScenarioConfig(config), { code: 'INVALID_SCENARIO_CONFIG' });
});

test('scenario rejects unsafe URLs, unbounded waits, duplicate names, empty assertions, and invalid values', () => {
  const variants = [
    { ...minimal(), url: 'file:///tmp/private' },
    { ...minimal(), url: 'https://user:secret@example.test' },
    { ...minimal(), schemaVersion: 2 },
    { ...minimal(), timeoutMs: 30001 },
    { ...minimal(), runTimeoutMs: 0 },
    { ...minimal(), settleMs: 10001 },
    { ...minimal(), viewports: [] },
    { ...minimal(), viewports: [{ name: 'same', width: 390, height: 844 }, { name: 'same', width: 1440, height: 900 }] },
    { ...minimal(), scenarios: [minimal().scenarios[0], minimal().scenarios[0]] },
    { ...minimal(), scenarios: [{ name: 'bad', steps: [{ action: 'click', selector: '#button' }] }] },
  ];
  const invalidSteps = [
    { action: 'wait', ms: 10001 }, { action: 'click', selector: '#a', times: 0 },
    { action: 'press', selector:'#a',key:'' }, {action:'press',selector:'#a',key:'a'.repeat(81)},
    { action: 'assert-visible', selector: '#a', visible: 'false' },
    { action: 'assert-count', selector: '#a', count: -1 },
    { action: 'assert-text', selector: '#a' }, { action: 'assert-attribute', selector: '#a', name: 'data-value' },
    { action: 'dispatch', selector: '#a', event: 'eval' },
    { action: 'dispatch', selector: '#a', event: 'shopify:section:load', detail: { script: 'run()' } },
    { action: 'reconnect', key: 'missing' }, { action: 'assert-count', selector: ' ', count: 1 },
  ];
  for (const step of invalidSteps) variants.push({ ...minimal(), scenarios: [{ name: 'bad', steps: [step, ...minimal().scenarios[0].steps] }] });
  for (const config of variants) assert.throws(() => validateScenarioConfig(config), { code: 'INVALID_SCENARIO_CONFIG' });
});

test('scenario keyboard actions preserve the declared key and require a selector',()=>{
  const config=minimal();config.scenarios[0].steps.unshift({action:'press',selector:'#button',key:'Enter'});
  assert.equal(validateScenarioConfig(config).scenarios[0].steps[0].key,'Enter');
  delete config.scenarios[0].steps[0].selector;assert.throws(()=>validateScenarioConfig(config),/selector/);
});

test('scenario permits relative page URLs, null attributes, repeated clicks and explicit matched reconnects', () => {
  const config = validateScenarioConfig({ ...minimal(), scenarios: [{ name: 'lifecycle', url: '/products/example', steps: [
    { action: 'click', selector: '#button', times: 3 },
    { action: 'detach', selector: '#component', key: 'original' },
    { action: 'assert-attribute', selector: 'body', name: 'data-timer', value: null },
    { action: 'reconnect', key: 'original' },
  ] }] });
  assert.equal(config.scenarios[0].url, 'https://preview.example.test/products/example');
  assert.equal(config.scenarios[0].steps[0].times, 3);
});

test('scenario requires explicit assertions and caps total configuration work', () => {
  const config = minimal();
  config.scenarios[0].steps = [...Array.from({ length: 7 }, () => ({ action: 'wait', ms: 10000 })), ...config.scenarios[0].steps];
  assert.throws(() => validateScenarioConfig(config), /60000/);
  const duplicateDetach = minimal();
  duplicateDetach.scenarios[0].steps.unshift({ action: 'detach', selector: '#a', key: 'a' }, { action: 'detach', selector: '#b', key: 'a' });
  assert.throws(() => validateScenarioConfig(duplicateDetach), /already detached/);
  const tooMany = { ...minimal(), viewports: ['a', 'b', 'c', 'd'].map(name => ({ name, width: 390, height: 844 })), scenarios: Array.from({ length: 11 }, (_, i) => ({ ...minimal().scenarios[0], name: String(i) })) };
  assert.throws(() => validateScenarioConfig(tooMany), /at most 40/);
});

test('missing browser runtime persists a blocked result instead of reporting an empty pass', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'perf-kit-scenarios-missing-runtime-'));
  const previous = process.env.PERF_KIT_PLAYWRIGHT_MODULE;
  try {
    process.env.PERF_KIT_PLAYWRIGHT_MODULE = path.join(directory, 'no-such-playwright.mjs');
    const output = path.join(directory, 'result');
    const result = await runScenarios({ config: minimal(), output });
    assert.equal(result.outcome, 'blocked');
    assert.equal(result.runs.length, 0);
    assert.equal(result.errors[0].code, 'PLAYWRIGHT_UNAVAILABLE');
    assert.equal(JSON.parse(await readFile(path.join(output, 'scenario-results.json'), 'utf8')).outcome, 'blocked');
  } finally {
    if (previous === undefined) delete process.env.PERF_KIT_PLAYWRIGHT_MODULE;
    else process.env.PERF_KIT_PLAYWRIGHT_MODULE = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
