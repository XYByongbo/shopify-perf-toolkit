import { configValue, fields, validateAt } from './evidence-contract.mjs';
import path from 'node:path';
import {acceptanceContract} from './standards-policy.mjs';
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import {copyFcpDiagnostics} from './fcp-diagnostics.mjs';
import { sourceSnapshot } from './theme-source.mjs';
import { validateSitePlan } from './site-changes.mjs';
import { requireHypothesis } from './bottlenecks.mjs';
import { readRunEvidence, normalizeEvidenceUrl, requiredGoalGroups } from './run-evidence.mjs';
import { verifyDeployment } from './deployment.mjs';
import { verifyPreservation } from './preservation.mjs';
import { measureSite, validateMeasureConfig, createRunDirectory } from './measure.mjs';
import { runScenarios, validateScenarioConfig } from './scenarios.mjs';
import { createBudget, validateBudget } from './execution-policy.mjs';
import { verifyInteractions, interactionMatchesNavigation } from './interaction-evidence.mjs';
import { verifyLiquidGain } from './liquid-experiment.mjs';
import { checkAppBehavior,checkAppDeployment,checkAppPlan,checkScenarioDeployment,checkExtendedBehavior,checkExtendedPlan } from './optimization-regression.mjs';

import { patchFingerprint, assertHypothesisScope, experimentHistoryGate, verifyOnlyPatch, verifyPatchExperiment } from './patch-verification.mjs';

export { patchFingerprint, assertHypothesisScope, experimentHistoryGate, verifyOnlyPatch, verifyPatchExperiment } from './patch-verification.mjs';

async function combineSamples(roots, destination, declaration, deployment) {
  const evidence = [];
  for (const root of roots) evidence.push(await readRunEvidence(root,{ allowExploration: true }));
  const first = evidence[0], manifest = structuredClone(first.manifest), group = manifest.groups[0];
  manifest.config.runs = roots.length; group.reports = []; group.validReports = []; group.attempts = [];
  if (manifest.config.budget) manifest.config.budget.maxAttempts = roots.length;
  manifest.counts = { planned: roots.length, attempted: roots.length, succeeded: roots.length, failed: 0 };
  manifest.config.deployment = declaration;
  manifest.deployment = deployment;
  manifest.startedAt = deployment.before.startedAt;
  manifest.finishedAt = deployment.after.finishedAt;
  manifest.provenance = { schedule: 'alternating-pair-order', sampleManifests: evidence.map(e => ({ root: e.root, hash: e.manifestHash })) };
  await mkdir(path.join(destination,group.reportsDirectory),{ recursive: true });
  for (const [i,e] of evidence.entries()) {
    if (e.groups.length !== 1 || e.groups[0].records.length !== 1 || e.manifest.engine !== first.manifest.engine || e.groups[0].key !== first.groups[0].key
      || normalizeEvidenceUrl(e.groups[0].url) !== normalizeEvidenceUrl(first.groups[0].url)) throw new Error('Sample matrix changed during the experiment.');
    const relative = `${group.reportsDirectory}/run-${String(i+1).padStart(2,'0')}.json`;
    await copyFile(path.join(e.root,e.groups[0].reports[0]),path.join(destination,relative)); group.reports.push(relative); group.validReports.push(relative);
    const original=e.groups[0].attempts?.find(a=>a.report===e.groups[0].reports[0]);
    if(original?.diagnostics)group.attempts.push({index:i+1,status:'complete',report:relative,
      diagnostics:await copyFcpDiagnostics({source:e.root,destination,record:e.groups[0].records[0],descriptor:original.diagnostics,
        relative:`groups/${group.pageId}/${group.device}/diagnostics/run-${String(i+1).padStart(2,'0')}`})});
  }
  await writeFile(path.join(destination,'run.json'),JSON.stringify(manifest,null,2)+'\n',{ flag: 'wx' });
  return destination;
}

export function validateExperimentConfig(config) {
  fields(config,['schemaVersion','plan','diagnosis','candidateId','before','after','regressionBefore','regressionAfter','history','runs','budget','goal','acceptancePolicy','interactionEvidence','liquidEvidence','previewThemeIdParam'], 'experiment config');
  if (config.schemaVersion !== 1) throw configValue('config.schemaVersion','1');
  const {goal}=acceptanceContract(config.acceptancePolicy,config.goal);
  validateBudget(config.budget);
  const runs = config.runs ?? 3;
  if (![3,4].includes(runs)) throw configValue('runs', '3 or 4 independent samples per side');
  // Support URL parameter-based theme switching: when previewThemeIdParam is set,
  // both sides use the same base URL with different preview_theme_id values.
  const usePreviewParam = typeof config.previewThemeIdParam === 'string' && config.previewThemeIdParam.length > 0;
  const configs = {};
  for (const side of ['before','after']) {
    let measureConfig = { ...config[side], purpose: 'exploration', runs: 1 };
    if (usePreviewParam) {
      // Inject the preview theme ID parameter into the page URL
      const themeId = config[side].deployment?.themeId;
      if (!themeId) throw new Error(`Preview theme ID parameter requires deployment.themeId for ${side} side.`);
      measureConfig.pages = measureConfig.pages.map(page => {
        const url = new URL(page.url);
        url.searchParams.set(config.previewThemeIdParam, String(themeId));
        return { ...page, url: url.href };
      });
    }
    configs[side] = validateAt(side, () => validateMeasureConfig(measureConfig));
    if (configs[side].pages.length !== 1 || configs[side].devices.length !== 1 || !configs[side].deployment) throw new Error('Each side needs one page/device and explicit prepared-preview deployment.');
  }
  for (const side of Object.values(configs)) {
    requiredGoalGroups(goal,[{pageId:side.pages[0].id,device:side.devices[0]}],{representative:true});
  }
  const a=configs.before, b=configs.after;
  if (a.engine !== b.engine || (a.throttlingMethod ?? 'simulate') !== (b.throttlingMethod ?? 'simulate') || a.devices[0] !== b.devices[0] || a.pages[0].id !== b.pages[0].id) throw new Error('Preview measurements must describe the same engine/page/device.');
  // When using preview param, URLs will differ only by the theme ID parameter
  if (!usePreviewParam && normalizeEvidenceUrl(a.pages[0].url) !== normalizeEvidenceUrl(b.pages[0].url)) throw new Error('Preview measurements must describe the same engine/page/device.');
  const regression = {};
  for (const side of ['before','after']) regression[side] = validateScenarioConfig({ ...config[side === 'before' ? 'regressionBefore' : 'regressionAfter'], project: configs[side].deployment.project, expectedThemeId: configs[side].deployment.themeId });
  return {goal, runs, a, b, regression, configs};
}

/** Read-only runner against two explicitly prepared previews. Never edits/syncs/publishes a theme. */
export async function runPatchExperiment({ config, output, dependencies = {} } = {}) {
  const {goal, runs, a, b, regression, configs} = validateExperimentConfig(config);
  const json = async value => typeof value === 'string' ? JSON.parse(await readFile(value,'utf8')) : value;
  const plan = await json(config.plan), diagnosis = await json(config.diagnosis);
  const liquidEvidence=await json(config.liquidEvidence);
  await validateSitePlan(plan);
  const history = await Promise.all((config.history ?? []).map(json));
  const budget = createBudget(config.budget), gate = experimentHistoryGate(history,plan,budget.limits.maxCandidateRounds);
  const base = await sourceSnapshot(a.deployment.project), candidate = await sourceSnapshot(b.deployment.project);
  if (!base.complete || !candidate.complete) throw new Error('Incomplete experiment source.');
  verifyOnlyPatch(plan,base.files,candidate.files);
  const hypothesis = requireHypothesis(diagnosis,config.candidateId,base);
  for (const side of [a,b]) assertHypothesisScope(hypothesis,[{url:side.pages[0].url,device:side.devices[0]}]);
  const out = await createRunDirectory(output), result = { schemaVersion: 1, kind: 'patch-experiment', status: 'running', output: out, schedule: [], history, counts: { attempted: 0, failed: 0 }, formalAcceptance: 'not-evaluated', artifacts: {} };
  const save = async (name,value) => { await writeFile(path.join(out,name),JSON.stringify(value,null,2)+'\n',{ flag: 'wx' }); result.artifacts[name]=name; };
  try {
    await save('plan.json',plan); await save('diagnosis.json',diagnosis);
    if (gate.stop) { result.status='stopped'; result.reason=gate.reason; return result; }
    if(['liquid-hotspot','liquid-query','liquid-render'].includes(hypothesis.kind)) {
      const gate=verifyLiquidGain({evidence:liquidEvidence,hypothesis,beforeIdentity:{sourceHash:base.hash,...a.deployment},afterIdentity:{sourceHash:candidate.hash,...b.deployment}});
      await save('liquid-gate.json',gate);
      if(gate.outcome==='invalid-evidence')throw new Error(`Liquid profiling evidence is invalid: ${gate.error}`);
      if(gate.outcome!=='measurable-gain') {
        result.status=gate.outcome==='performance-regressed'?'performance-regressed':'hypothesis-not-confirmed';
        result.verification={kind:'patch-experiment-verification',fingerprint:patchFingerprint(plan),planHash:plan.planHash,outcome:result.status,liquid:gate,formalAcceptance:'not-evaluated'};
        await save('verification.json',result.verification);return result;
      }
    }
    if(goal.kind==='interaction'){
      const interaction=await verifyInteractions({...config.interactionEvidence,goal,allowExploration:true});await save('interaction-gate.json',interaction);
      const groups=side=>configs[side].pages.flatMap(p=>configs[side].devices.map(device=>({...p,device})));
      const matched = interactionMatchesNavigation(interaction,
        {status:'verified',sourceHash:base.hash,...configs.before.deployment},
        {status:'verified',sourceHash:candidate.hash,...configs.after.deployment},groups('before'),groups('after'));
      if (!matched || interaction.outcome==='invalid-evidence') throw new Error('Independent interaction evidence does not match these source/store/theme/page/device snapshots.');
      if (interaction.outcome!=='interaction-improved') {
        result.status = interaction.outcome==='interaction-regressed' ? 'performance-regressed' : 'no-measurable-gain';
        result.verification = {kind:'patch-experiment-verification',fingerprint:patchFingerprint(plan),
          planHash:plan.planHash,outcome:result.status,interactions:interaction,formalAcceptance:'not-evaluated'};
        await save('verification.json',result.verification);
        return result;
      }
    }
    const roots = { before: [], after: [] }, proofs = { before: {}, after: {} };
    const identity = async (side, stage) => {
      const config = configs[side], remaining = Math.floor(budget.remainingMs());
      if (remaining < 1000) throw new Error('Insufficient deployment proof budget.');
      const proof = await (dependencies.verifyDeployment ?? verifyDeployment)({ config: { ...config.deployment,timeoutMs:Math.min(config.deployment.timeoutMs,remaining) },pages:config.pages });
      proofs[side][stage]=proof;
      await save(`deployment-${side}-${stage}.json`,proof);
      if (proof.status !== 'verified' || proof.sourceHash !== (side === 'before' ? base.hash : candidate.hash)) throw new Error('Prepared preview does not match the declared source.');
    };
    const domain=hypothesis.source.status==='verified-domain-source';
    if(hypothesis.kind==='app-loader'&&!checkAppPlan(plan,hypothesis))throw new Error('App plan lost its diagnosed script/business contract.');
    // New domain evidence brackets behavior as well as independent navigation.
    if(domain)for(const side of ['before','after'])await identity(side,'before');
    if(hypothesis.kind==='app-loader'&&!checkAppDeployment(plan,[proofs.before.before,proofs.after.before]))throw new Error('App script drifted since diagnosis; recapture evidence before measurement.');
    const scenarios = {};
    // Fail functional changes before spending Lighthouse samples. Checkpoints are captured at explicit states.
    for (const side of ['before','after']) {
      const stop = await budget.check({ attempts: result.counts.attempted, failures: result.counts.failed }); if (stop) throw new Error(`Experiment stopped: ${stop}`);
      const cfg = regression[side], perRun = Math.floor(budget.remainingMs()/(cfg.scenarios.length*cfg.viewports.length));
      if (perRun < 1000) throw new Error('Insufficient experiment regression budget.');
      const extraPages=domain&&cfg.scenarios.some(s=>!configs[side].pages.some(p=>p.url===s.url));
      const regressionProof={};
      const verifyRegression=async()=>{
        const pages=[...new Set(cfg.scenarios.map(s=>s.url))].map((url,i)=>({id:`regression-${i}`,url}));
        const remaining=Math.floor(budget.remainingMs());if(remaining<1000)throw new Error('Insufficient regression identity budget.');
        const proof=await(dependencies.verifyDeployment??verifyDeployment)({config:{...configs[side].deployment,timeoutMs:Math.min(configs[side].deployment.timeoutMs,remaining)},pages});
        if(proof.status!=='verified'||proof.sourceHash!==(side==='before'?base.hash:candidate.hash))throw new Error('Regression source drift.');return proof;
      };
      if(extraPages)regressionProof.before=await verifyRegression();
      scenarios[side] = await (dependencies.runScenarios ?? runScenarios)({ config: { ...cfg, runTimeoutMs: Math.min(cfg.runTimeoutMs,perRun) }, output: path.join(out,`regression-${side}`) });
      if(extraPages){regressionProof.after=await verifyRegression();scenarios[side].domainProof=regressionProof;}
      await save(`regression-${side}.json`,scenarios[side]);
    }
    const preservation = verifyPreservation({ before: scenarios.before, after: scenarios.after, beforeSourceHash: base.hash, afterSourceHash: candidate.hash,plan });
    await save('preservation.json',preservation);
    if (preservation.outcome !== 'preserved') {
      if(domain)for(const side of ['before','after'])await identity(side,'after');
      const observedFailure=domain&&scenarios.before.outcome==='passed'&&scenarios.after.outcome==='failed'
        &&checkScenarioDeployment(scenarios.before,{sourceHash:base.hash,...a.deployment},scenarios.before.domainProof??proofs.before)
        &&checkScenarioDeployment(scenarios.after,{sourceHash:candidate.hash,...b.deployment},scenarios.after.domainProof??proofs.after)
        &&scenarios.after.runs.some(r=>r.steps.some(s=>s.outcome==='failed'&&s.error?.code==='ASSERTION_FAILED'));
      result.status=preservation.outcome === 'regressed'||observedFailure ? 'functional-regressed' : 'invalid-evidence'; return result;
    }
    if(plan.changes.some(c=>/\.m?js$/.test(c.target)||c.evidence?.domainKind==='hidden-dom')&&!preservation.checks?.some(c=>c.kind==='interaction-response'))throw new Error('JS changes require observable interaction response timing before navigation samples.');
    if(!checkExtendedPlan(plan,hypothesis)||!checkExtendedBehavior(plan,scenarios.before)||!checkExtendedBehavior(plan,scenarios.after,{candidate:true}))throw new Error('Method-specific behavior or request evidence is missing; navigation samples were not started.');
    if(hypothesis.kind==='app-loader'&&(!checkAppBehavior(plan,scenarios.before)||!checkAppBehavior(plan,scenarios.after)))throw new Error('App script bytes or observable business transition failed verification; navigation samples were not started.');
    if(!domain)for (const side of ['before','after']) await identity(side,'before');
    for (let round=0;round<runs;round++) for (const side of round%2 ? ['after','before'] : ['before','after']) {
      const stop = await budget.check({ attempts: result.counts.attempted, failures: result.counts.failed }); if (stop) throw new Error(`Experiment stopped: ${stop}`);
      const dest = path.join(out,`sample-${result.schedule.length+1}-${side}`);
      const { deployment, ...measurement } = configs[side];
      const sampled = await (dependencies.measureSite ?? measureSite)({ config: { ...measurement, budget: { ...configs[side].budget, maxAttempts: 1, maxFailures: 1, maxWallTimeMs: Math.min(configs[side].budget.maxWallTimeMs,Math.max(1,Math.floor(budget.remainingMs()))) } }, output: dest });
      result.counts.attempted += sampled.counts?.attempted ?? 1; result.counts.failed += sampled.counts?.failed ?? (sampled.status === 'complete' ? 0 : 1);
      result.schedule.push({ round: round+1, side, directory: path.basename(dest), status: sampled.status });
      if (sampled.status !== 'complete') throw new Error('Incomplete sample; failed attempts retained, no replacement sampling.');
      const e = await readRunEvidence(dest,{ allowExploration: true });
      const current = await sourceSnapshot(deployment.project);
      if (!current.complete || current.hash !== (side === 'before' ? base.hash : candidate.hash) || e.groups.some(g => g.records.some(r => r.report.runWarnings?.length))) throw new Error('Sample warnings or local source drift; experiment is invalid.');
      roots[side].push(dest);
    }
    for (const side of ['before','after']) await identity(side,'after');
    const before = await combineSamples(roots.before,path.join(out,'before'),configs.before.deployment,proofs.before), after = await combineSamples(roots.after,path.join(out,'after'),configs.after.deployment,proofs.after);
    await save('patch-evidence.json',{ goal:config.goal,acceptancePolicy:config.acceptancePolicy,interactionEvidence:config.interactionEvidence,liquidEvidence,plan:path.join(out,'plan.json'),diagnosis:path.join(out,'diagnosis.json'),candidateId:config.candidateId,before,after,
      regressionBefore:path.join(out,'regression-before.json'),regressionAfter:path.join(out,'regression-after.json') });
    result.verification = await verifyPatchExperiment({ plan,diagnosis,candidateId: config.candidateId,before,after,regressionBefore: scenarios.before,regressionAfter: scenarios.after,goal:config.goal,acceptancePolicy:config.acceptancePolicy,interactionEvidence:config.interactionEvidence,liquidEvidence });
    result.status=result.verification.outcome; await save('verification.json',result.verification);
  } catch (error) { result.status='invalid-evidence'; result.error=error.message; }
  finally {
    if (!result.verification && result.status !== 'stopped') {
      result.verification = { schemaVersion: 1, kind: 'patch-experiment-verification', fingerprint: patchFingerprint(plan), planHash: plan.planHash, outcome: result.status, error: result.error ?? null, formalAcceptance: 'not-evaluated' };
      await save('verification.json',result.verification);
    }
    await save('experiment.json',result);
  }
  return result;
}
