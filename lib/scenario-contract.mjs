import path from 'node:path';

export const scenarioError = (message, code = 'INVALID_SCENARIO_CONFIG') => Object.assign(new Error(message), { code });
export const normalizeText = value => String(value ?? '').replace(/\s+/g, ' ').trim();

const fields = {
  fill: ['selector','value'], select: ['selector','values'], ime: ['selector','text','commit'],
  click: ['selector', 'times'], press: ['selector','key'], scroll: ['selector'],
  'assert-count': ['selector', 'count'], 'assert-visible': ['selector', 'visible'],
  'assert-text': ['selector', 'text'], 'assert-attribute': ['selector', 'name', 'value'],
  'assert-image-loaded': ['selector'],
  detach: ['selector', 'key'], reconnect: ['key'], dispatch: ['selector', 'event', 'detail'], wait: ['ms'],
  checkpoint: ['selector', 'key'],
};

function object(value, allowed, at) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype) throw scenarioError(`${at} must be a plain object.`);
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw scenarioError(`Unknown field ${at}.${key}. Allowed fields: ${allowed.join(', ')}.`);
  }
}
function integer(value, min, max, at) {
  if (!Number.isInteger(value) || value < min || value > max) throw scenarioError(`${at} must be an integer from ${min} to ${max}.`);
  return value;
}
function string(value, at, { empty = false, max = 2000 } = {}) {
  if (typeof value !== 'string' || (!empty && !value.trim()) || value.length > max) throw scenarioError(`${at} must be ${empty ? 'a' : 'a nonempty'} string of at most ${max} characters.`);
  return value;
}
function url(value, base, at) {
  let result;
  try { result = new URL(value, base); } catch { throw scenarioError(`${at} must resolve to an HTTP(S) URL.`); }
  if (!['http:', 'https:'].includes(result.protocol) || result.username || result.password) throw scenarioError(`${at} must be HTTP(S) without embedded credentials.`);
  return result.href;
}

export function validateScenarioConfig(input) {
  object(input, ['schemaVersion', 'url', 'viewports', 'timeoutMs', 'settleMs', 'runTimeoutMs', 'scenarios', 'project', 'expectedThemeId','serverRenderedSelectors','networkFaults'], 'config');
  const networkFaults=input.networkFaults??[];
  if(!Array.isArray(networkFaults)||networkFaults.length>20)throw scenarioError('At most 20 network faults.');
  for(const fault of networkFaults){
    object(fault,['url','occurrence','delayMs','abort'],'network fault');
    url(fault.url,undefined,'fault.url');integer(fault.occurrence,1,100,'fault.occurrence');
    integer(fault.delayMs??0,0,10000,'fault.delayMs');
    if(fault.abort!==undefined&&typeof fault.abort!=='boolean')throw scenarioError('fault.abort must be boolean.');
  }
  if(new Set(networkFaults.map(f=>f.url+'#'+f.occurrence)).size!==networkFaults.length)throw scenarioError('Duplicate network fault.');
  if(input.serverRenderedSelectors!==undefined&&(!Array.isArray(input.serverRenderedSelectors)||!input.serverRenderedSelectors.length||input.serverRenderedSelectors.length>5
    ||input.serverRenderedSelectors.some(s=>typeof s!=='string'||!/^#[A-Za-z_][\w-]*$/.test(s))||new Set(input.serverRenderedSelectors).size!==input.serverRenderedSelectors.length))throw scenarioError('serverRenderedSelectors requires 1–5 distinct literal id selectors.');
  if (input.schemaVersion !== 1) throw scenarioError('config.schemaVersion must be 1.');
  if (input.project !== undefined && (typeof input.project !== 'string' || !path.isAbsolute(input.project))) throw scenarioError('project must be absolute.');
  if (input.expectedThemeId !== undefined && !/^\d+$/.test(String(input.expectedThemeId))) throw scenarioError('expectedThemeId must be numeric.');
  const baseUrl = input.url === undefined ? undefined : url(string(input.url, 'config.url'), undefined, 'config.url');
  const timeoutMs = integer(input.timeoutMs ?? 10000, 1, 30000, 'config.timeoutMs');
  const settleMs = integer(input.settleMs ?? 0, 0, 10000, 'config.settleMs');
  const runTimeoutMs = integer(input.runTimeoutMs ?? 120000, 1, 300000, 'config.runTimeoutMs');
  const viewports = input.viewports ?? [{ name: 'mobile', width: 390, height: 844 }, { name: 'desktop', width: 1440, height: 900 }];
  if (!Array.isArray(viewports) || viewports.length < 1 || viewports.length > 4) throw scenarioError('Provide between 1 and 4 viewports.');
  const viewportNames = new Set();
  const normalizedViewports = viewports.map((entry, index) => {
    const at = `viewports[${index}]`;
    object(entry, ['name', 'width', 'height', 'dpr'], at);
    const name = string(entry.name, `${at}.name`, { max: 80 });
    if (viewportNames.has(name)) throw scenarioError(`Duplicate viewport name: ${name}.`);
    viewportNames.add(name);
    const width = integer(entry.width, 1, 10000, `${at}.width`);
    const height = integer(entry.height, 1, 10000, `${at}.height`);
    const dpr = entry.dpr ?? 1;
    if (!Number.isFinite(dpr) || dpr < 0.1 || dpr > 5) throw scenarioError(`${at}.dpr must be between 0.1 and 5.`);
    return { name, width, height, dpr };
  });
  if (!Array.isArray(input.scenarios) || input.scenarios.length < 1 || input.scenarios.length > 20) throw scenarioError('Provide between 1 and 20 scenarios.');
  if (input.scenarios.length * viewports.length > 40) throw scenarioError('A configuration may contain at most 40 scenario/viewport runs.');
  const names = new Set();
  const scenarios = input.scenarios.map((entry, index) => {
    const at = `scenarios[${index}]`;
    object(entry, ['name', 'url', 'steps'], at);
    const name = string(entry.name, `${at}.name`, { max: 120 });
    if (names.has(name)) throw scenarioError(`Duplicate scenario name: ${name}.`);
    names.add(name);
    if (entry.url === undefined && !baseUrl) throw scenarioError(`${at} needs a URL or config.url.`);
    const scenarioUrl = entry.url === undefined ? baseUrl : url(string(entry.url, `${at}.url`), baseUrl, `${at}.url`);
    if (!Array.isArray(entry.steps) || entry.steps.length < 1 || entry.steps.length > 100) throw scenarioError(`${at}.steps must contain 1 to 100 steps.`);
    const detached = new Set();
    let waitTotal = settleMs;
    const steps = entry.steps.map((step, stepIndex) => {
      const stepAt = `${at}.steps[${stepIndex}]`;
      if (!step || !Object.hasOwn(fields, step.action)) {
        throw scenarioError(`Unknown action at ${stepAt}.action. Allowed values: ${Object.keys(fields).join(', ')}.`);
      }
      object(step, ['action', ...fields[step.action]], stepAt);
      const normalized = { ...step };
      if (fields[step.action].includes('selector')) normalized.selector = string(step.selector, `${stepAt}.selector`).trim();
      if(step.action==='fill')string(step.value,stepAt+'.value',{empty:true,max:10000});
      if(step.action==='select'&&(!Array.isArray(step.values)||step.values.length>100||step.values.some(v=>typeof v!=='string')))throw scenarioError('select.values must be strings.');
      if(step.action==='ime'){string(step.text,stepAt+'.text',{max:1000});if(typeof step.commit!=='boolean')throw scenarioError('ime.commit must be explicit.');}
      if (step.action === 'click') normalized.times = integer(step.times ?? 1, 1, 20, `${stepAt}.times`);
      if (step.action === 'press') normalized.key = string(step.key, `${stepAt}.key`, {max:80});
      if (step.action === 'assert-count') integer(step.count, 0, 10000, `${stepAt}.count`);
      if (step.action === 'assert-visible') {
        normalized.visible = step.visible ?? true;
        if (typeof normalized.visible !== 'boolean') throw scenarioError(`${stepAt}.visible must be boolean.`);
      }
      if (step.action === 'assert-text') string(step.text, `${stepAt}.text`, { empty: true, max: 10000 });
      if (step.action === 'assert-attribute') {
        string(step.name, `${stepAt}.name`, { max: 200 });
        if (step.value !== null) string(step.value, `${stepAt}.value`, { empty: true, max: 10000 });
      }
      if (step.action === 'detach' || step.action === 'reconnect') {
        string(step.key, `${stepAt}.key`, { max: 100 });
        if (step.action === 'detach') {
          if (detached.has(step.key)) throw scenarioError(`${stepAt}: key already detached: ${step.key}.`);
          detached.add(step.key);
        } else {
          if (!detached.has(step.key)) throw scenarioError(`${stepAt}: reconnect requires an earlier unmatched detach: ${step.key}.`);
          detached.delete(step.key);
        }
      }
      if (step.action === 'dispatch') {
        if (!['shopify:section:load', 'shopify:section:unload'].includes(step.event)) throw scenarioError(`${stepAt}.event must be shopify:section:load or shopify:section:unload.`);
        if (step.detail !== undefined) {
          object(step.detail, ['sectionId'], `${stepAt}.detail`);
          if (step.detail.sectionId !== undefined) string(step.detail.sectionId, `${stepAt}.detail.sectionId`, { max: 200 });
        }
      }
      if (step.action === 'wait') waitTotal += integer(step.ms, 0, 10000, `${stepAt}.ms`);
      if (step.action === 'checkpoint') string(step.key,`${stepAt}.key`,{ max: 100 });
      return normalized;
    });
    if (waitTotal > 60000) throw scenarioError(`${at} contains more than 60000 ms of explicit waiting.`);
    if (!steps.some(step => step.action.startsWith('assert-'))) throw scenarioError(`${at} needs at least one explicit assertion; actions alone do not establish acceptance.`);
    return { name, url: scenarioUrl, steps };
  });
  return { schemaVersion: 1, ...(networkFaults.length?{networkFaults}:{}), ...(baseUrl ? { url: baseUrl } : {}), ...(input.project ? { project: input.project } : {}), ...(input.expectedThemeId !== undefined ? { expectedThemeId: String(input.expectedThemeId) } : {}), ...(input.serverRenderedSelectors?{serverRenderedSelectors:[...input.serverRenderedSelectors]}:{}),viewports: normalizedViewports, timeoutMs, settleMs, runTimeoutMs, scenarios };
}

export const assertionExpected = step => step.action === 'assert-image-loaded' ? true : step.action === 'assert-count' ? step.count : step.action === 'assert-visible' ? step.visible : step.action === 'assert-text' ? normalizeText(step.text) : step.value;
export { string as validateScenarioString };
