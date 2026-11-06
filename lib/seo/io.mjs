import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

export const toolkitRoot=fileURLToPath(new URL('../../',import.meta.url));
export function absolute(value,label) {
  if(typeof value!=='string'||!path.isAbsolute(value)||/[\x00-\x1f\x7f]/.test(value))throw new Error(`${label} must be an absolute path.`);
  return path.resolve(value);
}
async function resolvedDestination(file) {
  let ancestor=path.dirname(file),tail=[];
  while(true){try {ancestor=await fs.realpath(ancestor);break;}catch(e){if(e.code!=='ENOENT')throw e;tail.unshift(path.basename(ancestor));ancestor=path.dirname(ancestor);}}
  return path.join(ancestor,...tail,path.basename(file));
}
export async function guardOutput(file,project=null) {
  file=absolute(file,'output');
  const actual=await resolvedDestination(file);
  // A saved audit remains reportable after its source has been moved or removed.
  // Resolve existing roots (including symlinks), and retain the original boundary otherwise.
  let themeRoot;
  if(project){absolute(project,'project');try{themeRoot=await fs.realpath(project);}catch(e){if(e.code!=='ENOENT')throw e;themeRoot=await resolvedDestination(project);}}
  for(const root of [await fs.realpath(toolkitRoot),...(themeRoot?[themeRoot]:[])]) {
    const rel=path.relative(root,actual);
    if(!rel||!rel.startsWith('..'+path.sep)&&rel!=='..'&&!path.isAbsolute(rel))throw new Error('Save audit output outside the toolkit and theme repositories.');
  }
  try {await fs.lstat(file);throw new Error('Output already exists.');}catch(e){if(e.code!=='ENOENT')throw e;}
  return file;
}
export async function saveFile(file,data) {
  await fs.mkdir(path.dirname(file),{recursive:true});
  await fs.writeFile(file,typeof data==='string'?data:JSON.stringify(data,null,2)+'\n',{flag:'wx',mode:0o600});
}
export const readJSON=async file=>JSON.parse(await fs.readFile(absolute(file,'input'),'utf8'));
