import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DataStore } from '../src/store/DataStore.ts';
import { LiveEngine } from '../src/engine/LiveEngine.ts';
import { FakeWorld, DryRunGitPort, DryRunGhPort, DryRunProcPort, DryRunClaudePort } from '../src/engine/dryrun-ports.ts';
import type { CiStatus, Ports } from '../src/engine/ports.ts';
import { makeFixture, sleep } from './helpers.ts';

// #560: same-base PRs released together each rebased, pushed and ran CI, and every sibling that merged first threw the
// others' runs away. An item whose sync would push a new head waits while a sibling's run on the base tip goes first.

let store: DataStore | undefined; let engine: LiveEngine | undefined;
afterEach(async () => { await engine?.stop(); store?.close(); store = undefined; engine = undefined; });

type Verdict = CiStatus['state'];

async function setup() {
  const { dataDir } = makeFixture();
  const cfg = join(dataDir, 'planestro.yml');
  writeFileSync(cfg, readFileSync(cfg, 'utf8').replace(/^code_repo:\n/m, 'code_repo:\n  github: acme/repo\n'));
  delete process.env.PLANESTRO_DRYRUN_CI;
  store = await DataStore.open(dataDir, { emit: () => {} });
  const world = new FakeWorld(() => {}, { 'origin/trunk': 'f'.repeat(40) });
  const ports: Ports = { mode: 'dry-run', git: new DryRunGitPort(world), gh: new DryRunGhPort(world), proc: new DryRunProcPort(world), agents: { claude: new DryRunClaudePort(world) } };
  const make = () => { const e = new LiveEngine(store!, ports, () => {}, { sleep: async () => {}, tickMs: 30 }); (e as any).sleep = () => sleep(5); return e; };
  engine = make();
  // A merge moves the base tip to its merge commit, as GitHub's would.
  const realMerge = ports.gh.mergePr.bind(ports.gh);
  ports.gh.mergePr = async (r, n, o) => { const out = await realMerge(r, n, o); if (out === 'merged') world.baseBranches['origin/trunk'] = world.prs.get(n)!.mergeCommit!; return out; };
  // Every push is a CI run; the verdict for each head is the test's.
  const pushes: string[] = [];
  const realPush = ports.git.pushForceWithLease.bind(ports.git);
  ports.git.pushForceWithLease = async (cwd, branch, expected) => { await realPush(cwd, branch, expected); pushes.push(branch); };
  const polls = new Map<string, number>();
  let verdict: (branch: string, sha: string, polls: number) => Verdict = (_b, _s, n) => n >= 2 ? 'success' : 'pending';
  ports.gh.ciForSha = async (_r, branch, sha) => {
    const n = (polls.get(sha) ?? 0) + 1; polls.set(sha, n);
    const state = verdict(branch, sha, n);
    const runId = parseInt(sha.slice(0, 6), 16);
    return { state, runId, sha, url: `https://example/run/${runId}`, attempt: 1 };
  };
  return { store, world, ports, pushes, make, setVerdict: (v: typeof verdict) => { verdict = v; } };
}

function inReview(store: DataStore, eng: LiveEngine, world: FakeWorld, n: number, extra: Record<string, unknown> = {}) {
  const item = store.createItem({ title: `Sibling ${n}`, description: 'x' });
  const branch = `tp/${n}-sib`, rel = `.claude/worktrees/tp-${n}-sib`, pr = 500 + n;
  const cwd = (eng as any).absWorktree(rel);
  mkdirSync(cwd, { recursive: true });
  const head = world.sha();
  world.worktrees.set(cwd, { path: cwd, head, branch }); world.localBranches.add(branch); world.remoteBranches.set(branch, head); world.commits.set(cwd, 1);
  world.prs.set(pr, { number: pr, url: `https://github.com/acme/repo/pull/${pr}`, state: 'OPEN', headRefOid: head, headRefName: branch, baseRefName: 'trunk', polls: 0, failOnce: false });
  store.mutateItem(item.id, [{ set: { status: 'IN_REVIEW', branch, worktree: rel, pr, ci_result: 'pending', merge_order: n, ...extra } }], 'engine');
  return { id: item.id, branch, cwd, pr, head };
}

async function waitFor(pred: () => boolean, ms = 8000) { const t0 = Date.now(); while (!pred()) { if (Date.now() - t0 > ms) throw new Error('timeout waiting'); await sleep(20); } }
const fmOf = (s: DataStore, id: string) => s.getItem(id)!.file.frontmatter;
const activityOf = (s: DataStore, id: string) => s.getItem(id)!.file.sections.find((x) => x.title === 'Activity')!.body;

describe('same-base siblings wait for the one in CI ahead of them (#560)', () => {
  it('three siblings released together run CI once each when all pass, and say who waits on whom', async () => {
    const { store, world, pushes } = await setup();
    const [a, b, c] = [1, 2, 3].map((n) => inReview(store, engine!, world, n));
    await engine!.start();
    await waitFor(() => [a, b, c].every((x) => fmOf(store, x.id).status === 'FINISHED'));
    expect(pushes).toHaveLength(3);   // one sync and one run each; before #560 each merge sent the rest round again (3 + 2 + 1)
    expect(pushes).toEqual([a.branch, b.branch, c.branch]);
    expect(activityOf(store, b.id)).toMatch(new RegExp(`waiting on ${a.id}: its CI for [0-9a-f]{7} on trunk@fffffff runs first`));
    expect(activityOf(store, b.id)).toContain(`no longer waiting on ${a.id}: it merged; syncing with trunk`);
    expect(activityOf(store, c.id)).toContain(`waiting on ${a.id}`);
    expect(activityOf(store, c.id)).toContain(`waiting on ${b.id}`);
    expect(activityOf(store, c.id)).not.toContain('discarded');
    for (const x of [a, b, c]) expect(fmOf(store, x.id).op_data?.sibling_ci).toBeUndefined();
  });

  it('a red sibling does not hold back the one behind it', async () => {
    const { store, world, pushes, setVerdict } = await setup();
    const a = inReview(store, engine!, world, 1);
    const b = inReview(store, engine!, world, 2);
    setVerdict((branch, _s, n) => n < 2 ? 'pending' : branch === a.branch ? 'failure' : 'success');
    await engine!.start();
    await waitFor(() => fmOf(store, b.id).status === 'FINISHED');
    expect(activityOf(store, b.id)).toContain(`waiting on ${a.id}`);
    expect(activityOf(store, b.id)).toMatch(new RegExp(`no longer waiting on ${a.id}: it went red on [0-9a-f]{7}; syncing with trunk`));
    expect(pushes.filter((p) => p === b.branch)).toHaveLength(1);
    expect(fmOf(store, a.id).status).not.toBe('FINISHED');
  });

  it('a sibling put on hold while in CI lets the one behind it go', async () => {
    const { store, world, setVerdict } = await setup();
    const a = inReview(store, engine!, world, 1);
    const b = inReview(store, engine!, world, 2);
    setVerdict((branch, _s, n) => branch === a.branch ? 'pending' : n >= 2 ? 'success' : 'pending');
    await engine!.start();
    await waitFor(() => Boolean(fmOf(store, b.id).op_data?.sibling_ci));
    store.mutateItem(a.id, [{ set: { skip_merge: true } }], 'user');
    await waitFor(() => fmOf(store, b.id).status === 'FINISHED');
    expect(activityOf(store, b.id)).toContain(`no longer waiting on ${a.id}: it is held`);
  });

  it('a restart mid-wait rebuilds the wait from the item files: no sync, no second line, and it goes once the sibling merges', async () => {
    const { store, world, pushes, make, setVerdict } = await setup();
    let release = false;
    const a = inReview(store, engine!, world, 1);
    const b = inReview(store, engine!, world, 2);
    setVerdict((branch, _s, n) => branch === a.branch && !release ? 'pending' : n >= 2 ? 'success' : 'pending');
    await engine!.start();
    await waitFor(() => Boolean(fmOf(store, b.id).op_data?.sibling_ci));
    await engine!.stop();
    expect(fmOf(store, a.id).op).toBe('awaiting_ci');
    engine = make();
    await engine.start();
    await sleep(300);
    expect(pushes).toEqual([a.branch]);
    expect(fmOf(store, b.id).op_data?.sibling_ci).toMatchObject({ on: a.id });
    expect(activityOf(store, b.id).match(/waiting on /g)).toHaveLength(1);
    release = true;
    await waitFor(() => fmOf(store, b.id).status === 'FINISHED');
    expect(pushes).toEqual([a.branch, b.branch]);
  });

  it('under the pause a wait is kept as it is, and resuming takes it up again', async () => {
    const { store, world, pushes, setVerdict } = await setup();
    let release = false;
    const a = inReview(store, engine!, world, 1);
    const b = inReview(store, engine!, world, 2);
    setVerdict((branch, _s, n) => branch === a.branch && !release ? 'pending' : n >= 2 ? 'success' : 'pending');
    await engine!.start();
    await waitFor(() => Boolean(fmOf(store, b.id).op_data?.sibling_ci));
    engine!.pause();
    release = true;
    await sleep(300);
    expect(pushes).toEqual([a.branch]);
    expect(fmOf(store, b.id).op_data?.sibling_ci).toMatchObject({ on: a.id });
    engine!.resume();
    await waitFor(() => fmOf(store, b.id).status === 'FINISHED');
    expect(pushes).toEqual([a.branch, b.branch]);
  });

  it('a green run thrown away because the base moved says so, naming the merge that moved it', async () => {
    const { store, world, setVerdict } = await setup();
    const a = inReview(store, engine!, world, 1);
    const b = inReview(store, engine!, world, 2);
    // Both already on the tip and pushed: neither syncs, both run; A's run ends first and A merges.
    world.behind.set(a.cwd, 0); world.behind.set(b.cwd, 0);
    setVerdict((branch, _s, n) => branch === a.branch ? (n >= 2 ? 'success' : 'pending') : fmOf(store!, a.id).status === 'FINISHED' && n >= 2 ? 'success' : 'pending');
    await engine!.start();
    await waitFor(() => fmOf(store, b.id).status === 'FINISHED');
    const tip = world.prs.get(a.pr)!.mergeCommit!;
    expect(activityOf(store, b.id)).toContain(`green run for ${b.head.slice(0, 7)} discarded: trunk moved to ${tip.slice(0, 7)} (${a.id} merged)`);
  });
});
