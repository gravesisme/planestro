import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { seedSample } from '../src/sample.ts';
import { EXIT_DATA_DIR_IN_USE, EXIT_PORT_IN_USE } from '../src/exitCodes.ts';
import {
  servesDataDir, instanceAlive, listInstances, liveInstance, startInstance, stopInstance, stopGroup, groupAlive,
  instancePath, uptime, type Instance, StartRefused, lockHeldBy, clearForeignLock, unrecordedHolder,
} from '../src/instances.ts';

const home = () => { const h = mkdtempSync(join(tmpdir(), 'planestro-home-')); process.env.PLANESTRO_HOME = h; return h; };
const nap = (ms: number) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise<number>((done) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = (s.address() as { port: number }).port; s.close(() => done(p)); }); });
const deadPid = () => new Promise<number>((done) => { const c = spawn(process.execPath, ['-e', '']); c.once('exit', () => done(c.pid!)); });
const record = (dataDir: string, r: Partial<Instance>): Instance => {
  const full: Instance = { data_dir: dataDir, port: 1, host: '127.0.0.1', url: 'http://127.0.0.1:1', pid: 1, pgid: 1, watch: false, log: join(dataDir, '.planestro', 'serve.log'), started_at: new Date().toISOString(), ...r };
  mkdirSync(join(dataDir, '.planestro'), { recursive: true });
  writeFileSync(instancePath(dataDir), JSON.stringify(full));
  const index = join(process.env.PLANESTRO_HOME!, 'instances');
  mkdirSync(index, { recursive: true });
  writeFileSync(join(index, `${Math.random().toString(16).slice(2)}.json`), JSON.stringify({ data_dir: dataDir }));
  return full;
};

describe('planestro start/stop/status: telling our server from anything else (#175)', () => {
  it('a command line serves a data dir only when `serve` names exactly that dir', () => {
    expect(servesDataDir('node --import tsx /p/cli.ts serve /work/hh/planning --port 4300 --watch', '/work/hh/planning')).toBe(true);
    expect(servesDataDir('npm run planestro -- serve /work/hh/planning', '/work/hh/planning')).toBe(true);
    expect(servesDataDir('node cli.ts serve /work/hh/planning-old --port 4300', '/work/hh/planning')).toBe(false);
    expect(servesDataDir('node cli.ts serve /work/lm/planning --port 4301', '/work/hh/planning')).toBe(false);
    expect(servesDataDir('vim /work/hh/planning', '/work/hh/planning')).toBe(false);
    expect(servesDataDir(undefined, '/work/hh/planning')).toBe(false);
  });
  it('a record is live only while its group exists and its pid (or its port) is still that serve', () => {
    const r = { data_dir: '/d', port: 4390, pgid: 50, pid: 50 } as Instance;
    const serve = 'node cli.ts serve /d --port 4390';
    expect(instanceAlive(r, { group: () => false, command: () => serve })).toBe(false);
    expect(instanceAlive(r, { group: () => true, command: () => serve })).toBe(true);
    // the pid was recycled for something else, and nothing serves the port
    expect(instanceAlive(r, { group: () => true, command: () => 'bash', listener: () => undefined })).toBe(false);
  });
  it('a data-dir lock is held only by a planestro on that dir, not by whatever process now has its pid', () => {
    expect(lockHeldBy('node cli.ts serve /work/hh/planning --port 4300', '/work/hh/planning')).toBe(true);
    expect(lockHeldBy('node /p/cli.ts reconcile /work/hh/planning', '/work/hh/planning')).toBe(true);
    expect(lockHeldBy('/usr/libexec/some-daemon --flag', '/work/hh/planning')).toBe(false);
    expect(lockHeldBy('node cli.ts serve /work/lm/planning --port 4301', '/work/hh/planning')).toBe(false);
    expect(lockHeldBy(undefined, '/work/hh/planning')).toBe(false);
  });
  it('a lock naming a live pid that runs something else is stale: removed before start, and stop does not chase it', () => {
    home();
    const d = mkdtempSync(join(tmpdir(), 'planestro-lock-'));
    mkdirSync(join(d, '.planestro'), { recursive: true });
    const lock = join(d, '.planestro', 'lock');
    writeFileSync(lock, JSON.stringify({ pid: process.pid, started_at: 'x' })); // alive, and it is this test, not a planestro on d
    expect(unrecordedHolder(d)).toBeUndefined();
    expect(clearForeignLock(d)).toMatchObject({ pid: process.pid });
    expect(existsSync(lock)).toBe(false);
    // a lock its own planestro really holds is left alone
    writeFileSync(lock, JSON.stringify({ pid: process.pid, started_at: 'x' }));
    expect(clearForeignLock(d, () => `node cli.ts serve ${d} --port 4300`)).toBeUndefined();
    expect(existsSync(lock)).toBe(true);
  });
  it('uptime reads at a glance', () => {
    const now = Date.parse('2026-10-02T12:00:00Z');
    expect(uptime('2026-10-02T11:59:20Z', now)).toBe('40s');
    expect(uptime('2026-10-02T09:30:00Z', now)).toBe('2h 30m');
    expect(uptime('2026-09-30T10:00:00Z', now)).toBe('2d 2h');
  });
});

describe('planestro status: stale records are pruned (#175)', () => {
  beforeEach(() => { home(); });
  it('a dead pid, and a pid now running something else, are dropped from the data dir and the index; a live one stays', async () => {
    const dead = mkdtempSync(join(tmpdir(), 'planestro-dead-'));
    record(dead, { pid: await deadPid(), pgid: await deadPid() });
    const recycled = mkdtempSync(join(tmpdir(), 'planestro-recycled-'));
    record(recycled, { pid: process.pid, pgid: process.pid, port: await freePort() }); // alive, but it is this test, not a serve
    const { live, pruned } = listInstances();
    expect(live).toEqual([]);
    expect(pruned.sort()).toEqual([dead, recycled].sort());
    expect(existsSync(instancePath(dead))).toBe(false);
    expect(existsSync(instancePath(recycled))).toBe(false);
    expect(readdirSync(join(process.env.PLANESTRO_HOME!, 'instances'))).toEqual([]);
    expect(liveInstance(dead)).toBeUndefined();
  });
});

describe('planestro stop: the whole process group (#175)', () => {
  it('catches a child a --watch supervisor restarted after start recorded it, even one that ignores SIGTERM', async () => {
    const out = join(mkdtempSync(join(tmpdir(), 'planestro-group-')), 'child.pid');
    // A stand-in supervisor: it replaces its first child (a restart), then on SIGTERM exits without
    // stopping the new one. Stopping only the recorded pid would leave that child running.
    const script = `
      const { spawn } = require('node:child_process'); const fs = require('node:fs');
      const kid = () => spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: 'ignore' });
      const first = kid();
      setTimeout(() => { first.kill('SIGKILL'); fs.writeFileSync(${JSON.stringify(out)}, String(kid().pid)); }, 300);
      process.on('SIGTERM', () => process.exit(0));
      setInterval(() => {}, 1000);`;
    const leader = spawn(process.execPath, ['-e', script], { detached: true, stdio: 'ignore' });
    leader.unref();
    for (let i = 0; i < 50 && !existsSync(out); i++) await nap(100);
    const restarted = Number(readFileSync(out, 'utf8'));
    expect(groupAlive(leader.pid!)).toBe(true);
    expect(await stopGroup(leader.pid!, { graceMs: 1000 })).toBe('killed');
    expect(groupAlive(leader.pid!)).toBe(false);
    expect(() => process.kill(restarted, 0)).toThrow();
  });
  it('refuses to signal its own process group', async () => {
    await expect(stopGroup(process.pid)).rejects.toThrow(/own/);
  });
});

describe('planestro start/stop with real servers: two instances side by side (#175)', () => {
  const started: Instance[] = [];
  afterAll(async () => { for (const r of started) await stopGroup(r.pgid, { graceMs: 3000 }).catch(() => undefined); });

  it('refuses a second start on the same data dir or port, and stopping one leaves the other running', async () => {
    home();
    const a = (await seedSample(join(mkdtempSync(join(tmpdir(), 'planestro-a-')), 's'))).dataDir;
    const b = (await seedSample(join(mkdtempSync(join(tmpdir(), 'planestro-b-')), 's'))).dataDir;
    const c = (await seedSample(join(mkdtempSync(join(tmpdir(), 'planestro-c-')), 's'))).dataDir;
    const [pa, pb] = [await freePort(), await freePort()];

    const ra = await startInstance({ dataDir: a, port: pa });
    started.push(ra.instance);
    expect(ra.corrections).toEqual(expect.any(Array));
    expect(ra.instance.pgid).toBe(ra.instance.pid); // its own session: it outlives the terminal that ran start
    const rb = await startInstance({ dataDir: b, port: pb, watch: true });
    started.push(rb.instance);

    // The same start again is a no-op that reports the running server: a wrapper's desired state already holds.
    const again = await startInstance({ dataDir: a, port: pa });
    expect(again).toMatchObject({ already: true, instance: { pid: ra.instance.pid, pgid: ra.instance.pgid, port: pa } });
    const refused = async (p: Promise<unknown>) => { try { await p; return undefined; } catch (e) { return e as StartRefused; } };
    const otherPort = await refused(startInstance({ dataDir: a, port: await freePort() }));
    expect(otherPort?.message).toMatch(/already has a server on 127\.0\.0\.1:\d+, not the/);
    expect(otherPort?.exitCode).toBe(EXIT_DATA_DIR_IN_USE);
    const samePort = await refused(startInstance({ dataDir: c, port: pa }));
    expect(samePort?.exitCode).toBe(EXIT_PORT_IN_USE);
    expect(liveInstance(c)).toBeUndefined();
    expect(listInstances().live.map((r) => r.data_dir).sort()).toEqual([a, b].sort());

    expect(listInstances().live.map((r) => r.data_dir).sort()).toEqual([a, b].sort());
    expect(await stopInstance(rb.instance)).toBe('stopped');
    expect(groupAlive(rb.instance.pgid)).toBe(false); // the --watch supervisor and its child both
    expect(liveInstance(b)).toBeUndefined();
    expect((await fetch(`${ra.instance.url}/healthz`)).ok).toBe(true);
    expect(listInstances().live.map((r) => r.data_dir)).toEqual([a]);

    expect(await stopInstance(ra.instance)).toBe('stopped');
    expect(listInstances().live).toEqual([]);
  }, 120_000);
});
