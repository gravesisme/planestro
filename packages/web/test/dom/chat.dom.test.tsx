import { describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { useStore } from '../../src/store.ts';
import { OrchestratorChat } from '../../src/components/OrchestratorChat.tsx';
import { FakeSocket, installSocket, item, mockApi, state } from './fixture.tsx';

const entry = (ts: string, type: string, text: string) => ({ ts, type, actor: type.endsWith('user_message') ? 'user' : 'orchestrator', data: { text } });

describe('the orchestrator chat (#406)', () => {
  it('opens on its thread and appends what the stream brings, once each', async () => {
    vi.useFakeTimers();
    const api = mockApi({
      '/api/state': state([item('TP-1')]), '/api/orchestrator/notes': [], '/api/orchestrator/notes/seen': { seen: '' }, '/api/questions': [],
      '/api/orchestrator/chat': { enabled: true, entries: [entry('2026-10-20T10:00:00-04:00', 'orchestrator.user_message', 'What is blocked?')] },
    });
    installSocket();
    useStore.getState().connect();
    await act(async () => { FakeSocket.last!.open(); await vi.runAllTimersAsync(); });

    render(<MemoryRouter><OrchestratorChat /></MemoryRouter>);
    await act(async () => { useStore.getState().openChat(); await vi.runAllTimersAsync(); });
    expect(api.count('/api/orchestrator/chat')).toBeGreaterThan(0);
    expect(screen.getByText('What is blocked?')).toBeTruthy();

    const reply = { type: 'journal.appended', entry: entry('2026-10-20T10:00:05-04:00', 'orchestrator.reply', 'Nothing: TP-1 is waiting for you.') };
    await act(async () => {
      FakeSocket.last!.emit(reply);
      FakeSocket.last!.emit(reply); // a resend after a reconnect is not a second message
      FakeSocket.last!.emit({ type: 'journal.appended', entry: entry('2026-10-20T10:00:06-04:00', 'ci.result', 'not chat') });
      await vi.runAllTimersAsync();
    });
    const texts = [...document.querySelectorAll('.chat-text')].map((t) => t.textContent);
    expect(texts).toEqual(['What is blocked?', 'Nothing: TP-1 is waiting for you.']);
    expect(screen.getByRole('link', { name: 'TP-1' }).getAttribute('href')).toBe('/items/TP-1'); // an item id in a reply opens it
    expect(useStore.getState().chat.entries?.map((e) => e.type)).toEqual(['orchestrator.user_message', 'orchestrator.reply']);
    expect(screen.queryByText('not chat')).toBeNull();
    vi.useRealTimers();
  });
});
