import {acceptanceContract} from './standards-policy.mjs';
import {customPlanIdentity} from './custom-plan-contract.mjs';
import {createCustomPlan} from './custom-implementation.mjs';
import {formalInteractionGate} from './formal-interaction.mjs';
import {formalRecoveryDecision,formalLiquidRejected} from './formal-recovery.mjs';
import {assertRecoveryCaptureCoverage,matchesRecoveryCapture} from './recovery-evidence.mjs';
import {profileDomain,validDomainProfile} from './domain-profile.mjs';
import {zeroNavigationFailure} from './formal-collection-evidence.mjs';
import {pinAvailableFormalFiles} from './formal-sample-lock.mjs';
import { readFile, writeFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRunDirectory, validateMeasureConfig } from './measure.mjs';
import { sourceSnapshot } from './runtime-profile.mjs';
import { digest, fields, goalContract } from './evidence-contract.mjs';
import { validateBudget, createBudget } from './execution-policy.mjs';
import { diagnoseRecovery, hypothesisKey, remainingDomainMethods } from './recovery.mjs';
import { createSitePlan, validateSitePlan, applySitePlan, rollbackSitePlan } from './site-changes.mjs';
import { createDemandPlan } from './demand-plan.mjs';
import { createSplitPlan } from './split-plan.mjs';
import { createOfficialPlan } from './official-plan.mjs';
import { officialMethodCatalog,officialMethodIdentity } from './official-methods.mjs';
import { readShopifySources } from './shopify-docs.mjs';
import { createDomainPlan } from './domain-plan.mjs';
import { requireHypothesis } from './bottlenecks.mjs';
import { patchFingerprint, runPatchExperiment, assertHypothesisScope } from './patch-experiment.mjs';
import {verifyOptimization,patchGate} from './optimization-verification.mjs';
import {collectOptimizationEvidence} from './optimization-collection.mjs';
import { validateResourceBudget } from './resource-budget.mjs';
import { evaluateGain } from './performance-gain.mjs';
import { readRunEvidence, normalizeEvidenceUrl } from './run-evidence.mjs';
import { validateLhrReport } from './lhr-contract.mjs';
import { checkRunDeployment, verifyDeployment, validateDeployment } from './deployment.mjs';
import { runProcess } from './bounded-process.mjs';

const json = async value => typeof value === 'string' ? JSON.parse(await readFile(value, 'utf8')) : value;
const actions = {
  start: ['project','run','profiles','liquidProfile','field','owners','goal','budget','sources','resourceBudget'],
  refresh: ['run','profiles','liquidProfile','field','owners'],
  reprofile: ['evidence'],
  prepare: ['candidateId','method','rationale','recipe','recipeDir','demand','split','plan','domain','official','sources','implementation'],
  apply: ['adapterContext','reviewedPlanHash'], sync: ['preview'], experiment: ['experiment'], collect: ['formal'], verify: ['verification'], rollback: [],
};
import {hashSession,readImprovementSession} from './improvement-state.mjs';
export {readImprovementSession};

/** A resumable single-writer workflow. Remote synchronization remains explicit. */
export async function runImprovement({ config, output, dependencies = {} }) {
  if (!actions[config?.action]) throw new Error('Use start, refresh, reprofile, prepare, apply, sync, experiment, collect, verify or rollback.');
  fields(config, ['schemaVersion','action','previous',...actions[config.action]], 'improvement config');
  if (config.schemaVersion !== 1 || (config.action === 'start') === Boolean(config.previous)) throw new Error('Only start omits previous.');
  const previous = config.previous ? await readImprovementSession(config.previous) : null;
  if (config.resourceBudget !== undefined) validateResourceBudget(config.resourceBudget);
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
      ...(config.resourceBudget === undefined ? {} : {resourceBudget:config.resourceBudget}),
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
  const pinFormalRun = async run => {
    if(state.active.formalCollection) {
      const expected=path.join(state.active.formalCollection,'acceptance');
      if(path.resolve(run)!==expected)throw new Error('Reuse the first valid formal candidate samples from the original formal collection directory; failed reads do not authorize score resampling.');
    }
    state.formalEvidenceFiles??={};
    const observation={};
    try {await pinAvailableFormalFiles(run,state.formalEvidenceFiles,observation);}
    finally {if(state.active.formalCollection)state.active.formalObservedAttempts=Math.max(state.active.formalObservedAttempts??0,observation.attempted??0);}
    const evidence=await pinRun(run);
    if(state.active.formalAfter&&state.active.formalAfter!==evidence.root)throw new Error('Reuse the first valid formal candidate samples; missing review evidence does not authorize score resampling.');
    const candidate=checkRunDeployment(evidence),baseline=checkRunDeployment(await pinRun(state.baselineRun));
    if(candidate.status==='verified'&&candidate.sourceHash===state.active.sourceHash
      &&candidate.project===state.project&&candidate.store===baseline.store
      &&evidence.manifest.config.purpose!=='exploration'&&evidence.groups.every(g=>g.records.length>=5))state.active.formalAfter=evidence.root;
    return evidence;
  };
  const pinFormalInteraction = async (value,measurement) => {
    const evidence=await json(value??state.active.interactionEvidence);
    const gate=await formalInteractionGate({evidence,goal:state.goal,baseline:await pinRun(state.baselineRun),measurement,sourceHash:state.active.sourceHash});
    const hash=digest(gate.evidenceHashes);
    if(state.active.interactionEvidenceHash&&state.active.interactionEvidenceHash!==hash)throw new Error('Reuse the first valid formal interaction samples; missing evidence does not authorize resampling.');
    if(!state.active.interactionEvidenceHash) {
      state.active.interactionEvidence=await save('pinned-interaction-evidence.json',evidence);state.active.interactionEvidenceHash=hash;
    }
    return evidence;
  };
  const pinFormalLiquid = async (value,name) => {
    const evidence=await json(value);
    if(state.active.liquidEvidenceHash&&digest(evidence)!==state.active.liquidEvidenceHash)throw new Error('Reuse the first valid formal Liquid samples; missing review does not authorize server resampling.');
    const patch=await json(state.active.patchEvidence);
    if(digest(patch)!==state.active.patchEvidenceHash)throw new Error('Saved patch evidence changed.');
    const file=await save(name,evidence),gate=await patchGate(await activePlan(),patch,state.goal,evidence);
    if(gate.liquid?.outcome&&gate.liquid.outcome!=='invalid-evidence') {
      state.active.liquidEvidenceHash=digest(evidence);state.active.liquidEvidence=file;
    }
    return {evidence,file};
  };
  // Each independently valid evidence set survives failures in the other sets.
  // Fallback measurement is the saved candidate experiment contract, never a guessed preview.
  const pinSupplementalEvidence = async (input,measurement,errors,name) => {
    if(state.goal.kind==='interaction'&&(input.interactionEvidence||state.active.interactionEvidence)) {
      try {
        if(!measurement) {
          const patch=await json(state.active.patchEvidence);
          if(digest(patch)!==state.active.patchEvidenceHash)throw new Error('Saved patch evidence changed.');
          measurement=state.active.formalMeasurement??(await pinRun(patch.after)).manifest.config;
        }
        input.interactionEvidence=await pinFormalInteraction(input.interactionEvidence,measurement);
      } catch(error) {errors.push(error);}
    }
    let file;
    try {
      const patch=await json(state.active.patchEvidence);
      if(digest(patch)!==state.active.patchEvidenceHash)throw new Error('Saved patch evidence changed.');
      input.liquidEvidence??=state.active.liquidEvidence??patch.liquidEvidence;
      if(input.liquidEvidence) {
        const pinned=await pinFormalLiquid(input.liquidEvidence,name);input.liquidEvidence=pinned.evidence;file=pinned.file;
      }
    } catch(error) {errors.push(error);}
    return file;
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
    if (!['rollback','verify'].includes(config.action)) await guard(['prepare','reprofile'].includes(config.action)||config.action==='sync'&&!state.active);
    if (config.action === 'start' || config.action === 'refresh') {
      if (state.active) throw new Error('Finish or roll back the active patch before refreshing.');
      if (config.action === 'refresh') await snapshot(state.baselineHash);
      if (config.action === 'refresh' && config.run) await replaceBaseline(config.run);
      state.acceptance = 'not-evaluated';
      await updateInputs(); await diagnose();
    } else if (config.action === 'reprofile') {
      if(state.active)throw new Error('Fresh diagnosis evidence requires the restored baseline.');
      const current=await snapshot(state.baselineHash),baseline=await pinRun(state.baselineRun),identity=checkRunDeployment(baseline);
      const requests=config.evidence;
      if(!Array.isArray(requests)||!requests.length||requests.length>10||requests.filter(c=>c.mode==='liquid').length>1)throw new Error('Supply 1..10 runtime/Liquid evidence requests, at most one Liquid context.');
      assertRecoveryCaptureCoverage(state.inputs,requests);
      for(const c of requests) {
        if(c.deployment?.project!==state.project||c.deployment?.store!==identity.store||!['runtime','liquid'].includes(c.mode)
          ||!baseline.groups.some(g=>normalizeEvidenceUrl(g.url)===normalizeEvidenceUrl(c.url)&&(c.mode==='liquid'||g.device===(c.profile?.device??'mobile')||state.inputs.profiles.some(p=>p.config?.device===c.profile?.device&&normalizeEvidenceUrl(p.config.url)===normalizeEvidenceUrl(c.url)))))throw new Error('Evidence capture must match the session source/store/page/device matrix.');
      }
      if(requests.length>state.budget.maxAttempts-state.counts.attempted)throw Object.assign(new Error('attempt-budget'),{code:'SESSION_BUDGET'});
      const captured=[];
      for(const [i,c] of requests.entries()) {
        await guard();state.counts.attempted++;
        try {
          const timeout=Math.min(120000,Math.floor(budget.remainingMs()/3));
          if(timeout<1000)throw new Error('Insufficient evidence collection time.');
          const captureStart=Date.now();
          const p=await (dependencies.profileDomain??profileDomain)({config:{...c,deployment:{...c.deployment,timeoutMs:Math.min(c.deployment.timeoutMs??120000,timeout)},
            profile:{...c.profile,timeoutMs:Math.min(c.profile?.timeoutMs??120000,timeout)}},output:path.join(out,'profile-'+i)});
          await snapshot(state.baselineHash);
          if(!validDomainProfile(p,current)||!matchesRecoveryCapture(p,c)||p.project!==state.project||Date.parse(p.domainProof.before.startedAt)<captureStart||Date.parse(p.domainProof.after.finishedAt)>Date.now()
            ||p.domainProof.before.store!==c.deployment.store||p.domainProof.before.themeId!==String(c.deployment.themeId)
            ||normalizeEvidenceUrl(p.domainProof.url)!==normalizeEvidenceUrl(c.url)
            ||p.kind!==`${c.mode}-profile`||c.mode==='runtime'&&p.config.device!==(c.profile?.device??'mobile'))throw new Error('Fresh profile lacks valid source/deployment evidence.');
          captured.push(p);
        }catch(error){state.counts.failed++;throw error;}
      }
      state.inputs.profiles=captured.filter(p=>p.kind==='runtime-profile');
      delete state.inputs.liquidProfile;
      const liquid=captured.find(p=>p.kind==='liquid-profile');if(liquid)state.inputs.liquidProfile=liquid;
      await save('fresh-evidence.json',captured);state.evidenceRefreshHistoryLength=state.history.length;
      await diagnose();
    } else if (config.action === 'prepare') {
      if (state.active || !['ready-for-plan','investigation-required','rolled-back'].includes(state.status)) throw new Error('A fresh diagnosis is required before prepare.');
      const current = await snapshot(state.baselineHash), recovery = await json(state.recovery);
      if (digest(recovery)!==state.recoveryHash) throw new Error('Saved recovery diagnosis changed.');
      if(recovery.workflow?.resourceFailures?.length)throw Object.assign(new Error('Repair the source-bound failed images with plan-resource-repair and verify-resource-repair, then measure a corrected-content baseline before score optimization.'),{code:'CONTENT_REPAIR_REQUIRED'});
      if(config.domain&&config.candidateId==='next') {
        const selected=recovery.candidates.find(c=>remainingDomainMethods(c,current.hash,state.history,state.preparationFailures).length);
        if(!selected)throw Object.assign(new Error('All supported domain methods are exhausted; refresh with new measured evidence or supply a reviewed custom implementation.'),{code:'NO_UNTESTED_DOMAIN_METHOD'});
        config={...config,candidateId:selected.candidateId};
      }
      const hypothesis = requireHypothesis(recovery.diagnosis,config.candidateId,current);
      const assessed=recovery.candidates.find(c=>c.candidateId===config.candidateId)??hypothesis;
      if(assessed.gainCeiling?.blocked)throw Object.assign(new Error('The declared goal cannot reach the unchanged minimum gain from this baseline; choose another measured scope or stop.'),{code:'NO_GAIN_HEADROOM'});
      if(config.domain) {
        const method=config.method==='next'?remainingDomainMethods(assessed,current.hash,state.history,state.preparationFailures)[0]:config.method;
        if(!method)throw new Error('No untested supported method remains for this hypothesis; select the next measured candidate.');
        config={...config,method,domain:{...config.domain,candidateId:config.candidateId,method}};
      }
      if (typeof config.method !== 'string' || !config.method.trim() || typeof config.rationale !== 'string' || !config.rationale.trim()) throw new Error('Specify method and rationale explaining the mechanism and changed assumption.');
      if (['recipe','demand','split','plan','domain','official','implementation'].filter(k => config[k] !== undefined).length !== 1) throw new Error('Supply exactly one recipe, demand, split, domain, official, implementation or existing plan.');
      const requestedMethod=config.method;
      let official;
      if(config.official){
        official=await json(config.official);
        if(official.candidateId!==config.candidateId||config.method!==`${official.methodId}/${official.executor}`)throw new Error('Official preparation method must be methodId/executor and bind the selected candidate.');
        config={...config,method:officialMethodIdentity(official)};
      }
      if((config.domain||config.official)&&hypothesis.methods?.includes(config.method)
        &&!remainingDomainMethods(assessed,current.hash,state.history,state.preparationFailures).includes(config.method))
        throw Object.assign(new Error('Measured mechanism exhausted or baseline below achievable gain floor; select a different measured bottleneck or refresh evidence.'),{code:'NO_UNTESTED_DOMAIN_METHOD'});
      if(config.implementation){
        fields(config.implementation,['request','candidate'],'implementation');
        const request=await json(config.implementation.request),candidate=await json(config.implementation.candidate);
        if(request.previous!==config.previous||request.sessionHash!==state.parentHash||request.candidateId!==config.candidateId||candidate.method!==config.method||candidate.rationale!==config.rationale)throw new Error('Custom implementation must bind this session, candidate, method and rationale.');
      }
      const plan = config.implementation ? await createCustomPlan(config.implementation) : config.official ? await createOfficialPlan({project:state.project,diagnosis:recovery.diagnosis,config:official,profiles:state.inputs.profiles,sources:state.officialSources}) : config.plan ? await json(config.plan) : config.recipe
        ? await createSitePlan({project:state.project,recipe:await json(config.recipe),recipeDir:config.recipeDir})
        : config.demand ? await createDemandPlan({project:state.project,config:await json(config.demand),diagnosis:recovery.diagnosis,profiles:state.inputs.profiles})
          : config.domain ? await createDomainPlan({project:state.project,config:config.domain,diagnosis:recovery.diagnosis,profiles:state.inputs.profiles})
          : await createSplitPlan({project:state.project,config:await json(config.split)});
      await validateSitePlan(plan);
      const custom=customPlanIdentity(plan);
      if(custom&&(custom.method!==config.method||custom.candidateId!==config.candidateId||custom.sourceHash!==current.hash))throw new Error('Custom plan method and hypothesis must match preparation; renaming does not reset tested history.');
      for(const method of new Set(plan.changes.map(c=>c.evidence?.domainMethod).filter(Boolean)))
        if(hypothesis.methods?.includes(method)&&!remainingDomainMethods(assessed,current.hash,state.history,state.preparationFailures).includes(method))
          throw Object.assign(new Error('Plan reuses an exhausted mechanism or an impossible gain target.'),{code:'NO_UNTESTED_DOMAIN_METHOD'});
      if (plan.changes.some(c => c.evidence?.candidateId !== config.candidateId || c.evidence?.diagnosisSourceHash !== current.hash
        || (current.files.find(f=>f.file===c.target)?.sourceHash ?? null) !== c.beforeHash)) throw new Error('Every patch file must bind this hypothesis and current baseline source.');
      const fingerprint = patchFingerprint(plan), key = hypothesisKey(hypothesis);
      if (state.history.some(h => h.fingerprint === fingerprint && h.outcome!=='invalid-evidence')) throw Object.assign(new Error('This exact patch was already tested; change the implementation, do not repeat scores.'),{code:'ALREADY_TESTED_PATCH'});
      if (state.history.some(h=>h.baselineHash===current.hash && h.hypothesisKey===key && h.method===config.method && h.outcome!=='invalid-evidence')) throw new Error('This hypothesis/method was already tested; select a different mechanism and explain why.');
      state.active = { plan: await save('plan.json',plan), planHash: plan.planHash, fingerprint, candidateId: config.candidateId,
        hypothesisKey: key, domainMethods:[...new Set(plan.changes.map(c=>c.evidence?.domainMethod).filter(Boolean))], recoveryContext:hypothesis.recoveryContext??null, requestedMethod, method: config.method, rationale: config.rationale, diagnosis: await save('diagnosis.json',recovery.diagnosis), diagnosisHash: digest(recovery.diagnosis) };
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
      state.operationReceipt = await save('apply-receipt.json',await (dependencies.applySitePlan ?? applySitePlan)(plan,state.project,config.adapterContext));
      state.active.sourceHash = (await snapshot()).hash;
      state.status = 'awaiting-preview-sync'; state.previewSyncRequired = true;
      state.next = 'explicitly sync the candidate preview, then experiment with both prepared previews';
    } else if (config.action === 'sync') {
      if (state.active&&state.status !== 'awaiting-preview-sync') throw new Error('Preview sync requires an applied candidate or restored baseline.');
      const expected=state.active?.sourceHash??state.baselineHash;
      await snapshot(expected);if(state.active)await activePlan();
      const preview=await json(config.preview);
      fields(preview,['deployment','pages','command','args','timeoutMs'],'preview sync');
      const deployment=validateDeployment(preview.deployment);
      const identity=checkRunDeployment(await pinRun(state.baselineRun));
      if(deployment.project!==state.project||deployment.store!==identity.store)throw new Error('Sync destination differs from session project/store.');
      if(!Array.isArray(preview.pages)||!preview.pages.length||preview.pages.some(p=>!p.id||!/^https?:\/\//.test(p.url)))throw new Error('Sync needs an explicit preview page matrix.');
      if(preview.command!==undefined) {
        if(!path.isAbsolute(preview.command)||!Array.isArray(preview.args)||preview.args.some(a=>typeof a!=='string')
          ||!Number.isSafeInteger(preview.timeoutMs)||preview.timeoutMs<1000||preview.timeoutMs>120000)throw new Error('Sync adapter needs an absolute executable, argument array and timeoutMs (1000..120000).');
        const request=await save('sync-request.json',{kind:'theme-preview-sync',project:state.project,sourceHash:expected,
          deployment,pages:preview.pages,publish:false});
        const receipt=await (dependencies.runProcess??runProcess)(preview.command,[...preview.args,request],
          {timeoutMs:Math.max(1,Math.min(preview.timeoutMs,Math.floor(budget.remainingMs()))),maxBytes:65536});
        await save('sync-receipt.json',{code:receipt.code});
        if(receipt.code!==0)throw new Error('Explicit preview sync adapter failed.');
      } else if(preview.args!==undefined||preview.timeoutMs!==undefined)throw new Error('Sync args/timeout require a command.');
      const proof=await (dependencies.verifyDeployment??verifyDeployment)({config:{...deployment,
        timeoutMs:Math.max(1,Math.min(deployment.timeoutMs,Math.floor(budget.remainingMs())))},pages:preview.pages});
      await save('sync-deployment.json',proof);await snapshot(expected);
      if(proof.status!=='verified'||proof.sourceHash!==expected)throw new Error('Preview source identity is not verified; experiment was not started.');
      state.previewSyncRequired=false;state.next=state.active?'preview identity verified; run the independent patch experiment':'restored baseline identity verified; collect fresh diagnosis evidence';
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
    } else if (['verify','collect'].includes(config.action)) {
      if (state.status !== 'formal-validation-required') throw new Error('Formal verification requires a promising experiment.');
      await snapshot(state.active.sourceHash);
      let supplied;
      if (config.action === 'collect') {
        if(state.active.formalCollection&&!state.active.formalAfter) {
          const empty=await zeroNavigationFailure(state.active.formalCollection,{project:state.project,sourceHash:state.active.sourceHash});
          if(empty) {
            await save('zero-navigation-recovery.json',empty);
            (state.active.emptyFormalCollections??=[]).push(empty);delete state.active.formalCollection;
          }
        }
        if (state.active.formalCollection || state.active.formalAfter) throw new Error('Formal collection already attempted; reuse saved samples with verify, or rollback. No score resampling.');
        const formal = await json(config.formal);
        fields(formal,['measurement','scenarios','review','interactionEvidence','liquidEvidence','resourceProfiles','integrityProfiles','policy','businessEvidence','acceptancePolicy','standardsEvidence'],'formal collection');
        acceptanceContract(formal.acceptancePolicy,state.goal);
        const formalPolicy=formal.acceptancePolicy??'legacy-score';
        if(state.acceptancePolicy&&state.acceptancePolicy!==formalPolicy)throw new Error('Acceptance policy is fixed for this session.');
        state.acceptancePolicy=formalPolicy;
        const evidenceErrors=[];let measurement;
        try {measurement=validateMeasureConfig(formal.measurement);}catch(error){evidenceErrors.push(error);}
        await pinSupplementalEvidence(formal,measurement,evidenceErrors,'pinned-liquid-preflight.json');
        if(evidenceErrors.length)throw evidenceErrors[0];
        await readRunEvidence(state.baselineRun); // A formal baseline must exist before sampling.
        if(formal.review!==undefined) {
          formal.review=await json(formal.review);
          if(formal.review?.sourceHash!==state.active.sourceHash)throw Object.assign(
            new Error('Formal review belongs to another source; review the current patch before collection.'),{code:'STALE_FORMAL_REVIEW'});
        }
        const attempts = measurement.pages.length * measurement.devices.length * measurement.runs;
        if (attempts > state.budget.maxAttempts-state.counts.attempted) throw Object.assign(new Error('attempt-budget'),{code:'SESSION_BUDGET'});
        const destination = path.join(out,'formal');
        state.active.formalCollection = destination;
        state.active.formalMeasurement=measurement;
        await save('formal-collection-intent.json',{destination,attempts,sourceHash:state.active.sourceHash});
        state.counts.attempted += attempts; // Unknown progress remains charged on interruption.
        let collected;
        try {collected = await (dependencies.collectOptimizationEvidence ?? collectOptimizationEvidence)({config:{schemaVersion:1,action:'verify',
          project:state.project,plan:state.active.plan,reviewedPlanHash:state.active.planHash,before:state.baselineRun,
          ...formal,measurement:{...measurement,budget:{...measurement.budget,maxAttempts:attempts,
            maxFailures:Math.min(measurement.budget.maxFailures,state.budget.maxFailures-state.counts.failed),
            maxWallTimeMs:Math.max(1,Math.min(measurement.budget.maxWallTimeMs,Math.floor(budget.remainingMs()))) }},
          goal:state.goal,patchEvidence:state.active.patchEvidence,resourceProfiles:formal.resourceProfiles,integrityProfiles:formal.integrityProfiles,policy:formal.policy,businessEvidence:formal.businessEvidence,budget:state.resourceBudget??state.verificationBudget,exploreFirst:false,rollbackOnFailure:false},
          output:destination});
        } catch(error) {
          state.counts.failed++;throw error;
        } finally {
          // A collector may throw after writing the samples (including while saving
          // its final receipt). Bind those bytes even without a normal return value.
          try {await pinFormalRun(path.join(destination,'acceptance'));}catch {}
          state.counts.attempted+=Math.max(0,(state.active.formalObservedAttempts??0)-attempts);
        }
        const used=collected.budget?.counts?.attempted;
        if(Number.isSafeInteger(used)&&used>=0&&used<(state.active.formalObservedAttempts??0)) {
          state.counts.failed++;throw new Error('Formal collector attempt count contradicts saved samples; reservation and original collection are retained.');
        }
        if(Number.isSafeInteger(used)&&used>=0&&used<=attempts)state.counts.attempted-=attempts-used;
        if(['formal-interaction','formal-liquid'].includes(collected.preflightRejection?.kind)&&collected.measurementStarted===false&&used===0&&!state.active.formalAfter) {
          const baseline=await pinRun(state.baselineRun),isInteraction=collected.preflightRejection.kind==='formal-interaction';
          let gate,evidenceInput;
          if(isInteraction) {
            if(state.goal.kind!=='interaction')throw new Error('Unexpected formal interaction rejection.');
            gate=await formalInteractionGate({evidence:formal.interactionEvidence,goal:state.goal,baseline,measurement,sourceHash:state.active.sourceHash});
            if(!['no-measurable-gain','interaction-regressed'].includes(gate.outcome))throw new Error('Formal interaction rejection cannot be independently reproduced.');
            evidenceInput=formal.interactionEvidence;
          } else {
            gate=await patchGate(await activePlan(),state.active.patchEvidence,state.goal,formal.liquidEvidence);
            if(!formalLiquidRejected(gate,checkRunDeployment(baseline),state.active.sourceHash))throw new Error('Formal Liquid rejection cannot be independently reproduced.');
            evidenceInput=await json(formal.liquidEvidence);
          }
          const evidence=await save('formal-preflight-evidence.json',evidenceInput),verificationFile=await save('formal-preflight-rejection.json',gate);
          state.counts.failed++;state.acceptance='not-accepted';
          state.formalRecovery=await save('formal-recovery.json',{action:'reject-patch',stage:'before-navigation',reasons:[isInteraction?'interaction-no-gain-or-regression':'liquid-no-gain-or-regression']});
          state.history.push({...state.active,baselineHash:state.baselineHash,outcome:'formal-rejected',
            rejectionReasons:[isInteraction?'interaction-no-gain-or-regression':'liquid-no-gain-or-regression'],verification:isInteraction?{interactions:gate}:{patchExperiment:gate},verificationFile,
            formalEvidence:{before:state.baselineRun,...(isInteraction?{interactionEvidence:evidence}:{liquidEvidence:evidence}),stage:'before-navigation'}});
          await rollback();await diagnose();state.next='formal target failed; collect fresh evidence and change the mechanism';return state;
        }
        if(collected.error || !collected.artifacts?.['regression-evidence.json']) {
          const beforeNavigation=collected.measurementStarted===false&&used===0&&!state.active.formalAfter;
          if(beforeNavigation)delete state.active.formalCollection;
          state.counts.failed++;throw new Error(beforeNavigation?'Formal preflight failed before navigation; fix configuration and collect.':
            'Formal collection incomplete; inspect saved samples and repair evidence with verify.');
        }
        supplied={after:path.join(destination,'acceptance'),regression:path.join(destination,'regression-evidence.json'),
          review:formal.review,interactionEvidence:formal.interactionEvidence,liquidEvidence:formal.liquidEvidence,policy:formal.policy,acceptancePolicy:formal.acceptancePolicy,standardsEvidence:formal.standardsEvidence};
      } else supplied = await json(config.verification);
      if (!supplied?.after) throw new Error('Supply formal after measurement and regression/review evidence.');
      // Freeze usable navigation evidence before any ancillary file can fail to read.
      // A previous candidate's samples must never become this candidate's fixed batch.
      const evidenceErrors=[];let afterEvidence;
      try {afterEvidence=await pinFormalRun(supplied.after);}catch(error){evidenceErrors.push(error);}
      // Preserve independently valid constraints and samples even if another input
      // is broken. Invalid budget metadata must not leave valid samples replaceable.
      let budgetError;
      try {
        if(supplied.budget!==undefined) {
          validateResourceBudget(supplied.budget);
          const fixed=state.resourceBudget??state.verificationBudget;
          if(fixed!==undefined&&digest(supplied.budget)!==digest(fixed))throw new Error('Resource budget is fixed for this session.');
          if(fixed===undefined)state.verificationBudget=structuredClone(supplied.budget);
        }
      } catch(error) {budgetError=error;}
      const fixedBudget=state.resourceBudget??state.verificationBudget;
      if(fixedBudget!==undefined)supplied.budget=fixedBudget;
      const savedLiquid=await pinSupplementalEvidence(supplied,afterEvidence?.manifest.config,evidenceErrors,'liquid-evidence.json');
      if(evidenceErrors.length)throw evidenceErrors[0];
      fields(supplied,['after','before','regression','review','interactionEvidence','liquidEvidence','budget','policy','acceptancePolicy','standardsEvidence'],'formal verification');
      acceptanceContract(supplied.acceptancePolicy,state.goal);
      const formalPolicy=supplied.acceptancePolicy??'legacy-score';
      if(state.acceptancePolicy&&state.acceptancePolicy!==formalPolicy)throw new Error('Acceptance policy is fixed for this session.');
      state.acceptancePolicy=formalPolicy;
      if(budgetError)throw budgetError;
      for(const key of ['regression','review'])if(typeof supplied[key]==='string')supplied[key]=await json(supplied[key]);
      if (digest(await json(state.active.patchEvidence)) !== state.active.patchEvidenceHash) throw new Error('Saved patch evidence changed.');
      if (supplied.before && supplied.before!==state.baselineRun) await replaceBaseline(supplied.before);
      const input = { ...supplied, before: state.baselineRun, expectedSourceHash: state.active.sourceHash, goal: state.goal,
        plan: await activePlan(), patchEvidence: state.active.patchEvidence };
      const verification = await (dependencies.verifyOptimization ?? verifyOptimization)(input);
      if(supplied.liquidEvidence&&verification.patchExperiment?.liquid?.outcome&&verification.patchExperiment.liquid.outcome!=='invalid-evidence') {
        state.active.liquidEvidenceHash=digest(supplied.liquidEvidence);state.active.liquidEvidence=savedLiquid;
      }
      await snapshot(state.active.sourceHash);
      state.verification = await save('verification.json',verification);
      // Compare the final candidate to the original baseline as well as the last retained step.
      const cumulative = await (dependencies.evaluateGain ?? evaluateGain)({before:state.originalFormalRun??state.originalRun,after:supplied.after,
        goal:state.goal.kind==='interaction'?(supplied.acceptancePolicy?{kind:'loading',metric:'lcp'}:undefined):state.goal,scoreDiagnosticOnly:Boolean(supplied.acceptancePolicy)});
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
        const decision=formalRecoveryDecision({verification,cumulative,goal:state.goal,review:supplied.review,
          regression:supplied.regression,candidate:afterEvidence,sourceHash:state.active.sourceHash});
        state.formalRecovery=await save('formal-recovery.json',decision);
        if (decision.action==='reject-patch') {
          state.counts.failed++;
          state.history.push({...state.active,baselineHash:state.baselineHash,outcome:'formal-rejected',verification,rejectionReasons:decision.reasons,
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
    if(config.action==='prepare'&&config.method!=='next') {
      state.preparationFailures??=[];state.preparationFailures.push({evidenceHash:digest(state.inputs),baselineHash:state.baselineHash,candidateId:config.candidateId,method:config.method,code:error.code??null,error:error.message});
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
