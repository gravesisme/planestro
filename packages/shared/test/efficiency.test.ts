import { describe, it, expect } from 'vitest';
import { itemEfficiency, efficiencyRanking, usageStage, USAGE_TURN, type JournalEntry } from '../src/index.ts';

const turn = (ts: string, data: Record<string, unknown>, item?: string): JournalEntry => ({ ts, type: USAGE_TURN, ...(item ? { item } : {}), actor: 'engine', data: { provider: 'claude', model: 'opus', subtype: 'success', ...data } });

describe('per-item efficiency (#346)', () => {
  const entries: JournalEntry[] = [
    turn('2026-10-06T09:00:00-07:00', { role: 'planner', op: 'planning_turn', usd: 3, tokens: 1000, input: 100, cache_read: 900, cache_write: 800, output: 100, context: 40_000, start_context: 25_000, resumed: false }, 'HH-1'),
    turn('2026-10-07T09:00:00-07:00', { role: 'worker', op: 'implement_turn', stage: 'implementation', usd: 2, context: 90_000, start_context: 31_000, resumed: false }, 'HH-1'),
    turn('2026-10-07T10:00:00-07:00', { role: 'worker', op: 'implement_turn', stage: 'fix', usd: 1, context: 60_000, start_context: 88_000, resumed: true }, 'HH-1'),
    turn('2026-10-07T11:00:00-07:00', { role: 'orchestrator', op: 'orchestrator_wake', usd: 0.5, items: ['HH-1', 'HH-2'] }),
    turn('2026-10-07T12:00:00-07:00', { role: 'orchestrator', op: 'orchestrator_wake', usd: 9 }),
    turn('2026-10-08T09:00:00-07:00', { role: 'worker', op: 'implement_turn', tokens: 5000 }, 'HH-2'),
    { ts: '2026-10-07T09:30:00-07:00', type: 'session.replaced', item: 'HH-1', actor: 'engine', data: {} },
    { ts: '2026-10-07T09:40:00-07:00', type: 'permission.parked', item: 'HH-1', actor: 'engine', data: { park: 'p1' } },
    { ts: '2026-10-07T09:50:00-07:00', type: 'permission.answered', item: 'HH-1', actor: 'user', data: { park: 'p1', waited_ms: 600_000 } },
  ];

  it('totals an item by stage, with its share of the wakes about it, its parks, fresh sessions and startup weight', () => {
    const e = itemEfficiency(entries, 'HH-1');
    expect(e).toMatchObject({ usd: 6.25, turns: 3, wakes: 1, fresh_sessions: 1, parks: 1, parked_ms: 600_000, peak_context: 90_000 });
    expect(e.stages).toMatchObject({ planning: { usd: 3, turns: 1 }, implementation: { usd: 2 }, fix: { usd: 1 }, orchestrator: { usd: 0.25, turns: 1 } });
    // The resume's first window is a reload, not startup weight.
    expect(e.startup).toEqual({ sessions: 2, max: 31_000, mean: 28_000 });
    expect(e.cache_hit).toBe(0.5);
    // A wake about no item is no item's.
    expect(itemEfficiency(entries, 'HH-9')).toMatchObject({ usd: 0, turns: 0, wakes: 0 });
  });

  it('ranks the window: most expensive items, per stage, heaviest starting context', () => {
    const r = efficiencyRanking(entries, { days: 2, today: '2026-10-08' });
    expect(r.items.map((e) => e.item)).toEqual(['HH-1', 'HH-2']);
    // Inside the window only: the planning turn of 10-06 is out of it.
    expect(r.items[0].usd).toBe(3.25);
    expect(r.by_stage.fix).toEqual([{ item: 'HH-1', usd: 1, tokens: 0, turns: 1 }]);
    expect(r.by_stage.planning).toBeUndefined();
    expect(r.startup).toEqual([{ item: 'HH-1', max: 31_000, mean: 31_000, sessions: 1 }]);
  });

  it('reads an older entry\'s stage from its op', () => {
    expect(usageStage({ op: 'planning_turn', role: 'planner' })).toBe('planning');
    expect(usageStage({ op: 'conflict_session', role: 'worker' })).toBe('conflict');
    expect(usageStage({ op: 'implement_turn', role: 'worker' })).toBe('implementation');
    expect(usageStage({ op: 'orchestrator_wake', role: 'orchestrator' })).toBe('orchestrator');
  });
});
