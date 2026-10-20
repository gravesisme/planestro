import { describe, expect, it } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { ItemCard } from '../../src/components/ItemCard.tsx';
import { useStore } from '../../src/store.ts';
import { item, state } from './fixture.tsx';

describe('a card on the board (#406)', () => {
  it("shows a running agent's badge, and its last output follows the stream", () => {
    const tp1 = item('TP-1', { status: 'IN_PROGRESS' });
    useStore.setState({ state: state([tp1], { sessions: [{ item: 'TP-1', op: 'implement', busy: true, last_output: 'from the state' }] }), lastOutput: {} });
    render(<MemoryRouter><ItemCard item={tp1} /></MemoryRouter>);

    const badge = screen.getByRole('button', { name: 'implementing…' });
    expect(badge.title).toBe('Last output: from the state');
    act(() => useStore.setState({ lastOutput: { 'TP-1': 'Running npm test' } }));
    expect(badge.title).toBe('Last output: Running npm test');

    // On glass nothing hovers: a tap shows the line on the card.
    fireEvent.click(badge);
    expect(screen.getByText('Running npm test')).toBeTruthy();
  });

  it('says a saved instruction waits rather than runs', () => {
    const tp2 = item('TP-2', { status: 'QUEUED', op_data: { pending_turn: { key: 'k', phase: 'plan', prompt: 'p' } } });
    useStore.setState({ state: state([tp2]), lastOutput: {} });
    render(<MemoryRouter><ItemCard item={tp2} /></MemoryRouter>);
    expect(screen.queryByRole('button', { name: /running|planning/ })).toBeNull();
    expect(screen.getByText(/waiting/)).toBeTruthy();
  });
});
