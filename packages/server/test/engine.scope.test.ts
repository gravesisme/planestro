import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DataStore } from '../src/store/DataStore.ts';
import { LiveEngine } from '../src/engine/LiveEngine.ts';
import { FakeWorld, DryRunGitPort, DryRunGhPort, DryRunProcPort, DryRunClaudePort } from '../src/engine/dryrun-ports.ts';
import type { Ports } from '../src/engine/ports.ts';
import { getSection } from '@planestro/shared';
import { makeFixture } from './helpers.ts';

/**
 * What the reviewer approved is what merges (#74, HH-214): a CI-fix turn after the designer approved HH-214's art
 * committed five .import files for other items. The approved head's paths are recorded when the hold is released;
 * a later head touching others is held for the orchestrator, and releasing that hold approves them.
 */
let store: DataStore | undefined; let engine: LiveEngine | undefined;
afterEach(async () => { await engine?.stop(); store?.close(); store = undefined; engine = undefined; });

describe('approved scope (#74)', () => {
  it('a commit after approval that touches new paths is held before merge; accepting it lets it merge', async () => {
    const { dataDir, codeRepo } = makeFixture();
    mkdirSync(join(codeRepo, '.git', 'info'), { recursive: true });
    const cfg = join(dataDir, 'planestro.yml');
    writeFileSync(cfg, readFileSync(cfg, 'utf8').replace(/^code_repo:\n/m, 'code_repo:\n  github: acme/repo\n'));
    store = await DataStore.open(dataDir, { emit: () => {} });
    const world = new FakeWorld(() => {}, { 'origin/trunk': 'f'.repeat(40) });
    const git = new DryRunGitPort(world);
    const files: Record<string, string[]> = {};
    git.changedFiles = async (_cwd: string, _base: string, head: string) => (files[head] ?? []).map((path) => ({ path, change: 'added' as const, bytes: 1 }));
    const ports: Ports = { mode: 'dry-run', git, gh: new DryRunGhPort(world), proc: new DryRunProcPort(world), agents: { claude: new DryRunClaudePort(world) } };
    engine = new LiveEngine(store, ports, () => {}, { sleep: async () => {}, tickMs: 50 });
    const e = engine as any;
    // This test drives merge directly; releasing a hold must not start a competing tick.
    e.tick = async () => {};
    const it = store.createItem({ title: 'Siren art', description: 'x' });
    const rel = '.claude/worktrees/siren'; const branch = 'tp/siren'; const cwd = e.absWorktree(rel);
    const s1 = world.sha(); files[s1] = ['assets/siren.png'];
    world.worktrees.set(cwd, { path: cwd, head: s1, branch }); world.remoteBranches.set(branch, s1);
    world.prs.set(300, { number: 300, url: 'u', state: 'OPEN', headRefOid: s1, headRefName: branch, baseRefName: 'trunk', polls: 0, failOnce: false });
    store.mutateItem(it.id, [{ set: { status: 'IN_REVIEW', worktree: rel, branch, pr: 300, ci_result: 'green', ci_head_sha: s1, review_hold: true, awaiting: 'review' } }], 'engine');
    await engine.releaseHold(it.id);
    expect((store.requireItem(it.id).file.frontmatter.op_data as any).approved_scope).toEqual({ sha: s1, paths: ['assets/siren.png'] });
    // a CI-fix turn commits other items' import files
    const s2 = world.sha(); files[s2] = ['assets/siren.png', 'assets/hound.png.import', 'assets/crawler.png.import'];
    world.remoteBranches.set(branch, s2); world.worktrees.get(cwd)!.head = s2;
    store.mutateItem(it.id, [{ set: { ci_head_sha: s2 } }], 'engine');
    await e.merge(it.id, store.journal.begin('merge', it.id), 'trunk', s2);
    let fm = store.requireItem(it.id).file.frontmatter;
    expect(world.prs.get(300)!.state).toBe('OPEN');
    expect(fm.skip_merge).toBe(true);
    expect(fm.hold_reason).toBe('commits after your approval touched 2 paths the approved change did not: assets/crawler.png.import, assets/hound.png.import');
    expect(store.journal.read({ item: it.id, type: 'orchestrator.wake' }).some((w) => w.data?.event === 'scope_changed')).toBe(true);
    // the orchestrator accepts them (unskip_merge → acceptScope): the same paths are not held again
    expect(await e.acceptScope(it.id)).toBe(`its approved change is now 3 paths at ${s2.slice(0, 7)}`);
    store.mutateItem(it.id, [{ unset: ['skip_merge'] }], 'orchestrator');
    await e.merge(it.id, store.journal.begin('merge', it.id), 'trunk', s2);
    expect(world.prs.get(300)!.state).toBe('MERGED');
    fm = store.requireItem(it.id).file.frontmatter;
    expect(getSection(store.requireItem(it.id).file, 'Activity')).toContain('held out of the merge queue: commits after your approval touched 2 paths');
  });
});

describe('the orchestrator releases a scope hold (#209)', () => {
  it('unskip_merge records the new approved set before the hold comes off, so a merge mid-call is not held again', async () => {
    const { dataDir, codeRepo } = makeFixture();
    mkdirSync(join(codeRepo, '.git', 'info'), { recursive: true });
    const cfg = join(dataDir, 'planestro.yml');
    writeFileSync(cfg, readFileSync(cfg, 'utf8').replace(/^code_repo:\n/m, 'code_repo:\n  github: acme/repo\n'));
    store = await DataStore.open(dataDir, { emit: () => {} });
    const world = new FakeWorld(() => {}, { 'origin/trunk': 'f'.repeat(40) });
    const git = new DryRunGitPort(world);
    const files: Record<string, string[]> = {};
    git.changedFiles = async (_cwd: string, _base: string, head: string) => (files[head] ?? []).map((path) => ({ path, change: 'added' as const, bytes: 1 }));
    const ports: Ports = { mode: 'dry-run', git, gh: new DryRunGhPort(world), proc: new DryRunProcPort(world), agents: { claude: new DryRunClaudePort(world) } };
    engine = new LiveEngine(store, ports, () => {}, { sleep: async () => {}, tickMs: 50 });
    const e = engine as any;
    e.tick = async () => {};
    const it = store.createItem({ title: 'Check-impact policy', description: 'x' });
    const rel = '.claude/worktrees/policy'; const branch = 'tp/policy'; const cwd = e.absWorktree(rel);
    const s1 = world.sha(); files[s1] = ['tools/select_checks.py'];
    world.worktrees.set(cwd, { path: cwd, head: s1, branch }); world.remoteBranches.set(branch, s1);
    world.prs.set(301, { number: 301, url: 'u', state: 'OPEN', headRefOid: s1, headRefName: branch, baseRefName: 'trunk', polls: 0, failOnce: false });
    store.mutateItem(it.id, [{ set: { status: 'IN_REVIEW', worktree: rel, branch, pr: 301, ci_result: 'green', ci_head_sha: s1, review_hold: true, awaiting: 'review' } }], 'engine');
    await engine.releaseHold(it.id);
    // HH-428: the fix turn after CI went red adds a test file
    const s2 = world.sha(); files[s2] = ['tools/select_checks.py', 'tools/select_checks_test.py'];
    world.remoteBranches.set(branch, s2); world.worktrees.get(cwd)!.head = s2;
    store.mutateItem(it.id, [{ set: { ci_head_sha: s2 } }], 'engine');
    await e.merge(it.id, store.journal.begin('merge', it.id), 'trunk', s2);
    expect(store.requireItem(it.id).file.frontmatter.skip_merge).toBe(true);
    // the orchestrator releases it; the merge chain reaches the item while unskip_merge is still reading the branch
    const real = git.remoteBranchSha.bind(git); let mergedMidCall = false;
    git.remoteBranchSha = async (r: string, b: string) => {
      if (!mergedMidCall && !store!.requireItem(it.id).file.frontmatter.skip_merge) { mergedMidCall = true; await e.merge(it.id, store!.journal.begin('merge', it.id), 'trunk', s2); }
      return real(r, b);
    };
    const unskip = e.orchestrator.tools(() => {}).find((t: any) => t.name === 'unskip_merge');
    expect(await unskip.handler({ id: it.id })).toBe(`returned; its approved change is now 2 paths at ${s2.slice(0, 7)}`);
    git.remoteBranchSha = real;
    const fm = store.requireItem(it.id).file.frontmatter;
    expect(fm.skip_merge).toBeUndefined();
    expect((fm.op_data as any).approved_scope).toEqual({ sha: s2, paths: ['tools/select_checks.py', 'tools/select_checks_test.py'] });
    await e.merge(it.id, store.journal.begin('merge', it.id), 'trunk', s2);
    expect(world.prs.get(301)!.state).toBe('MERGED');
    expect(store.journal.read({ item: it.id, type: 'orchestrator.wake' }).filter((w) => w.data?.event === 'scope_changed')).toHaveLength(1);
  });
});
