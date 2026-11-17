import {transition} from './improvement-transitions.mjs';
import {createCustomPlan} from './custom-implementation.mjs';
import {assertRecoveryCaptureCoverage, matchesRecoveryCapture} from './recovery-evidence.mjs';
import {profileDomain, validDomainProfile} from './domain-profile.mjs';
import path from 'node:path';
import {digest, fields} from './evidence-contract.mjs';
import {diagnoseRecovery, remainingDomainMethods} from './recovery.mjs';
import {createSitePlan, applySitePlan, rollbackSitePlan} from './site-changes.mjs';
import {createDemandPlan} from './demand-plan.mjs';
import {createSplitPlan} from './split-plan.mjs';
import {createOfficialPlan} from './official-plan.mjs';
import {officialMethodIdentity} from './official-methods.mjs';
import {createDomainPlan} from './domain-plan.mjs';
import {requireHypothesis} from './bottlenecks.mjs';
import {runPatchExperiment} from './patch-experiment.mjs';
import {normalizeEvidenceUrl} from './run-evidence.mjs';
import {checkRunDeployment, verifyDeployment, validateDeployment} from './deployment.mjs';
import {runProcess} from './bounded-process.mjs';
import {json} from './improvement-evidence.mjs';

/** Executes local plan, capture and preview steps after the session has reserved its continuation. */
export function createImprovementActions(step) {
  const {state, out, save, checkpoint, budget, evidence, dependencies} = step;
  const {snapshot, activePlan, pinRun, updateInputs, replaceBaseline} = evidence;
  const diagnose = async () => {
    await pinRun(state.baselineRun);
    const recovery = await (dependencies.diagnoseRecovery ?? diagnoseRecovery)({ project: state.project, run: state.baselineRun,
      ...state.inputs, sources:state.officialSources, goal: state.goal, history: state.history,preparationFailures:state.preparationFailures??[] });
    state.recovery = await save('recovery.json', recovery);
    state.recoveryHash = digest(recovery);
    state.baselineHash = recovery.sourceHash;
    state.originalBaselineHash ??= recovery.sourceHash;
    await snapshot(state.baselineHash);
    transition(state, 'diagnosed', recovery);
  };
  const rollback = async () => {
    const plan = await activePlan();
    await save('rollback-intent.json',{planHash:plan.planHash,project:state.project});
    await checkpoint('rollback');
    try {
      const receipt = await (dependencies.rollbackSitePlan ?? rollbackSitePlan)(plan,state.project);
      state.operationReceipt = await save('rollback-receipt.json',receipt);
      await snapshot(state.baselineHash);
      transition(state, 'rolled-back');
      await checkpoint('read-only');
    } catch (error) {
      if (error.receipt) state.operationReceipt = await save('rollback-failure.json',error.receipt);
      transition(state, 'rollback-conflict');
      throw error;
    }
  };

  async function refresh(config) {
    if (config.action === 'refresh') await snapshot(state.baselineHash);
    if (config.action === 'refresh' && config.run) await replaceBaseline(config.run);
    transition(state, 'refreshing');
    await updateInputs(config); await diagnose();
  }

  async function reprofile(config) {
    const current=await snapshot(state.baselineHash),baseline=await pinRun(state.baselineRun),identity=checkRunDeployment(baseline);
    const requests=config.evidence;
    if(!Array.isArray(requests)||!requests.length||requests.length>10||requests.filter(c=>c.mode==='liquid').length>1)throw new Error('Supply 1..10 runtime/Liquid evidence requests, at most one Liquid context.');
    assertRecoveryCaptureCoverage(state.inputs,requests);
    for(const c of requests) {
      if(c.deployment?.project!==state.project||c.deployment?.store!==identity.store||!['runtime','liquid'].includes(c.mode)
        ||!baseline.groups.some(g=>normalizeEvidenceUrl(g.url)===normalizeEvidenceUrl(c.url)&&(c.mode==='liquid'||g.device===(c.profile?.device??'mobile')||state.inputs.profiles.some(p=>p.config?.device===c.profile?.device&&normalizeEvidenceUrl(p.config.url)===normalizeEvidenceUrl(c.url)))))throw new Error('Evidence capture must match the session source/store/page/device matrix.');
    }
    budget.requireAttempts(requests.length);
    const captured=[];
    for(const [i,c] of requests.entries()) {
      await budget.guard(checkpoint);
      budget.reserveAttempts(1);
      await checkpoint('reprofile');
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
  }

  async function prepare() {
    let config = step.config;
    const {current, recovery} = await evidence.prepareDiagnosis();
    if(config.domain&&config.candidateId==='next') {
      const selected=recovery.candidates.find(c=>remainingDomainMethods(c,current.hash,state.history,state.preparationFailures).length);
      if(!selected)throw Object.assign(new Error('All supported domain methods are exhausted; refresh with new measured evidence or supply a reviewed custom implementation.'),{code:'NO_UNTESTED_DOMAIN_METHOD'});
      step.config = config = {...config,candidateId:selected.candidateId};
    }
    const hypothesis = requireHypothesis(recovery.diagnosis,config.candidateId,current);
    const assessed=recovery.candidates.find(c=>c.candidateId===config.candidateId)??hypothesis;
    if(assessed.gainCeiling?.blocked)throw Object.assign(new Error('The declared goal cannot reach the unchanged minimum gain from this baseline; choose another measured scope or stop.'),{code:'NO_GAIN_HEADROOM'});
    if(config.domain) {
      const method=config.method==='next'?remainingDomainMethods(assessed,current.hash,state.history,state.preparationFailures)[0]:config.method;
      if(!method)throw new Error('No untested supported method remains for this hypothesis; select the next measured candidate.');
      step.config = config = {...config,method,domain:{...config.domain,candidateId:config.candidateId,method}};
    }
    if (typeof config.method !== 'string' || !config.method.trim() || typeof config.rationale !== 'string' || !config.rationale.trim()) throw new Error('Specify method and rationale explaining the mechanism and changed assumption.');
    if (['recipe','demand','split','plan','domain','official','implementation'].filter(k => config[k] !== undefined).length !== 1) throw new Error('Supply exactly one recipe, demand, split, domain, official, implementation or existing plan.');
    const requestedMethod=config.method;
    let official;
    if(config.official){
      official=await json(config.official);
      if(official.candidateId!==config.candidateId||config.method!==`${official.methodId}/${official.executor}`)throw new Error('Official preparation method must be methodId/executor and bind the selected candidate.');
      step.config = config = {...config,method:officialMethodIdentity(official)};
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
    const {fingerprint, key} = await evidence.validatePreparedPlan({plan, config, current, hypothesis, assessed});
    state.active = { plan: await save('plan.json',plan), planHash: plan.planHash, fingerprint, candidateId: config.candidateId,
      hypothesisKey: key, domainMethods:[...new Set(plan.changes.map(c=>c.evidence?.domainMethod).filter(Boolean))], recoveryContext:hypothesis.recoveryContext??null, requestedMethod, method: config.method, rationale: config.rationale, diagnosis: await save('diagnosis.json',recovery.diagnosis), diagnosisHash: digest(recovery.diagnosis) };
    transition(state, 'prepared');
  }

  async function apply(config) {
    await snapshot(state.baselineHash); await budget.guard(checkpoint, true);
    const plan = await activePlan();
    await save('apply-intent.json',{planHash:plan.planHash,project:state.project});
    state.counts.rounds++;
    transition(state, 'applying');
    await checkpoint('apply');
    state.operationReceipt = await save('apply-receipt.json',await (dependencies.applySitePlan ?? applySitePlan)(plan,state.project,config.adapterContext));
    state.active.sourceHash = (await snapshot()).hash;
    transition(state, 'applied');
  }

  async function sync(config) {
    const expected=state.active?.sourceHash??state.baselineHash;
    await snapshot(expected);if(state.active)await activePlan();
    const preview=await json(config.preview);
    fields(preview,['deployment','pages','command','args','timeoutMs'],'preview sync');
    const deployment=validateDeployment(preview.deployment);
    const identity=checkRunDeployment(await pinRun(state.baselineRun));
    if(deployment.project!==state.project||deployment.store!==identity.store)throw new Error('Sync destination differs from session project/store.');
    if(!Array.isArray(preview.pages)||!preview.pages.length||preview.pages.some(p=>!p.id||!/^https?:\/\//.test(p.url)))throw new Error('Sync needs an explicit preview page matrix.');
    await checkpoint('sync');
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
    transition(state, 'preview-verified');
  }

  async function experiment(config) {
    const supplied = await evidence.prepareExperiment(config.experiment);
    const plannedAttempts = 2*(supplied.runs ?? 3);
    const remainingAttempts = budget.requireAttempts(plannedAttempts);
    budget.reserveAttempts(plannedAttempts);
    await checkpoint('experiment');
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
    budget.settleAttempts(plannedAttempts, result.counts?.attempted);
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
      transition(state, 'promising');
    } else {
      if (!result.counts?.failed) state.counts.failed++;
      await rollback(); await diagnose();
      transition(state, 'experiment-rejected', outcome);
    }
  }

  async function rollbackStep() {
    await rollback(); await diagnose();
  }

  return {start:refresh, refresh, reprofile, prepare, apply, sync, experiment, rollback:rollbackStep, diagnose, restoreSource:rollback};
}
