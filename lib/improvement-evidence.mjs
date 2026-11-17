import {customPlanIdentity} from './custom-plan-contract.mjs';
import {hypothesisKey, remainingDomainMethods} from './recovery.mjs';
import {acceptanceContract} from './standards-policy.mjs';
import {zeroNavigationFailure} from './formal-collection-evidence.mjs';
import {validateMeasureConfig} from './measure.mjs';
import {validateResourceBudget} from './resource-budget.mjs';
import {officialMethodCatalog} from './official-methods.mjs';
import {readShopifySources} from './shopify-docs.mjs';
import {formalInteractionGate} from './formal-interaction.mjs';
import {pinAvailableFormalFiles} from './formal-sample-lock.mjs';
import path from 'node:path';
import {sourceSnapshot} from './runtime-profile.mjs';
import {digest, fields} from './evidence-contract.mjs';
import {validateSitePlan} from './site-changes.mjs';
import {patchFingerprint, assertHypothesisScope, patchGate} from './patch-verification.mjs';
import {readRunEvidence, normalizeEvidenceUrl} from './run-evidence.mjs';
import {validateLhrReport} from './lhr-contract.mjs';
import {checkRunDeployment} from './deployment.mjs';
import {readFile} from 'node:fs/promises';

export const json = async value => typeof value === 'string' ? JSON.parse(await readFile(value, 'utf8')) : value;

/** Session-bound evidence checks. Persist pins before execution can move to the next gate. */
export function createImprovementEvidence({state, save, checkpoint}) {
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
    await checkpoint();
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
    finally {
      if(state.active.formalCollection)state.active.formalObservedAttempts=Math.max(state.active.formalObservedAttempts??0,observation.attempted??0);
      await checkpoint();
    }
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
      await checkpoint();
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
      await checkpoint();
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
  const updateInputs = async config => {
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
  const prepareStep = async config => {
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
  };

  const pinAcceptancePolicy = async policy => {
    acceptanceContract(policy,state.goal);
    const formalPolicy=policy??'legacy-score';
    if(state.acceptancePolicy&&state.acceptancePolicy!==formalPolicy)throw new Error('Acceptance policy is fixed for this session.');
    state.acceptancePolicy=formalPolicy;
    await checkpoint();
  };

  const prepareFormalCollection = async value => {
    if(state.active.formalCollection&&!state.active.formalAfter) {
      const empty=await zeroNavigationFailure(state.active.formalCollection,{project:state.project,sourceHash:state.active.sourceHash});
      if(empty) {
        await save('zero-navigation-recovery.json',empty);
        (state.active.emptyFormalCollections??=[]).push(empty);delete state.active.formalCollection;
      }
    }
    if (state.active.formalCollection || state.active.formalAfter) throw new Error('Formal collection already attempted; reuse saved samples with verify, or rollback. No score resampling.');
    const formal = await json(value);
    fields(formal,['measurement','scenarios','review','interactionEvidence','liquidEvidence','resourceProfiles','integrityProfiles','policy','businessEvidence','acceptancePolicy','standardsEvidence'],'formal collection');
    await pinAcceptancePolicy(formal.acceptancePolicy);
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
    return {formal, measurement};
  };

  const prepareFormalVerification = async supplied => {
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
        await checkpoint();
      }
    } catch(error) {budgetError=error;}
    const fixedBudget=state.resourceBudget??state.verificationBudget;
    if(fixedBudget!==undefined)supplied.budget=fixedBudget;
    const savedLiquid=await pinSupplementalEvidence(supplied,afterEvidence?.manifest.config,evidenceErrors,'liquid-evidence.json');
    if(evidenceErrors.length)throw evidenceErrors[0];
    fields(supplied,['after','before','regression','review','interactionEvidence','liquidEvidence','budget','policy','acceptancePolicy','standardsEvidence'],'formal verification');
    await pinAcceptancePolicy(supplied.acceptancePolicy);
    if(budgetError)throw budgetError;
    for(const key of ['regression','review'])if(typeof supplied[key]==='string')supplied[key]=await json(supplied[key]);
    if (digest(await json(state.active.patchEvidence)) !== state.active.patchEvidenceHash) throw new Error('Saved patch evidence changed.');
    if (supplied.before && supplied.before!==state.baselineRun) await replaceBaseline(supplied.before);
    const input = { ...supplied, before: state.baselineRun, expectedSourceHash: state.active.sourceHash, goal: state.goal,
      plan: await activePlan(), patchEvidence: state.active.patchEvidence };
    return {input, afterEvidence, savedLiquid};
  };

  const prepareDiagnosis = async () => {
    const current = await snapshot(state.baselineHash), recovery = await json(state.recovery);
    if (digest(recovery)!==state.recoveryHash) throw new Error('Saved recovery diagnosis changed.');
    if(recovery.workflow?.resourceFailures?.length)throw Object.assign(new Error('Repair the source-bound failed images with plan-resource-repair and verify-resource-repair, then measure a corrected-content baseline before score optimization.'),{code:'CONTENT_REPAIR_REQUIRED'});
    return {current, recovery};
  };

  const validatePreparedPlan = async ({plan, config, current, hypothesis, assessed}) => {
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
    return {fingerprint, key};
  };

  const prepareExperiment = async value => {
    await snapshot(state.active.sourceHash);
    await activePlan();
    if (digest(await json(state.active.diagnosis))!==state.active.diagnosisHash) throw new Error('Active diagnosis changed since preparation.');
    const supplied = await json(value);
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
    return supplied;
  };

  return {snapshot, activePlan, pinRun, pinFormalRun, updateInputs, replaceBaseline,
    prepareStep, prepareDiagnosis, validatePreparedPlan, prepareExperiment, prepareFormalCollection, prepareFormalVerification};
}
