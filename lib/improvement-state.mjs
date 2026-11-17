import {readFile,realpath} from 'node:fs/promises';
import path from 'node:path';
import {digest} from './evidence-contract.mjs';
import {zeroNavigationFailure} from './formal-collection-evidence.mjs';
const json=async file=>JSON.parse(await readFile(file,'utf8'));

export const hashSession = state => { const { sessionHash, ...body } = state; return digest(body); };

export async function readImprovementSession(file) {
  if (!path.isAbsolute(file ?? '')) throw new Error('previous must be an absolute session.json path.');
  const state = await json(file);
  if (state.kind !== 'improvement-session' || state.schemaVersion !== 1 || state.sessionHash !== hashSession(state)) throw new Error('Invalid or changed session evidence.');
  if (await realpath(file) !== path.join(state.output,'session.json')) throw new Error('Session must be resumed from its original output directory, not a copied session file.');
  return validateImprovementHistory(state);
}

export async function validateImprovementHistory(state) {
  // A chain is an integrity trail, not a signature. Check every parent, not only the latest object.
  let child = state, depth = 0;
  while (child.previous) {
    if (++depth > 200) throw new Error('Session history exceeds 200 steps.');
    const parent = await json(child.previous);
    const link = await json(path.join(path.dirname(child.previous),'next-step.json'));
    if (await realpath(child.previous) !== path.join(parent.output,'session.json') || link.output !== child.output || link.action !== child.action) throw new Error('Broken session directory/continuation link.');
    if(parent.active&&child.active&&parent.active.planHash===child.active.planHash&&parent.active.formalCollection) {
      if(child.active.formalCollection!==parent.active.formalCollection) {
        const empty=await zeroNavigationFailure(parent.active.formalCollection,{project:parent.project,sourceHash:parent.active.sourceHash});
        if(child.action!=='collect'||!empty||!child.active.emptyFormalCollections?.some(e=>digest(e)===digest(empty)))throw new Error('Broken formal collection lock; a failed read does not authorize replacement samples.');
      } else if(JSON.stringify(child.active.formalMeasurement)!==JSON.stringify(parent.active.formalMeasurement)
        ||(child.active.formalObservedAttempts??0)<(parent.active.formalObservedAttempts??0))throw new Error('Broken formal measurement contract.');
    }
    if (parent.sessionHash !== hashSession(parent) || child.parentHash !== parent.sessionHash || child.id !== parent.id
      || child.step !== parent.step+1 || child.project !== parent.project || child.originalRun !== parent.originalRun
      || digest(child.goal) !== digest(parent.goal) || digest(child.budget) !== digest(parent.budget)
      || JSON.stringify(child.resourceBudget) !== JSON.stringify(parent.resourceBudget)
      || parent.verificationBudget!==undefined && (child.verificationBudget===undefined||digest(child.verificationBudget)!==digest(parent.verificationBudget))
      || Object.entries(parent.evidenceRuns??{}).some(([root,hash])=>child.evidenceRuns?.[root]!==hash)
      || Object.entries(parent.formalEvidenceFiles??{}).some(([file,hash])=>child.formalEvidenceFiles?.[file]!==hash)
      || parent.active&&child.active&&parent.active.planHash===child.active.planHash
        && ['sourceHash','fingerprint','diagnosisHash','patchEvidenceHash','formalAfter','interactionEvidenceHash','liquidEvidenceHash']
          .some(key=>parent.active[key]!==undefined&&child.active[key]!==parent.active[key])
      || parent.officialSources && digest(child.officialSources)!==digest(parent.officialSources)
      || child.counts.attempted < parent.counts.attempted || child.counts.rounds < parent.counts.rounds
      || child.counts.failed < parent.counts.failed || child.elapsedMs < parent.elapsedMs
      || (child.modelUsageTokens ?? 0) < (parent.modelUsageTokens ?? 0)
      || digest(child.history.slice(0,parent.history.length)) !== digest(parent.history)) throw new Error('Broken session history or reset budget.');
    child = parent;
  }
  return state;
}
