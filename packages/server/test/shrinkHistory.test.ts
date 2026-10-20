import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyShrink, gcShrunk, inspectShrink } from '../src/shrinkHistory.ts';
import { git as gitRaw } from './helpers.ts';

const git = (cwd: string, ...args: string[]) => gitRaw(cwd, ...args).trim();

/** A code repo whose planning branch is an orphan worktree beside it (HH's layout), pushed to a bare remote, that tracked its journal. */
function planningRepo(o: { untracked?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'planestro-shrink-'));
  const remote = join(root, 'remote.git'); git(root, 'init', '-q', '--bare', remote);
  const code = join(root, 'code'); mkdirSync(code);
  git(code, 'init', '-q', '-b', 'main'); writeFileSync(join(code, 'app.js'), 'x\n'); git(code, 'add', '-A'); git(code, 'commit', '-q', '-m', 'code');
  git(code, 'remote', 'add', 'origin', remote); git(code, 'push', '-q', 'origin', 'main');
  const dir = join(root, 'planning');
  git(code, 'worktree', 'add', '-q', '--orphan', '-b', 'planning', dir);
  mkdirSync(join(dir, 'items')); mkdirSync(join(dir, 'journal'));
  writeFileSync(join(dir, 'items', 'MP-1.md'), 'one\n'); writeFileSync(join(dir, 'journal', '2026-10.ndjson'), '{"a":1}\n');
  git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'init');
  for (let i = 0; i < 4; i++) { appendFileSync(join(dir, 'journal', '2026-10.ndjson'), `{"tick":${i}}\n`.repeat(200)); git(dir, 'commit', '-qam', `planestro: checkpoint ${i}`); }
  writeFileSync(join(dir, 'items', 'MP-1.md'), 'one, edited\n'); appendFileSync(join(dir, 'journal', '2026-10.ndjson'), '{"b":2}\n'); git(dir, 'commit', '-qam', 'MP-1: edit');
  if (o.untracked !== false) {
    git(dir, 'rm', '-r', '-q', '--cached', 'journal'); writeFileSync(join(dir, '.gitignore'), '.planestro/\njournal/\n'); git(dir, 'add', '.gitignore');
    git(dir, 'commit', '-q', '-m', 'planestro: stop tracking journal');
  }
  git(dir, 'push', '-q', '-u', 'origin', 'planning');
  return { root, remote, code, dir };
}

describe('shrink-history (#409)', () => {
  it('dry run: counts what the branch carries and changes nothing', () => {
    const { dir } = planningRepo();
    const tip = git(dir, 'rev-parse', 'planning');
    const r = inspectShrink(dir, { tool: 'filter-branch' });
    expect(r.refusals).toEqual([]);
    expect(r.branch).toBe('planning');
    expect(r.shared).toBe(true);
    expect(r.journalCommits).toBe(7); // init, four checkpoints, MP-1: edit, and the commit that stopped tracking it
    expect(r.journalBytes).toBeGreaterThan(1000);
    expect(r.upstream?.sha).toBe(tip);
    expect(git(dir, 'rev-parse', 'planning')).toBe(tip);
  }, 60_000);

  it('refuses a tracked journal, a dirty tree, a live server and a remote that is ahead', () => {
    const tracked = planningRepo({ untracked: false });
    expect(inspectShrink(tracked.dir).refusals.join('\n')).toMatch(/journal\/ is still tracked/);

    const { dir, root, remote } = planningRepo();
    writeFileSync(join(dir, 'items', 'MP-2.md'), 'new\n');
    expect(inspectShrink(dir).refusals.join('\n')).toMatch(/working tree has changes/);
    execSync(`rm ${join(dir, 'items', 'MP-2.md')}`);

    mkdirSync(join(dir, '.planestro'), { recursive: true });
    writeFileSync(join(dir, '.planestro', 'lock'), JSON.stringify({ pid: process.ppid }));
    expect(inspectShrink(dir).refusals.join('\n')).toMatch(/planestro server \(pid \d+\) holds/);
    expect(() => applyShrink(dir, { tool: 'filter-branch' })).toThrow(/refused/);
    execSync(`rm ${join(dir, '.planestro', 'lock')}`);

    const other = join(root, 'other'); git(root, 'clone', '-q', '-b', 'planning', remote, other);
    writeFileSync(join(other, 'items', 'MP-3.md'), 'elsewhere\n'); git(other, 'add', '-A'); git(other, 'commit', '-q', '-m', 'MP-3'); git(other, 'push', '-q');
    expect(inspectShrink(dir, { fetch: true }).refusals.join('\n')).toMatch(/has commits planning lacks/);
  }, 60_000);

  it('--apply bundles the branch, rewrites only it, keeps the tree and the journal on disk, and never pushes; --gc after the push', () => {
    const { dir, code, remote } = planningRepo();
    const mainBefore = git(code, 'rev-parse', 'main');
    const remoteBefore = git(remote, 'rev-parse', 'planning');
    const tree = git(dir, 'rev-parse', 'HEAD^{tree}');
    const journal = readFileSync(join(dir, 'journal', '2026-10.ndjson'), 'utf8');

    const home = mkdtempSync(join(tmpdir(), 'planestro-home-'));
    const prevHome = process.env.PLANESTRO_HOME;
    process.env.PLANESTRO_HOME = home;
    let res: ReturnType<typeof applyShrink>;
    try { res = applyShrink(dir, { tool: 'filter-branch', now: () => new Date('2026-10-20T12:00:00Z') }); }
    finally { if (prevHome === undefined) delete process.env.PLANESTRO_HOME; else process.env.PLANESTRO_HOME = prevHome; }
    expect(existsSync(res.bundle)).toBe(true);
    expect(res.bundle.startsWith(join(home, 'backups') + '/')).toBe(true); // never in the code repository's working tree
    expect(git(code, 'status', '--porcelain')).toBe('');
    expect(git(dir, 'bundle', 'list-heads', res.bundle)).toContain(res.before.tip);
    expect(git(dir, 'rev-list', '--count', 'planning', '--', 'journal')).toBe('0');
    expect(res.after.commits).toBe(3); // init, MP-1: edit, stop tracking: the four checkpoint-only commits are gone
    expect(git(dir, 'rev-parse', 'HEAD^{tree}')).toBe(tree);
    expect(readFileSync(join(dir, 'journal', '2026-10.ndjson'), 'utf8')).toBe(journal);
    expect(git(code, 'rev-parse', 'main')).toBe(mainBefore);
    expect(git(remote, 'rev-parse', 'planning')).toBe(remoteBefore);
    expect(res.push).toContain(`--force-with-lease=planning:${remoteBefore}`);
    expect(existsSync(join(dir, '.planestro', 'lock'))).toBe(false);

    expect(() => gcShrunk(dir)).toThrow(/push the rewritten branch first/);
    execSync(res.push!, { stdio: 'ignore' });
    expect(git(remote, 'rev-parse', 'planning')).toBe(res.after.tip);
    const g = gcShrunk(dir);
    expect(g.after).toBeLessThanOrEqual(g.before);
    expect(g.otherHolders).toEqual([]);
    expect(inspectShrink(dir).journalCommits).toBe(0);
  }, 60_000);

  // CI has no git filter-repo; run where it is installed (brew install git-filter-repo).
  const hasFilterRepo = (() => { try { execSync('git filter-repo --version', { stdio: 'ignore' }); return true; } catch { return false; } })();
  it.skipIf(!hasFilterRepo)('with git filter-repo: rewrites only the branch, keeps the remote and the journal on disk', () => {
    const { dir, code, remote } = planningRepo();
    const mainBefore = git(code, 'rev-parse', 'main');
    const remoteBefore = git(remote, 'rev-parse', 'planning');
    const tree = git(dir, 'rev-parse', 'HEAD^{tree}');
    const journal = readFileSync(join(dir, 'journal', '2026-10.ndjson'), 'utf8');
    const res = applyShrink(dir, { tool: 'filter-repo', backupDir: mkdtempSync(join(tmpdir(), 'planestro-bundle-')) });
    expect(res.after.commits).toBe(3);
    expect(git(dir, 'rev-list', '--count', 'planning', '--', 'journal')).toBe('0');
    expect(git(dir, 'rev-parse', 'HEAD^{tree}')).toBe(tree);
    expect(readFileSync(join(dir, 'journal', '2026-10.ndjson'), 'utf8')).toBe(journal);
    expect(git(code, 'rev-parse', 'main')).toBe(mainBefore);
    expect(git(code, 'remote')).toBe('origin'); // filter-repo drops origin only on a fresh clone; --refs keeps it
    expect(git(remote, 'rev-parse', 'planning')).toBe(remoteBefore);
    execSync(res.push!, { stdio: 'ignore' });
    expect(gcShrunk(dir).otherHolders).toEqual([]);
    expect(inspectShrink(dir).journalCommits).toBe(0);
  }, 60_000);

  it('a standalone planning repository with no remote: rewrites, and --gc follows at once', () => {
    const root = mkdtempSync(join(tmpdir(), 'planestro-shrink-solo-'));
    git(root, 'init', '-q', '-b', 'main');
    mkdirSync(join(root, 'journal')); writeFileSync(join(root, 'journal', 'j.ndjson'), 'x\n'.repeat(500)); writeFileSync(join(root, 'planestro.yml'), 'a: 1\n');
    git(root, 'add', '-A'); git(root, 'commit', '-q', '-m', 'init');
    git(root, 'rm', '-r', '-q', '--cached', 'journal'); writeFileSync(join(root, '.gitignore'), 'journal/\n'); git(root, 'add', '.gitignore'); git(root, 'commit', '-q', '-m', 'stop tracking');
    const r = inspectShrink(root, { tool: 'filter-branch' });
    expect(r.shared).toBe(false);
    expect(r.upstream).toBeUndefined();
    const res = applyShrink(root, { tool: 'filter-branch', backupDir: join(mkdtempSync(join(tmpdir(), 'planestro-bundle-')), 'not', 'yet') });
    expect(existsSync(res.bundle)).toBe(true); // the backup dir is created
    expect(res.push).toBeUndefined();
    expect(res.next[0]).toMatch(/--gc/);
    expect(gcShrunk(root).after).toBeGreaterThan(0);
  }, 60_000);
});
