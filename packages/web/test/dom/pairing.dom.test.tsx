import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { SettingsPage } from '../../src/pages/Settings.tsx';
import { useStore } from '../../src/store.ts';
import { mockApi, state } from './fixture.tsx';
import type { PairingCode } from '../../src/api.ts';

const LINK = 'http://192.168.1.20:4395/pair?code=ABCD-EFGH';

function showAccess(minted: PairingCode) {
  const s = state([]);
  s.local = { ...s.local, mcp_servers: {}, paired_devices: [] } as typeof s.local;
  mockApi({ '/api/state': () => s, '/api/pairing/code': minted });
  useStore.setState({ state: s });
  render(<MemoryRouter><SettingsPage /></MemoryRouter>);
  fireEvent.click(screen.getByRole('button', { name: /^Access/ }));
}

describe('pairing a device from Settings → Access (#403)', () => {
  it('Access is its own tab, holding paired devices and MCP servers', () => {
    showAccess({ code: 'ABCD-EFGH', expires_at: new Date(Date.now() + 600_000).toISOString(), host: '0.0.0.0', loopback: false, links: [LINK] });
    expect(screen.getByRole('heading', { level: 2, name: 'Access' })).toBeTruthy();
    for (const g of ['Local network', 'Paired devices', 'MCP servers']) expect(screen.getByRole('heading', { level: 3, name: g })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /^This machine/ }));
    expect(screen.queryByRole('heading', { level: 3, name: 'Paired devices' })).toBeNull();
  });

  it('a minted code shows its link, a QR code of it and Copy link, with its expiry and one-time use', async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    showAccess({ code: 'ABCD-EFGH', expires_at: new Date(Date.now() + 600_000).toISOString(), host: '0.0.0.0', loopback: false,
      links: [LINK, 'http://studio.local:4395/pair?code=ABCD-EFGH'], qr: { size: 33, path: 'M4 4h7v1h-7z' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Pair a device' })); });
    const card = screen.getByRole('group', { name: 'Pairing code' });
    expect(within(card).getByText('ABCD-EFGH')).toBeTruthy();
    expect(within(card).getByText(/For one device, until .*: it stops working once used/)).toBeTruthy();
    expect(within(card).getByRole('link', { name: LINK }).getAttribute('href')).toBe(LINK);
    const qr = within(card).getByRole('img', { name: `QR code for ${LINK}` });
    expect(qr.getAttribute('viewBox')).toBe('0 0 33 33');
    expect(qr.querySelector('path')?.getAttribute('d')).toBe('M4 4h7v1h-7z');
    expect(within(card).getByText('Other addresses (1)')).toBeTruthy();
    fireEvent.click(within(card).getByRole('button', { name: 'Copy link' }));
    expect(writeText).toHaveBeenCalledWith(LINK);
  });

  it('a server bound to loopback only says another device cannot reach it, and how to change that', async () => {
    showAccess({ code: 'WXYZ-2345', expires_at: new Date(Date.now() + 600_000).toISOString(), host: '127.0.0.1', loopback: true, links: [] });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Pair a device' })); });
    const card = screen.getByRole('group', { name: 'Pairing code' });
    expect(within(card).getByText('WXYZ-2345')).toBeTruthy();
    expect(within(card).queryByRole('img')).toBeNull();
    expect(within(card).queryByRole('button', { name: 'Copy link' })).toBeNull();
    expect(card.textContent).toMatch(/listens on 127\.0\.0\.1 only, so another device can't reach it/);
    expect(card.textContent).toMatch(/--host 0\.0\.0\.0/);
  });
});
