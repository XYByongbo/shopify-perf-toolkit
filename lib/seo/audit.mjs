import {scanInventory} from '../core/source-scan.mjs';
import {readThemeSource} from '../core/source-reader.mjs';
import {sha256,lineAt} from '../core/source-utils.mjs';
import {auditRenderedHTML} from '../core/rendered-html.mjs';
import {inspectSEOFile,inspectSEOLayouts} from './source-rules.mjs';
import path from 'node:path';

export const ruleVersion = 1;
const limitations = [
  'Offline checks only; no HTTP requests, Liquid rendering, browser execution or search-engine indexing verification.',
  'No findings means only no observations under these rules. It does not establish SEO acceptance, ranking or performance.',
  'HTTP status/X-Robots-Tag, robots.txt, sitemap, hreflang reciprocity and rich-result eligibility remain not-run.',
];

export function finalizeAudit(data) {
  const summary={findings:data.findingCount??data.findings.length,
    errors:data.errorCount??data.findings.filter(f=>f.severity==='error').length,
    warnings:data.warningCount??data.findings.filter(f=>f.severity==='warning').length,
    observations:data.observations.length,issues:data.issues.length};
  const complete=data.issues.length===0 && !data.findingsTruncated;
  return {schemaVersion:1,kind:'seo-audit',domain:'seo',ruleVersion,
    ...data,summary,complete,reviewRequired:!complete||summary.findings>0,
    status:!complete?'partial':summary.findings?'review-required':'audit-complete',
    acceptance:'not-evaluated',limitations:[...limitations,...(data.limitations??[])]};
}

export async function auditSEOSource({project}={}) {
  const scan=await scanInventory({project});
  const sources=new Map(),files=new Map(scan.inventory.files.map(f=>[f.path,f]));
  const findings=[],observations=[],issues=[...scan.errors,...scan.skipped];
  const add=(file,index,ruleId,dimension,summary,evidence={})=>findings.push({ruleId,
    dimension,file,line:lineAt(sources.get(file),index),sourceHash:files.get(file).sha256,
    severity:'warning',status:'source-candidate',summary,evidence});
  const observe=(file,index,check,status,detail)=>observations.push({file,
    line:lineAt(sources.get(file),index),sourceHash:files.get(file).sha256,check,status,detail});
  for(const f of files.values()) {
    if(f.kind!=='liquid'||!f.sha256||f.rawBytes>5*1024*1024||scan.skipped.some(s=>s.file===f.path))continue;
    const read=await readThemeSource(scan.project,f.path,f.sha256);
    sources.set(f.path,read.source);
    inspectSEOFile({file:f.path,source:read.source,add,observe});
  }
  const edges=scan.dependencies.filter(e=>e.status==='resolved'&&['liquid-render','liquid-include'].includes(e.type));
  inspectSEOLayouts({sources,edges,add,observe});
  for(const e of scan.dependencies.filter(e=>['liquid-render','liquid-include'].includes(e.type)&&e.status!=='resolved'))
    issues.push({file:e.from,reason:'Snippet dependency is missing or dynamic; SEO source coverage is incomplete.',dependency:e});
  if(![...sources.keys()].some(f=>/^layout\/.*\.liquid$/.test(f)))issues.push({reason:'No readable layout; document metadata coverage is incomplete.'});
  const manifest=scan.inventory.files.filter(f=>f.sha256).map(f=>({file:f.path,sha256:f.sha256}));
  const end=await scanInventory({project:scan.project});
  if(!end.complete && scan.complete || JSON.stringify(end.inventory.files.filter(f=>f.sha256).map(f=>({file:f.path,sha256:f.sha256})))!==JSON.stringify(manifest))
    throw new Error('Source changed during SEO audit.');
  return finalizeAudit({mode:'source',scope:'theme-source',project:scan.project,
    sourceAssociation:'current-local-source',sourceManifest:manifest,sourceHash:sha256(JSON.stringify(manifest)),
    findings,observations,issues,findingsTruncated:false,
    coverage:{liquidFiles:sources.size,layoutFiles:[...sources.keys()].filter(f=>f.startsWith('layout/')),
      runtime:'not-run',sourceScanComplete:scan.complete},
    limitations:['Source locations are Liquid locations. Literal snippet reachability does not evaluate branch conditions, App injection or merchant settings.']});
}

export async function auditSEOHTML({input,fragment=false,timeoutMs=30000}={}) {
  const html=await auditRenderedHTML({input,fragment,timeoutMs,profile:'seo',python:process.env.SEOKIT_PYTHON||process.env.PERF_KIT_PYTHON||'python3'});
  return finalizeAudit({mode:'html',scope:html.scope,input:html.input,
    sourceAssociation:'unverified-saved-html',findings:html.findings,
    observations:[],issues:[],findingsTruncated:html.findings_truncated,
    findingCount:html.summary.findings,errorCount:html.summary.errors,warningCount:html.summary.warnings,
    coverage:{runtime:'not-run',sourceBinding:'not-established'},
    limitations:['HTML line numbers are not Liquid source locations. A saved HTML hash does not prove current URL, store, theme or deployment identity.']});
}

export function validateSEOAudit(value) {
  const count=n=>Number.isSafeInteger(n)&&n>=0;
  if(!value||value.schemaVersion!==1||value.kind!=='seo-audit'||value.domain!=='seo'||value.ruleVersion!==ruleVersion
    ||!['source','html'].includes(value.mode)||value.acceptance!=='not-evaluated'
    ||!Array.isArray(value.findings)||!Array.isArray(value.observations)||!Array.isArray(value.issues)
    ||!Array.isArray(value.limitations)||value.limitations.some(x=>typeof x!=='string')
    ||typeof value.findingsTruncated!=='boolean'||!value.summary
    ||Object.values(value.summary).some(n=>!count(n))
    ||value.findings.some(f=>!f||!['error','warning'].includes(f.severity)||typeof f.ruleId!=='string'||typeof f.summary!=='string'||typeof f.file!=='string'||!Number.isSafeInteger(f.line)||f.line<1))throw new Error('Invalid SEO audit contract.');
  const coverage=value.coverage;
  if(!coverage||coverage.runtime!=='not-run'||value.issues.some(x=>!x||typeof x!=='object'||Array.isArray(x)))throw new Error('Invalid SEO coverage.');
  if(value.mode==='source') {
    if(typeof coverage.sourceScanComplete!=='boolean'||!count(coverage.liquidFiles)||!Array.isArray(coverage.layoutFiles)
      ||coverage.layoutFiles.some(f=>typeof f!=='string'||!/^layout\/.*\.liquid$/.test(f))
      ||coverage.layoutFiles.length>coverage.liquidFiles
      ||(!coverage.sourceScanComplete||!coverage.layoutFiles.length)&&!value.issues.length)throw new Error('Incomplete SEO coverage cannot be reported as complete.');

    if(value.scope!=='theme-source'||value.sourceAssociation!=='current-local-source'||typeof value.project!=='string'||!path.isAbsolute(value.project)
      ||!Array.isArray(value.sourceManifest)||value.findingsTruncated
      ||value.sourceManifest.some(f=>!f||typeof f.file!=='string'||!f.file||path.posix.isAbsolute(f.file)||/[\\\x00-\x1f\x7f]/.test(f.file)||f.file.split('/').some(p=>!p||p==='.'||p==='..')||!/^[a-f0-9]{64}$/.test(f.sha256??''))
      ||new Set(value.sourceManifest.map(f=>f.file)).size!==value.sourceManifest.length
      ||sha256(JSON.stringify(value.sourceManifest))!==value.sourceHash)throw new Error('Invalid SEO source evidence.');
    const files=new Map(value.sourceManifest.map(f=>[f.file,f.sha256]));
    if(coverage.layoutFiles.some(f=>!files.has(f))||coverage.liquidFiles>files.size||[...value.findings,...value.observations].some(f=>!f||!files.has(f.file)||files.get(f.file)!==f.sourceHash||!Number.isSafeInteger(f.line)||f.line<1))throw new Error('SEO source finding fingerprint mismatch.');
  } else if(!['document','fragment'].includes(value.scope)||value.sourceAssociation!=='unverified-saved-html'
    ||typeof value.input?.file!=='string'||!path.isAbsolute(value.input.file)||!count(value.input.bytes)||value.input.bytes>20*1024*1024||!/^[a-f0-9]{64}$/.test(value.input.sha256??'')
    ||value.findings.some(f=>f.file!==value.input.file))throw new Error('Invalid saved HTML provenance.');
  if(value.mode==='html'&&(coverage.sourceBinding!=='not-established'||value.observations.length
    ||value.findings.length!==Math.min(200,value.summary.findings)
    ||value.findings.some(f=>f.status!=='rendered-html-observation')))throw new Error('Incomplete HTML finding evidence.');
  const expected=finalizeAudit(value);
  const errors=value.findings.filter(f=>f.severity==='error').length,warnings=value.findings.length-errors;
  if(value.summary.errors<errors||value.summary.warnings<warnings||value.summary.findings!==value.summary.errors+value.summary.warnings
    ||value.findingsTruncated!==(value.summary.findings>value.findings.length)
    ||!value.findingsTruncated&&(value.summary.errors!==errors||value.summary.warnings!==warnings)
    ||Object.keys(value.summary).length!==Object.keys(expected.summary).length||Object.keys(expected.summary).some(k=>expected.summary[k]!==value.summary[k])
    ||['complete','reviewRequired','status'].some(k=>value[k]!==expected[k]))throw new Error('Inconsistent SEO audit result.');
  return value;
}
