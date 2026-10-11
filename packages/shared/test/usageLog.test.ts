import { describe, it, expect } from 'vitest';
import { usageReport, usageTurnData, dayBefore, USAGE_TURN, type JournalEntry } from '../src/index.ts';

const turn = (ts: string, data: Record<string, unknown>): JournalEntry => ({ ts, type: USAGE_TURN, actor: 'engine', data: { subtype: 'success', op: 'implement_turn', ...data } });

describe('usage report (#236)', () => {
  it('buckets turns by local day, empty days included, grouped by provider, model and role', () => {
    const entries: JournalEntry[] = [
      turn('2026-09-20T10:00:00-07:00', { provider: 'claude', model: 'opus', role: 'worker', usd: 9 }),
      turn('2026-10-06T23:59:00-07:00', { provider: 'claude', model: 'opus', role: 'planner', usd: 0.5 }),
      turn('2026-10-08T00:01:00-07:00', { provider: 'claude', model: 'opus', role: 'worker', usd: 1.25 }),
      turn('2026-10-08T09:00:00-07:00', { provider: 'codex', model: 'gpt', role: 'worker', tokens: 2000 }),
      { ts: '2026-10-08T09:30:00-07:00', type: 'usage.guard_tripped', actor: 'engine', data: { provider: 'claude', window: 'five_hour', status: 'allowed', utilization: 0.87 } },
      { ts: '2026-10-08T14:30:00-07:00', type: 'usage.guard_resumed', actor: 'engine', data: { provider: 'claude' } },
    ];
    const r = usageReport(entries, { days: 3, today: '2026-10-08' });
    expect(r.days.map((d) => d.day)).toEqual(['2026-10-06', '2026-10-07', '2026-10-08']);
    expect(r.days[0]).toMatchObject({ usd: 0.5, turns: 1 });
    expect(r.days[1]).toMatchObject({ usd: 0, tokens: 0, turns: 0 });
    expect(r.days[2]).toMatchObject({ usd: 1.25, tokens: 2000, turns: 2 });
    expect(r.days[2].by.provider).toMatchObject({ claude: { usd: 1.25, tokens: 0, turns: 1 }, codex: { usd: 0, tokens: 2000, turns: 1 } });
    expect(r.totals).toMatchObject({ usd: 1.75, tokens: 2000, turns: 3 });
    expect(r.totals.by.role.worker.turns).toBe(2);
    expect(r.recorded_since).toBe('2026-09-20T10:00:00-07:00');
    expect(r.events.map((e) => e.kind)).toEqual(['resumed', 'crossing']);
    expect(r.events[1].text).toBe('Claude paused: the 5-hour window reached 87%');
  });

  it('sums the token split and its cache-hit rate per provider, model and role (#345)', () => {
    const r = usageReport([
      turn('2026-10-08T09:00:00-07:00', { provider: 'claude', model: 'opus', role: 'worker', usd: 1, tokens: 300, input: 100, cache_read: 900, cache_write: 100, output: 100 }),
      turn('2026-10-08T10:00:00-07:00', { provider: 'claude', model: 'opus', role: 'planner', usd: 2 }),
      turn('2026-10-08T11:00:00-07:00', { provider: 'codex', model: 'gpt', role: 'worker', tokens: 60, input: 50, cache_read: 50, cache_write: 0, output: 10 }),
    ], { days: 1, today: '2026-10-08' });
    expect(r.totals).toMatchObject({ tokens: 360, input: 150, cache_read: 950, cache_write: 100, output: 110, cache_hit: 0.792 });
    expect(r.totals.by.provider.claude).toMatchObject({ turns: 2, cache_hit: 0.818 });
    expect(r.totals.by.provider.codex.cache_hit).toBe(0.5);
    expect(r.totals.by.role.planner.cache_hit).toBeUndefined();
  });

  it('days count back across a month end', () => {
    expect(dayBefore('2026-10-01', 1)).toBe('2026-09-30');
    expect(dayBefore('2026-03-01', 1)).toBe('2026-02-28');
  });

  it('a turn that never ran is not recorded; dollars only from a runner that reports them', () => {
    const base = { provider: 'claude', model: 'opus', role: 'worker' as const, op: 'implement_turn' };
    expect(usageTurnData({ ...base, accounting: 'dollars', result: { subtype: 'deferred', costUsd: 0, numTurns: 0 } })).toBeUndefined();
    expect(usageTurnData({ ...base, accounting: 'dollars', result: { subtype: 'resume_declined', costUsd: 0, numTurns: 0 } })).toBeUndefined();
    expect(usageTurnData({ ...base, accounting: 'dollars', result: { subtype: 'success', costUsd: 0.4, numTurns: 3 } })).toEqual({ ...base, usd: 0.4, subtype: 'success' });
    expect(usageTurnData({ ...base, provider: 'codex', accounting: 'tokens', result: { subtype: 'success', costUsd: 0, tokens: 50, numTurns: 1 } })).toEqual({ ...base, provider: 'codex', tokens: 50, subtype: 'success' });
    // #345: Claude's dollars come with the split it streamed, and tokens are the work paid in full.
    const usage = { input: 10, cache_read: 9000, cache_write: 400, cache_ttl_s: 3600, output: 90 };
    expect(usageTurnData({ ...base, accounting: 'dollars', result: { subtype: 'success', costUsd: 0.4, numTurns: 3, usage, contextTokens: 9500 } }))
      .toEqual({ ...base, usd: 0.4, tokens: 500, input: 10, cache_read: 9000, cache_write: 400, cache_ttl_s: 3600, output: 90, context: 9500, subtype: 'success' });
    expect(usageTurnData({ ...base, provider: 'codex', accounting: 'tokens', result: { subtype: 'success', costUsd: 0, tokens: 60, numTurns: 1, usage: { input: 50, cache_read: 50, cache_write: 0, output: 10 } } }))
      .toMatchObject({ tokens: 60, input: 50, cache_read: 50, cache_write: 0, output: 10 });
  });
});
