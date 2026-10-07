import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ModelDef, usageGuardTrips, type RateLimitSnapshot } from '@planestro/shared';
import { DataStore } from '../src/store/DataStore.ts';
import { LiveEngine } from '../src/engine/LiveEngine.ts';
import { FakeWorld, DryRunGitPort, DryRunGhPort, DryRunProcPort, DryRunCodexPort, DryRunClaudePort } from '../src/engine/dryrun-ports.ts';
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
  const ports: Ports = { mode: 'dry-run', git: new DryRunGitPort(world), gh: new DryRunGhPort(world), proc: new DryRunProcPort(world), agents: { claude: readingClaude(opts.reading ?? {})(world), codex: new DryRunCodexPort(world) } };
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

describe('provider usage guards in the engine', () => {
  it('a Claude reading pauses only Claude, leaving Codex admissions and the global lever alone', async () => {
    const { store, engine } = await setup();
    seen(engine, snap());
    expect(engine.paused).toBe(false);
    expect(store.local.engine.provider_guards?.claude?.utilization).toBe(0.87);
    const model = ModelDef.parse({ id: 'test-codex', label: 'Codex', runner: 'codex', codex_transport: 'app-server' });
    store.updateConfig((doc) => doc.set('models', [...store.config.models, model]), 'config: add test runner');
    const a = store.createItem({ title: 'Claude plan', description: 'x' });
    const b = store.createItem({ title: 'Codex plan', description: 'x', planner: model.id, implementer: model.id });
    store.transition(a.id, 'QUEUED', 'user'); store.transition(b.id, 'QUEUED', 'user');
    await engine.start();
    await waitFor(() => store.requireItem(b.id).file.frontmatter.status === 'PLAN_READY');
    expect(store.requireItem(a.id).file.frontmatter.status).toBe('QUEUED');
  });
  it('an orchestrator wake reports the selected provider', async () => {
    const { store, engine } = await setup({ reading: { current: snap() } });
    await (engine.orchestrator as any).runWake([{ type: 'user_message', data: { text: 'hello' } }]);
    expect(store.local.engine.provider_guards?.claude).toBeDefined();
    expect(engine.paused).toBe(false);
  });
  it('global resume never dismisses the provider guard; explicit provider retry suppresses only its crossing', async () => {
    const { store, engine } = await setup();
    const r = snap(); seen(engine, r);
    engine.pause(); engine.resume();
    expect(store.local.engine.provider_guards?.claude).toBeDefined();
    engine.retryProvider('claude');
    expect(store.local.engine.provider_guards?.claude).toBeUndefined();
    seen(engine, r);
    expect(trips(store)).toHaveLength(1);
    seen(engine, snap({ resetsAt: new Date(Date.now() + 8 * HOUR).toISOString() }));
    expect(trips(store)).toHaveLength(2);
  });
  it('auto_resume releases only the due provider and preserves a user pause', async () => {
    const { store, engine, timers } = await setup();
    seen(engine, snap());
    (engine as any).usageSeen(snap(), 'codex');
    engine.pause();
    store.updateLocal({ engine: { ...store.local.engine, provider_guards: { ...store.local.engine.provider_guards, claude: { ...store.local.engine.provider_guards!.claude, resume_at: new Date(Date.now() - 1000).toISOString() } } } });
    timers.filter((t) => !t.cancelled).at(-1)!.fn();
    expect(store.local.engine.provider_guards?.claude).toBeUndefined();
    expect(store.local.engine.provider_guards?.codex).toBeDefined();
    expect(engine.paused).toBe(true);
    expect(store.local.engine.paused_by).toBe('user');
  });
  it('re-arms provider reset timers at startup', async () => {
    const first = await setup(); seen(first.engine, snap());
    const dataDir = first.dataDir;
    await first.engine.stop(); first.store.close(); engine = undefined; store = undefined;
    const again = await setup({ dataDir }); await again.engine.start();
    expect(again.engine.paused).toBe(false);
    expect(again.timers.filter((t) => !t.cancelled)).toHaveLength(1);
    expect(again.store.local.engine.provider_guards?.claude).toBeDefined();
  });
  it('default auto_resume is off and does not arm a timer', async () => {
    const { store, engine, timers } = await setup({ defaults: true });
    seen(engine, snap());
    expect(store.local.engine.provider_guards?.claude?.resume_at).toBeUndefined();
    expect(timers).toHaveLength(0);
  });
  it('disabled guards ignore readings', async () => {
    const { store, engine } = await setup({ edit: (y) => y.replace('  enabled: true\\n  threshold', '  enabled: false\\n  threshold') });
    store.updateConfig((doc) => doc.setIn(['usage_guard', 'enabled'], false), 'config: disabled usage guard');
    seen(engine, snap()); expect(trips(store)).toHaveLength(0);
  });
});
