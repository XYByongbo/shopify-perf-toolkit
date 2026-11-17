import {scanInventory} from './core/source-scan.mjs';
import {inspectSourceText} from './inspect.mjs';
import {inspectPerformanceSource} from './performance-rules.mjs';

/** Legacy performance scan; inventory and traversal are shared with seokit. */
export async function scanTheme({project,pages=[],analysis,syntax}={}) {
  const findings=[],performance=[],coverageMap=new Map();
  const scan=await scanInventory({project,pages,analysis,onSource:({project,target:file,source,sourceHash,validUtf8})=>{
    // The legacy scan could not bind replacement characters to the original file bytes.
    if (!validUtf8) throw Object.assign(new Error('Source is not valid UTF-8.'), {code:'FILE_CHANGED'});
    const inspection=inspectSourceText({projectRoot:project,relativeTarget:file,source,sourceHash});
    const perf=inspectPerformanceSource({source,file,sourceHash,syntax});
    performance.push({file,sourceHash,...perf});findings.push(...perf.findings);
    for(const finding of inspection.findings)findings.push({...finding,id:`${file}:${finding.id}`,file,sourceHash});
    for(const item of inspection.coverage){
      if(!coverageMap.has(item.ruleId))coverageMap.set(item.ruleId,{ruleId:item.ruleId,files:0,statuses:{},note:'Counts are per inspected source file; absence of a candidate is not a pass.'});
      const aggregate=coverageMap.get(item.ruleId);aggregate.files++;aggregate.statuses[item.status]=(aggregate.statuses[item.status]??0)+1;
    }
  }});
  const files=scan.inventory.files;
  const candidates = findings.map((finding) => ({ id: finding.id, file: finding.file, sourceHash: finding.sourceHash, ruleId: finding.ruleId, priority: ['CMP03', 'CMP04'].includes(finding.ruleId) ? 'P1' : 'P2', status: 'candidate', summary: finding.summary, evidence: finding.evidence, verification: finding.verification, basis: 'Static pattern; severity and runtime cost have not been measured.' }));
  for (const asset of files.filter((file) => file.path.startsWith('assets/') && ((['javascript', 'css'].includes(file.kind) && file.rawBytes >= 100 * 1024) || (['image', 'media', 'font'].includes(file.kind) && file.rawBytes >= 500 * 1024)))) candidates.push({ id: `${asset.path}:RAW_BYTES`, file: asset.path, sourceHash: asset.sha256, ruleId: 'RAW_BYTES', priority: 'P2', status: 'candidate', summary: 'Large local asset is a resource-cost review candidate.', evidence: [{ file: asset.path, rawBytes: asset.rawBytes }], verification: ['Check whether and where the asset is requested, transfer compression, cache, viewport and business purpose before changing it.'], basis: 'Heuristic: JS/CSS at least 100 KiB, media/font/image at least 500 KiB. Raw bytes are not network transfer bytes or measured impact.' });
  candidates.sort((a, b) => a.priority.localeCompare(b.priority) || a.file.localeCompare(b.file) || a.id.localeCompare(b.id));
  return {...scan,kind:'site-scan',findings,candidates,performance,
    coverage:[...coverageMap.values()].sort((a,b)=>a.ruleId.localeCompare(b.ruleId)),
    summary:{...scan.summary,findings:findings.length,candidates:candidates.length}};
}
