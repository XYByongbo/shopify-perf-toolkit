#!/usr/bin/env node
import fs from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {auditSEOSource,auditSEOHTML,validateSEOAudit} from '../lib/seo/audit.mjs';
import {renderSEOReport} from '../lib/seo/report.mjs';
import {runSEOBatch} from '../lib/seo/batch.mjs';
import {guardOutput,saveFile,readJSON,absolute} from '../lib/seo/io.mjs';
import {runProcess} from '../lib/core/bounded-process.mjs';

const {version}=JSON.parse(await fs.readFile(new URL('../package.json',import.meta.url),'utf8'));
const specs={doctor:[], 'audit-source':['project','out'],'audit-html':['input','fragment','out'],
  plan:['project','config','out'],fix:['project','config','out'],apply:['project','plan','out'],verify:['project','plan','out'],rollback:['project','plan','out'],
  batch:['config','out'],report:['input','out'],'report-pdf':['input','out']};
const help=`Shopify SEO Toolkit ${version}
  doctor
  plan --project <theme> [--config <source-replacements.json>] --out <plan.json>
  fix --project <theme> [--config <source-replacements.json>] --out <new-directory>
  apply|verify|rollback --project <theme> --plan <plan.json> --out <new-json>
  audit-source --project <absolute-theme> --out <new-json>
  audit-html --input <absolute-saved.html> [--fragment true|false] --out <new-json>
  batch --config <absolute-json> --out <new-directory>
  report --input <seo-audit.json> --out <new-html>
  report-pdf --input <seo-audit.json> --out <new-pdf>
Source SEO audit and repair. Saved HTML remains an optional read-only diagnostic. No online SEO acceptance.
Exit 0: requested operation completed (audit has no findings); 3: review/partial/stopped; 2: input/execution failure.
PDF requires optional Python reportlab; HTML audit uses Python stdlib only.
`;
function parse(argv) {
  if(!argv.length||['help','--help','-h'].includes(argv[0]))return {command:'help',args:{}};
  const command=argv[0],args={};if(!Object.hasOwn(specs,command))throw new Error('Unknown SEO command.');
  for(let i=1;i<argv.length;i+=2){const flag=argv[i],value=argv[i+1],key=flag.slice(2);
    if(!flag.startsWith('--')||!specs[command].includes(key)||Object.hasOwn(args,key)||value===undefined||value.startsWith('--'))throw new Error('Invalid or duplicate SEO option: '+flag);
    args[key]=value;
  }
  return {command,args};
}
export async function main(argv=process.argv.slice(2)) {
  const {command,args:a}=parse(argv);
  if(command==='help'){console.log(help);return 0;}
  if(command==='doctor'){
    let python=false;try {const p=await runProcess(process.env.SEOKIT_PYTHON||process.env.PERF_KIT_PYTHON||'python3',['--version'],{timeoutMs:3000,maxBytes:1024});const match=(p.stdout+p.stderr).match(/^Python (\d+)\.(\d+)\./);python=p.code===0&&!!match&&(Number(match[1])>3||Number(match[1])===3&&Number(match[2])>=9);}catch{}
    let repairAvailable=false;try{await import('../lib/seo/repair.mjs');repairAvailable=true;}catch{}
    console.log(JSON.stringify({kind:'seo-capabilities',version,sourceAudit:true,htmlAudit:python,
      pythonAvailable:python,networkRequired:false,lighthouseRequired:false,browserRequired:false,
      onlineSEO:'not-implemented',repairAvailable,patching:repairAvailable?'source-plan-apply-verify-rollback':'install-dependencies',pdf:'optional-reportlab'}));return 0;
  }
  if(['plan','fix','apply','verify','rollback'].includes(command)) {
    absolute(a.project,'project');const out=await guardOutput(a.out,a.project);
    const repair=await import('../lib/seo/repair.mjs');
    if(command==='fix') {const result=await repair.repairSEO({project:a.project,config:a.config?await readJSON(a.config):undefined,output:out});console.log(JSON.stringify({...result,output:out}));return ['failed','failed-rolled-back','rollback-conflict'].includes(result.status)?2:['partially-repaired','implementation-required'].includes(result.status)?3:0;}
    // Fail on unusable receipt directories before changing the theme.
    await fs.mkdir(path.dirname(out),{recursive:true});
    let result;
    try {
      result=command==='plan'?await repair.createSEOPlan({project:a.project,config:a.config?await readJSON(a.config):undefined}):await repair[{apply:'applySEOPlan',verify:'verifySEOPlan',rollback:'rollbackSEOPlan'}[command]](await readJSON(a.plan),a.project);
    }catch(error){if(error.receipt)await saveFile(out,error.receipt);throw error;}
    await saveFile(out,result);console.log(JSON.stringify({kind:result.kind,status:result.status,output:out}));
    return command==='verify'&&!result.passed||result.status==='implementation-required'?3:0;
  }
  if(command==='batch') {
    const result=await runSEOBatch({config:await readJSON(a.config),output:a.out});
    console.log(JSON.stringify(result));return result.status==='failed'?2:result.reviewRequired?3:0;
  }
  const out=await guardOutput(a.out,a.project);
  let value;
  if(command==='audit-source'){absolute(a.project,'project');value=await auditSEOSource({project:a.project});}
  if(command==='audit-html'){
    if(a.fragment!==undefined&&!['true','false'].includes(a.fragment))throw new Error('fragment must be true or false.');
    value=await auditSEOHTML({input:a.input,fragment:a.fragment==='true'});
  }
  if(value){await saveFile(out,value);console.log(JSON.stringify({kind:value.kind,status:value.status,summary:value.summary,output:out,acceptance:value.acceptance}));return value.reviewRequired?3:0;}
  value=validateSEOAudit(await readJSON(a.input));
  await guardOutput(out,value.mode==='source'?value.project:null);
  if(command==='report'){await saveFile(out,renderSEOReport(value));return 0;}
  if(command==='report-pdf'){
    await fs.mkdir(path.dirname(out),{recursive:true});
    const result=await runProcess(process.env.SEOKIT_PYTHON||process.env.PERF_KIT_PYTHON||'python3',['-B',fileURLToPath(new URL('./render_seo_report.py',import.meta.url)),a.input,out],{timeoutMs:30000,maxBytes:65536});
    if(result.code!==0)throw new Error('SEO PDF renderer failed: '+result.stderr.trim());return 0;
  }
}
if(process.argv[1]&&await fs.realpath(process.argv[1])===fileURLToPath(import.meta.url)) {
  try {process.exitCode=await main();}catch(e){console.error(JSON.stringify({error:e.message,code:e.code??'SEO_ERROR'}));process.exitCode=2;}
}
