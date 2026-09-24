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

async function setup(opts: { claude?: (world: FakeWorld) => AgentPort; codex?: (world: FakeWorld) => AgentPort<AgentTurnOptions>; noCodex?: boolean; config?: (yml: string) => string } = {}) {
  const { dataDir, codeRepo } = makeFixture();
  mkdirSync(join(codeRepo, '.git', 'info'), { recursive: true });
  const cfg = join(dataDir, 'planestro.yml');
  let yml = readFileSync(cfg, 'utf8').replace(/^code_repo:\n/m, 'code_repo:\n  github: acme/repo\n').replace('models:\n', MODELS);
  if (opts.config) yml = opts.config(yml);
  writeFileSync(cfg, yml);
  delete process.env.PLANESTRO_DRYRUN_CI;
  store = await DataStore.open(dataDir);
  const world = new FakeWorld(() => {}, { 'origin/trunk': 'f'.repeat(40) });
  const ports: Ports = { mode: 'dry-run', git: new DryRunGitPort(world), gh: new DryRunGhPort(world), proc: new DryRunProcPort(world), agents: { claude: opts.claude ? opts.claude(world) : new DryRunClaudePort(world), ...(opts.noCodex ? {} : { codex: opts.codex ? opts.codex(world) : new DryRunCodexPort(world) }) } };
  engine = new LiveEngine(store, ports, () => {}, { sleep: async () => {}, tickMs: 50 });
  return { store, engine, world };
}
async function waitFor(pred: () => boolean, ms = 6000) { const t0 = Date.now(); while (!pred()) { if (Date.now() - t0 > ms) throw new Error(`timeout waiting: ${pred.toString().slice(0, 120)} :: ${store?.listItems().map((i) => `${i.id} ${i.file.frontmatter.status} ${i.file.frontmatter.awaiting ?? ''} ${i.file.frontmatter.blocked_reason ?? ''} ${i.file.frontmatter.blocked ? i.file.sections.find((x) => x.title === 'Activity')!.body.split('\n').slice(-1)[0].slice(0, 220) : ''}`).join(' | ')}`); await sleep(20); } }
const fmOf = (s: DataStore, id: string) => s.getItem(id)!.file.frontmatter;
const activityOf = (s: DataStore, id: string) => s.getItem(id)!.file.sections.find((x) => x.title === 'Activity')!.body;

describe('mixed runners (dry-run ports)', () => {
  it('Claude plans, Codex implements, the PR is held for review, and releasing the hold merges it', async () => {
    const { store, engine, world } = await setup();
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
    expect(world.prs.get(fm.pr!)!.isDraft).toBe(true);             // held: opened as a draft (f6)
    expect(world.ciPolledWhileDraft).toBe(0);                      // the review comes first; CI is not waited on
    expect(fm.ci_result).toBe('pending');
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
    expect(world.prs.get(fm.pr!)!.isDraft).toBe(false);            // marked ready after the sync: one CI run, on the merged head
    expect(activityOf(store, item.id)).toContain('as a draft: it is held, so CI waits until the hold is released');
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
    // the token budget is the other half: an item that has spent its tokens does not get another turn
    store.mutateItem(auth.id, [{ set: { agent_turns: 0, tokens: 600_000 } }], 'engine');
    await engine.unblock(auth.id, 'and again');
    await waitFor(() => fmOf(store, auth.id).blocked_reason === 'token_budget');
  });

  it('review: the branch\'s images come from git, changes go back to the same thread and return for review, approval merges', async () => {
    const { store, engine } = await setup();
    const item = store.createItem({ title: 'Tide chart icon', description: 'x', implementer: 'codex-art' });
    store.transition(item.id, 'QUEUED', 'user');
    await engine.start();
    await waitFor(() => fmOf(store, item.id).status === 'PLAN_READY');
    await engine.approvePlan(item.id);
    await waitFor(() => fmOf(store, item.id).awaiting === 'review');
    const images = await engine.reviewImages(item.id);
    expect(images).toEqual([{ path: `assets/${item.id.toLowerCase()}.png`, change: 'added', bytes: expect.any(Number), width: 96, height: 96 }]);
    const first = (await engine.reviewImage(item.id, images[0].path, 'after'))!;
    expect(first.subarray(1, 4).toString()).toBe('PNG');
    expect(await engine.reviewImage(item.id, images[0].path, 'before')).toBeNull();      // it is new
    expect(await engine.reviewImage(item.id, '../../etc/passwd', 'after')).toBeNull();     // only what the branch changed
    await expect(engine.requestReviewChanges(item.id, '  ')).rejects.toThrow(/what should change/);
    const thread = fmOf(store, item.id).agent_sessions!.codex;
    await engine.requestReviewChanges(item.id, 'warmer colours');
    await waitFor(() => fmOf(store, item.id).awaiting === 'review' && fmOf(store, item.id).agent_turns === 2);
    expect(fmOf(store, item.id).agent_sessions!.codex).toBe(thread);
    expect(fmOf(store, item.id).review_hold).toBe(true);
    const second = (await engine.reviewImage(item.id, images[0].path, 'after'))!;
    expect(second.equals(first)).toBe(false);                                            // a new picture, same path
    expect(activityOf(store, item.id)).toContain('review: changes requested: warmer colours');
    await engine.releaseHold(item.id);
    await waitFor(() => fmOf(store, item.id).status === 'FINISHED');
    expect(await engine.reviewImages(item.id)).toEqual([]);
  });

  it('a file over review.max_file_bytes blocks the item before any pull request exists', async () => {
    const { store, engine } = await setup({ config: (y) => `${y}\nreview:\n  max_file_bytes: 100\n` });
    const item = store.createItem({ title: 'Huge splash', description: 'x', implementer: 'codex-free' });
    store.transition(item.id, 'QUEUED', 'user');
    await engine.start();
    await waitFor(() => fmOf(store, item.id).status === 'PLAN_READY');
    await engine.approvePlan(item.id);
    await waitFor(() => fmOf(store, item.id).blocked === true);
    expect(fmOf(store, item.id)).toMatchObject({ status: 'IN_PROGRESS', blocked_reason: 'asset_too_large' });
    expect(fmOf(store, item.id).pr).toBeUndefined();
  });

  it('epic: the planner proposes children, a bad list goes back to the planner, the user edits and approves, the children exist as routed', async () => {
    let attempts = 0;
    const planner = (world: FakeWorld) => ({
      inner: new DryRunClaudePort(world),
      async runTurn(o: any): Promise<TurnResult> {
        if (/## Break this epic down/.test(o.prompt) && attempts++ === 0) {
          const bad = await o.tools.submit_breakdown('p', [{ title: 'A', description: 'a description that is long enough', implementer: 'codex-art', depends_on: [1] }, { title: 'B', description: 'a description that is long enough', implementer: 'opus-5', depends_on: [0] }]);
          expect(bad).toMatch(/^Rejected: the dependencies form a cycle/);
        }
        return this.inner.runTurn(o);
      },
    });
    const { store, engine, world } = await setup({ claude: planner });
    const epic = store.createItem({ title: 'Tide chart view', description: 'A chart of the day\'s tide with its own icon and header art.', kind: 'epic', category: 'Game' });
    await engine.start();
    await expect(engine.planEpic('TP-404')).rejects.toThrow();
    await engine.planEpic(epic.id);
    await waitFor(() => fmOf(store, epic.id).awaiting === 'breakdown_approval');
    expect(fmOf(store, epic.id).status).toBe('PLAN_READY');
    expect(store.derived(store.getItem(epic.id)!).needs_you).toBe(true);
    expect(activityOf(store, epic.id)).toContain('breakdown rejected back to the planner: the dependencies form a cycle');
    const proposed = fmOf(store, epic.id).awaiting_data!.children as any[];
    expect(proposed.map((c) => c.implementer)).toEqual(['codex-art', 'codex-art', 'fable-5', 'fable-5']);  // art to the art model, code to a Claude model
    expect(world.worktrees.size).toBe(1);                                   // the read-only planning checkout
    // the user retitles one child and drops the docs child before approving
    const edited = proposed.slice(0, 3).map((c, i) => i === 0 ? { ...c, title: 'Chart icon (retitled)' } : c);
    await expect(engine.approveBreakdown(epic.id, [{ ...edited[0], implementer: 'nobody' }])).rejects.toThrow(/not one of/);
    const created = await engine.approveBreakdown(epic.id, edited, { queue: false });
    expect(created).toHaveLength(3);
    const kids = created.map((id) => fmOf(store, id));
    expect(kids.map((k) => k.title)).toEqual(['Chart icon (retitled)', 'Tide chart view: illustration', 'Tide chart view: implementation']);
    expect(kids.every((k) => k.parent === epic.id && k.category === 'Game' && k.status === 'NOT_YET_SUBMITTED')).toBe(true);
    expect(kids[2].depends_on).toEqual([created[0], created[1]]);
    expect(kids[2].implementer).toBe('fable-5');
    await waitFor(() => fmOf(store, epic.id).branch !== undefined && world.worktrees.size === 0);
    expect(fmOf(store, epic.id)).toMatchObject({ status: 'IN_PROGRESS', branch: 'feature/tide-chart-view' });
    expect(fmOf(store, epic.id).worktree).toBeUndefined();
    expect(fmOf(store, epic.id).awaiting).toBeUndefined();
    expect(store.derived(store.getItem(epic.id)!).children).toEqual(created);
  });

  it('THE DEMO: one epic, planned once — Codex art, reviewed by eye, blocks Claude logic, which is told what was delivered — lands as one PR', async () => {
    const turns: { item: string; runner: string; phase: string; prompt: string }[] = [];
    const spy = (runner: string, make: (w: FakeWorld) => any) => (world: FakeWorld) => { const inner = make(world); return { async runTurn(o: any): Promise<TurnResult> { turns.push({ item: o.itemId, runner, phase: o.phase, prompt: o.prompt }); return inner.runTurn(o); }, runCustomTurn: inner.runCustomTurn?.bind(inner) }; };
    const { store, engine } = await setup({ claude: spy('claude', (w) => new DryRunClaudePort(w)), codex: spy('codex', (w) => new DryRunCodexPort(w)) });
    const epic = store.createItem({ title: 'Frost wand', description: 'Add a Frost Wand: icon, header art, and the weapon itself.', kind: 'epic', category: 'Game' });
    await engine.start();

    await engine.planEpic(epic.id);                                                  // 1. I queue it
    await waitFor(() => fmOf(store, epic.id).awaiting === 'breakdown_approval');
    const proposal = fmOf(store, epic.id).awaiting_data!.children as any[];
    const [icon, art, code, docs] = await engine.approveBreakdown(epic.id, proposal.map((c, i) => i === 0 ? { ...c, title: 'Frost wand icon' } : c)); // 2. I fix one title and approve
    const finished = (id: string) => fmOf(store, id).status === 'FINISHED';

    // each child is still planned and its plan approved: the Claude planner turns the brief into a precise spec for the artist
    await waitFor(() => fmOf(store, icon).status === 'PLAN_READY' && fmOf(store, art).status === 'PLAN_READY', 12000);
    expect(turns.filter((t) => t.phase === 'plan' && (t.item === icon || t.item === art)).every((t) => t.runner === 'claude')).toBe(true);
    await engine.approvePlan(icon); await engine.approvePlan(art);
    // Codex draws both in their own worktrees; each parks with something to look at
    await waitFor(() => fmOf(store, icon).awaiting === 'review' && fmOf(store, art).awaiting === 'review', 12000);
    expect((await engine.reviewImages(icon))[0]).toMatchObject({ change: 'added', width: 96 });
    // …while nothing that waits on them has so much as a worktree
    for (const id of [code, docs]) expect(fmOf(store, id)).toMatchObject({ status: 'QUEUED' });
    expect(turns.filter((t) => t.item === code || t.item === docs)).toEqual([]);

    await engine.requestReviewChanges(art, 'colder palette');                        // 3. I send one back with a note
    await waitFor(() => fmOf(store, art).awaiting === 'review' && fmOf(store, art).agent_turns === 2);
    await engine.releaseHold(icon); await engine.releaseHold(art);                   // 4. I approve both
    await waitFor(() => finished(icon) && finished(art), 12000);
    expect(fmOf(store, icon).delivered).toEqual([{ path: `assets/${icon.toLowerCase()}.png`, change: 'added', bytes: expect.any(Number), width: 96, height: 96 }]);

    // only then do the Claude items start — told which files their dependencies delivered
    await waitFor(() => fmOf(store, code).status === 'PLAN_READY', 12000);
    const planning = turns.find((t) => t.item === code && t.phase === 'plan')!;
    expect(planning.runner).toBe('claude');
    expect(planning.prompt).toContain(`${icon} — "Frost wand icon" (merged into your base branch)`);
    expect(planning.prompt).toContain(`added \`assets/${icon.toLowerCase()}.png\` (96×96`);
    expect(planning.prompt).toContain(`added \`assets/${art.toLowerCase()}.png\``);
    expect(fmOf(store, docs).status).toBe('QUEUED');                                 // still waiting on the code
    await engine.approvePlan(code);
    await waitFor(() => finished(code), 12000);
    await waitFor(() => fmOf(store, docs).status === 'PLAN_READY', 12000);
    await engine.approvePlan(docs);

    // they land, the epic PR opens, CI is green, it merges
    await waitFor(() => finished(docs) && finished(epic.id), 20000);
    const order = turns.map((t) => `${t.runner}:${t.item}:${t.phase}`);
    const firstLogic = order.findIndex((o) => o.startsWith(`claude:${code}`));
    const lastArt = Math.max(...order.map((o, i) => o.startsWith('codex:') ? i : -1));
    expect(firstLogic).toBeGreaterThan(lastArt);                                     // no logic turn before the last art turn
    expect(new Set(turns.filter((t) => t.runner === 'codex').map((t) => t.item))).toEqual(new Set([icon, art]));
    expect(fmOf(store, epic.id).pr).toBeDefined();
    expect(activityOf(store, epic.id)).toMatch(/merged PR #/);
  }, 60000);

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

describe('a turn queued for its runner slot (p9)', () => {
  it('shows as queued, not as a running agent, until the slot frees', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const codex = (world: FakeWorld) => { const inner = new DryRunCodexPort(world); return { async runTurn(o: any): Promise<TurnResult> { await gate; return inner.runTurn(o); } }; };
    const { store, engine } = await setup({ codex });
    const a = store.createItem({ title: 'Icon A', description: 'a 512px icon', implementer: 'codex-art' });
    const b = store.createItem({ title: 'Icon B', description: 'a 512px icon', implementer: 'codex-art' });
    for (const it of [a, b]) store.transition(it.id, 'QUEUED', 'user');
    await engine.start();
    await waitFor(() => fmOf(store, a.id).status === 'PLAN_READY' && fmOf(store, b.id).status === 'PLAN_READY');
    await engine.approvePlan(a.id); await engine.approvePlan(b.id);
    await waitFor(() => engine.sessions().length === 2);
    const views = engine.sessions();
    expect(views.filter((v) => v.busy)).toHaveLength(1);
    expect(views.find((v) => !v.busy)!.op).toBe('implement: waiting for a codex slot');
    release();
    await waitFor(() => fmOf(store, a.id).awaiting === 'review' && fmOf(store, b.id).awaiting === 'review', 10000); // both ran, one after the other
  });
});

