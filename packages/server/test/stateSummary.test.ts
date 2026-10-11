import { describe, it, expect, afterEach } from 'vitest';
import { DataStore } from '../src/store/DataStore.ts';
import { MockEngine } from '../src/engine/MockEngine.ts';
import { apiRoutes } from '../src/routes/api.ts';
import { stateView, SUMMARY_ACTIVITY } from '../src/routes/views.ts';
import { makeFixture } from './helpers.ts';

let store: DataStore | undefined;
afterEach(() => { store?.close(); store = undefined; });

describe('/api/state lists done and iceboxed items as summaries', () => {
  it('keeps what the board searches and shows, and /api/items/:id still has the rest', async () => {
    const { dataDir } = makeFixture();
    store = await DataStore.open(dataDir);
    const done = store.createItem({ title: 'Shipped', description: 'Find me by description', notes: 'and by notes' });
    const live = store.createItem({ title: 'Working', description: 'Still on the board' });
    store.mutateItem(done.file.frontmatter.id, [
      { section: 'Plan', body: 'A long plan' },
      ...Array.from({ length: 10 }, (_, i) => ({ activity: { actor: 'app' as const, text: `line ${i}` } })),
      { set: { status: 'FINISHED', delivered: [{ path: 'a.png', change: 'added' as const }] } },
    ], 'engine');
    store.mutateItem(live.file.frontmatter.id, [{ section: 'Plan', body: 'Live plan' }], 'engine');

    const items = stateView(store, new MockEngine(store, () => {}), {}).items;
    const d = items.find((i) => i.id === done.file.frontmatter.id)!;
    const l = items.find((i) => i.id === live.file.frontmatter.id)!;
    expect(d).toMatchObject({ summary: true, sections: { Description: 'Find me by description', Notes: 'and by notes', Plan: '', Activity: '' } });
    expect(d.activity).toHaveLength(SUMMARY_ACTIVITY);
    expect(d.activity.at(-1)!.text).toBe('line 9');
    expect('delivered' in d.frontmatter).toBe(false);
    expect('summary' in l).toBe(false);
    expect(l.sections).toMatchObject({ Plan: 'Live plan', Activity: '' });

    const app = apiRoutes(store, new MockEngine(store, () => {}));
    const full = await (await app.request(`/items/${done.file.frontmatter.id}`)).json();
    expect(full.summary).toBeUndefined();
    expect(full.sections.Plan).toBe('A long plan');
    expect(full.activity.length).toBeGreaterThan(SUMMARY_ACTIVITY);
    expect(full.frontmatter.delivered).toHaveLength(1);
  });
});
