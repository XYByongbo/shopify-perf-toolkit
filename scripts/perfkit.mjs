#!/usr/bin/env node
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = path.dirname(fileURLToPath(import.meta.url));
const { version } = JSON.parse(await fs.readFile(path.join(here, '../package.json'), 'utf8'));
const specs = {
  'request-implementation':['previous','candidate','files','out'],
  'plan-custom':['request','candidate','out'],
  'sync-shopify-docs':['config','out'],
  'shopify-methods':['sources','topic','out'],
  'plan-official':['project','config','diagnosis','profiles','sources','out'],
  improve: ['config','out'],
  'improve-cycle': ['config','out'],
  doctor: [],
  'import-field': ['input','out'],
  'audit-stylesheets': ['project','out'],
  'attribute-apps': ['profiles','owners','out'],
  'measure-interactions': ['config','out'],
  'verify-interactions': ['config','out'],
  'ci-check': ['config','out'],
  'source-graph': ['project', 'out'],
  'diagnose-performance': ['project', 'profiles', 'run', 'liquid', 'field', 'owners', 'goal', 'limit', 'checks', 'ownership', 'performance-baseline', 'out'],
  'plan-demand': ['project', 'config', 'diagnosis', 'profiles', 'out'],
  'plan-domain': ['project', 'config', 'diagnosis', 'profiles', 'out'],
  'profile-domain': ['config', 'out'],
  'experiment-liquid': ['config', 'out'],
  'verify-patch': ['config', 'out'],
  'verify-preservation': ['config', 'out'],
  experiment: ['config', 'out'],
  'code-strategies': ['out'],
  'analyze-code': ['project', 'target', 'out'],
  'profile-runtime': ['config', 'out'],
  'profile-devtools': ['config', 'out'],
  'profile-liquid': ['config', 'out'],
  'verify-deployment': ['config', 'out'],
  'verify-gain': ['before', 'after', 'goal', 'out'],
  'verify-optimization': ['config', 'out'],
  'plan-split': ['project', 'config', 'out'],
  optimize: ['config', 'out'],
  'report-pdf': ['config', 'out'],
  scan: ['project', 'pages', 'out'],
  precheck: ['project', 'config', 'out'],
  'check-performance': ['project', 'config', 'out'],
  'audit-performance': ['project', 'profiles', 'baseline', 'checks', 'ownership', 'out'],
  'import-check': ['project', 'input', 'metadata', 'baseline', 'out'],
  'audit-resources': ['project', 'probe', 'out'],
  'plan-resource-repair':['project','config','profile','out'],
  'verify-resource-repair':['config','out'],
  'audit-quality': ['project', 'checks', 'out'],
  'audit-html': ['input', 'fragment', 'lcp-id', 'out'],
  map: ['project', 'target', 'capture', 'out'],
  scenarios: ['config', 'out'],
  measure: ['config', 'out', 'progress'],
  batch: ['config','out'],
  summarize: ['run','out'],
  'evaluate-iteration': ['config','out'],
  'audit-site': ['project', 'run', 'checks', 'official', 'resources', 'runtime', 'precheck', 'ownership', 'performance-baseline', 'html-audits', 'out'],
  'plan-site': ['project', 'recipe', 'out'],
  'verify-site': ['before', 'after', 'thresholds', 'out'],
  inspect: ['project', 'target', 'capture', 'out'],
  'plan-image': ['project', 'target', 'inspection', 'image', 'sizes', 'widths', 'out'],
  'plan-component': ['project', 'target', 'replacement', 'rule', 'reason', 'validators', 'out'],
  apply: ['project', 'plan', 'out'],
  rollback: ['project', 'plan', 'out'],
  capture: ['url', 'selector', 'out', 'width', 'height', 'dpr', 'wait-ms', 'timeout-ms', 'project', 'target'],
  verify: ['before', 'after', 'out'],
  report: ['input', 'out'],
  lighthouse: ['before', 'after', 'out'],
  'score-target': ['before', 'after', 'minimum', 'target', 'out'],
};
const help = `Shopify Perf Toolkit ${version} (Node 22+, offline core)
  request-implementation --previous <session.json> --candidate <candidateId> [--files <paths.json>] --out <request.json>
  plan-custom --request <request.json> --candidate <implementation.json> --out <plan.json>
  sync-shopify-docs [--config <bounded-sync.json>] --out <NEW-directory>
  shopify-methods [--sources <refreshed-sources.json>] [--topic <images|liquid|css|fonts|javascript|apps|delivery|mobile|measurement|platform|external>] [--out <methods.json>]
  plan-official --project <theme> --config <official-method.json> --diagnosis <diagnosis.json> [--profiles <profile-paths.json>] [--sources <sources.json>] --out <plan.json>
  improve --config <start-or-resume-step.json> --out <NEW-directory>
  improve-cycle --config <reviewed-recovery-options.json> --out <NEW-directory>
  doctor
  import-field --input <normalized-export.json|summary.csv|crux.json> --out <field.json>
  audit-stylesheets --project <theme> --out <stylesheet-audit.json>
  attribute-apps --profiles <profile-paths.json> [--owners <reviewed-owners.json>] --out <apps.json>
  measure-interactions --config <interaction-measurement.json> --out <NEW-directory>
  verify-interactions --config <interaction-comparison.json> --out <interaction-gain.json>
  ci-check --config <explicit-baseline-and-candidate.json> --out <ci.json>
  source-graph --project <theme> --out <graph.json>
  diagnose-performance --project <theme> --profiles <profile-paths.json> [--run <run>] [--liquid <profile.json>] [--field <field.json>] [--owners <owners.json>] [--goal <goal.json>] [--checks <check-import.json>] [--ownership <ownership.json>] [--performance-baseline <performance.json>] [--limit <1..20>] --out <diagnosis.json>
  plan-demand --project <theme> --config <demand.json> --diagnosis <diagnosis.json> [--profiles <profile-paths.json>] --out <plan.json>
  plan-domain --project <theme> --config <domain-plan.json> --diagnosis <diagnosis.json> [--profiles <profile-paths.json>] --out <plan.json>
  profile-domain --config <domain-profile.json> --out <new-directory>
  experiment-liquid --config <liquid-pair.json> --out <new-directory>
  experiment --config <single-patch-experiment.json> --out <NEW-directory>
  verify-patch --config <patch-evidence.json> --out <decision.json>
  verify-preservation --config <checkpoint-evidence.json> --out <preservation.json>
  profile-runtime --config <runtime.json> --out <NEW-directory>
  profile-devtools --config <devtools.json> --out <NEW-directory>
  profile-liquid --config <liquid-profile.json> --out <profile.json>
  verify-deployment --config <deployment-with-pages.json> --out <proof.json>
  verify-gain --before <run> --after <run> [--goal <goal.json>] --out <gain.json>
  verify-optimization --config <verification.json> --out <decision.json>
  plan-split --project <theme> --config <split.json> --out <plan.json>
  optimize --config <prepare-apply-or-verify.json> --out <NEW-directory>
  report-pdf --config <report-config.json> --out <new-absolute-directory>
  code-strategies [--out <strategies.json>]
  analyze-code --project <theme> --target <relative-JS-CSS-Liquid-file> --out <code-analysis.json>
  scan --project <theme> [--pages <URLs.json>] --out <site-scan.json>
  batch --config <batch.json> --out <NEW-directory>
  summarize --run <measurement-directory> [--out <summary.json>]
  evaluate-iteration --config <history.json> [--out <decision.json>]
  precheck --project <theme> [--config <precheck-options.json>] --out <precheck.json>
  check-performance --project <theme> [--config <official-options.json>] --out <official-checks.json>
  audit-performance --project <theme> [--profiles <runtime-profile-array.json>] [--baseline <performance.json>] [--checks <check-import.json>] [--ownership <ownership.json>] --out <performance.json>
  import-check --project <theme> --input <theme-check.json> [--metadata <scan-contract.json>] [--baseline <prior-import.json>] --out <check-import.json>
  audit-quality --project <theme> [--checks <check-import.json>] --out <quality.json>
  audit-html --input <absolute-rendered.html> [--fragment true|false] [--lcp-id <trace-identified-img-id>] --out <html-audit.json>
  audit-resources --project <theme> [--probe true|false] --out <resource-audit.json>
  plan-resource-repair --project <theme> --config <approved-image-repair.json> --profile <deployment-bound-profile.json> --out <plan.json>
  verify-resource-repair --config <plan-before-after-profiles.json> --out <repair-verification.json>
  measure --config <measurement.json> --out <NEW-run-directory>
  audit-site --project <theme> --run <measurement-directory> [--html-audits <saved-html-audits.json>] [--checks <check-import.json>] [--resources <resource-audit.json>] [--ownership <ownership.json>] [--performance-baseline <performance.json>] --out <site-audit.json>
  plan-site --project <theme> --recipe <reviewed-recipe.json> --out <site-plan.json>
  verify-site --before <baseline-run> --after <candidate-run> [--thresholds <thresholds.json>] --out <site-verification.json>
  map --project <theme> --capture <capture.json> [--target <file>] --out <mapping.json>
  scenarios --config <scenarios.json> --out <NEW-directory>
  inspect --project <theme> --target <relative-file> [--capture <capture.json>] --out <inspection.json>
  plan-image --project <theme> --target <relative-file> --image 0 --sizes '<CSS sizes>' --widths 320,640,900 --out <plan.json>
  plan-component --project <theme> --target assets/file.js --replacement <reviewed-file> --rule CMP03 --reason '<why>' --out <plan.json>
  apply|rollback --project <theme> --plan <plan.json> [--out <receipt.json>]
  capture --url <http-url> --selector '<unique-selector>' --out <NEW-directory> [--width 390 --height 844 --dpr 1]
  verify --before <capture.json> --after <capture.json> --out <comparison.json>
  report --input <inspection/capture/comparison.json> --out <report.html>
  lighthouse --before <five-LHR-directory> [--after <five-LHR-directory>] --out <summary.json>
  score-target --before <five-LHR-directory> --after <five-LHR-directory> [--minimum <score>] [--target <median-score>] [--out <new-target.json>]
Default: one agent, bounded JSON console summaries (4 KiB), quiet batch/measurement progress.
Use --format full for complete stdout, or --out to save full JSON without feeding it to the model.
measure --progress quiet|group|attempt selects progress (quiet by default).
All output paths must be new. scan/audit/inspect/plan/capture do not change theme files.
apply/rollback accept both single-file and site-change plans; site writes are preflighted, not a filesystem transaction.
measure runs real Lighthouse or PSI against explicit URLs, sequentially. It executes normal page requests.
Install pinned dependencies with npm ci; local measurement discovers installed Chrome or accepts PERF_KIT_BROWSER_EXECUTABLE / CHROME_PATH. PSI needs a publicly accessible URL.
Browser capture includes Playwright Core; optionally set PERF_KIT_PLAYWRIGHT_MODULE to an existing absolute module path.
Optional PERF_KIT_BROWSER_EXECUTABLE selects an installed Chromium executable.
Exit: 0 completed, 2 invalid input/execution, 3 diagnostic mismatch or score target failed/review required, 4 missing browser dependency.
score-target defaults: mobile minimum 75 / median 80; desktop minimum 85 / median 90. Imports reports; does not run Lighthouse.
Capture and verify are bounded diagnostics, not a release or CWV pass. No push/publish commands.
`;
function parse(argv) {
  const [command, ...rest] = argv;
  if (!command || ['help','--help','-h'].includes(command)) return { command: 'help', args: {} };
  if (!(command in specs)) throw new Error(`Unknown command: ${command}`);
  const args = {};
  for (let i=0;i<rest.length;i+=2) {
    const key=rest[i]?.replace(/^--/, '');
    if (!rest[i]?.startsWith('--') || ![...specs[command],'format'].includes(key)) throw new Error(`Unknown option: ${rest[i]}`);
    if (Object.hasOwn(args,key)) throw new Error(`Duplicate option: ${key}`);
    if (rest[i+1]===undefined || rest[i+1].startsWith('--')) throw new Error(`Missing value for ${key}`);
    args[key]=rest[i+1];
  }
  if(args.format!==undefined&&!['summary','full'].includes(args.format))throw new Error('format must be summary or full');
  return {command,args};
}
function required(a,key) { if (!a[key]) throw new Error(`Required: --${key}`); return a[key]; }
function number(a,key,fallback) { const value=a[key]===undefined?fallback:Number(a[key]); if (!Number.isFinite(value)) throw new Error(`Invalid --${key}`); return value; }
async function readJSON(file) { return JSON.parse(await fs.readFile(file,'utf8')); }
async function newOutput(file) {
  if (!file) return;
  try { await fs.lstat(file); throw new Error(`Refusing to overwrite output: ${file}`); }
  catch(e) { if(e.code!=='ENOENT') throw e; }
}
let outputFormat='summary';
async function emit(value,file) {
  const text=typeof value==='string'?value:JSON.stringify(value,null,2)+'\n';
  if(file) { await fs.mkdir(path.dirname(path.resolve(file)),{recursive:true}); await fs.writeFile(file,text,{flag:'wx'}); console.log(JSON.stringify({output:path.resolve(file),kind:value.kind??'report'})); }
  else if(typeof value==='string'||outputFormat==='full')console.log(text);
  else { const {compactArtifact}=await import('../lib/summary.mjs'); console.log(JSON.stringify(compactArtifact(value))); }
}
async function prepareReceiptOutput(file) {
  if (!file) return;
  const directory=path.dirname(path.resolve(file));
  await fs.mkdir(directory,{recursive:true});
  const probe=path.join(directory,`.perfkit-output-${randomUUID()}.tmp`);
  let handle;
  try {
    handle=await fs.open(probe,'wx',0o600);
    await handle.writeFile('\n');
  } finally {
    if(handle) {
      try { await handle.close(); }
      finally { await fs.unlink(probe); }
    }
  }
  // A probe cannot reserve the output name or prevent later permission/disk changes.
  await newOutput(file);
}
async function emitOperationReceipt(operation,file) {
  let receipt,operationError;
  try { receipt=await operation(); }
  catch(error) {
    if(!error.receipt) throw error;
    receipt=error.receipt;operationError=error;
  }
  try {
    if(!file) console.log(JSON.stringify(receipt,null,2)); // Preserve complete mutation recovery receipts on legacy stdout.
    else await emit(receipt,file);
  }
  catch(error) {
    if(!file) throw error;
    // The source operation has already run: preserve its full result even when
    // a concurrent writer, permission change or disk error prevents saving it.
    console.log(JSON.stringify(receipt,null,2));
    console.error(JSON.stringify({code:'RECEIPT_OUTPUT_FAILED',error:'Could not save the operation receipt; the complete receipt is on stdout.',output:path.resolve(file),outputError:{code:error.code??'ERROR',message:error.message}}));
    if(operationError) throw operationError;
    return 2;
  }
  if(operationError) throw operationError;
  return 0;
}
export async function main(argv=process.argv.slice(2)) {
  const {command,args:a}=parse(argv);
  outputFormat=a.format??'summary';
  if(command==='help') { console.log(help); return 0; }
  if(command==='improve-cycle') {
    const {runRecoveryCycle}=await import('../lib/recovery-cycle.mjs');
    const result=await runRecoveryCycle({config:await readJSON(required(a,'config')),output:required(a,'out')});
    await emit(result);return result.error?2:result.status==='optimization-accepted'?0:3;
  }
  if(command==='improve') {
    const {runImprovement}=await import('../lib/improvement-session.mjs');
    const result=await runImprovement({config:await readJSON(required(a,'config')),output:required(a,'out')});
    await emit(result);
    return result.error?2:result.status==='optimization-accepted'?0:3;
  }
  if(['import-field','audit-stylesheets','attribute-apps','measure-interactions','verify-interactions','ci-check'].includes(command)) {
    if(command!=='measure-interactions')await newOutput(a.out);
    let result;
    if(command==='import-field')result=await (await import('../lib/field-data.mjs')).importFieldData({input:required(a,'input')});
    else if(command==='audit-stylesheets')result=await (await import('../lib/stylesheet-audit.mjs')).auditStylesheets({project:required(a,'project')});
    else if(command==='attribute-apps'){
      const list=await readJSON(required(a,'profiles'));
      if(!Array.isArray(list)||list.length>24)throw new Error('profiles must contain at most 24 saved profiles.');
      result=(await import('../lib/app-attribution.mjs')).attributeApps({profiles:await Promise.all(list.map(p=>typeof p==='string'?readJSON(p):p)),owners:a.owners?await readJSON(a.owners):[]});
    } else {
      const config=await readJSON(required(a,'config'));
      result=command==='measure-interactions'?await (await import('../lib/interaction-measure.mjs')).measureInteractions({config,output:required(a,'out')})
        :command==='verify-interactions'?await (await import('../lib/interaction-measure.mjs')).verifyInteractions(config):await (await import('../lib/ci-check.mjs')).checkCI(config);
    }
    await emit(result,command==='measure-interactions'?undefined:a.out);
    return result.outcome==='invalid-evidence'?2:result.outcome&& !['passed','interaction-improved'].includes(result.outcome)||['limited','partial','review-required','stopped'].includes(result.status)?3:0;
  }
  if(command==='experiment-liquid') {
    const result=await (await import('../lib/liquid-experiment.mjs')).runLiquidExperiment({config:await readJSON(required(a,'config')),output:required(a,'out')});
    await emit(result);return result.status==='complete'?0:3;
  }
  if (command==='profile-domain') {
    const result=await (await import('../lib/domain-profile.mjs')).profileDomain({config:await readJSON(required(a,'config')),output:required(a,'out')});
    await emit(result);return result.status==='complete'?0:3;
  }
  if (['source-graph','diagnose-performance','plan-demand','plan-domain','verify-patch','verify-preservation','experiment'].includes(command)) {
    if (command !== 'experiment') await newOutput(a.out);
    const materialize = async value => typeof value === 'string' ? readJSON(value) : value;
    const profiles = async () => {
      const list = a.profiles ? await readJSON(a.profiles) : [];
      if (!Array.isArray(list) || list.length > 24) throw new Error('profiles must be an array of at most 24 saved profile paths/objects.');
      return Promise.all(list.map(materialize));
    };
    let result;
    if (command === 'source-graph') {
      const { indexThemeSources, publicSourceIndex } = await import('../lib/source-attribution.mjs');
      result = publicSourceIndex(await indexThemeSources(required(a,'project')));
    } else if (command === 'diagnose-performance') {
      result = await (await import('../lib/decision-engine.mjs')).diagnoseUnified({ project: required(a,'project'), profiles: await profiles(), run: a.run, liquidProfile: a.liquid ? await readJSON(a.liquid) : undefined,
        checks:a.checks?await readJSON(a.checks):null,ownership:a.ownership?await readJSON(a.ownership):[],performanceBaseline:a['performance-baseline']?await readJSON(a['performance-baseline']):null,field:a.field?await readJSON(a.field):null,owners:a.owners?await readJSON(a.owners):[],goal:a.goal?await readJSON(a.goal):undefined,...(a.limit!==undefined?{limit:Number(a.limit)}:{}) });
    } else if (command === 'plan-demand') {
      result = await (await import('../lib/demand-plan.mjs')).createDemandPlan({ project: required(a,'project'), config: await readJSON(required(a,'config')), diagnosis: await readJSON(required(a,'diagnosis')), profiles: await profiles() });
    } else if (command === 'plan-domain') {
      result = await (await import('../lib/domain-plan.mjs')).createDomainPlan({ project: required(a,'project'), config: await readJSON(required(a,'config')), diagnosis: await readJSON(required(a,'diagnosis')), profiles: await profiles() });
    } else if (command === 'experiment') {
      result = await (await import('../lib/patch-experiment.mjs')).runPatchExperiment({ config: await readJSON(required(a,'config')), output: required(a,'out') });
      await emit(result); return result.status === 'promising' ? 0 : 3;
    } else {
      const config = await readJSON(required(a,'config'));
      for (const key of command === 'verify-patch' ? ['plan','diagnosis','regressionBefore','regressionAfter'] : ['before','after','plan']) if (config[key]) config[key] = await materialize(config[key]);
      result = command === 'verify-patch' ? await (await import('../lib/patch-experiment.mjs')).verifyPatchExperiment(config)
        : (await import('../lib/preservation.mjs')).verifyPreservation(config);
    }
    await emit(result,a.out);
    return ['invalid-evidence','regressed','functional-regressed','performance-regressed','hypothesis-not-confirmed','no-measurable-gain'].includes(result.outcome) || result.status === 'review-required' || command==='diagnose-performance'&&result.reviewRequired ? 3 : 0;
  }
  if(command==='report-pdf') {
    const {generatePdfReport}=await import('../lib/pdf-report.mjs');
    await emit(await generatePdfReport({config:await readJSON(required(a,'config')),out:required(a,'out')}),null); return 0;
  }
  if(command==='code-strategies') {
    await newOutput(a.out);
    const { codeStrategies } = await import('../lib/code-strategy-catalog.mjs');
    await emit({ schemaVersion:1, kind:'code-strategy-catalog', strategies:codeStrategies },a.out); return 0;
  }
  if(command==='analyze-code') {
    await newOutput(a.out);
    const { analyzeCode } = await import('../lib/code-strategies.mjs');
    await emit(await analyzeCode({project:required(a,'project'),target:required(a,'target')}),a.out); return 0;
  }
  if(command==='doctor') {
    let browser={available:false,reason:'Playwright not installed; offline commands remain usable.'};
    try {
      const selected=process.env.PERF_KIT_PLAYWRIGHT_MODULE;
      if(selected&&!path.isAbsolute(selected)) throw new Error('PERF_KIT_PLAYWRIGHT_MODULE must be absolute');
      const { loadPlaywright } = await import('../lib/capture.mjs'); await loadPlaywright();
      const { browserExecutable } = await import('../lib/runtime-profile.mjs'); const executable=await browserExecutable();
      await fs.access(executable); browser={available:true,executable,module:selected??'playwright / bundled playwright-core',launchVerified:false};
    } catch(e) { browser.reason=e.message; }
    let measurement={available:false,reason:'Run npm ci to install the pinned local Lighthouse runtime.'};
    try {
      if(process.platform==='win32') throw new Error('Local Lighthouse measurement requires macOS or Linux; select PSI separately on Windows.');
      const cli=process.env.PERF_KIT_LIGHTHOUSE_CLI??path.join(here,'../node_modules/lighthouse/cli/index.js');
      const chrome=process.env.PERF_KIT_BROWSER_EXECUTABLE??process.env.CHROME_PATH??await (await import('../lib/runtime-profile.mjs')).browserExecutable();
      for(const [label,file,mode] of [['Lighthouse CLI',cli,constants.R_OK],['PERF_KIT_BROWSER_EXECUTABLE or CHROME_PATH',chrome,constants.X_OK]]) {
        if(typeof file!=='string'||!path.isAbsolute(file)||/[\x00-\x1f\x7f]/.test(file)) throw new Error(`${label} must be an absolute path to an existing file.`);
        if(!(await fs.stat(file)).isFile()) throw new Error(`${label} must point to a file.`);
        await fs.access(file,mode);
      }
      measurement={available:true,cli,chrome,launchVerified:false};
    } catch(e) { measurement.reason=e.message; }
    await emit({kind:'capabilities',version,node:process.version,offlineCore:true,browser,measurement,performanceEngine:{runtime:'Playwright coverage, CPU, trace and request attribution',sourceAttribution:'template/section/snippet/asset graph; exact-byte and structural-AST script mapping including static inline scripts',demandLoading:['custom-element extraction with private dependency closure','multi-state critical CSS with full cascade fallback'],experiments:'one hypothesis, exact patch-only source diff, alternating sample order, DOM/content/style checkpoints, history and original formal gates',devtools:'isolated pinned Chrome DevTools MCP',liquid:'Shopify CLI profile or Speedscope import',strategies:(await import('../lib/code-strategy-catalog.mjs')).codeStrategies.length,officialMethods:(await import('../lib/official-methods.mjs')).officialMethodCatalog().coverage,splitModes:['css','interaction'],acceptance:'candidate identity + score gain + no metric regression + original thresholds + behavior and visual evidence'},psi:{transportAvailable:typeof fetch==='function',keyConfigured:Boolean(process.env.PERF_KIT_PSI_API_KEY),networkVerified:false},scan:'whole-theme source inventory and candidates',patches:'reviewed multi-file plans and new assets with drift checks and rollback',lighthouse:'real local or PSI measurements plus Python report acceptance',field:'offline RUM/CrUX JSON and summary CSV; no causal field acceptance',goals:['score (default)','loading','interaction'],ci:'explicit baseline regression gate',nativeStylesheets:'conservative scoped CSS compatibility audit',scoreTarget:'mobile minimum 75 / median 80; desktop minimum 85 / median 90; no theme score guarantee'},null);return 0;
  }
  if(!['capture','scenarios','measure','batch','profile-runtime','profile-devtools','optimize'].includes(command)) await newOutput(a.out);
  if(command==='sync-shopify-docs') {
    const {syncShopifyDocs}=await import('../lib/shopify-docs.mjs');
    const result=await syncShopifyDocs({config:a.config?await readJSON(a.config):{},output:required(a,'out')});await emit(result);return result.status==='complete'?0:3;
  }
  if(command==='shopify-methods') {
    const {officialMethodCatalog}=await import('../lib/official-methods.mjs');
    const result=officialMethodCatalog({sources:a.sources?await readJSON(a.sources):undefined});
    if(a.topic){if(!result.methods.some(m=>m.topic===a.topic))throw new Error('Unknown official method topic.');result.methods=result.methods.filter(m=>m.topic===a.topic);result.filter={topic:a.topic};}
    await emit(result,a.out);return result.status==='current'?0:3;
  }
  if(command==='request-implementation') {
    const {requestImplementation}=await import('../lib/custom-implementation.mjs');
    await emit(await requestImplementation({previous:required(a,'previous'),candidateId:required(a,'candidate'),files:a.files?await readJSON(a.files):[]}),required(a,'out'));return 0;
  }
  if(command==='plan-custom') {
    const {createCustomPlan}=await import('../lib/custom-implementation.mjs');
    await emit(await createCustomPlan({request:required(a,'request'),candidate:required(a,'candidate')}),required(a,'out'));return 0;
  }
  if(command==='plan-official') {
    const {createOfficialPlan}=await import('../lib/official-plan.mjs');
    const inputs=a.profiles?await readJSON(a.profiles):[];
    if(!Array.isArray(inputs)||inputs.length>24)throw new Error('profiles must be an array of at most 24 saved profiles.');
    const profiles=await Promise.all(inputs.map(p=>typeof p==='string'?readJSON(p):p));
    const output=required(a,'out');
    await emit(await createOfficialPlan({project:required(a,'project'),diagnosis:await readJSON(required(a,'diagnosis')),config:await readJSON(required(a,'config')),profiles,sources:a.sources?await readJSON(a.sources):undefined}),output);return 0;
  }
  if (['profile-runtime','profile-devtools','optimize'].includes(command)) {
    const config = await readJSON(required(a, 'config')), output = required(a, 'out');
    const run = command === 'profile-runtime' ? (await import('../lib/runtime-profile.mjs')).profileRuntime
      : command === 'profile-devtools' ? (await import('../lib/devtools-profile.mjs')).profileDevtools : (await import('../lib/optimize.mjs')).runOptimization;
    const result = await run({ config, output }); await emit(result); return ['complete','optimization-accepted','awaiting-preview-sync'].includes(result.status) ? 0 : 3;
  }
  if (command === 'profile-liquid') {
    const { profileLiquid } = await import('../lib/liquid-profile.mjs'); const result = await profileLiquid({ config: await readJSON(required(a, 'config')) });
    await emit(result, a.out); return result.status === 'complete' ? 0 : 3;
  }
  if (command === 'verify-deployment') {
    const { verifyDeployment } = await import('../lib/deployment.mjs'); const { pages, ...config } = await readJSON(required(a, 'config'));
    const result = await verifyDeployment({ config, pages }); await emit(result, a.out); return result.status === 'verified' ? 0 : 3;
  }
  if (command === 'verify-gain') {
    const { evaluateGain } = await import('../lib/performance-gain.mjs'); const result = await evaluateGain({ before: required(a, 'before'), after: required(a, 'after'), allowExploration: true,goal:a.goal?await readJSON(a.goal):undefined,...(a.limit!==undefined?{limit:Number(a.limit)}:{}) });
    await emit(result, a.out); return result.outcome === 'measurable-gain' ? 0 : 3;
  }
  if (command === 'verify-optimization') {
    const { verifyOptimization } = await import('../lib/optimize.mjs'); const result = await verifyOptimization(await readJSON(required(a, 'config')));
    await emit(result, a.out); return result.outcome === 'optimization-accepted' ? 0 : 3;
  }
  if (command === 'plan-split') {
    const { createSplitPlan } = await import('../lib/split-plan.mjs'); await emit(await createSplitPlan({ project: required(a, 'project'), config: await readJSON(required(a, 'config')) }), a.out); return 0;
  }
  if(command==='scan') {
    const {scanTheme}=await import('../lib/scan.mjs');
    const result=await scanTheme({project:required(a,'project'),pages:a.pages?await readJSON(a.pages):[]});
    await emit(result,a.out);return result.complete===false?3:0;
  }
  if(command==='check-performance') {
    await newOutput(a.out);
    const {assertPrecheckOutput}=await import('../lib/precheck.mjs');
    await assertPrecheckOutput(required(a,'project'),a.out);
    const {checkOfficialPerformance}=await import('../lib/official-performance.mjs');
    const result=await checkOfficialPerformance({project:required(a,'project'),config:a.config?await readJSON(a.config):{}});
    await emit(result,a.out);return result.reviewRequired?3:0;
  }
  if(command==='audit-performance') {
    await newOutput(a.out);
    const {auditPerformance}=await import('../lib/performance-audit.mjs');
    const profiles=a.profiles?await readJSON(a.profiles):[];
    if(!Array.isArray(profiles)||profiles.length>24)throw new Error('profiles must contain at most 24 saved profile paths/objects.');
    const result=await auditPerformance({project:required(a,'project'),baseline:a.baseline?await readJSON(a.baseline):null,checks:a.checks?await readJSON(a.checks):null,ownership:a.ownership?await readJSON(a.ownership):[],profiles:await Promise.all(profiles.map(p=>typeof p==='string'?readJSON(p):p))});
    await emit(result,a.out);return result.reviewRequired?3:0;
  }
  if(command==='precheck') {
    const {precheckTheme,assertPrecheckOutput}=await import('../lib/precheck.mjs');
    await assertPrecheckOutput(required(a,'project'),a.out);
    const result=await precheckTheme({project:required(a,'project'),config:a.config?await readJSON(a.config):{}});
    await emit(result,a.out);return result.reviewRequired?3:0;
  }
  if(command==='import-check') {
    const {importCheck}=await import('../lib/check-import.mjs');
    const result=await importCheck({project:required(a,'project'),input:await readJSON(required(a,'input')),metadata:a.metadata?await readJSON(a.metadata):{},baseline:a.baseline?await readJSON(a.baseline):null});
    await emit(result,a.out);return !result.complete||result.comparison.gate==='review-required'?3:0;
  }
  if(command==='audit-html') {
    await newOutput(required(a,'out'));
    if(a.fragment !== undefined && !['true','false'].includes(a.fragment)) throw new Error('fragment must be true or false.');
    const {auditRenderedHTML}=await import('../lib/rendered-html.mjs');
    const result=await auditRenderedHTML({input:required(a,'input'),fragment:a.fragment==='true',lcpId:a['lcp-id']??null});
    await emit(result,a.out);return result.reviewRequired?3:0;
  }
  if(command==='audit-quality') {
    await newOutput(a.out);
    const {auditQuality}=await import('../lib/quality-audit.mjs');
    await emit(await auditQuality({project:required(a,'project'),checks:a.checks?await readJSON(a.checks):null}),a.out);return 0;
  }
  if(command==='audit-resources') {
    if(a.probe!==undefined&&!['true','false'].includes(a.probe)) throw new Error('--probe must be true or false.');
    const {auditResources}=await import('../lib/resource-audit.mjs');
    const result=await auditResources({project:required(a,'project'),probe:a.probe==='true'});
    await emit(result,a.out);return result.complete?0:3;
  }
  if(['plan-resource-repair','verify-resource-repair'].includes(command)) {
    await newOutput(a.out);const {createResourceRepair,verifyResourceRepair}=await import('../lib/resource-repair.mjs');
    let result;
    if(command==='plan-resource-repair')result=await createResourceRepair({project:required(a,'project'),config:await readJSON(required(a,'config')),profile:await readJSON(required(a,'profile'))});
    else {const config=await readJSON(required(a,'config'));for(const k of ['plan','before','after'])if(typeof config[k]==='string')config[k]=await readJSON(config[k]);result=await verifyResourceRepair(config);}
    await emit(result,a.out);return result.outcome==='invalid-evidence'?3:0;
  }
  if(command==='map') {
    const {mapCapture}=await import('../lib/mapping.mjs');
    await emit(await mapCapture({project:required(a,'project'),target:a.target,capture:await readJSON(required(a,'capture'))}),a.out);return 0;
  }
  if(command==='scenarios') {
    const {runScenarios}=await import('../lib/scenarios.mjs');
    const result=await runScenarios({config:await readJSON(required(a,'config')),output:required(a,'out')});
    console.log(JSON.stringify({kind:result.kind,outcome:result.outcome,output:path.resolve(a.out),runs:result.runs?.length}));
    if(result.errors?.some(error=>error.code==='PLAYWRIGHT_UNAVAILABLE'))return 4;
    return result.outcome==='passed'?0:3;
  }
  if(command==='measure') {
    const {measureSite}=await import('../lib/measure.mjs');
    const progressMode=a.progress??'quiet';
    if(!['quiet','group','attempt'].includes(progressMode))throw new Error('progress must be quiet, group or attempt');
    const result=await measureSite({config:await readJSON(required(a,'config')),output:required(a,'out'),onProgress:progress=>{if(progressMode==='attempt'||(progressMode==='group'&&(progress.event==='run-end'||(progress.event==='attempt-end'&&progress.index===progress.runs))))console.error(JSON.stringify({progress}));}});
    console.log(JSON.stringify({kind:result.kind,status:result.status,output:path.resolve(a.out),counts:result.counts,stopped:result.stopped??null,summary:path.join(path.resolve(a.out),'summary.json')}));
    return result.status==='complete'?0:3;
  }
  if(command==='batch') {
    const {runBatch}=await import('../lib/batch.mjs');
    const {compactArtifact}=await import('../lib/summary.mjs');
    const result=await runBatch({config:await readJSON(required(a,'config')),output:required(a,'out')});
    console.log(JSON.stringify(outputFormat==='full'?result:compactArtifact(result)));
    return result.status!=='complete'||result.reviewRequired||!['not-evaluated','score-targets-met'].includes(result.acceptance)?3:0;
  }
  if(command==='summarize') {
    const {summarizeRun}=await import('../lib/summary.mjs');
    await emit(await summarizeRun(required(a,'run')),a.out);return 0;
  }
  if(command==='evaluate-iteration') {
    const {evaluateIterations}=await import('../lib/iteration.mjs');
    const result=await evaluateIterations(await readJSON(required(a,'config')));
    await emit(result,a.out);return result.stop?3:0;
  }
  if(command==='audit-site') {
    const {auditSite}=await import('../lib/site-audit.mjs');
    const result=await auditSite({project:required(a,'project'),run:required(a,'run'),checks:a.checks?await readJSON(a.checks):null,officialChecks:a.official?await readJSON(a.official):null,resourceAnalysis:a.resources?await readJSON(a.resources):null,precheck:a.precheck?await readJSON(a.precheck):null,runtimeProfile:a.runtime?await readJSON(a.runtime):null,ownership:a.ownership?await readJSON(a.ownership):[],performanceBaseline:a['performance-baseline']?await readJSON(a['performance-baseline']):null,renderedHtml:a['html-audits']?await readJSON(a['html-audits']):[]});
    await emit(result,a.out);return result.complete===false?3:0;
  }
  if(command==='plan-site') {
    const {createSitePlan}=await import('../lib/site-changes.mjs');
    const recipePath=path.resolve(required(a,'recipe'));
    await emit(await createSitePlan({project:required(a,'project'),recipe:await readJSON(recipePath),recipeDir:path.dirname(recipePath)}),a.out);return 0;
  }
  if(command==='verify-site') {
    const {verifySite}=await import('../lib/site-verify.mjs');
    const result=await verifySite({before:required(a,'before'),after:required(a,'after'),thresholds:a.thresholds?await readJSON(a.thresholds):undefined});
    await emit(result,a.out);return result.outcome==='score-targets-met'?0:result.outcome==='invalid-evidence'?2:3;
  }
  if(command==='inspect') {
    const {inspectSource}=await import('../lib/inspect.mjs');
    const result=await inspectSource({project:required(a,'project'),target:required(a,'target'),capture:a.capture?await readJSON(a.capture):null});
    await emit(result,a.out);return 0;
  }
  if(command==='plan-image') {
    const {inspectSource}=await import('../lib/inspect.mjs');
    const {createImagePlan}=await import('../lib/changes.mjs');
    const project=required(a,'project'),target=required(a,'target');
    const inspection=a.inspection?await readJSON(a.inspection):await inspectSource({project,target});
    const plan=await createImagePlan({project,target,inspection,imageIndex:number(a,'image',0),sizes:required(a,'sizes'),widths:required(a,'widths').split(',').map(Number)});
    await emit(plan,a.out);return 0;
  }
  if(command==='plan-component') {
    const {createPatchPlan}=await import('../lib/changes.mjs');
    const plan=await createPatchPlan({project:required(a,'project'),target:required(a,'target'),replacement:await fs.readFile(required(a,'replacement'),'utf8'),ruleId:required(a,'rule'),reason:required(a,'reason'),validators:(a.validators??'component-behavior,visual,host-regression').split(',')});
    await emit(plan,a.out);return 0;
  }
  if(command==='apply'||command==='rollback') {
    const {applyPlan,rollbackPlan}=await import('../lib/changes.mjs');
    const plan=await readJSON(required(a,'plan'));
    const project=required(a,'project');
    await prepareReceiptOutput(a.out);
    if(plan.kind==='site-change-plan') {
      const {applySitePlan,rollbackSitePlan}=await import('../lib/site-changes.mjs');
      return emitOperationReceipt(()=>(command==='apply'?applySitePlan:rollbackSitePlan)(plan,project),a.out);
    }
    return emitOperationReceipt(()=>(command==='apply'?applyPlan:rollbackPlan)(plan,project),a.out);
  }
  if(command==='capture') {
    const {capturePage}=await import('../lib/capture.mjs');
    const result=await capturePage({url:required(a,'url'),selector:required(a,'selector'),output:required(a,'out'),viewport:{width:number(a,'width',390),height:number(a,'height',844)},dpr:number(a,'dpr',1),waitMs:number(a,'wait-ms',1500),timeoutMs:number(a,'timeout-ms',30000),project:a.project,target:a.target});
    console.log(JSON.stringify({kind:result.kind,output:path.resolve(a.out),images:result.images?.length,limitations:result.limitations}));return 0;
  }
  if(command==='verify') {
    const {compareCaptures}=await import('../lib/compare.mjs');
    const result=compareCaptures(await readJSON(required(a,'before')),await readJSON(required(a,'after')));
    await emit(result,a.out);return result.comparable===false||['regression','regression-detected','failed','not-comparable'].includes(result.outcome)?3:0;
  }
  if(command==='report') {
    const {renderReport}=await import('../lib/report.mjs');
    await emit(renderReport(await readJSON(required(a,'input'))),required(a,'out'));return 0;
  }
  if(command==='lighthouse') {
    const args=[path.join(here,'summarize_lighthouse.py'),required(a,'before')];
    if(a.after) args.push(a.after);if(a.out) args.push('--output',a.out);
    const r=spawnSync(process.env.PERF_KIT_PYTHON||'python3',args,{encoding:'utf8'});
    if(r.error) throw r.error;process.stdout.write(r.stdout??'');process.stderr.write(r.stderr??'');return r.status??2;
  }
  if(command==='score-target') {
    const args=['-B',path.join(here,'check_score_target.py'),'--before',required(a,'before'),'--after',required(a,'after')];
    for(const key of ['minimum','target']) if(a[key]!==undefined) args.push(`--${key}`,a[key]);
    if(a.out) args.push('--output',a.out);
    const r=spawnSync(process.env.PERF_KIT_PYTHON||'python3',args,{encoding:'utf8'});
    if(r.error) throw r.error;process.stdout.write(r.stdout??'');process.stderr.write(r.stderr??'');return r.status??2;
  }
}
const entryPath = process.argv[1] ? await fs.realpath(process.argv[1]).catch(() => null) : null;
if(entryPath && entryPath===await fs.realpath(fileURLToPath(import.meta.url))) {
  main().then(code=>{process.exitCode=code;}).catch(error=>{console.error(JSON.stringify({error:error.message,code:error.code??'EXECUTION_FAILED'}));process.exitCode=/playwright|browser executable|executable.*exist/i.test(error.message)?4:2;});
}
