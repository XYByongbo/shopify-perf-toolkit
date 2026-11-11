import {sha256} from './source-utils.mjs';
import {withStandardRules} from './standards-registry.mjs';
const displayUrl=value=>{if(!value)return '';try{const u=new URL(value);u.username='';u.password='';u.hash='';for(const k of [...u.searchParams.keys()])if(!/^(v|width|height|format|crop|quality|dl|raw)$/.test(k))u.searchParams.set(k,'[redacted]');return u.href;}catch{return '[unresolved URL]';}};

export const integrityRules = [
  {id:'PERF_LCP_IDENTITY',title:'LCP visibility and content identity',source:'https://web.dev/articles/optimize-lcp/'},
  {id:'PERF_LCP_EXPECTED_TARGET',title:'LCP differs from declared main content',source:'https://web.dev/articles/optimize-lcp/'},
  {id:'PERF_REPEAT_RESOURCE_REQUEST',title:'Repeated script or stylesheet requests',source:'https://shopify.dev/docs/storefronts/themes/best-practices/performance/load-javascript-on-user-interaction'},
  {id:'PERF_REPEAT_INIT_EVENT',title:'Repeated initialization signals',source:'https://shopify.dev/docs/storefronts/themes/best-practices/performance/load-javascript-on-user-interaction'},
].map(r=>withStandardRules({...r,phase:'integrity',staticScope:'not-inferred-from-source',runtimeSupported:true}));
export const defaultInitializationEvents = ['StartAsyncLoading','StartKernelLoading'];

/** Serialized by Playwright. Observe only: no DOM, resource, dispatch or prototype changes. */
export function installIntegrityObserver({initializationEvents=[],expectedLcpSelectors=[]}={}) {
  const state={version:1,timeOrigin:performance.timeOrigin,lcpSupported:false,lcpEntries:[],lcpTotal:0,
    lcpTruncated:false,events:[],eventsTruncated:false,initializationEvents,expectedLcpSelectors,errors:[]};
  const selector=el=>{
    if(el===window)return 'window';if(el===document)return 'document';if(!el?.tagName)return null;
    if(el.id&&document.querySelectorAll('#'+CSS.escape(el.id)).length===1)return '#'+CSS.escape(el.id);
    const parts=[];for(let n=el;n&&parts.length<12;n=n.parentElement){const siblings=n.parentElement?[...n.parentElement.children].filter(x=>x.tagName===n.tagName):[n];parts.unshift(n.tagName.toLowerCase()+(siblings.length>1?`:nth-of-type(${siblings.indexOf(n)+1})`:''));}
    const s=parts.join(' > ');return document.querySelectorAll(s).length===1?s:null;
  };
  const sample=el=>{
    if(!el?.isConnected)return null;
    const r=el.getBoundingClientRect(),style=getComputedStyle(el),ancestors=[];let node=el,opacity=1;
    while(node&&ancestors.length<32){const s=getComputedStyle(node);opacity*=Number(s.opacity);ancestors.push({selector:selector(node),opacity:s.opacity,display:s.display,visibility:s.visibility,contentVisibility:s.contentVisibility,zIndex:s.zIndex,filter:s.filter,activeAnimations:node.getAnimations().filter(a=>a.playState==='running').length});node=node.parentElement;}
    const text=(el.textContent??'').trim().replace(/\s+/g,' '),clipped=text.slice(0,200);
    const w=Math.max(0,Math.min(r.right,innerWidth)-Math.max(r.left,0)),h=Math.max(0,Math.min(r.bottom,innerHeight)-Math.max(r.top,0));
    return {capturedAtMs:performance.now(),selector:selector(el),tag:el.tagName,text:clipped,textCharacters:[...clipped].length,textTruncated:text.length>200,
      rect:{x:r.x,y:r.y,width:r.width,height:r.height},viewport:{width:innerWidth,height:innerHeight},viewportCoverage:innerWidth*innerHeight?w*h/(innerWidth*innerHeight):0,
      fontSize:parseFloat(style.fontSize),backgroundImage:style.backgroundImage,ariaHidden:el.getAttribute('aria-hidden'),inMain:Boolean(el.closest('main,[role="main"]')),
      effectiveOpacity:opacity,ancestors,ancestorsTruncated:Boolean(node),expectedMatch:expectedLcpSelectors.length?expectedLcpSelectors.some(s=>el.matches(s)):null};
  };
  for(const s of expectedLcpSelectors)try{document.querySelector(s);}catch{state.errors.push('invalid-expected-lcp-selector');}
  for(const name of initializationEvents)window.addEventListener(name,event=>{
    if(state.events.length>=500){state.eventsTruncated=true;return;}
    state.events.push({name,target:selector(event.target),atMs:performance.now(),trusted:event.isTrusted});
  },{capture:true,passive:true});
  let lcpElement=null;
  try{
    if(PerformanceObserver.supportedEntryTypes.includes('largest-contentful-paint')){
      new PerformanceObserver(list=>{for(const e of list.getEntries()){
        try{lcpElement=e.element;const value={startTime:e.startTime,size:e.size,url:e.url,identity:state.errors.length?null:sample(e.element)};
          state.lcpTotal++;if(state.lcpEntries.length>=20){state.lcpEntries.shift();state.lcpTruncated=true;}state.lcpEntries.push(value);
        }catch{state.errors.push('lcp-identity-capture-failed');}
      }}).observe({type:'largest-contentful-paint',buffered:true});state.lcpSupported=true;
    }
  }catch{state.errors.push('lcp-observer-unavailable');}
  window.__perfkitIntegritySnapshot=()=>({...state,capturedAtMs:performance.now(),settledLcp:state.errors.length?null:sample(lcpElement)});
}
export const integritySnapshot=()=>window.__perfkitIntegritySnapshot?.()??null;
const finite=n=>typeof n==='number'&&Number.isFinite(n);
const validIdentity=x=>x&&finite(x.effectiveOpacity)&&x.effectiveOpacity>=0&&x.effectiveOpacity<=1&&finite(x.viewportCoverage)&&x.viewportCoverage>=0&&x.viewportCoverage<=1&&finite(x.fontSize)&&finite(x.capturedAtMs)&&Array.isArray(x.ancestors)&&x.ancestors.length>0&&x.ancestors.length<=32&&x.ancestors.every(a=>typeof a.opacity==='string'&&a.opacity.trim()!==''&&finite(Number(a.opacity))&&typeof a.display==='string'&&typeof a.visibility==='string');
const hidden=x=>x.ancestors.some(a=>a.display==='none'||['hidden','collapse'].includes(a.visibility)||a.contentVisibility==='hidden');
const nearInvisible=x=>x.effectiveOpacity<=0.01||hidden(x);
const transient=x=>x.ancestors.some(a=>a.activeAnimations>0);

/** Recompute from raw capture; never trust a serialized `integrity` pass flag. */
export function inspectRuntimeIntegrity(profile) {
  const findings=[],issues=[];
  const add=(ruleId,summary,evidence,priority='P1')=>findings.push(withStandardRules({id:`integrity:${ruleId}:${findings.length}`,ruleId,dimension:'performance',status:'review-required',priority,file:null,line:null,
    summary,evidence:[evidence],verification:['Bind the page/theme/source and review actual main content and dependency behavior.','Repeated requests do not establish duplicate transfer or script execution; diagnostic timings are not formal score evidence.']}));
  if(!profile||profile.kind!=='runtime-profile')throw new Error('Expected runtime-profile evidence.');
  if(profile.status!=='complete'||profile.sourceStable!==true)issues.push({reason:'capture-incomplete-or-source-unstable'});
  if(profile.config?.expectedThemeId!==undefined&&String(profile.config.expectedThemeId)!==String(profile.themeId))issues.push({reason:'theme-identity-mismatch'});
  const initial=profile.initial?.integrity,after=profile.afterActions?.integrity;
  let lcpStatus='not-collected',metricUse='not-assessed';
  if(initial?.version===1){
    if(JSON.stringify(initial.expectedLcpSelectors)!==JSON.stringify(profile.config?.expectedLcpSelectors??[])||JSON.stringify(initial.initializationEvents)!==JSON.stringify(profile.config?.initializationEvents??defaultInitializationEvents))issues.push({reason:'integrity-observer-config-mismatch'});
    if(!Array.isArray(initial.lcpEntries)||initial.lcpEntries.length>20||initial.errors?.length||initial.lcpTruncated!==false)issues.push({reason:'lcp-history-incomplete'});
    const entry=Array.isArray(initial.lcpEntries)?initial.lcpEntries.at(-1):null,x=entry?.identity,settled=initial.settledLcp;
    const declared=profile.initial?.lcp;
    if(!initial.lcpSupported||!entry){lcpStatus='unavailable';issues.push({reason:'lcp-not-observed'});}
    else if(!validIdentity(x)||!validIdentity(settled)||x.ancestorsTruncated||settled.ancestorsTruncated
      ||!finite(entry.startTime)||!declared||entry.startTime!==declared.startTime||entry.size!==declared.size||entry.url!==declared.url
      ||initial.timeOrigin!==profile.timeOrigin){lcpStatus='incomplete';issues.push({reason:'lcp-identity-incomplete-or-mismatched'});}
    else {
      lcpStatus='no-anomaly-observed';metricUse='no-anomaly-observed-not-acceptance';
      const stable=nearInvisible(settled)&&settled.selector===x.selector;
      const giantText=!['IMG','VIDEO'].includes(x.tag)&&x.backgroundImage==='none'&&x.textTruncated===false&&x.textCharacters>0&&x.textCharacters<=8
        &&x.viewportCoverage>=0.5&&x.fontSize>=x.viewport?.width;
      if(nearInvisible(x)){
        const strong=stable&&!transient(x)&&!transient(settled)&&giantText;
        add('PERF_LCP_IDENTITY',strong?'Nearly invisible oversized short text occupies the observed LCP; do not claim a main-content speed gain from this metric.':'LCP visibility at observer callback needs review; style or animation changes can differ from paint-time visibility.',
          {entry:{startTime:entry.startTime,size:entry.size,url:displayUrl(entry.url)},identity:x,settled,confidence:strong?'strong-anomaly':'candidate',mechanism:giantText?'oversized-short-text':'low-visibility',paintTimeStyles:'not-recorded'},strong?'P0':'P1');
        lcpStatus='suspect';metricUse='hold-for-review';
      }
      if(initial.expectedLcpSelectors?.length&&x.expectedMatch===false){add('PERF_LCP_EXPECTED_TARGET','Observed LCP does not match the caller-declared main-content selectors; verify the expectation and page state.',{expected:initial.expectedLcpSelectors,observed:x.selector});lcpStatus='suspect';metricUse='hold-for-review';}
    }
  }else issues.push({reason:'lcp-identity-not-collected-recapture'});
  const network=profile.networkCapture,resources=profile.resources;
  let requestStatus='not-collected';const repeatedResources=[];
  if(network?.version===1&&Array.isArray(resources)&&resources.length<=6000){
    requestStatus='no-repeat-observed';
    if(network.complete!==true||network.truncated!==false||network.redirectsTruncated!==false||!network.mainFrameId||!network.mainLoaderId){requestStatus='incomplete';issues.push({reason:'network-coverage-incomplete'});}
    const groups=new Map(),seen=new Set();
    for(const r of resources){
      if(r.redirected||!['Script','Stylesheet'].includes(r.type)||r.method!=='GET')continue;
      if(typeof r.frameId!=='string'||typeof r.loaderId!=='string'||typeof r.id!=='string'||!finite(r.timestamp)){requestStatus='incomplete';issues.push({reason:'request-context-unavailable'});continue;}
      if(r.frameId!==network.mainFrameId||r.loaderId!==network.mainLoaderId)continue;
      let url;try{url=new URL(r.url);if(!['http:','https:'].includes(url.protocol))continue;url.hash='';}catch{requestStatus='incomplete';issues.push({reason:'request-url-unavailable'});continue;}
      const attempt=`${r.id}:${r.redirectHop??0}`;if(seen.has(attempt))continue;seen.add(attempt);
      const key=JSON.stringify([r.type,url.href]);if(!groups.has(key))groups.set(key,{url:url.href,type:r.type,requests:[]});groups.get(key).requests.push(r);
    }
    for(const group of groups.values())if(group.requests.length>1){
      const req=group.requests.sort((a,b)=>a.timestamp-b.timestamp),completed=req.filter(r=>finite(r.finishedTimestamp)&&!r.error),failed=req.filter(r=>r.error||r.status>=400);
      const known=completed.filter(r=>finite(r.transferBytes)&&r.transferBytes>=0);
      const evidence={url:displayUrl(group.url),urlHash:sha256(group.url),type:group.type,attempts:req.length,completed:completed.length,failed:failed.length,
        classification:failed.length?'retry-or-failure-review':'repeated-request-observed',cachedResponses:req.filter(r=>r.fromDiskCache||r.fromMemoryCache||r.fromServiceWorker).length,
        observedEncodedBytes:known.length?known.reduce((n,r)=>n+r.transferBytes,0):null,bytesComplete:known.length===req.length,
        execution:'not-established',savedBytes:null,requests:req.map(r=>({id:r.id,phase:r.phase,relativeMs:(r.timestamp-req[0].timestamp)*1000,status:r.status??null,
          initiatorType:r.initiator?.type??null,initiatorUrl:displayUrl(r.initiator?.url??r.initiator?.stack?.callFrames?.[0]?.url??''),error:r.error??null}))};
      repeatedResources.push(evidence);add('PERF_REPEAT_RESOURCE_REQUEST','The same script/stylesheet URL was requested more than once in the same main document; inspect initiators, cache/retry behavior and initialization.',evidence);
    }
    if(repeatedResources.length)requestStatus='repeats-observed';
  }else issues.push({reason:'network-request-context-not-collected-recapture'});
  const eventSource=after?.version===1?after:initial;let eventStatus='not-collected';const repeatedEvents=[];
  if(eventSource?.version===1&&Array.isArray(eventSource.events)&&eventSource.events.length<=500&&eventSource.timeOrigin===profile.timeOrigin){
    if(JSON.stringify(eventSource.initializationEvents)!==JSON.stringify(profile.config?.initializationEvents??defaultInitializationEvents)||!finite(eventSource.capturedAtMs))issues.push({reason:'initialization-observer-config-mismatch'});
    eventStatus='no-repeat-observed';if(!after||eventSource.eventsTruncated!==false||!Array.isArray(eventSource.initializationEvents)||!eventSource.initializationEvents.length||eventSource.errors?.length){eventStatus='incomplete';issues.push({reason:'initialization-event-window-incomplete'});}
    const groups=new Map();for(const e of eventSource.events){if(typeof e.name!=='string'||typeof e.target!=='string'||(!finite(e.atMs)||e.atMs<0||e.atMs>eventSource.capturedAtMs)||!eventSource.initializationEvents?.includes(e.name)){eventStatus='incomplete';issues.push({reason:'invalid-initialization-event'});continue;}const k=JSON.stringify([e.name,e.target]);if(!groups.has(k))groups.set(k,[]);groups.get(k).push(e);}
    for(const events of groups.values())if(events.length>1){const evidence={name:events[0].name,target:events[0].target,count:events.length,timesMs:events.map(e=>e.atMs),execution:'handlers-and-effects-not-established'};repeatedEvents.push(evidence);add('PERF_REPEAT_INIT_EVENT','A watched initialization signal was dispatched repeatedly to the same target; verify one-shot intent and handler idempotence.',evidence);}
    if(repeatedEvents.length)eventStatus='repeats-observed';
  }else issues.push({reason:'initialization-events-not-collected-recapture'});
  const complete=issues.length===0;
  if(!complete&&metricUse==='no-anomaly-observed-not-acceptance')metricUse='not-assessed';
  return {schemaVersion:1,kind:'runtime-integrity',version:1,status:findings.length?'review-required':complete?'no-anomaly-observed':'incomplete',complete,reviewRequired:findings.length>0||!complete,
    metricUse,lcpStatus,requestStatus,eventStatus,findings,issues, repeatedResources,repeatedEvents,
    input:{page:displayUrl(profile.config?.url??''),device:profile.config?.device??null,state:profile.config?.state??null,themeId:profile.themeId??null,sourceHash:profile.snapshot?.hash??null,createdAt:profile.createdAt??null},
    scope:{network:'same-main-frame-and-loader-exact-url-GET-script-stylesheet',events:eventSource?.initializationEvents??[],initialEndMs:initial?.capturedAtMs??null,endMs:eventSource?.capturedAtMs??null,actions:profile.actions?.map(a=>({type:a.type,status:a.status}))??[],cache:profile.environment?.cache??'unknown'},
    limitations:['Anomaly candidates are not proof of author intent or of what styles existed at LCP paint time.','No anomaly observed is limited to this capture window, not a performance or business acceptance.','URL queries remain distinct for grouping; fragments are ignored. Redirect hops, other frames/documents and preloads reused without another request are not counted as duplicate requests.','Encoded response bytes are not predicted savings; repeated requests/events do not prove duplicate downloads or script execution.','Initialization listeners record only declared event names and no event payload. Unobserved events and later timers are outside coverage.']};
}
