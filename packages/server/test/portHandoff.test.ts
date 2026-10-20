import { describe, it, expect, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { holdPort, offerPort, PORT_HANDOFF_ENV, type HeldPort } from '../src/portHandoff.ts';
import { startServer } from '../src/server.ts';
import { MockEngine } from '../src/engine/MockEngine.ts';
import { makeFixture } from './helpers.ts';

// A stand-in for the server child: it takes the supervisor's socket when it is handed one (receivePort, the real
// module), else binds PORT itself, as a child of an older supervisor does. Its SIGTERM closes the listener first,
// as startServer's shutdown does on a held port.
const MODULE = fileURLToPath(new URL('../src/portHandoff.ts', import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'planestro-handoff-'));
const CHILD = join(dir, 'child.mjs');
writeFileSync(CHILD, `
import http from 'node:http';
import { receivePort } from ${JSON.stringify(MODULE)};
const handed = await receivePort(5000);
const s = http.createServer((q, r) => r.end(String(process.pid)));
s.listen(handed ? handed.handle : { port: Number(process.env.PORT), host: '127.0.0.1' }, () => console.log(handed ? 'up handed' : 'up bound'));
process.on('SIGTERM', () => { s.close(() => process.exit(0)); s.closeIdleConnections(); });
`);

const children: ChildProcess[] = [];
const held: HeldPort[] = [];
afterEach(() => { for (const c of children.splice(0)) c.kill('SIGKILL'); for (const h of held.splice(0)) h.close(); });

function startChild(o: { held?: HeldPort; port?: number }): Promise<{ child: ChildProcess; how: string }> {
  const child = spawn(process.execPath, ['--import', 'tsx', CHILD], {
    stdio: o.held ? ['ignore', 'pipe', 'inherit', 'ipc'] : ['ignore', 'pipe', 'inherit'],
    env: { ...process.env, PORT: String(o.port ?? ''), [PORT_HANDOFF_ENV]: o.held ? '1' : '' },
  });
  children.push(child);
  if (o.held) offerPort(child, o.held);
  return new Promise((done, fail) => {
    child.stdout!.on('data', (d: Buffer) => { const m = /up (\w+)/.exec(String(d)); if (m) done({ child, how: m[1]! }); });
    child.once('exit', (code) => fail(new Error(`child exited ${code} before listening`)));
  });
}
const stopChild = (c: ChildProcess) => new Promise<void>((done) => { if (c.exitCode !== null) return done(); c.once('exit', () => done()); c.kill('SIGTERM'); });
// A fresh connection each time (no keep-alive): a refused connect is exactly what #354 is about.
const get = (port: number) => new Promise<string>((done, fail) => {
  request({ host: '127.0.0.1', port, agent: false }, (r) => { let b = ''; r.on('data', (d) => (b += d)); r.on('end', () => done(b)); }).on('error', fail).end();
});
const nap = (ms: number) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise<number>((done) => { const s = createServer().listen(0, '127.0.0.1', () => { const p = (s.address() as AddressInfo).port; s.close(() => done(p)); }); });

describe('serve --watch keeps the port open across a restart (#354)', () => {
  it('requests in flight across three restarts all land: none is refused, the ones sent in the gap wait for the next child', async () => {
    const h = holdPort('127.0.0.1', 0);
    if ('error' in h) throw new Error(h.error);
    held.push(h);
    let { child, how } = await startChild({ held: h });
    expect(how).toBe('handed');
    const failures: string[] = [];
    const servedBy = new Set<string>();
    let down = false, sentInGap = 0, ok = 0, going = true;
    const hammer = async () => {
      while (going) {
        if (down) sentInGap++;
        try { servedBy.add(await get(h.port)); ok++; } catch (e) { failures.push((e as NodeJS.ErrnoException).code ?? String(e)); }
      }
    };
    const loops = [hammer(), hammer(), hammer()];
    for (let i = 0; i < 3; i++) {
      await nap(150);
      down = true;
      await stopChild(child);
      await nap(300);           // the restart gap: a real child takes seconds to start
      ({ child } = await startChild({ held: h }));
      down = false;
    }
    await nap(150);
    going = false;
    await Promise.all(loops);
    expect(failures).toEqual([]);
    expect(sentInGap).toBeGreaterThan(0);
    expect(servedBy.size).toBe(4);
    expect(ok).toBeGreaterThan(sentInGap);
  }, 60_000);

  it('a child of an older supervisor (no port handed) binds its own, and in that gap a request is refused', async () => {
    const port = await freePort();
    const first = await startChild({ port });
    expect(first.how).toBe('bound');
    expect(Number(await get(port))).toBe(first.child.pid);
    await stopChild(first.child);
    await expect(get(port)).rejects.toMatchObject({ code: 'ECONNREFUSED' });
  }, 30_000);

  it('a name is not held (the child binds it), and a port someone else listens on still fails as EADDRINUSE when the child listens', async () => {
    expect(holdPort('localhost', 0)).toEqual({ error: 'localhost is not an IP address' });
    const port = await freePort();
    const taken = createServer().listen(port, '127.0.0.1');
    await new Promise((r) => taken.once('listening', r));
    try {
      // The bind alone may pass (SO_REUSEADDR); the listen is what fails, and startServer reports it as PortInUseError (exit 11).
      const h = holdPort('127.0.0.1', port);
      if ('error' in h) { expect(h.error).toMatch(/EADDRINUSE/); return; }
      held.push(h);
      const child = createServer();
      const err = await new Promise<NodeJS.ErrnoException>((done) => { child.once('error', done); child.listen(h.handle as never); });
      expect(err.code).toBe('EADDRINUSE');
    } finally { taken.close(); }
  });

  it('startServer serves on the handed socket, at its host and port, over the --port flag', async () => {
    const { dataDir } = makeFixture();
    const h = holdPort('127.0.0.1', 0);
    if ('error' in h) throw new Error(h.error);
    held.push(h);
    const lines: string[] = [];
    const srv = await startServer({ dataDir, port: 1, log: (_l, m) => lines.push(m), engineFactory: (st, em) => new MockEngine(st, em), listen: { host: h.host, port: h.port, handle: h.handle } });
    try {
      expect((await fetch(`http://127.0.0.1:${h.port}/healthz`)).status).toBe(200);
      expect(lines.some((m) => m.includes(`on http://127.0.0.1:${h.port}`))).toBe(true);
    } finally { await srv.engine.stop(); srv.server.close(); srv.store.close(); }
  });
});
