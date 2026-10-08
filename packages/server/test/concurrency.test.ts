import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';
import { DataStore } from '../src/store/DataStore.ts';
import { MockEngine } from '../src/engine/MockEngine.ts';
import { LiveEngine } from '../src/engine/LiveEngine.ts';
import { FakeWorld, DryRunGitPort, DryRunGhPort, DryRunProcPort, DryRunClaudePort } from '../src/engine/dryrun-ports.ts';
import type { Ports } from '../src/engine/ports.ts';
import { apiRoutes } from '../src/routes/api.ts';
import { stateView } from '../src/routes/views.ts';
import { changeConcurrency, recentCi } from '../src/concurrency.ts';
import { makeFixture, git, sleep } from './helpers.ts';

// #330: concurrency raised and lowered from the header, inside what this machine has shown it can take, each change
// journaled with who and why, and one click back to the values before it.

let store: DataStore | undefined; let engine: LiveEngine | undefined;
afterEach(async () => { await engine?.stop(); store?.close(); store = undefined; engine = undefined; });

const QUIET = () => ({ load: [1, 1, 1] as [number, number, number], cpus: 8 });

function withConfig(dataDir: string, edit: (y: string) => string) {
  const cfg = join(dataDir, 'planestro.yml');
  writeFileSync(cfg, edit(readFileSync(cfg, 'utf8')));
}

async function api() {
  const { dataDir } = makeFixture();
  store = await DataStore.open(dataDir);
  const app = apiRoutes(store, new MockEngine(store, () => {}), undefined, { hostLoad: QUIET });
  const send = async (method: string, path: string, body?: unknown) => {
    const r = await app.request(path, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: await r.json() as any };
  };
  const yml = () => YAML.parse(readFileSync(join(dataDir, 'planestro.yml'), 'utf8'));
  const lastCommit = () => git(dataDir, 'log', '-1', '--format=%s').trim();
  return { store, send, yml, lastCommit };
}

describe('the concurrency control (#330)', () => {
  it('a change applies through the Settings path, is journaled with who and why, and rolls back in one step', async () => {
    const { store, send, yml, lastCommit } = await api();
    let r = await send('GET', '/concurrency');
    expect(r.status).toBe(200);
    expect(r.body.limits).toEqual({ max_sessions: 3, max_local_jobs: 1, runner_limits: { codex: 1 } });
    expect(r.body.host).toEqual({ load: [1, 1, 1], cpus: 8 });
    expect(r.body.ci_runner.state).toBe('unknown');   // no heavy_runs.shared_labels: which runners share this machine is not known
    expect(r.body.advice).toMatchObject({ healthy: true, raise_ok: true, recommended_max: 4 });
    expect(r.body.last_change).toBeNull();

    r = await send('PUT', '/concurrency', { max_sessions: 4, reason: '29 items queued' });
    expect(r.status).toBe(200);
    expect(yml().concurrency.max_sessions).toBe(4);
    expect(lastCommit()).toBe('config: concurrency.max_sessions 4');
    const [entry] = store.journal.read({ type: 'concurrency.changed' });
    expect(entry).toMatchObject({ actor: 'user', data: { from: { max_sessions: 3, runner_limits: { codex: 1 } }, to: { max_sessions: 4, runner_limits: { codex: 1 } }, reason: '29 items queued' } });

    // Two more right after a raise is past the recommendation: it is refused until confirmed.
    r = await send('PUT', '/concurrency', { max_sessions: 6 });
    expect(r.status).toBe(409);
    expect(r.body.needs_confirm).toBe(true);
    expect(r.body.error).toMatch(/above the recommended 4/);
    expect(yml().concurrency.max_sessions).toBe(4);
    r = await send('PUT', '/concurrency', { max_sessions: 6, runner_limits: { codex: 2 }, confirm: true });
    expect(r.status).toBe(200);
    expect(yml().concurrency).toMatchObject({ max_sessions: 6, runner_limits: { codex: 2 } });
    expect(r.body.last_change).toMatchObject({ by: 'user', from: { max_sessions: 4, runner_limits: { codex: 1 } }, to: { max_sessions: 6, runner_limits: { codex: 2 } } });

    // Roll back to the values before the last change; lowering asks nothing.
    r = await send('POST', '/concurrency/rollback', {});
    expect(r.status).toBe(200);
    expect(yml().concurrency).toMatchObject({ max_sessions: 4, runner_limits: { codex: 1 } });
    expect(r.body.last_change).toMatchObject({ by: 'user', rollback: true, to: { max_sessions: 4, runner_limits: { codex: 1 } } });
    expect(store.journal.read({ type: 'concurrency.changed' })).toHaveLength(3);

    // A per-runner limit shares the session slots, so it never needs a confirm; nothing to change is refused.
    expect((await send('PUT', '/concurrency', { runner_limits: { codex: 3 } })).status).toBe(200);
    expect((await send('PUT', '/concurrency', { runner_limits: { codex: 3 } })).body.error).toMatch(/nothing to change/);
    expect((await send('PUT', '/concurrency', { max_sessions: 0 })).status).toBe(400);
  });

  it('the state carries N of M and how many wait for a slot', async () => {
    const { store } = await api();
    const a = store.createItem({ title: 'Waits', description: 'x' });
    store.transition(a.id, 'QUEUED', 'user');
    const view = stateView(store, new MockEngine(store, () => {}), {});
    expect(view.engine.slots).toMatchObject({ max: 3, running: 0 });
  });
});

describe('guard rails from CI and the tick (#330)', () => {
  async function live(edit: (y: string) => string = (y) => y) {
    const { dataDir, codeRepo } = makeFixture();
    mkdirSync(join(codeRepo, '.git', 'info'), { recursive: true });
    withConfig(dataDir, (y) => edit(y.replace(/^code_repo:\n/m, 'code_repo:\n  github: acme/repo\n')));
    process.env.PLANESTRO_DRYRUN_CI = 'red-once';
    store = await DataStore.open(dataDir, { emit: () => {} });
    const world = new FakeWorld(() => {}, { 'origin/trunk': 'f'.repeat(40) });
    world.ciMode = 'red-once';
    world.failedLog = 'boss_check › run: rc=137 after 600 s (killed at its timeout)';
    const ports: Ports = { mode: 'dry-run', git: new DryRunGitPort(world), gh: new DryRunGhPort(world), proc: new DryRunProcPort(world), agents: { claude: new DryRunClaudePort(world) } };
    engine = new LiveEngine(store, ports, () => {}, { sleep: async () => {}, tickMs: 50, hostLoad: QUIET });
    return { store, engine, world };
  }
  async function waitFor(pred: () => boolean, ms = 10_000) { const t0 = Date.now(); while (!pred()) { if (Date.now() - t0 > ms) throw new Error('timeout waiting'); await sleep(20); } }

  it('a check killed at its timeout is remembered from the run log, and the advice steps down', async () => {
    const { store, engine } = await live();
    const item = store.createItem({ title: 'Boss fight', description: 'x' });
    store.transition(item.id, 'QUEUED', 'user');
    await engine.start();
    await waitFor(() => store.getItem(item.id)!.file.frontmatter.status === 'PLAN_READY');
    await engine.approvePlan(item.id);
    await waitFor(() => store.getItem(item.id)!.file.frontmatter.status === 'FINISHED');
    const seen = recentCi(store);
    expect(seen.filter((r) => r.timeout_killed)).toHaveLength(1);
    expect(seen.some((r) => r.outcome === 'success' && !r.timeout_killed)).toBe(true);
    expect(store.journal.read({ type: 'ci.result' }).find((e) => e.data?.timeout_killed)).toMatchObject({ item: item.id, data: { outcome: 'failure' } });
    const app = apiRoutes(store, engine, undefined, { hostLoad: QUIET });
    const view = await (await app.request('/concurrency')).json() as any;
    expect(view.advice).toMatchObject({ healthy: false, kills: 1, recommended_max: 2 });
    // Nothing steps down unless asked to (concurrency.guard.auto_step_down is off).
    expect(store.config.concurrency.max_sessions).toBe(3);
  });

  it('opted in, a raise followed by a timeout kill is stepped back on the tick, journaled as the engine', async () => {
    const { store, engine } = await live((y) => y.replace('  max_sessions: 3\n', '  max_sessions: 2\n  guard:\n    auto_step_down: true\n'));
    changeConcurrency(store, { max_sessions: 3, reason: 'designer asked for 3', confirm: true }, 'user', { host: QUIET() });
    const item = store.createItem({ title: 'Boss fight', description: 'x' });
    store.transition(item.id, 'QUEUED', 'user');
    await engine.start();
    await waitFor(() => store.getItem(item.id)!.file.frontmatter.status === 'PLAN_READY');
    await engine.approvePlan(item.id);
    await waitFor(() => store.config.concurrency.max_sessions === 2);
    const last = store.journal.read({ type: 'concurrency.changed' }).at(-1)!;
    expect(last).toMatchObject({ actor: 'engine', data: { auto: true, from: { max_sessions: 3 }, to: { max_sessions: 2 } } });
    expect(String(last.data!.reason)).toMatch(/killed at a timeout/);
    expect(engine.log.some((e) => e.type === 'engine.log' && e.level === 'warn' && /stepped concurrency down/.test(e.message))).toBe(true);
    expect(stateView(store, engine, {}).engine.slots).toMatchObject({ max: 2, stepped_down: { to: { max_sessions: 2 } } });
    await waitFor(() => store.getItem(item.id)!.file.frontmatter.status === 'FINISHED');
    // Stepped down once: the step-down is the last change now, and it is not stepped down again.
    expect(store.journal.read({ type: 'concurrency.changed' })).toHaveLength(2);
  });

  it('raising max_sessions lets a turn waiting for a session slot start at once', async () => {
    const { store, engine } = await live((y) => y.replace('  max_sessions: 3\n', '  max_sessions: 1\n'));
    (engine as any).sessionTurns = 1;
    let ran = false;
    const waiting = (engine as any).withSessionSlot('TP-9', async () => { ran = true; });
    await sleep(30);
    expect(ran).toBe(false);
    changeConcurrency(store, { max_sessions: 2, confirm: true }, 'user', { host: QUIET() });
    engine.observe({ type: 'config.updated' });
    await waiting;
    expect(ran).toBe(true);
  });
});
