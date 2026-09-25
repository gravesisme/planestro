import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DataStore } from '../src/store/DataStore.ts';
import { LiveEngine } from '../src/engine/LiveEngine.ts';
import { apiRoutes } from '../src/routes/api.ts';
import { FakeWorld, DryRunGitPort, DryRunGhPort, DryRunProcPort, DryRunClaudePort } from '../src/engine/dryrun-ports.ts';
import type { Ports, TurnOptions, TurnResult, CustomTurnOptions } from '../src/engine/ports.ts';
import { makeFixture, sleep } from './helpers.ts';

/**
 * Take-over (dogfood p28): while the designer finished HH-136 by hand, a worker turn they had started
 * kept running in the same worktree, a permission allow queued a fix turn, and the worker blocked the
 * item (by then in review with its PR) on the person's half-made edits.
 */
let store: DataStore | undefined; let engine: LiveEngine | undefined;
afterEach(async () => { await engine?.stop(); store?.close(); store = undefined; engine = undefined; });

type Tool = (name: string) => { handler(a: Record<string, unknown>): Promise<string> };
const killed: TurnResult = { sessionId: 's-hang', subtype: 'killed', isError: false, costUsd: 0, numTurns: 1, text: '' };

/**
 * Plans like the dry run; an implement turn with `hang` set asks for a permission (it parks), then
 * runs until it is aborted, the way a live turn does. Every turn and wake is recorded.
 */
function agents(world: FakeWorld, opts: { hang?: boolean; orchestrate?: (prompt: string, tool: Tool) => Promise<void> } = {}) {
  const inner = new DryRunClaudePort(world);
  const turns: { phase: string; prompt: string }[] = []; const wakes: string[] = [];
  const claude: Ports['agents']['claude'] = {
    async runTurn(o: TurnOptions): Promise<TurnResult> {
      turns.push({ phase: o.phase, prompt: o.prompt });
      if (o.phase !== 'implement' || !opts.hang) return inner.runTurn(o);
      await o.onPermission({ tool: 'Bash', input: { command: 'npm run build' } });
      await new Promise<void>((done) => { if (o.signal?.aborted) done(); else o.signal?.addEventListener('abort', () => done(), { once: true }); });
      return killed;
    },
    ...(opts.orchestrate ? { async runCustomTurn(o: CustomTurnOptions): Promise<TurnResult> {
      wakes.push(o.prompt);
      await opts.orchestrate!(o.prompt, (n) => o.mcpTools.find((t) => t.name === n)!);
      return { sessionId: 'orch', subtype: 'success', isError: false, costUsd: 0, numTurns: 1, text: '' };
    } } : {}),
  };
  return { claude, turns, wakes };
}

async function setup(opts: { hang?: boolean; orchestrate?: (prompt: string, tool: Tool) => Promise<void> } = {}) {
  const { dataDir, codeRepo } = makeFixture();
  mkdirSync(join(codeRepo, '.git', 'info'), { recursive: true });
  const cfg = join(dataDir, 'planestro.yml');
  writeFileSync(cfg, readFileSync(cfg, 'utf8').replace(/^code_repo:\n/m, 'code_repo:\n  github: acme/repo\n'));
  delete process.env.PLANESTRO_DRYRUN_CI;
  store = await DataStore.open(dataDir);
  const world = new FakeWorld(() => {}, { 'origin/trunk': 'f'.repeat(40) });
  const a = agents(world, opts);
  const ports: Ports = { mode: 'dry-run', git: new DryRunGitPort(world), gh: new DryRunGhPort(world), proc: new DryRunProcPort(world), agents: { claude: a.claude } };
  engine = new LiveEngine(store, ports, () => {}, { sleep: async () => {}, tickMs: 50 });
  return { store, engine, world, ...a };
}

async function waitFor(pred: () => boolean, ms = 6000) { const t0 = Date.now(); while (!pred()) { if (Date.now() - t0 > ms) throw new Error('timeout waiting'); await sleep(20); } }
const fmOf = (s: DataStore, id: string) => s.getItem(id)!.file.frontmatter;
const activityOf = (s: DataStore, id: string) => s.getItem(id)!.file.sections.find((x) => x.title === 'Activity')!.body;
const post = (body: unknown = {}) => ({ method: 'POST' as const, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

/** An item whose implement turn is live, parked on a permission the user has just allowed: the allow's turn is queued behind it. */
async function liveTurnWithQueuedFollowUps(s: DataStore, e: LiveEngine) {
  const item = s.createItem({ title: 'Finish by hand', description: 'x' });
  s.transition(item.id, 'QUEUED', 'user');
  await e.start();
  await waitFor(() => fmOf(s, item.id).status === 'PLAN_READY');
  await e.approvePlan(item.id);
  await waitFor(() => fmOf(s, item.id).awaiting === 'permission');
  await e.respond(item.id, { kind: 'permission', decision: 'allow' });   // the allow's turn waits for the live one to end
  await e.message(item.id, 'also update the changelog');                 // a message queued for its next turn
  expect((e as any).followUps.has(item.id)).toBe(true);
  expect(fmOf(s, item.id).op_data?.pending_messages).toEqual(['also update the changelog']);
  expect(e.sessions()).toHaveLength(1);
  return item.id;
}

describe('take over (p28)', () => {
  it('stops the live turn and drops the turn and message queued behind it; the item is yours, not "needs you"', async () => {
    const { store, engine, turns } = await setup({ hang: true });
    const id = await liveTurnWithQueuedFollowUps(store, engine);
    const before = turns.length;
    await engine.takeOver(id, 'finishing the art pass myself');
    await waitFor(() => engine.sessions().length === 0);
    const fm = fmOf(store, id);
    expect(fm.taken_over?.note).toBe('finishing the art pass myself');
    expect(fm.op_data?.pending_messages).toEqual([]);
    expect(fm.op).toBeUndefined(); expect(fm.awaiting).toBeUndefined(); expect(fm.blocked).toBeUndefined();
    expect(store.derived(store.getItem(id)!).needs_you).toBe(false);
    const activity = activityOf(store, id);
    expect(activity).toContain('took this item over by hand: finishing the art pass myself; stopped its implement turn, the turn queued behind it, 1 queued message');
    expect(activity).toContain('turn stopped: you took this item over');
    await sleep(400);                                                      // ticks pass: nothing starts
    expect(turns.length).toBe(before);
    expect(fmOf(store, id).status).toBe('IN_PROGRESS');
    await expect(engine.message(id, 'hello?')).rejects.toThrow(/taken over/);
  });

  it('no turn, wake or fix turn while taken over: a red CI is read, not fixed or merged, and a block is only said; hand back re-enters the pipeline', async () => {
    const { store, engine, world, turns, wakes } = await setup({ orchestrate: async (_p, tool) => { await tool('done_with_wake').handler({ summary: 'x' }); } });
    const item = store.createItem({ title: 'In review by hand', description: 'x' });
    const branch = 'tp/1-in-review-by-hand', rel = '.claude/worktrees/tp-1-in-review-by-hand';
    const cwd = (engine as any).absWorktree(rel); const head = world.sha();
    world.worktrees.set(cwd, { path: cwd, head, branch }); world.remoteBranches.set(branch, head); world.commits.set(cwd, 1); world.behind.set(cwd, 0);
    world.prs.set(350, { number: 350, url: 'u', state: 'OPEN', headRefOid: head, headRefName: branch, baseRefName: 'trunk', polls: 0, failOnce: true });
    store.mutateItem(item.id, [{ set: { status: 'IN_REVIEW', branch, worktree: rel, pr: 350, ci_result: 'pending' } }], 'engine');
    await engine.takeOver(item.id);
    await engine.start();
    // Its CI is polled on the held cadence; let every tick poll it until the red, then leave the red standing.
    await waitFor(() => fmOf(store, item.id).ci_result === 'red' || ((engine as any).heldPolledAt.clear(), false));
    await sleep(300);
    expect(turns).toEqual([]);                                             // no fix turn
    expect(world.prs.get(350)!.state).toBe('OPEN');                        // not merged
    expect(activityOf(store, item.id)).toContain('CI is red for');
    (engine as any).block(item.id, 'turn_error', 'something failed');
    (engine as any).wakeOrchestrator('pr_opened', item.id);
    await sleep(200);
    expect(fmOf(store, item.id).blocked).toBeUndefined();
    expect(activityOf(store, item.id)).toContain('not blocked (turn_error), since you have this item');
    expect(wakes).toEqual([]);                                             // nothing woke the orchestrator
    await engine.handBack(item.id, 'fixed the test by hand');
    expect(fmOf(store, item.id).ci_result).toBe('pending');
    await waitFor(() => fmOf(store, item.id).status === 'FINISHED', 8000);
    expect(activityOf(store, item.id)).toContain('handed back to planestro: fixed the test by hand; it re-enters the merge pipeline');
  });

  it('hand back of work in progress runs the done check: committed clean work goes to a pull request; otherwise the session is resumed and told', async () => {
    const { store, engine, world, turns } = await setup();
    const item = store.createItem({ title: 'Committed by hand', description: 'x' });
    store.transition(item.id, 'QUEUED', 'user');
    await engine.start();
    await waitFor(() => fmOf(store, item.id).status === 'PLAN_READY');
    await engine.takeOver(item.id);
    expect(fmOf(store, item.id).awaiting).toBe('plan_approval');           // the plan still waits for approval…
    expect(store.derived(store.getItem(item.id)!).needs_you).toBe(false);  // …but from the person who already has the item
    await engine.approvePlan(item.id);                                     // the person approves and implements it themselves
    await sleep(300);
    expect(turns.map((t) => t.phase)).toEqual(['plan']);                   // no implement turn started for them
    expect(activityOf(store, item.id)).toContain('not starting its implement turn: you have this item');
    const cwd = (engine as any).absWorktree(fmOf(store, item.id).worktree!);
    world.commits.set(cwd, 2);
    await engine.handBack(item.id);
    await waitFor(() => fmOf(store, item.id).status === 'FINISHED', 8000);
    expect(fmOf(store, item.id).pr).toBe(100);
    expect(turns.map((t) => t.phase)).toEqual(['plan']);                   // the PR came from git, not from a session

    const other = store.createItem({ title: 'Half done by hand', description: 'x' });
    store.transition(other.id, 'QUEUED', 'user');
    await waitFor(() => fmOf(store, other.id).status === 'PLAN_READY');
    await engine.takeOver(other.id);
    await engine.approvePlan(other.id);
    await engine.handBack(other.id, 'the parser is done; do the tests');
    await waitFor(() => turns.length === 3);
    expect(turns[2].phase).toBe('implement');
    expect(turns[2].prompt).toContain('has now handed it back to you: the parser is done; do the tests');
    await waitFor(() => fmOf(store, other.id).status === 'FINISHED', 8000);
  });

  it('a manual move into review stops the live turn and cancels the follow-ups queued for it, then the pipeline takes the PR', async () => {
    const { store, engine, world, turns } = await setup({ hang: true });
    const id = await liveTurnWithQueuedFollowUps(store, engine);
    const fm = fmOf(store, id);
    const head = world.sha(); world.remoteBranches.set(fm.branch!, head);
    world.prs.set(305, { number: 305, url: 'u', state: 'OPEN', headRefOid: head, headRefName: fm.branch!, baseRefName: 'trunk', polls: 0, failOnce: false });
    store.mutateItem(id, [{ set: { pr: 305 } }], 'user');
    const before = turns.length;
    const r = await apiRoutes(store, engine).request(`/items/${id}/transition`, post({ to: 'IN_REVIEW' }));
    expect(r.status).toBe(200);
    await waitFor(() => engine.sessions().length === 0);
    expect((engine as any).followUps.has(id)).toBe(false);
    expect(fmOf(store, id).op_data?.pending_messages ?? []).toEqual([]);
    expect(activityOf(store, id)).toContain('moved into review by hand: stopped its implement turn, the turn queued behind it, 1 queued message');
    await waitFor(() => fmOf(store, id).status === 'FINISHED', 8000);
    expect(turns.length).toBe(before);                                     // neither the allow's turn nor the message's ever ran
    expect(fmOf(store, id).blocked).toBeUndefined();
  });

  it("the orchestrator's packet says so and its tools refuse the item; reading and annotating still work", async () => {
    const results: Record<string, string> = {}; let packet = '';
    const { store, engine } = await setup({ orchestrate: async (prompt, tool) => {
      packet = prompt;
      const id = /^Item: (\S+)/m.exec(prompt)![1];
      results.unblock = await tool('unblock_item').handler({ id, message: 'carry on' });
      results.message = await tool('message_session').handler({ id, text: 'x' });
      results.retry = await tool('retry_op').handler({ id });
      results.sync = await tool('sync_with_base').handler({ id });
      results.order = await tool('set_merge_order').handler({ ids: [id] });
      results.card = await tool('ask_user_decision').handler({ item: id, question: 'q', why: 'w', options: [{ label: 'a', description: 'a', recommended: true }, { label: 'b', description: 'b' }] });
      results.annotate = await tool('annotate_item').handler({ id, text: 'the user has this one' });
      results.list = await tool('list_items').handler({});
      await tool('done_with_wake').handler({ summary: 'left it alone' });
    } });
    const item = store.createItem({ title: 'Mine', description: 'x' });
    store.mutateItem(item.id, [{ set: { status: 'IN_PROGRESS', blocked: true, blocked_reason: 'agent_blocked', awaiting: 'user' } }], 'engine');
    await engine.takeOver(item.id);
    engine.orchestrator.wake({ type: 'user_message', item: item.id, data: { message: 'unblock it' } });
    await waitFor(() => 'list' in results);
    expect(packet).toContain('TAKEN OVER by the user');
    for (const k of ['unblock', 'message', 'retry', 'sync', 'order', 'card']) expect(results[k], k).toMatch(new RegExp(`^not permitted: the user has taken ${item.id} over`));
    expect(results.annotate).toBe('noted');
    expect(results.list).toContain('TAKEN_OVER');
    const fm = fmOf(store, item.id);
    expect(fm.blocked).toBeUndefined(); expect(fm.awaiting).toBeUndefined(); expect(fm.taken_over).toBeDefined();
  });

  it('the routes take over and hand back, and refuse what does not apply', async () => {
    const { store, engine } = await setup();
    const app = apiRoutes(store, engine);
    const item = store.createItem({ title: 'Routes', description: 'x' });
    expect((await app.request(`/items/${item.id}/take-over`, post())).status).toBe(400);  // not something planestro is driving
    store.transition(item.id, 'QUEUED', 'user');
    const r = await app.request(`/items/${item.id}/take-over`, post({ note: 'mine for now' }));
    expect(r.status).toBe(200);
    expect((await r.json()).frontmatter.taken_over.note).toBe('mine for now');
    expect((await app.request(`/items/${item.id}/take-over`, post())).status).toBe(400);  // already yours
    await engine.start(); await sleep(200);
    expect(fmOf(store, item.id).status).toBe('QUEUED');                    // not admitted while taken over
    const back = await app.request(`/items/${item.id}/hand-back`, post());
    expect(back.status).toBe(200);
    expect((await back.json()).frontmatter.taken_over).toBeUndefined();
    expect((await app.request(`/items/${item.id}/hand-back`, post())).status).toBe(400); // not taken over
    await waitFor(() => fmOf(store, item.id).status === 'PLAN_READY');     // admitted once handed back
  });

  it('leaving the board ends a take-over', async () => {
    const { store, engine } = await setup();
    const item = store.createItem({ title: 'Iced', description: 'x' });
    store.transition(item.id, 'QUEUED', 'user');
    await engine.takeOver(item.id);
    store.transition(item.id, 'ICEBOX', 'user');
    expect(fmOf(store, item.id).taken_over).toBeUndefined();
  });
});
