import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DataStore } from '../src/store/DataStore.ts';
import { LiveEngine } from '../src/engine/LiveEngine.ts';
import { FakeWorld, DryRunGitPort, DryRunGhPort, DryRunProcPort, DryRunClaudePort } from '../src/engine/dryrun-ports.ts';
import { attemptTiming } from '../src/engine/live-ports.ts';
import type { CiStatus, Ports } from '../src/engine/ports.ts';
import { apiRoutes } from '../src/routes/api.ts';
import { ciBreakdown } from '@planestro/shared';
import { makeFixture, sleep } from './helpers.ts';

// #179: a CI wait's end keeps the run's timing (queue, first job, end, jobs, re-runs). #180: a merge records what proved it green.

let store: DataStore | undefined; let engine: LiveEngine | undefined;
afterEach(async () => { await engine?.stop(); store?.close(); store = undefined; engine = undefined; });

async function setup() {
  const { dataDir } = makeFixture();
  const cfg = join(dataDir, 'planestro.yml');
  writeFileSync(cfg, readFileSync(cfg, 'utf8').replace(/^code_repo:\n/m, 'code_repo:\n  github: acme/repo\n'));
  delete process.env.PLANESTRO_DRYRUN_CI;
  store = await DataStore.open(dataDir, { emit: () => {} });
  const world = new FakeWorld(() => {}, { 'origin/trunk': 'f'.repeat(40) });
  const ports: Ports = { mode: 'dry-run', git: new DryRunGitPort(world), gh: new DryRunGhPort(world), proc: new DryRunProcPort(world), agents: { claude: new DryRunClaudePort(world) } };
  engine = new LiveEngine(store, ports, () => {}, { sleep: async () => {}, tickMs: 50 });
  mkdirSync(join(store.codeRepoPath(), '.git', 'info'), { recursive: true });
  return { store, engine, world };
}

async function waitFor(pred: () => boolean, ms = 8000) { const t0 = Date.now(); while (!pred()) { if (Date.now() - t0 > ms) throw new Error('timeout waiting'); await sleep(20); } }
const fmOf = (s: DataStore, id: string) => s.getItem(id)!.file.frontmatter;
const activityOf = (s: DataStore, id: string) => s.getItem(id)!.file.sections.find((x) => x.title === 'Activity')!.body;
const ends = (s: DataStore, id: string, op: string) => s.journal.read({ item: id, type: 'op.end' }).filter((e) => String(e.data?.op_id).startsWith(`${op}-`)).map((e) => e.data as Record<string, any>);

async function run(s: DataStore, e: LiveEngine, title: string, until: (id: string) => boolean) {
  const item = s.createItem({ title, description: 'x' });
  s.transition(item.id, 'QUEUED', 'user');
  await e.start();
  await waitFor(() => fmOf(s, item.id).status === 'PLAN_READY');
  await e.approvePlan(item.id);
  await waitFor(() => until(item.id));
  return item.id;
}
const finished = (s: DataStore) => (id: string) => fmOf(s, id).status === 'FINISHED' || fmOf(s, id).blocked === true;

describe('CI run timing at the end of a CI wait (#179)', () => {
  it('a green run: the wait ends with its run, attempt, queue, first job start, end and jobs', async () => {
    const { store, engine } = await setup();
    const id = await run(store, engine, 'Green', finished(store));
    expect(fmOf(store, id).status).toBe('FINISHED');
    const timing = ends(store, id, 'ci_wait').find((d) => d.timing)!.timing;
    expect(timing).toMatchObject({ run_id: 3, attempt: 1, url: 'https://example/run/3', reruns: [] });
    expect(timing.attempts).toHaveLength(1);
    expect(timing.attempts[0]).toMatchObject({ attempt: 1, created_at: expect.any(String), queued_at: expect.any(String), first_job_started_at: expect.any(String), completed_at: expect.any(String), jobs: [{ name: 'test', runner: 'fake-runner' }] });    // #181: the item's breakdown reads it; #182: the Usage page's CI aggregates count the wait and its run, nothing asked of GitHub again
    expect(ciBreakdown(timing)).toMatchObject({ run_id: 3, reruns: 0, latest: { attempt: 1, jobs: [{ name: 'test' }] } });
    const ci = await (await apiRoutes(store, engine).request('/usage/ci?days=1')).json();
    expect(ci.totals).toMatchObject({ waits: 1, runs: 1, reruns: 0 });
    expect(ci.run.n).toBe(1);
  });

  it('a cancelled run that is re-run: both attempts, and the re-run with its reason', async () => {
    const { store, engine, world } = await setup();
    world.ciCancelOnce = true;
    const id = await run(store, engine, 'Cancelled', finished(store));
    expect(fmOf(store, id).status).toBe('FINISHED');
    const timing = ends(store, id, 'ci_wait').find((d) => d.timing)!.timing;
    expect(timing.attempt).toBe(2);
    expect(timing.attempts.map((a: any) => a.attempt)).toEqual([1, 2]);
    expect(timing.reruns).toEqual([{ reason: 'cancelled', by: 'app' }]);
  });

  it('a flaky re-run: the re-run names the check that matched', async () => {
    const { store, engine, world } = await setup();
    world.ciMode = 'red-once';
    store.updateConfig((doc) => { doc.setIn(['ci', 'flaky_checks'], ['fake-check']); }, 'config: flaky');
    const id = await run(store, engine, 'Flaky', finished(store));
    expect(fmOf(store, id).status).toBe('FINISHED');
    const timing = ends(store, id, 'ci_wait').find((d) => d.timing)!.timing;
    expect(timing.reruns).toEqual([{ reason: 'flaky', by: 'app', attempt: 2, check: 'fake-check' }]);
    expect(timing.attempt).toBe(2);
  });

  it('a queue timeout: the wait ends with the run that never started, and no first job start', async () => {
    const { store, engine } = await setup();
    store.updateConfig((doc) => { doc.setIn(['ci', 'queue_timeout_min'], 100); }, 'config: short queue timeout');
    let clock = 0;
    (engine as any).ciNow = () => clock;
    (engine as any).ports.gh.ciForSha = async (_r: string, _b: string, sha: string): Promise<CiStatus> => { clock += 7 * 60_000; return { state: 'pending', queued: true, runId: 9, sha, url: 'https://example/run/9', attempt: 1 }; };
    (engine as any).ports.gh.runTiming = async (_r: string, _id: number, attempt: number) => attemptTiming({ run_attempt: attempt, status: 'queued', created_at: '2026-10-02T10:00:00Z', run_started_at: '2026-10-02T10:00:00Z', updated_at: '2026-10-02T11:40:00Z' }, [{ name: 'suite', status: 'queued', created_at: '2026-10-02T10:00:01Z', started_at: '2026-10-02T10:00:01Z', runner_name: null }], attempt);
    const id = await run(store, engine, 'Never starts', (i) => fmOf(store, i).blocked === true);
    expect(fmOf(store, id).blocked_reason).toBe('ci_timeout');
    const end = ends(store, id, 'ci_wait').find((d) => d.reason === 'ci_queue_timeout')!;
    expect(end.timing).toMatchObject({ run_id: 9, attempt: 1 });
    expect(end.timing.attempts[0].first_job_started_at).toBeUndefined();
    expect(end.timing.attempts[0].completed_at).toBeUndefined();
    expect(end.timing.attempts[0].jobs[0]).toMatchObject({ name: 'suite', status: 'queued' });
    expect(fmOf(store, id).op_data?.ci_timing).toEqual(end.timing);
  });

  it('attemptTiming counts only jobs a runner took towards the first start, and keeps job names as GitHub reports them', () => {
    const t = attemptTiming({ run_attempt: 2, status: 'completed', conclusion: 'success', created_at: 'a', run_started_at: 'b', updated_at: 'z' }, [
      { name: 'Godot / unit (shard 1)', status: 'completed', conclusion: 'success', started_at: 'd', completed_at: 'e', runner_name: 'mini-1' },
      { name: 'lint', status: 'completed', conclusion: 'success', started_at: 'c', completed_at: 'f', runner_name: 'mini-2' },
      { name: 'skipped', status: 'completed', conclusion: 'skipped', started_at: 'a', completed_at: 'a', runner_name: null },
    ], 2);
    expect(t).toMatchObject({ attempt: 2, created_at: 'a', queued_at: 'b', first_job_started_at: 'c', completed_at: 'z', conclusion: 'success' });
    expect(t.jobs.map((j) => j.name)).toEqual(['Godot / unit (shard 1)', 'lint', 'skipped']);
  });
});

describe('validation evidence pointer on merge (#180)', () => {
  it('a merge records the run, its url, the head, the base and the merge commit, on the item and the merge op', async () => {
    const { store, engine } = await setup();
    const id = await run(store, engine, 'Pointer', finished(store));
    const fm = fmOf(store, id);
    expect(fm.status).toBe('FINISHED');
    const v = fm.validated_by as Record<string, string | number>;
    expect(v).toMatchObject({ run_id: 3, url: 'https://example/run/3', head: fm.ci_head_sha, base: expect.any(String), merge: expect.any(String) });
    expect(ends(store, id, 'merge').find((d) => d.merged)!.validated_by).toEqual(v);
    expect(activityOf(store, id)).toMatch(/merged PR #\d+ into trunk \(\w{7}\); validated by CI run 3 \(https:\/\/example\/run\/3\) on \w{7} over trunk@\w{7}/);
  });

  it('a re-sync after the base moved records the new head\'s run, not the old one', async () => {
    const { store, engine, world } = await setup();
    const gh = (engine as any).ports.gh;
    const inner = gh.ciForSha.bind(gh);
    const runs = new Map<string, number>();
    gh.ciForSha = async (r: string, b: string, sha: string): Promise<CiStatus> => {
      const ci = await inner(r, b, sha);
      if (ci.state !== 'success') return ci;
      if (!runs.has(sha)) {
        runs.set(sha, 100 + runs.size);
        // The base moves while the first head's run is green: the merge step must sync again.
        if (runs.size === 1) for (const cwd of world.worktrees.keys()) world.behind.set(cwd, 1);
      }
      return { ...ci, runId: runs.get(sha), url: `https://example/run/${runs.get(sha)}` };
    };
    const id = await run(store, engine, 'Base moved', finished(store));
    const fm = fmOf(store, id);
    expect(fm.status).toBe('FINISHED');
    expect(runs.size).toBe(2);
    const [, second] = [...runs.entries()];
    expect(fm.validated_by).toMatchObject({ run_id: second[1], head: second[0] });
  });
});
