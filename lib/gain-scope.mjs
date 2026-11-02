import {normalizeEvidenceUrl} from './run-evidence.mjs';

/** Gain records expose pageId, not URL. Never borrow another page's result. */
export function gainGroupForCandidate(groups,candidate,runGroup) {
  const matches=(Array.isArray(groups)?groups:[]).filter(g=>g.device===candidate.device);
  if(runGroup) {
    try{if(runGroup.device!==candidate.device||normalizeEvidenceUrl(runGroup.url)!==normalizeEvidenceUrl(candidate.page))return null;}catch{return null;}
    const scoped=matches.filter(g=>g.pageId===runGroup.pageId);
    return scoped.length===1?scoped[0]:null;
  }
  return matches.length===1?matches[0]:null;
}
