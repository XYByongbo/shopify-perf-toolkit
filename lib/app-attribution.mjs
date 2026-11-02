import { fields } from './evidence-contract.mjs';
import { displayUrl } from './resource-audit.mjs';

export function validateOwners(owners=[]) {
  if(!Array.isArray(owners)||owners.length>500)throw new Error('owners must be an array of at most 500 reviewed mappings.');
  return owners.map(o=>{
    fields(o,['id','name','host','pathPrefix','purpose','evidence'],'owner');
    if(!/^[\w-]{1,80}$/.test(o.id)||typeof o.name!=='string'||!o.name.trim()||!/^([a-z0-9-]+\.)+[a-z0-9-]+$/.test(o.host??'')
       ||typeof o.pathPrefix!=='string'||!o.pathPrefix.startsWith('/')||/[?#]/.test(o.pathPrefix)||!o.purpose?.trim()||!o.evidence?.trim())throw new Error('An owner needs id, name, exact host, pathPrefix, purpose and review evidence.');
    return o;
  });
}

/** Infer potential app boundaries from resource request patterns without explicit owner mappings. */
function inferAppBoundaries(resources) {
  const hostGroups = new Map(); // host -> { paths: Set, count: number, totalMs: number, types: Set }
  for (const r of resources) {
    try {
      const url = new URL(r.url);
      const host = url.hostname;
      if (!hostGroups.has(host)) hostGroups.set(host, { paths: new Set(), count: 0, totalMs: 0, types: new Set(), samples: [] });
      const group = hostGroups.get(host);
      group.paths.add(url.pathname);
      group.count++;
      group.types.add(r.initiatorType ?? 'unknown');
      if (Number.isFinite(r.requestMs)) group.totalMs += r.requestMs;
      group.samples.push({ url: r.url, path: url.pathname, requestMs: r.requestMs, type: r.initiatorType });
    } catch {}
  }
  const inferred = [];
  for (const [host, group] of hostGroups) {
    // Skip same-origin and known CDN hosts
    if (host === 'cdn.shopify.com' || host === 'monorail-edge.shopifysvc.com') continue;
    // Heuristic: hosts with multiple distinct paths and consistent request patterns are likely apps
    if (group.paths.size >= 2 && group.count >= 3) {
      const commonPrefix = findCommonPrefix([...group.paths]);
      inferred.push({
        host,
        inferredPathPrefix: commonPrefix,
        requestCount: group.count,
        distinctPaths: group.paths.size,
        totalRequestMs: Math.round(group.totalMs),
        resourceTypes: [...group.types],
        confidence: group.paths.size >= 5 ? 'high' : group.paths.size >= 3 ? 'medium' : 'low',
        note: 'Automatically inferred from request patterns; requires manual review to confirm app identity.'
      });
    }
  }
  return inferred.sort((a, b) => b.requestCount - a.requestCount);
}

function findCommonPrefix(paths) {
  if (!paths.length) return '/';
  const sorted = [...paths].sort();
  const first = sorted[0], last = sorted.at(-1);
  let i = 0;
  while (i < first.length && first[i] === last[i]) i++;
  return first.slice(0, i) || '/';
}

export function attributeApps({profiles=[],owners=[]}={}) {
  owners=validateOwners(owners);const resources=[],cpu=[],groups=new Map();
  const ownerOf=url=>{try {const u=new URL(url);const matches=owners.filter(o=>u.hostname===o.host&&u.pathname.startsWith(o.pathPrefix));
    return matches.length===1?{status:'reviewed-mapping',ownerId:matches[0].id,name:matches[0].name,purpose:matches[0].purpose,evidence:matches[0].evidence}
      :{status:matches.length?'ambiguous':'unknown',ownerId:null};}catch{return {status:'unknown',ownerId:null};}};
  for(const [profileIndex,p] of profiles.entries()){
    const scope={profileIndex,url:displayUrl(p.config?.url),device:p.config?.device,state:p.config?.state};
    for(const r of p.resources??[]) {
      let sameOrigin=false;try{sameOrigin=new URL(r.url).origin===new URL(p.config?.url).origin;}catch{}
      const owner=ownerOf(r.url),role=owner.status==='reviewed-mapping'?'reviewed-app':/^assets\//.test(r.source?.file??'')&&['verified-bytes','verified-ast'].includes(r.source?.status)?'theme-code':sameOrigin?'same-origin-unreviewed':'external-unreviewed';
      resources.push({...scope,pageUrl:scope.url,url:displayUrl(r.url),owner,role,requestMs:Number.isFinite(r.finishedTimestamp)&&Number.isFinite(r.timestamp)?(r.finishedTimestamp-r.timestamp)*1000:null,
        source:r.source??null,initiatorType:r.initiator?.type??null,initiator:r.initiator??null});
    }
    for(const [phase,rows] of [['navigation',p.cpu??[]],['interaction',p.interactionCpu??[]]])for(const r of rows){
      if(!Number.isFinite(r.selfMs)||r.selfMs<0)continue;
      const owner=ownerOf(r.url),entry={...scope,url:displayUrl(r.url),owner,phase,function:r.functionName,selfMs:r.selfMs,source:r.source??null};cpu.push(entry);
      const key=JSON.stringify([profileIndex,phase,owner.ownerId??entry.url]);const group=groups.get(key)??{...scope,phase,owner,selfMs:0,resource:owner.ownerId?null:entry.url};group.selfMs+=r.selfMs;groups.set(key,group);
    }
  }
  // Infer app boundaries from resource patterns for hosts without explicit owner mappings
  const unmappedResources = resources.filter(r => r.role==='external-unreviewed');
  const inferredBoundaries = inferAppBoundaries(unmappedResources);
  return {schemaVersion:1,kind:'app-attribution',resources,cpu,groups:[...groups.values()],unknownResources:resources.filter(r=>r.owner.status!=='reviewed-mapping').length,
    inferredBoundaries,themeResources:resources.filter(r=>r.role==='theme-code').length,sameOriginUnreviewed:resources.filter(r=>r.role==='same-origin-unreviewed').length,
    limitations:['Ownership requires an explicit reviewed host/path mapping. CDN host or filename alone never proves an app identity.',
      'Inferred boundaries are heuristic suggestions from request patterns; they require manual review before use.',
      'CPU self time is grouped within one capture and phase only; request durations overlap and are not summed into savings.',
      'This report never removes apps, defers consent/analytics, or establishes business-event correctness.']};
}
