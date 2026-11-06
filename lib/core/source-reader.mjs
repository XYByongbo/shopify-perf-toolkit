import path from 'node:path';
import { realpath, open, lstat } from 'node:fs/promises';
import { constants } from 'node:fs';
import {createHash} from 'node:crypto';
import { sha256 as hash } from './source-utils.mjs';
const dirs = /^(assets|blocks|config|layout|locales|sections|snippets|templates)\//;
/** Read-only byte identity also covers protected settings, images and fonts. */
export async function fingerprintThemeFile(root,file) {
  const target=path.join(root,relativeFile(file));
  if(await realpath(target)!==target)throw new Error('Symlink source is unsupported.');
  const handle=await open(target,constants.O_RDONLY|constants.O_NOFOLLOW);
  try {
    const before=await handle.stat();if(!before.isFile())throw new Error('Source is not a regular file.');
    const digest=createHash('sha256'),buffer=Buffer.alloc(65536);let size=0;
    while(true){const {bytesRead}=await handle.read(buffer,0,buffer.length,null);if(!bytesRead)break;size+=bytesRead;if(size>before.size)throw new Error('Source changed during read.');digest.update(buffer.subarray(0,bytesRead));}
    const after=await handle.stat(),current=await lstat(target);
    if(current.ino!==before.ino||current.dev!==before.dev||await realpath(target)!==target||size!==before.size||after.size!==before.size||after.mtimeMs!==before.mtimeMs||after.ctimeMs!==before.ctimeMs)throw new Error('Source changed during read.');
    return digest.digest('hex');
  }finally{await handle.close();}
}
export function relativeFile(file, sourceRoot) {
  if (typeof file !== 'string' || !file || /[\\\x00-\x1f]/.test(file)) throw new Error('Invalid report file path.');
  const relative = path.isAbsolute(file) && sourceRoot ? path.relative(sourceRoot, file) : file;
  if (path.isAbsolute(relative) || relative.split('/').some(part => part === '..' || part === '.') || !dirs.test(relative)) throw new Error('Report paths must be theme-relative or inside metadata.sourceRoot.');
  return relative;
}
/** Read only regular, bounded files under the real theme root; never follow a symlink. */
export async function readThemeSource(root, file, expectedHash) {
  const target = path.join(root, relativeFile(file));
  if (await realpath(target) !== target) throw new Error('Symlink source is unsupported.');
  const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > 5 * 1024 * 1024) throw new Error('Source is not a bounded regular file.');
    const source = await handle.readFile('utf8'), after = await handle.stat();
    if (await realpath(target) !== target || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error('Source changed during read.');
    const sourceHash = hash(source);
    if (expectedHash && expectedHash !== sourceHash) throw new Error('Source fingerprint mismatch.');
    return { source, sourceHash };
  } finally { await handle.close(); }
}
