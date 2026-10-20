import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DataStore } from '../src/store/DataStore.ts';
import { LiveEngine } from '../src/engine/LiveEngine.ts';
import { FakeWorld, DryRunGitPort, DryRunGhPort, DryRunProcPort, DryRunClaudePort, DryRunCodexPort } from '../src/engine/dryrun-ports.ts';
import type { Ports } from '../src/engine/ports.ts';
import { makeFixture, sleep } from './helpers.ts';

let store: DataStore | undefined; let engine: LiveEngine | undefined;
afterEach(async () => { await engine?.stop(); store?.close(); store = undefined; engine = undefined; });

const MODELS = `models:
  - { id: codex-art, label: Codex Art, runner: codex, hold_for_review: true, description: "all raster art" }
`;

async function setup() {
  const { dataDir, codeRepo } = makeFixture();
  mkdirSync(join(codeRepo, '.git', 'info'), { recursive: true });
  const cfg = join(dataDir, 'planestro.yml');
  writeFileSync(cfg, readFileSync(cfg, 'utf8').replace(/^code_repo:\n/m, 'code_repo:\n  github: acme/repo\n').replace('models:\n', MODELS));
  delete process.env.PLANESTRO_DRYRUN_CI;
  store = await DataStore.open(dataDir);
  const world = new FakeWorld(() => {}, { 'origin/trunk': 'f'.repeat(40) });
  const ports: Ports = { mode: 'dry-run', git: new DryRunGitPort(world), gh: new DryRunGhPort(world), proc: new DryRunProcPort(world), agents: { claude: new DryRunClaudePort(world), codex: new DryRunCodexPort(world) } };
  engine = new LiveEngine(store, ports, () => {}, { sleep: async () => {}, tickMs: 50 });
  return { store, engine, world };
}
async function waitFor(pred: () => boolean, ms = 6000) { const t0 = Date.now(); while (!pred()) { if (Date.now() - t0 > ms) throw new Error(`timeout waiting: ${pred.toString().slice(0, 120)} :: ${store?.listItems().map((i) => `${i.id} ${i.file.frontmatter.status} ${i.file.frontmatter.blocked_reason ?? ''}`).join(' | ')}`); await sleep(20); } }
const fmOf = (s: DataStore, id: string) => s.getItem(id)!.file.frontmatter;
const activityOf = (s: DataStore, id: string) => s.getItem(id)!.file.sections.find((x) => x.title === 'Activity')!.body;

async function plannedEpic() {
  const ctx = await setup();
  const epic = ctx.store.createItem({ title: 'Tide chart view', description: 'A chart of the day\'s tide with its own icon and header art.', kind: 'epic', category: 'Game' });
  await ctx.engine.start();
  await ctx.engine.planEpic(epic.id);
  await waitFor(() => fmOf(ctx.store, epic.id).awaiting === 'breakdown_approval');
  return { ...ctx, epic: epic.id };
}

describe('epic breakdown approval and unblock (#438, #439)', () => {
  it('#438: children queued by hand while the approval job ran are skipped and noted; the rest are still queued', async () => {
    const { store, engine, epic } = await plannedEpic();
    await engine.pause();
    const created = await engine.approveBreakdown(epic);
    expect(created.length).toBeGreaterThanOrEqual(3);
    // The job is still at its first await: the user queues the first child, and the second has already started planning.
    store.transition(created[0], 'QUEUED', 'user');
    store.transition(created[1], 'QUEUED', 'user');
    store.transition(created[1], 'PLAN_IN_PROGRESS', 'engine');
    await waitFor(() => created.slice(2).every((c) => fmOf(store, c).status === 'QUEUED'));
    await sleep(100);
    expect(fmOf(store, epic).blocked).toBeUndefined();
    expect(fmOf(store, created[0]).status).toBe('QUEUED');
    expect(fmOf(store, created[1]).status).toBe('PLAN_IN_PROGRESS');
    const act = activityOf(store, epic);
    expect(act).toContain(`${created[0]} is already QUEUED`);
    expect(act).toContain(`${created[1]} is already PLAN_IN_PROGRESS`);
    expect(act).not.toContain('engine_error');
  }, 20000);

  it('#439: unblocking an IN_PROGRESS epic stopped by engine_error clears it, with or without a message, and does not re-block', async () => {
    const { store, engine, epic } = await plannedEpic();
    await engine.pause();
    const created = await engine.approveBreakdown(epic);
    await waitFor(() => created.every((c) => fmOf(store, c).status === 'QUEUED'));
    await waitFor(() => !(engine as unknown as { jobs: Map<string, unknown> }).jobs.has(epic));
    // The epic stopped as it did on HH-574: engine_error, with the planning conversation's session still on it.
    expect(fmOf(store, epic).session_id).toBeDefined();
    store.mutateItem(epic, [{ set: { blocked: true, blocked_reason: 'engine_error' } }], 'engine');
    await engine.resume();
    await engine.unblock(epic, 'Benign race: nothing to fix.', 'user');
    await sleep(300);
    expect(fmOf(store, epic).blocked).toBeUndefined();
    expect(fmOf(store, epic).op_data?.pending_turn).toBeUndefined();
    expect(activityOf(store, epic)).toContain('retrying after engine_error: checking the integration branch; the children drive the rest: Benign race: nothing to fix.');
    expect(activityOf(store, epic)).not.toContain('"path" argument');
    expect(fmOf(store, epic).branch).toBe('feature/tide-chart-view');

    // The second unblock on HH-574 (no message) met the implement turn the first had saved: a turn with no worktree is
    // dropped and said, never run, and the epic stays unblocked.
    store.mutateItem(epic, [{ set: { blocked: true, blocked_reason: 'engine_error', op_data: { ...fmOf(store, epic).op_data, pending_turn: { key: 'stale', phase: 'implement', prompt: 'carry on', extraAllowed: [], oneShotCommands: [], opts: {} } } } }], 'engine');
    await engine.unblock(epic, undefined, 'orchestrator');
    await waitFor(() => fmOf(store, epic).op_data?.pending_turn === undefined);
    await sleep(200);
    expect(fmOf(store, epic).blocked).toBeUndefined();
    expect(fmOf(store, epic).status).toBe('IN_PROGRESS');
    expect(activityOf(store, epic)).toContain(`not starting its implement turn: ${epic} has no worktree for a session to run in`);
    expect(activityOf(store, epic)).not.toContain('"path" argument');
  }, 20000);

  it('#439: an engine step that throws logs its stack to the server log', async () => {
    const lines: string[] = [];
    const { dataDir, codeRepo } = makeFixture();
    mkdirSync(join(codeRepo, '.git', 'info'), { recursive: true });
    store = await DataStore.open(dataDir);
    const world = new FakeWorld(() => {}, { 'origin/trunk': 'f'.repeat(40) });
    const git = new DryRunGitPort(world);
    git.fetch = async () => { throw new Error('fetch exploded'); };
    const ports: Ports = { mode: 'dry-run', git, gh: new DryRunGhPort(world), proc: new DryRunProcPort(world), agents: { claude: new DryRunClaudePort(world) } };
    engine = new LiveEngine(store, ports, () => {}, { sleep: async () => {}, tickMs: 50, log: (l, m) => lines.push(`[${l}] ${m}`) });
    const epic = store.createItem({ title: 'Exploding epic', description: 'x', kind: 'epic' });
    await engine.start();
    await engine.planEpic(epic.id);
    const s = store;
    await waitFor(() => fmOf(s, epic.id).blocked === true);
    expect(fmOf(s, epic.id).blocked_reason).toBe('engine_error');
    expect(lines.some((l) => l.startsWith(`[error] ${epic.id}: engine step failed: Error: fetch exploded\n    at `))).toBe(true);
  }, 20000);
});
