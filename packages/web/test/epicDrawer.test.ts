import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { Config, ItemFrontmatter } from '@planestro/shared';
import type { ItemView, State } from '../src/api.ts';

const fixture = vi.hoisted(() => ({ current: {} as any }));
vi.mock('../src/store.ts', () => ({ useStore: (selector: (s: any) => any) => selector(fixture.current), act: () => {} }));
import { PreviewDrawer } from '../src/components/PreviewDrawer.tsx';

/**
 * #290: the board's quick view of an epic looked like any item's: nothing said it was an epic, and its children were only
 * on the full page. The drawer marks an epic as one, with its merged count, and lists its children as the page does.
 */
const config = Config.parse({ schema_version: 3, tool_version: '0.1.0', project: { name: 'T', id_prefix: 'TP' }, code_repo: { path: '.', default_branch: 'trunk', github: 'o/r' }, defaults: { planner: 'm', implementer: 'm', category: 'c' }, categories: ['c'], models: [{ id: 'm', label: 'M', claude_model: 'x' }] });
const view = (id: string, fields: Record<string, unknown>, children: string[] = []) => ({
  id, path: `items/${id}.md`,
  frontmatter: ItemFrontmatter.parse({ schema: 4, id, title: `${id} title`, category: 'c', created_at: '2026-10-07T00:00:00Z', updated_at: '2026-10-07T00:00:00Z', status: 'NOT_YET_SUBMITTED', planner: 'm', implementer: 'm', ...fields }),
  sections: { Description: 'Do it.', Notes: '', Plan: '', Activity: '' }, activity: [],
  derived: { lane: 'board', needs_you: false, external: false, flavor: fields.kind === 'epic' ? 'epic' : 'worker', deps_satisfied: true, children, base_branch: 'trunk' },
}) as unknown as ItemView;

function drawer(id: string, items: ItemView[]): string {
  fixture.current = { state: { config, local: { model_unavailable: {} }, engine: { paused: false, provider_guards: {}, sessions: [] }, items, releases: [] } as unknown as State, chat: {}, consoles: {}, seedConsole: () => {} };
  return renderToStaticMarkup(createElement(MemoryRouter, null, createElement(PreviewDrawer, { id, onClose: () => {} })));
}

describe("the board's quick view of an epic (#290)", () => {
  const items = [
    view('TP-1', { kind: 'epic', status: 'IN_PROGRESS', branch: 'feature/x' }, ['TP-2', 'TP-3', 'TP-4']),
    view('TP-2', { parent: 'TP-1', status: 'FINISHED', pr: 7 }),
    view('TP-3', { parent: 'TP-1' }),
    view('TP-4', { parent: 'TP-1', depends_on: ['TP-3'] }),
  ];

  it('says it is an epic, with its merged count', () => {
    expect(drawer('TP-1', items)).toMatch(/<span class="pill epic">EPIC 1\/3<\/span>/);
  });

  it("lists its children as the page does: status, PR, Queue, and what one waits on", () => {
    const html = drawer('TP-1', items);
    expect(html).toContain('Children · 1/3 merged');
    for (const id of ['TP-2', 'TP-3', 'TP-4']) expect(html).toMatch(new RegExp(`<a href="/items/${id}"[^>]*>${id}</a>`));
    expect(html).toContain('PR #7');
    expect(html).toMatch(/<button[^>]*>Queue<\/button>/);
    expect(html).toMatch(/waits on <a href="\/items\/TP-3"[^>]*>TP-3<\/a> \(not yet submitted\)/);
  });

  it("a plain item's drawer has neither", () => {
    const html = drawer('TP-3', items);
    expect(html).not.toContain('EPIC');
    expect(html).not.toContain('Children ·');
  });
});
