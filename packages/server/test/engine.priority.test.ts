/**
 * Item priority (#194): an optional high | medium | low that orders each column and the queue before
 * rank, round-trips through the API and the file, and changes nothing for items without one.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DataStore } from '../src/store/DataStore.ts';
import { LiveEngine } from '../src/engine/LiveEngine.ts';
import { FakeWorld, DryRunGitPort, DryRunGhPort, DryRunProcPort, DryRunClaudePort } from '../src/engine/dryrun-ports.ts';
import type { Ports, TurnOptions, TurnResult } from '../src/engine/ports.ts';
import { makeFixture, sleep } from './helpers.ts';
import { apiRoutes } from '../src/routes/api.ts';

let store: DataStore | undefined; let engine: LiveEngine | undefined;
afterEach(async () => { await engine?.stop(); store?.close(); store = undefined; engine = undefined; });

async function setup(claude?: (world: FakeWorld) => Ports['agents']['claude']) {
  const { dataDir, codeRepo } = makeFixture();
  mkdirSync(join(codeRepo, '.git', 'info'), { recursive: true });
  delete process.env.PLANESTRO_DRYRUN_CI;
  store = await DataStore.open(dataDir);
  const world = new FakeWorld(() => {}, { 'origin/trunk': 'f'.repeat(40) });
  const ports: Ports = { mode: 'dry-run', git: new DryRunGitPort(world), gh: new DryRunGhPort(world), proc: new DryRunProcPort(world), agents: { claude: claude ? claude(world) : new DryRunClaudePort(world) } };
  engine = new LiveEngine(store, ports, () => {}, { sleep: async () => {}, tickMs: 50 });
  return { store, engine };
}

async function waitFor(pred: () => boolean, ms = 4000) { const t0 = Date.now(); while (!pred()) { if (Date.now() - t0 > ms) throw new Error('timeout waiting'); await sleep(20); } }
const titles = (s: DataStore) => s.laneItems('board').map((i) => i.file.frontmatter.title).join('');

describe('item priority (#194)', () => {
  it('admits a high item ahead of a low one ranked above it', async () => {
    let firstAdmitted: string[] | undefined;
    const { store, engine } = await setup((world) => { const inner = new DryRunClaudePort(world); return {
      async runTurn(o: TurnOptions): Promise<TurnResult> {
        firstAdmitted ??= store!.listItems().filter((i) => i.file.frontmatter.status === 'PLAN_IN_PROGRESS').map((i) => i.file.frontmatter.title);
        return inner.runTurn(o);
      },
      runCustomTurn: inner.runCustomTurn.bind(inner),
    }; });
    store.updateConfig((doc) => { doc.setIn(['concurrency', 'max_sessions'], 1); }, 'config: one session');
    const low = store.createItem({ title: 'low', description: 'x', priority: 'low' });
    const high = store.createItem({ title: 'high', description: 'x', priority: 'high' });
    expect(low.file.frontmatter.rank!).toBeLessThan(high.file.frontmatter.rank!);
    store.transition(low.id, 'QUEUED', 'user'); store.transition(high.id, 'QUEUED', 'user');
    await engine.start();
    await waitFor(() => firstAdmitted !== undefined);
    expect(firstAdmitted).toEqual(['high']);
  });

  it('orders a column by priority, then rank; with none set the order is rank order, as before', async () => {
    const { store } = await setup();
    const [a, b, c, d] = ['A', 'B', 'C', 'D'].map((t) => store.createItem({ title: t }).id);
    expect(titles(store)).toBe('ABCD');
    store.editItem(d, [{ set: { priority: 'high' } }]);
    store.editItem(b, [{ set: { priority: 'low' } }]);
    store.editItem(c, [{ set: { priority: 'medium' } }]);
    expect(titles(store)).toBe('DCBA');                      // high, medium, low, then the unset A
    store.editItem(b, [{ unset: ['priority'] }]);
    expect(titles(store)).toBe('DCAB');                      // back among the unset, by rank
    expect(store.search('', { priority: 'high' }).map((i) => i.id)).toEqual([d]);
    void a;
  });

  it('a move orders within the priority; a place beside another priority snaps to its own edge', async () => {
    const { store } = await setup();
    const [a, b, c, d] = ['A', 'B', 'C', 'D'].map((t) => store.createItem({ title: t, priority: t < 'C' ? 'high' : undefined }).id);
    expect(titles(store)).toBe('ABCD');
    store.move(b, 'top'); expect(titles(store)).toBe('BACD');
    store.move(d, 'top'); expect(titles(store)).toBe('BADC');                  // top of the unset items, still below high
    store.move(c, 'before', b); expect(titles(store)).toBe('BACD');            // above a high item: the top of its own band
    store.move(a, 'after', d); expect(titles(store)).toBe('BACD');             // below an unset item: the bottom of the high band
    store.move(a, 'before', b); expect(titles(store)).toBe('ABCD');            // within the band, as always
  });

  it('round-trips through the API and the file; null clears it', async () => {
    const { store, engine } = await setup();
    const app = apiRoutes(store, engine);
    const post = await app.request('/items', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'Fix CI', priority: 'high' }) });
    expect(post.status).toBe(201);
    const id = ((await post.json()) as { id: string }).id;
    expect(readFileSync(store.getItem(id)!.path, 'utf8')).toMatch(/\ncategory: [^\n]+\npriority: high\nstatus:/);
    const patch = (fields: Record<string, unknown>) => app.request(`/items/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ fields }) });
    expect((await patch({ priority: 'urgent' })).status).toBe(400);
    expect((await patch({ priority: 'low' })).status).toBe(200);
    expect(store.getItem(id)!.file.frontmatter.priority).toBe('low');
    const listed = await (await app.request('/items?priority=low')).json() as { id: string }[];
    expect(listed.map((i) => i.id)).toEqual([id]);
    expect((await patch({ priority: null })).status).toBe(200);
    expect(store.getItem(id)!.file.frontmatter.priority).toBeUndefined();
    expect(readFileSync(store.getItem(id)!.path, 'utf8')).not.toMatch(/priority:/);
  });
});
