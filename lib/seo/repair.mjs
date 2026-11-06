import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import {protectSEOChange} from './repair-protection.mjs';
import {auditSEOSource,validateSEOAudit} from './audit.mjs';
import {tags,maskNonRendering} from '../core/html-source.mjs';
import {readTarget,validTarget,projectRoot} from '../core/source-target.mjs';
import {executeChanges} from '../core/source-write.mjs';
import {sha256} from '../core/source-utils.mjs';
import {planHash,canonical,unifiedDiff} from '../core/plan-utils.mjs';
import {guardOutput,saveFile} from './io.mjs';

const selectedRules=(targets,audit,file)=>targets.filter(t=>t.file===file||audit.findings.find(f=>f.file===t.file&&f.ruleId===t.ruleId)?.evidence?.reachable?.includes(file)).map(t=>t.ruleId);
const validText=s=>typeof s==='string'&&Buffer.from(s,'utf8').toString('utf8')===s;
const key=f=>`${f.file}:${f.ruleId}`;
const fields=(v,allowed)=>{if(!v||Array.isArray(v)||typeof v!=='object'||Object.keys(v).some(k=>!allowed.includes(k)))throw new Error('Invalid SEO repair configuration.');};
const active=s=>tags(maskNonRendering(s)).filter(t=>!t.svg&&!t.inert);
const digestManifest=files=>sha256(JSON.stringify(files));
const target=t=>{validTarget(t);if(!/^(layout|templates|sections|snippets|blocks)\/.+\.liquid$/.test(t))throw new Error('SEO repairs accept existing theme Liquid files only.');};
function automatic(source,findings) {
  const ids=new Set(findings.map(f=>f.ruleId)),nodes=active(source),head=nodes.filter(t=>t.name==='head');
  const edits=[],selected=[];
  const add=(start,end,text,id)=>{edits.push({start,end,text});selected.push(id);};
  // Insert only in a unique, literal layout head; no guessing snippet/App ownership.
  if(head.length===1&&!head[0].dynamic&&!head[0].duplicate) {
    const snippets={
      'Q-SEO-TITLE':'<title>{{ page_title | escape }}</title>',
      'Q-SEO-DESCRIPTION':'<meta name="description" content="{{ page_description | escape }}">',
      'Q-SEO-CANONICAL':'<link rel="canonical" href="{{ canonical_url }}">',
      'Q-SEO-SOCIAL':'<meta property="og:title" content="{{ page_title | escape }}">',
    };
    const insert=Object.entries(snippets).filter(([id])=>ids.has(id));
    if(insert.length){add(head[0].end,head[0].end,'\n'+insert.map(([,s])=>s).join('\n')+'\n',insert[0][0]);selected.push(...insert.slice(1).map(([id])=>id));}
  }
  const html=nodes.filter(t=>t.name==='html');
  if(ids.has('Q-SEO-LANG')&&html.length===1&&!html[0].dynamic&&!html[0].duplicate){
    const a=html[0].attributeList.find(a=>a.name==='lang');
    if(a&&!html[0].attributes.lang.trim())add(a.start,a.end,'lang="{{ request.locale.iso_code }}"','Q-SEO-LANG');
    else if(!a)add(html[0].end-1,html[0].end-1,' lang="{{ request.locale.iso_code }}"','Q-SEO-LANG');
  }
  for(const n of nodes){
    if(n.dynamic||n.duplicate||n.malformed)continue;
    if(ids.has('Q-SEO-EMPTY-TITLE')&&n.name==='title'&&!n.body.trim())add(n.bodyStart,n.bodyStart+n.body.length,'{{ page_title | escape }}','Q-SEO-EMPTY-TITLE');
    if(ids.has('Q-SEO-EMPTY-DESCRIPTION')&&n.name==='meta'&&n.attributes.name?.toLowerCase()==='description'&&typeof n.attributes.content==='string'&&!n.attributes.content.trim()){
      const a=n.attributeList.find(a=>a.name==='content');add(a.start,a.end,'content="{{ page_description | escape }}"','Q-SEO-EMPTY-DESCRIPTION');
    }
    if(ids.has('Q-SEO-CANONICAL-VALUE')&&n.name==='link'&&n.attributes.rel?.toLowerCase().split(/\s+/).includes('canonical')&&(!n.attributes.href?.trim()||/^(javascript:|#)/i.test(n.attributes.href.trim()))){
      const a=n.attributeList.find(a=>a.name==='href');if(a)add(a.start,a.end,'href="{{ canonical_url }}"','Q-SEO-CANONICAL-VALUE');else add(n.end-(source[n.end-2]==='/'?2:1),n.end-(source[n.end-2]==='/'?2:1),' href="{{ canonical_url }}"','Q-SEO-CANONICAL-VALUE');
    }
  }
  let after=source;for(const e of edits.sort((a,b)=>b.start-a.start))after=after.slice(0,e.start)+e.text+after.slice(e.end);
  return {after,selected:[...new Set(selected)]};
}
async function candidateAudit(project,before,changes) {
  const temp=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'seo-candidate-')));
  try {
    for(const entry of before.sourceManifest){const dest=path.join(temp,entry.file);await fs.mkdir(path.dirname(dest),{recursive:true});await fs.copyFile(path.join(project,entry.file),dest);}
    const copied=await auditSEOSource({project:temp});if(copied.sourceHash!==before.sourceHash||!copied.complete)throw new Error('Source changed while preparing candidate.');
    for(const c of changes)await fs.writeFile(path.join(temp,c.target),c.after);
    return await auditSEOSource({project:temp});
  }finally{await fs.rm(temp,{recursive:true,force:true});}
}
function compare(before,after,targets) {
  const counts=r=>{const out=new Map();for(const f of r.findings)out.set(key(f),(out.get(key(f))??0)+1);return out;},a=counts(before),b=counts(after);
  return {resolved:targets.filter(t=>a.has(key(t))&&!b.has(key(t))),unresolved:targets.filter(t=>b.has(key(t))),introduced:[...b].filter(([k,n])=>n>(a.get(k)??0)).map(([key,count])=>({key,count}))};
}
export async function createSEOPlan({project,config}={}) {
  project=await projectRoot(project);const before=validateSEOAudit(await auditSEOSource({project}));
  if(!before.complete)throw new Error('Repair requires complete source coverage; resolve missing/dynamic dependencies first.');
  const changes=[],targets=[];
  if(config!==undefined){
    fields(config,['schemaVersion','summary','targets','changes']);
    if(config.schemaVersion!==1||!config.summary?.trim()||!Array.isArray(config.changes)||!config.changes.length||!Array.isArray(config.targets)||!config.targets.length)throw new Error('Supply a source repair summary, targets and replacement changes.');
    for(const t of config.targets){fields(t,['file','ruleId']);if(!before.findings.some(f=>key(f)===key(t)))throw new Error('Repair target is not a current SEO finding.');targets.push(t);}
    for(const c of config.changes){fields(c,['target','replacementText']);target(c.target);const {source}=await readTarget(project,c.target);changes.push({target:c.target,before:source,after:c.replacementText,reason:config.summary});}
  }else{
    for(const file of new Set(before.findings.map(f=>f.file))){
      if(!file.startsWith('layout/')||file==='layout/password.liquid')continue;
      const {source}=await readTarget(project,file),result=automatic(source,before.findings.filter(f=>f.file===file));
      if(result.after!==source){changes.push({target:file,before:source,after:result.after,reason:'Restore source metadata using Shopify Liquid objects.'});targets.push(...result.selected.map(ruleId=>({file,ruleId})));}
    }
  }
  if(new Set(targets.map(key)).size!==targets.length)throw new Error('Duplicate SEO repair targets.');
  if(changes.length>50||new Set(changes.map(c=>c.target)).size!==changes.length)throw new Error('Repair needs at most 50 distinct files.');
  for(const c of changes){target(c.target);if(!validText(c.after)||!c.after.trim()||c.after===c.before||Buffer.byteLength(c.after)>5*1024*1024)throw new Error('Invalid or unchanged replacement.');protectSEOChange(c.before,c.after,selectedRules(targets,before,c.target));Object.assign(c,{beforeHash:sha256(c.before),afterHash:sha256(c.after),diff:unifiedDiff(c.target,c.before,c.after)});}
  const after=changes.length?await candidateAudit(project,before,changes):before;
  const comparison=compare(before,after,targets);
  if(changes.length&&(!after.complete||comparison.introduced.length||comparison.unresolved.length||comparison.resolved.length!==targets.length))throw new Error('Candidate does not resolve every selected finding without new source findings.');
  const current=await auditSEOSource({project});if(current.sourceHash!==before.sourceHash||!current.complete)throw new Error('Source drift during planning.');
  const plan={schemaVersion:1,kind:'seo-change-plan',domain:'seo',id:randomUUID(),project,createdAt:new Date().toISOString(),mode:config?'reviewed-source':'automatic-metadata',
    metadata:{readOnlyDependencies:before.sourceManifest.filter(f=>!changes.some(c=>c.target===f.file)).map(f=>({file:f.file,sourceHash:f.sha256}))},
    changes,targets,beforeAudit:before,expectedManifest:after.sourceManifest,comparison,
    status:changes.length?'ready':before.findings.length?'implementation-required':'no-findings',
    acceptance:'not-evaluated',verificationScope:'source-only',limitations:['Source rule resolution and Liquid parse only; no rendered, functional, indexing or ranking acceptance.']};
  plan.planHash=planHash(plan);return plan;
}
export function validateSEOPlan(plan) {
  if(!plan||plan.schemaVersion!==1||plan.kind!=='seo-change-plan'||plan.domain!=='seo'||plan.planHash!==planHash(plan)||plan.verificationScope!=='source-only'||plan.acceptance!=='not-evaluated'||plan.status!=='ready'||!['reviewed-source','automatic-metadata'].includes(plan.mode)||typeof plan.id!=='string'||!plan.id)throw new Error('Invalid SEO plan.');
  const before=validateSEOAudit(plan.beforeAudit);
  if(before.mode!=='source'||!before.complete||before.project!==plan.project||!Array.isArray(plan.changes)||!plan.changes.length||plan.changes.length>50||new Set(plan.changes.map(c=>c.target)).size!==plan.changes.length||!Array.isArray(plan.targets)||!plan.targets.length||new Set(plan.targets.map(key)).size!==plan.targets.length)throw new Error('Invalid SEO plan scope.');
  const manifest=new Map(before.sourceManifest.map(f=>[f.file,f.sha256]));
  for(const c of plan.changes){target(c.target);if(!validText(c.before)||!validText(c.after)||!c.after.trim()||c.after===c.before||Buffer.byteLength(c.after)>5*1024*1024||sha256(c.before)!==c.beforeHash||sha256(c.after)!==c.afterHash||manifest.get(c.target)!==c.beforeHash||c.diff!==unifiedDiff(c.target,c.before,c.after)||typeof c.reason!=='string'||!c.reason.trim())throw new Error('Invalid SEO change fingerprint.');protectSEOChange(c.before,c.after,selectedRules(plan.targets,before,c.target));manifest.set(c.target,c.afterHash);}
  for(const t of plan.targets)if(!before.findings.some(f=>key(f)===key(t)))throw new Error('Invalid SEO plan finding.');
  if(canonical(plan.expectedManifest)!==canonical(before.sourceManifest.map(f=>({file:f.file,sha256:manifest.get(f.file)}))))throw new Error('Invalid expected source manifest.');
  const dependencies=before.sourceManifest.filter(f=>!plan.changes.some(c=>c.target===f.file)).map(f=>({file:f.file,sourceHash:f.sha256}));
  if(canonical(plan.metadata?.readOnlyDependencies)!==canonical(dependencies))throw new Error('Invalid SEO dependency manifest.');
  return plan;
}
export async function applySEOPlan(plan,project) {
  validateSEOPlan(plan);project=await projectRoot(project);if(project!==plan.project)throw new Error('SEO plan project mismatch.');
  const current=await auditSEOSource({project}),expected=digestManifest(plan.expectedManifest);
  if(!current.complete||![plan.beforeAudit.sourceHash,expected].includes(current.sourceHash))throw new Error('Theme drift since SEO planning.');
  const before=current.sourceHash===plan.beforeAudit.sourceHash?current:await candidateAudit(project,current,plan.changes.map(c=>({...c,after:c.before})));
  if(before.sourceHash!==plan.beforeAudit.sourceHash)throw new Error('Baseline reconstruction failed.');
  const preview=current.sourceHash===before.sourceHash?await candidateAudit(project,current,plan.changes):current;
  const checked=compare(before,preview,plan.targets);
  if(!preview.complete||checked.unresolved.length||checked.introduced.length||checked.resolved.length!==plan.targets.length)throw new Error('Candidate source findings failed replay verification.');
  return executeChanges(plan,project,'apply',{validatePlan:validateSEOPlan,receiptKind:'seo-change-receipt'});
}
export async function rollbackSEOPlan(plan,project) {
  validateSEOPlan(plan);if(await projectRoot(project)!==plan.project)throw new Error('SEO plan project mismatch.');
  return executeChanges(plan,project,'rollback',{validatePlan:validateSEOPlan,receiptKind:'seo-change-receipt'});
}
export async function verifySEOPlan(plan,project) {
  validateSEOPlan(plan);if(await projectRoot(project)!==plan.project)throw new Error('SEO plan project mismatch.');
  const after=await auditSEOSource({project});
  const before=await candidateAudit(project,after,plan.changes.map(c=>({...c,after:c.before})));
  const comparison=compare(before,after,plan.targets);
  const current=await auditSEOSource({project}),sourceStable=current.complete&&current.sourceHash===after.sourceHash;
  const passed=sourceStable&&before.sourceHash===plan.beforeAudit.sourceHash&&before.complete&&after.complete&&after.sourceHash===digestManifest(plan.expectedManifest)&&!comparison.unresolved.length&&!comparison.introduced.length&&comparison.resolved.length===plan.targets.length;
  return {schemaVersion:1,kind:'seo-repair-verification',domain:'seo',planHash:plan.planHash,scope:'source-only',sourceStable,status:passed?'source-verified':'not-verified',passed,acceptance:passed?'source-fix-verified':'not-accepted',comparison,remaining:after.findings,afterAudit:after,runtime:'not-run',onlineSEO:'not-evaluated'};
}
export async function repairSEO({project,config,output}) {
  project=await projectRoot(project);output=await guardOutput(output,project);await fs.mkdir(path.dirname(output),{recursive:true});await fs.mkdir(output);
  const plan=await createSEOPlan({project,config});await saveFile(path.join(output,'plan.json'),plan);
  if(!plan.changes.length){const result={kind:'seo-repair',status:plan.status,changed:false,acceptance:'not-evaluated',remaining:plan.beforeAudit.findings};await saveFile(path.join(output,'result.json'),result);return result;}
  let applied=false;
  try {
    const receipt=await applySEOPlan(plan,project);applied=true;await saveFile(path.join(output,'apply.json'),receipt);
    const verification=await verifySEOPlan(plan,project);await saveFile(path.join(output,'verification.json'),verification);
    if(!verification.passed)throw new Error('Source verification failed.');
    const result={kind:'seo-repair',status:verification.remaining.length?'partially-repaired':'source-verified',changed:true,acceptance:'source-fix-verified',planHash:plan.planHash,resolved:verification.comparison.resolved,remaining:verification.remaining,scope:'source-only'};
    await saveFile(path.join(output,'result.json'),result);return result;
  } catch(error) {
    const persistenceErrors=[];
    const record=async(name,value)=>{try{await saveFile(path.join(output,name),value);}catch(e){persistenceErrors.push({file:name,error:e.message});}};
    let rollback=null;
    if(applied) {
      try{rollback=await rollbackSEOPlan(plan,project);}catch(e){rollback={status:'conflict',error:e.message,receipt:e.receipt??null};}
    } else if(error.receipt?.partial)rollback={status:'conflict',receipt:error.receipt};
    else if(error.receipt?.writesOccurred)rollback={completed:true,status:'restored',receipt:error.receipt};
    if(error.receipt)await record('failure-receipt.json',error.receipt);
    if(rollback)await record('rollback.json',rollback);
    const result={kind:'seo-repair',status:rollback?.completed?'failed-rolled-back':rollback?'rollback-conflict':'failed',acceptance:'not-accepted',error:error.message,rollback,persistenceErrors};
    await record('result.json',result);return result;
  }
}
