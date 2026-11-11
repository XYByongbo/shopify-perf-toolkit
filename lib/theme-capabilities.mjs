import {indexThemeSources,publicSourceIndex} from './source-attribution.mjs';
import {sourceSnapshot} from './theme-source.mjs';
import {fields,digest} from './evidence-contract.mjs';
import {canonical} from './core/plan-utils.mjs';

const states=new Set(['verified','absent','unknown']);
const keys=['rendering','resources','lifecycle','business','ownership'];
const hash=/^[a-f0-9]{64}$/;
const text=v=>typeof v==='string'&&v.trim().length>0&&v.length<=2000;
/** Static clues identify investigation entry points, never verified runtime capability. */
export async function inspectThemeCapabilities({project,identity={},context={}}={}){
  fields(identity,['store','themeId','vendor','version'],'theme identity');
  fields(context,['appRevision','generatorRevision','configurationRevision'],'external context');
  if(Object.values({...identity,...context}).some(v=>!text(v)))throw new Error('Identity/context values must be nonempty strings.');
  const index=await indexThemeSources(project),graph=publicSourceIndex(index);
  const clues={jsonTemplates:graph.files.filter(f=>/^templates\/.+\.json$/.test(f.file)).map(f=>f.file),
    themeBlocks:graph.files.filter(f=>f.file.startsWith('blocks/')).map(f=>f.file),
    jquery:index.files.filter(f=>/jQuery|\$\(document\)/.test(f.text)).map(f=>f.file),
    generators:index.files.filter(f=>/pagefly|gempages|shogun/i.test(f.text)).map(f=>f.file)};
  return {schemaVersion:1,kind:'theme-capabilities',sourceHash:graph.sourceHash,identity,context,
    contextHash:digest(canonical(context)),graph,clues,
    capabilities:Object.fromEntries(keys.map(k=>[k,{status:'unknown',evidence:[]} ])),
    status:'diagnostic-only',note:'Clues are not lifecycle, ownership, business or compatibility proof.'};
}
export function validateAdapter(adapter){
  fields(adapter,['schemaVersion','id','version','identity','sourceHash','context','capabilities','strategies','coverage'],'theme adapter');
  if(adapter.schemaVersion!==1||!text(adapter.id)||!text(adapter.version)||!hash.test(adapter.sourceHash??''))throw new Error('Invalid adapter identity.');
  fields(adapter.identity,['store','themeId','vendor','version'],'adapter identity');
  if(!text(adapter.identity.store)||!text(adapter.identity.themeId)||!text(adapter.identity.version))throw new Error('Adapter needs store, themeId and version.');
  fields(adapter.context,['appRevision','generatorRevision','configurationRevision'],'adapter context');
  if(Object.values(adapter.context).some(v=>!text(v)))throw new Error('Invalid adapter context.');
  fields(adapter.capabilities,keys,'adapter capabilities');
  for(const key of keys){
    const cap=adapter.capabilities[key];fields(cap,['status','evidence','contract'],`capability ${key}`);
    if(!states.has(cap.status)||!Array.isArray(cap.evidence)||cap.evidence.length>100)throw new Error('Invalid capability state/evidence.');
    if(cap.status!=='unknown'&&(!cap.evidence.length||!text(cap.contract)))throw new Error('Known capability requires evidence and a concrete contract.');
    for(const e of cap.evidence){fields(e,['file','sourceHash','reason'],'capability evidence');if(!text(e.file)||!hash.test(e.sourceHash??'')||!text(e.reason))throw new Error('Invalid capability source reference.');}
  }
  if(!Array.isArray(adapter.strategies)||adapter.strategies.length>100||new Set(adapter.strategies.map(s=>s.id)).size!==adapter.strategies.length)throw new Error('Invalid strategy list.');
  for(const s of adapter.strategies){fields(s,['id','requires','protectedFiles','reason'],'adapter strategy');
    if(!text(s.id)||!text(s.reason)||!Array.isArray(s.requires)||!s.requires.length||s.requires.some(k=>!keys.includes(k))||!Array.isArray(s.protectedFiles)||s.protectedFiles.some(f=>!text(f)))throw new Error('Invalid strategy contract.');}
  if(!Array.isArray(adapter.coverage)||adapter.coverage.some(c=>!text(c)))throw new Error('Coverage must explicitly list verified scopes.');
  return adapter;
}
export async function resolveThemeAdapter({project,adapter,identity,context,strategy,targets=[]}={}){
  validateAdapter(adapter);
  const snapshot=await sourceSnapshot(project),reasons=[];
  if(!snapshot.complete||snapshot.hash!==adapter.sourceHash)reasons.push('source-changed');
  if(canonical(identity)!==canonical(adapter.identity))reasons.push('theme-identity-changed');
  if(canonical(context)!==canonical(adapter.context))reasons.push('external-context-changed');
  for(const cap of Object.values(adapter.capabilities))for(const e of cap.evidence)
    if(!snapshot.files.some(f=>f.file===e.file&&f.sourceHash===e.sourceHash))reasons.push('capability-evidence-stale');
  const selected=adapter.strategies.find(s=>s.id===strategy);
  if(!selected)reasons.push('strategy-not-declared');
  else {
    for(const key of selected.requires)if(adapter.capabilities[key].status!=='verified')reasons.push(`capability-${key}-${adapter.capabilities[key].status}`);
    if(targets.some(f=>selected.protectedFiles.includes(f)))reasons.push('protected-target');
  }
  return {schemaVersion:1,kind:'adapter-resolution',status:reasons.length?'rejected':'compatible-for-declared-strategy',
    adapter:{id:adapter.id,version:adapter.version,hash:digest(canonical(adapter))},sourceHash:snapshot.hash,strategy,coverage:adapter.coverage,reasons:[...new Set(reasons)],
    acceptance:'not-evaluated'};
}
export async function resolveAdapterRegistry({project,adapters,identity,context,strategy,targets=[]}){
  if(!Array.isArray(adapters)||!adapters.length||adapters.length>50)throw new Error('Registry needs 1–50 explicit adapters.');
  if(new Set(adapters.map(a=>a.id+'@'+a.version)).size!==adapters.length)throw new Error('Duplicate adapter versions.');
  const resolutions=[];for(const adapter of adapters)resolutions.push(await resolveThemeAdapter({project,adapter,identity,context,strategy,targets}));
  const matched=resolutions.filter(r=>r.status==='compatible-for-declared-strategy');
  return {schemaVersion:1,kind:'adapter-registry-resolution',status:matched.length===1?'selected':matched.length?'ambiguous':'rejected',selected:matched.length===1?matched[0]:null,resolutions};
}

/** Recompute formal binding from the original manifest, not the stored resolution flag. */
export function checkAdapterPlanBinding(plan,before,after,manifest){
  try{
    const binding=plan?.adapter;if(!binding)return false;
    const a=validateAdapter(binding.adapter),strategy=a.strategies.find(s=>s.id===binding.strategy);
    return a.sourceHash===before.sourceHash&&a.identity.store===before.store&&a.identity.store===after.store
      &&String(a.identity.themeId)===String(after.themeId)&&canonical(binding.identity)===canonical(a.identity)
      &&canonical(binding.context)===canonical(a.context)&&Boolean(strategy)
      &&strategy.requires.every(k=>a.capabilities[k].status==='verified')
      &&plan.changes.every(c=>!strategy.protectedFiles.includes(c.target))
      &&Object.values(a.capabilities).every(c=>c.evidence.every(e=>manifest.some(f=>f.file===e.file&&f.sourceHash===e.sourceHash)));
  }catch{return false;}
}
