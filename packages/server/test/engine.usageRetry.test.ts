import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DataStore } from '../src/store/DataStore.ts';
import { LiveEngine } from '../src/engine/LiveEngine.ts';
import { FakeWorld, DryRunGitPort, DryRunGhPort, DryRunProcPort } from '../src/engine/dryrun-ports.ts';
import type { Ports, TurnOptions, TurnResult, CustomTurnOptions } from '../src/engine/ports.ts';
import { makeFixture, sleep } from './helpers.ts';

/**
 * A usage stop with a known reset waits for it and is retried once (#296, HH-441): the orchestrator's retry_at_reset
 * (or the user's "Wait for the reset") persists the due time in op_data.usage_retry and the tick runs the retry; the
 * item never needs anyone meanwhile, and no process or wake sleeps until the reset.
 */
let store: DataStore | undefined; let engine: LiveEngine | undefined;
afterEach(async () => { await engine?.stop(); store?.close(); store = undefined; engine = undefined; });

type Tool = (name: string) => { handler(a: Record<string, unknown>): Promise<string> };
type Wake = { label: string; tools: Tool };
const ok: TurnResult = { sessionId: 's', subtype: 'success', isError: false, costUsd: 0, numTurns: 1, text: '' };
const HOUR = 3_600_000;
const RESET = new Date(Date.now() + 2 * HOUR).toISOString();
const exhausted = (o: TurnOptions): TurnResult => ({ ...ok, sessionId: o.resume ?? '', subtype: 'usage_exhausted', isError: true, numTurns: 0, text: '', error: "You've hit your limit", usageLimit: { message: "You've hit your limit", resetsAt: RESET } });

/** A planner that runs out of usage on the turns `out` names, else submits a plan; an orchestrator whose wakes run `orchestrate`. */
function agents(out: (n: number) => boolean, orchestrate: (w: Wake, n: number) => Promise<void>) {
  const prompts: string[] = []; const wakes: string[] = [];
  const claude: Ports['agents']['claude'] = {
    async runTurn(o: TurnOptions): Promise<TurnResult> {
      prompts.push(o.prompt);
      if (out(prompts.length)) return exhausted(o);
      await o.tools.submit_plan('# the plan');
      return { ...ok, planSubmitted: '# the plan' };
    },
    async runCustomTurn(o: CustomTurnOptions): Promise<TurnResult> {
      wakes.push(o.label);
      await orchestrate({ label: o.label, tools: ((n: string) => o.mcpTools.find((t) => t.name === n)!) as Tool }, wakes.length);
      return { ...ok, sessionId: 'orch' };
    },
  };
  return { claude, prompts, wakes };
}

async function setup(claude: Ports['agents']['claude']) {
  const { dataDir, codeRepo } = makeFixture();
  mkdirSync(join(codeRepo, '.git', 'info'), { recursive: true });
  const cfg = join(dataDir, 'planestro.yml');
  writeFileSync(cfg, readFileSync(cfg, 'utf8').replace(/^code_repo:\n/m, 'code_repo:\n  github: acme/repo\n'));
  delete process.env.PLANESTRO_DRYRUN_CI;
  store = await DataStore.open(dataDir);
  expect(store.config.usage_guard.auto_resume).toBe(false); // HH-441's setting: nothing resumes a usage stop by itself
  const world = new FakeWorld(() => {}, { 'origin/trunk': 'f'.repeat(40) });
  const ports: Ports = { mode: 'dry-run', git: new DryRunGitPort(world), gh: new DryRunGhPort(world), proc: new DryRunProcPort(world), agents: { claude } };
  engine = new LiveEngine(store, ports, () => {}, { sleep: async () => {}, tickMs: 30 });
  const item = store.createItem({ title: 'Out of usage', description: 'x' });
  store.mutateItem(item.id, [{ set: { planner: 'opus-5' } }], 'user'); // the orchestrator wakes on Fable 5, which stays in usage
  store.transition(item.id, 'QUEUED', 'user');
  return { store, engine, id: item.id };
}

async function waitFor(pred: () => boolean, ms = 10000) { const t0 = Date.now(); while (!pred()) { if (Date.now() - t0 > ms) throw new Error(`timeout waiting: ${JSON.stringify(store?.listItems().map((i) => ({ ...i.file.frontmatter, activity: i.file.sections.find((x) => x.title === 'Activity')?.body })))}`); await sleep(15); } }
const fmOf = (s: DataStore, id: string) => s.getItem(id)!.file.frontmatter;
const activityOf = (s: DataStore, id: string) => s.getItem(id)!.file.sections.find((x) => x.title === 'Activity')!.body;
const needs = (s: DataStore, id: string) => s.derived(s.getItem(id)!).needs_you;
const dueOf = (s: DataStore, id: string) => (fmOf(s, id).op_data?.usage_retry as { due_at?: string } | undefined)?.due_at;
/** The reset comes: the provider's window is over and the due time has passed (no test waits two hours). */
function resetPasses(s: DataStore, id: string): void {
  s.updateLocal({ model_unavailable: {} });
  const fm = fmOf(s, id);
  s.mutateItem(id, [{ set: { op_data: { ...fm.op_data, usage_retry: { ...(fm.op_data?.usage_retry as object), due_at: new Date(Date.now() - 1000).toISOString() } } } }], 'engine');
}

describe('a usage stop waits for its reset and is retried once (#296)', () => {
  it("from triage, retry_at_reset parks it on the recorded reset without needing anyone; the tick retries the step once", async () => {
    const replies: string[] = []; const seen: boolean[] = [];
    const a = agents((n) => n === 1, async (w, n) => { if (n === 1 && w.label === 'blocked_usage_exhausted') replies.push(await w.tools('retry_at_reset').handler({ id: 'TP-1' })); });
    const { store: s, engine: e, id } = await setup(a.claude);
    await e.start();
    await waitFor(() => dueOf(s, id) !== undefined);
    expect(replies[0]).toMatch(/retries once/);
    const f = fmOf(s, id);
    expect(f.blocked_reason).toBe('usage_exhausted');
    expect(f.triage).toBeUndefined();
    // A minute past the reset the provider reported, as the usage guard resumes.
    expect(dueOf(s, id)).toBe(new Date(Date.parse(RESET) + 60_000).toISOString());
    seen.push(needs(s, id));
    await e.tick(); await sleep(100);
    expect(a.prompts).toHaveLength(1); // nothing runs before the reset
    expect(activityOf(s, id)).not.toContain('needs you');

    resetPasses(s, id);
    await waitFor(() => fmOf(s, id).status === 'PLAN_READY');
    expect(seen).toEqual([false]);
    expect(a.prompts).toHaveLength(2);
    expect(a.wakes.filter((w) => w.startsWith('blocked_'))).toEqual(['blocked_usage_exhausted']);
    expect(activityOf(s, id)).toMatch(/waits for Opus 5's usage to reset/);
    expect(activityOf(s, id)).toMatch(/usage reset/);
  });

  it('a second exhaustion stops as before: triaged again, and never a second retry by itself', async () => {
    const replies: string[] = [];
    const a = agents(() => true, async (w) => { replies.push(await w.tools('retry_at_reset').handler({ id: 'TP-1' })); });
    const { store: s, engine: e, id } = await setup(a.claude);
    await e.start();
    await waitFor(() => dueOf(s, id) !== undefined);
    resetPasses(s, id);
    await waitFor(() => a.prompts.length === 2 && fmOf(s, id).blocked === true && !fmOf(s, id).triage && a.wakes.length === 2);
    expect(fmOf(s, id).blocked_reason).toBe('usage_exhausted');
    expect(dueOf(s, id)).toBeUndefined();
    expect(needs(s, id)).toBe(true);
    expect(replies[1]).toMatch(/^not possible: TP-1 was already retried once at a reset/);
    await e.tick(); await sleep(100);
    expect(a.prompts).toHaveLength(2);
  });

  it('a later `at` is kept, an earlier one waits for the recorded reset, and only a usage stop can wait', async () => {
    const replies: string[] = [];
    const later = new Date(Date.parse(RESET) + 5 * HOUR).toISOString();
    const a = agents((n) => n === 1, async (w, n) => {
      if (n !== 1) return;
      const t = w.tools('retry_at_reset');
      replies.push(await t.handler({ id: 'TP-1', at: 'tomorrow-ish' }));
      replies.push(await t.handler({ id: 'TP-1', at: new Date(Date.now() + 60_000).toISOString() }));
      replies.push(await t.handler({ id: 'TP-1', at: later }));
    });
    const { store: s, engine: e, id } = await setup(a.claude);
    await e.start();
    await waitFor(() => replies.length === 3);
    expect(replies[0]).toMatch(/^not recorded/);
    expect(replies[1]).toContain(new Date(Date.parse(RESET) + 60_000).toISOString());
    expect(replies[2]).toContain(later);
    expect(dueOf(s, id)).toBe(later);

    const other = s.createItem({ title: 'Blocked for something else', description: 'x' });
    s.mutateItem(other.id, [{ set: { status: 'IN_PROGRESS', blocked: true, blocked_reason: 'agent_blocked', awaiting: 'user' } }], 'engine');
    expect(await e.retryAtReset(other.id, undefined, 'orchestrator')).toMatch(/^not possible: .* is not stopped for usage/);
  });
});
