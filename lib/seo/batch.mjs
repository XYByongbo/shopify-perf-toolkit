import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {runProcess} from '../core/bounded-process.mjs';
import {escapeHTML as esc} from '../core/report-format.mjs';
import {validateSEOAudit} from './audit.mjs';
import {renderSEOReport} from './report.mjs';
import {absolute,guardOutput,saveFile,readJSON} from './io.mjs';

export async function runSEOBatch({config,output}) {
  if(!config||Array.isArray(config)||config.schemaVersion!==1||Object.keys(config).some(k=>!['schemaVersion','project','renderedHtml','timeoutMs'].includes(k)))throw new Error('Invalid SEO batch config.');
  if(config.project!==undefined)absolute(config.project,'project');
  if(config.renderedHtml!==undefined&&(!Array.isArray(config.renderedHtml)||!config.renderedHtml.length||config.renderedHtml.length>12))throw new Error('Supply 1..12 HTML inputs.');
  const jobs=[];
  if(config.project)jobs.push(['audit-source','--project',config.project]);
  for(const item of config.renderedHtml??[]) {
    if(!item||Array.isArray(item)||Object.keys(item).some(k=>!['input','fragment'].includes(k))||item.fragment!==undefined&&typeof item.fragment!=='boolean')throw new Error('HTML entry accepts input and optional fragment.');
    absolute(item.input,'HTML input');jobs.push(['audit-html','--input',item.input,'--fragment',String(item.fragment===true)]);
  }
  if(!jobs.length)throw new Error('SEO batch needs project and/or renderedHtml; no measurements are required.');
  const timeout=config.timeoutMs??120000;
  if(!Number.isSafeInteger(timeout)||timeout<100||timeout>3600000)throw new Error('SEO batch timeout must be 100..3600000 ms.');
  output=await guardOutput(output,config.project);
  await fs.mkdir(path.dirname(output),{recursive:true});await fs.mkdir(output);
  const result={schemaVersion:1,kind:'seo-batch',domain:'seo',status:'running',acceptance:'not-evaluated',complete:false,
    reviewRequired:true,inputs:jobs.length,completed:0,reports:[],failure:null};
  const started=Date.now(),script=fileURLToPath(new URL('../../scripts/seokit.mjs',import.meta.url));
  const checkpoint=async()=>{const temp=path.join(output,'.batch.tmp');await fs.writeFile(temp,JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o600});await fs.rename(temp,path.join(output,'batch.json'));};
  await checkpoint();
  try {
    for(const [index,job] of jobs.entries()) {
      const remaining=timeout-(Date.now()-started);
      if(remaining<=0)throw Object.assign(new Error('SEO batch deadline exceeded.'),{code:'WALL_TIME_BUDGET'});
      const name=`seo-${index+1}`,out=path.join(output,name+'.json');
      const child=await runProcess(process.execPath,[script,...job,'--out',out],{timeoutMs:remaining,maxBytes:65536});
      if(![0,3].includes(child.code))throw new Error(`SEO input ${index+1} failed: ${child.stderr.trim()}`);
      const report=validateSEOAudit(await readJSON(out));
      await saveFile(path.join(output,name+'.html'),renderSEOReport(report));
      result.reports.push({artifact:name+'.json',html:name+'.html',mode:report.mode,scope:report.scope,status:report.status,
        complete:report.complete,reviewRequired:report.reviewRequired,summary:report.summary});
      result.completed++;await checkpoint();
    }
    result.complete=result.reports.every(r=>r.complete);
    result.reviewRequired=!result.complete||result.reports.some(r=>r.reviewRequired);
    result.status=!result.complete?'partial':result.reviewRequired?'review-required':'audit-complete';
  } catch(e) {result.status=e.code==='WALL_TIME_BUDGET'?'stopped':'failed';result.failure={code:e.code??'AUDIT_FAILED',message:e.message};}
  await checkpoint();
  await saveFile(path.join(output,'index.html'),`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>SEO 批次</title><h1>SEO 批次：${esc(result.status)}</h1><p>完成 ${result.completed}/${result.inputs}。SEO 验收未执行。</p><p>${esc(result.failure?.message??'')}</p><ul>${result.reports.map(r=>`<li><a href="${r.html}">${r.artifact}</a>：${esc(r.status)}，${r.summary.findings} 项</li>`).join('')}</ul></html>`);
  return result;
}
