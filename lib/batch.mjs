import { readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { measureSite, createRunDirectory, validateMeasureConfig } from './measure.mjs';
import { createBudget, validateBudget } from './execution-policy.mjs';
import { summarizeRun, compactArtifact } from './summary.mjs';
import { evaluateIterations, validateEarlyStop } from './iteration.mjs';
import { offlineStep } from './batch-offline.mjs';
import { renderReport } from './report.mjs';
import { precheckTheme, validatePrecheck, assertPrecheckOutput } from './precheck.mjs';
import { checkOfficialPerformance, validateOfficialPerformance } from './official-performance.mjs';

/** One invocation per deployed snapshot. No models, agents, patching, sync or publication. */
export async function runBatch({ config, output, dependencies = {} } = {}) {
  const allowed = ['schemaVersion','measurement','run','project','before','history','earlyStop','budget','agents','checks','resources','quality','runtimeProfiles','liquidProfile','devtoolsProfile','recipe','bottlenecks','demand','field','owners','goal','stylesheets','precheck','officialChecks'];
  if (!config || Array.isArray(config) || config.schemaVersion !== 1 || Object.keys(config).some(k => !allowed.includes(k))) throw new Error('Invalid batch config fields.');
  if (config.agents !== undefined && config.agents !== 1) throw new Error('Batch uses one agent; delegation is not supported.');
  if (config.bottlenecks !== undefined && (!config.project || !config.bottlenecks || typeof config.bottlenecks !== 'object' || Array.isArray(config.bottlenecks) || Object.keys(config.bottlenecks).some(k => !['profiles','limit'].includes(k)))) throw new Error('bottlenecks requires project and {profiles?,limit?}.');
  if (config.bottlenecks?.profiles !== undefined && (!Array.isArray(config.bottlenecks.profiles) || config.bottlenecks.profiles.length > 24 || config.bottlenecks.profiles.some(p => typeof p !== 'string' || !path.isAbsolute(p)))) throw new Error('bottlenecks.profiles must contain saved absolute profile paths.');
  if (config.demand !== undefined && (!config.bottlenecks || config.recipe || !config.demand || typeof config.demand !== 'object' || Array.isArray(config.demand))) throw new Error('demand needs bottlenecks and cannot be combined with a separate recipe.');
  if (Boolean(config.measurement) === Boolean(config.run)) throw new Error('Supply exactly one of measurement or run (offline import).');
  const absolute = (value, label) => { if (typeof value !== 'string' || !path.isAbsolute(value) || /[\x00-\x1f\x7f]/.test(value)) throw new Error(`${label} must be an absolute path.`); };
  for (const k of ['run','project','before']) if (config[k] !== undefined) absolute(config[k], k);
  if (config.checks !== undefined) {
    if (!config.project || !config.checks || typeof config.checks !== 'object' || Array.isArray(config.checks) || Object.keys(config.checks).some(k => !['input','metadata','baseline'].includes(k))) throw new Error('checks requires project and an object with input, optional metadata/baseline.');
    absolute(config.checks.input, 'checks.input');
    for (const k of ['metadata','baseline']) if (config.checks[k] !== undefined) absolute(config.checks[k], `checks.${k}`);
  }
  if (config.resources !== undefined && config.resources !== false) {
    if (!config.project || !config.resources || typeof config.resources !== 'object' || Array.isArray(config.resources) || Object.keys(config.resources).some(k => k !== 'probe') || (config.resources.probe !== undefined && typeof config.resources.probe !== 'boolean')) throw new Error('resources requires project and {probe: boolean}, or false to disable.');
  }
  if(config.quality !== undefined && (typeof config.quality !== 'boolean' || !config.project)) throw new Error('quality requires project and a boolean.');
  const {goalContract}=await import('./evidence-contract.mjs');goalContract(config.goal);
  const {validateOwners}=await import('./app-attribution.mjs');validateOwners(config.owners);
  if(config.field!==undefined)absolute(config.field,'field');
  if(config.stylesheets!==undefined&&(typeof config.stylesheets!=='boolean'||!config.project))throw new Error('stylesheets requires project and boolean.');
  if (config.runtimeProfiles !== undefined && (!config.project || !Array.isArray(config.runtimeProfiles) || !config.runtimeProfiles.length || config.runtimeProfiles.length > 12)) throw new Error('runtimeProfiles needs project and 1..12 explicit page/device/state configs.');
  for (const key of ['liquidProfile','devtoolsProfile','recipe']) if (config[key] !== undefined && (!config.project || typeof config[key] !== 'object' || !config[key] || Array.isArray(config[key]))) throw new Error(`${key} requires project and a config object.`);
  if(config.precheck !== undefined && config.precheck !== false) {
    if(!config.project)throw new Error('precheck requires project.');
    validatePrecheck(config.precheck === true ? {} : config.precheck);
  }
  const useResources = Boolean(config.project) && config.resources !== false;
  if (config.officialChecks !== undefined && config.officialChecks !== false) {
    if (!config.project) throw new Error('officialChecks requires project.');
    validateOfficialPerformance(config.officialChecks === true ? {} : config.officialChecks);
  }
  if (config.history !== undefined && !Array.isArray(config.history)) throw new Error('history must be an array of all before/after pairs.');
  validateBudget(config.budget);
  const limits = validateBudget({ maxFailures: 3, ...config.budget });
  validateEarlyStop(config.earlyStop);
  const measurement = config.measurement ? validateMeasureConfig(config.measurement) : null;
  const budget = createBudget(limits, { now: dependencies.now });
  if(config.precheck||config.officialChecks)await assertPrecheckOutput(config.project,output);
  const out = await createRunDirectory(output);
  const result = { schemaVersion: 1, kind: 'batch-run', status: 'running', agents: 1, startedAt: new Date().toISOString(),
    output: out, steps: [], budget: { limits, modelMeter: budget.modelMeter }, acceptance: 'not-evaluated', reviewRequired: false,
    diagnostics: { precheck: {status: config.precheck ? 'pending' : 'not-requested'}, checks: { status: config.checks ? 'pending' : 'not-requested' }, resources: { status: useResources ? 'pending' : 'not-requested' }, quality: {status: config.quality ? 'pending' : 'not-requested'} }, artifacts: {} };
  const save = async () => {
    const temp = path.join(out, '.batch.json.tmp');
    await writeFile(temp, JSON.stringify(result,null,2)+'\n', { flag:'wx',mode:0o600 });
    await rename(temp,path.join(out,'batch.json'));
  };
  const artifact = async (name, data) => { await writeFile(path.join(out,name),typeof data === 'string' ? data : JSON.stringify(data,null,2)+'\n',{ flag:'wx',mode:0o600 });result.artifacts[name]=name; };
  const stop = reason => { result.status='stopped';result.stopped={ reason }; };
  const guard = async () => { const reason=await budget.check();if(reason)stop(reason);return !reason; };
  const diagnosticTimeout = requested => {
    const remaining = Math.floor(budget.remainingMs());
    if (remaining < 1000) throw Object.assign(new Error('Insufficient remaining diagnostic budget.'), { code: 'WALL_TIME_BUDGET' });
    return Math.min(requested, remaining);
  };
  // CLI subprocesses own bounded process groups, including opt-in resource HEAD probes.
  // Import's exit 3 means retained diagnostic evidence requiring review, not process failure.
  const diagnostic = async (command, args, filename, kind) => {
    const key = command === 'import-check' ? 'checks' : command === 'audit-quality' ? 'quality' : 'resources';
    result.diagnostics[key].status = 'running';
    try {
      const report = await (dependencies.offlineStep ?? offlineStep)(command, [...args, '--out', path.join(out, filename)], { output: out, timeoutMs: budget.remainingMs() });
      if (report?.schemaVersion !== 1 || report.kind !== kind) throw new Error(`Unexpected ${command} result.`);
      result.artifacts[filename] = filename;
      await artifact(filename.replace(/\.json$/, '.html'), renderReport(report));
      return report;
    } catch (error) {
      result.diagnostics[key] = { status: error.code === 'WALL_TIME_BUDGET' ? 'stopped' : 'failed', code: error.code ?? 'DIAGNOSTIC_FAILED' };
      result.steps.push({ command, status: result.diagnostics[key].status });
      throw error;
    }
  };
  await save();
  try {
    if (!await guard()) return result;
    const history = config.history ?? [];
    if (history.length) {
      const gate = await evaluateIterations({ rounds:history, earlyStop:config.earlyStop,maxCandidateRounds:limits.maxCandidateRounds });
      await artifact('history-decision.json',gate);
      if (gate.stop && measurement?.purpose === 'exploration') { stop(gate.decision);return result; }
    }
    let precheck = null, checks = null, officialChecks = null, resourceAnalysis = null, runtimeProfile = null, liquidResult = null;
    if(config.officialChecks) {
      result.diagnostics.officialChecks={status:'running'};
      try {
        const requested=validateOfficialPerformance(config.officialChecks===true?{}:config.officialChecks);
        officialChecks=await (dependencies.checkOfficialPerformance??checkOfficialPerformance)({project:config.project,config:{...requested,timeoutMs:diagnosticTimeout(requested.timeoutMs)}});
        await artifact('official-checks.json',officialChecks);await artifact('official-checks.html',renderReport(officialChecks));
        result.diagnostics.officialChecks={status:officialChecks.complete?'complete':'partial',reviewRequired:officialChecks.reviewRequired,artifact:'official-checks.json'};
        result.reviewRequired ||= officialChecks.reviewRequired;
        result.steps.push({command:'check-performance',status:result.diagnostics.officialChecks.status});await save();
      } catch(error) {
        if(error.officialChecks)await artifact('official-checks-failure.json',error.officialChecks);
        result.diagnostics.officialChecks={status:'failed',message:error.message};
        result.steps.push({command:'check-performance',status:'failed'});throw error;
      }
    }
    if(config.precheck) {
      if(!await guard())return result;
      result.diagnostics.precheck.status='running';
      try {
        const requested=validatePrecheck(config.precheck === true ? {} : config.precheck);
        precheck=await (dependencies.precheckTheme ?? precheckTheme)({project:config.project,config:{...requested,timeoutMs:diagnosticTimeout(requested.timeoutMs)}});
        await artifact('precheck.json',precheck);await artifact('precheck.html',renderReport(precheck));
        await artifact('precheck-checks.json',precheck.checks);
        result.diagnostics.precheck={status:precheck.complete?'complete':'partial',summary:precheck.summary,reviewRequired:precheck.reviewRequired,artifact:'precheck.json'};
        result.reviewRequired ||= precheck.reviewRequired;
        result.steps.push({command:'precheck',status:result.diagnostics.precheck.status});
        await save();
      } catch(error) {
        if(error.precheck)await artifact('precheck-failure.json',error.precheck);
        result.diagnostics.precheck={status:error.code==='WALL_TIME_BUDGET'?'stopped':'failed',message:error.message};
        result.steps.push({command:'precheck',status:result.diagnostics.precheck.status});throw error;
      }
    }
    const profiles = [];
    let field=null;
    if(config.field){
      if(!await guard())return result;
      const {importFieldData}=await import('./field-data.mjs');field=await importFieldData({input:config.field});
      await artifact('field.json',field);await artifact('field.html',renderReport(field));
      result.steps.push({command:'import-field',status:field.status});result.reviewRequired ||= field.status!=='available';
    }
    if(config.stylesheets){
      if(!await guard())return result;
      const {auditStylesheets}=await import('./stylesheet-audit.mjs');const css=await auditStylesheets({project:config.project});
      await artifact('stylesheets.json',css);await artifact('stylesheets.html',renderReport(css));
      result.steps.push({command:'audit-stylesheets',status:css.status});result.reviewRequired ||= css.status!=='compatible-static-patterns';
    }
    if (config.checks) {
      if (!await guard()) return result;
      const args = ['--project', config.project, '--input', config.checks.input];
      for (const key of ['metadata','baseline']) if (config.checks[key]) args.push(`--${key}`, config.checks[key]);
      checks = await diagnostic('import-check', args, 'checks.json', 'check-import');
      const review = !checks.complete || checks.comparison?.gate === 'review-required'
        || (checks.comparison?.gate === 'not-evaluated' && checks.findings.some(f => f.severity === 'error'));
      result.diagnostics.checks = { status: review ? 'review-required' : 'complete', complete: checks.complete,
        comparisonGate: checks.comparison?.gate, observations: checks.summary?.observations, reportedOccurrences: checks.summary?.reportedOccurrences, artifact: 'checks.json' };
      result.reviewRequired ||= review;
      result.steps.push({ command: 'import-check', status: result.diagnostics.checks.status });
      await save();
    }
    if (useResources) {
      if (!await guard()) return result;
      resourceAnalysis = await diagnostic('audit-resources', ['--project', config.project, '--probe', String(config.resources?.probe === true)], 'resources.json', 'resource-audit');
      const probeIncomplete = config.resources?.probe === true && resourceAnalysis.resources.some(resource => resource.network?.status !== 'reachable-headers');
      const review = !resourceAnalysis.complete || resourceAnalysis.findings.length > 0 || resourceAnalysis.unresolved.length > 0 || probeIncomplete;
      result.diagnostics.resources = { status: review ? 'review-required' : 'complete', complete: resourceAnalysis.complete,
        resources: resourceAnalysis.summary.resources, findings: resourceAnalysis.findings.length, unresolved: resourceAnalysis.unresolved.length,
        probeRequested: config.resources?.probe === true, probeIncomplete, network: resourceAnalysis.resources.reduce((counts, resource) => {
          const state = resource.network?.status ?? 'unverified'; counts[state] = (counts[state] ?? 0) + 1; return counts;
        }, {}), artifact: 'resources.json' };
      result.reviewRequired ||= review;
      result.steps.push({ command: 'audit-resources', status: result.diagnostics.resources.status });
      await save();
    }
    if (!await guard()) return result;
    if(config.quality) {
      const args=['--project',config.project];if(checks)args.push('--checks',path.join(out,'checks.json'));else if(officialChecks)args.push('--checks',path.join(out,'official-checks.json'));else if(precheck)args.push('--checks',path.join(out,'precheck-checks.json'));
      const quality=await diagnostic('audit-quality',args,'quality.json','quality-audit');
      result.diagnostics.quality={status:quality.complete?'complete':'partial',complete:quality.complete,summary:quality.summary,artifact:'quality.json'};
      result.reviewRequired ||= !quality.complete || quality.findings.length>0;
      result.steps.push({command:'audit-quality',status:result.diagnostics.quality.status});
      await save();if(!await guard())return result;
    }
    if (config.runtimeProfiles) {
      const { profileRuntime } = await import('./runtime-profile.mjs');
      runtimeProfile = { project: config.project, resources: [], profiles };
      for (const [index, requested] of config.runtimeProfiles.entries()) {
        if (!await guard()) return result;
        const profile = await (dependencies.profileRuntime ?? profileRuntime)({ config: { ...requested, project: config.project, timeoutMs: diagnosticTimeout(requested.timeoutMs ?? 45000) }, output: path.join(out, `runtime-${index + 1}`) });
        if (profile.sourceStable && profile.status === 'complete') runtimeProfile.resources.push(...profile.resources);
        profiles.push(profile);
        result.steps.push({ command: 'profile-runtime', state: requested.state, status: profile.status }); result.reviewRequired ||= profile.status !== 'complete';
        result.artifacts[`runtime-${index + 1}/profile.json`] = `runtime-${index + 1}/profile.json`;
      }
      await artifact('runtime-mapping.json', runtimeProfile);
    }
    if (config.liquidProfile) {
      if (!await guard()) return result;
      const { profileLiquid } = await import('./liquid-profile.mjs');
      try {
        const profile = await (dependencies.profileLiquid ?? profileLiquid)({ config: { ...config.liquidProfile, project: config.project, timeoutMs: diagnosticTimeout(config.liquidProfile.timeoutMs ?? 60000) } });
        liquidResult = profile;
        await artifact('liquid-profile.json', profile); result.steps.push({ command: 'profile-liquid', status: profile.status }); result.reviewRequired ||= profile.status !== 'complete';
      } catch (error) { if (error.code === 'WALL_TIME_BUDGET') throw error; result.steps.push({ command: 'profile-liquid', status: 'unavailable', error: error.message }); result.reviewRequired = true; }
    }
    if (config.devtoolsProfile) {
      if (!await guard()) return result;
      const { profileDevtools } = await import('./devtools-profile.mjs');
      const profile = await (dependencies.profileDevtools ?? profileDevtools)({ config: { ...config.devtoolsProfile, timeoutMs: diagnosticTimeout(config.devtoolsProfile.timeoutMs ?? 60000) }, output: path.join(out, 'devtools') });
      result.artifacts['devtools/devtools.json'] = 'devtools/devtools.json'; result.steps.push({ command: 'profile-devtools', status: profile.status }); result.reviewRequired ||= profile.status !== 'complete';
    }
    if (config.recipe) {
      const { createSitePlan } = await import('./site-changes.mjs');
      const plan = await createSitePlan({ project: config.project, recipe: config.recipe });
      await artifact('plan.json', plan); result.planHash = plan.planHash; result.reviewRequired = true;
    }
    let run=config.run;
    if (measurement) {
      run=path.join(out,'measurement');
      const elapsedLimit = Math.max(1,Math.floor(budget.remainingMs()));
      // Inner limits can tighten but never expand the batch's budgets.
      const inner = Object.fromEntries(['maxWallTimeMs','maxAttempts','maxFailures','maxCandidateRounds'].map(k => [k,Math.min(measurement.budget[k],limits[k]) ]));
      inner.maxWallTimeMs=Math.min(inner.maxWallTimeMs,elapsedLimit);
      const meters=[measurement.budget,limits].filter(x=>x.maxModelTokens!==undefined);
      if(meters.length) {
        if(new Set(meters.map(x=>x.modelUsageFile)).size!==1)throw new Error('Nested model budgets must share the same usage file.');
        Object.assign(inner,{maxModelTokens:Math.min(...meters.map(x=>x.maxModelTokens)),modelUsageFile:meters[0].modelUsageFile});
      }
      const measured=await (dependencies.measureSite ?? measureSite)({config:{...measurement,budget:inner},output:run,dependencies:dependencies.measurement ?? {}});
      result.steps.push({command:'measure',status:measured.status,counts:measured.counts});
      if(measured.status!=='complete') { stop(measured.stopped?.reason ?? 'measurement-incomplete'); }
    }
    const summary=await summarizeRun(run);await artifact('measurement-summary.json',summary);
    result.groups=summary.groups;result.counts=summary.counts;
    if(summary.status!=='complete'||summary.issues.length)stop('measurement-incomplete');
    if(result.status==='stopped')return result;
    if (config.bottlenecks) {
      if (!await guard()) return result;
      for (const file of config.bottlenecks.profiles ?? []) profiles.push(JSON.parse(await readFile(file,'utf8')));
      const { diagnoseUnified } = await import('./decision-engine.mjs');
      const diagnosis = await diagnoseUnified({ project: config.project, profiles, run, liquidProfile: liquidResult, limit: config.bottlenecks.limit ?? 3,field,owners:config.owners,goal:config.goal });
      await artifact('bottlenecks.json',diagnosis); result.steps.push({ command: 'diagnose-performance', status: diagnosis.status }); result.reviewRequired ||= diagnosis.status !== 'candidates-ready'||diagnosis.reviewRequired;
      await artifact('bottlenecks.html',renderReport(diagnosis));await artifact('apps.json',diagnosis.apps);
      if (config.demand) {
        const { createDemandPlan } = await import('./demand-plan.mjs');
        const candidateId = config.demand.candidateId ?? diagnosis.candidates.find(c => c.file === config.demand.source)?.candidateId;
        const plan = await createDemandPlan({ project: config.project, config: { ...config.demand,candidateId },diagnosis,profiles });
        await artifact('plan.json',plan); result.planHash=plan.planHash; result.reviewRequired=true;
      }
    }
    if (!await guard()) return result;
    if(config.before && summary.purpose==='exploration') {
      const gate=await evaluateIterations({rounds:[...history,{before:config.before,after:run}],earlyStop:config.earlyStop,maxCandidateRounds:limits.maxCandidateRounds});
      await artifact('iteration.json',gate);result.decision=gate.decision;
      if(gate.stop)stop(gate.decision);
    }
    if(!await guard())return result;
    if(config.project) {
      const args=['--project',config.project,'--run',run];
      if(checks)args.push('--checks',path.join(out,'checks.json'));
      if(officialChecks)args.push('--official',path.join(out,'official-checks.json'));
      if(resourceAnalysis)args.push('--resources',path.join(out,'resources.json'));
      if(precheck)args.push('--precheck',path.join(out,'precheck.json'));
      if(runtimeProfile)args.push('--runtime',path.join(out,'runtime-mapping.json'));
      const audit=dependencies.auditSite ? await dependencies.auditSite({project:config.project,run,checks,officialChecks,resourceAnalysis,runtimeProfile,precheck}) : await offlineStep('audit-site',[...args,'--out',path.join(out,'audit.json')],{output:out,timeoutMs:budget.remainingMs()});
      if(dependencies.auditSite)await artifact('audit.json',audit);else result.artifacts['audit.json']='audit.json';
      await artifact('audit.html',renderReport(audit));
      result.diagnostics.audit = { status: audit.complete ? 'complete' : 'incomplete', supplemental: (audit.supplemental ?? []).map(item => ({ kind: item.kind, status: item.status })) };
      result.reviewRequired ||= !audit.complete || (audit.supplemental ?? []).some(item => item.status !== 'current-source' || item.report?.reviewRequired);
      result.steps.push({command:'audit-site',status:audit.outcome});
    }
    if(result.status==='stopped'||!await guard())return result;
    if(config.before && summary.purpose==='acceptance') {
      // Original evaluator and its 5-sample, warning, comparability and 75/80–85/90 gates remain authoritative.
      const verification=dependencies.verifySite ? await dependencies.verifySite({before:config.before,after:run}) : await offlineStep('verify-site',['--before',config.before,'--after',run,'--out',path.join(out,'verification.json')],{output:out,timeoutMs:budget.remainingMs()});
      if(dependencies.verifySite)await artifact('verification.json',verification);else result.artifacts['verification.json']='verification.json';await artifact('verification.html',renderReport(verification));
      result.acceptance=verification.outcome;result.steps.push({command:'verify-site',status:verification.outcome});
    }
    result.status='complete';
  } catch(error) { if(error.code==='WALL_TIME_BUDGET')stop('wall-time-budget');else result.status='failed';result.error={code:error.code??'BATCH_ERROR',message:error.message}; }
  finally {
    for (const item of Object.values(result.diagnostics)) if (item.status === 'pending') item.status = 'not-run';
    result.finishedAt=new Date().toISOString();result.budget.elapsedMs=Math.round(budget.elapsedMs());
    if(result.status==='complete' && budget.remainingMs()<=0)stop('wall-time-budget');
    result.artifacts['summary.json']='summary.json';
    await save();
    await artifact('summary.json',compactArtifact(result));
  }
  return result;
}
