import {readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {collectOptimizationEvidence} from './optimization-collection.mjs';
import {verifyOptimization} from './optimization-verification.mjs';
import {createSitePlan,applySitePlan,validateSitePlan,rollbackSitePlan} from './site-changes.mjs';
import {createRunDirectory} from './measure.mjs';
import {acceptanceContract} from './standards-policy.mjs';
import {validateResourceBudget} from './resource-budget.mjs';
import {sourceSnapshot} from './theme-source.mjs';
export {verifyOptimization,collectOptimizationEvidence};

/** Compatibility facade: collection produces evidence; one verifier decides acceptance. */
export async function runOptimization(args) {
  if(['prepare','apply'].includes(args.config?.action)) {
    const {config}=args;
    if(config.schemaVersion!==1||!path.isAbsolute(config.project??'')||Object.keys(config).some(k=>!['schemaVersion','action','project','recipe','recipeDir','plan','reviewedPlanHash','before','measurement','scenarios','review','exploreFirst','rollbackOnFailure','patchEvidence','goal','interactionEvidence','liquidEvidence','resourceProfiles','integrityProfiles','budget','policy','businessEvidence','adapterContext','acceptancePolicy','standardsEvidence'].includes(k)))throw new Error('Invalid optimization workflow config.');
    acceptanceContract(config.acceptancePolicy,config.goal);if(config.budget!==undefined)validateResourceBudget(config.budget);
    for(const key of ['exploreFirst','rollbackOnFailure'])if(config[key]!==undefined&&typeof config[key]!=='boolean')throw new Error(`${key} must be boolean.`);
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
  if(result.status==='evidence-collected') {
    const verification=await (args.dependencies?.verifyOptimization??verifyOptimization)(result.verificationInput);
    await writeFile(path.join(result.output,'verification.json'),JSON.stringify(verification,null,2)+'\n',{flag:'wx',mode:0o600});
    result.artifacts['verification.json']='verification.json';result.status=verification.outcome;
  }
  if(args.config.action==='verify'&&args.config.rollbackOnFailure&&result.candidateValidated&&result.status!=='optimization-accepted') {
    try {
      const receipt=await rollbackSitePlan(JSON.parse(await readFile(args.config.plan,'utf8')),args.config.project);
      await writeFile(path.join(result.output,'rollback-receipt.json'),JSON.stringify(receipt),{flag:'wx',mode:0o600});
      result.artifacts['rollback-receipt.json']='rollback-receipt.json';
      result.localRollback='complete-preview-still-requires-sync';
    } catch(error) {result.localRollback='failed';if(error.receipt){await writeFile(path.join(result.output,'rollback-failure.json'),JSON.stringify(error.receipt),{flag:'wx',mode:0o600});result.artifacts['rollback-failure.json']='rollback-failure.json';}}
  }
  await writeFile(path.join(result.output,'optimization.json'),JSON.stringify(result,null,2)+'\n',{mode:0o600});
  return result;
}
