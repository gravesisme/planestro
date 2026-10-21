import { describe, it, expect } from 'vitest';
import { usageReport, USAGE_TURN, type JournalEntry } from '@planestro/shared';
import { usageSeries, dayValues, niceTicks, formatValue, shownMeasure, turnsAndWakes, SERIES_COLORS, OTHER } from '../src/usageChart.ts';

const turn = (ts: string, model: string, usd: number, role = 'worker', provider = 'claude'): JournalEntry => ({ ts, type: USAGE_TURN, actor: 'engine', data: { provider, model, role, op: 'x', usd, subtype: 'success' } });

describe('usage chart series (#236)', () => {
  it('a role keeps its colour whatever else is charted, and the legend runs biggest first', () => {
    const r = usageReport([turn('2026-10-08T09:00:00-07:00', 'a', 1, 'orchestrator'), turn('2026-10-08T10:00:00-07:00', 'a', 3, 'planner')], { days: 1, today: '2026-10-08' });
    const s = usageSeries(r, 'role', 'usd');
    expect(s.map((x) => x.key)).toEqual(['planner', 'orchestrator']);
    expect(s.find((x) => x.key === 'planner')!.color).toBe(SERIES_COLORS[1]);
    expect(s.find((x) => x.key === 'orchestrator')!.color).toBe(SERIES_COLORS[2]);
  });
  it('past seven models the smallest fold into Other, and a day sums them there', () => {
    const entries = Array.from({ length: 9 }, (_, i) => turn('2026-10-08T09:00:00-07:00', `m${i}`, i + 1));
    const r = usageReport(entries, { days: 1, today: '2026-10-08' });
    const s = usageSeries(r, 'model', 'usd');
    expect(s).toHaveLength(7);
    expect(s.at(-1)).toMatchObject({ key: OTHER, total: 1 + 2 + 3 });
    expect(dayValues(r.days[0], s, 'model', 'usd').reduce((a, b) => a + b, 0)).toBe(45);
    expect(new Set(s.map((x) => x.color)).size).toBe(7);
  });
  it('a series with nothing in the chosen measure is left out', () => {
    const r = usageReport([turn('2026-10-08T09:00:00-07:00', 'a', 2)], { days: 1, today: '2026-10-08' });
    expect(usageSeries(r, 'provider', 'tokens')).toEqual([]);
  });
  it('round ticks and short values', () => {
    expect(niceTicks(7.3)).toEqual([0, 2, 4, 6, 8]);
    expect(niceTicks(0)).toEqual([0]);
    expect(formatValue(1.5, 'usd')).toBe('$1.50');
    expect(formatValue(12_345, 'tokens')).toBe('12k');
    expect(formatValue(2_500_000, 'tokens')).toBe('2.5M');
  });
  it('a range with no dollars opens on tokens, unless the viewer picked dollars on this visit (#476)', () => {
    const codex: JournalEntry = { ts: '2026-10-08T09:00:00-07:00', type: USAGE_TURN, actor: 'engine', data: { provider: 'codex', model: 'gpt', role: 'worker', op: 'x', tokens: 1200, subtype: 'success' } };
    const tokensOnly = usageReport([codex], { days: 1, today: '2026-10-08' });
    expect(shownMeasure(tokensOnly, undefined, 'usd')).toBe('tokens');
    expect(shownMeasure(tokensOnly, 'usd', 'usd')).toBe('usd');
    const dollars = usageReport([codex, turn('2026-10-08T10:00:00-07:00', 'a', 2)], { days: 1, today: '2026-10-08' });
    expect(shownMeasure(dollars, undefined, 'usd')).toBe('usd');
    expect(shownMeasure(dollars, undefined, 'tokens')).toBe('tokens');
    expect(shownMeasure(usageReport([], { days: 1, today: '2026-10-08' }), undefined, 'usd')).toBe('usd');
    expect(shownMeasure(undefined, undefined, 'usd')).toBe('usd');
  });
  it('counts read as turns and wakes in the header and the day line alike (#476)', () => {
    expect(turnsAndWakes(26)).toBe('turns and wakes');
    expect(turnsAndWakes(0)).toBe('turns and wakes');
    expect(turnsAndWakes(1)).toBe('turn or wake');
  });
});
