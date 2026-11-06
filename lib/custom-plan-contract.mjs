import {parse} from 'acorn';
import postcss from 'postcss';
import {toLiquidHtmlAST} from '@shopify/liquid-html-parser';
import {canonical} from './core/plan-utils.mjs';

export function parseCustomSource(target,source) {
  if(target.endsWith('.liquid'))toLiquidHtmlAST(source,{mode:'strict'});
  else if(/\.m?js$/.test(target)){try{parse(source,{ecmaVersion:'latest',sourceType:'module'});}catch{parse(source,{ecmaVersion:'latest',sourceType:'script'});}}
  else if(target.endsWith('.css'))postcss.parse(source);
}

/** Keep custom provenance and syntax checks when a saved plan uses the legacy path. */
export function customPlanIdentity(plan) {
  if(!plan.changes.some(c=>c.evidence?.implementationRequestHash!==undefined))return null;
  const first=plan.changes[0].evidence;
  const identity=e=>({requestHash:e.implementationRequestHash,method:e.method,candidateId:e.candidateId,sourceHash:e.diagnosisSourceHash,checks:e.requestedChecks});
  if(!first||!/^custom\/[a-z0-9][a-z0-9-]{2,80}$/.test(first.method??'')||!/^[a-f0-9]{64}$/.test(first.implementationRequestHash??'')
    ||!Array.isArray(first.requestedChecks)||!first.requestedChecks.length||first.requestedChecks.some(c=>typeof c!=='string'||!c.trim()))throw new Error('Invalid custom implementation contract.');
  const expected=canonical(identity(first));
  for(const c of plan.changes){
    if(canonical(identity(c.evidence))!==expected)throw new Error('Custom implementation identity differs across patch files.');
    parseCustomSource(c.target,c.after);
  }
  return identity(first);
}
