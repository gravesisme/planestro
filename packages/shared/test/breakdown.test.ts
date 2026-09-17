import { describe, it, expect } from 'vitest';
import { validateBreakdown, dependencyOrder, type BreakdownChild } from '../src/breakdown.ts';
import { findTransition, applyTransition } from '../src/transitions.ts';
import type { ItemFrontmatter } from '../src/schema.ts';

const models = [{ id: 'opus-5' }, { id: 'codex-art' }];
const cats = ['Feature', 'Bug'];
const child = (over: Partial<BreakdownChild> = {}): BreakdownChild => ({ title: 'Icon', description: 'Draw the 256px icon at assets/icon.png.', implementer: 'codex-art', ...over });

describe('epic breakdowns', () => {
  it('accepts a sane list and names the first problem otherwise', () => {
    expect(validateBreakdown([child(), child({ title: 'Code', implementer: 'opus-5', depends_on: [0], category: 'Feature' })], models, cats)).toBeNull();
    expect(validateBreakdown([], models, cats)).toMatch(/at least one/);
    expect(validateBreakdown('nope', models, cats)).toMatch(/at least one/);
    expect(validateBreakdown([child({ title: ' ' })], models, cats)).toMatch(/no title/);
    expect(validateBreakdown([child({ description: 'too short' })], models, cats)).toMatch(/stands on its own/);
    expect(validateBreakdown([child({ implementer: 'gpt-9' })], models, cats)).toMatch(/not one of: opus-5, codex-art/);
    expect(validateBreakdown([child({ category: 'Art' })], models, cats)).toMatch(/category "Art"/);
    expect(validateBreakdown([child({ depends_on: [3] })], models, cats)).toMatch(/index 3/);
    expect(validateBreakdown([child({ depends_on: [0] })], models, cats)).toMatch(/depends on itself/);
    expect(validateBreakdown([child({ depends_on: [1] }), child({ depends_on: [2] }), child({ depends_on: [0] })], models, cats)).toMatch(/cycle/);
    expect(validateBreakdown(Array.from({ length: 25 }, () => child()), models, cats)).toMatch(/too large/);
  });
  it('orders children so every dependency is created before what waits on it', () => {
    const order = dependencyOrder([child({ depends_on: [2] }), child(), child({ depends_on: [1] })]);
    expect(order).toEqual([1, 2, 0]);
  });
  it('an epic can be planned: only the user approves a breakdown, and PLAN_READY waits on breakdown_approval', () => {
    expect(findTransition('NOT_YET_SUBMITTED', 'PLAN_IN_PROGRESS', 'user', 'epic')).toBeDefined();
    expect(findTransition('NOT_YET_SUBMITTED', 'PLAN_IN_PROGRESS', 'user', 'worker')).toBeUndefined();
    expect(findTransition('PLAN_READY', 'IN_PROGRESS', 'user', 'epic')).toBeDefined();
    expect(findTransition('PLAN_READY', 'IN_PROGRESS', 'orchestrator', 'epic')).toBeUndefined();
    expect(findTransition('PLAN_READY', 'IN_PROGRESS', 'orchestrator', 'worker')).toBeDefined();
    const base: ItemFrontmatter = { schema: 1, id: 'TP-1', kind: 'epic', title: 't', category: 'c', status: 'PLAN_IN_PROGRESS', depends_on: [], attachments: [], created_at: 'x', updated_at: 'x' };
    expect(applyTransition(base, 'PLAN_READY', 'engine', 'epic', 't1').awaiting).toBe('breakdown_approval');
    expect(applyTransition({ ...base, kind: 'item' }, 'PLAN_READY', 'engine', 'worker', 't1').awaiting).toBe('plan_approval');
  });
});
