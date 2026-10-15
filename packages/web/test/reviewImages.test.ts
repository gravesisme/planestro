import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router';
import { Config, ItemFrontmatter, needsYou } from '@planestro/shared';
import type { ItemView, State } from '../src/api.ts';
import { reviewImagesOf, showsReviewImages } from '../src/components/ReviewImages.tsx';

const fixture = vi.hoisted(() => ({ current: {} as any }));
vi.mock('../src/store.ts', () => ({ useStore: (selector: (s: any) => any) => selector(fixture.current), act: () => {} }));
import { ItemPage } from '../src/pages/Item.tsx';

const config = Config.parse({ schema_version: 3, tool_version: '0.1.0', project: { name: 'T', id_prefix: 'TP' }, code_repo: { path: '.', default_branch: 'trunk', github: 'o/r' }, defaults: { planner: 'm', implementer: 'm', category: 'c' }, categories: ['c'], models: [{ id: 'm', label: 'M', claude_model: 'x' }] });
const att = (name: string, at: string, kind = 'managed') => ({ path: `attachments/TP-1/${name}`, kind, added_at: at });
const ATTACHED = [att('old_1x.png', '2026-10-07T01:00:00Z'), att('notes.md', '2026-10-07T03:00:00Z'), att('compare_4x.jpg', '2026-10-07T02:00:00Z'), att('far.png', '2026-10-07T04:00:00Z', 'reference')];
const itemOf = (fields: Record<string, unknown>): ItemView => {
  const frontmatter = ItemFrontmatter.parse({ schema: 4, id: 'TP-1', title: 'Lamps', category: 'c', created_at: '2026-10-07T00:00:00Z', updated_at: '2026-10-07T00:00:00Z', status: 'IN_PROGRESS', planner: 'm', implementer: 'm', attachments: ATTACHED, ...fields });
  return { id: 'TP-1', path: 'items/TP-1.md', frontmatter, sections: { Description: '', Notes: '', Plan: '', Activity: '' }, activity: [], derived: { lane: 'board', needs_you: needsYou(frontmatter), external: false, flavor: 'worker', deps_satisfied: true, children: [], base_branch: 'trunk' } } as unknown as ItemView;
};
const page = (item: ItemView) => {
  fixture.current = { state: { config, local: { model_unavailable: {} }, engine: { paused: false, provider_guards: {}, sessions: [] }, items: [item], releases: [] } as unknown as State, chat: {}, consoles: {}, seedConsole: () => {} };
  return renderToStaticMarkup(createElement(MemoryRouter, { initialEntries: ['/items/TP-1'] }, createElement(Routes, null, createElement(Route, { path: '/items/:id', element: createElement(ItemPage) }))));
};

describe('review images first (#355, #372)', () => {
  it("an item's pictures are the managed images, the latest hand-off's first", () => {
    expect(reviewImagesOf(itemOf({})).map((a) => a.path.split('/').pop())).toEqual(['compare_4x.jpg', 'old_1x.png']);
  });

  it('they go to the top only when the item is held or waits for review, or needs you', () => {
    expect(showsReviewImages(itemOf({}))).toBe(false); // still being worked on
    expect(showsReviewImages(itemOf({ status: 'IN_REVIEW', skip_merge: true }))).toBe(true);
    expect(showsReviewImages(itemOf({ status: 'IN_REVIEW', awaiting: 'review' }))).toBe(true);
    expect(showsReviewImages(itemOf({ awaiting: 'question', awaiting_data: { questions: [] } }))).toBe(true);
    expect(showsReviewImages(itemOf({ status: 'IN_REVIEW', skip_merge: true, attachments: [ATTACHED[1]] }))).toBe(false); // no pictures
  });

  it('a held item shows its pictures above the hold panel and the Attachments list, each opening in the zoom', () => {
    const markup = page(itemOf({ status: 'IN_REVIEW', skip_merge: true, hold_reason: 'art review' }));
    const gallery = markup.indexOf('id="images"');
    expect(gallery).toBeGreaterThan(-1);
    expect(gallery).toBeLessThan(markup.indexOf('id="hold"'));
    expect(gallery).toBeLessThan(markup.indexOf('id="attachments"'));
    expect(markup.slice(gallery, markup.indexOf('id="hold"'))).toMatch(/compare_4x\.jpg[\s\S]*old_1x\.png/);
    // the Attachments list opens a picture in the same zoom, not only a new tab
    expect(markup.slice(markup.indexOf('id="attachments"'))).toContain('<button type="button" class="checker" title="Click to zoom"><img src="/attachments/TP-1/old_1x.png"');
  });

  it('no gallery while the item is still being worked on', () => {
    expect(page(itemOf({}))).not.toContain('id="images"');
  });
});
