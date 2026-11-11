#!/usr/bin/env node
import {writeFile,readFile,realpath} from 'node:fs/promises';
import path from 'node:path';
import {toolkitManifest,toolkitRoot} from '../lib/toolkit-manifest.mjs';
import {createRunDirectory} from '../lib/measure.mjs';
import {digest} from '../lib/evidence-contract.mjs';
import {runProcess} from '../lib/core/bounded-process.mjs';

const args=process.argv.slice(2);
if(args.length!==2||args[0]!=='--out'||!path.isAbsolute(args[1]))throw new Error('Usage: node scripts/validate_delivery.mjs --out <new external directory>');
const root=await realpath(toolkitRoot),requested=path.resolve(args[1]);
if(requested===root||requested.startsWith(root+path.sep))throw new Error('Validation artifacts must be outside the repository.');
const out=await createRunDirectory(requested);
const manifest=await toolkitManifest(),records=[];
const checks=[['unit','npm',['test']],['python','npm',['run','test:lighthouse']],
  ['browser','npm',['run','test:browser']],
  ['theme-check',process.execPath,['--test','tests/standards-browser.test.mjs']],
  ['delivery-browser',process.execPath,['--test','--test-concurrency=1','tests/delivery-browser.test.mjs','tests/scenarios.test.mjs']],
  ['site',process.execPath,['scripts/validate_site_pipeline.mjs','--out',path.join(out,'site')]],
  ['demand',process.execPath,['scripts/validate_demand_pipeline.mjs']]];
for(const [id,command,argv] of checks){
  console.log(JSON.stringify({stage:id,status:'running'}));
  const log=path.join(out,id+'.log'),startedAt=new Date().toISOString();
  const env=id.includes('browser')?{PERF_KIT_BROWSER_TESTS:'1',PERF_KIT_PLAYWRIGHT_MODULE:path.join(root,'node_modules/playwright-core/index.mjs')}
    :{PERF_KIT_BROWSER_TESTS:null,PERF_KIT_PLAYWRIGHT_MODULE:null,...(id==='theme-check'?{PERF_KIT_THEME_CHECK_TESTS:'1'}:{PERF_KIT_THEME_CHECK_TESTS:null})};
  let transport;
  try{transport=await runProcess(command,argv,{cwd:root,env,timeoutMs:15*60*1000});}
  catch(error){transport={code:1,stdout:'',stderr:`${error.code??'ERROR'}: ${error.message}`};}
  const exitCode=transport.code??1;
  await writeFile(log,transport.stdout+'\n'+transport.stderr,{flag:'wx',mode:0o600});
  records.push({id,command,argv,startedAt,finishedAt:new Date().toISOString(),exitCode,log:path.basename(log),sha256:digest(await readFile(log))});
  await writeFile(path.join(out,'progress.json'),JSON.stringify(records,null,2));
  console.log(JSON.stringify({stage:id,status:exitCode===0?'passed':'failed',exitCode}));
}
const after=await toolkitManifest(),sourceStable=after.sourceHash===manifest.sourceHash;
const result={schemaVersion:1,kind:'toolkit-validation',toolkit:manifest,sourceStable,checks:records,
  status:sourceStable&&records.every(r=>r.exitCode===0)?'passed':'failed',scope:'Tool contracts and isolated local browser/Lighthouse fixtures; no merchant theme or field CWV claim.'};
await writeFile(path.join(out,'validation.json'),JSON.stringify(result,null,2),{flag:'wx',mode:0o600});
console.log(JSON.stringify({status:result.status,output:out}));process.exitCode=result.status==='passed'?0:1;
