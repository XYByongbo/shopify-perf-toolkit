import {access,lstat,realpath,readdir,open} from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {sha256} from './source-utils.mjs';
export {sha256};
export async function browserExecutable(env = process.env) {
  const explicit = env.PERF_KIT_BROWSER_EXECUTABLE || env.PERF_KIT_CHROMIUM_EXECUTABLE || env.CHROME_PATH;
  const candidates = explicit ? [explicit] : process.platform === 'darwin'
    ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
    : process.platform === 'win32' ? [path.join(env.PROGRAMFILES || 'C:\\Program Files', 'Google/Chrome/Application/chrome.exe')]
      : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
  for (const file of candidates) { if (!path.isAbsolute(file)) throw new Error('Browser executable must be absolute.'); try { await access(file); return file; } catch {} }
  throw Object.assign(new Error('Set PERF_KIT_BROWSER_EXECUTABLE to an installed Chrome/Chromium binary. No browser is downloaded.'), { code: 'BROWSER_UNAVAILABLE' });
}
export async function sourceSnapshot(project) {
  const info = await lstat(project); if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Source snapshot requires a real project directory.');
  const root = await realpath(project), files = [], errors = []; let count = 0;
  const walk = async directory => {
    for (const entry of await readdir(path.join(root,directory), { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const file = `${directory}/${entry.name}`;
      if (++count > 10000) throw new Error('Source snapshot exceeds the file-count limit.');
      if (entry.isSymbolicLink()) { errors.push({ file, reason: 'symlink' }); continue; }
      if (entry.isDirectory()) await walk(file);
      else if (/\.(?:liquid|m?js|css|json)$/.test(file)) {
        try {
          if (!entry.isFile() || (await lstat(path.join(root,file))).size > 16 * 1024 * 1024) throw new Error('Source file exceeds 16 MiB or is not regular.');
          // Read-only hashing includes protected config; patch APIs continue to forbid writing it.
          const absolute = path.join(root,file);
          if (await realpath(absolute) !== absolute) throw new Error('Source path changed or follows a symlink.');
          const handle = await open(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
          try {
            const before = await handle.stat();
            if (!before.isFile() || before.size > 16 * 1024 * 1024) throw new Error('Source is not a bounded regular file.');
            const bytes = await handle.readFile(), after = await handle.stat(), named = await lstat(absolute);
            if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || named.ino !== after.ino || named.dev !== after.dev || await realpath(absolute) !== absolute) throw new Error('Source changed during snapshot.');
            files.push({ file, sourceHash: sha256(bytes) });
          } finally { await handle.close(); }
        } catch (error) { errors.push({ file, reason: error.code ?? error.message }); }
      }
    }
  };
  for (const directory of ['assets','blocks','config','layout','locales','sections','snippets','templates']) {
    try { const stat = await lstat(path.join(root, directory)); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Theme directory must not be a symlink.'); await walk(directory); }
    catch (error) { if (error.code !== 'ENOENT') errors.push({ file: directory, reason: error.message }); }
  }
  files.sort((a,b) => a.file.localeCompare(b.file));
  return { project: root, scope: 'theme-text-source', complete: !errors.length && files.length > 0, files, errors, hash: sha256(JSON.stringify(files)) };
}
