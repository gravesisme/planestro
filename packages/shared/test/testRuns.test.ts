import { describe, it, expect } from 'vitest';
import { testRunShape, testWaste, efficiencyRanking, TEST_RUN, USAGE_TURN, type JournalEntry } from '../src/index.ts';

const cfg = { patterns: ['npm test', './tools/run_checks.sh', 'Bash(npx vitest run *)'], filters: ['--only-file', '--shard', '-t'], repeat_flags: ['--repeat', '--stress'] };

describe('test runs (#347)', () => {
  it('knows a test command, and whether it runs the whole suite or a load pass', () => {
    expect(testRunShape('ls -la', cfg)).toBeUndefined();
    expect(testRunShape('npm test', cfg)).toEqual({ whole_suite: true, load: false });
    expect(testRunShape('cd pkg && npm test 2>&1 | tail -20', cfg)).toEqual({ whole_suite: true, load: false });
    expect(testRunShape('npm test -- packages/a.test.ts', cfg)).toEqual({ whole_suite: false, load: false });
    expect(testRunShape('./tools/run_checks.sh boss_fight', cfg)).toEqual({ whole_suite: false, load: false });
    expect(testRunShape('./tools/run_checks.sh --shard 2/4', cfg)).toEqual({ whole_suite: false, load: false });
    expect(testRunShape('./tools/run_checks.sh --only-file=x.gd', cfg)).toEqual({ whole_suite: false, load: false });
    expect(testRunShape('./tools/run_checks.sh --stress 20', cfg)).toEqual({ whole_suite: true, load: true });
    expect(testRunShape('./tools/run_checks.sh boss --repeat 5', cfg)).toEqual({ whole_suite: false, load: true });
    expect(testRunShape('npx vitest run a.test.ts', cfg)).toEqual({ whole_suite: false, load: false });
    expect(testRunShape('npm testing', cfg)).toBeUndefined();
  });

  const run = (ts: string, data: Record<string, unknown>): JournalEntry => ({ ts, type: TEST_RUN, item: 'HH-1', actor: 'engine', data: { ok: true, ms: 60_000, whole_suite: false, load: false, source: 'bash', ...data } });
  const turn = (ts: string, usd: number): JournalEntry => ({ ts, type: USAGE_TURN, item: 'HH-1', actor: 'engine', data: { provider: 'claude', model: 'opus', role: 'worker', op: 'implement_turn', usd, subtype: 'success' } });

  it('counts whole-suite runs, repeats on a tree unchanged since a green run, load repeats, and the turns they fell in', () => {
    const entries: JournalEntry[] = [
      run('2026-10-08T09:00:00-07:00', { command: 'npm test -- a', tree: 't1', ok: false }),
      // Red before: running it again on the same tree is not a repeat after green.
      run('2026-10-08T09:05:00-07:00', { command: 'npm test -- a', tree: 't1' }),
      turn('2026-10-08T09:10:00-07:00', 4),
      run('2026-10-08T10:00:00-07:00', { command: 'npm test -- a', tree: 't1' }),
      run('2026-10-08T10:01:00-07:00', { command: 'npm test -- a', tree: 't2' }),
      run('2026-10-08T10:02:00-07:00', { command: 'npm test', tree: 't2', whole_suite: true, ms: 300_000 }),
      run('2026-10-08T10:03:00-07:00', { command: 'run --stress', tree: 't2', load: true, whole_suite: true }),
      run('2026-10-08T10:04:00-07:00', { command: 'run --stress 9', tree: 't2', load: true }),
      // No tree read: never a repeat.
      run('2026-10-08T10:05:00-07:00', { command: 'npm test -- a' }),
      turn('2026-10-08T10:10:00-07:00', 2),
      turn('2026-10-08T11:10:00-07:00', 8),
    ];
    const w = testWaste(entries).get('HH-1')!;
    expect(w).toMatchObject({ runs: 8, whole_suite: { runs: 2, ms: 360_000 }, repeats: { runs: 1, ms: 60_000 }, load_repeats: { runs: 1 }, wasted: { runs: 4, ms: 480_000 }, turn_usd: 2 });
    const r = efficiencyRanking(entries, { days: 1, today: '2026-10-08' });
    expect(r.wasted_runs).toEqual([expect.objectContaining({ item: 'HH-1', wasted: { runs: 4, ms: 480_000 } })]);
    expect(r.items[0].test_runs?.runs).toBe(8);
  });
});
