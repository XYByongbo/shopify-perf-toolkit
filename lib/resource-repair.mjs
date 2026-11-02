import {createSitePlan,validateSitePlan} from './site-changes.mjs';
import {sourceSnapshot,sha256} from './runtime-profile.mjs';
import {readTarget} from './changes.mjs';
import {validDomainProfile} from './domain-profile.mjs';
import {targetNodes} from './domain-candidates.mjs';
import {literalAttribute} from './performance-syntax.mjs';
import {normalizeEvidenceUrl} from './run-evidence.mjs';
import {fields} from './evidence-contract.mjs';

function repairSource(source,file,offset,url) {
  const n=targetNodes([{file,text:source}]).find(n=>n.offset===offset&&n.tag==='img');
  if(!n||!n.id||n.attrs.has('srcset')||n.attrs.has('sizes')||n.attrs.has('onload')||n.attrs.has('onerror')
    ||!literalAttribute(n.node,'src')||n.filter)throw new Error('Resource repair requires one literal-id, direct img without responsive sources or handlers.');
  const src=n.attrs.get('src');
  if(/["<>\r\n]/.test(url))throw new Error('Replacement URL cannot be serialized as an HTML attribute.');
  return {node:n,after:source.slice(0,src.position.start)+`src="${url.replace(/&/g,'&amp;')}"`+source.slice(src.position.end)};
}
function healthyImage(profile,selector,url) {
  return (profile.resourceHealthAfter??profile.resourceHealth)?.images?.find(i=>i.selector===selector&&i.url===url&&i.complete===true&&i.decoded===true&&i.naturalWidth>0&&i.naturalHeight>0);
}
export async function createResourceRepair({project,config,profile}) {
  fields(config,['schemaVersion','target','offset','replacementUrl','approvedAssetHash','review'],'resource repair');
  if(config.schemaVersion!==1||!Number.isSafeInteger(config.offset)||!config.review?.summary?.trim()||config.review.originalAssetConfirmed!==true||! /^[a-f0-9]{64}$/.test(config.approvedAssetHash??''))throw new Error('Repair needs the exact source offset, intended original asset hash and concrete content review.');
  const snapshot=await sourceSnapshot(project);
  if(!/^(sections|snippets|layout|templates|blocks)\/.+\.liquid$/.test(config.target??''))throw new Error('Repair target must be a theme HTML/Liquid source.');
  if(!validDomainProfile(profile,snapshot)||profile.kind!=='runtime-profile')throw new Error('Repair requires a current deployment-bound browser profile.');
  const newUrl=new URL(config.replacementUrl);
  if(!['http:','https:'].includes(newUrl.protocol)||newUrl.username||newUrl.password)throw new Error('Replacement must be an explicit HTTP(S) asset URL.');
  const {source}=await readTarget(project,config.target),generated=repairSource(source,config.target,config.offset,newUrl.href),selector='#'+generated.node.id;
  const rawUrl=literalAttribute(generated.node.node,'src');
  if(/&(?!amp;)[a-z#][^;]*;/i.test(rawUrl))throw new Error('Complex HTML entity URL needs explicit normalization.');
  const oldUrl=new URL(rawUrl.replace(/&amp;/g,'&'),profile.config.url).href;
  const old=(profile.resourceHealthAfter??profile.resourceHealth)?.images?.filter(i=>i.selector===selector&&i.url===oldUrl&&i.complete===true&&i.decoded===false);
  const observed=profile.domainTargets?.filter(t=>t.id===generated.node.id&&t.idCount===1&&t.tag==='IMG'&&!t.inPicture&&t.currentSrc===oldUrl);
  if(old?.length!==1||observed?.length!==1)throw new Error('The exact current source image must have failed browser decoding; HEAD status alone cannot authorize repair.');
  if(oldUrl===newUrl.href)throw new Error('Repair does not change the resource.');
  const resourceRepair={selector,offset:config.offset,oldUrl,newUrl:newUrl.href,approvedAssetHash:config.approvedAssetHash};
  return createSitePlan({project,recipe:{schemaVersion:1,changes:[{target:config.target,kind:'reviewed-replacement',replacementText:generated.after,
    reason:'Restore the approved original image, then establish a new correctness baseline before performance optimization.',evidence:{...config.review,sourceHash:sha256(source),resourceRepair}}]},
    metadata:{intent:'content-repair',performanceAcceptance:'not-applicable',requiresNewContentBaseline:true}});
}

export async function verifyResourceRepair({plan,before,after}) {
  const result={kind:'resource-repair-verification',outcome:'invalid-evidence',performanceGain:'not-evaluated',requiresNewContentBaseline:true};
  try {
    await validateSitePlan(plan);
    if(plan.metadata?.intent!=='content-repair'||plan.changes.length!==1)throw new Error('Expected one content repair plan.');
    const change=plan.changes[0],r=change.evidence.resourceRepair;
    if(!r||change.evidence.originalAssetConfirmed!==true||! /^[a-f0-9]{64}$/.test(r.approvedAssetHash??''))throw new Error('Original asset approval and identity are required.');
    const replay=repairSource(change.before,change.target,r.offset,r.newUrl);
    if(replay.after!==change.after||'#'+replay.node.id!==r.selector||new URL(literalAttribute(replay.node.node,'src').replace(/&amp;/g,'&'),before.config.url).href!==r.oldUrl)throw new Error('Repair changes more than the bound image source.');
    for(const p of [before,after])if(!validDomainProfile(p,p.snapshot)||p.kind!=='runtime-profile')throw new Error('Missing deployment-bound repair verification.');
    if(before.snapshot.hash===after.snapshot.hash||normalizeEvidenceUrl(before.config.url)!==normalizeEvidenceUrl(after.config.url)
      ||before.domainProof.before.store!==after.domainProof.before.store||Date.parse(after.createdAt)<Date.parse(before.finishedAt))throw new Error('Repair profiles have wrong source, page, store or collection order.');
    const changed=[...new Set([...before.snapshot.files,...after.snapshot.files].map(f=>f.file))].filter(file=>before.snapshot.files.find(f=>f.file===file)?.sourceHash!==after.snapshot.files.find(f=>f.file===file)?.sourceHash);
    if(changed.length!==1||changed[0]!==change.target||before.snapshot.files.find(f=>f.file===change.target)?.sourceHash!==change.beforeHash||after.snapshot.files.find(f=>f.file===change.target)?.sourceHash!==change.afterHash)throw new Error('Repair measurement contains unrelated source changes.');
    if(!(before.resourceHealthAfter??before.resourceHealth)?.images?.some(i=>i.selector===r.selector&&i.url===r.oldUrl&&i.complete&&i.decoded===false)||!healthyImage(after,r.selector,r.newUrl)
      ||!after.resources?.some(x=>x.url===r.newUrl&&x.type==='Image'&&x.status>=200&&x.status<300&&!x.error&&x.bodyHash===r.approvedAssetHash))throw new Error('Restored image must decode and its actual response bytes must match the approved original hash.');
    result.outcome='correctness-restored';result.resource=r;result.newBaselineSourceHash=after.snapshot.hash;
  }catch(error){result.error=error.message;}return result;
}
