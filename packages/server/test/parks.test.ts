import { describe, it, expect } from 'vitest';
import type { JournalEntry } from '@planestro/shared';
import { commandShape, suggestedRule, parksOf, parkSummary, parkHint } from '../src/engine/parks.ts';

const e = (type: string, item: string, data: Record<string, unknown>, ts = '2026-09-29T10:00:00-04:00'): JournalEntry => ({ ts, type, item, actor: 'engine', data });

describe('what parks cost (#108)', () => {
  it('names the kind of command, and offers a worktree rule only for kinds that are safe to allow on a count', () => {
    expect(commandShape('npx tsx tools/lm-24_browser.ts smoke 2>&1 | tail -9')).toBe('npx tsx');
    expect(commandShape('npm run -s grading-check')).toBe('npm run');
    expect(commandShape('CHECK_JOBS=4 ./tools/run_checks.sh')).toBe('./tools/run_checks.sh');
    expect(commandShape('git log --oneline')).toBe('git log');
    expect(suggestedRule('npx tsx')).toBe('Bash(npx tsx *)@worktree');
    for (const risky of ['rm', 'git push', 'git reset', 'curl', 'python3', 'node', 'sh', 'gh']) expect(suggestedRule(risky), risky).toBeUndefined();
    expect(commandShape('echo `x`')).toBeUndefined();              // not read
  });

  it('joins each park to its answer and to the cost of the turn that resumed from it', () => {
    const j = [
      e('permission.parked', 'LM-24', { park: 'p1', kind: 'permission', what: 'npx tsx a.ts', shape: 'npx tsx', asked: 'user' }),
      e('permission.answered', 'LM-24', { park: 'p1', by: 'user', decision: 'allow', waited_ms: 12 * 60_000 }),
      e('op.begin', 'LM-24', { op: 'implement_turn', op_id: 'o1', resumes_park: 'p1' }),
      e('op.end', 'LM-24', { op_id: 'o1', outcome: 'ok', cost: 16.5 }),
      e('permission.parked', 'LM-24', { park: 'p2', kind: 'permission', what: 'npx tsx b.ts', shape: 'npx tsx', asked: 'orchestrator' }),
      e('op.begin', 'LM-24', { op: 'implement_turn', op_id: 'o2' }),
      e('op.end', 'LM-24', { op_id: 'o2', outcome: 'ok', cost: 3 }),   // not a resume: not counted
      e('permission.parked', 'HH-1', { park: 'p3', kind: 'question', what: 'which colour?', asked: 'user' }),
      e('permission.answered', 'HH-1', { park: 'p3', by: 'user', decision: 'answered', waited_ms: 90_000 }),
    ];
    expect(parksOf(j)).toHaveLength(3);
    const [lm, hh] = parkSummary(j);
    expect(lm).toEqual({ item: 'LM-24', parks: 2, open: 1, waited_ms: 12 * 60_000, resume_cost: 16.5, shapes: [{ shape: 'npx tsx', parks: 2, rule: 'Bash(npx tsx *)@worktree' }] });
    expect(hh).toMatchObject({ item: 'HH-1', parks: 1, open: 0, resume_cost: 0, shapes: [] });
    // the second park on a kind offers its rule, unless the project has it already
    expect(parkHint(j, 'npx tsx c.ts', [])).toEqual({ shape: 'npx tsx', parks: 2, rule: 'Bash(npx tsx *)@worktree' });
    expect(parkHint(j, 'npx tsx c.ts', ['Bash(npx tsx *)@worktree'])).toBeUndefined();
    expect(parkHint(j.slice(0, 1), 'npx tsx c.ts', [])).toBeUndefined();   // only once so far
  });
});
