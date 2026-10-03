import { afterEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { DataStore } from '../src/store/DataStore.ts';
import { LiveEngine } from '../src/engine/LiveEngine.ts';
import { FakeWorld, DryRunGitPort, DryRunGhPort, DryRunProcPort, DryRunClaudePort } from '../src/engine/dryrun-ports.ts';
import { makeFixture } from './helpers.ts';

let store: DataStore | undefined;
afterEach(() => { store?.close(); store = undefined; });
async function setup() {
  const { dataDir, codeRepo } = makeFixture();
  const cfg = join(dataDir, 'planestro.yml');
  writeFileSync(cfg, readFileSync(cfg, 'utf8').replace('code_repo:\n', 'code_repo:\n  github: acme/test\n'));
  store = await DataStore.open(dataDir);
  const world = new FakeWorld(() => {}, { 'origin/trunk': 'a'.repeat(40) });
  const git = new DryRunGitPort(world), gh = new DryRunGhPort(world);
  const engine = new LiveEngine(store, { mode: 'dry-run', git, gh, proc: new DryRunProcPort(world), agents: { claude: new DryRunClaudePort(world) } }, () => {});
  const item = store.createItem({ title: 'Verified Git changes' });
  const branch = 'tp/1-verified', wt = '.claude/worktrees/tp-1-verified', cwd = join(codeRepo, wt), head = world.sha();
  store.mutateItem(item.id, [{ set: { status: 'MERGED', branch, worktree: wt, pr: 401, ci_head_sha: head, ci_result: 'green' } }], 'engine');
  world.worktrees.set(cwd, { path: cwd, head, branch });
  world.localBranches.add(branch); world.remoteBranches.set(branch, head);
  world.prs.set(401, { number: 401, url: 'u', state: 'MERGED', headRefOid: head, headRefName: branch, baseRefName: 'trunk', mergeCommit: world.sha(), polls: 9, failOnce: false });
  return { store, engine, world, git, gh, item, branch, cwd, head };
}

describe('merge and cleanup bind their mutations to verified commits', () => {
  it('refuses a head moved at the final merge call and requires validation again', async () => {
    const c = await setup();
    c.store.mutateItem(c.item.id, [{ set: { status: 'IN_REVIEW' } }], 'engine');
    c.world.prs.get(401)!.state = 'OPEN';
    const merge = c.gh.mergePr.bind(c.gh);
    const newer = c.world.sha();
    c.gh.mergePr = async (repo, n, opts) => {
      expect(opts.headSha).toBe(c.head);
      c.world.remoteBranches.set(c.branch, newer);
      return merge(repo, n, opts);
    };
    await (c.engine as any).merge(c.item.id, 'probe-merge', 'trunk', c.head);
    expect(c.world.prs.get(401)!.state).toBe('OPEN');
    expect(c.world.remoteBranches.get(c.branch)).toBe(newer);
    expect(c.store.requireItem(c.item.id).file.frontmatter).toMatchObject({ status: 'IN_REVIEW', blocked_reason: 'merge_head_moved', ci_result: 'pending' });
  });

  it('keeps the remote branch after merging until the cleanup proof succeeds', async () => {
    const c = await setup();
    c.world.prs.get(401)!.state = 'OPEN';
    expect(await c.gh.mergePr('acme/test', 401, { headSha: c.head })).toBe('merged');
    expect(c.world.remoteBranches.get(c.branch)).toBe(c.head);
    c.world.unreachable.add(c.head);
    await (c.engine as any).cleanup(c.item.id);
    expect(c.world.remoteBranches.get(c.branch)).toBe(c.head);
    expect(c.world.worktrees.has(c.cwd)).toBe(true);
    expect(c.store.requireItem(c.item.id).file.frontmatter.blocked_reason).toBe('cleanup_unverifiable');
  });

  for (const change of ['remote advances', 'remote is recreated', 'local advances', 'local is recreated']) {
    it(`keeps unverified work when ${change} after the proof`, async () => {
      const c = await setup();
      const newer = c.world.sha(); c.world.unreachable.add(newer);
      if (change === 'remote is recreated') c.world.remoteBranches.delete(c.branch);
      if (change === 'local is recreated') c.world.localBranches.delete(c.branch);
      const remove = c.git.worktreeRemove.bind(c.git);
      c.git.worktreeRemove = async (repo, path, force) => {
        await remove(repo, path, force);
        if (change.startsWith('remote')) c.world.remoteBranches.set(c.branch, newer);
        else { c.world.localBranches.add(c.branch); c.world.localTips.set(c.branch, newer); }
      };
      await (c.engine as any).cleanup(c.item.id);
      expect(c.store.requireItem(c.item.id).file.frontmatter).toMatchObject({ status: 'MERGED', blocked: true, blocked_reason: 'cleanup_unverifiable' });
      if (change.startsWith('remote')) expect(c.world.remoteBranches.get(c.branch)).toBe(newer);
      else { expect(c.world.localBranches.has(c.branch)).toBe(true); expect(c.world.localTips.get(c.branch)).toBe(newer); }
    });
  }

  it('fails closed when worktree inventory cannot be read', async () => {
    const c = await setup();
    c.git.worktreeList = async () => { throw new Error('inventory unavailable'); };
    await (c.engine as any).cleanup(c.item.id);
    expect(c.world.worktrees.has(c.cwd)).toBe(true);
    expect(c.world.remoteBranches.get(c.branch)).toBe(c.head);
    expect(c.store.requireItem(c.item.id).file.frontmatter.blocked_reason).toBe('cleanup_unverifiable');
  });

  it('finishes normally when the verified tips remain unchanged', async () => {
    const c = await setup();
    await (c.engine as any).cleanup(c.item.id);
    expect(c.store.requireItem(c.item.id).file.frontmatter.status).toBe('FINISHED');
    expect(c.world.worktrees.has(c.cwd)).toBe(false);
    expect(c.world.localBranches.has(c.branch)).toBe(false);
    expect(c.world.remoteBranches.has(c.branch)).toBe(false);
  });
});
