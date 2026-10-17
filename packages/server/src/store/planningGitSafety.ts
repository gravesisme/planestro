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
  let before = existsSync(path) ? readFileSync(path, 'utf8') : '';
  if (before.endsWith(REQUIRED_IGNORES)) return false;
  // The block as an older planestro wrote it is replaced, not repeated.
  for (const old of OLD_IGNORES) if (before.endsWith(old)) { before = before.slice(0, -old.length); break; }
  atomicWrite(path, before + (before && !before.endsWith('\n') ? '\n' : '') + REQUIRED_IGNORES);
  return true;
}
const REQUIRED_IGNORES = '/.planestro/\n/planestro.local.yml\n/logs/\n/journal/\n.DS_Store\n';
const OLD_IGNORES = ['/.planestro/\n/planestro.local.yml\n/logs/\n.DS_Store\n'];

/**
 * The journal is machine-local and appended to all day: tracked, every hourly checkpoint committed the month's file
 * again, and one planning repository passed 3 GiB. It is ignored and taken out of the index (never deleted; history is
 * left as it is), in one commit of its own. With anything else already staged it waits for the next start rather
 * than commit that too. Returns whether it committed.
 */
export function untrackJournal(dir: string, toolVersion: string, log?: (level: 'info' | 'warn', msg: string) => void): boolean {
  if (!existsSync(join(dir, '.git'))) return false;
  const ignoresChanged = ensurePlanningIgnores(dir);
  const tracked = git(dir, ['ls-files', '--cached', '--', 'journal']);
  if (!tracked && !ignoresChanged) return false;
  const staged = git(dir, ['diff', '--cached', '--name-only']).split('\n').filter((p) => p && p !== '.gitignore' && !p.startsWith('journal/'));
  if (staged.length) { log?.('warn', `journal: left tracked for now (${staged.length} other change(s) already staged)`); return false; }
  if (tracked) git(dir, ['rm', '-r', '-q', '--cached', '--', 'journal']);
  git(dir, ['add', '--', '.gitignore']);
  if (!git(dir, ['diff', '--cached', '--name-only'])) return false;
  git(dir, ['commit', '-q', '-m', tracked ? 'planestro: stop tracking journal' : 'planestro: ignore journal', '-m', 'The journal stays on disk; it is machine-local and no longer versioned.', '-m', `Planestro-Version: ${toolVersion}`]);
  log?.('info', tracked ? 'git: stopped tracking journal/ (the files stay on disk)' : 'git: journal/ ignored');
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
