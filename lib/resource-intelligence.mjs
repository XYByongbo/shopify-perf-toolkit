import {displayUrl} from './resource-audit.mjs';
import {validDomainProfile} from './domain-profile.mjs';
const number=x=>Number.isFinite(x)&&x>=0?x:null;
export function resourceHealth(profiles=[]) {
  return profiles.map(p=>{
    const h=p.resourceHealthAfter??p.resourceHealth;
    const valid=h?.version===1&&Array.isArray(h.images);
    const images=(Array.isArray(h?.images)?h.images:[]).map(value=>{const i=value&&typeof value==='object'?value:{};return {...i,state:i.changedDuringCapture===true?'changed-during-capture':i.complete!==true?'not-triggered-or-pending':i.decoded===true&&i.naturalWidth>0&&i.naturalHeight>0?'loaded':i.decoded===false?'failed':'unverified'};});
    const backgrounds=(Array.isArray(h?.backgrounds)?h.backgrounds:[]).map(i=>({...i,state:'unverified'}));
    const failed=images.filter(i=>i.state==='failed');
    return {page:p.config?.url,device:p.config?.device,state:p.config?.state,
      status:!valid?'not-collected':failed.length?'failures-observed':h.truncated===true||h.backgroundsTruncated===true||images.some(i=>i.state!=='loaded')||backgrounds.length?'partial':'no-failure-observed',
      images,backgrounds,truncated:h?.truncated===true,backgroundsTruncated:h?.backgroundsTruncated===true,coverage:h?.coverage??'img-only',
      failures:failed.length,pending:images.filter(i=>i.state==='not-triggered-or-pending').length,scope:'captured-page-state-only'};
  });
}
/** Aggregate CPU once per raw URL; redact only after joining and counting. */
export function resourceIntelligence({profiles=[],snapshot,staticResources=[]}={}) {
  const captures=[],rejectedProfiles=[];
  for(const [profileIndex,p] of profiles.entries()) {
    if(p.kind!=='runtime-profile'||!validDomainProfile(p,snapshot)){rejectedProfiles.push(profileIndex);continue;}
    const groups=new Map();
    const requests=(p.resources??[]).map(r=>{
      let group=groups.get(r.url);
      if(!group){group={id:groups.size,url:displayUrl(r.url),references:staticResources.filter(s=>s.url===r.url).flatMap(s=>s.references??[]),
        cpuSelfMs:Array.isArray(p.cpu)?p.cpu.filter(c=>c.url===r.url&&number(c.selfMs)!==null).reduce((n,c)=>n+c.selfMs,0):null,requestCount:0};groups.set(r.url,group);}
      group.requestCount++;
      const verified=['verified-bytes','verified-ast'].includes(r.source?.status)&&snapshot.files.some(f=>f.file===r.source.file&&f.sourceHash===r.source.sourceHash);
      return {resourceGroupId:group.id,url:displayUrl(r.url),type:r.type,source:verified?r.source:null,references:group.references,
        transferBytes:number(r.transferBytes??r.encodedDataLength??r.transferSize),requestMs:number((r.finishedTimestamp-r.timestamp)*1000),
        initiator:r.initiator??null,status:r.status??null,
        next:verified?'analyze-code':group.references.length?'review-rendered-source-binding':'map-request-initiator',estimatedSavings:null};
    });
    captures.push({profileIndex,page:p.config.url,device:p.config.device,state:p.config.state,
      referenceCount:[...groups.values()].reduce((n,r)=>n+r.references.length,0),requestCount:requests.length,uniqueUrlCount:groups.size,
      requests,resourceGroups:[...groups.values()],health:resourceHealth([p])[0]});
  }
  return {version:2,captures,rejectedProfiles,scope:'per-capture-no-cross-page-sums',
    limitations:['CPU is aggregated once in resourceGroups, not on each request. Request duration is not predicted savings. Static matches require source-binding review.']};
}
