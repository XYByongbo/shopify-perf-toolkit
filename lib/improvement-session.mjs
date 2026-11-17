import {realpath, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {createRunDirectory} from './measure.mjs';
import {digest} from './evidence-contract.mjs';
import {randomUUID} from 'node:crypto';
import {createImprovementJournal, publishSessionJSON, recoverImprovement, reserveImprovementContinuation} from './improvement-journal.mjs';
import {hashSession, readImprovementSession} from './improvement-state.mjs';
import {validateImprovementConfig} from './improvement-config.mjs';
import {createImprovementActions} from './improvement-actions.mjs';
import {createImprovementEvidence} from './improvement-evidence.mjs';
import {createImprovementBudget} from './improvement-budget.mjs';
import {runImprovementFormal} from './improvement-formal.mjs';
import {assertResumeAllowed, assertStepAllowed, initializeImprovementState, transition} from './improvement-transitions.mjs';

export {readImprovementSession};
export {validateImprovementConfig, validateImprovementInput} from './improvement-config.mjs';
/** A resumable single-writer workflow. Remote synchronization remains explicit. */
export async function runImprovement({ config, output, dependencies = {} }) {
  validateImprovementConfig(config);
  if (config.action === 'recover') return recoverImprovement({config, output});
  const previous = config.previous ? await readImprovementSession(config.previous) : null;
  assertResumeAllowed(previous, config.action);
  const initial = previous ? undefined : {id:randomUUID(), project:await realpath(config.project)};
  const state = initializeImprovementState(config, previous, initial);
  // Check before directory creation; createRunDirectory then refuses symlink ancestors.
  const relative = path.relative(state.project, path.resolve(output));
  if (!relative || (!relative.startsWith('..'+path.sep) && relative !== '..' && !path.isAbsolute(relative))) throw new Error('Session output must be outside the theme.');
  const out = await createRunDirectory(output);
  const save = async (name, value) => {
    const file = path.join(out,name); await writeFile(file,JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600}); return file;
  };
  state.output = out; state.action = config.action;
  const budget = createImprovementBudget(state);
  const checkpoint = createImprovementJournal(out, state, budget.usage);
  // Prepare a recoverable state before reserving the parent. Neither publication exposes partial JSON.
  await checkpoint();
  if (previous) await reserveImprovementContinuation(state.previous, config.previous, {output:out, action:config.action});
  const evidence = createImprovementEvidence({state, save, checkpoint});
  const step = {config, state, out, save, checkpoint, budget, evidence, dependencies};
  const actions = createImprovementActions(step);
  try {
    await evidence.prepareStep(config);
    if (!['rollback','verify'].includes(config.action)) await budget.guard(checkpoint, ['prepare','reprofile'].includes(config.action)||config.action==='sync'&&!state.active);
    assertStepAllowed(state, config);
    if (['verify','collect'].includes(config.action)) await runImprovementFormal(config, step, actions);
    else await actions[config.action](config);
  } catch (error) {
    config = step.config;
    if(config.action==='prepare'&&config.method!=='next') {
      state.preparationFailures??=[];state.preparationFailures.push({evidenceHash:digest(state.inputs),baselineHash:state.baselineHash,candidateId:config.candidateId,method:config.method,code:error.code??null,error:error.message});
    }
    transition(state, 'not-accepted');
    state.error = {code:error.code??'IMPROVEMENT_FAILED',message:error.message};
    if(error.code==='NO_UNTESTED_DOMAIN_METHOD')await actions.diagnose();
    if (error.receipt) state.operationReceipt = await save('failure-receipt.json',error.receipt);
    if (error.code==='SESSION_BUDGET') transition(state, 'budget-stopped');
  } finally {
    if (state.budget.maxModelTokens !== undefined) state.modelUsageTokens = budget.modelUsageTokens();
    state.elapsedMs = budget.elapsedMs();
    state.updatedAt = new Date().toISOString(); state.sessionHash = hashSession(state);
    await publishSessionJSON(path.join(out,'session.json'),state);
  }
  return state;
}
