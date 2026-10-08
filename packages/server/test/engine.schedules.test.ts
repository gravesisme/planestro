/**
 * Scheduled and recurring items (#247): a schedule files one item per cron slot, keyed
 * `<schedule>:<slot>` so a restart never files twice; `skip_if_open` skips while the last one is
 * unfinished; AUTOMATION PAUSED stops the filing; only a schedule the user made submits what it files.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isoLocal } from '@planestro/shared';
import { DataStore } from '../src/store/DataStore.ts';
import { LiveEngine } from '../src/engine/LiveEngine.ts';
import { FakeWorld, DryRunGitPort, DryRunGhPort, DryRunProcPort, DryRunClaudePort } from '../src/engine/dryrun-ports.ts';
import type { Ports } from '../src/engine/ports.ts';
import { makeFixture } from './helpers.ts';
import { apiRoutes } from '../src/routes/api.ts';

let store: DataStore | undefined; let engine: LiveEngine | undefined;
afterEach(async () => { await engine?.stop(); store?.close(); store = undefined; engine = undefined; });

const HOUR = 3_600_000; const DAY = 24 * HOUR;
// Slots are relative to the real time, since a schedule is armed when it is made: the first 09:00 UTC after a minute from now, then each day.
const first = (() => { const t = Math.floor(Date.now() / DAY) * DAY + 9 * HOUR; return t > Date.now() + 60_000 ? t : t + DAY; })();
const slot = (n: number) => first + n * DAY;
let clock = Date.now();

async function open(dataDir: string) {
  store = await DataStore.open(dataDir);
  const world = new FakeWorld(() => {}, { 'origin/trunk': 'f'.repeat(40) });
  const ports: Ports = { mode: 'dry-run', git: new DryRunGitPort(world), gh: new DryRunGhPort(world), proc: new DryRunProcPort(world), agents: { claude: new DryRunClaudePort(world) } };
  engine = new LiveEngine(store, ports, () => {}, { sleep: async () => {}, tickMs: 60_000, now: () => isoLocal(new Date(clock)) });
  return { store, engine };
}
async function setup() {
  const { dataDir, codeRepo } = makeFixture();
  mkdirSync(join(codeRepo, '.git', 'info'), { recursive: true });
  delete process.env.PLANESTRO_DRYRUN_CI;
  clock = Date.now();
  return { dataDir, ...(await open(dataDir)) };
}
const filed = (s: DataStore, name = 'daily') => s.listItems().filter((i) => String(i.file.frontmatter.scheduled_from ?? '').startsWith(`${name}:`));
const make = (s: DataStore, extra: Record<string, unknown> = {}, actor: 'user' | 'orchestrator' = 'user') =>
  s.createSchedule({ name: 'daily', title: 'Audit {{date}}', description: 'Audit the slot {{slot}} of {{schedule}}.', cron: '0 9 * * *', tz: 'UTC', ...extra }, actor);

describe('schedules (#247)', () => {
  it('files exactly one item per slot, across a restart and a crash between filing and recording it', async () => {
    const { dataDir, store: s1, engine: e1 } = await setup();
    make(s1);
    clock = slot(0) - 60_000; await e1.tick();
    expect(filed(s1)).toHaveLength(0);
    clock = slot(0) + 60_000; await e1.tick(); await e1.tick();
    const [first] = filed(s1);
    expect(filed(s1)).toHaveLength(1);
    const date = new Date(slot(0)).toISOString().slice(0, 10);
    expect(first.file.frontmatter).toMatchObject({ title: `Audit ${date}`, status: 'NOT_YET_SUBMITTED', scheduled_from: `daily:${date}T09:00:00+00:00` });
    expect(readFileSync(first.path, 'utf8')).toContain(`Audit the slot ${date}T09:00:00+00:00 of daily.`);
    expect(s1.requireSchedule('daily').file.frontmatter.history).toEqual([expect.objectContaining({ slot: `${date}T09:00:00+00:00`, item: first.id })]);
    await e1.stop(); s1.close(); engine = undefined;
    // A restart later in the same slot files nothing.
    clock = slot(0) + 2 * HOUR;
    const { store: s2, engine: e2 } = await open(dataDir);
    await e2.tick();
    expect(filed(s2)).toHaveLength(1);
    // A crash after the item was written but before the schedule recorded it: the item is the evidence.
    const path = s2.requireSchedule('daily').path;
    const before = readFileSync(path, 'utf8');
    clock = slot(1) + 60_000; await e2.tick();
    expect(filed(s2)).toHaveLength(2);
    await e2.stop(); s2.close(); engine = undefined;
    writeFileSync(path, before);
    const { store: s3, engine: e3 } = await open(dataDir);
    await e3.tick();
    expect(filed(s3)).toHaveLength(2);
    expect(s3.requireSchedule('daily').file.frontmatter.history.map((h) => h.item)).toEqual([first.id, filed(s3)[1].id]);
  });

  it('a sleep across several slots files the latest one once', async () => {
    const { store, engine } = await setup();
    make(store);
    clock = slot(3) + HOUR; await engine.tick(); await engine.tick();
    expect(filed(store).map((i) => i.file.frontmatter.scheduled_from)).toEqual([`daily:${new Date(slot(3)).toISOString().slice(0, 10)}T09:00:00+00:00`]);
  });

  it('skip_if_open skips a slot while the previous item is unfinished', async () => {
    const { store, engine } = await setup();
    make(store, { skip_if_open: true });
    clock = slot(0) + 60_000; await engine.tick();
    const [a] = filed(store);
    clock = slot(1) + 60_000; await engine.tick();
    expect(filed(store)).toHaveLength(1);
    expect(store.requireSchedule('daily').file.frontmatter.history.at(-1)).toMatchObject({ skipped: expect.stringContaining(a.id) });
    store.mutateItem(a.id, [{ set: { status: 'FINISHED', finished_at: isoLocal() } }], 'user');
    clock = slot(2) + 60_000; await engine.tick();
    expect(filed(store)).toHaveLength(2);
  });

  it('AUTOMATION PAUSED stops the filing; a disabled schedule files nothing', async () => {
    const { store, engine } = await setup();
    make(store);
    engine.pause();
    clock = slot(0) + 60_000; await engine.tick();
    expect(filed(store)).toHaveLength(0);
    engine.resume(); await engine.tick();
    expect(filed(store)).toHaveLength(1);
    store.editSchedule('daily', { enabled: false });
    clock = slot(1) + 60_000; await engine.tick();
    expect(filed(store)).toHaveLength(1);
  });

  it('submit: only a schedule the user made submits what it files', async () => {
    const { store, engine } = await setup();
    expect(() => make(store, { submit: true }, 'orchestrator')).toThrow(/user/);
    make(store, {}, 'orchestrator');
    expect(() => store.editSchedule('daily', { submit: true }, 'orchestrator')).toThrow(/user/);
    store.deleteSchedule('daily');
    make(store, { submit: true });
    clock = slot(0) + 60_000; await engine.tick();
    const [it] = filed(store);
    expect(store.requireItem(it.id).file.frontmatter.status).not.toBe('NOT_YET_SUBMITTED');
    // A file that says submit but was not made by the user (a hand edit) files without submitting.
    const path = store.requireSchedule('daily').path; const dir = store.dataDir;
    await engine.stop(); store.close();
    writeFileSync(path, readFileSync(path, 'utf8').replace('created_by: user', 'created_by: orchestrator'));
    const { store: s2, engine: e2 } = await open(dir);
    clock = slot(1) + 60_000; await e2.tick();
    expect(filed(s2).map((i) => i.file.frontmatter.status)).toContain('NOT_YET_SUBMITTED');
  });

  it('a schedule is refused for a bad cron, zone, category or template, and its name is unique', async () => {
    const { store } = await setup();
    expect(() => make(store, { cron: '0 25 * * *' })).toThrow(/cron/);
    expect(() => make(store, { tz: 'Nowhere/Else' })).toThrow(/time zone/);
    expect(() => make(store, { category: 'Nope' })).toThrow(/category/);
    expect(() => make(store, { title: 'Audit {{when}}' })).toThrow(/when/);
    make(store);
    expect(() => make(store)).toThrow(/exists/);
  });

  it('the API makes a schedule as the user, shows its next run, edits and deletes it', async () => {
    const { store, engine } = await setup();
    const app = apiRoutes(store, engine);
    const send = (method: string, path: string, body?: unknown) => app.request(path, { method, headers: { 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const made = await send('POST', '/schedules', { name: 'weekly', title: 'Bump deps {{date}}', description: 'Bump them.', cron: '0 9 * * MON', tz: 'Europe/London', submit: true, skip_if_open: true });
    expect(made.status).toBe(201);
    const view = (await made.json()) as { next_run: string; frontmatter: { created_by: string } };
    expect(view.frontmatter.created_by).toBe('user');
    expect(view.next_run).toMatch(/T09:00:00\+0[01]:00$/);
    expect((await send('PATCH', '/schedules/weekly', { cron: '0 9 * *' })).status).toBe(400);
    expect((await send('PATCH', '/schedules/weekly', { enabled: false })).status).toBe(200);
    expect(store.requireSchedule('weekly').file.frontmatter.enabled).toBe(false);
    expect((await send('DELETE', '/schedules/weekly')).status).toBe(200);
    expect(store.listSchedules()).toEqual([]);
  });
});
