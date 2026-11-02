import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { loadPlaywright, isLocalPreviewUrl } from './capture.mjs';
import { checkpointDOM, preservationStyles } from './preservation.mjs';
import {sectionResponseEvidence} from './extended-methods.mjs';
import { sourceSnapshot } from './runtime-profile.mjs';

const fail = (message, code = 'INVALID_SCENARIO_CONFIG') => Object.assign(new Error(message), { code });
const normalizeText = value => String(value ?? '').replace(/\s+/g, ' ').trim();
async function bounded(operation, timeoutMs) {
  let timer;
  try {
    return await Promise.race([operation, new Promise((_, reject) => {
      timer = setTimeout(() => reject(fail('Action exceeded its time bound.', 'ACTION_TIMEOUT')), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}
const fields = {
  click: ['selector', 'times'], press: ['selector','key'], scroll: ['selector'],
  'assert-count': ['selector', 'count'], 'assert-visible': ['selector', 'visible'],
  'assert-text': ['selector', 'text'], 'assert-attribute': ['selector', 'name', 'value'],
  'assert-image-loaded': ['selector'],
  detach: ['selector', 'key'], reconnect: ['key'], dispatch: ['selector', 'event', 'detail'], wait: ['ms'],
  checkpoint: ['selector', 'key'],
};

function object(value, allowed, at) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype) throw fail(`${at} must be a plain object.`);
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw fail(`Unknown field ${at}.${key}.`);
}
function integer(value, min, max, at) {
  if (!Number.isInteger(value) || value < min || value > max) throw fail(`${at} must be an integer from ${min} to ${max}.`);
  return value;
}
function string(value, at, { empty = false, max = 2000 } = {}) {
  if (typeof value !== 'string' || (!empty && !value.trim()) || value.length > max) throw fail(`${at} must be ${empty ? 'a' : 'a nonempty'} string of at most ${max} characters.`);
  return value;
}
function url(value, base, at) {
  let result;
  try { result = new URL(value, base); } catch { throw fail(`${at} must resolve to an HTTP(S) URL.`); }
  if (!['http:', 'https:'].includes(result.protocol) || result.username || result.password) throw fail(`${at} must be HTTP(S) without embedded credentials.`);
  return result.href;
}

export function validateScenarioConfig(input) {
  object(input, ['schemaVersion', 'url', 'viewports', 'timeoutMs', 'settleMs', 'runTimeoutMs', 'scenarios', 'project', 'expectedThemeId','serverRenderedSelectors'], 'config');
  if(input.serverRenderedSelectors!==undefined&&(!Array.isArray(input.serverRenderedSelectors)||!input.serverRenderedSelectors.length||input.serverRenderedSelectors.length>5
    ||input.serverRenderedSelectors.some(s=>typeof s!=='string'||!/^#[A-Za-z_][\w-]*$/.test(s))||new Set(input.serverRenderedSelectors).size!==input.serverRenderedSelectors.length))throw fail('serverRenderedSelectors requires 1–5 distinct literal id selectors.');
  if (input.schemaVersion !== 1) throw fail('config.schemaVersion must be 1.');
  if (input.project !== undefined && (typeof input.project !== 'string' || !path.isAbsolute(input.project))) throw fail('project must be absolute.');
  if (input.expectedThemeId !== undefined && !/^\d+$/.test(String(input.expectedThemeId))) throw fail('expectedThemeId must be numeric.');
  const baseUrl = input.url === undefined ? undefined : url(string(input.url, 'config.url'), undefined, 'config.url');
  const timeoutMs = integer(input.timeoutMs ?? 10000, 1, 30000, 'config.timeoutMs');
  const settleMs = integer(input.settleMs ?? 0, 0, 10000, 'config.settleMs');
  const runTimeoutMs = integer(input.runTimeoutMs ?? 120000, 1, 300000, 'config.runTimeoutMs');
  const viewports = input.viewports ?? [{ name: 'mobile', width: 390, height: 844 }, { name: 'desktop', width: 1440, height: 900 }];
  if (!Array.isArray(viewports) || viewports.length < 1 || viewports.length > 4) throw fail('Provide between 1 and 4 viewports.');
  const viewportNames = new Set();
  const normalizedViewports = viewports.map((entry, index) => {
    const at = `viewports[${index}]`;
    object(entry, ['name', 'width', 'height', 'dpr'], at);
    const name = string(entry.name, `${at}.name`, { max: 80 });
    if (viewportNames.has(name)) throw fail(`Duplicate viewport name: ${name}.`);
    viewportNames.add(name);
    const width = integer(entry.width, 1, 10000, `${at}.width`);
    const height = integer(entry.height, 1, 10000, `${at}.height`);
    const dpr = entry.dpr ?? 1;
    if (!Number.isFinite(dpr) || dpr < 0.1 || dpr > 5) throw fail(`${at}.dpr must be between 0.1 and 5.`);
    return { name, width, height, dpr };
  });
  if (!Array.isArray(input.scenarios) || input.scenarios.length < 1 || input.scenarios.length > 20) throw fail('Provide between 1 and 20 scenarios.');
  if (input.scenarios.length * viewports.length > 40) throw fail('A configuration may contain at most 40 scenario/viewport runs.');
  const names = new Set();
  const scenarios = input.scenarios.map((entry, index) => {
    const at = `scenarios[${index}]`;
    object(entry, ['name', 'url', 'steps'], at);
    const name = string(entry.name, `${at}.name`, { max: 120 });
    if (names.has(name)) throw fail(`Duplicate scenario name: ${name}.`);
    names.add(name);
    if (entry.url === undefined && !baseUrl) throw fail(`${at} needs a URL or config.url.`);
    const scenarioUrl = entry.url === undefined ? baseUrl : url(string(entry.url, `${at}.url`), baseUrl, `${at}.url`);
    if (!Array.isArray(entry.steps) || entry.steps.length < 1 || entry.steps.length > 100) throw fail(`${at}.steps must contain 1 to 100 steps.`);
    const detached = new Set();
    let waitTotal = settleMs;
    const steps = entry.steps.map((step, stepIndex) => {
      const stepAt = `${at}.steps[${stepIndex}]`;
      if (!step || !Object.hasOwn(fields, step.action)) throw fail(`Unknown action at ${stepAt}: ${step?.action}.`);
      object(step, ['action', ...fields[step.action]], stepAt);
      const normalized = { ...step };
      if (fields[step.action].includes('selector')) normalized.selector = string(step.selector, `${stepAt}.selector`).trim();
      if (step.action === 'click') normalized.times = integer(step.times ?? 1, 1, 20, `${stepAt}.times`);
      if (step.action === 'press') normalized.key = string(step.key, `${stepAt}.key`, {max:80});
      if (step.action === 'assert-count') integer(step.count, 0, 10000, `${stepAt}.count`);
      if (step.action === 'assert-visible') {
        normalized.visible = step.visible ?? true;
        if (typeof normalized.visible !== 'boolean') throw fail(`${stepAt}.visible must be boolean.`);
      }
      if (step.action === 'assert-text') string(step.text, `${stepAt}.text`, { empty: true, max: 10000 });
      if (step.action === 'assert-attribute') {
        string(step.name, `${stepAt}.name`, { max: 200 });
        if (step.value !== null) string(step.value, `${stepAt}.value`, { empty: true, max: 10000 });
      }
      if (step.action === 'detach' || step.action === 'reconnect') {
        string(step.key, `${stepAt}.key`, { max: 100 });
        if (step.action === 'detach') {
          if (detached.has(step.key)) throw fail(`${stepAt}: key already detached: ${step.key}.`);
          detached.add(step.key);
        } else {
          if (!detached.has(step.key)) throw fail(`${stepAt}: reconnect requires an earlier unmatched detach: ${step.key}.`);
          detached.delete(step.key);
        }
      }
      if (step.action === 'dispatch') {
        if (!['shopify:section:load', 'shopify:section:unload'].includes(step.event)) throw fail(`${stepAt}.event must be shopify:section:load or shopify:section:unload.`);
        if (step.detail !== undefined) {
          object(step.detail, ['sectionId'], `${stepAt}.detail`);
          if (step.detail.sectionId !== undefined) string(step.detail.sectionId, `${stepAt}.detail.sectionId`, { max: 200 });
        }
      }
      if (step.action === 'wait') waitTotal += integer(step.ms, 0, 10000, `${stepAt}.ms`);
      if (step.action === 'checkpoint') string(step.key,`${stepAt}.key`,{ max: 100 });
      return normalized;
    });
    if (waitTotal > 60000) throw fail(`${at} contains more than 60000 ms of explicit waiting.`);
    if (!steps.some(step => step.action.startsWith('assert-'))) throw fail(`${at} needs at least one explicit assertion; actions alone do not establish acceptance.`);
    return { name, url: scenarioUrl, steps };
  });
  return { schemaVersion: 1, ...(baseUrl ? { url: baseUrl } : {}), ...(input.project ? { project: input.project } : {}), ...(input.expectedThemeId !== undefined ? { expectedThemeId: String(input.expectedThemeId) } : {}), ...(input.serverRenderedSelectors?{serverRenderedSelectors:[...input.serverRenderedSelectors]}:{}),viewports: normalizedViewports, timeoutMs, settleMs, runTimeoutMs, scenarios };
}

async function unique(page, selector) {
  const locator = page.locator(`css=${selector}`);
  const count = await locator.count();
  if (count !== 1) throw fail(`Selector ${JSON.stringify(selector)} matched ${count} elements; expected exactly one.`, 'SELECTOR_NOT_UNIQUE');
  return locator;
}

export const assertionExpected = step => step.action === 'assert-image-loaded' ? true : step.action === 'assert-count' ? step.count : step.action === 'assert-visible' ? step.visible : step.action === 'assert-text' ? normalizeText(step.text) : step.value;

async function readAssertion(page, step, sample = operation => operation()) {
  const locator = page.locator(`css=${step.selector}`);
  const snapshot = await sample(() => locator.evaluateAll((elements, spec) => ({
    count: elements.length,
    value: elements.length === 1 ? (spec.action === 'assert-text' ? elements[0].textContent
      : spec.action === 'assert-attribute' ? elements[0].getAttribute(spec.name)
      : spec.action === 'assert-image-loaded' ? elements[0] instanceof HTMLImageElement && elements[0].complete && elements[0].naturalWidth>0 && elements[0].naturalHeight>0 : null) : null,
  }), { action: step.action, name: step.name }));
  let actual;
  if (step.action === 'assert-count') actual = snapshot.count;
  else {
    if (snapshot.count > 1) throw fail(`Selector ${JSON.stringify(step.selector)} matched ${snapshot.count} elements; expected exactly one.`, 'SELECTOR_NOT_UNIQUE');
    if (snapshot.count === 0) actual = { matched: 0 };
    else if (step.action === 'assert-visible') actual = await sample(() => locator.isVisible());
    else actual = step.action === 'assert-text' ? normalizeText(snapshot.value) : snapshot.value;
  }
  return {actual,expected:assertionExpected(step)};
}

async function assertion(page, step, timeoutMs) {
  const deadline = performance.now() + timeoutMs;
  let actual;
  let observed = false;
  const expected = assertionExpected(step);
  const mismatch = () => Object.assign(fail(`${step.action} failed for ${JSON.stringify(step.selector)}: expected ${JSON.stringify(expected)}, ${observed ? `last observed ${JSON.stringify(actual)}` : 'no observation completed before the deadline'}.`, observed ? 'ASSERTION_FAILED' : 'ASSERTION_TIMEOUT'), { expected, actual: observed ? actual : { availability: 'not-observed' } });
  const sample = async operation => {
    const remaining = deadline - performance.now();
    if (remaining <= 0) throw mismatch();
    try { return await bounded(operation(), remaining); }
    catch (error) {
      // Deadline expiry must retain a real mismatch already observed. Invalid selectors,
      // closed pages, and other browser errors remain distinct failures.
      if (error.code === 'ACTION_TIMEOUT' || error.name === 'TimeoutError') throw mismatch();
      throw error;
    }
  };
  while (performance.now() < deadline) {
    ({actual}=await readAssertion(page,step,sample));
    observed = true;
    if (actual === expected) return { actual, expected, ...(step.action === 'assert-text' ? { comparison: 'exact-after-whitespace-collapse-and-trim' } : {}) };
    const remaining = deadline - performance.now();
    if (remaining > 0) await sample(() => page.waitForTimeout(Math.min(50, remaining)));
  }
  throw mismatch();
}

async function performStep(page, step, nodes, timeoutMs) {
  if (step.action === 'checkpoint') return (await unique(page,step.selector)).evaluate(checkpointDOM,preservationStyles);
  if (step.action.startsWith('assert-')) return assertion(page, step, timeoutMs);
  if (step.action === 'wait') {
    if (step.ms > timeoutMs) throw fail('Explicit wait exceeds remaining action/run time.', 'RUN_TIMEOUT');
    await page.waitForTimeout(step.ms);
    return { waitedMs: step.ms };
  }
  if (step.action === 'reconnect') {
    const saved = nodes.get(step.key);
    if (!saved) throw fail(`Detached node unavailable for key ${step.key}.`, 'DETACHED_NODE_MISSING');
    const result = await saved.evaluate(({ node, marker }) => {
      if (!marker.isConnected || node.isConnected) throw new Error('Reconnect requires the original connected placeholder and detached original node.');
      marker.replaceWith(node);
      return { reconnected: node.isConnected, sameNode: true };
    });
    if (!result.reconnected) throw fail('Original node did not remain connected.', 'RECONNECT_FAILED');
    await saved.dispose();
    nodes.delete(step.key);
    return result;
  }
  const locator = await unique(page, step.selector);
  if (step.action === 'press') {
    await locator.press(step.key,{timeout:timeoutMs});
    return {key:step.key};
  }
  if (step.action === 'click') {
    const started = performance.now();
    for (let index = 0; index < step.times; index++) {
      const remaining = Math.floor(timeoutMs - (performance.now() - started));
      if (remaining <= 0) throw fail('Repeated clicks exceeded the action time bound.', 'ACTION_TIMEOUT');
      await (await unique(page, step.selector)).click({ timeout: remaining });
    }
    return { clicks: step.times };
  }
  if (step.action === 'scroll') {
    await locator.scrollIntoViewIfNeeded({ timeout: timeoutMs });
    return { scrolledIntoView: true };
  }
  if (step.action === 'dispatch') {
    await locator.evaluate((node, payload) => node.dispatchEvent(new CustomEvent(payload.event, { bubbles: true, cancelable: false, detail: payload.detail })), { event: step.event, detail: step.detail ?? {} }, { timeout: timeoutMs });
    return { event: step.event, detail: step.detail ?? {}, synthetic: true };
  }
  if (step.action === 'detach') {
    const saved = await locator.evaluateHandle(node => {
      const marker = document.createComment('perf-kit-original-position');
      node.replaceWith(marker);
      if (node.isConnected) throw new Error('Node remained connected after detach.');
      return { node, marker };
    }, undefined, { timeout: timeoutMs });
    nodes.set(step.key, saved);
    return { detached: true, originalNodeRetained: true };
  }
  throw fail(`Unsupported action: ${step.action}.`);
}

async function screenshot(page, directory, filename, timeoutMs, run) {
  try {
    const buffer = await page.screenshot({ fullPage: false, timeout: timeoutMs });
    await writeFile(path.join(directory, filename), buffer, { flag: 'wx' });
    run.artifacts[filename.replace('.png', '')] = { file: `${run.directory}/${filename}`, sha256: createHash('sha256').update(buffer).digest('hex') };
  } catch (error) {
    run.artifactErrors.push({ file: filename, message: error.message });
  }
}

export async function runScenarios({ config: input, output } = {}) {
  const config = validateScenarioConfig(input);
  const source = config.project ? await sourceSnapshot(config.project) : null;
  if (source && !source.complete) throw fail('Incomplete regression source inventory.');
  string(output, 'output', { max: 10000 });
  const destination = path.resolve(output);
  await mkdir(path.dirname(destination), { recursive: true });
  try { await mkdir(destination); }
  catch (error) {
    if (error.code === 'EEXIST') throw fail(`Output directory already exists; refusing to overwrite: ${destination}`, 'OUTPUT_EXISTS');
    throw error;
  }
  const started = performance.now();
  const result = {
    schemaVersion: 1, kind: 'scenarios', createdAt: new Date().toISOString(), outcome: 'blocked', config,
    environment: { browser: 'chromium', browserVersion: null, locale: 'en-US', timezoneId: 'UTC', colorScheme: 'light', reducedMotion: 'no-preference', storage: 'fresh-context-per-run', cache: 'disabled-by-routing', requestPolicy: 'GET-HEAD-OPTIONS-only', serviceWorkers: 'blocked', webSockets: 'blocked' },
    runs: [], errors: [],
    limitations: [
      'Declarative laboratory interaction checks only; no field INP, performance gain, complete business acceptance, or automatic timer/listener leak detection.',
      'Lifecycle cleanup and repeated initialization require explicit page-observable assertions, such as instrumented attributes. Shopify events are synthetic and do not reproduce the complete theme editor.',
      'Each scenario and viewport uses fresh cookies and storage. Non-GET/HEAD/OPTIONS requests, WebSockets, service workers, and downloads are blocked; dependent functionality is constrained and cannot pass.',
      'Read-only HTTP methods do not guarantee that a poorly designed GET endpoint has no server-side effects. Use authorized preview URLs and known local UI interactions.',
      'Text assertions compare exact textContent after whitespace collapse and trim. Screenshots are viewport artifacts, not automated visual-difference checks.',
      'The first configured click is not an earliest possible click or an INP measurement. A click-first scenario omits its before screenshot to avoid an artificial pre-click screenshot delay.',
      'Console errors are retained; uncaught page errors fail unconstrained runs. Coverage is limited to configured assertions and viewport states.',
    ],
  };
  let browser;
  try {
    const playwright = await loadPlaywright();
    const executablePath = process.env.PERF_KIT_BROWSER_EXECUTABLE || process.env.PERF_KIT_CHROMIUM_EXECUTABLE || await (await import('./runtime-profile.mjs')).browserExecutable();
    if (executablePath && !path.isAbsolute(executablePath)) throw fail('Browser executable must be an absolute path.', 'INVALID_BROWSER_PATH');
    browser = await playwright.chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
    result.environment.browserVersion = browser.version();
    for (const scenario of config.scenarios) for (const viewport of config.viewports) {
      const runStarted = performance.now();
      const deadline = runStarted + config.runTimeoutMs;
      const budget = () => {
        const remaining = Math.floor(deadline - performance.now());
        if (remaining < 1) throw fail('Scenario exceeded runTimeoutMs.', 'RUN_TIMEOUT');
        return Math.min(config.timeoutMs, remaining);
      };
      const run = { name: scenario.name, url: scenario.url, viewport, directory: `run-${String(result.runs.length + 1).padStart(3, '0')}`, outcome: 'blocked', steps: [], blockedRequests: [], consoleErrors: [], pageErrors: [], artifacts: {}, artifactErrors: [], errors: [], beforeScreenshot: 'pending' };
      result.runs.push(run);
      const directory = path.join(destination, run.directory);
      await mkdir(directory);
      let context;
      let page;
      const scriptTasks=[];let scriptBytes=0;
      const nodes = new Map();
      try {
        context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height }, deviceScaleFactor: viewport.dpr, locale: 'en-US', timezoneId: 'UTC', colorScheme: 'light', reducedMotion: 'no-preference', serviceWorkers: 'block', acceptDownloads: false });
        await context.addInitScript(()=>{
          window.__perfkitCspViolations=[];
          document.addEventListener('securitypolicyviolation',e=>{if(window.__perfkitCspViolations.length<100)window.__perfkitCspViolations.push({directive:e.effectiveDirective,blockedURI:e.blockedURI,disposition:e.disposition});});
        });
        if (typeof context.routeWebSocket !== 'function') throw fail('This Playwright version cannot enforce WebSocket blocking; update the externally supplied runtime before scenario execution.', 'WEBSOCKET_BLOCKING_UNAVAILABLE');
        await context.route('**/*', async route => {
          const request = route.request();
          if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method())) {
            run.blockedRequests.push({ method: request.method(), url: request.url(), resourceType: request.resourceType() });
            await route.abort('blockedbyclient');
          } else await route.continue();
        });
        await context.routeWebSocket('**/*', socket => {
          run.blockedRequests.push({ method: 'WEBSOCKET', url: socket.url(), resourceType: 'websocket' });
          socket.close();
        });
        page = await context.newPage();
        page.on('console', message => { if (message.type() === 'error') run.consoleErrors.push({ message: message.text() }); });
        page.on('pageerror', error => run.pageErrors.push({ message: error.message }));
        run.scriptResources=[];run.fetchResources=[];run.resourceCaptureComplete=true;
        let activeStep=-1;
        const scriptRequests=new Map();
        page.on('request',request=>{if(['script','fetch'].includes(request.resourceType())){
          if(scriptRequests.size>=1000){run.resourceCaptureComplete=false;return;}
          const record={url:request.url(),method:request.method(),startedStepIndex:activeStep,status:null,finished:false};
          scriptRequests.set(request,record);(request.resourceType()==='script'?run.scriptResources:run.fetchResources).push(record);
        }});
        page.on('response',response=>{const request=response.request();if(scriptRequests.has(request)){
          const redirects=[];for(let prior=request.redirectedFrom();prior;prior=prior.redirectedFrom())redirects.unshift(prior.url());
          const record=scriptRequests.get(request);if(!record)return;Object.assign(record,{url:response.url(),redirects,status:response.status()});
          scriptTasks.push((async()=>{
            try {
              if(response.status()<200||response.status()>=300)return;
              const error=await response.finished();if(error)return;
              if(Number(response.headers()['content-length'])>2*1024*1024){record.bodyStatus='size-limit';return;}
              const body=await response.body();scriptBytes+=body.length;
              if(body.length>2*1024*1024||scriptBytes>16*1024*1024){record.bodyStatus='size-limit';return;}
              record.bodyHash=createHash('sha256').update(body).digest('hex');
              if(request.resourceType()==='fetch')record.sectionResponse=sectionResponseEvidence(record.url,body.toString('utf8'));
            }catch{record.bodyStatus='unavailable';}
          })());
        }});
        page.on('requestfinished',request=>{const record=scriptRequests.get(request);if(record)record.finished=true;});
        page.on('requestfailed',request=>{const record=scriptRequests.get(request);if(record)record.failed=true;});
        page.on('download', download => {
          run.blockedRequests.push({ method: 'DOWNLOAD', url: download.url(), resourceType: 'download' });
          download.cancel().catch(() => {});
        });
        page.setDefaultTimeout(config.timeoutMs);
        const response = await page.goto(scenario.url, { waitUntil: 'domcontentloaded', timeout: budget() });
        run.navigationStatus = response?.status() ?? null;
        const identity = await page.evaluate(() => ({ themeId: window.Shopify?.theme?.id?.toString() ?? null, store: window.Shopify?.shop ?? null, timeOrigin: performance.timeOrigin }));
        run.themeId = identity.themeId; run.store = identity.store;
        if (config.expectedThemeId !== undefined && config.expectedThemeId !== run.themeId) throw fail('Regression page theme identity mismatch.','THEME_ID_MISMATCH');
        if (response && response.status() >= 400) throw fail(`Navigation returned HTTP ${response.status()}.`, 'NAVIGATION_FAILED');
        if (config.settleMs) {
          if (config.settleMs > budget()) throw fail('settleMs exceeds remaining run time.', 'RUN_TIMEOUT');
          await page.waitForTimeout(config.settleMs);
        }
        run.initialDisclosures=await page.evaluate(()=>[...document.querySelectorAll('details[id]:not([open])')].slice(0,100).map(el=>({id:el.id,
          bodyId:el.querySelector(':scope > div')?.id,descendants:el.querySelector(':scope > div')?.querySelectorAll('*').length??null,
          controllers:Object.getOwnPropertySymbols(document).map(Symbol.keyFor).filter(k=>k?.startsWith('perfkit_hidden_'))})));
        run.initialStylesheets=await page.evaluate(()=>[...document.querySelectorAll('link[rel="stylesheet"]')].slice(0,500).map(el=>({href:el.href,
          roots:(()=>{const roots=[];for(let n=el.parentElement;n;n=n.parentElement)if(n.id&&document.querySelectorAll('#'+CSS.escape(n.id)).length===1)roots.push('#'+CSS.escape(n.id));return roots;})()})));
        if(config.serverRenderedSelectors) {
          run.securityPolicy={complete:true,headers:(await response.headersArray()).filter(h=>h.name.toLowerCase()==='content-security-policy').map(h=>h.value),
            meta:await page.evaluate(()=>[...document.querySelectorAll('meta[http-equiv]')].filter(n=>n.httpEquiv.toLowerCase()==='content-security-policy').map(n=>n.content))};
          run.initialControllers=await page.evaluate(()=>Object.getOwnPropertySymbols(document).filter(s=>Symbol.keyFor(s)?.startsWith('perfkit:initial-liquid:')).map(s=>({key:Symbol.keyFor(s),signature:document[s]?.signature})));
          const noJs=await browser.newContext({javaScriptEnabled:false,viewport:{width:viewport.width,height:viewport.height},deviceScaleFactor:viewport.dpr,
            locale:'en-US',timezoneId:'UTC',colorScheme:'light',reducedMotion:'no-preference',serviceWorkers:'block',acceptDownloads:false});
          try {
            const plain=await noJs.newPage(),document=await plain.goto(scenario.url,{waitUntil:'load',timeout:budget()});
            const body=await bounded(document.body(),budget());
            if(body.length>2*1024*1024||document.status()!==200||plain.url()!==page.url())throw fail('Unverifiable no-JS document.','SSR_DOCUMENT_INVALID');
            await writeFile(path.join(directory,'server-rendered.html'),body,{flag:'wx',mode:0o600});
            run.serverRendered={javascriptEnabled:false,url:plain.url(),documentStatus:document.status(),documentHash:createHash('sha256').update(body).digest('hex'),
              file:`${run.directory}/server-rendered.html`,checkpoints:[]};
            for(const selector of config.serverRenderedSelectors)run.serverRendered.checkpoints.push({selector,observation:await (await unique(plain,selector)).evaluate(checkpointDOM,preservationStyles)});
          }finally{await noJs.close();}
        }
        if (['click','press'].includes(scenario.steps[0].action)) run.beforeScreenshot = scenario.steps[0].action==='click'?'omitted-click-first':'omitted-press-first';
        else {
          await screenshot(page, directory, 'before.png', budget(), run);
          run.beforeScreenshot = run.artifacts.before ? 'captured' : 'unavailable';
        }
        let failed = false;
        for (let index = 0; index < scenario.steps.length; index++) {
          activeStep=index;
          const step = scenario.steps[index];
          const record = { index, ...step, outcome: 'skipped', elapsedMs: 0 };
          run.steps.push(record);
          if (failed) { record.reason = 'Earlier step failed; dependent actions were not executed.'; continue; }
          const stepStarted = performance.now();
          try {
            const next=scenario.steps[index+1];
            if(['click','press'].includes(step.action)&&next?.action.startsWith('assert-'))record.assertionBefore={action:next.action,selector:next.selector,...await bounded(readAssertion(page,next),budget())};
            const timeoutMs = budget();
            // Assertions enforce their own deadline so expiry can retain the last actual
            // value instead of racing an outer generic action-timeout error.
            record.observation = step.action.startsWith('assert-')
              ? await performStep(page, step, nodes, timeoutMs)
              : await bounded(performStep(page, step, nodes, timeoutMs), timeoutMs);
            record.outcome = 'passed';
          } catch (error) {
            failed = true;
            record.outcome = 'failed';
            record.error = { code: error.code ?? 'STEP_FAILED', message: error.message, ...(Object.hasOwn(error, 'expected') ? { expected: error.expected, actual: error.actual } : {}) };
          }
          record.elapsedMs = performance.now() - stepStarted;
        }
        run.finalUrl = page.url();
        run.cspViolations=await page.evaluate(()=>window.__perfkitCspViolations??[]);
        run.sectionScopes=await page.evaluate(()=>[...document.querySelectorAll('[id^="shopify-section-"]')].slice(0,100).map(el=>({id:el.id,selectors:[el,...el.querySelectorAll('[id]')].slice(0,100).filter(n=>document.querySelectorAll('#'+CSS.escape(n.id)).length===1).map(n=>'#'+n.id)})));
        const finalIdentity = await page.evaluate(() => ({ themeId: window.Shopify?.theme?.id?.toString() ?? null, store: window.Shopify?.shop ?? null, timeOrigin: performance.timeOrigin }));
        run.documentStable = finalIdentity.timeOrigin === identity.timeOrigin
          && finalIdentity.themeId === identity.themeId && finalIdentity.store === identity.store;
        run.previewDetection = { pageMarker: await bounded(page.evaluate(() => Boolean(window.__LOCAL_PREVIEW__)), budget()), loopbackUrl: isLocalPreviewUrl(scenario.url) || isLocalPreviewUrl(run.finalUrl) };
        run.localPreview = run.previewDetection.pageMarker || run.previewDetection.loopbackUrl;
      } catch (error) {
        run.errors.push({ code: error.code ?? 'SCENARIO_FAILED', message: error.message });
        for (let index = run.steps.length; index < scenario.steps.length; index++) run.steps.push({ index, ...scenario.steps[index], outcome: 'skipped', reason: 'Scenario setup or navigation failed.', elapsedMs: 0 });
      } finally {
        try{await bounded(Promise.all(scriptTasks),Math.max(1,deadline-performance.now()));}catch{run.errors.push({code:'SCRIPT_CAPTURE_TIMEOUT',message:'Script body capture exceeded the scenario deadline.'});}
        if (page && !page.isClosed()) await screenshot(page, directory, 'after.png', Math.min(config.timeoutMs, 5000), run);
        for (const saved of nodes.values()) await saved.dispose().catch(() => {});
        if (context) await context.close().catch(error => run.errors.push({ code: 'CONTEXT_CLOSE_FAILED', message: error.message }));
      }
      run.assertionOutcome = run.steps.some(step => step.outcome === 'failed') || run.errors.length || run.pageErrors.length ? 'failed' : 'passed';
      run.constrained = run.blockedRequests.length > 0 || run.artifactErrors.length > 0 || run.errors.some(error => error.code === 'WEBSOCKET_BLOCKING_UNAVAILABLE');
      run.outcome = run.constrained ? 'blocked' : run.assertionOutcome;
      run.elapsedMs = performance.now() - runStarted;
      await writeFile(path.join(directory, 'run.json'), `${JSON.stringify(run, null, 2)}\n`, { flag: 'wx' });
    }
    result.outcome = result.runs.some(run => run.outcome === 'failed') ? 'failed' : result.runs.some(run => run.outcome === 'blocked') ? 'blocked' : 'passed';
  } catch (error) {
    result.errors.push({ code: error.code ?? 'SCENARIOS_UNAVAILABLE', message: error.message });
    result.outcome = 'blocked';
  } finally {
    if (browser) await browser.close().catch(error => { result.errors.push({ code: 'BROWSER_CLOSE_FAILED', message: error.message }); result.outcome = 'blocked'; });
  }
  result.summary = { runs: result.runs.length, passed: result.runs.filter(run => run.outcome === 'passed').length, failed: result.runs.filter(run => run.outcome === 'failed').length, blocked: result.runs.filter(run => run.outcome === 'blocked').length, assertionsPassed: result.runs.flatMap(run => run.steps).filter(step => step.action.startsWith('assert-') && step.outcome === 'passed').length, blockedRequests: result.runs.reduce((total, run) => total + run.blockedRequests.length, 0) };
  result.elapsedMs = performance.now() - started;
  if (source) {
    const final = await sourceSnapshot(config.project);
    result.sourceHash = source.hash; result.sourceStable = final.complete && final.hash === source.hash;
    if (!result.sourceStable) { result.outcome = 'blocked'; result.errors.push({ code: 'SOURCE_DRIFT', message: 'Theme changed during regression.' }); }
  }
  result.finishedAt = new Date().toISOString();
  await writeFile(path.join(destination, 'scenario-results.json'), `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' });
  return result;
}
