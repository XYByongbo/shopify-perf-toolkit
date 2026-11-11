/** Opt-in adapter primitives. Integrators supply the theme's actual contracts. No auto-install. */
export function instanceLifecycle({mount,unmount}) {
  const instances=new WeakMap();
  return {
    async mount(element){
      if(instances.has(element))return instances.get(element).ready;
      const state={controller:new AbortController(),disposed:false};instances.set(element,state);
      state.ready=Promise.resolve().then(()=>mount(element,state.controller.signal)).then(async value=>{
        state.value=value;if(state.disposed)await unmount(element,value);return value;
      }).catch(error=>{if(instances.get(element)===state)instances.delete(element);throw error;});
      return state.ready;
    },
    async unmount(element){
      const state=instances.get(element);if(!state)return;
      instances.delete(element);state.disposed=true;state.controller.abort();
      // A pending mount cleans itself up after resolving. Do not destroy a new instance.
      if(Object.hasOwn(state,'value'))await unmount(element,state.value);
    }
  };
}

/** Preserve stylesheet-subsetting output when replacing only a section's contents. */
export function replaceSectionContents(container,html,{selector,destroy=()=>{},initialize=()=>{}}={}){
  if(!container?.isConnected||typeof html!=='string'||!selector)throw new Error('Connected target, HTML and explicit section selector required.');
  const template=container.ownerDocument.createElement('template');template.innerHTML=html;
  const matches=template.content.querySelectorAll(selector);
  if(matches.length!==1)throw new Error('Section response must have one matching target.');
  const next=matches[0];
  const styles=[...template.content.querySelectorAll('style[data-section-stylesheet]')].filter(s=>!next.contains(s));
  const old=[...container.childNodes],focus=container.contains(container.ownerDocument.activeElement)?container.ownerDocument.activeElement?.id:null;
  const rollback=()=>{destroy(container);container.replaceChildren(...old);initialize(container);};
  destroy(container);
  try {
    // Scripts remain inert; the owning adapter must initialize explicitly, once per instance.
    container.replaceChildren(...styles.map(s=>s.cloneNode(true)),...next.childNodes);
    initialize(container);
    if(focus){const target=[...container.querySelectorAll('[id]')].find(e=>e.id===focus);target?.focus();}
  }catch(error){rollback();throw error;}
  return rollback;
}

/** Serial, idempotent while pending; uncertain writes are reconciled, never retried. */
export function cartMutationQueue({request,readCart,render,recover,onSuccess=()=>{},sections,routeRoot='/'}){
  if(!Array.isArray(sections)||!sections.length||sections.length>5||new Set(sections).size!==sections.length||sections.some(s=>typeof s!=='string'||!s))throw new Error('One to five unique section IDs required.');
  if(!/^\/(?:[\w-]+\/)*$/.test(routeRoot)||![request,readCart,render,recover].every(f=>typeof f==='function'))throw new Error('Explicit locale route and cart adapters required.');
  let tail=Promise.resolve();const pending=new Map();
  return function mutate({operationId,operation,payload,sectionsUrl}){
    if(!operationId||!['add','change','update','clear'].includes(operation)||!payload||typeof payload!=='object'||Array.isArray(payload))return Promise.reject(new Error('Explicit operation and payload required.'));
    if(typeof sectionsUrl!=='string'||!sectionsUrl.startsWith('/')||sectionsUrl.startsWith('//'))return Promise.reject(new Error('Same-site sections_url required.'));
    const signature=JSON.stringify({operation,payload,sectionsUrl});
    if(pending.has(operationId)){const prior=pending.get(operationId);return prior.signature===signature?prior.promise:Promise.reject(new Error('Pending operation ID has different payload.'));}
    const promise=tail.then(async()=>{
      let response;
      try{response=await request(`${routeRoot}cart/${operation}.js`,{...payload,sections,sections_url:sectionsUrl});}
      catch(error){const cart=await readCart();await recover(cart);throw Object.assign(error,{cart,reconciled:true,writeOutcome:'unknown'});}
      const cart=await readCart();
      if(!response||response.status<200||response.status>=300){await recover(cart);throw Object.assign(new Error('Cart mutation response unsuccessful; state reconciled without retry.'),{cart,writeOutcome:'unknown'});}
      const rendered=response.body?.sections;
      if(!rendered||sections.some(id=>typeof rendered[id]!=='string'||!rendered[id].trim()))await recover(cart);
      else {try{await render(rendered,cart);}catch{await recover(cart);}}
      await onSuccess({operationId,operation,cart});return cart;
    });
    pending.set(operationId,{signature,promise});tail=promise.catch(()=>{});
    promise.finally(()=>pending.delete(operationId)).catch(()=>{});return promise;
  };
}
