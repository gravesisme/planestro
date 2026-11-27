import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DataStore } from '../src/store/DataStore.ts';
import { LiveEngine } from '../src/engine/LiveEngine.ts';
import { FakeWorld, DryRunGitPort, DryRunGhPort, DryRunProcPort, DryRunClaudePort } from '../src/engine/dryrun-ports.ts';
import type { Ports, CiStatus } from '../src/engine/ports.ts';
import { getSection } from '@planestro/shared';
import { makeFixture, sleep } from './helpers.ts';

/**
 * #580 (HH-835, HH-844, 2026-11-18): a rebase conflict and a first CI red were handed to their sessions while claude was
 * paused by the usage guard. Both fix turns were saved (`op_data.pending_turn`) and started when the guard lifted an hour
 * later, but nothing in Activity said so, the review watchdog took both for stalls, and the wake named tools that refuse an
 * item that is not blocked. A saved turn that starts by itself is something coming; the deferral is said once; a true stall's
 * wake names only what takes the item; and message_session says whether it started the turn.
 */
let store: DataStore | undefined; let engine: LiveEngine | undefined;
afterEach(async () => { await engine?.stop(); store?.close(); store = undefined; engine = undefined; });

type Wake = { type: string; item?: string; data?: Record<string, unknown> };

async function setup() {
  const { dataDir, codeRepo } = makeFixture();
  mkdirSync(join(codeRepo, '.git', 'info'), { recursive: true });
  const cfg = join(dataDir, 'planestro.yml');
  writeFileSync(cfg, readFileSync(cfg, 'utf8').replace(/^code_repo:\n/m, 'code_repo:\n  github: acme/repo\n'));
  delete process.env.PLANESTRO_DRYRUN_CI;
  store = await DataStore.open(dataDir, { emit: () => {} });
  store.updateConfig((doc) => { doc.setIn(['ci', 'stall_wake_min'], 0.005); }, 'config: stall wake');
  const world = new FakeWorld(() => {}, { 'origin/trunk': 'f'.repeat(40) });
  const gh = new DryRunGhPort(world);
  const ci = { state: 'failure' as CiStatus['state'] };
  gh.ciForSha = async (_r: string, _b: string, sha: string): Promise<CiStatus> => ({ state: ci.state, runId: 7, sha, url: 'u7', attempt: 1 });
  const ports: Ports = { mode: 'dry-run', git: new DryRunGitPort(world), gh, proc: new DryRunProcPort(world), agents: { claude: new DryRunClaudePort(world) } };
  engine = new LiveEngine(store, ports, () => {}, { sleep: async () => {}, tickMs: 50 });
  const s = store; const e = engine;
  const wakes: Wake[] = [];
  (e as any).orchestrator.wake = (w: Wake) => { wakes.push(w); };
  /** A worker's pull request in review, with a session to hand things to. */
  const inReview = (set: Record<string, unknown>) => {
    const it = s.createItem({ title: 'Title score', description: 'x' });
    const rel = '.claude/worktrees/score'; const branch = 'tp/score'; const tip = world.sha();
    const cwd = (e as any).absWorktree(rel) as string;
    world.worktrees.set(cwd, { path: cwd, head: tip, branch }); world.localBranches.add(branch); world.remoteBranches.set(branch, tip);
    world.prs.set(300, { number: 300, url: 'u', state: 'OPEN', headRefOid: tip, headRefName: branch, baseRefName: 'trunk', polls: 0, failOnce: false });
    s.mutateItem(it.id, [{ set: { status: 'IN_REVIEW', worktree: rel, branch, pr: 300, ci_head_sha: tip, session_id: 'dryrun-s1', ...set } }], 'engine');
    return { id: it.id, tip, cwd };
  };
  /** claude paused by the usage guard, as on 2026-11-18 at 20:58. */
  const guardUp = () => s.updateLocal({ engine: { ...s.local.engine, provider_guards: { claude: { window: 'seven_day', status: 'allowed_warning', utilization: 0.85, tripped_at: new Date().toISOString() } } } });
  return { store: s, engine: e, world, wakes, ci, inReview, guardUp };
}
const fm = (id: string) => store!.requireItem(id).file.frontmatter;
const activity = (id: string) => getSection(store!.requireItem(id).file, 'Activity');
const fixTurns = (id: string) => store!.journal.read({ type: 'op.begin', item: id }).filter((e) => e.data?.phase === 'fix');
const stalled = (wakes: Wake[]) => wakes.filter((w) => w.type === 'review_stalled');
async function until(pred: () => boolean, ms = 6000) { const t0 = Date.now(); while (!pred()) { if (Date.now() - t0 > ms) throw new Error('timeout'); await sleep(20); } }
/** Longer than the watchdog needs: Activity is stamped to the second, and the stall clock is 0.3 s here. */
const STALL_WINDOW_MS = 2200;

describe('a turn handed to the session under a usage pause (#580)', () => {
  it('a first CI red: the fix turn is saved and said, it is no review stall, and it starts when the pause lifts', async () => {
    const { engine, wakes, inReview, guardUp } = await setup();
    const h = inReview({ ci_result: 'pending', op: 'awaiting_ci', op_started_at: new Date().toISOString() });
    guardUp();
    await engine.start();
    await until(() => Boolean(fm(h.id).op_data?.pending_turn));
    expect(fm(h.id)).toMatchObject({ ci_result: 'red', ci_failed_count: 1 });
    expect(fm(h.id).blocked).toBeUndefined();
    expect((fm(h.id).op_data!.pending_turn as { phase: string }).phase).toBe('fix');
    expect(activity(h.id)).toContain('its fix turn is saved and waits: claude is paused by the usage guard until it is resumed; it starts by itself then, with nothing to unblock');
    await sleep(STALL_WINDOW_MS);
    expect(stalled(wakes)).toEqual([]);
    expect(fixTurns(h.id)).toEqual([]);
    // Said once, however many passes look at it.
    expect(activity(h.id).match(/its fix turn is saved and waits/g)).toHaveLength(1);
    expect((engine as any).ciWatch.reviewStallOver(h.id)).toMatch(/^a turn is saved for its session and starts by itself \(claude is paused by the usage guard/);
    engine.retryProvider('claude');
    await until(() => fixTurns(h.id).length === 1);
    expect(stalled(wakes)).toEqual([]);
  });

  it('a rebase conflict in the merge pipeline: left stopped for the session, its turn saved, no stall, started when the pause lifts', async () => {
    const { engine, world, wakes, ci, inReview, guardUp } = await setup();
    ci.state = 'success';
    const h = inReview({ ci_result: 'pending' });
    world.conflictArmed = true;
    guardUp();
    await engine.start();
    await until(() => Boolean(fm(h.id).op_data?.pending_turn));
    expect(fm(h.id).op_data).toMatchObject({ needs_session_rebase: true, rebase_continue: { conflicts: ['src/conflicted.ts'] } });
    expect(fm(h.id).blocked).toBeUndefined();
    expect(activity(h.id)).toContain('the rebase is left stopped at the conflict for the session');
    expect(activity(h.id)).toContain('its fix turn is saved and waits: claude is paused by the usage guard');
    await sleep(STALL_WINDOW_MS);
    expect(stalled(wakes)).toEqual([]);
    engine.retryProvider('claude');
    await until(() => fixTurns(h.id).length === 1);
    expect(stalled(wakes)).toEqual([]);
  });

  it('the automation pause is said the same way, once', async () => {
    const { engine, inReview } = await setup();
    const h = inReview({ ci_result: 'red' });
    engine.pause();
    (engine as any).queueTurn(h.id, 'fix', 'fix the red run');
    await until(() => !(engine as any).jobs.has(h.id));
    expect(activity(h.id).match(/its fix turn is saved and waits: automation is paused/g)).toHaveLength(1);
    // The same saved instruction, tried again under the same pause, says nothing more.
    await (engine as any).turnRunner.runTurnFor(h.id, 'fix', 'x', [], [], {}, fm(h.id).op_data!.pending_turn);
    expect(activity(h.id).match(/its fix turn is saved and waits: automation is paused/g)).toHaveLength(1);
    expect((fm(h.id).op_data!.pending_turn as { waits?: string }).waits).toBe('automation is paused');
  });
});

describe('an item in review that nothing drives (#580)', () => {
  it('the wake names only tools that take an item that is not blocked', async () => {
    const { engine, wakes, inReview } = await setup();
    const h = inReview({ ci_result: 'red', ci_failed_count: 1 });
    store!.mutateItem(h.id, [{ set: { op_data: { last_red: { runId: 7, sha: h.tip, attempt: 1 }, ci: { runId: 7, url: 'u7' } } } }], 'engine');
    await engine.start();
    await until(() => stalled(wakes).length === 1);
    const note = String(stalled(wakes)[0].data?.note);
    expect(note).toContain('It is not blocked, so unblock_item, retry_op and sync_with_base refuse it.');
    expect(note).toContain("- message_session: nothing is live on it, so your message starts its session's turn now");
    expect(note).toContain('CI is red, so say what failed and what to fix');
    expect(note).toContain('- rerun_ci: run 7 for this head is on record as red');
    expect(note).toContain('- mark_blocked with the reason, or ask_user_decision');
    // Each tool it rules out does refuse the item as it is.
    expect(await (engine as any).retryOp(h.id, 'orchestrator')).toMatch(/^nothing to retry/);
    expect(await (engine as any).orchestratorUnblocks(h.id, 'fix it')).toMatch(/^nothing to unblock/);
    expect(await engine.syncWithBase(h.id, { by: 'orchestrator' })).toMatch(/^not needed/);
    expect((engine as any).ciWatch.reviewStallOver(h.id)).toBeUndefined();
  });

  it('a held rebase with no turn says how to hand the conflict over, and offers no rerun_ci without a red run on record', async () => {
    const { engine, wakes, inReview } = await setup();
    const h = inReview({ ci_result: 'unknown' });
    store!.mutateItem(h.id, [{ set: { op_data: { needs_session_rebase: true, rebase_continue: { base: 'trunk', base_sha: 'f'.repeat(40), before: h.tip, expected: h.tip, stop_head: h.tip, conflicts: ['docs/long_game_ui.md'], files: ['docs/long_game_ui.md'], took: [], rounds: 1 } } } }], 'engine');
    await engine.start();
    await until(() => stalled(wakes).length === 1);
    const note = String(stalled(wakes)[0].data?.note);
    expect(note).toContain('a rebase onto origin/trunk is left stopped at a conflict in docs/long_game_ui.md, so say how those files should go');
    expect(note).not.toContain('rerun_ci');
  });

  it('message_session starts the session\'s turn when nothing is live, and says so', async () => {
    const { engine, inReview } = await setup();
    const h = inReview({ ci_result: 'red', ci_failed_count: 1 });
    const said = await (engine as any).orchestrator.hooks.message(h.id, 'add the dynamic_loaders entry');
    expect(said).toBe(`started: nothing was live on ${h.id}, so its session's fix turn starts now with the message`);
    await until(() => fixTurns(h.id).length === 1);
  });

  it('message_session under a usage pause says the turn is saved and what it waits for; a second message joins it', async () => {
    const { engine, inReview, guardUp } = await setup();
    const h = inReview({ ci_result: 'red', ci_failed_count: 1 });
    guardUp();
    const hooks = (engine as any).orchestrator.hooks;
    expect(await hooks.message(h.id, 'add the dynamic_loaders entry')).toBe(`saved, not started: nothing was live on ${h.id}, so the message is its session's next turn, which waits (claude is paused by the usage guard until it is resumed) and starts by itself once that ends`);
    await until(() => !(engine as any).jobs.has(h.id));
    expect(fixTurns(h.id)).toEqual([]);
    expect(await hooks.message(h.id, 'and keep the fixture sorted')).toMatch(/^queued with the turn already saved for \S+'s session, which has not started: claude is paused by the usage guard/);
    expect(fm(h.id).op_data?.pending_messages).toEqual(['and keep the fixture sorted']);
  });

  it('a stall wake read after the item moved on says so in the orchestrator\'s packet', async () => {
    const { engine, inReview, guardUp } = await setup();
    const h = inReview({ ci_result: 'red', ci_failed_count: 1 });
    const packet = () => (engine as any).orchestrator.renderPacket({ type: 'review_stalled', item: h.id, data: { note: 'x' } }) as string;
    expect(packet()).not.toContain('NO LONGER A STALL');
    guardUp();
    (engine as any).queueTurn(h.id, 'fix', 'fix the red run');
    await until(() => !(engine as any).jobs.has(h.id));
    expect(packet()).toMatch(/NO LONGER A STALL \(planestro's reading of the item now, later than this wake\): a turn is saved for its session and starts by itself \(claude is paused by the usage guard/);
    store!.mutateItem(h.id, [{ set: { blocked: true, blocked_reason: 'ci_red_twice' } }], 'engine');
    expect(packet()).toContain('NO LONGER A STALL');
    expect(packet()).toContain('it is blocked now (ci_red_twice)');
  });
});
