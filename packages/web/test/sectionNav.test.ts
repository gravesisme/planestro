import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router';
import { Config, ItemFrontmatter, needsYou } from '@planestro/shared';
import type { ItemView, State } from '../src/api.ts';
import { navEntries } from '../src/components/SectionNav.tsx';

const fixture = vi.hoisted(() => ({ current: {} as any }));
vi.mock('../src/store.ts', () => ({ useStore: (selector: (s: any) => any) => selector(fixture.current), act: () => {} }));
import { ItemPage } from '../src/pages/Item.tsx';

/** A stand-in for the page's DOM: elements in page order, each with its attributes. */
const fakeRoot = (els: { id: string; attrs: Record<string, string> }[]) => ({
  querySelectorAll: () => els.map((e) => ({ id: e.id, hasAttribute: (a: string) => a in e.attrs, getAttribute: (a: string) => e.attrs[a] ?? null }) as unknown as Element),
});

describe('the item page section nav (#374)', () => {
  it('lists waiting panels first, then every section in page order, with its label', () => {
    const entries = navEntries(fakeRoot([
      { id: 'files', attrs: { 'data-nav': 'Files to review · 1294' } },
      { id: 'hold', attrs: { 'data-nav': 'Held out of the merge queue', 'data-wait': 'true' } },
      { id: 'description', attrs: { 'data-nav': 'Description' } },
      { id: 'decision', attrs: { 'data-wait': 'true' } },
      { id: 'attachments', attrs: { 'data-nav': 'Attachments · 45' } },
    ]));
    expect(entries).toEqual([
      { id: 'hold', label: 'Held out of the merge queue', wait: true },
      { id: 'decision', label: 'Your decision', wait: true },
      { id: 'files', label: 'Files to review · 1294', wait: false },
      { id: 'description', label: 'Description', wait: false },
      { id: 'attachments', label: 'Attachments · 45', wait: false },
    ]);
  });

  it('every section of the page has a stable id the nav and a link can name', () => {
    const config = Config.parse({ schema_version: 3, tool_version: '0.1.0', project: { name: 'T', id_prefix: 'TP' }, code_repo: { path: '.', default_branch: 'trunk', github: 'o/r' }, defaults: { planner: 'm', implementer: 'm', category: 'c' }, categories: ['c'], models: [{ id: 'm', label: 'M', claude_model: 'x' }] });
    const frontmatter = ItemFrontmatter.parse({ schema: 4, id: 'TP-1', title: 'Lamps', category: 'c', created_at: '2026-10-07T00:00:00Z', updated_at: '2026-10-07T00:00:00Z', status: 'IN_REVIEW', skip_merge: true, planner: 'm', implementer: 'm', attachments: [{ path: 'attachments/TP-1/a.png', kind: 'managed', added_at: '2026-10-07T00:00:00Z' }] });
    const item = { id: 'TP-1', path: 'items/TP-1.md', frontmatter, sections: { Description: '', Notes: '', Plan: '1. Do it.', Activity: '' }, activity: [], derived: { lane: 'board', needs_you: needsYou(frontmatter), external: false, flavor: 'worker', deps_satisfied: true, children: [], base_branch: 'trunk' } } as unknown as ItemView;
    fixture.current = { state: { config, local: { model_unavailable: {} }, engine: { paused: false, provider_guards: {}, sessions: [] }, items: [item], releases: [] } as unknown as State, chat: {}, consoles: {}, seedConsole: () => {} };
    const markup = renderToStaticMarkup(createElement(MemoryRouter, { initialEntries: ['/items/TP-1'] }, createElement(Routes, null, createElement(Route, { path: '/items/:id', element: createElement(ItemPage) }))));
    const ids = [...markup.matchAll(/ id="([^"]+)" data-nav="([^"]+)"/g)].map((m) => `${m[1]}:${m[2]}`);
    expect(ids).toEqual(['images:Images to review · 1', 'hold:Held out of the merge queue', 'description:Description', 'notes:Notes', 'plan-text:Plan', 'session:Session', 'console:Console', 'attachments:Attachments · 1', 'activity:Activity']);
  });
});
