import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DataStore } from '../src/store/DataStore.ts';
import { LiveEngine } from '../src/engine/LiveEngine.ts';
import { apiRoutes } from '../src/routes/api.ts';
import { FakeWorld, DryRunGitPort, DryRunGhPort, DryRunProcPort, DryRunClaudePort } from '../src/engine/dryrun-ports.ts';
import type { Ports } from '../src/engine/ports.ts';
import { makeFixture, sleep } from './helpers.ts';

let store: DataStore | undefined; let engine: LiveEngine | undefined;
afterEach(async () => { await engine?.stop(); store?.close(); store = undefined; engine = undefined; });

const fmOf = (s: DataStore, id: string) => s.getItem(id)!.file.frontmatter;
const activityOf = (s: DataStore, id: string) => s.getItem(id)!.file.sections.find((x) => x.title === 'Activity')!.body;
async function waitFor(pred: () => boolean, ms = 6000) { const t0 = Date.now(); while (!pred()) { if (Date.now() - t0 > ms) throw new Error(`timeout waiting: ${pred.toString().slice(0, 120)}`); await sleep(20); } }

type Hooks = { orchestratorUnblocks(id: string, message?: string, syncFirst?: boolean, fresh?: boolean): Promise<string>; askUserDecision(id: string, input: unknown): string };

/** LM-64 (#500): an epic in review, every child merged, its PR red with no session to hand the failure to. */
async function redEpic(opts: { status?: 'IN_REVIEW' | 'IN_PROGRESS' } = {}) {
  const { dataDir, codeRepo } = makeFixture();
  mkdirSync(join(codeRepo, '.git', 'info'), { recursive: true });
  const cfg = join(dataDir, 'planestro.yml');
  writeFileSync(cfg, readFileSync(cfg, 'utf8').replace(/^code_repo:\n/m, 'code_repo:\n  github: acme/repo\n'));
  delete process.env.PLANESTRO_DRYRUN_CI;
  store = await DataStore.open(dataDir);
  const world = new FakeWorld(() => {}, { 'origin/trunk': 'f'.repeat(40) });
  const ports: Ports = { mode: 'dry-run', git: new DryRunGitPort(world), gh: new DryRunGhPort(world), proc: new DryRunProcPort(world), agents: { claude: new DryRunClaudePort(world) } };
  engine = new LiveEngine(store, ports, () => {}, { sleep: async () => {}, tickMs: 50 });
  const epic = store.createItem({ title: 'Lake trail', description: 'x', kind: 'epic' });
  const child = store.createItem({ title: 'Trail art', description: 'x', parent: epic.id });
  store.mutateItem(child.id, [{ set: { status: 'MERGED' } }], 'engine');
  const branch = 'feature/lake-trail';
  world.remoteBranches.set(branch, world.sha());
  world.prs.set(77, { number: 77, url: 'u', state: 'OPEN', headRefOid: world.remoteBranches.get(branch)!, headRefName: branch, baseRefName: 'trunk', polls: 0, failOnce: false });
  const status = opts.status ?? 'IN_REVIEW';
  store.mutateItem(epic.id, [{ set: { status, branch, session_id: 's-planner', ...(status === 'IN_REVIEW' ? { pr: 77, ci_result: 'red', blocked_reason: 'ci_red' } : { blocked_reason: 'agent_blocked' }), blocked: true } }], 'engine');
  return { store, engine, world, epic: epic.id, hooks: engine as unknown as Hooks };
}

describe('a red epic in review (#500, LM-64)', () => {
  it('unblock_item with a message is refused in words, the stop kept, and it names the fix child path; nothing runs', async () => {
    const { store, engine, epic, hooks } = await redEpic();
    await engine.start();
    const r = await hooks.orchestratorUnblocks(epic, 'Fix the failing trail test in TrailMap.gd.');
    expect(r).toMatch(/^not possible: .* is an epic in review: past its breakdown it has no session/);
    expect(r).toContain(`parent: "${epic}"`);
    expect(r).toContain('rerun_ci');
    // sync_first with a message is refused the same way, before any sync (the #486 shape on an epic).
    const s = await hooks.orchestratorUnblocks(epic, 'Fix it.', true);
    expect(s).toMatch(/^not possible: .* is an epic in review/);
    await sleep(150);
    const fm = fmOf(store, epic);
    expect(fm.blocked_reason).toBe('ci_red');
    expect(fm.op_data?.pending_turn).toBeUndefined();
    expect(activityOf(store, epic)).not.toContain('unblocked');
    // The stop is still a stop, so the card the refusal points at can be filed, its fix child checked as one that can be made.
    const card = hooks.askUserDecision(epic, { question: 'Fix the red trail test?', why: 'The epic PR is red on a real failure.', options: [
      { label: 'File a fix', description: 'A child that fixes TrailMap.gd', recommended: true, action: { tool: 'create_item', args: { title: 'Fix trail test', description: 'TrailMap.gd fails test_trail_ends.', parent: epic, submit: true } } },
      { label: 'Leave it', description: 'Do nothing' },
    ] });
    expect(card).toMatch(/^recorded/);
  }, 20000);

  it('a message to an epic in progress is refused too, with sync_first or without; a fresh session is not offered', async () => {
    const { store, engine, epic, hooks } = await redEpic({ status: 'IN_PROGRESS' });
    await engine.start();
    for (const [sync, fresh] of [[false, false], [true, false], [false, true]] as const) {
      const r = await hooks.orchestratorUnblocks(epic, 'Carry on.', sync, fresh);
      expect(r).toMatch(/^not possible: .* is an epic that is IN_PROGRESS: past its breakdown it has no session/);
      expect(r).toContain('unblock_item without a message');
    }
    expect(fmOf(store, epic).blocked_reason).toBe('agent_blocked');
    // planestro's own stop is retried, a message with it a note (#211, #439): unblocked, and said to be Activity only.
    store.mutateItem(epic, [{ set: { blocked_reason: 'engine_error' } }], 'engine');
    expect(await hooks.orchestratorUnblocks(epic, 'Benign race.')).toMatch(/your message is in its Activity log only$/);
    await waitFor(() => !fmOf(store, epic).blocked);
  }, 20000);

  it('a fix child takes the epic back in progress and clears its CI stop and card; retry_op meanwhile says why not', async () => {
    const { store, engine, epic, hooks } = await redEpic();
    hooks.askUserDecision(epic, { question: 'Fix it?', why: 'Red.', options: [{ label: 'Yes', description: 'a child', recommended: true }, { label: 'No', description: 'no' }] });
    expect(fmOf(store, epic).awaiting).toBe('user');
    const fix = store.createItem({ title: 'Fix trail test', description: 'x', parent: epic });
    expect(await engine.retryOp(epic, 'orchestrator')).toMatch(new RegExp(`^not now: ${fix.id} is new work for epic ${epic}`));
    expect(activityOf(store, epic)).not.toContain('retrying the merge pipeline');   // the same red run is not re-read under the child
    store.transition(fix.id, 'QUEUED', 'user');
    await engine.start();
    await waitFor(() => fmOf(store, epic).status === 'IN_PROGRESS');
    const fm = fmOf(store, epic);
    expect(fm.blocked).toBeUndefined(); expect(fm.blocked_reason).toBeUndefined();
    expect(fm.awaiting).toBeUndefined(); expect(fm.awaiting_data).toBeUndefined();
    expect(fm.pr).toBe(77);
    expect(activityOf(store, epic)).toContain(`new child ${fix.id}: epic back in progress; PR #77 stays open and is reused (its ci_red stop is cleared`);
  }, 20000);

  it('the return text follows the phase unblock resumes in: a plain item in review resumes; with no session the message is said to be Activity only', async () => {
    const { store, engine, hooks } = await redEpic();
    const item = store.createItem({ title: 'Merged thing', description: 'x' });
    store.mutateItem(item.id, [{ set: { status: 'MERGED', blocked: true, blocked_reason: 'cleanup_failed' } }], 'engine');
    await engine.start();
    expect(await hooks.orchestratorUnblocks(item.id, 'Try again.')).toMatch(/with no session to resume: your message is in its Activity log only$/);
  }, 20000);

  it("the user's own unblock with a message is refused in plain words, the stop kept; without one it unblocks; a card's answer still does", async () => {
    const { store, engine, epic } = await redEpic();
    await engine.start();
    const app = apiRoutes(store, engine);
    const res = await app.request(`/items/${epic}/unblock`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: 'Fix the trail test.' }) });
    expect(res.status).toBe(400);
    const error = String((await res.json()).error);
    expect(error).toMatch(/is an epic in review: it has no session to read a message, so it was not unblocked/);
    expect(error).toContain('add a fix child to the epic');
    expect(error).toContain('unblock without a message');
    expect(error).not.toMatch(/ask_user_decision|create_item|parent:|rerun_ci|unblock_item/);
    expect(fmOf(store, epic).blocked_reason).toBe('ci_red');
    expect(activityOf(store, epic)).not.toContain('unblocked');
    // A decision card answered with no orchestrator to carry it (fromCard): the answer is in Activity, and the stop is cleared as before.
    await (engine as unknown as { unblock(id: string, m: string, by: 'user', o: { fromCard: boolean }): Promise<void> }).unblock(epic, 'The user was asked: fix it?\nTheir answer: Leave it', 'user', { fromCard: true });
    expect(activityOf(store, epic)).toContain('unblocked: The user was asked: fix it?');
  }, 20000);
});
