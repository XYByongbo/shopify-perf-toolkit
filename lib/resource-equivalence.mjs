import {liquidAST,visitAST} from './advanced-strategies.mjs';
import {validDomainProfile} from './domain-profile.mjs';
import {normalizeEvidenceUrl} from './run-evidence.mjs';
export function rehostContract(change) {
  let oldUrl,tag,attribute,id,rel,as;
  visitAST(liquidAST(change.before),n=>{
    if(n.position?.start!==change.parameters.tagStart)return;
    tag=typeof n.name==='string'?n.name:n.name?.map(x=>x.value).join('');attribute=tag==='link'?'href':'src';
    const attrs=Object.fromEntries((n.attributes??[]).filter(a=>a.value?.every(x=>x.type==='TextNode')).map(a=>[a.name.map(x=>x.value).join('').toLowerCase(),a.value.map(x=>x.value).join('').replace(/&amp;/g,'&')]));
    oldUrl=attrs[attribute];id=attrs.id;rel=attrs.rel;as=attrs.as;
  });
  if(!oldUrl)throw new Error('Missing original rehost resource.');
  return {tag,attribute,id,rel,as,offset:change.parameters.tagStart,oldUrl,newUrl:new URL(change.parameters.replacementUrl).href,hash:change.parameters.originalBodyHash};
}
function resourceMimeMatches(contract,mime) {
  const type=mime.split(';')[0].trim().toLowerCase();
  const tag=contract.tag==='link'?({stylesheet:'style',icon:'img',modulepreload:'script'}[contract.rel]??{image:'img',font:'font',style:'style',script:'script'}[contract.as]):contract.tag;
  if(tag==='style')return type==='text/css';
  if(tag==='font')return type.startsWith('font/')||/^application\/(?:font-|vnd\.ms-fontobject)/.test(type);
  if(tag==='img')return type.startsWith('image/');
  if(tag==='script')return /^(?:application|text)\/(?:x-)?(?:javascript|ecmascript)$/.test(type);
  return type==='text/css'||type.startsWith('font/')||type.startsWith('image/')||/^(?:application|text)\/(?:x-)?(?:javascript|ecmascript)$/.test(type)||/^application\/(?:font-|vnd\.ms-fontobject)/.test(type);
}
export function checkResourceEquivalence(plan,evidence,left,right,groups) {
  try {
    const changes=plan.changes.filter(c=>c.recipeKind==='liquid-rehost-resource');
    if(!changes.length)return true;
    if(!evidence?.before?.length||!evidence?.after?.length||!groups?.length)return false;
    const witnessed=new Set();
    const equivalent=(a,b,c,contract)=>{
      const pass=targetMatches(a,c,contract,contract.oldUrl)&&targetMatches(b,c,contract,contract.newUrl)
        &&a.resources.some(x=>x.url===contract.oldUrl&&x.bodyHash===contract.hash&&x.status>=200&&x.status<300&&successfulGET(x)
          &&b.resources.some(y=>y.url===contract.newUrl&&y.bodyHash===contract.hash&&y.status>=200&&y.status<300&&successfulGET(y)&&x.mimeType&&x.mimeType===y.mimeType&&resourceMimeMatches(contract,x.mimeType)));
      if(pass)witnessed.add(c.target);return pass;
    };
    const passed=groups.every(g=>changes.every(c=>{
      const contract=rehostContract(c);
      const valid=(p,id,url)=>validDomainProfile(p,p.snapshot)&&p.snapshot.hash===id.sourceHash&&p.domainProof.before.store===id.store
        &&p.domainProof.before.themeId===id.themeId&&p.snapshot.files.some(f=>f.file===c.target&&f.sourceHash===(url===contract.oldUrl?c.beforeHash:c.afterHash))
        &&normalizeEvidenceUrl(p.config.url)===normalizeEvidenceUrl(g.url)&&p.config.device===g.device&&actionsCompleted(p);
      return evidence.before.some(a=>valid(a,left,contract.oldUrl)&&evidence.after.some(b=>valid(b,right,contract.newUrl)&&patchOnly(a,b,plan)
        &&a.config.state===b.config.state&&JSON.stringify(a.config.actions??[])===JSON.stringify(b.config.actions??[])&&Date.parse(a.finishedAt)<=Date.parse(b.createdAt)
        &&(unaffected(a,contract)&&unaffected(b,contract)||equivalent(a,b,c,contract))));
    }));
    return passed&&changes.every(c=>witnessed.has(c.target));
  }catch{return false;}
}

function successfulGET(r) {return r.method==='GET'&&!r.error&&!r.redirected&&Number.isFinite(r.timestamp)&&Number.isFinite(r.finishedTimestamp)&&r.finishedTimestamp>=r.timestamp;}
function targetMatches(p,c,contract,url) {
  if(!contract.id)return false;
  const targets=(p.domainTargets??[]).filter(t=>t.id===contract.id);
  if(targets.length!==1)return false;
  const t=targets[0];if(t.tag!==contract.tag.toUpperCase()||t.idCount!==1)return false;
  if(contract.tag==='img'){
    const health=p.resourceHealthAfter??p.resourceHealth;
    return t.currentSrc===url&&!t.inPicture&&t.naturalWidth>0&&t.naturalHeight>0&&health?.version===1
      &&health.images?.some(i=>i.selector==='#'+contract.id&&i.url===url&&i.complete===true&&i.decoded===true&&i.naturalWidth>0&&i.naturalHeight>0);
  }
  return typeof t.attrs?.[contract.attribute]==='string'&&t.attrs[contract.attribute].length>0&&new URL(t.attrs[contract.attribute],p.config.url).href===url;
}

function actionsCompleted(p) {
  const declared=p.config.actions??[],actual=p.actions??[];
  return declared.length===actual.length&&declared.every((s,i)=>Object.entries(s).every(([k,v])=>JSON.stringify(actual[i][k])===JSON.stringify(v))&&actual[i].status==='completed'&&Number.isFinite(actual[i].startedAtMs)&&Number.isFinite(actual[i].finishedAtMs)&&actual[i].finishedAtMs>=actual[i].startedAtMs);
}
function patchOnly(a,b,plan) {
  const left=new Map(a.snapshot.files.map(f=>[f.file,f.sourceHash])),right=new Map(b.snapshot.files.map(f=>[f.file,f.sourceHash]));
  const changed=[...new Set([...left.keys(),...right.keys()])].filter(f=>left.get(f)!==right.get(f));
  return changed.length===plan.changes.length&&plan.changes.every(c=>changed.includes(c.target)&&(c.beforeHash===null?!left.has(c.target):left.get(c.target)===c.beforeHash)&&right.get(c.target)===c.afterHash);
}

function unaffected(p,contract) {
  const coverage=p.domainTargetCoverage;
  return coverage?.version===1&&coverage.selectorScope==='all-img-script-link-and-configured-targets'&&coverage.truncated===false
    &&Array.isArray(p.domainTargets)&&coverage.total===p.domainTargets.length&&!p.domainTargets.some(t=>t.id===contract.id)
    &&Array.isArray(p.resources)&&!p.resources.some(r=>[contract.oldUrl,contract.newUrl].includes(r.url));
}
