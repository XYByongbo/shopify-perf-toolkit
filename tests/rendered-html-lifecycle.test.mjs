import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,access,rm,realpath} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import {offlineStep} from '../lib/batch-offline.mjs';

test('the outer HTML batch deadline kills its interpreter instead of leaving an escaped process',
  {skip:process.platform==='win32',timeout:15000},async t=>{
    const root=await realpath(await mkdtemp(path.join(os.tmpdir(),'perfkit-html-deadline-')));
    t.after(()=>rm(root,{recursive:true,force:true}));
    const executable=path.join(root,'interpreter.mjs'),pidfile=path.join(root,'pid'),escaped=path.join(root,'escaped');
    await writeFile(executable,`#!${process.execPath}\nimport {writeFileSync} from 'node:fs';\nwriteFileSync(${JSON.stringify(pidfile)},String(process.pid));\nsetTimeout(()=>{writeFileSync(${JSON.stringify(escaped)},'escaped');console.log('{}');},5000);\n`,{mode:0o700});
    let pid;
    t.after(()=>{if(pid)try{process.kill(pid,'SIGKILL');}catch{}});
    await assert.rejects(offlineStep('audit-html',['--input',path.join(root,'input.html'),'--out',path.join(root,'audit.json')],
      {output:root,timeoutMs:2500},{spawn:(command,args,options)=>spawn(command,args,{...options,env:{...process.env,PERF_KIT_PYTHON:executable}})}),{code:'WALL_TIME_BUDGET'});
    pid=Number(await readFile(pidfile,'utf8'));assert.ok(pid>0);
    await assert.rejects(access(escaped),{code:'ENOENT'});
    const transport=JSON.parse(await readFile(path.join(root,'audit.transport.json'),'utf8'));
    assert.equal(transport.timedOut,true);
  });
