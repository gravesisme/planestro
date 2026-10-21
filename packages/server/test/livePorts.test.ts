import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LiveGitPort, refLocked, retrying, TRANSIENT, ciFromRuns } from '../src/engine/live-ports.ts';
import { git, sleep } from './helpers.ts';

describe('transient git and gh failures (p30, p34)', () => {
  it('knows a retryable message from a real failure', () => {
    for (const m of [
      "git fetch --prune origin failed in /r: error: cannot lock ref 'refs/remotes/origin/feature/x': is at 5850b31 but expected d81cc47",
      'gh pr view 306 failed: Get "https://api.github.com/graphql": net/http: TLS handshake timeout',
      'gh pr view 306 failed: dial tcp 140.82.112.6:443: i/o timeout',
      'git push failed: fatal: unable to access \'https://github.com/a/b/\': Could not resolve host: github.com',
      'gh run list failed: HTTP 502: Bad Gateway',
    ]) expect(TRANSIENT.test(m), m).toBe(true);
    for (const m of [
      'git rebase failed: CONFLICT (content): Merge conflict in a.ts',
      'git push failed: ! [rejected] x -> x (stale info)',
      'gh pr view 9 failed: GraphQL: Could not resolve to a PullRequest with the number of 9.',
    ]) expect(TRANSIENT.test(m), m).toBe(false);
  });

  it('retries a transient failure after each delay, and gives up after the last', async () => {
    const waits: number[] = [];
    let calls = 0;
    const flaky = async () => { calls += 1; if (calls < 3) throw new Error('gh pr view failed: i/o timeout'); return 'ok'; };
    expect(await retrying(flaky, [5, 15, 40], async (ms) => { waits.push(ms); })).toBe('ok');
    expect(waits).toEqual([5, 15]);
    calls = -10;
    await expect(retrying(flaky, [1, 1], async () => {})).rejects.toThrow('i/o timeout');
  });

  it('never retries a real failure', async () => {
    let calls = 0;
    await expect(retrying(async () => { calls += 1; throw new Error('CONFLICT (content)'); }, [1, 1, 1], async () => {})).rejects.toThrow('CONFLICT');
    expect(calls).toBe(1);
  });

  it('runs ref-updating operations one at a time, and a failure does not jam the queue', async () => {
    let inside = 0, most = 0;
    const op = (fail = false) => refLocked(async () => { inside += 1; most = Math.max(most, inside); await sleep(15); inside -= 1; if (fail) throw new Error('boom'); return 'done'; });
    const results = await Promise.allSettled([op(), op(true), op(), op()]);
    expect(most).toBe(1);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected', 'fulfilled', 'fulfilled']);
  });

  it('a fetch in the main checkout and pushes from its worktrees, all at once, all succeed', async () => {
    const root = mkdtempSync(join(tmpdir(), 'planestro-race-'));
    const origin = join(root, 'origin.git'), repo = join(root, 'repo');
    git(root, 'init', '-q', '--bare', '-b', 'trunk', origin);
    git(root, 'clone', '-q', origin, repo);
    writeFileSync(join(repo, 'a.txt'), 'a\n'); git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', 'init'); git(repo, 'push', '-q', 'origin', 'HEAD:trunk');
    const port = new LiveGitPort();
    const trees = [1, 2, 3].map((n) => join(root, `wt-${n}`));
    for (const [n, wt] of trees.entries()) await port.worktreeAdd(repo, wt, `b${n}`, 'origin/trunk');
    for (let round = 0; round < 5; round++) {
      for (const [n, wt] of trees.entries()) { writeFileSync(join(wt, `f${n}.txt`), `${round}\n`); git(wt, 'add', '-A'); git(wt, 'commit', '-q', '-m', `r${round}`); }
      await Promise.all([port.fetch(repo), ...trees.map((wt, n) => port.pushSetUpstream(wt, `b${n}`)), port.fetch(repo)]);
    }
    const heads = await port.remoteHeads(repo);
    for (const [n, wt] of trees.entries()) expect(heads.get(`b${n}`)).toBe(await port.revParse(wt, 'HEAD'));
  }, 30_000);
});

describe('a head\'s CI verdict from its runs (HH-174, HH-180)', () => {
  const run = (id: number, conclusion: string | null, status = 'completed') => ({ databaseId: id, status, conclusion, headSha: 'abc', url: `u/${id}`, createdAt: 't' });
  it('a run whose jobs were all skipped is never red, and a real run for the same head wins over it', () => {
    expect(ciFromRuns([run(2, 'skipped')], 'abc').state).toBe('skipped');
    expect(ciFromRuns([run(3, 'skipped'), run(2, null, 'in_progress')], 'abc')).toMatchObject({ state: 'pending', runId: 2 });
    expect(ciFromRuns([run(3, 'skipped'), run(2, 'success')], 'abc')).toMatchObject({ state: 'success', runId: 2 });
    expect(ciFromRuns([run(3, 'failure'), run(2, 'skipped')], 'abc').state).toBe('failure');
    expect(ciFromRuns([], 'abc').state).toBe('none');
  });
});

describe('the lines a worktree adds that hold a marker (#240)', () => {
  it('reads commits, uncommitted and untracked files against the merge base, never what the base already had', async () => {
    const root = mkdtempSync(join(tmpdir(), 'planestro-markers-'));
    const origin = join(root, 'origin.git'), repo = join(root, 'repo');
    git(root, 'init', '-q', '--bare', '-b', 'trunk', origin);
    git(root, 'clone', '-q', origin, repo);
    writeFileSync(join(repo, 'old.ts'), '// planestro:debug-begin left on the base long ago\nconst a = 1;\n');
    writeFileSync(join(repo, 'a.ts'), 'one\ntwo\nthree\n');
    git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', 'init'); git(repo, 'push', '-q', 'origin', 'HEAD:trunk');
    const port = new LiveGitPort();
    const wt = join(root, 'wt');
    await port.worktreeAdd(repo, wt, 'fix', 'origin/trunk');
    writeFileSync(join(wt, 'a.ts'), 'one\n# planestro:debug-begin\nprint(x)\n# planestro:debug-end\ntwo\nthree\n');
    git(wt, 'add', '-A'); git(wt, 'commit', '-q', '-m', 'instrument');
    writeFileSync(join(wt, 'old.ts'), '// planestro:debug-begin left on the base long ago\nconst a = 2;\n');   // a change beside an old marker
    writeFileSync(join(wt, 'b.sql'), 'select 1;\n-- planestro:debug-end\n');                                   // untracked
    const hits = await port.addedLinesWith(wt, 'origin/trunk', 'planestro:debug-');
    expect(hits.map((h) => `${h.path}:${h.line}`).sort()).toEqual(['a.ts:2', 'a.ts:4', 'b.sql:2']);
    expect(hits.find((h) => h.path === 'b.sql')!.text).toBe('-- planestro:debug-end');
    expect(git(wt, 'status', '--porcelain')).toContain('?? b.sql');   // the real index is untouched
    writeFileSync(join(wt, 'a.ts'), 'one\ntwo\nthree\n'); writeFileSync(join(wt, 'b.sql'), 'select 1;\n');
    expect(await port.addedLinesWith(wt, 'origin/trunk', 'planestro:debug-')).toEqual([]);
  });
});

describe('a rebase left stopped for a session, and continued by planestro (HH-532)', () => {
  it('stops at the conflict, refuses markers and edits to other files, then continues to a rebase that contains the base', async () => {
    const root = mkdtempSync(join(tmpdir(), 'planestro-held-rebase-'));
    const origin = join(root, 'origin.git'), repo = join(root, 'repo');
    git(root, 'init', '-q', '--bare', '-b', 'trunk', origin);
    git(root, 'clone', '-q', origin, repo);
    writeFileSync(join(repo, 'a.ts'), 'one\n'); writeFileSync(join(repo, 'c.ts'), 'c\n');
    git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', 'init'); git(repo, 'push', '-q', 'origin', 'HEAD:trunk');
    const port = new LiveGitPort();
    const wt = join(root, 'wt');
    await port.worktreeAdd(repo, wt, 'fix', 'origin/trunk');
    writeFileSync(join(wt, 'a.ts'), 'branch\n'); writeFileSync(join(wt, 'b.ts'), 'b\n');
    git(wt, 'add', '-A'); git(wt, 'commit', '-q', '-m', 'branch change');
    const before = git(wt, 'rev-parse', 'HEAD').trim();
    writeFileSync(join(repo, 'a.ts'), 'base\n'); git(repo, 'commit', '-q', '-am', 'base change'); git(repo, 'push', '-q', 'origin', 'HEAD:trunk');
    await port.fetch(repo);
    const r = await port.rebase(wt, 'origin/trunk', [], { stop: true });
    expect(r).toMatchObject({ ok: false, stopped: true, conflicts: ['a.ts'] });
    expect(r.stepFiles!.sort()).toEqual(['a.ts', 'b.ts']);
    expect(await port.inProgressOp(wt)).toBe('rebase');
    const step = { conflicts: r.conflicts, files: r.stepFiles!, head: r.head };
    expect((await port.continueRebase(wt, [], step)).state).toBe('markers');
    writeFileSync(join(wt, 'a.ts'), 'base\nbranch\n'); writeFileSync(join(wt, 'c.ts'), 'changed on the way\n');
    expect(await port.continueRebase(wt, [], step)).toMatchObject({ state: 'outside', files: ['c.ts'] });
    writeFileSync(join(wt, 'c.ts'), 'c\n');
    const done = await port.continueRebase(wt, [], step);
    expect(done.state).toBe('done');
    expect(await port.inProgressOp(wt)).toBeNull();
    expect(done.head).not.toBe(before);
    expect(await port.isAncestor(wt, 'origin/trunk', 'HEAD')).toBe(true);
    expect(git(wt, 'show', 'HEAD:a.ts')).toBe('base\nbranch\n');
    expect(git(wt, 'status', '--porcelain')).toBe('');
  });

  it('continues a step whose commit deletes files: a path gone from the index and the tree is not staged by name (#477)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'planestro-held-rebase-rm-'));
    const origin = join(root, 'origin.git'), repo = join(root, 'repo');
    git(root, 'init', '-q', '--bare', '-b', 'trunk', origin);
    git(root, 'clone', '-q', origin, repo);
    writeFileSync(join(repo, 'a.ts'), 'one\n'); writeFileSync(join(repo, 'gone.jpg'), 'img\n');
    git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', 'init'); git(repo, 'push', '-q', 'origin', 'HEAD:trunk');
    const port = new LiveGitPort();
    const wt = join(root, 'wt');
    await port.worktreeAdd(repo, wt, 'fix', 'origin/trunk');
    writeFileSync(join(wt, 'a.ts'), 'branch\n'); git(wt, 'rm', '-q', 'gone.jpg');
    git(wt, 'add', '-A'); git(wt, 'commit', '-q', '-m', 'branch change and removal');
    writeFileSync(join(repo, 'a.ts'), 'base\n'); git(repo, 'commit', '-q', '-am', 'base change'); git(repo, 'push', '-q', 'origin', 'HEAD:trunk');
    await port.fetch(repo);
    const r = await port.rebase(wt, 'origin/trunk', [], { stop: true });
    expect(r).toMatchObject({ ok: false, stopped: true, conflicts: ['a.ts'] });
    expect(r.stepFiles!.sort()).toEqual(['a.ts', 'gone.jpg']);
    writeFileSync(join(wt, 'a.ts'), 'base\nbranch\n');
    const done = await port.continueRebase(wt, [], { conflicts: r.conflicts, files: r.stepFiles!, head: r.head });
    expect(done.state).toBe('done');
    expect(await port.isAncestor(wt, 'origin/trunk', 'HEAD')).toBe(true);
    expect(git(wt, 'ls-files')).not.toContain('gone.jpg');
    expect(git(wt, 'show', 'HEAD:a.ts')).toBe('base\nbranch\n');
    expect(git(wt, 'status', '--porcelain')).toBe('');
  });
});
