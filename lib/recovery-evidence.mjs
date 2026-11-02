import {digest} from './evidence-contract.mjs';
import {normalizeEvidenceUrl} from './run-evidence.mjs';

export function captureSelectors(request) {
  const selectors=request.profile?.targetSelectors??[],bindings=request.bindings??[];
  if(!Array.isArray(selectors)||!Array.isArray(bindings)||selectors.some(s=>typeof s!=='string'||!s.trim()))throw new Error('Capture selectors and bindings must be arrays of declared targets.');
  const all=[...new Set([...selectors,...bindings.map(b=>b.selector)])].sort();
  if(all.length>50)throw new Error('Capture supports at most 50 distinct target selectors.');
  return all;
}
const context = (url,profile={}) => ({page:normalizeEvidenceUrl(url),device:profile.device??'mobile',state:profile.state??'initial',actions:profile.actions??[],readOnly:profile.readOnly??true});
const contains = (actual,required) => required.every(v=>actual.some(a=>digest(a)===digest(v)));

/** An explicit recapture cannot quietly discard previously declared states or server evidence. */
export function assertRecoveryCaptureCoverage(inputs,requests) {
  for(const p of inputs.profiles??[]) {
    const expected=context(p.config.url,p.config);
    if(!requests.some(r=>r.mode==='runtime'&&digest(context(r.url,r.profile))===digest(expected)
      &&(r.profile?.settleMs??1500)>=(p.config.settleMs??1500)
      &&contains(captureSelectors(r),captureSelectors({profile:p.config,bindings:p.domainBindings}))
      &&contains(r.profile?.hashResourceUrls??[],p.config.hashResourceUrls??[])
      &&contains(r.bindings??[],p.domainBindings??[])))throw new Error('Fresh evidence must retain every declared runtime state, action, selector and binding.');
  }
  const liquid=inputs.liquidProfile;
  if(liquid&&!requests.some(r=>r.mode==='liquid'&&normalizeEvidenceUrl(r.url)===normalizeEvidenceUrl(liquid.domainProof?.url??new URL(liquid.evidence.urlPath,r.url).href)
    &&contains(r.bindings??[],liquid.domainBindings??[])))throw new Error('Fresh evidence must retain the declared Liquid context.');
}

/** Verify the executed capture contract, not just its page/device and top-level status. */
export function matchesRecoveryCapture(profile,request) {
  if(digest(profile.domainBindings??[])!==digest(request.bindings??[]))return false;
  if(request.mode!=='runtime')return true;
  if(profile.errors?.length||profile.blockedRequests?.length||profile.trace?.truncated===true)return false;
  if(digest(context(profile.config.url,profile.config))!==digest(context(request.url,request.profile))
    ||(profile.config.settleMs??1500)!==(request.profile?.settleMs??1500)
    ||digest([...(profile.config.targetSelectors??[])].sort())!==digest(captureSelectors(request))
    ||digest(profile.config.hashResourceUrls??[])!==digest(request.profile?.hashResourceUrls??[]))return false;
  const actions=request.profile?.actions??[],executed=profile.actions??[];
  return actions.length===executed.length&&actions.every((action,i)=>{
    const actual=executed[i];return actual.status==='completed'&&Object.entries(action).every(([k,v])=>Object.hasOwn(actual,k)&&digest(actual[k])===digest(v))
      &&Number.isFinite(actual.startedAtMs)&&Number.isFinite(actual.finishedAtMs)&&actual.startedAtMs<=actual.finishedAtMs
      &&(!i||actual.startedAtMs>=executed[i-1].finishedAtMs);
  });
}
