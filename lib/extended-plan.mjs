import {parse} from 'acorn';
import {sourceSnapshot,sha256} from './runtime-profile.mjs';
import {readTarget} from './changes.mjs';
import {requireHypothesis} from './bottlenecks.mjs';
import {createSitePlan} from './site-changes.mjs';
import {queryPatch,hiddenTargets,fetchTargets,extendedContracts} from './extended-methods.mjs';
import {hiddenRuntime,hiddenDetachRuntime,scopedSectionFetch} from './extended-runtime.mjs';
import {liquidAST} from './advanced-strategies.mjs';
import {prepareInitialLiquid,inlineInitialController,checkControllerOwnership} from './section-liquid.mjs';
import {managedSectionController} from './section-controller.mjs';
import {permitsBareInline} from './section-csp.mjs';
const fail=(message,code='UNSUPPORTED_CODE_PATTERN')=>{throw Object.assign(new Error(message),{code});};
export async function createExtendedPlan({project,diagnosis,config}) {
  const snapshot=await sourceSnapshot(project),c=requireHypothesis(diagnosis,config.candidateId,snapshot),contract=extendedContracts[config.method];
  if(!contract||!c.methods?.includes(config.method))fail('Implementation does not belong to the measured hypothesis.');
  if(!config.review?.summary?.trim())fail('Concrete source/behavior review is required.','REVIEW_REQUIRED');
  for(const key of contract.review)if(config.review[key]!==true)fail(`Review requires ${key}.`,'REVIEW_REQUIRED');
  const {source}=await readTarget(project,c.file),offset=c.binding.offset;
  const evidence={...config.review,sourceHash:sha256(source),candidateId:c.candidateId,diagnosisSourceHash:snapshot.hash,
    domainKind:c.kind,domainMethod:config.method,domainPage:c.page,domainTarget:c.data.target?.id??null};
  let after,asset,liquidChange;
  if(c.kind==='liquid-query') {
    after=queryPatch(source,offset,config.method,{files:c.domainEvidence.dependencyFiles??[]});
    evidence.paginationPagesRequired=config.method==='query-paginate'?[1,2]:[];
    evidence.queryContract={selector:'body',dependencies:(c.domainEvidence.dependencyFiles??[]).map(({file,sourceHash})=>({file,sourceHash}))};
  }else if(c.kind==='hidden-dom') {
    const n=hiddenTargets(source).find(n=>n.offset===offset);if(!n)fail('Hidden component source changed.');
    const inner=source.slice(n.body.blockStartPosition.end,n.body.blockEndPosition.start),key='perfkit_hidden_'+sha256(source+offset).slice(0,12);
    if(source.includes(key))fail('Generated Liquid variable collides with existing source.');
    evidence.hiddenContract={summarySelector:'#'+n.id+' > summary',bodySelector:'#'+n.bodyId};
    if(config.method==='hidden-detach') {
      if(c.data.securityPolicy?.complete!==true)fail('Recapture CSP evidence before generating an inline hidden controller.','CSP_EVIDENCE_REQUIRED');
      if(!permitsBareInline(c.data.securityPolicy))fail('Observed CSP blocks the inline hidden controller.','CSP_INLINE_BLOCKED');
      evidence.hiddenContract.mechanism={kind:'dom-parking',key,initialDescendants:c.data.target.descendants};
      const js=`(${hiddenDetachRuntime.toString()})(${JSON.stringify(n.id)},${JSON.stringify(n.bodyId)},${JSON.stringify(key)});`;
      parse(js,{ecmaVersion:'latest'});
      // Run immediately after the closed disclosure, before later DOM-scanning theme scripts.
      after=source.slice(0,n.node.position.end)+`\n<script>${js}</script>\n`+source.slice(n.node.position.end);
    }else {
    if(!/^assets\/[a-z][a-z0-9-]*\.js$/.test(config.newAsset??''))fail('newAsset must be a new assets/name.js.');
    if(snapshot.files.some(f=>f.file===config.newAsset))fail('Runtime asset already exists.');
    const replacement=`{% capture ${key} %}${inner}{% endcapture %}<template data-perfkit-content>${'{{ '+key+' }}'}</template><noscript>${'{{ '+key+' }}'}</noscript>`;
    after=source.slice(0,n.body.blockStartPosition.end)+replacement+source.slice(n.body.blockEndPosition.start);
    const name=config.newAsset.slice(7);
    after+=`\n<script src="{{ '${name}' | asset_url }}" defer></script>\n`;
    asset={target:config.newAsset,kind:'create-asset',replacementText:`(${hiddenRuntime.toString()})(${JSON.stringify(n.id)},${JSON.stringify(n.bodyId)},${config.method==='hidden-template-chunked'},${JSON.stringify(key)});\n`,reason:'Hydrate the existing native disclosure, preserving its first open and no-JS fallback.',evidence:{...evidence,sourceHash:null}};
    asset.evidence.hiddenContract=evidence.hiddenContract;
    parse(asset.replacementText,{ecmaVersion:'latest'});
    }
    liquidAST(after);
  }else if(c.kind==='section-fetch') {
    const n=fetchTargets(source).find(n=>n.offset===offset);if(!n)fail('Measured native fetch call changed.');
    const selector=config.sectionSelector;
    if(!/^#[A-Za-z_][\w-]*$/.test(selector??'')||!c.data.sections?.some(s=>s.selectors?.includes(selector)))fail('Select one captured real Shopify section wrapper.');
    let initial=config.method.startsWith('section-liquid-')?await prepareInitialLiquid({project,source,fetchOffset:offset,selector,config:config.initialLiquid}):null;
    const replacement=`(${scopedSectionFetch.toString()})(${n.argument},${JSON.stringify(selector)},${config.method==='section-fetch-json'},${JSON.stringify(initial?.contract.legacyView??null)})`;
    const edits=[{start:n.offset,end:n.end,text:replacement},...(initial?[{...initial.startup,text:''}]:[])];
    after=source;for(const edit of edits.sort((a,b)=>b.start-a.start))after=after.slice(0,edit.start)+edit.text+after.slice(edit.end);
    parse(after,{ecmaVersion:'latest',sourceType:'module'});
    if(config.method==='section-liquid-inline') {
      if(c.data.securityPolicy?.complete!==true)fail('Recapture the deployment-bound runtime profile with CSP headers and meta policies.','CSP_EVIDENCE_REQUIRED');
      if(!permitsBareInline(c.data.securityPolicy))fail('Observed CSP does not allow a new bare inline controller; keep the external-controller method.','CSP_INLINE_BLOCKED');
      initial=await inlineInitialController({project,snapshot,file:c.file,source,controller:after,initial});after=initial.assetAfter;
      initial.contract.inlineController.securityPolicy=c.data.securityPolicy;
    }else if(initial) {
      await checkControllerOwnership({project,snapshot,file:c.file,source,initial});
      const managed=managedSectionController({source,controller:after,startup:initial.startup,selector,file:c.file});after=managed.script;
      initial.contract.controllerLifecycle={key:managed.key,signature:managed.signature};
    }
    evidence.sectionFetchContract={sectionSelector:selector,requestUrl:c.data.resourceUrl};
    if(initial){
      const expected=new URL(c.data.resourceUrl),update=new URL(initial.contract.update.requestUrl);
      if(update.origin!==expected.origin||update.pathname!==expected.pathname)fail('Dynamic update must stay on the measured page route.');
      if(initial.contract.legacyView&&expected.searchParams.get('view')!==initial.contract.legacyView)fail('legacyView must match the observed initial Ajax request.');
      evidence.initialLiquidContract={...initial.contract,initialRequestUrl:c.data.resourceUrl};
      liquidChange={target:initial.targetFile,kind:'reviewed-replacement',replacementText:initial.after,
        reason:'Render the existing snippet in the initial Liquid response; retain Section API for dynamic updates.',evidence:{...evidence,sourceHash:sha256(initial.targetSource)}};
    }
  }else fail('Unsupported extended hypothesis.');
  const changes=[{target:c.file,kind:'reviewed-replacement',replacementText:after,reason:`${config.method}: ${c.evidence}`,evidence},...(asset?[asset]:[]),...(liquidChange?[liquidChange]:[])];
  return createSitePlan({project,recipe:{schemaVersion:1,changes},metadata:{domainKind:c.kind,method:config.method,
    readOnlyDependencies:(c.domainEvidence.dependencyFiles??[]).map(({file,sourceHash})=>({file,sourceHash})),verificationRequired:[
    'Independent performance samples; no regression and original score thresholds.',
    ...(c.kind==='liquid-query'?['Independent raw Liquid profiles and unchanged query output.',...(config.method==='query-paginate'?['Page 1/page 2 preservation.']:[])]:[]),
    ...(c.kind==='hidden-dom'?['First open and repeated close/open, keyboard, no-JS, editor reload and full opened-content checkpoint.']:[]),
    ...(c.kind==='section-fetch'?['Same section content/parameters and real section resource response; timeout/null/error falls back to original full-page fetch.']:[])]}});
}
