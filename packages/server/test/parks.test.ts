import { describe, it, expect } from 'vitest';
import type { JournalEntry } from '@planestro/shared';
import { commandShape, suggestedRule, parksOf, parkSummary, parkHint, rulingText, parkedRefusal } from '../src/engine/parks.ts';

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

  it('states a ruling outright, and refuses report_blocked only while a permission is parked (#168)', () => {
    const bash = { tool: 'Bash', input: { command: 'npm run check' } };
    expect(rulingText(bash, 'allow', 'The orchestrator')).toBe('APPROVED: The orchestrator approved your command `npm run check`. Run it now, as it was; it is allowed. Then continue.');
    // #297: a plain denial forbids any rewrite; a denial that says what to do instead authorizes that, and only that
    expect(rulingText(bash, 'deny', 'The user')).toBe('DENIED: The user denied your command `npm run check`. Do not retry it in another form (a rewritten command, a script, another tool to the same effect). Continue without it, or call report_blocked if you cannot.');
    expect(rulingText(bash, 'deny', 'The orchestrator', 'submit a safer command that only reads the log')).toBe('DENIED: The orchestrator denied your command `npm run check`: submit a safer command that only reads the log. This exact command is denied: do not run it again, reworded or by another route (a script, another tool to the same effect). That does not forbid what the ruling asks for: where it says what to do instead, a safer or different command included, do that. You are authorized to propose it, and it is judged on its own. Continue, or call report_blocked if you cannot.');
    expect(rulingText({ tool: 'WebFetch', input: { url: 'https://x' } }, 'always', 'The user')).toContain('approved your WebFetch {"url":"https://x"} call');
    expect(parkedRefusal({ awaiting: 'permission', awaiting_data: { tool: 'Bash', input: { command: 'ls' } } })).toMatch(/^Not recorded: you are parked on `ls`; wait\./);
    expect(parkedRefusal({ awaiting: 'orchestrator', awaiting_data: { kind: 'permission', tool: 'Bash', input: { command: 'ls' } } })).toBeDefined();
    expect(parkedRefusal({ awaiting: 'orchestrator' })).toBeUndefined();            // a plan review handed over is not a park
    expect(parkedRefusal({ awaiting: 'question', awaiting_data: { questions: [] } })).toBeUndefined();
    expect(parkedRefusal({})).toBeUndefined();
  });
});
