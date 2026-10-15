import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ModelDef, USAGE_TURN, type UsageTurn } from '@planestro/shared';
import { DataStore } from '../src/store/DataStore.ts';
import { LiveEngine } from '../src/engine/LiveEngine.ts';
import { FakeWorld, DryRunGitPort, DryRunGhPort, DryRunProcPort, DryRunCodexPort, DryRunClaudePort } from '../src/engine/dryrun-ports.ts';
import type { Ports, TurnOptions, TurnResult, CustomTurnOptions } from '../src/engine/ports.ts';
import { apiRoutes } from '../src/routes/api.ts';
import { makeFixture, sleep } from './helpers.ts';

let store: DataStore | undefined; let engine: LiveEngine | undefined;
afterEach(async () => { await engine?.stop(); store?.close(); store = undefined; engine = undefined; });

/** A Claude runner that reports what each turn cost, as the SDK does. */
function billingClaude(world: FakeWorld) {
  const inner = new DryRunClaudePort(world);
  return {
    async runTurn(o: TurnOptions): Promise<TurnResult> { return { ...(await inner.runTurn(o)), costUsd: o.phase === 'plan' ? 0.25 : 1.5 }; },
    async runCustomTurn(o: CustomTurnOptions): Promise<TurnResult> { return { ...(await inner.runCustomTurn(o)), costUsd: 0.1 }; },
  };
}

async function setup() {
  const { dataDir } = makeFixture();
  const cfg = join(dataDir, 'planestro.yml');
  writeFileSync(cfg, readFileSync(cfg, 'utf8').replace(/^code_repo:\n/m, 'code_repo:\n  github: acme/repo\n'));
  delete process.env.PLANESTRO_DRYRUN_CI;
  store = await DataStore.open(dataDir);
  mkdirSync(join(store.codeRepoPath(), '.git', 'info'), { recursive: true });
  const world = new FakeWorld(() => {}, { 'origin/trunk': 'f'.repeat(40) });
  const ports: Ports = { mode: 'dry-run', git: new DryRunGitPort(world), gh: new DryRunGhPort(world), proc: new DryRunProcPort(world), agents: { claude: billingClaude(world), codex: new DryRunCodexPort(world) } };
  engine = new LiveEngine(store, ports, () => {}, { sleep: async () => {}, tickMs: 50 });
  return { store, engine };
}
async function waitFor(pred: () => boolean, ms = 8000) { const t0 = Date.now(); while (!pred()) { if (Date.now() - t0 > ms) throw new Error('timeout waiting'); await sleep(20); } }
const usage = (s: DataStore) => s.journal.read({ type: USAGE_TURN });

describe('per-turn usage (#236)', () => {
  it('journals one usage.turn per planning turn, implementation turn and orchestrator wake, with provider, model, role and dollars', async () => {
    const { store, engine } = await setup();
    const item = store.createItem({ title: 'Spend me', description: 'x' });
    store.transition(item.id, 'QUEUED', 'user');
    await engine.start();
    await waitFor(() => store.requireItem(item.id).file.frontmatter.status === 'PLAN_READY');
    await engine.approvePlan(item.id);
    await waitFor(() => ['IN_REVIEW', 'MERGED', 'FINISHED'].includes(store.requireItem(item.id).file.frontmatter.status));
    const turns = usage(store).filter((e) => e.item === item.id).map((e) => e.data as unknown as UsageTurn);
    expect(turns[0]).toMatchObject({ provider: 'claude', role: 'planner', op: 'planning_turn', usd: 0.25, subtype: 'success', stage: 'planning', resumed: false });
    expect(turns[1]).toMatchObject({ provider: 'claude', role: 'worker', op: 'implement_turn', usd: 1.5, stage: 'implementation' });
    expect(turns[0].model).toBeTruthy();
    await (engine.orchestrator as any).runWake([{ type: 'user_message', data: { text: 'hello' } }, { type: 'review_stalled', item: item.id }]);
    expect(usage(store).at(-1)!.data).toMatchObject({ provider: 'claude', role: 'orchestrator', op: 'orchestrator_wake', usd: 0.1, stage: 'orchestrator', items: [item.id] });
    // The item's efficiency (#346): its turns by stage, and the wake that was about it.
    const eff = await (await apiRoutes(store, engine).request(`/items/${item.id}/efficiency`)).json();
    // The engine woke the orchestrator about it on its way too: each wake about it adds its $0.10.
    const wakes = usage(store).filter((e) => (e.data as unknown as UsageTurn).items?.includes(item.id)).length;
    expect(eff).toMatchObject({ item: item.id, turns: 2, wakes, stages: { planning: { usd: 0.25 }, implementation: { usd: 1.5 }, orchestrator: { turns: wakes } } });
    expect(eff.usd).toBeCloseTo(1.75 + wakes * 0.1, 2);
    const ranked = await (await apiRoutes(store, engine).request('/usage/items?days=7')).json();
    expect(ranked.items[0]).toMatchObject({ item: item.id, usd: eff.usd });
  });

  it('a token-accounted runner records its tokens and no dollars', async () => {
    const { store, engine } = await setup();
    const model = ModelDef.parse({ id: 'test-codex', label: 'Codex', runner: 'codex', codex_model: 'gpt-test', codex_transport: 'app-server' });
    store.updateConfig((doc) => doc.set('models', [...store.config.models, model]), 'config: add test runner');
    const item = store.createItem({ title: 'Codex plan', description: 'x', planner: model.id, implementer: model.id });
    store.transition(item.id, 'QUEUED', 'user');
    await engine.start();
    await waitFor(() => store.requireItem(item.id).file.frontmatter.status === 'PLAN_READY');
    const turn = usage(store).find((e) => e.item === item.id)!.data as unknown as UsageTurn;
    expect(turn).toMatchObject({ provider: 'codex', model: 'gpt-test', role: 'planner', tokens: 1500 });
    expect(turn.usd).toBeUndefined();
  });

  it('GET /usage reports the days, grouped by provider, model and role, with the guard crossings', async () => {
    const { store, engine } = await setup();
    const today = new Date();
    store.journal.append({ type: USAGE_TURN, item: 'TP-1', actor: 'engine', data: { provider: 'claude', model: 'opus', role: 'worker', op: 'implement_turn', usd: 2, subtype: 'success' } });
    store.journal.append({ type: USAGE_TURN, actor: 'engine', data: { provider: 'codex', model: 'gpt', role: 'orchestrator', op: 'orchestrator_wake', tokens: 900, subtype: 'success' } });
    store.journal.append({ type: 'usage.guard_tripped', actor: 'engine', data: { provider: 'claude', window: 'five_hour', status: 'allowed', utilization: 0.9 } });
    const res = await apiRoutes(store, engine).request('/usage?days=7');
    const body = await res.json();
    expect(body.days).toHaveLength(7);
    const last = body.days.at(-1);
    expect(last.day).toBe(`${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`);
    expect(last).toMatchObject({ usd: 2, tokens: 900, turns: 2 });
    expect(last.by.role).toMatchObject({ worker: { usd: 2, turns: 1 }, orchestrator: { tokens: 900, turns: 1 } });
    expect(body.events[0]).toMatchObject({ kind: 'crossing', provider: 'claude' });
    expect(body.events[0].text).toContain('90%');
  });
});
