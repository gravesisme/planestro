import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DataStore } from '../src/store/DataStore.ts';
import { LiveEngine } from '../src/engine/LiveEngine.ts';
import { apiRoutes } from '../src/routes/api.ts';
import { FakeWorld, DryRunGitPort, DryRunGhPort, DryRunProcPort, DryRunClaudePort } from '../src/engine/dryrun-ports.ts';
import type { Ports, TurnOptions, TurnResult, CustomTurnOptions } from '../src/engine/ports.ts';
import { makeFixture, sleep } from './helpers.ts';

let store: DataStore | undefined; let engine: LiveEngine | undefined;
afterEach(async () => { await engine?.stop(); store?.close(); store = undefined; engine = undefined; });

type Tool = (name: string) => { handler(a: Record<string, unknown>): Promise<string> };

/**
 * Sync with base (dogfood p29): a worker branch is brought up to date between turns, deterministically.
 * `hold` makes worker turns wait until released, so a live turn can be observed.
 */
async function setup(opts: { orchestrate?: (tools: Tool) => Promise<void>; hold?: Promise<void> } = {}) {
  const { dataDir, codeRepo } = makeFixture();
  mkdirSync(join(codeRepo, '.git', 'info'), { recursive: true });
  const cfg = join(dataDir, 'planestro.yml');
  writeFileSync(cfg, readFileSync(cfg, 'utf8').replace(/^code_repo:\n/m, 'code_repo:\n  github: acme/repo\n'));
  delete process.env.PLANESTRO_DRYRUN_CI;
  store = await DataStore.open(dataDir);
  const log: string[] = [];
  const world = new FakeWorld((m) => log.push(m), { 'origin/trunk': 'f'.repeat(40) });
  const prompts: { phase: string; prompt: string }[] = [];
  const inner = new DryRunClaudePort(world);
  const claude: Ports['agents']['claude'] = {
    async runTurn(o: TurnOptions): Promise<TurnResult> { prompts.push({ phase: o.phase, prompt: o.prompt }); if (opts.hold) await opts.hold; return inner.runTurn(o); },
    async runCustomTurn(o: CustomTurnOptions): Promise<TurnResult> {
      await opts.orchestrate?.(((n: string) => o.mcpTools.find((t) => t.name === n)!) as Tool);
      return { sessionId: 'orch', subtype: 'success', isError: false, costUsd: 0, numTurns: 1, text: '' };
    },
  };
  const ports: Ports = { mode: 'dry-run', git: new DryRunGitPort(world), gh: new DryRunGhPort(world), proc: new DryRunProcPort(world), agents: { claude } };
  engine = new LiveEngine(store, ports, () => {}, { sleep: async () => {}, tickMs: 50 });
  return { store, engine, world, log, prompts };
}

/** A worker item in progress on its own worktree, between turns. */
function worker(ctx: Awaited<ReturnType<typeof setup>>, opts: { pushed?: boolean; session?: boolean; blocked?: boolean; status?: string } = {}) {
  const { store, engine, world } = ctx;
  const item = store.createItem({ title: 'Boss atlas', description: 'x' });
  const branch = `tp/${item.id.split('-')[1]}-boss-atlas`;
  const rel = `.claude/worktrees/${item.id.toLowerCase()}-boss-atlas`, cwd = (engine as any).absWorktree(rel);
  world.worktrees.set(cwd, { path: cwd, head: world.sha(), branch });
  world.commits.set(cwd, 1);
  if (opts.pushed) world.remoteBranches.set(branch, world.sha());
  store.mutateItem(item.id, [{ set: { status: (opts.status ?? 'IN_PROGRESS') as any, branch, worktree: rel, ...(opts.session === false ? {} : { session_id: 's-art' }), ...(opts.blocked ? { blocked: true, blocked_reason: 'agent_blocked', awaiting: 'user' } : {}) } }], 'engine');
  return { id: item.id, branch, cwd };
}

const activityOf = (s: DataStore, id: string) => s.getItem(id)!.file.sections.find((x) => x.title === 'Activity')!.body;
async function waitFor(pred: () => boolean, ms = 4000) { const t0 = Date.now(); while (!pred()) { if (Date.now() - t0 > ms) throw new Error('timeout waiting'); await sleep(20); } }

describe('sync with base (p29)', () => {
  it('a branch behind its base is rebased onto origin/<base> and, already pushed, pushed with a lease', async () => {
    const ctx = await setup();
    const { id, branch, cwd } = worker(ctx, { pushed: true });
    await ctx.engine.start();
    const r = await ctx.engine.syncWithBase(id);
    expect(r).toMatch(/^synced: rebased onto origin\/trunk@f{7} \(\w{7}\), pushed with --force-with-lease$/);
    expect(ctx.log).toContain(`Would git rebase origin/trunk in ${cwd}`);
    expect(ctx.log).toContain(`Would git push --force-with-lease origin ${branch} (from ${cwd})`);
    expect(ctx.log.some((l) => l.includes('git merge'))).toBe(false);
    expect(ctx.world.remoteBranches.get(branch)).toBe(ctx.world.worktrees.get(cwd)!.head);
    const fm = ctx.store.getItem(id)!.file.frontmatter;
    expect(fm.op).toBeUndefined(); expect(fm.ci_result).toBeUndefined();
    expect(activityOf(ctx.store, id)).toContain('rebased onto origin/trunk (');
    expect(ctx.store.journal.openOps()).toEqual([]);
    expect(ctx.prompts).toHaveLength(0);                                   // syncing is not a turn
  });

  it('a pushed branch that moved on its own is never rebased away or pushed over: the sync refuses as diverged', async () => {
    const ctx = await setup();
    const { id, branch } = worker(ctx, { pushed: true });
    const remote = ctx.world.remoteBranches.get(branch)!;
    ctx.world.unreachable.add(remote);                                     // a commit someone pushed that the worktree lacks
    const r = await ctx.engine.syncWithBase(id);
    expect(r).toMatch(/^refused: the worktree \(\w{7}\) and the pushed branch .* have diverged; not pushing either way/);
    expect(ctx.log.some((l) => l.includes('git rebase') || l.includes('git push'))).toBe(false);
    expect(ctx.world.remoteBranches.get(branch)).toBe(remote);
    const fm = ctx.store.getItem(id)!.file.frontmatter;
    expect(fm.op).toBeUndefined(); expect(fm.blocked).toBeUndefined();   // refused, not blocked
    expect(activityOf(ctx.store, id)).toContain('have diverged; not pushing either way');
    const app = apiRoutes(ctx.store, ctx.engine);
    const res = await app.request(`/items/${id}/sync`, { method: 'POST' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('have diverged');
  });

  it('a branch that was never pushed is only rebased locally', async () => {
    const ctx = await setup();
    const { id, branch } = worker(ctx);
    const r = await ctx.engine.syncWithBase(id);
    expect(r).toContain('local only (not pushed yet)');
    expect(ctx.log.some((l) => l.includes('git push'))).toBe(false);
    expect(ctx.world.remoteBranches.has(branch)).toBe(false);
  });

  it('a branch already on the base tip is left alone, and the Activity log says so', async () => {
    const ctx = await setup();
    const { id, cwd } = worker(ctx, { pushed: true });
    ctx.world.behind.set(cwd, 0);
    const r = await ctx.engine.syncWithBase(id);
    expect(r).toMatch(/^already up to date: .* is on origin\/trunk@f{7}; nothing to sync$/);
    expect(ctx.log.some((l) => l.includes('git rebase') || l.includes('git push'))).toBe(false);
    expect(activityOf(ctx.store, id)).toContain('already on trunk@fffffff; no sync needed');
  });

  it('is refused while a turn is live, a step is in flight, it awaits an answer, the tree is dirty, or automation is paused', async () => {
    let release!: () => void;
    const ctx = await setup({ hold: new Promise<void>((r) => { release = r; }) });
    const { id } = worker(ctx, { blocked: true });
    await ctx.engine.start();
    await ctx.engine.unblock(id, 'carry on');
    await waitFor(() => ctx.engine.sessions().some((s) => s.item === id));
    expect(await ctx.engine.syncWithBase(id)).toMatch(/^not now: .* has a step running/);
    release();
    await waitFor(() => !ctx.engine.sessions().some((s) => s.item === id));
    await sleep(50);
    const other = worker(ctx);
    ctx.store.mutateItem(other.id, [{ set: { op: 'pushing' } }], 'engine');
    expect(await ctx.engine.syncWithBase(other.id)).toBe(`not now: ${other.id} is pushing; let it finish first`);
    ctx.store.mutateItem(other.id, [{ unset: ['op'] }, { set: { awaiting: 'question' } }], 'engine');
    expect(await ctx.engine.syncWithBase(other.id)).toMatch(/^not now: .* is awaiting question/);
    ctx.store.mutateItem(other.id, [{ unset: ['awaiting'] }], 'engine');
    ctx.world.dirty.add(other.cwd);
    expect(await ctx.engine.syncWithBase(other.id)).toMatch(/^refused: .* has uncommitted changes \(src\/fake\.ts\)/);
    ctx.world.dirty.delete(other.cwd);
    ctx.engine.pause();
    expect(await ctx.engine.syncWithBase(other.id)).toMatch(/^not now: automation is paused/);
    ctx.engine.resume();
    const queued = ctx.store.createItem({ title: 'Not started', description: 'x' });
    expect(await ctx.engine.syncWithBase(queued.id)).toMatch(/^not possible: /);
    expect(ctx.log.filter((l) => l.includes(`git rebase origin/trunk in ${other.cwd}`)).length).toBe(0);
  });

  it('a conflict is aborted and goes to the session with the rebase-conflict prompt', async () => {
    const ctx = await setup();
    const { id } = worker(ctx);
    await ctx.engine.start();
    ctx.world.conflictArmed = true;
    const r = await ctx.engine.syncWithBase(id);
    expect(r).toMatch(/^conflict: rebasing .* onto origin\/trunk conflicted in src\/conflicted\.ts; .*Handed to the session/);
    await waitFor(() => ctx.prompts.length === 1);
    expect(ctx.prompts[0].phase).toBe('fix');
    expect(ctx.prompts[0].prompt).toContain('src/conflicted.ts');
    expect(ctx.prompts[0].prompt).toContain('carry on with your work');
    expect(ctx.store.getItem(id)!.file.frontmatter.blocked).toBeUndefined();
  });

  it('a conflict with no session to take it blocks the item, and a blocked item stays blocked', async () => {
    const ctx = await setup();
    const fresh = worker(ctx, { session: false, status: 'PLAN_IN_PROGRESS' });
    ctx.world.conflictArmed = true;
    expect(await ctx.engine.syncWithBase(fresh.id)).toMatch(/blocked for a person to resolve$/);
    expect(ctx.store.getItem(fresh.id)!.file.frontmatter.blocked_reason).toBe('sync_conflict');
    const stopped = worker(ctx, { blocked: true });
    ctx.world.conflictArmed = true;
    expect(await ctx.engine.syncWithBase(stopped.id)).toContain('stays blocked (agent_blocked)');
    expect(ctx.store.getItem(stopped.id)!.file.frontmatter.blocked_reason).toBe('agent_blocked');
    expect(ctx.prompts).toHaveLength(0);
  });

  it("an epic's integration branch has the base merged in and is pushed plainly, never rebased", async () => {
    const ctx = await setup();
    const epic = ctx.store.createItem({ title: 'Big thing', description: 'x', kind: 'epic' } as any);
    ctx.store.mutateItem(epic.id, [{ set: { status: 'IN_PROGRESS', branch: 'feature/big-thing' } }], 'engine');
    ctx.world.remoteBranches.set('feature/big-thing', ctx.world.sha());
    const r = await ctx.engine.syncWithBase(epic.id);
    expect(r).toMatch(/^synced: merged origin\/trunk into feature\/big-thing@f{7} \(\w{7}\), pushed$/);
    expect(ctx.log.some((l) => /git merge origin\/trunk in /.test(l))).toBe(true);
    expect(ctx.log.some((l) => l.includes('git rebase') || l.includes('--force-with-lease'))).toBe(false);
    expect(ctx.log.some((l) => l.startsWith('Would git push -u origin feature/big-thing'))).toBe(true);
    // the epic page's button goes the same way
    await ctx.engine.syncBase(epic.id);
    expect(ctx.log.filter((l) => /git merge origin\/trunk in /.test(l)).length).toBe(2);
  });

  it('the orchestrator syncs with sync_with_base, and unblock_item with sync_first resumes on the rebased branch', async () => {
    const said: Record<string, string> = {};
    let ids: { plain: string; stopped: string } = { plain: '', stopped: '' };
    const ctx = await setup({
      orchestrate: async (t) => {
        said.sync ??= await t('sync_with_base').handler({ id: ids.plain });
        said.unblock ??= await t('unblock_item').handler({ id: ids.stopped, message: 'Build the final pack with --row-jump-overrides.', sync_first: true });
        await t('done_with_wake').handler({ summary: 'synced' });
      },
    });
    const plain = worker(ctx, { pushed: true });
    const stopped = worker(ctx, { blocked: true });
    ids = { plain: plain.id, stopped: stopped.id };
    const dep = ctx.store.createItem({ title: 'Row-jump flag', description: 'x' });
    ctx.store.mutateItem(stopped.id, [{ set: { depends_on: [dep.id], started_at: '2026-01-01T00:00:00+00:00' } }], 'engine');
    ctx.store.mutateItem(dep.id, [{ set: { status: 'MERGED', merged_at: '2026-01-02T00:00:00+00:00' } }], 'engine');
    await ctx.engine.start();
    ctx.engine.orchestrator.wake({ type: 'user_message', item: stopped.id, data: { message: 'resume it' } });
    await waitFor(() => ctx.prompts.length === 1);
    expect(said.sync).toMatch(/^synced: rebased onto origin\/trunk/);
    expect(said.unblock).toMatch(/^synced: .*; unblocked, and the session resumes with your message$/);
    expect(ctx.prompts[0].prompt).toContain('planestro rebased your branch onto origin/trunk');
    expect(ctx.prompts[0].prompt).toContain('Build the final pack with --row-jump-overrides.');
    expect(activityOf(ctx.store, plain.id)).toContain('rebased onto origin/trunk for the orchestrator');
  });

  it('the orchestrator is told when a dependency merged after the worktree was cut', async () => {
    const ctx = await setup();
    const { id } = worker(ctx, { blocked: true });
    const dep = ctx.store.createItem({ title: 'Row-jump flag', description: 'x' });
    ctx.store.mutateItem(id, [{ set: { depends_on: [dep.id], started_at: '2026-01-01T00:00:00+00:00' } }], 'engine');
    ctx.store.mutateItem(dep.id, [{ set: { status: 'MERGED', merged_at: '2026-01-02T00:00:00+00:00' } }], 'engine');
    const packet: string = (ctx.engine.orchestrator as any).renderPacket({ type: 'blocked_agent_blocked', item: id });
    expect(packet).toContain(`Merged since its worktree was cut: ${dep.id} (2026-01-0`);
    expect(packet).toContain('sync_with_base');
  });

  it('a restart part-way through a sync clears its op from persisted state, with no CI verdict to reset', async () => {
    const ctx = await setup();
    const { id } = worker(ctx);
    ctx.store.mutateItem(id, [{ set: { op: 'rebasing', op_started_at: '2026-01-01T00:00:00+00:00' } }], 'engine');
    await ctx.engine.start();
    const fm = ctx.store.getItem(id)!.file.frontmatter;
    expect(fm.op).toBeUndefined(); expect(fm.ci_result).toBeUndefined(); expect(fm.blocked).toBeUndefined();
    expect(activityOf(ctx.store, id)).toContain('reconcile: cleared stale op rebasing');
    expect(await ctx.engine.syncWithBase(id)).toMatch(/^synced: /);
  });

  it('POST /items/:id/sync syncs, and a refusal is a 400 with the reason', async () => {
    const ctx = await setup();
    const { id, cwd } = worker(ctx);
    const app = apiRoutes(ctx.store, ctx.engine);
    const ok = await app.request(`/items/${id}/sync`, { method: 'POST' });
    expect(ok.status).toBe(200);
    expect((await ok.json()).result).toMatch(/^synced: rebased onto origin\/trunk/);
    ctx.world.dirty.add(cwd);
    const no = await app.request(`/items/${id}/sync`, { method: 'POST' });
    expect(no.status).toBe(400);
    expect((await no.json()).error).toMatch(/^refused: .* uncommitted changes/);
  });
});
