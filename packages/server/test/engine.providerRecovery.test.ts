import { afterEach, expect, it, vi } from 'vitest';
import { ModelDef } from '@planestro/shared';
import { DataStore } from '../src/store/DataStore.ts';
import { LiveEngine } from '../src/engine/LiveEngine.ts';
import { FakeWorld, DryRunGitPort, DryRunGhPort, DryRunProcPort } from '../src/engine/dryrun-ports.ts';
import type { Ports, TurnOptions, TurnResult } from '../src/engine/ports.ts';
import { itemModelSwitchOps } from '../src/providerSwitch.ts';
import { makeFixture, sleep } from './helpers.ts';

let store: DataStore;
let engine: LiveEngine;
afterEach(async () => { await engine?.stop(); store?.close(); });
const success: TurnResult = { subtype: 'success', isError: false, costUsd: 0, numTurns: 1, text: '' };
async function until(f: () => boolean) { for (let n = 0; !f(); n++) { if (n > 300) throw new Error('not settled'); await sleep(5); } }
async function setup(run?: (o: TurnOptions) => Promise<TurnResult>) {
  const fixture = makeFixture(); store = await DataStore.open(fixture.dataDir);
  store.updateConfig((d) => {
    d.set('models', [...store.config.models, ModelDef.parse({ id: 'codex-general', label: 'Codex', runner: 'codex', codex_transport: 'app-server' }), ModelDef.parse({ id: 'outside', label: 'Outside', external: true })]);
    d.setIn(['concurrency', 'runner_limits'], { claude: 1, codex: 1 });
  }, 'config: test runners');
  const calls: TurnOptions[] = [];
  const agent = { runTurn: async (o: TurnOptions): Promise<TurnResult> => {
    calls.push(o);
    if (run) return run(o);
    await o.onQuestion([{ question: 'Review current work?' }]);
    return { ...success, parked: 'question', sessionId: 'new-session' };
  } };
  const world = new FakeWorld(() => {}, { 'origin/trunk': 'f'.repeat(40) });
  const ports: Ports = { mode: 'dry-run', git: new DryRunGitPort(world), gh: new DryRunGhPort(world), proc: new DryRunProcPort(world), agents: { claude: agent, codex: agent } };
  engine = new LiveEngine(store, ports, () => {});
  const item = (extra = {}) => {
    const i = store.createItem({ title: 'Synthetic continuation' });
    store.mutateItem(i.id, [{ set: { status: 'IN_PROGRESS', branch: 'work/synthetic', worktree: fixture.codeRepo, session_id: 'prior-session', ...extra } }], 'engine');
    return i.id;
  };
  const restart = async () => {
    await engine.stop(); store.close(); store = await DataStore.open(fixture.dataDir);
    engine = new LiveEngine(store, ports, () => {});
    await (engine as any).resumeInterrupted();
  };
  return { ...fixture, ports, calls, item, restart };
}

it.each(['pause', 'drain', 'guard'] as const)('keeps a slot-waiting CI instruction across %s and restart', async (reason) => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  let first = true;
  const ctx = await setup(async (o) => {
    if (first) { first = false; await gate; }
    await o.onQuestion([{ question: 'Review?' }]);
    return { ...success, parked: 'question' };
  });
  const a = ctx.item(), b = ctx.item();
  const active = (engine as any).runTurnFor(a, 'implement', 'first');
  await until(() => ctx.calls.length === 1);
  const waiting = (engine as any).runTurnFor(b, 'fix', 'Fix ONLY the failing parser test', ['Bash(npm test)'], ['npm test'], { fresh: 'auto' });
  await until(() => engine.sessions().some((s) => s.item === b));
  if (reason === 'pause') engine.pause();
  else if (reason === 'drain') engine.drain();
  else (engine as any).usageSeen({ status: 'rejected', window: 'five_hour', resetsAt: new Date(Date.now() + 60000).toISOString() });
  release(); await Promise.all([active, waiting]);
  expect(ctx.calls).toHaveLength(1);
  expect(store.requireItem(b).file.frontmatter.op).toBeUndefined();
  expect(store.requireItem(b).file.frontmatter.op_data?.pending_turn).toMatchObject({ phase: 'fix', prompt: 'Fix ONLY the failing parser test', oneShotCommands: ['npm test'] });
  await ctx.restart();
  if (reason === 'guard') engine.retryProvider('claude');
  engine.resume();
  await until(() => ctx.calls.length === 2);
  expect(ctx.calls[1].prompt).toContain('Fix ONLY the failing parser test');
  expect(ctx.calls[1].allowedTools).toContain('Bash(npm test)');
  await until(() => engine.sessions().length === 0);
  expect(store.requireItem(b).file.frontmatter.op_data?.pending_turn).toBeUndefined();
  expect(store.requireItem(b).file.frontmatter.op_data?.active_turn).toBeUndefined();
});

it('preserves a question answer under a provider guard and auto-resumes it exactly once', async () => {
  const ctx = await setup();
  store.updateConfig((d) => d.setIn(['usage_guard', 'auto_resume'], true), 'config: auto resume');
  const id = ctx.item({ awaiting: 'question', awaiting_data: { questions: [{ question: 'Which color?' }] } });
  (engine as any).usageSeen({ status: 'rejected', window: 'five_hour', resetsAt: new Date(Date.now() + 60000).toISOString() });
  await engine.respond(id, { kind: 'question', answers: { 'Which color?': 'Use blue, keep the border' } });
  await until(() => !(engine as any).jobs.has(id));
  expect(ctx.calls).toHaveLength(0);
  expect(store.requireItem(id).file.frontmatter.blocked).toBeUndefined();
  expect((store.requireItem(id).file.frontmatter.op_data?.pending_turn as any).prompt).toContain('Use blue, keep the border');
  await engine.message(id, 'Also preserve keyboard navigation');
  expect((store.requireItem(id).file.frontmatter.op_data?.pending_turn as any).prompt).toContain('Use blue, keep the border');
  await ctx.restart();
  store.updateLocal({ engine: { ...store.local.engine, provider_guards: { claude: { ...store.local.engine.provider_guards!.claude, resume_at: new Date(Date.now() - 1000).toISOString() } } } });
  (engine as any).guardResume();
  await until(() => ctx.calls.length === 1 && engine.sessions().length === 0);
  await engine.tick();
  expect(ctx.calls).toHaveLength(1);
  expect(ctx.calls[0].prompt).toContain('Q: Which color?\n  A: Use blue, keep the border');
  expect(ctx.calls[0].prompt).toContain('Also preserve keyboard navigation');
});

it('saves an answer while the previous process is still ending, without that process erasing it', async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  let first = true;
  const ctx = await setup(async (o) => {
    if (first) { first = false; await o.onQuestion([{ question: 'Proceed?' }]); await gate; }
    return { ...success, parked: 'question' };
  });
  const id = ctx.item();
  (engine as any).runJob(id, () => (engine as any).runTurnFor(id, 'implement', 'First instruction'));
  await until(() => store.requireItem(id).file.frontmatter.awaiting === 'question');
  engine.pause();
  await engine.respond(id, { kind: 'question', answers: { 'Proceed?': 'Keep existing changes' } });
  release(); await until(() => !(engine as any).jobs.has(id));
  expect((store.requireItem(id).file.frontmatter.op_data?.pending_turn as any).prompt).toContain('Keep existing changes');
  await ctx.restart(); engine.resume();
  await until(() => ctx.calls.length === 2);
  expect(ctx.calls[1].prompt).toContain('Keep existing changes');
});

it('refuses unusable native Codex grants without persisting a fake allow rule; denial can resume', async () => {
  const ctx = await setup();
  const id = ctx.item({ implementer: 'codex-general', awaiting: 'permission', awaiting_data: { tool: 'CodexApproval', input: { command: 'needs network', method: 'item/commandExecution/requestApproval' } } });
  const rules = store.config.permissions.allow;
  for (const decision of ['allow', 'always']) await expect(engine.respond(id, { kind: 'permission', decision })).rejects.toThrow('cannot be granted here');
  expect(store.config.permissions.allow).toEqual(rules);
  expect(store.requireItem(id).file.frontmatter.awaiting).toBe('permission');
  await engine.respond(id, { kind: 'permission', decision: 'deny', reason: 'Use the project inspection tool' });
  await until(() => ctx.calls.length === 1);
  expect(ctx.calls[0].prompt).toContain('Use the project inspection tool');
});

it.each(['rejected', 'throws', 'wrong-phase'])('quarantines a %s outbox once and surfaces recovery instead of stalling', async (mode) => {
  const ctx = await setup();
  const id = ctx.item();
  const box = { tool: 'report_done', args: { summary: 'Finished', attach: ['capture.png'], review: 'review text' }, error: 'lost connection' };
  store.mutateItem(id, [{ set: { status: mode === 'wrong-phase' ? 'PLAN_IN_PROGRESS' : 'IN_PROGRESS', op: 'implement_turn', op_data: { outbox: box } } }], 'engine');
  const report = vi.fn(async () => { if (mode === 'throws') throw new Error('validation failed'); return 'Rejected: needs a loop review'; });
  vi.spyOn(engine as any, 'makeTools').mockReturnValue({ report_done: report });
  await (engine as any).resumeInterrupted();
  await until(() => !(engine as any).jobs.has(id));
  const fm = store.requireItem(id).file.frontmatter;
  expect(fm).toMatchObject({ blocked: true, blocked_reason: 'connection_lost' });
  expect(fm.op_data?.outbox).toBeUndefined();
  expect(fm.op_data?.rejected_report).toMatchObject({ report: box });
  await (engine as any).resumeInterrupted();
  await (engine as any).ingestOutbox(id, { ...success, undelivered: box });
  expect(report).toHaveBeenCalledTimes(mode === 'wrong-phase' ? 0 : 1);
  expect(ctx.calls).toHaveLength(0);
});

it('allows external implementers through shared editing validation and the orchestrator', async () => {
  const ctx = await setup(); const a = ctx.item(), b = ctx.item();
  store.mutateItem(a, itemModelSwitchOps(store, engine, a, { implementer: 'outside' }), 'user');
  expect(store.requireItem(a).file.frontmatter.implementer).toBe('outside');
  expect(store.requireItem(a).file.frontmatter.op_data?.fresh_brief).toBeUndefined();
  expect(() => itemModelSwitchOps(store, engine, a, { planner: 'outside' })).toThrow('cannot serve as planner');
  await (engine as any).orchestratorSetsFields(b, { implementer: 'outside' });
  expect(store.requireItem(b).file.frontmatter.implementer).toBe('outside');
});

it('never merges over a deferred fix and discards its instruction on a manual takeover', async () => {
  const ctx = await setup(); const id = ctx.item({ status: 'IN_REVIEW', pr: 12, ci_result: 'green' });
  (engine as any).usageSeen({ status: 'rejected', window: 'five_hour' });
  (engine as any).queueTurn(id, 'fix', 'Fix the approved detail before merging');
  await until(() => !(engine as any).jobs.has(id));
  const fetch = vi.spyOn(ctx.ports.git, 'fetch');
  await (engine as any).mergeStep(id);
  expect(fetch).not.toHaveBeenCalled();
  await engine.takeOver(id);
  expect(store.requireItem(id).file.frontmatter.op_data?.pending_turn).toBeUndefined();
  expect(store.requireItem(id).file.frontmatter.op_data?.active_turn).toBeUndefined();
  expect(ctx.calls).toHaveLength(0);
});
