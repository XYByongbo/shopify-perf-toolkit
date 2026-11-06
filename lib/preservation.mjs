import {rehostContract} from './resource-equivalence.mjs';
import {upgradeTransform} from './upgrade-strategies.mjs';
import { normalizeEvidenceUrl } from './run-evidence.mjs';
import { sha256 } from './runtime-profile.mjs';
import {themePlanDeltas} from './theme-methods.mjs';

export const preservationStyles = ['display','position','color','background-color','font-family','font-size','font-weight','line-height','letter-spacing','text-align','visibility','opacity','overflow','transform','border-radius'];

/** Runs in the browser. No downloaded media or screenshots; inspect the rendered DOM. */
export function checkpointDOM(root, styles) {
  if (root?.nodeType !== 1 || !root.isConnected || !root.ownerDocument?.defaultView || root.closest('script,style,template,noscript')) throw new Error('Checkpoint needs one connected live component root.');
  if (!Array.isArray(styles) || !styles.length || styles.some(k => typeof k !== 'string' || !k.trim()) || new Set(styles).size !== styles.length) throw new Error('Checkpoint needs unique computed-style properties.');
  const win = root.ownerDocument.defaultView;
  const nodes = [root,...root.querySelectorAll('*')].filter(el => !el.closest('script,style,template,noscript'));
  if (nodes.length > 5000) throw new Error('Checkpoint exceeds 5000 elements; select a narrower component.');
  const content = [], layout = [];
  const normalized = text => text.replace(/\s+/g,' ').trim();
  for (const el of nodes) {
    const rect = el.getBoundingClientRect(), css = win.getComputedStyle(el);
    const attrs = [...el.attributes].filter(a => /^(id|class|href|rel|media|crossorigin|integrity|disabled|nonce|src|srcset|sizes|alt|title|name|type|value|action|method|role|hidden|inert|open|readonly|required|multiple|min|max|step|pattern|maxlength|minlength|checked|selected|tabindex|aria-.+|data-.+)$/.test(a.name)).map(a => [a.name,a.value]).sort((a,b) => a[0].localeCompare(b[0]));
    const properties = {};
    for (const key of ['indeterminate','disabled','readOnly','required','multiple','selected','open','hidden','inert']) properties[key] = typeof el[key] === 'boolean' ? el[key] : null;
    for (const key of ['min','max','step','pattern']) properties[key] = typeof el[key] === 'string' ? el[key] : null;
    properties.effectivelyDisabled = /^(BUTTON|INPUT|SELECT|TEXTAREA|OPTION|OPTGROUP|FIELDSET)$/.test(el.tagName) ? el.matches(':disabled') : null;
    properties.selectedOptions = el.tagName === 'SELECT' ? [...el.options].flatMap((option,index) => option.selected ? [{index,value:option.value}] : []) : null;
    properties.scroll = [el.scrollLeft,el.scrollTop];
    content.push({ tag: el.tagName, attrs, text: [...el.childNodes].filter(n => n.nodeType === 3).map(n => normalized(n.textContent)).filter(Boolean),
      value: /^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName) ? el.value : null,
      checked: el.tagName === 'INPUT' ? el.checked : null, properties });
    layout.push({ rect: [rect.x,rect.y,rect.width,rect.height], styles: Object.fromEntries(styles.map(k => [k,css.getPropertyValue(k)])) });
  }
  return { version: 2, content, layout, focusIndex: nodes.indexOf(root.ownerDocument.activeElement),
    environment: { viewport: [win.innerWidth,win.innerHeight,win.devicePixelRatio], scroll: [win.scrollX,win.scrollY] } };
}

function completeState(point) {
  const finite = (v,n) => Array.isArray(v) && v.length === n && v.every(Number.isFinite);
  return Number.isInteger(point.focusIndex) && point.focusIndex >= -1 && point.focusIndex < point.content.length
    && finite(point.environment?.viewport,3) && point.environment.viewport.every(v => v > 0) && finite(point.environment?.scroll,2)
    && point.content.every(node => {
      const p = node?.properties;
      const controls=/^(BUTTON|INPUT|SELECT|TEXTAREA|OPTION|OPTGROUP|FIELDSET)$/.test(node?.tag);
      const applicable={indeterminate:node?.tag==='INPUT',disabled:controls,effectivelyDisabled:controls,
        readOnly:/^(INPUT|TEXTAREA)$/.test(node?.tag),required:/^(INPUT|SELECT|TEXTAREA)$/.test(node?.tag),
        multiple:/^(INPUT|SELECT)$/.test(node?.tag),selected:node?.tag==='OPTION',open:/^(DETAILS|DIALOG)$/.test(node?.tag)};
      return typeof node?.tag === 'string' && Array.isArray(node.attrs) && node.attrs.every(pair => Array.isArray(pair) && pair.length === 2 && pair.every(v => typeof v === 'string'))
        && Array.isArray(node.text) && node.text.every(v => typeof v === 'string') && (node.value === null || typeof node.value === 'string') && (node.checked === null || typeof node.checked === 'boolean')
        && p && ['indeterminate','disabled','readOnly','required','multiple','selected','open','hidden','inert','effectivelyDisabled'].every(k => p[k] === null || typeof p[k] === 'boolean')
        && Object.entries(applicable).every(([key,needed])=>!needed||typeof p[key]==='boolean')
        && (/^(INPUT|SELECT|TEXTAREA)$/.test(node.tag)?typeof node.value==='string':node.value===null)
        && (node.tag==='INPUT'?typeof node.checked==='boolean':node.checked===null)
        && ['min','max','step','pattern'].every(k => p[k] === null || typeof p[k] === 'string') && finite(p.scroll,2)
        && ['min','max','step','pattern'].every(k=>node.tag!=='INPUT'||typeof p[k]==='string')
        && (node.tag==='SELECT'?Array.isArray(p.selectedOptions):p.selectedOptions===null)
        && (p.selectedOptions === null || Array.isArray(p.selectedOptions) && p.selectedOptions.every((o,i,list) => o && Number.isInteger(o.index) && o.index >= 0 && typeof o.value === 'string' && (!i || o.index > list[i-1].index)));
    });
}

export function compareCheckpoints(a, b, tolerance = 0.5) {
  if (!Number.isFinite(tolerance) || tolerance < 0 || tolerance > 0.5) throw new Error('Layout tolerance must be between 0 and 0.5 CSS pixels.');
  if (![1,2].includes(a?.version) || a.version !== b?.version || !Array.isArray(a.content) || !Array.isArray(b.content) || !a.content.length || !b.content.length
    || !Array.isArray(a.layout) || !Array.isArray(b.layout) || a.layout.length !== a.content.length || b.layout.length !== b.content.length) return { outcome: 'invalid-evidence', reason: 'Missing DOM checkpoint.' };
  if (a.version === 2 && (!completeState(a) || !completeState(b))) return { outcome: 'invalid-evidence', reason: 'Incomplete runtime form, focus or environment evidence.' };
  if (a.version === 2 && JSON.stringify(a.environment) !== JSON.stringify(b.environment)) return { outcome: 'invalid-evidence', reason: 'Checkpoint viewport, DPR or page scroll differs.' };
  const changes = [];
  if (a.version === 2 && a.focusIndex !== b.focusIndex) changes.push('focus');
  if (JSON.stringify(a.content) !== JSON.stringify(b.content)) changes.push('content-or-data');
  if (a.layout.length !== b.layout.length) changes.push('element-count');
  else for (let i=0;i<a.layout.length;i++) {
    const x=a.layout[i], y=b.layout[i];
    if (!x || !y || !Array.isArray(x.rect) || !Array.isArray(y.rect) || x.rect.length !== 4 || y.rect.length !== 4 || !x.rect.every(Number.isFinite) || !y.rect.every(Number.isFinite)
      || !x.styles || !y.styles || preservationStyles.some(k => typeof x.styles[k] !== 'string' || typeof y.styles[k] !== 'string')) return { outcome: 'invalid-evidence', reason: 'Incomplete geometry or computed-style evidence.' };
    if (x.rect.some((n,j) => Math.abs(n-y.rect[j]) > tolerance)) changes.push(`layout:${i}`);
    if (JSON.stringify(x.styles) !== JSON.stringify(y.styles)) changes.push(`style:${i}`);
  }
  return { outcome: changes.length ? 'regressed' : 'preserved', changes: changes.slice(0,30), changeCount: changes.length, elements: a.content.length,
    checkpointVersion: a.version, coverage: a.version === 2 ? 'dom-form-focus-layout' : 'legacy-dom-layout',
    limitations: ['Only sampled fields and declared scenarios; business assertions and visual review remain required.', ...(a.version === 1 ? ['Legacy checkpoint lacks complete form, focus and scroll state; recollect both sides for version 2 coverage.'] : [])] };
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
  if(before.version===2 && remove.has(before.focusIndex))throw new Error('Cannot exempt removal of the focused stylesheet node.');
  return {...before,...(before.version===2?{focusIndex:before.focusIndex-[...remove].filter(i=>i<before.focusIndex).length}:{}),
    content:before.content.filter((_,i)=>!remove.has(i)),layout:before.layout.filter((_,i)=>!remove.has(i))};
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
