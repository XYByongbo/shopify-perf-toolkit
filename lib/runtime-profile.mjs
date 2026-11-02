import { sha256 } from './source-utils.mjs';
import { chromium } from 'playwright-core';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRunDirectory } from './measure.mjs';
import { evidenceEnvelope } from './evidence-contract.mjs';

export { sha256 };
export {browserExecutable,sourceSnapshot} from './theme-source.mjs';
import {browserExecutable,sourceSnapshot} from './theme-source.mjs';
export function mapRuntimeSource(url, bodyHash, snapshot) {
  if (!bodyHash || !snapshot) return { status: 'unmapped', reason: 'Response body or local source evidence unavailable.' };
  let name; try { name = decodeURIComponent(path.posix.basename(new URL(url).pathname)); } catch { return { status: 'unmapped' }; }
  const matches = snapshot.files.filter(f => f.file.startsWith('assets/') && /\.(?:m?js|css)$/.test(f.file) && f.sourceHash === bodyHash);
  const named = matches.filter(f => path.posix.basename(f.file) === name);
  const exact = named.length === 1 ? named[0] : matches.length === 1 ? matches[0] : null;
  return exact ? { status: 'verified-bytes', ...exact, reason: 'Decoded network response bytes match SHA-256 of local source; origin and filename alone are insufficient.' }
    : { status: matches.length ? 'ambiguous' : 'unmapped', candidates: matches.map(f => f.file), reason: 'No unique byte-identical local JS/CSS source.' };
}
export function coverageSummary(entry) {
  if (!entry.ranges && Array.isArray(entry.functions)) {
    const text = entry.source;
    if (typeof text !== 'string') return { url: entry.url, status: 'source-unavailable', totalBytes: null, usedBytes: null, ranges: [] };
    const events = entry.functions.flatMap(fn => fn.ranges.flatMap(r => [ { offset: r.startOffset, end: r.endOffset, start: true, count: r.count }, { offset: r.endOffset, begin: r.startOffset, start: false } ]));
    events.sort((a,b) => a.offset-b.offset || Number(a.start)-Number(b.start) || (a.start ? b.end-a.end : b.begin-a.begin));
    const stack = [], ranges = []; let previous = 0;
    for (const event of events) {
      if (event.offset < 0 || event.offset > text.length) throw new Error('V8 coverage offset outside source.');
      if (event.offset > previous && stack.at(-1) > 0) ranges.push({ start: previous, end: event.offset });
      if (event.start) stack.push(event.count); else stack.pop();
      previous = event.offset;
    }
    entry = { ...entry, text, ranges };
  }
  if (typeof entry.text !== 'string') return { url: entry.url, status: 'source-unavailable', totalBytes: null, usedBytes: null, ranges: [] };
  const ranges = [...entry.ranges].sort((a, b) => a.start - b.start || a.end - b.end), union = [];
  for (const range of ranges) {
    if (range.start < 0 || range.end > entry.text.length || range.end < range.start) throw new Error('Coverage range outside source.');
    const last = union.at(-1);
    if (last && range.start <= last.end) last.end = Math.max(last.end, range.end);
    else union.push({ start: range.start, end: range.end });
  }
  const usedUnits = union.reduce((s, r) => s + r.end - r.start, 0), usedBytes = union.reduce((s, r) => s + Buffer.byteLength(entry.text.slice(r.start, r.end)), 0);
  return { url: entry.url, status: 'observed', sourceHash: sha256(entry.text), totalUnits: entry.text.length, usedUnits, unusedUnits: entry.text.length - usedUnits,
    totalBytes: Buffer.byteLength(entry.text), usedBytes, ranges: union, offsetUnit: 'UTF-16 code units' };
}
export function cpuHotspots(profile, snapshot, mapFrame) {
  const nodes = new Map(profile.nodes.map(n => [n.id, n])), parents = new Map(), totals = new Map();
  for (const n of nodes.values()) for (const child of n.children ?? []) parents.set(child, n.id);
  for (let i = 0; i < (profile.samples ?? []).length; i++) {
    let id = profile.samples[i], leaf = true, seen = new Set(); const ms = (profile.timeDeltas?.[i] ?? 0) / 1000;
    while (id && !seen.has(id)) {
      seen.add(id); const row = totals.get(id) ?? { selfMs: 0, inclusiveMs: 0 };
      row.inclusiveMs += ms; if (leaf) row.selfMs += ms; totals.set(id, row); id = parents.get(id); leaf = false;
    }
  }
  return [...totals].map(([id, timing]) => { const frame = nodes.get(id)?.callFrame ?? {};
    return { ...timing, functionName: frame.functionName, scriptId: frame.scriptId, url: frame.url, line: frame.lineNumber + 1, column: frame.columnNumber + 1,
      source: mapFrame?.(frame) ?? (() => { const source = snapshot?.resources?.find(r => r.url === frame.url)?.source;
        return source?.status === 'verified-bytes' ? { ...source,line: frame.lineNumber+1,column: frame.columnNumber+1 } : source ?? { status: 'unmapped' }; })(),
      callPath: (() => { const result=[]; let at=parents.get(id); while(at && result.length<12) { const f=nodes.get(at)?.callFrame; if(f?.url) result.push({ functionName:f.functionName,url:f.url,line:f.lineNumber+1,column:f.columnNumber+1 }); at=parents.get(at); } return result; })() };
  }).sort((a, b) => b.selfMs - a.selfMs).slice(0, 100);
}
export function lcpBreakdown(performance) {
  const lcp = performance.lcp, nav = performance.navigation;
  if (!lcp || !nav) return { status: 'unavailable' };
  const base = { lcpMs: lcp.startTime, element: lcp.element, url: lcp.url, ttfbMs: nav.responseStart };
  if (!lcp.url) return { ...base, status: 'text-or-inline', loadDelayMs: 0, loadDurationMs: 0, renderDelayMs: Math.max(0, lcp.startTime - nav.responseStart), note: 'Text LCP includes font and style wait in render delay.' };
  const r = performance.resources.find(r => r.name === lcp.url);
  if (!r || !r.responseStart || !r.requestStart) return { ...base, status: 'timing-unavailable', loadDelayMs: null, loadDurationMs: null, renderDelayMs: null, note: 'Resource Timing/TAO does not expose enough timing; missing is not zero.' };
  return { ...base, status: 'observed', loadDelayMs: Math.max(0, r.requestStart - nav.responseStart),
    loadDurationMs: Math.max(0, r.responseEnd - Math.max(r.requestStart, nav.responseStart)), renderDelayMs: Math.max(0, lcp.startTime - r.responseEnd) };
}
export function validateProfileConfig(config) {
  if (!config || config.schemaVersion !== 1 || Object.keys(config).some(k => !['schemaVersion','url','project','device','state','actions','settleMs','timeoutMs','readOnly','expectedThemeId','targetSelectors','hashResourceUrls'].includes(k))) throw new Error('Invalid runtime profile config.');
  const url = new URL(config.url); if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Profile URL requires HTTP(S) without credentials.');
  const value = { device: 'mobile', state: 'initial', actions: [], settleMs: 1500, timeoutMs: 45000, readOnly: true, ...config };
  if(value.hashResourceUrls!==undefined&&(!Array.isArray(value.hashResourceUrls)||value.hashResourceUrls.length>5||value.hashResourceUrls.some(u=>{try{const p=new URL(u);return !['http:','https:'].includes(p.protocol)||p.username||p.password;}catch{return true;}})))throw new Error('hashResourceUrls accepts at most five explicit HTTP(S) resource URLs.');
  if(value.targetSelectors!==undefined&&(!Array.isArray(value.targetSelectors)||value.targetSelectors.length>50||value.targetSelectors.some(s=>typeof s!=='string'||!s.trim()||s.length>500)))throw new Error('targetSelectors must contain at most 50 bounded CSS selectors.');
  if (!['mobile','desktop'].includes(value.device) || typeof value.state !== 'string' || !value.state.trim() || typeof value.readOnly !== 'boolean') throw new Error('Invalid profile device/state/readOnly.');
  for (const [key, max] of [['settleMs', 10000], ['timeoutMs', 120000]]) if (!Number.isSafeInteger(value[key]) || value[key] < (key === 'timeoutMs' ? 1000 : 0) || value[key] > max) throw new Error(`Invalid ${key}.`);
  if (!Array.isArray(value.actions) || value.actions.length > 30) throw new Error('At most 30 profile actions are supported.');
  for (const action of value.actions) {
    if (!action || !['click','hover','focus','scroll','wait','press'].includes(action.type) || Object.keys(action).some(k => !['type','selector','y','ms','key'].includes(k))) throw new Error('Unsupported profile action.');
    if (['click','hover','focus','press'].includes(action.type) && (typeof action.selector !== 'string' || !action.selector)) throw new Error('Action needs a selector.');
    if(action.type==='press'&&(typeof action.key!=='string'||!action.key.trim()||action.key.length>80))throw new Error('Press action needs a bounded key.');
    if (action.type === 'wait' && (!Number.isInteger(action.ms) || action.ms < 0 || action.ms > 5000)) throw new Error('Action wait must be 0..5000 ms.');
    if (action.type === 'scroll' && (!Number.isFinite(action.y) || Math.abs(action.y) > 100000)) throw new Error('Invalid scroll offset.');
  }
  return value;
}

export const resourceHealthSnapshot=async()=>({version:1,capturedAtMs:performance.now(),
      images:await Promise.all([...document.images].slice(0,200).map(async el=>{
        const url=el.currentSrc||el.src,complete=el.complete;let decoded=null,timer;
        if(complete)try{decoded=await Promise.race([el.decode().then(()=>el.naturalWidth>0&&el.naturalHeight>0,()=>false),new Promise(resolve=>{timer=setTimeout(()=>resolve(null),500);})]);}finally{clearTimeout(timer);}
        const changed=url!==(el.currentSrc||el.src);
        return {selector:window.__perfkitTargetName(el),url,complete:changed?false:complete,decoded:changed?null:decoded,changedDuringCapture:changed,
          naturalWidth:el.naturalWidth,naturalHeight:el.naturalHeight,loading:el.loading,inPicture:Boolean(el.closest("picture")),srcset:el.srcset,sizes:el.sizes,inViewport:el.getBoundingClientRect().top<innerHeight&&el.getBoundingClientRect().bottom>0};})),
      fonts:[...document.fonts].map(f=>({family:f.family,weight:f.weight,style:f.style,status:f.status,display:f.display})),
      text:[...document.querySelectorAll('h1,h2,h3,p,button,a')].slice(0,100).map(el=>{const css=getComputedStyle(el),r=el.getBoundingClientRect();return {selector:window.__perfkitTargetName(el),text:el.textContent.slice(0,200),family:css.fontFamily,weight:css.fontWeight,fontSize:css.fontSize,lineHeight:css.lineHeight,rect:[r.x,r.y,r.width,r.height]};}),
      backgrounds:[...document.querySelectorAll('[style],section,header,main')].slice(0,300).flatMap(el=>{const value=getComputedStyle(el).backgroundImage;return value==='none'?[]:[{selector:window.__perfkitTargetName(el),value,state:'unverified'}];}),
      coverage:'img-selected-source-and-sampled-backgrounds',backgroundsTruncated:document.querySelectorAll('[style],section,header,main').length>300,
      truncated:document.images.length>200});

/** Instrumented diagnostics, deliberately separate from Lighthouse score samples. No media bodies are saved. */
export async function profileRuntime({ config, output } = {}) {
  config = validateProfileConfig(config);
  const out = await createRunDirectory(output), snapshot = config.project ? await sourceSnapshot(config.project) : null;
  const attribution = config.project ? await import('./source-attribution.mjs') : null;
  const sourceIndex = attribution ? await attribution.indexThemeSources(config.project) : null;
  if (sourceIndex && sourceIndex.snapshot.hash !== snapshot.hash) throw new Error('Source drift before runtime capture.');
  const result = { schemaVersion: 1, kind: 'runtime-profile', createdAt: new Date().toISOString(), status: 'running', project: snapshot?.project ?? null,
    config, snapshot, resources: [], actions: [], errors: [], blockedRequests: [], coverage: { js: [], css: [] },
    limitations: ['Instrumented diagnostic timings are not Lighthouse score or field INP evidence.', 'Coverage applies only to the recorded page/device/state; unused here does not authorize global removal.', 'Normal browser media requests occur, but image/video/font response bodies and screenshots are not saved.'] };
  let browser, timer; const started = Date.now();
  try {
    browser = await chromium.launch({ executablePath: await browserExecutable(), headless: true, timeout: config.timeoutMs });
    timer = setTimeout(() => { result.errors.push('Profile wall-time budget exceeded.'); void browser.close(); }, Math.max(1,config.timeoutMs-(Date.now()-started)));
    const context = await browser.newContext({ viewport: config.device === 'mobile' ? { width: 390, height: 844 } : { width: 1440, height: 900 },
      isMobile: config.device === 'mobile', deviceScaleFactor: config.device === 'mobile' ? 3 : 1, hasTouch: config.device === 'mobile', serviceWorkers: 'block' });
    if (config.readOnly) await context.route('**/*', route => ['GET','HEAD','OPTIONS'].includes(route.request().method()) ? route.continue()
      : (result.blockedRequests.push({ url: route.request().url(), method: route.request().method() }), route.abort()));
    if (config.readOnly && context.routeWebSocket) await context.routeWebSocket('**/*', socket => socket.close());
    await context.addInitScript(() => {
      window.__perfkit = { lcp: null, fcp: null, shifts: [], longTasks: [], interactions: [], longAnimationFrames: [], motion: [], supported: [] };
      const targetName = el => {
        if (!el?.tagName) return null;
        if (el.id && document.querySelectorAll('#'+CSS.escape(el.id)).length===1) return '#'+CSS.escape(el.id);
        const parts=[];for(let n=el;n&&parts.length<6;n=n.parentElement){const siblings=n.parentElement?[...n.parentElement.children].filter(x=>x.tagName===n.tagName):[n];parts.unshift(n.tagName.toLowerCase()+(siblings.length>1?`:nth-of-type(${siblings.indexOf(n)+1})`:''));}
        const selector=parts.join(' > ');
        return document.querySelectorAll(selector).length===1?selector:null;
      };
      window.__perfkitTargetName = targetName;
      window.__perfkit.resizes = [];
      const seen = new WeakSet(), sizes = new WeakMap();
      const resize = new ResizeObserver(entries => {
        for (const {target} of entries) {
          const rect=target.getBoundingClientRect(), after={width:rect.width,height:rect.height,top:rect.top,left:rect.left};
          const before=sizes.get(target);sizes.set(target,after);
          if(before && (before.height!==after.height||before.width!==after.width) && window.__perfkit.resizes.length<1000)
            window.__perfkit.resizes.push({id:target.id,selector:targetName(target),tag:target.tagName,at:performance.now(),before,after});
        }
      });
      const track = () => {
        for(const el of [...document.querySelectorAll('[id], img')].slice(0,500))if(!seen.has(el)){
          seen.add(el);const r=el.getBoundingClientRect();sizes.set(el,{width:r.width,height:r.height,top:r.top,left:r.left});resize.observe(el);
        }
      };
      new MutationObserver(track).observe(document,{childList:true,subtree:true});
      for (const type of ['animationstart', 'animationend', 'transitionrun', 'transitionend']) document.addEventListener(type, event => {
        if (window.__perfkit.motion.length >= 500) return;
        window.__perfkit.motion.push({ selector: targetName(event.target), type, at: performance.now(),
          name: event.animationName ?? event.propertyName, elapsedTime: event.elapsedTime });
      }, { capture: true, passive: true });
      const presentation = el => {
        if (!el) return null;
        const ancestors = [];
        for (let node = el; node && ancestors.length < 12; node = node.parentElement) {
          const style = getComputedStyle(node), selector = targetName(node);
          ancestors.push({ selector, tag: node.tagName, role: node.getAttribute('role'), opacity: style.opacity, visibility: style.visibility, display: style.display,
            animations: [
              ...node.getAnimations().slice(0, 20).map(a => ({ state: a.playState, currentTime: typeof a.currentTime === 'number' ? a.currentTime : null })),
              ...window.__perfkit.motion.filter(m => selector && m.selector === selector).slice(-20),
            ] });
        }
        return { capturedAtMs: performance.now(), selector: targetName(el), tag: el.tagName, classes: [...el.classList],
          loading: el.loading ?? null, fetchPriority: el.fetchPriority ?? null, currentSrc: el.currentSrc ?? null,
          backgroundImage: getComputedStyle(el).backgroundImage, ancestors };
      };
      const observe = (type, fn, extra = {}) => { try { if(!PerformanceObserver.supportedEntryTypes.includes(type))return;new PerformanceObserver(list => list.getEntries().forEach(fn)).observe({ type, buffered: true, ...extra });window.__perfkit.supported.push(type); } catch {} };
      observe('paint', e => { if(e.name==='first-contentful-paint')window.__perfkit.fcp=e.startTime; });
      observe('largest-contentful-paint', e => { window.__perfkitLCPElement=e.element;window.__perfkit.lcp = { startTime: e.startTime, url: e.url, size: e.size,
        element: e.element ? { tag: e.element.tagName, id: e.element.id, className: String(e.element.className) } : null,
        presentation: presentation(e.element) }; });
      observe('layout-shift', e => { if (!e.hadRecentInput && window.__perfkit.shifts.length < 1000) window.__perfkit.shifts.push({ value: e.value, startTime: e.startTime, sources: e.sources?.map(s => ({ tag: s.node?.nodeName, target:targetName(s.node), previousRect: s.previousRect, currentRect: s.currentRect })) }); });
      observe('longtask', e => { if (window.__perfkit.longTasks.length < 1000) window.__perfkit.longTasks.push({ startTime: e.startTime, duration: e.duration }); });
      observe('event', e => { if (e.interactionId && window.__perfkit.interactions.length < 1000) window.__perfkit.interactions.push({ name: e.name, target: targetName(e.target), startTime:e.startTime, interactionId: e.interactionId, duration: e.duration, inputDelay: e.processingStart - e.startTime, processing: e.processingEnd - e.processingStart }); }, { durationThreshold: 16 });
      observe('long-animation-frame',e=>{if(window.__perfkit.longAnimationFrames.length<500)window.__perfkit.longAnimationFrames.push({startTime:e.startTime,duration:e.duration,blockingDuration:e.blockingDuration,
        scripts:e.scripts?.slice(0,50).map(s=>({sourceURL:s.sourceURL,sourceFunctionName:s.sourceFunctionName,invokerType:s.invokerType,duration:s.duration,forcedStyleAndLayoutDuration:s.forcedStyleAndLayoutDuration}))});});
    });
    const page = await context.newPage(); page.setDefaultTimeout(Math.min(10000, config.timeoutMs));
    page.on('pageerror', e => result.errors.push(e.message));
    const cdp = await context.newCDPSession(page), requests = new Map(), bodyTasks = [], trace = [], scripts = new Map();
    let scriptBytes = 0;
    cdp.on('Debugger.scriptParsed', e => {
      if (!sourceIndex || !/^https?:/.test(e.url) || scripts.size >= 300) return;
      const record = { scriptId: e.scriptId, url: e.url, startLine: e.startLine, startColumn: e.startColumn }; scripts.set(e.scriptId,record);
      bodyTasks.push((async () => { try {
        const { scriptSource } = await cdp.send('Debugger.getScriptSource', { scriptId: e.scriptId });
        const bytes = Buffer.byteLength(scriptSource);
        if (bytes <= 2*1024*1024 && scriptBytes+bytes <= 16*1024*1024) { scriptBytes += bytes; record.text = scriptSource; }
      } catch { record.unavailable = true; } })());
    });
    let traceTruncated = false,initialCapture=true;
    cdp.on('Network.requestWillBeSent', e => {
      if (requests.size >= 3000) return;
      if (e.redirectResponse && requests.has(e.requestId)) { const old = requests.get(e.requestId); result.resources.push({ ...old, status: e.redirectResponse.status, redirected: true }); }
      requests.set(e.requestId, { id: e.requestId, url: e.request.url, method: e.request.method, type: e.type, timestamp: e.timestamp,
        initiator: e.initiator, documentURL: e.documentURL, priority: e.request.initialPriority,phase:initialCapture?'initial':'interaction' });
    });
    cdp.on('Network.responseReceived', e => {
      const r = requests.get(e.requestId);
      if (r) Object.assign(r, { status: e.response.status, mimeType: e.response.mimeType, timing: e.response.timing, fromDiskCache: e.response.fromDiskCache });
      if (r?.type === 'Document') {
        const value = Object.entries(e.response.headers ?? {}).find(([k]) => k.toLowerCase() === 'link')?.[1];
        r.linkHeader = typeof value === 'string' ? value.slice(0, 65536) : null;
        r.linkHeaderTruncated = typeof value === 'string' && value.length > 65536;
      }
    });
    cdp.on('Network.loadingFailed', e => { const r = requests.get(e.requestId); if (r) r.error = e.errorText; });
    cdp.on('Network.loadingFinished', e => {
      const r = requests.get(e.requestId); if (!r) return; r.transferBytes = e.encodedDataLength; r.finishedTimestamp = e.timestamp;
      if ((['Script','Stylesheet'].includes(r.type)||['Image','Font'].includes(r.type)&&config.hashResourceUrls?.includes(r.url)) && e.encodedDataLength < 8 * 1024 * 1024 && bodyTasks.length < 200) bodyTasks.push((async () => {
        try { const body = await cdp.send('Network.getResponseBody', { requestId: e.requestId }); const bytes = Buffer.from(body.body, body.base64Encoded ? 'base64' : 'utf8');
          if (bytes.length <= 8 * 1024 * 1024) r.bodyHash = sha256(bytes); else r.bodyStatus = 'size-limit';
        } catch { r.bodyStatus = 'unavailable'; }
      })());
    });
    cdp.on('Tracing.dataCollected', ({ value }) => { if (trace.length + value.length <= 100000) trace.push(...value); else traceTruncated = true; });
    await cdp.send('Network.enable'); await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
    await cdp.send('Performance.enable');
    await cdp.send('Debugger.enable'); await cdp.send('Profiler.enable'); await cdp.send('Profiler.start');
    await cdp.send('Tracing.start', { categories: 'devtools.timeline,v8,blink.user_timing,disabled-by-default-devtools.timeline', transferMode: 'ReportEvents' });
    await page.coverage.startJSCoverage({ resetOnNavigation: false }); await page.coverage.startCSSCoverage({ resetOnNavigation: false });
    const navigationResponse=await page.goto(config.url, { waitUntil: 'load', timeout: Math.min(config.timeoutMs, 30000) });
    await page.waitForTimeout(config.settleMs);
    const initialTraceEnd=(await cdp.send('Performance.getMetrics')).metrics.find(m=>m.name==='Timestamp')?.value;
    const initial = await page.evaluate(() => ({ ...window.__perfkit, navigation: performance.getEntriesByType('navigation')[0]?.toJSON(), resources: performance.getEntriesByType('resource').map(x => x.toJSON()) }));
    initial.delivery = await page.evaluate(() => {
      const links = [...document.querySelectorAll('link[rel]')];
      const hidden = [...document.querySelectorAll('dialog, details:not([open]), [hidden], [role="dialog"], [role="alertdialog"]')]
        .filter(el => el.tagName === 'DIALOG' && !el.open || el.tagName === 'DETAILS' && !el.open
          || el.hidden || getComputedStyle(el).display === 'none' || getComputedStyle(el).visibility === 'hidden');
      return { version: 1, capturedAtMs: performance.now(), truncated: links.length > 500 || hidden.length > 100||document.querySelectorAll('style,link[rel="stylesheet"]').length>500,
        stylesheets:[...document.querySelectorAll('style,link[rel="stylesheet"]')].slice(0,500).map(el=>({tag:el.tagName,
          href:el.href??null,assetName:el.href?decodeURIComponent(new URL(el.href).pathname.split('/').at(-1)):null,
          media:el.media??'',mediaMatches:!el.media||matchMedia(el.media).matches,disabled:Boolean(el.disabled),onLoad:el.hasAttribute('onload'),
          crossOrigin:el.getAttribute('crossorigin'),integrity:el.getAttribute('integrity'),
          rootSelectors:(()=>{const ids=[];for(let p=el.parentElement;p;p=p.parentElement)if(p.id&&document.querySelectorAll('#'+CSS.escape(p.id)).length===1)ids.push('#'+CSS.escape(p.id));return ids;})()})),
        links: links.slice(0, 500).map(el => ({ selector: window.__perfkitTargetName(el), rel: el.rel.toLowerCase(),
          href: el.href, as: el.as, crossOrigin: el.getAttribute('crossorigin'), media: el.media,
          mediaMatches: !el.media || matchMedia(el.media).matches, disabled: el.disabled,
          imageSrcset: el.imageSrcset || null, imageSizes: el.imageSizes || null })),
        hiddenComponents: hidden.slice(0, 100).map(el => ({ selector: window.__perfkitTargetName(el), tag: el.tagName, descendants: el.querySelectorAll('*').length })),
        limitations: ['DOM snapshot after initial settle; scripts may have changed resource hints.', 'Document Link headers are recorded separately; HTTP 103 Early Hints are not captured.'] };
    });
    initial.delivery.securityPolicy={complete:true,headers:(await navigationResponse.headersArray()).filter(h=>h.name.toLowerCase()==='content-security-policy').map(h=>h.value),
      meta:await page.evaluate(()=>[...document.querySelectorAll('meta[http-equiv]')].filter(n=>n.httpEquiv.toLowerCase()==='content-security-policy').map(n=>n.content))};
    result.initial = initial; result.lcp = lcpBreakdown(initial);
    result.resourceHealth=await page.evaluate(resourceHealthSnapshot);
    result.domainTargetCoverage = await page.evaluate(selectors => {const nodes=[...new Set([...document.querySelectorAll('details[id]:not([open]), img, script[src], link[href], [id].shopify-app-block, [id][data-app-container]'),...selectors.flatMap(s=>[...document.querySelectorAll(s)])])];return {version:1,selectorScope:'all-img-script-link-and-configured-targets',total:nodes.length,truncated:nodes.length>500,targets:nodes.slice(0,500).map(el=>{
      const r=el.getBoundingClientRect(),s=getComputedStyle(el);
      return {id:el.id,tag:el.tagName,idCount:el.id?document.querySelectorAll('#'+CSS.escape(el.id)).length:0,
        selector:window.__perfkitTargetName(el),isLCP:el===window.__perfkitLCPElement,
        reviewedSelectors:selectors.filter(s=>document.querySelectorAll(s).length===1&&document.querySelector(s)===el),
        attrs:Object.fromEntries(['src','href','rel','as','loading','fetchpriority','width','height','type','defer','async'].filter(k=>el.hasAttribute(k)).map(k=>[k,el.getAttribute(k)])),
        currentSrc:el.currentSrc??el.src??null,naturalWidth:el.naturalWidth??null,naturalHeight:el.naturalHeight??null,
        inPicture:Boolean(el.closest('picture')),rect:{top:r.top,left:r.left,width:r.width,height:r.height},
        viewport:{width:innerWidth,height:innerHeight},display:s.display,position:s.position,
        ...(el.tagName==='DETAILS'?{open:el.open,descendants:el.querySelectorAll('*').length,bodyId:el.querySelector(':scope > div')?.id,
          unsafeContent:Boolean(el.querySelector('script,style,iframe,object,embed,template,noscript'))}: {})};
    })};},config.targetSelectors??[]);
    result.domainTargets=result.domainTargetCoverage.targets;delete result.domainTargetCoverage.targets;
    result.sections=await page.evaluate(()=>[...document.querySelectorAll('[id^="shopify-section-"]')].slice(0,100).map(el=>({id:el.id,idCount:document.querySelectorAll('#'+CSS.escape(el.id)).length,containsLCP:el.contains(window.__perfkitLCPElement),selectors:[el,...el.querySelectorAll('[id]')].slice(0,100).filter(n=>/^[A-Za-z_][\w-]*$/.test(n.id)&&document.querySelectorAll('#'+CSS.escape(n.id)).length===1).map(n=>'#'+n.id)})));
    result.renderResources = await page.evaluate(() => [...document.querySelectorAll('link[rel="stylesheet"], script[src]')].map(el => ({
      url: el.href || el.src, tag: el.tagName.toLowerCase(), blocking: el.getAttribute('blocking'), async: Boolean(el.async), defer: Boolean(el.defer),
      type: el.type, media: el.media || '', inHead: document.head.contains(el) })));
    result.themeId = await page.evaluate(() => window.Shopify?.theme?.id?.toString() ?? null);
    result.finalUrl = page.url(); result.browserVersion = browser.version();
    result.environment={platform:process.platform,arch:process.arch,cpuModel:os.cpus()[0]?.model??'unknown',cpuCount:os.cpus().length,cache:'disabled',serviceWorkers:'blocked'};
    const { profile: navigationProfile } = await cdp.send('Profiler.stop');
    await cdp.send('Profiler.start');
    result.timeOrigin = await page.evaluate(() => performance.timeOrigin);
    result.interactionWindowStartMs = await page.evaluate(() => performance.now());
    const interactionTraceStart=(await cdp.send('Performance.getMetrics')).metrics.find(m=>m.name==='Timestamp')?.value;initialCapture=false;
    for (const action of config.actions) {
      const startedAtMs=await page.evaluate(() => performance.now());
      const target=action.selector?await page.locator(action.selector).evaluate(el=>window.__perfkitTargetName(el)):null;
      if (action.type === 'wait') await page.waitForTimeout(action.ms);
      else if (action.type === 'scroll') await page.evaluate(y => window.scrollTo(0, y), action.y);
      else if (action.type === 'press') await page.locator(action.selector).press(action.key);
      else await page.locator(action.selector)[action.type]();
      const finishedAtMs=await page.evaluate(() => performance.now());
      result.actions.push({ ...action, status: 'completed', target, startedAtMs, finishedAtMs });
    }
    await page.waitForTimeout(config.settleMs);
    result.afterActions = await page.evaluate(() => ({ ...window.__perfkit, fonts: { status: document.fonts.status, entries: [...document.fonts].map(f => ({ family: f.family, status: f.status, display: f.display })) } }));
    result.resourceHealthAfter=await page.evaluate(resourceHealthSnapshot);
    result.interactionWindowEndMs=await page.evaluate(() => performance.now());
    const interactionTraceEnd=(await cdp.send('Performance.getMetrics')).metrics.find(m=>m.name==='Timestamp')?.value;
    result.afterActionsUrl=page.url();
    if(await page.evaluate(() => performance.timeOrigin)!==result.timeOrigin)throw new Error('Interaction actions navigated to another document.');
    result.afterActions.interactions = result.afterActions.interactions.filter(e => e.startTime >= result.interactionWindowStartMs);
    const css = await page.coverage.stopCSSCoverage(), js = await page.coverage.stopJSCoverage();
    result.coverage = { js: js.map(coverageSummary), css: css.map(entry => {
      const summary=coverageSummary(entry); if (!sourceIndex || summary.status !== 'observed') return summary;
      const association=attribution.associateStylesheet(entry.text,sourceIndex,{url:entry.url,ranges:summary.ranges});
      if (!['verified-bytes','verified-ast'].includes(association.source.status)) return {...summary,source:association.source};
      const local=sourceIndex.files.find(f=>f.file===association.source.file);
      const mapped=coverageSummary({url:entry.url,text:local.text,ranges:association.ranges});
      return {...mapped,source:association.source,runtimeSourceHash:summary.sourceHash,runtimeTotalBytes:summary.totalBytes,runtimeUsedBytes:summary.usedBytes};
    }) };
    const { profile } = await cdp.send('Profiler.stop');
    let traceTimer;
    const traceEnded = new Promise((resolve, reject) => { cdp.once('Tracing.tracingComplete', resolve); traceTimer = setTimeout(() => reject(new Error('Trace flush timed out.')), 5000); });
    try { await cdp.send('Tracing.end'); await traceEnded; } finally { clearTimeout(traceTimer); }
    await Promise.all(bodyTasks);
    result.resources.push(...requests.values());
    const frameSource = frame => {
      const script = scripts.get(frame.scriptId); if (!script?.text) return null;
      const inline = script.url === result.finalUrl || script.url === config.url || script.startLine > 0 || script.startColumn > 0;
      return attribution.associateScript(script.text,sourceIndex,{ url: script.url, inline,
        line: Math.max(1,frame.lineNumber-script.startLine+1), column: Math.max(1,frame.columnNumber-(frame.lineNumber === script.startLine ? script.startColumn : 0)+1) });
    };
    for (const r of result.resources) {
      r.initiatorSources=sourceIndex?(r.initiator?.stack?.callFrames??[]).slice(0,10).map(frameSource).filter(Boolean):[];
      r.source = mapRuntimeSource(r.url, r.bodyHash, snapshot);
      const cssSource = result.coverage.css.find(c => c.url === r.url)?.source;
      if (r.type === 'Stylesheet' && ['verified-bytes','verified-ast'].includes(cssSource?.status)) r.source = cssSource;
      const script = [...scripts.values()].find(s => s.url === r.url && s.text);
      if (r.source.status === 'unmapped' && script && r.type === 'Script') r.source = attribution.associateScript(script.text,sourceIndex,{ url: r.url });
    }
    result.cpu = cpuHotspots(navigationProfile, result, sourceIndex ? frameSource : undefined);
    result.compiledAssets=[];let compiledBytes=0;
    if(sourceIndex)for(const script of scripts.values()) {
      if(!script.text||script.text.length>2*1024*1024)continue;
      const mapped=attribution.associateScript(script.text,sourceIndex,{url:script.url});
      if(mapped.scriptKind!=='liquid-asset'||result.compiledAssets.some(e=>e.bodyHash===mapped.bodyHash))continue;
      compiledBytes+=Buffer.byteLength(script.text);if(compiledBytes>8*1024*1024)break;
      result.compiledAssets.push({url:script.url,bodyHash:mapped.bodyHash,text:script.text});
    }
    result.cpuWindow = 'navigation-through-initial-settle';
    result.interactionCpu = cpuHotspots(profile, result, sourceIndex ? frameSource : undefined);
    result.interactionCpuWindow = {
      startMs: result.interactionWindowStartMs,
      endMs: result.interactionWindowEndMs,
      actions: result.actions.map(a => ({ type: a.type, target: a.target, startedAtMs: a.startedAtMs, finishedAtMs: a.finishedAtMs })),
      note: 'Interaction CPU covers the window after initial settle through configured actions; not first-paint TBT.'
    };
    // Identify interaction-triggered scripts (loaded during interaction window)
    const interactionScripts = [...scripts.values()].filter(s => s.text && !result.cpu.some(c => c.scriptId === s.scriptId));
    if (interactionScripts.length) {
      result.interactionScripts = interactionScripts.map(s => ({
        scriptId: s.scriptId, url: s.url, startLine: s.startLine, startColumn: s.startColumn,
        source: sourceIndex ? frameSource({ scriptId: s.scriptId, url: s.url, lineNumber: s.startLine, columnNumber: s.startColumn }) : null
      }));
    }
    if (sourceIndex) result.sourceGraph = attribution.publicSourceIndex(sourceIndex);
    result.trace = { file: 'trace.json', events: trace.length, truncated: traceTruncated };
    const navigationStart=[...requests.values()].find(r=>r.type==='Document'&&r.phase==='initial')?.timestamp;
    const styleEvents=trace.filter(e=>e.name==='UpdateLayoutTree'&&e.ph==='X'&&Number.isFinite(e.dur)
      &&e.ts>=navigationStart*1e6&&e.ts+e.dur<=initialTraceEnd*1e6);
    result.styleCosts={styleRecalcMs:styleEvents.reduce((n,e)=>n+e.dur/1000,0),events:styleEvents.length,
      complete:Number.isFinite(navigationStart)&&Number.isFinite(initialTraceEnd)&&!traceTruncated,
      scope:'instrumented-initial-navigation-not-independent-score'};
    const interactionStyles=trace.filter(e=>e.name==='UpdateLayoutTree'&&e.ph==='X'&&Number.isFinite(e.dur)&&e.ts>=interactionTraceStart*1e6&&e.ts+e.dur<=interactionTraceEnd*1e6);
    result.interactionStyleCosts={styleRecalcMs:interactionStyles.reduce((n,e)=>n+e.dur/1000,0),events:interactionStyles.length,
      complete:Number.isFinite(interactionTraceStart)&&Number.isFinite(interactionTraceEnd)&&!traceTruncated,scope:'configured-action-window-not-field-INP'};
    await writeFile(path.join(out, 'trace.json'), JSON.stringify({ traceEvents: trace }), { flag: 'wx', mode: 0o600 });
    await writeFile(path.join(out, 'cpu.cpuprofile'), JSON.stringify(navigationProfile), { flag: 'wx', mode: 0o600 });
    await writeFile(path.join(out, 'interaction-cpu.cpuprofile'), JSON.stringify(profile), { flag: 'wx', mode: 0o600 });
    const current = config.project ? await sourceSnapshot(config.project) : null;
    result.sourceStable = !snapshot || (snapshot.complete && current.complete && current.hash === snapshot.hash);
    result.status = result.errors.length || !result.sourceStable || traceTruncated ? 'review-required' : 'complete';
    if (config.expectedThemeId !== undefined && String(config.expectedThemeId) !== result.themeId) { result.status = 'identity-mismatch'; result.errors.push('Rendered Shopify theme ID differs from expectedThemeId.'); }
  } catch (error) { result.status = 'failed'; result.errors.push(error.message); }
  finally { clearTimeout(timer); if (browser) await browser.close().catch(() => {}); }
  result.finishedAt=new Date().toISOString();
  result.evidence=evidenceEnvelope({type:'runtime',input:{config:result.config,createdAt:result.createdAt,snapshot:result.snapshot?.hash},scope:'instrumented-laboratory',sourceHash:result.snapshot?.hash??null,
    environment:{browserVersion:result.browserVersion??null,device:config.device,cache:'disabled',serviceWorkers:'blocked'}});
  await writeFile(path.join(out, 'profile.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return result;
}
