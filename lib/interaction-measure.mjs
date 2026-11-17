import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { profileRuntime } from './runtime-profile.mjs';
import { createRunDirectory } from './run-directory.mjs';
import { verifyDeployment } from './deployment.mjs';
import { createBudget } from './execution-policy.mjs';
import { digest } from './evidence-contract.mjs';
import { validateInteractionConfig } from './interaction-evidence.mjs';

export { validateInteractionConfig, readInteractionRun, verifyInteractions, interactionMatchesNavigation, interactionBehaviorCovered } from './interaction-evidence.mjs';

export async function measureInteractions({config,output,dependencies={}}={}) {
  config=validateInteractionConfig(config);const out=await createRunDirectory(output),budget=createBudget(config.budget);
  const result={schemaVersion:1,kind:'interaction-measurement',status:'running',startedAt:new Date().toISOString(),config,profiles:[],deployment:{},counts:{attempted:0,failed:0}};
  const proof=()=> (dependencies.verifyDeployment??verifyDeployment)({config:config.deployment,pages:config.pages});
  try {
    if(budget.remainingMs()<config.deployment.timeoutMs)throw new Error('Insufficient budget for deployment proof.');
    result.deployment.before=await proof();
    if(result.deployment.before.status!=='verified')throw new Error('Initial interaction source identity is unverified.');
    for(let i=0;i<config.runs;i++){
      const stop=await budget.check({attempts:result.counts.attempted,failures:result.counts.failed,reserveMs:config.profile.timeoutMs+config.deployment.timeoutMs});
      if(stop)throw new Error(`Interaction budget stopped: ${stop}`);
      result.counts.attempted++;
      try {
        const dir=`sample-${i+1}`,p=await (dependencies.profileRuntime??profileRuntime)({config:{...config.profile,expectedThemeId:config.deployment.themeId},output:path.join(out,dir)});
        const file=`${dir}/profile.json`,hash=digest(await readFile(path.join(out,file)));
        result.profiles.push({file,hash});
        if(p.status!=='complete'||!p.sourceStable||p.snapshot?.hash!==result.deployment.before.sourceHash||p.blockedRequests?.length)throw new Error('Incomplete, constrained or drifted interaction sample.');
      }catch(error){result.counts.failed++;(result.failures??=[]).push({attempt:i+1,error:error.message});throw error;}
    }
    if(budget.remainingMs()<config.deployment.timeoutMs)throw new Error('Insufficient budget for final deployment proof.');
    result.deployment.after=await proof();
    if(result.deployment.after.status!=='verified'||result.deployment.after.sourceHash!==result.deployment.before.sourceHash)throw new Error('Interaction source changed.');
    if(budget.remainingMs()<=0)throw new Error('Interaction wall-time budget expired.');
    result.status='complete';
  }catch(error){result.status='stopped';result.error=error.message;}
  result.finishedAt=new Date().toISOString();result.budget={elapsedMs:budget.elapsedMs(),limits:budget.limits};
  await writeFile(path.join(out,'interactions.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx'});return result;
}
