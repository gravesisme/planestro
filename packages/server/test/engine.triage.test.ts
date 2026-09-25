import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { needsYou } from '@planestro/shared';
import { DataStore } from '../src/store/DataStore.ts';
import { LiveEngine } from '../src/engine/LiveEngine.ts';
import { apiRoutes } from '../src/routes/api.ts';
import { FakeWorld, DryRunGitPort, DryRunGhPort, DryRunProcPort } from '../src/engine/dryrun-ports.ts';
import type { Ports, TurnOptions, TurnResult, CustomTurnOptions } from '../src/engine/ports.ts';
import { makeFixture, sleep } from './helpers.ts';

let store: DataStore | undefined; let engine: LiveEngine | undefined;
afterEach(async () => { await engine?.stop(); store?.close(); store = undefined; engine = undefined; });

type Tool = (name: string) => { handler(a: Record<string, unknown>): Promise<string> };
type Wake = { label: string; prompt: string; tools: Tool };
const ok: TurnResult = { sessionId: 's', subtype: 'success', isError: false, costUsd: 0, numTurns: 1, text: '' };

/**
 * A worker whose first planning turn stops the way `firstTurn` says (a report_blocked, a question),
 * and whose later turns submit a plan; and an orchestrator whose wakes run `orchestrate`.
 */
function agents(opts: { firstTurn: (o: TurnOptions) => Promise<TurnResult>; orchestrate?: (w: Wake) => Promise<void>; noOrchestrator?: boolean }) {
  const prompts: string[] = []; const wakes: Wake[] = [];
  const claude: Ports['agents']['claude'] = {
    async runTurn(o: TurnOptions): Promise<TurnResult> {
      prompts.push(o.prompt);
      if (prompts.length === 1) return opts.firstTurn(o);
      await o.tools.submit_plan('# the plan');
      return { ...ok, planSubmitted: '# the plan' };
    },
    ...(opts.noOrchestrator ? {} : {
      async runCustomTurn(o: CustomTurnOptions): Promise<TurnResult> {
        const w = { label: o.label, prompt: o.prompt, tools: ((n: string) => o.mcpTools.find((t) => t.name === n)!) as Tool };
        wakes.push(w);
        await opts.orchestrate?.(w);
        return { ...ok, sessionId: 'orch' };
      },
    }),
  };
  return { claude, prompts, wakes };
}

const blocksOnce = async (o: TurnOptions): Promise<TurnResult> => { await o.tools.report_blocked('I need to know which base to use'); return { ...ok, blocked: 'I need to know which base to use' }; };

async function setup(claude: Ports['agents']['claude'], yml: (s: string) => string = (s) => s) {
  const { dataDir, codeRepo } = makeFixture();
  mkdirSync(join(codeRepo, '.git', 'info'), { recursive: true });
  const cfg = join(dataDir, 'planestro.yml');
  writeFileSync(cfg, yml(readFileSync(cfg, 'utf8').replace(/^code_repo:\n/m, 'code_repo:\n  github: acme/repo\n').replace('after_worktree_create: []', 'after_worktree_create: ["echo hook"]')));
  delete process.env.PLANESTRO_DRYRUN_CI;
  store = await DataStore.open(dataDir);
  const world = new FakeWorld(() => {}, { 'origin/trunk': 'f'.repeat(40) });
  const ports: Ports = { mode: 'dry-run', git: new DryRunGitPort(world), gh: new DryRunGhPort(world), proc: new DryRunProcPort(world), agents: { claude } };
  engine = new LiveEngine(store, ports, () => {}, { sleep: async () => {}, tickMs: 50 });
  const item = store.createItem({ title: 'Stops', description: 'x' });
  store.transition(item.id, 'QUEUED', 'user');
  return { store, engine, world, id: item.id };
}

async function waitFor(pred: () => boolean, ms = 5000) { const t0 = Date.now(); while (!pred()) { if (Date.now() - t0 > ms) throw new Error('timeout waiting'); await sleep(20); } }
const fmOf = (s: DataStore, id: string) => s.getItem(id)!.file.frontmatter;
const activityOf = (s: DataStore, id: string) => s.getItem(id)!.file.sections.find((x) => x.title === 'Activity')!.body;
const needs = (s: DataStore, id: string) => s.derived(s.getItem(id)!).needs_you;

describe('needs-you triage', () => {
  it('a block goes to the orchestrator first; a wake that resolves nothing hands it to you as it was', async () => {
    const seen: { triage: boolean; needs: boolean }[] = [];
    const a = agents({ firstTurn: blocksOnce, orchestrate: async (w) => { if (w.label.startsWith('blocked_')) { const fm = fmOf(store!, 'TP-1'); seen.push({ triage: Boolean(fm.triage), needs: needs(store!, 'TP-1') }); expect(w.prompt).toContain('Triage: DELEGATED TO YOU'); expect(w.prompt).toContain('BLOCKED (agent_blocked)'); } } });
    const { store: s, engine: e, id } = await setup(a.claude);
    await e.start();
    await waitFor(() => fmOf(s, id).blocked === true && !fmOf(s, id).triage);
    expect(seen).toEqual([{ triage: true, needs: false }]);
    expect(a.wakes[0].label).toBe('blocked_agent_blocked');
    expect(needs(s, id)).toBe(true);
    expect(activityOf(s, id)).toContain('the orchestrator is triaging this (agent_blocked)');
    expect(activityOf(s, id)).toContain('needs you: the orchestrator looked at it without resolving it');
  });

  it('needs-you never counts an item in triage', () => {
    expect(needsYou({ blocked: true, awaiting: 'user', triage: { reason: 'no_plan', started_at: '2026-09-23T10:00:00+00:00' } })).toBe(false);
    expect(needsYou({ blocked: true, awaiting: 'user' })).toBe(true);
    expect(needsYou({ awaiting: 'question', triage: { reason: 'question', started_at: '2026-09-23T10:00:00+00:00' } })).toBe(false);
  });

  it('unblock_item resolves it: the session resumes with the instruction and the item never needs you', async () => {
    const needed: boolean[] = [];
    const a = agents({ firstTurn: blocksOnce, orchestrate: async (w) => { if (w.label.startsWith('blocked_')) { needed.push(needs(store!, 'TP-1')); expect(await w.tools('unblock_item').handler({ id: 'TP-1', message: 'Use the epic branch; the brief says so.' })).toContain('resumes with your message'); } } });
    const { store: s, engine: e, id } = await setup(a.claude);
    await e.start();
    await waitFor(() => fmOf(s, id).status === 'PLAN_READY');
    expect(needed).toEqual([false]);
    expect(a.prompts[1]).toContain('Use the epic branch; the brief says so.');
    expect(fmOf(s, id).blocked).toBeUndefined();
    expect(fmOf(s, id).triage).toBeUndefined();
    expect(activityOf(s, id)).toContain('[orchestrator] unblocked: Use the epic branch');
    expect(activityOf(s, id)).not.toContain('needs you:');
  });

  it('answer_question answers a worker question from the brief', async () => {
    const asks = async (o: TurnOptions): Promise<TurnResult> => { await o.onQuestion([{ question: 'Which base?', options: [{ label: 'trunk' }, { label: 'epic' }] }]); return { ...ok, parked: 'question' }; };
    const a = agents({ firstTurn: asks, orchestrate: async (w) => { if (w.label === 'worker_question') { expect(w.prompt).toContain('Which base?'); expect(needs(store!, 'TP-1')).toBe(false); expect(await w.tools('answer_question').handler({ id: 'TP-1', answers: { 'Which base?': 'epic' } })).toContain('answered'); } } });
    const { store: s, engine: e, id } = await setup(a.claude);
    await e.start();
    await waitFor(() => fmOf(s, id).status === 'PLAN_READY');
    expect(a.prompts[1]).toContain('A: epic');
    expect(activityOf(s, id)).toContain('[orchestrator] answered: epic');
  });

  it('set_item_fields refuses anything off its whitelist and sets what is on it', async () => {
    const replies: string[] = [];
    const a = agents({ firstTurn: blocksOnce, orchestrate: async (w) => {
      if (!w.label.startsWith('blocked_')) return;
      const t = w.tools('set_item_fields');
      replies.push(await t.handler({ id: 'TP-1', fields: { status: 'FINISHED', parent: 'TP-2' } }));
      replies.push(await t.handler({ id: 'TP-1', fields: { parent: 'TP-1' } }));
      replies.push(await t.handler({ id: 'TP-1', fields: { parent: 'TP-2', allow_model_fallback: true } }));
    } });
    const { store: s, engine: e, id } = await setup(a.claude);
    s.createItem({ title: 'The epic', kind: 'epic' });
    await e.start();
    await waitFor(() => replies.length === 3);
    expect(replies[0]).toContain('not permitted: status');
    expect(replies[1]).toContain('is not an epic');
    expect(replies[2]).toContain('set parent = TP-2, allow_model_fallback = true');
    expect(replies[2]).toContain('recreate_worktree');
    expect(fmOf(s, id).parent).toBe('TP-2');
    expect(fmOf(s, id).status).toBe('PLAN_IN_PROGRESS');
  });

  it('recreate_worktree refuses a worktree with commits, and otherwise recreates it, re-runs setup and unblocks', async () => {
    const replies: string[] = [];
    let world: FakeWorld;
    const cwd = () => join(store!.codeRepoPath(), '.claude/worktrees/tp-1-stops');
    const a = agents({ firstTurn: blocksOnce, orchestrate: async (w) => {
      if (!w.label.startsWith('blocked_')) return;
      const t = w.tools('recreate_worktree');
      world.commits.set(cwd(), 2);
      replies.push(await t.handler({ id: 'TP-1' }));
      world.dirty.add(cwd()); world.commits.set(cwd(), 0);
      replies.push(await t.handler({ id: 'TP-1' }));
      world.dirty.delete(cwd());
      replies.push(await t.handler({ id: 'TP-1', message: 'Fresh worktree; start the plan again.' }));
    } });
    const ctx = await setup(a.claude); world = ctx.world;
    await ctx.engine.start();
    await waitFor(() => fmOf(ctx.store, ctx.id).status === 'PLAN_READY');
    expect(replies[0]).toContain('refused: tp/1-stops has commits that are not on origin/trunk');
    expect(replies[1]).toContain('refused');
    expect(replies[1]).toContain('uncommitted changes');
    expect(replies[2]).toContain('recreating');
    expect(a.prompts[1]).toContain('Fresh worktree; start the plan again.');
    const act = activityOf(ctx.store, ctx.id);
    expect(act).toContain('[orchestrator] recreating .claude/worktrees/tp-1-stops on tp/1-stops from origin/trunk');
    expect(act.match(/hook ok: echo hook/g)?.length).toBe(2); // setup ran again
    expect(fmOf(ctx.store, ctx.id).blocked).toBeUndefined();
    expect(world.worktrees.has(cwd())).toBe(true);
  });

  it('retry_op resumes a session stopped by a transient failure', async () => {
    const fails = async (): Promise<TurnResult> => ({ ...ok, subtype: 'error_during_execution', isError: true, error: 'GitHub 503' });
    const a = agents({ firstTurn: fails, orchestrate: async (w) => { if (w.label === 'blocked_turn_error') expect(await w.tools('retry_op').handler({ id: 'TP-1' })).toContain('session is resumed'); } });
    const { store: s, engine: e, id } = await setup(a.claude);
    await e.start();
    await waitFor(() => fmOf(s, id).status === 'PLAN_READY');
    expect(a.prompts[1]).toContain('transient failure (turn_error)');
  });

  it("a card's '+$N and resume' option raises the item's budget when tapped, and the wake says so (p43)", async () => {
    const replies: string[] = [];
    const a = agents({ firstTurn: blocksOnce, orchestrate: async (w) => {
      if (w.label.startsWith('blocked_')) {
        const t = w.tools('ask_user_decision');
        replies.push(await t.handler({ item: 'TP-1', question: 'Give it more budget?', why: 'It is one step from done.', options: [{ label: '+$40 and resume', description: 'Raise the cap and carry on', recommended: true, raise_budget_usd: 40 }, { label: 'Stop here', description: 'Leave it blocked' }] }));
        replies.push(await t.handler({ item: 'TP-1', question: 'Bad raise?', why: 'x', options: [{ label: 'A', description: '', recommended: true, raise_budget_usd: -5 }, { label: 'B', description: '' }] }));
      }
      if (w.label === 'decision_answered') {
        expect(w.prompt).toContain('budget: The item\'s budget is already raised to $');
        expect(w.prompt).toContain('Resume it with unblock_item');
        await w.tools('unblock_item').handler({ id: 'TP-1', message: 'Carry on.' });
      }
    } });
    const { store: s, engine: e, id } = await setup(a.claude);
    await e.start();
    await waitFor(() => Boolean((fmOf(s, id).awaiting_data as any)?.decision));
    expect(replies[0]).toContain('recorded');
    expect(replies[1]).toContain('raise_budget_usd must be a number of dollars');
    const before = fmOf(s, id);
    expect(before.budget_usd).toBeUndefined();
    await e.answerDecision(id, { choice: '+$40 and resume' });
    const after = fmOf(s, id);
    expect(after.budget_usd).toBe(s.config.budget_usd_per_item + 40);
    expect(activityOf(s, id)).toContain(`(budget raised to $${s.config.budget_usd_per_item + 40})`);
    await waitFor(() => !fmOf(s, id).blocked);
    expect(s.journal.read({ type: 'orchestrator.decision_answered' })[0].data?.budget_raised_to).toBe(s.config.budget_usd_per_item + 40);
  });

  it('a card is withdrawn by withdraw_decision, replaced by a new block, and cleared by an engine block; never left moot (p42)', async () => {
    let messages = 0, stops = 0; const replies: string[] = [];
    const card = { question: 'Raise the budget?', why: 'It spent its cap.', options: [{ label: '+$40', description: 'more', recommended: true }, { label: 'Stop', description: 'leave it' }] };
    const a = agents({ firstTurn: blocksOnce, orchestrate: async (w) => {
      if (w.label.startsWith('blocked_') && ++stops === 1) await w.tools('ask_user_decision').handler({ item: 'TP-1', ...card });   // only the first stop gets a card
      if (w.label === 'user_message') {
        messages += 1;
        if (messages === 1) { replies.push(await w.tools('withdraw_decision').handler({ id: 'TP-1', reason: 'the user raised it by hand' })); replies.push(await w.tools('withdraw_decision').handler({ id: 'TP-1', reason: 'again' })); }
        if (messages === 2) { await w.tools('ask_user_decision').handler({ item: 'TP-1', ...card }); await w.tools('mark_blocked').handler({ id: 'TP-1', reason: 'the user took it over' }); }
      }
    } });
    const { store: s, engine: e, id } = await setup(a.claude);
    await e.start();
    await waitFor(() => Boolean((fmOf(s, id).awaiting_data as any)?.decision));
    e.orchestrator.wake({ type: 'user_message', item: id, data: { message: 'I raised it' } });
    await waitFor(() => replies.length === 2);
    expect(replies[0]).toContain('withdrawn');
    expect(replies[1]).toContain('nothing to withdraw');
    let fm = fmOf(s, id);
    expect((fm.awaiting_data as any)?.decision).toBeUndefined();
    expect(fm).toMatchObject({ blocked: true, blocked_reason: 'agent_blocked' });        // the stop itself is untouched
    expect(activityOf(s, id)).toContain('withdrew the decision card (Raise the budget?): the user raised it by hand');
    e.orchestrator.wake({ type: 'user_message', item: id, data: { message: 'x' } });
    await waitFor(() => fmOf(s, id).blocked_reason === 'orchestrator');
    fm = fmOf(s, id);
    expect((fm.awaiting_data as any)?.decision).toBeUndefined();                          // mark_blocked replaced the new card
    expect(activityOf(s, id)).toContain('the decision card it had is withdrawn: this block replaces it');
    s.mutateItem(id, [{ set: { awaiting_data: { decision: { ...card, allow_free_text: true, requested_at: 'now' } } } }], 'engine');
    (e as any).block(id, 'engine_error', 'something else broke');
    expect((fmOf(s, id).awaiting_data as any)?.decision).toBeUndefined();                // an engine block clears it too
    expect(activityOf(s, id)).toContain('BLOCKED (engine_error): something else broke');
  });

  it('an engineering fix is filed for the maintainer, not put on a card, and the packet says so (p38)', async () => {
    let reply = '';
    const a = agents({ firstTurn: blocksOnce, orchestrate: async (w) => {
      if (w.label.startsWith('blocked_')) {
        expect(w.prompt).toContain('never asks the user to edit code or config');
        reply = await w.tools('file_for_maintainer').handler({ title: 'CI: the Mac runner\'s log upload step is broken', description: 'ci.yml uploads to a path with ..; upload-artifact rejects it. Fix the path and push.', from_item: 'TP-1' });
        await w.tools('annotate_item').handler({ id: 'TP-1', text: 'waits on the maintainer item' });
      }
    } });
    const { store: s, engine: e, id } = await setup(a.claude);
    await e.start();
    await waitFor(() => reply !== '');
    expect(reply).toMatch(/^filed TP-2 \(NOT_YET_SUBMITTED, for the maintainer\)/);
    const filed = fmOf(s, 'TP-2');
    expect(filed.status).toBe('NOT_YET_SUBMITTED');
    expect(filed.title).toBe("CI: the Mac runner's log upload step is broken");
    expect(s.getItem('TP-2')!.file.sections.find((x) => x.title === 'Notes')!.body).toContain('Filed by the orchestrator while triaging TP-1');
    expect(activityOf(s, id)).toContain('filed TP-2 for the maintainer: CI: the Mac runner');
    expect((fmOf(s, id).awaiting_data as any)?.decision).toBeUndefined();
  });

  it('the packet lists the repository\'s open pull requests, marking the ones no item owns (p38 part 2)', async () => {
    let packet = '';
    const a = agents({ firstTurn: blocksOnce, orchestrate: async (w) => { if (w.label.startsWith('blocked_')) packet = w.prompt; } });
    const { store: s, engine: e, id } = await setup(a.claude);
    (e as any).ports.gh.prList = async () => [
      { number: 338, url: 'u', state: 'OPEN', headRefOid: 'a', headRefName: 'fix/ci-log-upload', baseRefName: 'develop', title: "CI: the Mac runner's log dir must not contain '..'", author: 'gravesisme', updatedAt: new Date(Date.now() - 20 * 60_000).toISOString() },
      { number: 300, url: 'u', state: 'OPEN', headRefOid: 'b', headRefName: fmOf(s, id).branch ?? 'tp/1-stops', baseRefName: 'trunk', title: 'Stops (TP-1)', updatedAt: new Date(Date.now() - 3 * 86_400_000).toISOString() },
    ];
    await e.start();
    await waitFor(() => packet !== '');
    expect(packet).toContain('Open pull requests in the repository (2)');
    expect(packet).toContain(`- #338 "CI: the Mac runner's log dir must not contain '..'" — fix/ci-log-upload → develop, by gravesisme, updated just now (not a planestro item: a person opened it)`);
    expect(packet).toMatch(/- #300 "Stops \(TP-1\)" — \S+ → trunk, updated 3 d ago \(item TP-1\)/);
    expect(packet).toContain('a fix already in flight');
  });

  it('ask_user_decision stores one structured decision, recommended first; your answer wakes the orchestrator to carry it out', async () => {
    const replies: string[] = [];
    const a = agents({ firstTurn: blocksOnce, orchestrate: async (w) => {
      if (w.label.startsWith('blocked_')) {
        const t = w.tools('ask_user_decision');
        replies.push(await t.handler({ item: 'TP-1', question: 'Raise the budget?', why: 'It spent its cap.', options: [{ label: 'Stop', description: 'Leave it' }, { label: 'Raise', description: 'Give it $10 more' }] }));
        replies.push(await t.handler({ item: 'TP-1', question: 'Raise the budget\nfor this?', why: 'x', options: [{ label: 'A', description: '', recommended: true }, { label: 'B', description: '' }] }));
        replies.push(await t.handler({ item: 'TP-1', question: 'Which base should this item build on?', why: 'It was created without its epic, so it started from the wrong branch.', options: [{ label: 'Stop here', description: 'Close it; I will redo it' }, { label: 'Use the epic', description: 'Recreate it on the epic branch', recommended: true }] }));
      }
      if (w.label === 'decision_answered') {
        expect(w.prompt).toContain('Decision answered');
        expect(w.prompt).toContain('question: Which base should this item build on?');
        expect(w.prompt).toContain('answer: Use the epic — and keep the name');
        expect(needs(store!, 'TP-1')).toBe(false);
        await w.tools('unblock_item').handler({ id: 'TP-1', message: 'The user chose the epic branch.' });
      }
    } });
    const { store: s, engine: e, id } = await setup(a.claude);
    await e.start();
    await waitFor(() => Boolean((fmOf(s, id).awaiting_data as any)?.decision));
    expect(replies[0]).toContain('mark exactly one option recommended');
    expect(replies[1]).toContain('the question must be one line');
    expect(replies[2]).toContain('recorded');
    const fm = fmOf(s, id);
    const decision = (fm.awaiting_data as any).decision;
    expect(decision).toMatchObject({ question: 'Which base should this item build on?', why: 'It was created without its epic, so it started from the wrong branch.', allow_free_text: true, reason: 'agent_blocked' });
    expect(decision.options.map((o: { label: string }) => o.label)).toEqual(['Use the epic', 'Stop here']);
    expect(fm.triage).toBeUndefined();
    expect(fm.awaiting).toBe('user');
    expect(needs(s, id)).toBe(true);
    expect(s.journal.read({ type: 'orchestrator.decision_requested' })).toHaveLength(1);

    const app = apiRoutes(s, e);
    const post = (body: unknown) => app.request(`/items/${id}/decision`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    expect((await post({ choice: 'Maybe' })).status).toBe(400);
    expect((await post({ choice: 'Use the epic', text: 'and keep the name' })).status).toBe(200);
    await waitFor(() => fmOf(s, id).status === 'PLAN_READY');
    expect(a.wakes.map((w) => w.label)).toContain('decision_answered');
    expect(activityOf(s, id)).toContain('decided: Which base should this item build on? → Use the epic — and keep the name');
    expect(a.prompts[1]).toContain('The user chose the epic branch.');
  });

  it('a triage that outlives orchestrator.triage_timeout_min comes to you as it is', async () => {
    let release!: () => void;
    const hung = new Promise<void>((r) => { release = r; });
    const a = agents({ firstTurn: blocksOnce, orchestrate: async (w) => { if (w.label.startsWith('blocked_')) await hung; } });
    const { store: s, engine: e, id } = await setup(a.claude, (y) => y.replace('rotate_after_wakes: 40', 'rotate_after_wakes: 40\n  triage_timeout_min: 0.005'));
    await e.start();
    await waitFor(() => Boolean(fmOf(s, id).blocked));
    await waitFor(() => !fmOf(s, id).triage);
    expect(needs(s, id)).toBe(true);
    expect(activityOf(s, id)).toContain('needs you: triage took longer than 0.005 min');
    release();
  });

  it('without an orchestrator, or with triage off, a block needs you at once', async () => {
    const a = agents({ firstTurn: blocksOnce, noOrchestrator: true });
    const c = await setup(a.claude);
    await c.engine.start();
    await waitFor(() => Boolean(fmOf(c.store, c.id).blocked));
    expect(fmOf(c.store, c.id).triage).toBeUndefined();
    expect(needs(c.store, c.id)).toBe(true);
    await c.engine.stop(); c.store.close();

    const b = agents({ firstTurn: blocksOnce, orchestrate: async () => {} });
    const d = await setup(b.claude, (y) => y.replace('rotate_after_wakes: 40', 'rotate_after_wakes: 40\n  triage: false'));
    await d.engine.start();
    await waitFor(() => Boolean(fmOf(d.store, d.id).blocked));
    expect(fmOf(d.store, d.id).triage).toBeUndefined();
    expect(needs(d.store, d.id)).toBe(true);
  });

  it('pausing automation hands a triaging item back to you', async () => {
    let release!: () => void;
    const hung = new Promise<void>((r) => { release = r; });
    const a = agents({ firstTurn: blocksOnce, orchestrate: async (w) => { if (w.label.startsWith('blocked_')) await hung; } });
    const { store: s, engine: e, id } = await setup(a.claude);
    await e.start();
    await waitFor(() => Boolean(fmOf(s, id).triage));
    e.pause();
    await e.tick();
    expect(fmOf(s, id).triage).toBeUndefined();
    expect(activityOf(s, id)).toContain('needs you: automation is paused');
    release();
  });
});
