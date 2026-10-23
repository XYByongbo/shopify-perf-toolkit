#!/usr/bin/env node
// Offline replay of the original saved LHR/trace/log; never collects new measurements.
import {readFile,writeFile} from 'node:fs/promises';
import {replayFcp} from '../lib/fcp-diagnostics.mjs';
import {createHash} from 'node:crypto';
const [reportPath,tracePath,logPath,output]=process.argv.slice(2);
if(!reportPath||!tracePath||!logPath||!output)throw new Error('Usage: node scripts/inspect_lantern_fcp.mjs LHR TRACE DEVTOOLSLOG NEW_OUTPUT');
const bytes=await Promise.all([reportPath,tracePath,logPath].map(p=>readFile(p)));
const [report,trace,devtoolsLog]=bytes.map(b=>JSON.parse(b));
const result=await replayFcp({report,trace,devtoolsLog});
result.evidence=Object.fromEntries(['reportSha256','traceSha256','devtoolsLogSha256'].map((key,i)=>[key,createHash('sha256').update(bytes[i]).digest('hex')]));
await writeFile(output,JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o600});
console.log(JSON.stringify({output,status:result.status,reportedFcpMs:result.reportedFcpMs,replayedFcpMs:result.replayedFcpMs,observedFcpMs:result.observedFcpMs}));
