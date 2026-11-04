import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DataStore } from '../src/store/DataStore.ts';
import { LiveEngine } from '../src/engine/LiveEngine.ts';
import { FakeWorld, DryRunGitPort, DryRunGhPort, DryRunProcPort, DryRunClaudePort } from '../src/engine/dryrun-ports.ts';
import type { Ports, CiStatus } from '../src/engine/ports.ts';
import { getSection } from '@planestro/shared';
import { makeFixture, sleep } from './helpers.ts';

/**
 * A cancelled or infrastructure run on a head its base has moved past (#533, #532). HH-310's run was cancelled three times by a
 * slow full-history checkout; the fix (HH-678) merged into its base, but a re-run of a pull_request run reuses the old merge
 * commit and workflow, so it could not help, and sync_with_base, retry_op and mark_blocked all refused while planestro's own
 * re-run burned 40 more minutes of CI. Now the wait ends and the merge pipeline syncs the item, so the new head gets a run of its
 * own; sync_with_base takes such an item on, blocked or still waiting; rerun_ci refuses it in words, naming sync_with_base.
 */
let store: DataStore | undefined; let engine: LiveEngine | undefined;
afterEach(async () => { await engine?.stop(); store?.close(); store = undefined; engine = undefined; });

const BRANCH = 'tp/desert';
async function setup() {
  const { dataDir, codeRepo } = makeFixture();
  mkdirSync(join(codeRepo, '.git', 'info'), { recursive: true });
  const cfg = join(dataDir, 'planestro.yml');
  writeFileSync(cfg, readFileSync(cfg, 'utf8').replace(/^code_repo:\n/m, 'code_repo:\n  github: acme/repo\n'));
  delete process.env.PLANESTRO_DRYRUN_CI;
  const s = store = await DataStore.open(dataDir, { emit: () => {} });
  const world = new FakeWorld(() => {}, { 'origin/trunk': 'f'.repeat(40) });
  const gh = new DryRunGhPort(world);
  const ports: Ports = { mode: 'dry-run', git: new DryRunGitPort(world), gh, proc: new DryRunProcPort(world), agents: { claude: new DryRunClaudePort(world) } };
  const e = engine = new LiveEngine(s, ports, () => {}, { sleep: async () => {}, tickMs: 50 });
  const it = s.createItem({ title: 'Desert art', description: 'x' });
  const rel = '.claude/worktrees/desert'; const tip = world.sha();
  const cwd = (e as any).absWorktree(rel) as string;
  world.worktrees.set(cwd, { path: cwd, head: tip, branch: BRANCH }); world.localBranches.add(BRANCH); world.remoteBranches.set(BRANCH, tip);
  world.prs.set(300, { number: 300, url: 'u', state: 'OPEN', headRefOid: tip, headRefName: BRANCH, baseRefName: 'trunk', polls: 0, failOnce: false });
  // In review, waiting for CI on its head; the old head's run 9 is `old` (cancelled, or red), any other head's run is green.
  s.mutateItem(it.id, [{ set: { status: 'IN_REVIEW', worktree: rel, branch: BRANCH, pr: 300, ci_result: 'pending', ci_head_sha: tip, op: 'awaiting_ci', op_data: {} } }], 'engine');
  // Already on the base tip, so entering the pipeline reuses the head and waits for its run instead of rebasing.
  world.behind.set(cwd, 0);
  /** The base moves past the head since it was synced (a fix merges): origin/trunk is no ancestor of it, and the worktree is behind. */
  const baseMoves = () => { world.unreachable.add('origin/trunk'); world.baseBranches['origin/trunk'] = 'e'.repeat(40); world.behind.set(cwd, 1); };
  // `moveBase`: the base moves while the wait polls the old head's run (as HH-678 merged while HH-310 waited).
  const run = { old: 'cancelled' as 'cancelled' | 'failure' | 'pending', reruns: 0, moveBase: false, attempt: 1 };
  gh.ciForSha = async (_r: string, _b: string, sha: string): Promise<CiStatus> => {
    if (sha !== tip) return { state: 'success', runId: 10, sha, url: 'https://example/run/10', attempt: 1 };
    if (run.moveBase) { run.moveBase = false; baseMoves(); }
    return { state: run.old, runId: 9, sha, url: 'https://example/run/9', attempt: run.attempt };
  };
  // A re-run's new attempt of the old head's run ends the same way as the first.
  gh.rerunAll = async () => { run.reruns += 1; run.attempt += 1; };
  gh.rerunFailed = async () => { run.reruns += 1; run.attempt += 1; };
  return { store: s, engine: e, world, gh, run, id: it.id, tip, cwd, baseMoves };
}
const fm = (id: string) => store!.requireItem(id).file.frontmatter;
const activity = (id: string) => getSection(store!.requireItem(id).file, 'Activity');
async function until(pred: () => boolean, ms = 6000) { const t0 = Date.now(); while (!pred()) { if (Date.now() - t0 > ms) throw new Error('timeout'); await sleep(20); } }
const ended = (id: string, reason: string) => store!.journal.read({ type: 'op.end', item: id }).filter((e) => e.data?.reason === reason);

describe('a cancelled run on a head its base has moved past (#533)', () => {
  it('is not re-run: the wait ends, the branch is rebased and pushed with a lease, and the new head is watched and merges', async () => {
    const { engine, world, run, id, tip } = await setup();
    run.moveBase = true;
    await engine.start();
    await until(() => ['MERGED', 'FINISHED'].includes(fm(id).status));
    expect(run.reruns).toBe(0);
    expect(world.remoteBranches.get(BRANCH) ?? 'gone').not.toBe(tip);
    expect(activity(id)).toMatch(/CI run 9 for \w{7} was cancelled, and trunk has moved past it since it was synced \(to eeeeeee\): a re-run would reuse its old merge commit and workflow, so it is synced with trunk instead/);
    expect(activity(id)).toMatch(/rebased onto trunk@\w{7} and pushed \w{7}; waiting for CI/);
    expect(activity(id)).not.toContain('re-running it');
    expect(ended(id, 'stale_base')).toHaveLength(1);
    expect(fm(id).blocked).toBeUndefined();
  });

  it('on a base that has not moved it is re-run once, then blocks ci_cancelled as before, naming sync_with_base for a fix on the base', async () => {
    const { engine, world, run, id, tip } = await setup();
    await engine.start();
    await until(() => fm(id).blocked === true);
    expect(fm(id).blocked_reason).toBe('ci_cancelled');
    expect(run.reruns).toBe(1);
    expect(world.remoteBranches.get(BRANCH)).toBe(tip);
    expect(ended(id, 'stale_base')).toHaveLength(0);
    expect(activity(id)).toMatch(/was cancelled again after planestro re-ran it once .*a fix that lands on trunk \(a workflow change\) needs a new head instead, since a re-run reuses this head's merge commit and workflow: sync_with_base then/);
  });

  it('a red run on the infrastructure is synced the same way, with no re-run of its failed jobs and no fix turn', async () => {
    const { engine, world, run, id, tip } = await setup();
    run.old = 'failure';
    world.failedLog = '##[error]The runner has received a shutdown signal. This can happen when the runner service is stopped.';
    run.moveBase = true;
    await engine.start();
    await until(() => ['MERGED', 'FINISHED'].includes(fm(id).status));
    expect(run.reruns).toBe(0);
    expect(world.remoteBranches.get(BRANCH) ?? 'gone').not.toBe(tip);
    expect(activity(id)).toMatch(/CI run 9 for \w{7} failed on the infrastructure \(The runner has received a shutdown signal, built in\), and trunk has moved past it/);
    expect(activity(id)).not.toContain('CI red (github');
    expect(fm(id).ci_failed_count ?? 0).toBe(0);
  });
});

describe('sync_with_base on an item in review whose run was cancelled (#533)', () => {
  it('ends a CI wait sitting on the cancelled run, and the pipeline syncs it for a new head', async () => {
    const { engine, world, run, id, tip } = await setup();
    run.moveBase = true;
    // The wait polls (and is parked between polls) before planestro's own look at the cancelled run comes round.
    let gate = true; const parked: Array<() => void> = [];
    (engine as any).sleep = (_ms: number) => gate ? new Promise<void>((r) => parked.push(r)) : Promise.resolve();
    await engine.start();
    await until(() => (engine as any).ciWaits.has(id) && parked.length > 0);
    // A re-run under the wait would not have what landed on trunk either (#532).
    expect(await engine.rerunCi(id, 'user')).toMatch(/^not possible: trunk has moved past \w{7} since it was synced.*Use sync_with_base instead/);
    expect(await engine.syncWithBase(id, { by: 'orchestrator' })).toMatch(/^ending the CI wait: its run for \w{7} was cancelled \(run 9\), and trunk has moved past it to eeeeeee\. The merge pipeline syncs/);
    expect(activity(id)).toContain('sync with base: ending the CI wait on');
    gate = false; parked.splice(0).forEach((r) => r());
    await until(() => ['MERGED', 'FINISHED'].includes(fm(id).status));
    expect(run.reruns).toBe(0);
    expect(world.remoteBranches.get(BRANCH) ?? 'gone').not.toBe(tip);
    expect(store!.journal.read({ type: 'op.end', item: id }).find((e) => e.data?.reason === 'stale_base')?.data?.by).toBe('orchestrator');
  });

  it('a blocked ci_cancelled item re-enters the pipeline, which syncs and merges it', async () => {
    const { store, engine, world, run, id, tip, baseMoves } = await setup();
    store.mutateItem(id, [{ unset: ['op'] }, { set: { blocked: true, blocked_reason: 'ci_cancelled', op_data: { last_cancelled: { runId: 9, sha: tip }, ci: { runId: 9 }, ci_cancel_rerun: tip } } }], 'engine');
    baseMoves();
    expect(await engine.syncWithBase(id, { by: 'user' })).toMatch(/^in review, and its run for \w{7} was cancelled, and trunk has moved past it to eeeeeee: the merge pipeline syncs it for a new head and a run of its own: retrying: it re-enters the merge pipeline/);
    await engine.start();
    await until(() => ['MERGED', 'FINISHED'].includes(fm(id).status));
    expect(run.reruns).toBe(0);
    expect(world.remoteBranches.get(BRANCH) ?? 'gone').not.toBe(tip);
  });

  it('is refused for a healthy pull request, and for a cancelled run whose base has not moved', async () => {
    const { store, engine, run, id } = await setup();
    run.old = 'pending';
    expect(await engine.syncWithBase(id, { by: 'orchestrator' })).toMatch(/^not needed: .* is in review, and the merge pipeline rebases its pull request/);
    store.mutateItem(id, [{ unset: ['op'] }], 'engine');
    expect(await engine.syncWithBase(id, { by: 'orchestrator' })).toMatch(/^not needed: .* is in review, and the merge pipeline rebases/);
    store.mutateItem(id, [{ set: { op: 'awaiting_ci' } }], 'engine');
    run.old = 'cancelled';
    expect(await engine.syncWithBase(id, { by: 'orchestrator' })).toMatch(/^not needed: .*'s head \w{7} is already on origin\/trunk, so a sync gives it no new head and its run \(cancelled \(run 9\)\) would be the same\. Re-run CI \(rerun_ci\)/);
    expect(fm(id).op_data?.ci_resync).toBeUndefined();
  });

  it('is refused while another step runs on the item', async () => {
    const { engine, id, baseMoves } = await setup();
    baseMoves();
    let release!: () => void;
    (engine as any).jobs.set(id, new Promise<void>((r) => { release = r; }));
    expect(await engine.syncWithBase(id, { by: 'orchestrator' })).toMatch(/^not now: /);
    release(); (engine as any).jobs.delete(id);
  });
});

describe('rerun_ci on a cancelled run whose base has moved (#532)', () => {
  it('refuses in words for a blocked ci_cancelled item, naming sync_with_base (a base that has not moved is re-run as before)', async () => {
    const { store, engine, run, id, tip, baseMoves } = await setup();
    store.mutateItem(id, [{ unset: ['op'] }, { set: { blocked: true, blocked_reason: 'ci_cancelled', op_data: { last_cancelled: { runId: 9, sha: tip }, ci: { runId: 9 } } } }], 'engine');
    expect(await engine.rerunCi(id, 'orchestrator')).toMatch(/^re-running cancelled run 9/);
    store.mutateItem(id, [{ unset: ['op'] }, { set: { blocked: true, blocked_reason: 'ci_cancelled', op_data: { last_cancelled: { runId: 9, sha: tip }, ci: { runId: 9 } } } }], 'engine');
    baseMoves();
    expect(await engine.rerunCi(id, 'user')).toMatch(/^not possible: trunk has moved past \w{7} since it was synced \(it is at eeeeeee now\), and a re-run reuses that head's old merge commit and workflow.*Use sync_with_base instead/);
    expect(run.reruns).toBe(1);
    expect(fm(id).blocked).toBe(true);
  });
});
