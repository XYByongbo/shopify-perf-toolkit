import {officialMethodIdentity} from './official-methods.mjs';
import path from 'node:path';
import {writeFile,rename} from 'node:fs/promises';
import {createRunDirectory} from './measure.mjs';
import {runImprovement,readImprovementSession} from './improvement-session.mjs';
import {validateSitePlan} from './site-changes.mjs';
import {fields,digest,readEvidenceJSON} from './evidence-contract.mjs';
import {readRunEvidence} from './run-evidence.mjs';
import {hypothesisKey,methodMechanism,remainingDomainMethods,recoverablePreparationCodes} from './recovery.mjs';

const read = value => typeof value === 'string' ? readEvidenceJSON(value) : structuredClone(value);
const preparationKeys=['candidateId','method','rationale','recipe','recipeDir','demand','split','plan','domain','official'];

// Re-generation creates new UUIDs/timestamps. Approval binds every semantic field,
// including full before/after text, evidence, dependencies and verification requirements.
export async function reviewedPlanContent(plan) {
  await validateSitePlan(plan);
  const {id,createdAt,updatedAt,planHash,...body}=structuredClone(plan);
  body.changes=body.changes.map(({id,...change})=>change);
  if(body.metadata)delete body.metadata.generatorPlanHash;
  const sorted=value=>Array.isArray(value)?value.map(sorted):value&&typeof value==='object'
    ?Object.fromEntries(Object.keys(value).sort().map(k=>[k,sorted(value[k])])):value;
  return digest(sorted(body));
}

export function selectRecoveryOption(state,recovery,options,skipped=new Set()) {
  for(const candidate of recovery.candidates??[]) {
    if(candidate.gainCeiling?.blocked)continue;
    const remaining=remainingDomainMethods(candidate,state.baselineHash,state.history,state.preparationFailures);
    const choices=options.filter(o=>!skipped.has(o.id)&&o.prepare.candidateId===candidate.candidateId);
    for(const option of choices) {
      const method=option.methodKey??option.prepare.method;
      if(state.preparationFailures?.some(f=>f.baselineHash===state.baselineHash&&f.candidateId===candidate.candidateId&&f.method===method
        &&f.evidenceHash===digest(state.inputs)&&recoverablePreparationCodes.has(f.code)))continue;
      if(candidate.methods?.includes(method)&&!remaining.includes(method))continue;
      if(state.history.some(h=>h.outcome!=='invalid-evidence'&&h.baselineHash===state.baselineHash
        &&h.hypothesisKey===hypothesisKey(candidate)&&methodMechanism(h.method)===methodMechanism(method)))continue;
      return option;
    }
  }
  return null;
}

// Reuse declared preview transport and capture scope, never stored profile results.
export async function recoveryEvidenceRequests(state,options) {
  const experiment=await read(options.find(o=>o.experiment)?.experiment);
  const deployment=experiment?.after?.deployment;
  if(!deployment)throw new Error('Fresh evidence needs a declared candidate preview deployment.');
  const baseline=await readRunEvidence(state.baselineRun,{allowExploration:true});
  const profiles=state.inputs.profiles.length?state.inputs.profiles.map(p=>({profile:p.config,bindings:p.domainBindings??[]}))
    :baseline.groups.map(g=>({profile:{url:g.url,device:g.device},bindings:[]}));
  const requests=profiles.map(({profile,bindings})=>({schemaVersion:1,mode:'runtime',deployment:{...deployment,project:state.project},
    url:profile.url,profile:{...profile},bindings}));
  if(state.inputs.liquidProfile) {
    const p=state.inputs.liquidProfile;
    requests.push({schemaVersion:1,mode:'liquid',deployment:{...deployment,project:state.project},
      url:p.domainProof?.url??new URL(p.evidence.urlPath,baseline.groups[0].url).href,bindings:p.domainBindings??[]});
  }
  // profileDomain sets the declared preview ID; sync must check that same URL.
  for(const r of requests){const u=new URL(r.url);u.searchParams.set('preview_theme_id',String(deployment.themeId));r.url=u.href;}
  return requests;
}

export async function validateRecoveryCycleConfig(config) {
  fields(config,['schemaVersion','previous','options','sync','evidence'],'recovery cycle');
  if(config.schemaVersion!==1||!Array.isArray(config.options)||!config.options.length||config.options.length>20)
    throw new Error('Cycle requires 1..20 source-bound options.');
  const options=structuredClone(config.options),ids=new Set();
  for(const o of options) {
    fields(o,['id','prepare','reviewedPlan','experiment','formal','verification'],'cycle option');
    fields(o.prepare,preparationKeys,'cycle preparation');
    if(typeof o.id!=='string'||!o.id.trim()||ids.has(o.id)||!o.prepare.candidateId||o.prepare.candidateId==='next'
      ||!o.prepare.method||o.prepare.method==='next'||!o.prepare.rationale?.trim())throw new Error('Options need unique ids and explicit measured candidate/method/rationale.');
    if(o.prepare.official) {
      const official=await read(o.prepare.official);
      if(o.prepare.method!==`${official.methodId}/${official.executor}`)throw new Error('Official option method must match methodId/executor.');
      o.methodKey=officialMethodIdentity(official);
    } else o.methodKey=o.prepare.method;
    if(options.some(other=>other!==o&&other.methodKey===o.methodKey&&other.prepare.candidateId===o.prepare.candidateId))throw new Error('Ambiguous candidate/method options.');
    ids.add(o.id);
  }
  if(config.sync!==undefined)fields(config.sync,['command','args','timeoutMs'],'cycle sync adapter');
  if(config.evidence!==undefined&&(!Array.isArray(config.evidence)||!config.evidence.length||config.evidence.length>10))throw new Error('evidence must contain 1..10 capture requests.');
  return options;
}

/** Execute distinct reviewed mechanisms through the existing persistent session gates. */
export async function runRecoveryCycle({config,output,dependencies={}}) {
  const options=await validateRecoveryCycleConfig(config);
  let state=await readImprovementSession(config.previous);
  const relative=path.relative(state.project,path.resolve(output));
  if(!relative||relative==='.'||(!relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative)))
    throw new Error('Cycle output must be outside the theme.');
  const out=await createRunDirectory(output),skipped=new Set();let stepIndex=0;
  const result={schemaVersion:1,kind:'recovery-cycle',output:out,status:'running',session:config.previous,events:[],
    limitations:['Only supplied, source-bound implementations are generated. No model or review evidence is invented.',
      'An explicit sync executable may update a preview; its exit code never substitutes for deployment proof.',
      'Exploration and local fixtures do not establish merchant performance or formal acceptance.']};
  const persist=async()=>{
    await writeFile(path.join(out,'cycle.pending.json'),JSON.stringify(result,null,2)+'\n',{mode:0o600});
    await rename(path.join(out,'cycle.pending.json'),path.join(out,'cycle.json'));
  };
  const step=async(action,input)=>{
    const destination=path.join(out,`step-${String(++stepIndex).padStart(3,'0')}-${action}`);
    result.pending={action,output:destination};await persist();
    state=await runImprovement({config:{schemaVersion:1,previous:result.session,action,...input},output:destination,dependencies});
    result.session=path.join(state.output,'session.json');delete result.pending;
    result.events.push({action,status:state.status,session:result.session,error:state.error??null,
      candidateId:state.active?.candidateId??null,method:state.active?.method??null,historyLength:state.history.length});
    await persist();return !state.error;
  };
  try {
    for(let round=0;round<=options.length;round++) {
      if(state.status==='optimization-accepted'){result.status=state.status;break;}
      if(['stopped','rollback-conflict','apply-recovery-required','improved-below-target'].includes(state.status)) {
        result.status=state.status;break;
      }
      let option;
      if(!state.active) {
        // Refresh recomputes raw-cost reassessment and ranking, retaining source-bound history.
        if(state.history.length && state.evidenceRefreshHistoryLength!==state.history.length) {
          const evidence=config.evidence??await recoveryEvidenceRequests(state,options);
          const first=evidence[0];
          if(!await step('sync',{preview:{...config.sync,deployment:first.deployment,pages:[{id:'profile',url:first.url}]}})){result.status=state.status==='stopped'?'stopped':'awaiting-baseline-sync';break;}
          if(!await step('reprofile',{evidence})){result.status=state.status==='stopped'?'stopped':'evidence-collection-failed';break;}
        } else if(!await step('refresh',{})){result.status='blocked';break;}
        const recovery=await read(state.recovery);
        option=selectRecoveryOption(state,recovery,options,skipped);
        if(!option){
          result.status='no-supported-alternative';result.recovery=state.recovery;
          const candidates=recovery.candidates.filter(c=>!c.gainCeiling?.blocked).map(c=>c.candidateId);
          result.nextAction={command:candidates.length?'request-implementation':'reprofile',previous:result.session,candidates,
            instruction:candidates.length?'Generate a custom candidate from current measured sources, then resume improve prepare with implementation.':'No eligible measured source remains; collect fresh evidence or stop within the existing budget.'};
          break;
        }
        result.events.push({action:'select',option:option.id,recovery:state.recovery,recoveryHash:state.recoveryHash,
          reason:option.prepare.rationale,priorFailures:state.history.filter(h=>h.outcome!=='invalid-evidence').map(h=>({method:h.method,outcome:h.outcome}))});
        if(!await step('prepare',option.prepare)) {
          if(recoverablePreparationCodes.has(state.error?.code)) {skipped.add(option.id);continue;}
          result.status='blocked';break;
        }
      } else option=options.find(o=>o.prepare.candidateId===state.active.candidateId&&o.methodKey===state.active.method);
      if(!option){result.status='missing-active-option';break;}
      if(state.status==='review-required') {
        const plan=await read(state.active.plan);
        result.plan=state.active.plan;result.reviewContentHash=await reviewedPlanContent(plan);
        if(!option.reviewedPlan){result.status='review-required';break;}
        if(await reviewedPlanContent(await read(option.reviewedPlan))!==result.reviewContentHash) {
          result.status='review-required';result.reviewReason='Generated plan differs from the explicitly reviewed plan; inspect the new diff.';break;
        }
        if(!await step('apply',{reviewedPlanHash:state.active.planHash})){result.status='blocked';break;}
      }
      if(state.status==='awaiting-preview-sync') {
        const experiment=await read(option.experiment);
        if(!experiment?.after?.deployment)throw new Error('Selected option needs prepared experiment previews.');
        if(!await step('sync',{preview:{...config.sync,deployment:experiment.after.deployment,pages:experiment.after.pages}})) {
          result.status='awaiting-preview-sync';break;
        }
        if(!await step('experiment',{experiment})){result.status='blocked';break;}
        if(state.history.at(-1)?.outcome==='invalid-evidence'){result.status='invalid-evidence';break;}
        if(!state.active){skipped.add(option.id);continue;}
      }
      if(state.status==='formal-validation-required') {
        // Repair evidence against the fixed batch; never call the collector again.
        // Keep an explicit after value so the session can reject sample replacement.
        if(option.verification) {
          const verification=await read(option.verification);
          verification.after??=state.active.formalAfter;
          if(!await step('verify',{verification})){result.status=state.status==='stopped'?'stopped':'formal-evidence-repair-required';break;}
        } else {
          if(state.active.formalAfter){result.status='formal-evidence-repair-required';break;}
          if(!option.formal){result.status='formal-validation-required';break;}
          if(!await step('collect',{formal:await read(option.formal)})) {
            result.status=state.status==='stopped'?'stopped':state.error?.code==='STALE_FORMAL_REVIEW'?'formal-review-required':'formal-evidence-repair-required';
            if(result.status==='formal-review-required')result.reviewSourceHash=state.active.sourceHash;
            break;
          }
        }
        if(!state.active&&state.status!=='optimization-accepted'&&state.status!=='improved-below-target') {skipped.add(option.id);continue;}
        result.status=state.active?'formal-evidence-repair-required':state.status;break;
      }
      result.status=state.status;break;
    }
    if(result.status==='running')result.status='no-supported-alternative';
  } catch(error) {result.status='blocked';result.error={code:error.code??'RECOVERY_CYCLE_FAILED',message:error.message};}
  result.acceptance=state.acceptance;result.counts=state.counts;result.recovery=state.recovery;
  await persist();return result;
}
