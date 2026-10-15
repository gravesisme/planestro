import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DataStore } from '../src/store/DataStore.ts';
import { LiveEngine } from '../src/engine/LiveEngine.ts';
import { apiRoutes } from '../src/routes/api.ts';
import { FakeWorld, DryRunGitPort, DryRunGhPort, DryRunProcPort, DryRunClaudePort } from '../src/engine/dryrun-ports.ts';
import type { Ports, TurnOptions, TurnResult } from '../src/engine/ports.ts';
import { getSection } from '@planestro/shared';
import { makeFixture, git, sleep } from './helpers.ts';

/**
 * Item or epic (#69, HH-198): HH-198 and HH-199 were approved as items though their plans were whole
 * epic breakdowns, and each went to one implementer. The kind is a choice made in the open, a plan
 * that reads as a breakdown is never approved as one item, and an item converts to an epic (or back)
 * while nothing has run for implementation.
 */
let store: DataStore | undefined; let engine: LiveEngine | undefined;
afterEach(async () => { await engine?.stop(); store?.close(); store = undefined; engine = undefined; });

type Tool = (n: string) => { handler(a: Record<string, unknown>): Promise<unknown> };
const ok: TurnResult = { sessionId: 's', subtype: 'success', isError: false, costUsd: 0, numTurns: 1, text: '' };
const BREAKDOWN_PLAN = '# Plan\n\nThree pieces.\n\n| # | Child | Implementer |\n|---|---|---|\n| 0 | Wand icon | codex-art |\n| 1 | Header art | codex-art |\n| 2 | Wand logic | fable-5 |\n';

/** The dry-run agents, with a planner that can be told what to hand in and every prompt recorded; `orchestrate` scripts plan-review and chat wakes. */
async function setup(opts: { plan?: (o: TurnOptions) => Promise<TurnResult | undefined>; orchestrate?: (label: string, t: Tool, prompt: string) => Promise<void>; delegate?: boolean } = {}) {
  const { dataDir, codeRepo } = makeFixture();
  mkdirSync(join(codeRepo, '.git', 'info'), { recursive: true });
  const cfg = join(dataDir, 'planestro.yml');
  let yml = readFileSync(cfg, 'utf8').replace(/^code_repo:\n/m, 'code_repo:\n  github: acme/repo\n');
  if (opts.delegate) yml = yml.replace('may_approve_plans: false', 'may_approve_plans: true');
  writeFileSync(cfg, yml);
  delete process.env.PLANESTRO_DRYRUN_CI;
  store = await DataStore.open(dataDir, { emit: () => {} });
  const world = new FakeWorld(() => {}, { 'origin/trunk': 'f'.repeat(40) });
  const inner = new DryRunClaudePort(world);
  const prompts: { item: string; prompt: string }[] = []; const wakes: string[] = [];
  const claude: Ports['agents']['claude'] = {
    async runTurn(o: TurnOptions): Promise<TurnResult> {
      prompts.push({ item: o.itemId, prompt: o.prompt });
      if (o.phase === 'plan' && opts.plan && !/## Break this epic down/.test(o.prompt)) { const r = await opts.plan(o); if (r) return r; }
      return inner.runTurn(o);
    },
    async runCustomTurn(o) {
      wakes.push(o.prompt);
      if (!opts.orchestrate) return inner.runCustomTurn(o);
      await opts.orchestrate(o.label, (n) => o.mcpTools.find((t) => t.name === n)!, o.prompt);
      await o.mcpTools.find((t) => t.name === 'done_with_wake')!.handler({ summary: 'done' });
      return { ...ok, sessionId: 'orch' };
    },
  };
  const ports: Ports = { mode: 'dry-run', git: new DryRunGitPort(world), gh: new DryRunGhPort(world), proc: new DryRunProcPort(world), agents: { claude } };
  engine = new LiveEngine(store, ports, () => {}, { sleep: async () => {}, tickMs: 50 });
  return { store, engine, world, prompts, wakes, dataDir, app: apiRoutes(store, engine) };
}

async function waitFor(pred: () => boolean, ms = 4000) { const t0 = Date.now(); while (!pred()) { if (Date.now() - t0 > ms) throw new Error('timeout waiting'); await sleep(20); } }
const fmOf = (s: DataStore, id: string) => s.getItem(id)!.file.frontmatter;
const section = (s: DataStore, id: string, name: string) => getSection(s.getItem(id)!.file, name);
const post = (body: unknown) => ({ method: 'POST' as const, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
/** A planner that hands in `plan` with submit_plan. */
const plans = (plan: string) => async (o: TurnOptions) => { await o.tools.submit_plan(plan); return { ...ok, planSubmitted: plan }; };

describe('a plan that reads as an epic is never approved as one item (#69)', () => {
  it('a plan with a table of children is flagged, and approval is refused for the user and the orchestrator alike', async () => {
    const { store, engine, app } = await setup({ plan: plans(BREAKDOWN_PLAN) });
    const item = store.createItem({ title: 'Frost wand', description: 'Add a Frost Wand: icon, header art and the weapon.' });
    store.transition(item.id, 'QUEUED', 'user');
    await engine.start();
    await waitFor(() => fmOf(store, item.id).status === 'PLAN_READY');
    expect(fmOf(store, item.id).op_data?.looks_like_epic).toMatchObject({ source: 'plan', reason: 'its plan has a table of 3 child items' });
    expect(section(store, item.id, 'Activity')).toContain('this reads as an epic, not one item: its plan has a table of 3 child items');
    await expect(engine.approvePlan(item.id)).rejects.toThrow(`${item.id} is not approved: its plan has a table of 3 child items, so it is an epic, not one item. Convert it to an epic`);
    await expect(engine.approvePlan(item.id, undefined, 'orchestrator')).rejects.toThrow(/Convert it to an epic .*or leave it to the user/);
    // The orchestrator may not use the user's deliberate override.
    await expect(engine.approvePlan(item.id, undefined, 'orchestrator', { asItem: true })).rejects.toThrow(/not approved/);
    const r = await app.request(`/items/${item.id}/plan/approve`, post({}));
    expect(r.status).toBe(400);
    expect(fmOf(store, item.id).status).toBe('PLAN_READY');
    // The user can still overrule the check on purpose, and the Activity log says so.
    const ok2 = await app.request(`/items/${item.id}/plan/approve`, post({ as_item: true }));
    expect(ok2.status).toBe(200);
    expect(fmOf(store, item.id).status).not.toBe('PLAN_READY');
    expect(section(store, item.id, 'Activity')).toContain('approved as one item although its plan has a table of 3 child items');
    expect(fmOf(store, item.id).op_data?.looks_like_epic).toBeUndefined();
  });

  it('a revised plan without the breakdown clears the flag; an ordinary plan is never flagged', async () => {
    let n = 0;
    const { store, engine } = await setup({ plan: async (o) => { const plan = n++ === 0 ? BREAKDOWN_PLAN : '# Plan\n\n1. Add the flag.\n2. Test it.\n\n## Steps\n- a\n- b\n'; await o.tools.submit_plan(plan); return { ...ok, planSubmitted: plan }; } });
    const item = store.createItem({ title: 'Wand', description: 'x' });
    store.transition(item.id, 'QUEUED', 'user');
    await engine.start();
    await waitFor(() => fmOf(store, item.id).status === 'PLAN_READY');
    expect(fmOf(store, item.id).op_data?.looks_like_epic).toBeDefined();
    await engine.rejectPlan(item.id, 'it is one change: plan it as one');
    await waitFor(() => fmOf(store, item.id).status === 'PLAN_READY' && n === 2);
    expect(fmOf(store, item.id).op_data?.looks_like_epic).toBeUndefined();
    await engine.approvePlan(item.id);
    expect(fmOf(store, item.id).status).toBe('IN_PROGRESS');
  });

  it('a plain item\'s planner is told how to hand in an epic; submit_breakdown on it is recorded as a flagged plan, never as children', async () => {
    const replies: string[] = [];
    const children = [{ title: 'Wand icon', description: 'Draw the 256px wand icon at assets/wand.png.', implementer: 'codex-art' }, { title: 'Wand logic', description: 'Implement the wand; it uses assets/wand.png.', implementer: 'fable-5', depends_on: [0] }];
    const { store, engine, prompts } = await setup({ plan: async (o) => {
      if (!o.prompt.includes('If this is really an epic')) { replies.push(await o.tools.submit_breakdown('# Plan', children)); await o.tools.submit_plan('# Plan\n\nOne piece.'); return { ...ok, planSubmitted: '# Plan\n\nOne piece.' }; }
      replies.push(await o.tools.submit_breakdown('# Plan\n\nTwo pieces.', [{ title: 'only one' }]));
      replies.push(await o.tools.submit_breakdown('# Plan\n\nTwo pieces.', children));
      return { ...ok, planSubmitted: '# Plan\n\nTwo pieces.' };
    } });
    const epic = store.createItem({ title: 'Existing epic', description: 'x', kind: 'epic' });
    const item = store.createItem({ title: 'Frost wand', description: 'x' });
    store.transition(item.id, 'QUEUED', 'user');
    await engine.start();
    await waitFor(() => fmOf(store, item.id).status === 'PLAN_READY');
    expect(prompts.find((p) => p.item === item.id)!.prompt).toContain('## If this is really an epic');
    expect(prompts.find((p) => p.item === item.id)!.prompt).toMatch(/- `fable-5` — Fable 5 \(runner claude\)/);
    expect(replies[0]).toMatch(/^Rejected: a breakdown needs at least two children/);
    expect(replies[1]).toMatch(/flagged as an epic/);
    const flag = fmOf(store, item.id).op_data?.looks_like_epic as { source: string; children: unknown[] };
    expect(flag).toMatchObject({ source: 'breakdown', reason: 'its planner handed in a breakdown of 2 child items instead of one plan' });
    expect(flag.children).toEqual([{ title: 'Wand icon', description: 'Draw the 256px wand icon at assets/wand.png.', implementer: 'codex-art' }, { title: 'Wand logic', description: 'Implement the wand; it uses assets/wand.png.', implementer: 'fable-5', depends_on: [0] }]);
    expect(store.derived(store.getItem(item.id)!).children).toEqual([]);
    expect(section(store, item.id, 'Plan')).toContain('Two pieces.');
    await expect(engine.approvePlan(item.id)).rejects.toThrow(/planner handed in a breakdown of 2 child items/);

    // A child of an epic is not told, and may not hand one in: epics do not nest.
    store.mutateItem(epic.id, [{ set: { branch: 'feature/existing-epic' } }], 'user');
    const child = store.createItem({ title: 'Kid', description: 'x', parent: epic.id });
    store.transition(child.id, 'QUEUED', 'user');
    engine.poke();
    await waitFor(() => fmOf(store, child.id).status === 'PLAN_READY');
    expect(prompts.find((p) => p.item === child.id)!.prompt).not.toContain('If this is really an epic');
    expect(replies[2]).toMatch(/^Rejected: this item is a child of epic/);
    expect(fmOf(store, child.id).op_data?.looks_like_epic).toBeUndefined();
  });

  it('delegated to the orchestrator: its packet says it is an epic, approve_plan is refused, and convert_item makes it one', async () => {
    const results: Record<string, unknown> = {};
    const { store, engine, world, wakes } = await setup({ delegate: true, plan: plans(BREAKDOWN_PLAN), orchestrate: async (label, t) => {
      if (!label.includes('plan_review') || results.convert) return;
      results.approve = await t('approve_plan').handler({ id: 'TP-1' });
      results.convert = await t('convert_item').handler({ id: 'TP-1', to: 'epic', reason: 'the plan is three children' });
    } });
    const item = store.createItem({ title: 'Frost wand', description: 'Add a Frost Wand: icon, header art and the weapon.', extra: { auto_approve_plan: true } });
    store.transition(item.id, 'QUEUED', 'user');
    await engine.start();
    await waitFor(() => results.convert !== undefined);
    const packet = wakes.find((w) => w.includes('Event: plan_review'))!;
    expect(packet).toContain('THIS IS AN EPIC, NOT ONE ITEM: its plan has a table of 3 child items. approve_plan refuses it');
    expect(packet).toContain('- convert_item with to: "epic"');
    expect(packet).not.toContain('- approve_plan —');
    expect(results.approve).toMatch(/^refused: TP-1 is not approved/);
    // The wake came while the planner's turn was still ending: the conversion waits for it, as an approval would.
    expect(results.convert).toBe('TP-1 converts to an epic as soon as its planning turn has ended');
    await waitFor(() => fmOf(store, item.id).awaiting === 'breakdown_approval');
    const fm = fmOf(store, item.id);
    expect(fm).toMatchObject({ kind: 'epic', status: 'PLAN_READY' });
    expect(world.localBranches.has('tp/1-frost-wand')).toBe(false);
    const activity = section(store, item.id, 'Activity');
    expect(activity).toContain('[orchestrator] converted to an epic: the plan is three children');
    expect(activity).toContain('removed unused worktree and branch tp/1-frost-wand');
  });
});

describe('convert item ↔ epic (#69)', () => {
  it('a planned item becomes an epic: description kept, plan handed to the epic planner in Notes, unused worktree gone, a semantic commit', async () => {
    const { store, engine, world, prompts, dataDir, app } = await setup({ plan: plans(BREAKDOWN_PLAN) });
    const item = store.createItem({ title: 'Frost wand', description: 'Add a Frost Wand: icon, header art and the weapon.', notes: 'Match the ice palette.' });
    store.transition(item.id, 'QUEUED', 'user');
    await engine.start();
    await waitFor(() => fmOf(store, item.id).status === 'PLAN_READY');
    const branch = fmOf(store, item.id).branch!;
    expect(world.worktrees.size).toBe(1);
    const r = await app.request(`/items/${item.id}/convert`, post({ to: 'epic' }));
    expect(r.status).toBe(200);
    expect(fmOf(store, item.id).kind).toBe('epic');
    expect(section(store, item.id, 'Description')).toBe('Add a Frost Wand: icon, header art and the weapon.');
    const notes = section(store, item.id, 'Notes');
    expect(notes).toMatch(/^Match the ice palette\.\n\n### Plan written while this was one item \(converted \d{4}-\d{2}-\d{2}\)/);
    expect(notes).toContain('| 0 | Wand icon | codex-art |');
    expect(world.localBranches.has(branch)).toBe(false);
    // Submitted already, so its breakdown is planned at once, from a read-only checkout, with the old plan in front of the planner.
    await waitFor(() => fmOf(store, item.id).awaiting === 'breakdown_approval');
    expect(section(store, item.id, 'Plan')).toContain('Epic plan (dry-run)');
    const epicPrompt = prompts.filter((p) => p.item === item.id).at(-1)!.prompt;
    expect(epicPrompt).toContain('## Break this epic down');
    expect(epicPrompt).toContain('| 1 | Header art | codex-art |');
    const activity = section(store, item.id, 'Activity');
    for (const step of ['status PLAN_READY → NOT_YET_SUBMITTED', '[user] converted to an epic. The plan is kept in Notes for its new planner', 'removed unused worktree and branch', 'converted to an epic, so its planner breaks it down: planning the breakdown']) expect(activity, step).toContain(step);
    await store.git.idle();
    expect(git(dataDir, 'log', '--format=%s')).toContain(`${item.id}: convert to epic`);
  });

  it('refuses when work exists: a dirty worktree, an approved plan, an epic with children, a child of an epic', async () => {
    const { store, engine, world } = await setup();
    const item = store.createItem({ title: 'Half done', description: 'x' });
    store.transition(item.id, 'QUEUED', 'user');
    await engine.start();
    await waitFor(() => fmOf(store, item.id).status === 'PLAN_READY');
    const cwd = [...world.worktrees.keys()][0]!;
    world.dirty.add(cwd);
    await expect(engine.convertKind(item.id, 'epic')).rejects.toThrow(/^not converted: TP-1's worktree .* may hold work \(uncommitted changes/);
    expect(fmOf(store, item.id)).toMatchObject({ kind: 'item', status: 'PLAN_READY' });
    expect(world.worktrees.has(cwd)).toBe(true);
    expect(engine.sessions()).toEqual([]);   // the hold it took while checking is released
    world.dirty.delete(cwd);
    world.commits.set(cwd, 1);
    await expect(engine.convertKind(item.id, 'epic')).rejects.toThrow(/1 commit\(s\) are not on origin\/trunk/);
    world.commits.delete(cwd);
    await engine.approvePlan(item.id);
    await expect(engine.convertKind(item.id, 'epic')).rejects.toThrow(/implementation has run|a turn or step running|IN_PROGRESS/);

    const epic = store.createItem({ title: 'Crowded', description: 'x', kind: 'epic' });
    const kid = store.createItem({ title: 'Kid', description: 'x', parent: epic.id });
    await expect(engine.convertKind(epic.id, 'item')).rejects.toThrow(`not converted: ${epic.id} has 1 child item: an epic with children stays an epic`);
    await expect(engine.convertKind(kid.id, 'epic')).rejects.toThrow(`not converted: ${kid.id} is a child of ${epic.id}, and epics do not nest`);
    await expect(engine.convertKind(kid.id, 'item')).rejects.toThrow(/already an item/);
  });

  it('in the backlog it only changes the kind; an epic whose breakdown is waiting goes back to being planned as an item', async () => {
    const { store, engine, world, app, prompts } = await setup();
    const idle = store.createItem({ title: 'Not yet', description: 'x' });
    await engine.start();
    expect((await app.request(`/items/${idle.id}/convert`, post({ to: 'epic' }))).status).toBe(200);
    expect(fmOf(store, idle.id)).toMatchObject({ kind: 'epic', status: 'NOT_YET_SUBMITTED' });
    expect((await app.request(`/items/${idle.id}/convert`, post({ to: 'item', reason: 'one change after all' }))).status).toBe(200);
    expect(fmOf(store, idle.id)).toMatchObject({ kind: 'item', status: 'NOT_YET_SUBMITTED' });
    expect(section(store, idle.id, 'Activity')).toContain('[user] converted to an item: one change after all');

    const epic = store.createItem({ title: 'Too small', description: 'Rename the settings tab.', kind: 'epic' });
    await engine.planEpic(epic.id);
    await waitFor(() => fmOf(store, epic.id).awaiting === 'breakdown_approval');
    expect(world.worktrees.size).toBe(1);   // its read-only planning checkout
    await engine.convertKind(epic.id, 'item');
    expect(world.worktrees.size).toBe(0);
    const notes = section(store, epic.id, 'Notes');
    expect(notes).toContain('### Breakdown proposed while this was an epic');
    expect(notes).toMatch(/Children proposed:\n- 0: \*\*Too small: implementation\*\*/);
    expect(section(store, epic.id, 'Activity')).toContain("removed the breakdown's read-only planning checkout");
    // Submitted already, so it is queued and planned as one item, with the breakdown in front of its planner.
    await waitFor(() => fmOf(store, epic.id).status === 'PLAN_READY' && fmOf(store, epic.id).kind === 'item');
    expect(fmOf(store, epic.id).branch).toMatch(/^tp\/\d+-too-small$/);
    expect(prompts.filter((p) => p.item === epic.id).at(-1)!.prompt).toContain('Breakdown proposed while this was an epic');
  });
});

describe('the orchestrator creates epics from the chat (#69)', () => {
  it('create_item takes kind and an epic\'s planner; a submitted epic has its breakdown planned', async () => {
    const results: Record<string, unknown> = {};
    const { store, engine } = await setup({ orchestrate: async (label, t) => {
      if (!label.includes('user_message')) return;
      results.bad = await t('create_item').handler({ title: 'X', description: 'x', kind: 'epic', planner: 'codex-art' });
      results.idle = await t('create_item').handler({ title: 'Frost wand', description: 'Icon, header art and the weapon.', kind: 'epic', planner: 'opus-5' });
      results.go = await t('create_item').handler({ title: 'Ice wall', description: 'Art and code.', kind: 'epic', submit: true });
      results.item = await t('create_item').handler({ title: 'Typo', description: 'Fix the typo.' });
      results.convert = await t('convert_item').handler({ id: 'TP-3', to: 'epic', reason: 'the user said it has art too' });
      await t('reply_to_user').handler({ text: 'done' });
    } });
    await engine.start();
    engine.orchestrator.wake({ type: 'user_message', data: { message: 'add the frost wand and the ice wall as epics' } });
    await waitFor(() => results.convert !== undefined);
    expect(results.bad).toMatch(/^failed: planner "codex-art" is not a model that can plan/);
    expect(results.idle).toBe('created epic TP-1 (not submitted; submit_item has its breakdown planned when the user asks, or they press "plan the breakdown" on its page)');
    expect(fmOf(store, 'TP-1')).toMatchObject({ kind: 'epic', planner: 'opus-5', status: 'NOT_YET_SUBMITTED' });
    expect(section(store, 'TP-1', 'Activity')).toContain('[orchestrator] created from the chat as an epic');
    expect(results.go).toBe('created epic TP-2 and started planning its breakdown (the user approves the children)');
    await waitFor(() => fmOf(store, 'TP-2').awaiting === 'breakdown_approval');
    expect(results.item).toBe('created TP-3 (not submitted; the user or submit_item queues it)');
    expect(results.convert).toBe('TP-3 converted to an epic');
    expect(fmOf(store, 'TP-3').kind).toBe('epic');
  });

  it('outside the chat it may convert only a plan whose approval is delegated to it', async () => {
    const results: Record<string, unknown> = {};
    const { store, engine } = await setup({ plan: plans(BREAKDOWN_PLAN), orchestrate: async (label, t, prompt) => {
      if (!label.includes('plan_review')) return;
      results.prompt = prompt;
      results.convert = await t('convert_item').handler({ id: 'TP-1', to: 'epic', reason: 'x' });
      await t('annotate_item').handler({ id: 'TP-1', text: 'this is an epic: convert it' });
    } });
    const item = store.createItem({ title: 'Frost wand', description: 'x' });
    store.transition(item.id, 'QUEUED', 'user');
    await engine.start();
    await waitFor(() => results.convert !== undefined);
    expect(results.prompt).toContain("THIS IS AN EPIC, NOT ONE ITEM: its plan has a table of 3 child items. approve_plan refuses it, whoever approves.\nPlan approval: the user's.");
    expect(results.convert).toMatch(/^not permitted: this item's plan is the user's to decide/);
    expect(fmOf(store, item.id).kind).toBe('item');
  });
});

describe('create_item under an epic in review (#208)', () => {
  it('says the epic is reopened for the child and its PR reused', async () => {
    const results: Record<string, unknown> = {};
    const { store, engine } = await setup({ orchestrate: async (label, t) => {
      if (!label.includes('user_message')) return;
      results.child = await t('create_item').handler({ title: 'Wind', description: 'x', parent: 'TP-1' });
      await t('reply_to_user').handler({ text: 'done' });
    } });
    const epic = store.createItem({ title: 'Sound pass', description: 'x', kind: 'epic' });
    store.mutateItem(epic.id, [{ set: { status: 'IN_REVIEW', branch: 'feature/sound-pass', pr: 590, skip_merge: true, hold_reason: 'held', ci_result: 'pending' } }], 'engine');
    await engine.start();
    engine.orchestrator.wake({ type: 'user_message', data: { message: 'add a wind child' } });
    await waitFor(() => results.child !== undefined);
    expect(results.child).toBe('created TP-2 (not submitted; the user or submit_item queues it). Epic TP-1 is in review with PR #590 open: planestro moves it back to in progress for this child, keeping its PR and any hold, and submits the same PR again once every child has merged');
  });
});

describe('the orchestrator submits on the user\'s word (#73)', () => {
  it('submit_item plans an epic\'s breakdown in the chat, refuses it in words anywhere else, and queues a worker item as before', async () => {
    const results: Record<string, unknown> = {};
    const { store, engine } = await setup({ orchestrate: async (label, t, prompt) => {
      if (label.includes('orchestrator_note')) {
        results.outside = await t('submit_item').handler({ id: 'TP-1' });
        results.statusOutside = fmOf(store!, 'TP-1').status;
        results.createOutside = await t('create_item').handler({ title: 'X', description: 'x' });
      }
      if (!label.includes('user_message')) return;
      results.prompt = prompt;
      results.epic = await t('submit_item').handler({ id: 'TP-1' });
      results.again = await t('submit_item').handler({ id: 'TP-1' });
      results.item = await t('submit_item').handler({ id: 'TP-2' });
      results.ghost = await t('submit_item').handler({ id: 'TP-99' });
      results.child = await t('create_item').handler({ title: 'Wand icon', description: 'Draw the 256px wand icon.', parent: 'TP-3', implementer: 'opus-5' });
      results.nested = await t('create_item').handler({ title: 'Nested', description: 'x', kind: 'epic', parent: 'TP-3' });
      results.unknown = await t('create_item').handler({ title: 'Waits for nothing', description: 'x', depends_on: ['TP-99'], implementer: 'gpt-9' });
      results.parented = await t('submit_item').handler({ id: 'TP-3' });
      await t('reply_to_user').handler({ text: 'done' });
    } });
    store.createItem({ title: 'Frost wand', description: 'Icon, header art and the weapon.', kind: 'epic' });
    store.createItem({ title: 'Typo', description: 'Fix the typo.' });
    store.createItem({ title: 'Ice wall', description: 'Art and code.', kind: 'epic' });
    await engine.start();
    engine.orchestrator.wake({ type: 'orchestrator_note', data: { note: 'routine' } });
    await waitFor(() => results.createOutside !== undefined);
    expect(results.outside).toMatch(/^not permitted: TP-1 is an epic, and planning an epic's breakdown is the user's call/);
    expect(results.outside).toContain('{ tool: "submit_item", args: { id: "TP-1" } }');
    expect(results.statusOutside).toBe('NOT_YET_SUBMITTED');
    expect(results.createOutside).toMatch(/^not permitted: only when the user asks you to in the chat.*offer it on its decision card/);

    engine.orchestrator.wake({ type: 'user_message', data: { message: 'start the frost wand, and queue the typo' } });
    await waitFor(() => results.parented !== undefined);
    expect(results.prompt).toContain('submit_item on an epic does not queue it: it has the epic\'s breakdown planned');
    expect(results.epic).toBe('planning the breakdown of epic TP-1 (it is not queued: the user approves the children it proposes)');
    expect(results.again).toMatch(/^refused: TP-1 is PLAN_(IN_PROGRESS|READY); only an item that is not submitted yet can be submitted\. Nothing was submitted\./);
    expect(results.item).toBe('queued');
    expect(results.ghost).toMatch(/^refused: .*TP-99/);
    expect(results.child).toBe('created TP-4 (not submitted; the user or submit_item queues it)');
    expect(fmOf(store, 'TP-4')).toMatchObject({ parent: 'TP-3', implementer: 'opus-5', status: 'NOT_YET_SUBMITTED' });
    expect(results.nested).toBe('failed: an epic cannot be a child of TP-3: epics do not nest');
    expect(results.unknown).toMatch(/^failed: implementer "gpt-9" is not one of the project's models/);
    expect(results.parented).toMatch(/^refused: epic TP-3 already has children \(TP-4\): submit those/);
    expect(store.getItem('TP-5')).toBeUndefined();
    expect(section(store, 'TP-1', 'Activity')).toContain('submitted from the chat: planning the breakdown');
    await waitFor(() => fmOf(store, 'TP-1').awaiting === 'breakdown_approval');
    expect(fmOf(store, 'TP-1').status).toBe('PLAN_READY');
  });

  it('submit_item refuses an item imported from a GitHub issue outside the chat, and queues it when the user asks (#339)', async () => {
    const results: Record<string, unknown> = {};
    const { store, engine } = await setup({ orchestrate: async (label, t) => {
      if (label.includes('triage') && results.outside === undefined) {
        results.outside = await t('submit_item').handler({ id: 'TP-1' });
        results.statusOutside = fmOf(store!, 'TP-1').status;
        results.mine = await t('submit_item').handler({ id: 'TP-2' });
      }
      if (label.includes('user_message') && results.inChat === undefined) results.inChat = await t('submit_item').handler({ id: 'TP-1' });
    } });
    store.createItem({ title: 'Crash on load', description: 'Text a stranger wrote.', extra: { source: { github_issue: 42 } } }, 'user');
    store.createItem({ title: 'Typo', description: 'Fix the typo.' });
    await engine.start();
    engine.orchestrator.wake({ type: 'triage', item: 'TP-2' });
    await waitFor(() => results.mine !== undefined);
    expect(results.outside).toMatch(/^not permitted: TP-1 was imported from issue #42, and starting work on an imported issue is the user's call/);
    expect(results.outside).toContain('{ tool: "submit_item", args: { id: "TP-1" } }');
    expect(results.statusOutside).toBe('NOT_YET_SUBMITTED');
    expect(results.mine).toBe('queued');   // an item the user filed is submitted as before
    engine.orchestrator.wake({ type: 'user_message', data: { message: 'start the crash on load issue' } });
    await waitFor(() => results.inChat !== undefined);
    expect(results.inChat).toBe('queued');
    expect(fmOf(store, 'TP-1').status).not.toBe('NOT_YET_SUBMITTED');
  });

  it('planEpic refuses an epic with a step running, before its status moves', async () => {
    const { store, engine } = await setup();
    const epic = store.createItem({ title: 'Frost wand', description: 'x', kind: 'epic' });
    let release!: () => void;
    (engine as any).runJob(epic.id, () => new Promise<void>((r) => { release = r; }));
    await expect(engine.planEpic(epic.id)).rejects.toThrow(`${epic.id} has a step running; let it finish first`);
    expect(fmOf(store, epic.id).status).toBe('NOT_YET_SUBMITTED');
    release();
    await sleep(20);
    await engine.planEpic(epic.id);
    expect(fmOf(store, epic.id).status).toBe('PLAN_IN_PROGRESS');
  });
});
