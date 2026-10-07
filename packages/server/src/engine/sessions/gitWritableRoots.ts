import { execFileSync } from 'node:child_process';
import { mkdirSync, realpathSync } from 'node:fs';
import { join, relative, isAbsolute } from 'node:path';

/**
 * What a commit writes outside a linked worktree, as sandbox roots (HH-273, HH-281, HH-286): its own git dir
 * (index, HEAD, rebase state) and, in the shared one, objects/, refs/heads/ and logs/refs/heads/. Never the
 * shared dir itself: config and hooks/ stay read-only to the worker. Without them every commit failed on
 * index.lock ("Operation not permitted"); the spike missed it because it ran under the temp dir, which the
 * sandbox always lets a turn write. A worktree that holds its own .git needs nothing. packed-refs stays out:
 * git only warns when it cannot tidy it.
 */
export function gitWritableRoots(cwd: string): string[] {
  let gitDir: string, common: string;
  try { [gitDir, common] = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().split('\n'); }
  catch { return []; }
  const here = (() => { try { return realpathSync(cwd); } catch { return cwd; } })();
  const inside = (p: string) => { const r = relative(here, p); return !r.startsWith('..') && !isAbsolute(r); };
  if (!gitDir || !common || inside(gitDir)) return [];
  const shared = ['objects', 'refs/heads', 'logs/refs/heads'].map((d) => join(common, d));
  for (const d of shared) { try { mkdirSync(d, { recursive: true }); } catch { /* git makes it on first use; the root is then simply missing */ } }
  return [gitDir, ...shared];
}

