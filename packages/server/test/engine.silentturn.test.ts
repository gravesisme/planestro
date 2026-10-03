import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DataStore } from '../src/store/DataStore.ts';
import { LiveEngine } from '../src/engine/LiveEngine.ts';
import { FakeWorld, DryRunGitPort, DryRunGhPort, DryRunProcPort, DryRunClaudePort } from '../src/engine/dryrun-ports.ts';
import type { Ports, TurnOptions, TurnResult } from '../src/engine/ports.ts';
import { getSection } from '@planestro/shared';
import { makeFixture, sleep } from './helpers.ts';

/**
 * A worker turn that ends without report_done or report_blocked after the pull request opens wakes the
 * orchestrator with the session's last message (#196). HH-373 (PR #541) was held in review; twice its
 * worker explained itself only in its final message, the log said "re-checking", and nobody read it.
 */
let store: DataStore | undefined; let engine: LiveEngine | undefined;
const polls: ReturnType<typeof setInterval>[] = [];
afterEach(async () => { for (const p of polls.splice(0)) clearInterval(p); await engine?.stop(); store?.close(); store = undefined; engine = undefined; });

const ok: TurnResult = { sessionId: 's', subtype: 'success', isError: false, costUsd: 0, numTurns: 1, text: '' };
const PLAN = '# Plan\n\n1. Fix the cart.\n2. Test it.\n';
const SAID = 'I could not finish the soak: the planestro tools stopped answering (Stream closed).\nThe fix itself is committed.';

/** Dry-run agents with a scripted worker; every orchestrator wake's packet is recorded. */
async function setup(work: (o: TurnOptions, world: FakeWorld, n: number) => Promise<TurnResult>) {
  const { dataDir, codeRepo } = makeFixture();
  mkdirSync(join(codeRepo, '.git', 'info'), { recursive: true });
  const cfg = join(dataDir, 'planestro.yml');
  writeFileSync(cfg, readFileSync(cfg, 'utf8').replace(/^code_repo:\n/m, 'code_repo:\n  github: acme/repo\n'));
  delete process.env.PLANESTRO_DRYRUN_CI;
  store = await DataStore.open(dataDir, { emit: () => {} });
  store.updateConfig((doc) => { doc.setIn(['ci', 'draft_while_held'], false); }, 'config: no drafts');
  const world = new FakeWorld(() => {}, { 'origin/trunk': 'f'.repeat(40) });
  const inner = new DryRunClaudePort(world);
  const wakes: string[] = []; let n = 0;
  const claude: Ports['agents']['claude'] = {
    async runTurn(o: TurnOptions): Promise<TurnResult> {
      if (o.phase === 'plan') { await o.tools.submit_plan(PLAN); return { ...ok, planSubmitted: PLAN }; }
      return work(o, world, n++);
    },
    async runCustomTurn(o) {
      wakes.push(o.prompt);
      await o.mcpTools.find((t) => t.name === 'done_with_wake')!.handler({ summary: 'done' });
      return { ...ok, sessionId: 'orch' };
    },
  };
  void inner;
  const ports: Ports = { mode: 'dry-run', git: new DryRunGitPort(world), gh: new DryRunGhPort(world), proc: new DryRunProcPort(world), agents: { claude } };
  const live = engine = new LiveEngine(store, ports, () => {}, { sleep: async () => {}, tickMs: 50 });
  polls.push(setInterval(() => (live as any).heldPolledAt.clear(), 30));
  return { store, engine, world, wakes };
}

async function waitFor(pred: () => boolean, ms = 6000) { const t0 = Date.now(); while (!pred()) { if (Date.now() - t0 > ms) throw new Error('timeout waiting'); await sleep(20); } }
const fmOf = (s: DataStore, id: string) => s.getItem(id)!.file.frontmatter;
const activityOf = (s: DataStore, id: string) => getSection(s.getItem(id)!.file, 'Activity');
const commit = (o: TurnOptions, world: FakeWorld) => { world.commits.set(o.cwd, (world.commits.get(o.cwd) ?? 0) + 1); const wt = world.worktrees.get(o.cwd); if (wt) wt.head = world.sha(); };
const silentWakes = (wakes: string[]) => wakes.filter((w) => w.includes('Event: turn_ended_silent'));

async function planned(s: DataStore, e: LiveEngine) {
  const item = s.createItem({ title: 'Fix the mine cart', description: 'It derails on the ramp.' });
  s.transition(item.id, 'QUEUED', 'user');
  await e.start();
  await waitFor(() => fmOf(s, item.id).status === 'PLAN_READY');
  return item.id;
}

describe('a worker turn that ends without a report after the pull request opens (#196)', () => {
  it('held in review: exactly one wake, carrying the final message, and the log quotes its first line', async () => {
    const { store, engine, wakes } = await setup(async (o, world, n) => {
      if (n === 0) { commit(o, world); await o.tools.report_done('fixed the cart'); return { ...ok, done: 'fixed the cart' }; }
      return { ...ok, text: SAID };   // answers the message, reports nothing
    });
    const id = await planned(store, engine);
    await engine.approvePlan(id, undefined, 'user', { hold: 'until the designer plays it' });
    await waitFor(() => fmOf(store, id).status === 'IN_REVIEW' && fmOf(store, id).ci_result === 'green');
    expect(silentWakes(wakes)).toHaveLength(0);
    await engine.message(id, 'did the soak pass?');
    await waitFor(() => silentWakes(wakes).length > 0);
    await sleep(300);
    const packets = silentWakes(wakes);
    expect(packets).toHaveLength(1);
    expect(packets[0]).toContain(`final_message: ${SAID}`);
    expect(packets[0]).toContain('branch: unchanged');
    expect(packets[0]).toContain('hold: until the designer plays it');
    expect(packets[0]).toMatch(/ci: (green|pending)/);
    expect(activityOf(store, id)).toContain('session finished without changing the branch; re-checking. It ended without report_done or report_blocked, saying: "I could not finish the soak: the planestro tools stopped answering (Stream closed)."; the orchestrator reads its last message');
    expect(fmOf(store, id)).toMatchObject({ status: 'IN_REVIEW', skip_merge: true });
  });

  it('not held: a fix turn that commits without a report wakes once with the branch it moved, and the item still merges', async () => {
    const { store, engine, world, wakes } = await setup(async (o, w, n) => {
      commit(o, w);
      if (n === 0) { await o.tools.report_done('fixed the cart'); return { ...ok, done: 'fixed the cart' }; }
      return { ...ok, text: 'Fixed the flaky check by seeding the RNG.' };
    });
    world.ciMode = 'red-once';
    const id = await planned(store, engine);
    await engine.approvePlan(id);
    await waitFor(() => fmOf(store, id).status === 'FINISHED', 10000);
    const packets = silentWakes(wakes);
    expect(packets).toHaveLength(1);
    expect(packets[0]).toContain('final_message: Fixed the flaky check by seeding the RNG.');
    expect(packets[0]).toMatch(/branch: moved to [0-9a-f]{7}/);
    expect(packets[0]).toContain('hold: none');
    expect(activityOf(store, id)).toMatch(/session updated the branch \([0-9a-f]{7}\); re-entering the merge pipeline\. It ended without report_done or report_blocked, saying: "Fixed the flaky check by seeding the RNG\."/);
  });

  it('a turn that reports done in review wakes nobody for silence', async () => {
    const { store, engine, wakes } = await setup(async (o, world, n) => {
      if (n === 0) commit(o, world);
      await o.tools.report_done(n === 0 ? 'fixed the cart' : 'answered: the soak passed');
      return { ...ok, done: n === 0 ? 'fixed the cart' : 'answered: the soak passed', text: 'The soak passed.' };
    });
    const id = await planned(store, engine);
    await engine.approvePlan(id, undefined, 'user', { hold: 'until the designer plays it' });
    await waitFor(() => fmOf(store, id).status === 'IN_REVIEW' && fmOf(store, id).ci_result === 'green');
    await engine.message(id, 'did the soak pass?');
    await waitFor(() => activityOf(store, id).includes('re-checking'));
    await sleep(300);
    expect(silentWakes(wakes)).toHaveLength(0);
    expect(activityOf(store, id)).not.toContain('the orchestrator reads its last message');
  });

  it('before the pull request: the report nudge that also ends silent opens the PR and wakes with the message instead of pr_opened', async () => {
    const { store, engine, wakes } = await setup(async (o, world, n) => {
      if (n === 0) { commit(o, world); return { ...ok, text: 'Done, I think.' }; }
      return { ...ok, text: 'All checks pass (42/42).' };   // the nudge: still no report_done
    });
    const id = await planned(store, engine);
    await engine.approvePlan(id);
    await waitFor(() => silentWakes(wakes).length > 0);
    await sleep(300);
    const packets = silentWakes(wakes);
    expect(packets).toHaveLength(1);
    expect(packets[0]).toContain('final_message: All checks pass (42/42).');
    expect(packets[0]).toMatch(/even after it was asked for its report; planestro opened PR #\d+ anyway/);
    expect(wakes.filter((w) => w.includes('Event: pr_opened'))).toHaveLength(0);
    const log = activityOf(store, id);
    expect(log).toContain('asking the session for its report before the pull request');
    expect(log).toContain('proceeding to a pull request. Its last message: "All checks pass (42/42)."; the orchestrator reads it');
  });
});
