import { describe, it, expect } from 'vitest';
import { ciAggregates, ciBreakdown, formatCiDuration, percentile, type CiAttemptTiming, type JournalEntry } from '../src/index.ts';

const at = (base: string, s: number) => new Date(Date.parse(base) + s * 1000).toISOString();
/** An attempt that waited `q` seconds for a runner and ran `r` seconds, its jobs named as GitHub names them. */
const attempt = (n: number, start: string, q: number, r: number, conclusion = 'success', jobs = [{ name: 'Headless checks', s: r }]): CiAttemptTiming => ({
  attempt: n, status: 'completed', conclusion, created_at: '2026-10-01T00:00:00Z', queued_at: start, first_job_started_at: at(start, q), completed_at: at(start, q + r),
  jobs: jobs.map((j) => ({ name: j.name, conclusion, started_at: at(start, q), completed_at: at(start, q + j.s), runner: 'r1' })),
});
const begin = (ts: string, item = 'HH-1'): JournalEntry => ({ ts, type: 'op.begin', item, actor: 'engine', data: { op: 'ci_wait', op_id: ts } });
const end = (ts: string, run_id: number, attempts: CiAttemptTiming[], item = 'HH-1'): JournalEntry => ({ ts, type: 'op.end', item, actor: 'engine', data: { op_id: 'x', outcome: 'ok', timing: { run_id, attempt: attempts.at(-1)!.attempt, attempts, reruns: [] } } });

describe('ciBreakdown (#181)', () => {
  it('reads the latest attempt: queued from its own start (a re-run keeps the run\'s created_at), running, jobs by name, re-runs with why', () => {
    const b = ciBreakdown({
      run_id: 9, attempt: 2, url: 'https://example/run/9',
      attempts: [attempt(2, '2026-10-14T10:30:00Z', 30, 300, 'success', [{ name: 'policy', s: 20 }, { name: 'Headless checks', s: 300 }]), attempt(1, '2026-10-14T10:00:00Z', 90, 240, 'failure')],
      reruns: [{ reason: 'flaky', by: 'app', attempt: 2 }],
    })!;
    expect(b.attempts.map((a) => a.attempt)).toEqual([1, 2]);
    expect(b.latest).toMatchObject({ attempt: 2, conclusion: 'success', queued_ms: 30_000, running_ms: 300_000 });
    expect(b.latest!.jobs.map((j) => [j.name, j.ms])).toEqual([['policy', 20_000], ['Headless checks', 300_000]]);
    expect(b).toMatchObject({ reruns: 1, rerun_reasons: ['flaky'] });
  });

  it('counts a re-run made by hand on GitHub (no reason recorded), says who asked for one, and has no start for a job no runner took', () => {
    const queued: CiAttemptTiming = { attempt: 3, status: 'queued', queued_at: '2026-10-14T11:00:00Z', jobs: [{ name: 'suite', status: 'queued' }] };
    const b = ciBreakdown({ run_id: 4, attempt: 3, attempts: [queued], reruns: [{ reason: 'rerun_ci', by: 'user' }] })!;
    expect(b).toMatchObject({ reruns: 2, rerun_reasons: ['rerun_ci (user)'] });
    expect(b.latest).toMatchObject({ queued_ms: undefined, running_ms: undefined });
    expect(b.latest!.jobs[0]).toEqual({ name: 'suite', status: 'queued' });
  });

  it('is nothing for an item with no timing', () => {
    expect(ciBreakdown(undefined)).toBeUndefined();
    expect(ciBreakdown({ attempts: [] })).toBeUndefined();
  });
});

describe('ciAggregates (#182)', () => {
  const journal: JournalEntry[] = [
    begin('2026-10-12T09:00:00-04:00'), end('2026-10-12T09:10:00-04:00', 1, [attempt(1, '2026-10-12T13:00:00Z', 60, 300)]),
    begin('2026-10-13T09:00:00-04:00', 'HH-2'), end('2026-10-13T09:20:00-04:00', 2, [attempt(1, '2026-10-13T13:00:00Z', 120, 600, 'failure')], 'HH-2'),
    // the wait after a re-run records attempt 1 again: counted once, the re-run on its own day
    begin('2026-10-14T09:00:00-04:00', 'HH-2'), end('2026-10-14T09:15:00-04:00', 2, [attempt(1, '2026-10-13T13:00:00Z', 120, 600, 'failure'), attempt(2, '2026-10-14T13:00:00Z', 30, 420)], 'HH-2'),
    begin('2026-10-14T10:00:00-04:00', 'HH-3'), // still waiting: a wait, no run timed yet
    { ts: '2026-10-14T10:00:01-04:00', type: 'op.begin', actor: 'engine', data: { op: 'merge' } },
    begin('2026-10-01T09:00:00-04:00'), end('2026-10-01T09:10:00-04:00', 7, [attempt(1, '2026-10-01T13:00:00Z', 999, 999)]), // outside the window
  ];

  it('per day: waits begun, attempts timed once each, re-runs; p50/p90 of queue and run time over the window', () => {
    const r = ciAggregates(journal, { days: 7, today: '2026-10-14' });
    expect(r.days).toHaveLength(7);
    expect(r.days.slice(-3)).toEqual([
      { day: '2026-10-12', waits: 1, runs: 1, reruns: 0 },
      { day: '2026-10-13', waits: 1, runs: 1, reruns: 0 },
      { day: '2026-10-14', waits: 2, runs: 1, reruns: 1 },
    ]);
    expect(r.totals).toEqual({ waits: 4, runs: 3, reruns: 1 });
    expect(r.queue).toEqual({ p50: 60_000, p90: 120_000, n: 3 });
    expect(r.run).toEqual({ p50: 420_000, p90: 600_000, n: 3 });
  });

  it('an empty window has no percentiles', () => {
    expect(ciAggregates([], { days: 3, today: '2026-10-14' })).toMatchObject({ queue: { n: 0 }, run: { n: 0 }, totals: { waits: 0, runs: 0, reruns: 0 } });
  });
});

describe('percentile and durations', () => {
  it('nearest rank', () => {
    expect(percentile([5, 1, 4, 2, 3], 50)).toBe(3);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90)).toBe(9);
    expect(percentile([], 50)).toBeUndefined();
  });
  it('reads as a person would', () => {
    expect([formatCiDuration(42_000), formatCiDuration(65_000), formatCiDuration(3_780_000), formatCiDuration(undefined)]).toEqual(['42s', '1m 05s', '1h 03m', '–']);
  });
});
