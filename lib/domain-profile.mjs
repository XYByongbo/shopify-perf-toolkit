import {captureSelectors} from './recovery-evidence.mjs';
import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import { profileRuntime, validateProfileConfig, sourceSnapshot, sha256 } from './runtime-profile.mjs';
import { profileLiquid, analyzeLiquidProfile } from './liquid-profile.mjs';
import { verifyDeployment, validateDeployment } from './deployment.mjs';
import { createRunDirectory } from './run-directory.mjs';
import { fields } from './evidence-contract.mjs';
import { normalizeEvidenceUrl } from './run-evidence.mjs';

export function validateDomainProfileConfig(config) {
  fields(config,['schemaVersion','mode','deployment','url','profile','bindings'],'domain profile');
  if(config.schemaVersion!==1||!['runtime','liquid'].includes(config.mode))throw new Error('Domain profile mode must be runtime or liquid.');
  const deployment=validateDeployment(config.deployment),url=new URL(config.url);
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw new Error('Invalid domain profile URL.');
  url.searchParams.set('preview_theme_id',deployment.themeId);
  const bindings=config.bindings??[];
  if(!Array.isArray(bindings)||bindings.length>50||bindings.some(b=>typeof b.file!=='string'||!Number.isSafeInteger(b.offset)||b.offset<0||!b.selector?.trim()||!b.review?.trim()||!/^[a-f0-9]{64}$/.test(b.sourceHash??'')))throw new Error('Bindings require current file/sourceHash/parser offset, unique rendered selector and concrete mapping review.');
  const profileConfig = config.mode === 'runtime' ? validateProfileConfig({
    ...config.profile,schemaVersion:1,project:deployment.project,url:url.href,expectedThemeId:deployment.themeId,targetSelectors:captureSelectors(config),
  }) : undefined;
  return {deployment,url,bindings,profileConfig};
}

/** Source identity brackets the instrumented capture, independently of score runs. */
export async function profileDomain({config,output,dependencies={}}) {
  const {deployment,url,bindings,profileConfig}=validateDomainProfileConfig(config);
  if (profileConfig?.expectedSourceHash) {
    const snapshot = await sourceSnapshot(deployment.project);
    if (!snapshot.complete || snapshot.hash !== profileConfig.expectedSourceHash) {
      throw new Error('Audited source changed before domain capture; regenerate the sampling plan.');
    }
  }
  const out=await createRunDirectory(output),pages=[{id:'target',url:url.href}],proof={};
  const verify=dependencies.verifyDeployment??verifyDeployment;
  proof.before=await verify({config:deployment,pages});
  await writeFile(path.join(out,'deployment-before.json'),JSON.stringify(proof.before,null,2)+'\n',{flag:'wx'});
  if(proof.before.status!=='verified')throw new Error('Domain source verification failed before capture.');
  const startedAt=new Date().toISOString();
  const profile=config.mode==='runtime'
    ? await (dependencies.profileRuntime??profileRuntime)({config:profileConfig,output:path.join(out,'runtime')})
    : await (dependencies.profileLiquid??profileLiquid)({config:{schemaVersion:1,project:deployment.project,store:deployment.store,themeId:deployment.themeId,urlPath:url.pathname+url.search,timeoutMs:config.profile?.timeoutMs}});
  const finishedAt=new Date().toISOString();
  proof.after=await verify({config:deployment,pages});
  await writeFile(path.join(out,'deployment-after.json'),JSON.stringify(proof.after,null,2)+'\n',{flag:'wx'});
  const snapshot=await sourceSnapshot(deployment.project);
  const result={...profile,domainBindings:bindings,domainProof:{version:1,url:url.href,startedAt,finishedAt,...proof}};
  await writeFile(path.join(out,'profile.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx'});
  if(!validDomainProfile(result,snapshot))throw new Error(`Domain capture failed identity/complete checks; inspect ${path.join(out,'profile.json')}. ${profile.errors?.join('; ')??''}`);
  return result;
}

export function validDomainProfile(profile,snapshot) {
  try {
    const d=profile.domainProof,pages=[d.before,d.after],times=[d.before.startedAt,d.before.finishedAt,d.startedAt,d.finishedAt,d.after.startedAt,d.after.finishedAt].map(Date.parse);
    const recorded=profile.snapshot??profile.sourceSnapshot;
    if(d.version!==1||profile.status!=='complete'||!snapshot.complete||!['runtime-profile','liquid-profile'].includes(profile.kind)
      ||recorded?.complete!==true||recorded.hash!==snapshot.hash||sha256(JSON.stringify(recorded.files))!==snapshot.hash
      ||times.some((n,i)=>!Number.isFinite(n)||i>0&&n<times[i-1]))return false;
    const captureStart=Date.parse(profile.createdAt??profile.startedAt),captureEnd=Date.parse(profile.finishedAt);
    if(!Number.isFinite(captureStart)||!Number.isFinite(captureEnd)||captureStart<times[2]||captureEnd>times[3]||captureEnd<captureStart)return false;
    for(const p of pages)if(p.kind!=='deployment-proof'||p.status!=='verified'||p.scope!=='theme-text-source'
      ||p.method!=='shopify-cli-source-pull-and-browser-theme-id'||p.sourceHash!==snapshot.hash||p.remoteSourceHash!==snapshot.hash
      ||sha256(JSON.stringify(p.sourceManifest))!==snapshot.hash||p.themeId!==d.before.themeId||p.store!==d.before.store
      ||p.project!==(profile.snapshot??profile.sourceSnapshot).project||profile.project!==p.project
      ||!p.pages?.some(q=>q.url===d.url&&q.status==='verified'&&q.themeId===p.themeId&&q.store===p.store))return false;
    if(profile.kind==='runtime-profile')return profile.sourceStable===true&&profile.themeId===d.before.themeId
      &&normalizeEvidenceUrl(profile.config.url)===normalizeEvidenceUrl(d.url)&&normalizeEvidenceUrl(profile.finalUrl)===normalizeEvidenceUrl(d.url);
    const e=profile.evidence;
    if(e.origin!=='shopify-cli'||e.rawProfileHash!==sha256(JSON.stringify(profile.rawProfile))||e.collector?.kind!=='shopify-cli'
      ||!/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(e.collector.version??'')||String(e.themeId)!==d.before.themeId||e.store!==d.before.store
      ||normalizeEvidenceUrl(new URL(e.urlPath,d.url).href)!==normalizeEvidenceUrl(d.url))return false;
    analyzeLiquidProfile(profile.rawProfile,profile.sourceSnapshot);
    return true;
  }catch{return false;}
}
