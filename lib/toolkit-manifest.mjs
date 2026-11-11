import {readFile,readdir,lstat} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {digest} from './evidence-contract.mjs';

export const toolkitRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const excluded=new Set(['node_modules','.git','__pycache__','.DS_Store','validation','releases']);
/** Same allowlist as the source release builder. No timestamps or git state in identity. */
export async function toolkitManifest(root=toolkitRoot) {
  const pkg=JSON.parse(await readFile(path.join(root,'package.json'),'utf8')), files=new Map();
  const collect=async relative=>{
    if(relative.split('/').some(p=>excluded.has(p))||/\.(zip|pyc)$/i.test(relative))return;
    const file=path.join(root,relative),stat=await lstat(file);
    if(stat.isSymbolicLink())throw new Error('Toolkit manifest refuses symlinks.');
    if(stat.isDirectory())for(const name of (await readdir(file)).sort())await collect(`${relative}/${name}`);
    else if(stat.isFile())files.set(relative,digest(await readFile(file)));
    else throw new Error('Toolkit manifest requires regular files.');
  };
  for(const entry of ['package.json',...pkg.files]){
    if(typeof entry!=='string'||entry.split('/').some(p=>!p||p==='.'||p==='..')||/[\\:*?\[\]\x00-\x1f]/.test(entry))throw new Error('Invalid release allowlist.');
    await collect(entry);
  }
  const entries=[...files].sort(([a],[b])=>a<b?-1:a>b?1:0).map(([file,sha256])=>({file,sha256}));
  return {schemaVersion:1,kind:'toolkit-manifest',name:pkg.name,version:pkg.version,
    sourceHash:digest(entries.map(e=>`${e.file}\0${e.sha256}\n`).join('')),files:entries,
    validation:'not-assessed',note:'Content identity only; not a signature, test result or storefront acceptance.'};
}
