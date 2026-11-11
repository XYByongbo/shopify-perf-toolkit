import {standardsCatalog,standardsReference} from './standards-registry.mjs';
import {fields,digest} from './evidence-contract.mjs';
import {readThemeSource} from './core/source-reader.mjs';

const ids=new Set(standardsCatalog().rules.map(r=>r.id));
function identity(input){
  fields(input,['url','themeId','themeRole','pageType','language','currency','viewport'],'PageOtter identity');
  const url=new URL(input.url);if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw new Error('PageOtter needs an HTTP(S) page URL without credentials.');
  for(const k of ['themeId','themeRole','pageType','language','currency'])if(typeof input[k]!=='string'||!input[k].trim())throw new Error(`PageOtter identity missing ${k}.`);
  if(!['live','preview','development'].includes(input.themeRole))throw new Error('Unknown PageOtter theme role.');
  if(!input.viewport||!['width','height'].every(k=>Number.isInteger(input.viewport[k])&&input.viewport[k]>0&&input.viewport[k]<=20000))throw new Error('Invalid PageOtter viewport.');
  return structuredClone(input);
}
const comparableIdentity=i=>[i.url,i.themeId,i.themeRole,i.pageType,i.language,i.currency,i.viewport];
const key=c=>digest([c.ruleId,c.subject]);

/** Proposed v1 handoff contract. Existing unspecified extension formats are rejected, not guessed. */
export async function importPageOtter({input,project,baseline}={}) {
  fields(input,['schemaVersion','kind','producer','identity','capturedAt','ruleScope','checks'],'PageOtter handoff');
  if(input.schemaVersion!==1||input.kind!=='pageotter-handoff'||input.producer?.name!=='PageOtter'||typeof input.producer.version!=='string'||!input.producer.version.trim()
    ||!Number.isFinite(Date.parse(input.capturedAt)))throw new Error('Unsupported PageOtter handoff format/version. Use the documented v1 adapter contract.');
  const page=identity(input.identity),scope=input.ruleScope;
  if(!Array.isArray(scope)||!scope.length||scope.some(id=>!ids.has(id))||new Set(scope).size!==scope.length)throw new Error('PageOtter ruleScope needs unique registered standards IDs.');
  if(!Array.isArray(input.checks)||input.checks.length>5000)throw new Error('Invalid PageOtter checks.');
  const checks=[],seen=new Set();
  for(const raw of input.checks){
    fields(raw,['ruleId','subject','status','summary','reason','evidenceLevel','evidence','sourceCandidate'],'PageOtter check');
    if(!scope.includes(raw.ruleId)||typeof raw.subject!=='string'||!raw.subject.trim()||typeof raw.summary!=='string'||!raw.summary.trim()
      ||!['PASS','FAIL','NOT RUN','N/A'].includes(raw.status))throw new Error('Malformed PageOtter check.');
    const id=key(raw);if(seen.has(id))throw new Error('Duplicate PageOtter rule/subject.');seen.add(id);
    if(['NOT RUN','N/A'].includes(raw.status)&&!raw.reason?.trim())throw new Error('NOT RUN / N/A requires an explicit reason.');
    if(['PASS','FAIL'].includes(raw.status)&&(!['E1','E2','E4'].includes(raw.evidenceLevel)||!Array.isArray(raw.evidence)||!raw.evidence.length
      ||raw.evidence.some(e=>!e||typeof e.observation!=='string'||!e.observation.trim())))throw new Error('Executed PageOtter checks require scoped observation evidence.');
    let sourceCandidate=null;
    if(raw.sourceCandidate){
      const s=raw.sourceCandidate;fields(s,['file','confidence','sourceHash'],'PageOtter source candidate');
      if(!/^(sections|snippets|blocks)\/[\w-]+\.liquid$/.test(s.file)||!['annotated','inferred','user-selected'].includes(s.confidence))throw new Error('Unsafe or invalid source candidate.');
      sourceCandidate={...s,binding:'unverified-candidate'};
      if(project&&/^[a-f0-9]{64}$/.test(s.sourceHash??''))try{const local=await readThemeSource(project,s.file,s.sourceHash);sourceCandidate.binding=local.sourceHash===s.sourceHash?'local-hash-match-remote-unverified':'mismatch';}catch{sourceCandidate.binding='unavailable-or-mismatch';}
    }
    checks.push({...structuredClone(raw),id,standardRuleIds:[raw.ruleId],sourceCandidate,provenance:'external-observation-not-reexecuted',executed:['PASS','FAIL'].includes(raw.status)});
  }
  for(const ruleId of scope.filter(id=>!checks.some(c=>c.ruleId===id)))checks.push({id:digest([ruleId,'missing']),ruleId,standardRuleIds:[ruleId],subject:'page',status:'NOT RUN',summary:'No observation supplied for selected rule.',reason:'Selected scope without corresponding evidence.',executed:false});
  let comparison={status:'not-requested',added:[],existing:[],resolved:[],incomparable:[]};
  if(baseline){
    // Re-normalize original input; saved comparison/status fields are not authoritative.
    if(baseline.kind!=='pageotter-import'||!baseline.original)throw new Error('Baseline must retain its original PageOtter handoff.');
    const old=await importPageOtter({input:baseline.original});
    const same=digest(comparableIdentity(old.identity))===digest(comparableIdentity(page))&&digest([...old.ruleScope].sort())===digest([...scope].sort())
      &&Date.parse(input.capturedAt)>Date.parse(old.capturedAt);
    comparison.status=same?'comparable':'not-comparable';
    for(const c of checks.filter(c=>c.status==='FAIL'))(old.checkResults.some(b=>key(b)===key(c)&&b.status==='FAIL')&&same?comparison.existing:same?comparison.added:comparison.incomparable).push(c.id);
    for(const c of old.checkResults.filter(c=>c.status==='FAIL')){
      const current=checks.find(n=>key(n)===key(c));
      if(same&&current?.status==='PASS')comparison.resolved.push(c.id);
      else if(!same||!current||current.status!=='FAIL')comparison.incomparable.push(c.id);
    }
    comparison.incomparable=[...new Set(comparison.incomparable)];
  }
  return {schemaVersion:1,kind:'pageotter-import',standards:standardsReference,identity:page,ruleScope:[...scope],capturedAt:input.capturedAt,
    original:structuredClone(input),inputHash:digest(input),checkResults:checks,
    findings:checks.filter(c=>c.status==='FAIL').map(c=>({...c,status:'external-observation',checkStatus:'FAIL',file:c.sourceCandidate?.file??null,verification:['Reproduce against current source and verify the candidate file before planning a patch.']})),
    comparison,reviewRequired:checks.some(c=>['FAIL','NOT RUN'].includes(c.status)),acceptance:'not-evaluated',
    limitations:['Proposed handoff v1 only; no claim that PageOtter 0.9.3 already exports this schema.','External results are attributed observations, never formal optimization/deployment proof.','Resolution requires an explicit later PASS for the same subject and comparable page/theme/viewport/rule scope.']};
}
