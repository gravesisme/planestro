import { describe, expect, it } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { ReleasesPage } from '../../src/pages/Releases.tsx';
import { useStore } from '../../src/store.ts';
import { state } from './fixture.tsx';

describe('the releases page', () => {
  it('opens the New release dialog without a render loop', () => {
    act(() => { useStore.setState({ state: state([]) }); });
    render(<MemoryRouter initialEntries={['/releases']}><Routes><Route path="/releases" element={<ReleasesPage />} /></Routes></MemoryRouter>);
    fireEvent.click(screen.getByRole('button', { name: '+ New' }));
    expect(screen.getByRole('heading', { name: 'New release' })).toBeTruthy();
  });
});
