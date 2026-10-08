import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router';
import { Config, ItemFrontmatter } from '@planestro/shared';
import type { ItemView, State } from '../src/api.ts';
import { itemWait } from '../../server/src/engine/needsYou.ts';
import { notificationPath, waitTarget } from '../src/deepLink.ts';

const fixture = vi.hoisted(() => ({ current: {} as any }));
vi.mock('../src/store.ts', () => ({ useStore: (selector: (s: any) => any) => selector(fixture.current), act: () => {} }));
import { ItemPage } from '../src/pages/Item.tsx';

describe('deep links that open straight to the decision (#226)', () => {
  it("a notification opens its link's path and fragment in this tab, whatever host the link names", () => {
    expect(notificationPath({ item: 'TP-1', data: { url: 'http://studio.lan:4300/items/TP-1#plan' } })).toBe('/items/TP-1#plan');
    expect(notificationPath({ item: 'TP-1', data: { url: 'http://127.0.0.1:4300/questions/Q-3' } })).toBe('/questions/Q-3');
    expect(notificationPath({ item: 'TP-1', data: { event: 'on_merge' } })).toBe('/items/TP-1'); // a merge: its item
    expect(notificationPath({ data: { event: 'on_usage_pause' } })).toBeUndefined();
  });

  it('the fragment names the element; a fragment that names nothing here lands on what the page waits for now', () => {
    const els: Record<string, string> = { plan: 'the plan panel', audition: 'a panel added later' };
    const root = { getElementById: (id: string) => (els[id] ?? null) as unknown as Element, querySelector: (sel: string) => (sel === '[data-wait]' ? 'first waiting panel' : null) as unknown as Element };
    expect(waitTarget(root, '#plan', true)).toBe('the plan panel');
    expect(waitTarget(root, '#audition', true)).toBe('a panel added later');
    expect(waitTarget(root, '#decision', true)).toBe('first waiting panel');
    expect(waitTarget(root, '#decision', false)).toBeNull();
    expect(waitTarget(root, '', true)).toBe('first waiting panel');
  });

  const config = Config.parse({ schema_version: 3, tool_version: '0.1.0', project: { name: 'T', id_prefix: 'TP' }, code_repo: { path: '.', default_branch: 'trunk', github: 'o/r' }, defaults: { planner: 'm', implementer: 'm', category: 'c' }, categories: ['c'], models: [{ id: 'm', label: 'M', claude_model: 'x' }] });
  const page = (fields: Record<string, unknown>): { kind: string | undefined; markup: string } => {
    const frontmatter = ItemFrontmatter.parse({ schema: 4, id: 'TP-1', title: 'Lamps', category: 'c', created_at: '2026-10-07T00:00:00Z', updated_at: '2026-10-07T00:00:00Z', status: 'IN_PROGRESS', planner: 'm', implementer: 'm', ...fields });
    const item = {
      id: 'TP-1', path: 'items/TP-1.md', frontmatter,
      sections: { Description: '', Notes: '', Plan: '1. Do it.', Activity: '' }, activity: [],
      derived: { lane: 'board', needs_you: true, external: false, flavor: 'worker', deps_satisfied: true, children: [], base_branch: 'trunk' },
    } as unknown as ItemView;
    fixture.current = { state: { config, local: { model_unavailable: {} }, engine: { paused: false, provider_guards: {}, sessions: [] }, items: [item], releases: [] } as unknown as State, chat: {}, consoles: {}, seedConsole: () => {} };
    const markup = renderToStaticMarkup(createElement(MemoryRouter, { initialEntries: ['/items/TP-1'] }, createElement(Routes, null, createElement(Route, { path: '/items/:id', element: createElement(ItemPage) }))));
    return { kind: itemWait(frontmatter)?.kind, markup };
  };
  beforeEach(() => { fixture.current = {}; });

  it.each([
    ['plan', { status: 'PLAN_READY', awaiting: 'plan_approval' }],
    ['breakdown', { status: 'PLAN_READY', kind: 'epic', awaiting: 'breakdown_approval' }],
    ['permission', { awaiting: 'permission', awaiting_data: { tool: 'Bash', input: { command: 'make' } } }],
    ['question', { awaiting: 'question', awaiting_data: { questions: [{ question: 'Which?', options: [] }] } }],
    ['decision', { awaiting: 'user', awaiting_data: { decision: { question: 'Which way?', why: 'Two ways.', options: [{ label: 'Left' }], requested_at: '2026-10-07T00:00:00Z' } } }],
    ['blocked', { blocked: true, blocked_reason: 'ci_red', awaiting: 'user' }],
    ['review', { status: 'IN_REVIEW', awaiting: 'review' }],
    ['hold', { status: 'IN_REVIEW', skip_merge: true, hold_reason: 'for the designer' }],
  ])("the item page holds the panel a '#%s' link names, marked as waiting on you", (kind, fields) => {
    const { kind: notified, markup } = page(fields);
    expect(notified).toBe(kind); // the fragment the server's notification uses
    expect(markup).toMatch(new RegExp(`<div[^>]* id="${kind}" data-wait="true"`));
  });
});
