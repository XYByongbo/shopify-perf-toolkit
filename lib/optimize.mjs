import {readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {collectOptimizationEvidence} from './optimization-collection.mjs';
import {verifyOptimization} from './optimization-verification.mjs';
import {createSitePlan,applySitePlan,validateSitePlan,rollbackSitePlan} from './site-changes.mjs';
import {createRunDirectory} from './measure.mjs';
import {validateOptimizationEnvelope} from './optimization-config.mjs';
import {formalRecoveryDecision} from './formal-recovery.mjs';
import {readRunEvidence} from './run-evidence.mjs';
import {sourceSnapshot} from './theme-source.mjs';
export {verifyOptimization,collectOptimizationEvidence};

/** Compatibility facade: collection produces evidence; one verifier decides acceptance. */
export async function runOptimization(args) {
  if(['prepare','apply'].includes(args.config?.action)) {
    const {config}=args;
    validateOptimizationEnvelope(config, ['prepare','apply']);
    const output=await createRunDirectory(args.output),result={schemaVersion:1,kind:'optimization-run',action:config.action,output,steps:[],artifacts:{},measurementStarted:false};
    const save=async(name,data)=>{await writeFile(path.join(output,name),JSON.stringify(data,null,2)+'\n',{flag:'wx',mode:0o600});result.artifacts[name]=name;};
    try {
      if(config.action==='prepare') {
        const plan=await createSitePlan({project:config.project,recipe:config.recipe,recipeDir:config.recipeDir});
        await save('plan.json',plan);result.planHash=plan.planHash;result.status='review-required';
      } else {
        const plan=JSON.parse(await readFile(config.plan,'utf8'));await validateSitePlan(plan);
        if(config.reviewedPlanHash!==plan.planHash)throw new Error('Supply the exact reviewedPlanHash of the saved site plan.');
        await save('apply-receipt.json',await applySitePlan(plan,config.project,config.adapterContext));
        result.sourceHash=(await sourceSnapshot(config.project)).hash;result.status='awaiting-preview-sync';
      }
    }catch(error){result.status='failed';result.error={code:error.code??'OPTIMIZATION_FAILED',message:error.message};if(error.receipt)await save('failure-receipt.json',error.receipt);}
    await save('optimization.json',result);return result;
  }
  const result=await collectOptimizationEvidence(args);
  let verification;
  if(result.status==='evidence-collected') {
    verification=await (args.dependencies?.verifyOptimization??verifyOptimization)(result.verificationInput);
    await writeFile(path.join(result.output,'verification.json'),JSON.stringify(verification,null,2)+'\n',{flag:'wx',mode:0o600});
    result.artifacts['verification.json']='verification.json';result.status=verification.outcome;
  }
  if(args.config.action==='verify'&&args.config.rollbackOnFailure&&result.candidateValidated&&result.status!=='optimization-accepted') {
    result.localRollback = 'retained-pending-evidence';
    try {
      const input = result.verificationInput;
      if (verification) {
        result.rollbackDecision = formalRecoveryDecision({
          verification, cumulative:verification.gain, goal:input.goal, review:input.review,
          regression:input.regression, candidate:await readRunEvidence(input.after), sourceHash:input.expectedSourceHash,
        });
      }
      if (result.rollbackDecision?.action === 'reject-patch' || result.explorationRejection || result.preflightRejection) {
        result.localRollback = 'failed';
        const plan = JSON.parse(await readFile(args.config.plan,'utf8'));
        if (plan.planHash !== args.config.reviewedPlanHash) throw new Error('Reviewed plan changed before rollback.');
        const receipt = await rollbackSitePlan(plan,args.config.project);
        result.localRollback='complete-preview-still-requires-sync';
        await writeFile(path.join(result.output,'rollback-receipt.json'),JSON.stringify(receipt),{flag:'wx',mode:0o600});
        result.artifacts['rollback-receipt.json']='rollback-receipt.json';
      }
    } catch(error) {
      result.rollbackError = error.message;
      if (error.receipt) {
        result.localRollback='failed';
        await writeFile(path.join(result.output,'rollback-failure.json'),JSON.stringify(error.receipt),{flag:'wx',mode:0o600});
        result.artifacts['rollback-failure.json']='rollback-failure.json';
      }
    }
  }
  await writeFile(path.join(result.output,'optimization.json'),JSON.stringify(result,null,2)+'\n',{mode:0o600});
  return result;
}
