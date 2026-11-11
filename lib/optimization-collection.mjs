import {acceptanceContract} from './standards-policy.mjs';
import {verifyStandardsEvidence} from './standards-acceptance.mjs';
import {integrityRequired,validateDeliveryPolicy} from './delivery-policy.mjs';
import {checkFormalRuntimeIntegrity} from './formal-runtime-integrity.mjs';
import {checkAdapterPlanBinding} from './theme-capabilities.mjs';
import {checkResourceEquivalence} from './resource-equivalence.mjs';
import {formalLiquidRejected} from './formal-recovery.mjs';
import {formalInteractionGate} from './formal-interaction.mjs';
import { validateResourceBudget } from './resource-budget.mjs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { validateSitePlan } from './site-changes.mjs';
import { sourceSnapshot } from './theme-source.mjs';
import { readRunEvidence } from './run-evidence.mjs';
import { evaluateGain } from './performance-gain.mjs';
import { checkRunDeployment, verifyDeployment } from './deployment.mjs';
import { measureSite, createRunDirectory, validateMeasureConfig } from './measure.mjs';
import { runScenarios, validateScenarioConfig } from './scenarios.mjs';
import { createBudget } from './execution-policy.mjs';
import { goalContract } from './evidence-contract.mjs';

import {patchGate} from './optimization-verification.mjs';
/** Collect source-bound samples and regression artifacts. Never writes theme source or decides acceptance. */
export async function collectOptimizationEvidence({ config, output, dependencies = {} }) {
  if (!config || config.schemaVersion !== 1 || config.action !== 'verify'
      || Object.keys(config).some(k => !['schemaVersion','action','project','recipe','recipeDir','plan','reviewedPlanHash','before','measurement','scenarios','review','exploreFirst','rollbackOnFailure','patchEvidence','goal','interactionEvidence','liquidEvidence','resourceProfiles','integrityProfiles','budget','policy','businessEvidence','acceptancePolicy','standardsEvidence'].includes(k))) throw new Error('Invalid optimization workflow config.');
  validateDeliveryPolicy(config.policy);
  acceptanceContract(config.acceptancePolicy,config.goal);
  const goal=goalContract(config.goal);
  if (config.budget !== undefined) validateResourceBudget(config.budget);
  if (!path.isAbsolute(config.project ?? '')) throw new Error('Optimization project must be absolute.');
  for (const key of ['exploreFirst','rollbackOnFailure']) if (config[key] !== undefined && typeof config[key] !== 'boolean') throw new Error(`${key} must be boolean.`);
  const out = await createRunDirectory(output);
  const result = { schemaVersion: 1, kind: 'optimization-run', action: config.action, status: 'running', output: out, steps: [], artifacts: {}, measurementStarted:false,
    limitations: ['No preview sync or publication is performed. Apply and verify are separate so stale online code cannot count as the candidate.', 'An exploratory gain or a successful patch is not final performance acceptance.'] };
  const artifact = async (name, value) => { await writeFile(path.join(out, name), JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); result.artifacts[name] = name; };
  let plan;
  try {
    plan = JSON.parse(await readFile(config.plan, 'utf8'));
    await validateSitePlan(plan);
    if (plan.kind !== 'site-change-plan' || config.reviewedPlanHash !== plan.planHash) throw new Error('Supply the exact reviewedPlanHash of the saved site plan.');
    const source = await sourceSnapshot(config.project);
    if (!source.complete || !plan.changes.every(change => source.files.some(f => f.file === change.target && f.sourceHash === change.afterHash))) throw new Error('Local source does not match every planned candidate file.');
    result.candidateValidated = true;
    const measurement = validateMeasureConfig(config.measurement);
    const budget = createBudget(measurement.budget), counts = { attempted: 0, failed: 0 };
    result.budget = { limits: budget.limits, counts };
    const measure = async (purpose, runs, destination) => {
      const stop = await budget.check({ attempts: counts.attempted, failures: counts.failed });
      if (stop) throw Object.assign(new Error(`Optimization stopped: ${stop}`), { code: 'OPTIMIZATION_BUDGET' });
      const inner = { ...measurement.budget, maxWallTimeMs: Math.max(1,Math.floor(budget.remainingMs())), maxAttempts: budget.limits.maxAttempts - counts.attempted,
        maxFailures: budget.limits.maxFailures - counts.failed };
      const reserved=measurement.pages.length * measurement.devices.length * runs;
      if(reserved>inner.maxAttempts)throw Object.assign(new Error('Insufficient optimization attempt budget.'),{code:'OPTIMIZATION_BUDGET'});
      result.measurementStarted=true;counts.attempted+=reserved;
      try {
        const sampled = await (dependencies.measureSite ?? measureSite)({ config: { ...measurement, purpose, runs, budget: inner }, output: destination });
        const used=sampled.counts?.attempted;
        if(Number.isSafeInteger(used)&&used>=0&&used<=reserved)counts.attempted-=reserved-used;
        counts.failed += sampled.counts?.failed ?? (sampled.status === 'complete' ? 0 : 1);
        return sampled;
      } catch(error) {counts.failed++;throw error;}
    };
    if (measurement.purpose !== 'acceptance' || measurement.deployment?.project !== config.project) throw new Error('Verify needs acceptance measurement and deployment verification for the same project.');
    const baseline = await readRunEvidence(config.before);
    if (checkRunDeployment(baseline).status !== 'verified') throw new Error('Baseline lacks bracketed deployment proof. Collect a verified baseline before applying a candidate.');
    if(config.acceptancePolicy){
      const standards=await verifyStandardsEvidence({input:config.standardsEvidence,beforeManifest:baseline.manifest.deployment.before.sourceManifest,
        afterManifest:source.files,sourceHash:source.hash,pages:measurement.pages.map(p=>p.url)});
      await artifact('standards-preflight.json',standards);
      if(!standards.pass)throw new Error('Standards evidence incomplete or failed; formal sampling not started.');
    }
    const integrityProfiles=config.integrityProfiles!==undefined?await loadResourceProfiles(config.integrityProfiles):undefined;
    if((config.acceptancePolicy||integrityRequired(plan,config.policy))&&!integrityProfiles)throw new Error('Selected policy requires deployment-bound integrityProfiles before formal sampling.');
    if(config.policy&&!plan.adapter)throw new Error('delivery-v1 requires a source-bound theme adapter before formal sampling.');
    if(plan.adapter&&!checkAdapterPlanBinding(plan,checkRunDeployment(baseline),
      {sourceHash:source.hash,store:measurement.deployment.store,themeId:String(measurement.deployment.themeId)},
      baseline.manifest.deployment?.before?.sourceManifest??[]))throw new Error('Adapter identity/capability evidence does not match formal baseline and candidate.');
    if((config.policy||config.acceptancePolicy)&&integrityProfiles){
      const check=checkFormalRuntimeIntegrity(integrityProfiles,checkRunDeployment(baseline),
        {status:'verified',sourceHash:source.hash,store:measurement.deployment.store,themeId:String(measurement.deployment.themeId)},
        measurement.pages.flatMap(p=>measurement.devices.map(device=>({url:p.url,device}))));
      if(!check.pass)throw new Error('Policy integrity evidence is invalid or requires review; formal sampling not started.');
    }
    const resourceProfiles=config.resourceProfiles?await loadResourceProfiles(config.resourceProfiles):undefined;
    if(plan.changes.some(c=>c.recipeKind==='liquid-rehost-resource')&&!checkResourceEquivalence(plan,resourceProfiles,checkRunDeployment(baseline),
      {sourceHash:source.hash,store:measurement.deployment.store,themeId:measurement.deployment.themeId},
      measurement.pages.flatMap(p=>measurement.devices.map(device=>({url:p.url,device})))))throw new Error('Equivalent resource GET, rendered target and deployment evidence required before collecting scores.');
    if(goal.kind==='interaction'){
      const gate=await formalInteractionGate({evidence:config.interactionEvidence,goal,baseline,measurement,sourceHash:source.hash});
      await artifact('interaction-gate.json',gate);
      if(gate.outcome!=='interaction-improved') {
        result.preflightRejection={kind:'formal-interaction',outcome:gate.outcome};result.status='formal-preflight-rejected';return result;
      }
    }
    if (plan.changes.some(c => c.evidence?.candidateId)) {
      const gate = await patchGate(plan,config.patchEvidence,goal,config.liquidEvidence); await artifact('patch-gate.json',gate);
      if(formalLiquidRejected(gate,checkRunDeployment(baseline),source.hash)) {
        result.preflightRejection={kind:'formal-liquid',outcome:gate.liquid.outcome};result.status='formal-preflight-rejected';return result;
      }
      if (gate.outcome !== 'promising' || gate.sourceHashes.before !== checkRunDeployment(baseline).sourceHash || gate.sourceHashes.after !== source.hash || gate.identity?.before?.store!==checkRunDeployment(baseline).store || gate.identity?.after?.store!==measurement.deployment.store) throw new Error('Single-patch evidence is not promising or does not match this formal baseline/candidate; formal samples were not started.');
    }
    if (config.scenarios?.project !== undefined && config.scenarios.project !== config.project
      || config.scenarios?.expectedThemeId !== undefined && String(config.scenarios.expectedThemeId) !== measurement.deployment.themeId) throw new Error('Regression project/theme differs from the measured candidate.');
    const scenarios = validateScenarioConfig({ ...config.scenarios, project: config.project, expectedThemeId: measurement.deployment.themeId });
    for (const page of measurement.pages) for (const device of measurement.devices) if (!scenarios.scenarios.some(s => s.url === page.url && s.steps.some(x => x.action.startsWith('assert-'))) || !scenarios.viewports.some(v => v.name === device)) throw new Error('Regression scenarios must include assertions for each measured URL and named mobile/desktop viewport.');
    if (config.exploreFirst !== false && !config.patchEvidence && goal.kind!=='interaction') {
      const exploratory = path.join(out, 'exploration');
      const samples = await measure('exploration',3,exploratory);
      result.steps.push({ step: 'exploration', status: samples.status });
      if (samples.status !== 'complete') throw new Error('Exploratory measurement incomplete.');
      const evidence = await readRunEvidence(exploratory, { allowExploration: true });
      if (checkRunDeployment(evidence).sourceHash !== source.hash) throw new Error('Exploration measured a different candidate.');
      const gain = await evaluateGain({ before: config.before, after: exploratory, allowExploration: true, goal, scoreDiagnosticOnly:Boolean(config.acceptancePolicy) }); await artifact('exploratory-gain.json', gain);
      if (gain.outcome !== 'measurable-gain') { result.status = gain.outcome; return result; }
    }
    const run = path.join(out, 'acceptance');
    const measured = await measure('acceptance',measurement.runs,run);
    result.steps.push({ step: 'acceptance-measurement', status: measured.status });
    if (measured.status !== 'complete') throw new Error('Formal measurement incomplete.');
    const evidence = await readRunEvidence(run);
    if (checkRunDeployment(evidence).sourceHash !== source.hash) throw new Error('Formal samples measured a different candidate.');
    const reserve = measurement.deployment.timeoutMs;
    const perRun = Math.floor((budget.remainingMs()-reserve-30000)/(scenarios.scenarios.length*scenarios.viewports.length));
    if (perRun < 1000) throw Object.assign(new Error('Insufficient optimization budget for regression and final identity check.'), { code: 'OPTIMIZATION_BUDGET' });
    const behavior = await (dependencies.runScenarios ?? runScenarios)({ config: { ...scenarios, runTimeoutMs: Math.min(scenarios.runTimeoutMs,perRun) }, output: path.join(out, 'regression') });
    if (budget.remainingMs() < reserve) throw Object.assign(new Error('Insufficient budget for final identity check.'), { code: 'OPTIMIZATION_BUDGET' });
    const remote = await (dependencies.verifyDeployment ?? verifyDeployment)({ config: measurement.deployment, pages: measurement.pages });
    const regression = { kind: 'optimization-regression', sourceHash: source.hash, scenarios: behavior, remote, ...(resourceProfiles?{resourceProfiles}:{}),...(integrityProfiles?{integrityProfiles}:{}) };
    if(config.businessEvidence)regression.businessEvidence=config.businessEvidence;
    await artifact('regression-evidence.json', regression);
    const current = await sourceSnapshot(config.project); if (current.hash !== source.hash) throw new Error('Source changed during regression.');
    result.verificationInput={acceptancePolicy:config.acceptancePolicy,standardsEvidence:config.standardsEvidence,policy:config.policy,before:config.before,after:run,regression,expectedSourceHash:source.hash,review:config.review,plan,patchEvidence:config.patchEvidence,goal,interactionEvidence:config.interactionEvidence,liquidEvidence:config.liquidEvidence,budget:config.budget};
    result.status='evidence-collected';
  } catch (error) { result.status = error.code === 'OPTIMIZATION_BUDGET' ? 'stopped' : 'failed'; result.error = { code: error.code ?? 'OPTIMIZATION_FAILED', message: error.message };
    if (error.receipt) await artifact('failure-receipt.json', error.receipt);
  } finally {
    await artifact('optimization.json', result);
  }
  return result;
}

async function loadResourceProfiles(input) {
  const value=typeof input==='string'?JSON.parse(await readFile(input,'utf8')):input;
  if(!value||!['before','after'].every(k=>Array.isArray(value[k])&&value[k].length>0&&value[k].length<=24))throw new Error('resourceProfiles needs 1..24 before/after profiles.');
  const result={};for(const k of ['before','after'])result[k]=await Promise.all(value[k].map(p=>typeof p==='string'?readFile(p,'utf8').then(JSON.parse):p));return result;
}
