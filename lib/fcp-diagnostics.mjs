import {readFile,writeFile,mkdir,rename,chmod,lstat,copyFile} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {readEvidenceJSON} from './run-evidence.mjs';

const hash=bytes=>createHash('sha256').update(bytes).digest('hex');

/** Replays the pinned Lantern model, never changes the LHR or acceptance metrics. */
export async function replayFcp({report,trace,devtoolsLog}) {
  const localVersion=JSON.parse(await readFile(new URL('../node_modules/lighthouse/package.json',import.meta.url))).version;
  if(report.lighthouseVersion!==localVersion)throw new Error(`FCP replay requires Lighthouse ${report.lighthouseVersion}; installed ${localVersion}.`);
  if(report.configSettings?.throttlingMethod!=='simulate')throw new Error('FCP replay requires the original simulated navigation.');
  const [{getComputationDataParamsFromDevtoolsLog},{Metrics}]=await Promise.all([
    import('lighthouse/core/computed/metrics/lantern-metric.js'),import('lighthouse/core/lib/lantern/lantern.js')]);
  const data={trace,devtoolsLog,settings:report.configSettings,URL:{requestedUrl:report.requestedUrl,
    mainDocumentUrl:report.finalDisplayedUrl,finalDisplayedUrl:report.finalDisplayedUrl},
    SourceMaps:[],HostDPR:1,gatherContext:{gatherMode:'navigation'}};
  // Explicitly use the normal devtools-log model; do not inherit experimental environment flags.
  const p=await getComputationDataParamsFromDevtoolsLog(data,{computedCache:new Map()});
  const m=Metrics.FirstContentfulPaint.compute(p),origin=p.processedNavigation.timestamps.timeOrigin;
  const serialize=(graph,estimate)=>{
    const nodes=[];
    graph.traverse(n=>{
      const timing=estimate.nodeTimings.get(n);
      nodes.push({id:n.id,type:n.type,observedStartMs:(n.startTime-origin)/1000,durationMs:(n.endTime-n.startTime)/1000,
        simulatedStartMs:timing?.startTime??null,simulatedEndMs:timing?.endTime??null,dependencies:n.getDependencies().map(x=>x.id),
        ...(n.type==='network'?{url:n.request.url,priority:n.request.priority,renderBlocking:n.hasRenderBlockingPriority()}
          :{events:n.childEvents.filter(e=>['Layout','Paint','ParseHTML','EvaluateScript','FunctionCall','ResourceSendRequest','TimerInstall','ScheduleStyleRecalculation','InvalidateLayout'].includes(e.name))
            .map(e=>({name:e.name,atMs:(e.ts-origin)/1000,durationMs:Number.isFinite(e.dur)?e.dur/1000:null,
              ...(e.args?.data?.url?{url:e.args.data.url}:{}),...(e.args?.data?.stackTrace?{stack:e.args.data.stackTrace.map(x=>({function:x.functionName,url:x.url}))}:{})}))})});
    });
    return {timeMs:estimate.timeInMs,nodes};
  };
  const reported=report.audits['first-contentful-paint']?.numericValue,observed=p.processedNavigation.timings.firstContentfulPaint;
  const observedInReport=report.audits.metrics?.details?.items?.[0]?.observedFirstContentfulPaint;
  if(!Number.isFinite(reported)||Math.abs(m.timing-reported)>0.001||!Number.isFinite(observedInReport)||Math.abs(observed-observedInReport)>1)
    throw new Error('Raw artifacts do not reproduce this LHR FCP; no causal conclusion is permitted.');
  const optimistic=serialize(m.optimisticGraph,m.optimisticEstimate),pessimistic=serialize(m.pessimisticGraph,m.pessimisticEstimate);
  // A single observed RunTask can contain script evaluation followed by the first layout.
  // Lantern retains the whole task and its script dependencies. This is evidence of
  // coalescing, not proof that application code causally blocked the paint.
  const taskPaintCouplings=[];
  for(const [name,graph] of Object.entries({optimistic,pessimistic}))for(const node of graph.nodes.filter(n=>n.type==='cpu')) {
    const paint=node.events.find(e=>['Layout','Paint'].includes(e.name));
    if(!paint)continue;
    for(const script of node.events.filter(e=>e.name==='EvaluateScript')) {
      const dependency=graph.nodes.find(n=>n.type==='network'&&n.url===script.url&&node.dependencies.includes(n.id));
      if(!dependency||dependency.url===report.finalDisplayedUrl)continue;
      taskPaintCouplings.push({graph:name,taskId:node.id,scriptUrl:script.url,paintEvent:paint.name,
        scriptStartMs:script.atMs,scriptDurationMs:script.durationMs,paintStartMs:paint.atMs,
        taskDurationMs:node.durationMs,dependencyId:dependency.id});
    }
  }
  return {schemaVersion:1,kind:'lantern-fcp-diagnosis',status:'replayed',purpose:'diagnosis-only',lighthouseVersion:localVersion,
    reportedFcpMs:reported,replayedFcpMs:m.timing,observedFcpMs:observed,
    optimistic,pessimistic,taskPaintCouplings};
}

/** Move sidecars out of the strict LHR directory even when replay is unavailable. */
export async function captureFcpDiagnostics({root,reportRelative,diagnosticsRelative}) {
  const result={status:'unavailable',files:{}};
  const dir=path.join(root,diagnosticsRelative);
  await mkdir(dir,{recursive:true,mode:0o700});
  for(const [key,suffix] of [['trace','trace'],['devtoolsLog','devtoolslog']]) {
    const source=path.join(root,reportRelative.replace(/\.json$/,'')+`-0.${suffix}.json`),relative=`${diagnosticsRelative}/${suffix}.json`;
    try {
      const info=await lstat(source);
      if(!info.isFile()||info.isSymbolicLink()||info.size>128*1024*1024)throw new Error(`Invalid Lighthouse ${suffix} sidecar.`);
      await rename(source,path.join(root,relative));await chmod(path.join(root,relative),0o600);
      const record=await readEvidenceJSON(root,relative);
      result.files[key]={file:relative,sha256:record.sha256};
    }catch(error){result.reason=error.message;}
  }
  try {
    if(!result.files.trace||!result.files.devtoolsLog)throw new Error(result.reason??'Lighthouse raw navigation assets are missing.');
    const [lhr,trace,log]=await Promise.all([reportRelative,result.files.trace.file,result.files.devtoolsLog.file].map(file=>readEvidenceJSON(root,file)));
    result.reportSha256=lhr.sha256;
    const diagnosis=await replayFcp({report:lhr.data,trace:trace.data,devtoolsLog:log.data});
    diagnosis.evidence={reportSha256:lhr.sha256,traceSha256:trace.sha256,devtoolsLogSha256:log.sha256};
    const bytes=JSON.stringify(diagnosis,null,2)+'\n',relative=`${diagnosticsRelative}/fcp.json`;
    await writeFile(path.join(root,relative),bytes,{flag:'wx',mode:0o600});
    result.files.analysis={file:relative,sha256:hash(bytes)};result.reportSha256=lhr.sha256;result.status='replayed';delete result.reason;
  }catch(error){result.reason=error.message;}
  return result;
}

/** Verify each archived file against the manifest and exact original LHR before reading conclusions. */
export async function readFcpDiagnostics(root,record,descriptor) {
  try {
    if(descriptor?.status!=='replayed'||descriptor.reportSha256!==record.sha256)throw new Error('No matching raw FCP replay was saved for this report.');
    const entries={};
    for(const key of ['trace','devtoolsLog','analysis']) {
      const ref=descriptor.files?.[key];if(!ref)throw new Error('Incomplete FCP evidence.');
      const saved=await readEvidenceJSON(root,ref.file);
      if(saved.sha256!==ref.sha256)throw new Error(`FCP ${key} hash changed.`);
      entries[key]=saved;
    }
    const analysis=entries.analysis.data;
    if(analysis.kind!=='lantern-fcp-diagnosis'||analysis.status!=='replayed'||analysis.evidence?.reportSha256!==record.sha256
      ||analysis.evidence?.traceSha256!==entries.trace.sha256||analysis.evidence?.devtoolsLogSha256!==entries.devtoolsLog.sha256)
      throw new Error('FCP analysis binding is invalid.');
    return analysis;
  }catch(error){return {status:'unavailable',reason:error.message};}
}

export async function copyFcpDiagnostics({source,destination,record,descriptor,relative}) {
  if(descriptor?.reportSha256!==record.sha256)return {status:'unavailable',reason:'No matching report binding for diagnostic assets.'};
  if(descriptor.status==='replayed'){
    const analysis=await readFcpDiagnostics(source,record,descriptor);
    if(analysis.status!=='replayed')return analysis;
  }
  await mkdir(path.join(destination,relative),{recursive:true,mode:0o700});
  const copied={...structuredClone(descriptor),files:{}};
  for(const key of ['trace','devtoolsLog','analysis']) {
    const ref=descriptor.files?.[key];if(!ref)continue;
    const original=await readEvidenceJSON(source,ref.file);
    if(original.sha256!==ref.sha256)throw new Error(`FCP ${key} hash changed before copy.`);
    const file=`${relative}/${key}.json`;
    await copyFile(original.file,path.join(destination,file));
    await chmod(path.join(destination,file),0o600);
    const saved=await readEvidenceJSON(destination,file);
    if(saved.sha256!==ref.sha256)throw new Error(`FCP ${key} changed during copy.`);
    copied.files[key]={...ref,file};
  }
  if(copied.status!=='replayed')return copied;
  const checked=await readFcpDiagnostics(destination,record,copied);
  return checked.status==='replayed'?copied:checked;
}
