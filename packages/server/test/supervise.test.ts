import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planFor, busyTurns, restartIdle, acquireSupervisorLock, releaseSupervisorLock, supervisorLockPath, childExitVerdict, waitUntilUp, swapWebBuild } from '../src/supervise.ts';
import { createServer } from 'node:net';
import { makeFixture } from './helpers.ts';
import { startServer } from '../src/server.ts';
import { MockEngine } from '../src/engine/MockEngine.ts';
import { EXIT_DATA_DIR_IN_USE, EXIT_PORT_IN_USE, exitCodeFor, DataDirInUseError, PortInUseError } from '../src/exitCodes.ts';

describe('serve --watch policy', () => {
  it('web-only changes rebuild and never restart the process that owns the agents', () => {
    expect(planFor(['packages/web/src/pages/Board.tsx', 'packages/web/index.html'])).toEqual({ restart: false, rebuild: true });
    expect(planFor(['packages/web/public/favicon.svg'])).toEqual({ restart: false, rebuild: true });
  });
  it('a rebuilt UI replaces dist whole, so index.html is never missing while it builds', () => {
    const web = mkdtempSync(join(tmpdir(), 'pl-web-'));
    mkdirSync(join(web, 'dist/assets'), { recursive: true });
    writeFileSync(join(web, 'dist/index.html'), 'old'); writeFileSync(join(web, 'dist/assets/old.js'), '');
    mkdirSync(join(web, 'dist.next')); writeFileSync(join(web, 'dist.next/index.html'), 'new');
    mkdirSync(join(web, 'dist.old')); // a leftover from an interrupted swap
    swapWebBuild(web);
    expect(readFileSync(join(web, 'dist/index.html'), 'utf8')).toBe('new');
    expect(existsSync(join(web, 'dist/assets/old.js'))).toBe(false);
    expect(existsSync(join(web, 'dist.next')) || existsSync(join(web, 'dist.old'))).toBe(false);
    mkdirSync(join(web, 'dist.next')); writeFileSync(join(web, 'dist.next/index.html'), 'first');
    rmSync(join(web, 'dist'), { recursive: true });
    swapWebBuild(web);
    expect(readFileSync(join(web, 'dist/index.html'), 'utf8')).toBe('first');
  });
  it('server changes restart; shared code is compiled into both halves', () => {
    expect(planFor(['packages/server/src/engine/LiveEngine.ts'])).toEqual({ restart: true, rebuild: false });
    expect(planFor(['packages/shared/src/transitions.ts'])).toEqual({ restart: true, rebuild: true });
    expect(planFor(['README.md', 'packages/server/srcs/x.ts'])).toEqual({ restart: false, rebuild: false });
  });
  it('restarts when the engine says nothing is left to lose; a server without that report falls back to busy turns (#90)', () => {
    expect(restartIdle({ engine: { restart: { idle: false, running: ['LM-24: plan turn'] }, sessions: [] } })).toBe(false);
    expect(restartIdle({ engine: { restart: { idle: true, running: [] }, sessions: [{ busy: true }] } })).toBe(true);
    expect(restartIdle({ engine: { sessions: [{ busy: true }] } })).toBe(false);
    expect(restartIdle({ engine: { sessions: [] } })).toBe(true);
    expect(restartIdle(null)).toBe(true);
  });
  it('only a running turn counts as busy: a parked session costs nothing to restart under', () => {
    expect(busyTurns({ engine: { sessions: [{ busy: true }, { busy: false }, { busy: true }] } })).toBe(2);
    expect(busyTurns({ engine: { sessions: [] } })).toBe(0);
    expect(busyTurns(null)).toBe(0);
    expect(busyTurns({})).toBe(0);
  });
});

// #85 (LM 2026-09-28): four supervisors on one data dir raced their children until none was left.
describe('serve --watch: one supervisor per data dir', () => {
  const dir = () => mkdtempSync(join(tmpdir(), 'planestro-supervise-'));
  it('a second supervisor is refused while the first is alive, and told where the first one is', () => {
    const d = dir();
    expect(acquireSupervisorLock(d, { pid: 1001, port: 4301, host: '127.0.0.1' }, () => true)).toEqual({ ok: true });
    const r = acquireSupervisorLock(d, { pid: 1002, port: 4301, host: '0.0.0.0' }, () => true);
    expect(r.ok).toBe(false);
    if (!r.ok) { expect(r.holder).toMatchObject({ pid: 1001, port: 4301 }); expect(r.message).toMatch(/already supervised by pid 1001 on :4301/); expect(r.message).toContain('http://127.0.0.1:4301'); }
    expect(JSON.parse(readFileSync(supervisorLockPath(d), 'utf8')).pid).toBe(1001);
  });
  it('a stale lock (dead pid, or unreadable) is replaced', () => {
    const d = dir();
    acquireSupervisorLock(d, { pid: 1001, port: 4301, host: '127.0.0.1' }, () => true);
    expect(acquireSupervisorLock(d, { pid: 1002, port: 4302, host: '127.0.0.1' }, (pid) => pid !== 1001)).toEqual({ ok: true });
    expect(JSON.parse(readFileSync(supervisorLockPath(d), 'utf8'))).toMatchObject({ pid: 1002, port: 4302, host: '127.0.0.1' });
    writeFileSync(supervisorLockPath(d), '{not json');
    expect(acquireSupervisorLock(d, { pid: 1003, port: 4303, host: '127.0.0.1' }, () => true)).toEqual({ ok: true });
  });
  it('the real liveness check: our own pid is alive, so a lock naming it keeps another out', () => {
    const d = dir();
    mkdirSync(join(d, '.planestro'), { recursive: true });
    writeFileSync(supervisorLockPath(d), JSON.stringify({ pid: process.pid, port: 4315, host: '127.0.0.1', started_at: 'x' }));
    expect(acquireSupervisorLock(d, { pid: process.pid + 1_000_000, port: 4316, host: '127.0.0.1' }).ok).toBe(false);
  });
  it('shutdown removes only its own lock', () => {
    const d = dir();
    acquireSupervisorLock(d, { pid: 1001, port: 4301, host: '127.0.0.1' }, () => true);
    releaseSupervisorLock(d, 1002);
    expect(existsSync(supervisorLockPath(d))).toBe(true);
    releaseSupervisorLock(d, 1001);
    expect(existsSync(supervisorLockPath(d))).toBe(false);
  });
});

describe('serve --watch: why the child died', () => {
  const o = { dataDir: '/data/LM', host: '127.0.0.1', port: 4301 };
  it('a data dir or port someone else holds stops the supervisor instead of idling', () => {
    expect(childExitVerdict(EXIT_DATA_DIR_IN_USE, null, o)).toMatchObject({ fatal: true, message: expect.stringMatching(/\/data\/LM is in use by another planestro/) });
    expect(childExitVerdict(EXIT_PORT_IN_USE, null, o)).toMatchObject({ fatal: true, message: expect.stringMatching(/port 4301 .* is taken/) });
  });
  it('an ordinary crash still waits for a source change', () => {
    expect(childExitVerdict(1, null, o)).toEqual({ fatal: false, message: 'server exited (1); waiting for a source change to start it again' });
    expect(childExitVerdict(null, 'SIGKILL', o).fatal).toBe(false);
  });
  it('serve maps the two ownership errors to their codes, anything else to 1', () => {
    expect(EXIT_DATA_DIR_IN_USE).not.toBe(EXIT_PORT_IN_USE);
    expect(exitCodeFor(new DataDirInUseError(42, '/x/.planestro/lock'))).toBe(EXIT_DATA_DIR_IN_USE);
    expect(exitCodeFor(new PortInUseError('127.0.0.1', 4301))).toBe(EXIT_PORT_IN_USE);
    expect(exitCodeFor(new Error('boom'))).toBe(1);
  });
});

describe('serve --watch: did the new child come up', () => {
  const nap = async () => {};
  it('up once /api/state answers', async () => {
    let n = 0;
    expect(await waitUntilUp(async () => ++n >= 3, { alive: () => true, nap })).toBe('up');
    expect(n).toBe(3);
  });
  it('a live child that never answers is a timeout, loudly; a dead one is left to its exit handler', async () => {
    expect(await waitUntilUp(async () => undefined, { alive: () => true, tries: 5, nap })).toBe('timeout');
    let alive = true, n = 0;
    expect(await waitUntilUp(async () => { if (++n === 2) alive = false; return undefined; }, { alive: () => alive, nap })).toBe('exited');
  });
});

describe('serve: a taken port', () => {
  it('fails as PortInUseError before the engine starts, and gives the data-dir lock back', async () => {
    const { dataDir } = makeFixture();
    const squatter = createServer();
    await new Promise<void>((r) => squatter.listen(0, '127.0.0.1', () => r()));
    const port = (squatter.address() as { port: number }).port;
    let started = false;
    const engineFactory = (store: ConstructorParameters<typeof MockEngine>[0], emit: ConstructorParameters<typeof MockEngine>[1]) => {
      const e = new MockEngine(store, emit); const start = e.start.bind(e);
      e.start = async () => { started = true; await start(); };
      return e;
    };
    try {
      await expect(startServer({ dataDir, port, log: () => {}, engineFactory })).rejects.toBeInstanceOf(PortInUseError);
      expect(started).toBe(false);
      expect(existsSync(join(dataDir, '.planestro', 'lock'))).toBe(false);
    } finally { squatter.close(); }
  });
});
