#!/usr/bin/env node
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { commandHelp, parseCommand, configValidator } from './perfkit-commands.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const { version } = JSON.parse(await fs.readFile(path.join(here, '../package.json'), 'utf8'));
function number(a,key,fallback) { const value=a[key]===undefined?fallback:Number(a[key]); if (!Number.isFinite(value)) throw new Error(`Invalid --${key}`); return value; }
async function readJSON(file) {
  const contents = await fs.readFile(file, 'utf8');
  try { return JSON.parse(contents); }
  catch (error) {
    const location = error.message.match(/\bposition \d+(?: \(line \d+ column \d+\))?/);
    throw Object.assign(new Error(`Invalid JSON in ${file}${location ? ` at ${location[0]}` : ''}.`), {code: 'INVALID_JSON'});
  }
}
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
  const {command,args:a,help}=parseCommand(argv);
  if (help) { console.log(commandHelp(version, command)); return 0; }
  outputFormat=a.format??'summary';
  if (command === 'validate-config') {
    const validate = configValidator(a.command);
    const result = await validate(await readJSON(a.config));
    const measurement = a.command === 'measure' ? result
      : ['batch','optimize'].includes(a.command) ? result?.measurement : null;
    const samplingBudget = result?.samplingBudget;
    const plannedSamples = samplingBudget?.totalAttempts ?? (measurement ? measurement.pages.length * measurement.devices.length * measurement.runs
      : a.command === 'measure-interactions' ? result.runs
      : a.command === 'experiment' ? result.runs * 2 : undefined);
    const attemptLimit = a.command === 'batch' ? Math.min(result.limits.maxAttempts, measurement?.budget.maxAttempts ?? Infinity)
      : measurement?.budget.maxAttempts;
    const warnings = [];
    if (plannedSamples > attemptLimit) warnings.push('Planned samples exceed budget.maxAttempts.');
    if (samplingBudget && samplingBudget.timeoutEstimateMs > samplingBudget.maxWallTimeMs) {
      warnings.push('Configured stage timeouts may exceed budget.maxWallTimeMs; the actual run remains time-bounded.');
    }
    const plannedScenarioRuns = samplingBudget?.scenarioRuns ?? (a.command === 'scenarios' ? result.scenarios.length * result.viewports.length : undefined);
    const blocked = samplingBudget?.fits === false;
    console.log(JSON.stringify({
      kind:'config-validation', command:a.command, status:blocked?'insufficient-budget':'valid', scope:'config-only',
      plannedSamples, plannedScenarioRuns, samplingBudget, warnings:warnings.length?warnings:undefined,
    }));
    return blocked ? 3 : 0;
  }
  if(['toolkit-manifest','theme-capabilities','resolve-adapter','verify-business','audit-policy','audit-window-budget','field-monitor','strategy-contract'].includes(command)){
    if(command!=='field-monitor')await newOutput(a.out);
    const config=a.config?await readJSON(a.config):{};let result;
    if(command==='toolkit-manifest')result=await (await import('../lib/toolkit-manifest.mjs')).toolkitManifest();
    if(command==='theme-capabilities')result=await (await import('../lib/theme-capabilities.mjs')).inspectThemeCapabilities({project:a.project,...config});
    if(command==='resolve-adapter')result=await (await import('../lib/theme-capabilities.mjs')).resolveAdapterRegistry(config);
    if(command==='verify-business')result=await (await import('../lib/business-evidence.mjs')).verifyBusinessEvidence(config);
    if(command==='audit-policy')result=await (await import('../lib/policy-audit.mjs')).auditPolicy(config);
    if(command==='audit-window-budget')result=await (await import('../lib/resource-budget.mjs')).auditWindowBudget(config);
    if(command==='field-monitor')result=await (await import('../lib/field-monitor.mjs')).monitorField({config,output:a.out});
    if(command==='strategy-contract')result=await (await import('../lib/strategy-contract.mjs')).prepareStrategyContract(config);
    await emit(result,command==='field-monitor'?undefined:a.out);
    return ['rejected','ambiguous','not-accepted','review-required','failed','limited'].includes(result.status??result.outcome)?3:0;
  }
  if(command==='improve-cycle') {
    const {runRecoveryCycle}=await import('../lib/recovery-cycle.mjs');
    const result=await runRecoveryCycle({config:await readJSON(a.config),output:a.out});
    await emit(result);return result.error?2:result.status==='optimization-accepted'?0:3;
  }
  if(command==='improve') {
    const {runImprovement}=await import('../lib/improvement-session.mjs');
    const result=await runImprovement({config:await readJSON(a.config),output:a.out});
    await emit(result);
    return result.error?2:result.status==='optimization-accepted'?0:3;
  }
  if(['import-field','audit-stylesheets','attribute-apps','measure-interactions','verify-interactions','ci-check'].includes(command)) {
    if(command!=='measure-interactions')await newOutput(a.out);
    let result;
    if(command==='import-field')result=await (await import('../lib/field-data.mjs')).importFieldData({input:a.input});
    else if(command==='audit-stylesheets')result=await (await import('../lib/stylesheet-audit.mjs')).auditStylesheets({project:a.project});
    else if(command==='attribute-apps'){
      const list=await readJSON(a.profiles);
      if(!Array.isArray(list)||list.length>24)throw new Error('profiles must contain at most 24 saved profiles.');
      result=(await import('../lib/app-attribution.mjs')).attributeApps({profiles:await Promise.all(list.map(p=>typeof p==='string'?readJSON(p):p)),owners:a.owners?await readJSON(a.owners):[]});
    } else {
      const config=await readJSON(a.config);
      result=command==='measure-interactions'?await (await import('../lib/interaction-measure.mjs')).measureInteractions({config,output:a.out})
        :command==='verify-interactions'?await (await import('../lib/interaction-measure.mjs')).verifyInteractions(config):await (await import('../lib/ci-check.mjs')).checkCI(config);
    }
    await emit(result,command==='measure-interactions'?undefined:a.out);
    return result.outcome==='invalid-evidence'?2:result.outcome&& !['passed','interaction-improved'].includes(result.outcome)||['limited','partial','review-required','stopped'].includes(result.status)?3:0;
  }
  if(command==='experiment-liquid') {
    const result=await (await import('../lib/liquid-experiment.mjs')).runLiquidExperiment({config:await readJSON(a.config),output:a.out});
    await emit(result);return result.status==='complete'?0:3;
  }
  if (command==='profile-domain') {
    const result=await (await import('../lib/domain-profile.mjs')).profileDomain({config:await readJSON(a.config),output:a.out});
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
      result = publicSourceIndex(await indexThemeSources(a.project));
    } else if (command === 'diagnose-performance') {
      result = await (await import('../lib/decision-engine.mjs')).diagnoseUnified({ project: a.project, profiles: await profiles(), run: a.run, liquidProfile: a.liquid ? await readJSON(a.liquid) : undefined,
        checks:a.checks?await readJSON(a.checks):null,ownership:a.ownership?await readJSON(a.ownership):[],performanceBaseline:a['performance-baseline']?await readJSON(a['performance-baseline']):null,field:a.field?await readJSON(a.field):null,owners:a.owners?await readJSON(a.owners):[],goal:a.goal?await readJSON(a.goal):undefined,...(a.limit!==undefined?{limit:Number(a.limit)}:{}) });
    } else if (command === 'plan-demand') {
      result = await (await import('../lib/demand-plan.mjs')).createDemandPlan({ project: a.project, config: await readJSON(a.config), diagnosis: await readJSON(a.diagnosis), profiles: await profiles() });
    } else if (command === 'plan-domain') {
      result = await (await import('../lib/domain-plan.mjs')).createDomainPlan({ project: a.project, config: await readJSON(a.config), diagnosis: await readJSON(a.diagnosis), profiles: await profiles() });
    } else if (command === 'experiment') {
      result = await (await import('../lib/patch-experiment.mjs')).runPatchExperiment({ config: await readJSON(a.config), output: a.out });
      await emit(result); return result.status === 'promising' ? 0 : 3;
    } else {
      const config = await readJSON(a.config);
      for (const key of command === 'verify-patch' ? ['plan','diagnosis','regressionBefore','regressionAfter'] : ['before','after','plan']) if (config[key]) config[key] = await materialize(config[key]);
      result = command === 'verify-patch' ? await (await import('../lib/patch-experiment.mjs')).verifyPatchExperiment(config)
        : (await import('../lib/preservation.mjs')).verifyPreservation(config);
    }
    await emit(result,a.out);
    return ['invalid-evidence','regressed','functional-regressed','performance-regressed','hypothesis-not-confirmed','no-measurable-gain'].includes(result.outcome) || result.status === 'review-required' || command==='diagnose-performance'&&result.reviewRequired ? 3 : 0;
  }
  if(command==='report-pdf') {
    const {generatePdfReport}=await import('../lib/pdf-report.mjs');
    await emit(await generatePdfReport({config:await readJSON(a.config),out:a.out}),null); return 0;
  }
  if(command==='code-strategies') {
    await newOutput(a.out);
    const { codeStrategies } = await import('../lib/code-strategy-catalog.mjs');
    await emit({ schemaVersion:1, kind:'code-strategy-catalog', strategies:codeStrategies },a.out); return 0;
  }
  if(command==='analyze-code') {
    await newOutput(a.out);
    const { analyzeCode } = await import('../lib/code-strategies.mjs');
    await emit(await analyzeCode({project:a.project,target:a.target}),a.out); return 0;
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
    const result=await syncShopifyDocs({config:a.config?await readJSON(a.config):{},output:a.out});await emit(result);return result.status==='complete'?0:3;
  }
  if(command==='shopify-methods') {
    const {officialMethodCatalog}=await import('../lib/official-methods.mjs');
    const result=officialMethodCatalog({sources:a.sources?await readJSON(a.sources):undefined});
    if(a.topic){if(!result.methods.some(m=>m.topic===a.topic))throw new Error('Unknown official method topic.');result.methods=result.methods.filter(m=>m.topic===a.topic);result.filter={topic:a.topic};}
    await emit(result,a.out);return result.status==='current'?0:3;
  }
  if(command==='request-implementation') {
    const {requestImplementation}=await import('../lib/custom-implementation.mjs');
    await emit(await requestImplementation({previous:a.previous,candidateId:a.candidate,files:a.files?await readJSON(a.files):[]}),a.out);return 0;
  }
  if(command==='plan-custom') {
    const {createCustomPlan}=await import('../lib/custom-implementation.mjs');
    await emit(await createCustomPlan({request:a.request,candidate:a.candidate}),a.out);return 0;
  }
  if(command==='plan-official') {
    const {createOfficialPlan}=await import('../lib/official-plan.mjs');
    const inputs=a.profiles?await readJSON(a.profiles):[];
    if(!Array.isArray(inputs)||inputs.length>24)throw new Error('profiles must be an array of at most 24 saved profiles.');
    const profiles=await Promise.all(inputs.map(p=>typeof p==='string'?readJSON(p):p));
    const output=a.out;
    await emit(await createOfficialPlan({project:a.project,diagnosis:await readJSON(a.diagnosis),config:await readJSON(a.config),profiles,sources:a.sources?await readJSON(a.sources):undefined}),output);return 0;
  }
  if(command==='audit-runtime-integrity'){
    const {inspectRuntimeIntegrity}=await import('../lib/runtime-integrity.mjs');
    const result=inspectRuntimeIntegrity(await readJSON(a.input));
    await emit(result,a.out);return result.reviewRequired?3:0;
  }
  if (['profile-runtime','profile-devtools','optimize'].includes(command)) {
    const config = await readJSON(a.config), output = a.out;
    const run = command === 'profile-runtime' ? (await import('../lib/runtime-profile.mjs')).profileRuntime
      : command === 'profile-devtools' ? (await import('../lib/devtools-profile.mjs')).profileDevtools : (await import('../lib/optimize.mjs')).runOptimization;
    const result = await run({ config, output }); await emit(result); return ['complete','optimization-accepted','awaiting-preview-sync'].includes(result.status)&&!(command==='profile-runtime'&&result.reviewRequired) ? 0 : 3;
  }
  if (command === 'profile-liquid') {
    const { profileLiquid } = await import('../lib/liquid-profile.mjs'); const result = await profileLiquid({ config: await readJSON(a.config) });
    await emit(result, a.out); return result.status === 'complete' ? 0 : 3;
  }
  if (command === 'verify-deployment') {
    const { verifyDeployment } = await import('../lib/deployment.mjs'); const { pages, ...config } = await readJSON(a.config);
    const result = await verifyDeployment({ config, pages }); await emit(result, a.out); return result.status === 'verified' ? 0 : 3;
  }
  if (command === 'verify-gain') {
    const { evaluateGain } = await import('../lib/performance-gain.mjs'); const result = await evaluateGain({ before: a.before, after: a.after, allowExploration: true,goal:a.goal?await readJSON(a.goal):undefined,...(a.limit!==undefined?{limit:Number(a.limit)}:{}) });
    await emit(result, a.out); return result.outcome === 'measurable-gain' ? 0 : 3;
  }
  if (command === 'verify-optimization') {
    const { verifyOptimization } = await import('../lib/optimize.mjs'); const result = await verifyOptimization(await readJSON(a.config));
    await emit(result, a.out); return result.outcome === 'optimization-accepted' ? 0 : 3;
  }
  if (command === 'plan-split') {
    const { createSplitPlan } = await import('../lib/split-plan.mjs'); await emit(await createSplitPlan({ project: a.project, config: await readJSON(a.config) }), a.out); return 0;
  }
  if(command==='scan') {
    const {scanTheme}=await import('../lib/scan.mjs');
    const result=await scanTheme({project:a.project,pages:a.pages?await readJSON(a.pages):[]});
    await emit(result,a.out);return result.complete===false?3:0;
  }
  if(command==='check-theme'){
    const {checkThemeProject}=await import('../lib/theme-check-project.mjs');
    const {assertPrecheckOutput}=await import('../lib/precheck.mjs');
    await assertPrecheckOutput(a.project,a.out);
    await newOutput(a.out);
    try{const result=await checkThemeProject({project:a.project});await emit(result,a.out);return result.reviewRequired?3:0;}
    catch(error){if(error.themeCheck)await emit({...error.themeCheck,status:'failed',error:error.message},a.out);throw error;}
  }
  if(command==='plan-sampling'){
    const {planAuditSampling}=await import('../lib/audit-sampling.mjs');
    const result=await planAuditSampling({
      audit:await readJSON(a.audit),findingId:a.finding,url:a.url,device:a.device,selector:a.selector,themeId:a['theme-id'],store:a.store,settleMs:a['settle-ms']===undefined?undefined:Number(a['settle-ms']),output:a.out,
    });
    await emit(result);return 0;
  }
  if(command==='plan-verification'){
    const {verificationPlan}=await import('../lib/standards-policy.mjs');
    await emit(verificationPlan(await readJSON(a.config)),a.out);return 0;
  }
  if(command==='import-pageotter'){
    const {importPageOtter}=await import('../lib/pageotter-import.mjs');
    if(a.project){const {assertPrecheckOutput}=await import('../lib/precheck.mjs');await assertPrecheckOutput(a.project,a.out);}
    const result=await importPageOtter({input:await readJSON(a.input),project:a.project,baseline:a.baseline?await readJSON(a.baseline):undefined});
    await emit(result,a.out);return result.reviewRequired?3:0;
  }
  if(command==='check-performance') {
    await newOutput(a.out);
    const {assertPrecheckOutput}=await import('../lib/precheck.mjs');
    await assertPrecheckOutput(a.project,a.out);
    const {checkOfficialPerformance}=await import('../lib/official-performance.mjs');
    let result;try{result=await checkOfficialPerformance({project:a.project,config:a.config?await readJSON(a.config):{}});}catch(error){if(a.out&&error.officialChecks)await emit({schemaVersion:1,...error.officialChecks,status:'failed',error:error.message},a.out);throw error;}
    await emit(result,a.out);return result.reviewRequired?3:0;
  }
  if(command==='audit-performance') {
    await newOutput(a.out);
    const {auditPerformance}=await import('../lib/performance-audit.mjs');
    const profiles=a.profiles?await readJSON(a.profiles):[];
    if(!Array.isArray(profiles)||profiles.length>24)throw new Error('profiles must contain at most 24 saved profile paths/objects.');
    const result=await auditPerformance({project:a.project,baseline:a.baseline?await readJSON(a.baseline):null,checks:a.checks?await readJSON(a.checks):null,ownership:a.ownership?await readJSON(a.ownership):[],profiles:await Promise.all(profiles.map(p=>typeof p==='string'?readJSON(p):p))});
    await emit(result,a.out);return result.reviewRequired?3:0;
  }
  if(command==='precheck') {
    const {precheckTheme,assertPrecheckOutput}=await import('../lib/precheck.mjs');
    await assertPrecheckOutput(a.project,a.out);
    await newOutput(a.out);
    let result;try{result=await precheckTheme({project:a.project,config:a.config?await readJSON(a.config):{}});}catch(error){if(a.out&&error.precheck)await emit({schemaVersion:1,...error.precheck,status:'failed',error:error.message},a.out);throw error;}
    await emit(result,a.out);return result.reviewRequired?3:0;
  }
  if(command==='import-check') {
    const {importCheck}=await import('../lib/check-import.mjs');
    const result=await importCheck({project:a.project,input:await readJSON(a.input),metadata:a.metadata?await readJSON(a.metadata):{},baseline:a.baseline?await readJSON(a.baseline):null});
    await emit(result,a.out);return !result.complete||result.comparison.gate==='review-required'?3:0;
  }
  if(command==='audit-html') {
    await newOutput(a.out);
    const {auditRenderedHTML}=await import('../lib/rendered-html.mjs');
    const result=await auditRenderedHTML({input:a.input,fragment:a.fragment==='true',lcpId:a['lcp-id']??null});
    await emit(result,a.out);return result.reviewRequired?3:0;
  }
  if(command==='theme-diff') {
    await newOutput(a.out);
    const {assertPrecheckOutput}=await import('../lib/precheck.mjs');
    await assertPrecheckOutput(a.before,a.out);await assertPrecheckOutput(a.after,a.out);
    const {compareThemes}=await import('../lib/theme-diff.mjs');
    const result=await compareThemes({before:a.before,after:a.after});await emit(result,a.out);return result.complete?0:3;
  }
  if(command==='audit-quality') {
    await newOutput(a.out);
    const {auditQuality}=await import('../lib/quality-audit.mjs');
    await emit(await auditQuality({project:a.project,checks:a.checks?await readJSON(a.checks):null}),a.out);return 0;
  }
  if(command==='audit-resources') {
    const {auditResources}=await import('../lib/resource-audit.mjs');
    const result=await auditResources({project:a.project,probe:a.probe==='true'});
    await emit(result,a.out);return result.complete?0:3;
  }
  if(['plan-resource-repair','verify-resource-repair'].includes(command)) {
    await newOutput(a.out);const {createResourceRepair,verifyResourceRepair}=await import('../lib/resource-repair.mjs');
    let result;
    if(command==='plan-resource-repair')result=await createResourceRepair({project:a.project,config:await readJSON(a.config),profile:await readJSON(a.profile)});
    else {const config=await readJSON(a.config);for(const k of ['plan','before','after'])if(typeof config[k]==='string')config[k]=await readJSON(config[k]);result=await verifyResourceRepair(config);}
    await emit(result,a.out);return result.outcome==='invalid-evidence'?3:0;
  }
  if(command==='map') {
    const {mapCapture}=await import('../lib/mapping.mjs');
    await emit(await mapCapture({project:a.project,target:a.target,capture:await readJSON(a.capture)}),a.out);return 0;
  }
  if(command==='scenarios') {
    const {runScenarios}=await import('../lib/scenarios.mjs');
    const result=await runScenarios({config:await readJSON(a.config),output:a.out});
    console.log(JSON.stringify({kind:result.kind,outcome:result.outcome,output:path.resolve(a.out),runs:result.runs?.length}));
    if(result.errors?.some(error=>error.code==='PLAYWRIGHT_UNAVAILABLE'))return 4;
    return result.outcome==='passed'?0:3;
  }
  if(command==='measure') {
    const {measureSite}=await import('../lib/measure.mjs');
    const progressMode=a.progress??'quiet';
    const result=await measureSite({config:await readJSON(a.config),output:a.out,onProgress:progress=>{if(progressMode==='attempt'||(progressMode==='group'&&(progress.event==='run-end'||(progress.event==='attempt-end'&&progress.index===progress.runs))))console.error(JSON.stringify({progress}));}});
    console.log(JSON.stringify({kind:result.kind,status:result.status,output:path.resolve(a.out),counts:result.counts,stopped:result.stopped??null,summary:path.join(path.resolve(a.out),'summary.json')}));
    return result.status==='complete'?0:3;
  }
  if(command==='batch') {
    const {runBatch}=await import('../lib/batch.mjs');
    const {compactArtifact}=await import('../lib/summary.mjs');
    const result=await runBatch({config:await readJSON(a.config),output:a.out});
    console.log(JSON.stringify(outputFormat==='full'?result:compactArtifact(result)));
    return result.status!=='complete'||result.reviewRequired||!['not-evaluated','score-targets-met'].includes(result.acceptance)?3:0;
  }
  if(command==='summarize') {
    const {summarizeRun}=await import('../lib/summary.mjs');
    await emit(await summarizeRun(a.run),a.out);return 0;
  }
  if(command==='evaluate-iteration') {
    const {evaluateIterations}=await import('../lib/iteration.mjs');
    const result=await evaluateIterations(await readJSON(a.config));
    await emit(result,a.out);return result.stop?3:0;
  }
  if(command==='audit-site') {
    const {auditSite}=await import('../lib/site-audit.mjs');
    const result=await auditSite({project:a.project,run:a.run,checks:a.checks?await readJSON(a.checks):null,officialChecks:a.official?await readJSON(a.official):null,resourceAnalysis:a.resources?await readJSON(a.resources):null,precheck:a.precheck?await readJSON(a.precheck):null,runtimeProfile:a.runtime?await readJSON(a.runtime):null,ownership:a.ownership?await readJSON(a.ownership):[],performanceBaseline:a['performance-baseline']?await readJSON(a['performance-baseline']):null,renderedHtml:a['html-audits']?await readJSON(a['html-audits']):[]});
    await emit(result,a.out);return result.complete===false?3:0;
  }
  if(command==='plan-site') {
    const {createSitePlan}=await import('../lib/site-changes.mjs');
    const recipePath=path.resolve(a.recipe);
    await emit(await createSitePlan({project:a.project,recipe:await readJSON(recipePath),recipeDir:path.dirname(recipePath)}),a.out);return 0;
  }
  if(command==='verify-site') {
    const {verifySite}=await import('../lib/site-verify.mjs');
    const result=await verifySite({before:a.before,after:a.after,thresholds:a.thresholds?await readJSON(a.thresholds):undefined});
    await emit(result,a.out);return result.outcome==='score-targets-met'?0:result.outcome==='invalid-evidence'?2:3;
  }
  if(command==='inspect') {
    const {inspectSource}=await import('../lib/inspect.mjs');
    const result=await inspectSource({project:a.project,target:a.target,capture:a.capture?await readJSON(a.capture):null});
    await emit(result,a.out);return 0;
  }
  if(command==='plan-image') {
    const {inspectSource}=await import('../lib/inspect.mjs');
    const {createImagePlan}=await import('../lib/changes.mjs');
    const project=a.project,target=a.target;
    const inspection=a.inspection?await readJSON(a.inspection):await inspectSource({project,target});
    const plan=await createImagePlan({project,target,inspection,imageIndex:number(a,'image',0),sizes:a.sizes,widths:a.widths.split(',').map(Number)});
    await emit(plan,a.out);return 0;
  }
  if(command==='plan-component') {
    const {createPatchPlan}=await import('../lib/changes.mjs');
    const plan=await createPatchPlan({project:a.project,target:a.target,replacement:await fs.readFile(a.replacement,'utf8'),ruleId:a.rule,reason:a.reason,validators:(a.validators??'component-behavior,visual,host-regression').split(',')});
    await emit(plan,a.out);return 0;
  }
  if(command==='apply'||command==='rollback') {
    const {applyPlan,rollbackPlan}=await import('../lib/changes.mjs');
    const plan=await readJSON(a.plan);
    const project=a.project;
    await prepareReceiptOutput(a.out);
    if(plan.kind==='site-change-plan') {
      const {applySitePlan,rollbackSitePlan}=await import('../lib/site-changes.mjs');
      const adapterContext=a['adapter-context']?await readJSON(a['adapter-context']):undefined;
      return emitOperationReceipt(()=>(command==='apply'?applySitePlan:rollbackSitePlan)(plan,project,adapterContext),a.out);
    }
    return emitOperationReceipt(()=>(command==='apply'?applyPlan:rollbackPlan)(plan,project),a.out);
  }
  if(command==='capture') {
    const {capturePage}=await import('../lib/capture.mjs');
    const result=await capturePage({url:a.url,selector:a.selector,output:a.out,viewport:{width:number(a,'width',390),height:number(a,'height',844)},dpr:number(a,'dpr',1),waitMs:number(a,'wait-ms',1500),timeoutMs:number(a,'timeout-ms',30000),project:a.project,target:a.target});
    console.log(JSON.stringify({kind:result.kind,output:path.resolve(a.out),images:result.images?.length,limitations:result.limitations}));return 0;
  }
  if(command==='verify') {
    const {compareCaptures}=await import('../lib/compare.mjs');
    const result=compareCaptures(await readJSON(a.before),await readJSON(a.after));
    await emit(result,a.out);return result.comparable===false||['regression','regression-detected','failed','not-comparable'].includes(result.outcome)?3:0;
  }
  if(command==='report') {
    const {renderReport}=await import('../lib/report.mjs');
    await emit(renderReport(await readJSON(a.input)),a.out);return 0;
  }
  if(command==='lighthouse') {
    const args=[path.join(here,'summarize_lighthouse.py'),a.before];
    if(a.after) args.push(a.after);if(a.out) args.push('--output',a.out);
    const r=spawnSync(process.env.PERF_KIT_PYTHON||'python3',args,{encoding:'utf8'});
    if(r.error) throw r.error;process.stdout.write(r.stdout??'');process.stderr.write(r.stderr??'');return r.status??2;
  }
  if(command==='score-target') {
    const args=['-B',path.join(here,'check_score_target.py'),'--before',a.before,'--after',a.after];
    for(const key of ['minimum','target']) if(a[key]!==undefined) args.push(`--${key}`,a[key]);
    if(a.out) args.push('--output',a.out);
    const r=spawnSync(process.env.PERF_KIT_PYTHON||'python3',args,{encoding:'utf8'});
    if(r.error) throw r.error;process.stdout.write(r.stdout??'');process.stderr.write(r.stderr??'');return r.status??2;
  }
  throw new Error('No handler registered for command ' + command + '.');
}
const entryPath = process.argv[1] ? await fs.realpath(process.argv[1]).catch(() => null) : null;
if(entryPath && entryPath===await fs.realpath(fileURLToPath(import.meta.url))) {
  main().then(code=>{process.exitCode=code;}).catch(error=>{
    console.error(JSON.stringify({error:error.message,code:error.code??'EXECUTION_FAILED'}));
    process.exitCode=['PLAYWRIGHT_UNAVAILABLE','BROWSER_UNAVAILABLE'].includes(error.code)?4:2;
  });
}
