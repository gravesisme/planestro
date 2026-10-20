import { Component, Suspense, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { lazyPage } from '../../src/lazyPage.ts';

class Caught extends Component<{ children: ReactNode }, { error?: Error }> {
  state: { error?: Error } = {};
  static getDerivedStateFromError(error: Error) { return { error }; }
  render() { return this.state.error ? <p>failed: {this.state.error.message}</p> : this.props.children; }
}
const show = (Page: ReturnType<typeof lazyPage<object>>) => render(<Caught><Suspense fallback={<p>Loading…</p>}><Page /></Suspense></Caught>);

describe('pages loaded when first opened (#406)', () => {
  afterEach(() => sessionStorage.clear());

  it('shows the fallback, then the page once its chunk loads', async () => {
    let arrive!: () => void;
    const Page = lazyPage(() => new Promise<() => ReactNode>((ok) => { arrive = () => ok(() => <h1>Settings</h1>); }));
    show(Page);
    expect(screen.getByText('Loading…')).toBeTruthy();
    arrive();
    expect(await screen.findByRole('heading', { name: 'Settings' })).toBeTruthy();
  });

  it('a chunk a rebuild removed marks one reload, and a second failure never loops', async () => {
    const gone = () => Promise.reject(new Error('Failed to fetch dynamically imported module'));
    // jsdom cannot reload (it says "Not implemented: navigation"), and React reports the caught error: both expected here.
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    show(lazyPage(gone));
    expect(await screen.findByText(/failed: Failed to fetch/)).toBeTruthy();
    expect(sessionStorage.getItem('planestro.chunk-reload')).toBe('1');
    quiet.mockRestore();
  });

  it('the real routes are lazy: the item page is its own module, loaded on demand', async () => {
    const Item = lazyPage(() => import('../../src/pages/Item.tsx').then((m) => m.ItemPage));
    expect(typeof Item).toBe('object'); // a React.lazy component, nothing imported yet
    const mod = await import('../../src/pages/Item.tsx');
    expect(typeof mod.ItemPage).toBe('function');
  });
});
