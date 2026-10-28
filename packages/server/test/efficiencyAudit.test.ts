import { describe, it, expect, afterEach } from 'vitest';
import { USAGE_TURN, EFFICIENCY_AUDIT, auditDigest, dayBefore, isoLocal } from '@planestro/shared';
import { DataStore } from '../src/store/DataStore.ts';
import { auditSlotDue, runEfficiencyAudit, previousRecommendation, auditHistory } from '../src/engine/efficiencyAudit.ts';
import { NOTE_TYPE, NOTE_LINK_TYPE, notesWithLinks } from '../src/engine/feedback.ts';
import type { CustomTurnOptions, TurnResult } from '../src/engine/ports.ts';
import { LiveEngine } from '../src/engine/LiveEngine.ts';
import { FakeWorld, DryRunGitPort, DryRunGhPort, DryRunProcPort, DryRunCodexPort, DryRunClaudePort } from '../src/engine/dryrun-ports.ts';
import { makeFixture, sleep } from './helpers.ts';

let store: DataStore | undefined;
afterEach(() => { store?.close(); store = undefined; });

const NOW = new Date('2026-10-15T10:00:00Z');
async function setup(enabled = true) {
  const { dataDir } = makeFixture();
  store = await DataStore.open(dataDir);
  if (enabled) store.updateConfig((doc) => doc.set('efficiency_audit', { enabled: true, cron: '30 3 * * *', days: 7, budget_usd: 1, budget_tokens: 60000 }), 'config: audit on');
  return store;
}
const turn = (s: DataStore, ts: string, item: string, usd: number) => s.journal.append({ ts, type: USAGE_TURN, item, actor: 'engine', data: { provider: 'claude', model: 'opus', role: 'worker', op: 'implement_turn', stage: 'implementation', usd, subtype: 'success' } });

/** An orchestrator model that files what it is given, and reports what it cost. */
function auditor(args: Record<string, unknown> | undefined, seen: CustomTurnOptions[] = []) {
  return {
    claude: {
      runTurn: async () => { throw new Error('not here'); },
      async runCustomTurn(o: CustomTurnOptions): Promise<TurnResult> {
        seen.push(o);
        if (args) await o.mcpTools.find((t) => t.name === 'file_recommendation')!.handler(args);
        return { subtype: 'success', isError: false, costUsd: 0.31, numTurns: 2, text: '' };
      },
    },
  } as any;
}
const deps = (s: DataStore, agents: any) => ({ store: s, agents, orchestrator: { modelForWake: () => ({ runner: 'claude' as const, model: 'claude-opus-5-5', label: 'Opus' }) }, log: () => {} });
const rec = { key: 'HH-1-whole-suite', title: 'Run only the changed test file on HH-1 worker turns', what: 'HH-1 runs the whole suite every turn', evidence: '9 whole-suite runs, 41 min', change: 'add --only-file to the worker prompt partial', saving: '$4/day' };

describe('daily efficiency audit (#348)', () => {
  it('is off by default, and once on, due once per slot', async () => {
    const off = await setup(false);
    expect(auditSlotDue(off, NOW, 'UTC')).toBeUndefined();
    off.close(); store = undefined;
    const s = await setup();
    const slot = auditSlotDue(s, NOW, 'UTC')!;
    expect(slot.slice(0, 16)).toBe('2026-10-15T03:30');
    turn(s, '2026-10-14T12:00:00+00:00', 'HH-1', 3);
    await runEfficiencyAudit(deps(s, auditor(rec)), slot);
    expect(auditSlotDue(s, NOW, 'UTC')).toBeUndefined();
  });

  it('skips a slot after a day with no turns, without a wake', async () => {
    const s = await setup();
    const seen: CustomTurnOptions[] = [];
    turn(s, '2026-10-12T12:00:00+00:00', 'HH-1', 3);
    const r = await runEfficiencyAudit(deps(s, auditor(rec, seen)), auditSlotDue(s, NOW, 'UTC')!);
    expect(r).toMatchObject({ outcome: 'skipped', reason: 'no turns on 2026-10-14' });
    expect(seen).toHaveLength(0);
  });

  it('reads the digest in one capped wake with one tool, files exactly one feedback note, and journals its cost', async () => {
    const s = await setup();
    turn(s, '2026-10-14T12:00:00+00:00', 'HH-1', 3);
    const seen: CustomTurnOptions[] = [];
    const r = await runEfficiencyAudit(deps(s, auditor(rec, seen)), auditSlotDue(s, NOW, 'UTC')!);
    expect(seen[0]).toMatchObject({ model: 'claude-opus-5-5', maxBudgetUsd: 1, maxTokens: 60000, allowedTools: [] });
    expect(seen[0].mcpTools.map((t) => t.name)).toEqual(['file_recommendation']);
    expect(seen[0].prompt).toContain('## Costliest items\n- HH-1: $3.00');
    expect(r).toMatchObject({ outcome: 'noted', key: rec.key, usd: 0.31 });
    const notes = s.journal.read({ type: NOTE_TYPE });
    expect(notes).toHaveLength(1);
    expect(notes[0].data!.text).toContain('Efficiency audit 2026-10-14: HH-1 runs the whole suite every turn');
    expect(notes[0].data!.text).toContain('Change: add --only-file');
    expect(notes[0].data!.title).toBe('Run only the changed test file on HH-1 worker turns');
    expect(s.journal.read({ type: USAGE_TURN }).at(-1)!.data).toMatchObject({ role: 'orchestrator', op: 'efficiency_audit', usd: 0.31 });
    // A second call in the same wake files nothing more.
    expect(await seen[0].mcpTools[0].handler(rec)).toMatch(/^Already filed/);
    expect(s.journal.read({ type: NOTE_TYPE })).toHaveLength(1);
  });

  it('a waste that is still yesterday\'s unacted note is said on that note, not filed again; once acted on, it is nothing new', async () => {
    const s = await setup();
    turn(s, '2026-10-13T12:00:00+00:00', 'HH-1', 3);
    await runEfficiencyAudit(deps(s, auditor(rec)), '2026-10-14T03:30:00+00:00');
    turn(s, '2026-10-14T12:00:00+00:00', 'HH-1', 3);
    const seen: CustomTurnOptions[] = [];
    const r = await runEfficiencyAudit(deps(s, auditor(rec, seen)), '2026-10-15T03:30:00+00:00');
    expect(seen[0].prompt).toContain('NOT acted on yet');
    expect(r).toMatchObject({ outcome: 'repeat', key: rec.key });
    expect(s.journal.read({ type: NOTE_TYPE })).toHaveLength(1);
    expect(notesWithLinks(s)[0].links.comments[0]).toContain('still the biggest waste on 2026-10-14');
    // The user files it as an issue: acted on, so the same waste again is nothing new, with no note in the Console.
    s.journal.append({ type: NOTE_LINK_TYPE, actor: 'user', data: { note: notesWithLinks(s)[0].ts, issues: [{ number: 484 }] } });
    expect(previousRecommendation(s)).toMatchObject({ key: rec.key, acted: true });
    turn(s, '2026-10-15T12:00:00+00:00', 'HH-1', 3);
    const again: CustomTurnOptions[] = [];
    expect(await runEfficiencyAudit(deps(s, auditor(rec, again)), '2026-10-16T03:30:00+00:00')).toMatchObject({ outcome: 'nothing_new', key: rec.key, issues: [484] });
    expect(again[0].prompt).toContain(`\`${rec.key}\` (filed as #484)`);
    expect(s.journal.read({ type: NOTE_TYPE })).toHaveLength(1);
    expect(notesWithLinks(s)[0].links.comments).toHaveLength(1);
    // A different waste in between does not make the old key new again.
    turn(s, '2026-10-16T12:00:00+00:00', 'HH-1', 3);
    await runEfficiencyAudit(deps(s, auditor({ ...rec, key: 'planner-cost' })), '2026-10-17T03:30:00+00:00');
    turn(s, '2026-10-17T12:00:00+00:00', 'HH-1', 3);
    expect((await runEfficiencyAudit(deps(s, auditor(rec)), '2026-10-18T03:30:00+00:00')).outcome).toBe('nothing_new');
    expect(s.journal.read({ type: NOTE_TYPE })).toHaveLength(2);
    expect(auditHistory(s).map((h) => h.outcome)).toEqual(['nothing_new', 'noted', 'nothing_new', 'repeat', 'noted']);
  });

  it('a wake that files nothing is recorded as failed, and its slot is not run again', async () => {
    const s = await setup();
    turn(s, '2026-10-14T12:00:00+00:00', 'HH-1', 3);
    const r = await runEfficiencyAudit(deps(s, auditor(undefined)), auditSlotDue(s, NOW, 'UTC')!);
    expect(r).toMatchObject({ outcome: 'failed', reason: 'the wake ended without a recommendation' });
    expect(s.journal.read({ type: EFFICIENCY_AUDIT })).toHaveLength(1);
    expect(auditSlotDue(s, NOW, 'UTC')).toBeUndefined();
  });
});

describe('the audit on the tick (#348)', () => {
  it('runs once its slot has come, while automation runs, and files the note through the orchestrator\'s model', async () => {
    const s = await setup();
    const slot = auditSlotDue(s, NOW)!;
    turn(s, `${dayBefore(slot.slice(0, 10), 1)}T12:00:00${slot.slice(19)}`, 'HH-1', 3);
    const world = new FakeWorld(() => {}, { 'origin/trunk': 'f'.repeat(40) });
    const engine = new LiveEngine(s, { mode: 'dry-run', git: new DryRunGitPort(world), gh: new DryRunGhPort(world), proc: new DryRunProcPort(world), agents: { claude: new DryRunClaudePort(world), codex: new DryRunCodexPort(world) } }, () => {}, { sleep: async () => {}, tickMs: 50, now: () => isoLocal(NOW) });
    try {
      await engine.start();
      const t0 = Date.now();
      while (!s.journal.read({ type: EFFICIENCY_AUDIT }).length && Date.now() - t0 < 5000) await sleep(20);
      expect(s.journal.read({ type: EFFICIENCY_AUDIT }).map((e) => e.data)).toEqual([expect.objectContaining({ slot, outcome: 'noted', key: 'HH-1-cost' })]);
      await sleep(150);
      expect(s.journal.read({ type: EFFICIENCY_AUDIT })).toHaveLength(1);
    } finally { await engine.stop(); }
  });
});

describe('the audit digest (#348)', () => {
  it('is built in code: totals, roles, stages, costliest items, parks and the last recommendation', () => {
    const e = (ts: string, type: string, data: Record<string, unknown>, item?: string) => ({ ts, type, actor: 'engine', ...(item ? { item } : {}), data });
    const text = auditDigest([
      e('2026-10-14T09:00:00-07:00', USAGE_TURN, { provider: 'claude', model: 'fable', role: 'planner', op: 'planning_turn', usd: 97, subtype: 'success', input: 10, cache_read: 90, cache_write: 0, output: 5 }, 'HH-2'),
      e('2026-10-14T10:00:00-07:00', USAGE_TURN, { provider: 'claude', model: 'opus', role: 'orchestrator', op: 'orchestrator_wake', usd: 2, subtype: 'success', stage: 'orchestrator' }),
      e('2026-10-14T11:00:00-07:00', 'permission.parked', { park: 'p', shape: 'godot --headless' }, 'HH-2'),
    ], { today: '2026-10-14', days: 7, previous: { at: '2026-10-14T03:30:00-07:00', key: 'fable-planner', what: 'Fable plans cost most', acted: false } });
    expect(text).toContain('## Totals, 2026-10-08 to 2026-10-14\n$99.00 over 2 turns and wakes; cache hits 90%');
    expect(text).toContain('- planner: $97.00, 1 turns');
    expect(text).toContain('- planning: $97.00, 1 turns');
    expect(text).toContain('- orchestrator wakes about no item: $2.00, 1 wakes');
    expect(text).toContain('- HH-2: $97.00 (planning $97.00); 1 turns, 0 wakes, 0 fresh, 1 parks');
    expect(text).toContain('- `godot --headless`: 1 parks on 1 items');
    expect(text).toContain('2026-10-14 [fable-planner] Fable plans cost most — not acted on yet');
  });

  it('never calls a wake journaled before its items were recorded "about no item" (#416)', () => {
    const e = (ts: string, data: Record<string, unknown>) => ({ ts, type: USAGE_TURN, actor: 'orchestrator', data: { provider: 'claude', model: 'opus', role: 'orchestrator', subtype: 'success', ...data } });
    const text = auditDigest([
      e('2026-10-12T10:00:00-07:00', { op: 'orchestrator_wake', usd: 75 }),
      e('2026-10-14T10:00:00-07:00', { op: 'orchestrator_wake', usd: 4, stage: 'orchestrator', items: ['HH-2'] }),
      e('2026-10-14T11:00:00-07:00', { op: 'orchestrator_wake', usd: 1, stage: 'orchestrator' }),
      e('2026-10-14T03:30:00-07:00', { op: 'efficiency_audit', usd: 0.3, stage: 'orchestrator' }),
    ], { today: '2026-10-14', days: 7 });
    expect(text).toContain('- orchestrator: $4.00, 1 turns');
    expect(text).toContain('- orchestrator wakes about no item: $1.00, 1 wakes');
    expect(text).toContain('- orchestrator wakes journaled before their items were recorded (#346; not "no item"): $75.00, 1 wakes');
    expect(text).toContain('- the efficiency audit itself: $0.30, 1 runs');
    expect(text).not.toContain('about no item: $76');
  });
});
