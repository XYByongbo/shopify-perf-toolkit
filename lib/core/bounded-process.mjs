import { spawn } from 'node:child_process';
/** No shell, no inherited stdin, bounded output and an owned process group. */
export function runProcess(command, args, { cwd, timeoutMs = 60000, maxBytes = 32 * 1024 * 1024, env = {}, ownProcessGroup = true } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, shell: false, detached: ownProcessGroup && process.platform !== 'win32', stdio: ['ignore','pipe','pipe'], env: { ...process.env, ...env } });
    const stdout = [], stderr = []; let size = 0, failure, killTimer;
    const kill = signal => { try { if (!ownProcessGroup || process.platform === 'win32') child.kill(signal); else process.kill(-child.pid, signal); } catch {} };
    const stop = (message, code) => { if (failure) return; failure = Object.assign(new Error(message), { code }); kill('SIGTERM'); killTimer = setTimeout(() => kill('SIGKILL'), 500); };
    const timer = setTimeout(() => stop('Process wall-time budget exceeded.', 'WALL_TIME_BUDGET'), timeoutMs);
    for (const [stream, chunks] of [[child.stdout, stdout], [child.stderr, stderr]]) stream.on('data', data => {
      size += data.length; if (size > maxBytes) stop('Process output exceeds the configured limit.', 'OUTPUT_LIMIT'); else chunks.push(data);
    });
    child.on('error', error => { clearTimeout(timer); clearTimeout(killTimer); reject(error); });
    child.on('close', code => { clearTimeout(timer); clearTimeout(killTimer); if (failure) { kill('SIGKILL'); reject(failure); }
      else resolve({ code, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') }); });
  });
}
