import { configValue, fields } from './evidence-contract.mjs';
import {normalizeThemeCheck,themeCheckEnvironment} from './theme-check-transport.mjs';
import { sha256 as hash } from './source-utils.mjs';
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { scanTheme } from './scan.mjs';
import { readThemeSource, importCheck } from './check-import.mjs';
import { runProcess } from './bounded-process.mjs';
import { analyzeLiquidStructure } from './liquid-structure.mjs';

const rules = ['LiquidComplexity','LiquidNestingDepth'];
export function validatePrecheck(config = {}) {
  fields(config, ['maxComplexity','maxDepth','timeoutMs'], 'precheck');
  const value = { maxComplexity:120, maxDepth:10, timeoutMs:120000, ...config };
  for (const k of ['maxComplexity','maxDepth']) {
    if (!Number.isSafeInteger(value[k]) || value[k] < 1 || value[k] > 100000) throw configValue('precheck.'+k, 'an integer from 1 to 100000');
  }
  if (!Number.isInteger(value.timeoutMs) || value.timeoutMs < 1000 || value.timeoutMs > 600000) throw configValue('precheck.timeoutMs', 'an integer from 1000 to 600000');
  return value;
}

/** Resolve existing parent symlinks before allowing output outside the theme. */
export async function assertPrecheckOutput(project, output) {
  if (!output) return;
  const root = await realpath(project), suffix = [];
  let current = path.resolve(output), resolved;
  for (;;) {
    try { resolved = path.join(await realpath(current),...suffix); break; }
    catch (error) { if (error.code !== 'ENOENT') throw error; suffix.unshift(path.basename(current)); current=path.dirname(current); }
  }
  const relative = path.relative(root,resolved);
  if (!relative || relative !== '..' && !relative.startsWith('..'+path.sep) && !path.isAbsolute(relative)) throw new Error('Precheck output must be outside the theme directory.');
}

/** Run only the two official checks on a temporary source snapshot. No theme writes. */
export async function precheckTheme({ project, config = {}, dependencies = {} } = {}) {
  const options = validatePrecheck(config), started = Date.now(), scan = await scanTheme({project});
  const sourceManifest = scan.inventory.files.map(f => ({file:f.path, sourceHash:f.sha256}));
  const sources = new Map(), files = [], issues = [], commands = [];
  const selected = scan.inventory.files.filter(f => ['liquid','json'].includes(f.kind));
  await assertPrecheckOutput(scan.project,path.join(tmpdir(),'perfkit-precheck-probe'));
  const staging = await mkdtemp(path.join(tmpdir(),'perfkit-precheck-'));
  const snapshot = path.join(staging,'theme'), configPath = path.join(staging,'checks.yml');
  const requested = `extends: theme-check:nothing\nLiquidComplexity:\n  enabled: true\n  severity: warning\n  maxComplexity: ${options.maxComplexity}\nLiquidNestingDepth:\n  enabled: true\n  severity: warning\n  maxDepth: ${options.maxDepth}\n`;
  const cli = process.env.PERF_KIT_SHOPIFY_CLI || 'shopify';
  const execute = async args => {
    const remaining = options.timeoutMs - (Date.now()-started);
    if (remaining < 1) throw Object.assign(new Error('Precheck deadline reached.'),{code:'WALL_TIME_BUDGET'});
    const result = await (dependencies.runProcess ?? runProcess)(cli,args,{cwd:staging,timeoutMs:remaining,
      env:themeCheckEnvironment()});
    commands.push({args,exitCode:result.code,stderr:result.stderr,stdout:result.stdout});
    return result;
  };
  let cliVersion, checkerVersion, effective, raw;
  try {
    await mkdir(snapshot);
    for (const f of selected) {
      const {source} = await readThemeSource(scan.project,f.path,f.sha256); sources.set(f.path,source);
      await mkdir(path.dirname(path.join(snapshot,f.path)),{recursive:true}); await writeFile(path.join(snapshot,f.path),source,{flag:'wx'});
      if (f.kind === 'liquid') {
        try { files.push({file:f.path,sourceHash:f.sha256,...analyzeLiquidStructure(source,options)}); }
        catch (error) { issues.push({file:f.path,reason:'structure-parser-unavailable',detail:error.message}); }
      }
    }
    await writeFile(configPath,requested,{flag:'wx'});
    const base = ['theme','check','--path',snapshot,'--config',configPath,'--no-color','--no-input'];
    const version = await execute(['version']);
    const checker = await execute([...base,'--version']);
    if (version.code !== 0 || checker.code !== 0 || !/\d+\.\d+\.\d+/.test(version.stdout) || !/\d+\.\d+\.\d+/.test(checker.stdout)) throw new Error('Shopify CLI / Theme Check version unavailable.');
    cliVersion = version.stdout.trim(); checkerVersion = checker.stdout.trim();
    const printed = await execute([...base,'--print']); effective = printed.stdout;
    if (printed.code !== 0) throw new Error('Unable to read effective Theme Check configuration.');
    for (const [rule,key] of [['LiquidComplexity','maxComplexity'],['LiquidNestingDepth','maxDepth']]) {
      const block = effective.match(new RegExp(`^${rule}:\\n((?:[ \\t]+[^\\n]*\\n?)+)`,'m'))?.[1] ?? '';
      if (!/enabled: true/.test(block) || !new RegExp(`${key}: ${options[key]}(?:\\s|$)`).test(block)) throw new Error(`Installed Theme Check does not enable ${rule} with the requested threshold.`);
    }
    const checked = await execute([...base,'--output','json','--fail-level','warning']);
    if (![0,1].includes(checked.code)) throw new Error('Theme Check failed; no clean precheck result was inferred.');
    raw = JSON.parse(checked.stdout);
    const normalized = normalizeThemeCheck(raw).groups;
    if (normalized.some(g => !Array.isArray(g.offenses) || g.offenses.some(o => !rules.includes(o.check)))) throw new Error('Unexpected Theme Check JSON or rule scope.');
    if (checked.code === 1 && !normalized.some(g => g.offenses.length)) throw new Error('Theme Check failed without diagnostics.');
    for (const f of selected) if (hash(await readFile(path.join(snapshot,f.path))) !== f.sha256) throw new Error('Checker changed the temporary snapshot; report rejected.');
  } catch (error) {
    error.precheck = {kind:'precheck-failure',commands,requestedConfiguration:requested,cliVersion,checkerVersion};
    throw error;
  } finally { await rm(staging,{recursive:true,force:true}); }
  const end = await scanTheme({project:scan.project});
  if (JSON.stringify(sourceManifest) !== JSON.stringify(end.inventory.files.map(f => ({file:f.path,sourceHash:f.sha256})))) throw new Error('Theme source changed during precheck.');
  const metadata = {tool:'Shopify Theme Check',toolVersion:checkerVersion,cliVersion,sourceRoot:snapshot,positionBase:0,severityMap:{0:'error',1:'warning',2:'info'},
    scope:'precheck-two-rules-frozen-liquid-json-snapshot',scannedFiles:selected.map(f=>f.path),sourceHashes:Object.fromEntries(selected.map(f=>[f.path,f.sha256])),
    rulesConfig:{requestedConfiguration:requested,effectiveConfiguration:effective.replace(/^rootUri:.*$/m,'rootUri: <snapshot>')},complete:scan.complete && issues.length === 0};
  const checks = await importCheck({project:scan.project,input:raw,metadata});
  const byFile = new Map(files.map(f=>[f.file,f]));
  // Compare diagnostics with local explanatory metrics; suppressions/parser drift stay visible.
  for (const file of files) {
    const reported = checks.findings.filter(f=>f.file===file.file);
    const c = reported.filter(f=>f.ruleId==='LiquidComplexity');
    const n = reported.filter(f=>f.ruleId==='LiquidNestingDepth');
    if (c.length !== Number(file.complexity > options.maxComplexity) || n.length !== file.exceedingPaths.length
      || c.some(f=>!f.summary.includes(`complexity is ${file.complexity},`))
      || n.some(f=>!file.exceedingPaths.some(p=>p.line===f.line && p.column===f.evidence.original.column && f.summary.includes(`nested ${p.depth} levels deep`)))) issues.push({file:file.file,reason:'official-and-explanatory-results-differ',detail:'Check inline suppression, parser version and rule behavior; no diagnostic is discarded.'});
  }
  const edges = scan.dependencies.filter(e=>e.status==='resolved');
  const owner = file => {
    const visited = new Set([file]), queue = [file];
    for (let i=0;i<queue.length;i++) for (const e of edges) if(e.to===queue[i]&&!visited.has(e.from)){visited.add(e.from);queue.push(e.from);}
    const pagefly = queue.filter(f=>/pagefly|(?:^|\/)pf-/i.test(f)||/pagefly/i.test(sources.get(f)??''));
    const generated = /auto.?generated|automatically generated|do not (?:edit|modify)|booster seo/i.test((sources.get(file)??'').slice(0,2500));
    return {directCallers:edges.filter(e=>e.to===file).map(e=>e.from),upstreamFiles:queue.slice(1),pageflyCandidates:pagefly,generatedMarker:generated,
      status:'static-candidate',note:'静态引用不证明页面实际启用；动态 include、App 注入与 PageFly 再发布覆盖需人工核对。'};
  };
  const findings = checks.findings.map(f=>{const metrics=byFile.get(f.file);return {...f,column:f.evidence.original.column,dimension:'architecture',category:'maintainability',
    actual:Number(f.summary.match(f.ruleId==='LiquidComplexity'?/complexity is (\d+)/:/nested (\d+) levels deep/)?.[1]) || null,
    explanatoryActual:f.ruleId==='LiquidComplexity'?metrics?.complexity:metrics?.exceedingPaths.find(p=>p.line===f.line&&p.column===f.evidence.original.column)?.depth,
    threshold:f.ruleId==='LiquidComplexity'?options.maxComplexity:options.maxDepth,
    nestingPath:f.ruleId==='LiquidNestingDepth'?metrics?.exceedingPaths.find(p=>p.line===f.line&&p.column===f.evidence.original.column)?.path:undefined,
    review:{status:'not-reviewed',hints:metrics?.hints??[],recommendation:metrics?.recommendation,impact:owner(f.file)},
    verification:['核对条件等价性、Liquid render 参数与作用域。','按真实模板配置验证功能、PageFly 与主题编辑器；性能影响另做 Liquid profiling 和页面前后测量。']};});
  const complete = checks.complete && end.complete && issues.length===0;
  if (!complete) { checks.complete=false; checks.metadata.complete=false; checks.issues.push(...issues); }
  return {schemaVersion:1,kind:'theme-precheck',project:scan.project,complete,status:complete?'complete':'partial',reviewRequired:!complete||findings.length>0,
    startedAt:new Date(started).toISOString(),finishedAt:new Date().toISOString(),sourceManifest,thresholds:{maxComplexity:options.maxComplexity,maxDepth:options.maxDepth},
    findings,files,issues,checks,checker:{cliVersion,checkerVersion,commands,requestedConfiguration:requested,effectiveConfiguration:effective,rawReport:raw},
    summary:{liquidFiles:files.length,unparsedFiles:issues.filter(i=>i.reason==='structure-parser-unavailable').length,
      complexity:findings.filter(f=>f.ruleId==='LiquidComplexity').length,nesting:findings.filter(f=>f.ruleId==='LiquidNestingDepth').length},
    limitations:['仅检查两项维护性规则，不是全量 Theme Check 或性能验收。','使用独立预检配置和临时源码副本；不继承主题 ignore/禁用项，默认阈值 120/10 可显式配置。',
      '官方告警与本地 AST 解释分别保存；解析失败或抑制差异会标记未完成。','条件合并、必要分支、snippet 拆分与 App/PageFly 归属均为待人工复核建议，不自动改写源码。']};
}
