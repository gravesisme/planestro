import { beforeEach, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { ItemFrontmatter, ModelDef } from '@planestro/shared';
import type { ItemView, State } from '../src/api.ts';
import { pendingTurnWait } from '../src/pendingTurn.ts';

const fixture = vi.hoisted(() => ({ current: {} as any }));
vi.mock('../src/store.ts', () => ({ useStore: (selector: (s: any) => any) => selector(fixture.current), act: () => {} }));
import { ItemCard } from '../src/components/ItemCard.tsx';

let item: ItemView;
let state: State;
const outage = { since: '2026-01-01T00:00:00Z', until: '2999-01-01T00:00:00Z', reason: 'usage limit' };
beforeEach(() => {
  item = {
    id: 'TP-1', path: 'items/TP-1.md',
    frontmatter: ItemFrontmatter.parse({
      schema: 4, id: 'TP-1', title: 'Synthetic saved instruction', category: 'Tools',
      created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', status: 'IN_PROGRESS',
      planner: 'primary', implementer: 'primary',
      op_data: { pending_turn: { key: 'saved', phase: 'implement', prompt: 'Private instruction content', extraAllowed: ['private permission'] } },
    }),
    sections: { Description: '', Notes: '', Plan: '', Activity: '' }, activity: [],
    derived: { lane: 'board', needs_you: false, external: false, flavor: 'worker', deps_satisfied: true, children: [] },
  };
  state = {
    config: { models: [
      ModelDef.parse({ id: 'primary', label: 'Primary', claude_model: 'test-primary', fallback: 'backup' }),
      ModelDef.parse({ id: 'backup', label: 'Backup', claude_model: 'test-backup' }),
    ] },
    local: { model_unavailable: {} },
    engine: { paused: false, provider_guards: {}, sessions: [] }, items: [item],
  } as unknown as State;
  fixture.current = { state };
});
const render = () => renderToStaticMarkup(createElement(MemoryRouter, null, createElement(ItemCard, { item, sortable: false })));

it('shows a saved instruction on its card until it is admitted, without displaying its prompt or rules', () => {
  const markup = render();
  expect(markup).toContain('waiting for a slot');
  expect(markup).not.toContain('waiting: saved instruction');
  expect(markup).toContain('session slot');
  expect(markup).not.toContain('Private instruction content');
  expect(markup).not.toContain('private permission');
  delete item.frontmatter.op_data!.pending_turn;
  expect(render()).not.toContain('waiting for a slot');
});

it.each(['phase', 'model', 'usage'] as const)('explains a saved instruction waiting on its %s', (reason) => {
  if (reason === 'phase') item.frontmatter.status = 'PLAN_IN_PROGRESS';
  if (reason === 'model') item.frontmatter.implementer = 'removed-model';
  if (reason === 'usage') state.local.model_unavailable = { primary: outage };
  const markup = render();
  expect(markup).toContain('waiting: saved instruction');
  expect(markup).toContain(reason === 'phase' ? 'does not match this item' : reason === 'model' ? 'no longer configured' : 'Waiting for model usage');
});

it('recognizes an available fallback while keeping the provider pause authoritative', () => {
  state.local.model_unavailable = { primary: outage };
  item.frontmatter.allow_model_fallback = true;
  expect(pendingTurnWait(item.frontmatter, state)).toContain('session slot');
  state.engine.provider_guards = { claude: { tripped_at: outage.since, window: 'five_hour', status: 'rejected' } };
  expect(pendingTurnWait(item.frontmatter, state)).toBe('Waiting for the claude usage pause to end.');
  state.engine.provider_guards = {};
  state.local.model_unavailable.backup = outage;
  expect(pendingTurnWait(item.frontmatter, state)).toContain('Waiting for model usage');
});

it('marks a card whose session is busy as running, its last output a tap away (#299)', () => {
  state.engine.sessions = [{ item: 'TP-1', op: 'implement', busy: true, last_output: 'Editing board.ts' }];
  const markup = render();
  expect(markup).toContain('implementing…');
  expect(markup).toContain('Editing board.ts');
  expect(markup).toMatch(/class="card [^"]*running/);
  expect(markup).not.toContain('waiting for a slot');
});

it('explains global pause and restart waits without discarding the instruction', () => {
  state.engine.paused = true;
  expect(render()).toContain('Waiting for automation to resume.');
  state.engine.paused = false;
  state.engine.restart = { draining: true, idle: false, running: [] };
  expect(render()).toContain('Waiting for the restart to finish.');
});
