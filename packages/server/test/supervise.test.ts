import { describe, it, expect } from 'vitest';
import { planFor, busyTurns } from '../src/supervise.ts';

describe('serve --watch policy', () => {
  it('web-only changes rebuild and never restart the process that owns the agents', () => {
    expect(planFor(['packages/web/src/pages/Board.tsx', 'packages/web/index.html'])).toEqual({ restart: false, rebuild: true });
    expect(planFor(['packages/web/public/favicon.svg'])).toEqual({ restart: false, rebuild: true });
  });
  it('server changes restart; shared code is compiled into both halves', () => {
    expect(planFor(['packages/server/src/engine/LiveEngine.ts'])).toEqual({ restart: true, rebuild: false });
    expect(planFor(['packages/shared/src/transitions.ts'])).toEqual({ restart: true, rebuild: true });
    expect(planFor(['README.md', 'packages/server/srcs/x.ts'])).toEqual({ restart: false, rebuild: false });
  });
  it('only a running turn counts as busy: a parked session costs nothing to restart under', () => {
    expect(busyTurns({ engine: { sessions: [{ busy: true }, { busy: false }, { busy: true }] } })).toBe(2);
    expect(busyTurns({ engine: { sessions: [] } })).toBe(0);
    expect(busyTurns(null)).toBe(0);
    expect(busyTurns({})).toBe(0);
  });
});
