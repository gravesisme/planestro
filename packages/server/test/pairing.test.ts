import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { request as httpRequest } from 'node:http';
import { createServer } from 'node:net';
import { networkInterfaces } from 'node:os';
import type { LocalConfig } from '@planestro/shared';
import { allowedHosts, fromThisMachine, isLanAddress, requestGuard } from '../src/guard.ts';
import { CODE_TTL_MS, MAX_FAILURES, PAIR_SCRIPT, Pairing, TOKEN_COOKIE, normalizeCode, pairLinks, pairingGuard, pairingRoutes, qrOf, type MintedCode, type PairNet, type PairingStore } from '../src/pairing.ts';
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
/** fromThisMachine on a bare loopback request with these headers (it also guards settings that run commands). */
function fromThisMachineOf(headers: Record<string, string>): boolean {
  let seen = false;
  const a = new Hono();
  a.get('/', (c) => { seen = fromThisMachine(c); return c.text(''); });
  void a.request('/', { headers }, LOOP);
  return seen;
}
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

  it('a loopback request a proxy relayed (a forwarding header) is not this machine: it must pair, and cannot mint', async () => {
    const { a } = app();
    const proxied: Record<string, string>[] = [{ forwarded: 'for=192.168.1.20' }, { 'x-forwarded-for': '192.168.1.20' }, { 'x-forwarded-host': 'mac.tailnet.ts.net' }, { 'x-forwarded-proto': 'https' },
      { 'x-real-ip': '100.101.102.103' }, { 'tailscale-user-login': 'someone@example.com' }, { 'tailscale-user-name': 'Someone' }, { via: '1.1 caddy' }];
    for (const h of proxied) {
      expect((await a.request('/api/state', req('GET', h), LOOP)).status, JSON.stringify(h)).toBe(401);
      expect((await a.request('/mcp', req('POST', h, {}), LOOP)).status, JSON.stringify(h)).toBe(401);
      expect((await a.request('/api/pairing/code', req('POST', h, {}), LOOP)).status, JSON.stringify(h)).toBe(401);
    }
    // Paired, a proxied device gets in, but still mints nothing.
    const { code } = await (await a.request('/api/pairing/code', req('POST', {}, {}), LOOP)).json() as { code: string };
    const via = { 'x-forwarded-for': '192.168.1.20' };
    const paired = await a.request('/api/pair', req('POST', via, { code, name: 'via proxy' }), LOOP);
    expect(paired.status).toBe(200);
    const jar = { ...via, cookie: paired.headers.get('set-cookie')!.split(';')[0] };
    expect((await a.request('/api/state', req('GET', jar), LOOP)).status).toBe(200);
    expect((await a.request('/api/pairing/code', req('POST', jar, {}), LOOP)).status).toBe(403);
    // Loopback with no forwarding header stays token-free.
    expect((await a.request('/api/state', req('GET'), LOOP)).status).toBe(200);
    expect(fromThisMachineOf({ 'x-forwarded-for': '1.2.3.4' })).toBe(false);
    expect(fromThisMachineOf({})).toBe(true);
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
      const { code, links } = await (await fetch(`http://127.0.0.1:${port}/api/pairing/code`, { method: 'POST', headers: { 'content-type': 'application/json' } })).json() as MintedCode;
      expect(links).toContain(`${lan}/pair?code=${code}`);
      expect((await fetch(`${lan}/pair?code=${code}`)).status).toBe(200);
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

describe('pairing links and the QR code (#403)', () => {
  const ifaces = {
    lo0: [{ address: '127.0.0.1', family: 'IPv4', internal: true }, { address: '::1', family: 'IPv6', internal: true }],
    utun4: [{ address: '100.101.102.103', family: 'IPv4', internal: false }],
    en0: [{ address: 'fe80::1', family: 'IPv6', internal: false }, { address: '192.168.1.20', family: 'IPv4', internal: false }],
    en9: [{ address: '203.0.113.9', family: 'IPv4', internal: false }],
  } as unknown as PairNet['interfaces'];
  const net = (hostname: string): PairNet => ({ interfaces: ifaces, hostname });

  it('a loopback bind has no link to offer; every interface offers each LAN address and the .local name, the code in the query', () => {
    expect(pairLinks({ host: '127.0.0.1', port: 4395 }, 'ABCD-EFGH', net('Studio.local'))).toEqual([]);
    expect(pairLinks({ host: 'localhost', port: 4395 }, 'ABCD-EFGH', net('Studio.local'))).toEqual([]);
    expect(pairLinks({ host: '0.0.0.0', port: 4395 }, 'ABCD-EFGH', net('Studio.local'))).toEqual([
      'http://192.168.1.20:4395/pair?code=ABCD-EFGH', 'http://100.101.102.103:4395/pair?code=ABCD-EFGH', 'http://studio.local:4395/pair?code=ABCD-EFGH']);
    // A hostname that is not a .local name is not offered; a public address is not either (the guard refuses it).
    expect(pairLinks({ host: '0.0.0.0', port: 4395 }, 'ABCD-EFGH', net('studio'))).toEqual(['http://192.168.1.20:4395/pair?code=ABCD-EFGH', 'http://100.101.102.103:4395/pair?code=ABCD-EFGH']);
    expect(pairLinks({ host: '192.168.1.20', port: 4395 }, 'ABCD-EFGH', net('studio'))).toEqual(['http://192.168.1.20:4395/pair?code=ABCD-EFGH']);
  });

  it('a QR code is one path of dark runs over its grid, quiet zone included', () => {
    const qr = qrOf('http://192.168.1.20:4395/pair?code=ABCD-EFGH');
    expect(qr.size).toBeGreaterThanOrEqual(21 + 8);
    expect(qr.path.startsWith('M4 4h7v1h-7z')).toBe(true);   // the top-left finder's top edge, after a 4-module border
    expect(qr.path).toMatch(/^(M\d+ \d+h\d+v1h-\d+z)+$/);
  });

  function mintApp(bind: { host: string; port: number }) {
    const a = new Hono();
    a.use('*', requestGuard(allowedHosts('0.0.0.0'), undefined, { lanOnly: true }));
    const pairing = new Pairing(memoryStore());
    a.use('*', pairingGuard(pairing));
    pairingRoutes(a, pairing, bind, net('studio.local'));
    a.get('/api/state', (c) => c.json({ ok: true }));
    return a;
  }

  it('minting on a loopback-bound server says so and offers no link', async () => {
    const r = await (await mintApp({ host: '127.0.0.1', port: 4395 }).request('/api/pairing/code', req('POST', {}, {}), LOOP)).json() as MintedCode;
    expect(r).toMatchObject({ host: '127.0.0.1', loopback: true, links: [] });
    expect(r.qr).toBeUndefined();
    expect(r.code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  });

  it('minting on a server bound to every interface gives LAN links carrying the code (never a token) and a QR of the first', async () => {
    const a = mintApp({ host: '0.0.0.0', port: 4395 });
    const r = await (await a.request('/api/pairing/code', req('POST', {}, {}), LOOP)).json() as MintedCode;
    expect(r.loopback).toBe(false);
    expect(r.links[0]).toBe(`http://192.168.1.20:4395/pair?code=${r.code}`);
    for (const l of r.links) expect([...new URL(l).searchParams]).toEqual([['code', r.code]]);
    expect(r.qr?.path).toMatch(/^M4 4h7/);
    // The link's code pairs once from the LAN, and the token it gives is in none of the links.
    const paired = await a.request('/api/pair', req('POST', {}, { code: new URL(r.links[0]).searchParams.get('code'), name: 'phone' }), LAN);
    const { token } = await paired.json() as { token: string };
    expect(token).toBeTruthy();
    expect(JSON.stringify(r)).not.toContain(token);
    expect((await a.request('/api/pair', req('POST', {}, { code: r.code, name: 'again' }), LAN)).status).toBe(401);
  });

  it('the /pair page opens unpaired with ?code=, fills the code in, drops it from the address bar and sends nothing until Pair', async () => {
    const a = mintApp({ host: '0.0.0.0', port: 4395 });
    const page = await a.request('/pair?code=ABCD-EFGH', req('GET', { accept: 'text/html' }), LAN);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('<input id="code"');
    type El = { value: string; focused?: boolean; focus(): void; addEventListener(t: string, f: unknown): void };
    const els: Record<string, El> = {};
    for (const id of ['code', 'name', 'pair', 'out']) els[id] = { value: '', focus() { this.focused = true; }, addEventListener() {} };
    const replaced: unknown[][] = [];
    let fetched = 0;
    const run = (search: string) => new Function('document', 'location', 'history', 'fetch', PAIR_SCRIPT)(
      { getElementById: (id: string) => els[id] }, { search, pathname: '/pair' }, { replaceState: (...args: unknown[]) => replaced.push(args) }, () => { fetched++; });
    run('?code=ABCD-EFGH');
    expect(els.code.value).toBe('ABCD-EFGH');
    expect(els.name.focused).toBe(true);
    expect(replaced).toEqual([[null, '', '/pair']]);
    expect(fetched).toBe(0);
    els.code.value = '';
    run('');
    expect(els.code.value).toBe('');
    expect(replaced).toHaveLength(1);
  });
});
