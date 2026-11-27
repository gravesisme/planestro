import { describe, it, expect, afterEach } from 'vitest';
import { createServer } from 'node:net';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { DataStore } from '../src/store/DataStore.ts';
import { LiveEngine } from '../src/engine/LiveEngine.ts';
import { apiRoutes } from '../src/routes/api.ts';
import { startServer } from '../src/server.ts';
import { FakeWorld, DryRunGitPort, DryRunGhPort, DryRunProcPort, DryRunClaudePort } from '../src/engine/dryrun-ports.ts';
import type { Ports, TurnOptions, TurnResult } from '../src/engine/ports.ts';
import { getSection, findTransition, allowedTransitions } from '@planestro/shared';
import { makeFixture, git, sleep } from './helpers.ts';

/**
 * Back to the backlog (#584, HH-947): two items were submitted too early and started planning within the second.
 * Nothing took them back: `move_item` refused, a hold only kept a pull request from merging, and the one way out was
 * a discard. The move to the backlog now takes work that has started and has no pull request yet.
 */
let store: DataStore | undefined; let engine: LiveEngine | undefined;
afterEach(async () => { await engine?.stop(); store?.close(); store = undefined; engine = undefined; });

type Tool = (n: string) => { handler(a: Record<string, unknown>): Promise<unknown> };
const ok: TurnResult = { sessionId: 's-1', subtype: 'success', isError: false, costUsd: 0, numTurns: 1, text: '' };
const PLAN = '# Plan\n\nCompare the three vendors, then wire the cheapest one in `shop.ts`.';

interface Opts { hang?: 'plan' | 'implement'; plan?: string; orchestrate?: (label: string, t: Tool) => Promise<void> }

/** The dry-run agents, with a turn that can be made to run until it is aborted (as a live one does) and every prompt recorded. */
function world(opts: Opts) {
  const w = new FakeWorld(() => {}, { 'origin/trunk': 'f'.repeat(40) });
  const inner = new DryRunClaudePort(w);
  const prompts: { item: string; phase: string; prompt: string; resume?: string }[] = []; const aborted: string[] = [];
  const claude: Ports['agents']['claude'] = {
    async runTurn(o: TurnOptions): Promise<TurnResult> {
      prompts.push({ item: o.itemId, phase: o.phase, prompt: o.prompt, resume: o.resume });
      if (o.phase === opts.hang) {
        await new Promise<void>((done) => { if (o.signal?.aborted) done(); else o.signal?.addEventListener('abort', () => done(), { once: true }); });
        aborted.push(o.itemId);
        return { ...ok, subtype: 'killed' };
      }
      if (o.phase === 'plan' && opts.plan && !/## Break this epic down/.test(o.prompt)) { await o.tools.submit_plan(opts.plan); return { ...ok, planSubmitted: opts.plan }; }
      return inner.runTurn(o);
    },
    async runCustomTurn(o) {
      if (!opts.orchestrate) return inner.runCustomTurn(o);
      await opts.orchestrate(o.label, (n) => o.mcpTools.find((t) => t.name === n)!);
      await o.mcpTools.find((t) => t.name === 'done_with_wake')!.handler({ summary: 'done' });
      return { ...ok, sessionId: 'orch' };
    },
  };
  const ports: Ports = { mode: 'dry-run', git: new DryRunGitPort(w), gh: new DryRunGhPort(w), proc: new DryRunProcPort(w), agents: { claude } };
  return { world: w, ports, prompts, aborted };
}

function fixture() {
  const { dataDir, codeRepo } = makeFixture();
  mkdirSync(join(codeRepo, '.git', 'info'), { recursive: true });
  const cfg = join(dataDir, 'planestro.yml');
  writeFileSync(cfg, readFileSync(cfg, 'utf8').replace(/^code_repo:\n/m, 'code_repo:\n  github: acme/repo\n'));
  delete process.env.PLANESTRO_DRYRUN_CI;
  return dataDir;
}

async function setup(opts: Opts = {}) {
  const dataDir = fixture();
  store = await DataStore.open(dataDir, { emit: () => {} });
  const w = world(opts);
  engine = new LiveEngine(store, w.ports, () => {}, { sleep: async () => {}, tickMs: 50 });
  return { store, engine, dataDir, app: apiRoutes(store, engine), ...w };
}

async function waitFor(pred: () => boolean, ms = 5000) { const t0 = Date.now(); while (!pred()) { if (Date.now() - t0 > ms) throw new Error('timeout waiting'); await sleep(20); } }
const fm = (id: string) => store!.requireItem(id).file.frontmatter;
const section = (id: string, name: string) => getSection(store!.requireItem(id).file, name);
const post = (body: unknown) => ({ method: 'POST' as const, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const live = (id: string) => engine!.sessions().some((s) => s.item === id);

describe('back to the backlog from started work (#584)', () => {
  it('an item planning: the board\'s move stops its turn and returns it, with the worktree, branch and conversation left in place', async () => {
    const { store, engine, world, aborted, prompts, app, dataDir } = await setup({ hang: 'plan' });
    const item = store.createItem({ title: 'Shop prices', description: 'Pick a vendor.' });
    store.transition(item.id, 'QUEUED', 'user');
    await engine.start();
    await waitFor(() => fm(item.id).status === 'PLAN_IN_PROGRESS' && live(item.id) && prompts.length === 1);
    // What a hold could not do (the report's own attempt): it is still planning.
    store.mutateItem(item.id, [{ set: { skip_merge: true, hold_reason: 'submitted too early, back to the backlog', hold_waits_on: 'person' } }], 'user');
    const { worktree, branch } = fm(item.id);
    expect((await (await app.request(`/items/${item.id}/transitions`)).json() as { to: string; label: string }[])).toContainEqual({ to: 'NOT_YET_SUBMITTED', label: 'back to backlog' });

    const r = await app.request(`/items/${item.id}/move`, post({ op: 'backlog' }));
    expect(r.status).toBe(200);
    expect(aborted).toEqual([item.id]);                                    // waited for: the item is not moved under a running session
    const f = fm(item.id);
    expect(f.status).toBe('NOT_YET_SUBMITTED');
    expect(f).toMatchObject({ worktree, branch });
    for (const k of ['skip_merge', 'hold_reason', 'hold_waits_on', 'op', 'op_data', 'awaiting', 'blocked', 'blocked_reason']) expect((f as any)[k], k).toBeUndefined();
    expect(world.worktrees.size).toBe(1);                                  // nothing was deleted (invariant 7)
    expect(world.localBranches.has(branch!)).toBe(true);
    const activity = section(item.id, 'Activity');
    expect(activity).toContain('going back to Not yet submitted: stopped its plan turn');
    expect(activity).toContain('turn stopped: you moved this item back to Not yet submitted');
    expect(activity).toContain('[user] moved back to Not yet submitted from PLAN IN PROGRESS');
    expect(activity).toMatch(new RegExp(`its worktree ${worktree} and branch ${branch} are kept as they are: nothing was deleted, and submitting the item again picks them up`));
    expect(activity).toContain('its hold is dropped (submitted too early, back to the backlog): an item that is not submitted has no pull request to hold');
    // Nothing drives it from here: it is not admitted again, blocked or stalled.
    await sleep(200);
    expect(fm(item.id).status).toBe('NOT_YET_SUBMITTED');
    expect(fm(item.id).blocked).toBeUndefined();
    expect(live(item.id)).toBe(false);
    expect(prompts.length).toBe(1);
    await store.git.idle();
    expect(git(dataDir, 'log', '--format=%s')).toContain(`${item.id}: back to the backlog`);

    // Submitted again, it picks up what it has.
    store.transition(item.id, 'QUEUED', 'user'); engine.poke();
    await waitFor(() => prompts.length === 2);
    expect(section(item.id, 'Activity')).toContain(`reusing the worktree this item already has (${worktree})`);
    expect(world.worktrees.size).toBe(1);
  });

  it('a plan waiting for approval: the plan moves to Notes, where the next planner reads it; a block and the approval wait are dropped', async () => {
    const { store, engine, prompts, app } = await setup({ plan: PLAN });
    const item = store.createItem({ title: 'Shop prices', description: 'Pick a vendor.', notes: 'Budget is 40 a month.' });
    store.transition(item.id, 'QUEUED', 'user');
    await engine.start();
    await waitFor(() => fm(item.id).status === 'PLAN_READY' && !live(item.id));
    expect(section(item.id, 'Plan')).toContain('Compare the three vendors');
    store.mutateItem(item.id, [{ set: { blocked: true, blocked_reason: 'orchestrator', plan_revisions: 1 } }], 'engine');

    // The page's button is the same operation, through the transition route.
    const r = await app.request(`/items/${item.id}/transition`, post({ to: 'NOT_YET_SUBMITTED' }));
    expect(r.status).toBe(200);
    const f = fm(item.id);
    expect(f.status).toBe('NOT_YET_SUBMITTED');
    for (const k of ['awaiting', 'blocked', 'blocked_reason', 'plan_revisions']) expect((f as any)[k], k).toBeUndefined();
    expect(section(item.id, 'Plan').trim()).toBe('');
    const notes = section(item.id, 'Notes');
    expect(notes).toMatch(/^Budget is 40 a month\.\n\n### Plan written before this went back to the backlog \(\d{4}-\d{2}-\d{2}\)\n\nIts planner wrote this before the item went back to Not yet submitted; it was not approved\. Start from it/);
    expect(notes).toContain('Compare the three vendors, then wire the cheapest one in `shop.ts`.');
    const activity = section(item.id, 'Activity');
    expect(activity).toMatch(/\[user\] moved back to Not yet submitted from PLAN READY; dropped its block \(orchestrator\), its plan's wait for approval/);
    expect(activity).toContain('the plan is kept in Notes, where its next planner reads it');
    expect(activity).toContain('its conversation is kept');

    // The same planning is not paid for twice: the next planner has the plan in front of it, in the conversation it had.
    const session = fm(item.id).session_id;
    expect(session).toBeTruthy();
    store.transition(item.id, 'QUEUED', 'user'); engine.poke();
    await waitFor(() => prompts.filter((p) => p.item === item.id).length === 2);
    const again = prompts.filter((p) => p.item === item.id).at(-1)!;
    expect(again.prompt).toContain('### Plan written before this went back to the backlog');
    expect(again.prompt).toContain('Compare the three vendors');
    expect(again.resume).toBe(session);
  });

  it('work in progress goes back while nothing of it is on the remote; pushed, or with a pull request, it is refused and names discard', async () => {
    const { store, engine, world, aborted, app } = await setup({ plan: PLAN, hang: 'implement' });
    const item = store.createItem({ title: 'Shop prices', description: 'Pick a vendor.' });
    store.transition(item.id, 'QUEUED', 'user');
    await engine.start();
    await waitFor(() => fm(item.id).status === 'PLAN_READY' && !live(item.id));
    await engine.approvePlan(item.id);
    await waitFor(() => fm(item.id).status === 'IN_PROGRESS' && live(item.id));
    const branch = fm(item.id).branch!;

    // Pushed: an undo no longer covers it. Refused before anything is changed, the turn still running.
    world.remoteBranches.set(branch, 'a'.repeat(40));
    const pushed = await app.request(`/items/${item.id}/move`, post({ op: 'backlog' }));
    expect(pushed.status).not.toBe(200);
    expect(((await pushed.json()) as { error: string }).error).toMatch(/branch .* is on the remote \(tip aaaaaaa\): its work was pushed.*discard_item/);
    expect(fm(item.id).status).toBe('IN_PROGRESS');
    expect(aborted).toEqual([]);
    expect(live(item.id)).toBe(true);

    // With a pull request: the same, and the page does not offer it.
    world.remoteBranches.delete(branch);
    store.mutateItem(item.id, [{ set: { pr: 41 } }], 'engine');
    await expect(engine.returnToBacklog(item.id)).rejects.toThrow(/has pull request #41, so it is past the point where a submit is undone\. Dropping it is a discard \(Discard on its page, discard_item\)/);
    expect((await (await app.request(`/items/${item.id}/transitions`)).json() as { to: string }[]).map((t) => t.to)).not.toContain('NOT_YET_SUBMITTED');
    expect(aborted).toEqual([]);

    // Nothing pushed, no pull request: it goes back, its approved plan with it.
    store.mutateItem(item.id, [{ unset: ['pr'] }], 'engine');
    const said = await engine.returnToBacklog(item.id);
    expect(said).toMatch(new RegExp(`^${item.id} is back in Not yet submitted; stopped its implement turn`));
    expect(aborted).toEqual([item.id]);
    expect(fm(item.id).status).toBe('NOT_YET_SUBMITTED');
    expect(fm(item.id).plan_approved_at).toBeUndefined();
    expect(section(item.id, 'Notes')).toContain('it had been approved, and implementation had started in the worktree');
    expect(world.localBranches.has(branch)).toBe(true);
    expect(world.remoteBranches.has(branch)).toBe(false);
  });

  it('refuses in words past that point: in review, finished, already there, an epic that is open, a step running', async () => {
    const { store, engine } = await setup();
    const review = store.createItem({ title: 'In review', description: 'x' });
    store.mutateItem(review.id, [{ set: { status: 'IN_REVIEW', pr: 7, branch: 'tp/review' } }], 'engine');
    expect(engine.returnToBacklogRefusal(review.id)).toMatch(/has pull request #7.*Dropping it is a discard/);
    const done = store.createItem({ title: 'Done', description: 'x' });
    store.mutateItem(done.id, [{ set: { status: 'FINISHED' } }], 'engine');
    expect(engine.returnToBacklogRefusal(done.id)).toMatch(/is FINISHED: its work has landed/);
    const idle = store.createItem({ title: 'Idle', description: 'x' });
    expect(engine.returnToBacklogRefusal(idle.id)).toBe(`${idle.id} is already Not yet submitted`);
    const epic = store.createItem({ title: 'Surface', description: 'x', kind: 'epic' } as any);
    store.mutateItem(epic.id, [{ set: { status: 'IN_PROGRESS', branch: 'feature/surface' } }], 'engine');
    expect(engine.returnToBacklogRefusal(epic.id)).toMatch(/is an epic whose breakdown was approved: its children and its integration branch feature\/surface exist\. Send its children back, or discard them/);
    const iced = store.createItem({ title: 'Iced', description: 'x' });
    store.transition(iced.id, 'ICEBOX', 'user');
    expect(engine.returnToBacklogRefusal(iced.id)).toBeNull();                 // the user's move, as before
    expect(engine.returnToBacklogRefusal(iced.id, 'orchestrator')).toMatch(/is in the Icebox: bringing it back from there is the user's move/);
    for (const id of [review.id, done.id, idle.id, epic.id]) await expect(engine.returnToBacklog(id)).rejects.toThrow();
    expect(fm(review.id).status).toBe('IN_REVIEW');
    expect(fm(epic.id).status).toBe('IN_PROGRESS');
    // An engine step (a worktree being made, a pull request being opened) is not cut short.
    const busy = store.createItem({ title: 'Busy', description: 'x' });
    store.mutateItem(busy.id, [{ set: { status: 'IN_PROGRESS', op: 'creating_pr' } }], 'engine');
    (engine as any).jobs.set(busy.id, new Promise<void>(() => {}));
    expect(engine.returnToBacklogRefusal(busy.id)).toMatch(/has a step running \(creating pr\); move it back when that ends/);
    (engine as any).jobs.delete(busy.id);
  });

  it('the transition exists for the user and the orchestrator, never as a bare store move from the routes', () => {
    for (const from of ['QUEUED', 'PLAN_IN_PROGRESS', 'PLAN_READY', 'IN_PROGRESS'] as const) for (const by of ['user', 'orchestrator'] as const) expect(findTransition(from, 'NOT_YET_SUBMITTED', by, 'worker'), `${from} ${by}`).toBeTruthy();
    expect(findTransition('PLAN_READY', 'NOT_YET_SUBMITTED', 'user', 'epic')).toBeTruthy();
    expect(findTransition('IN_PROGRESS', 'NOT_YET_SUBMITTED', 'user', 'epic')).toBeUndefined();
    expect(findTransition('IN_PROGRESS', 'NOT_YET_SUBMITTED', 'user', 'external')).toBeUndefined();
    expect(allowedTransitions('IN_REVIEW', 'user', 'worker').map((t) => t.to)).not.toContain('NOT_YET_SUBMITTED');
    expect(findTransition('ICEBOX', 'NOT_YET_SUBMITTED', 'orchestrator', 'worker')).toBeUndefined();
  });
});

describe('epics and their children (#584)', () => {
  it('an epic goes back while its breakdown waits: the proposed children are kept in Notes and its planning checkout is left', async () => {
    const { store, engine, world, prompts } = await setup();
    const epic = store.createItem({ title: 'Surface', description: 'Art and code.', kind: 'epic' } as any);
    await engine.start();
    await engine.planEpic(epic.id);
    await waitFor(() => fm(epic.id).awaiting === 'breakdown_approval' && !live(epic.id));
    const proposed = (fm(epic.id).awaiting_data!.children as { title: string }[]).map((c) => c.title);
    expect(proposed.length).toBeGreaterThan(1);
    const said = await engine.returnToBacklog(epic.id);
    expect(said).toContain(`${epic.id} is back in Not yet submitted`);
    expect(fm(epic.id)).toMatchObject({ status: 'NOT_YET_SUBMITTED', kind: 'epic' });
    expect(fm(epic.id).awaiting_data).toBeUndefined();
    const notes = section(epic.id, 'Notes');
    expect(notes).toMatch(/### Breakdown proposed before this went back to the backlog/);
    for (const t of proposed) expect(notes).toContain(`**${t}**`);
    expect(store.derived(store.requireItem(epic.id)).children).toEqual([]);   // nothing was created from it
    expect(world.worktrees.size).toBe(1);
    // Planned again, its planner starts from the breakdown it already made.
    await engine.planEpic(epic.id);
    await waitFor(() => prompts.filter((p) => p.item === epic.id).length === 2);
    expect(prompts.at(-1)!.prompt).toContain('### Breakdown proposed before this went back to the backlog');
    expect(world.worktrees.size).toBe(1);
  });

  it('a child goes back and stays its epic\'s child: the epic waits on it and says so', async () => {
    const { store, engine, world } = await setup({ hang: 'plan' });
    const epic = store.createItem({ title: 'Surface', description: 'x', kind: 'epic' } as any);
    world.remoteBranches.set('feature/surface', world.sha());
    store.mutateItem(epic.id, [{ set: { status: 'IN_PROGRESS', branch: 'feature/surface' } }], 'engine');
    const child = store.createItem({ title: 'Siren art', description: 'x', parent: epic.id });
    store.transition(child.id, 'QUEUED', 'user');
    await engine.start();
    await waitFor(() => fm(child.id).status === 'PLAN_IN_PROGRESS' && live(child.id));
    await engine.returnToBacklog(child.id, { why: 'not ready' });
    expect(fm(child.id)).toMatchObject({ status: 'NOT_YET_SUBMITTED', parent: epic.id });
    expect(section(child.id, 'Activity')).toContain(`it is still a child of epic ${epic.id}, which waits on it`);
    expect(section(epic.id, 'Activity')).toContain(`${child.id} went back to Not yet submitted: not ready. It is still one of this epic's children, and the epic waits on it.`);
    await sleep(200);
    expect(fm(epic.id).status).toBe('IN_PROGRESS');
    expect(fm(child.id).status).toBe('NOT_YET_SUBMITTED');
  });
});

describe('the orchestrator\'s return_to_backlog (#584)', () => {
  it('undoes a submit on a planning item and a queued one, refuses one with a pull request and one the user took over, and starts nothing', async () => {
    const results: Record<string, unknown> = {};
    const { store, engine, aborted, prompts } = await setup({ hang: 'plan', orchestrate: async (label, t) => {
      if (!label.includes('user_message')) return;
      results.planning = await t('return_to_backlog').handler({ id: 'TP-1', reason: 'submitted too early' });
      results.review = await t('return_to_backlog').handler({ id: 'TP-2', reason: 'x' });
      results.yours = await t('return_to_backlog').handler({ id: 'TP-3', reason: 'x' });
      results.queued = await t('return_to_backlog').handler({ id: 'TP-4', reason: 'the user asked' });
      await t('reply_to_user').handler({ text: 'done' });
    } });
    const planning = store.createItem({ title: 'Shop prices', description: 'x' });
    const review = store.createItem({ title: 'In review', description: 'x' });
    store.mutateItem(review.id, [{ set: { status: 'IN_REVIEW', pr: 7, branch: 'tp/review', taken_over: undefined } }], 'engine');
    const yours = store.createItem({ title: 'Yours', description: 'x' });
    store.mutateItem(yours.id, [{ set: { status: 'PLAN_READY', taken_over: { since: '2026-11-27T10:00:00-05:00' } } }], 'engine');
    const queued = store.createItem({ title: 'Queued', description: 'x', depends_on: [review.id] });
    store.mutateItem(queued.id, [{ set: { status: 'QUEUED' } }], 'engine');   // waits on a dependency: it stays queued
    store.transition(planning.id, 'QUEUED', 'user');
    await engine.start();
    await waitFor(() => fm(planning.id).status === 'PLAN_IN_PROGRESS' && live(planning.id));
    engine.orchestrator.wake({ type: 'user_message', data: { message: 'TP-1 and TP-4 were submitted too early: back to the backlog' } });
    await waitFor(() => results.queued !== undefined);
    expect(results.planning).toMatch(/^TP-1 is back in Not yet submitted; stopped its plan turn/);
    expect(aborted).toEqual([planning.id]);
    expect(fm(planning.id).status).toBe('NOT_YET_SUBMITTED');
    expect(section(planning.id, 'Activity')).toContain('[orchestrator] moved back to Not yet submitted from PLAN IN PROGRESS: submitted too early');
    expect(section(planning.id, 'Activity')).toContain('turn stopped: the orchestrator moved this item back to Not yet submitted');
    expect(results.review).toMatch(/^refused: TP-2 has pull request #7.*Dropping it is a discard.*Nothing was changed\.$/);
    expect(fm(review.id).status).toBe('IN_REVIEW');
    expect(String(results.yours)).toMatch(/taken over|by hand/);
    expect(fm(yours.id).status).toBe('PLAN_READY');
    expect(results.queued).toBe('TP-4 is back in Not yet submitted');
    expect(fm(queued.id).status).toBe('NOT_YET_SUBMITTED');
    await sleep(200);
    expect(prompts.filter((p) => p.phase !== 'orchestrator').length).toBe(1);   // it started nothing (#73)
    expect(fm(planning.id).status).toBe('NOT_YET_SUBMITTED');
  });
});

describe('the operator MCP\'s move_item (#584)', () => {
  const freePort = () => new Promise<number>((done) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = (s.address() as { port: number }).port; s.close(() => done(p)); }); });
  const text = (r: any) => JSON.parse(r.content[0].text);

  it('to: backlog takes a planning item back, as [operator]; one with a pull request is refused, naming discard_item', async () => {
    const dataDir = fixture();
    const w = world({ hang: 'plan' });
    const port = await freePort();
    const srv = await startServer({ dataDir, port, log: () => {}, engineFactory: (s, em) => new LiveEngine(s, w.ports, em, { sleep: async () => {}, tickMs: 50 }) });
    const client = new Client({ name: 'test', version: '1' });
    const f = (id: string) => srv.store.requireItem(id).file.frontmatter;
    try {
      srv.store.updateConfig((d) => { d.setIn(['operator_mcp', 'allow_writes'], true); d.setIn(['operator_mcp', 'allow_submit'], true); });
      await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
      const made = text(await client.callTool({ name: 'create_item', arguments: { title: 'Clip editor' } }));
      // A free slot: it is planning before anyone can take the submit back, here before the submit's own answer.
      expect(text(await client.callTool({ name: 'submit_item', arguments: { id: made.id } })).said).toBe(`${made.id} is queued for planning`);
      await waitFor(() => f(made.id).status === 'PLAN_IN_PROGRESS' && srv.engine.sessions().some((s) => s.item === made.id));
      const back = text(await client.callTool({ name: 'move_item', arguments: { id: made.id, to: 'backlog' } }));
      expect(back.item.status).toBe('NOT_YET_SUBMITTED');
      expect(back.said).toMatch(new RegExp(`^${made.id} is back in Not yet submitted; stopped its plan turn; its worktree .* kept as they are: nothing was deleted`));
      expect(w.aborted).toEqual([made.id]);
      expect(w.world.worktrees.size).toBe(1);
      const activity = srv.store.requireItem(made.id).file.sections.find((s) => s.title === 'Activity')!.body;
      expect(activity).toContain('[operator] moved back to Not yet submitted from PLAN IN PROGRESS: through the operator MCP');
      expect(activity).not.toMatch(/\[user\]/);
      expect(srv.store.journal.read({ type: 'operator_mcp.action' }).map((e) => [e.data?.tool, e.data?.to])).toContainEqual(['move_item', 'backlog']);

      // Past the point an undo covers: refused in words, the item as it was.
      const pr = srv.store.createItem({ title: 'Renderer' });
      srv.store.mutateItem(pr.id, [{ set: { status: 'IN_REVIEW', pr: 12, branch: 'tp/renderer' } }], 'engine');
      const refused = await client.callTool({ name: 'move_item', arguments: { id: pr.id, to: 'backlog' } });
      expect(refused.isError).toBe(true);
      expect(text(refused).error).toMatch(/has pull request #12, so it is past the point where a submit is undone\..*discard_item/);
      expect(f(pr.id).status).toBe('IN_REVIEW');
    } finally { await client.close(); await srv.engine.stop(); srv.server.close(); srv.store.close(); }
  });
});
