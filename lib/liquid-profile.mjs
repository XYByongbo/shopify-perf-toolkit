import { readFile, stat } from 'node:fs/promises';
import { sourceSnapshot, sha256 } from './runtime-profile.mjs';
import { runProcess } from './bounded-process.mjs';
import { indexThemeSources, pathsToSource } from './source-attribution.mjs';
const factors = { seconds: 1000, milliseconds: 1, microseconds: 0.001, nanoseconds: 0.000001 };
export function analyzeLiquidProfile(data, snapshot, sourceIndex = null) {
  if (!data || !Array.isArray(data.shared?.frames) || !Array.isArray(data.profiles) || !data.profiles.length) throw new Error('Expected a Speedscope profile with shared.frames and profiles.');
  const frames = data.shared.frames, rows = new Map(), profiles = [];
  const add = (stack, weight) => {
    if (!Number.isFinite(weight) || weight < 0) throw new Error('Invalid profiler sample weight.');
    for (const index of new Set(stack)) {
      if (!Number.isInteger(index) || !frames[index]) throw new Error('Unknown profiler frame.');
      const row = rows.get(index) ?? { selfMs: 0, inclusiveMs: 0, samples: 0, callers:new Set() };
      const at=stack.indexOf(index);if(at>0)row.callers.add(stack[at-1]);
      row.inclusiveMs += weight; row.samples++; rows.set(index, row);
    }
    if (stack.length) rows.get(stack.at(-1)).selfMs += weight;
  };
  for (const profile of data.profiles) {
    const factor = factors[profile.unit]; if (!factor) throw new Error('Liquid time profiles require time units; bytes/none are not milliseconds.');
    if (!Number.isFinite(profile.startValue) || !Number.isFinite(profile.endValue) || profile.endValue < profile.startValue) throw new Error('Invalid profile bounds.');
    if (profile.type === 'evented') {
      if (!Array.isArray(profile.events)) throw new Error('Evented profile lacks events.');
      const stack = []; let previous = profile.startValue;
      for (const event of profile.events) {
        if (!Number.isFinite(event.at) || event.at < previous || event.at > profile.endValue || !frames[event.frame]) throw new Error('Invalid event ordering or frame.');
        add(stack, (event.at - previous) * factor); previous = event.at;
        if (event.type === 'O') stack.push(event.frame);
        else if (event.type !== 'C' || stack.pop() !== event.frame) throw new Error('Unbalanced Speedscope frame stack.');
      }
      if (stack.length) throw new Error('Incomplete Speedscope frame stack.');
    } else if (profile.type === 'sampled') {
      if (!Array.isArray(profile.samples) || !Array.isArray(profile.weights) || profile.samples.length !== profile.weights.length) throw new Error('Sampled profiles need a weight for every sample.');
      if(Math.abs(profile.weights.reduce((sum,n)=>sum+n,0)-(profile.endValue-profile.startValue))>Math.max(0.001,(profile.endValue-profile.startValue)*0.001))throw new Error('Sample weights do not cover the declared profile duration.');
      profile.samples.forEach((stack, i) => { if (!Array.isArray(stack)) throw new Error('Invalid sampled stack.'); add(stack, profile.weights[i] * factor); });
    } else throw new Error('Unsupported Speedscope profile type.');
    profiles.push({ name: profile.name, durationMs: (profile.endValue - profile.startValue) * factor });
  }
  const hotspots = [...rows].map(([index, cost]) => {
    const frame = frames[index];
    const location = String(frame.file ?? frame.name).match(/(?:^|[\s(/])((?:sections|snippets|layout|templates|blocks)\/[\w./-]+\.liquid)(?::(\d+))?/);
    const file = location?.[1], local = snapshot?.files.find(x => x.file === file);
    const callers=[...cost.callers].map(i=>{const f=frames[i],m=String(f.file??f.name).match(/(?:^|[\s(/])((?:sections|snippets|layout|templates|blocks)\/[\w./-]+\.liquid)(?::(\d+))?/);return {name:f.name,file:m?.[1]??null,line:f.line??(m?.[2]?Number(m[2]):null)};});
    const hotspot = { selfMs:cost.selfMs,inclusiveMs:cost.inclusiveMs,samples:cost.samples,callers, name: frame.name, file: file ?? null, line: frame.line ?? (location?.[2] ? Number(location[2]) : null),
      sourceHash: local?.sourceHash ?? null, association: local ? 'candidate-requires-deployment-proof' : 'unmapped' };
    // Enhanced: when sourceIndex is available, attempt to verify the file exists in the current source graph
    if (sourceIndex && file) {
      const graphFile = sourceIndex.files.find(f => f.file === file);
      if (graphFile) {
        hotspot.sourceGraphVerified = true;
        hotspot.sourceGraphHash = graphFile.sourceHash;
        // Attempt to find render/include paths to this file
        try {
          const paths = pathsToSource(sourceIndex, file, 5);
          if (paths.length) hotspot.renderPaths = paths;
        } catch {}
      }
    }
    return hotspot;
  }).sort((a, b) => b.selfMs - a.selfMs);
  return { profiles, hotspots, totalSelfMs: hotspots.reduce((n, x) => n + x.selfMs, 0) };
}
export async function profileLiquid({ config, dependencies = {} } = {}) {
  if (!config || config.schemaVersion !== 1 || Object.keys(config).some(k => !['schemaVersion','project','input','store','themeId','urlPath','timeoutMs'].includes(k))) throw new Error('Invalid Liquid profile config.');
  if (Boolean(config.input) === Boolean(config.store)) throw new Error('Supply either a Speedscope input or a Shopify store.');
  const snapshot = await sourceSnapshot(config.project), startedAt = new Date().toISOString(); let text,collector=null;
  if (config.input) { if ((await stat(config.input)).size > 32 * 1024 * 1024) throw new Error('Liquid profile exceeds 32 MiB.'); text = await readFile(config.input, 'utf8'); }
  else {
    if (!/^[\w-]+\.myshopify\.com$/.test(config.store) || !/^\d+$/.test(String(config.themeId)) || typeof config.urlPath !== 'string' || !config.urlPath.startsWith('/') || config.urlPath.startsWith('//')) throw new Error('Explicit myshopify store, numeric themeId and relative urlPath are required.');
    const run = dependencies.runProcess ?? runProcess, timeoutMs = config.timeoutMs ?? 60000;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120000) throw new Error('Invalid profile timeout.');
    const cli = process.env.PERF_KIT_SHOPIFY_CLI || 'shopify', started = Date.now();
    const version=await run(cli,['version'],{timeoutMs:Math.min(10000,timeoutMs)});
    if(version.code!==0||!/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(version.stdout?.trim()))throw new Error('Cannot establish Shopify CLI version for comparable Liquid sampling.');
    collector={kind:'shopify-cli',version:version.stdout.trim()};
    const helpBudget=timeoutMs-(Date.now()-started);if(helpBudget<=0)throw new Error('Liquid profile time budget exhausted during version detection.');
    const help = await run(cli, ['theme','profile','--help'], { timeoutMs: Math.min(15000, helpBudget) });
    const urlFlag = /--urlpath\b/.test(help.stdout) ? '--urlpath' : /--url\b/.test(help.stdout) ? '--url' : null;
    if (help.code !== 0 || !urlFlag || !/--json(?:[\s,=]|$)/.test(help.stdout)) throw new Error('Installed Shopify CLI does not expose theme profile URL/JSON support.');
    const remaining = timeoutMs - (Date.now() - started); if (remaining <= 0) throw Object.assign(new Error('Liquid profile time budget exhausted.'), { code: 'WALL_TIME_BUDGET' });
    const result = await run(cli, ['theme','profile','--store',config.store,'--theme',String(config.themeId),urlFlag,config.urlPath,'--json','--no-color',
      ...(/--no-input\b/.test(help.stdout) ? ['--no-input'] : [])], { timeoutMs: remaining, env: { CI: '1', SHOPIFY_CLI_NO_ANALYTICS: '1' } });
    if (result.code !== 0) throw Object.assign(new Error('Shopify Liquid profiling failed. Complete Shopify CLI login in the local terminal and retry; no profile was fabricated.'), { code: 'LIQUID_PROFILE_UNAVAILABLE' });
    text = result.stdout;
  }
  if (Buffer.byteLength(text) > 32 * 1024 * 1024) throw new Error('Liquid profile exceeds 32 MiB.');
  const data = JSON.parse(text), current = await sourceSnapshot(config.project);
  // Build source index for enhanced hotspot-to-source association
  let sourceIndex = null;
  try { sourceIndex = await indexThemeSources(config.project); } catch {}
  return { schemaVersion: 1, kind: 'liquid-profile', startedAt, finishedAt: new Date().toISOString(), project: snapshot.project,
    status: snapshot.complete && current.hash === snapshot.hash ? 'complete' : 'source-drift', sourceSnapshot: snapshot,
    evidence: { inputHash: sha256(text), rawProfileHash:sha256(JSON.stringify(data)),collector,origin: config.input ? 'imported-speedscope' : 'shopify-cli', store: config.store ?? null, themeId: config.themeId ?? null, urlPath: config.urlPath ?? null },
    ...analyzeLiquidProfile(data, snapshot, sourceIndex), rawProfile: data,
    limitations: ['Liquid server time is not browser LCP or an additive Lighthouse score saving.', 'Imported profile file/line matches require independently verified deployed source. Inclusive frame times overlap.',
      'Source graph verification confirms file existence in current source; it does not prove the deployed theme matches.'] };
}
