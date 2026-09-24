import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { usageGuardTrips, type RateLimitSnapshot } from '@planestro/shared';
import { DataStore } from '../src/store/DataStore.ts';
import { LiveEngine } from '../src/engine/LiveEngine.ts';
import { FakeWorld, DryRunGitPort, DryRunGhPort, DryRunProcPort, DryRunClaudePort } from '../src/engine/dryrun-ports.ts';
import type { Ports, TurnOptions, TurnResult, CustomTurnOptions } from '../src/engine/ports.ts';
import { makeFixture, sleep } from './helpers.ts';

let store: DataStore | undefined; let engine: LiveEngine | undefined;
afterEach(async () => { await engine?.stop(); store?.close(); store = undefined; engine = undefined; });

const HOUR = 3_600_000;
const snap = (over: Partial<RateLimitSnapshot> = {}): RateLimitSnapshot => ({ status: 'allowed', window: 'five_hour', utilization: 0.87, resetsAt: new Date(Date.now() + 2 * HOUR).toISOString(), ...over });

/** A Claude port whose turns and wakes report `reading.current` as their rate-limit snapshot. */
function readingClaude(reading: { current?: RateLimitSnapshot }) {
  return (world: FakeWorld) => {
    const inner = new DryRunClaudePort(world);
    return {
      async runTurn(o: TurnOptions): Promise<TurnResult> { return { ...(await inner.runTurn(o)), ...(reading.current ? { rateLimit: reading.current } : {}) }; },
      async runCustomTurn(o: CustomTurnOptions): Promise<TurnResult> { return { ...(await inner.runCustomTurn(o)), ...(reading.current ? { rateLimit: reading.current } : {}) }; },
    };
  };
}

interface Timer { fn: () => void; ms: number; cancelled: boolean }

async function setup(opts: { reading?: { current?: RateLimitSnapshot }; edit?: (yml: string) => string; dataDir?: string; defaults?: boolean } = {}) {
  const dataDir = opts.dataDir ?? makeFixture().dataDir;
  if (!opts.dataDir) {
    const cfg = join(dataDir, 'planestro.yml');
    // auto_resume is opt-in (off by default); these tests opt in unless they are about the default.
    const base = readFileSync(cfg, 'utf8').replace(/^code_repo:\n/m, 'code_repo:\n  github: acme/repo\n');
    writeFileSync(cfg, (opts.edit ?? ((y) => y))(opts.defaults ? base : base.replace('auto_resume: false', 'auto_resume: true')));
  }
  delete process.env.PLANESTRO_DRYRUN_CI;
  store = await DataStore.open(dataDir);
  mkdirSync(join(store.codeRepoPath(), '.git', 'info'), { recursive: true });
  const lines: string[] = [];
  const world = new FakeWorld((l: string) => lines.push(l), { 'origin/trunk': 'f'.repeat(40) });
  const ports: Ports = { mode: 'dry-run', git: new DryRunGitPort(world), gh: new DryRunGhPort(world), proc: new DryRunProcPort(world), agents: { claude: readingClaude(opts.reading ?? {})(world) } };
  const timers: Timer[] = [];
  engine = new LiveEngine(store, ports, () => {}, { sleep: async () => {}, tickMs: 50, schedule: (fn, ms) => { const t = { fn, ms, cancelled: false }; timers.push(t); return () => { t.cancelled = true; }; } });
  return { store, engine, timers, lines, dataDir };
}

async function waitFor(pred: () => boolean, ms = 5000) { const t0 = Date.now(); while (!pred()) { if (Date.now() - t0 > ms) throw new Error('timeout waiting'); await sleep(20); } }
const trips = (s: DataStore) => s.journal.read({ type: 'usage.guard_tripped' });
const seen = (e: LiveEngine, r: RateLimitSnapshot) => (e as any).usageSeen(r);

describe('usage guard rule', () => {
  const cfg = { enabled: true, threshold: 0.85, on_warning: true, auto_resume: true };
  it('trips at the threshold, on a warning, on a rejection — not below, and not when disabled', () => {
    expect(usageGuardTrips(cfg, snap({ utilization: 0.85 }))).toBe(true);
    expect(usageGuardTrips(cfg, snap({ utilization: 0.84 }))).toBe(false);
    expect(usageGuardTrips(cfg, snap({ status: 'allowed_warning', utilization: 0.2 }))).toBe(true);
    expect(usageGuardTrips({ ...cfg, on_warning: false }, snap({ status: 'allowed_warning', utilization: 0.2 }))).toBe(false);
    expect(usageGuardTrips(cfg, snap({ status: 'rejected', utilization: undefined }))).toBe(true);
    expect(usageGuardTrips(cfg, snap({ utilization: undefined }))).toBe(false);
    expect(usageGuardTrips({ ...cfg, enabled: false }, snap({ utilization: 0.99 }))).toBe(false);
    expect(usageGuardTrips(cfg, undefined)).toBe(false);
  });
});

describe('usage guard in the engine', () => {
  it('a worker turn over the threshold pauses automation, records it, notifies and arms the resume', async () => {
    const reading = { current: snap() as RateLimitSnapshot | undefined };
    const { store, engine, timers, lines } = await setup({ reading, edit: (y) => y.replace('notifications: {}', 'notifications:\n  on_usage_pause: say "paused for usage"') });
    const a = store.createItem({ title: 'First', description: 'x' });
    store.transition(a.id, 'QUEUED', 'user');
    await engine.start();
    await waitFor(() => engine.paused);
    expect(store.local.engine).toMatchObject({ paused: true, paused_by: 'usage_guard', usage_guard: { window: 'five_hour', status: 'allowed', utilization: 0.87, resets_at: reading.current!.resetsAt } });
    const g = store.local.engine.usage_guard!;
    expect(Date.parse(g.resume_at!)).toBe(Date.parse(reading.current!.resetsAt!) + 60_000);
    expect(trips(store)).toHaveLength(1);
    expect(engine.log.some((e) => e.type === 'engine.log' && e.level === 'warn' && e.message.startsWith('USAGE GUARD: 5-hour window at 87% — automation paused until '))).toBe(true);
    await waitFor(() => lines.some((l) => l.includes('Would run `say "paused for usage"`')));
    const live = timers.filter((t) => !t.cancelled);
    expect(live).toHaveLength(1);
    expect(Math.abs(live[0].ms - (Date.parse(g.resume_at!) - Date.now()))).toBeLessThan(5000);
    // Nothing new starts while paused; the in-flight turn still finished.
    const b = store.createItem({ title: 'Second', description: 'y' });
    store.transition(b.id, 'QUEUED', 'user');
    await engine.tick();
    expect(store.getItem(b.id)!.file.frontmatter.status).toBe('QUEUED');
    expect(store.getItem(a.id)!.file.frontmatter.status).toBe('PLAN_READY');
  });

  it('an orchestrator wake reports its reading too', async () => {
    const { store, engine } = await setup({ reading: { current: snap({ status: 'allowed_warning', utilization: 0.4 }) } });
    await (engine.orchestrator as any).runWake([{ type: 'user_message', data: { text: 'hello' } }]);
    expect(engine.paused).toBe(true);
    expect(store.local.engine).toMatchObject({ paused_by: 'usage_guard', usage_guard: { status: 'allowed_warning', utilization: 0.4 } });
  });

  it('below the threshold nothing happens; a disabled guard ignores everything', async () => {
    const off = await setup({ edit: (y) => y.replace('  enabled: true\n  threshold', '  enabled: false\n  threshold') });
    expect(off.store.config.usage_guard.enabled).toBe(false);
    seen(off.engine, snap({ utilization: 0.99 }));
    seen(off.engine, snap({ status: 'rejected' }));
    expect(off.engine.paused).toBe(false);
    expect(trips(off.store)).toHaveLength(0);
    await off.engine.stop(); off.store.close(); engine = undefined; store = undefined;
    const second = await setup();
    seen(second.engine, snap({ utilization: 0.5 }));
    expect(second.engine.paused).toBe(false);
    expect(trips(second.store)).toHaveLength(0);
    seen(second.engine, snap({ status: 'allowed_warning', utilization: 0.5, window: 'seven_day' }));
    expect(second.engine.paused).toBe(true); // the warning, not the 50%
    expect(second.store.local.engine.usage_guard?.window).toBe('seven_day');
  });

  it('trips once per window crossing: a manual resume inside it holds, the next crossing trips again', async () => {
    const { store, engine, timers } = await setup();
    const first = snap();
    seen(engine, first);
    seen(engine, snap({ utilization: 0.95 }));
    expect(trips(store)).toHaveLength(1);
    engine.resume();
    expect(timers.every((t) => t.cancelled)).toBe(true);
    expect(store.local.engine.paused_by).toBeUndefined();
    expect(store.local.engine.usage_guard).toBeUndefined();
    seen(engine, snap({ utilization: 0.97, resetsAt: new Date(Date.parse(first.resetsAt!) + 30_000).toISOString() }));
    expect(engine.paused).toBe(false);
    expect(trips(store)).toHaveLength(1);
    seen(engine, snap({ resetsAt: new Date(Date.parse(first.resetsAt!) + 5 * HOUR).toISOString() }));
    expect(engine.paused).toBe(true);
    expect(trips(store)).toHaveLength(2);
  });

  it('auto-resumes when its timer fires, and a manual resume cancels the timer', async () => {
    const { store, engine, timers } = await setup();
    seen(engine, snap());
    expect(timers).toHaveLength(1);
    timers[0].fn();
    expect(engine.paused).toBe(false);
    expect(store.local.engine.paused_by).toBeUndefined();
    expect(store.journal.read({ type: 'usage.guard_resumed' })).toHaveLength(1);
    expect(engine.log.some((e) => e.type === 'engine.log' && e.message === 'automation resumed: the 5-hour usage window has reset')).toBe(true);
  });

  it('never takes over or resumes a manual pause; auto_resume off leaves the resume to you', async () => {
    const { store, engine, timers } = await setup({ edit: (y) => y.replace('auto_resume: true', 'auto_resume: false') });
    engine.pause();
    seen(engine, snap());
    expect(store.local.engine.paused_by).toBe('user');
    expect(trips(store)).toHaveLength(0);
    engine.resume();
    seen(engine, snap());
    expect(store.local.engine.paused_by).toBe('usage_guard');
    expect(store.local.engine.usage_guard?.resume_at).toBeUndefined();
    expect(timers).toHaveLength(0);
    await engine.tick();
    expect(engine.paused).toBe(true);
  });

  it('a manual pause over a guard pause becomes the user\'s and is not resumed at the reset', async () => {
    const { store, engine, timers } = await setup();
    seen(engine, snap({ resetsAt: new Date(Date.now() - 2 * 60_000).toISOString() }));
    // The reset already passed: the guard resumed at once.
    expect(engine.paused).toBe(false);
    seen(engine, snap());
    engine.pause();
    expect(timers.every((t) => t.cancelled)).toBe(true);
    expect(store.local.engine).toMatchObject({ paused: true, paused_by: 'user' });
    expect(store.local.engine.usage_guard).toBeUndefined();
    await engine.tick();
    expect(engine.paused).toBe(true);
  });

  it('a restart re-arms a pending resume from local config, or resumes one already due', async () => {
    const first = await setup();
    seen(first.engine, snap());
    const dataDir = first.dataDir;
    await first.engine.stop(); first.store.close(); engine = undefined; store = undefined;

    const again = await setup({ dataDir });
    expect(again.engine.paused).toBe(true);
    await again.engine.start();
    expect(again.engine.paused).toBe(true);
    const live = again.timers.filter((t) => !t.cancelled);
    expect(live).toHaveLength(1);
    expect(Math.abs(live[0].ms - (Date.parse(again.store.local.engine.usage_guard!.resume_at!) - Date.now()))).toBeLessThan(5000);
    again.store.updateLocal({ engine: { ...again.store.local.engine, usage_guard: { ...again.store.local.engine.usage_guard!, resume_at: new Date(Date.now() - 1000).toISOString() } } });
    await again.engine.stop(); again.store.close(); engine = undefined; store = undefined;

    const third = await setup({ dataDir });
    expect(third.engine.paused).toBe(true);
    await third.engine.start();
    expect(third.engine.paused).toBe(false);
    expect(third.store.local.engine.paused_by).toBeUndefined();
    expect(third.store.journal.read({ type: 'usage.guard_resumed' })).toHaveLength(1);
  });
  it('by default a guard pause waits for you: auto_resume is off, so no resume is armed', async () => {
    const { store, engine, timers } = await setup({ defaults: true, reading: { current: snap({ utilization: 0.9 }) } });
    expect(store.config.usage_guard.auto_resume).toBe(false);
    const a = store.createItem({ title: 'default guard', description: 'x' });
    store.transition(a.id, 'QUEUED', 'user');
    await engine.start();
    await waitFor(() => engine.paused);
    expect(store.local.engine.paused_by).toBe('usage_guard');
    expect(timers.filter((t) => !t.cancelled)).toHaveLength(0);
  });
});
