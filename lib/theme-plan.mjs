import {sourceSnapshot,sha256} from './runtime-profile.mjs';
import {requireHypothesis} from './bottlenecks.mjs';
import {createSitePlan} from './site-changes.mjs';
import {readTarget} from './changes.mjs';
import {themeContracts,stylesheetOncePatch,collapseForwarder} from './theme-methods.mjs';

export async function createThemePlan({project,diagnosis,config}) {
  const snapshot=await sourceSnapshot(project),c=requireHypothesis(diagnosis,config.candidateId,snapshot),contract=themeContracts[config.method];
  if(!contract||!c.methods?.includes(config.method))throw new Error('Method does not belong to the measured theme hypothesis.');
  if(!config.review?.summary?.trim()||contract.review.some(k=>config.review[k]!==true))throw new Error('Concrete method-specific source and behavior review is required.');
  const inputs=c.domainEvidence.dependencyFiles??[];
  for(const f of inputs)if(sha256((await readTarget(project,f.file)).source)!==f.sourceHash)throw new Error('Theme dependency changed.');
  const {source}=await readTarget(project,c.file),offset=c.binding.offset;
  const themeOptimization={method:config.method,file:c.file,offset,inputs};
  let changes;
  if(config.method==='stylesheet-once') {
    const generated=stylesheetOncePatch(c.file,source,offset,inputs);
    themeOptimization.resourceDelta={kind:'stylesheet-once',selector:c.data.measured.rootSelector,href:c.data.measured.href,
      beforeCount:c.data.measured.count,afterCount:1,asset:generated.target.asset};
    changes=[{target:c.file,after:generated.caller},{target:generated.target.snippet,after:generated.snippet}];
  }else changes=[{target:c.file,after:collapseForwarder(source,offset,inputs)}];
  const evidence={...config.review,candidateId:c.candidateId,diagnosisSourceHash:snapshot.hash,domainKind:c.kind,domainMethod:config.method,domainPage:c.page,themeOptimization};
  const recipe={schemaVersion:1,changes:changes.map(x=>({target:x.target,kind:'reviewed-replacement',replacementText:x.after,
    reason:config.method==='stylesheet-once'?'Emit the shared card stylesheet at the first actual render; preserve independent callers.':'Collapse one pure forwarding render while retaining child render isolation.',
    evidence:{...evidence,sourceHash:snapshot.files.find(f=>f.file===x.target).sourceHash}}))};
  return createSitePlan({project,recipe,metadata:{method:config.method,readOnlyDependencies:inputs.filter(f=>!changes.some(c=>c.target===f.file)).map(({file,sourceHash})=>({file,sourceHash})),
    verificationRequired:['Exact content/layout/interaction preservation with the declared stylesheet-node delta only.',
      'Actual mechanism cost reduction plus independent navigation gain under unchanged gates.',
      ...(c.kind==='liquid-render'?['Independent Shopify Liquid samples over caller/wrapper/leaf file set; absence of the wrapper is not zero total work.']:[]) ]}});
}
