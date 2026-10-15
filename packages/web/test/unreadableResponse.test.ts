import { describe, it, expect, vi, afterEach } from 'vitest';
import { req, UnreadableResponse } from '../src/api.ts';
import { unreadNoteCount } from '../src/noteWindow.ts';
import { useStore } from '../src/store.ts';

const respond = (routes: Record<string, () => Response>) =>
  vi.stubGlobal('fetch', vi.fn(async (url: string) => (routes[url] ?? (() => new Response('{}', { status: 404 })))()));
const note = (ts: string) => ({ ts, type: 'orchestrator.planestro_note', data: { text: ts } });

afterEach(() => { vi.unstubAllGlobals(); useStore.setState({ notes: [], notesSeen: '' }); });

describe('a cut-off response (#350)', () => {
  it('rejects a 200 whose body does not parse, as a retryable failure, never {}', async () => {
    respond({ '/x': () => new Response('[{"ts":"2026-10-1', { status: 200 }) });
    const err = await req<unknown>('GET', '/x').then(() => undefined, (e: UnreadableResponse) => e);
    expect(err).toBeInstanceOf(UnreadableResponse);
    expect(err?.retryable).toBe(true);
  });

  it('still reads an empty success as {} and a failed status with its error', async () => {
    respond({ '/empty': () => new Response('', { status: 200 }), '/bad': () => new Response('{"error":"no such item"}', { status: 404 }), '/cut': () => new Response('<html', { status: 502, statusText: 'Bad Gateway' }) });
    expect(await req('GET', '/empty')).toEqual({});
    await expect(req('GET', '/bad')).rejects.toThrow('no such item');
    await expect(req('GET', '/cut')).rejects.toThrow('502 Bad Gateway');
  });

  it('keeps the notes it had through a truncated answer, and a later good one fills them', async () => {
    respond({ '/api/orchestrator/notes': () => new Response('[{"ts":', { status: 200 }), '/api/orchestrator/notes/seen': () => Response.json({ seen: '' }) });
    await useStore.getState().loadNotes();
    expect(useStore.getState().notes).toEqual([]);
    respond({ '/api/orchestrator/notes': () => Response.json([note('2026-10-11T10:00:00Z')]), '/api/orchestrator/notes/seen': () => Response.json({ seen: '' }) });
    await useStore.getState().loadNotes();
    expect(useStore.getState().notes).toHaveLength(1);
  });

  it('a notes value that is not a list costs the badge, not the page', () => {
    expect(unreadNoteCount({}, '')).toBe(0);
    expect(unreadNoteCount(undefined, '')).toBe(0);
    expect(unreadNoteCount([note('2026-10-11T10:00:00Z'), note('2026-10-10T10:00:00Z')], '2026-10-10T12:00:00Z')).toBe(1);
  });
});
