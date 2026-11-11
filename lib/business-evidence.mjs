import path from 'node:path';
import {fields,readEvidenceJSON,digest} from './evidence-contract.mjs';
import {canonical} from './core/plan-utils.mjs';

const hash=/^[a-f0-9]{64}$/;
const nonempty=v=>typeof v==='string'&&v.trim();
/** Import observations from an authorized external test runner. This API makes no writes. */
export async function verifyBusinessEvidence({input,identity,requiredCases}={}){
  if(!path.isAbsolute(input??'')||!Array.isArray(requiredCases)||!requiredCases.length||new Set(requiredCases).size!==requiredCases.length)throw new Error('Business evidence needs an absolute manifest and unique required cases.');
  const manifest=await readEvidenceJSON(input),root=path.dirname(input);
  fields(manifest,['schemaVersion','kind','producer','mode','authorization','identity','startedAt','finishedAt','cases'],'business manifest');
  if(manifest.schemaVersion!==1||manifest.kind!=='external-business-run'||!nonempty(manifest.producer)||manifest.mode!=='authorized-preview')throw new Error('Expected an authorized external preview run, not simulated scenarios.');
  fields(manifest.authorization,['reference','store','themeId'],'business authorization');
  if(!nonempty(manifest.authorization.reference)||manifest.authorization.store!==identity.store||String(manifest.authorization.themeId)!==String(identity.themeId))throw new Error('Business authorization scope mismatch.');
  if(!hash.test(identity.sourceHash??'')||['sourceHash','store','themeId'].some(k=>String(manifest.identity?.[k])!==String(identity[k])))throw new Error('Business deployment identity mismatch.');
  const start=Date.parse(manifest.startedAt),end=Date.parse(manifest.finishedAt);
  if(!Number.isFinite(start)||!Number.isFinite(end)||end<=start||end>Date.now())throw new Error('Invalid business execution interval.');
  if(!Array.isArray(manifest.cases)||manifest.cases.length>100||new Set(manifest.cases.map(c=>c.id)).size!==manifest.cases.length)throw new Error('Invalid business cases.');
  const checks=[];
  for(const id of requiredCases){
    const c=manifest.cases.find(c=>c.id===id);if(!c){checks.push({id,pass:false,reason:'missing-case'});continue;}
    fields(c,['id','artifact','sha256','expected'],'business case');
    if(!hash.test(c.sha256??'')||!nonempty(c.artifact))throw new Error('Case must reference raw hash-bound observations.');
    const raw=await readEvidenceJSON(path.resolve(root,c.artifact),{root,hash:c.sha256});
    fields(raw,['identity','startedAt','finishedAt','actions','requests','cart','ui','events','errors','simulated'],'business observations');
    fields(c.expected,['cart','ui','events','writes'],'business expectations');
    const rs=Date.parse(raw.startedAt),re=Date.parse(raw.finishedAt);
    const valid=raw.simulated===false&&rs>=start&&re<=end&&re>rs
      &&['sourceHash','store','themeId'].every(k=>String(raw.identity?.[k])===String(identity[k]))
      &&Array.isArray(raw.actions)&&raw.actions.length>0&&raw.actions.every(a=>nonempty(a.type)&&nonempty(a.target)&&Number.isFinite(Date.parse(a.at))&&Date.parse(a.at)>=rs&&Date.parse(a.at)<=re)
      &&Array.isArray(raw.requests)&&raw.requests.length>0&&raw.requests.every(r=>['GET','POST'].includes(r.method)&&nonempty(r.url)&&Number.isInteger(r.status)&&r.status>=100&&r.status<=599&&r.completed===true)
      &&Array.isArray(raw.errors)&&raw.errors.length===0;
    const writes=raw.requests?.filter(r=>r.method==='POST')??[];
    const observedWrites=writes.map(r=>({url:r.url,status:r.status}));
    const pass=valid&&['cart','ui','events'].every(k=>c.expected[k]!==undefined&&raw[k]!==undefined&&canonical(raw[k])===canonical(c.expected[k]))
      &&Array.isArray(c.expected.writes)&&canonical(observedWrites)===canonical(c.expected.writes);
    checks.push({id,pass,artifact:c.artifact,sha256:c.sha256,reason:pass?'observations-match':'observation-or-expectation-mismatch'});
  }
  return {schemaVersion:1,kind:'business-verification',outcome:checks.every(c=>c.pass)?'passed':'not-accepted',identity,manifestHash:digest(manifest),checks,
    limitation:'Hash-bound external runner observations, not a server signature or proof of unrecorded actions; payment and field INP are not inferred.'};
}
