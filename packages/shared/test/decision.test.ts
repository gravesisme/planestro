import { describe, it, expect } from 'vitest';
import { validateDecision, describeAction, type DecisionInput, type DecisionOption } from '../src/decision.ts';

const create = { tool: 'create_item', args: { title: 'Draw the shop icon', description: 'Draw the 256px shop icon at assets/shop.png, in the style of the others.', parent: 'TP-2', implementer: 'opus-5', submit: true } };
const card = (...options: unknown[]): DecisionInput => ({ question: 'Start a worker for the icon?', why: 'The shop screen waits for it.', options: options as DecisionOption[] });
const yes = (over: Record<string, unknown> = {}) => ({ label: 'Yes, start a worker', description: 'I create the task and queue it', recommended: true, ...over });
const no = { label: 'Not now', description: 'Leave it' };
const errorOf = (input: DecisionInput) => { const v = validateDecision(input); return v.ok ? '' : v.error; };

describe('decision cards', () => {
  it('an option keeps its action through validation, recommended first (#73)', () => {
    const v = validateDecision(card(no, yes({ action: { tool: 'create_item', args: { ...create.args, title: '  Draw the shop icon ', kind: 'item', depends_on: ['TP-3 '], note: 'dropped' } } })));
    expect(v.ok && v.value.options.map((o) => o.label)).toEqual(['Yes, start a worker', 'Not now']);
    expect(v.ok && v.value.options[0].action).toEqual({ tool: 'create_item', args: { ...create.args, depends_on: ['TP-3'] } });
    expect(v.ok && v.value.options[1].action).toBeUndefined();
    const submit = validateDecision(card(no, yes({ action: { tool: 'submit_item', args: { id: ' TP-4 ' } } })));
    expect(submit.ok && submit.value.options[0].action).toEqual({ tool: 'submit_item', args: { id: 'TP-4' } });
  });

  it('an action that is not one an option can carry is refused in a sentence, after the plainer mistakes', () => {
    expect(errorOf(card(no, yes({ action: { tool: 'approve_plan', args: { id: 'TP-1' } } })))).toMatch(/option "Yes, start a worker": its action's tool "approve_plan" is not one an option can carry: create_item, submit_item/);
    expect(errorOf(card(no, yes({ action: 'create_item' })))).toMatch(/its action must be \{ tool, args \}/);
    expect(errorOf(card(no, yes({ action: { tool: 'create_item', args: { ...create.args, title: ' ' } } })))).toMatch(/needs args\.title/);
    expect(errorOf(card(no, yes({ action: { tool: 'create_item', args: { title: 'Icon' } } })))).toMatch(/needs args\.description, a complete brief/);
    expect(errorOf(card(no, yes({ action: { tool: 'create_item', args: { ...create.args, kind: 'story' } } })))).toMatch(/kind is "item" or "epic"/);
    expect(errorOf(card(no, yes({ action: { tool: 'create_item', args: { ...create.args, parent: 7 } } })))).toMatch(/parent must be a name/);
    expect(errorOf(card(no, yes({ action: { tool: 'create_item', args: { ...create.args, depends_on: 'TP-3' } } })))).toMatch(/depends_on is a list of item ids/);
    expect(errorOf(card(no, yes({ action: { tool: 'submit_item', args: {} } })))).toMatch(/needs args\.id/);
    expect(errorOf(card(no, yes({ action: create, raise_budget_usd: 40 })))).toMatch(/has both raise_budget_usd and an action: an option does one thing/);
    expect(errorOf(card(no, yes({ action: create, fresh: true })))).toMatch(/has both fresh and an action/);
    expect(errorOf(card(no, yes({ action: { tool: 'nope' }, recommended: false })))).toMatch(/mark exactly one option recommended/);
  });

  it('describeAction says what the tap does, from the action itself', () => {
    const items: Record<string, { title: string; kind?: 'item' | 'epic' }> = { 'TP-4': { title: 'Shop screen', kind: 'epic' }, 'TP-5': { title: 'Fix the door', kind: 'item' } };
    const lookup = (id: string) => items[id];
    expect(describeAction(create as never)).toBe('creates the item "Draw the shop icon" in epic TP-2, implemented by opus-5 and queues it for planning');
    expect(describeAction({ tool: 'create_item', args: { title: 'Shop', description: 'x', kind: 'epic', submit: true } })).toBe('creates the epic "Shop" and has its breakdown planned (you approve its children)');
    expect(describeAction({ tool: 'create_item', args: { title: 'Later', description: 'x', depends_on: ['TP-3'] } })).toBe('creates the item "Later", after TP-3, not submitted yet');
    expect(describeAction({ tool: 'submit_item', args: { id: 'TP-4' } }, lookup)).toBe('has the breakdown of epic TP-4 "Shop screen" planned (you approve its children)');
    expect(describeAction({ tool: 'submit_item', args: { id: 'TP-5' } }, lookup)).toBe('queues TP-5 "Fix the door" for planning');
    expect(describeAction({ tool: 'submit_item', args: { id: 'TP-9' } })).toBe('queues TP-9 for planning');
  });
});
