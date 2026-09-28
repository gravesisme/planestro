import { describe, it, expect } from 'vitest';
import { applyTransition, findTransition, flavorOf, laneOf, needsYou, baseBranchOf, depsSatisfied, TRANSITIONS, allowedTransitions, kindConversionRefusal } from '../src/transitions.ts';
import { STATUSES, type ItemFrontmatter } from '../src/schema.ts';

const base: ItemFrontmatter = { schema: 1, id: 'HH-1', kind: 'item', title: 't', category: 'c', status: 'NOT_YET_SUBMITTED', depends_on: [], attachments: [], created_at: '2026-01-01T00:00:00+00:00', updated_at: '2026-01-01T00:00:00+00:00' };
const models = [{ id: 'fable-5', label: 'F', external: false }, { id: 'codex', label: 'C', external: true }];

describe('transitions', () => {
  it('user queue sets queued_at; engine-only rows reject the user', () => {
    const q = applyTransition(base, 'QUEUED', 'user', 'worker', '2026-01-02T00:00:00+00:00');
    expect(q.status).toBe('QUEUED');
    expect(q.queued_at).toBe('2026-01-02T00:00:00+00:00');
    expect(() => applyTransition(q, 'PLAN_IN_PROGRESS', 'user', 'worker', 'x')).toThrow(/may not/);
    const p = applyTransition(q, 'PLAN_IN_PROGRESS', 'engine', 'worker', '2026-01-03T00:00:00+00:00');
    expect(p.started_at).toBe('2026-01-03T00:00:00+00:00');
  });
  it('PLAN_READY sets awaiting; approval clears it and sets plan_approved_at; finish drops worktree', () => {
    let fm: ItemFrontmatter = { ...base, status: 'PLAN_IN_PROGRESS' };
    fm = applyTransition(fm, 'PLAN_READY', 'engine', 'worker', 't1');
    expect(fm.awaiting).toBe('plan_approval');
    fm = applyTransition(fm, 'IN_PROGRESS', 'user', 'worker', 't2');
    expect(fm.awaiting).toBeUndefined();
    expect(fm.plan_approved_at).toBe('t2');
    fm = applyTransition({ ...fm, status: 'MERGED', worktree: 'wt', op: 'cleaning_up' }, 'FINISHED', 'engine', 'worker', 't3');
    expect(fm.worktree).toBeUndefined();
    expect(fm.op).toBeUndefined();
    expect(fm.finished_at).toBe('t3');
  });
  it('epics and external items start straight from NOT_YET_SUBMITTED; workers cannot', () => {
    expect(findTransition('NOT_YET_SUBMITTED', 'IN_PROGRESS', 'user', 'epic')).toBeDefined();
    expect(findTransition('NOT_YET_SUBMITTED', 'IN_PROGRESS', 'user', 'external')).toBeDefined();
    expect(findTransition('NOT_YET_SUBMITTED', 'IN_PROGRESS', 'user', 'worker')).toBeUndefined();
    expect(findTransition('NOT_YET_SUBMITTED', 'QUEUED', 'user', 'epic')).toBeUndefined();
  });
  it('every status except FINISHED/MERGED has an exit and the table only names real statuses', () => {
    for (const t of TRANSITIONS) { expect(STATUSES).toContain(t.from); expect(STATUSES).toContain(t.to); }
    for (const s of STATUSES) if (s !== 'MERGED') expect(TRANSITIONS.some((t) => t.from === s), `${s} has no exit`).toBe(true);
    expect(allowedTransitions('ICEBOX', 'user', 'worker').map((t) => t.to).sort()).toEqual(['FINISHED', 'NOT_YET_SUBMITTED', 'QUEUED']);
  });
  it('close as done: the user alone, never past a pull request, and it clears a block', () => {
    for (const from of ['NOT_YET_SUBMITTED', 'ICEBOX', 'QUEUED', 'PLAN_IN_PROGRESS', 'PLAN_READY', 'IN_PROGRESS'] as const) {
      expect(findTransition(from, 'FINISHED', 'user', 'worker'), from).toBeDefined();
      expect(findTransition(from, 'FINISHED', 'orchestrator', 'worker'), from).toBeUndefined();
      expect(findTransition(from, 'FINISHED', 'engine', 'worker'), from).toBeUndefined();
    }
    expect(findTransition('IN_REVIEW', 'FINISHED', 'user', 'worker')).toBeUndefined();
    expect(findTransition('MERGED', 'FINISHED', 'user', 'worker')).toBeUndefined();
    expect(findTransition('IN_PROGRESS', 'FINISHED', 'user', 'epic')).toBeUndefined();
    const fm = applyTransition({ ...base, status: 'IN_PROGRESS', blocked: true, blocked_reason: 'no_commits', awaiting: 'user', worktree: 'wt', op_data: { done_summary: 'x' } }, 'FINISHED', 'user', 'worker', 't9');
    expect(fm).toMatchObject({ status: 'FINISHED', finished_at: 't9' });
    for (const k of ['blocked', 'blocked_reason', 'awaiting', 'worktree', 'op_data'] as const) expect(fm[k], k).toBeUndefined();
  });
  it('derived values', () => {
    expect(flavorOf({ kind: 'item', implementer: 'codex' }, models)).toBe('external');
    expect(flavorOf({ kind: 'epic', implementer: 'fable-5' }, models)).toBe('epic');
    expect(laneOf('ICEBOX')).toBe('icebox'); expect(laneOf('FINISHED')).toBe('done'); expect(laneOf('QUEUED')).toBe('board');
    expect(needsYou({ blocked: true })).toBe(true);
    expect(needsYou({ awaiting: 'orchestrator' })).toBe(false);
    expect(needsYou({ awaiting: 'question' })).toBe(true);
    expect(baseBranchOf({}, undefined, 'develop')).toBe('develop');
    expect(baseBranchOf({ parent: 'HH-9' }, { branch: 'feature/x' }, 'develop')).toBe('feature/x');
    expect(baseBranchOf({ parent: 'HH-9', base_branch_override: 'release/1' }, { branch: 'feature/x' }, 'develop')).toBe('release/1');
    expect(() => baseBranchOf({ parent: 'HH-9' }, { }, 'develop')).toThrow(/integration branch/);
    const lookup = (id: string) => ({ 'A': { status: 'MERGED' as const }, 'B': { status: 'IN_REVIEW' as const } } as any)[id];
    expect(depsSatisfied({ depends_on: ['A'] }, lookup)).toBe(true);
    expect(depsSatisfied({ depends_on: ['A', 'B'] }, lookup)).toBe(false);
    expect(depsSatisfied({ depends_on: ['Z'] }, lookup)).toBe(false);
  });
});

describe('item ↔ epic conversion (#69, HH-198)', () => {
  const at = (over: Partial<ItemFrontmatter>) => ({ ...base, ...over });
  it('is allowed while nothing has run for implementation', () => {
    for (const status of ['NOT_YET_SUBMITTED', 'ICEBOX', 'QUEUED', 'PLAN_IN_PROGRESS', 'PLAN_READY'] as const) expect(kindConversionRefusal(at({ status }), 'epic', 0), status).toBeNull();
    for (const status of ['NOT_YET_SUBMITTED', 'ICEBOX', 'PLAN_IN_PROGRESS', 'PLAN_READY'] as const) expect(kindConversionRefusal(at({ kind: 'epic', status }), 'item', 0), status).toBeNull();
  });
  it('is refused, with the reason, once work or structure exists', () => {
    expect(kindConversionRefusal(at({ status: 'IN_PROGRESS' }), 'epic', 0)).toMatch(/HH-1 is IN_PROGRESS: only NOT_YET_SUBMITTED, ICEBOX, QUEUED/);
    expect(kindConversionRefusal(at({ status: 'ICEBOX', plan_approved_at: '2026-01-02T10:00:00+00:00' }), 'epic', 0)).toBe("HH-1's plan was approved (2026-01-02 10:00): implementation has run");
    expect(kindConversionRefusal(at({ pr: 7 }), 'epic', 0)).toMatch(/pull request #7/);
    expect(kindConversionRefusal(at({ kind: 'epic' }), 'item', 2)).toBe('HH-1 has 2 child items: an epic with children stays an epic');
    expect(kindConversionRefusal(at({ kind: 'epic', status: 'IN_PROGRESS' }), 'item', 0)).toMatch(/is IN_PROGRESS/);
    expect(kindConversionRefusal(at({ parent: 'HH-9' }), 'epic', 0)).toBe('HH-1 is a child of HH-9, and epics do not nest');
    expect(kindConversionRefusal(at({ taken_over: { since: 'x' } }), 'epic', 0)).toMatch(/taken over/);
    expect(kindConversionRefusal(at({ status: 'PLAN_IN_PROGRESS', op: 'creating_worktree' }), 'epic', 0)).toMatch(/step running \(creating worktree\)/);
    expect(kindConversionRefusal(at({}), 'item', 0)).toBe('HH-1 is already an item');
  });
});
