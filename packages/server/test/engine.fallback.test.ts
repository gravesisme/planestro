import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DataStore } from '../src/store/DataStore.ts';
import { LiveEngine } from '../src/engine/LiveEngine.ts';
import { FakeWorld, DryRunGitPort, DryRunGhPort, DryRunProcPort, DryRunClaudePort } from '../src/engine/dryrun-ports.ts';
import type { Ports, TurnOptions, TurnResult, CustomTurnOptions } from '../src/engine/ports.ts';
import { makeFixture, sleep } from './helpers.ts';

let store: DataStore | undefined; let engine: LiveEngine | undefined;
afterEach(async () => { await engine?.stop(); store?.close(); store = undefined; engine = undefined; });

const RESET = '2099-01-01T09:00:00.000Z';

/** A Claude port on which some models are out of usage: their turns fail the way the CLI does. */
function limitedClaude(exhausted: Set<string>, used: { item?: string; model: string; fallbackModel?: string }[]) {
  return (world: FakeWorld) => {
    const inner = new DryRunClaudePort(world);
    return {
      async runTurn(o: TurnOptions): Promise<TurnResult> {
        used.push({ item: o.itemId, model: o.model, fallbackModel: o.fallbackModel });
        if (exhausted.has(o.model)) return { sessionId: o.resume ?? `s-${o.itemId}`, subtype: 'usage_exhausted', isError: true, costUsd: 0, numTurns: 0, text: '', usageLimit: { message: 'Fable 5 requires usage credits', resetsAt: RESET }, error: 'Fable 5 requires usage credits' };
        return inner.runTurn(o);
      },
      async runCustomTurn(o: CustomTurnOptions): Promise<TurnResult> {
        used.push({ model: o.model, fallbackModel: o.fallbackModel });
        if (exhausted.has(o.model)) return { sessionId: 'orch', subtype: 'usage_exhausted', isError: true, costUsd: 0, numTurns: 0, text: '', usageLimit: { message: 'Fable 5 requires usage credits', resetsAt: RESET } };
        return inner.runCustomTurn(o);
      },
    };
  };
}

async function setup(claude: (w: FakeWorld) => Ports['agents']['claude'], edit: (yml: string) => string = (y) => y) {
  const { dataDir, codeRepo } = makeFixture();
  mkdirSync(join(codeRepo, '.git', 'info'), { recursive: true });
  const cfg = join(dataDir, 'planestro.yml');
  writeFileSync(cfg, edit(readFileSync(cfg, 'utf8')
    .replace(/^code_repo:\n/m, 'code_repo:\n  github: acme/repo\n')
    .replace('claude_model: claude-fable-5 }', 'claude_model: claude-fable-5, fallback: opus-5 }')));
  delete process.env.PLANESTRO_DRYRUN_CI;
  store = await DataStore.open(dataDir);
  const world = new FakeWorld(() => {}, { 'origin/trunk': 'f'.repeat(40) });
  const ports: Ports = { mode: 'dry-run', git: new DryRunGitPort(world), gh: new DryRunGhPort(world), proc: new DryRunProcPort(world), agents: { claude: claude(world) } };
  engine = new LiveEngine(store, ports, () => {}, { sleep: async () => {}, tickMs: 50 });
  return { store, engine };
}

async function waitFor(pred: () => boolean, ms = 5000) { const t0 = Date.now(); while (!pred()) { if (Date.now() - t0 > ms) throw new Error('timeout waiting'); await sleep(20); } }
const fm = (s: DataStore, id: string) => s.getItem(id)!.file.frontmatter;
const activity = (s: DataStore, id: string) => s.getItem(id)!.file.sections.find((x) => x.title === 'Activity')!.body;

describe('model fallback in the engine', () => {
  it('an item that allows fallback re-runs the failed turn on the fallback, and later turns skip the outage', async () => {
    const used: { item?: string; model: string; fallbackModel?: string }[] = [];
    const { store, engine } = await setup(limitedClaude(new Set(['claude-fable-5']), used));
    const a = store.createItem({ title: 'First', description: 'x', allow_model_fallback: true });
    expect(fm(store, a.id).allow_model_fallback).toBe(true);
    store.transition(a.id, 'QUEUED', 'user');
    await engine.start();
    await waitFor(() => fm(store, a.id).status === 'PLAN_READY');
    expect(used.filter((u) => u.item === a.id).map((u) => u.model)).toEqual(['claude-fable-5', 'claude-opus-5']);
    expect(used[0].fallbackModel).toBe('claude-opus-5'); // the SDK's own overload fallback rides along
    expect(activity(store, a.id)).toContain(`Fable 5 is out of usage until ${RESET}; retrying this plan turn on its fallback`);
    expect(store.local.model_unavailable?.['fable-5']).toMatchObject({ until: RESET, reason: 'Fable 5 requires usage credits' });
    expect(fm(store, a.id).blocked).toBeUndefined();

    const b = store.createItem({ title: 'Second', description: 'y', allow_model_fallback: true });
    store.transition(b.id, 'QUEUED', 'user');
    await waitFor(() => fm(store, b.id).status === 'PLAN_READY');
    expect(used.filter((u) => u.item === b.id).map((u) => u.model)).toEqual(['claude-opus-5']);
    expect(activity(store, b.id)).toContain(`Fable 5 is unavailable until ${RESET} (Fable 5 requires usage credits): this plan turn runs on Opus 5`);
  });

  it('an item that does not allow fallback blocks as usage_exhausted, and the outage is still remembered', async () => {
    const used: { item?: string; model: string }[] = [];
    const { store, engine } = await setup(limitedClaude(new Set(['claude-fable-5']), used));
    const a = store.createItem({ title: 'Strict', description: 'x' });
    expect(fm(store, a.id).allow_model_fallback).toBeUndefined();
    store.transition(a.id, 'QUEUED', 'user');
    await engine.start();
    await waitFor(() => fm(store, a.id).blocked === true);
    expect(fm(store, a.id).blocked_reason).toBe('usage_exhausted');
    expect(activity(store, a.id)).toContain('(this item does not allow a fallback model)');
    expect(used.map((u) => u.model)).toEqual(['claude-fable-5']);
    expect(store.local.model_unavailable?.['fable-5']?.until).toBe(RESET);
  });

  it('when the whole chain is out, the item blocks without spending a turn', async () => {
    const used: { item?: string; model: string }[] = [];
    const { store, engine } = await setup(limitedClaude(new Set(['claude-fable-5', 'claude-opus-5']), used));
    const a = store.createItem({ title: 'Both out', description: 'x', allow_model_fallback: true });
    store.transition(a.id, 'QUEUED', 'user');
    await engine.start();
    await waitFor(() => fm(store, a.id).blocked === true);
    expect(fm(store, a.id).blocked_reason).toBe('usage_exhausted');
    expect(used.map((u) => u.model)).toEqual(['claude-fable-5', 'claude-opus-5']);
    const b = store.createItem({ title: 'After', description: 'y', allow_model_fallback: true });
    store.transition(b.id, 'QUEUED', 'user');
    await waitFor(() => fm(store, b.id).blocked === true);
    expect(activity(store, b.id)).toContain('Fable 5, Opus 5 are all out of usage until');
    expect(used.length).toBe(2);
  });

  it('defaults.allow_model_fallback starts new items with it, and an epic hands it to its children', async () => {
    const { store, engine } = await setup(limitedClaude(new Set(), []), (y) => y.replace(/^defaults:\n/m, 'defaults:\n  allow_model_fallback: true\n'));
    expect(fm(store, store.createItem({ title: 'Defaulted', description: 'x' }).id).allow_model_fallback).toBe(true);
    expect(fm(store, store.createItem({ title: 'Opted out', description: 'x', allow_model_fallback: false }).id).allow_model_fallback).toBeUndefined();
    const epic = store.createItem({ title: 'Big thing', description: 'make it', kind: 'epic' });
    expect(fm(store, epic.id).allow_model_fallback).toBe(true);
    await engine.start();
    await engine.planEpic(epic.id);
    await waitFor(() => fm(store, epic.id).awaiting === 'breakdown_approval');
    const kids = await engine.approveBreakdown(epic.id, undefined, { queue: false });
    expect(kids.length).toBeGreaterThan(0);
    for (const k of kids) expect(fm(store, k).allow_model_fallback, k).toBe(true);
  });

  it('the orchestrator wakes on its fallback while its model is out, and retries a wake that hit the limit', async () => {
    const used: { model: string }[] = [];
    const { store, engine } = await setup(limitedClaude(new Set(['claude-fable-5']), used), (y) => y.replace('orchestrator:\n  model: claude-fable-5', 'orchestrator:\n  model: claude-fable-5\n  allow_model_fallback: true'));
    expect(engine.orchestrator.modelForWake().model).toBe('claude-fable-5');
    await (engine.orchestrator as any).runWake([{ type: 'user_message', data: { text: 'hello' } }]);
    expect(used.map((u) => u.model)).toEqual(['claude-fable-5', 'claude-opus-5']);
    expect(store.local.model_unavailable?.['fable-5']?.until).toBe(RESET);
    const pick = engine.orchestrator.modelForWake();
    expect(pick).toMatchObject({ model: 'claude-opus-5', label: 'Opus 5', fellBackFrom: 'Fable 5' });
  });

  it('without the orchestrator setting, it stays on its model', async () => {
    const { store, engine } = await setup(limitedClaude(new Set(), []));
    store.updateLocal({ model_unavailable: { 'fable-5': { until: RESET, reason: 'marked' } } });
    expect(engine.orchestrator.modelForWake()).toMatchObject({ model: 'claude-fable-5', label: 'Fable 5' });
  });
});
