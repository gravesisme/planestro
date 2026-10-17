import { describe, it, expect } from 'vitest';
import { appendConsole, keepConsole, parseEvent, reconnectDelay, refreshesState, throttled } from '../src/liveEvents.ts';

/** A clock and timer queue the test drives. */
function clock() {
  let t = 0;
  const due: { at: number; f: () => void }[] = [];
  return {
    now: () => t,
    later: (f: () => void, ms: number) => { due.push({ at: t + ms, f }); },
    advance(ms: number) {
      const end = t + ms;
      for (;;) {
        due.sort((a, b) => a.at - b.at);
        const next = due[0];
        if (!next || next.at > end) break;
        due.shift(); t = next.at; next.f();
      }
      t = end;
    },
  };
}

describe('the page follows the event stream (#audit web)', () => {
  it('a session printing never refetches the state; a change does', () => {
    expect(refreshesState('session.output')).toBe(false);
    expect(refreshesState('engine.log')).toBe(false);
    expect(refreshesState('journal.appended')).toBe(false);
    expect(refreshesState('item.updated')).toBe(true);
    expect(refreshesState('session.started')).toBe(true);
  });

  it('refreshes once per burst, at most once a second, and always after the last ask', () => {
    const c = clock();
    const runs: number[] = [];
    const ask = throttled(() => runs.push(c.now()), { gap: 1000, settle: 120, now: c.now, later: c.later });
    ask(); ask(); ask();
    c.advance(200);
    expect(runs).toEqual([120]);
    // A steady stream of changes: one refresh a second, not one per event and not none until it stops.
    for (let i = 0; i < 30; i++) { ask(); c.advance(100); }
    expect(runs).toEqual([120, 1120, 2120, 3120]);
    c.advance(5000);
    expect(runs).toEqual([120, 1120, 2120, 3120]); // the last ask (3100) is answered by the run after it, and nothing more runs
    ask(); c.advance(200);
    expect(runs.at(-1)).toBe(c.now() - 80); // quiet for a while: the next one is prompt again
  });

  it('appends the lines of one message at once, drops blank ones and caps the console', () => {
    const cur = appendConsole(undefined, ['a', '', '  ', 'b'], '10:00:00');
    expect(cur).toEqual(['10:00:00  a', '10:00:00  b']);
    expect(appendConsole(cur, [''], 'x')).toBe(cur);
    expect(appendConsole(Array.from({ length: 800 }, (_, i) => String(i)), ['new'], 's').slice(-2)).toEqual(['799', 's  new']);
  });

  it('keeps the consoles written to last', () => {
    let held: Record<string, string[]> = {};
    for (let i = 0; i < 30; i++) held = keepConsole(held, `X-${i}`, ['x'], 24);
    expect(held['X-5']).toBeUndefined();
    held = keepConsole(held, 'X-6', ['again'], 24); // written again: now the newest
    held = keepConsole(held, 'X-30', ['x'], 24);
    expect(Object.keys(held)).toHaveLength(24);
    expect(held['X-6']).toEqual(['again']);
    expect(held['X-7']).toBeUndefined();
    expect(Object.keys(held).at(-1)).toBe('X-30');
  });

  it('ignores a message that is not an event, and backs off reconnecting', () => {
    expect(parseEvent('not json')).toBeUndefined();
    expect(parseEvent('{"no":"type"}')).toBeUndefined();
    expect(parseEvent('{"type":"item.updated","id":"X-1"}')).toEqual({ type: 'item.updated', id: 'X-1' });
    expect([0, 1, 2, 10].map(reconnectDelay)).toEqual([1000, 2000, 4000, 30_000]);
  });
});
