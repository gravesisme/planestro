import { spawn, type ChildProcess } from 'node:child_process';
import { watch, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface SuperviseOptions { serveArgs: string[]; host: string; port: number; open?: boolean; log?: (m: string) => void }

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
 * `planestro serve --watch`: keep one server child alive and current. Server or shared source
 * changes restart it — but never under a running agent turn: automation is paused until the
 * running turns finish, the restart happens in that gap, and automation resumes. Web source changes rebuild the UI, and open pages reload themselves when they see the
 * new bundle. A child that dies on a syntax error is restarted by the next change, not in a loop.
 */
export async function supervise(o: SuperviseOptions): Promise<void> {
  const log = o.log ?? ((m: string) => console.log(`[watch] ${m}`));
  const urlHost = o.host === '0.0.0.0' ? '127.0.0.1' : o.host;
  const base = `http://${urlHost}:${o.port}`;
  let child: ChildProcess | undefined;
  let stopping = false;
  let expectedExit = false;

  const start = () => {
    expectedExit = false;
    child = spawn(process.execPath, [...process.execArgv, CLI, 'serve', ...o.serveArgs], { cwd: process.cwd(), stdio: 'inherit' });
    const mine = child;
    mine.once('exit', (code, signal) => {
      if (child === mine) child = undefined;
      if (stopping) return;
      if (!expectedExit) log(`server exited (${signal ?? code}); waiting for a source change to start it again`);
    });
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
        if (drained) {
          let up = false;
          for (let i = 0; i < 120 && !stopping && child; i++) { if (await peek()) { up = true; break; } await nap(500); }
          log(up && await lever('resume') ? 'automation resumed' : 'automation is still PAUSED from the restart drain: resume it in the UI once the server is up');
        }
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

  const shutdown = async () => { if (stopping) return; stopping = true; clearTimeout(timer); await stop(); process.exit(0); };
  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());

  start();
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
