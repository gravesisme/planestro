import { describe, it, expect, afterEach } from 'vitest';
import type { JournalEntry } from '@planestro/shared';
import { DataStore, type ItemOp } from '../src/store/DataStore.ts';
import { LiveEngine } from '../src/engine/LiveEngine.ts';
import { SETTLE_MS } from '../src/engine/needsYou.ts';
import { FakeWorld, DryRunGitPort, DryRunGhPort, DryRunProcPort, DryRunClaudePort } from '../src/engine/dryrun-ports.ts';
import type { Ports } from '../src/engine/ports.ts';
import { listenUrl } from '../src/server.ts';
import { makeFixture } from './helpers.ts';

let store: DataStore | undefined;
afterEach(() => { store?.close(); store = undefined; });

/** A store whose events reach the engine (as server.ts wires them), on a clock and timers the test moves by hand. */
async function setup() {
  const { dataDir } = makeFixture();
  let engine: LiveEngine | undefined;
  store = await DataStore.open(dataDir, { emit: (e) => engine?.observe(e) });
  let t = Date.parse('2026-10-07T12:00:00Z');
  let timers: { at: number; fn: () => void }[] = [];
  const runs: { command: string; env?: Record<string, string> }[] = [];
  const world = new FakeWorld(() => {}, { 'origin/trunk': 'f'.repeat(40) });
  const proc = new DryRunProcPort(world); const inner = proc.run.bind(proc);
  proc.run = async (command: string, opts: { cwd: string; env?: Record<string, string> }) => { runs.push({ command, env: opts.env }); return inner(command, opts); };
  const make = () => new LiveEngine(store!, { mode: 'dry-run', git: new DryRunGitPort(world), gh: new DryRunGhPort(world), proc, agents: { claude: new DryRunClaudePort(world) } } as Ports, () => {}, {
    sleep: async () => {}, now: () => new Date(t).toISOString(), listenUrl: 'http://127.0.0.1:4300',
    schedule: (fn, ms) => { const timer = { at: t + ms, fn }; timers.push(timer); return () => { timers = timers.filter((x) => x !== timer); }; },
  });
  engine = make();
  /** Let `ms` pass, running every timer that comes due. */
  const advance = (ms: number) => {
    const end = t + ms;
    for (;;) {
      const next = timers.filter((x) => x.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!next) break;
      timers = timers.filter((x) => x !== next); t = Math.max(t, next.at); next.fn();
    }
    t = end;
  };
  const s = store;
  const notes = () => s.journal.read({ type: 'notification' }).filter((j) => j.data?.event === 'on_needs_you');
  /** A new process: the old one's timers die with it. */
  const restart = () => { timers = []; engine = make(); return engine; };
  return { store: s, engine: () => engine!, advance, notes, runs, restart };
}

const set = (fields: Record<string, unknown>): ItemOp => ({ set: fields } as ItemOp);
const clear = { unset: ['awaiting', 'awaiting_data', 'blocked', 'blocked_reason', 'skip_merge', 'hold_reason'] } as ItemOp;

describe('notify when an item needs you (#224)', () => {
  it('each wait kind journals exactly one notification, with an absolute link to it', async () => {
    const { store, advance, notes } = await setup();
    const item = store.createItem({ title: 'Lamps at a rhythm', description: 'x' });
    const waits: [string, Record<string, unknown>][] = [
      ['plan', { awaiting: 'plan_approval', plan_ready_at: '2026-10-07T12:00:00Z' }],
      ['breakdown', { awaiting: 'breakdown_approval', plan_ready_at: '2026-10-07T12:01:00Z' }],
      ['permission', { awaiting: 'permission', awaiting_data: { tool: 'Bash', input: { command: 'make' }, requested_at: '2026-10-07T12:02:00Z' } }],
      ['question', { awaiting: 'question', awaiting_data: { questions: [{ question: 'Which?' }], requested_at: '2026-10-07T12:03:00Z' } }],
      ['decision', { awaiting: 'user', awaiting_data: { decision: { question: 'Which way?', options: [] } } }],
      ['blocked', { blocked: true, blocked_reason: 'ci_red', awaiting: 'user' }],
      ['review', { status: 'IN_REVIEW', awaiting: 'review', ci_head_sha: 'a'.repeat(40) }],
      ['hold', { status: 'IN_REVIEW', skip_merge: true, hold_reason: 'for the designer' }],
    ];
    for (const [kind, fields] of waits) {
      store.mutateItem(item.id, [clear, set(fields)], 'engine');
      advance(SETTLE_MS);
      store.mutateItem(item.id, [{ activity: { actor: 'app', text: `still waiting (${kind})` } }], 'engine'); // the same wait: nothing new
      advance(10 * 60_000);
      const mine = notes().filter((n) => n.data!.kind === kind);
      expect(mine, kind).toHaveLength(1);
      expect(mine[0]).toMatchObject({ item: item.id, data: { url: `http://127.0.0.1:4300/items/${item.id}#${kind}`, message: 'Lamps at a rhythm' } });
    }
    expect(notes()).toHaveLength(waits.length);

    const q = store.askQuestion({ headline: 'Ship the lamps?', summary: 'They flicker.', item: item.id });
    advance(SETTLE_MS);
    expect(notes().at(-1)).toMatchObject({ item: item.id, data: { kind: 'question', question: q.file.frontmatter.id, url: `http://127.0.0.1:4300/questions/${q.file.frontmatter.id}`, message: 'Ship the lamps?' } });
    expect(notes()).toHaveLength(waits.length + 1);
  });

  it('a stop the orchestrator is triaging, or one gone again at once, is not announced', async () => {
    const { store, advance, notes } = await setup();
    const item = store.createItem({ title: 'Triaged', description: 'x' });
    store.mutateItem(item.id, [set({ blocked: true, blocked_reason: 'ci_red', awaiting: 'user', triage: { reason: 'ci_red', started_at: '2026-10-07T12:00:00Z' } })], 'engine');
    advance(10 * 60_000);
    expect(notes()).toHaveLength(0);
    store.mutateItem(item.id, [{ unset: ['triage'] }], 'engine');  // handed back: now it is yours
    advance(SETTLE_MS);
    expect(notes()).toHaveLength(1);
    const other = store.createItem({ title: 'Brief', description: 'x' });
    store.mutateItem(other.id, [set({ blocked: true, blocked_reason: 'stalled' })], 'engine');
    store.mutateItem(other.id, [clear], 'engine');
    advance(10 * 60_000);
    expect(notes()).toHaveLength(1);
  });

  it('a wait answered inside the idle window while a client heartbeats sends nothing; one left until every client is idle is sent then', async () => {
    const { store, engine, advance, notes } = await setup();
    const item = store.createItem({ title: 'At the desk', description: 'x' });
    engine().clientActive();
    store.mutateItem(item.id, [set({ awaiting: 'plan_approval', plan_ready_at: '2026-10-07T12:00:00Z' })], 'engine');
    advance(60_000);
    engine().clientActive();
    advance(60_000);
    store.mutateItem(item.id, [clear], 'user');  // answered at the desk
    advance(30 * 60_000);
    expect(notes()).toHaveLength(0);

    store.mutateItem(item.id, [set({ awaiting: 'plan_approval', plan_ready_at: '2026-10-07T13:00:00Z' })], 'engine');
    engine().clientActive();
    advance(119_000);
    expect(notes()).toHaveLength(0);          // idle_after_min is 2: the tab was used under two minutes ago
    advance(1_000);
    expect(notes()).toHaveLength(1);
  });

  it('on_needs_you gets the item, the kind and an absolute PLANESTRO_URL from notifications.base_url', async () => {
    const { store, advance, runs } = await setup();
    store.updateConfig((doc) => { doc.setIn(['notifications', 'on_needs_you'], 'echo needs-you'); doc.setIn(['notifications', 'base_url'], 'http://studio.local:4300/'); }, 'config: on_needs_you');
    const item = store.createItem({ title: 'Pinged', description: 'x' });
    store.mutateItem(item.id, [set({ blocked: true, blocked_reason: 'ci_red', awaiting: 'user' })], 'engine');
    advance(SETTLE_MS);
    expect(runs.filter((r) => r.command === 'echo needs-you').map((r) => r.env)).toEqual([{
      PLANESTRO_TITLE: `${item.id} needs you: blocked (ci_red)`, PLANESTRO_MESSAGE: 'Pinged',
      PLANESTRO_ITEM: item.id, PLANESTRO_KIND: 'blocked', PLANESTRO_URL: `http://studio.local:4300/items/${item.id}#blocked`,
    }]);
  });

  it('after a restart, a wait already announced is not announced again; one that was not is', async () => {
    const { store, advance, notes, restart } = await setup();
    const a = store.createItem({ title: 'Announced', description: 'x' });
    store.mutateItem(a.id, [set({ blocked: true, blocked_reason: 'ci_red' })], 'engine');
    advance(SETTLE_MS);
    expect(notes()).toHaveLength(1);
    const b = store.createItem({ title: 'Not yet', description: 'x' });
    restart().clientActive();
    store.mutateItem(b.id, [set({ blocked: true, blocked_reason: 'stalled' })], 'engine');
    restart();                                   // stopped before b's was due
    store.mutateItem(a.id, [{ activity: { actor: 'app', text: 'nudge' } }], 'engine');
    advance(SETTLE_MS);
    expect(notes().map((n: JournalEntry) => n.item)).toEqual([a.id, b.id]);
  });

  it('a link names the machine when the server listens on every address', () => {
    expect(listenUrl('127.0.0.1', 4300)).toBe('http://127.0.0.1:4300');
    expect(listenUrl('0.0.0.0', 4300)).not.toMatch(/0\.0\.0\.0/);
    expect(listenUrl('::1', 4300)).toBe('http://[::1]:4300');
  });
});
