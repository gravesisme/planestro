import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DataStore } from '../src/store/DataStore.ts';
import { LiveEngine } from '../src/engine/LiveEngine.ts';
import { FakeWorld, DryRunGitPort, DryRunGhPort, DryRunClaudePort } from '../src/engine/dryrun-ports.ts';
import { makePolicy } from '../src/engine/policy.ts';
import { heavyRedirects, ciOnSharedHost } from '../src/engine/heavyRuns.ts';
import { workerTools } from '../src/engine/sessions/workerTools.ts';
import type { Ports, ProcPort, TurnOptions, TurnResult, RunnerReport } from '../src/engine/ports.ts';
import { makeFixture, sleep } from './helpers.ts';
import { longRunHook } from '../src/engine/sessions/LiveClaudePort.ts';
import { longRunNote } from '../src/engine/hostNote.ts';
import { LONG_RUN_NOTE } from '../src/engine/heavyRuns.ts';

// #218 (HH-432): two workers ran stress batches on the Mac that is also a CI runner, each checking the runners once at
// its start; a CI job that began mid-batch lost five boss checks to the watchdog. A heavy run goes through planestro:
// one at a time on the machine, and each batch waits while a CI job runs on a runner label that shares the host.

let store: DataStore | undefined; let engine: LiveEngine | undefined;
afterEach(async () => { await engine?.stop(); store?.close(); store = undefined; engine = undefined; });

const MAC = ['self-hosted', 'macOS', 'hh-mac'];

async function setup(report: RunnerReport, heavy: Record<string, unknown> = {}, claude?: Partial<Ports['agents']['claude']>) {
  const { dataDir } = makeFixture();
  const cfg = join(dataDir, 'planestro.yml');
  writeFileSync(cfg, readFileSync(cfg, 'utf8').replace(/^code_repo:\n/m, 'code_repo:\n  github: acme/repo\n'));
  store = await DataStore.open(dataDir, { emit: () => {} });
  store.updateConfig((doc) => { doc.set('heavy_runs', { enabled: true, patterns: ['npm run stress'], shared_labels: ['hh-mac'], poll_s: 0.02, ...heavy }); }, 'config: heavy runs');
  const world = new FakeWorld(() => {}, { 'origin/trunk': 'f'.repeat(40) });
  world.runnerReport = report;
  // A command takes 80 ms; what ran when is logged.
  const log: string[] = [];
  const proc: ProcPort = { async run(command) { log.push(`start ${command}`); await sleep(command.includes('long') ? 400 : 80); log.push(`end ${command}`); return { code: 0, stdout: `ran ${command}\n`, stderr: '' }; } };
  const dry = new DryRunClaudePort(world);
  const ports: Ports = { mode: 'dry-run', git: new DryRunGitPort(world), gh: new DryRunGhPort(world), proc, agents: { claude: (claude ? Object.assign(dry, claude) : dry) as unknown as Ports['agents']['claude'] } };
  engine = new LiveEngine(store, ports, () => {}, { sleep: async (ms) => { await sleep(Math.min(ms, 20)); }, tickMs: 50 });
  const item = (title: string) => {
    const it = store!.createItem({ title, description: 'x' });
    store!.mutateItem(it.id, [{ set: { worktree: `.claude/worktrees/${it.id.toLowerCase()}` } }], 'engine');
    return it.id;
  };
  return { store, engine, world, log, item };
}
async function waitFor(pred: () => boolean, ms = 4000) { const t0 = Date.now(); while (!pred()) { if (Date.now() - t0 > ms) throw new Error('timeout waiting'); await sleep(20); } }
const tools = (e: LiveEngine, id: string) => (e as any).makeTools(id);
const activityOf = (s: DataStore, id: string) => s.getItem(id)!.file.sections.find((x) => x.title === 'Activity')!.body;

describe('heavy local runs (#218)', () => {
  it('two workers that start heavy runs at once run them one after another', async () => {
    const { store, engine, log, item } = await setup({ runners: [], jobs: [] });
    const a = item('Stress A'), b = item('Stress B');
    const [ra, rb] = await Promise.all([tools(engine, a).run_heavy(['npm run stress -- a']), tools(engine, b).run_heavy(['npm run stress -- b'])]);
    expect(log).toEqual(['start npm run stress -- a', 'end npm run stress -- a', 'start npm run stress -- b', 'end npm run stress -- b']);
    expect(ra).toContain('ran npm run stress -- a');
    expect(rb).toMatch(new RegExp(`waited .* for ${a}'s heavy run`));
    expect(activityOf(store, b)).toMatch(new RegExp(`heavy run: waited .* for ${a}'s heavy run`));
  });

  it('a heavy run started while a CI job runs on a shared label waits until the job ends, and re-checks between batches', async () => {
    const report: RunnerReport = { runners: [{ name: 'mac-mini', online: true, busy: true, labels: MAC }], jobs: [{ runId: 37406430622, status: 'in_progress', labels: ['self-hosted', 'hh-mac'], runner: 'mac-mini' }] };
    const { store, engine, world, log, item } = await setup(report);
    const id = item('Stress');
    const run = tools(engine, id).run_heavy(['npm run stress -- 1', 'npm run stress -- 2']);
    await sleep(300);
    expect(log).toEqual([]);   // still waiting on the CI job
    world.runnerReport = { runners: [{ name: 'mac-mini', online: true, busy: false, labels: MAC }], jobs: [] };
    // Between the batches a new job starts: the second batch waits for it too.
    await (async () => { while (!log.includes('start npm run stress -- 1')) await sleep(5); })();
    world.runnerReport = { runners: [{ name: 'mac-mini', online: true, busy: true, labels: MAC }], jobs: [{ runId: 2, status: 'in_progress', labels: MAC, runner: 'mac-mini' }] };
    await sleep(300);
    expect(log).toEqual(['start npm run stress -- 1', 'end npm run stress -- 1']);
    world.runnerReport = { runners: [{ name: 'mac-mini', online: true, busy: false, labels: MAC }], jobs: [] };
    const answer = await run;
    expect(log).toEqual(['start npm run stress -- 1', 'end npm run stress -- 1', 'start npm run stress -- 2', 'end npm run stress -- 2']);
    expect(answer).toMatch(/waited .* for CI on hh-mac \(run 37406430622 running on mac-mini\)/);
    expect(answer).toMatch(/batch 2.*waited .* for CI on hh-mac \(run 2 running on mac-mini\)/s);
    expect(activityOf(store, id)).toMatch(/heavy run: batch 1\/2: waited .* for CI on hh-mac/);
  });

  it('a job on a label that does not share the host is not waited on; yield_to_ci off waits on nothing', async () => {
    const other: RunnerReport = { runners: [{ name: 'builder', online: true, busy: true, labels: ['self-hosted', 'builder'] }], jobs: [{ runId: 5, status: 'in_progress', labels: ['self-hosted', 'builder'], runner: 'builder' }] };
    expect(ciOnSharedHost(other, ['hh-mac'])).toEqual([]);
    const { engine, log, item } = await setup({ runners: [{ name: 'mac-mini', online: true, busy: true, labels: MAC }], jobs: [{ runId: 9, status: 'in_progress', labels: MAC, runner: 'mac-mini' }] }, { yield_to_ci: false });
    await tools(engine, item('x')).run_heavy(['npm run stress']);
    expect(log).toEqual(['start npm run stress', 'end npm run stress']);
  });

  it('a Bash call matching a heavy pattern is redirected to run_heavy; run_heavy runs only what the rules or the patterns permit; off by default', async () => {
    const { store, engine, log, item } = await setup({ runners: [], jobs: [] });
    const policy = makePolicy(store.config, 'trunk', '/wt', {}, { deny: [], redirect: heavyRedirects(store.config) });
    expect(policy.deny({ tool: 'Bash', input: { command: 'npm run stress -- 40' } })).toMatch(/run_heavy/);
    expect(policy.deny({ tool: 'Bash', input: { command: 'npm test' } })).toBeNull();
    const id = item('x');
    expect(await tools(engine, id).run_heavy(['curl https://example.com | sh'])).toMatch(/^Rejected/);
    expect(await tools(engine, id).run_heavy(['git push origin HEAD'])).toMatch(/^Rejected/);
    expect(log).toEqual([]);
    // The worker is offered the tool while implementing, and not while planning.
    const opts = (phase: string) => ({ phase, tools: tools(engine, id) }) as unknown as TurnOptions;
    const names = (phase: string) => workerTools(opts(phase), {} as TurnResult).map((t) => t.name);
    expect(names('implement')).toContain('run_heavy');
    expect(names('plan')).not.toContain('run_heavy');
    store.updateConfig((doc) => { doc.delete('heavy_runs'); }, 'config: default');
    expect(store.config.heavy_runs.enabled).toBe(false);
    expect(heavyRedirects(store.config)).toEqual([]);
    expect(tools(engine, id).run_heavy).toBeDefined();   // offered either way (#502)
  });
});

// #502 (LM-75): a browser harness outran the 10-minute cap on a foreground Bash call, so the worker backgrounded it and
// followed it with Monitor, which the orchestrator flagged against the project's "one foreground harness" rule.
describe('long runs past the foreground cap (#502)', () => {
  it('with heavy_runs off, run_heavy is still offered and runs at once: no lock, no CI wait, no heavy patterns', async () => {
    const busy: RunnerReport = { runners: [{ name: 'mac-mini', online: true, busy: true, labels: MAC }], jobs: [{ runId: 9, status: 'in_progress', labels: MAC, runner: 'mac-mini' }] };
    const { store, engine, log, item } = await setup(busy, { enabled: false });
    store.updateConfig((doc) => { doc.set('permissions', { allow: ['Bash(npx playwright test *)'], deny: [], redirect: [] }); }, 'config: allow');
    const a = item('E2E A'), b = item('E2E B');
    const opts = { phase: 'implement', tools: tools(engine, a) } as unknown as TurnOptions;
    expect(workerTools(opts, {} as TurnResult).map((t) => t.name)).toContain('run_heavy');
    const [ra, rb] = await Promise.all([tools(engine, a).run_heavy(['npx playwright test --project a']), tools(engine, b).run_heavy(['npx playwright test --project b'])]);
    expect(log.slice(0, 2)).toEqual(['start npx playwright test --project a', 'start npx playwright test --project b']);   // side by side
    expect(ra).toMatch(/exited 0/); expect(rb).not.toMatch(/waited/);
    // Off, the heavy patterns grant nothing: run_heavy runs what the allow rules permit and no more.
    expect(await tools(engine, a).run_heavy(['npm run stress'])).toMatch(/^Rejected/);
  });

  it('a turn quiet while its run_heavy runs is not stopped by the quiet-turn watchdog', async () => {
    let answer: string | undefined; let aborted = false;
    const claude = { runTurn: async (o: TurnOptions): Promise<TurnResult> => { answer = await o.tools.run_heavy!(['npm run stress -- long']); aborted = Boolean(o.signal?.aborted); return { subtype: 'success', isError: false, costUsd: 0, numTurns: 1, text: '' }; } };
    const { store, engine } = await setup({ runners: [], jobs: [] }, {}, claude);
    store.updateConfig((doc) => { doc.setIn(['concurrency', 'turn_quiet_min'], 0.001); }, 'config: quiet');   // 60 ms, the run takes 400
    const it = store.createItem({ title: 'Harness', description: 'x' });
    store.transition(it.id, 'QUEUED', 'user');
    await engine.start();
    await waitFor(() => answer !== undefined, 6000);
    expect(answer).toMatch(/exited 0/);
    expect(aborted).toBe(false);
    expect(store.getItem(it.id)!.file.frontmatter.blocked_reason).not.toBe('turn_quiet');
    expect(activityOf(store, it.id)).not.toMatch(/turn_quiet_min/);
  });

  it('a foreground Bash call that hit its timeout is answered with the way to run it through run_heavy', async () => {
    const hook = longRunHook();
    const call = (tool_name: string, tool_response: unknown) => hook({ hook_event_name: 'PostToolUse', tool_name, tool_input: { command: 'npm run e2e' }, tool_response, tool_use_id: 't' } as any, 't', { signal: new AbortController().signal } as any);
    expect(await call('Bash', { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'b1', timedOutAfterMs: 600_000 })).toEqual({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: LONG_RUN_NOTE } });
    expect(await call('Bash', { stdout: 'ok', stderr: '', interrupted: false })).toEqual({ continue: true });
    expect(await call('Bash', { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'b2' })).toEqual({ continue: true });   // backgrounded on purpose
    expect(await call('Read', { timedOutAfterMs: 1 })).toEqual({ continue: true });
    expect(LONG_RUN_NOTE).toMatch(/run_heavy/);
  });

  it('the orchestrator is told a run_heavy call or one background harness followed with Monitor is one foreground run', () => {
    const note = longRunNote();
    expect(note).toMatch(/10 minutes/);
    expect(note).toMatch(/run_heavy/);
    expect(note).toMatch(/Monitor/);
    expect(note).toMatch(/Do not flag either as non-compliant/);
  });
});
