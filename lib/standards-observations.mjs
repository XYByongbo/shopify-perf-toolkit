import {withStandardRules} from './standards-registry.mjs';

const definitions=[
  ['PERF_IMAGE_PRIORITY_COUNT','Multiple high priority images','PERF-IMG-03'],
  ['PERF_IMAGE_SIZES_MISMATCH','Declared versus rendered image width','PERF-IMG-08'],
  ['PERF_HIDDEN_IMAGE_DOWNLOAD','Hidden image downloads','PERF-IMG-09'],
  ['PERF_IMAGE_DIMENSIONS','Image dimension declarations','PERF-IMG-10'],
  ['PERF_DUPLICATE_STYLESHEET','Duplicate active stylesheet references','PERF-CSS-04'],
  ['PERF_HEAD_BLOCKING_SCRIPT','Synchronous scripts in settled head','PERF-JS-01'],
  ['PERF_MOBILE_OVERFLOW','Narrow viewport overflow','PERF-MOB-03'],
  ['PERF_VIEWPORT_META','Viewport declaration','PERF-MOB-06'],
];
export const observationRules=definitions.map(([id,title])=>({id,title,phase:'standards-v1',runtimeSupported:true,
  staticScope:'not-applicable-runtime-only',source:'https://shopify.dev/docs/storefronts/themes/best-practices/performance/'}));

/** Serialized into the page. This is a bounded settled-DOM observation, never an initial-response claim. */
export function collectStandardsDOM(){
  const select=el=>window.__perfkitTargetName(el);
  const images=[...document.images],links=[...document.querySelectorAll('link[rel~="stylesheet"]')],scripts=[...document.head.querySelectorAll('script[src]')];
  const downloaded=new Set(performance.getEntriesByType('resource').filter(r=>r.initiatorType==='img').map(r=>r.name));
  return {version:1,phase:'initial-settled-dom',capturedAtMs:performance.now(),url:location.href,
    width:document.documentElement.clientWidth,documentWidth:Math.max(document.documentElement.scrollWidth,document.body?.scrollWidth??0),
    viewport:[...document.querySelectorAll('meta[name="viewport" i]')].map(el=>el.content),
    truncated:images.length>500||links.length>500||scripts.length>500,
    images:images.slice(0,500).map(el=>{
      const box=el.getBoundingClientRect();let hidden=false;
      for(let p=el;p;p=p.parentElement){const s=getComputedStyle(p);if(s.display==='none'||['hidden','collapse'].includes(s.visibility)||Number(s.opacity)===0)hidden=true;}
      const size=el.sizes.trim().match(/^(\d+(?:\.\d+)?)(px|vw)$/);
      return {selector:select(el),src:el.currentSrc||el.src,loading:el.loading,priority:el.fetchPriority,width:box.width,height:box.height,
        declaredWidth:el.getAttribute('width'),declaredHeight:el.getAttribute('height'),sizes:el.sizes,
        declaredSizePx:size?Number(size[1])*(size[2]==='vw'?document.documentElement.clientWidth/100:1):null,
        hidden,downloaded:downloaded.has(el.currentSrc||el.src),carouselCandidate:Boolean(el.closest('[aria-roledescription="carousel"],[data-carousel],.swiper,.slick-slider'))};
    }),
    stylesheets:links.slice(0,500).map(el=>({selector:select(el),href:el.href,media:el.media,active:!el.disabled&&(!el.media||matchMedia(el.media).matches)})),
    scripts:scripts.slice(0,500).map(el=>({selector:select(el),src:el.src,type:el.type.toLowerCase(),async:el.async,defer:el.defer,noModule:el.noModule})),
  };
}

export function inspectStandardsDOM(profile,profileIndex=0){
  const d=profile.initial?.standardsDOM,findings=[],checks=[];
  const base={profileIndex,evidenceLevel:'E2',page:profile.config?.url,device:profile.config?.device,scope:'single settled DOM snapshot; not initial HTML or field CWV'};
  const complete=d?.version===1&&d.phase==='initial-settled-dom'&&d.truncated===false&&Number.isFinite(d.width)&&d.width>0
    &&Number.isFinite(d.documentWidth)&&d.documentWidth>=0&&['images','stylesheets','scripts','viewport'].every(k=>Array.isArray(d[k])&&d[k].length<=500)
    &&d.images.every(i=>i&&typeof i.selector==='string'&&Number.isFinite(i.width)&&Number.isFinite(i.height)&&typeof i.sizes==='string'&&typeof i.hidden==='boolean'&&typeof i.downloaded==='boolean'&&typeof i.carouselCandidate==='boolean')
    &&d.stylesheets.every(l=>l&&typeof l.href==='string'&&typeof l.media==='string'&&typeof l.active==='boolean')
    &&d.scripts.every(s=>s&&typeof s.type==='string'&&typeof s.async==='boolean'&&typeof s.defer==='boolean'&&typeof s.noModule==='boolean')
    &&d.viewport.every(v=>typeof v==='string');
  if(!complete)return {findings,checks:definitions.map(([id])=>({...base,...withStandardRules({id}),status:'NOT RUN',executed:false,reason:'Bounded settled-DOM evidence missing, truncated or invalid; recapture.'}))};
  const record=(ruleId,rows,{confirmed=false,reason=null,notApplicable=false}={})=>{
    const status=notApplicable?'N/A':rows.length?'FAIL':'PASS';
    checks.push({...base,...withStandardRules({id:ruleId}),status,executed:!notApplicable,reason:reason??'Inspection of the captured DOM only; candidate conditions require review.',reviewRequired:rows.length>0&&!confirmed});
    for(const [n,row] of rows.entries())findings.push(withStandardRules({id:`runtime:${profileIndex}:${ruleId}:${n}`,ruleId,
      dimension:'performance',status:confirmed?'observed':'candidate',checkStatus:confirmed?'FAIL':undefined,priority:'P1',file:null,line:null,
      summary:observationRules.find(r=>r.id===ruleId).title,sourceAssociation:'requires-rendered-source-review',
      evidence:[{...base,...row}],verification:['Map the observed element to current source and inspect all affected states.','Compare independent measurements; this observation alone does not prove performance savings.']}));
  };
  const high=d.images.filter(i=>i.priority==='high');record('PERF_IMAGE_PRIORITY_COUNT',high.length>1?high:[]);
  record('PERF_IMAGE_SIZES_MISMATCH',d.images.filter(i=>Number.isFinite(i.declaredSizePx)&&i.declaredSizePx>0&&i.width>0&&(i.declaredSizePx/i.width>2||i.width/i.declaredSizePx>2)));
  // Complex sizes cannot be evaluated here. Do not turn unsupported syntax into a PASS.
  if(d.images.some(i=>i.sizes&&i.declaredSizePx===null)){const c=checks.at(-1);if(c.status==='PASS'){c.status='NOT RUN';c.executed=false;}c.reason='Complex sizes expressions need browser/source-size review; only literal px/vw were evaluated.';}
  record('PERF_HIDDEN_IMAGE_DOWNLOAD',d.images.filter(i=>i.hidden&&i.downloaded&&!i.carouselCandidate));
  record('PERF_IMAGE_DIMENSIONS',d.images.filter(i=>!i.declaredWidth||!i.declaredHeight),{reason:'Missing attributes require CSS aspect-ratio/reserved-space review; not proof of CLS.'});
  const groups=new Map();for(const link of d.stylesheets.filter(l=>l.active)){const key=JSON.stringify([link.href,link.media]);if(!groups.has(key))groups.set(key,[]);groups.get(key).push(link);}
  record('PERF_DUPLICATE_STYLESHEET',[...groups.values()].filter(g=>g.length>1).map(links=>({links})),{confirmed:true});
  record('PERF_HEAD_BLOCKING_SCRIPT',d.scripts.filter(s=>['','text/javascript','application/javascript'].includes(s.type)&&!s.async&&!s.defer&&!s.noModule),{reason:'Settled DOM cannot prove parser insertion or original response ordering; confirm against initial HTML.'});
  record('PERF_MOBILE_OVERFLOW',d.width<=768&&d.documentWidth>d.width+1?[{viewportWidth:d.width,documentWidth:d.documentWidth}]:[],{confirmed:true,notApplicable:d.width>768,reason:d.width>768?'Captured viewport exceeds 768 CSS px.':'Observed document width must not exceed narrow viewport by more than one CSS px.'});
  record('PERF_VIEWPORT_META',d.viewport.length?[]:[{viewport:null}],{confirmed:true});
  return {findings,checks};
}
