import { afterEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { DataStore } from '../src/store/DataStore.ts';
import { LiveEngine } from '../src/engine/LiveEngine.ts';
import { LiveGitPort } from '../src/engine/live-ports.ts';
import { FakeWorld, DryRunGhPort, DryRunProcPort, DryRunClaudePort } from '../src/engine/dryrun-ports.ts';
import { apiRoutes } from '../src/routes/api.ts';
import { makeFixture, git } from './helpers.ts';

let store: DataStore | undefined;
afterEach(() => { store?.close(); store = undefined; });

/** A real repository: an item's worktree branch changes a source file and adds one, beside a base that moved on. */
async function setup() {
  const { dataDir, codeRepo } = makeFixture();
  const cfg = join(dataDir, 'planestro.yml');
  writeFileSync(cfg, readFileSync(cfg, 'utf8').replace('code_repo:\n', 'code_repo:\n  github: acme/test\n'));
  mkdirSync(join(codeRepo, 'src'));
  writeFileSync(join(codeRepo, 'src/a.ts'), 'export const a = 1;\nexport const keep = true;\n');
  git(codeRepo, 'add', '-A'); git(codeRepo, 'commit', '-q', '-m', 'base');
  git(codeRepo, 'update-ref', 'refs/remotes/origin/trunk', 'trunk');
  const wt = '.claude/worktrees/tp-1-diff', cwd = join(codeRepo, wt), branch = 'tp/1-diff';
  git(codeRepo, 'worktree', 'add', '-q', '-b', branch, cwd, 'trunk');
  writeFileSync(join(cwd, 'src/a.ts'), 'export const a = 2;\nexport const keep = true;\n');
  writeFileSync(join(cwd, 'src/b.ts'), 'export const b = "new";\n');
  git(cwd, 'add', '-A'); git(cwd, 'commit', '-q', '-m', 'change a, add b');
  // Uncommitted work in the worktree is the session's, never the reviewer's: it is not in the diff and is left alone.
  writeFileSync(join(cwd, 'src/a.ts'), 'export const a = 3; // not committed\nexport const keep = true;\n');
  // The base moves on with an unrelated file: a three-dot diff does not show it.
  writeFileSync(join(codeRepo, 'other.ts'), 'x\n');
  git(codeRepo, 'add', '-A'); git(codeRepo, 'commit', '-q', '-m', 'base moves');
  git(codeRepo, 'update-ref', 'refs/remotes/origin/trunk', 'trunk');

  store = await DataStore.open(dataDir);
  const world = new FakeWorld(() => {}, { 'origin/trunk': 'a'.repeat(40) });
  const engine = new LiveEngine(store, { mode: 'dry-run', git: new LiveGitPort(), gh: new DryRunGhPort(world), proc: new DryRunProcPort(world), agents: { claude: new DryRunClaudePort(world) } }, () => {});
  const item = store.createItem({ title: 'Diff me' });
  store.mutateItem(item.id, [{ set: { status: 'IN_PROGRESS', branch, worktree: wt } }], 'engine');
  return { store, engine, world, codeRepo, cwd, branch, id: item.id };
}

const snapshot = (cwd: string) => ({ status: git(cwd, 'status', '--porcelain'), head: git(cwd, 'rev-parse', 'HEAD'), a: readFileSync(join(cwd, 'src/a.ts'), 'utf8') });

describe('a code diff on the item page (#233)', () => {
  it('lists the text files a worktree branch changed and diffs each against the base, read-only', async () => {
    const { engine, store, cwd, id } = await setup();
    const before = snapshot(cwd);
    const files = await engine.reviewImages(id);
    expect(files.map((f) => [f.path, f.change, f.kind])).toEqual([['src/a.ts', 'modified', 'text'], ['src/b.ts', 'added', 'text']]);
    const d = (await engine.reviewDiff(id, 'src/a.ts'))!;
    expect(d).toMatchObject({ path: 'src/a.ts', change: 'modified', binary: false, truncated: false });
    expect(d.patch).toContain('-export const a = 1;');
    expect(d.patch).toContain('+export const a = 2;');
    expect(d.patch).not.toContain('a = 3');                                  // the committed branch, not the dirty tree
    expect((await engine.reviewDiff(id, 'src/b.ts'))!.patch).toContain('+export const b = "new";');
    expect(await engine.reviewDiff(id, 'other.ts')).toBeNull();               // the base's change is not the branch's
    expect(await engine.reviewDiff(id, '../../etc/passwd')).toBeNull();      // only what the branch changed
    expect(snapshot(cwd)).toEqual(before);                                    // never touches the worktree

    const app = apiRoutes(store, engine);
    const r = await app.request(`/items/${id}/diff?path=${encodeURIComponent('src/a.ts')}`);
    expect(r.status).toBe(200);
    expect((await r.json()).patch).toContain('+export const a = 2;');
    expect((await app.request(`/items/${id}/diff?path=README.md`)).status).toBe(404);
    expect(snapshot(cwd)).toEqual(before);
  });

  it('after merge it diffs the merge commit, with the branch and worktree gone', async () => {
    const { engine, store, world, codeRepo, cwd, branch, id } = await setup();
    git(cwd, 'checkout', '-q', '--', 'src/a.ts');
    git(codeRepo, 'merge', '-q', '--no-ff', '-m', 'Merge PR #7', branch);
    const mergeCommit = git(codeRepo, 'rev-parse', 'HEAD').trim();
    git(codeRepo, 'update-ref', 'refs/remotes/origin/trunk', 'trunk');
    git(codeRepo, 'worktree', 'remove', cwd); git(codeRepo, 'branch', '-q', '-D', branch);
    world.prs.set(7, { number: 7, url: 'u', state: 'MERGED', headRefOid: 'h', headRefName: branch, baseRefName: 'trunk', mergeCommit, polls: 9, failOnce: false });
    store.mutateItem(id, [{ set: { status: 'FINISHED', pr: 7 } }], 'engine');
    expect((await engine.reviewImages(id)).map((f) => f.path)).toEqual(['src/a.ts', 'src/b.ts']);
    const d = (await engine.reviewDiff(id, 'src/a.ts'))!;
    expect(d.patch).toContain('-export const a = 1;');
    expect(d.patch).toContain('+export const a = 2;');
    expect(await engine.reviewDiff(id, 'other.ts')).toBeNull();
  });
});
