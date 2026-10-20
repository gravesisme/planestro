import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { request as httpRequest } from 'node:http';
import { createServer } from 'node:net';
import { networkInterfaces } from 'node:os';
import type { LocalConfig } from '@planestro/shared';
import { allowedHosts, isLanAddress, requestGuard } from '../src/guard.ts';
import { CODE_TTL_MS, MAX_FAILURES, Pairing, TOKEN_COOKIE, normalizeCode, pairingGuard, pairingRoutes, type PairingStore } from '../src/pairing.ts';
import { publicLocal } from '../src/routes/views.ts';
import { startServer } from '../src/server.ts';
import { MockEngine } from '../src/engine/MockEngine.ts';
import { makeFixture } from './helpers.ts';

function memoryStore(): PairingStore & { writes: number } {
  const s = { local: { mcp_servers: {}, update: { channel: 'off', poll_min: 15, min_age_hours: 0 }, engine: { paused: false } } as unknown as LocalConfig, writes: 0,
    updateLocal(patch: Partial<LocalConfig>) { s.local = { ...s.local, ...patch }; s.writes++; return s.local; } };
  return s;
}

describe('pairing codes and tokens (#403)', () => {
  it('trades a one-time code for a token stored only as a hash, and a revoked token stops matching', () => {
    const store = memoryStore();
    const p = new Pairing(store);
    const { code } = p.mint();
    expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    const r = p.redeem(code.toLowerCase().replace('-', ' '), 'phone');
    if ('error' in r) throw new Error(r.error);
    expect(r.device.name).toBe('phone');
    expect(store.local.paired_devices).toHaveLength(1);
    expect(JSON.stringify(store.local)).not.toContain(r.token);
    expect(p.check(r.token)?.id).toBe(r.device.id);
    expect(p.check(`${r.token}x`)).toBeUndefined();
    expect(p.check(undefined)).toBeUndefined();
    expect('error' in p.redeem(code, 'again')).toBe(true);   // once only
    expect(p.revoke(r.device.id)).toBe(true);
    expect(p.check(r.token)).toBeUndefined();
    expect(p.revoke(r.device.id)).toBe(false);
  });

  it('expires a code, and too many wrong codes void every pending one', () => {
    let t = 1_000_000;
    const p = new Pairing(memoryStore(), () => t);
    const late = p.mint().code;
    t += CODE_TTL_MS + 1;
    expect(p.redeem(late, 'x')).toMatchObject({ error: expect.stringMatching(/wrong or expired/) });
    const good = p.mint().code;
    for (let i = 1; i < MAX_FAILURES; i++) expect(p.redeem('AAAA-AAAA', 'x')).toMatchObject({ error: expect.stringMatching(/wrong or expired/) });
    expect(p.redeem('AAAA-AAAA', 'x')).toMatchObject({ error: expect.stringMatching(/too many wrong codes/) });
    expect('error' in p.redeem(good, 'x')).toBe(true);
    expect(normalizeCode(' ab-cd efgh ')).toBe('ABCDEFGH');
  });

  it('the page never learns a token hash', () => {
    const store = memoryStore();
    const p = new Pairing(store);
    p.redeem(p.mint().code, 'phone');
    const shown = publicLocal(store.local);
    expect(shown.paired_devices?.[0].token_sha256).toBe('(set)');
    expect(shown.paired_devices?.[0].name).toBe('phone');
  });
});

/** The server's middleware order: the request guard, then pairing, then the routes. */
function app(store = memoryStore()) {
  const a = new Hono();
  a.use('*', requestGuard(allowedHosts('0.0.0.0'), undefined, { lanOnly: true }));
  const pairing = new Pairing(store);
  a.use('*', pairingGuard(pairing));
  pairingRoutes(a, pairing);
  a.get('/api/state', (c) => c.json({ ok: true }));
  a.post('/mcp', (c) => c.json({ ok: true }));
  a.get('/ws', (c) => c.text('upgrade'));
  a.get('/attachments/x.png', (c) => c.text('png'));
  a.get('*', (c) => c.html('<p>board</p>'));
  return { a, pairing, store };
}
const LAN = { incoming: { socket: { remoteAddress: '192.168.1.20' } } };
const LOOP = { incoming: { socket: { remoteAddress: '127.0.0.1' } } };
const req = (method: string, headers: Record<string, string> = {}, body?: unknown) => ({ method, headers: { host: '127.0.0.1:4300', ...(body ? { 'content-type': 'application/json' } : {}), ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) });

describe('the pairing guard (#403)', () => {
  it('this machine needs no token, exactly as before', async () => {
    const { a } = app();
    expect((await a.request('/api/state', req('GET'), LOOP)).status).toBe(200);
    expect((await a.request('/mcp', req('POST', {}, {}), { incoming: { socket: { remoteAddress: '::1' } } })).status).toBe(200);
  });

  it('a LAN request without a token gets a 401 (a page load goes to /pair), except the pairing page itself', async () => {
    const { a } = app();
    for (const [path, method] of [['/api/state', 'GET'], ['/mcp', 'POST'], ['/ws', 'GET'], ['/attachments/x.png', 'GET']] as const) {
      const r = await a.request(path, req(method, { accept: 'text/html' }, method === 'POST' ? {} : undefined), LAN);
      expect(r.status, path).toBe(401);
      expect(r.headers.get('www-authenticate')).toMatch(/Bearer/);
    }
    const page = await a.request('/', req('GET', { accept: 'text/html' }), LAN);
    expect(page.status).toBe(302);
    expect(page.headers.get('location')).toBe('/pair');
    expect((await a.request('/pair', req('GET'), LAN)).status).toBe(200);
    expect((await a.request('/pair.js', req('GET'), LAN)).headers.get('content-type')).toMatch(/javascript/);
  });

  it('pairs from the LAN with a code minted on this machine; the cookie and the bearer token both work until revoked', async () => {
    const { a } = app();
    expect((await a.request('/api/pairing/code', req('POST', {}, {}), LAN)).status).toBe(401);   // unpaired: the guard, before the route's own 403
    const { code } = await (await a.request('/api/pairing/code', req('POST', {}, {}), LOOP)).json() as { code: string };
    expect((await a.request('/api/pair', req('POST', {}, { code: 'ZZZZ-ZZZZ', name: 'phone' }), LAN)).status).toBe(401);
    const paired = await a.request('/api/pair', req('POST', {}, { code, name: 'phone' }), LAN);
    expect(paired.status).toBe(200);
    const { token, device } = await paired.json() as { token: string; device: { id: string } };
    const cookie = paired.headers.get('set-cookie')!;
    expect(cookie).toMatch(new RegExp(`^${TOKEN_COOKIE}=`));
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Strict/);
    const jar = { cookie: cookie.split(';')[0] };
    expect((await a.request('/api/state', req('GET', jar), LAN)).status).toBe(200);
    expect((await a.request('/ws', req('GET', jar), LAN)).status).toBe(200);
    expect((await a.request('/', req('GET', { ...jar, accept: 'text/html' }), LAN)).status).toBe(200);
    expect((await a.request('/mcp', req('POST', { authorization: `Bearer ${token}` }, {}), LAN)).status).toBe(200);
    expect((await a.request('/mcp', req('POST', { authorization: 'Bearer nope' }, {}), LAN)).status).toBe(401);
    // A paired device may list and revoke; minting stays on this machine.
    expect((await (await a.request('/api/pairing/devices', req('GET', jar), LAN)).json() as { devices: unknown[] }).devices).toHaveLength(1);
    expect((await a.request('/api/pairing/code', req('POST', jar, {}), LAN)).status).toBe(403);
    expect((await a.request(`/api/pairing/devices/${device.id}`, req('DELETE'), LOOP)).status).toBe(200);
    expect((await a.request('/api/state', req('GET', jar), LAN)).status).toBe(401);
    expect((await a.request('/mcp', req('POST', { authorization: `Bearer ${token}` }, {}), LAN)).status).toBe(401);
  });

  it('a request from outside the LAN is still refused by the request guard first, token or not', async () => {
    const { a } = app();
    expect((await a.request('/pair', req('GET'), { incoming: { socket: { remoteAddress: '203.0.113.9' } } })).status).toBe(403);
  });
});

const freePort = () => new Promise<number>((done) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = (s.address() as { port: number }).port; s.close(() => done(p)); }); });
const lanIp = Object.values(networkInterfaces()).flat().find((a) => a && a.family === 'IPv4' && !a.internal && isLanAddress(a.address))?.address;

/** A WebSocket upgrade's status line: 101 when it is accepted, else the refusal's status. */
function upgrade(host: string, port: number, headers: Record<string, string> = {}): Promise<number> {
  return new Promise((done, fail) => {
    const r = httpRequest({ host, port, path: '/ws', headers: { connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', ...headers } });
    r.on('upgrade', (res, socket) => { socket.destroy(); done(res.statusCode ?? 0); });
    r.on('response', (res) => { res.resume(); done(res.statusCode ?? 0); });
    r.on('error', fail);
    r.end();
  });
}

describe.skipIf(!lanIp)('a real server bound beyond loopback (#403)', () => {
  it('answers this machine as before, and a LAN peer only once paired: API, /mcp and the WebSocket', async () => {
    const { dataDir } = makeFixture();
    const port = await freePort();
    const srv = await startServer({ dataDir, port, host: '0.0.0.0', log: () => {}, engineFactory: (s, em) => new MockEngine(s, em) });
    try {
      const lan = `http://${lanIp}:${port}`;
      expect((await fetch(`http://127.0.0.1:${port}/api/state`)).status).toBe(200);
      expect(await upgrade('127.0.0.1', port)).toBe(101);
      expect((await fetch(`${lan}/api/state`)).status).toBe(401);
      expect((await fetch(`${lan}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: '{}' })).status).toBe(401);
      expect(await upgrade(lanIp!, port)).toBe(401);
      const { code } = await (await fetch(`http://127.0.0.1:${port}/api/pairing/code`, { method: 'POST', headers: { 'content-type': 'application/json' } })).json() as { code: string };
      const paired = await fetch(`${lan}/api/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, name: 'laptop' }) });
      expect(paired.status).toBe(200);
      const { token } = await paired.json() as { token: string };
      const cookie = paired.headers.get('set-cookie')!.split(';')[0];
      expect((await fetch(`${lan}/api/state`, { headers: { cookie } })).status).toBe(200);
      expect(await upgrade(lanIp!, port, { cookie })).toBe(101);
      const init = await fetch(`${lan}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } }) });
      expect(init.status).toBe(200);
      expect(srv.store.local.paired_devices?.map((d) => d.name)).toEqual(['laptop']);
    } finally { await srv.engine.stop(); srv.server.close(); srv.store.close(); }
  });
});
