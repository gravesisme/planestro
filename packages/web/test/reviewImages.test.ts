import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router';
import { Config, ItemFrontmatter, needsYou } from '@planestro/shared';
import type { ItemView, State } from '../src/api.ts';
import { attachmentName, flagsFor, galleryImagesOf, groupPairs, pairRole, reviewImagesOf, showsReviewImages, worstSeverity } from '../src/components/ReviewImages.tsx';

const fixture = vi.hoisted(() => ({ current: {} as any }));
vi.mock('../src/store.ts', () => ({ useStore: (selector: (s: any) => any) => selector(fixture.current), act: () => {} }));
import { ItemPage } from '../src/pages/Item.tsx';

const config = Config.parse({ schema_version: 3, tool_version: '0.1.0', project: { name: 'T', id_prefix: 'TP' }, code_repo: { path: '.', default_branch: 'trunk', github: 'o/r' }, defaults: { planner: 'm', implementer: 'm', category: 'c' }, categories: ['c'], models: [{ id: 'm', label: 'M', claude_model: 'x' }] });
const att = (name: string, at: string, kind: 'managed' | 'reference' = 'managed') => ({ path: `attachments/TP-1/${name}`, kind, added_at: at });
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

describe('the latest hand-off, compare pairs and review flags (#355, #372)', () => {
  const PAIRS = [att('20261007-020000-tmp-lamp_4x_before.png', '2026-10-07T02:00:00Z'), att('20261007-020000-2-tmp-lamp_4x_after.png', '2026-10-07T02:00:01Z'), att('20261007-020000-tmp-lamp_6x_before.png', '2026-10-07T02:00:02Z'), att('20261007-020000-tmp-lamp_6x_after.png', '2026-10-07T02:00:03Z'), att('20261007-020000-tmp-lamp_4x_compare.png', '2026-10-07T02:00:04Z')];

  it('an attachment matches a flag by the worktree path it was copied from, or that path\'s file name', () => {
    const flags = [{ path: 'tmp/lamp_4x_after.png', reason: 'floats' }, { path: 'lamp_6x_before.png', reason: 'clips' }, { path: 'art/lamp.png', reason: 'drift' }];
    expect(attachmentName(PAIRS[1].path)).toBe('tmp-lamp_4x_after.png');
    expect(flagsFor(flags, { path: PAIRS[1].path, attachment: true }).map((f) => f.reason)).toEqual(['floats']);
    expect(flagsFor(flags, { path: PAIRS[2].path, attachment: true })).toEqual([]); // the copy is tmp-lamp_6x_before.png
    expect(flagsFor(flags, { path: 'art/lamp.png' }).map((f) => f.reason)).toEqual(['drift']); // a branch file, as is
    expect(worstSeverity([{ path: 'a', reason: 'x', severity: 'info' }, { path: 'a', reason: 'y' }])).toBe('warn');
  });

  it('compare pairs group by name, before then after then compare; the scale keeps a 4× pair apart from a 6×', () => {
    const groups = groupPairs([...PAIRS].reverse()).map((g) => g.map((a) => pairRole(attachmentName(a.path))));
    expect(groups).toEqual([['before', 'after', 'compare'], ['before', 'after']]);
    expect(groupPairs([...PAIRS].reverse())[0].map((a) => attachmentName(a.path))).toEqual(['tmp-lamp_4x_before.png', 'tmp-lamp_4x_after.png', 'tmp-lamp_4x_compare.png']);
  });

  it("the gallery shows the latest hand-off's pictures when it has some, else every picture", () => {
    const item = itemOf({ status: 'IN_REVIEW', skip_merge: true, attachments: [...ATTACHED, ...PAIRS], review_handoff: { at: '2026-10-07T02:00:05Z', attached: [PAIRS[0].path, PAIRS[1].path] } });
    expect(galleryImagesOf(item)).toMatchObject({ latest: true, images: [PAIRS[1], PAIRS[0]] });
    // a hand-off whose pictures were removed falls back to them all
    expect(galleryImagesOf(itemOf({ review_handoff: { at: '2026-10-07T02:00:05Z', attached: ['attachments/TP-1/gone.png'] } })).latest).toBe(false);
    const markup = page(item);
    const gallery = markup.slice(markup.indexOf('id="images"'), markup.indexOf('id="hold"'));
    expect(gallery).toContain('Latest hand-off');
    expect(gallery).not.toContain('old_1x.png');
    expect(gallery).toContain('class="review-group"'); // the 4× before and after, side by side
  });

  it('flagged pictures come first under "Needs a look", boxed by severity with the reason; a flag on no picture is listed by path', () => {
    const flags = [{ path: 'tmp/lamp_4x_after.png', cell: 'frame 3', reason: 'the flame floats', severity: 'problem' }, { path: 'art/lamp.png', reason: 'colour drift' }];
    const markup = page(itemOf({ status: 'IN_REVIEW', skip_merge: true, attachments: PAIRS, review_handoff: { at: '2026-10-07T02:00:05Z', attached: PAIRS.map((a) => a.path), flags } }));
    const gallery = markup.slice(markup.indexOf('id="images"'), markup.indexOf('id="hold"'));
    expect(gallery).toMatch(/· <!-- -->2<!-- --> flagged|· 2 flagged/);
    const look = gallery.indexOf('Needs a look');
    expect(look).toBeGreaterThan(-1);
    expect(gallery.indexOf('review-side flagged sev-problem')).toBeGreaterThan(look);
    // the flagged after comes up with its whole group (the before it is judged against), ahead of the unflagged 6× pair
    expect(gallery.indexOf('review-side flagged sev-problem')).toBeLessThan(gallery.indexOf('tmp-lamp_6x_before.png'));
    expect(gallery.indexOf('tmp-lamp_4x_before.png')).toBeLessThan(gallery.indexOf('tmp-lamp_6x_before.png'));
    expect(gallery).toMatch(/<b>frame 3: <\/b>the flame floats/);
    expect(gallery).toMatch(/<code>art\/lamp\.png<\/code>[\s\S]*colour drift/);
    // advisory: the hold and its release are as before
    expect(markup).toContain('id="hold"');
  });

  it('flags alone (no pictures) still put the section at the top', () => {
    expect(showsReviewImages(itemOf({ status: 'IN_REVIEW', skip_merge: true, attachments: [], review_handoff: { at: '2026-10-07T02:00:05Z', attached: [], flags: [{ path: 'a.png', reason: 'x' }] } }))).toBe(true);
  });
});
