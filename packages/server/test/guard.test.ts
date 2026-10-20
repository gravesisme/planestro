import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { allowedHosts, bindHost, hostnameOf, isLanAddress, isLoopbackBind, linkRefusal, requestGuard, sameOrigin } from '../src/guard.ts';
import { accessReport, listenUrl } from '../src/server.ts';
import { hostname } from 'node:os';

function app(bind = '127.0.0.1', extra: string[] = []) {
  const a = new Hono();
  a.use('*', requestGuard(allowedHosts(bind, extra)));
  a.post('/api/items', (c) => c.json({ ok: true }));
  a.get('/api/state', (c) => c.json({ ok: true }));
  return a;
}
const at = (host: string, headers: Record<string, string> = {}, method = 'GET', _path = '/api/state') => ({ method, headers: { host, ...headers } });

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

describe('local network access as a setting (#255)', () => {
  it('lan_access binds every interface unless --host says otherwise', () => {
    expect(bindHost(undefined, {})).toBe('127.0.0.1');
    expect(bindHost(undefined, { lan_access: false })).toBe('127.0.0.1');
    expect(bindHost(undefined, { lan_access: true })).toBe('0.0.0.0');
    expect(bindHost('127.0.0.1', { lan_access: true })).toBe('127.0.0.1');
    expect(bindHost('0.0.0.0', {})).toBe('0.0.0.0');
  });

  it('a wildcard bind links by the mDNS name a phone on the Wi-Fi resolves', () => {
    const short = hostname().toLowerCase().replace(/\.local$/, '');
    expect(listenUrl('0.0.0.0', 4300)).toBe(`http://${short}.local:4300`);
    expect(listenUrl('::', 4301)).toBe(`http://${short}.local:4301`);
  });

  it('knows a private address from a public one: IPv4, IPv6 and IPv4-mapped IPv6', () => {
    for (const a of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.254', '192.168.1.20', '169.254.3.4', '100.64.0.1', '100.101.102.103', '100.127.255.254', '::1', 'fe80::1', 'fe80::1%en0', 'FEBF::2', 'fc00::1', 'fd12:3456::9', '::ffff:192.168.1.20', '::ffff:127.0.0.1', '::FFFF:10.0.0.1'])
      expect(isLanAddress(a), a).toBe(true);
    for (const a of ['8.8.8.8', '172.15.0.1', '172.32.0.1', '192.169.0.1', '100.63.255.255', '100.128.0.1', '2001:db8::1', '2606:4700::1111', 'fec0::1', '::ffff:8.8.8.8', '::', 'garbage', ''])
      expect(isLanAddress(a), a).toBe(false);
  });

  it('with lan_access, a request from outside the LAN gets a 403 and is logged; one from the LAN gets in', async () => {
    const logged: string[] = [];
    const a = new Hono();
    a.use('*', requestGuard(allowedHosts('0.0.0.0'), (_l, m) => logged.push(m), { lanOnly: true }));
    a.get('/api/state', (c) => c.json({ ok: true }));
    const from = (address: string) => a.request('/api/state', at('127.0.0.1:4300'), { incoming: { socket: { remoteAddress: address } } });
    expect((await from('192.168.1.20')).status).toBe(200);
    expect((await from('::ffff:10.0.0.7')).status).toBe(200);
    expect((await from('203.0.113.9')).status).toBe(403);
    expect((await from('2001:db8::5')).status).toBe(403);
    expect((await a.request('/api/state', at('127.0.0.1:4300'))).status).toBe(403);   // no remote address: not evidence of a LAN
    expect(logged.filter((m) => /outside the local network/.test(m))).toHaveLength(3);
    // Without the setting the remote address is not looked at (a bare --host keeps working as before).
    expect((await app('0.0.0.0').request('/api/state', at('127.0.0.1:4300'), { incoming: { socket: { remoteAddress: '203.0.113.9' } } })).status).toBe(200);
  });

  it('check says when notifications.base_url names a host the guard would refuse', () => {
    const hosts = allowedHosts('0.0.0.0', ['mac.tailnet.ts.net']);
    expect(linkRefusal('http://mac.tailnet.ts.net:4300', hosts)).toBeUndefined();
    expect(linkRefusal('http://127.0.0.1:4300', hosts)).toBeUndefined();
    expect(linkRefusal('http://studio.example.com:4300', hosts)).toMatch(/studio\.example\.com.*403/);
    expect(linkRefusal('http://studio.local:4300', allowedHosts('127.0.0.1'))).toMatch(/403/);
    const report = accessReport({ lan_access: true }, { base_url: 'http://nas.example.com:4300' }, 4300).join('\n');
    expect(report).toMatch(/lan_access: on/);
    expect(report).toMatch(/0\.0\.0\.0/);
    expect(report).toMatch(/nas\.example\.com/);
    expect(report).toMatch(/403/);
    const off = accessReport({}, {}, 4300).join('\n');
    expect(off).toMatch(/lan_access: off/);
    expect(off).toMatch(/http:\/\/127\.0\.0\.1:4300/);
    expect(off).not.toMatch(/403/);
  });
});

describe('another port on this machine is another site', () => {
  it('refuses a page on another localhost port, which only a port-blind Origin check let in', async () => {
    const a = app();
    expect((await a.request('/api/items', at('localhost:4300', { origin: 'http://localhost:9999', 'content-type': 'application/json' }, 'POST'))).status).toBe(403);
    expect((await a.request('/api/items', at('127.0.0.1:4300', { origin: 'http://127.0.0.1:3000' }, 'POST'))).status).toBe(403);
    expect((await a.request('/api/items', at('localhost:4300', { origin: 'http://localhost:4300', 'content-type': 'application/json' }, 'POST'))).status).toBe(200);
  });

  it('refuses a same-site write, and a form or text/plain body, which skip the CORS preflight', async () => {
    const a = app();
    expect((await a.request('/api/items', at('127.0.0.1:4300', { 'sec-fetch-site': 'same-site' }, 'POST'))).status).toBe(403);
    expect((await a.request('/api/state', at('127.0.0.1:4300', { 'sec-fetch-site': 'same-site' }))).status).toBe(200);   // a link from a sibling app still opens
    expect((await a.request('/api/items', at('127.0.0.1:4300', { 'content-type': 'text/plain;charset=UTF-8' }, 'POST'))).status).toBe(403);
    expect((await a.request('/api/items', at('127.0.0.1:4300', { 'content-type': 'application/x-www-form-urlencoded' }, 'POST'))).status).toBe(403);
    expect((await a.request('/api/items', at('127.0.0.1:4300', { 'content-type': 'multipart/form-data; boundary=x' }, 'POST'))).status).toBe(200);
  });

  it('trusts a declared name as an Origin behind a proxy that rewrites Host, never a loopback one', async () => {
    const a = new Hono();
    a.use('*', requestGuard(allowedHosts('127.0.0.1', ['mac.tailnet.ts.net']), undefined, { declared: ['mac.tailnet.ts.net', 'localhost'] }));
    a.post('/api/items', (c) => c.json({ ok: true }));
    expect((await a.request('/api/items', at('127.0.0.1:4300', { origin: 'https://mac.tailnet.ts.net' }, 'POST'))).status).toBe(200);
    expect((await a.request('/api/items', at('127.0.0.1:4300', { origin: 'http://localhost:9999' }, 'POST'))).status).toBe(403);
  });

  it('compares name and port, with the default port of the scheme filled in', () => {
    expect(sameOrigin('http://localhost:5173', 'localhost:5173')).toBe(true);
    expect(sameOrigin('https://mac.ts.net', 'mac.ts.net')).toBe(true);
    expect(sameOrigin('http://mac.ts.net', 'mac.ts.net:80')).toBe(true);
    expect(sameOrigin('http://[::1]:4300', '[::1]:4300')).toBe(true);
    expect(sameOrigin('http://[::1]:4301', '[::1]:4300')).toBe(false);
    expect(sameOrigin('http://localhost', 'localhost:4300')).toBe(false);
    expect(sameOrigin('null', 'localhost:4300')).toBe(false);
    expect(sameOrigin('file:///x', 'localhost:4300')).toBe(false);
  });

  it('any bind but loopback answers only the local network', () => {
    for (const h of ['127.0.0.1', '127.0.0.2', 'localhost', '::1']) expect(isLoopbackBind(h), h).toBe(true);
    for (const h of ['0.0.0.0', '::', '192.168.1.20', 'studio.local']) expect(isLoopbackBind(h), h).toBe(false);
  });
});
