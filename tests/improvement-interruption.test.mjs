import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn, execFile} from 'node:child_process';
import {once} from 'node:events';
import {readFile, writeFile, access, mkdir, rename, symlink, unlink} from 'node:fs/promises';
import {promisify} from 'node:util';
import path from 'node:path';
import {runImprovement, readImprovementSession} from '../lib/improvement-session.mjs';
import {hashSession} from '../lib/improvement-state.mjs';
import {digest} from '../lib/evidence-contract.mjs';
import {setup, experimentConfig, read} from './helpers/improvement-fixture.mjs';

const sessionURL = new URL('../lib/improvement-session.mjs', import.meta.url).href;
const changesURL = new URL('../lib/site-changes.mjs', import.meta.url).href;

async function interrupt(t, f, input, dependency, {wait = false, apply = false, rollback = false,
  previous = path.join(f.state.output, 'session.json')} = {}) {
  const output = path.join(f.root, 'interrupted');
  const config = {schemaVersion:1, previous, ...input};
  const code = `import {runImprovement} from ${JSON.stringify(sessionURL)};
    import {applySitePlan,rollbackSitePlan} from ${JSON.stringify(changesURL)};
    await runImprovement({config:${JSON.stringify(config)},output:${JSON.stringify(output)},dependencies:{
      ${dependency}:async (...args)=>{
        ${apply ? 'await applySitePlan(...args);' : ''}
        ${rollback ? 'await rollbackSitePlan(...args);' : ''}
        process.stdout.write('checkpoint-reached\\n');
        ${wait ? 'await new Promise(()=>setInterval(()=>{},1000));' : "process.kill(process.pid,'SIGKILL');"}
      }
    }});`;
  const child = spawn(process.execPath, ['--input-type=module','-e',code], {stdio:['ignore','pipe','pipe']});
  const exited = once(child, 'exit');
  let stderr = ''; child.stderr.on('data', data => { stderr += data; });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  if (wait) {
    await Promise.race([once(child.stdout, 'data'), exited.then(() => { throw new Error('Child exited before checkpoint: '+stderr); })]);
  } else {
    const [code, signal] = await exited;
    assert.equal(signal, 'SIGKILL', `${code}: ${stderr}`);
  }
  return {previous, output, child, exited,
    recover: () => runImprovement({config:{schemaVersion:1, action:'recover', previous}, output})};
}

test('a killed read-only refresh is recovered once and its chain can continue without deleting the lock', {timeout:30000}, async t => {
  const f = await setup(t); const parent = await f.step({action:'start'});
  const crashed = await interrupt(t, f, {action:'refresh'}, 'diagnoseRecovery');
  await assert.rejects(access(path.join(crashed.output,'session.json')), {code:'ENOENT'});
  await assert.rejects(runImprovement({config:{schemaVersion:1,action:'refresh',previous:crashed.previous},output:path.join(f.root,'retry')}), {code:'EEXIST'});
  const [recovered, concurrent] = await Promise.all([crashed.recover(), crashed.recover()]);
  assert.equal(recovered.sessionHash, concurrent.sessionHash);
  assert.equal(recovered.interruption.requiresRollback, false);
  assert.ok(recovered.elapsedMs >= parent.elapsedMs);
  assert.deepEqual(recovered.evidenceRuns, parent.evidenceRuns);
  assert.equal((await crashed.recover()).sessionHash, recovered.sessionHash);
  const recoveryConfig = path.join(f.root,'recover.json');
  await writeFile(recoveryConfig,JSON.stringify({schemaVersion:1,action:'recover',previous:crashed.previous}));
  await assert.rejects(promisify(execFile)(process.execPath,[new URL('../scripts/perfkit.mjs',import.meta.url).pathname,
    'improve','--config',recoveryConfig,'--out',crashed.output]), error => {
    assert.equal(error.code,3,error.stderr); // Recovered, still awaiting the explicit next action.
    return true;
  });
  const next = await runImprovement({config:{schemaVersion:1,action:'refresh',previous:path.join(crashed.output,'session.json')},output:path.join(f.root,'continued')});
  assert.equal(next.status,'ready-for-plan');
  assert.equal(next.error,undefined);
  assert.equal((await readImprovementSession(path.join(next.output,'session.json'))).step, parent.step+2);
});

test('recovery refuses a live owner and a different output directory', {timeout:30000}, async t => {
  const f = await setup(t); await f.step({action:'start'});
  const crashed = await interrupt(t, f, {action:'refresh'}, 'diagnoseRecovery', {wait:true});
  await assert.rejects(crashed.recover(), {code:'SESSION_STILL_RUNNING'});
  await assert.rejects(runImprovement({config:{schemaVersion:1,action:'recover',previous:crashed.previous},output:path.join(f.root,'other')}), {code:'RECOVERY_OUTPUT_MISMATCH'});
  crashed.child.kill('SIGKILL'); await crashed.exited;
  assert.equal((await crashed.recover()).interruption.requiresRollback,false);
});

test('aliased and canonical session paths contend for the same continuation and recover the same child', {timeout:30000}, async t => {
  const f = await setup(t); const parent = await f.step({action:'start'});
  const previous = path.join(parent.output,'session.json');
  const aliasDir = path.join(f.root,'aliases'); await mkdir(aliasDir);
  const alias = path.join(aliasDir,'previous.json'); await symlink(previous,alias);
  const crashed = await interrupt(t,f,{action:'refresh'},'diagnoseRecovery',{wait:true,previous:alias});
  await assert.rejects(runImprovement({config:{schemaVersion:1,action:'refresh',previous},output:path.join(f.root,'fork')}), {code:'EEXIST'});
  await assert.rejects(access(path.join(aliasDir,'next-step.json')), {code:'ENOENT'});
  await assert.rejects(crashed.recover(), {code:'SESSION_STILL_RUNNING'});
  crashed.child.kill('SIGKILL'); await crashed.exited;
  const recovered = await runImprovement({config:{schemaVersion:1,action:'recover',previous:alias},
    output:path.relative(process.cwd(),crashed.output)});
  assert.equal(recovered.previous,previous);
  assert.equal((await crashed.recover()).sessionHash,recovered.sessionHash);
  assert.equal((await readImprovementSession(path.join(crashed.output,'session.json'))).parentHash,parent.sessionHash);
});

test('a legacy continuation stored beside a parent alias still recovers through that alias', {timeout:30000}, async t => {
  const f = await setup(t); const parent = await f.step({action:'start'});
  const crashed = await interrupt(t,f,{action:'refresh'},'diagnoseRecovery');
  const aliasDir = path.join(f.root,'legacy-alias'); await mkdir(aliasDir);
  const alias = path.join(aliasDir,'previous.json'); await symlink(crashed.previous,alias);
  await rename(path.join(parent.output,'next-step.json'),path.join(aliasDir,'next-step.json'));
  const file = path.join(crashed.output,'checkpoint.json');
  const {hash: _, ...body} = await read(file);
  body.state.previous = alias;
  body.state.sessionHash = hashSession(body.state);
  await writeFile(file,JSON.stringify({...body,hash:digest(body)}));
  await assert.rejects(runImprovement({config:{schemaVersion:1,action:'refresh',previous:alias},output:path.join(f.root,'fork')}), {code:'EEXIST'});
  const recovered = await runImprovement({config:{schemaVersion:1,action:'recover',previous:alias},output:crashed.output});
  assert.equal(recovered.previous,alias);
  assert.equal((await readImprovementSession(path.join(crashed.output,'session.json'))).parentHash,parent.sessionHash);
});

test('recovery after committed apply preserves the round and requires explicit rollback, without replaying writes', {timeout:30000}, async t => {
  const f = await setup(t); await f.step({action:'start'});
  await f.prepare('function heavy(){ return 2; }');
  const crashed = await interrupt(t, f, {action:'apply',reviewedPlanHash:f.state.active.planHash}, 'applySitePlan', {apply:true});
  const recovered = await crashed.recover();
  assert.equal(recovered.status,'interrupted-recovery-required');
  assert.equal(recovered.counts.rounds,1);
  assert.equal(await readFile(path.join(f.project,'assets/main.js'),'utf8'),'function heavy(){ return 2; }');
  const previous = path.join(crashed.output,'session.json');
  await assert.rejects(runImprovement({config:{schemaVersion:1,action:'apply',previous,reviewedPlanHash:f.state.active.planHash},output:path.join(f.root,'repeat')}), {code:'INTERRUPTED_ROLLBACK_REQUIRED'});
  await assert.rejects(access(path.join(crashed.output,'next-step.json')), {code:'ENOENT'});
  const restored = await runImprovement({config:{schemaVersion:1,action:'rollback',previous},output:path.join(f.root,'rollback')});
  assert.equal(restored.error,undefined);
  assert.equal(restored.interruption.requiresRollback,false);
  assert.equal(restored.counts.rounds,1);
  assert.equal(await readFile(path.join(f.project,'assets/main.js'),'utf8'),'function heavy(){ return 1; }');
});

test('recovering a rollback interrupted after restoring source can finish the same rollback idempotently', {timeout:30000}, async t => {
  const f = await setup(t); await f.step({action:'start'});
  await f.prepare('function heavy(){ return 2; }');
  await f.step({action:'apply',reviewedPlanHash:f.state.active.planHash});
  const file = path.join(f.project,'assets/main.js');
  const crashed = await interrupt(t,f,{action:'rollback'},'rollbackSitePlan',{rollback:true});
  assert.equal(await readFile(file,'utf8'),'function heavy(){ return 1; }');
  const recovered = await crashed.recover();
  assert.equal(recovered.interruption.phase,'rollback');
  assert.equal(recovered.interruption.requiresRollback,true);
  const resumed = await runImprovement({config:{schemaVersion:1,action:'rollback',previous:path.join(crashed.output,'session.json')},
    output:path.join(f.root,'resumed-rollback')});
  assert.equal(resumed.error,undefined);
  assert.equal(resumed.interruption.requiresRollback,false);
  assert.equal((await read(resumed.operationReceipt)).status,'already-rolled-back');
  assert.equal(resumed.counts.rounds,1);
  assert.equal(await readFile(file,'utf8'),'function heavy(){ return 1; }');
});

test('interrupted experiments retain reserved attempts and cannot retry the same patch after rollback', {timeout:30000}, async t => {
  const f = await setup(t); await f.step({action:'start'});
  await f.prepare('function heavy(){ return 2; }');
  await f.step({action:'apply',reviewedPlanHash:f.state.active.planHash});
  const crashed = await interrupt(t, f, {action:'experiment',experiment:experimentConfig(f.project)}, 'runPatchExperiment');
  const recovered = await crashed.recover();
  assert.equal(recovered.counts.attempted,6);
  assert.equal(recovered.counts.failed,1);
  assert.equal(recovered.history.at(-1).outcome,'interrupted');
  const restored = await runImprovement({config:{schemaVersion:1,action:'rollback',previous:path.join(crashed.output,'session.json')},output:path.join(f.root,'rollback')});
  const oldPlan = await read(f.state.active.plan);
  const retry = await runImprovement({config:{schemaVersion:1,action:'prepare',previous:path.join(restored.output,'session.json'),
    candidateId:oldPlan.changes[0].evidence.candidateId,method:'renamed-method',rationale:'Retry must still fail',plan:oldPlan},output:path.join(f.root,'retry-plan')});
  assert.equal(retry.error.code,'ALREADY_TESTED_PATCH');
  assert.equal(retry.counts.attempted,6);
});

test('interrupted formal collection retains its sample destination, reservation and previous evidence locks', {timeout:30000}, async t => {
  const f = await setup(t); await f.step({action:'start'});
  await f.prepare('function heavy(){ return 2; }');
  await f.step({action:'apply',reviewedPlanHash:f.state.active.planHash});
  await f.experiment({score:80,tbt:200});
  assert.equal(f.state.status,'formal-validation-required');
  const before = f.state;
  const measurement = {...experimentConfig(f.project).after,runs:5};
  const crashed = await interrupt(t, f, {action:'collect',formal:{measurement}}, 'collectOptimizationEvidence');
  const recovered = await crashed.recover();
  assert.equal(recovered.counts.attempted,before.counts.attempted+5);
  assert.equal(recovered.active.formalCollection,path.join(crashed.output,'formal'));
  assert.equal(recovered.active.formalMeasurement.runs,5);
  assert.deepEqual(recovered.evidenceRuns,before.evidenceRuns);
  await assert.rejects(runImprovement({config:{schemaVersion:1,action:'collect',previous:path.join(crashed.output,'session.json'),formal:{measurement}},output:path.join(f.root,'resample')}), {code:'INTERRUPTED_ROLLBACK_REQUIRED'});
});

test('damaged or redirected checkpoints never publish a recovered session', {timeout:30000}, async t => {
  const f = await setup(t); await f.step({action:'start'});
  const crashed = await interrupt(t, f, {action:'refresh'}, 'diagnoseRecovery');
  const file = path.join(crashed.output,'checkpoint.json'), original = await readFile(file,'utf8');
  const changed = JSON.parse(original); changed.state.counts.rounds = 99;
  await writeFile(file,JSON.stringify(changed));
  await assert.rejects(crashed.recover(), {code:'INVALID_RECOVERY_CHECKPOINT'});
  await writeFile(file,original);
  const alias = path.join(f.root,'alias'); await symlink(crashed.output,alias);
  await assert.rejects(runImprovement({config:{schemaVersion:1,action:'recover',previous:crashed.previous},output:alias}), {code:'RECOVERY_OUTPUT_MISMATCH'});
  await assert.rejects(access(path.join(crashed.output,'session.json')), {code:'ENOENT'});
  await crashed.recover();
});

test('recovery and subsequent rollback never overwrite source edited after an interrupted application', {timeout:30000}, async t => {
  const f = await setup(t); await f.step({action:'start'});
  await f.prepare('function heavy(){ return 2; }');
  const crashed = await interrupt(t, f, {action:'apply',reviewedPlanHash:f.state.active.planHash}, 'applySitePlan', {apply:true});
  const file = path.join(f.project,'assets/main.js');
  await writeFile(file,'external source edit');
  const recovered = await crashed.recover();
  assert.equal(recovered.interruption.source.matchesExpected,false);
  const result = await runImprovement({config:{schemaVersion:1,action:'rollback',previous:path.join(crashed.output,'session.json')},output:path.join(f.root,'conflict')});
  assert.equal(result.status,'rollback-conflict');
  assert.equal(result.interruption.requiresRollback,true);
  assert.equal(await readFile(file,'utf8'),'external source edit');
});

test('legacy interrupted directories without checkpoints keep their reservation and fail with recovery guidance', {timeout:30000}, async t => {
  const f = await setup(t); await f.step({action:'start'});
  const crashed = await interrupt(t, f, {action:'refresh'}, 'diagnoseRecovery');
  await unlink(path.join(crashed.output,'checkpoint.json'));
  await assert.rejects(crashed.recover(), {code:'RECOVERY_CHECKPOINT_MISSING'});
  await access(path.join(f.state.output,'next-step.json'));
  await assert.rejects(access(path.join(crashed.output,'session.json')), {code:'ENOENT'});
});
