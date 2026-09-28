import { spawn, type ChildProcess } from 'node:child_process';
import { watch, existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXIT_DATA_DIR_IN_USE, EXIT_PORT_IN_USE } from './exitCodes.ts';

export interface SuperviseOptions { dataDir: string; serveArgs: string[]; host: string; port: number; open?: boolean; log?: (m: string) => void }

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const CLI = fileURLToPath(new URL('./cli.ts', import.meta.url));
const SERVER_DIRS = ['packages/server/src', 'packages/shared/src'];
const WEB_PATHS = ['packages/web/src', 'packages/web/public', 'packages/web/index.html', 'packages/shared/src'];
const QUIET_MS = 1500;      // a save-all or a branch switch lands as a burst; act once it settles
const BUSY_POLL_MS = 5000;

/** What to do about one burst of changes. Pure, so the policy is testable without processes. */
export function planFor(changed: readonly string[]): { restart: boolean; rebuild: boolean } {
  const under = (paths: readonly string[]) => changed.some((f) => paths.some((p) => f === p || f.startsWith(`${p}/`)));
  return { restart: under(SERVER_DIRS), rebuild: under(WEB_PATHS) };
}

/** `engine.sessions[].busy` from /api/state: a restart kills a running turn, which costs a resume. */
export function busyTurns(state: unknown): number {
  const sessions = (state as { engine?: { sessions?: { busy?: boolean }[] } } | null)?.engine?.sessions;
  return Array.isArray(sessions) ? sessions.filter((s) => s?.busy).length : 0;
}

// ---- one supervisor per data dir (#85, LM 2026-09-28) ----
// Four supervisors on one data dir each restarted their child on every merge pulled into the
// checkout; the children raced for the data-dir lock and the port until none was left. The
// data-dir lock kept writers apart, but nothing kept supervisors apart. This lock does.

export interface SupervisorLock { pid: number; port: number; host: string; started_at: string }
export const supervisorLockPath = (dataDir: string) => join(dataDir, '.planestro', 'supervisor');
const baseUrl = (host: string, port: number) => `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}`;

/** EPERM means the pid exists under another user: alive, not stale. */
export function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
}

/**
 * Take `<data_dir>/.planestro/supervisor`, or name the live supervisor that has it. A lock whose
 * pid is dead (or that does not parse) is stale and replaced, as DataStore does with its own.
 */
export function acquireSupervisorLock(dataDir: string, me: Omit<SupervisorLock, 'started_at'>, alive = pidAlive): { ok: true } | { ok: false; holder: SupervisorLock; message: string } {
  const path = supervisorLockPath(dataDir);
  mkdirSync(join(dataDir, '.planestro'), { recursive: true });
  if (existsSync(path)) {
    let holder: SupervisorLock | undefined;
    try { holder = JSON.parse(readFileSync(path, 'utf8')); } catch { /* unreadable: stale */ }
    if (holder && typeof holder.pid === 'number' && holder.pid !== me.pid && alive(holder.pid)) {
      return { ok: false, holder, message: `${dataDir} is already supervised by pid ${holder.pid} on :${holder.port} (since ${holder.started_at}); stop it (kill ${holder.pid}) or open ${baseUrl(holder.host, holder.port)}` };
    }
  }
  writeFileSync(path, JSON.stringify({ ...me, started_at: new Date().toISOString() } satisfies SupervisorLock));
  return { ok: true };
}

/** Only our own lock: a supervisor that lost a race must not delete the winner's. */
export function releaseSupervisorLock(dataDir: string, pid = process.pid): void {
  const path = supervisorLockPath(dataDir);
  try { if (JSON.parse(readFileSync(path, 'utf8')).pid === pid) unlinkSync(path); } catch { /* gone or unreadable */ }
}

/**
 * What an unexpected child exit means. The data dir or the port held by someone else is fatal:
 * no source change frees it, and a supervisor idling on it hid a dead project (#85). Anything
 * else — a syntax error, a crash — waits for the next change, not a restart loop.
 */
export function childExitVerdict(code: number | null, signal: NodeJS.Signals | null, o: { dataDir: string; host: string; port: number }): { fatal: boolean; message: string } {
  if (code === EXIT_DATA_DIR_IN_USE) return { fatal: true, message: `server exited: ${o.dataDir} is in use by another planestro (see its error above); stopping the supervisor — stop the other one or open it instead` };
  if (code === EXIT_PORT_IN_USE) return { fatal: true, message: `server exited: port ${o.port} on ${o.host} is taken by another process; stopping the supervisor — free the port or pass --port` };
  return { fatal: false, message: `server exited (${signal ?? code}); waiting for a source change to start it again` };
}

/**
 * After a start or restart, poll until the server answers. A child can be alive and still never
 * listen (stuck in startup); the only sign used to be a UI that stopped loading (#85). Stops early
 * once the child is gone: its exit is reported on its own.
 */
export async function waitUntilUp(probe: () => Promise<unknown>, o: { alive: () => boolean; tries?: number; delayMs?: number; nap?: (ms: number) => Promise<unknown> }): Promise<'up' | 'exited' | 'timeout'> {
  const nap = o.nap ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  for (let i = 0; i < (o.tries ?? 120); i++) {
    if (!o.alive()) return 'exited';
    if (await probe()) return 'up';
    await nap(o.delayMs ?? 500);
  }
  return o.alive() ? 'timeout' : 'exited';
}

/**
 * `planestro serve --watch`: keep one server child alive and current. Server or shared source
 * changes restart it — but never under a running agent turn: automation is paused until the
 * running turns finish, the restart happens in that gap, and automation resumes. Web source changes rebuild the UI, and open pages reload themselves when they see the
 * new bundle. A child that dies on a syntax error is restarted by the next change, not in a loop.
 */
export async function supervise(o: SuperviseOptions): Promise<void> {
  const log = o.log ?? ((m: string) => console.log(`[watch] ${m}`));
  const base = baseUrl(o.host, o.port);
  const lock = acquireSupervisorLock(o.dataDir, { pid: process.pid, port: o.port, host: o.host });
  if (!lock.ok) { log(`ERROR: ${lock.message}`); process.exit(1); }
  let child: ChildProcess | undefined;
  let stopping = false;
  let expectedExit = false;

  const start = () => {
    expectedExit = false;
    child = spawn(process.execPath, [...process.execArgv, CLI, 'serve', ...o.serveArgs], { cwd: process.cwd(), stdio: 'inherit' });
    const mine = child;
    mine.once('exit', (code, signal) => {
      if (child === mine) child = undefined;
      if (stopping || expectedExit) return;
      const v = childExitVerdict(code, signal, o);
      if (!v.fatal) return log(v.message);
      log(`ERROR: ${v.message}`);
      stopping = true; clearTimeout(timer); releaseSupervisorLock(o.dataDir); process.exit(code ?? 1);
    });
  };
  // Every start, not only restarts: a child that never answers is otherwise invisible (#85).
  const confirmUp = async (): Promise<boolean> => {
    const r = await waitUntilUp(peek, { alive: () => Boolean(child) && !stopping });
    if (r === 'timeout') log(`ERROR: the server was started but has not answered ${base}/api/state for 60 s; it is running but not serving — check its output above`);
    return r === 'up';
  };
  const stop = () => new Promise<void>((done) => {
    const c = child;
    if (!c || c.exitCode !== null) return done();
    expectedExit = true;
    c.once('exit', () => done());
    c.kill('SIGTERM');
  });
  const peek = async (): Promise<{ busy: number; paused: boolean } | undefined> => {
    try { const r = await fetch(`${base}/api/state`, { signal: AbortSignal.timeout(4000) }); if (!r.ok) return undefined; const s = await r.json(); return { busy: busyTurns(s), paused: Boolean(s?.engine?.paused) }; } catch { return undefined; }
  };
  const lever = (to: 'pause' | 'resume') => fetch(`${base}/api/engine/${to}`, { method: 'POST', signal: AbortSignal.timeout(4000) }).then((r) => r.ok, () => false);
  const nap = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const run = (cmd: string, args: string[]) => new Promise<number>((done) => { spawn(cmd, args, { cwd: ROOT, stdio: 'inherit' }).once('exit', (code) => done(code ?? 1)); });

  // ---- one worker drains the pending set, so a restart and a rebuild never overlap or stack up
  const pending = new Set<string>();
  let timer: NodeJS.Timeout | undefined;
  let working = false;
  const work = async () => {
    if (working || stopping) return;
    working = true;
    try {
      while (pending.size && !stopping) {
        const plan = planFor([...pending]); pending.clear();
        if (plan.rebuild) { log('web source changed: rebuilding the UI'); if (await run('npm', ['run', '--silent', 'build'])) log('web build failed; the previous UI stays in place'); }
        if (!plan.restart) continue;
        // Drain rather than interrupt: agents run most of the day, so an idle gap has to be made.
        // Pausing automation lets running turns finish and starts nothing new; undo it afterwards
        // only if this supervisor was the one that paused.
        let drained = false;
        for (let s = await peek(); s && s.busy > 0 && !stopping; s = await peek()) {
          if (!drained && !s.paused) { drained = await lever('pause'); log(`server source changed: automation paused so ${s.busy} running turn${s.busy === 1 ? '' : 's'} can finish; restarting after that (Ctrl-C and rerun to restart now)`); }
          await nap(BUSY_POLL_MS);
        }
        if (stopping) break;
        log('server source changed: restarting');
        await stop();
        if (stopping) break;
        start();
        const up = await confirmUp();
        if (drained) log(up && await lever('resume') ? 'automation resumed' : 'automation is still PAUSED from the restart drain: resume it in the UI once the server is up');
      }
    } finally { working = false; }
  };
  const changed = (rel: string) => {
    if (/(^|\/)(node_modules|dist)\//.test(rel) || /\.(test|spec)\.tsx?$|~$|\.swp$/.test(rel)) return;
    pending.add(rel);
    clearTimeout(timer);
    timer = setTimeout(() => void work(), QUIET_MS);
  };
  for (const rel of new Set([...SERVER_DIRS, ...WEB_PATHS])) {
    const abs = join(ROOT, rel);
    if (!existsSync(abs)) continue;
    watch(abs, { recursive: true }, (_event, file) => changed(file && !rel.endsWith('.html') ? `${rel}/${String(file).replace(/\\/g, '/')}` : rel));
  }

  const shutdown = async () => { if (stopping) return; stopping = true; clearTimeout(timer); await stop(); releaseSupervisorLock(o.dataDir); process.exit(0); };
  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());

  start();
  void confirmUp();
  log('watching planestro source: server changes restart it between agent turns, web changes rebuild and reload the page');
  if (o.open) void openWhenUp(base, log);
}

export async function openWhenUp(base: string, log: (m: string) => void): Promise<void> {
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(base, { signal: AbortSignal.timeout(1000) })).ok) break; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  spawn(opener, [base], { stdio: 'ignore', shell: process.platform === 'win32', detached: true }).once('error', () => log(`open ${base} in a browser`)).unref();
}
