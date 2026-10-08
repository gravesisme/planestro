import { beforeEach, describe, expect, it } from 'vitest';
import { ItemFrontmatter, ModelDef } from '@planestro/shared';
import type { ItemView, State } from '../src/api.ts';
import { agentStateOf, runningItems } from '../src/agentState.ts';

let item: ItemView;
let state: State;
beforeEach(() => {
  item = {
    id: 'TP-1', path: 'items/TP-1.md',
    frontmatter: ItemFrontmatter.parse({
      schema: 4, id: 'TP-1', title: 'Synthetic', category: 'Tools', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
      status: 'PLAN_IN_PROGRESS', op: 'planning_turn', planner: 'primary', implementer: 'primary',
    }),
    sections: { Description: '', Notes: '', Plan: '', Activity: '' }, activity: [],
    derived: { lane: 'board', needs_you: false, external: false, flavor: 'worker', deps_satisfied: true, children: [] },
  };
  state = {
    config: { models: [ModelDef.parse({ id: 'primary', label: 'Primary', claude_model: 'test-primary' })] },
    local: { model_unavailable: {} },
    engine: { paused: false, provider_guards: {}, sessions: [] }, items: [item],
  } as unknown as State;
});
const pending = () => { item.frontmatter.op_data = { pending_turn: { key: 'k', phase: 'plan', prompt: 'p' } }; };

describe('the board tells an agent running from one waiting (#299)', () => {
  it('a busy session is running, with its phase and last output', () => {
    state.engine.sessions = [{ item: 'TP-1', op: 'plan', busy: true, last_output: 'Reading src/board.ts' }];
    expect(agentStateOf(item, state)).toEqual({ kind: 'running', label: 'planning…', output: 'Reading src/board.ts' });
    state.engine.sessions = [{ item: 'TP-1', op: 'implement', busy: true }];
    expect(agentStateOf(item, state)).toMatchObject({ kind: 'running', label: 'implementing…' });
    pending(); // a busy session wins over a saved instruction still on file
    expect(agentStateOf(item, state)?.kind).toBe('running');
  });

  it('a turn holding its instruction for a session slot is waiting for a slot, with the reason', () => {
    pending();
    expect(agentStateOf(item, state)).toEqual({ kind: 'slot', reason: expect.stringContaining('session slot') });
    delete item.frontmatter.op_data;
    state.engine.sessions = [{ item: 'TP-1', op: 'plan: waiting for a claude slot', busy: false }];
    expect(agentStateOf(item, state)).toEqual({ kind: 'slot', reason: expect.stringContaining('waiting for a claude slot') });
  });

  it('other saved-instruction waits keep their own reason', () => {
    pending();
    state.engine.paused = true;
    expect(agentStateOf(item, state)).toEqual({ kind: 'wait', reason: 'Waiting for automation to resume.' });
    state.engine.paused = false;
    item.frontmatter.planner = 'removed-model';
    expect(agentStateOf(item, state)).toMatchObject({ kind: 'wait', reason: expect.stringContaining('no longer configured') });
  });

  it('nothing to say when no session or saved instruction is there', () => {
    expect(agentStateOf(item, state)).toBeUndefined();
    expect(agentStateOf(item, null)).toBeUndefined();
  });

  it('lists the items with an agent running, in the order of the sessions', () => {
    const other = { ...item, id: 'TP-2' };
    state.items = [item, other];
    state.engine.sessions = [{ item: 'TP-2', op: 'implement', busy: true }, { item: 'TP-1', op: 'plan: waiting for a claude slot', busy: false }, { item: 'TP-9', op: 'plan', busy: true }];
    expect(runningItems(state).map((r) => [r.item?.id, r.session.item])).toEqual([['TP-2', 'TP-2'], [undefined, 'TP-9']]);
  });
});
