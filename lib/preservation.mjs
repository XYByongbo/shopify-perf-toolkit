import {rehostContract} from './resource-equivalence.mjs';
import {upgradeTransform} from './upgrade-strategies.mjs';
import { normalizeEvidenceUrl } from './run-evidence.mjs';
import { sha256 } from './runtime-profile.mjs';
import {themePlanDeltas} from './theme-methods.mjs';

export const preservationStyles = ['display','position','color','background-color','font-family','font-size','font-weight','line-height','letter-spacing','text-align','visibility','opacity','overflow','transform','border-radius'];

/** Runs in the browser. No downloaded media or screenshots; inspect the rendered DOM. */
export function checkpointDOM(root, styles) {
  const nodes = [root,...root.querySelectorAll('*')].filter(el => !el.closest('script,style,template,noscript'));
  if (nodes.length > 5000) throw new Error('Checkpoint exceeds 5000 elements; select a narrower component.');
  const content = [], layout = [];
  const normalized = text => text.replace(/\s+/g,' ').trim();
  for (const el of nodes) {
    const rect = el.getBoundingClientRect(), css = getComputedStyle(el);
    const attrs = [...el.attributes].filter(a => /^(id|class|href|rel|media|crossorigin|integrity|disabled|nonce|src|srcset|sizes|alt|title|name|type|value|action|method|role|aria-.+|data-.+)$/.test(a.name)).map(a => [a.name,a.value]).sort((a,b) => a[0].localeCompare(b[0]));
    content.push({ tag: el.tagName, attrs, text: [...el.childNodes].filter(n => n.nodeType === 3).map(n => normalized(n.textContent)).filter(Boolean),
      value: /^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName) ? el.value : null,
      checked: el instanceof HTMLInputElement ? el.checked : null });
    layout.push({ rect: [rect.x,rect.y,rect.width,rect.height], styles: Object.fromEntries(styles.map(k => [k,css.getPropertyValue(k)])) });
  }
  return { version: 1, content, layout };
}

export function compareCheckpoints(a, b, tolerance = 0.5) {
  if (!Number.isFinite(tolerance) || tolerance < 0 || tolerance > 0.5) throw new Error('Layout tolerance must be between 0 and 0.5 CSS pixels.');
  if (a?.version !== 1 || b?.version !== 1 || !Array.isArray(a.content) || !Array.isArray(b.content) || !a.content.length
    || !Array.isArray(a.layout) || !Array.isArray(b.layout) || a.layout.length !== a.content.length || b.layout.length !== b.content.length) return { outcome: 'invalid-evidence', reason: 'Missing DOM checkpoint.' };
  const changes = [];
  if (JSON.stringify(a.content) !== JSON.stringify(b.content)) changes.push('content-or-data');
  if (a.layout.length !== b.layout.length) changes.push('element-count');
  else for (let i=0;i<a.layout.length;i++) {
    const x=a.layout[i], y=b.layout[i];
    if (!Array.isArray(x.rect) || !Array.isArray(y.rect) || x.rect.length !== 4 || y.rect.length !== 4 || !x.rect.every(Number.isFinite) || !y.rect.every(Number.isFinite)
      || !x.styles || !y.styles || preservationStyles.some(k => typeof x.styles[k] !== 'string' || typeof y.styles[k] !== 'string')) return { outcome: 'invalid-evidence', reason: 'Incomplete geometry or computed-style evidence.' };
    if (x.rect.some((n,j) => Math.abs(n-y.rect[j]) > tolerance)) changes.push(`layout:${i}`);
    if (JSON.stringify(x.styles) !== JSON.stringify(y.styles)) changes.push(`style:${i}`);
  }
  return { outcome: changes.length ? 'regressed' : 'preserved', changes: changes.slice(0,30), changeCount: changes.length, elements: a.content.length };
}

/** Requires matching actions and checkpoints, not self-asserted contentPreserved booleans. */
export function verifyPreservation({ before, after, beforeSourceHash, afterSourceHash, plan } = {}) {
  const result = { schemaVersion: 1, kind: 'preservation-verification', outcome: 'invalid-evidence', checks: [], beforeSourceHash, afterSourceHash,
    limitations: ['Checks declared DOM/content/geometry/styles and interaction assertions; not exhaustive pixel or business-event equivalence.', 'Blocked write requests cannot establish cart, analytics or checkout acceptance.'] };
  if (!/^[a-f0-9]{64}$/.test(beforeSourceHash ?? '') || !/^[a-f0-9]{64}$/.test(afterSourceHash ?? '') || before?.sourceHash !== beforeSourceHash || after?.sourceHash !== afterSourceHash
      || before?.sourceStable !== true || after?.sourceStable !== true || before?.kind !== 'scenarios' || after?.kind !== 'scenarios'
      || before.outcome !== 'passed' || after.outcome !== 'passed' || !before.runs?.length || before.runs.length !== after.runs?.length
      || JSON.stringify(before.environment) !== JSON.stringify(after.environment)) { result.reason = 'Source identity, environment or successful unconstrained regression runs are missing.'; return result; }
  const key = r => JSON.stringify([r.name,normalizeEvidenceUrl(r.url),r.viewport]);
  let deltas;try{deltas=themePlanDeltas(plan);}catch(error){result.reason=error.message;return result;}
  const other = new Map(after.runs.map(r => [key(r),r]));
  if (other.size !== after.runs.length || new Set(before.runs.map(key)).size !== before.runs.length) return result;
  for (const a of before.runs) {
    const b = other.get(key(a));
    if (!b || [a,b].some(r => r.outcome !== 'passed' || r.constrained || r.blockedRequests?.length || r.pageErrors?.length || !r.steps?.some(s => s.action.startsWith('assert-') && s.outcome === 'passed'))) return result;
    const actions = r => r.steps.map(({ observation, assertionBefore, elapsedMs, outcome, ...spec }) => spec);
    if (JSON.stringify(actions(a)) !== JSON.stringify(actions(b)) || a.steps.some(s => s.outcome !== 'passed') || b.steps.some(s => s.outcome !== 'passed')) return result;
    // Compare observable click-to-assert response, not just the eventual screenshot.
    // A single pair is a review guard, not an INP/causality claim; retain both timings.
    for (let i=0;i<a.steps.length-1;i++) if (['click','press'].includes(a.steps[i].action) && a.steps[i+1].action.startsWith('assert-')) {
      // A visible shell is not a ready component. Include consecutive assertions
      // (e.g. visible + complete child count) so deferred hydration cannot hide its delay.
      let end=i+1;while(a.steps[end+1]?.action.startsWith('assert-'))end++;
      const left=a.steps.slice(i,end+1).map(s=>s.elapsedMs),right=b.steps.slice(i,end+1).map(s=>s.elapsedMs),values=[...left,...right];
      if(values.some(v=>!Number.isFinite(v)||v<0)) { result.reason='Missing click/press-to-assert timing evidence.'; return result; }
      const beforeMs=left.reduce((a,b)=>a+b,0), afterMs=right.reduce((a,b)=>a+b,0), toleranceMs=Math.max(150,beforeMs);
      result.checks.push({run:a.name,url:a.url,device:a.viewport.name,key:`interaction-${i}`,kind:'interaction-response',beforeMs,afterMs,toleranceMs,
        outcome:afterMs-beforeMs>toleranceMs?'invalid-evidence':'preserved',reason:afterMs-beforeMs>toleranceMs?'Interaction response slowed; repeat focused timing before accepting.':undefined});
    }
    const points = a.steps.filter(s => s.action === 'checkpoint');
    if (!points.length) { result.reason = 'Each scenario requires at least one explicit checkpoint.'; return result; }
    for (const point of points) {
      const candidate = b.steps.find(s => s.index === point.index);
      let original=point.observation;
      try {
        for(const delta of deltas.filter(d=>d.selector===point.selector))original=stylesheetNodeDelta(original,candidate?.observation,delta,a.url);
      }catch(error){result.reason=error.message;return result;}
      try{original=resourceUrlDelta(original,candidate?.observation,plan);}catch(error){result.reason=error.message;return result;}
      const comparison = compareCheckpoints(original,candidate?.observation);
      result.checks.push({ run: a.name, url: a.url, device: a.viewport.name, key: point.key, ...comparison });
    }
  }
  result.evidenceHash = sha256(JSON.stringify([before,after]));
  result.outcome = result.checks.some(c => c.outcome === 'invalid-evidence') ? 'invalid-evidence' : result.checks.every(c => c.outcome === 'preserved') ? 'preserved' : 'regressed';
  if (result.outcome==='invalid-evidence') result.reason=result.checks.find(c=>c.outcome==='invalid-evidence')?.reason ?? 'Incomplete comparable checkpoint evidence.';
  return result;
}

function stylesheetNodeDelta(before,after,delta,page) {
  const indices=p=>(p?.content??[]).flatMap((n,i)=>{const a=Object.fromEntries(n.attrs??[]);
    try{return n.tag==='LINK'&&a.rel?.toLowerCase()==='stylesheet'&&new URL(a.href,page).href===delta.href?[i]:[];}catch{return [];}});
  const a=indices(before),b=indices(after);
  if(a.length<=1&&a.length===b.length)return before;
  if(a.length<2||b.length!==1||a.some(i=>JSON.stringify(before.content[i])!==JSON.stringify(before.content[a[0]]))
    ||JSON.stringify(after.content[b[0]])!==JSON.stringify(before.content[a[0]]))throw new Error('Unexpected stylesheet-node delta.');
  const remove=new Set(a.slice(1));
  return {...before,content:before.content.filter((_,i)=>!remove.has(i)),layout:before.layout.filter((_,i)=>!remove.has(i))};
}

function resourceUrlDelta(before,after,plan) {
  let result=before;
  for(const c of plan?.changes??[])if(c.recipeKind==='liquid-rehost-resource') {
    if(upgradeTransform(c.before,c.target,c.recipeKind,c.parameters).after!==c.after)throw new Error('Unreplayable resource replacement.');
    const r=rehostContract(c),content=structuredClone(result.content);
    for(let i=0;i<content.length;i++) {
      const a=content[i],b=after?.content?.[i];if(!b||a.tag!==r.tag.toUpperCase()||a.tag!==b.tag||Object.fromEntries(a.attrs).id!==r.id||Object.fromEntries(b.attrs).id!==r.id)continue;
      for(const attr of a.attrs)if(attr[0]===r.attribute&&attr[1]===r.oldUrl&&b.attrs.some(x=>x[0]===attr[0]&&x[1]===r.newUrl))attr[1]=r.newUrl;
    }
    result={...result,content};
  }
  return result;
}
