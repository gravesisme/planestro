import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';

/** EPERM means the pid exists under another user: alive, not stale. */
export function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
}

/**
 * Take a lock file holding `{ pid, … }`, created exclusively (`wx`): checking for it and then writing it let two
 * processes starting together (a `--watch` restart beside a `planestro start`) both take it, two writers of one data
 * dir (invariant 1). A lock this process holds is rewritten; one whose pid is dead, or that does not parse, is stale
 * and replaced once. Otherwise the holder, as it parsed, is returned.
 */
export function takePidLock(path: string, body: Record<string, unknown> & { pid: number }, alive: (pid: number) => boolean = pidAlive): { ok: true } | { ok: false; holder: Record<string, unknown> & { pid: number } } {
  const text = JSON.stringify(body);
  for (let attempt = 0; ; attempt++) {
    try { writeFileSync(path, text, { flag: 'wx' }); return { ok: true }; }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
    let holder: (Record<string, unknown> & { pid: number }) | undefined;
    try { const h = JSON.parse(readFileSync(path, 'utf8')); if (h && typeof h.pid === 'number') holder = h; } catch { /* unreadable: stale */ }
    if (holder?.pid === body.pid) { writeFileSync(path, text); return { ok: true }; }
    if (holder && alive(holder.pid)) return { ok: false, holder };
    if (attempt > 0) throw new Error(`${path}: could not take the lock (a stale one kept coming back)`);
    try { unlinkSync(path); } catch { /* another process removed it first */ }
  }
}
