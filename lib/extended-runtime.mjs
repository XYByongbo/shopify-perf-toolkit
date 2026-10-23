/** Inline progressive enhancement: retain one HTML copy and move original nodes, never clone. */
export function hiddenDetachRuntime(id,bodyId,key) {
  const marker=Symbol.for(key);
  if(document[marker]){document[marker]();return;}
  const parked=new WeakMap(),seen=new WeakSet();
  const bodyOf=details=>details?.id===id&&document.querySelectorAll('#'+CSS.escape(id)).length===1
    ?details.querySelector(':scope > #'+CSS.escape(bodyId)):null;
  const restore=details=>{
    const body=bodyOf(details),fragment=body&&parked.get(body);
    if(fragment){body.append(fragment);parked.delete(body);}
  };
  const initialize=()=>{
    const details=document.getElementById(id),body=bodyOf(details);
    if(!body||details.open||seen.has(body))return;
    seen.add(body);
    const fragment=document.createDocumentFragment();
    while(body.firstChild)fragment.append(body.firstChild);
    parked.set(body,fragment);
  };
  const activate=event=>{
    const summary=event.target.closest?.('summary');
    if(summary?.parentElement?.tagName==='DETAILS'&&(event.type==='click'||['Enter',' '].includes(event.key)))restore(summary.parentElement);
  };
  document.addEventListener('click',activate,true);
  document.addEventListener('keydown',activate,true);
  document.addEventListener('toggle',event=>{if(event.target.open)restore(event.target);},true);
  document.addEventListener('shopify:section:load',initialize);
  document[marker]=initialize;initialize();
}

/** Legacy template strategies kept for explicit comparison, not independent initial-load hypotheses. */
export function hiddenRuntime(id,bodyId,chunked,key) {
  const marker=Symbol.for(key);
  if(document[marker])return;document[marker]=true;
  const pending=new WeakMap();
  const hydrate=details=>{
    if(details?.id!==id||document.querySelectorAll('#'+CSS.escape(id)).length!==1)return;
    const body=details.querySelector('#'+CSS.escape(bodyId));
    const template=body?.querySelector(':scope > template[data-perfkit-content]');
    if(!template||pending.has(body))return pending.get(body);
    const work=(async()=>{
      // Move nodes out of the inert template. Interrupted chunking can resume without
      // cloning already inserted children or permanently keeping a settled pending promise.
      const fragment=template.content;
      if(!chunked)body.insertBefore(fragment,template);
      else {
        let count=0;
        while(fragment.firstChild){
          if(!body.isConnected)return;
          body.insertBefore(fragment.firstChild,template);
          if(++count%32===0)await(globalThis.scheduler?.yield?.()??new Promise(resolve=>setTimeout(resolve,0)));
        }
      }
      template.remove();body.querySelector(':scope > noscript')?.remove();
    })();
    pending.set(body,work);work.then(()=>pending.delete(body),()=>pending.delete(body));return work;
  };
  const activate=event=>{
    const summary=event.target.closest?.('summary');
    const details=summary?.parentElement;
    if(details?.tagName==='DETAILS'&&(event.type==='click'||['Enter',' '].includes(event.key)))hydrate(details);
  };
  document.addEventListener('click',activate,true);
  document.addEventListener('keydown',activate,true);
  document.addEventListener('toggle',event=>{if(event.target.open)hydrate(event.target);},true);
  const resume=()=>document.querySelectorAll('details[open]').forEach(hydrate);
  document.addEventListener('shopify:section:load',resume);resume();
}

/** Keep the caller's text/DOMParser workflow and one-shot Response semantics. */
export async function scopedSectionFetch(input,selector,jsonMode,legacyView,signal) {
  const original=()=>signal?.aborted?null:signal?globalThis.fetch(input,{signal}):globalThis.fetch(input);
  if(typeof input!=='string'&&!(input instanceof globalThis.URL))return original();
  const url=new globalThis.URL(input,globalThis.location.href);
  const roots=globalThis.document.querySelectorAll(selector),root=roots[0]?.closest('[id^="shopify-section-"]');
  if(url.origin!==globalThis.location.origin||url.username||url.password||url.searchParams.has('sections')||url.searchParams.has('section_id')
    ||roots.length!==1||!root||!root.id.startsWith('shopify-section-'))return original();
  const id=root.id.slice('shopify-section-'.length);
  if(!/^[\w-]+$/.test(id)||globalThis.document.querySelectorAll('#'+globalThis.CSS.escape(root.id)).length!==1)return original();
  // Dynamic updates use the current template's section/settings. The original
  // alternate view remains intact for the full-page failure fallback.
  if(legacyView&&url.searchParams.get('view')===legacyView)url.searchParams.delete('view');
  url.searchParams.set(jsonMode?'sections':'section_id',id);
  const controller=new globalThis.AbortController(),timer=globalThis.setTimeout(()=>controller.abort(),5000);
  const cancel=()=>controller.abort();
  if(signal?.aborted){globalThis.clearTimeout(timer);return null;}
  signal?.addEventListener('abort',cancel,{once:true});
  try {
    const response=await globalThis.fetch(url.href,{signal:controller.signal});
    if(!response.ok||response.redirected||new globalThis.URL(response.url).origin!==url.origin)throw new Error('Section response unavailable');
    const copy=response.clone();
    const html=jsonMode?(await copy.json())[id]:await copy.text();
    if(typeof html!=='string'||!html.trim())throw new Error('Section response is empty');
    const doc=new globalThis.DOMParser().parseFromString(html,'text/html');
    if(doc.querySelectorAll('#'+globalThis.CSS.escape(root.id)).length!==1)throw new Error('Section identity mismatch');
    if(!jsonMode)return response;
    return new globalThis.Response(html,{status:200,headers:{'content-type':'text/html; charset=utf-8'}});
  } catch {
    return signal?.aborted?null:original();
  } finally {globalThis.clearTimeout(timer);signal?.removeEventListener('abort',cancel);}
}
