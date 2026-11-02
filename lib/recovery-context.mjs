import {parse} from 'acorn';
import {liquidAST,visitAST} from './advanced-strategies.mjs';
import {digest} from './evidence-contract.mjs';
import {normalizeEvidenceUrl} from './run-evidence.mjs';

/** Stable across an unrelated baseline edit or a line shift; never use noisy timing as a reset. */
export function recoveryContext(candidate,files=[]) {
  const file=files.find(f=>f.file===candidate.file),offset=candidate.source?.offset;
  if(!file||!Number.isInteger(offset))return null;
  try {
    let fragment;
    if(candidate.file.endsWith('.liquid')&&!/\.m?js\.liquid$/.test(candidate.file)) {
      const start=candidate.data?.target?.loopOffset??offset;
      visitAST(liquidAST(file.text),node=>{
        if(['LiquidTag','LiquidVariableOutput','HtmlElement','HtmlVoidElement','HtmlRawNode'].includes(node.type)
          &&node.position?.start===start&&node.position.end>start&&(fragment===undefined||node.position.end-start<fragment.length))
          fragment=file.text.slice(start,node.position.end);
      });
    } else if(/\.m?js$/.test(candidate.file)) {
      const tree=parse(file.text,{ecmaVersion:'latest',sourceType:'module'});let best=tree;
      const walk=n=>{if(!n||typeof n!=='object')return;
        if(Number.isInteger(n.start)&&n.start<=offset&&n.end>offset&&/Function|Statement|Declaration/.test(n.type)&&n.end-n.start<best.end-best.start)best=n;
        for(const [k,v]of Object.entries(n))if(k!=='start'&&k!=='end')Array.isArray(v)?v.forEach(walk):walk(v);
      };walk(tree);fragment=file.text.slice(best.start,best.end);
    }
    if(!fragment)return null;
    const p=candidate.domainEvidence?.profile;
    const runtime=p?.kind==='runtime-profile'?p:(candidate.domainEvidence?.runtimeProfiles??[]).find(p=>p.config?.device===candidate.device&&normalizeEvidenceUrl(p.config.url)===normalizeEvidenceUrl(candidate.page));
    const target=candidate.data?.target;
    const context={version:1,file:candidate.file,kind:candidate.kind,metric:candidate.metric,page:normalizeEvidenceUrl(candidate.page),device:candidate.device,interactionTarget:candidate.target??null,interactionEvent:candidate.event??null,
      fragment,dependencies:(candidate.domainEvidence?.dependencyFiles??[]).map(f=>[f.file,f.sourceHash]).sort(),
      target:target?Object.fromEntries(['tag','id','bodyId','descendants','attrs','currentSrc','rootSelector'].filter(k=>target[k]!==undefined).map(k=>[k,target[k]])):null,
      // Content/order changes can alter the critical path. Duration changes cannot reopen a failure.
      delivery:runtime?.initial?.delivery?.stylesheets?.map(s=>[s.tag,s.href,s.media,s.disabled])??null,
      resources:(runtime?.resources??[]).filter(r=>['Script','Stylesheet','Font'].includes(r.type)).map(r=>[r.url,r.bodyHash??r.source?.sourceHash??null]).sort((a,b)=>a[0].localeCompare(b[0])),
    };
    return {version:1,key:digest(context),basis:'parser-target-dependencies-and-delivery-context'};
  }catch{return null;}
}

export function sameRecoveryContext(history,candidate,baselineHash,hypothesisKey) {
  if(history.outcome==='invalid-evidence')return false;
  if(history.recoveryContext?.key&&candidate.recoveryContext?.key)
    return history.recoveryContext.key===candidate.recoveryContext.key;
  return history.baselineHash===baselineHash&&history.hypothesisKey===hypothesisKey;
}
