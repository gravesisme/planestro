import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DataStore } from '../src/store/DataStore.ts';
import { LiveEngine } from '../src/engine/LiveEngine.ts';
import { FakeWorld, DryRunGitPort, DryRunGhPort, DryRunProcPort, DryRunClaudePort, DryRunCodexPort } from '../src/engine/dryrun-ports.ts';
import type { AgentPort, AgentTurnOptions, Ports, TurnResult } from '../src/engine/ports.ts';
import { makeFixture, sleep } from './helpers.ts';

let store: DataStore | undefined; let engine: LiveEngine | undefined;
afterEach(async () => { await engine?.stop(); store?.close(); store = undefined; engine = undefined; });

const MODELS = `models:
  - { id: codex-art, label: Codex Art, runner: codex, hold_for_review: true, description: "all raster art" }
  - { id: codex-free, label: Codex (no hold), runner: codex }
`;

async function setup(opts: { codex?: (world: FakeWorld) => AgentPort<AgentTurnOptions>; noCodex?: boolean; config?: (yml: string) => string } = {}) {
  const { dataDir, codeRepo } = makeFixture();
  mkdirSync(join(codeRepo, '.git', 'info'), { recursive: true });
  const cfg = join(dataDir, 'planestro.yml');
  let yml = readFileSync(cfg, 'utf8').replace(/^code_repo:\n/m, 'code_repo:\n  github: acme/repo\n').replace('models:\n', MODELS);
  if (opts.config) yml = opts.config(yml);
  writeFileSync(cfg, yml);
  delete process.env.PLANESTRO_DRYRUN_CI;
  store = await DataStore.open(dataDir);
  const world = new FakeWorld(() => {}, { 'origin/trunk': 'f'.repeat(40) });
  const ports: Ports = { mode: 'dry-run', git: new DryRunGitPort(world), gh: new DryRunGhPort(world), proc: new DryRunProcPort(world), agents: { claude: new DryRunClaudePort(world), ...(opts.noCodex ? {} : { codex: opts.codex ? opts.codex(world) : new DryRunCodexPort(world) }) } };
  engine = new LiveEngine(store, ports, () => {}, { sleep: async () => {}, tickMs: 50 });
  return { store, engine, world };
}
async function waitFor(pred: () => boolean, ms = 6000) { const t0 = Date.now(); while (!pred()) { if (Date.now() - t0 > ms) throw new Error('timeout waiting'); await sleep(20); } }
const fmOf = (s: DataStore, id: string) => s.getItem(id)!.file.frontmatter;
const activityOf = (s: DataStore, id: string) => s.getItem(id)!.file.sections.find((x) => x.title === 'Activity')!.body;

describe('mixed runners (dry-run ports)', () => {
  it('Claude plans, Codex implements, the PR is held for review, and releasing the hold merges it', async () => {
    const { store, engine } = await setup();
    const item = store.createItem({ title: 'Frost wand icon', description: 'a 512px icon', implementer: 'codex-art' });
    store.transition(item.id, 'QUEUED', 'user');
    await engine.start();
    await waitFor(() => fmOf(store, item.id).status === 'PLAN_READY');
    const planSession = fmOf(store, item.id).session_id!;
    expect(planSession).toMatch(/^dryrun-/);
    await engine.approvePlan(item.id);
    await waitFor(() => fmOf(store, item.id).awaiting === 'review');
    await sleep(300); // long enough for an un-held item to have merged
    let fm = fmOf(store, item.id);
    expect(fm.status).toBe('IN_REVIEW');
    expect(fm.ci_result).toBe('green');                            // CI ran while it was held: only the merge waits
    expect(fm.review_hold).toBe(true);
    expect(store.derived(store.getItem(item.id)!).needs_you).toBe(true);
    expect(fm.session_id).toBe(planSession);                       // the Claude conversation is untouched
    expect(fm.agent_sessions?.codex).toMatch(/^dryrun-codex-/);    // Codex has its own thread
    expect(fm.agent_turns).toBe(1);
    expect(fm.tokens).toBe(1500);
    expect(activityOf(store, item.id)).toContain('waiting for your review before merging');
    await expect(engine.releaseHold('TP-999')).rejects.toThrow();
    await engine.releaseHold(item.id, 'looks right at 1x');
    await waitFor(() => fmOf(store, item.id).status === 'FINISHED');
    fm = fmOf(store, item.id);
    expect(fm.merged_at).toBeDefined();
    expect(fm.review_hold).toBeUndefined();
    expect(activityOf(store, item.id)).toContain('approved for merge: looks right at 1x');
  });

  it('a Codex question parks the item and the answer resumes the same thread; "blocked" blocks with the reason', async () => {
    const seen: (string | undefined)[] = [];
    const asking = (world: FakeWorld) => ({
      inner: new DryRunCodexPort(world),
      async runTurn(o: AgentTurnOptions): Promise<TurnResult> {
        seen.push(o.resume);
        if (seen.length === 1) { await o.onQuestion([{ question: 'Pixel art or painted?', header: 'Codex asks', options: [] }]); return { sessionId: 'thread-7', subtype: 'success', isError: false, costUsd: 0, numTurns: 1, text: '', parked: 'question' }; }
        if (/STUCK/.test(o.prompt)) { await o.tools.report_blocked('no reference image was attached'); return { sessionId: 'thread-7', subtype: 'success', isError: false, costUsd: 0, numTurns: 1, text: '', blocked: 'no reference image was attached' }; }
        return this.inner.runTurn(o);
      },
    });
    const { store, engine } = await setup({ codex: asking });
    const item = store.createItem({ title: 'Splash art', description: 'x', implementer: 'codex-free' });
    store.transition(item.id, 'QUEUED', 'user');
    await engine.start();
    await waitFor(() => fmOf(store, item.id).status === 'PLAN_READY');
    await engine.approvePlan(item.id);
    await waitFor(() => fmOf(store, item.id).awaiting === 'question' && fmOf(store, item.id).agent_sessions !== undefined);
    expect(fmOf(store, item.id).agent_sessions).toEqual({ codex: 'thread-7' });
    expect(store.derived(store.getItem(item.id)!).needs_you).toBe(true);
    await engine.respond(item.id, { kind: 'question', answers: { 'Pixel art or painted?': 'Painted, like the potion' } });
    await waitFor(() => fmOf(store, item.id).status === 'FINISHED', 8000);
    expect(seen).toEqual([undefined, 'thread-7']);
    expect(fmOf(store, item.id).review_hold).toBeUndefined();      // codex-free has no hold

    const stuck = store.createItem({ title: 'STUCK art', description: 'STUCK', implementer: 'codex-free' });
    seen.length = 1; // skip the question branch
    store.transition(stuck.id, 'QUEUED', 'user'); engine.poke();
    await waitFor(() => fmOf(store, stuck.id).status === 'PLAN_READY');
    await engine.approvePlan(stuck.id, 'STUCK');
    await waitFor(() => fmOf(store, stuck.id).blocked === true);
    expect(fmOf(store, stuck.id).blocked_reason).toBe('agent_blocked');
  });

  it('guards: a Codex model cannot plan, a missing runner and a spent turn budget block with reasons, and failures keep their names', async () => {
    const failing = () => ({ async runTurn(): Promise<TurnResult> { return { subtype: 'auth_required', isError: true, costUsd: 0, numTurns: 1, text: '', error: 'Codex is not logged in (run `codex login`)' }; } });
    const { store, engine } = await setup({ codex: failing, config: (y) => `${y}\nbudget_turns_per_item: 1\n` });
    const bad = store.createItem({ title: 'Planned by codex', description: 'x', planner: 'codex-art' });
    const auth = store.createItem({ title: 'Needs login', description: 'x', implementer: 'codex-free' });
    for (const i of [bad, auth]) store.transition(i.id, 'QUEUED', 'user');
    await engine.start();
    await waitFor(() => fmOf(store, bad.id).blocked === true);
    expect(fmOf(store, bad.id).blocked_reason).toBe('planner_cannot_plan');
    await waitFor(() => fmOf(store, auth.id).status === 'PLAN_READY');
    await engine.approvePlan(auth.id);
    await waitFor(() => fmOf(store, auth.id).blocked === true);
    expect(fmOf(store, auth.id).blocked_reason).toBe('auth_required');
    expect(activityOf(store, auth.id)).toContain('codex login');
    // one turn was spent; with budget_turns_per_item: 1 the retry is refused before it starts
    expect(fmOf(store, auth.id).agent_turns).toBe(1);
    await engine.unblock(auth.id, 'try again');
    await waitFor(() => fmOf(store, auth.id).blocked_reason === 'turn_budget');
  });

  it('an engine without the Codex runner says so instead of failing obscurely', async () => {
    const { store, engine } = await setup({ noCodex: true });
    const item = store.createItem({ title: 'No runner', description: 'x', implementer: 'codex-art' });
    store.transition(item.id, 'QUEUED', 'user');
    await engine.start();
    await waitFor(() => fmOf(store, item.id).status === 'PLAN_READY');
    await engine.approvePlan(item.id);
    await waitFor(() => fmOf(store, item.id).blocked === true);
    expect(fmOf(store, item.id).blocked_reason).toBe('runner_unavailable');
  });
});
