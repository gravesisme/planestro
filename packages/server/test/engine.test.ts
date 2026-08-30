import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DataStore } from '../src/store/DataStore.ts';
import { LiveEngine } from '../src/engine/LiveEngine.ts';
import { FakeWorld, DryRunGitPort, DryRunGhPort, DryRunProcPort, DryRunClaudePort } from '../src/engine/dryrun-ports.ts';
import type { Ports, TurnOptions, TurnResult } from '../src/engine/ports.ts';
import type { ServerEvent } from '@planestro/shared';
import { makeFixture, git, sleep } from './helpers.ts';

let store: DataStore | undefined; let engine: LiveEngine | undefined;
afterEach(async () => { await engine?.stop(); store?.close(); store = undefined; engine = undefined; });

async function setup(opts: { ci?: string; claude?: (world: FakeWorld) => Ports['claude'] } = {}) {
  const { dataDir, codeRepo } = makeFixture();
  mkdirSync(join(codeRepo, '.git', 'info'), { recursive: true });
  const cfg = join(dataDir, 'planestro.yml');
  const { readFileSync, writeFileSync } = await import('node:fs');
  writeFileSync(cfg, readFileSync(cfg, 'utf8').replace('github: ', 'github: ').replace(/^code_repo:\n/m, 'code_repo:\n  github: acme/repo\n').replace('after_worktree_create: []', 'after_worktree_create: ["echo hook"]'));
  if (opts.ci) process.env.PLANESTRO_DRYRUN_CI = opts.ci; else delete process.env.PLANESTRO_DRYRUN_CI;
  const events: ServerEvent[] = [];
  store = await DataStore.open(dataDir, { emit: (e) => events.push(e) });
  const world = new FakeWorld(() => {}, { 'origin/trunk': 'f'.repeat(40) });
  const ports: Ports = { mode: 'dry-run', git: new DryRunGitPort(world), gh: new DryRunGhPort(world), proc: new DryRunProcPort(world), claude: opts.claude ? opts.claude(world) : new DryRunClaudePort(world) };
  engine = new LiveEngine(store, ports, (e) => events.push(e), { sleep: async () => {}, tickMs: 50 });
  return { store, engine, world, events, dataDir, codeRepo };
}

async function waitFor(pred: () => boolean, ms = 4000) { const t0 = Date.now(); while (!pred()) { if (Date.now() - t0 > ms) throw new Error('timeout waiting'); await sleep(20); } }
const status = (s: DataStore, id: string) => s.getItem(id)!.file.frontmatter.status;

describe('LiveEngine lifecycle (dry-run ports)', () => {
  it('drives one item NOT_YET_SUBMITTED → FINISHED with a user plan approval in the middle', async () => {
    const { store, engine, world, dataDir } = await setup();
    const item = store.createItem({ title: 'Add version flag', description: 'print the version' });
    store.transition(item.id, 'QUEUED', 'user');
    await engine.start();
    await waitFor(() => status(store, item.id) === 'PLAN_READY');
    let fm = store.getItem(item.id)!.file.frontmatter;
    expect(fm.branch).toBe('tp/1-add-version-flag');
    expect(fm.worktree).toBe('.claude/worktrees/tp-1-add-version-flag');
    expect(fm.awaiting).toBe('plan_approval');
    expect(store.getItem(item.id)!.file.sections.find((s) => s.title === 'Plan')!.body).toContain('Plan (dry-run)');
    expect(store.derived(store.getItem(item.id)!).needs_you).toBe(true);
    expect(world.worktrees.size).toBe(1);
    expect(engine.sessions()).toEqual([]); // parked: no live process

    await engine.approvePlan(item.id, 'looks good');
    await waitFor(() => status(store, item.id) === 'FINISHED', 8000);
    fm = store.getItem(item.id)!.file.frontmatter;
    expect(fm.pr).toBe(100);
    expect(fm.ci_result).toBe('green');
    expect(fm.merged_at).toBeDefined(); expect(fm.finished_at).toBeDefined();
    expect(fm.worktree).toBeUndefined(); expect(fm.op).toBeUndefined();
    expect(world.worktrees.size).toBe(0); expect(world.remoteBranches.has('tp/1-add-version-flag')).toBe(false);
    expect(world.prs.get(100)!.state).toBe('MERGED');
    const activity = store.getItem(item.id)!.file.sections.find((s) => s.title === 'Activity')!.body;
    for (const step of ['creating worktree', 'PLAN_IN_PROGRESS → PLAN_READY', 'approval notes', 'status PLAN_READY → IN_PROGRESS', 'opened PR #100', 'waiting for CI', 'merged PR #100', 'removed worktree']) expect(activity, step).toContain(step);
    await store.git.idle();
    const log = git(dataDir, 'log', '--format=%s');
    for (const m of ['TP-1: begin planning', 'TP-1: submit plan', 'TP-1: approve plan', 'TP-1: open PR #100', 'TP-1: merge', 'TP-1: finish']) expect(log, m).toContain(m);
    expect(log).not.toMatch(/CI/);
    expect(store.journal.openOps()).toEqual([]);
  });

  it('CI red once → the session fixes it → merged; conflict once → session rebases', async () => {
    const { store, engine, world } = await setup({ ci: 'red-once' });
    world.ciMode = 'red-once';
    const item = store.createItem({ title: 'Flaky', description: 'x' });
    store.transition(item.id, 'QUEUED', 'user');
    await engine.start();
    await waitFor(() => status(store, item.id) === 'PLAN_READY');
    await engine.approvePlan(item.id);
    await waitFor(() => status(store, item.id) === 'FINISHED', 8000);
    const fm = store.getItem(item.id)!.file.frontmatter;
    expect(fm.ci_failed_count).toBe(1);
    const activity = store.getItem(item.id)!.file.sections.find((s) => s.title === 'Activity')!.body;
    expect(activity).toContain('CI red (github, attempt 1)');
    expect(activity).toContain('session updated the branch');
    expect(activity).toContain('merged PR #100');
  });

  it('rebase conflict is handed to the session and the pipeline resumes after its fix', async () => {
    const { store, engine, world } = await setup();
    world.ciMode = 'conflict-once'; world.conflictArmed = true;
    const item = store.createItem({ title: 'Conflicty', description: 'x' });
    store.transition(item.id, 'QUEUED', 'user');
    await engine.start();
    await waitFor(() => status(store, item.id) === 'PLAN_READY');
    await engine.approvePlan(item.id);
    await waitFor(() => status(store, item.id) === 'FINISHED', 8000);
    const activity = store.getItem(item.id)!.file.sections.find((s) => s.title === 'Activity')!.body;
    expect(activity).toContain('conflicted in src/conflicted.ts');
    expect(activity).toContain('merged PR #100');
  });

  it('a question parks the session with awaiting=question; answering resumes the same session', async () => {
    let calls = 0;
    const asking = (world: FakeWorld) => ({
      async runTurn(o: TurnOptions): Promise<TurnResult> {
        calls += 1;
        if (calls === 1) { await o.onQuestion([{ question: 'Short or long?', options: [{ label: 'Short' }, { label: 'Long' }] }]); return { sessionId: 'sess-1', subtype: 'success', isError: false, costUsd: 0.1, numTurns: 1, text: 'asked', parked: 'question' }; }
        expect(o.resume).toBe('sess-1');
        expect(o.prompt).toContain('A: Long');
        await o.tools.submit_plan('# plan after answer');
        return { sessionId: 'sess-1', subtype: 'success', isError: false, costUsd: 0.1, numTurns: 1, text: 'planned', planSubmitted: '# plan after answer' };
      },
    });
    const { store, engine } = await setup({ claude: asking });
    const item = store.createItem({ title: 'Q', description: 'x' });
    store.transition(item.id, 'QUEUED', 'user');
    await engine.start();
    await waitFor(() => store.getItem(item.id)!.file.frontmatter.awaiting === 'question');
    expect(status(store, item.id)).toBe('PLAN_IN_PROGRESS');
    expect(store.derived(store.getItem(item.id)!).needs_you).toBe(true);
    expect((store.getItem(item.id)!.file.frontmatter.awaiting_data as any).questions[0].question).toBe('Short or long?');
    await engine.respond(item.id, { kind: 'question', answers: { 'Short or long?': 'Long' } });
    await waitFor(() => status(store, item.id) === 'PLAN_READY');
    expect(store.getItem(item.id)!.file.frontmatter.cost_usd).toBeCloseTo(0.2);
    expect(store.getItem(item.id)!.file.frontmatter.turns).toBe(2);
  });

  it('a permission prompt parks; "allow" resumes with the exact rule; policy denies pushes outright', async () => {
    const seen: string[][] = [];
    const permy = () => ({
      async runTurn(o: TurnOptions): Promise<TurnResult> {
        seen.push(o.allowedTools);
        if (o.phase === 'plan') { await o.tools.submit_plan('# p'); return { sessionId: 's', subtype: 'success', isError: false, costUsd: 0, numTurns: 1, text: '', planSubmitted: '# p' }; }
        if (seen.length === 2) {
          expect((await o.onPermission({ tool: 'Bash', input: { command: 'git push origin HEAD' } })).action).toBe('deny');
          expect((await o.onPermission({ tool: 'Bash', input: { command: 'git checkout trunk' } })).action).toBe('deny');
          expect((await o.onPermission({ tool: 'Bash', input: { command: 'node -e 1' } })).action).toBe('park');
          return { sessionId: 's', subtype: 'success', isError: false, costUsd: 0, numTurns: 1, text: '', parked: 'permission' };
        }
        await o.tools.report_done('did it');
        return { sessionId: 's', subtype: 'success', isError: false, costUsd: 0, numTurns: 1, text: '', done: 'did it' };
      },
    });
    const { store, engine, world } = await setup({ claude: permy });
    const item = store.createItem({ title: 'P', description: 'x' });
    store.transition(item.id, 'QUEUED', 'user');
    await engine.start();
    await waitFor(() => status(store, item.id) === 'PLAN_READY');
    await engine.approvePlan(item.id);
    await waitFor(() => store.getItem(item.id)!.file.frontmatter.awaiting === 'permission');
    expect((store.getItem(item.id)!.file.frontmatter.awaiting_data as any).input.command).toBe('node -e 1');
    world.commits.set(join(store.codeRepoPath(), '.claude/worktrees/tp-1-p'), 1); // the third turn "commits"
    await engine.respond(item.id, { kind: 'permission', decision: 'always' });
    await waitFor(() => status(store, item.id) === 'FINISHED', 8000);
    expect(seen[2]).toContain('Bash(node -e 1)');
    expect(store.config.permissions.allow).toContain('Bash(node -e 1)');
  });

  it('no commits after "done" blocks the item with a reason instead of opening a PR', async () => {
    const lazy = () => ({
      async runTurn(o: TurnOptions): Promise<TurnResult> {
        if (o.phase === 'plan') { await o.tools.submit_plan('# p'); return { sessionId: 's', subtype: 'success', isError: false, costUsd: 0, numTurns: 1, text: '', planSubmitted: '# p' }; }
        await o.tools.report_done('nothing really');
        return { sessionId: 's', subtype: 'success', isError: false, costUsd: 0, numTurns: 1, text: '', done: 'nothing really' };
      },
    });
    const { store, engine } = await setup({ claude: lazy });
    const item = store.createItem({ title: 'Lazy', description: 'x' });
    store.transition(item.id, 'QUEUED', 'user');
    await engine.start();
    await waitFor(() => status(store, item.id) === 'PLAN_READY');
    await engine.approvePlan(item.id);
    await waitFor(() => store.getItem(item.id)!.file.frontmatter.blocked === true);
    const fm = store.getItem(item.id)!.file.frontmatter;
    expect(fm.status).toBe('IN_PROGRESS');
    expect(fm.blocked_reason).toBe('no_commits');
    expect(fm.pr).toBeUndefined();
  });

  it('pause stops admissions; resume continues; a restart resumes an interrupted turn', async () => {
    const { store, engine, dataDir } = await setup();
    engine.pause();
    const item = store.createItem({ title: 'Paused', description: 'x' });
    store.transition(item.id, 'QUEUED', 'user');
    await engine.start();
    await sleep(200);
    expect(status(store, item.id)).toBe('QUEUED');
    engine.resume();
    await waitFor(() => status(store, item.id) === 'PLAN_READY');
    // simulate a crash mid-implementation: op left behind on disk
    await engine.stop();
    store.mutateItem(item.id, [{ transition: { to: 'IN_PROGRESS', actor: 'user' } }, { set: { op: 'implement_turn', op_started_at: '2026-01-01T00:00:00+00:00' } }], 'user');
    const world2 = new FakeWorld(() => {}, { 'origin/trunk': 'f'.repeat(40) });
    world2.worktrees.set(join(store.codeRepoPath(), '.claude/worktrees/tp-1-paused'), { path: 'x', head: 'a'.repeat(40), branch: 'tp/1-paused' });
    const engine2 = new LiveEngine(store, { mode: 'dry-run', git: new DryRunGitPort(world2), gh: new DryRunGhPort(world2), proc: new DryRunProcPort(world2), claude: new DryRunClaudePort(world2) }, () => {}, { sleep: async () => {}, tickMs: 50 });
    await engine2.start();
    await waitFor(() => status(store, item.id) === 'FINISHED', 8000);
    const activity = store.getItem(item.id)!.file.sections.find((s) => s.title === 'Activity')!.body;
    expect(activity).toContain('interrupted by a restart; resuming');
    await engine2.stop();
    expect(dataDir).toBeTruthy();
  });
});
