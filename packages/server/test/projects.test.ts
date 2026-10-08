import { afterEach, describe, expect, it } from 'vitest';
import { DataStore } from '../src/store/DataStore.ts';
import { MockEngine } from '../src/engine/MockEngine.ts';
import { apiRoutes } from '../src/routes/api.ts';
import { projectsOverview, summarizeState, type OverviewDeps } from '../src/projects.ts';
import { makeFixture } from './helpers.ts';

/**
 * #235: each project runs its own server and nothing showed them together. The overview reads the project registry
 * and the recorded instances, asks each running one for its /api/state (server-side, with a short timeout) and
 * counts what needs you, what is blocked, in review and running, and its guard state. Never the real ~/.planestro,
 * never a real server: the registry, the instances and fetch are fakes here.
 */
const item = (id: string, o: { status?: string; needs?: boolean; blocked?: boolean; lane?: string } = {}) => ({
  id, frontmatter: { id, status: o.status ?? 'IN_PROGRESS', ...(o.blocked ? { blocked: true } : {}) }, derived: { needs_you: Boolean(o.needs), lane: o.lane ?? 'board' },
});
const remoteState = {
  config: { project: { name: 'Lake Monomonac' } }, readOnly: false,
  items: [
    item('LM-1', { needs: true }), item('LM-2', { needs: true, blocked: true }), item('LM-3', { blocked: true }),
    item('LM-4', { status: 'IN_REVIEW' }), item('LM-5', { status: 'IN_REVIEW', needs: true }),
    item('LM-6', { needs: true, lane: 'icebox', status: 'ICEBOX' }),
  ],
  engine: { mode: 'live', paused: true, paused_by: 'user', provider_guards: { claude: { window: 'five_hour', status: 'rejected', tripped_at: '2026-10-08T10:00:00Z', resume_at: '2026-10-08T12:01:00Z' } }, sessions: [{ item: 'LM-1', busy: true }, { item: 'LM-4', busy: false }] },
};

const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });

function deps(o: Partial<OverviewDeps> = {}): OverviewDeps {
  return {
    registry: () => [
      { name: 'Hurricane Harrison', data_dir: '/w/hh/planning' },
      { name: 'Lake Monomonac', data_dir: '/w/lm/planning' },
      { name: 'Old Thing', data_dir: '/w/old/planning' },
    ],
    instances: () => [{ data_dir: '/w/lm/planning', url: 'http://127.0.0.1:4391', host: '0.0.0.0', port: 4391 }],
    unrecorded: () => undefined,
    fetch: async () => json(remoteState),
    timeoutMs: 200,
    ...o,
  };
}
const self = { dataDir: '/w/hh/planning', name: 'Hurricane Harrison', state: () => ({ config: { project: { name: 'Hurricane Harrison' } }, readOnly: false, items: [item('HH-1', { needs: true })], engine: { mode: 'dry-run', paused: false, sessions: [] } }) };

describe('the all-projects overview (#235)', () => {
  it('counts what needs you, blocked, in review and running, with the guard state, from a project\'s state', () => {
    expect(summarizeState(remoteState)).toEqual({
      name: 'Lake Monomonac', needs_you: 3, blocked: 2, in_review: 2, running: 1, mode: 'live', paused: true, paused_by: 'user', read_only: false,
      guards: [{ provider: 'claude', window: 'five_hour', status: 'rejected', resume_at: '2026-10-08T12:01:00Z' }],
    });
  });

  it('lists every registered project: this one from memory, a running one from its server, the rest as not running', async () => {
    const asked: string[] = [];
    const { projects } = await projectsOverview(self, deps({ fetch: async (url) => { asked.push(String(url)); return json(remoteState); } }));
    expect(asked).toEqual(['http://127.0.0.1:4391/api/state']);   // never this server itself
    expect(projects.map((p) => [p.name, p.reach, p.self])).toEqual([
      ['Hurricane Harrison', 'self', true], ['Lake Monomonac', 'ok', false], ['Old Thing', 'not_running', false],
    ]);
    expect(projects[0].summary?.needs_you).toBe(1);
    expect(projects[1]).toMatchObject({ url: 'http://127.0.0.1:4391', host: '0.0.0.0', port: 4391, summary: { needs_you: 3, running: 1 } });
    expect(projects[2].summary).toBeUndefined();
  });

  it('a server that does not answer in time, or answers with an error, is shown unreachable; the page still loads', async () => {
    const hang: OverviewDeps['fetch'] = (_url, init) => new Promise((_, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('The operation was aborted due to timeout'))));
    const started = Date.now();
    const slow = await projectsOverview(self, deps({ fetch: hang, timeoutMs: 50 }));
    expect(Date.now() - started).toBeLessThan(2000);
    expect(slow.projects[1]).toMatchObject({ name: 'Lake Monomonac', reach: 'unreachable' });
    expect(slow.projects[1].error).toMatch(/timeout|did not answer/);
    const broken = await projectsOverview(self, deps({ fetch: async () => new Response('nope', { status: 503 }) }));
    expect(broken.projects[1]).toMatchObject({ reach: 'unreachable', error: 'HTTP 503' });
  });

  it('finds a server started with plain `serve` from its data dir\'s lock, and adds a running instance the registry lacks', async () => {
    const { projects } = await projectsOverview(self, deps({
      registry: () => [{ name: 'Hurricane Harrison', data_dir: '/w/hh/planning' }, { name: 'Old Thing', data_dir: '/w/old/planning' }],
      instances: () => [{ data_dir: '/w/lm/planning', url: 'http://127.0.0.1:4391', host: '127.0.0.1', port: 4391 }],
      unrecorded: (dir) => (dir === '/w/old/planning' ? { url: 'http://127.0.0.1:4392', host: '127.0.0.1', port: 4392 } : undefined),
      fetch: async (url) => json({ ...remoteState, config: { project: { name: String(url).includes(':4392') ? 'Old Thing' : 'Lake Monomonac' } } }),
    }));
    expect(projects.map((p) => [p.name, p.reach, p.port])).toEqual([
      ['Hurricane Harrison', 'self', undefined], ['Lake Monomonac', 'ok', 4391], ['Old Thing', 'ok', 4392],
    ]);
  });

  it('this server is listed even when no registry names it', async () => {
    const { projects } = await projectsOverview(self, deps({ registry: () => [], instances: () => [] }));
    expect(projects).toHaveLength(1);
    expect(projects[0]).toMatchObject({ name: 'Hurricane Harrison', reach: 'self', data_dir: '/w/hh/planning' });
  });
});

describe('GET /api/projects (#235)', () => {
  let store: DataStore | undefined;
  afterEach(() => { store?.close(); store = undefined; });
  it('answers with this project and the others, read-only, through the injected registry and fetch', async () => {
    const f = makeFixture();
    store = await DataStore.open(f.dataDir);
    const app = apiRoutes(store, new MockEngine(store, () => {}), undefined, { projects: deps({ registry: () => [{ name: 'Lake Monomonac', data_dir: '/w/lm/planning' }] }) });
    const r = await app.request('/projects');
    expect(r.status).toBe(200);
    const body = await r.json() as { projects: { name: string; reach: string; self: boolean }[] };
    expect(body.projects.map((p) => [p.name, p.reach])).toEqual([['Test Project', 'self'], ['Lake Monomonac', 'ok']]);
  });
});
