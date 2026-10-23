import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/** Fixed diagnostic commands; only audit-resources --probe true can use the network.
 * Descendants share the owned process group and remaining batch deadline. */
export async function offlineStep(command, args, { output, timeoutMs }, dependencies = {}) {
  if(process.platform==='win32')throw new Error('Offline batch process-group deadlines require macOS or Linux.');
  if (!['import-check','audit-resources','audit-quality','audit-site','verify-site'].includes(command)) throw new Error('Unsupported offline batch step.');
  const child = (dependencies.spawn ?? spawn)(process.execPath,[fileURLToPath(new URL('../scripts/perfkit.mjs',import.meta.url)),command,...args],
    {shell:false,detached:process.platform!=='win32',stdio:['ignore','pipe','pipe']});
  let stdout='',stderr='',expired=false,timer,hard;
  child.stdout.on('data',b=>{stdout=(stdout+b).slice(0,65536);});
  child.stderr.on('data',b=>{stderr=(stderr+b).slice(0,65536);});
  const kill = signal => {try { (dependencies.kill ?? process.kill.bind(process))(process.platform==='win32'?child.pid:-child.pid,signal); } catch(e) {if(e.code!=='ESRCH')stderr=(stderr+'\nProcess cleanup failed: '+e.code).slice(0,65536);} };
  const exit = await new Promise((resolve,reject)=>{
    child.once('error',reject);child.once('close',code=>resolve(code));
    timer=setTimeout(()=>{expired=true;kill('SIGTERM');hard=setTimeout(()=>kill('SIGKILL'),250);},Math.max(1,Math.floor(timeoutMs)));
  }).finally(()=>{clearTimeout(timer);clearTimeout(hard);});
  await writeFile(path.join(output,command+'.transport.json'),JSON.stringify({exitCode:exit,timedOut:expired,stdout,stderr})+'\n',{flag:'wx',mode:0o600});
  if(expired)throw Object.assign(new Error('Offline batch deadline reached.'),{code:'WALL_TIME_BUDGET'});
  if(![0,3].includes(exit))throw new Error(`${command} failed; inspect its saved transport record.`);
  const filename=args[args.indexOf('--out')+1];
  return JSON.parse(await readFile(filename,'utf8'));
}
