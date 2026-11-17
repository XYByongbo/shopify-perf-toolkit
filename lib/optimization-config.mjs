import path from 'node:path';
import {acceptanceContract} from './standards-policy.mjs';
import {validateDeliveryPolicy} from './delivery-policy.mjs';
import {validateResourceBudget} from './resource-budget.mjs';
import {validateMeasureConfig} from './measure.mjs';
import {validateScenarioConfig} from './scenarios.mjs';
import {configValue, fields, isObject, validateAt} from './evidence-contract.mjs';

const allowed = ['schemaVersion','action','project','recipe','recipeDir','plan','reviewedPlanHash','before',
  'measurement','scenarios','review','exploreFirst','rollbackOnFailure','patchEvidence','goal','interactionEvidence',
  'liquidEvidence','resourceProfiles','integrityProfiles','budget','policy','businessEvidence','adapterContext',
  'acceptancePolicy','standardsEvidence'];

export function validateOptimizationEnvelope(config, actions) {
  fields(config, allowed, 'optimization config');
  if (config.schemaVersion !== 1) throw configValue('config.schemaVersion', '1');
  if (!actions.includes(config.action)) throw configValue('config.action', actions.join(', '));
  if (typeof config.project !== 'string' || !path.isAbsolute(config.project)) throw configValue('config.project', 'an absolute theme path');
  if (config.action === 'verify') validateDeliveryPolicy(config.policy);
  const {goal} = acceptanceContract(config.acceptancePolicy, config.goal);
  if (config.budget !== undefined) validateResourceBudget(config.budget);
  for (const key of ['exploreFirst','rollbackOnFailure']) {
    if (config[key] !== undefined && typeof config[key] !== 'boolean') throw configValue('config.'+key, 'true or false');
  }
  return goal;
}

export function validateOptimizationConfig(config) {
  validateOptimizationEnvelope(config, ['prepare','apply','verify']);
  if (config.action === 'prepare') {
    if (!isObject(config.recipe) || config.recipe.schemaVersion !== 1 || !Array.isArray(config.recipe.changes) || !config.recipe.changes.length) {
      throw configValue('config.recipe', 'an object with schemaVersion 1 and a nonempty changes array');
    }
    return;
  }
  if (typeof config.plan !== 'string' || !config.plan) throw configValue('config.plan', 'a saved plan path');
  if (!/^[a-f0-9]{64}$/.test(config.reviewedPlanHash ?? '')) throw configValue('config.reviewedPlanHash', 'the 64-character lowercase SHA-256 of the reviewed plan');
  if (config.action !== 'verify') return;
  if (typeof config.before !== 'string' || !config.before) throw configValue('config.before', 'a baseline run path');
  const measurement = validateAt('measurement', () => validateMeasureConfig(config.measurement));
  if (measurement.purpose !== 'acceptance') throw configValue('measurement.purpose', 'acceptance');
  if (measurement.deployment?.project !== config.project) throw configValue('measurement.deployment.project', 'the same absolute path as config.project');
  validateAt('scenarios', () => validateScenarioConfig({...config.scenarios, project: config.project}));
  return {measurement};
}
