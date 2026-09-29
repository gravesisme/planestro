import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
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
  initDataDir({ dataDir, codeRepo, name: 'Test Project', prefix: 'TP', defaultBranch: 'trunk', categories: ['Game', 'Marketing Site', 'Chores', 'Tools', 'Not Yet Categorized'], commit: opts.git !== false });
  pinTestModels(dataDir, opts.git !== false);
  return { root, codeRepo, dataDir };
}

/**
 * The tests' own model rows, independent of what `init` gives new projects (#49): a planner and an implementer that
 * differ, a fallback between them, the orchestrator on the planner, rotation every 40 wakes. Amended into init's commit.
 */
function pinTestModels(dataDir: string, committed: boolean): void {
  const cfg = join(dataDir, 'planestro.yml');
  const y = readFileSync(cfg, 'utf8')
    .replace(/^models:\n(?:  (?:#.*|- .*)\n)+/m, 'models:\n  - { id: fable-5, label: Fable 5, claude_model: claude-fable-5, fallback: opus-5 }\n  - { id: opus-5, label: Opus 5, claude_model: claude-opus-5 }\n')
    .replace(/^  planner: .*$/m, '  planner: fable-5').replace(/^  implementer: .*$/m, '  implementer: opus-5')
    .replace(/^  model: opus-5-5$/m, '  model: claude-fable-5')
    .replace(/^  # A fresh conversation.*\n  rotate_after_wakes: \d+$/m, '  rotate_after_wakes: 40');
  writeFileSync(cfg, y);
  if (committed) git(dataDir, 'commit', '-q', '-a', '--amend', '--no-edit');
}

export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' });
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
