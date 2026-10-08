import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, openSync, closeSync, readFileSync, readdirSync, unlinkSync, writeFileSync, appendFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG_FILE, readLocalConfig } from './config.ts';
import { bindHost } from './guard.ts';
import { EXIT_DATA_DIR_IN_USE, EXIT_PORT_IN_USE } from './exitCodes.ts';
import { pidAlive } from './supervise.ts';

// ---- `planestro start` / `stop` / `status` (#175) ----
// A server started as a Claude Code background task died at that task's 2-hour cap, and took the
// worker turns it was driving with it (Hurricane Harrison's start-planestro.sh, #529 there). `start`
// runs `serve` in a session of its own, so it outlives the terminal; `stop` ends that session's whole
// process group, so a `--watch` supervisor and whichever child it restarted go together. Several
// servers share one machine (HH on 4300, LM on 4301): each is recorded under its own data dir, and
// nothing here ever stops or adopts a server it cannot positively identify as the one asked for.

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const CLI = fileURLToPath(new URL('./cli.ts', import.meta.url));

export interface Instance {
  data_dir: string; port: number; host: string; url: string;
  pid: number; pgid: number; watch: boolean; log: string; started_at: string;
}

export const instancePath = (dataDir: string) => join(dataDir, '.planestro', 'instance.json');
export const serveLogPath = (dataDir: string) => join(dataDir, '.planestro', 'serve.log');
/** One pointer per recorded data dir, so `status` and `stop --all` can find every instance on the machine. */
const indexDir = () => join(process.env.PLANESTRO_HOME ?? join(homedir(), '.planestro'), 'instances');
const indexPath = (dataDir: string) => join(indexDir(), `${createHash('sha1').update(dataDir).digest('hex').slice(0, 16)}.json`);
export const localUrl = (host: string, port: number) => `http://${host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host}:${port}`;

/** What the OS says a pid is running, or undefined when it is gone. */
export function commandOf(pid: number): string | undefined {
  try { return execFileSync('ps', ['-ww', '-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }).trim() || undefined; } catch { return undefined; }
}
export function pgidOf(pid: number): number | undefined {
  try { const n = Number(execFileSync('ps', ['-o', 'pgid=', '-p', String(pid)], { encoding: 'utf8' }).trim()); return n > 0 ? n : undefined; } catch { return undefined; }
}
export function ppidOf(pid: number): number | undefined {
  try { const n = Number(execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8' }).trim()); return n > 0 ? n : undefined; } catch { return undefined; }
}
/** The pid listening on a TCP port (any address), or undefined. lsof is on macOS and most Linux installs. */
export function portListener(port: number): number | undefined {
  try { const pid = Number(execFileSync('lsof', ['-nP', '-t', `-iTCP:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' }).split('\n')[0]); return pid > 0 ? pid : undefined; } catch { return undefined; }
}
export function groupAlive(pgid: number): boolean {
  try { process.kill(-pgid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
}

/** A command line that is `planestro serve <dataDir>`, however it was launched (npm, tsx, node, the bin). */
export function servesDataDir(command: string | undefined, dataDir: string): boolean {
  if (!command) return false;
  const i = command.indexOf(` serve ${dataDir}`);
  if (i < 0) return false;
  const after = command[i + ` serve ${dataDir}`.length];
  return after === undefined || after === ' ' || after === '/';
}

export function readInstance(dataDir: string): Instance | undefined {
  try { const r = JSON.parse(readFileSync(instancePath(dataDir), 'utf8')); return typeof r?.pid === 'number' && typeof r?.pgid === 'number' ? r : undefined; } catch { return undefined; }
}
function writeInstance(r: Instance): void {
  mkdirSync(join(r.data_dir, '.planestro'), { recursive: true });
  writeFileSync(instancePath(r.data_dir), JSON.stringify(r, null, 2));
  mkdirSync(indexDir(), { recursive: true });
  writeFileSync(indexPath(r.data_dir), JSON.stringify({ data_dir: r.data_dir }));
}
export function forgetInstance(dataDir: string): void {
  for (const p of [instancePath(dataDir), indexPath(dataDir)]) { try { unlinkSync(p); } catch { /* already gone */ } }
}

/**
 * A record is live only while its process group exists and its leader (or, after the leader died,
 * a process on its port) is still `serve <this data dir>`: a recycled pid is not our server.
 */
export function instanceAlive(r: Instance, o: { command?: (pid: number) => string | undefined; listener?: (port: number) => number | undefined; group?: (pgid: number) => boolean } = {}): boolean {
  const command = o.command ?? commandOf, listener = o.listener ?? portListener, group = o.group ?? groupAlive;
  if (!group(r.pgid)) return false;
  if (servesDataDir(command(r.pid), r.data_dir)) return true;
  const holder = listener(r.port);
  return holder !== undefined && servesDataDir(command(holder), r.data_dir) && pgidOf(holder) === r.pgid;
}

/** Every recorded instance on this machine. Stale records (process gone, or a pid now running something else) are pruned. */
export function listInstances(o: { prune?: boolean } = {}): { live: Instance[]; pruned: string[] } {
  const live: Instance[] = [], pruned: string[] = [];
  let entries: string[] = [];
  try { entries = readdirSync(indexDir()).filter((f) => f.endsWith('.json')); } catch { /* none yet */ }
  for (const f of entries) {
    let dataDir: string | undefined;
    try { dataDir = JSON.parse(readFileSync(join(indexDir(), f), 'utf8')).data_dir; } catch { /* unreadable */ }
    const r = dataDir ? readInstance(dataDir) : undefined;
    if (r && instanceAlive(r)) { live.push(r); continue; }
    if (o.prune !== false) {
      if (dataDir) { pruned.push(dataDir); forgetInstance(dataDir); }
      try { unlinkSync(join(indexDir(), f)); } catch { /* gone */ }
    }
  }
  return { live: live.sort((a, b) => a.port - b.port), pruned };
}

/** The live instance for a data dir; a stale record is removed on the way. */
export function liveInstance(dataDir: string): Instance | undefined {
  const r = readInstance(dataDir);
  if (!r) return undefined;
  if (instanceAlive(r)) return r;
  forgetInstance(dataDir);
  return undefined;
}

const lockFile = (dataDir: string) => join(dataDir, '.planestro', 'lock');

/**
 * Whether a lock's pid is really a planestro on this data dir: its `serve`, or another planestro
 * command naming the dir (a `reconcile`, a `check`). A live pid alone is not enough: the OS reuses
 * pids, and a lock naming some unrelated process would otherwise keep the data dir shut for good.
 */
export function lockHeldBy(command: string | undefined, dataDir: string): boolean {
  return servesDataDir(command, dataDir) || (command !== undefined && /(planestro|cli\.ts)/.test(command) && command.includes(dataDir));
}

/** The pid in `<data_dir>/.planestro/lock` when a planestro that `start` did not record holds the data dir. */
function dataDirLockHolder(dataDir: string, command: (pid: number) => string | undefined = commandOf): number | undefined {
  try { const { pid } = JSON.parse(readFileSync(lockFile(dataDir), 'utf8')); return typeof pid === 'number' && pidAlive(pid) && lockHeldBy(command(pid), dataDir) ? pid : undefined; } catch { return undefined; }
}

/**
 * Remove a lock whose pid is alive but is not a planestro on this data dir (a reused pid). The
 * DataStore checks only that the pid is alive, so `serve` would refuse it forever. A dead pid's
 * lock is left for the DataStore, which replaces it itself. Returns the pid it cleared.
 */
export function clearForeignLock(dataDir: string, command: (pid: number) => string | undefined = commandOf): { pid: number; command: string } | undefined {
  let pid: unknown;
  try { pid = JSON.parse(readFileSync(lockFile(dataDir), 'utf8')).pid; } catch { return undefined; }
  if (typeof pid !== 'number' || !pidAlive(pid)) return undefined;
  const cmd = command(pid);
  if (lockHeldBy(cmd, dataDir)) return undefined;
  try { unlinkSync(lockFile(dataDir)); } catch { return undefined; }
  return { pid, command: cmd ?? '?' };
}

export class StartRefused extends Error { constructor(message: string, readonly exitCode: number) { super(message); } }

export interface StartOptions {
  dataDir: string; port?: number; host?: string; watch?: boolean;
  timeoutMs?: number; log?: (m: string) => void;
  /** The `serve` command to run, for tests; defaults to this checkout's CLI under the running node and loader. */
  serveCommand?: (args: string[]) => { cmd: string; args: string[] };
}

export interface StartResult {
  instance: Instance; corrections: string[] | undefined; reconcileError?: string;
  /** The data dir's own server was already up on the port asked for: nothing was started (a wrapper's desired state already holds). */
  already?: boolean;
  /** A stale lock naming an unrelated process, removed before starting. */
  clearedLock?: { pid: number; command: string };
}

/**
 * `planestro start`: refuse a data dir or port someone already holds (naming them), run `serve`
 * detached in a new session, wait until it answers, record it, then reconcile.
 */
export async function startInstance(o: StartOptions): Promise<StartResult> {
  const dataDir = resolve(o.dataDir);
  if (!existsSync(join(dataDir, CONFIG_FILE))) throw new Error(`not a planestro data dir (no ${CONFIG_FILE}): ${dataDir}`);
  // lan_access (#255) is read at each start; the serve it records gets the resolved --host, so the record says where it listens.
  const port = o.port ?? 4300, host = bindHost(o.host, readLocalConfig(dataDir));

  const running = liveInstance(dataDir);
  if (running && running.port === port && running.host === host) return { instance: running, corrections: undefined, already: true };
  if (running) throw new StartRefused(`${dataDir} already has a server on ${running.host}:${running.port}, not the ${host}:${port} asked for: ${running.url} (pid ${running.pid}, process group ${running.pgid}, log ${running.log}); \`planestro stop ${dataDir}\` first to move it`, EXIT_DATA_DIR_IN_USE);
  const clearedLock = clearForeignLock(dataDir);
  const locker = dataDirLockHolder(dataDir);
  if (locker) throw new StartRefused(`${dataDir} is held by a planestro started some other way (pid ${locker}: ${commandOf(locker) ?? '?'}); not starting another — \`planestro stop ${dataDir}\` stops it`, EXIT_DATA_DIR_IN_USE);
  const holder = portListener(port);
  if (holder) throw new StartRefused(`port ${port} is in use by pid ${holder} (${commandOf(holder) ?? '?'}); not starting — free it or pass --port`, EXIT_PORT_IN_USE);

  const log = serveLogPath(dataDir);
  mkdirSync(join(dataDir, '.planestro'), { recursive: true });
  const serveArgs = ['serve', dataDir, '--port', String(port), '--host', host, ...(o.watch ? ['--watch'] : [])];
  const { cmd, args } = o.serveCommand?.(serveArgs) ?? { cmd: process.execPath, args: [...(process.execArgv.some((a) => a.includes('tsx')) ? process.execArgv : ['--import', 'tsx']), CLI, ...serveArgs] };
  appendFileSync(log, `\n==== planestro start ${new Date().toISOString()}: ${serveArgs.join(' ')}\n`);
  const fd = openSync(log, 'a');
  // detached: the child leads a new session and process group (setsid), so it survives this
  // terminal and a Claude Code task cap, and `stop` can signal the group as a whole.
  const child = spawn(cmd, args, { cwd: ROOT, detached: true, stdio: ['ignore', fd, fd] });
  closeSync(fd);
  let exited: number | null | undefined;
  child.once('exit', (code) => { exited = code; });
  child.unref();
  const pid = child.pid!;
  const instance: Instance = { data_dir: dataDir, port, host, url: localUrl(host, port), pid, pgid: pid, watch: Boolean(o.watch), log, started_at: new Date().toISOString() };
  writeInstance(instance);

  const deadline = Date.now() + (o.timeoutMs ?? 90_000);
  for (;;) {
    if (exited !== undefined) {
      forgetInstance(dataDir);
      throw new StartRefused(`the server exited (code ${exited}) before it answered; the last lines of ${log}:\n${tail(log, 15)}`, exited === EXIT_DATA_DIR_IN_USE || exited === EXIT_PORT_IN_USE ? exited : 1);
    }
    if (await answers(instance.url)) break;
    if (Date.now() > deadline) {
      await stopGroup(pid, { graceMs: 5000 });
      forgetInstance(dataDir);
      throw new Error(`the server did not answer ${instance.url} within ${Math.round((o.timeoutMs ?? 90_000) / 1000)} s and was stopped; see ${log}:\n${tail(log, 15)}`);
    }
    await nap(300);
  }
  try {
    const r = await fetch(`${instance.url}/api/reconcile`, { method: 'POST', signal: AbortSignal.timeout(120_000) });
    const body = await r.json() as { corrections?: string[]; error?: string };
    return r.ok ? { instance, corrections: body.corrections ?? [], clearedLock } : { instance, corrections: undefined, reconcileError: body.error ?? `HTTP ${r.status}`, clearedLock };
  } catch (e) { return { instance, corrections: undefined, reconcileError: (e as Error).message, clearedLock }; }
}

async function answers(url: string): Promise<boolean> {
  try { return (await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(1500) })).ok; } catch { return false; }
}
const nap = (ms: number) => new Promise((r) => setTimeout(r, ms));
function tail(path: string, lines: number): string {
  try { return readFileSync(path, 'utf8').trimEnd().split('\n').slice(-lines).map((l) => `  ${l}`).join('\n'); } catch { return '  (no log)'; }
}

/**
 * SIGTERM the whole process group (npm, tsx, the server, a `--watch` supervisor and whichever child
 * it restarted last), then SIGKILL whatever is left after the grace period. Resolves once the group is gone.
 */
export async function stopGroup(pgid: number, o: { graceMs?: number; log?: (m: string) => void } = {}): Promise<'stopped' | 'killed' | 'not_running'> {
  if (pgid <= 1 || pgid === process.pid || pgid === pgidOf(process.pid)) throw new Error(`refusing to signal process group ${pgid}: it is this process's own`);
  if (!groupAlive(pgid)) return 'not_running';
  try { process.kill(-pgid, 'SIGTERM'); } catch { /* gone in between */ }
  const deadline = Date.now() + (o.graceMs ?? 15_000);
  while (Date.now() < deadline) { if (!groupAlive(pgid)) return 'stopped'; await nap(200); }
  o.log?.(`process group ${pgid} still up after ${Math.round((o.graceMs ?? 15_000) / 1000)} s; sending SIGKILL`);
  try { process.kill(-pgid, 'SIGKILL'); } catch { /* gone */ }
  for (let i = 0; i < 25 && groupAlive(pgid); i++) await nap(200);
  return 'killed';
}

export async function stopInstance(r: Instance, o: { graceMs?: number; log?: (m: string) => void } = {}): Promise<'stopped' | 'killed' | 'not_running'> {
  const how = await stopGroup(r.pgid, o);
  forgetInstance(r.data_dir);
  return how;
}

/**
 * A planestro that `start` did not record (run in a terminal, or by an older script), found by its
 * port or its data-dir lock. Its group may be a shell's or a Claude Code session's, so it is never
 * signalled as a group: the server is stopped, or its `--watch` supervisor when it has one (which
 * stops the child itself). Anything that is not `planestro serve` is refused.
 */
export async function stopUnrecorded(pid: number, o: { graceMs?: number; log?: (m: string) => void } = {}): Promise<{ pid: number; command: string } | { refused: string }> {
  const command = commandOf(pid) ?? '';
  const m = / serve (\S+)/.exec(command);
  if (!m || !/(planestro|cli\.ts)/.test(command)) return { refused: `pid ${pid} is not a planestro server (${command || 'gone'}); not stopping it` };
  const parent = ppidOf(pid);
  const parentCmd = parent ? commandOf(parent) : undefined;
  const target = parent && servesDataDir(parentCmd, m[1]) && / --watch\b/.test(parentCmd!) ? parent : pid;
  const targetCmd = commandOf(target) ?? command;
  try { process.kill(target, 'SIGTERM'); } catch { /* gone */ }
  const deadline = Date.now() + (o.graceMs ?? 15_000);
  while (Date.now() < deadline && (pidAlive(target) || pidAlive(pid))) await nap(200);
  for (const p of [target, pid]) if (pidAlive(p)) { o.log?.(`pid ${p} still up after the grace period; sending SIGKILL`); try { process.kill(p, 'SIGKILL'); } catch { /* gone */ } }
  return { pid: target, command: targetCmd };
}

/** The pid of an unrecorded planestro holding this data dir: its lock, else a listener serving it. */
export function unrecordedHolder(dataDir: string, port?: number): number | undefined {
  const locker = dataDirLockHolder(dataDir);
  if (locker) return locker;
  const listener = port ? portListener(port) : undefined;
  return listener && servesDataDir(commandOf(listener), dataDir) ? listener : undefined;
}

export function uptime(startedAt: string, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - Date.parse(startedAt)) / 1000));
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : m ? `${m}m` : `${s}s`;
}

export function describeInstance(r: Instance): string {
  let size = '';
  try { size = ` (${Math.round(statSync(r.log).size / 1024)} KB)`; } catch { /* no log */ }
  return `${r.data_dir}\n  ${r.url}${r.host === '0.0.0.0' ? ' (listening on 0.0.0.0)' : ''}  pid ${r.pid}  process group ${r.pgid}  up ${uptime(r.started_at)}${r.watch ? '  --watch' : ''}\n  mcp ${r.url}/mcp\n  log ${r.log}${size}`;
}
