import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DataStore } from '../src/store/DataStore.ts';
import { LiveEngine } from '../src/engine/LiveEngine.ts';
import { FakeWorld, DryRunGitPort, DryRunGhPort, DryRunProcPort, DryRunClaudePort } from '../src/engine/dryrun-ports.ts';
import { workerTools } from '../src/engine/sessions/workerTools.ts';
import { stateView } from '../src/routes/views.ts';
import type { CiStatus, Ports, TurnOptions, TurnResult, CustomTurnOptions, RunnerReport } from '../src/engine/ports.ts';
import { makeFixture, sleep } from './helpers.ts';

// #216: nobody in planestro could see the CI runners, so a sleeping self-hosted runner, a busy queue and a billing
// block looked the same; and HH-323/326/328 timed out on one sleeping Mac in the same minute, each with its own triage.

let store: DataStore | undefined; let engine: LiveEngine | undefined;
afterEach(async () => { await engine?.stop(); store?.close(); store = undefined; engine = undefined; });

async function setup(report: RunnerReport, agents: Partial<Ports['agents']['claude']> = {}) {
  const { dataDir } = makeFixture();
  const cfg = join(dataDir, 'planestro.yml');
  writeFileSync(cfg, readFileSync(cfg, 'utf8').replace(/^code_repo:\n/m, 'code_repo:\n  github: acme/repo\n'));
  delete process.env.PLANESTRO_DRYRUN_CI;
  store = await DataStore.open(dataDir, { emit: () => {} });
  const world = new FakeWorld(() => {}, { 'origin/trunk': 'f'.repeat(40) });
  world.runnerReport = report;
  const dry = new DryRunClaudePort(world);
  const claude = { runTurn: (o: TurnOptions) => dry.runTurn(o), runCustomTurn: (o: CustomTurnOptions) => dry.runCustomTurn(o), ...agents } as Ports['agents']['claude'];
  const ports: Ports = { mode: 'dry-run', git: new DryRunGitPort(world), gh: new DryRunGhPort(world), proc: new DryRunProcPort(world), agents: { claude } };
  engine = new LiveEngine(store, ports, () => {}, { sleep: async () => {}, tickMs: 50 });
  mkdirSync(join(store.codeRepoPath(), '.git', 'info'), { recursive: true });
  return { store, engine, world };
}

async function waitFor(pred: () => boolean, ms = 15_000) { const t0 = Date.now(); while (!pred()) { if (Date.now() - t0 > ms) throw new Error('timeout waiting'); await sleep(20); } }
const fmOf = (s: DataStore, id: string) => s.getItem(id)!.file.frontmatter;
const activityOf = (s: DataStore, id: string) => s.getItem(id)!.file.sections.find((x) => x.title === 'Activity')!.body;
const wakes = (s: DataStore, type: string) => s.journal.read({ type: 'orchestrator.wake' }).filter((w) => w.data?.event === type);

const MAC = ['self-hosted', 'macOS', 'hh-mac'];
const FIXTURE: RunnerReport = {
  runners: [
    { name: 'mac-mini', online: false, busy: false, labels: MAC },
    { name: 'builder-1', online: true, busy: true, labels: ['self-hosted', 'Linux', 'builder'] },
    { name: 'builder-2', online: true, busy: false, labels: ['self-hosted', 'Linux', 'builder'] },
  ],
  jobs: [
    { runId: 11, status: 'queued', labels: ['self-hosted', 'hh-mac'] },
    { runId: 12, status: 'queued', labels: ['self-hosted', 'hh-mac'] },
    { runId: 13, status: 'in_progress', labels: ['self-hosted', 'builder'], runner: 'builder-1' },
    { runId: 14, status: 'queued', labels: ['ubuntu-latest'] },
  ],
};

describe('runner status (#216)', () => {
  it('the orchestrator and a worker read online/busy/queued per label through planestro, with no permission park', async () => {
    const seen: { orchestrator?: string; worker?: string; workerTools?: string[] } = {};
    const { store, engine } = await setup(FIXTURE, {
      async runCustomTurn(o: CustomTurnOptions): Promise<TurnResult> {
        const t = o.mcpTools.find((x) => x.name === 'runner_status');
        if (t) seen.orchestrator = await t.handler({});
        await o.mcpTools.find((x) => x.name === 'done_with_wake')!.handler({ summary: 'read the runners' });
        return { sessionId: 'orch', subtype: 'success', isError: false, costUsd: 0, numTurns: 1, text: '' };
      },
      async runTurn(o: TurnOptions): Promise<TurnResult> {
        const result: TurnResult = { sessionId: 'w', subtype: 'success', isError: false, costUsd: 0, numTurns: 1, text: '' };
        seen.workerTools = workerTools(o, result).map((t) => t.name);
        seen.worker = await workerTools(o, result).find((t) => t.name === 'runners_busy')!.handler({});
        await o.tools.submit_plan('# plan');
        return { ...result, planSubmitted: '# plan' };
      },
    });
    const item = store.createItem({ title: 'Checks the runners', description: 'x' });
    store.transition(item.id, 'QUEUED', 'user');
    await engine.start();
    await waitFor(() => fmOf(store, item.id).status === 'PLAN_READY');
    (engine as any).wakeOrchestrator('user_message', undefined, { message: 'is the mac runner up?' });
    await waitFor(() => seen.orchestrator !== undefined);
    expect(seen.workerTools).toContain('runners_busy');
    expect(['permission', 'question']).not.toContain(fmOf(store, item.id).awaiting);   // it went on to its plan (awaiting plan_approval): nothing parked
    for (const text of [seen.orchestrator!, seen.worker!]) {
      expect(text).toContain('CI runners for acme/repo');
      expect(text).toMatch(/hh-mac: 1 runner, 0 online \(1 offline\), 0 busy, 0 idle; 2 jobs queued, 0 running — OFFLINE/);
      expect(text).toMatch(/builder: 2 runners, 2 online, 1 busy, 1 idle; 0 jobs queued, 1 running/);
      expect(text).toMatch(/ubuntu-latest: GitHub-hosted .*1 job queued/);
    }
  });

  it('three items timing out on one offline runner label raise one wake and one banner, not three triages; a runner back sends them to CI again', async () => {
    const report: RunnerReport = { runners: [{ name: 'mac-mini', online: false, busy: false, labels: MAC }], jobs: [] };
    const { store, engine } = await setup(report);
    store.updateConfig((doc) => { doc.setIn(['ci', 'queue_timeout_min'], 100); }, 'config: short queue timeout');
    engine.runnerStallGatherMs = 1e12;   // gather until all three have stopped
    // Each CI look moves a shared fake clock 7 min; every head's run is queued on hh-mac, with a run id of its own.
    let clock = 0; let green = false; const runs = new Map<string, number>();
    (engine as any).ciNow = () => clock;
    (engine as any).ports.gh.ciForSha = async (_r: string, branch: string, sha: string): Promise<CiStatus> => {
      clock += 7 * 60_000;
      if (!runs.has(branch)) { runs.set(branch, 100 + runs.size); report.jobs.push({ runId: runs.get(branch)!, status: 'queued', labels: ['self-hosted', 'hh-mac'] }); (engine as any).runnersAt = 0; }
      const runId = runs.get(branch)!;
      return green ? { state: 'success', runId, sha, url: `https://example/run/${runId}` } : { state: 'pending', queued: true, runId, sha, url: `https://example/run/${runId}` };
    };
    const ids = ['HH-323', 'HH-326', 'HH-328'].map((t) => { const it = store.createItem({ title: t, description: 'x' }); store.transition(it.id, 'QUEUED', 'user'); return it.id; });
    await engine.start();
    const approved = new Set<string>();
    await waitFor(() => {
      for (const id of ids) if (fmOf(store, id).status === 'PLAN_READY' && !approved.has(id)) { approved.add(id); void engine.approvePlan(id); }
      return ids.every((id) => fmOf(store, id).blocked === true);
    }, 30_000);
    for (const id of ids) {
      expect(fmOf(store, id).blocked_reason).toBe('ci_timeout');
      expect(fmOf(store, id).triage).toBeUndefined();
      expect(activityOf(store, id)).toMatch(/runner hh-mac looks stalled or offline/);
    }
    expect(wakes(store, 'blocked_ci_timeout')).toHaveLength(0);
    expect(engine.runnerStalls().map((g) => ({ label: g.label, items: [...g.items].sort() }))).toEqual([{ label: 'hh-mac', items: [...ids].sort() }]);
    expect((stateView(store, engine, null).engine as any).runner_stalls).toEqual([expect.objectContaining({ label: 'hh-mac', items: expect.arrayContaining(ids) })]);

    engine.runnerStallGatherMs = 0;
    await waitFor(() => wakes(store, 'runner_stalled').length > 0);
    await sleep(400);
    expect(wakes(store, 'runner_stalled')).toHaveLength(1);
    expect(wakes(store, 'blocked_ci_timeout')).toHaveLength(0);

    // The Mac wakes up and takes the queue: the three wait for CI again by themselves, and the banner goes.
    report.runners[0].online = true; report.jobs = []; green = true; (engine as any).runnersAt = 0;
    await waitFor(() => ids.every((id) => !fmOf(store, id).blocked));
    expect(engine.runnerStalls()).toEqual([]);
    for (const id of ids) expect(activityOf(store, id)).toMatch(/a runner for hh-mac is taking jobs again/);
    await waitFor(() => ids.every((id) => fmOf(store, id).status === 'FINISHED'), 30_000);
  });

  it('a timeout on a runner that is online and idle is triaged as before', async () => {
    const { store, engine } = await setup({ runners: [{ name: 'mac-mini', online: true, busy: false, labels: MAC }], jobs: [{ runId: 1, status: 'queued', labels: MAC }] });
    store.updateConfig((doc) => { doc.setIn(['ci', 'queue_timeout_min'], 100); }, 'config: short queue timeout');
    let clock = 0;
    (engine as any).ciNow = () => clock;
    (engine as any).ports.gh.ciForSha = async (_r: string, _b: string, sha: string): Promise<CiStatus> => { clock += 7 * 60_000; return { state: 'pending', queued: true, runId: 1, sha }; };
    const it = store.createItem({ title: 'Plain queue', description: 'x' });
    store.transition(it.id, 'QUEUED', 'user');
    await engine.start();
    await waitFor(() => fmOf(store, it.id).status === 'PLAN_READY');
    await engine.approvePlan(it.id);
    await waitFor(() => wakes(store, 'blocked_ci_timeout').length > 0);
    expect(fmOf(store, it.id).op_data?.runner_stall).toBeUndefined();
    expect(engine.runnerStalls()).toEqual([]);
  });
});
