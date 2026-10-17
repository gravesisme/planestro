import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LiveProcPort } from '../src/engine/live-ports.ts';

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const waitFor = async (pred: () => boolean, ms = 3000) => { const t0 = Date.now(); while (!pred() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 25)); return pred(); };

describe('a command run by planestro ends whole', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pl-proc-'));

  it('at its timeout, with the children it started, which hold its output open', async () => {
    const pidFile = join(dir, 'child.pid');
    const t0 = Date.now();
    const r = await new LiveProcPort().run(`sleep 30 & echo $! > ${pidFile}; echo started; wait`, { cwd: dir, timeoutMs: 400 });
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(r.code).toBe(124);
    expect(r.stdout).toContain('started');
    expect(r.stderr).toMatch(/timed out after/);
    expect(await waitFor(() => !alive(Number(readFileSync(pidFile, 'utf8'))))).toBe(true);
  });

  it('when its turn is stopped', async () => {
    const stop = new AbortController();
    const run = new LiveProcPort().run('sleep 30', { cwd: dir, signal: stop.signal });
    setTimeout(() => stop.abort(), 100);
    const r = await run;
    expect(r.code).toBe(124);
    expect(r.stderr).toMatch(/turn ended/);
  });

  it('says how an ordinary command exited', async () => {
    const p = new LiveProcPort();
    expect(await p.run('echo hi; echo err >&2; exit 3', { cwd: dir })).toEqual({ code: 3, stdout: 'hi\n', stderr: 'err\n' });
    expect((await p.run('printf "$X"', { cwd: dir, env: { X: 'y' }, cleanEnv: true })).stdout).toBe('y');
  });
});
