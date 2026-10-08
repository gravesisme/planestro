import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DataStore } from '../src/store/DataStore.ts';
import { LiveEngine } from '../src/engine/LiveEngine.ts';
import { FakeWorld, DryRunGitPort, DryRunGhPort, DryRunProcPort, DryRunClaudePort } from '../src/engine/dryrun-ports.ts';
import type { Ports, TurnOptions } from '../src/engine/ports.ts';
import { makeFixture, sleep } from './helpers.ts';

/**
 * A red epic whose failing check is the base's, not its own (#204, HH-375): PR #563 went red on a check the epic never
 * touched, because develop had just broken it. The orchestrator triaged the ci_red, blamed the epic, and a worker turn
 * pushed a duplicate of develop's own fix onto the integration branch. A red run whose log names files the base changed
 * since the epic last synced, and none the epic changed, waits for the base: no block, no triage, no fix turn. Once the
 * base moves, the epic merges it in and CI runs again, once; red after that is ci_red as before.
 */
let store: DataStore | undefined; let engine: LiveEngine | undefined;
afterEach(async () => { await engine?.stop(); store?.close(); store = undefined; engine = undefined; });

async function setup() {
  const { dataDir, codeRepo } = makeFixture();
  mkdirSync(join(codeRepo, '.git', 'info'), { recursive: true });
  const cfg = join(dataDir, 'planestro.yml');
  writeFileSync(cfg, readFileSync(cfg, 'utf8').replace(/^code_repo:\n/m, 'code_repo:\n  github: acme/repo\n'));
  delete process.env.PLANESTRO_DRYRUN_CI;
  store = await DataStore.open(dataDir, { emit: () => {} });
  const world = new FakeWorld(() => {}, { 'origin/trunk': 'f'.repeat(40) });
  world.remoteBranches.set('trunk', world.sha());
  const turns: string[] = [];
  // Worker turns are recorded (there must be none); the orchestrator's wakes run as the dry-run port runs them.
  const inner = new DryRunClaudePort(world);
  const claude = { runTurn: (o: TurnOptions) => { turns.push(o.prompt); return inner.runTurn(o); }, runCustomTurn: inner.runCustomTurn.bind(inner) };
  const ports: Ports = { mode: 'dry-run', git: new DryRunGitPort(world), gh: new DryRunGhPort(world), proc: new DryRunProcPort(world), agents: { claude: claude as any } };
  engine = new LiveEngine(store, ports, () => {}, { sleep: async () => {}, tickMs: 50 });
  // An epic in review whose PR's first run is red, as HH-375's was.
  const epic = store.createItem({ title: 'Mine cart', description: 'x', kind: 'epic' } as any);
  const branch = 'feature/mine-cart';
  world.remoteBranches.set(branch, world.sha());
  world.prs.set(563, { number: 563, url: 'u', state: 'OPEN', headRefOid: world.remoteBranches.get(branch)!, headRefName: branch, baseRefName: 'trunk', polls: 0, failOnce: true });
  store.mutateItem(epic.id, [{ set: { status: 'IN_REVIEW' } }, { set: { pr: 563, branch, ci_result: 'pending' } }], 'engine');
  return { store, engine, world, id: epic.id, branch, turns };
}

async function waitFor(pred: () => boolean, ms = 8000) { const t0 = Date.now(); while (!pred()) { if (Date.now() - t0 > ms) throw new Error('timeout waiting'); await sleep(20); } }
const activityOf = (s: DataStore, id: string) => s.getItem(id)!.file.sections.find((x) => x.title === 'Activity')!.body;
const wakes = (s: DataStore, id: string) => s.journal.read({ item: id, type: 'orchestrator.wake' }).map((w) => String(w.data?.event));

describe('a red epic on a check the base broke (#204)', () => {
  it('gets no fix turn and no triage; once the base moves it merges the base in, CI runs again, and green merges', async () => {
    const ctx = await setup();
    // develop changed the check since the epic last synced; the epic did not touch it.
    ctx.world.files.set('trunk', new Map([['checks/mine_cart_check.gd', Buffer.from('x')]]));
    ctx.world.failedLog = 'mine_cart_check: failure\nFAIL checks/mine_cart_check.gd:42: expected 3.0s, measured 3.4s';
    await ctx.engine.start();
    await waitFor(() => Boolean(ctx.store.getItem(ctx.id)!.file.frontmatter.op_data?.base_wait));
    let fm = ctx.store.getItem(ctx.id)!.file.frontmatter;
    expect(fm.blocked).toBeUndefined();
    expect(fm.ci_result).toBe('red');
    expect((fm.op_data?.base_wait as any).files).toEqual(['checks/mine_cart_check.gd']);
    expect(activityOf(ctx.store, ctx.id)).toContain('likely a base regression');
    await sleep(300);   // ticks pass: the base has not moved, so nothing happens to it
    expect(ctx.store.getItem(ctx.id)!.file.frontmatter.blocked).toBeUndefined();
    expect(wakes(ctx.store, ctx.id)).not.toContain('blocked_ci_red');
    expect(ctx.turns).toEqual([]);

    // develop's fix lands: the epic merges it in, pushes, and the run for the new head is green.
    const before = ctx.world.remoteBranches.get(ctx.branch);
    ctx.world.remoteBranches.set('trunk', ctx.world.sha());
    for (const cwd of ctx.world.worktrees.keys()) ctx.world.behind.set(cwd, 1);
    (ctx.engine as any).baseWaitPolledAt.clear();
    await waitFor(() => ctx.world.prs.get(563)!.state === 'MERGED');
    expect(ctx.world.remoteBranches.get(ctx.branch) ?? 'gone').not.toBe(before);
    expect(activityOf(ctx.store, ctx.id)).toMatch(/trunk moved .*; merging it in and running CI again, once/);
    expect(wakes(ctx.store, ctx.id)).not.toContain('blocked_ci_red');
    expect(ctx.turns).toEqual([]);
  });

  it('red again after that one re-run is ci_red, for the orchestrator, as before', async () => {
    const ctx = await setup();
    ctx.world.files.set('trunk', new Map([['checks/mine_cart_check.gd', Buffer.from('x')]]));
    ctx.world.failedLog = 'FAIL checks/mine_cart_check.gd:42';
    await ctx.engine.start();
    await waitFor(() => Boolean(ctx.store.getItem(ctx.id)!.file.frontmatter.op_data?.base_wait));
    ctx.world.prs.get(563)!.failOnce = true;
    ctx.world.remoteBranches.set('trunk', ctx.world.sha());
    for (const cwd of ctx.world.worktrees.keys()) ctx.world.behind.set(cwd, 1);
    (ctx.engine as any).baseWaitPolledAt.clear();
    await waitFor(() => ctx.store.getItem(ctx.id)!.file.frontmatter.blocked_reason === 'ci_red');
    const fm = ctx.store.getItem(ctx.id)!.file.frontmatter;
    expect(fm.op_data?.base_wait).toBeUndefined();
    expect(activityOf(ctx.store, ctx.id)).toContain('still red after merging the moved base in');
    await waitFor(() => wakes(ctx.store, ctx.id).includes('blocked_ci_red'));
  });

  it('a base that does not move within ci.stall_wake_min hands it to ci_red, with the suspicion said', async () => {
    const ctx = await setup();
    ctx.store.updateConfig((doc) => { doc.setIn(['ci', 'stall_wake_min'], 0.002); }, 'config: short wait');
    ctx.world.files.set('trunk', new Map([['checks/mine_cart_check.gd', Buffer.from('x')]]));
    ctx.world.failedLog = 'FAIL checks/mine_cart_check.gd:42';
    await ctx.engine.start();
    await waitFor(() => Boolean(ctx.store.getItem(ctx.id)!.file.frontmatter.op_data?.base_wait));
    await sleep(200);
    (ctx.engine as any).baseWaitPolledAt.clear();
    await waitFor(() => ctx.store.getItem(ctx.id)!.file.frontmatter.blocked_reason === 'ci_red');
    expect(activityOf(ctx.store, ctx.id)).toMatch(/BLOCKED \(ci_red\): .*likely a base regression in checks\/mine_cart_check\.gd/);
    expect(ctx.turns).toEqual([]);
  });

  it('a red run that names a file the epic changed, or none the base changed, is ci_red at once', async () => {
    const ctx = await setup();
    ctx.world.files.set('trunk', new Map([['checks/mine_cart_check.gd', Buffer.from('x')]]));
    ctx.world.failedLog = 'FAIL tests/epic_own_test.gd:7';
    await ctx.engine.start();
    await waitFor(() => ctx.store.getItem(ctx.id)!.file.frontmatter.blocked_reason === 'ci_red');
    expect(ctx.store.getItem(ctx.id)!.file.frontmatter.op_data?.base_wait).toBeUndefined();
  });
});
