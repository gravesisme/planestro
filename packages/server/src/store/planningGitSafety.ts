import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWrite } from './atomicWrite.ts';

const PRIVATE_PATHS = ['planestro.local.yml', '.planestro', 'logs'];
const isPrivate = (path: string) => PRIVATE_PATHS.some((p) => path === p || path.startsWith(p + '/'));

/** Enumerate checkpoint paths: Git treats some excluded ignored directories as explicit add errors. */
export function safePlanningPaths(dir: string, paths?: string[]): string[] {
  if (paths?.length) {
    if (paths.some(isPrivate)) throw refusal();
    return paths;
  }
  const out = execFileSync('git', ['-C', dir, 'ls-files', '--cached', '--others', '--exclude-standard', '-z'], { encoding: 'utf8' });
  const staged = execFileSync('git', ['-C', dir, 'diff', '--cached', '--name-only', '-z'], { encoding: 'utf8' });
  return [...new Set((out + staged).split('\0').filter((p) => p && !isPrivate(p)))];
}
// An already-staged deletion is absent from both the index and disk: adding it again fails.
export function planningStagePaths(dir: string, paths: string[]): string[] {
  const removed = new Set(git(dir, ['diff', '--cached', '--diff-filter=D', '--name-only', '-z']).split('\0'));
  return paths.filter((p) => !removed.has(p) || existsSync(join(dir, p))).map((p) => `:(top,literal)${p}`);
}

const git = (dir: string, args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const refusal = () => new Error('machine-local settings or runtime files are tracked in the planning repository; automatic commits/pushes are refused. Stop Planestro, back up planestro.local.yml, remove private files from Git tracking, and review unpublished history before restarting. No files or history were removed.');

/** Preserve custom rules, but put private exclusions last so earlier negations cannot expose them. */
export function ensurePlanningIgnores(dir: string): boolean {
  const path = join(dir, '.gitignore');
  const before = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const required = '/.planestro/\n/planestro.local.yml\n/logs/\n.DS_Store\n';
  if (before.endsWith(required)) return false;
  atomicWrite(path, before + (before && !before.endsWith('\n') ? '\n' : '') + required);
  return true;
}

/** Check both index and HEAD: a staged deletion is not permission to publish older secrets. */
export function assertSafePlanningGit(dir: string): void {
  if (!existsSync(join(dir, '.git'))) return;
  let tracked: string;
  try {
    // One Git read covers the index plus paths removed since HEAD. This runs on
    // every semantic commit, so avoid separate HEAD/index/tree subprocesses.
    tracked = git(dir, ['ls-files', '--cached', '--with-tree=HEAD', '--', ...PRIVATE_PATHS]);
  } catch (e) {
    let unborn = false;
    try { git(dir, ['rev-parse', '--verify', '--quiet', 'HEAD']); }
    catch (headError) { unborn = (headError as { status?: number }).status === 1; }
    if (!unborn) throw e;
    tracked = git(dir, ['ls-files', '--cached', '--', ...PRIVATE_PATHS]);
  }
  if (tracked) throw refusal();
}

/** Even a file removed from the tip must not be published in an earlier outgoing commit. */
export function assertSafePlanningPush(dir: string): void {
  assertSafePlanningGit(dir);
  if (git(dir, ['log', '--full-history', '--format=', '--name-only', '@{u}..HEAD', '--', ...PRIVATE_PATHS])) throw refusal();
}
