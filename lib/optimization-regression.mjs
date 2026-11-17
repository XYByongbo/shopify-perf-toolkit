import { sha256 } from './runtime-profile.mjs';
import { validateScenarioConfig,assertionExpected } from './scenario-contract.mjs';
import { normalizeEvidenceUrl } from './run-evidence.mjs';
import {checkInitialLiquidBehavior} from './section-liquid-behavior.mjs';
import {themePlanDeltas,themeContracts} from './theme-methods.mjs';
import {queryPatch} from './extended-methods.mjs';

export function checkScenarioDeployment(scenarios,identity,proofs) {
  try {
    if(scenarios?.kind!=='scenarios'||scenarios.sourceHash!==identity.sourceHash||scenarios.sourceStable!==true||!scenarios.runs?.length)return false;
    const times=[proofs.before.startedAt,proofs.before.finishedAt,scenarios.createdAt,scenarios.finishedAt,proofs.after.startedAt,proofs.after.finishedAt].map(Date.parse);
    if(times.some((n,i)=>!Number.isFinite(n)||i>0&&n<times[i-1]))return false;
    return [proofs.before,proofs.after].every(p=>p.kind==='deployment-proof'&&p.status==='verified'&&p.scope==='theme-text-source'
      &&p.method==='shopify-cli-source-pull-and-browser-theme-id'&&p.sourceHash===identity.sourceHash&&p.remoteSourceHash===identity.sourceHash
      &&sha256(JSON.stringify(p.sourceManifest))===identity.sourceHash&&p.store===identity.store&&p.themeId===identity.themeId&&p.project===identity.project
      &&scenarios.runs.every(r=>r.themeId===identity.themeId&&r.store===identity.store&&r.documentStable===true
        &&normalizeEvidenceUrl(r.finalUrl)===normalizeEvidenceUrl(r.url)&&r.constrained===false
        &&p.pages.some(q=>q.url===r.url&&q.status==='verified'&&q.store===identity.store&&q.themeId===identity.themeId)));
  }catch{return false;}
}

export function checkAppPlan(plan,hypothesis) {
  return plan.changes.length>0&&plan.changes.every(c=>c.evidence?.domainKind==='app-loader'
    &&c.evidence.resourceUrl===hypothesis.data.resourceUrl&&c.evidence.resourceHash===hypothesis.data.resourceHash
    &&c.evidence.domainPage===hypothesis.page&&Array.isArray(c.evidence.businessAssertions)&&c.evidence.businessAssertions.length>0);
}

/** Deployment browser captures independently bracket remote script bytes too. */
export function checkAppDeployment(plan,proofs) {
  try {
    return plan.changes.filter(c=>c.evidence?.domainKind==='app-loader').every(({evidence:e})=>
      proofs.length>0&&proofs.every(p=>p.status==='verified'&&p.pages.some(q=>normalizeEvidenceUrl(q.url)===normalizeEvidenceUrl(e.domainPage)
        &&q.assets?.some(a=>(a.url===e.resourceUrl||a.redirects?.includes(e.resourceUrl))&&a.bodyHash===e.resourceHash))));
  }catch{return false;}
}

/** A faster app loader must still fetch its script and deliver its UI response. */
export function checkAppBehavior(plan, scenarios) {
  try {
    return plan.changes.filter(c=>c.evidence?.domainKind==='app-loader').every(c=>{
      const e=c.evidence,runs=scenarios.runs.filter(r=>normalizeEvidenceUrl(r.url)===normalizeEvidenceUrl(e.domainPage));
      return runs.length>0&&/^[a-f0-9]{64}$/.test(e.resourceHash??'')&&e.businessAssertions?.length>0&&runs.every(r=>
        r.scriptResources?.some(s=>(s.url===e.resourceUrl||s.redirects?.includes(e.resourceUrl))&&s.status>=200&&s.status<300&&s.finished===true&&!s.failed&&s.bodyHash===e.resourceHash)
        &&e.businessAssertions.every(selector=>r.steps.some((s,i)=>s.selector===selector&&s.action.startsWith('assert-')&&s.outcome==='passed'
          &&['click','press'].includes(r.steps[i-1]?.action)&&r.steps[i-1].outcome==='passed'
          &&r.steps[i-1].assertionBefore?.selector===selector&&r.steps[i-1].assertionBefore.action===s.action
          &&JSON.stringify(r.steps[i-1].assertionBefore.expected)===JSON.stringify(assertionExpected(s))
          &&JSON.stringify(r.steps[i-1].assertionBefore.actual)!==JSON.stringify(assertionExpected(s))
          &&JSON.stringify(s.observation?.actual)===JSON.stringify(assertionExpected(s)))));
    });
  }catch{return false;}
}

export function checkThemeBehavior(plan,scenarios,{candidate=false}={}) {
  try {
    const deltas=themePlanDeltas(plan),entries=plan.changes.filter(c=>themeContracts[c.evidence?.domainMethod]);
    if(!entries.length)return true;
    const page=entries[0].evidence.domainPage,runs=scenarios.runs.filter(r=>normalizeEvidenceUrl(r.url)===normalizeEvidenceUrl(page));
    if(!runs.length)return false;
    return runs.every(r=>deltas.every(d=>r.steps.some(s=>s.action==='checkpoint'&&s.selector===d.selector&&s.outcome==='passed')
      &&r.initialStylesheets?.filter(s=>s.href===d.href&&s.roots.includes(d.selector)).length===(candidate?1:d.beforeCount)));
  }catch{return false;}
}

/** Validate supplied regression evidence, not merely its top-level passed flag. */
export function checkOptimizationRegression(regression, candidate, identity, expectedSourceHash) {
  try {
    const scenarios = regression?.scenarios, remote = regression?.remote;
    if (identity.status !== 'verified' || regression?.kind !== 'optimization-regression'
      || regression.sourceHash !== expectedSourceHash || scenarios?.kind !== 'scenarios'
      || scenarios.sourceHash !== expectedSourceHash || scenarios.sourceStable !== true
      || scenarios.outcome !== 'passed' || !Array.isArray(scenarios.errors) || scenarios.errors.length) return false;
    const config = validateScenarioConfig(scenarios.config);
    if (config.project !== identity.project || config.expectedThemeId !== identity.themeId) return false;
    const times = [scenarios.createdAt, scenarios.finishedAt, remote?.startedAt, remote?.finishedAt].map(Date.parse);
    if (times.some(t => !Number.isFinite(t)) || times.some((t,i) => i > 0 && t < times[i-1])) return false;
    const pages = candidate.manifest.config.pages;
    if (remote?.kind !== 'deployment-proof' || remote.status !== 'verified' || remote.scope !== 'theme-text-source'
      || remote.method !== 'shopify-cli-source-pull-and-browser-theme-id'
      || remote.project !== identity.project || remote.store !== identity.store || remote.themeId !== identity.themeId
      || remote.sourceHash !== expectedSourceHash || remote.remoteSourceHash !== expectedSourceHash
      || !Array.isArray(remote.sourceManifest) || sha256(JSON.stringify(remote.sourceManifest)) !== expectedSourceHash
      || !Array.isArray(remote.pages) || remote.pages.length !== pages.length
      || pages.some(p => !remote.pages.some(q => q.id === p.id && q.url === p.url && q.status === 'verified'
        && q.themeId === identity.themeId && q.store === identity.store))) return false;
    const runs = scenarios.runs;
    if (!Array.isArray(runs) || runs.length !== config.scenarios.length * config.viewports.length) return false;
    for (const scenario of config.scenarios) for (const viewport of config.viewports) {
      const matches = runs.filter(r => r.name === scenario.name && r.url === scenario.url && r.viewport?.name === viewport.name);
      if (matches.length !== 1) return false;
      const r = matches[0];
      const finalUrl = new URL(r.finalUrl), requestedUrl = new URL(r.url);
      if (r.outcome !== 'passed' || r.constrained !== false || r.themeId !== identity.themeId || r.store !== identity.store
        || finalUrl.origin !== requestedUrl.origin || finalUrl.pathname !== requestedUrl.pathname || r.documentStable !== true
        || ['blockedRequests','pageErrors','errors','artifactErrors'].some(k => !Array.isArray(r[k]) || r[k].length)
        || ['width','height','dpr'].some(k => r.viewport[k] !== viewport[k])
        || !Array.isArray(r.steps) || r.steps.length !== scenario.steps.length) return false;
      for (const [i, step] of scenario.steps.entries()) {
        const actual = r.steps[i];
        if (actual.outcome !== 'passed' || !Number.isFinite(actual.elapsedMs) || actual.elapsedMs < 0
          || Object.entries(step).some(([k,v]) => JSON.stringify(actual[k]) !== JSON.stringify(v))) return false;
      }
    }
    return candidate.groups.every(g => runs.some(r => r.url === g.url && r.viewport.name === g.device
      && r.steps.some(s => s.action.startsWith('assert-') && s.outcome === 'passed')));
  } catch { return false; }
}

/** Reconstruct required behavior from the measured candidate, not arbitrary plan flags. */
export function checkExtendedPlan(plan,hypothesis) {
  const kinds=['hidden-dom','liquid-query','section-fetch'];
  if(!kinds.includes(hypothesis.kind))return true;
  try {
    const method=plan.changes[0]?.evidence?.domainMethod;
    return hypothesis.methods.includes(method)&&plan.changes.length>0&&plan.changes.every(c=>{
      const e=c.evidence;
      if(e.domainKind!==hypothesis.kind||e.domainMethod!==method||e.domainPage!==hypothesis.page)return false;
      if(hypothesis.kind==='liquid-query') {
        const deps=hypothesis.domainEvidence?.dependencyFiles??[];
        return plan.changes.length===1&&c.target===hypothesis.file&&e.queryContract?.selector==='body'
          &&JSON.stringify(e.queryContract.dependencies??[])===JSON.stringify(deps.map(({file,sourceHash})=>({file,sourceHash})))
          &&deps.every(f=>plan.metadata?.readOnlyDependencies?.some(d=>d.file===f.file&&d.sourceHash===f.sourceHash))
          &&queryPatch(c.before,hypothesis.binding.offset,method,{files:deps})===c.after
          &&JSON.stringify(e.paginationPagesRequired)===JSON.stringify(method==='query-paginate'?[1,2]:[]);
      }
      if(hypothesis.kind==='hidden-dom')return e.hiddenContract?.summarySelector==='#'+hypothesis.data.target.id+' > summary'&&e.hiddenContract.bodySelector==='#'+hypothesis.data.target.bodyId;
      return e.sectionFetchContract?.requestUrl===hypothesis.data.resourceUrl&&hypothesis.data.sections.some(s=>s.selectors.includes(e.sectionFetchContract.sectionSelector))
        &&(!method.startsWith('section-liquid-')||plan.changes.length===2&&e.initialLiquidContract?.selector===e.sectionFetchContract.sectionSelector
          &&e.initialLiquidContract.initialRequestUrl===hypothesis.data.resourceUrl
          &&(method!=='section-liquid-inline'||e.initialLiquidContract.inlineController?.bytes<=4096));
    });
  }catch{return false;}
}

/** Domain-specific behavior cannot be replaced by an unrelated button assertion. */
export function checkExtendedBehavior(plan,scenarios,{candidate=false}={}) {
  try {
    const contracts=plan.changes.filter(c=>['hidden-dom','liquid-query','section-fetch'].includes(c.evidence?.domainKind)).map(c=>c.evidence);
    return contracts.every(e=>{
      const runs=scenarios.runs.filter(r=>normalizeEvidenceUrl(r.url)===normalizeEvidenceUrl(e.domainPage));
      if(!runs.length)return false;
      if(e.domainKind==='hidden-dom') {
        const {summarySelector,bodySelector}=e.hiddenContract??{};if(!summarySelector||!bodySelector)return false;
        return runs.every(r=>{
          if(candidate&&e.domainMethod==='hidden-detach') {
            const m=e.hiddenContract.mechanism,initial=r.initialDisclosures?.filter(x=>x.id===summarySelector.slice(1).split(' > ')[0]&&'#'+x.bodyId===bodySelector);
            if(m?.kind!=='dom-parking'||initial?.length!==1||initial[0].descendants!==0||!initial[0].controllers?.includes(m.key)
              ||(r.cspViolations??[]).some(v=>v.disposition==='enforce'&&v.blockedURI==='inline'))return false;
          }
          const toggles=r.steps.flatMap((s,i)=>{
            const next=r.steps[i+1],before=s.assertionBefore;
            return s.selector===summarySelector&&['click','press'].includes(s.action)&&s.outcome==='passed'
              &&(s.action==='click'||['Enter',' '].includes(s.key))&&next?.action==='assert-visible'&&next.selector===bodySelector&&next.outcome==='passed'
              &&before?.selector===bodySelector&&before.action==='assert-visible'&&before.actual===!next.visible
              &&before.expected===next.visible&&next.observation?.actual===next.visible?[{step:s,index:i,visible:next.visible}]:[];
          });
          return toggles.length>=3&&toggles.slice(0,3).every((x,i)=>x.visible===(i!==1))&&toggles.some(x=>x.step.action==='press')
            &&r.steps.some((s,i)=>i>toggles[0].index&&i<toggles[1].index&&s.action==='checkpoint'&&s.selector===bodySelector&&s.outcome==='passed'&&s.observation?.content?.length>1)
            &&r.steps.some((s,i)=>i>toggles[2].index&&s.action==='checkpoint'&&s.selector===bodySelector&&s.outcome==='passed'&&s.observation?.content?.length>1);
        });
      }
      if(e.domainKind==='liquid-query') {
        if(e.queryContract?.selector!=='body')return false;
        const checkpoint=r=>r.steps.some(s=>s.action==='checkpoint'&&s.selector==='body'&&s.outcome==='passed'&&s.observation?.content?.length>1);
        if(!runs.every(checkpoint))return false;
        if(!e.paginationPagesRequired?.length)return true;
        const base=new URL(e.domainPage);base.searchParams.delete('page');base.searchParams.delete('preview_theme_id');
        // Every measured viewport needs both pages; a page-2 header or desktop-only sample is insufficient.
        return runs.every(original=>e.paginationPagesRequired.every(page=>scenarios.runs.some(r=>{
          const u=new URL(r.url),n=Number(u.searchParams.get('page')??1);u.searchParams.delete('page');u.searchParams.delete('preview_theme_id');
          return n===page&&u.href===base.href&&r.viewport?.name===original.viewport?.name&&checkpoint(r);
        })));
      }
      if(e.domainKind==='section-fetch') {
        const contract=e.sectionFetchContract;if(!contract)return false;
        if(e.domainMethod?.startsWith('section-liquid-'))return runs.every(r=>checkInitialLiquidBehavior(e.initialLiquidContract,r,candidate));
        return runs.every(r=>{
          if(!r.steps.some(s=>s.action==='checkpoint'&&s.selector===contract.sectionSelector&&s.outcome==='passed'))return false;
          const id=r.sectionScopes?.find(s=>s.selectors.includes(contract.sectionSelector))?.id?.slice('shopify-section-'.length);
          if(!id)return false;
          const relevant=(r.fetchResources??[]).filter(f=>{
            const u=new URL(f.url);u.searchParams.delete('section_id');u.searchParams.delete('sections');
            return normalizeEvidenceUrl(u.href)===normalizeEvidenceUrl(contract.requestUrl);
          });
          // An invalid scoped response followed by a full-page fallback is functional, but cannot prove this optimization.
          return relevant.length>0&&relevant.every(f=>{
            const u=new URL(f.url),scoped=u.searchParams.get('section_id')===id||u.searchParams.get('sections')===id;
            return (!candidate||scoped&&f.sectionResponse?.valid===true&&f.sectionResponse.id===id)&&f.status===200&&f.finished===true&&!f.failed&&/^[a-f0-9]{64}$/.test(f.bodyHash??'');
          });
        });
      }
      return true;
    });
  }catch{return false;}
}
