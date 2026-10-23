import { readFile, writeFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRunDirectory } from './measure.mjs';
import { sourceSnapshot } from './runtime-profile.mjs';
import { digest, fields, goalContract } from './evidence-contract.mjs';
import { validateBudget, createBudget } from './execution-policy.mjs';
import { diagnoseRecovery, hypothesisKey, remainingDomainMethods } from './recovery.mjs';
import { createSitePlan, validateSitePlan, applySitePlan, rollbackSitePlan } from './site-changes.mjs';
import { createDemandPlan } from './demand-plan.mjs';
import { createSplitPlan } from './split-plan.mjs';
import { createOfficialPlan } from './official-plan.mjs';
import { officialMethodCatalog } from './official-methods.mjs';
import { readShopifySources } from './shopify-docs.mjs';
import { createDomainPlan } from './domain-plan.mjs';
import { requireHypothesis } from './bottlenecks.mjs';
import { patchFingerprint, runPatchExperiment, assertHypothesisScope } from './patch-experiment.mjs';
import { verifyOptimization } from './optimize.mjs';
import { evaluateGain } from './performance-gain.mjs';
import { readRunEvidence, normalizeEvidenceUrl } from './run-evidence.mjs';
import { validateLhrReport } from './lhr-contract.mjs';
import { checkRunDeployment } from './deployment.mjs';

const json = async value => typeof value === 'string' ? JSON.parse(await readFile(value, 'utf8')) : value;
const actions = {
  start: ['project','run','profiles','liquidProfile','field','owners','goal','budget','sources'],
  refresh: ['run','profiles','liquidProfile','field','owners'],
  prepare: ['candidateId','method','rationale','recipe','recipeDir','demand','split','plan','domain','official','sources'],
  apply: ['reviewedPlanHash'], experiment: ['experiment'], verify: ['verification'], rollback: [],
};
const hashSession = state => { const { sessionHash, ...body } = state; return digest(body); };

export async function readImprovementSession(file) {
  if (!path.isAbsolute(file ?? '')) throw new Error('previous must be an absolute session.json path.');
  const state = await json(file);
  if (state.kind !== 'improvement-session' || state.schemaVersion !== 1 || state.sessionHash !== hashSession(state)) throw new Error('Invalid or changed session evidence.');
  if (await realpath(file) !== path.join(state.output,'session.json')) throw new Error('Session must be resumed from its original output directory, not a copied session file.');
  // A chain is an integrity trail, not a signature. Check every parent, not only the latest object.
  let child = state, depth = 0;
  while (child.previous) {
    if (++depth > 200) throw new Error('Session history exceeds 200 steps.');
    const parent = await json(child.previous);
    const link = await json(path.join(path.dirname(child.previous),'next-step.json'));
    if (await realpath(child.previous) !== path.join(parent.output,'session.json') || link.output !== child.output || link.action !== child.action) throw new Error('Broken session directory/continuation link.');
    if (parent.sessionHash !== hashSession(parent) || child.parentHash !== parent.sessionHash || child.id !== parent.id
      || child.step !== parent.step+1 || child.project !== parent.project || child.originalRun !== parent.originalRun
      || digest(child.goal) !== digest(parent.goal) || digest(child.budget) !== digest(parent.budget)
      || parent.officialSources && digest(child.officialSources)!==digest(parent.officialSources)
      || child.counts.attempted < parent.counts.attempted || child.counts.rounds < parent.counts.rounds
      || child.counts.failed < parent.counts.failed || child.elapsedMs < parent.elapsedMs
      || (child.modelUsageTokens ?? 0) < (parent.modelUsageTokens ?? 0)
      || digest(child.history.slice(0,parent.history.length)) !== digest(parent.history)) throw new Error('Broken session history or reset budget.');
    child = parent;
  }
  return state;
}

/** A resumable single-writer workflow. Remote synchronization remains explicit. */
export async function runImprovement({ config, output, dependencies = {} }) {
  if (!actions[config?.action]) throw new Error('Use start, refresh, prepare, apply, experiment, verify or rollback.');
  fields(config, ['schemaVersion','action','previous',...actions[config.action]], 'improvement config');
  if (config.schemaVersion !== 1 || (config.action === 'start') === Boolean(config.previous)) throw new Error('Only start omits previous.');
  const previous = config.previous ? await readImprovementSession(config.previous) : null;
  let state;
  if (previous) {
    state = structuredClone(previous);
    state.previous = path.resolve(config.previous); state.parentHash = previous.sessionHash; state.step++;
    delete state.error; delete state.operationReceipt;
  } else {
    if (!path.isAbsolute(config.project ?? '') || !path.isAbsolute(config.run ?? '')) throw new Error('start needs absolute project and run paths.');
    state = { schemaVersion: 1, kind: 'improvement-session', id: randomUUID(), step: 0,
      project: await realpath(config.project), originalRun: config.run, baselineRun: config.run,
      goal: goalContract(config.goal), budget: validateBudget(config.budget), counts: { rounds: 0, attempted: 0, failed: 0 },
      elapsedMs: 0, history: [], retained: [], baselineReplacements: [], status: 'diagnosis-required', acceptance: 'not-evaluated',
      inputs: { profiles: [], owners: [] }, limitations: ['No automatic preview synchronization or publishing.',
        'A promising patch and an improved intermediate baseline are not formal acceptance.',
        'CLI does not invoke a model or invent review evidence; complex patches are supplied by the operator.',
        'Session hashes detect accidental drift, not malicious rewriting or authorization.'] };
  }
  // Check before directory creation; createRunDirectory then refuses symlink ancestors.
  const relative = path.relative(state.project, path.resolve(output));
  if (!relative || (!relative.startsWith('..'+path.sep) && relative !== '..' && !path.isAbsolute(relative))) throw new Error('Session output must be outside the theme.');
  const out = await createRunDirectory(output);
  const save = async (name, value) => {
    const file = path.join(out,name); await writeFile(file,JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600}); return file;
  };
  if (previous) await writeFile(path.join(path.dirname(config.previous), 'next-step.json'), JSON.stringify({ output: out, action: config.action })+'\n', { flag: 'wx', mode: 0o600 });
  state.output = out; state.action = config.action;
  const started = performance.now();
  const budget = createBudget({ ...state.budget, maxWallTimeMs: Math.max(1, Math.floor(state.budget.maxWallTimeMs-state.elapsedMs)) },
    {initialModelTokens:state.modelUsageTokens ?? 0});
  const guard = async (round = false) => {
    const reason = state.elapsedMs >= state.budget.maxWallTimeMs ? 'wall-time-budget'
      : await budget.check({ attempts: state.counts.attempted, failures: state.counts.failed, rounds: round ? state.counts.rounds : 0 });
    if (reason) throw Object.assign(new Error(reason), { code: 'SESSION_BUDGET' });
  };
  const snapshot = async expected => {
    const current = await sourceSnapshot(state.project);
    if (!current.complete || expected && current.hash !== expected) throw new Error('Session source drift; inspect local edits before continuing.');
    return current;
  };
  const activePlan = async () => {
    const plan = await json(state.active.plan); await validateSitePlan(plan);
    if (plan.planHash !== state.active.planHash || patchFingerprint(plan) !== state.active.fingerprint) throw new Error('Active plan changed since preparation.');
    return plan;
  };
  // Pin raw report bytes as well as the manifest. Editing scores in-place must not
  // turn yesterday's failed experiment into today's accepted evidence.
  const pinRun = async run => {
    const e = await readRunEvidence(run,{allowExploration:true});
    const hash = digest([e.manifestHash,e.groups.map(g=>[g.key,g.records.map(r=>[r.relative,r.sha256])])]);
    state.evidenceRuns ??= {};
    if (state.evidenceRuns[e.root] && state.evidenceRuns[e.root] !== hash) throw new Error('Previously recorded measurement evidence changed.');
    state.evidenceRuns[e.root] = hash;
    return e;
  };
  const updateInputs = async () => {
    for (const key of ['profiles','liquidProfile','field','owners']) if (config[key] !== undefined) state.inputs[key] = key === 'profiles'
      ? await Promise.all((await json(config[key])).map(json)) : await json(config[key]);
  };
  const replaceBaseline = async run => {
    const old = await readRunEvidence(state.baselineRun,{allowExploration:true}), replacement = await readRunEvidence(run);
    if (old.manifest.config.purpose!=='exploration') throw new Error('A valid formal baseline is fixed; only upgrade exploratory evidence, never resample a lower baseline.');
    const left = checkRunDeployment(old), right = checkRunDeployment(replacement);
    if (right.status!=='verified' || right.sourceHash!==state.baselineHash || left.store!==right.store
      || old.manifest.engine!==replacement.manifest.engine || old.groups.length!==replacement.groups.length
      || old.groups.some(g=>!replacement.groups.some(h=>h.key===g.key && normalizeEvidenceUrl(h.url)===normalizeEvidenceUrl(g.url)
        && h.records[0].report.lighthouseVersion===g.records[0].report.lighthouseVersion
        && validateLhrReport(h.records[0].report,{url:h.url,device:h.device}).profileSha256===validateLhrReport(g.records[0].report,{url:g.url,device:g.device}).profileSha256))
      || replacement.groups.some(g=>g.records.some(r=>r.report.runWarnings?.length))) throw new Error('Replacement baseline must be formal, same source/store/matrix/environment and warning-free.');
    await pinRun(run);
    state.baselineReplacements.push({before:state.baselineRun,after:run,manifestHash:replacement.manifestHash});
    state.baselineRun=run;
    if (state.baselineHash===state.originalBaselineHash) state.originalFormalRun=run;
  };
  const diagnose = async () => {
    await pinRun(state.baselineRun);
    const recovery = await (dependencies.diagnoseRecovery ?? diagnoseRecovery)({ project: state.project, run: state.baselineRun,
      ...state.inputs, sources:state.officialSources, goal: state.goal, history: state.history,preparationFailures:state.preparationFailures??[] });
    state.recovery = await save('recovery.json', recovery);
    state.recoveryHash = digest(recovery);
    state.baselineHash = recovery.sourceHash;
    state.originalBaselineHash ??= recovery.sourceHash;
    await snapshot(state.baselineHash);
    state.nextDomainStep=recovery.nextDomainStep??null;
    state.status = recovery.status==='investigation-required' ? 'investigation-required' : 'ready-for-plan';
    state.next = recovery.status!=='investigation-required' ? 'prepare a source-bound method; domain candidateId=next and method=next select an available hypothesis and implementation, then apply and experiment' : 'supported methods exhausted or evidence missing; refresh with new measurements or prepare a reviewed custom implementation';
  };
  const rollback = async () => {
    const plan = await activePlan();
    await save('rollback-intent.json',{planHash:plan.planHash,project:state.project});
    try {
      const receipt = await rollbackSitePlan(plan,state.project);
      state.operationReceipt = await save('rollback-receipt.json',receipt);
      await snapshot(state.baselineHash);
      state.active = null; state.previewSyncRequired = true;
      state.status = 'rolled-back'; state.next = 'sync the restored preview explicitly before another experiment';
    } catch (error) {
      if (error.receipt) state.operationReceipt = await save('rollback-failure.json',error.receipt);
      state.status = 'rollback-conflict'; throw error;
    }
  };
  try {
    if(config.sources!==undefined&&!config.official&&config.action!=='start')throw new Error('sources is only accepted at start or official preparation.');
    if(config.sources!==undefined) {
      const sources=await json(config.sources);officialMethodCatalog({sources});
      if(state.officialSources&&digest(state.officialSources)!==digest(sources))throw new Error('Official sources are fixed for this session; start a new session to review another version.');
      state.officialSources=sources;
    }
    if(!state.officialSources)state.officialSources=await readShopifySources();
    if (config.action !== 'rollback') {
      for (const run of Object.keys(state.evidenceRuns ?? {})) await pinRun(run);
      await pinRun(state.baselineRun);
    }
    if (!['rollback','verify'].includes(config.action)) await guard(config.action === 'prepare');
    if (config.action === 'start' || config.action === 'refresh') {
      if (state.active) throw new Error('Finish or roll back the active patch before refreshing.');
      if (config.action === 'refresh') await snapshot(state.baselineHash);
      if (config.action === 'refresh' && config.run) await replaceBaseline(config.run);
      state.acceptance = 'not-evaluated';
      await updateInputs(); await diagnose();
    } else if (config.action === 'prepare') {
      if (state.active || !['ready-for-plan','investigation-required','rolled-back'].includes(state.status)) throw new Error('A fresh diagnosis is required before prepare.');
      const current = await snapshot(state.baselineHash), recovery = await json(state.recovery);
      if (digest(recovery)!==state.recoveryHash) throw new Error('Saved recovery diagnosis changed.');
      if(config.domain&&config.candidateId==='next') {
        const selected=recovery.candidates.find(c=>remainingDomainMethods(c,current.hash,state.history,state.preparationFailures).length);
        if(!selected)throw Object.assign(new Error('All supported domain methods are exhausted; refresh with new measured evidence or supply a reviewed custom implementation.'),{code:'NO_UNTESTED_DOMAIN_METHOD'});
        config={...config,candidateId:selected.candidateId};
      }
      const hypothesis = requireHypothesis(recovery.diagnosis,config.candidateId,current);
      const assessed=recovery.candidates.find(c=>c.candidateId===config.candidateId)??hypothesis;
      if(config.domain) {
        const method=config.method==='next'?remainingDomainMethods(assessed,current.hash,state.history,state.preparationFailures)[0]:config.method;
        if(!method)throw new Error('No untested supported method remains for this hypothesis; select the next measured candidate.');
        config={...config,method,domain:{...config.domain,candidateId:config.candidateId,method}};
      }
      if (typeof config.method !== 'string' || !config.method.trim() || typeof config.rationale !== 'string' || !config.rationale.trim()) throw new Error('Specify method and rationale explaining the mechanism and changed assumption.');
      if (['recipe','demand','split','plan','domain','official'].filter(k => config[k] !== undefined).length !== 1) throw new Error('Supply exactly one recipe, demand, split, domain, official config or existing plan.');
      let official;
      if(config.official){
        official=await json(config.official);
        if(official.candidateId!==config.candidateId||config.method!==`${official.methodId}/${official.executor}`)throw new Error('Official preparation method must be methodId/executor and bind the selected candidate.');
        config={...config,method:official.executor==='reviewed-replacement'?`${official.methodId}/reviewed-replacement`:official.executor.split(':').at(-1)};
      }
      if((config.domain||config.official)&&hypothesis.methods?.includes(config.method)
        &&!remainingDomainMethods(assessed,current.hash,state.history,state.preparationFailures).includes(config.method))
        throw Object.assign(new Error('Measured mechanism exhausted or baseline below achievable gain floor; select a different measured bottleneck or refresh evidence.'),{code:'NO_UNTESTED_DOMAIN_METHOD'});
      const plan = config.official ? await createOfficialPlan({project:state.project,diagnosis:recovery.diagnosis,config:official,profiles:state.inputs.profiles,sources:state.officialSources}) : config.plan ? await json(config.plan) : config.recipe
        ? await createSitePlan({project:state.project,recipe:await json(config.recipe),recipeDir:config.recipeDir})
        : config.demand ? await createDemandPlan({project:state.project,config:await json(config.demand),diagnosis:recovery.diagnosis,profiles:state.inputs.profiles})
          : config.domain ? await createDomainPlan({project:state.project,config:config.domain,diagnosis:recovery.diagnosis,profiles:state.inputs.profiles})
          : await createSplitPlan({project:state.project,config:await json(config.split)});
      await validateSitePlan(plan);
      for(const method of new Set(plan.changes.map(c=>c.evidence?.domainMethod).filter(Boolean)))
        if(hypothesis.methods?.includes(method)&&!remainingDomainMethods(assessed,current.hash,state.history,state.preparationFailures).includes(method))
          throw Object.assign(new Error('Plan reuses an exhausted mechanism or an impossible gain target.'),{code:'NO_UNTESTED_DOMAIN_METHOD'});
      if (plan.changes.some(c => c.evidence?.candidateId !== config.candidateId || c.evidence?.diagnosisSourceHash !== current.hash
        || (current.files.find(f=>f.file===c.target)?.sourceHash ?? null) !== c.beforeHash)) throw new Error('Every patch file must bind this hypothesis and current baseline source.');
      const fingerprint = patchFingerprint(plan), key = hypothesisKey(hypothesis);
      if (state.history.some(h => h.fingerprint === fingerprint && h.outcome!=='invalid-evidence')) throw Object.assign(new Error('This exact patch was already tested; change the implementation, do not repeat scores.'),{code:'ALREADY_TESTED_PATCH'});
      if (state.history.some(h=>h.baselineHash===current.hash && h.hypothesisKey===key && h.method===config.method && h.outcome!=='invalid-evidence')) throw new Error('This hypothesis/method was already tested; select a different mechanism and explain why.');
      state.active = { plan: await save('plan.json',plan), planHash: plan.planHash, fingerprint, candidateId: config.candidateId,
        hypothesisKey: key, method: config.method, rationale: config.rationale, diagnosis: await save('diagnosis.json',recovery.diagnosis), diagnosisHash: digest(recovery.diagnosis) };
      state.acceptance = 'not-evaluated';
      state.status = 'review-required'; state.next = 'review the full plan, then apply with its exact reviewedPlanHash';
    } else if (config.action === 'apply') {
      if (state.status !== 'review-required' || config.reviewedPlanHash !== state.active?.planHash) throw new Error('apply requires the exact reviewed active plan.');
      await snapshot(state.baselineHash); await guard(true);
      const plan = await activePlan();
      await save('apply-intent.json',{planHash:plan.planHash,project:state.project});
      state.counts.rounds++; state.status = 'apply-recovery-required';
      state.previewSyncRequired = true;
      state.next = 'if application fails, inspect the receipt and rollback before preparing another patch';
      state.operationReceipt = await save('apply-receipt.json',await (dependencies.applySitePlan ?? applySitePlan)(plan,state.project));
      state.active.sourceHash = (await snapshot()).hash;
      state.status = 'awaiting-preview-sync'; state.previewSyncRequired = true;
      state.next = 'explicitly sync the candidate preview, then experiment with both prepared previews';
    } else if (config.action === 'experiment') {
      if (state.status !== 'awaiting-preview-sync') throw new Error('Experiment requires an applied candidate.');
      await snapshot(state.active.sourceHash);
      await activePlan();
      if (digest(await json(state.active.diagnosis))!==state.active.diagnosisHash) throw new Error('Active diagnosis changed since preparation.');
      const supplied = await json(config.experiment);
      if (!supplied || supplied.after?.deployment?.project !== state.project) throw new Error('Experiment candidate project differs from this session.');
      const baseline = await pinRun(state.baselineRun), identity = checkRunDeployment(baseline);
      const diagnosis = await json(state.active.diagnosis), hypothesis = diagnosis.candidates.find(c=>c.candidateId===state.active.candidateId);
      for (const side of ['before','after']) {
        const cfg = supplied[side];
        if (cfg?.deployment?.store !== identity.store || cfg.engine !== baseline.manifest.engine || cfg.pages?.length !== 1 || cfg.devices?.length !== 1) throw new Error('Experiment must use the session store, engine and one diagnosed page/device.');
        assertHypothesisScope(hypothesis,[{url:cfg.pages[0].url,device:cfg.devices[0]}]);
        if (!baseline.groups.some(g=>g.pageId===cfg.pages[0].id && g.device===cfg.devices[0] && normalizeEvidenceUrl(g.url)===normalizeEvidenceUrl(cfg.pages[0].url))) throw new Error('Experiment page is outside the session measurement matrix.');
      }
      if (![3,4].includes(supplied.runs ?? 3)) throw new Error('Exploration requires 3 or 4 samples per side.');
      const plannedAttempts = 2*(supplied.runs ?? 3);
      if (plannedAttempts > state.budget.maxAttempts-state.counts.attempted) throw Object.assign(new Error('attempt-budget'),{code:'SESSION_BUDGET'});
      const remainingAttempts = state.budget.maxAttempts-state.counts.attempted;
      state.counts.attempted += plannedAttempts;
      let result;
      try {
        result = await (dependencies.runPatchExperiment ?? runPatchExperiment)({ config: { ...supplied,
        plan: state.active.plan, diagnosis: state.active.diagnosis, candidateId: state.active.candidateId, goal: state.goal,
        // The session enforces its own persistent rounds, fingerprints and changed-method requirements.
        history: [], budget: { ...state.budget, maxCandidateRounds: 1,
          maxWallTimeMs: Math.max(1,Math.floor(budget.remainingMs())), maxAttempts: remainingAttempts,
          maxFailures: state.budget.maxFailures-state.counts.failed } }, output: path.join(out,'experiment') });
      } catch (error) {
        // Unknown runner progress consumes the reservation; never retry for free.
        result = {output:path.join(out,'experiment'),status:'invalid-evidence',error:error.message,counts:{attempted:plannedAttempts,failed:1}};
      }
      if (Number.isSafeInteger(result.counts?.attempted) && result.counts.attempted >= 0 && result.counts.attempted <= plannedAttempts) state.counts.attempted -= plannedAttempts-result.counts.attempted;
      state.counts.failed += result.counts?.failed ?? 0;
      let outcome = result.verification?.outcome ?? result.status;
      if (outcome === 'promising') {
        state.active.experiment=result.output;
        try {
          state.active.patchEvidence = path.join(result.output,'patch-evidence.json');
          const patch = await json(state.active.patchEvidence);
          await pinRun(patch.before); await pinRun(patch.after);
          for(const key of ['diagnosis','regressionBefore','regressionAfter','liquidEvidence'])if(patch[key])patch[key]=await json(patch[key]);
          state.active.patchEvidence=await save('patch-evidence.json',patch);
          state.active.patchEvidenceHash = digest(patch);
        } catch (error) { outcome = 'invalid-evidence'; result.error = error.message; }
      }
      state.history.push({ ...state.active, baselineHash: state.baselineHash, outcome, experiment: result.output,
        verification: result.verification ?? null, error:result.error ?? null });
      if (outcome === 'promising') {
        state.previewSyncRequired = false; state.status = 'formal-validation-required';
        state.next = 'collect the full formal matrix and regression/review evidence, then verify';
      } else {
        if (!result.counts?.failed) state.counts.failed++;
        await rollback(); await diagnose();
        state.next = outcome === 'invalid-evidence' ? 'repair the measurement/identity evidence before choosing another implementation; restored preview requires sync'
          : 'inspect recovery.json, change the failed assumption or select another hypothesis; restored preview requires sync';
      }
    } else if (config.action === 'verify') {
      if (state.status !== 'formal-validation-required') throw new Error('Formal verification requires a promising experiment.');
      await snapshot(state.active.sourceHash);
      const supplied = await json(config.verification);
      if (!supplied?.after) throw new Error('Supply formal after measurement and regression/review evidence.');
      const frozenPatch=await json(state.active.patchEvidence);
      if(digest(frozenPatch)!==state.active.patchEvidenceHash)throw new Error('Saved patch evidence changed.');
      supplied.liquidEvidence??=state.active.liquidEvidence??frozenPatch.liquidEvidence;
      let savedLiquid;
      if(supplied.liquidEvidence) {
        supplied.liquidEvidence=await json(supplied.liquidEvidence);
        if(state.active.liquidEvidenceHash&&digest(supplied.liquidEvidence)!==state.active.liquidEvidenceHash)throw new Error('Reuse the first valid formal Liquid samples; missing review does not authorize server resampling.');
        savedLiquid=await save('liquid-evidence.json',supplied.liquidEvidence);
      }
      const afterEvidence = await pinRun(supplied.after);
      if (state.active.formalAfter && state.active.formalAfter !== afterEvidence.root) throw new Error('Reuse the first valid formal candidate samples; missing review evidence does not authorize score resampling.');
      if (digest(await json(state.active.patchEvidence)) !== state.active.patchEvidenceHash) throw new Error('Saved patch evidence changed.');
      if (supplied.before && supplied.before!==state.baselineRun) await replaceBaseline(supplied.before);
      const input = { ...supplied, before: state.baselineRun, expectedSourceHash: state.active.sourceHash, goal: state.goal,
        plan: await activePlan(), patchEvidence: state.active.patchEvidence };
      const verification = await (dependencies.verifyOptimization ?? verifyOptimization)(input);
      if(supplied.liquidEvidence&&verification.patchExperiment?.liquid?.outcome&&verification.patchExperiment.liquid.outcome!=='invalid-evidence') {
        state.active.liquidEvidenceHash=digest(supplied.liquidEvidence);state.active.liquidEvidence=savedLiquid;
      }
      await snapshot(state.active.sourceHash);
      if (verification.outcome!=='invalid-evidence' && ['score-targets-met','targets-not-met'].includes(verification.scoreTargets?.outcome)
        && verification.gain?.outcome!=='invalid-evidence') state.active.formalAfter = afterEvidence.root;
      state.verification = await save('verification.json',verification);
      // Compare the final candidate to the original baseline as well as the last retained step.
      const cumulative = await (dependencies.evaluateGain ?? evaluateGain)({before:state.originalFormalRun??state.originalRun,after:supplied.after,
        goal:state.goal.kind==='interaction'?undefined:state.goal});
      state.cumulativeGain = await save('cumulative-gain.json',cumulative);
      const cumulativePass = state.goal.kind==='interaction'
        ? !['invalid-evidence','performance-regressed'].includes(cumulative.outcome) : cumulative.outcome === 'measurable-gain';
      const failures = verification.checks.filter(c=>!c.pass).map(c=>c.id);
      const intermediate = state.goal.kind!=='interaction' && verification.outcome==='not-accepted'
        && verification.scoreTargets?.outcome==='targets-not-met'
        && verification.scoreTargets.checks.every(c=>['pass','fail'].includes(c.status))
        && failures.length===1 && failures[0]==='original-score-targets';
      if (cumulativePass && (verification.outcome==='optimization-accepted' || intermediate)) {
        const evidence = await readRunEvidence(supplied.after), identity = checkRunDeployment(evidence);
        if (identity.status!=='verified' || identity.sourceHash!==state.active.sourceHash) throw new Error('Formal candidate identity differs from the session.');
        await pinRun(supplied.after);
        state.retained.push({...state.active,verification:state.verification,after:supplied.after});
        state.baselineRun = supplied.after; state.baselineHash = state.active.sourceHash; state.active = null;
        state.inputs.profiles = []; delete state.inputs.liquidProfile;
        state.status = intermediate ? 'improved-below-target' : 'optimization-accepted';
        state.acceptance = intermediate ? 'not-accepted' : 'optimization-accepted';
        state.next = intermediate ? 'refresh with current-source runtime profiles to target the remaining loss; budgets and history are retained' : 'report accepted scope and arrange separate field verification';
      } else {
        state.acceptance = 'not-accepted';
        const scenarios = supplied.regression?.scenarios;
        const observedFailure = scenarios?.sourceHash===state.active.sourceHash && scenarios.sourceStable===true
          && scenarios.runs?.some(r=>r.steps?.some(s=>s.outcome==='failed'));
        const rejectedReview = supplied.review?.sourceHash===state.active.sourceHash
          && (supplied.review.contentPreserved===false || supplied.review.visualsPreserved===false);
        const harmful = cumulative.outcome==='performance-regressed' || state.goal.kind!=='interaction'&&cumulative.outcome==='no-measurable-gain' || verification.gain?.outcome==='performance-regressed'
          || ['no-measurable-gain','performance-regressed'].includes(verification.patchExperiment?.liquid?.outcome)
          || state.goal.kind!=='interaction' && verification.gain?.outcome==='no-measurable-gain' || observedFailure || rejectedReview;
        if (harmful) {
          state.counts.failed++;
          state.history.push({...state.active,baselineHash:state.baselineHash,outcome:'formal-rejected',verification,
            verificationFile:state.verification,formalEvidence:{before:state.baselineRun,after:afterEvidence.root}});
          await rollback(); await diagnose();
          state.next='formal regression or no gain: patch rolled back; inspect recovery.json and change the mechanism';
        } else state.next = 'inspect failed formal gates; supply missing evidence and verify again, or rollback before changing the implementation';
      }
    } else {
      if (!state.active) throw new Error('No active patch to roll back. Retained patches have independent saved plans.');
      await rollback(); await diagnose();
    }
  } catch (error) {
    if(config.action==='prepare'&&(config.domain||config.official)&&config.method!=='next') {
      state.preparationFailures??=[];state.preparationFailures.push({baselineHash:state.baselineHash,candidateId:config.candidateId,method:config.method,code:error.code??null,error:error.message});
    }
    state.acceptance = 'not-accepted';
    state.error = {code:error.code??'IMPROVEMENT_FAILED',message:error.message};
    if(error.code==='NO_UNTESTED_DOMAIN_METHOD')await diagnose();
    if (error.receipt) state.operationReceipt = await save('failure-receipt.json',error.receipt);
    if (error.code==='SESSION_BUDGET') { state.status='stopped'; state.next=state.active?'budget exhausted; rollback remains available':'deliver measured gains and unresolved investigations'; }
  } finally {
    if (state.budget.maxModelTokens !== undefined) state.modelUsageTokens = budget.modelUsageTokens();
    state.elapsedMs += Math.ceil(performance.now()-started);
    state.updatedAt = new Date().toISOString(); state.sessionHash = hashSession(state);
    await save('session.json',state);
  }
  return state;
}
