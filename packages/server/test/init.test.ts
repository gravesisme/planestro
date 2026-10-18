import { describe, it, expect } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { initDataDir, layoutRefusal } from '../src/init.ts';
import { git } from './helpers.ts';

function codeRepo(branch = 'trunk'): { root: string; repo: string } {
  const root = mkdtempSync(join(tmpdir(), 'planestro-init-'));
  process.env.PLANESTRO_HOME = join(root, 'home');
  const repo = join(root, 'repo');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', branch);
  writeFileSync(join(repo, 'README.md'), 'hi\n');
  git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', 'init');
  return { root, repo };
}

describe('planestro init on the shortest recipe (going-public O1, O3)', () => {
  it('creates the planning repository a sibling folder lacks and commits the seed into it', () => {
    const { root, repo } = codeRepo();
    const dataDir = join(root, 'planning');
    const lines: string[] = [];
    initDataDir({ dataDir, codeRepo: repo, register: false, log: (m) => lines.push(m) });
    expect(existsSync(join(dataDir, '.git'))).toBe(true);
    expect(git(dataDir, 'log', '--format=%s').trim()).toMatch(/^planestro: init schema \d+$/);
    expect(git(repo, 'status', '--porcelain').trim()).toBe(''); // nothing of it in the code repo
    expect(lines.join('\n')).toMatch(/created a git repository/);
  });

  it('takes the branch checked out, and says so, when the remote names no default; never an assumed name', () => {
    const { root, repo } = codeRepo('trunk');
    const dataDir = join(root, 'planning');
    const lines: string[] = [];
    initDataDir({ dataDir, codeRepo: repo, register: false, log: (m) => lines.push(m) });
    expect(readFileSync(join(dataDir, 'planestro.yml'), 'utf8')).toMatch(/default_branch: trunk/);
    expect(lines.join('\n')).toMatch(/default branch: trunk \(the branch checked out/);
    const detached = codeRepo('dev');
    git(detached.repo, 'checkout', '-q', '--detach');
    expect(() => initDataDir({ dataDir: join(detached.root, 'planning'), codeRepo: detached.repo, register: false })).toThrow(/--default-branch/);
  });

  it('excludes a data dir nested in a linked worktree through git, whose .git is a file', () => {
    const { root, repo } = codeRepo();
    const linked = join(root, 'linked');
    git(repo, 'worktree', 'add', '-q', '-b', 'side', linked);
    const dataDir = join(linked, 'planning');
    initDataDir({ dataDir, codeRepo: linked, defaultBranch: 'trunk', register: false });
    const exclude = git(linked, 'rev-parse', '--git-path', 'info/exclude').trim();
    expect(readFileSync(resolve(linked, exclude), 'utf8')).toContain('planning/');
    expect(git(linked, 'status', '--porcelain').trim()).toBe('');
    expect(existsSync(join(dataDir, '.git'))).toBe(false); // nested: not a repository of its own
  });

  it('commits the seed on an orphan branch checked out as a worktree inside the code repo, and keeps it out of the code repo', () => {
    const { repo } = codeRepo();
    const dataDir = join(repo, 'planning');
    git(repo, 'worktree', 'add', '-q', '--orphan', '-b', 'planning', dataDir);
    initDataDir({ dataDir, codeRepo: repo, register: false });
    expect(git(dataDir, 'log', '--format=%s', 'planning').trim()).toMatch(/^planestro: init schema \d+$/);
    expect(git(repo, 'log', '--format=%s', 'trunk').trim()).toBe('init'); // the code's branch is untouched
    expect(git(repo, 'status', '--porcelain').trim()).toBe('');
  });
});

describe('--layout is withdrawn (#332, D3)', () => {
  it('refuses orphan-branch with the recipe that replaces it, and takes dir as the default it always was', () => {
    expect(layoutRefusal(undefined)).toBeNull();
    expect(layoutRefusal('dir')).toBeNull();
    expect(layoutRefusal('orphan-branch')).toMatch(/withdrawn.*worktree add --orphan -b planning/);
  });
});
