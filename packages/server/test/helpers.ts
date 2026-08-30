import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { initDataDir } from '../src/init.ts';

/** A throwaway code repo + data dir (its own git repo) for store tests. */
export function makeFixture(opts: { git?: boolean } = {}): { root: string; codeRepo: string; dataDir: string } {
  const root = mkdtempSync(join(tmpdir(), 'planestro-'));
  process.env.PLANESTRO_HOME = join(root, 'home');
  const codeRepo = join(root, 'repo');
  mkdirSync(codeRepo);
  git(codeRepo, 'init', '-q', '-b', 'trunk');
  writeFileSync(join(codeRepo, 'README.md'), 'hi\n');
  git(codeRepo, 'add', '-A'); git(codeRepo, 'commit', '-q', '-m', 'init');
  const dataDir = join(root, 'planning');
  mkdirSync(dataDir);
  if (opts.git !== false) git(dataDir, 'init', '-q', '-b', 'planning');
  initDataDir({ dataDir, codeRepo, name: 'Test Project', prefix: 'TP', defaultBranch: 'trunk', commit: opts.git !== false });
  return { root, codeRepo, dataDir };
}

export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' });
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
