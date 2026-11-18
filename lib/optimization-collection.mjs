import {navigationGainOptions} from './standards-policy.mjs';
import {validateOptimizationEnvelope,optimizationScenarios,optimizationSamplingPlan} from './optimization-config.mjs';
import {verifyStandardsEvidence} from './standards-acceptance.mjs';
import {integrityRequired} from './delivery-policy.mjs';
import {checkFormalRuntimeIntegrity} from './formal-runtime-integrity.mjs';
import {checkAdapterPlanBinding} from './theme-capabilities.mjs';
import {checkResourceEquivalence} from './resource-equivalence.mjs';
import {formalLiquidRejected} from './formal-recovery.mjs';
import {formalInteractionGate} from './formal-interaction.mjs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { validateSitePlan } from './site-changes.mjs';
import { sourceSnapshot } from './theme-source.mjs';
import { readRunEvidence, requiredGoalGroups, groupIdentity, normalizeEvidenceUrl } from './run-evidence.mjs';
import { evaluateGain } from './performance-gain.mjs';
import { checkRunDeployment, verifyDeployment } from './deployment.mjs';
import { measureSite, createRunDirectory, validateMeasureConfig } from './measure.mjs';
import { runScenarios } from './scenarios.mjs';
import { createBudget } from './execution-policy.mjs';

import {patchGate} from './patch-verification.mjs';
/** Collect source-bound samples and regression artifacts. Never writes theme source or decides acceptance. */
export async function collectOptimizationEvidence({ config, output, dependencies = {} }) {
  const goal = validateOptimizationEnvelope(config, ['verify']);
  const out = await createRunDirectory(output);
  const result = { schemaVersion: 1, kind: 'optimization-run', action: config.action, status: 'running', output: out, steps: [], artifacts: {}, measurementStarted:false,
    limitations: ['No preview sync or publication is performed. Apply and verify are separate so stale online code cannot count as the candidate.', 'An exploratory gain or a successful patch is not final performance acceptance.'] };
  const artifact = async (name, value) => { await writeFile(path.join(out, name), JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); result.artifacts[name] = name; };
  try {
    const plan = JSON.parse(await readFile(config.plan, 'utf8'));
    await validateSitePlan(plan);
    if (plan.kind !== 'site-change-plan' || config.reviewedPlanHash !== plan.planHash) throw new Error('Supply the exact reviewedPlanHash of the saved site plan.');
    const source = await sourceSnapshot(config.project);
    if (!source.complete || !plan.changes.every(change => source.files.some(f => f.file === change.target && f.sourceHash === change.afterHash))) throw new Error('Local source does not match every planned candidate file.');
    result.candidateValidated = true;
    const measurement = validateMeasureConfig(config.measurement);
    if (measurement.purpose !== 'acceptance' || measurement.deployment?.project !== config.project) {
      throw new Error('Verify needs acceptance measurement and deployment verification for the same project.');
    }
    const budget = createBudget(measurement.budget);
    const counts = {attempted:0,failed:0};
    result.budget = {limits:budget.limits,counts};
    // An already established interaction or Liquid rejection can be returned
    // without a regression configuration because it never starts navigation.
    let scenarios, scenarioError, samplingBudget;
    try { scenarios = optimizationScenarios(config,measurement); }
    catch (error) { scenarioError = error; }
    if (scenarios) {
      samplingBudget = optimizationSamplingPlan(config,goal,measurement,scenarios);
      result.samplingBudget = samplingBudget;
      await artifact('sampling-budget.json',samplingBudget);
      if (!samplingBudget.fits) {
        throw Object.assign(new Error(
          `Optimization needs ${samplingBudget.totalAttempts} navigation attempts (${samplingBudget.explorationAttempts} exploration, ${samplingBudget.formalAttempts} formal) with ${samplingBudget.maxAttempts} available, and more than ${samplingBudget.minimumWallTimeMs} ms (configured ${samplingBudget.maxWallTimeMs} ms).`
        ), {code:'OPTIMIZATION_BUDGET'});
      }
    }
    const baseline = await readRunEvidence(config.before);
    if (baseline.manifest.engine !== measurement.engine
      || (measurement.engine === 'lighthouse' && baseline.groups.some(group =>
        group.records[0].report.configSettings.throttlingMethod !== (measurement.throttlingMethod ?? 'simulate')))) {
      throw new Error('Formal measurement must use the baseline engine and throttling method.');
    }
    const matrix = measurement.pages.flatMap(page=>measurement.devices.map(device=>({pageId:page.id,url:page.url,device})));
    requiredGoalGroups(goal,baseline.groups);
    requiredGoalGroups(goal,matrix);
    const baselineUrls = new Map(baseline.groups.map(group=>[groupIdentity(group),normalizeEvidenceUrl(group.url)]));
    if (matrix.length !== baselineUrls.size || matrix.some(group=>baselineUrls.get(groupIdentity(group)) !== normalizeEvidenceUrl(group.url))) {
      throw new Error('Formal measurement page/device matrix must match the baseline.');
    }
    const baselineIdentity = checkRunDeployment(baseline);
    if (baselineIdentity.status !== 'verified') throw new Error('Baseline lacks bracketed deployment proof. Collect a verified baseline before applying a candidate.');
    const baselineFiles = new Map(baseline.manifest.deployment.before.sourceManifest.map(file => [file.file,file.sourceHash]));
    if (baselineIdentity.store !== measurement.deployment.store || !plan.changes.every(change => (baselineFiles.get(change.target) ?? null) === change.beforeHash)) {
      throw new Error('Baseline store or source does not match the reviewed plan.');
    }
    if(config.acceptancePolicy){
      const standards=await verifyStandardsEvidence({input:config.standardsEvidence,beforeManifest:baseline.manifest.deployment.before.sourceManifest,
        afterManifest:source.files,sourceHash:source.hash,pages:measurement.pages.map(p=>p.url)});
      await artifact('standards-preflight.json',standards);
      if (!standards.pass) {
        const failed = standards.checks.filter(check=>check.blocking!==false && !check.pass).map(check=>check.id);
        throw new Error('Standards evidence incomplete or failed for ' + failed.join(', ') + '. See standards-preflight.json.');
      }
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
      const gate = await patchGate(plan,config.patchEvidence,goal,config.liquidEvidence,config.acceptancePolicy); await artifact('patch-gate.json',gate);
      if(formalLiquidRejected(gate,checkRunDeployment(baseline),source.hash)) {
        result.preflightRejection={kind:'formal-liquid',outcome:gate.liquid.outcome};result.status='formal-preflight-rejected';return result;
      }
      if (gate.outcome !== 'promising' || gate.sourceHashes.before !== checkRunDeployment(baseline).sourceHash || gate.sourceHashes.after !== source.hash || gate.identity?.before?.store!==checkRunDeployment(baseline).store || gate.identity?.after?.store!==measurement.deployment.store) throw new Error('Single-patch evidence is not promising or does not match this formal baseline/candidate; formal samples were not started.');
    }
    if (scenarioError) throw scenarioError;
    for (const page of measurement.pages) for (const device of measurement.devices) if (!scenarios.scenarios.some(s => s.url === page.url && s.steps.some(x => x.action.startsWith('assert-'))) || !scenarios.viewports.some(v => v.name === device)) throw new Error('Regression scenarios must include assertions for each measured URL and named mobile/desktop viewport.');
    const measure = async (purpose, runs, destination) => {
      const stop = await budget.check({ attempts: counts.attempted, failures: counts.failed, reserveMs:samplingBudget.minimumWallTimeMs });
      if (stop) throw Object.assign(new Error(`Optimization stopped: ${stop}`), { code: 'OPTIMIZATION_BUDGET' });
      const inner = { ...measurement.budget, maxWallTimeMs: Math.max(1,Math.floor(budget.remainingMs()-samplingBudget.regressionReserveMs)), maxAttempts: budget.limits.maxAttempts - counts.attempted,
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
    if (samplingBudget.explorationAttempts) {
      const exploratory = path.join(out, 'exploration');
      const samples = await measure('exploration',samplingBudget.explorationsPerGroup,exploratory);
      result.steps.push({ step: 'exploration', status: samples.status });
      if (samples.status !== 'complete') throw new Error('Exploratory measurement incomplete.');
      const evidence = await readRunEvidence(exploratory, { allowExploration: true });
      const identity = checkRunDeployment(evidence);
      if (identity.status !== 'verified' || identity.sourceHash !== source.hash || identity.store !== baselineIdentity.store) {
        throw new Error('Exploration measured a different candidate.');
      }
      const gain = await evaluateGain({ before: config.before, after: exploratory, allowExploration:true,...navigationGainOptions(goal,config.acceptancePolicy) }); await artifact('exploratory-gain.json', gain);
      if (gain.outcome !== 'measurable-gain') {
        result.status = gain.outcome;
        if (['performance-regressed','no-measurable-gain'].includes(gain.outcome)) {
          result.explorationRejection = gain.outcome;
        }
        return result;
      }
    }
    const run = path.join(out, 'acceptance');
    const measured = await measure('acceptance',measurement.runs,run);
    result.steps.push({ step: 'acceptance-measurement', status: measured.status });
    if (measured.status !== 'complete') throw new Error('Formal measurement incomplete.');
    const evidence = await readRunEvidence(run);
    if (checkRunDeployment(evidence).sourceHash !== source.hash) throw new Error('Formal samples measured a different candidate.');
    const reserve = measurement.deployment.timeoutMs;
    const perRun = Math.floor((budget.remainingMs()-reserve-samplingBudget.regressionOverheadMs)/samplingBudget.scenarioRuns);
    if (perRun < samplingBudget.minimumScenarioMs) throw Object.assign(new Error('Insufficient optimization budget for regression and final identity check.'), { code: 'OPTIMIZATION_BUDGET' });
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
