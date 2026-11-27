import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
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

describe('a provider paused by its usage guard is on the top bar (#579)', () => {
  const guard = (resetInMs: number) => ({ window: 'seven_day', status: 'allowed' as const, utilization: 0.85, resets_at: new Date(Date.now() + resetInMs).toISOString(), tripped_at: new Date(Date.now()).toISOString() });

  it('says so beside its Retry without opening anything, then counts in Needs you once the window has reset', async () => {
    vi.useFakeTimers();
    const s = state([item('TP-1')], { mode: 'live' });
    s.engine.provider_guards = { claude: guard(120_000) };
    mockApi({ '/api/state': () => s, '/api/orchestrator/notes': [], '/api/orchestrator/notes/seen': { seen: '' }, '/api/questions': [] });
    installSocket();
    render(<MemoryRouter><Routes><Route element={<App />}><Route index element={<p>board</p>} /></Route></Routes></MemoryRouter>);
    await act(async () => { FakeSocket.last!.open(); await vi.advanceTimersByTimeAsync(1000); });

    expect(screen.getByRole('button', { name: /Automation status/ }).getAttribute('aria-label')).toBe('Automation status: Claude paused. View details');
    const banner = document.getElementById('provider-guards')!;
    expect(banner.textContent).toMatch(/Claude paused for usage \(7-day window at 85%\) · the window resets at .+, then press Retry Claude/);
    expect(banner.querySelector('button')!.textContent).toBe('Retry Claude');
    const needs = () => screen.getByRole('button', { name: /needs? you/ });
    expect(needs().textContent).toMatch(/0$/);

    // The reset passes with no event from the server: the wording and the count change on the clock.
    await act(async () => { await vi.advanceTimersByTimeAsync(121_000); });
    expect(banner.textContent).toMatch(/Claude usage window has reset · nothing new starts on Claude until you press Retry Claude/);
    expect(banner.textContent).not.toMatch(/resets at/);
    expect(needs().textContent).toMatch(/1$/);
    expect(needs().getAttribute('aria-label')).toBe('0 items need you, and Claude waits for your retry');
    expect(needs().className).toContain('wait');
    vi.useRealTimers();
  });

  it('a guard that resumes by itself is shown but never counted', async () => {
    vi.useFakeTimers();
    const s = state([item('TP-1')], { mode: 'live' });
    (s.config.usage_guard as { auto_resume: boolean }).auto_resume = true;
    s.engine.provider_guards = { claude: { ...guard(-30_000), resume_at: new Date(Date.now() + 30_000).toISOString() } };
    await showHeader(s);
    expect(document.getElementById('provider-guards')!.textContent).toMatch(/Claude usage window has reset · resumes by itself at /);
    expect(screen.getByRole('button', { name: /needs? you/ }).textContent).toMatch(/0$/);
    (s.config.usage_guard as { auto_resume: boolean }).auto_resume = false;
    vi.useRealTimers();
  });

  it('pressing Pause or Resume says that it does not clear the provider pause, and what does', async () => {
    vi.useFakeTimers();
    const s = state([item('TP-1')], { mode: 'live' });
    s.engine.paused = true;
    s.engine.provider_guards = { claude: guard(-60_000) };
    mockApi({ '/api/state': () => s, '/api/engine/resume': () => { s.engine.paused = false; return { ok: true }; }, '/api/orchestrator/notes': [], '/api/orchestrator/notes/seen': { seen: '' }, '/api/questions': [] });
    installSocket();
    render(<MemoryRouter><Routes><Route element={<App />}><Route index element={<p>board</p>} /></Route></Routes></MemoryRouter>);
    await act(async () => { FakeSocket.last!.open(); await vi.advanceTimersByTimeAsync(1000); });
    const banner = document.getElementById('provider-guards')!;
    expect(banner.textContent).not.toMatch(/does not clear/);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Resume automation' })); await vi.advanceTimersByTimeAsync(1000); });
    expect(banner.textContent).toMatch(/Automation resumed\. That button does not clear a usage pause: Claude stays paused until you press Retry Claude\./);
    vi.useRealTimers();
  });

  it('a press the server refused says nothing of the kind', async () => {
    vi.useFakeTimers();
    const s = state([item('TP-1')], { mode: 'live' });
    s.engine.provider_guards = { claude: guard(-60_000) };
    await showHeader(s);   // no /api/engine/pause route: the press fails
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Pause automation' })); await vi.advanceTimersByTimeAsync(1000); });
    expect(document.getElementById('provider-guards')!.textContent).not.toMatch(/does not clear/);
    await act(async () => { await vi.advanceTimersByTimeAsync(7000); });
    vi.useRealTimers();
  });
});
