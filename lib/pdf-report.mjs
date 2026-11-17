import { configValue, fields } from './evidence-contract.mjs';
import { sha256 as hash } from './source-utils.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {auditQuality,buildAnalysis} from './quality-audit.mjs';
import {dimensionFor} from './quality-catalog.mjs';
import {scanTheme} from './scan.mjs';
import {createSourceAnalysis} from './core/source-analysis.mjs';
import {fingerprintThemeInventory} from './core/source-scan.mjs';
import {createSourceSyntaxCache} from './source-syntax-cache.mjs';
import {auditResources} from './resource-audit.mjs';
import {readThemeSource} from './check-import.mjs';
import {readRunEvidence} from './run-evidence.mjs';

const json=async p=>JSON.parse(await fs.readFile(p,'utf8'));
const median=a=>{const b=[...a].sort((x,y)=>x-y);return b.length?(b[Math.floor((b.length-1)/2)]+b[Math.floor(b.length/2)])/2:null;};
export function validatePdfConfig(config) {
  const allowed=['schemaVersion','project','title','checks','baseline','run','before','review','context','sourceSnapshot'];
  fields(config, allowed, 'PDF report config');
  if (config.schemaVersion !== 1) throw configValue('config.schemaVersion', '1');
  if (typeof config.project !== "string" || !config.project) throw new Error("config.project must be a nonempty theme directory path.");
}

export async function buildPdfEvidence(config){
  validatePdfConfig(config);
  const originalProject=await fs.realpath(config.project);
  const analysis=createSourceAnalysis(),syntax=createSourceSyntaxCache();
  const scan=await scanTheme({project:config.sourceSnapshot??config.project,analysis,syntax});
  const resources=await auditResources({project:scan.project});
  const manifest=Object.fromEntries(scan.inventory.files.map(f=>[f.path,f.sha256]));
  const sourceHash=hash(JSON.stringify(Object.entries(manifest).sort()));
  const checks=config.checks?await json(config.checks):null;
  if(checks&&(checks.kind!=='check-import'||checks.project!==scan.project))throw new Error('checks must be an import-check report for this project.');
  const quality=await auditQuality({project:scan.project,scan,checks,analysis,syntax});
  const review=config.review?await json(config.review):[];
  if(!Array.isArray(review))throw new Error('review must be an array of source-bound findings.');
  const cache=new Map();const findings=[];const seen=new Set();
  for(const [origin,items]of [['scan',scan.findings],['resources',resources.findings],['check',checks?.findings??[]],['quality',quality.findings],['review',review]]){
    for(const f of items){
      const file=f.file??null,line=f.line??null;
      if(origin==='review'&&(!file||!Number.isSafeInteger(line)||line<1||!f.sourceHash||!f.summary?.trim()))throw new Error('Reviewed findings require file, positive line, sourceHash and summary.');
      let source=null,binding='unlocated';
      if(file){
        if(!cache.has(file)){try{cache.set(file,await readThemeSource(scan.project,file));}catch{cache.set(file,null);}}
        source=cache.get(file);
        binding=source&&f.sourceHash===manifest[file]&&(origin!=='check'||f.sourceBinding==='hash-matched')?'hash-matched':'stale-or-unavailable';
      }
      if(origin==='review'&&binding!=='hash-matched')throw new Error(`Reviewed source drift: ${file}`);
      const lines=source?.source.split('\n')??[];
      const located=Number.isSafeInteger(line)&&line>0&&line<=lines.length;
      if(origin==='review'&&!located)throw new Error('Reviewed line outside source.');
      const snippet=located?lines.slice(Math.max(0,line-2),Math.min(lines.length,line+2)).map((s,i)=>({line:Math.max(1,line-1)+i,text:s})):[];
      const column=f.evidence?.original?.column??null;
      const identity=[origin,f.ruleId??'REVIEW',file,line,f.summary];if(column!==null)identity.push(column);
      const key=JSON.stringify(identity);
      let ordinal=0;while(seen.has(key+':'+ordinal))ordinal++;seen.add(key+':'+ordinal);
      findings.push({id:'ISS-'+hash(ordinal?key+':'+ordinal:key).slice(0,12),origin,ruleId:f.ruleId??'REVIEW',file,line,column,sourceHash:f.sourceHash??null,sourceBinding:binding,
        status:binding==='stale-or-unavailable'?'needs-rescan':f.status??'candidate',priority:origin==='review'?f.priority??'待复核':'待复核',
        dimension:dimensionFor(f),severity:f.severity??'info',summary:f.summary,correction:(origin==='check'?quality.checkerCorrections.find(c=>c.file===file&&c.line===line&&c.ruleId===f.ruleId&&c.summary===f.summary):null)??f.correction??null,verification:f.verification??[],action:f.action??null,
        evidence:f.evidence??null,snippet});
    }
  }
  const contract={version:3,qualityVersion:1,checks:checks?{tool:checks.metadata?.tool,toolVersion:checks.metadata?.toolVersion,rulesConfig:checks.metadata?.rulesConfig,scope:checks.metadata?.scope}:null};
  const baseline=config.baseline?await json(config.baseline):null;
  let comparison={status:'no-baseline',added:[],absent:[]};
  if(baseline){
    if(baseline.kind!=='theme-pdf-report'||baseline.project!==originalProject||JSON.stringify(baseline.contract)!==JSON.stringify(contract))comparison.status='incomparable';
    else{const old=new Set(baseline.findings.map(f=>f.id)),now=new Set(findings.map(f=>f.id));comparison={status:'same-report-contract-not-proof-of-fix',added:[...now].filter(x=>!old.has(x)),absent:[...old].filter(x=>!now.has(x))};}
  }
  const measurement=[];
  for(const [phase,dir] of [['before',config.before],['after',config.run]])if(dir){
    const e=await readRunEvidence(dir,{allowPartial:true,allowExploration:true});
    for(const g of e.groups){const scores=g.records.map(r=>r.report.categories.performance.score*100);measurement.push({phase,run:path.resolve(dir),page:g.pageId,device:g.device,url:g.url,status:g.status,purpose:e.manifest.config.purpose??'acceptance',runStatus:e.manifest.status,failedAttempts:(g.attempts??[]).filter(a=>a.status==='failed').length,issues:e.issues,manifestSha256:e.manifestHash,reports:g.records.map(r=>r.relative),scores,median:median(scores),min:scores.length?Math.min(...scores):null,warnings:g.records.flatMap(r=>r.report.runWarnings??[]),lcpMedianMs:median(g.records.map(r=>r.report.audits['largest-contentful-paint']?.numericValue).filter(Number.isFinite)),tbtMedianMs:median(g.records.map(r=>r.report.audits['total-blocking-time']?.numericValue).filter(Number.isFinite))});}
  }
  // Recheck every inventoried file after reading evidence, not just referenced findings.
  const end=await fingerprintThemeInventory(scan.project);
  if(sourceHash!==hash(JSON.stringify(end.sort())))throw new Error('Source changed while generating report.');

  return {schemaVersion:1,kind:'theme-pdf-report',createdAt:new Date().toISOString(),project:originalProject,sourceRoot:scan.project,sourceMode:config.sourceSnapshot?'frozen-snapshot':'current-project',title:config.title??'Shopify 主题代码规范与性能专项评估',context:config.context??'',sourceHash,sourceManifest:manifest,contract,complete:scan.complete&&resources.complete&&quality.complete&&(!checks||checks.complete),inventory:scan.summary,
    findings,quality,analysis:buildAnalysis(findings,quality),comparison,measurement,resources:{summary:resources.summary,resources:resources.resources,relationships:resources.relationships},
    checksStatus:checks?{complete:checks.complete,summary:checks.summary,issues:checks.issues}:'not-supplied',
    limitations:['静态候选、检查器告警和人工复核分别统计，可能指向同一问题，不将相加数量视为独立缺陷数。','未提供 Theme Check 时不冒充全量规范扫描；历史哈希不匹配项保留并标明待重扫。','源码指纹仅绑定本地版本，不证明预览已同步。测量表不自动构成因果提速或正式验收。','差异红色仅表示同一报告契约下新增记录；行号移动可能导致新增/消失，消失不等于修复。','报告不会下载素材、执行整改命令或发布主题。完整原文与证据保存在同目录 JSON。']};
}
export async function generatePdfReport({config,out}){
  if(!path.isAbsolute(out))throw new Error('PDF output must be a new absolute directory.');
  try{await fs.lstat(out);throw new Error('Refusing to overwrite output.');}catch(e){if(e.code!=='ENOENT')throw e;}
  for(let parent=path.dirname(out);;parent=path.dirname(parent)){try{if((await fs.lstat(parent)).isSymbolicLink())throw new Error('Symlink output parent is unsupported.');}catch(e){if(e.code!=='ENOENT')throw e;}if(parent===path.dirname(parent))break;}
  const evidence=await buildPdfEvidence(config);
  await fs.mkdir(out,{recursive:true});
  const data=path.join(out,'report.json');await fs.writeFile(data,JSON.stringify(evidence,null,2),{flag:'wx'});
  const script=fileURLToPath(new URL('../scripts/render_pdf_report.py',import.meta.url));
  const p=spawnSync(process.env.PERF_KIT_PYTHON??'python3',[script,'--input',data,'--output',path.join(out,'report.pdf')],{encoding:'utf8',timeout:120000,maxBuffer:1024*1024});
  if(p.error||p.status!==0)throw new Error(`PDF renderer failed; JSON retained: ${p.error?.message??p.stderr}`);
  return {kind:'pdf-report-result',pdf:path.join(out,'report.pdf'),evidence:data,summary:{findings:evidence.findings.length,complete:evidence.complete},sourceHash:evidence.sourceHash};
}
