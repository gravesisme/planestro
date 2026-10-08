import { describe, it, expect } from 'vitest';
import { concurrencyAdvice, raiseNeedsConfirm, stepDownDue, timeoutKilledIn, CONCURRENCY_GUARD_DEFAULTS, type CiResultSeen, type ConcurrencyChange } from '../src/concurrency.ts';

// #330: the machine is the limit, not the number. HH ran at max_sessions 2, was asked for 3, and its check runs were
// killed at their timeouts (rc=137) while the shared Mac's load average sat at 60–92.

const NOW = Date.parse('2026-10-08T12:00:00-04:00');
const ok = (n: number): CiResultSeen[] => Array.from({ length: n }, (_, i) => ({ at: `2026-10-08T0${i % 9}:00:00-04:00`, outcome: 'success', timeout_killed: false }));
const killed: CiResultSeen = { at: '2026-10-08T10:00:00-04:00', outcome: 'failure', timeout_killed: true, run_id: 9 };
const g = CONCURRENCY_GUARD_DEFAULTS;
const change = (at: string, from: number, to: number, extra: Partial<ConcurrencyChange> = {}): ConcurrencyChange => ({ at, by: 'user', from: { max_sessions: from, runner_limits: { codex: 1 } }, to: { max_sessions: to, runner_limits: { codex: 1 } }, ...extra });

describe('concurrency guard rails (#330)', () => {
  it('a timeout kill is rc=137, an exit code 137, a SIGKILL or a job past its time limit', () => {
    expect(timeoutKilledIn('boss_check rc=137 after 600s')).toBe(true);
    expect(timeoutKilledIn('##[error]Process completed with exit code 137.')).toBe(true);
    expect(timeoutKilledIn('The job running on runner hh-mac has exceeded the maximum execution time of 10 minutes.')).toBe(true);
    expect(timeoutKilledIn('FAIL src/a.test.ts > adds\nAssertionError: expected 2 to be 3')).toBe(false);
    expect(timeoutKilledIn('rc=1370 is not it')).toBe(false);
  });

  it('healthy history and a quiet machine allow one step up; more than that needs a confirm', () => {
    const a = concurrencyAdvice({ current: 2, ci: ok(12), host: { load: [3, 4, 4], cpus: 10 }, now: NOW }, g);
    expect(a).toMatchObject({ healthy: true, raise_ok: true, recommended_max: 3, kills: 0, seen: 10, window: 10, reasons: [] });
    expect(raiseNeedsConfirm(2, 3, a)).toBe(false);
    expect(raiseNeedsConfirm(2, 4, a)).toBe(true);
    expect(raiseNeedsConfirm(2, 1, a)).toBe(false);   // lowering never asks
  });

  it('a timeout-killed check in the last N results, or load over the threshold, recommends a step down', () => {
    const kill = concurrencyAdvice({ current: 3, ci: [...ok(5), killed], host: { load: [2, 2, 2], cpus: 10 }, now: NOW }, g);
    expect(kill).toMatchObject({ healthy: false, raise_ok: false, recommended_max: 2, kills: 1 });
    expect(kill.reasons.join(' ')).toMatch(/1 of the last 6 CI results was killed at a timeout/);
    expect(raiseNeedsConfirm(3, 4, kill)).toBe(true);
    // Older than the window, it no longer counts.
    expect(concurrencyAdvice({ current: 3, ci: [killed, ...ok(10)], now: NOW }, g).healthy).toBe(true);
    const busy = concurrencyAdvice({ current: 3, ci: ok(3), host: { load: [80, 64, 50], cpus: 10 }, now: NOW }, g);
    expect(busy).toMatchObject({ healthy: false, recommended_max: 2, load_per_cpu: 6.4 });
    expect(busy.reasons.join(' ')).toMatch(/load 64 over 5 min on 10 cores/);
    expect(concurrencyAdvice({ current: 1, ci: [killed], now: NOW }, g).recommended_max).toBe(1);   // never below one
  });

  it('a raise settles before the next one is recommended', () => {
    const recent = concurrencyAdvice({ current: 3, ci: ok(4), last_change: change('2026-10-08T11:50:00-04:00', 2, 3), now: NOW }, g);
    expect(recent).toMatchObject({ healthy: true, raise_ok: false, recommended_max: 3 });
    expect(recent.reasons.join(' ')).toMatch(/raised 10 min ago/);
    expect(concurrencyAdvice({ current: 3, ci: ok(4), last_change: change('2026-10-08T11:00:00-04:00', 2, 3), now: NOW }, g).raise_ok).toBe(true);
    // A lowering is no reason to wait.
    expect(concurrencyAdvice({ current: 2, ci: ok(4), last_change: change('2026-10-08T11:55:00-04:00', 3, 2), now: NOW }, g).raise_ok).toBe(true);
  });

  it('auto-step-down is off by default, and steps a raise back once a check is killed or load stays high after it', () => {
    const raise = change('2026-10-08T09:00:00-04:00', 2, 3);
    const after = { ...killed, at: '2026-10-08T10:00:00-04:00' };
    expect(stepDownDue({ last_change: raise, ci: [after], now: NOW }, g)).toBeUndefined();
    const on = { ...g, auto_step_down: true };
    expect(stepDownDue({ last_change: raise, ci: [after], now: NOW }, on)).toMatch(/killed at a timeout/);
    // A kill from before the raise is not the raise's.
    expect(stepDownDue({ last_change: raise, ci: [{ ...killed, at: '2026-10-08T08:00:00-04:00' }], now: NOW }, on)).toBeUndefined();
    expect(stepDownDue({ last_change: raise, ci: [], host: { load: [30, 30, 25], cpus: 10 }, now: NOW }, on)).toMatch(/load/);
    // Only a raise is stepped back, and a step-down is never stepped down again.
    expect(stepDownDue({ last_change: change('2026-10-08T09:00:00-04:00', 3, 2), ci: [after], now: NOW }, on)).toBeUndefined();
    expect(stepDownDue({ last_change: { ...raise, auto: true }, ci: [after], now: NOW }, on)).toBeUndefined();
    expect(stepDownDue({ ci: [after], now: NOW }, on)).toBeUndefined();
  });
});
