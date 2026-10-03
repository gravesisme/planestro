import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DataStore } from '../src/store/DataStore.ts';
import { LiveEngine } from '../src/engine/LiveEngine.ts';
import { apiRoutes } from '../src/routes/api.ts';
import { FakeWorld, DryRunGitPort, DryRunGhPort, DryRunProcPort, DryRunClaudePort } from '../src/engine/dryrun-ports.ts';
import type { Ports, CiStatus } from '../src/engine/ports.ts';
import { getSection } from '@planestro/shared';
import { makeFixture, sleep } from './helpers.ts';

/**
 * Re-running a flaky red run (#139, HH-307, HH-284): retry_op only read the same red run again, so a
 * suspected flake after ci_red_twice always reached the user. rerun_ci re-runs that run's failed jobs,
 * once per head from the orchestrator, and only the new attempt's verdict counts.
 */
let store: DataStore | undefined; let engine: LiveEngine | undefined;
afterEach(async () => { await engine?.stop(); store?.close(); store = undefined; engine = undefined; });

async function setup() {
  const { dataDir, codeRepo } = makeFixture();
  mkdirSync(join(codeRepo, '.git', 'info'), { recursive: true });
  const cfg = join(dataDir, 'planestro.yml');
  writeFileSync(cfg, readFileSync(cfg, 'utf8').replace(/^code_repo:\n/m, 'code_repo:\n  github: acme/repo\n'));
  delete process.env.PLANESTRO_DRYRUN_CI;
  store = await DataStore.open(dataDir, { emit: () => {} });
  const world = new FakeWorld(() => {}, { 'origin/trunk': 'f'.repeat(40) });
  const gh = new DryRunGhPort(world);
  // Run 7 is red at attempt 1 until its failed jobs are re-run; attempt 2 is pending for two polls, then `second`.
  const run = { attempt: 1, polls: 0, second: 'success' as 'success' | 'failure', reruns: 0 };
  gh.ciForSha = async (_r: string, _b: string, sha: string): Promise<CiStatus> => {
    if (run.attempt === 1) return { state: 'failure', runId: 7, sha, url: 'u7', attempt: 1 };
    return ++run.polls < 3 ? { state: 'pending', runId: 7, sha, url: 'u7', attempt: run.attempt } : { state: run.second, runId: 7, sha, url: 'u7', attempt: run.attempt };
  };
  gh.rerunFailed = async () => { run.reruns += 1; run.attempt += 1; run.polls = 0; };
  const ports: Ports = { mode: 'dry-run', git: new DryRunGitPort(world), gh, proc: new DryRunProcPort(world), agents: { claude: new DryRunClaudePort(world) } };
  engine = new LiveEngine(store, ports, () => {}, { sleep: async () => {}, tickMs: 50 });
  const s = store; const e = engine;
  /** An item in review whose CI went red twice on run 7 for its head. */
  const redTwice = () => {
    const it = s.createItem({ title: 'Desert art', description: 'x' });
    const rel = '.claude/worktrees/desert'; const branch = 'tp/desert'; const tip = world.sha();
    const cwd = (e as any).absWorktree(rel) as string;
    world.worktrees.set(cwd, { path: cwd, head: tip, branch }); world.localBranches.add(branch); world.remoteBranches.set(branch, tip);
    world.prs.set(300, { number: 300, url: 'u', state: 'OPEN', headRefOid: tip, headRefName: branch, baseRefName: 'trunk', polls: 0, failOnce: false });
    s.mutateItem(it.id, [{ set: { status: 'IN_REVIEW', worktree: rel, branch, pr: 300, ci_result: 'red', ci_failed_count: 2, ci_head_sha: tip, blocked: true, blocked_reason: 'ci_red_twice', op_data: { last_red: { runId: 7, sha: tip }, ci: { runId: 7 } } } }], 'engine');
    return { id: it.id, tip };
  };
  return { store: s, engine: e, world, run, redTwice };
}
const fm = (id: string) => store!.requireItem(id).file.frontmatter;
const activity = (id: string) => getSection(store!.requireItem(id).file, 'Activity');
async function until(pred: () => boolean, ms = 6000) { const t0 = Date.now(); while (!pred()) { if (Date.now() - t0 > ms) throw new Error('timeout'); await sleep(20); } }

describe('rerun_ci (#139)', () => {
  it('re-runs the red run, clears the block, ignores the stale attempt and merges on the new one', async () => {
    const { engine, run, redTwice } = await setup();
    const h = redTwice();
    expect(await engine.rerunCi(h.id, 'orchestrator')).toBe('re-running the failed jobs of run 7 (attempt 2); its verdict is the one that counts');
    expect(run.reruns).toBe(1);
    expect(fm(h.id)).toMatchObject({ op: 'awaiting_ci', ci_result: 'pending' });
    expect(fm(h.id).blocked).toBeUndefined();
    expect(activity(h.id)).toContain('re-ran the failed jobs of CI run 7 for');
    await engine.start();
    await until(() => ['MERGED', 'FINISHED'].includes(fm(h.id).status));
    expect(activity(h.id)).not.toContain('same red run');
  });

  it('a red second attempt counts as a failure again; the orchestrator gets one re-run per head, the user more', async () => {
    const { engine, run, redTwice } = await setup();
    run.second = 'failure';
    const h = redTwice();
    await engine.rerunCi(h.id, 'orchestrator');
    await engine.start();
    await until(() => fm(h.id).blocked === true && fm(h.id).ci_failed_count === 3);
    expect(fm(h.id).blocked_reason).toBe('ci_red_twice');
    expect(await engine.rerunCi(h.id, 'orchestrator')).toMatch(/^not possible: you already re-ran CI once for \w{7}/);
    await until(() => !(engine as any).jobs.has(h.id));
    expect(await engine.rerunCi(h.id, 'user')).toMatch(/^re-running the failed jobs of run 7 \(attempt 3\)/);
  });

  it('refuses a moved head, an item with no red run, and a retry_op says it does not re-run CI', async () => {
    const { store, engine, world, redTwice } = await setup();
    const h = redTwice();
    world.remoteBranches.set('tp/desert', 'a'.repeat(40));
    expect(await engine.rerunCi(h.id)).toMatch(/^not possible: the head moved to aaaaaaa/);
    world.remoteBranches.set('tp/desert', h.tip);
    const plain = store.createItem({ title: 'x', description: 'x' });
    expect(await engine.rerunCi(plain.id)).toMatch(/^not possible: .* has no pull request in review/);
    expect(await engine.retryOp(h.id)).toMatch(/does not run CI again: use rerun_ci/);
  });

  it('the API re-runs for the user and says why not in an error', async () => {
    const { store, engine, redTwice } = await setup();
    const h = redTwice();
    const app = apiRoutes(store, engine);
    const plain = store.createItem({ title: 'x', description: 'x' });
    const bad = await app.request(`/items/${plain.id}/rerun-ci`, { method: 'POST' });
    expect(bad.status).toBe(400);
    const ok = await app.request(`/items/${h.id}/rerun-ci`, { method: 'POST' });
    expect(ok.status).toBe(200); expect((await ok.json()).said).toMatch(/^re-running/);
  });

  it('past its one re-run, the orchestrator offers it on a card and the user\'s tap re-runs it (#162)', async () => {
    const { engine, run, redTwice } = await setup();
    run.second = 'failure';
    const h = redTwice();
    await engine.rerunCi(h.id, 'orchestrator');
    await engine.start();
    await until(() => fm(h.id).blocked === true && fm(h.id).ci_failed_count === 3);
    await until(() => !(engine as any).jobs.has(h.id));
    expect(await engine.rerunCi(h.id, 'orchestrator')).toMatch(/action \{ tool: "rerun_ci"/);
    await (engine as any).askUserDecision(h.id, { question: 'Re-run CI now that the runner has disk space?', why: 'Both reds came while its disk was full.', options: [
      { label: 'Re-run CI', description: 'The runner has 78 GiB free now', recommended: true, action: { tool: 'rerun_ci', args: { id: h.id } } },
      { label: 'Leave it', description: 'Look at the logs first' },
    ] });
    await engine.answerDecision(h.id, { choice: 'Re-run CI' });
    expect(fm(h.id).blocked).toBeUndefined();
    expect(fm(h.id).op).toBe('awaiting_ci');
    expect(run.reruns).toBe(2);
    expect(activity(h.id)).toMatch(/decided: Re-run CI now that the runner has disk space\? → Re-run CI \(done for you: re-running the failed jobs of run 7/);
  });
});

/**
 * A cancelled run past its one re-run (#174, HH Oct 2): the wait sat on it until ci.timeout_min (6 h), and rerun-ci
 * refused because "a step is running", though the step was only the poll loop. It blocks ci_cancelled at once now,
 * and the user can re-run a cancelled run under a wait that is still polling it.
 */
describe('a cancelled CI run (#174)', () => {
  /** An item in review waiting on run 9, cancelled at the attempts named; any other attempt is pending twice, then green. */
  async function waiting(cancelled: number[]) {
    const s = await setup();
    const run = { attempt: 1, polls: 0, reruns: 0 };
    const gh = (s.engine as any).ports.gh as DryRunGhPort;
    gh.ciForSha = async (_r: string, _b: string, sha: string): Promise<CiStatus> => {
      if (cancelled.includes(run.attempt)) return { state: 'cancelled', runId: 9, sha, url: 'https://example/run/9', attempt: run.attempt };
      return ++run.polls < 3 ? { state: 'pending', runId: 9, sha, url: 'https://example/run/9', attempt: run.attempt } : { state: 'success', runId: 9, sha, url: 'https://example/run/9', attempt: run.attempt };
    };
    gh.rerunAll = async () => { run.reruns += 1; run.attempt += 1; run.polls = 0; };
    const h = s.redTwice();
    s.store.mutateItem(h.id, [{ unset: ['blocked', 'blocked_reason'] }, { set: { ci_result: 'pending', ci_failed_count: 0, op: 'awaiting_ci', op_data: {} } }], 'engine');
    return { ...s, run, h };
  }

  it('still cancelled after its one re-run, it blocks ci_cancelled with the run link, and the user re-runs it from there', async () => {
    const { engine, run, h } = await waiting([1, 2]);
    await engine.start();
    await until(() => fm(h.id).blocked === true);
    expect(fm(h.id).blocked_reason).toBe('ci_cancelled');
    expect(run.reruns).toBe(1);
    expect(activity(h.id)).toMatch(/CI run 9 for \w{7} was cancelled again after planestro re-ran it once \(https:\/\/example\/run\/9\)/);
    expect(fm(h.id).op_data?.last_cancelled).toMatchObject({ runId: 9, sha: fm(h.id).ci_head_sha });
    await until(() => !(engine as any).jobs.has(h.id));
    expect(await engine.rerunCi(h.id, 'user')).toBe('re-running cancelled run 9 (attempt 3); its verdict is the one that counts');
    expect(fm(h.id).blocked).toBeUndefined();
    await until(() => ['MERGED', 'FINISHED'].includes(fm(h.id).status));
    expect(run.reruns).toBe(2);
  });

  it('the user re-runs a cancelled run while the wait polls it; the same wait takes the new attempt, with no second re-run or wait', async () => {
    const { store, engine, run, h } = await waiting([1]);
    let gate = true; const parked: Array<() => void> = [];
    (engine as any).sleep = (_ms: number) => gate ? new Promise<void>((r) => parked.push(r)) : Promise.resolve();
    await engine.start();
    await until(() => (engine as any).ciWaits.has(h.id) && parked.length > 0);
    expect(await engine.rerunCi(h.id, 'user')).toBe('re-running cancelled run 9 (attempt 2); the CI wait already running counts only that attempt');
    expect(fm(h.id).op).toBe('awaiting_ci');
    expect(activity(h.id)).toContain('re-ran cancelled CI run 9 for');
    expect(await engine.rerunCi(h.id, 'user')).toMatch(/^not now: CI for \w{7} is still running/);
    gate = false; parked.splice(0).forEach((r) => r());
    await until(() => ['MERGED', 'FINISHED'].includes(fm(h.id).status));
    expect(run.reruns).toBe(1);
    expect(store.journal.read({ type: 'op.begin', item: h.id }).filter((e) => e.data?.op === 'ci_wait')).toHaveLength(1);
    expect(activity(h.id)).not.toContain('no other run replaced it');
  });
});
