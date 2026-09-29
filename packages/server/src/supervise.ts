import { spawn, type ChildProcess } from 'node:child_process';
import { watch, existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXIT_DATA_DIR_IN_USE, EXIT_PORT_IN_USE } from './exitCodes.ts';
import { checkForUpdate, readUpdateSettings } from './autoUpdate.ts';

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

/**
 * Whether a restart loses nothing now: the engine's own readiness (turns, engine steps, ops, a wake; not a
 * wait for CI), or, from a server too old to report it, no busy turn.
 */
export function restartIdle(state: unknown): boolean {
  const restart = (state as { engine?: { restart?: { idle?: unknown } } } | null)?.engine?.restart;
  return typeof restart?.idle === 'boolean' ? restart.idle : busyTurns(state) === 0;
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
 * changes restart it — but never under a running agent turn: the server drains for an update
 * (nothing new starts, what runs finishes), restarts in that gap, and comes back running. The drain
 * is not the PAUSE lever (#90): it is never persisted, the page says what it waits for, and a pause
 * the user set stays set. Web source changes rebuild the UI, and open pages reload themselves when they see the
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
  const peek = async (): Promise<{ idle: boolean; running: string[] } | undefined> => {
    try { const r = await fetch(`${base}/api/state`, { signal: AbortSignal.timeout(4000) }); if (!r.ok) return undefined; const s = await r.json(); return { idle: restartIdle(s), running: Array.isArray(s?.engine?.restart?.running) ? s.engine.restart.running : [] }; } catch { return undefined; }
  };
  const drainForUpdate = () => fetch(`${base}/api/engine/drain`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ by: 'update' }), signal: AbortSignal.timeout(4000) }).then((r) => r.ok, () => false);
  const nap = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const run = (cmd: string, args: string[]) => new Promise<number>((done) => { spawn(cmd, args, { cwd: ROOT, stdio: 'inherit' }).once('exit', (code) => done(code ?? 1)); });

  // ---- one worker drains the pending set, so a restart and a rebuild never overlap or stack up
  const pending = new Set<string>();
  let timer: NodeJS.Timeout | undefined;
  let working = false;
  // An update (#103) moves the checkout under the watcher: its changes wait until npm ci is done, then restart as one.
  let updating = false;
  const work = async () => {
    if (working || stopping || updating) return;
    working = true;
    try {
      while (pending.size && !stopping) {
        const plan = planFor([...pending]); pending.clear();
        if (plan.rebuild) { log('web source changed: rebuilding the UI'); if (await run('npm', ['run', '--silent', 'build'])) log('web build failed; the previous UI stays in place'); }
        if (!plan.restart) continue;
        // Drain rather than interrupt: agents run most of the day, so an idle gap has to be made. The
        // drain dies with the old process, so there is nothing to undo afterwards (#90: a PAUSE here
        // looked like the user's, was resumed by hand, and could outlive a failed restart).
        const drained = await drainForUpdate();
        for (let s = await peek(), told = false; s && !s.idle && !stopping; s = await peek()) {
          if (!told) { told = true; log(`server source changed: ${drained ? 'draining for the update' : 'could not drain; waiting'}, then restarting once this finishes: ${s.running.length ? s.running.join(', ') : 'the running turns'} (Ctrl-C and rerun to restart now)`); }
          await nap(BUSY_POLL_MS);
        }
        if (stopping) break;
        log('server source changed: restarting');
        await stop();
        if (stopping) break;
        start();
        if (await confirmUp()) log('restarted on the new planestro code');
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

  const shutdown = async () => { if (stopping) return; stopping = true; clearTimeout(timer); clearTimeout(updateTimer); await stop(); releaseSupervisorLock(o.dataDir); process.exit(0); };
  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());

  // Keep this checkout current (#103), re-reading planestro.local.yml each time so a change in Settings needs no restart.
  const poll = async () => {
    if (stopping) return;
    const settings = readUpdateSettings(o.dataDir);
    if (settings.channel !== 'off' && !working) {
      updating = true;
      try {
        const s = await checkForUpdate({ root: ROOT, dataDir: o.dataDir, log });
        if (s.state === 'refused' || s.state === 'error') log(`update: ${s.detail}`);
      } finally { updating = false; if (pending.size) void work(); }
    } else if (settings.channel === 'off') await checkForUpdate({ root: ROOT, dataDir: o.dataDir }).catch(() => undefined);
    if (!stopping) updateTimer = setTimeout(() => void poll(), (settings.channel === 'off' ? 5 : settings.poll_min) * 60_000);
  };
  let updateTimer: NodeJS.Timeout | undefined = setTimeout(() => void poll(), 30_000);

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
