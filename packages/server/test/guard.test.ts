import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { allowedHosts, hostnameOf, requestGuard } from '../src/guard.ts';

function app(bind = '127.0.0.1', extra: string[] = []) {
  const a = new Hono();
  a.use('*', requestGuard(allowedHosts(bind, extra)));
  a.post('/api/items', (c) => c.json({ ok: true }));
  a.get('/api/state', (c) => c.json({ ok: true }));
  return a;
}
const at = (host: string, headers: Record<string, string> = {}, method = 'GET', path = '/api/state') => ({ method, headers: { host, ...headers } });

describe('request guard: loopback is not private from the browser', () => {
  it('lets the UI in, directly and through the Vite dev proxy', async () => {
    const a = app();
    expect((await a.request('/api/state', at('127.0.0.1:4300'))).status).toBe(200);
    expect((await a.request('/api/items', at('localhost:5173', { origin: 'http://localhost:5173', 'sec-fetch-site': 'same-origin' }, 'POST'))).status).toBe(200);
    expect((await a.request('/api/state', at('[::1]:4300'))).status).toBe(200);
  });

  it('refuses a request another website makes, even a "simple" one that skips the CORS preflight', async () => {
    const r = await app().request('/api/items', { method: 'POST', headers: { host: '127.0.0.1:4300', origin: 'https://evil.example', 'content-type': 'text/plain' }, body: '{"title":"x"}' });
    expect(r.status).toBe(403);
    expect((await app().request('/api/items', at('127.0.0.1:4300', { 'sec-fetch-site': 'cross-site' }, 'POST'))).status).toBe(403);
    expect((await app().request('/api/items', at('127.0.0.1:4300', { origin: 'null' }, 'POST'))).status).toBe(403);
  });

  it('refuses a DNS-rebinding Host, and accepts a name the user declared', async () => {
    expect((await app().request('/api/state', at('attacker.example:4300'))).status).toBe(403);
    expect((await app('127.0.0.1', ['mac.tailnet.ts.net']).request('/api/state', at('mac.tailnet.ts.net:4300', { origin: 'http://mac.tailnet.ts.net:4300' }))).status).toBe(200);
  });

  it('bound to every interface, knows the machine by its addresses', () => {
    expect(allowedHosts('0.0.0.0').has('127.0.0.1')).toBe(true);
    expect(allowedHosts('0.0.0.0').size).toBeGreaterThan(3);
    expect(hostnameOf('Example.COM:80')).toBe('example.com');
  });
});
