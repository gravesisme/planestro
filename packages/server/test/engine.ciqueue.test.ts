import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DataStore } from '../src/store/DataStore.ts';
import { LiveEngine } from '../src/engine/LiveEngine.ts';
import { FakeWorld, DryRunGitPort, DryRunGhPort, DryRunProcPort, DryRunClaudePort } from '../src/engine/dryrun-ports.ts';
import { ciFromRuns } from '../src/engine/live-ports.ts';
import type { CiStatus, Ports } from '../src/engine/ports.ts';
import { makeFixture, sleep } from './helpers.ts';

// #170: time queued for a runner is a queue, not a CI failure. On Oct 1 (HH) four healthy items
// blocked ci_timeout behind a 3-5 h self-hosted runner queue, and the orchestrator read it as a dead runner.

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

/** Each CI look moves a fake clock 7 min and answers from `script` (its last state repeats). */
function scriptCi(e: LiveEngine, script: Array<'queued' | 'running' | 'success'>) {
  let clock = 0; let look = 0;
  (e as any).ciNow = () => clock;
  (e as any).ports.gh.ciForSha = async (_r: string, _b: string, sha: string): Promise<CiStatus> => {
    clock += 7 * 60_000;
    const st = script[Math.min(look++, script.length - 1)];
    if (st === 'success') return { state: 'success', runId: 1, sha, url: 'https://example/run/1' };
    return { state: 'pending', runId: 1, sha, url: 'https://example/run/1', ...(st === 'queued' ? { queued: true } : {}) };
  };
}

async function toCi(s: DataStore, e: LiveEngine, title: string) {
  const item = s.createItem({ title, description: 'x' });
  s.transition(item.id, 'QUEUED', 'user');
  await e.start();
  await waitFor(() => fmOf(s, item.id).status === 'PLAN_READY');
  await e.approvePlan(item.id);
  return item.id;
}

describe('CI queue time is not CI failure (#170)', () => {
  it('a run queued far past ci.timeout_min, then started, merges: queued time is not counted', async () => {
    const { store, engine } = await setup();
    scriptCi(engine, [...Array(12).fill('queued'), 'running', 'success']);   // 84 min queued against a 45-min timeout
    const id = await toCi(store, engine, 'Long queue');
    await waitFor(() => fmOf(store, id).status === 'FINISHED' || fmOf(store, id).blocked === true);
    expect(fmOf(store, id).blocked_reason).toBeUndefined();
    expect(fmOf(store, id).status).toBe('FINISHED');
    expect(activityOf(store, id)).toMatch(/has waited \d+ min for a runner; it is queued, not failing/);
  });

  it('a run that has started still times out on ci.timeout_min, counted from its start', async () => {
    const { store, engine } = await setup();
    scriptCi(engine, [...Array(5).fill('queued'), 'running']);   // starts after 35 min queued, then runs forever
    const id = await toCi(store, engine, 'Hung run');
    await waitFor(() => fmOf(store, id).blocked === true);
    expect(fmOf(store, id).blocked_reason).toBe('ci_timeout');
    expect(activityOf(store, id)).toMatch(/ran longer than 45 min after a runner started it/);
  });

  it('a run that never leaves the queue blocks after ci.queue_timeout_min, named as a queue', async () => {
    const { store, engine } = await setup();
    store.updateConfig((doc) => { doc.setIn(['ci', 'queue_timeout_min'], 100); }, 'config: short queue timeout');
    scriptCi(engine, ['queued']);
    const id = await toCi(store, engine, 'Never starts');
    await waitFor(() => fmOf(store, id).blocked === true);
    expect(fmOf(store, id).blocked_reason).toBe('ci_timeout');
    expect(activityOf(store, id)).toMatch(/waited 100 min for a runner and never started.*A queue, not a failure/);
  });

  it('ci.max_queued_runs holds new starts while the queue is deep, and releases them when it drains', async () => {
    const { store, engine } = await setup();
    store.updateConfig((doc) => { doc.setIn(['ci', 'max_queued_runs'], 2); }, 'config: admission control');
    let queued = 3;
    (engine as any).ports.gh.ciQueue = async () => ({ queued, running: 1 });
    const item = store.createItem({ title: 'Waits for the queue', description: 'x' });
    store.transition(item.id, 'QUEUED', 'user');
    await engine.start();
    await waitFor(() => engine!.log.some((e: any) => /holding new starts: 3 CI runs are queued/.test(JSON.stringify(e))));
    await sleep(300);
    expect(fmOf(store, item.id).status).toBe('QUEUED');
    expect(engine.ciQueue).toEqual({ queued: 3, running: 1 });
    queued = 0; (engine as any).ciQueueAt = 0;   // the next tick reads the drained queue
    await waitFor(() => fmOf(store, item.id).status === 'PLAN_READY');
    expect(engine.log.some((e: any) => /starting new items again/.test(JSON.stringify(e)))).toBe(true);
  });

  it('ci.max_queued_runs 0 (the default) never holds a start', async () => {
    const { store, engine } = await setup();
    (engine as any).ports.gh.ciQueue = async () => ({ queued: 50, running: 2 });
    const item = store.createItem({ title: 'No cap', description: 'x' });
    store.transition(item.id, 'QUEUED', 'user');
    await engine.start();
    await waitFor(() => fmOf(store, item.id).status === 'PLAN_READY');
  });

  it('ciFromRuns marks a run no runner has picked up as queued, and a started one as not', () => {
    const run = (status: string, conclusion: string | null = null) => ({ databaseId: 7, url: 'u', headSha: 's', createdAt: 't', status, conclusion });
    for (const s of ['queued', 'waiting', 'requested', 'pending']) expect(ciFromRuns([run(s)], 's')).toMatchObject({ state: 'pending', queued: true });
    expect(ciFromRuns([run('in_progress')], 's').queued).toBeUndefined();
    expect(ciFromRuns([run('completed', 'success')], 's')).toMatchObject({ state: 'success' });
  });
});
