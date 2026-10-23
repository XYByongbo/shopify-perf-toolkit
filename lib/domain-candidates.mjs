import { liquidAST, visitAST } from './advanced-strategies.mjs';
import { htmlName, imageFilter, filterArgument } from './performance-syntax.mjs';
import { digest } from './evidence-contract.mjs';
import { validDomainProfile } from './domain-profile.mjs';
import { analyzeLiquidProfile } from './liquid-profile.mjs';
import { normalizeEvidenceUrl } from './run-evidence.mjs';
import { validateOwners } from './app-attribution.mjs';
import {queryTargets,hiddenTargets,fetchTargets} from './extended-methods.mjs';

const literalAttribute = attr => attr?.value?.every(n=>n.type==='TextNode') ? attr.value.map(n=>n.value).join('') : null;
export function targetNodes(files) {
  const nodes=[];
  for(const file of files.filter(f=>f.file.endsWith('.liquid'))) {
    try{visitAST(liquidAST(file.text),(node,parents)=>{
      const filter=imageFilter(node),attrs=new Map((node.attributes??[]).map(a=>[htmlName(a),a]));
      if(!filter && !['HtmlVoidElement','HtmlRawNode','HtmlElement'].includes(node.type))return;
      if(!filter&&((node.attributes??[]).some(a=>!/^Attr/.test(a.type))||attrs.size!==(node.attributes??[]).length))return;
      if(filter&&(filter.args.some(a=>a.type!=='NamedArgument')||new Set(filter.args.map(a=>a.name)).size!==filter.args.length||node.markup.filters.at(-1)!==filter))return;
      const id=filter?filterArgument(filter,'id')?.value:undefined;
      const literalId=filter?(id?.type==='String'?id.value:null):literalAttribute(attrs.get('id'));
      const opaque=parents.some(p=>['HtmlComment','LiquidRawTag','AttrDoubleQuoted','AttrSingleQuoted'].includes(p.type)
        ||p.type==='LiquidTag'&&['capture','for','tablerow'].includes(p.name)||htmlName(p)==='template');
      if(opaque)return;
      nodes.push({file:file.file,text:file.text,sourceHash:digest(file.text),node,attrs,filter,id:literalId,
        tag:filter?'img':htmlName(node),offset:node.position.start,line:file.text.slice(0,node.position.start).split('\n').length});
    });}catch{/* A parse error is not a source mapping. */}
  }
  return nodes;
}
function sameTarget(n,t,page,bindings=[]) {
  if(n.tag!==t.tag.toLowerCase())return false;
  if(bindings.some(b=>b.file===n.file&&b.offset===n.offset&&b.sourceHash===n.sourceHash&&b.review?.trim()&&t.reviewedSelectors?.includes(b.selector)))return true;
  if(t.id)return t.idCount===1&&n.id===t.id;
  const src=literalAttribute(n.attrs.get('src'));
  return n.tag==='script'&&src && new URL(src,page).href===t.currentSrc;
}
function materialResize(p,t) {
  return (p.initial?.resizes??[]).find(r=>(t.id?r.id===t.id:t.selector&&r.selector===t.selector)&&r.after.height-r.before.height>=8
    &&r.before.top<t.viewport.height&&r.before.top+r.after.height>0
    &&(p.initial.shifts??[]).some(s=>!s.hadRecentInput&&s.value>=0.001&&Math.abs(s.startTime-r.at)<100));
}
const inViewport=t=>t.rect?.top<t.viewport?.height&&t.rect?.top+t.rect?.height>0&&t.rect?.width>0;
export function domainCandidates({files,snapshot,profiles=[],liquidProfile,owners=[],goal={kind:'score'}}) {
  const nodes=targetNodes(files),candidates=[];owners=validateOwners(owners);
  const hidden=files.filter(f=>f.file.endsWith('.liquid')).flatMap(f=>{try{return hiddenTargets(f.text).map(n=>({...n,file:f.file,text:f.text,sourceHash:digest(f.text)}));}catch{return [];}});
  const add=(n,p,kind,metric,data,methods,costMs=null)=>{
    if(goal.kind!=='score'&&goal.metric!==metric)return;
    const page=p.domainProof.url,device=p.kind==='runtime-profile'?p.config.device:(data.device??'mobile');
    const binding={file:n.file,offset:n.offset,sourceHash:n.sourceHash,text:n.text};
    const candidateId=digest([snapshot.hash,kind,n.file,n.offset,normalizeEvidenceUrl(page),device,metric]).slice(0,24);
    candidates.push({candidateId,kind,metric,page,device,state:'initial',file:n.file,line:n.line,costMs,eligible:true,
      source:{status:'verified-domain-source',file:n.file,line:n.line,offset:n.offset,sourceHash:n.sourceHash},
      association:'deployment-and-parser-bound',controllability:'theme-code',methods,data,
      evidence:'Deployment-bracketed observation mapped to one current parser node; independent experiment must confirm causality and preservation.',
      domainEvidence:{profile:p,binding,owners,...(p.kind==='liquid-profile'?{runtimeProfiles:profiles}:{})},binding});
  };
  for(const p of profiles) {
    if(!validDomainProfile(p,snapshot)||p.kind!=='runtime-profile')continue;
    for(const f of files) {
      try {
        if(f.file.endsWith('.liquid'))for(const n of hidden.filter(n=>n.file===f.file)) {
          if(hidden.filter(other=>other.id===n.id).length!==1)continue;
          const t=p.domainTargets?.find(t=>t.id===n.id&&t.idCount===1&&t.tag==='DETAILS'&&t.open===false&&t.bodyId===n.bodyId&&t.descendants>=200&&!t.unsafeContent);
          if(t)add({...n,file:f.file,text:f.text,sourceHash:digest(f.text)},p,'hidden-dom',goal.kind==='loading'?goal.metric:'tbt',{target:t},n.methods);
        }
        if(/^assets\/.+\.m?js$/.test(f.file))for(const n of fetchTargets(f.text))for(const r of p.resources??[]) {
          if(r.type!=='Fetch'||r.method!=='GET'||r.phase!=='initial'||r.status!==200||!r.mimeType?.includes('text/html')||r.error||r.redirected
            ||!r.initiatorSources?.some(s=>s.status==='verified-bytes'&&s.file===f.file&&s.sourceHash===digest(f.text)&&s.offset>=n.offset&&s.offset<n.end))continue;
          const duration=(r.finishedTimestamp-r.timestamp)*1000,u=new URL(r.url),page=new URL(p.config.url);
          const sections=(p.sections??[]).filter(s=>s.idCount===1&&s.containsLCP);
          if(duration>=100&&sections.length&&u.origin===page.origin&&u.pathname===page.pathname&&!u.searchParams.has('sections')&&!u.searchParams.has('section_id'))
            add({...n,file:f.file,text:f.text,sourceHash:digest(f.text)},p,'section-fetch','lcp',{resourceUrl:r.url,sections,securityPolicy:p.initial?.delivery?.securityPolicy},n.methods,duration);
        }
      }catch{/* Unsupported syntax never becomes an executable hypothesis. */}
    }
    for(const t of p.domainTargets??[]) {
      const matches=nodes.filter(n=>sameTarget(n,t,p.config.url,p.domainBindings));if(matches.length!==1)continue;
      const n=matches[0];
      // Every static identifying attribute must agree with the rendered initial element.
      if(['src','loading','fetchpriority','width','height'].some(k=>{
        const v=literalAttribute(n.attrs.get(k));return v!==null&&v!==undefined&&v!==t.attrs[k];
      }))continue;
      if(n.tag==='img'&&inViewport(t)&&(t.isLCP===true||t.id&&p.initial?.lcp?.element?.id===t.id)
        &&p.initial.lcp.url===t.currentSrc) {
        const methods=[];
        if(t.attrs.loading==='lazy')methods.push('image-eager');
        if(t.attrs.fetchpriority!=='high')methods.push('image-priority');
        if(methods.length)add(n,p,'image-lcp','lcp',{target:t},methods,p.lcp?.loadDelayMs??null);
      }
      const resize=materialResize(p,t);
      if(n.tag==='img'&&resize&&!t.inPicture&&!t.attrs.width&&!t.attrs.height&&t.naturalWidth>0&&t.naturalHeight>0)
        add(n,p,'image-cls','cls',{target:t,resize},['image-dimensions','image-aspect-ratio']);
      if(n.tag==='script'&&!Object.hasOwn(t.attrs,'defer')&&!Object.hasOwn(t.attrs,'async')&&(!t.attrs.type||['text/javascript','application/javascript'].includes(t.attrs.type))) {
        const src=literalAttribute(n.attrs.get('src'));if(!src)continue;
        const url=new URL(src,p.config.url),owner=owners.filter(o=>o.host===url.hostname&&url.pathname.startsWith(o.pathPrefix));
        const resource=p.resources?.find(r=>r.url===url.href&&r.type==='Script');
        const requestMs=resource?(resource.finishedTimestamp-resource.timestamp)*1000:null;
        const cpuMs=(p.cpu??[]).filter(r=>r.url===url.href).reduce((s,r)=>s+r.selfMs,0);
        // Removing a classic script's parser block directly targets first paint.
        // LCP may already be fetched by the speculative scanner; do not promise it.
        if(owner.length===1&&/^[a-f0-9]{64}$/.test(resource?.bodyHash??'')&&(requestMs>=100||cpuMs>=50))add(n,p,'app-loader',goal.kind==='loading'?goal.metric:'fcp',
          {target:t,owner:owner[0],resourceUrl:url.href,resourceHash:resource.bodyHash,requestMs,cpuMs},['app-defer','app-async'],Math.max(requestMs??0,cpuMs));
      }
      if(resize&&n.tag!=='img'&&n.tag!=='script'&&inViewport(t)&&!['inline','none'].includes(t.display)&&!['fixed','absolute'].includes(t.position))
        add(n,p,'app-space','cls',{target:t,resize},['app-reserve-space']);
    }
  }
  if(liquidProfile?.kind==='liquid-profile'&&validDomainProfile(liquidProfile,snapshot)) {
    const rows=analyzeLiquidProfile(liquidProfile.rawProfile,liquidProfile.sourceSnapshot).hotspots;
    for(const row of rows.filter(r=>r.file&&Number.isInteger(r.line)&&r.selfMs>=1)) {
      const f=files.find(f=>f.file===row.file);if(!f)continue;
      try {for(const n of queryTargets(f.text).filter(n=>row.line>=n.line&&row.line<=n.endLine))
        for(const device of new Set(profiles.filter(p=>validDomainProfile(p,snapshot)&&normalizeEvidenceUrl(p.config.url)===normalizeEvidenceUrl(liquidProfile.domainProof.url)).map(p=>p.config.device)))
          add({...n,file:f.file,text:f.text,sourceHash:digest(f.text)},liquidProfile,'liquid-query',goal.kind==='loading'?goal.metric:'lcp',{device,hotspot:row},n.methods,row.selfMs);
      }catch{}
      try{visitAST(liquidAST(f.text),(node,parents)=>{
        if(node.type!=='LiquidTag'||node.name!=='assign'||parents.at(-2)?.name!=='for')return;
        const line=f.text.slice(0,node.position.start).split('\n').length;if(line!==row.line)return;
        for(const device of new Set(profiles.filter(p=>validDomainProfile(p,snapshot)&&normalizeEvidenceUrl(p.config.url)===normalizeEvidenceUrl(liquidProfile.domainProof.url)).map(p=>p.config.device)))
          add({file:f.file,text:f.text,sourceHash:digest(f.text),offset:node.position.start,line},liquidProfile,'liquid-hotspot',goal.kind==='loading'?goal.metric:'lcp',
            {device,hotspot:row},['liquid-cache-loop-filter','liquid-cache-metafield'],row.selfMs);
      });}catch{}
    }
  }
  return candidates.filter(c=>!['app-loader','liquid-hotspot','liquid-query'].includes(c.kind)||['lcp','fcp','speedIndex'].includes(c.metric));
}

/** Recompute eligibility, identity and node binding instead of trusting an eligible flag. */
export function validateDomainCandidate(c,snapshot) {
  try {
    const {profile,binding,owners}=c.domainEvidence;
    snapshot={...snapshot,project:(profile.snapshot??profile.sourceSnapshot)?.project};
    if(binding.file!==c.file||digest(binding.text)!==c.source.sourceHash||binding.sourceHash!==c.source.sourceHash)return false;
    const candidates=domainCandidates({files:[{file:binding.file,text:binding.text}],snapshot,
      profiles:profile.kind==='runtime-profile'?[profile]:c.domainEvidence.runtimeProfiles??[],
      liquidProfile:profile.kind==='liquid-profile'?profile:undefined,owners,goal:{kind:'loading',metric:c.metric}});
    return candidates.some(x=>['candidateId','kind','metric','page','device','state','file','line'].every(k=>x[k]===c[k])
      &&['binding','source','data','methods'].every(k=>digest(x[k])===digest(c[k])));
  }catch{return false;}
}
