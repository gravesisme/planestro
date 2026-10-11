import { describe, it, expect } from 'vitest';
import { createServer } from 'node:net';
import { makeFixture } from './helpers.ts';
import { startServer } from '../src/server.ts';
import { MockEngine } from '../src/engine/MockEngine.ts';

const freePort = () => new Promise<number>((done) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = (s.address() as { port: number }).port; s.close(() => done(p)); }); });

describe('API responses are compressed', () => {
  it('gzips the JSON API for a client that accepts it, and nothing outside /api', async () => {
    const { dataDir } = makeFixture();
    const port = await freePort();
    const srv = await startServer({ dataDir, port, log: () => {}, engineFactory: (s, em) => new MockEngine(s, em) });
    try {
      const gz = { headers: { 'accept-encoding': 'gzip' } };
      const state = await fetch(`http://127.0.0.1:${port}/api/state`, gz);
      expect(state.headers.get('content-encoding')).toBe('gzip');
      expect(await state.json()).toHaveProperty('config');
      const plain = await fetch(`http://127.0.0.1:${port}/api/state`, { headers: { 'accept-encoding': 'identity' } });
      expect(plain.headers.get('content-encoding')).toBeNull();
      expect((await fetch(`http://127.0.0.1:${port}/healthz`, gz)).headers.get('content-encoding')).toBeNull();
    } finally { await srv.engine.stop(); srv.server.close(); srv.store.close(); }
  });
});
