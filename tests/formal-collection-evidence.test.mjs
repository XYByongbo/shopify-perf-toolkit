import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {zeroNavigationFailure} from '../lib/formal-collection-evidence.mjs';

async function setup(t) {
  const dir=await mkdtemp('/private/tmp/perfkit-empty-formal-');t.after(()=>rm(dir,{recursive:true,force:true}));
  const config={project:'/fixture',sourceHash:'hash'};
  const run={kind:'site-measurement',status:'failed',counts:{attempted:0,succeeded:0,failed:0},
    groups:[{reportsDirectory:'groups/a/mobile/lhr',reports:[],validReports:[],attempts:[]}],errors:[{code:'DEPLOYMENT_UNVERIFIED'}],
    deployment:{before:{status:'unverified',...config}},config:{deployment:{project:config.project}}};
  const result={kind:'optimization-run',action:'verify',status:'failed',output:dir,budget:{counts:{attempted:0}}};
  await mkdir(path.join(dir,'acceptance/groups/a/mobile/lhr'),{recursive:true});
  const save=async()=>{await writeFile(path.join(dir,'acceptance/run.json'),JSON.stringify(run));await writeFile(path.join(dir,'optimization.json'),JSON.stringify(result));};
  return {dir,config,run,result,save};
}
test('deployment failure before navigation has a bounded auditable retry receipt',async t=>{
  const f=await setup(t);await f.save();const receipt=await zeroNavigationFailure(f.dir,f.config);
  assert.equal(receipt.kind,'zero-navigation-deployment-failure');assert.equal(receipt.runHash.length,64);
});
test('any sample, attempted navigation, different source, unknown failure or unlisted report forbids re-collection',async t=>{
  for(const mutate of [f=>f.run.counts.attempted=1,f=>f.result.budget.counts.attempted=5,
    f=>f.run.groups[0].reports.push('score.json'),f=>f.run.groups[0].attempts.push({}),
    f=>f.run.deployment.before.status='verified',f=>f.run.deployment.before.sourceHash='other',
    f=>f.run.errors[0].code='UNKNOWN',f=>f.run.groups[0].reportsDirectory='../../outside']){
    const f=await setup(t);mutate(f);await f.save();assert.equal(await zeroNavigationFailure(f.dir,f.config),null);
  }
  const f=await setup(t);await f.save();await writeFile(path.join(f.dir,'acceptance/groups/a/mobile/lhr/unlisted.json'),'{}');
  assert.equal(await zeroNavigationFailure(f.dir,f.config),null);
});
