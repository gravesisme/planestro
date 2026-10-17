import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Hono } from 'hono';
import { appCsp, serveWeb } from '../src/server.ts';

/**
 * #280: an installed iPhone web app came back from the background to a black screen. A reload must never be answered
 * with a stale page, so the page that names the bundles is always revalidated; the hashed bundles may be cached.
 */
describe('the web shell is never served stale (#280)', () => {
  const dist = mkdtempSync(join(tmpdir(), 'planestro-web-'));
  mkdirSync(join(dist, 'assets'));
  writeFileSync(join(dist, 'index.html'), '<!doctype html><script type="module" src="/assets/index-abc.js"></script>');
  writeFileSync(join(dist, 'assets', 'index-abc.js'), 'console.log(1)');
  const app = new Hono();
  serveWeb(app, dist);

  it('the page itself, at /, /index.html and any app route, says no-cache', async () => {
    for (const path of ['/', '/index.html', '/items/TP-1', '/schedules']) {
      const r = await app.request(path);
      expect(r.status, path).toBe(200);
      expect(await r.text(), path).toContain('/assets/index-abc.js');
      expect(r.headers.get('cache-control'), path).toBe('no-cache');
    }
  });

  it('a hashed bundle is not marked no-cache', async () => {
    const r = await app.request('/assets/index-abc.js');
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).not.toBe('no-cache');
  });
});

describe('the app shell refuses to load anything from elsewhere', () => {
  const dist = mkdtempSync(join(tmpdir(), 'planestro-web-'));
  writeFileSync(join(dist, 'index.html'), '<!doctype html>');
  const app = new Hono();
  serveWeb(app, dist);

  it('sends a CSP whose images, scripts and connections are planestro alone, naming its WebSocket', async () => {
    const csp = (await app.request('/items/TP-1', { headers: { host: 'studio.local:4300' } })).headers.get('content-security-policy')!;
    expect(csp).toMatch(/img-src 'self' data: blob:/);
    expect(csp).toMatch(/script-src 'self';/);
    expect(csp).toMatch(/connect-src 'self' ws:\/\/studio\.local:4300 wss:\/\/studio\.local:4300/);
    expect(csp).toMatch(/frame-ancestors 'none'/);
    expect(appCsp('evil" ; script-src *')).not.toMatch(/evil/);
  });
});
