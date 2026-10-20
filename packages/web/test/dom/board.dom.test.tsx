import { describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { useStore } from '../../src/store.ts';
import { BoardPage } from '../../src/pages/Board.tsx';
import { FakeSocket, installSocket, item, mockApi, state } from './fixture.tsx';

// Every time the board draws a card, counted per item: a board that re-renders draws them all again.
const drawn: Record<string, number> = {};
vi.mock('../../src/components/ItemCard.tsx', async (load) => {
  const real = await load<typeof import('../../src/components/ItemCard.tsx')>();
  return { ...real, ItemCard: (p: Parameters<typeof real.ItemCard>[0]) => { drawn[p.item.id] = (drawn[p.item.id] ?? 0) + 1; return <real.ItemCard {...p} />; } };
});

describe('the board and the event stream (#406)', () => {
  it("a session's output redraws only its own card: never the board, never a state refetch", async () => {
    vi.useFakeTimers();
    const s = state([item('TP-1', { status: 'IN_PROGRESS' }), item('TP-2'), item('TP-3', { status: 'QUEUED' })], { sessions: [{ item: 'TP-1', op: 'implement', busy: true }] });
    const api = mockApi({ '/api/state': () => s, '/api/orchestrator/notes': [], '/api/orchestrator/notes/seen': { seen: '' }, '/api/questions': [] });
    installSocket();
    useStore.getState().connect();
    await act(async () => { FakeSocket.last!.open(); await vi.runAllTimersAsync(); });
    expect(api.count('/api/state')).toBe(1);

    render(<MemoryRouter><BoardPage lane="board" /></MemoryRouter>);
    const before = { ...drawn };
    expect(before['TP-2']).toBeGreaterThan(0);

    await act(async () => {
      for (const line of ['Reading src/tide.ts', 'Running npm test', 'All 12 tests passed']) FakeSocket.last!.emit({ type: 'session.output', id: 'TP-1', text: line });
      await vi.runAllTimersAsync();
    });
    expect(screen.getByRole('button', { name: 'implementing…' }).title).toBe('Last output: All 12 tests passed');
    expect(drawn).toEqual(before);
    expect(api.count('/api/state')).toBe(1);
    expect(useStore.getState().consoles['TP-1']).toHaveLength(3);

    // An event that does change the state is one refetch for the whole burst.
    await act(async () => {
      FakeSocket.last!.emit({ type: 'item.updated', id: 'TP-2' });
      FakeSocket.last!.emit({ type: 'item.updated', id: 'TP-3' });
      await vi.runAllTimersAsync();
    });
    expect(api.count('/api/state')).toBe(2);
    vi.useRealTimers();
  });
});
