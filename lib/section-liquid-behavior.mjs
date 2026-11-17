import {compareCheckpoints} from './preservation.mjs';
import {normalizeEvidenceUrl} from './run-evidence.mjs';
import {assertionExpected} from './scenario-contract.mjs';
import {permitsBareInline} from './section-csp.mjs';

export function checkInitialLiquidBehavior(contract,run,candidate) {
  if(!contract?.update||run.resourceCaptureComplete!==true)return false;
  const {selector,update}=contract,steps=run.steps;
  const action=steps.findIndex(s=>['click','press'].includes(s.action)&&s.selector===update.triggerSelector&&s.outcome==='passed');
  const assertion=steps[action+1],before=steps[action]?.assertionBefore;
  if(action<0||!assertion?.action.startsWith('assert-')||assertion.selector!==update.assertionSelector||assertion.outcome!=='passed'
    ||before?.action!==assertion.action||before.selector!==assertion.selector
    ||JSON.stringify(before.actual)===JSON.stringify(assertionExpected(assertion))
    ||JSON.stringify(assertion.observation?.actual)!==JSON.stringify(assertionExpected(assertion)))return false;
  const initial=steps.find((s,i)=>i<action&&s.action==='checkpoint'&&s.selector===selector&&s.outcome==='passed');
  const updated=steps.find((s,i)=>i>action+1&&s.action==='checkpoint'&&s.selector===selector&&s.outcome==='passed');
  if(!initial||initial.observation?.content?.length<2||!updated)return false;
  if(candidate) {
    const life=contract.controllerLifecycle;
    if(!life||!run.initialControllers?.some(c=>c.key===life.key&&c.signature===life.signature))return false;
    if(contract.inlineController&&(!permitsBareInline(run.securityPolicy)||!Array.isArray(run.cspViolations)
      ||run.cspViolations.some(v=>v.disposition==='enforce'&&/script-src|default-src/.test(v.directive))))return false;
    if(contract.inlineController&&(run.scriptResources??[]).some(s=>new URL(s.url).pathname.endsWith('/'+contract.inlineController.file.slice('assets/'.length))))return false;
    const plain=run.serverRendered,checkpoint=plain?.checkpoints?.find(p=>p.selector===selector);
    if(plain?.javascriptEnabled!==false||plain.url!==run.finalUrl||plain.documentStatus!==200||!/^[a-f0-9]{64}$/.test(plain.documentHash??'')
      ||compareCheckpoints(initial.observation,checkpoint?.observation).outcome!=='preserved')return false;
    // Retaining any startup fetch would keep the very waterfall this method claims to remove.
    const endpoint=value=>{const u=new URL(value);u.searchParams.delete('section_id');u.searchParams.delete('sections');if(contract.legacyView&&u.searchParams.get('view')===contract.legacyView)u.searchParams.delete('view');return normalizeEvidenceUrl(u.href);};
    if((run.fetchResources??[]).some(f=>endpoint(f.url)===endpoint(contract.initialRequestUrl)&&(!Number.isInteger(f.startedStepIndex)||f.startedStepIndex<action)))return false;
  }
  const id=run.sectionScopes?.find(s=>s.selectors.includes(selector))?.id?.slice('shopify-section-'.length);
  if(!id)return false;
  const expected=new URL(update.requestUrl);
  if(candidate&&contract.legacyView&&expected.searchParams.get('view')===contract.legacyView)expected.searchParams.delete('view');
  const requests=(run.fetchResources??[]).filter(f=>f.startedStepIndex>=action&&f.startedStepIndex<=updated.index);
  const relevant=requests.filter(f=>{const u=new URL(f.url);u.searchParams.delete('section_id');u.searchParams.delete('sections');return normalizeEvidenceUrl(u.href)===normalizeEvidenceUrl(expected.href);});
  return relevant.length>0&&relevant.every(f=>{
    const u=new URL(f.url);
    return f.method==='GET'&&f.status===200&&f.finished===true&&!f.failed&&/^[a-f0-9]{64}$/.test(f.bodyHash??'')
      &&(!candidate||u.searchParams.get('section_id')===id&&f.sectionResponse?.valid===true&&f.sectionResponse.id===id);
  })&&(!candidate||requests.every(f=>{
    const u=new URL(f.url),original=new URL(update.requestUrl);u.searchParams.delete('section_id');u.searchParams.delete('sections');
    return normalizeEvidenceUrl(u.href)!==normalizeEvidenceUrl(original.href)||relevant.includes(f);
  }));
}
