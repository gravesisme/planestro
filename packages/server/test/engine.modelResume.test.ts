import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DataStore } from '../src/store/DataStore.ts';
import { LiveEngine } from '../src/engine/LiveEngine.ts';
import { FakeWorld, DryRunGitPort, DryRunGhPort, DryRunProcPort, DryRunClaudePort } from '../src/engine/dryrun-ports.ts';
import type { Ports } from '../src/engine/ports.ts';
import { makeFixture } from './helpers.ts';

let store: DataStore | undefined; let engine: LiveEngine | undefined;
afterEach(async () => { await engine?.stop(); store?.close(); store = undefined; engine = undefined; });

const HOUR = 3_600_000;
interface Timer { fn: () => void; ms: number; cancelled: boolean }

// The fixture's models: fable-5 (falls back to opus-5) and opus-5; planner fable-5, implementer opus-5.
async function setup(opts: { dataDir?: string; autoResume?: boolean } = {}) {
  const dataDir = opts.dataDir ?? makeFixture().dataDir;
  if (!opts.dataDir) {
    const cfg = join(dataDir, 'planestro.yml');
    const base = readFileSync(cfg, 'utf8').replace(/^code_repo:\n/m, 'code_repo:\n  github: acme/repo\n');
    writeFileSync(cfg, opts.autoResume === false ? base : base.replace('auto_resume: false', 'auto_resume: true'));
  }
  delete process.env.PLANESTRO_DRYRUN_CI;
  store = await DataStore.open(dataDir);
  mkdirSync(join(store.codeRepoPath(), '.git', 'info'), { recursive: true });
  const world = new FakeWorld(() => {}, { 'origin/trunk': 'f'.repeat(40) });
  const ports: Ports = { mode: 'dry-run', git: new DryRunGitPort(world), gh: new DryRunGhPort(world), proc: new DryRunProcPort(world), agents: { claude: new DryRunClaudePort(world) } };
  const timers: Timer[] = [];
  engine = new LiveEngine(store, ports, () => {}, { sleep: async () => {}, tickMs: 60_000, schedule: (fn, ms) => { const t = { fn, ms, cancelled: false }; timers.push(t); return () => { t.cancelled = true; }; } });
  return { store, engine, timers, dataDir };
}

const fm = (s: DataStore, id: string) => s.requireItem(id).file.frontmatter;
const activity = (s: DataStore, id: string) => s.requireItem(id).file.sections.find((x) => x.title === 'Activity')!.body;
const live = (timers: Timer[]) => timers.filter((t) => !t.cancelled);
const outage = (ms: number) => ({ until: new Date(Date.now() + ms).toISOString(), reason: 'usage limit', since: new Date().toISOString() });

/** An item stopped in `status` with `reason`, as a turn would have left it. */
function stopped(s: DataStore, title: string, set: Record<string, unknown>, reason = 'usage_exhausted'): string {
  const item = s.createItem({ title, description: 'x' });
  s.mutateItem(item.id, [{ set: { status: 'IN_PROGRESS', branch: `tp/${item.id}`, worktree: `.claude/worktrees/${item.id}`, blocked: true, blocked_reason: reason, awaiting: 'user', ...set } }], 'engine');
  return item.id;
}

describe('a model outage that ends unblocks its usage_exhausted items (#244)', () => {
  it('moves only the items of the model whose entry expired, once', async () => {
    const { store, engine, timers } = await setup();
    const opus = stopped(store, 'On opus', { implementer: 'opus-5' });
    const fable = stopped(store, 'On fable, no fallback', { implementer: 'fable-5' });
    const viaFallback = stopped(store, 'On fable, falls back to opus', { implementer: 'fable-5', allow_model_fallback: true });
    const planning = stopped(store, 'Planning on fable', { status: 'PLAN_IN_PROGRESS', planner: 'fable-5', implementer: 'opus-5' });
    const other = stopped(store, 'Blocked for something else', { implementer: 'opus-5' }, 'agent_blocked');
    const held = stopped(store, 'Held', { implementer: 'opus-5', skip_merge: true, hold_reason: 'the user' });
    const mine = stopped(store, 'Taken over', { implementer: 'opus-5', taken_over: { since: new Date().toISOString() } });
    store.updateLocal({ model_unavailable: { 'opus-5': outage(HOUR), 'fable-5': outage(5 * HOUR) } });

    (engine as any).armModelResume();
    expect(live(timers)).toHaveLength(1);
    expect(live(timers)[0].ms).toBeGreaterThan(HOUR - 60_000);
    expect(live(timers)[0].ms).toBeLessThanOrEqual(HOUR);

    // Opus's window resets; fable's has not.
    store.updateLocal({ model_unavailable: { ...store.local.model_unavailable, 'opus-5': outage(-1000) } });
    const timer = live(timers)[0]; timer.fn(); timer.cancelled = true; // fired

    for (const id of [opus, viaFallback]) {
      expect(fm(store, id).blocked).toBeUndefined();
      expect(fm(store, id).blocked_reason).toBeUndefined();
      expect(fm(store, id).awaiting).toBeUndefined();
      expect(activity(store, id)).toContain('unblocked: Opus 5 usage window reset');
    }
    for (const id of [fable, planning, held, mine]) expect(fm(store, id).blocked_reason).toBe('usage_exhausted');
    expect(fm(store, other).blocked_reason).toBe('agent_blocked');
    expect(store.local.model_unavailable?.['opus-5']).toBeUndefined();
    expect(store.local.model_unavailable?.['fable-5']).toBeDefined();
    // The next expiry, fable's, is armed.
    expect(live(timers)).toHaveLength(1);
    expect(live(timers)[0].ms).toBeGreaterThan(4 * HOUR);

    // At most once: the same expiry firing again (a stale timer, a tick) unblocks nothing that stopped since.
    store.mutateItem(opus, [{ set: { blocked: true, blocked_reason: 'usage_exhausted' } }], 'engine');
    timer.fn(); await engine.tick();
    expect(fm(store, opus).blocked_reason).toBe('usage_exhausted');
    expect(activity(store, viaFallback).match(/usage window reset/g)).toHaveLength(1);
  });

  it('a restart before the expiry re-arms it from the persisted entry, and one that passed while down unblocks at startup', async () => {
    const first = await setup();
    const id = stopped(first.store, 'On opus', { implementer: 'opus-5' });
    const other = stopped(first.store, 'On fable', { implementer: 'fable-5' });
    first.store.updateLocal({ model_unavailable: { 'opus-5': outage(HOUR), 'fable-5': outage(2 * HOUR) } });
    const dataDir = first.dataDir;
    await first.engine.stop(); first.store.close(); engine = undefined; store = undefined;

    const again = await setup({ dataDir });
    (again.engine as any).armModelResume(); // what start() does
    expect(live(again.timers)).toHaveLength(1);
    expect(live(again.timers)[0].ms).toBeGreaterThan(HOUR - 60_000);
    again.store.updateLocal({ model_unavailable: { ...again.store.local.model_unavailable, 'opus-5': outage(-1000) } });
    const fired = live(again.timers)[0]; fired.fn(); fired.cancelled = true;
    expect(fm(again.store, id).blocked).toBeUndefined();
    expect(fm(again.store, other).blocked_reason).toBe('usage_exhausted');

    // Fable's window resets while planestro is down: the next start unblocks it at once.
    again.store.updateLocal({ model_unavailable: { 'fable-5': outage(-1000) } });
    await again.engine.stop(); again.store.close(); engine = undefined; store = undefined;
    const third = await setup({ dataDir });
    (third.engine as any).armModelResume();
    expect(fm(third.store, other).blocked).toBeUndefined();
    expect(activity(third.store, other)).toContain('unblocked: Fable 5 usage window reset');
    expect(third.store.local.model_unavailable ?? {}).toEqual({});
  });

  it('does nothing without usage_guard.auto_resume', async () => {
    const { store, engine, timers } = await setup({ autoResume: false });
    const id = stopped(store, 'On opus', { implementer: 'opus-5' });
    store.updateLocal({ model_unavailable: { 'opus-5': outage(-1000) } });
    (engine as any).armModelResume(); await engine.tick();
    expect(timers).toHaveLength(0);
    expect(fm(store, id).blocked_reason).toBe('usage_exhausted');
  });

  it('a recorded outage arms its own expiry', async () => {
    const { engine, timers } = await setup();
    engine.recordUnavailable({ id: 'opus-5', label: 'Opus 5' }, { message: 'limit', resetsAt: new Date(Date.now() + 3 * HOUR).toISOString() });
    expect(live(timers)).toHaveLength(1);
    expect(live(timers)[0].ms).toBeGreaterThan(3 * HOUR - 60_000);
  });
});
