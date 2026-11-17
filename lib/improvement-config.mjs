import path from 'node:path';
import {validateMeasureConfig} from './measure.mjs';
import {configValue, fields, goalContract, isObject, validateAt} from './evidence-contract.mjs';
import {validateBudget} from './execution-policy.mjs';
import {validateResourceBudget} from './resource-budget.mjs';

const actions = {
  start: ['project','run','profiles','liquidProfile','field','owners','goal','budget','sources','resourceBudget'],
  refresh: ['run','profiles','liquidProfile','field','owners'],
  reprofile: ['evidence'],
  prepare: ['candidateId','method','rationale','recipe','recipeDir','demand','split','plan','domain','official','sources','implementation'],
  apply: ['adapterContext','reviewedPlanHash'], sync: ['preview'], experiment: ['experiment'], collect: ['formal'], verify: ['verification'], rollback: [], recover: [],
};
export function validateImprovementConfig(config) {
  if (!Object.hasOwn(actions, config?.action)) throw configValue('config.action', Object.keys(actions).join(', '));
  fields(config, ['schemaVersion','action','previous',...actions[config.action]], 'improvement config');
  if (config.schemaVersion !== 1) throw configValue('config.schemaVersion', '1');
  if (config.action === 'start') {
    if (config.previous) throw configValue('config.previous', 'omitted for action=start');
    for (const key of ['project','run']) {
      if (typeof config[key] !== 'string' || !path.isAbsolute(config[key])) throw configValue('config.'+key, 'an absolute path');
    }
    goalContract(config.goal);
    validateBudget(config.budget);
    if (config.resourceBudget !== undefined) validateResourceBudget(config.resourceBudget);
  } else if (typeof config.previous !== 'string' || !path.isAbsolute(config.previous)) {
    throw configValue('config.previous', 'an absolute session.json path');
  }
}

export function validateImprovementInput(config) {
  validateImprovementConfig(config);
  if (config.action === 'prepare') {
    for (const key of ['candidateId','method','rationale']) {
      if (typeof config[key] !== 'string' || !config[key].trim()) throw configValue('config.'+key, 'a nonempty string');
    }
    const choices = ['recipe','demand','split','plan','domain','official','implementation'];
    if (choices.filter(key => config[key] !== undefined).length !== 1) {
      throw configValue('config', 'one preparation input from: ' + choices.join(', '));
    }
  }
  if (config.action === 'apply' && !/^[a-f0-9]{64}$/.test(config.reviewedPlanHash ?? '')) {
    throw configValue('config.reviewedPlanHash', 'the 64-character lowercase SHA-256 of the reviewed plan');
  }
  const payload = {sync:'preview', experiment:'experiment', collect:'formal', verify:'verification'}[config.action];
  if (payload && !isObject(config[payload]) && !(typeof config[payload] === 'string' && config[payload].trim())) {
    throw configValue('config.'+payload, 'a config object or a saved JSON path');
  }
  if (isObject(config.formal)) validateAt('formal.measurement', () => validateMeasureConfig(config.formal.measurement));
  if (config.action === 'reprofile' && (!Array.isArray(config.evidence) || !config.evidence.length || config.evidence.length > 10)) {
    throw configValue('config.evidence', 'an array with 1 to 10 capture requests');
  }
}
