import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DataStore } from '../src/store/DataStore.ts';
import { LiveEngine } from '../src/engine/LiveEngine.ts';
import { FakeWorld, DryRunGitPort, DryRunGhPort, DryRunProcPort, DryRunClaudePort } from '../src/engine/dryrun-ports.ts';
import type { Ports, TurnOptions, TurnResult } from '../src/engine/ports.ts';
import { getSection, loopGreen, loopLine, loopTallyProblem } from '@planestro/shared';
import { makeFixture, sleep } from './helpers.ts';

/**
 * Loop until green (#171): a worker iterates against its checks, each pass tallied and counted against
 * the item's own iteration budget; the budget ends in a block, never an endless loop, and green ends in
 * a review filed on the item with the pull request held for the user.
 */
let store: DataStore | undefined; let engine: LiveEngine | undefined;
afterEach(async () => { await engine?.stop(); store?.close(); store = undefined; engine = undefined; });

const ok: TurnResult = { sessionId: 's', subtype: 'success', isError: false, costUsd: 0, numTurns: 1, text: '' };
const PLAN = '# Plan\n\n1. Write the checks.\n2. Iterate the generator until they pass.\n';

async function setup(work: (o: TurnOptions, world: FakeWorld, n: number) => Promise<TurnResult>) {
  const { dataDir } = makeFixture();
  const cfg = join(dataDir, 'planestro.yml');
  writeFileSync(cfg, readFileSync(cfg, 'utf8').replace(/^code_repo:\n/m, 'code_repo:\n  github: acme/repo\n'));
  delete process.env.PLANESTRO_DRYRUN_CI;
  store = await DataStore.open(dataDir, { emit: () => {} });
  store.updateConfig((doc) => { doc.setIn(['ci', 'draft_while_held'], false); }, 'config: no drafts');
  const world = new FakeWorld(() => {}, { 'origin/trunk': 'f'.repeat(40) });
  const inner = new DryRunClaudePort(world);
  const prompts: string[] = []; let n = 0;
  const claude: Ports['agents']['claude'] = {
    async runTurn(o: TurnOptions): Promise<TurnResult> {
      if (o.phase === 'plan') { await o.tools.submit_plan(PLAN); return { ...ok, planSubmitted: PLAN }; }
      prompts.push(o.prompt);
      return work(o, world, n++);
    },
    async runCustomTurn(o) { return inner.runCustomTurn(o); },
  };
  const ports: Ports = { mode: 'dry-run', git: new DryRunGitPort(world), gh: new DryRunGhPort(world), proc: new DryRunProcPort(world), agents: { claude } };
  engine = new LiveEngine(store, ports, () => {}, { sleep: async () => {}, tickMs: 50 });
  return { store, engine, prompts };
}

async function waitFor(pred: () => boolean, ms = 4000) { const t0 = Date.now(); while (!pred()) { if (Date.now() - t0 > ms) throw new Error('timeout waiting'); await sleep(20); } }
const fmOf = (s: DataStore, id: string) => s.getItem(id)!.file.frontmatter;
const activityOf = (s: DataStore, id: string) => getSection(s.getItem(id)!.file, 'Activity');
const commit = (o: TurnOptions, world: FakeWorld) => { world.commits.set(o.cwd, (world.commits.get(o.cwd) ?? 0) + 1); const wt = world.worktrees.get(o.cwd); if (wt) wt.head = world.sha(); };

async function approved(s: DataStore, e: LiveEngine, loop?: Record<string, unknown>) {
  const item = s.createItem({ title: 'Fix the generated layouts', description: 'Findings from the last review.', ...(loop ? { extra: { loop } } : {}) });
  s.transition(item.id, 'QUEUED', 'user');
  await e.start();
  await waitFor(() => fmOf(s, item.id).status === 'PLAN_READY');
  await e.approvePlan(item.id);
  return item.id;
}

describe('loop helpers', () => {
  it('reads a tally, a line and green', () => {
    expect(loopLine({ iteration: 3, passing: 5, total: 7, line: 'widened the gap' }, 8)).toBe('iteration 3/8: 5/7 passing — widened the gap');
    expect(loopGreen({ iteration: 1, passing: 2, total: 2, at: '' })).toBe(true);
    expect(loopGreen({ iteration: 1, passing: 1, total: 2, at: '' })).toBe(false);
    expect(loopGreen(undefined)).toBe(false);
    expect(loopTallyProblem(3, 2)).toMatch(/between 0 and total/);
    expect(loopTallyProblem(0, 0)).toMatch(/at least 1/);
    expect(loopTallyProblem(1.5, 2)).toMatch(/whole numbers/);
    expect(loopTallyProblem(2, 2)).toBeUndefined();
  });
});

describe('loop until green (#171)', () => {
  it('logs each iteration, refuses done until green and reviewed, then files the review and holds the pull request', async () => {
    const answers: string[] = [];
    const { store, engine, prompts } = await setup(async (o, world) => {
      answers.push(await o.tools.report_iteration(2, 4, 'two contracts still fail'));
      answers.push(await o.tools.report_done('done early'));
      commit(o, world);
      answers.push(await o.tools.report_iteration(4, 4, 'all contracts pass'));
      answers.push(await o.tools.report_done('fixed the generator'));
      answers.push(await o.tools.report_done('fixed the generator', undefined, undefined, undefined, '# Review\n\n- gap contract: failed before, passes now'));
      answers.push(await o.tools.report_done('fixed the generator', undefined, undefined, undefined, '# Review\n\n- gap contract: failed before, passes now'));
      return { ...ok, done: 'fixed the generator' };
    });
    const id = await approved(store, engine, { max_iterations: 5, goal: 'every layout contract passes' });
    await waitFor(() => fmOf(store, id).status === 'IN_REVIEW' && fmOf(store, id).pr !== undefined);
    expect(prompts[0]).toContain('## Loop until green');
    expect(prompts[0]).toContain('iteration budget of 5 (0 used so far, last tally none yet)');
    expect(prompts[0]).toContain('Goal: every layout contract passes');
    expect(answers[0]).toBe('Recorded: iteration 1 of 5, 2/4 passing; 4 left.');
    expect(answers[1]).toMatch(/^Rejected: this is a loop-until-green item and its last iteration was 2\/4 passing/);
    expect(answers[2]).toMatch(/^Recorded: 4\/4, all green/);
    expect(answers[3]).toMatch(/^Rejected: a loop-until-green item hands off with its review/);
    expect(answers[4]).toMatch(/^Recorded, with your review filed on the item: planestro keeps the pull request out of the merge queue/);
    const log = activityOf(store, id);
    expect(log).toContain('iteration 1/5: 2/4 passing — two contracts still fail');
    expect(log).toContain('iteration 2/5: 4/4 passing — all contracts pass');
    const fm = fmOf(store, id);
    expect(fm.loop_state).toMatchObject({ iteration: 2, passing: 4, total: 4 });
    expect(fm).toMatchObject({ skip_merge: true, hold_reason: 'loop review: 4/4 checks green after 2 iterations; read the review on the item before releasing it' });
    expect(answers[5]).toMatch(/^Already recorded by planestro/);
    expect(getSection(store.getItem(id)!.file, 'Notes')!.split('## Loop review').length).toBe(2);   // a retried done (#167) files nothing twice
    expect(getSection(store.getItem(id)!.file, 'Notes')).toContain('## Loop review (iteration 2, 4/4 green)');
    expect(fm.attachments.some((a) => a.path.endsWith('-REVIEW.md'))).toBe(true);
    await sleep(200);
    expect(fmOf(store, id).status).toBe('IN_REVIEW');
  });

  it('blocks the item when the iteration budget is spent without going green', async () => {
    const answers: string[] = [];
    const { store, engine } = await setup(async (o, world) => {
      commit(o, world);
      answers.push(await o.tools.report_iteration(1, 3, 'first try'));
      answers.push(await o.tools.report_iteration(2, 3, 'second try'));
      answers.push(await o.tools.report_iteration(3, 3, 'too late'));
      return ok;
    });
    const id = await approved(store, engine, { max_iterations: 2 });
    await waitFor(() => fmOf(store, id).blocked === true);
    const fm = fmOf(store, id);
    expect(fm.blocked_reason).toBe('loop_cap');
    expect(answers[1]).toContain('do not iterate further');
    expect(answers[2]).toBe('Not recorded: this item is blocked. End your turn now.');
    expect(fm.loop_state).toMatchObject({ iteration: 2, passing: 2, total: 3 });
    expect(activityOf(store, id)).toMatch(/BLOCKED \(loop_cap\): the loop spent its 2 iterations \(loop\.max_iterations\) without going green: 2\/3 passing at the last one \(second try\)\. Last diff/);
    await sleep(200);
    expect(fmOf(store, id).pr).toBeUndefined();
  });

  it('carries a turn that ended mid-loop on once per new iteration, then blocks it as stalled', async () => {
    const { store, engine, prompts } = await setup(async (o, world, n) => {
      if (n === 0) { commit(o, world); await o.tools.report_iteration(1, 3, 'started'); }
      return ok;
    });
    const id = await approved(store, engine, { max_iterations: 5 });
    await waitFor(() => fmOf(store, id).blocked === true);
    expect(fmOf(store, id).blocked_reason).toBe('loop_stalled');
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain('Your turn ended before the loop was green');
    expect(prompts[1]).toContain('4 iterations left');
    expect(activityOf(store, id)).toContain('the turn ended mid-loop (iteration 1/5, 1/3 passing); asking the session to carry on');
    expect(fmOf(store, id).pr).toBeUndefined();
  });

  it('is nothing on an ordinary item: report_iteration says so and done is taken as always', async () => {
    let answer = '';
    const { store, engine, prompts } = await setup(async (o, world) => {
      commit(o, world);
      answer = await o.tools.report_iteration(1, 1, 'n/a');
      await o.tools.report_done('did it');
      return { ...ok, done: 'did it' };
    });
    const id = await approved(store, engine);
    await waitFor(() => fmOf(store, id).status === 'FINISHED');
    expect(answer).toMatch(/^Not a loop item/);
    expect(prompts[0]).not.toContain('## Loop until green');
    expect(fmOf(store, id).loop_state).toBeUndefined();
  });
});
