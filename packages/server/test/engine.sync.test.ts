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
async function setup(opts: { orchestrate?: (tools: Tool) => Promise<void>; hold?: Promise<void>; conflictSession?: (o: TurnOptions) => Promise<Partial<TurnResult>>; turn?: (o: TurnOptions, world: FakeWorld) => Promise<Partial<TurnResult> | undefined> } = {}) {
  const { dataDir, codeRepo } = makeFixture();
  mkdirSync(join(codeRepo, '.git', 'info'), { recursive: true });
  const cfg = join(dataDir, 'planestro.yml');
  writeFileSync(cfg, readFileSync(cfg, 'utf8').replace(/^code_repo:\n/m, 'code_repo:\n  github: acme/repo\n'));
  delete process.env.PLANESTRO_DRYRUN_CI;
  store = await DataStore.open(dataDir);
  const log: string[] = [];
  const world = new FakeWorld((m) => log.push(m), { 'origin/trunk': 'f'.repeat(40) });
  const prompts: { phase: string; prompt: string; behind?: number }[] = [];
  const inner = new DryRunClaudePort(world);
  const claude: Ports['agents']['claude'] = {
    async runTurn(o: TurnOptions): Promise<TurnResult> {
      prompts.push({ phase: o.phase, prompt: o.prompt, behind: world.behind.get(o.cwd) ?? 1 });
      if (opts.conflictSession && o.prompt.startsWith('You are resolving one merge conflict')) return { sessionId: 'conflict', subtype: 'success', isError: false, costUsd: 1.25, numTurns: 3, text: '', ...(await opts.conflictSession(o)) };
      const over = await opts.turn?.(o, world);
      if (over) return { sessionId: o.resume ?? 's-art', subtype: 'success', isError: false, costUsd: 0, numTurns: 1, text: '', ...over };
      if (opts.hold) await opts.hold; return inner.runTurn(o);
    },
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

  it('a conflict is left stopped for the session, which edits only the files; planestro continues and pushes it, then the session carries on (HH-532)', async () => {
    const ctx = await setup();
    const { id, cwd } = worker(ctx, { pushed: true });
    await ctx.engine.start();
    ctx.world.conflictArmed = true;
    const r = await ctx.engine.syncWithBase(id);
    expect(r).toMatch(/^conflict: rebasing .* onto origin\/trunk conflicted in src\/conflicted\.ts; it is left stopped at the conflict\. Handed to the session/);
    await waitFor(() => ctx.prompts.length >= 2);
    expect(ctx.prompts[0].phase).toBe('fix');
    expect(ctx.prompts[0].prompt).toContain('src/conflicted.ts');
    expect(ctx.prompts[0].prompt).not.toMatch(/git fetch|git rebase origin|git push/);
    expect(ctx.log).toContain(`Would git add && git rebase --continue in ${cwd}`);
    expect(ctx.log.some((l) => l.startsWith('Would git push --force-with-lease origin tp/'))).toBe(true);
    expect(ctx.prompts[1].prompt).toContain('planestro finished rebasing your branch onto origin/trunk');
    expect(ctx.prompts[1].prompt).toContain('Carry on with your work');
    expect(ctx.store.getItem(id)!.file.frontmatter.op_data?.rebase_continue).toBeUndefined();
  });

  describe('generated files (#63)', () => {
    const POT = 'resources/i18n/messages.pot';
    /** A worker whose sync conflicts only in messages.pot, with its regenerate command configured; `run` stands in for the command. */
    async function potConflict(run: (command: string, cwd: string) => { code: number; stderr?: string }) {
      const ctx = await setup();
      ctx.store.updateConfig((doc) => { doc.setIn(['worktrees', 'generated'], { 'messages.pot': 'godot --headless --script tools/i18n_export_pot.gd' }); }, 'config: generated');
      const w = worker(ctx, { pushed: true });
      const ran: string[] = [];
      (ctx.engine as any).ports.proc.run = async (command: string, o: { cwd: string }) => { ran.push(command); const r = run(command, o.cwd); return { code: r.code, stdout: '', stderr: r.stderr ?? '' }; };
      ctx.world.conflictFiles = [POT]; ctx.world.conflictArmed = true;
      return { ...ctx, ...w, ran };
    }

    it('a conflict only in a generated file takes the base copy, regenerates and commits it, with no session turn', async () => {
      const ctx = await potConflict((_c, cwd) => { ctx.world.regenerated.set(cwd, [POT]); return { code: 0 }; });
      const r = await ctx.engine.syncWithBase(ctx.id);
      expect(r).toMatch(/^synced: rebased onto origin\/trunk/);
      expect(ctx.ran).toEqual(['godot --headless --script tools/i18n_export_pot.gd']);
      expect(ctx.log.some((l) => l.includes(`git commit -m "${ctx.id}: regenerate messages.pot" -- ${POT}`))).toBe(true);
      expect(activityOf(ctx.store, ctx.id)).toContain(`took trunk's copy of ${POT} in the conflict and regenerated it (\`godot --headless --script tools/i18n_export_pot.gd\`); committed ${POT}`);
      expect(ctx.prompts).toHaveLength(0);
    });

    it('a regenerate command that fails undoes the sync and the conflict goes to the session as before', async () => {
      const ctx = await potConflict(() => ({ code: 1, stderr: 'godot: not found' }));
      const r = await ctx.engine.syncWithBase(ctx.id);
      expect(r).toMatch(/^conflict: .*conflicted in resources\/i18n\/messages\.pot; .*Handed to the session/);
      expect(ctx.log.some((l) => l.startsWith('Would git reset --hard'))).toBe(true);
      expect(activityOf(ctx.store, ctx.id)).toMatch(/exited 1: godot: not found; the sync was undone and rebased again, left stopped at the conflict/);
      await waitFor(() => ctx.prompts.length >= 1);
      expect(ctx.prompts[0].prompt).toContain(POT);
    });

    it('a command that also changes an unlisted file undoes the sync; a conflict in any other file never runs a command', async () => {
      const ctx = await potConflict((_c, cwd) => { ctx.world.regenerated.set(cwd, [POT, 'resources/i18n/en.po']); return { code: 0 }; });
      expect(await ctx.engine.syncWithBase(ctx.id)).toMatch(/^conflict: /);
      expect(activityOf(ctx.store, ctx.id)).toContain('regenerating also changed resources/i18n/en.po, which worktrees.generated does not list; the sync was undone');
      ctx.world.conflictFiles = [POT, 'src/main.ts']; ctx.world.conflictArmed = true; ctx.ran.length = 0;
      await waitFor(() => !(ctx.engine as any).jobs.has(ctx.id) && !(ctx.engine as any).turns.has(ctx.id));
      await ctx.engine.syncWithBase(ctx.id);
      expect(ctx.ran).toEqual([]);
    });
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

  describe("an epic's conflict goes to a one-shot conflict session (#71)", () => {
    /** An open epic whose integration branch is pushed and conflicts with its base on the next merge. */
    async function epicConflict(session: (o: TurnOptions) => Promise<Partial<TurnResult>>, files = ['LICENSES.md']) {
      const ctx = await setup({ conflictSession: session });
      const epic = ctx.store.createItem({ title: 'Animate Jungle enemies', description: 'Six sheets and their wiring.', kind: 'epic' } as any);
      ctx.store.mutateItem(epic.id, [{ set: { status: 'IN_PROGRESS', branch: 'feature/animate-jungle' } }], 'engine');
      ctx.world.remoteBranches.set('feature/animate-jungle', ctx.world.sha());
      ctx.world.conflictFiles = files; ctx.world.conflictArmed = true;
      await ctx.engine.start();
      return { ...ctx, id: epic.id };
    }
    const settled = (ctx: { engine: LiveEngine }, id: string) => waitFor(() => !(ctx.engine as any).jobs.has(id) && !(ctx.engine as any).turns.has(id));

    it('resolved and checked, the merge is pushed plainly and the epic carries on', async () => {
      const ctx = await epicConflict(async (o) => { expect(o.cwd).toContain('merge-'); await o.tools.report_done('kept both sides of LICENSES.md'); return { done: 'kept both sides of LICENSES.md' }; });
      const r = await ctx.engine.syncWithBase(ctx.id);
      expect(r).toMatch(/^conflict: merging origin\/trunk into feature\/animate-jungle conflicted in LICENSES\.md; .*A one-shot session is resolving it/);
      await settled(ctx, ctx.id);
      const p = ctx.prompts.find((x) => x.prompt.startsWith('You are resolving one merge conflict'))!;
      expect(p.prompt).toContain('- LICENSES.md');
      expect(p.prompt).toContain('`git merge --no-edit origin/trunk`');
      expect(p.prompt).toContain('Never rebase, reset, push or force');
      expect(p.prompt).toContain('Six sheets and their wiring.');
      const log = activityOf(ctx.store, ctx.id);
      expect(log).toMatch(/a one-shot .* session resolves it in \S+merge-\S+ \(up to \$10, epics\.conflict_budget_usd\)/);
      expect(log).toMatch(/the conflict session resolved the merge \("kept both sides of LICENSES\.md"\); checked it \(finished, clean, contains origin\/trunk and origin\/feature\/animate-jungle\) and pushed \w{7} \(\$1\.25\)/);
      expect(ctx.log.some((l) => l.startsWith('Would git push -u origin feature/animate-jungle'))).toBe(true);
      const fm = ctx.store.getItem(ctx.id)!.file.frontmatter;
      expect(fm.blocked).toBeUndefined();
      expect(fm.cost_usd).toBe(1.25);
    });

    it('a conflict that needs a decision comes back blocked with it, and the worktree goes back to where it was', async () => {
      const ctx = await epicConflict(async (o) => { await o.tools.report_blocked('the epic renames Frog while trunk deletes it: keep or drop?'); return { blocked: 'the epic renames Frog while trunk deletes it: keep or drop?' }; });
      await ctx.engine.syncWithBase(ctx.id);
      await settled(ctx, ctx.id);
      const fm = ctx.store.getItem(ctx.id)!.file.frontmatter;
      expect(fm.blocked_reason).toBe('sync_conflict');
      expect(activityOf(ctx.store, ctx.id)).toContain('the conflict session did not resolve it: it needs a decision: the epic renames Frog while trunk deletes it: keep or drop?');
      expect(ctx.log.some((l) => l.startsWith('Would git push -u origin feature/animate-jungle'))).toBe(false);
    });

    it('a merge that does not contain the base, or a session that never reports done, is not pushed', async () => {
      const ctx = await epicConflict(async () => { ctx.world.unreachable.add('f'.repeat(40)); return { done: 'merged' }; });
      await ctx.engine.syncWithBase(ctx.id);
      await settled(ctx, ctx.id);
      expect(activityOf(ctx.store, ctx.id)).toContain('the conflict session did not resolve it: the result does not contain origin/trunk (fffffff)');
      expect(ctx.store.getItem(ctx.id)!.file.frontmatter.blocked_reason).toBe('sync_conflict');
      expect(ctx.log.some((l) => l.startsWith('Would git push -u origin feature/animate-jungle'))).toBe(false);
    });

    it('a base that moves while the session merges does not throw the merge away: it holds the tip it merged and is pushed (#485)', async () => {
      const ctx = await epicConflict(async () => { ctx.world.unreachable.add('origin/trunk'); return { done: 'merged' }; });
      await ctx.engine.syncWithBase(ctx.id);
      await settled(ctx, ctx.id);
      expect(activityOf(ctx.store, ctx.id)).not.toContain('does not contain');
      expect(ctx.log.some((l) => l.startsWith('Would git push -u origin feature/animate-jungle'))).toBe(true);
    });

    it("in the merge chain, an epic PR's conflict is resolved as the epic's next job, outside the chain, then merges", async () => {
      const ctx = await epicConflict(async (o) => { await o.tools.report_done('kept both'); return { done: 'kept both' }; });
      ctx.world.prs.set(420, { number: 420, url: 'u', state: 'OPEN', headRefOid: ctx.world.remoteBranches.get('feature/animate-jungle')!, headRefName: 'feature/animate-jungle', baseRefName: 'trunk', polls: 0, failOnce: false });
      ctx.store.mutateItem(ctx.id, [{ set: { status: 'IN_REVIEW', pr: 420 } }], 'engine');
      await waitFor(() => ['MERGED', 'FINISHED'].includes(ctx.store.getItem(ctx.id)!.file.frontmatter.status), 8000);
      const log = activityOf(ctx.store, ctx.id);
      expect(log).toMatch(/merge of origin\/trunk \(f{7}\) conflicted in LICENSES\.md/);
      expect(log).toMatch(/the conflict session resolved the merge \("kept both"\)/);
    });

    it('a message while the conflict session runs is queued for it and the orchestrator is told; its merge is not pushed over it (#210, HH-375)', async () => {
      const ctx = await epicConflict(async (o) => {
        await ctx.engine.message(ctx.id, 'stop, change nothing');
        await ctx.engine.message(ctx.id, 'leave the check edit out', 'orchestrator');
        await o.tools.report_done('kept both'); return { done: 'kept both' };
      });
      await ctx.engine.syncWithBase(ctx.id);
      await settled(ctx, ctx.id);
      const log = activityOf(ctx.store, ctx.id);
      expect(log).toContain('message queued for its running conflict session: stop, change nothing');
      expect(log).toContain('message queued for its running conflict session: leave the check edit out');
      expect(ctx.store.journal.read({ item: ctx.id, type: 'orchestrator.wake' }).filter((w) => w.data?.event === 'epic_message')).toHaveLength(1);   // the user's; the orchestrator's own is not sent back to it
      expect(log).toContain('the conflict session did not resolve it: messages arrived while it ran, and a one-shot session cannot read them: "stop, change nothing"; "leave the check edit out"');
      expect(ctx.log.some((l) => l.startsWith('Would git push -u origin feature/animate-jungle'))).toBe(false);
      const fm = ctx.store.getItem(ctx.id)!.file.frontmatter;
      expect(fm.blocked_reason).toBe('sync_conflict');
      expect(fm.op_data?.pending_messages ?? []).toEqual([]);
      // with no session live, the #127 behaviour stands: the orchestrator is refused, the user's word goes to the orchestrator
      await expect(ctx.engine.message(ctx.id, 'again', 'orchestrator')).rejects.toThrow(/no session past its breakdown/);
    });

    it("a message while the epic's merge worktree session runs reaches that session when its turn ends (#210)", async () => {
      let release!: () => void;
      const ctx = await setup({ hold: new Promise<void>((r) => { release = r; }) });
      const epic = ctx.store.createItem({ title: 'Animate Jungle enemies', description: 'x', kind: 'epic' } as any);
      const rel = `.claude/worktrees/merge-${epic.id.toLowerCase()}`, cwd = (ctx.engine as any).absWorktree(rel);
      ctx.world.worktrees.set(cwd, { path: cwd, head: ctx.world.sha(), branch: 'feature/animate-jungle' });
      ctx.store.mutateItem(epic.id, [{ set: { status: 'IN_REVIEW', branch: 'feature/animate-jungle', worktree: rel, session_id: 's-merge' } }], 'engine');
      (ctx.engine as any).runJob(epic.id, () => (ctx.engine as any).runTurnFor(epic.id, 'fix', 'Fix the red check on the epic PR.'));
      await waitFor(() => (ctx.engine as any).turns.has(epic.id));
      await ctx.engine.message(epic.id, 'stop, change nothing');
      expect(ctx.store.getItem(epic.id)!.file.frontmatter.op_data?.pending_messages).toEqual(['stop, change nothing']);
      expect(activityOf(ctx.store, epic.id)).toContain('message queued for its running session: stop, change nothing');
      release();
      await waitFor(() => ctx.prompts.some((p) => p.prompt.includes('Messages from the user while you were working:\n\n- stop, change nothing')));
    });

    it('the orchestrator retries a blocked one with resolve_epic_conflict and a hint; with the budget at 0 it blocks as before', async () => {
      let hinted = '';
      let second = false;
      const ctx = await epicConflict(async (o) => { if (!second) return { subtype: 'success' }; hinted = o.prompt; return { done: 'union-merged' }; });
      await ctx.engine.syncWithBase(ctx.id);
      await settled(ctx, ctx.id);
      expect(ctx.store.getItem(ctx.id)!.file.frontmatter.blocked_reason).toBe('sync_conflict');   // ended without reporting done
      second = true; ctx.world.conflictArmed = true;
      const r = await ctx.engine.retryEpicConflict(ctx.id, 'LICENSES.md is append-only: keep both sides\' rows');
      expect(r).toMatch(/^started: /);
      await settled(ctx, ctx.id);
      expect(hinted).toContain("The orchestrator's hint for this conflict:\nLICENSES.md is append-only: keep both sides' rows");
      expect(ctx.store.getItem(ctx.id)!.file.frontmatter.blocked).toBeUndefined();
      // off: a person resolves it, as before #71
      ctx.store.updateConfig((doc) => { doc.setIn(['epics', 'conflict_budget_usd'], 0); }, 'config: off');
      ctx.world.conflictArmed = true;
      expect(await ctx.engine.syncWithBase(ctx.id)).toMatch(/blocked for a person to resolve$/);
      expect(await ctx.engine.retryEpicConflict(ctx.id, undefined)).toMatch(/conflict sessions are off/);
    });
  });

  describe('a sync git refuses over local changes is not a conflict (#212, HH-257, HH-260)', () => {
    /** An open epic whose merge worktree a conflict session pushed from and left dirty (HH-260): git would not overwrite a tracked change or an untracked file. */
    function dirtyEpic(ctx: Awaited<ReturnType<typeof setup>>) {
      const epic = ctx.store.createItem({ title: 'Animate Jungle enemies', description: 'x', kind: 'epic' } as any);
      const rel = `.claude/worktrees/merge-${epic.id.toLowerCase()}`, cwd = (ctx.engine as any).absWorktree(rel);
      ctx.world.worktrees.set(cwd, { path: cwd, head: ctx.world.sha(), branch: 'feature/animate-jungle' });
      ctx.store.mutateItem(epic.id, [{ set: { status: 'IN_PROGRESS', branch: 'feature/animate-jungle', worktree: rel } }], 'engine');
      ctx.world.remoteBranches.set('feature/animate-jungle', ctx.world.sha());
      ctx.world.dirty.add(cwd); ctx.world.untracked.set(cwd, ['LICENSES.md.orig']);
      ctx.world.refuseFor = ['src/fake.ts', 'LICENSES.md.orig'];
      return { id: epic.id, cwd };
    }

    it("an epic's merge worktree left dirty is set aside, its tips logged first, and the next sync merges", async () => {
      const ctx = await setup({ conflictSession: async () => { throw new Error('no conflict session: nothing conflicted'); } });
      const { id, cwd } = dirtyEpic(ctx);
      await ctx.engine.start();
      const r = await ctx.engine.syncWithBase(id);
      expect(r).toMatch(/^synced: merged origin\/trunk into feature\/animate-jungle@f{7}/);
      const log = activityOf(ctx.store, id);
      const aside = log.indexOf(`the merge worktree ${cwd} has changes nothing committed (src/fake.ts, LICENSES.md.orig) at `);
      expect(aside).toBeGreaterThan(-1);
      expect(log).toMatch(/origin\/feature\/animate-jungle at \w{7}; setting them aside to \S+\.displaced\/\S+ \(nothing deleted\)/);
      expect(aside).toBeLessThan(log.indexOf('merged origin/trunk into feature/animate-jungle'));
      expect(ctx.log.some((l) => l.startsWith(`Would move LICENSES.md.orig from ${cwd} to `) && l.includes('.displaced/'))).toBe(true);
      expect(ctx.log.some((l) => l.startsWith('Would git reset --hard') && l.includes(cwd))).toBe(true);
      expect(ctx.world.dirty.has(cwd)).toBe(false);
      expect(log).not.toContain('Aborting');
      expect(ctx.prompts).toHaveLength(0);
      expect(ctx.store.getItem(id)!.file.frontmatter.blocked).toBeUndefined();
    });

    it('in the merge chain, the dirty merge worktree is set aside and the epic PR merges', async () => {
      const ctx = await setup();
      const { id } = dirtyEpic(ctx);
      ctx.world.prs.set(421, { number: 421, url: 'u', state: 'OPEN', headRefOid: ctx.world.remoteBranches.get('feature/animate-jungle')!, headRefName: 'feature/animate-jungle', baseRefName: 'trunk', polls: 0, failOnce: false });
      ctx.store.mutateItem(id, [{ set: { status: 'IN_REVIEW', pr: 421 } }], 'engine');
      await ctx.engine.start();
      await waitFor(() => ['MERGED', 'FINISHED'].includes(ctx.store.getItem(id)!.file.frontmatter.status), 8000);
      expect(activityOf(ctx.store, id)).toContain('has changes nothing committed (src/fake.ts, LICENSES.md.orig)');
    });

    it('a refusal over files that cannot be set aside says what git said and goes to no session; in the merge chain it blocks dirty_tree', async () => {
      const ctx = await setup();
      const { id } = worker(ctx, { pushed: true });
      await ctx.engine.start();
      ctx.world.refuseArmed = true;
      const r = await ctx.engine.syncWithBase(id);
      expect(r).toMatch(/^not synced: the rebase was refused by git: error: cannot rebase: You have unstaged changes\./);
      expect(activityOf(ctx.store, id)).toMatch(/rebase onto origin\/trunk \(f{7}\) was refused by git: error: cannot rebase/);
      expect(ctx.store.getItem(id)!.file.frontmatter.blocked).toBeUndefined();
      // the merge chain: blocked as a dirty tree with git's words, never sync_conflict, never a fix turn
      const pr = worker(ctx, { pushed: true });
      ctx.world.prs.set(422, { number: 422, url: 'u', state: 'OPEN', headRefOid: ctx.world.remoteBranches.get(pr.branch)!, headRefName: pr.branch, baseRefName: 'trunk', polls: 0, failOnce: false });
      ctx.world.refuseArmed = true;
      ctx.store.mutateItem(pr.id, [{ set: { status: 'IN_REVIEW', pr: 422 } }], 'engine');
      await waitFor(() => ctx.store.getItem(pr.id)!.file.frontmatter.blocked === true);
      const fm = ctx.store.getItem(pr.id)!.file.frontmatter;
      expect(fm.blocked_reason).toBe('dirty_tree');
      expect(activityOf(ctx.store, pr.id)).toMatch(/the rebase onto origin\/trunk \(f{7}\) was refused by git: error: cannot rebase/);
      expect(activityOf(ctx.store, pr.id)).not.toContain('conflicted in');
      expect(ctx.prompts).toHaveLength(0);
    });

    it('an untracked byproduct the sync would overwrite is moved aside and the sync runs again', async () => {
      const ctx = await setup();
      ctx.store.updateConfig((doc) => { doc.setIn(['worktrees', 'byproducts'], ['*.import']); }, 'config: byproducts');
      const { id, cwd } = worker(ctx, { pushed: true });
      ctx.world.untracked.set(cwd, ['art/boss.png.import']);
      ctx.world.refuseFor = ['art/boss.png.import'];
      await ctx.engine.start();
      const r = await ctx.engine.syncWithBase(id);
      expect(r).toMatch(/^synced: rebased onto origin\/trunk@f{7}/);
      expect(activityOf(ctx.store, id)).toMatch(/git would not overwrite 1 untracked file the sync brings in; moved it aside \(nothing deleted\) to \S+\.displaced\/\S+: art\/boss\.png\.import; syncing again/);
      expect(ctx.world.untracked.get(cwd)).toEqual([]);
      expect(ctx.log.filter((l) => l.includes('refused: local changes would be overwritten'))).toHaveLength(1);
    });
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
    // the epic page's button goes the same way, once the base has moved again
    for (const cwd of ctx.world.worktrees.keys()) ctx.world.behind.set(cwd, 1);
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

  describe('approving a plan syncs the branch with its base before implementation starts (#217)', () => {
    /** A worker item whose plan is ready, its planning worktree cut on trunk; the base moves on unless `behind` is 0. */
    async function planReady(opts: Parameters<typeof setup>[0] & { behind?: number; delegated?: boolean } = {}) {
      const ctx = await setup(opts);
      const w = worker(ctx, { status: 'PLAN_READY' });
      ctx.store.mutateItem(w.id, [{ set: { started_at: '2026-01-01T00:00:00+00:00', ...(opts.delegated ? { auto_approve_plan: true } : {}) } }], 'engine');
      if (opts.behind !== undefined) ctx.world.behind.set(w.cwd, opts.behind);
      await ctx.engine.start();
      return { ...ctx, ...w };
    }

    it('a base that moved after planning: the branch is rebased first, and the implement turn starts on the new tip, told so', async () => {
      const ctx = await planReady();
      await ctx.engine.approvePlan(ctx.id, undefined, 'user', { syncFirst: true });
      await waitFor(() => ctx.prompts.length >= 1);
      expect(ctx.log).toContain(`Would git rebase origin/trunk in ${ctx.cwd}`);
      expect(ctx.prompts[0].phase).toBe('implement');
      expect(ctx.prompts[0].behind).toBe(0);
      expect(ctx.prompts[0].prompt).toContain('planestro rebased your branch onto origin/trunk');
      expect(activityOf(ctx.store, ctx.id)).toContain('rebased onto origin/trunk before implementation starts');
      expect(ctx.store.getItem(ctx.id)!.file.frontmatter.op).toBeUndefined();
    });

    it('a base that has not moved: no sync, and the implement turn starts as it always did', async () => {
      const ctx = await planReady({ behind: 0 });
      await ctx.engine.approvePlan(ctx.id, undefined, 'user', { syncFirst: true });
      await waitFor(() => ctx.prompts.length >= 1);
      expect(ctx.log.some((l) => l.includes('git rebase'))).toBe(false);
      expect(ctx.prompts[0].phase).toBe('implement');
      expect(ctx.prompts[0].prompt).not.toContain('rebased your branch');
    });

    it('it is the default; sync_first: false approves without it', async () => {
      const on = await planReady();
      await on.engine.approvePlan(on.id);
      await waitFor(() => on.prompts.length >= 1);
      expect(on.prompts[0].behind).toBe(0);
      await on.engine.stop(); on.store.close();
      const off = await planReady();
      store = off.store; engine = off.engine;
      await off.engine.approvePlan(off.id, undefined, 'user', { syncFirst: false });
      await waitFor(() => off.prompts.length >= 1);
      expect(off.prompts[0].behind).toBe(1);
    });

    it('a conflict goes to the session as the first thing it sees, and the plan to implement comes once planestro has finished the rebase', async () => {
      const ctx = await planReady();
      ctx.world.conflictArmed = true;
      await ctx.engine.approvePlan(ctx.id, undefined, 'user', { syncFirst: true });
      await waitFor(() => ctx.prompts.length >= 2);
      expect(ctx.prompts[0].phase).toBe('implement');
      expect(ctx.prompts[0].prompt).toContain('src/conflicted.ts');
      expect(ctx.prompts[0].prompt).not.toContain('Now start on this');
      expect(ctx.prompts[0].behind).toBe(1);
      expect(ctx.prompts[1].phase).toBe('implement');
      expect(ctx.prompts[1].behind).toBe(0);
      expect(ctx.prompts[1].prompt).toContain('planestro finished rebasing your branch');
      expect(ctx.prompts[1].prompt).toContain('Now start on this');
      expect(ctx.store.getItem(ctx.id)!.file.frontmatter.blocked).toBeUndefined();
    });

    it('the orchestrator approves with sync_first, and the API takes it from the user', async () => {
      let said = '';
      let id = '';
      const ctx = await planReady({
        delegated: true,
        orchestrate: async (t) => { said ||= await t('approve_plan').handler({ id, sync_first: true }); await t('done_with_wake').handler({ summary: 'approved' }); },
      });
      id = ctx.id;
      ctx.store.updateConfig((doc) => { doc.setIn(['orchestrator', 'may_approve_plans'], true); }, 'config: delegate');
      ctx.engine.orchestrator.wake({ type: 'plan_review', item: id });
      await waitFor(() => ctx.prompts.some((p) => p.phase === 'implement'));
      expect(said).toBe('approved');
      expect(ctx.prompts.find((p) => p.phase === 'implement')!.behind).toBe(0);
      const other = worker(ctx, { status: 'PLAN_READY' });
      const app = apiRoutes(ctx.store, ctx.engine);
      const res = await app.request(`/items/${other.id}/plan/approve`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sync_first: false }) });
      expect(res.status).toBe(200);
      await waitFor(() => ctx.prompts.filter((p) => p.phase === 'implement').length === 2);
      expect(ctx.prompts.filter((p) => p.phase === 'implement')[1].behind).toBe(1);
    });

    it('the plan says what has merged into its base since it was planned', async () => {
      const ctx = await setup();
      const w = worker(ctx, { status: 'PLAN_READY' });
      ctx.store.mutateItem(w.id, [{ set: { started_at: '2026-01-01T00:00:00+00:00' } }], 'engine');
      const before = ctx.store.createItem({ title: 'Earlier', description: 'x' });
      const after = ctx.store.createItem({ title: 'Later', description: 'x' });
      ctx.store.mutateItem(before.id, [{ set: { status: 'FINISHED', merged_at: '2025-12-31T00:00:00+00:00' } }], 'engine');
      ctx.store.mutateItem(after.id, [{ set: { status: 'FINISHED', merged_at: '2026-01-02T00:00:00+00:00' } }], 'engine');
      expect(ctx.store.mergedSinceCut(ctx.store.getItem(w.id)!)).toEqual([after.id]);
      const res = await apiRoutes(ctx.store, ctx.engine).request(`/items/${w.id}`);
      expect((await res.json()).merged_since_cut).toEqual([after.id]);
      const packet: string = (ctx.engine.orchestrator as any).renderPacket({ type: 'plan_review', item: w.id });
      expect(packet).toContain(`Merged into trunk since it was planned: ${after.id}`);
    });
  });
});

describe('a pull request whose rebase conflicts: planestro holds the rebase and the session edits only the files (HH-532)', () => {
  /** A worker item driven to its pull request; its merge-step rebase conflicts once. `turn` answers the fix turns. */
  async function inReview(turn?: (o: TurnOptions, world: FakeWorld) => Promise<Partial<TurnResult> | undefined>) {
    const seen: { prompt: string; midRebase: boolean; ciHead?: string }[] = [];
    let ctx!: Awaited<ReturnType<typeof setup>>;
    let id = '';
    ctx = await setup({
      turn: async (o, world) => {
        if (o.phase === 'implement') { world.conflictArmed = true; return undefined; }
        if (o.phase !== 'fix') return undefined;
        seen.push({ prompt: o.prompt, midRebase: world.stoppedRebases.has(o.cwd), ciHead: ctx.store.getItem(id)!.file.frontmatter.ci_head_sha });
        return turn ? turn(o, world) : undefined;
      },
    });
    const item = ctx.store.createItem({ title: 'Grapple copy', description: 'x' });
    id = item.id;
    ctx.store.transition(id, 'QUEUED', 'user');
    await ctx.engine.start();
    await waitFor(() => ctx.store.getItem(id)!.file.frontmatter.status === 'PLAN_READY');
    await ctx.engine.approvePlan(id, undefined, 'user', { syncFirst: false });
    return { ...ctx, id, seen, fm: () => ctx.store.getItem(id)!.file.frontmatter };
  }

  it('the conflict turn has no fetch, rebase or push step; planestro left the worktree mid-rebase, then continues, pushes with a lease and validates the new head', async () => {
    const ctx = await inReview();
    await waitFor(() => ctx.fm().status === 'FINISHED', 8000);
    expect(ctx.seen).toHaveLength(1);
    expect(ctx.seen[0].midRebase).toBe(true);
    expect(ctx.seen[0].prompt).toContain('src/conflicted.ts');
    expect(ctx.seen[0].prompt).not.toMatch(/git fetch|fetch origin|git rebase origin|git push/);
    const activity = activityOf(ctx.store, ctx.id);
    expect(activity).toContain('rebase onto origin/trunk (fffffff) conflicted in src/conflicted.ts; handing to the session');
    expect(activity).toContain('planestro continued the rebase onto origin/trunk (fffffff) and checked it');
    expect(activity).toContain('Re-entering the merge pipeline, which pushes it with a lease and waits for CI on the new head');
    // The PR merges at the head CI ran for after the push, never the head before the conflict.
    const merge = ctx.log.find((l) => l.startsWith('Would gh pr merge 100'))!;
    expect(merge).toBeDefined();
    expect(merge).not.toContain(ctx.seen[0].ciHead!);
    expect(activity.indexOf('Re-entering the merge pipeline')).toBeLessThan(activity.indexOf('rebased onto trunk@fffffff and pushed'));
  });

  it('a later commit that stops on its own conflict goes back to the session as another round', async () => {
    const ctx = await inReview(async (_o, world) => { if (!world.continueOutcomes.length && !(world as any).scripted) { (world as any).scripted = true; world.continueOutcomes.push({ state: 'stopped', files: ['src/other.ts'], stepFiles: ['src/other.ts'] }); } return undefined; });
    await waitFor(() => ctx.fm().status === 'FINISHED', 8000);
    expect(ctx.seen).toHaveLength(2);
    expect(ctx.seen[1].prompt).toContain('stopped again at a later commit');
    expect(ctx.seen[1].prompt).toContain('src/other.ts');
    expect(ctx.seen[1].midRebase).toBe(true);
  });

  it('a session that blocks: the rebase is aborted, the branch is as it was, it blocks sync_conflict once, and a retry without guidance does not loop back to it', async () => {
    const ctx = await inReview(async (o) => { await o.tools.report_blocked('The two grapple cooldowns truly contradict: which one wins?'); return { blocked: 'The two grapple cooldowns truly contradict: which one wins?' }; });
    await waitFor(() => ctx.fm().blocked_reason === 'sync_conflict');
    expect(ctx.log.some((l) => l.startsWith('Would git rebase --abort'))).toBe(true);
    expect(ctx.fm().op_data?.rebase_continue).toBeUndefined();
    expect(ctx.fm().op_data?.needs_session_rebase).toBe(false);
    expect(activityOf(ctx.store, ctx.id)).toContain('the held rebase onto origin/trunk was not kept: the session could not resolve it');
    // retry_op as the orchestrator would: the same base conflicts again, and it is a person's now.
    ctx.world.conflictArmed = true;
    expect(await ctx.engine.retryOp(ctx.id, 'orchestrator')).toMatch(/^retrying: it re-enters the merge pipeline/);
    await waitFor(() => ctx.fm().blocked_reason === 'sync_conflict' && activityOf(ctx.store, ctx.id).includes('already could not resolve this conflict at this base tip'));
    expect(ctx.seen).toHaveLength(1);
    // With guidance it goes to the session again, carrying it.
    ctx.world.conflictArmed = true;
    expect(await ctx.engine.retryOp(ctx.id, 'orchestrator', 'Keep the 10 s cooldown from the base; it is the designer\'s.')).toMatch(/^retrying/);
    await waitFor(() => ctx.seen.length === 2);
    expect(ctx.seen[1].prompt).toContain('Guidance for this conflict');
    expect(ctx.seen[1].prompt).toContain('Keep the 10 s cooldown from the base');
  });

  it('a base that moves while the session resolves is not a failed rebase: it is checked against the tip it rebased onto (#485)', async () => {
    const ctx = await inReview(async (_o, world) => { world.unreachable.add('origin/trunk'); return undefined; });
    await waitFor(() => activityOf(ctx.store, ctx.id).includes('the session resolved the conflict') || ctx.fm().blocked === true, 8000);
    expect(ctx.fm().blocked_reason).toBeUndefined();
    expect(activityOf(ctx.store, ctx.id)).not.toContain('does not contain');
    expect(activityOf(ctx.store, ctx.id)).toMatch(/the session resolved the conflict[^;]*; planestro continued the rebase onto origin\/trunk \(f{7}\) and checked it/);
  });

  it('a held rebase whose result lacks the tip it rebased onto blocks sync_conflict (#485)', async () => {
    const ctx = await inReview(async (_o, world) => { world.unreachable.add('f'.repeat(40)); return undefined; });
    await waitFor(() => ctx.fm().blocked_reason === 'sync_conflict');
    expect(activityOf(ctx.store, ctx.id)).toContain('the result does not contain origin/trunk (fffffff)');
  });

  it('conflict markers left in a file are not continued: the branch goes back and it blocks sync_conflict', async () => {
    const ctx = await inReview(async (_o, world) => { world.continueOutcomes.push({ state: 'markers', files: ['src/conflicted.ts'] }); return undefined; });
    await waitFor(() => ctx.fm().blocked_reason === 'sync_conflict');
    expect(activityOf(ctx.store, ctx.id)).toContain('it left conflict markers in src/conflicted.ts');
    expect(ctx.log.some((l) => l.startsWith('Would git rebase --abort'))).toBe(true);
  });

  it('unblock_item with sync_first on a pull request stopped on its conflict re-enters the pipeline instead of refusing', async () => {
    const ctx = await inReview(async (o) => { if (!(o as any).again) { await o.tools.report_blocked('needs a decision'); return { blocked: 'needs a decision' }; } return undefined; });
    await waitFor(() => ctx.fm().blocked_reason === 'sync_conflict');
    ctx.world.conflictArmed = true;
    const r = await ctx.engine.syncWithBase(ctx.id, { by: 'orchestrator', unblock: { message: 'Take both rows.' } });
    expect(r).toMatch(/^in review, so the merge pipeline syncs it: retrying/);
    expect(r).not.toContain('retry_op re-enters it');
    await waitFor(() => ctx.seen.length === 2);
    expect(ctx.seen[1].prompt).toContain('Take both rows.');
  });
});

describe('the conflict prompt and the worker rules agree (HH-532)', () => {
  const shipped = (name: string) => readFileSync(new URL(`../prompts/${name}.md`, import.meta.url), 'utf8');
  it('the conflict turn never asks for a fetch, a rebase of its own or a push; both runners\' rules leave the rebase to planestro', () => {
    const conflict = shipped('rebase-conflict');
    expect(conflict).not.toMatch(/`git (fetch|rebase|push)/);
    expect(conflict).toContain('You need no git commands');
    expect(conflict).toContain('{{conflict_hint}}');
    for (const rules of [shipped('worker-system'), shipped('worker-system-codex')]) {
      expect(rules).toMatch(/planestro owns every integration operation/);
      expect(rules).toMatch(/When planestro stops one of its rebases at a conflict, it hands you the conflicted files to edit/);
    }
    expect(shipped('worker-system-codex')).toMatch(/do not try to push or fetch/);
  });

  it("a data dir's untouched copy of the retired conflict prompt is brought up to the shipped one at startup; an edited copy is kept", async () => {
    const { dataDir } = makeFixture();
    const path = join(dataDir, 'prompts', 'rebase-conflict.md');
    const retired = `---\nschema: 1\nname: rebase-conflict\nkind: template\nrole: rebase_conflict\ntitle: Rebase conflict\ndescription: Sent when planestro's rebase of the worker branch onto its base hits conflicts.\n---\nplanestro tried to rebase \`{{item.branch}}\` onto the latest \`{{base_branch}}\` ({{base_sha}}) and hit conflicts in:\n\n\`\`\`\n{{conflict_files}}\n\`\`\`\n\nThe rebase was aborted; your worktree {{worktree}} is unchanged. Please resolve this yourself, because you know the intent of the change:\n\n1. \`git fetch origin\` and \`git rebase origin/{{base_branch}}\` in your worktree, resolving each conflict so both the base's changes and yours survive.\n2. Re-run the project's relevant checks.\n3. Finish the rebase (\`git rebase --continue\`), leave the tree clean, and call \`report_done\` with a summary of how you resolved it. Do not push — planestro pushes.\n`;
    writeFileSync(path, retired);
    store = await DataStore.open(dataDir);
    expect(readFileSync(path, 'utf8')).toContain('You need no git commands');
    store.close();
    const edited = retired.replace('Re-run the project', 'Re-run all of the project');
    writeFileSync(path, edited);
    store = await DataStore.open(dataDir);
    expect(readFileSync(path, 'utf8')).toBe(edited);
  });
});
