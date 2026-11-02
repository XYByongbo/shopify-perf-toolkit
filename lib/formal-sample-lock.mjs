import path from 'node:path';
import {realpath,lstat} from 'node:fs/promises';
import {readEvidenceJSON} from './run-evidence.mjs';

// A missing report must not make the other, already-readable raw reports replaceable.
// Mutate locks as each file succeeds so partial progress survives a later read failure.
export async function pinAvailableFormalFiles(directory,locks,observation={}) {
  let root;
  try {
    if((await lstat(directory)).isSymbolicLink())throw new Error('Formal sample directories must not be symlinks.');
    root=await realpath(directory);
  }catch(error){if(error.code==='ENOENT')return;throw error;}
  const errors=[];
  const pin=async relative=>{
    const key=path.join(root,relative);
    try {
      const file=await readEvidenceJSON(root,relative);
      if(locks[key]&&locks[key]!==file.sha256)throw new Error('Previously recorded formal sample file changed.');
      locks[key]=file.sha256;return file.data;
    }catch(error){if(error.code!=='ENOENT'||locks[key])errors.push(error);}
  };
  const manifest=await pin('run.json');
  const groups=Array.isArray(manifest?.groups)?manifest.groups:[];
  const declared=groups.reduce((sum,g)=>sum+Math.max(...['reports','validReports','attempts'].map(k=>Array.isArray(g[k])?g[k].length:0)),0);
  const attempted=manifest?.counts?.attempted;
  observation.attempted=Math.max(declared,Number.isSafeInteger(attempted)&&attempted>=0?attempted:0);
  const names=new Set(Object.keys(locks).filter(key=>key.startsWith(root+path.sep)).map(key=>path.relative(root,key)));
  for(const group of groups) {
    if(Array.isArray(group.reports))for(const report of group.reports) {
      if(typeof report!=='string'||names.size>=10000)throw new Error('Invalid formal report file list.');
      names.add(report);
    }
  }
  names.delete('run.json');
  for(const name of names)await pin(name);
  observation.attempted=Math.max(observation.attempted,Object.keys(locks).filter(key=>key.startsWith(root+path.sep)&&key!==path.join(root,'run.json')).length);
  if(errors.length)throw errors[0];
}
