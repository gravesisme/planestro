import { beforeEach, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { ItemFrontmatter } from '@planestro/shared';
import type { ItemView, State } from '../src/api.ts';
import { afterChoices, columnOf, stepMove } from '../src/reorder.ts';

const fixture = vi.hoisted(() => ({ current: {} as any }));
vi.mock('../src/store.ts', () => ({ useStore: (selector: (s: any) => any) => selector(fixture.current), act: () => {} }));
import { ItemCard } from '../src/components/ItemCard.tsx';

const view = (id: string, extra: Record<string, unknown> = {}): ItemView => ({
  id, path: `items/${id}.md`,
  frontmatter: ItemFrontmatter.parse({
    schema: 4, id, title: `Item ${id}`, category: 'Tools', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
    status: 'NOT_YET_SUBMITTED', planner: 'primary', implementer: 'primary', ...extra,
  }),
  sections: { Description: '', Notes: '', Plan: '', Activity: '' }, activity: [],
  derived: { lane: 'board', needs_you: false, external: false, flavor: 'worker', deps_satisfied: true, children: [] },
} as unknown as ItemView);

// The order the server lists them in: priority band first, then rank (#194).
let items: ItemView[];
beforeEach(() => {
  items = [view('T-1', { priority: 'high' }), view('T-2'), view('T-3'), view('T-4'), view('T-5', { status: 'QUEUED' }), view('T-6', { status: 'ICEBOX' })];
  items[5]!.derived.lane = 'icebox';
  fixture.current = { state: { config: { models: [] }, local: { model_unavailable: {} }, engine: { paused: false, provider_guards: {}, sessions: [] }, items } as unknown as State };
});

it('a column is the items of the same lane and status, in the order the server lists them', () => {
  expect(columnOf(items, items[2]!).map((i) => i.id)).toEqual(['T-1', 'T-2', 'T-3', 'T-4']);
});

it('moves an item up or down one place, within its priority band', () => {
  const col = columnOf(items, items[2]!);
  expect(stepMove(col, 'T-3', 'up')).toEqual({ op: 'before', ref: 'T-2' });
  expect(stepMove(col, 'T-3', 'down')).toEqual({ op: 'after', ref: 'T-4' });
  expect(stepMove(col, 'T-4', 'down')).toBeUndefined();
  // T-2 is already at its band's top: the high item above it is another band.
  expect(stepMove(col, 'T-2', 'up')).toBeUndefined();
  expect(stepMove(col, 'T-1', 'down')).toBeUndefined();
});

it('Move after… offers the items of its band it is not already directly after', () => {
  const col = columnOf(items, items[3]!);
  expect(afterChoices(col, 'T-4').map((i) => i.id)).toEqual(['T-2']);
  expect(afterChoices(col, 'T-2').map((i) => i.id)).toEqual(['T-3', 'T-4']);
  expect(afterChoices(col, 'T-1')).toEqual([]);
});

const render = (sortable: boolean) => renderToStaticMarkup(createElement(MemoryRouter, null, createElement(ItemCard, { item: items[1]!, sortable })));

it('a sortable card has a drag handle that touch can drag without scrolling the page', () => {
  expect(render(true)).toMatch(/<span[^>]*class="drag-handle"[^>]*aria-label="Drag T-2 to reorder"/);
  expect(render(false)).not.toContain('drag-handle');
});
