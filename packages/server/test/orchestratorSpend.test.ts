import { describe, it, expect } from 'vitest';
import type { JournalEntry } from '@planestro/shared';
import { orchestratorSpend } from '../src/engine/orchestratorSpend.ts';

const done = (ts: string, data: Record<string, unknown>): JournalEntry => ({ ts, type: 'orchestrator.done', actor: 'orchestrator', data: { subtype: 'success', summary: 's', ...data } });

describe("the orchestrator's cost per wake (#49)", () => {
  it('totals today and the current conversation, which starts again on rotation, newest wakes first', () => {
    const now = new Date('2026-09-29T15:00:00');
    const j = [
      done('2026-09-28T22:00:00', { events: ['plan_review'], items: ['HH-1'], cost: 4, session: 'a', wake: 1, fresh: true }),
      done('2026-09-29T09:00:00', { events: ['triage'], items: ['HH-2'], cost: 2, session: 'a', wake: 2, context_tokens: 90_000 }),
      done('2026-09-29T10:00:00', { events: ['user_message'], cost: 1.5, session: 'b', wake: 1, fresh: true, context_tokens: 30_000 }),
      done('2026-09-29T11:00:00', { events: ['pr_opened'], items: ['HH-3'], cost: 0.75, session: 'b', wake: 2, context_tokens: 41_000, subtype: 'error_max_turns' }),
      { ts: '2026-09-29T11:30:00', type: 'orchestrator.wake', actor: 'engine', data: {} },
    ];
    const s = orchestratorSpend(j, now);
    expect(s.today).toEqual({ wakes: 3, cost: 4.25 });
    expect(s.conversation).toEqual({ wakes: 2, cost: 2.25, context_tokens: 41_000 });
    expect(s.wakes.map((w) => w.at)).toEqual(['2026-09-29T11:00:00', '2026-09-29T10:00:00', '2026-09-29T09:00:00', '2026-09-28T22:00:00']);
    expect(s.wakes[0]).toMatchObject({ items: ['HH-3'], failed: true, fresh: false });
    expect(s.wakes[1]).toMatchObject({ fresh: true, items: [] });
  });

  it('entries from before #49 (no session) still count toward today, with no conversation total', () => {
    const s = orchestratorSpend([done('2026-09-29T09:00:00', { events: ['triage'], cost: 3 })], new Date('2026-09-29T12:00:00'));
    expect(s.today).toEqual({ wakes: 1, cost: 3 });
    expect(s.conversation).toBeNull();
  });
});
