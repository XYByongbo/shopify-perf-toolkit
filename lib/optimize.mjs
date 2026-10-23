import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createSitePlan, applySitePlan, rollbackSitePlan, validateSitePlan } from './site-changes.mjs';
import { checkOptimizationRegression, checkAppBehavior,checkAppDeployment,checkScenarioDeployment,checkExtendedBehavior } from './optimization-regression.mjs';
import { sourceSnapshot } from './runtime-profile.mjs';
import { readRunEvidence } from './run-evidence.mjs';
import { evaluateGain } from './performance-gain.mjs';
import { checkRunDeployment, verifyDeployment } from './deployment.mjs';
import { verifySite } from './site-verify.mjs';
import { measureSite, createRunDirectory, validateMeasureConfig } from './measure.mjs';
import { runScenarios, validateScenarioConfig } from './scenarios.mjs';
import { createBudget } from './execution-policy.mjs';
import { goalContract } from './evidence-contract.mjs';
import { verifyInteractions, interactionMatchesNavigation, interactionBehaviorCovered } from './interaction-measure.mjs';

async function patchGate(plan, patchEvidence, goal, liquidEvidence) {
  if (!patchEvidence) throw new Error('A diagnosis-bound plan requires its independently verifiable single-patch experiment evidence.');
  const input = typeof patchEvidence === 'string' ? JSON.parse(await readFile(patchEvidence,'utf8')) : { ...patchEvidence };
  for (const key of ['diagnosis','regressionBefore','regressionAfter']) if (typeof input[key] === 'string') input[key] = JSON.parse(await readFile(input[key],'utf8'));
  const { verifyPatchExperiment } = await import('./patch-experiment.mjs');
  if (JSON.stringify(goalContract(input.goal)) !== JSON.stringify(goalContract(goal))) throw new Error('Patch experiment goal differs from formal goal.');
  return verifyPatchExperiment({ ...input,plan,minLiquidSamples:5,...(liquidEvidence?{liquidEvidence}:{}) });
}

export async function verifyOptimization({ before, after, regression, expectedSourceHash, review, plan, patchEvidence, goal, interactionEvidence, liquidEvidence, budget: budgetConfig } = {}) {
  const result = { schemaVersion: 1, kind: 'optimization-verification', outcome: 'not-accepted', checks: [],
    scope: 'Measured navigation score improvement on the declared matrix with source identity and supplied behavior/visual review; not field CWV or a guarantee.' };
  try {
    const target=goalContract(goal);result.goal=target;
    if (plan) await validateSitePlan(plan);
    const baseline = await readRunEvidence(before), candidate = await readRunEvidence(after);
    result.scoreTargets = await verifySite({ before, after });
    result.gain = await evaluateGain({ before, after, goal: target.kind==='interaction'?undefined:target });
    const a = checkRunDeployment(baseline), b = checkRunDeployment(candidate);
    if (plan?.changes.some(c => c.evidence?.candidateId)) {
      result.patchExperiment = await patchGate(plan,patchEvidence,target,liquidEvidence);
      result.checks.push({ id: 'single-patch-experiment', pass: result.patchExperiment.outcome === 'promising'
        && result.patchExperiment.sourceHashes.before === a.sourceHash && result.patchExperiment.sourceHashes.after === b.sourceHash });
    }
    result.identity = { before: a, after: b };
    result.checks.push({ id: 'original-score-targets', pass: result.scoreTargets.outcome === 'score-targets-met' },
      { id: target.kind==='score'?'measured-score-gain-no-metric-regression':'declared-goal-gain-no-metric-regression', pass: target.kind==='interaction'
        ? !['invalid-evidence','performance-regressed'].includes(result.gain.outcome) : result.gain.outcome === 'measurable-gain' },
      { id: 'candidate-identity', pass: a.status === 'verified' && b.status === 'verified' && a.store === b.store
        && b.sourceHash === expectedSourceHash && a.sourceHash !== b.sourceHash });
    if(target.kind==='interaction') {
      result.interactions=await verifyInteractions({...interactionEvidence,goal:target,allowExploration:false});
      result.checks.push({id:'independent-interaction-gain',pass:result.interactions.outcome==='interaction-improved'
        &&interactionMatchesNavigation(result.interactions,a,b,baseline.groups,candidate.groups)});
      result.checks.push({id:'declared-interaction-behavior',pass:interactionBehaviorCovered(result.interactions,regression?.scenarios,b)});
    }
    if (plan) result.checks.push({ id: 'plan-matches-measured-source', pass: plan.changes.every(change =>
      (baseline.manifest.deployment?.before?.sourceManifest?.find(f => f.file === change.target)?.sourceHash ?? null) === change.beforeHash
      && candidate.manifest.deployment?.after?.sourceManifest?.some(f => f.file === change.target && f.sourceHash === change.afterHash)) });
    result.checks.push({ id: 'functional-regression', pass: checkOptimizationRegression(regression,candidate,b,expectedSourceHash) });
    if(plan?.changes.some(c=>c.evidence?.domainKind))result.checks.push({id:'domain-regression-deployment',pass:checkScenarioDeployment(regression?.scenarios,b,
      {before:regression?.remoteBefore??candidate.manifest.deployment?.after,after:regression?.remote})});
    if(plan?.changes.some(c=>c.evidence?.domainKind==='app-loader'))result.checks.push({id:'app-business-behavior',pass:checkAppBehavior(plan,regression?.scenarios)&&checkAppDeployment(plan,[candidate.manifest.deployment.before,candidate.manifest.deployment.after,regression?.remoteBefore??candidate.manifest.deployment.after,regression?.remote])});
    if(plan?.changes.some(c=>['hidden-dom','liquid-query','section-fetch'].includes(c.evidence?.domainKind)))result.checks.push({id:'extended-method-behavior',pass:checkExtendedBehavior(plan,regression?.scenarios,{candidate:true})});
    result.checks.push({ id: 'content-and-visual-review', pass: Boolean(review && /^[a-f0-9]{64}$/.test(expectedSourceHash ?? '') && review.sourceHash === expectedSourceHash && review.contentPreserved === true && review.visualsPreserved === true && typeof review.summary === 'string' && review.summary.trim()) });
    // Performance budget check: validate resource budgets against candidate measurements
    if (budgetConfig) {
      const budgetCheck = checkPerformanceBudget(candidate, budgetConfig);
      result.budget = budgetCheck;
      result.checks.push({ id: 'performance-budget', pass: budgetCheck.passed, details: budgetCheck.details });
    }
    result.scope=target.kind==='score'?result.scope:`Declared ${target.kind} laboratory improvement with original navigation score thresholds, identity and behavior gates; field CWV not established.`;
    result.outcome = result.checks.every(c => c.pass) ? 'optimization-accepted' : 'not-accepted';
  } catch (error) { result.outcome = 'invalid-evidence'; result.error = error.message; }
  return result;
}

/** Check performance budgets against candidate measurement resources. */
function checkPerformanceBudget(candidate, budgetConfig) {
  const details = [];
  let passed = true;
  // Aggregate resource metrics from all groups
  const allResources = [];
  for (const group of candidate.groups) {
    for (const record of group.records) {
      const report = record.report;
      // Extract resource summary from Lighthouse audit
      const resourceSummary = report.audits?.['resource-summary'];
      if (resourceSummary?.details?.items) {
        for (const item of resourceSummary.details.items) {
          if (item.resourceType) allResources.push({ type: item.resourceType, size: item.transferSize ?? 0, count: 1 });
        }
      }
    }
  }
  // Check total transfer size budget
  if (budgetConfig.maxTotalTransferBytes) {
    const totalBytes = allResources.reduce((sum, r) => sum + r.size, 0);
    const withinBudget = totalBytes <= budgetConfig.maxTotalTransferBytes;
    details.push({ metric: 'totalTransferBytes', value: totalBytes, limit: budgetConfig.maxTotalTransferBytes, passed: withinBudget });
    if (!withinBudget) passed = false;
  }
  // Check per-resource-type budgets
  if (budgetConfig.maxByType) {
    const byType = new Map();
    for (const r of allResources) byType.set(r.type, (byType.get(r.type) ?? 0) + r.size);
    for (const [type, limit] of Object.entries(budgetConfig.maxByType)) {
      const actual = byType.get(type) ?? 0;
      const withinBudget = actual <= limit;
      details.push({ metric: `transferBytes:${type}`, value: actual, limit, passed: withinBudget });
      if (!withinBudget) passed = false;
    }
  }
  // Check request count budget
  if (budgetConfig.maxRequests) {
    const requestCount = allResources.length;
    const withinBudget = requestCount <= budgetConfig.maxRequests;
    details.push({ metric: 'requestCount', value: requestCount, limit: budgetConfig.maxRequests, passed: withinBudget });
    if (!withinBudget) passed = false;
  }
  return { passed, details, note: 'Performance budgets are advisory gates; they do not replace score thresholds or functional acceptance.' };
}

/** One writer. prepare -> reviewed apply -> explicit preview sync -> explore/accept/functional regression. Never publishes. */
export async function runOptimization({ config, output, dependencies = {} }) {
  if (!config || config.schemaVersion !== 1 || !['prepare','apply','verify'].includes(config.action)
      || Object.keys(config).some(k => !['schemaVersion','action','project','recipe','recipeDir','plan','reviewedPlanHash','before','measurement','scenarios','review','exploreFirst','rollbackOnFailure','patchEvidence','goal','interactionEvidence','liquidEvidence','budget'].includes(k))) throw new Error('Invalid optimization workflow config.');
  const goal=goalContract(config.goal);
  if (!path.isAbsolute(config.project ?? '')) throw new Error('Optimization project must be absolute.');
  for (const key of ['exploreFirst','rollbackOnFailure']) if (config[key] !== undefined && typeof config[key] !== 'boolean') throw new Error(`${key} must be boolean.`);
  const out = await createRunDirectory(output);
  const result = { schemaVersion: 1, kind: 'optimization-run', action: config.action, status: 'running', output: out, steps: [], artifacts: {},
    limitations: ['No preview sync or publication is performed. Apply and verify are separate so stale online code cannot count as the candidate.', 'An exploratory gain or a successful patch is not final performance acceptance.'] };
  const artifact = async (name, value) => { await writeFile(path.join(out, name), JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); result.artifacts[name] = name; };
  let plan, changed = false;
  try {
    if (config.action === 'prepare') {
      plan = await createSitePlan({ project: config.project, recipe: config.recipe, recipeDir: config.recipeDir });
      await artifact('plan.json', plan); result.planHash = plan.planHash; result.status = 'review-required'; return result;
    }
    plan = JSON.parse(await readFile(config.plan, 'utf8'));
    await validateSitePlan(plan);
    if (plan.kind !== 'site-change-plan' || config.reviewedPlanHash !== plan.planHash) throw new Error('Supply the exact reviewedPlanHash of the saved site plan.');
    if (config.action === 'apply') {
      await artifact('apply-receipt.json', await applySitePlan(plan, config.project)); changed = true;
      result.sourceHash = (await sourceSnapshot(config.project)).hash;
      result.status = 'awaiting-preview-sync'; return result;
    }
    const source = await sourceSnapshot(config.project);
    if (!source.complete || !plan.changes.every(change => source.files.some(f => f.file === change.target && f.sourceHash === change.afterHash))) throw new Error('Local source does not match every planned candidate file.');
    changed = true;
    const measurement = validateMeasureConfig(config.measurement);
    const budget = createBudget(measurement.budget), counts = { attempted: 0, failed: 0 };
    result.budget = { limits: budget.limits, counts };
    const measure = async (purpose, runs, destination) => {
      const stop = await budget.check({ attempts: counts.attempted, failures: counts.failed });
      if (stop) throw Object.assign(new Error(`Optimization stopped: ${stop}`), { code: 'OPTIMIZATION_BUDGET' });
      const inner = { ...measurement.budget, maxWallTimeMs: Math.max(1,Math.floor(budget.remainingMs())), maxAttempts: budget.limits.maxAttempts - counts.attempted,
        maxFailures: budget.limits.maxFailures - counts.failed };
      const sampled = await (dependencies.measureSite ?? measureSite)({ config: { ...measurement, purpose, runs, budget: inner }, output: destination });
      counts.attempted += sampled.counts?.attempted ?? measurement.pages.length * measurement.devices.length * runs;
      counts.failed += sampled.counts?.failed ?? (sampled.status === 'complete' ? 0 : 1);
      return sampled;
    };
    if (measurement.purpose !== 'acceptance' || measurement.deployment?.project !== config.project) throw new Error('Verify needs acceptance measurement and deployment verification for the same project.');
    const baseline = await readRunEvidence(config.before);
    if (checkRunDeployment(baseline).status !== 'verified') throw new Error('Baseline lacks bracketed deployment proof. Collect a verified baseline before applying a candidate.');
    if(goal.kind==='interaction'){
      const gate=await verifyInteractions({...config.interactionEvidence,goal,allowExploration:false});await artifact('interaction-gate.json',gate);
      const groups=measurement.pages.flatMap(p=>measurement.devices.map(device=>({...p,device})));
      if(gate.outcome!=='interaction-improved'||!interactionMatchesNavigation(gate,checkRunDeployment(baseline),{status:'verified',sourceHash:source.hash,...measurement.deployment},baseline.groups,groups))throw new Error('Formal interaction evidence is missing, not improved or bound to another source/store/theme/page/device; navigation samples were not started.');
    }
    if (plan.changes.some(c => c.evidence?.candidateId)) {
      const gate = await patchGate(plan,config.patchEvidence,goal,config.liquidEvidence); await artifact('patch-gate.json',gate);
      if (gate.outcome !== 'promising' || gate.sourceHashes.before !== checkRunDeployment(baseline).sourceHash || gate.sourceHashes.after !== source.hash) throw new Error('Single-patch evidence is not promising or does not match this formal baseline/candidate; formal samples were not started.');
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
      const gain = await evaluateGain({ before: config.before, after: exploratory, allowExploration: true, goal }); await artifact('exploratory-gain.json', gain);
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
    const regression = { kind: 'optimization-regression', sourceHash: source.hash, scenarios: behavior, remote };
    await artifact('regression-evidence.json', regression);
    const current = await sourceSnapshot(config.project); if (current.hash !== source.hash) throw new Error('Source changed during regression.');
    const verification = await verifyOptimization({ before: config.before, after: run, regression, expectedSourceHash: source.hash, review: config.review, plan, patchEvidence: config.patchEvidence, goal, interactionEvidence:config.interactionEvidence, liquidEvidence:config.liquidEvidence, budget: config.budget });
    await artifact('verification.json', verification); result.status = verification.outcome;
  } catch (error) { result.status = error.code === 'OPTIMIZATION_BUDGET' ? 'stopped' : 'failed'; result.error = { code: error.code ?? 'OPTIMIZATION_FAILED', message: error.message };
    if (error.receipt) await artifact('failure-receipt.json', error.receipt);
  } finally {
    if (changed && config.action === 'verify' && config.rollbackOnFailure && result.status !== 'optimization-accepted') {
      try { await artifact('rollback-receipt.json', await rollbackSitePlan(plan, config.project)); result.localRollback = 'complete-preview-still-requires-sync'; }
      catch (error) { result.localRollback = 'failed'; if (error.receipt) await artifact('rollback-failure.json', error.receipt); }
    }
    await artifact('optimization.json', result);
  }
  return result;
}
