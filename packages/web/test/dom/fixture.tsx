/**
 * What a DOM test of the web package starts from (#406): an item and a /api/state body built from the real schemas,
 * a fetch that answers the API from a table, and a WebSocket the test speaks for. Nothing reaches a server.
 */
import { vi } from 'vitest';
import { Config, ItemFrontmatter } from '@planestro/shared';
import type { ItemView, SessionView, State } from '../../src/api.ts';

export const config = Config.parse({
  schema_version: 3, tool_version: '0.1.0', project: { name: 'Tidepool', id_prefix: 'TP' },
  code_repo: { path: '.', default_branch: 'trunk', github: 'o/r' },
  defaults: { planner: 'm', implementer: 'm', category: 'Tools' }, categories: ['Tools'],
  models: [{ id: 'm', label: 'Model M', claude_model: 'x' }],
});

export function item(id: string, fm: Record<string, unknown> = {}, derived: Partial<ItemView['derived']> = {}): ItemView {
  return {
    id, path: `items/${id}.md`,
    frontmatter: ItemFrontmatter.parse({ schema: 4, id, title: `Item ${id}`, category: 'Tools', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', status: 'NOT_YET_SUBMITTED', planner: 'm', implementer: 'm', ...fm }),
    sections: { Description: '', Notes: '', Plan: '', Activity: '' }, activity: [],
    derived: { lane: 'board', needs_you: false, external: false, flavor: 'worker', deps_satisfied: true, children: [], ...derived },
  };
}

export function state(items: ItemView[], o: { sessions?: SessionView[]; mode?: string } = {}): State {
  return {
    schema: '9', readOnly: false, dataDir: '/data', codeRepo: '/repo', config, local: { model_unavailable: {} },
    items, prompts: [], releases: [], schedules: [], invalid: [], update: null,
    engine: { mode: o.mode ?? 'dry-run', paused: false, provider_guards: {}, sessions: o.sessions ?? [] },
    git: { dirty: [], branch: 'main' }, statuses: [],
  } as unknown as State;
}

/** fetch for the API: each path answers from `routes` (a function is called per request), anything else 404s. */
export function mockApi(routes: Record<string, unknown>) {
  const calls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const path = new URL(String(input), 'http://localhost').pathname;
    calls.push(path);
    if (!(path in routes)) return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
    const body = typeof routes[path] === 'function' ? (routes[path] as () => unknown)() : routes[path];
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }));
  return { calls, count: (path: string) => calls.filter((c) => c === path).length };
}

/** The page's live connection, spoken for by the test: `FakeSocket.last.emit(event)` is the server sending one. */
export class FakeSocket {
  static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
  static last: FakeSocket | undefined;
  readyState = FakeSocket.CONNECTING;
  onopen?: () => void; onclose?: () => void; onmessage?: (m: { data: string }) => void;
  constructor(readonly url: string) { FakeSocket.last = this; }
  open() { this.readyState = FakeSocket.OPEN; this.onopen?.(); }
  emit(e: Record<string, unknown>) { this.onmessage?.({ data: JSON.stringify(e) }); }
  send() {}
  close() { this.readyState = FakeSocket.CLOSED; this.onclose?.(); }
}
export const installSocket = () => vi.stubGlobal('WebSocket', FakeSocket);
