import {acceptanceContract} from './standards-policy.mjs';
import {validateDeliveryPolicy} from './delivery-policy.mjs';
import {validateResourceBudget} from './resource-budget.mjs';
import {configValue, fields, goalContract, isObject} from './evidence-contract.mjs';

// These commands consume independent evidence. Validate the request before attempting to open it.
function reference(config, field, allowObject = false) {
  const value = config[field];
  if (!(typeof value === 'string' && value.trim()) && !(allowObject && isObject(value))) {
    throw configValue(field, allowObject ? 'an evidence object or a saved evidence path' : 'a saved run path');
  }
}

function fingerprint(config, field) {
  if (typeof config[field] !== 'string' || !/^[a-f0-9]{64}$/.test(config[field])) {
    throw configValue(field, 'a 64-character lowercase SHA-256 fingerprint');
  }
}

export function validateInteractionComparison(config) {
  fields(config, ['before','after','goal','allowExploration'], 'interaction comparison');
  for (const side of ['before','after']) reference(config, side);
  if (goalContract(config.goal).kind !== 'interaction') throw configValue('goal.kind', 'interaction with a target and event');
  if (config.allowExploration !== undefined && typeof config.allowExploration !== 'boolean') throw configValue('allowExploration','true or false');
}

export function validatePatchVerification(config) {
  fields(config, ['plan','diagnosis','candidateId','before','after','regressionBefore','regressionAfter','goal','interactionEvidence','liquidEvidence','minLiquidSamples'], 'patch verification');
  for (const side of ['before','after']) reference(config, side);
  for (const input of ['plan','diagnosis','regressionBefore','regressionAfter']) reference(config, input, true);
  if (typeof config.candidateId !== 'string' || !config.candidateId.trim()) throw configValue('candidateId','a nonempty candidate ID');
  goalContract(config.goal);
}

export function validatePreservationConfig(config) {
  fields(config, ['before','after','beforeSourceHash','afterSourceHash','plan'], 'preservation verification');
  for (const side of ['before','after']) {
    reference(config, side, true);
    fingerprint(config, side+'SourceHash');
  }
  if (config.plan !== undefined) reference(config, 'plan', true);
}

export function validateFormalVerification(config) {
  fields(config, ['before','after','regression','expectedSourceHash','review','plan','patchEvidence','goal','interactionEvidence','liquidEvidence','budget','policy','acceptancePolicy','standardsEvidence'], 'optimization verification');
  for (const side of ['before','after']) reference(config, side);
  fingerprint(config,'expectedSourceHash');
  validateDeliveryPolicy(config.policy);
  acceptanceContract(config.acceptancePolicy, config.goal);
  if (config.budget !== undefined) validateResourceBudget(config.budget);
}

export function validateResourceVerification(config) {
  fields(config, ['plan','before','after'], 'resource repair verification');
  for (const input of ['plan','before','after']) reference(config, input, true);
}
