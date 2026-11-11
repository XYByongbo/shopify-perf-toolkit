import {inspectRuntimeIntegrity} from './runtime-integrity.mjs';
import {validDomainProfile} from './domain-profile.mjs';
import {normalizeEvidenceUrl} from './run-evidence.mjs';
/** Optional explicit formal gate. Legacy callers are labeled unassessed, never certified clean. */
export function checkFormalRuntimeIntegrity(evidence,left,right,groups=[]) {
  if(evidence===undefined)return {status:'not-assessed',pass:null,reason:'No integrityProfiles supplied; metric identity and duplicate loading were not assessed by this gate.'};
  const reports=[],issues=[];
  try{
    if(!evidence||!['before','after'].every(k=>Array.isArray(evidence[k])&&evidence[k].length>0&&evidence[k].length<=24)||!groups.length)throw new Error('Expected before/after profiles and a declared page/device matrix.');
    for(const [side,id]of [['before',left],['after',right]])for(const [index,p]of evidence[side].entries()){
      if(typeof p.browserVersion!=='string'||!p.browserVersion||!p.environment||typeof p.environment.cache!=='string'||id?.status!=='verified'||!validDomainProfile(p,p.snapshot)||p.snapshot.hash!==id.sourceHash||p.domainProof.before.store!==id.store||p.themeId!==id.themeId
        ||!groups.some(g=>normalizeEvidenceUrl(p.config.url)===normalizeEvidenceUrl(g.url)&&p.config.device===g.device))throw new Error(`${side}[${index}] is not bound to the measured deployment/matrix.`);
      const declared=p.config.actions??[],actual=p.actions??[];
      if(declared.length!==actual.length||declared.some((a,i)=>Object.entries(a).some(([k,v])=>JSON.stringify(actual[i][k])!==JSON.stringify(v))||actual[i].status!=='completed'||!Number.isFinite(actual[i].startedAtMs)||!Number.isFinite(actual[i].finishedAtMs)||actual[i].finishedAtMs<actual[i].startedAtMs))throw new Error('Incomplete configured action evidence.');
      const report=inspectRuntimeIntegrity(p);reports.push({side,index,...report});if(report.reviewRequired)issues.push({side,index,reason:'integrity-review-or-recapture-required'});
    }
    for(const g of groups){
      const match=p=>normalizeEvidenceUrl(p.config.url)===normalizeEvidenceUrl(g.url)&&p.config.device===g.device;
      if(!evidence.before.some(a=>match(a)&&evidence.after.some(b=>match(b)&&a.config.state===b.config.state&&JSON.stringify(a.config.actions??[])===JSON.stringify(b.config.actions??[])
        &&JSON.stringify(a.config.initializationEvents??null)===JSON.stringify(b.config.initializationEvents??null)&&JSON.stringify(a.config.expectedLcpSelectors??null)===JSON.stringify(b.config.expectedLcpSelectors??null)
        &&a.config.settleMs===b.config.settleMs&&a.config.readOnly===b.config.readOnly&&a.browserVersion===b.browserVersion&&JSON.stringify(a.environment)===JSON.stringify(b.environment)
        &&Date.parse(a.finishedAt)<=Date.parse(b.createdAt))))throw new Error('Missing comparable before/after integrity capture for a measured page/device.');
    }
  }catch(error){issues.push({reason:error.message});}
  return {status:issues.length?'not-accepted':'checked-supplied-window',pass:issues.length===0,reports,issues,scope:'Deployment-bound diagnostic guard, not Lighthouse samples or field INP; no anomaly observed is not absence of every defect.'};
}
