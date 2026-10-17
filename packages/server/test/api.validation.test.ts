import { describe, it, expect, afterEach } from 'vitest';
import { DataStore } from '../src/store/DataStore.ts';
import { MockEngine } from '../src/engine/MockEngine.ts';
import { apiRoutes, journalLimit } from '../src/routes/api.ts';
import { makeFixture } from './helpers.ts';

let store: DataStore | undefined;
afterEach(() => { store?.close(); store = undefined; });

describe('request bodies and queries are checked before they reach the engine', () => {
  it("a journal limit that is not a number reads 200 entries, never the whole journal", () => {
    expect(journalLimit(undefined)).toBe(200);
    expect(journalLimit('x')).toBe(200);
    expect(journalLimit('0')).toBe(1);
    expect(journalLimit('-5')).toBe(1);
    expect(journalLimit('120')).toBe(120);
    expect(journalLimit('1e9')).toBe(1000);
  });

  it('a response of an unknown kind, or with answers that are not text, is refused with a 400', async () => {
    store = await DataStore.open(makeFixture().dataDir);
    const engine = new MockEngine(store, () => {});
    const seen: unknown[] = [];
    (engine as { respond: (id: string, p: Record<string, unknown>) => Promise<void> }).respond = async (_id, p) => { seen.push(p); };
    const app = apiRoutes(store, engine);
    const post = (body: unknown) => app.request('/items/X-1/respond', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    expect((await post({ kind: 'question', answers: { q: { evil: true } } })).status).toBe(400);
    expect((await post({ kind: 'permission', decision: 'sure' })).status).toBe(400);
    expect((await post({ kind: 'nope' })).status).toBe(400);
    expect(seen).toHaveLength(0);
    expect((await post({ kind: 'permission', decision: 'always', reason: 'tests' })).status).toBe(200);
    expect(seen).toEqual([{ kind: 'permission', decision: 'always', reason: 'tests' }]);
  });
});
