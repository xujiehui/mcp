import { mkdir, open, readFile, stat, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { MoonvyError } from './errors.js';

export async function withFileLock<T>(path: string, fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + 5000;
  for (;;) {
    if (signal?.aborted) throw new MoonvyError('CANCELLED', 'Local storage operation was cancelled.');
    let handle;
    try { handle = await open(path, 'wx', 0o600); }
    catch (error: any) {
      if (error.code !== 'EEXIST') throw error;
      try {
        let owner: any;
        try { owner = JSON.parse(await readFile(path, 'utf8')); } catch { /* A creator may not have written its PID yet. */ }
        if (Number.isSafeInteger(owner?.pid) && owner.pid > 0) {
          try { process.kill(owner.pid, 0); }
          catch (error: any) { if (error.code === 'ESRCH') { await unlink(path).catch(() => {}); continue; } }
        } else if (Date.now() - (await stat(path)).mtimeMs > 60_000) {
          await unlink(path).catch(() => {}); continue;
        }
      } catch (error: any) { if (error.code === 'ENOENT') continue; }
      if (Date.now() >= deadline) throw new MoonvyError('STORAGE_BUSY', 'Local storage is busy; retry this operation.');
      await delay(25, undefined, { signal }).catch(() => {});
      continue;
    }
    try {
      await handle.writeFile(JSON.stringify({ pid: process.pid }));
      if (signal?.aborted) throw new MoonvyError('CANCELLED', 'Local storage operation was cancelled.');
      return await fn();
    } finally {
      await handle.close(); await unlink(path).catch(() => {});
    }
  }
}
