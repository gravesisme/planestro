import { describe, it, expect } from 'vitest';
import { validateBreakdown, dependencyOrder, epicShapeOf, epicFlagOf, type BreakdownChild } from '../src/breakdown.ts';
import { findTransition, applyTransition } from '../src/transitions.ts';
import type { ItemFrontmatter } from '../src/schema.ts';

const models = [{ id: 'opus-5' }, { id: 'codex-art', runner: 'codex' as const }];
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
    expect(validateBreakdown([child({ planner: 'opus-5', hold_for_review: true })], models, cats)).toBeNull();
    expect(validateBreakdown([child({ planner: 'codex-art' })], models, cats)).toMatch(/planner "codex-art", which is not a model that can plan: opus-5/);
    expect(validateBreakdown([child({ planner: 'nobody' })], models, cats)).toMatch(/not a model that can plan/);
    expect(validateBreakdown([child({ hold_for_review: 'yes' as unknown as boolean })], models, cats)).toMatch(/true or false/);
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

describe('a plan on a plain item that is an epic breakdown (#69, HH-198)', () => {
  it('is recognised by a section of children or a table with a child column, with the reason in words', () => {
    expect(epicShapeOf('# Plan\n\n## Children\n\n- Wand icon (codex-art)\n  - 256px\n- Wand logic (fable-5)\n')).toBe('its plan has a "Children" section listing 2 child items');
    expect(epicShapeOf('## Proposed child items\n1. Icon\n2. Header\n3. Logic\n')).toBe('its plan has a "Proposed child items" section listing 3 child items');
    expect(epicShapeOf('### **Epic breakdown**\n| # | Piece | Who |\n|---|---|---|\n| 0 | Icon | art |\n| 1 | Code | claude |\n')).toBe('its plan has a "Epic breakdown" section listing 2 child items');
    expect(epicShapeOf('Intro.\n\n| # | Child | Implementer | Depends on |\n|:--|---|---|---|\n| 0 | Icon | codex-art | — |\n| 1 | Logic | fable-5 | 0 |\n')).toBe('its plan has a table of 2 child items');
    expect(epicShapeOf('| **Sub-item** | Owner |\n| --- | --- |\n| a | x |\n| b | y |\n')).toBe('its plan has a table of 2 child items');
  });
  it('is not fooled by an ordinary plan: steps, one child, a child mentioned in passing, a section that lists nothing', () => {
    expect(epicShapeOf('# Plan\n\n## Steps\n1. a\n2. b\n3. c\n\n## Files\n| File | Change |\n|---|---|\n| a.ts | x |\n| b.ts | y |\n')).toBeNull();
    expect(epicShapeOf('## Children\n- only one\n')).toBeNull();
    expect(epicShapeOf('## Child process handling\n- spawn\n- kill\n')).toBeNull();
    expect(epicShapeOf('## Children\nThe tree renders its children lazily.\n## Steps\n- a\n- b\n')).toBeNull();
    expect(epicShapeOf('| Child | x |\n|---|---|\n| only | one |\n')).toBeNull();
  });
  it('is read from op_data, and never on an epic', () => {
    const flag = { reason: 'r', source: 'plan' as const };
    expect(epicFlagOf({ kind: 'item', op_data: { looks_like_epic: flag } })).toEqual(flag);
    expect(epicFlagOf({ kind: 'epic', op_data: { looks_like_epic: flag } })).toBeUndefined();
    expect(epicFlagOf({ kind: 'item', op_data: {} })).toBeUndefined();
  });
});
