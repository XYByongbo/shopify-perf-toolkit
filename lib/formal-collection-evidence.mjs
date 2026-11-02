import path from 'node:path';
import {readdir,realpath} from 'node:fs/promises';
import {readEvidenceJSON,digest} from './evidence-contract.mjs';

/** Only a recorded deployment rejection before any navigation can be collected again. */
export async function zeroNavigationFailure(directory,{project,sourceHash}) {
  try {
    const run=await readEvidenceJSON(path.join(directory,'acceptance/run.json'));
    const result=await readEvidenceJSON(path.join(directory,'optimization.json'));
    const before=run.deployment?.before;
    if(result.kind!=='optimization-run'||result.action!=='verify'||result.status!=='failed'||result.output!==directory
      ||result.budget?.counts?.attempted!==0||run.kind!=='site-measurement'||run.status!=='failed'
      ||run.counts?.attempted!==0||run.counts?.succeeded!==0||run.counts?.failed!==0
      ||!Array.isArray(run.groups)||!run.groups.length||run.groups.some(g=>
        !['reports','validReports','attempts'].every(k=>Array.isArray(g[k])&&g[k].length===0))
      ||!Array.isArray(run.errors)||run.errors.length!==1||run.errors[0].code!=='DEPLOYMENT_UNVERIFIED'
      ||!before||before.status==='verified'||run.deployment.after||before.project!==project
      ||before.sourceHash!==sourceHash||run.config?.deployment?.project!==project)return null;
    const root=path.join(directory,'acceptance');
    for(const group of run.groups) {
      if(typeof group.reportsDirectory!=='string'||!group.reportsDirectory) return null;
      const folder=path.resolve(root,group.reportsDirectory);
      if(!folder.startsWith(root+path.sep))return null;
      try {
        if(await realpath(folder)!==folder||(await readdir(folder)).length)return null;
      } catch(error) {if(error.code!=='ENOENT')return null;}
    }
    return {kind:'zero-navigation-deployment-failure',directory,sourceHash,runHash:digest(run),resultHash:digest(result),
      reason:'Deployment was rejected before navigation; no scores exist to replace.'};
  } catch {return null;}
}
