import { describe, it, expect } from 'vitest';
import { testRunShape, testRunKey, stripWrappers, testWaste, efficiencyRanking, TEST_RUN, USAGE_TURN, type JournalEntry } from '../src/index.ts';

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

  it('reads past leading wrappers that do not change what runs (#396)', () => {
    const hh = { patterns: ['./tools/run_checks.sh', 'tools/run_checks.sh', 'godot --headless', 'npm test'], filters: ['--only-file'], repeat_flags: ['--stress'] };
    const whole = { whole_suite: true, load: false };
    expect(testRunShape('CHECK_JOBS=5 ./tools/run_checks.sh', hh)).toEqual(whole);
    expect(testRunShape('GODOT_LOG_DIR="$PWD/tmp/x y" CHECK_TIMEOUT=120 ./tools/run_checks.sh boss 2>&1 | tail -40', hh)).toEqual({ whole_suite: false, load: false });
    expect(testRunShape('timeout 120 godot --headless -s tests/run.gd', hh)).toEqual({ whole_suite: false, load: false });
    expect(testRunShape('timeout -k 5 -s KILL 2m godot --headless', hh)).toEqual(whole);
    expect(testRunShape('env FOO=1 npm test', hh)).toEqual(whole);
    expect(testRunShape('env -u HOME BAR=2 npm test', hh)).toEqual(whole);
    expect(testRunShape('nice -n 10 npm test', hh)).toEqual(whole);
    expect(testRunShape('time npm test', hh)).toEqual(whole);
    expect(testRunShape('command npm test', hh)).toEqual(whole);
    expect(testRunShape('exec npm test', hh)).toEqual(whole);
    expect(testRunShape('cd tools && CHECK_JOBS=8 nice timeout 10m ./tools/run_checks.sh --stress 3', hh)).toEqual({ whole_suite: true, load: true });
    // A pattern written with its wrapper, as HH's were before, still matches.
    expect(testRunShape('CHECK_JOBS=3 ./tools/run_checks.sh', { ...hh, patterns: ['CHECK_JOBS=1 ./tools/run_checks.sh'] })).toEqual(whole);
    // Not wrappers: `command -v` runs nothing, a timeout with no duration is left as written, a lone assignment runs nothing.
    expect(testRunShape('command -v npm test', hh)).toBeUndefined();
    expect(testRunShape('timeout npm test', hh)).toBeUndefined();
    expect(stripWrappers(['FOO=1'])).toEqual(['FOO=1']);
    expect(testRunShape('echo CHECK_JOBS=5 ./tools/run_checks.sh', hh)).toBeUndefined();
  });

  it('counts a wrapper-only change as the same run repeated (#396)', () => {
    expect(testRunKey('CHECK_JOBS=4 ./tools/run_checks.sh boss 2>&1 | tail')).toBe(testRunKey('CHECK_JOBS=8 timeout 300 ./tools/run_checks.sh boss | tail'));
    const waste = testWaste([
      run('2026-10-08T09:00:00-07:00', { command: 'CHECK_JOBS=4 ./tools/run_checks.sh boss', tree: 't1' }),
      run('2026-10-08T09:05:00-07:00', { command: 'CHECK_JOBS=8 ./tools/run_checks.sh boss', tree: 't1' }),
      run('2026-10-08T09:10:00-07:00', { command: './tools/run_checks.sh ruins', tree: 't1' }),
    ]).get('HH-1')!;
    expect(waste.repeats.runs).toBe(1);
  });
});
