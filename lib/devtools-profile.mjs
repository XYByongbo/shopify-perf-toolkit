import { configValue, fields } from './evidence-contract.mjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createRequire } from 'node:module';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createRunDirectory } from './measure.mjs';
import { browserExecutable } from './runtime-profile.mjs';
const require = createRequire(import.meta.url);
const texts = result => (result.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('\n');
export function validateDevtoolsConfig(config) {
  fields(config, ['schemaVersion','url','timeoutMs','device'], 'DevTools profile');
  if (config.schemaVersion !== 1) throw configValue('config.schemaVersion', '1');
  let url;
  try { url = new URL(config.url); } catch { throw configValue('url', 'an HTTP(S) URL without credentials'); }
  if (!['http:','https:'].includes(url.protocol) || url.username || url.password) throw configValue('url', 'an HTTP(S) URL without credentials');
  const timeoutMs = config.timeoutMs ?? 60000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120000) throw configValue('timeoutMs', 'an integer from 1000 to 120000');
  if (config.device && !['mobile','desktop'].includes(config.device)) throw configValue('device', 'mobile or desktop');
  return {url, timeoutMs};
}

export async function profileDevtools({ config, output } = {}) {
  const {url, timeoutMs} = validateDevtoolsConfig(config);
  const out = await createRunDirectory(output), started = Date.now();
  const result = { schemaVersion: 1, kind: 'devtools-profile', status: 'running', config, tools: [], insights: [],
    limitations: ['Chrome DevTools diagnostics are instrumented; use independent Lighthouse samples for acceptance.', 'This adapter launches its own isolated browser. It never attaches to existing user tabs.'] };
  const bin = path.join(path.dirname(require.resolve('chrome-devtools-mcp')), 'bin/chrome-devtools-mcp.js');
  const transport = new StdioClientTransport({ command: process.execPath, args: [bin, '--headless', '--isolated', '--workspace', out, '--executablePath', await browserExecutable(), '--no-usage-statistics', '--no-performance-crux'],
    stderr: 'pipe', cwd: out, env: { ...process.env, CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS: '1' } });
  const client = new Client({ name: 'shopify-perf-toolkit', version: '0.9.0' });
  const remaining = () => Math.max(1, timeoutMs - (Date.now() - started));
  const timer = setTimeout(() => { void transport.close(); }, timeoutMs);
  try {
    await client.connect(transport, { timeout: remaining() });
    // Drain diagnostics without storing arbitrary page text, tokens or browser logs.
    transport.stderr?.on('data', () => {});
    const { tools } = await client.listTools({}, { timeout: remaining() }); result.tools = tools.map(t => t.name);
    const call = async (name, args) => {
      if (!result.tools.includes(name)) throw new Error(`Pinned DevTools server lacks ${name}.`);
      const response = await client.callTool({ name, arguments: args }, undefined, { timeout: remaining() });
      if (response.isError) throw new Error(`${name} failed: ${texts(response).slice(0,1000)}`);
      const text = texts(response); if (text.length > 2 * 1024 * 1024) throw new Error('DevTools text exceeds limit.'); return text;
    };
    const opened = await call('new_page', { url: url.href, background: true, isolatedContext: 'perfkit', timeout: Math.min(30000, remaining()) });
    const match = [...opened.matchAll(/(?:^|\n)(\d+):\s+(https?:\/\/\S+)/g)].find(m => m[2].replace(/\s.*$/, '') === url.href) ?? [...opened.matchAll(/(?:^|\n)(\d+):\s+/g)].at(-1);
    if (!match) throw new Error('Cannot identify the isolated page from new_page response.');
    const pageId = Number(match[1]);
    if (config.device === 'mobile') await call('emulate', { pageId, viewport: '390x844x3,mobile,touch', cpuThrottlingRate: 4, networkConditions: 'Fast 4G' });
    result.trace = await call('performance_start_trace', { pageId, reload: true, autoStop: true, ignoreCache: true, filePath: path.join(out, 'trace.json.gz') });
    const setIds = [...new Set([...result.trace.matchAll(/insight\s*set\s*(?:id)?\s*[:=]\s*[`"']?([\w-]+)/gi)].map(m => m[1]))];
    for (const insightSetId of setIds.slice(0, 3)) for (const insightName of ['LCPBreakdown','DocumentLatency','RenderBlocking','LCPDiscovery']) {
      if (!result.trace.includes(insightName)) continue;
      result.insights.push({ insightSetId, insightName, text: await call('performance_analyze_insight', { pageId, insightSetId, insightName }) });
    }
    result.insightStatus = result.insights.length ? 'inspected' : 'unavailable-in-trace';
    result.status = 'complete';
  } catch (error) { result.status = 'failed'; result.error = error.message; }
  finally { clearTimeout(timer); await client.close().catch(() => {}); await transport.close().catch(() => {}); }
  await writeFile(path.join(out, 'devtools.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return result;
}
