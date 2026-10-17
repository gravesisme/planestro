import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';
import { LocalConfig } from '@planestro/shared';
import { atomicWrite } from './store/atomicWrite.ts';

/**
 * `serve --watch` keeping its own planestro checkout current (#103). Each project runs planestro from a
 * clone of its own (HH and LM shared one, where planestro is also developed, and a branch switch went
 * live on both: 2026-09-28). This moves that clone, never the data dir, to the newest `main` commit whose
 * CI passed and has been green for `min_age_hours`; the supervisor's own watch then drains and restarts.
 * The choices are pure functions below; `checkForUpdate` does the git and GitHub around them.
 */

export type UpdateSettings = LocalConfig['update'];
export interface UpdateStatus {
  channel: string;
  running: string;
  checked_at: string;
  state: 'off' | 'current' | 'updated' | 'waiting' | 'refused' | 'error';
  detail: string;
  target?: string;
}

export interface CheckRun { status: string; conclusion: string | null; completed_at?: string | null }
export type CiVerdict = { state: 'green'; completedAt: number } | { state: 'pending' | 'red' | 'none' };

/** All check runs on a commit finished and none failed (skipped and neutral are not failures); when the last one finished. */
export function ciVerdict(runs: CheckRun[]): CiVerdict {
  if (!runs.length) return { state: 'none' };
  if (runs.some((r) => r.status !== 'completed')) return { state: 'pending' };
  if (runs.some((r) => !['success', 'skipped', 'neutral'].includes(r.conclusion ?? ''))) return { state: 'red' };
  if (!runs.some((r) => r.conclusion === 'success')) return { state: 'none' };
  return { state: 'green', completedAt: Math.max(...runs.map((r) => Date.parse(r.completed_at ?? '') || 0)) };
}

/** `export const SCHEMA_VERSION = 3;` in a commit's schema.ts. */
export function schemaVersionIn(source: string): number | undefined {
  const m = /export const SCHEMA_VERSION = (\d+);/.exec(source);
  return m ? Number(m[1]) : undefined;
}

/**
 * The commit to move to: the newest of `newer` (commits on origin/main after HEAD, newest first) whose CI is
 * green and has been for `minAgeMs`, and whose data schema is not older than the data dir's. Otherwise why not.
 */
export function pickUpdate(newer: { sha: string; ci: CiVerdict; schema?: number }[], o: { minAgeMs: number; now: number; dataSchema: number }): { sha: string } | { wait: string } {
  if (!newer.length) return { wait: 'already on the newest main' };
  for (const c of newer) {
    if (c.ci.state !== 'green') continue;
    if (c.schema !== undefined && c.schema < o.dataSchema) continue;
    if (o.now - c.ci.completedAt < o.minAgeMs) continue;
    return { sha: c.sha };
  }
  const newest = newer[0];
  if (newest.ci.state === 'pending') return { wait: `CI is still running for ${newest.sha.slice(0, 7)}` };
  const young = newer.find((c) => c.ci.state === 'green');
  if (young && young.ci.state === 'green') return { wait: `${young.sha.slice(0, 7)} has been green for less than the soak time (min_age_hours)` };
  return { wait: `no newer main commit has passed CI (newest ${newest.sha.slice(0, 7)} is ${newest.ci.state})` };
}

/** `git@github.com:owner/repo.git` or `https://github.com/owner/repo(.git)` → `owner/repo`. */
export function githubRepoOf(url: string): string | undefined {
  const m = /github\.com[:/]([^/]+\/[^/.]+?)(?:\.git)?\/?$/.exec(url.trim());
  return m?.[1];
}

export function readUpdateSettings(dataDir: string): UpdateSettings {
  try {
    const raw = YAML.parse(readFileSync(join(dataDir, 'planestro.local.yml'), 'utf8')) ?? {};
    return LocalConfig.parse(raw).update;
  } catch { return LocalConfig.parse({}).update; }
}

export const updateStatusPath = (dataDir: string) => join(dataDir, '.planestro', 'update.json');
export function writeUpdateStatus(dataDir: string, s: UpdateStatus): void {
  atomicWrite(updateStatusPath(dataDir), JSON.stringify(s, null, 2));
}
export function readUpdateStatus(dataDir: string): UpdateStatus | undefined {
  try { return existsSync(updateStatusPath(dataDir)) ? JSON.parse(readFileSync(updateStatusPath(dataDir), 'utf8')) : undefined; } catch { return undefined; }
}

const run = promisify(execFile);
export type Exec = (cmd: string, args: string[], cwd: string) => Promise<string>;
const realExec: Exec = async (cmd, args, cwd) => (await run(cmd, args, { cwd, maxBuffer: 16 * 1024 * 1024, timeout: 10 * 60_000 })).stdout;

/**
 * One poll. Moves `root` (the planestro checkout this supervisor runs from) forward to the commit pickUpdate
 * chooses and runs `npm ci` when the lockfile changed; returns the status it also writes for the Console.
 * Refuses a checkout with local changes or one that is not behind origin/main (a development tree).
 */
export async function checkForUpdate(o: { root: string; dataDir: string; exec?: Exec; now?: number; log?: (m: string) => void }): Promise<UpdateStatus> {
  const exec = o.exec ?? realExec;
  const settings = readUpdateSettings(o.dataDir);
  const git = (...args: string[]) => exec('git', args, o.root).then((s) => s.trim());
  const now = o.now ?? Date.now();
  const running = await git('rev-parse', 'HEAD').catch(() => 'unknown');
  const status = (state: UpdateStatus['state'], detail: string, target?: string): UpdateStatus => {
    const s: UpdateStatus = { channel: settings.channel, running: state === 'updated' && target ? target : running, checked_at: new Date(now).toISOString(), state, detail, ...(target ? { target } : {}) };
    writeUpdateStatus(o.dataDir, s);
    return s;
  };
  if (settings.channel === 'off') return status('off', 'automatic updates are off (update.channel in planestro.local.yml)');
  try {
    if (await git('status', '--porcelain', '--untracked-files=no')) return status('refused', 'the planestro checkout has local changes; it is not updated under them');
    await git('fetch', '-q', 'origin', 'main');
    const tip = await git('rev-parse', 'origin/main');
    if (tip === running) return status('current', `on the newest main (${running.slice(0, 7)})`);
    if ((await exec('git', ['merge-base', '--is-ancestor', running, tip], o.root).then(() => true, () => false)) === false) return status('refused', `the checkout (${running.slice(0, 7)}) is not behind origin/main; it looks like a development tree and is left alone`);
    const repo = githubRepoOf(await git('remote', 'get-url', 'origin'));
    if (!repo) return status('error', 'origin is not a GitHub repository');
    const dataSchema = (() => { try { return Number(YAML.parse(readFileSync(join(o.dataDir, 'planestro.yml'), 'utf8'))?.schema_version ?? 0); } catch { return 0; } })();
    const shas = (await git('rev-list', '--first-parent', '--max-count=20', `${running}..${tip}`)).split('\n').filter(Boolean);
    const newer: { sha: string; ci: CiVerdict; schema?: number }[] = [];
    for (const sha of shas) {
      const runs = JSON.parse(await exec('gh', ['api', `repos/${repo}/commits/${sha}/check-runs`, '--jq', '[.check_runs[] | {status, conclusion, completed_at}]'], o.root)) as CheckRun[];
      const schema = schemaVersionIn(await git('show', `${sha}:packages/shared/src/schema.ts`).catch(() => ''));
      newer.push({ sha, ci: ciVerdict(runs), ...(schema !== undefined ? { schema } : {}) });
    }
    const pick = pickUpdate(newer, { minAgeMs: settings.min_age_hours * 3_600_000, now, dataSchema });
    if ('wait' in pick) return status('waiting', pick.wait);
    const lockChanged = !(await exec('git', ['diff', '--quiet', running, pick.sha, '--', 'package-lock.json'], o.root).then(() => true, () => false));
    await git('checkout', '-q', '--detach', pick.sha);
    o.log?.(`updated planestro ${running.slice(0, 7)} → ${pick.sha.slice(0, 7)}${lockChanged ? '; installing dependencies' : ''}`);
    if (lockChanged) await exec('npm', ['ci', '--silent'], o.root);
    return status('updated', `moved ${running.slice(0, 7)} → ${pick.sha.slice(0, 7)} (CI green${settings.min_age_hours ? ` for ${settings.min_age_hours} h` : ''})${lockChanged ? '; dependencies reinstalled' : ''}; restarting between turns`, pick.sha);
  } catch (e) {
    return status('error', (e as Error).message.replace(/\s+/g, ' ').slice(0, 300));
  }
}
