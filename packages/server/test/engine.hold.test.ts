import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DataStore } from '../src/store/DataStore.ts';
import { LiveEngine } from '../src/engine/LiveEngine.ts';
import { apiRoutes } from '../src/routes/api.ts';
import { FakeWorld, DryRunGitPort, DryRunGhPort, DryRunProcPort, DryRunClaudePort } from '../src/engine/dryrun-ports.ts';
import type { Ports, TurnOptions, TurnResult } from '../src/engine/ports.ts';
import { getSection } from '@planestro/shared';
import { makeFixture, sleep } from './helpers.ts';

/**
 * A hold that is written down takes effect (#97, LM-22): LM-22's plan said "PR stays held until …"
 * and nothing held it, because a hold existed only if someone called skip_merge. The plan's sentence
 * is found by code and offered at approval, the worker can ask for a hold as it reports done, and
 * the reason is on the item either way.
 */
let store: DataStore | undefined; let engine: LiveEngine | undefined;
const polls: ReturnType<typeof setInterval>[] = [];
afterEach(async () => { for (const p of polls.splice(0)) clearInterval(p); await engine?.stop(); store?.close(); store = undefined; engine = undefined; });

type Tool = (n: string) => { handler(a: Record<string, unknown>): Promise<unknown> };
const ok: TurnResult = { sessionId: 's', subtype: 'success', isError: false, costUsd: 0, numTurns: 1, text: '' };
const HOLD_PLAN = '# Plan\n\n1. Bump the version.\n2. Open the PR.\n\nThe PR stays held until the 0.4.0 release is cut.\n';
const STATED = 'until the 0.4.0 release is cut';
const PLAIN_PLAN = '# Plan\n\n1. Add the flag.\n2. Test it.\n';

/** The dry-run agents, with a planner and a worker that can be scripted, and every prompt recorded; `orchestrate` scripts the orchestrator's wakes. */
async function setup(opts: { plan?: (o: TurnOptions) => Promise<TurnResult | undefined>; work?: (o: TurnOptions, world: FakeWorld) => Promise<TurnResult | undefined>; orchestrate?: (label: string, t: Tool, prompt: string) => Promise<void>; delegate?: boolean; drafts?: boolean } = {}) {
  const { dataDir, codeRepo } = makeFixture();
  mkdirSync(join(codeRepo, '.git', 'info'), { recursive: true });
  const cfg = join(dataDir, 'planestro.yml');
  let yml = readFileSync(cfg, 'utf8').replace(/^code_repo:\n/m, 'code_repo:\n  github: acme/repo\n');
  if (opts.delegate) yml = yml.replace('may_approve_plans: false', 'may_approve_plans: true');
  writeFileSync(cfg, yml);
  delete process.env.PLANESTRO_DRYRUN_CI;
  store = await DataStore.open(dataDir, { emit: () => {} });
  // Most of these describe a project whose CI runs on held PRs; the draft flow is asked for by name.
  if (!opts.drafts) store.updateConfig((doc) => { doc.setIn(['ci', 'draft_while_held'], false); }, 'config: no drafts');
  const world = new FakeWorld(() => {}, { 'origin/trunk': 'f'.repeat(40) });
  const inner = new DryRunClaudePort(world);
  const prompts: { item: string; phase: string; prompt: string }[] = []; const wakes: string[] = [];
  const claude: Ports['agents']['claude'] = {
    async runTurn(o: TurnOptions): Promise<TurnResult> {
      prompts.push({ item: o.itemId, phase: o.phase, prompt: o.prompt });
      if (o.phase === 'plan' && opts.plan) { const r = await opts.plan(o); if (r) return r; }
      if (o.phase !== 'plan' && opts.work) { const r = await opts.work(o, world); if (r) return r; }
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
  const live = engine = new LiveEngine(store, ports, () => {}, { sleep: async () => {}, tickMs: 50 });
  // The tick looks at a held item once a minute; tests look again on every tick.
  polls.push(setInterval(() => (live as any).heldPolledAt.clear(), 30));
  return { store, engine, world, prompts, wakes, dataDir, app: apiRoutes(store, engine) };
}

async function waitFor(pred: () => boolean, ms = 4000) { const t0 = Date.now(); while (!pred()) { if (Date.now() - t0 > ms) throw new Error('timeout waiting'); await sleep(20); } }
const fmOf = (s: DataStore, id: string) => s.getItem(id)!.file.frontmatter;
const activityOf = (s: DataStore, id: string) => getSection(s.getItem(id)!.file, 'Activity');
const json = (method: 'POST' | 'PATCH', body: unknown) => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
/** A planner that hands in `plan` with submit_plan. */
const plans = (plan: string) => async (o: TurnOptions) => { await o.tools.submit_plan(plan); return { ...ok, planSubmitted: plan }; };
/** A worker that commits and reports done, asking for `hold` if given. */
const works = (hold?: string, summary = 'did it') => async (o: TurnOptions, world: FakeWorld) => {
  world.commits.set(o.cwd, (world.commits.get(o.cwd) ?? 0) + 1);
  const wt = world.worktrees.get(o.cwd); if (wt) wt.head = world.sha();
  const text = await o.tools.report_done(summary, undefined, hold);
  return { ...ok, done: summary, text };
};
async function planned(s: DataStore, e: LiveEngine, extra: Record<string, unknown> = {}) {
  const item = s.createItem({ title: 'Cut 0.4.0', description: 'Bump the version for the release.', extra });
  s.transition(item.id, 'QUEUED', 'user');
  await e.start();
  await waitFor(() => fmOf(s, item.id).status === 'PLAN_READY');
  return item.id;
}
const count = (text: string, part: string) => text.split(part).length - 1;

describe('a hold stated in the plan (#97)', () => {
  it('is logged at hand-in, holds nothing by itself, and a revised plan without it is an ordinary plan', async () => {
    let n = 0;
    const { store, engine } = await setup({ plan: async (o) => plans(n++ === 0 ? HOLD_PLAN : PLAIN_PLAN)(o) });
    const id = await planned(store, engine);
    expect(activityOf(store, id)).toContain('its plan states a merge hold: "The PR stays held until the 0.4.0 release is cut."');
    expect(fmOf(store, id).skip_merge).toBeUndefined();
    await engine.rejectPlan(id, 'it merges as usual: drop the hold');
    await waitFor(() => fmOf(store, id).status === 'PLAN_READY' && n === 2);
    expect(count(activityOf(store, id), 'its plan states a merge hold')).toBe(1);
    await engine.approvePlan(id);
    await waitFor(() => fmOf(store, id).status === 'FINISHED');
    const log = activityOf(store, id);
    expect(log).not.toContain('approved without the hold');
    expect(log).not.toContain('held out of the merge queue');
  });

  it('approved with the hold: the reason is on the item, the pull request never merges, and Release hold merges it', async () => {
    const { store, engine, world, prompts } = await setup({ plan: plans(HOLD_PLAN) });
    const id = await planned(store, engine);
    await engine.approvePlan(id, undefined, 'user', { hold: STATED });
    expect(fmOf(store, id)).toMatchObject({ status: 'IN_PROGRESS', skip_merge: true, hold_reason: STATED, hold_waits_on: 'person' });
    expect(activityOf(store, id)).toContain(`[user] held out of the merge queue: ${STATED}`);
    await waitFor(() => fmOf(store, id).status === 'IN_REVIEW' && fmOf(store, id).ci_result === 'green');
    expect(prompts.find((p) => p.phase === 'implement')!.prompt).toContain(`## Merge hold\n\nThis item's pull request is held out of the merge queue: ${STATED}.`);
    await sleep(300);
    const fm = fmOf(store, id);
    expect(fm).toMatchObject({ status: 'IN_REVIEW', skip_merge: true, hold_reason: STATED });
    expect(world.prs.get(fm.pr!)!.state).toBe('OPEN');
    expect(store.derived(store.getItem(id)!).needs_you).toBe(true);
    await engine.releaseHold(id, '0.4.0 is out');
    await waitFor(() => fmOf(store, id).status === 'FINISHED');
    expect(fmOf(store, id).skip_merge).toBeUndefined();
    expect(fmOf(store, id).hold_reason).toBeUndefined();
    expect(fmOf(store, id).hold_waits_on).toBeUndefined();   // lasts exactly as long as the hold, like its reason
    expect(activityOf(store, id)).toContain('approved for merge: 0.4.0 is out');
  });

  it('approved without it: nothing is held, the log says so, and the worker does not put the hold back', async () => {
    const { store, engine, prompts } = await setup({ plan: plans(HOLD_PLAN), work: works('until the release is cut') });
    const id = await planned(store, engine);
    await engine.approvePlan(id);
    expect(fmOf(store, id).skip_merge).toBeUndefined();
    expect(fmOf(store, id).op_data?.hold_waived).toBe(true);
    await waitFor(() => fmOf(store, id).status === 'FINISHED');
    const log = activityOf(store, id);
    expect(log).toContain('[user] approved without the hold its plan states: "The PR stays held until the 0.4.0 release is cut."');
    expect(log).toContain('the worker asked for a hold (until the release is cut); not held');
    expect(log).not.toContain('held out of the merge queue');
    expect(prompts.find((p) => p.phase === 'implement')!.prompt).toContain('The user approved it without that hold');
  });

  it('a hold set at approval can be dropped before the pull request exists, and stays dropped', async () => {
    let open!: () => void; const gate = new Promise<void>((r) => { open = r; });
    const { store, engine } = await setup({ plan: plans(PLAIN_PLAN), work: async (o, world) => { await gate; return works('until QA confirms')(o, world); } });
    const id = await planned(store, engine);
    await engine.approvePlan(id, undefined, 'user', { hold: 'until QA confirms' });
    expect(fmOf(store, id)).toMatchObject({ status: 'IN_PROGRESS', skip_merge: true, hold_reason: 'until QA confirms' });
    await engine.releaseHold(id, 'QA confirmed early');
    expect(fmOf(store, id).skip_merge).toBeUndefined();
    expect(fmOf(store, id).hold_reason).toBeUndefined();
    expect(activityOf(store, id)).toContain('[user] hold dropped: its pull request will merge as usual: QA confirmed early');
    await expect(engine.releaseHold(id)).rejects.toThrow(/only an item in review can be released/);
    open();
    await waitFor(() => fmOf(store, id).status === 'FINISHED');
    expect(activityOf(store, id)).toContain('the worker asked for a hold (until QA confirms); not held');
  });

  it('is read from the plan as it stands: a plan edited by hand is held when the orchestrator approves it', async () => {
    const { store, engine, app } = await setup({ plan: plans(PLAIN_PLAN) });
    const id = await planned(store, engine);
    expect(activityOf(store, id)).not.toContain('its plan states a merge hold');
    expect((await app.request(`/items/${id}`, json('PATCH', { sections: { Plan: `${PLAIN_PLAN}\nDo not merge until HH-3 has merged.\n` } }))).status).toBe(200);
    await engine.approvePlan(id, undefined, 'orchestrator');
    expect(fmOf(store, id)).toMatchObject({ skip_merge: true, hold_reason: 'until HH-3 has merged' });
    expect(activityOf(store, id)).toContain('[orchestrator] held out of the merge queue: until HH-3 has merged');
  });

  it('delegated: the packet quotes the hold, and approve_plan holds the pull request with it', async () => {
    const results: Record<string, unknown> = {};
    const { store, engine, wakes } = await setup({ delegate: true, plan: plans(HOLD_PLAN), orchestrate: async (label, t) => {
      if (!label.includes('plan_review') || results.approve) return;
      results.approve = await t('approve_plan').handler({ id: 'TP-1' });
    } });
    const item = store.createItem({ title: 'Cut 0.4.0', description: 'Bump the version for the release.', extra: { auto_approve_plan: true } });
    store.transition(item.id, 'QUEUED', 'user');
    await engine.start();
    await waitFor(() => fmOf(store, item.id).status === 'IN_REVIEW');
    const packet = wakes.find((w) => w.includes('Event: plan_review'))!;
    expect(packet).toContain('THIS PLAN STATES A MERGE HOLD: "The PR stays held until the 0.4.0 release is cut."');
    expect(packet).toContain(`planestro holds its pull request out of the merge queue (${STATED})`);
    expect(fmOf(store, item.id)).toMatchObject({ skip_merge: true, hold_reason: STATED });
    expect(activityOf(store, item.id)).toContain(`[orchestrator] held out of the merge queue: ${STATED}`);
    await sleep(300);
    expect(fmOf(store, item.id).status).toBe('IN_REVIEW');
  });

  it('the user\'s plan: the packet says the hold is theirs to set', async () => {
    const { store, engine, wakes } = await setup({ plan: plans(HOLD_PLAN), orchestrate: async () => {} });
    await planned(store, engine);
    await waitFor(() => wakes.some((w) => w.includes('Event: plan_review')));
    const packet = wakes.find((w) => w.includes('Event: plan_review'))!;
    expect(packet).toContain('THIS PLAN STATES A MERGE HOLD');
    expect(packet).toContain('the item page offers them "Approve and hold the PR"');
  });

  it('the route takes the hold; an empty one is refused; lifting skip_merge by an edit takes the reason with it', async () => {
    const { store, engine, app } = await setup({ plan: plans(HOLD_PLAN), work: async () => { await sleep(2000); return undefined; } });
    const id = await planned(store, engine);
    expect((await app.request(`/items/${id}/plan/approve`, json('POST', { hold: '  ' }))).status).toBe(400);
    expect(fmOf(store, id).status).toBe('PLAN_READY');
    const r = await app.request(`/items/${id}/plan/approve`, json('POST', { hold: ' until QA confirms ' }));
    expect(r.status).toBe(200);
    expect(((await r.json()) as any).frontmatter).toMatchObject({ skip_merge: true, hold_reason: 'until QA confirms' });
    expect((await app.request(`/items/${id}`, json('PATCH', { fields: { skip_merge: null } }))).status).toBe(200);
    expect(fmOf(store, id).skip_merge).toBeUndefined();
    expect(fmOf(store, id).hold_reason).toBeUndefined();
  });
});

describe('the orchestrator holds an item (#97)', () => {
  it('skip_merge puts its reason on the item, list_items shows it, and unskip_merge takes it off for good', async () => {
    const results: Record<string, unknown> = {};
    const { store, engine } = await setup({ plan: plans(PLAIN_PLAN), orchestrate: async (label, t) => {
      if (!label.includes('plan_review') || results.held) return;
      results.empty = await t('skip_merge').handler({ id: 'TP-1', reason: ' ' });
      results.held = await t('skip_merge').handler({ id: 'TP-1', reason: 'until HH-3 has merged' });
      results.list = await t('list_items').handler({});
      results.fm = { ...store!.getItem('TP-1')!.file.frontmatter };
      results.back = await t('unskip_merge').handler({ id: 'TP-1' });
    } });
    const id = await planned(store, engine);
    await waitFor(() => results.back !== undefined);
    expect(results.empty).toMatch(/^not held: say why/);
    expect(results.held).toBe('held');
    expect(results.fm).toMatchObject({ skip_merge: true, hold_reason: 'until HH-3 has merged', hold_waits_on: 'agent' });   // the merge only (#195)
    expect(results.list).toContain('HELD:until HH-3 has merged');
    expect(fmOf(store, id).skip_merge).toBeUndefined();
    expect(fmOf(store, id).hold_reason).toBeUndefined();
    expect(fmOf(store, id).op_data?.hold_waived).toBe(true);
    expect(activityOf(store, id)).toContain('[orchestrator] held out of the merge queue: until HH-3 has merged');
  });
});

describe('report_done with a hold (#97)', () => {
  it('opens the pull request held for the merge only, ready even where the project drafts held PRs, with the reason on the item (#195)', async () => {
    const replies: string[] = [];
    const { store, engine, world } = await setup({ drafts: true, plan: plans(PLAIN_PLAN), work: async (o, w) => { const r = await works('until the store listing is approved')(o, w); replies.push(r.text); return r; } });
    const id = await planned(store, engine);
    await engine.approvePlan(id);
    await waitFor(() => fmOf(store, id).status === 'IN_REVIEW');
    const fm = fmOf(store, id);
    expect(fm).toMatchObject({ skip_merge: true, hold_reason: 'until the store listing is approved' });
    // The worker's hold waits on an agent-side step, which needs a CI verdict: never a draft (#195).
    expect(fm.op_data?.pr_draft).toBeUndefined();
    expect(fm.hold_waits_on).toBe('agent');
    expect(world.prs.get(fm.pr!)!.isDraft).toBeFalsy();
    expect(fm.op_data?.done_summary).toBe('did it');
    expect(replies[0]).toBe('Recorded: planestro keeps the pull request out of the merge queue until the user releases the hold. End your turn now.');
    expect(activityOf(store, id)).toContain('[worker] held out of the merge queue: until the store listing is approved');
    await sleep(300);
    expect(fmOf(store, id).status).toBe('IN_REVIEW');
    expect(world.prs.get(fm.pr!)!.state).toBe('OPEN');
    expect(store.derived(store.getItem(id)!).needs_you).toBe(true);
  });

  it('without one, or with an empty one, nothing is held', async () => {
    const replies: string[] = [];
    const { store, engine } = await setup({ plan: plans(PLAIN_PLAN), work: async (o, w) => { const r = await works('   ')(o, w); replies.push(r.text); return r; } });
    const id = await planned(store, engine);
    await engine.approvePlan(id);
    await waitFor(() => fmOf(store, id).status === 'FINISHED');
    expect(replies[0]).toBe('Recorded. End your turn now.');
    expect(activityOf(store, id)).not.toContain('held out of the merge queue');
  });

  it('is ignored while planning: a hold belongs to work that is done', async () => {
    const { store, engine } = await setup({ plan: async (o) => { await o.tools.report_done('planned', undefined, 'until later'); return plans(PLAIN_PLAN)(o); } });
    const id = await planned(store, engine);
    expect(fmOf(store, id).skip_merge).toBeUndefined();
    expect(fmOf(store, id).hold_reason).toBeUndefined();
    expect(activityOf(store, id)).not.toContain('held out of the merge queue');
  });
});
