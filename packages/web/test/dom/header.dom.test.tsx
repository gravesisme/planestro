import { describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { App } from '../../src/App.tsx';
import { useStore } from '../../src/store.ts';
import { FakeSocket, installSocket, item, mockApi, state } from './fixture.tsx';

async function showHeader(s: ReturnType<typeof state>) {
  mockApi({ '/api/state': () => s, '/api/orchestrator/notes': [], '/api/orchestrator/notes/seen': { seen: '' }, '/api/questions': [] });
  installSocket();
  render(<MemoryRouter><Routes><Route element={<App />}><Route index element={<p>board</p>} /></Route></Routes></MemoryRouter>);
  await act(async () => { FakeSocket.last!.open(); await vi.runAllTimersAsync(); });
  return screen.getByRole('button', { name: /Automation status/ });
}

describe('the header says which engine mode is running (#333, #406)', () => {
  it('Dry-run until the server runs live, and Live only then', async () => {
    vi.useFakeTimers();
    const s = state([item('TP-1')]);
    const status = await showHeader(s);
    expect(status.getAttribute('aria-label')).toBe('Automation status: Dry-run. View details');

    s.engine.mode = 'live';
    await act(async () => { await useStore.getState().refresh(); });
    expect(status.getAttribute('aria-label')).toBe('Automation status: Live. View details');

    s.engine.paused = true;
    await act(async () => { await useStore.getState().refresh(); });
    expect(status.getAttribute('aria-label')).toBe('Automation status: Paused. View details');
    vi.useRealTimers();
  });
});
