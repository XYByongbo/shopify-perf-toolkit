import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {sourceSnapshot} from './theme-source.mjs';
import {runProcess} from './bounded-process.mjs';
import {normalizeThemeCheck,themeCheckEnvironment} from './theme-check-transport.mjs';
import {importCheck} from './check-import.mjs';
import {digest} from './evidence-contract.mjs';

export const requiredThemeChecks=['LiquidHTMLSyntaxError','JSONSyntaxError','MissingAsset','ImgWidthAndHeight',
  'ParserBlockingScript','ContentForHeaderModification','AssetSizeCSS','AssetSizeJavaScript',
  'PaginationSize','LiquidComplexity','LiquidNestingDepth','ExcessiveSettingsCount'];
export function effectiveCheckState(configuration,rule){
  const block=configuration.match(new RegExp(`^${rule}:\\r?\\n((?:[ \\t]+[^\\n]*\\n?)+)`,'m'))?.[1];
  return !block?'unavailable':/enabled:\s*true(?:\s|$)/.test(block)?'enabled':'disabled';
}
async function configText(project){try{return await readFile(path.join(project,'.theme-check.yml'),'utf8');}catch(error){if(error.code==='ENOENT')return null;throw error;}}

export async function isCurrentProjectThemeCheck(snapshot, report) {
  return snapshot.complete && snapshot.hash === report.sourceHash
    && (await configText(snapshot.project)) === report.metadata.rulesConfig?.projectConfiguration;
}

/** Execute the project's actual configuration read-only, with version/list/print provenance. */
export async function checkThemeProject({project,timeoutMs=120000,dependencies={}}={}) {
  if(!Number.isInteger(timeoutMs)||timeoutMs<1000||timeoutMs>600000)throw new Error('Invalid Theme Check timeout.');
  const snapshot=await sourceSnapshot(project),configuration=await configText(snapshot.project);
  if(!snapshot.complete)throw new Error('Theme Check needs a complete source snapshot.');
  const commands=[],start=Date.now(),cli=process.env.PERF_KIT_SHOPIFY_CLI||'shopify';
  const base=['theme','check','--path',snapshot.project,'--no-color','--no-input'];
  const execute=async args=>{
    const remaining=timeoutMs-(Date.now()-start);
    if(remaining<=0)throw Object.assign(new Error('Theme Check deadline exceeded.'),{code:'WALL_TIME_BUDGET'});
    const r=await (dependencies.runProcess??runProcess)(cli,args,{cwd:snapshot.project,timeoutMs:remaining,env:themeCheckEnvironment()});
    commands.push({args,exitCode:r.code,stdout:r.stdout,stderr:r.stderr});return r;
  };
  try {
    const cliVersion=await execute(['version']),version=await execute([...base,'--version']);
    const list=await execute([...base,'--list']),printed=await execute([...base,'--print']);
    if([cliVersion,version,list,printed].some(r=>r.code!==0)||![cliVersion,version].every(r=>/\d+\.\d+\.\d+/.test(r.stdout)))throw new Error('Theme Check version, rule list or effective configuration unavailable.');
    const checked=await execute([...base,'--output','json','--fail-level','error']);
    if(![0,1].includes(checked.code))throw new Error('Theme Check execution failed.');
    const raw=JSON.parse(checked.stdout),normalized=normalizeThemeCheck(raw);
    if(checked.code===1&&!normalized.groups.some(g=>g.offenses.length))throw new Error('Theme Check failed without diagnostics.');
    const end=await sourceSnapshot(snapshot.project);
    if(end.hash!==snapshot.hash||!end.complete||await configText(snapshot.project)!==configuration)throw new Error('Source/configuration changed during Theme Check.');
    const effective=printed.stdout.replace(/^rootUri:.*$/m,'rootUri: <theme>');
    const report=await importCheck({project:snapshot.project,input:raw,metadata:{tool:'Shopify Theme Check',toolVersion:version.stdout.trim(),
      cliVersion:cliVersion.stdout.trim(),sourceRoot:snapshot.project,positionBase:0,severityMap:{0:'error',1:'warning',2:'info'},
      scope:'project-theme-check-v1',scannedFiles:snapshot.files.map(f=>f.file),sourceHashes:Object.fromEntries(snapshot.files.map(f=>[f.file,f.sourceHash])),
      rulesConfig:{effectiveConfiguration:effective,projectConfiguration:configuration},complete:true}});
    return {...report,rawReport:raw,sourceHash:snapshot.hash,sourceManifest:snapshot.files,
      execution:{commands,availableRules:list.stdout,configurationHash:digest(effective)},
      requiredChecks:requiredThemeChecks.map(id=>({id,status:effectiveCheckState(effective,id)})),
      reviewRequired:!report.complete||report.findings.length>0||requiredThemeChecks.some(id=>effectiveCheckState(effective,id)!=='enabled')};
  }catch(error){error.themeCheck={kind:'project-theme-check-failure',commands};throw error;}
}
